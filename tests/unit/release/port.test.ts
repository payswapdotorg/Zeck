/**
 * Unit — the release-control port vocabulary (WORK-047 / D-06; the
 * RELEASE-IDENTITY checkpoint): the deterministic release identity,
 * the fail-closed exact-commit validation and the closed phase
 * vocabularies.
 */

import { describe, expect, test } from "vitest";
import {
  evidenceDigestOf,
  GATE_EVIDENCE_SOURCES,
  GATE_STATUSES,
  isHostingEnvironment,
  isReleasePhase,
  PROMOTION_DECISIONS,
  RELEASE_PHASES,
  releaseIdentityId,
  validateReleaseIdentityInputs,
} from "../../../src/platform/release/port";

describe("the release identity (WORK-047 D-06)", () => {
  const REVISION = "5d26365ee9b8e55f41b923328443ae746205757a";
  const DIGEST = "a".repeat(64);

  test("the release id is content-addressed and deterministic", () => {
    const a = releaseIdentityId(REVISION, DIGEST);
    const b = releaseIdentityId(REVISION, DIGEST);
    const c = releaseIdentityId("f".repeat(40), DIGEST);
    const d = releaseIdentityId(REVISION, "b".repeat(64));
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).not.toBe(d);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  test("a release not tied to an exact 40-hex commit is rejected fail-closed", () => {
    // The discrimination requirement: "a deployment not tied to an
    // exact commit must be rejected".
    for (const bad of [
      "",
      "short",
      "HEAD",
      "main",
      REVISION.slice(0, 39),
      `${REVISION}0`,
      REVISION.toUpperCase(),
      "not-a-sha-at-all-12345678901234567890",
    ]) {
      const result = validateReleaseIdentityInputs(bad, DIGEST);
      expect(result.valid, `revision "${bad}" must be rejected`).toBe(false);
      expect(result.message).toContain("exact 40-hex Git commit");
    }
  });

  test("a malformed manifest digest is rejected", () => {
    const result = validateReleaseIdentityInputs(REVISION, "not-a-digest");
    expect(result.valid).toBe(false);
    expect(result.message).toContain("64-hex sha256");
  });

  test("the exact inputs validate", () => {
    expect(validateReleaseIdentityInputs(REVISION, DIGEST).valid).toBe(true);
  });

  test("the evidence digest is deterministic over the canonical payload", () => {
    expect(evidenceDigestOf("abc")).toBe(evidenceDigestOf("abc"));
    expect(evidenceDigestOf("abc")).not.toBe(evidenceDigestOf("abd"));
    expect(evidenceDigestOf("abc")).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("the closed vocabularies", () => {
  test("the ladder phases (ci is a check phase, not a hosting environment)", () => {
    expect(RELEASE_PHASES).toEqual(["local", "ci", "preview", "staging", "production"]);
    expect(isReleasePhase("local")).toBe(true);
    expect(isReleasePhase("ci")).toBe(true);
    expect(isReleasePhase("dev")).toBe(false);
  });

  test("the hosting environments exclude the ci check phase", () => {
    expect(isHostingEnvironment("local")).toBe(true);
    expect(isHostingEnvironment("ci")).toBe(false);
    expect(isHostingEnvironment("production")).toBe(true);
    expect(isHostingEnvironment("staging")).toBe(true);
  });

  test("gate statuses and evidence sources are closed", () => {
    expect(GATE_STATUSES).toEqual(["passed", "failed"]);
    expect(GATE_EVIDENCE_SOURCES).toEqual(["tool-run", "external-attach"]);
    expect(PROMOTION_DECISIONS).toEqual(["promoted", "refused"]);
  });
});
