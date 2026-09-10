/**
 * Environment fingerprinting unit suite (WORK-055): the closed entry
 * vocabulary, canonical content-addressed identity, determinism,
 * deduplication, total round-trip validation, and typed drift
 * detection.
 */

import { describe, expect, test } from "vitest";
import { FailureRecoveryError } from "../../../../src/platform/failure-recovery/catalog";
import {
  compareFingerprints,
  fingerprintOf,
  validateEnvironmentFingerprint,
} from "../../../../src/platform/failure-recovery/fingerprint";
import { digest } from "./world";

function expectReject(invariant: string, fn: () => unknown): FailureRecoveryError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(FailureRecoveryError);
    const typed = error as FailureRecoveryError;
    expect(typed.invariant).toBe(invariant);
    return typed;
  }
  throw new Error("expected a typed rejection");
}

const ENTRIES = [
  { kind: "model-route", provider: "rail-a", model: "model-x" },
  { kind: "substrate", substrateId: "mid-container-b", version: "2.0.0" },
  { kind: "tool", toolId: "document-retrieval", version: "1.4.0" },
  { kind: "configuration", name: "sandbox-profile", digest: digest.sha256Hex("config:sandbox") },
];

describe("environment fingerprinting (WORK-055)", () => {
  test("the fingerprint is content-addressed and deterministic", () => {
    const first = fingerprintOf(ENTRIES, digest);
    const second = fingerprintOf(ENTRIES, digest);
    expect(first.fingerprintId).toBe(second.fingerprintId);
    expect(first.fingerprintId).toMatch(/^[0-9a-f]{64}$/);
    expect(first.entries).toHaveLength(4);
  });

  test("entry input order and duplicates never change the identity (canonical form)", () => {
    const canonical = fingerprintOf(ENTRIES, digest);
    const reordered = fingerprintOf([...ENTRIES].reverse(), digest);
    expect(reordered.fingerprintId).toBe(canonical.fingerprintId);
    const duplicated = fingerprintOf([...ENTRIES, ENTRIES[0]], digest);
    expect(duplicated.fingerprintId).toBe(canonical.fingerprintId);
  });

  test("a drifted entry produces a DIFFERENT identity (content addressing)", () => {
    const original = fingerprintOf(ENTRIES, digest);
    const drifted = fingerprintOf(
      ENTRIES.map((entry) =>
        entry.kind === "configuration"
          ? { ...entry, digest: digest.sha256Hex("config:changed") }
          : entry,
      ),
      digest,
    );
    expect(drifted.fingerprintId).not.toBe(original.fingerprintId);
  });

  test("entries outside the closed vocabulary are rejected", () => {
    expectReject("fingerprint-shape", () =>
      fingerprintOf([{ kind: "vendor", vendor: "e2b" } as never], digest),
    );
    expectReject("fingerprint-shape", () =>
      fingerprintOf([{ kind: "model-route", provider: "NOT A SLUG", model: "x" }], digest),
    );
    expectReject("fingerprint-shape", () =>
      fingerprintOf([{ kind: "configuration", name: "cfg", digest: "deadbeef" }], digest),
    );
    expectReject("fingerprint-shape", () =>
      fingerprintOf(
        [...Array(129)].map((_, i) => ({ kind: "tool", toolId: `t${i}`, version: "1" })),
        digest,
      ),
    );
  });

  test("round-trip validation: tampered identities are rejected at read time", () => {
    const fingerprint = fingerprintOf(ENTRIES, digest);
    const roundTripped = validateEnvironmentFingerprint(
      JSON.parse(JSON.stringify(fingerprint)),
      digest,
    );
    expect(roundTripped.fingerprintId).toBe(fingerprint.fingerprintId);
    const tampered = {
      ...JSON.parse(JSON.stringify(fingerprint)),
      fingerprintId: digest.sha256Hex("forged"),
    };
    expectReject("fingerprint-shape", () => validateEnvironmentFingerprint(tampered, digest));
    const mutatedEntry = JSON.parse(JSON.stringify(fingerprint));
    mutatedEntry.entries[0].model = "model-z";
    expectReject("fingerprint-shape", () => validateEnvironmentFingerprint(mutatedEntry, digest));
  });

  test("comparison: identical fingerprints match; drift is typed and named", () => {
    const original = fingerprintOf(ENTRIES, digest);
    const same = fingerprintOf([...ENTRIES].reverse(), digest);
    expect(compareFingerprints(original, same)).toEqual({ status: "match" });

    // A changed substrate version: only-original + only-resumed drift pair.
    const resumed = fingerprintOf(
      ENTRIES.map((entry) => (entry.kind === "substrate" ? { ...entry, version: "2.1.0" } : entry)),
      digest,
    );
    const comparison = compareFingerprints(original, resumed);
    expect(comparison.status).toBe("drift");
    if (comparison.status === "drift") {
      expect(comparison.drifted).toHaveLength(2);
      const keys = comparison.drifted.map((drift) => drift.entryKey);
      expect(keys).toContain("substrate:mid-container-b@2.0.0");
      expect(keys).toContain("substrate:mid-container-b@2.1.0");
    }
  });

  test("an added environment entry is only-resumed drift (fail-closed input for apply)", () => {
    const original = fingerprintOf(ENTRIES.slice(0, 3), digest);
    const resumed = fingerprintOf(ENTRIES, digest);
    const comparison = compareFingerprints(original, resumed);
    expect(comparison.status).toBe("drift");
    if (comparison.status === "drift") {
      expect(comparison.drifted.every((drift) => drift.kind === "only-resumed")).toBe(true);
    }
  });
});
