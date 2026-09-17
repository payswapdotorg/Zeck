/**
 * Unit tests — the promotion/rollback identity guards (DEP-003 AC4:
 * "The promote path verifies deployment identity before promotion and
 * re-attests on rollback; both directions carry tests").
 *
 * Pure decisions over attestation facts:
 *
 *  PROMOTE direction (promotionIdentityGuard):
 *  - no plane URL configured → allowed with the HONEST note (the
 *    recorded identity-audit gate evidence — the ledger binding —
 *    remains the identity authority; never a fabricated verification);
 *  - an unverified plane (unreachable, schema drift, tampering) →
 *    REFUSED before promotion, fail closed;
 *  - a verified plane attesting the WRONG revision → REFUSED with the
 *    exact mismatch;
 *  - a verified plane at the candidate revision → allowed with the
 *    journal evidence (revision + runtime identity + digests).
 *
 *  ROLLBACK direction (rollbackReattestation):
 *  - an unverified plane after the pointer flip → the re-attestation
 *    fails closed with the repoint instruction;
 *  - a plane still attesting the FROM revision (not yet repointed) →
 *    the re-attestation fails with the exact honest reason;
 *  - a plane attesting the TARGET revision → the re-attestation
 *    succeeds (the repoint landed; domain authority untouched — the
 *    identity document is hosting-independent by construction).
 */

import { describe, expect, test } from "vitest";
import {
  type PlaneAttestation,
  promotionIdentityGuard,
  rollbackReattestation,
} from "../../../deploy/plane-identity";

const CANDIDATE = "a".repeat(40);
const OTHER = "b".repeat(40);

function verifiedAttestation(revision: string): PlaneAttestation {
  return {
    verified: true,
    planeUrl: "https://api.example.com",
    expectedRevision: revision,
    attested: {
      runtimeIdentityId: "r".repeat(64),
      gitRevision: revision,
      manifestDigest: "m".repeat(64),
      topologyDigest: "t".repeat(64),
      environment: "production",
    },
  };
}

describe("the promote-path identity guard (AC4, forward direction)", () => {
  test("no plane URL configured: allowed with the honest ledger-binding note (no fabricated verification)", () => {
    const decision = promotionIdentityGuard(null, CANDIDATE);
    expect(decision.allowed).toBe(true);
    expect(decision.reason).toContain("no plane URL configured");
    expect(decision.reason).toContain("identity-audit");
    expect(decision.evidence).toBeUndefined();
  });

  test("an unverified plane (unreachable/tampered) refuses promotion fail-closed", () => {
    const decision = promotionIdentityGuard(
      {
        verified: false,
        reason: "the deployed plane at https://api.example.com is unreachable (fail closed): …",
        planeUrl: "https://api.example.com",
        expectedRevision: CANDIDATE,
      },
      CANDIDATE,
    );
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain("deployment identity verification failed");
    expect(decision.reason).toContain("unreachable");
  });

  test("a verified plane attesting the WRONG revision refuses with the exact mismatch", () => {
    const decision = promotionIdentityGuard(verifiedAttestation(OTHER), CANDIDATE);
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain(OTHER);
    expect(decision.reason).toContain(CANDIDATE);
  });

  test("a verified plane at the candidate revision allows with the journal evidence", () => {
    const decision = promotionIdentityGuard(verifiedAttestation(CANDIDATE), CANDIDATE);
    expect(decision.allowed).toBe(true);
    expect(decision.reason).toBeUndefined();
    expect(decision.evidence).toContain("https://api.example.com");
    expect(decision.evidence).toContain(CANDIDATE.slice(0, 12));
    expect(decision.evidence).toContain("manifest digest");
    expect(decision.evidence).toContain("topology digest");
  });
});

describe("the rollback-path re-attestation (AC4, reverse direction)", () => {
  test("an unverified plane after the pointer flip fails closed with the repoint instruction", () => {
    const decision = rollbackReattestation(
      {
        verified: false,
        reason: "GET /identity of the plane at https://api.example.com answered 503",
        planeUrl: "https://api.example.com",
        expectedRevision: OTHER,
      },
      OTHER,
    );
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain("post-rollback re-attestation failed");
    expect(decision.reason).toContain("repoint the plane");
  });

  test("a plane still attesting the FROM revision (not yet repointed) fails with the honest reason", () => {
    const decision = rollbackReattestation(verifiedAttestation(CANDIDATE), OTHER);
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain("not yet repointed");
    expect(decision.reason).toContain(CANDIDATE);
    expect(decision.reason).toContain(OTHER);
  });

  test("a plane attesting the TARGET revision re-attests successfully", () => {
    const decision = rollbackReattestation(verifiedAttestation(OTHER), OTHER);
    expect(decision.allowed).toBe(true);
    expect(decision.reason).toBeUndefined();
    expect(decision.evidence).toContain("re-attested the rollback target revision");
    expect(decision.evidence).toContain(OTHER.slice(0, 12));
  });
});
