/**
 * Node/Bun `node:crypto` adapter for the `CryptoPort` (WORK-003).
 *
 * Provider-neutral: this adapter carries no provider knowledge. It exists so
 * module adapters (e.g. the connections credential vault) can obtain
 * controlled randomness and hashing through the platform port instead of
 * importing runtime crypto directly (`IMPLEMENTATION.md` §3 — infrastructure
 * lives behind adapters/platform).
 */

import { createHash, randomBytes as nodeRandomBytes } from "node:crypto";
import type { CryptoPort } from "./port";

/** URL-safe alphabet (RFC 4648 §5, no padding) for opaque tokens. */
const BASE64URL_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";

export class NodeCryptoPort implements CryptoPort {
  randomBytes(length: number): Uint8Array {
    if (!Number.isInteger(length) || length < 0 || length > 1_048_576) {
      throw new RangeError(`randomBytes length out of range: ${length}`);
    }
    return new Uint8Array(nodeRandomBytes(length));
  }

  randomToken(bytes: number): string {
    const raw = this.randomBytes(bytes);
    // Rejection-free mapping is not possible with 256 % 64 === 0? 64 divides
    // 256 exactly, so every byte carries 6 unbiased base64url characters'
    // worth of entropy only when packed; simple modulo is unbiased here
    // because 256 % 64 === 0.
    let token = "";
    for (const byte of raw) {
      token += BASE64URL_ALPHABET[byte % 64] ?? "";
    }
    return token;
  }

  sha256Hex(data: Uint8Array | string): string {
    return createHash("sha256").update(data).digest("hex");
  }
}

/** Factory for composition roots and tests. */
export function createNodeCryptoPort(): CryptoPort {
  return new NodeCryptoPort();
}
