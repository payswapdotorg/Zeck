/**
 * Envelope encryption for credential material at rest (WORK-003).
 *
 * `IMPLEMENTATION.md` §9 — a `SecretStore` adapter owns encryption and
 * decryption of BYOK material. This cipher provides the AES-256-GCM envelope
 * used by the connections credential vault: authenticated encryption with the
 * vault row's reference bound as additional authenticated data (AAD), so a
 * ciphertext recorded for one reference cannot be replayed under another.
 *
 * Envelope layout (`aes-256-gcm-v1`):
 *
 * ```text
 * [ 12-byte random IV ][ 16-byte GCM tag ][ ciphertext ]
 * ```
 *
 * The master key is operator-supplied key material (exactly 32 bytes). It is
 * never persisted here and never appears in errors or details.
 */

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export const CIPHER_VERSION = "aes-256-gcm-v1" as const;

const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const KEY_LENGTH = 32;

/** Keyed AEAD cipher over credential material. */
export interface EnvelopeCipher {
  readonly version: typeof CIPHER_VERSION;
  /** Seal plaintext into a versioned envelope bound to `aad`. */
  seal(plaintext: string, aad: string): Uint8Array;
  /**
   * Open a sealed envelope. Throws a generic integrity error on any
   * tampering/wrong-key/wrong-AAD condition — the error never echoes key or
   * plaintext material.
   */
  open(envelope: Uint8Array, aad: string): string;
}

/** Opaque integrity failure — no key/plaintext material in the message. */
export class EnvelopeIntegrityError extends Error {
  constructor() {
    super("credential envelope failed authentication");
    this.name = "EnvelopeIntegrityError";
  }
}

export function createEnvelopeCipher(masterKey: Uint8Array): EnvelopeCipher {
  if (!(masterKey instanceof Uint8Array) || masterKey.length !== KEY_LENGTH) {
    throw new RangeError(`master key must be exactly ${KEY_LENGTH} bytes`);
  }
  const key = new Uint8Array(masterKey); // private copy, never exposed

  return {
    version: CIPHER_VERSION,

    seal(plaintext, aad) {
      const iv = randomBytes(IV_LENGTH);
      const cipher = createCipheriv("aes-256-gcm", key, iv, { authTagLength: TAG_LENGTH });
      cipher.setAAD(Buffer.from(aad, "utf8"));
      const encrypted = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
      const tag = cipher.getAuthTag();
      const envelope = new Uint8Array(IV_LENGTH + TAG_LENGTH + encrypted.length);
      envelope.set(iv, 0);
      envelope.set(new Uint8Array(tag), IV_LENGTH);
      envelope.set(new Uint8Array(encrypted), IV_LENGTH + TAG_LENGTH);
      return envelope;
    },

    open(envelope, aad) {
      if (envelope.length < IV_LENGTH + TAG_LENGTH) {
        throw new EnvelopeIntegrityError();
      }
      const iv = Buffer.from(envelope.subarray(0, IV_LENGTH));
      const tag = Buffer.from(envelope.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH));
      const ciphertext = Buffer.from(envelope.subarray(IV_LENGTH + TAG_LENGTH));
      try {
        const decipher = createDecipheriv("aes-256-gcm", key, iv, {
          authTagLength: TAG_LENGTH,
        });
        decipher.setAAD(Buffer.from(aad, "utf8"));
        decipher.setAuthTag(tag);
        return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
      } catch {
        // Wrong key, tampered ciphertext or mismatched AAD — identical
        // failure shape, no material leakage.
        throw new EnvelopeIntegrityError();
      }
    },
  };
}

/** Generate a fresh 32-byte master key (bootstrap/operator helper). */
export function generateMasterKey(): Uint8Array {
  return new Uint8Array(randomBytes(KEY_LENGTH));
}
