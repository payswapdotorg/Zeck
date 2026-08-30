/**
 * Crypto port — controlled randomness and hashing for adapters.
 *
 * UUIDv7 identifier generation is a pure dependency-light primitive and lives
 * in `src/shared/ids.ts` so domain code can use it without touching the
 * platform. This port covers adapter-grade cryptographic services.
 */
export interface CryptoPort {
  randomBytes(length: number): Uint8Array;

  /** URL-safe random token derived from `bytes` random bytes. */
  randomToken(bytes: number): string;

  sha256Hex(data: Uint8Array | string): string;
}
