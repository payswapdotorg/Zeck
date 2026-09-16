/**
 * Platform secret-store adapter for credential material (auth module; DEP-011).
 *
 * Bridges the module's neutral `CredentialSecretStore` port to the platform
 * `SecretStorePort` (`src/platform/secret-store/port.ts` — the ONLY layer
 * allowed to touch the platform's secret machinery, per
 * `IMPLEMENTATION.md` §3 and this module's adapters rule).
 *
 * CLASSIFICATION: application transport credentials are stored with the
 * platform's generic credential classification `provider-credential` — the
 * class the platform's secret inventory already uses for every externally
 * consumable credential. The `signing-key` class applies to signing
 * credentials, which this delivery does not issue (an honest boundary, not
 * a second authority: the classification vocabulary is the platform's).
 *
 * The stored material never crosses back: the neutral port is write-only
 * (there is no resolve on it by design — nothing in the credential
 * lifecycle may read a secret back).
 */

import { randomBytes } from "node:crypto";
import type { SecretStorePort } from "../../../platform/secret-store/port";
import type { CredentialSecretStore } from "../ports/credential-store";

export const CREDENTIAL_SECRET_CLASSIFICATION = "provider-credential" as const;

/**
 * Generate credential-shaped secret material (48 random bytes, base64url —
 * the `zeck-` prefix marks the vocabulary; the value is never logged, never
 * stored outside the secret store, never rendered). Compositions pass this
 * as the credential service's `generateSecret` dependency; tests inject
 * deterministic generators.
 */
export function randomCredentialSecret(): string {
  return `zeck-${randomBytes(48).toString("base64url")}`;
}

export function createPlatformCredentialSecretStore(
  secretStore: SecretStorePort,
): CredentialSecretStore {
  return {
    async store(input) {
      const reference = await secretStore.store({
        material: input.material,
        classification: CREDENTIAL_SECRET_CLASSIFICATION,
        description: input.description,
      });
      return { reference: reference as string };
    },
  };
}

/**
 * In-memory secret-store test double (the unit-test substrate): stores
 * material under generated `zeck-secret://` references and NEVER exposes
 * it back except through the test-only `materialOf` introspection used to
 * prove the show-once contract (no production path reads it).
 */
export class InMemoryCredentialSecretStore implements CredentialSecretStore {
  private readonly materials = new Map<string, string>();
  private counter = 0;

  async store(input: { material: string; description: string }): Promise<{ reference: string }> {
    this.counter += 1;
    const reference = `zeck-secret://test/credential-${String(this.counter).padStart(6, "0")}`;
    this.materials.set(reference, input.material);
    return { reference };
  }

  /** Test-only: the material stored under one reference. */
  materialOf(reference: string): string | null {
    return this.materials.get(reference) ?? null;
  }

  /** Test-only: every stored reference (handles, never material). */
  references(): readonly string[] {
    return [...this.materials.keys()];
  }
}
