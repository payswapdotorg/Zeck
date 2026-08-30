/**
 * SQL adapter for the connections credential vault (WORK-003, CON-002).
 *
 * Owns BYOK material end to end at the storage boundary
 * (`IMPLEMENTATION.md` §9): plaintext is sealed with the platform envelope
 * cipher (AES-256-GCM) bound to the vault row's reference as AAD before it
 * touches durable state, and is only re-opened for the authorized dispatch
 * path. The vault table (`connections.credentials`, migration 0002) stores
 * ciphertext bytes only.
 *
 * This adapter is the ONLY place in the connections module where credential
 * plaintext exists in memory, and it never places plaintext into a query
 * parameter, an error, a log line or a returned record.
 */

import {
  type EnvelopeCipher,
  EnvelopeIntegrityError,
} from "../../../platform/crypto/envelope-cipher";
import type { DatabasePort, Transaction } from "../../../platform/db/port";
import { PlatformError } from "../../../shared/errors";
import type { CredentialVault, VaultMaterialization } from "../ports/credential-vault";

type Executor = Pick<DatabasePort, "execute">;

interface CredentialRow {
  readonly reference: string;
  readonly ciphertext: Buffer;
}

/** AAD binds every envelope to its vault row — ciphertext cannot be transplanted between references. */
function aadFor(reference: string): string {
  return `connections.credentials:${reference}`;
}

export class SqlCredentialVault implements CredentialVault {
  constructor(
    private readonly exec: Executor,
    private readonly cipher: EnvelopeCipher,
    private readonly generateId: () => string,
  ) {}

  async store(material: string, options: { description?: string }): Promise<{ reference: string }> {
    if (material.length === 0) {
      throw new PlatformError({
        code: "AUTHORIZATION_DENIED",
        message: "credential material must not be empty",
      });
    }
    const reference = this.generateId();
    // Seal BEFORE the write: plaintext never reaches the database boundary.
    const envelope = this.cipher.seal(material, aadFor(reference));
    await this.exec.execute({
      sql: `INSERT INTO connections.credentials (reference, cipher, ciphertext, description)
VALUES ($1, $2, $3, $4)`,
      parameters: [
        reference,
        this.cipher.version,
        Buffer.from(envelope),
        options.description ?? null,
      ],
    });
    return { reference };
  }

  async materialize(
    reference: string,
    authorization: { attemptId: string; connectionId: string },
  ): Promise<VaultMaterialization> {
    void authorization; // audited upstream in the dispatch journal; kept in the contract for adapters that log access
    const result = await this.exec.execute<CredentialRow>({
      sql: "SELECT reference, ciphertext FROM connections.credentials WHERE reference = $1",
      parameters: [reference],
    });
    const row = result.rows.length > 0 ? result.rows[0] : undefined;
    if (row === undefined) {
      throw new PlatformError({
        code: "AUTHORIZATION_DENIED",
        message: "credential reference not found",
        details: { reference },
      });
    }
    try {
      const plaintext = this.cipher.open(new Uint8Array(row.ciphertext), aadFor(reference));
      return { reference, plaintext };
    } catch (error) {
      if (error instanceof EnvelopeIntegrityError) {
        // Tampered envelope / rotated key / transplanted ciphertext: fail
        // closed with a generic message (no material in the error).
        throw new PlatformError({
          code: "PROVIDER_ERROR",
          message: "credential material failed integrity verification",
          details: { reference },
        });
      }
      throw error;
    }
  }

  async destroy(reference: string): Promise<boolean> {
    const result = await this.exec.execute({
      sql: "DELETE FROM connections.credentials WHERE reference = $1",
      parameters: [reference],
    });
    return result.rowCount > 0;
  }
}

/**
 * Transaction-bound vault for idempotent mutations (rotation swaps the
 * reference and destroys superseded material inside the arbitration
 * transaction).
 */
export function createTxCredentialVault(
  tx: Transaction,
  cipher: EnvelopeCipher,
  generateId: () => string,
): CredentialVault {
  return new SqlCredentialVault(tx, cipher, generateId);
}

/** Root-bound vault over a `DatabasePort`. */
export function createSqlCredentialVault(
  db: DatabasePort,
  cipher: EnvelopeCipher,
  generateId: () => string,
): CredentialVault {
  return new SqlCredentialVault(db, cipher, generateId);
}
