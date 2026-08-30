/**
 * Unit: platform crypto adapter + envelope cipher (WORK-003, surface
 * `src/platform/crypto/`).
 */

import { describe, expect, test } from "vitest";
import {
  CIPHER_VERSION,
  createEnvelopeCipher,
  EnvelopeIntegrityError,
  generateMasterKey,
} from "../../../src/platform/crypto/envelope-cipher";
import { createNodeCryptoPort } from "../../../src/platform/crypto/node-crypto";

describe("NodeCryptoPort", () => {
  const port = createNodeCryptoPort();

  test("randomBytes returns the requested length and fresh values", () => {
    const a = port.randomBytes(32);
    const b = port.randomBytes(32);
    expect(a).toHaveLength(32);
    expect(b).toHaveLength(32);
    expect([...a]).not.toEqual([...b]);
  });

  test("randomBytes rejects out-of-range lengths", () => {
    expect(() => port.randomBytes(-1)).toThrow(RangeError);
    expect(() => port.randomBytes(1.5)).toThrow(RangeError);
  });

  test("randomToken is url-safe with expected entropy", () => {
    const token = port.randomToken(32);
    expect(token).toMatch(/^[A-Za-z0-9_-]{32}$/);
  });

  test("sha256Hex matches the known vector", () => {
    expect(port.sha256Hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });
});

describe("EnvelopeCipher (aes-256-gcm-v1)", () => {
  test("requires exactly 32 bytes of key material", () => {
    expect(() => createEnvelopeCipher(new Uint8Array(16))).toThrow(RangeError);
    expect(() => createEnvelopeCipher(generateMasterKey())).not.toThrow();
  });

  test("seal/open roundtrips and binds AAD", () => {
    const cipher = createEnvelopeCipher(generateMasterKey());
    const envelope = cipher.seal("sk-or-v1-secret-material", "connections.credentials:ref-1");
    expect(cipher.version).toBe(CIPHER_VERSION);
    expect(cipher.open(envelope, "connections.credentials:ref-1")).toBe("sk-or-v1-secret-material");
    // AAD mismatch (transplanted ciphertext) fails authentication.
    expect(() => cipher.open(envelope, "connections.credentials:ref-2")).toThrow(
      EnvelopeIntegrityError,
    );
  });

  test("ciphertext never contains plaintext", () => {
    const cipher = createEnvelopeCipher(generateMasterKey());
    const plaintext = "sk-ant-api03-PLAINTEXT-MARKER";
    const envelope = cipher.seal(plaintext, "aad");
    const asText = Buffer.from(envelope).toString("latin1");
    expect(asText).not.toContain(plaintext);
    expect(asText).not.toContain("PLAINTEXT-MARKER");
  });

  test("tampered ciphertext fails closed with a generic error", () => {
    const cipher = createEnvelopeCipher(generateMasterKey());
    const envelope = cipher.seal("material", "aad");
    const last = envelope.length - 1;
    envelope[last] = (envelope[last] ?? 0) ^ 0xff;
    try {
      cipher.open(envelope, "aad");
      expect.unreachable("tampered envelope must not open");
    } catch (error) {
      expect(error).toBeInstanceOf(EnvelopeIntegrityError);
      expect((error as Error).message).not.toContain("material");
    }
  });

  test("wrong master key fails with the same generic error", () => {
    const sealing = createEnvelopeCipher(generateMasterKey());
    const opening = createEnvelopeCipher(generateMasterKey());
    const envelope = sealing.seal("material", "aad");
    expect(() => opening.open(envelope, "aad")).toThrow(EnvelopeIntegrityError);
  });

  test("envelope layout: 12-byte IV + 16-byte tag + ciphertext", () => {
    const cipher = createEnvelopeCipher(generateMasterKey());
    const envelope = cipher.seal("x", "aad");
    expect(envelope.length).toBe(12 + 16 + 1);
  });
});
