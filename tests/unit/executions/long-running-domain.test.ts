/**
 * Unit: the long-running execution domain (WORK-028, LNG-001/002/003).
 *
 * The pure invariants of the checkpoint / lease / wake-up / operation
 * domains — the structural restart contract, the integrity and
 * compatibility rules, the materiality comparison, the lease-guard
 * classification (fail-closed on every mismatch class) and the wake-up
 * status machine + deterministic ordering.
 *
 * The crash-injection and concurrency halves live in
 * `longrunning-crash-recovery.test.ts` (kill/restart C-proofs) and the
 * real-PostgreSQL suites (physical discipline).
 */

import { createHash } from "node:crypto";
import { describe, expect, test } from "vitest";
import {
  type CheckpointContents,
  type CheckpointRecord,
  canonicalCheckpointJson,
  checkpointDigestInput,
  checkpointIncompatibility,
  checkpointIntegrityFailure,
  MATERIAL_CHANGE_DIMENSIONS,
  materialChangeBetween,
  materialFactsOf,
  type ResumeFacts,
  validateCheckpointContents,
  validateResumeFacts,
} from "../../../src/modules/executions/domain/checkpoint";
import {
  classifyLease,
  LEASE_RELEASE_CAUSES,
  type LeaseRecord,
  leaseGuardRejection,
} from "../../../src/modules/executions/domain/lease";
import {
  executionScopedDiscriminator,
  isLongRunningOperationKind,
  LONG_RUNNING_OPERATION_KINDS,
  longRunningOperationKey,
} from "../../../src/modules/executions/domain/longrunning";
import {
  canTransitionWakeUp,
  compareWakeUpOrder,
  WAKE_UP_STATUSES,
  type WakeUpRecord,
} from "../../../src/modules/executions/domain/wakeup";
import { PlatformError } from "../../../src/shared/errors";

const sha256 = (input: string): string => createHash("sha256").update(input).digest("hex");

const EXECUTION_ID = "00000000-0000-7000-8000-000000000001";
const OTHER_EXECUTION_ID = "00000000-0000-7000-8000-000000000002";

const contents = (overrides: Partial<CheckpointContents> = {}): CheckpointContents => ({
  executionId: EXECUTION_ID,
  planId: "plan-1",
  planRevision: 3,
  contextArtifactRefs: ["artifact:ctx/1", "artifact:ctx/2"],
  lastEventPosition: 7,
  resourceClass: "standard",
  environmentId: null,
  environmentSpecDigest: null,
  requiredCapabilities: ["cap-a", "cap-b"],
  maxCostMicroUsd: null,
  ...overrides,
});

const facts = (overrides: Partial<ResumeFacts> = {}): ResumeFacts => ({
  planId: "plan-1",
  planRevision: 3,
  resourceClass: "standard",
  environmentId: null,
  environmentSpecDigest: null,
  requiredCapabilities: ["cap-a", "cap-b"],
  maxCostMicroUsd: null,
  ...overrides,
});

const recordOf = (
  body: CheckpointContents,
  digestValue = sha256(checkpointDigestInput(body)),
): CheckpointRecord => ({
  id: "00000000-0000-7000-8000-0000000000c1",
  applicationId: "00000000-0000-7000-8000-0000000000a1",
  tenantId: "00000000-0000-7000-8000-0000000000t1",
  executionId: body.executionId,
  checkpointSequence: 1,
  contents: body,
  contentDigest: digestValue,
  recordedBy: "worker-1",
  createdAt: "2026-09-15T12:00:00.000Z",
});

// ---------------------------------------------------------------------------
// Checkpoint contents — the STRUCTURAL restart contract
// ---------------------------------------------------------------------------

describe("checkpoint contents validation (the structural restart contract)", () => {
  test("accepts the fully-formed restart contents", () => {
    expect(() => validateCheckpointContents(contents())).not.toThrow();
  });

  test.each([
    ["executionId must be a uuid", { executionId: "not-a-uuid" }],
    ["planId must be non-empty", { planId: "" }],
    ["planRevision must be a positive integer", { planRevision: 0 }],
    ["contextArtifactRefs must be strings", { contextArtifactRefs: [1 as unknown as string] }],
    ["lastEventPosition must be positive", { lastEventPosition: 0 }],
    ["resourceClass must be non-empty", { resourceClass: "" }],
    ["environmentId must be a uuid or null", { environmentId: "env" }],
    ["environmentSpecDigest must be 64-hex or null", { environmentSpecDigest: "abc" }],
    ["requiredCapabilities must be strings", { requiredCapabilities: [null as unknown as string] }],
    ["maxCostMicroUsd must be an integer micro-USD string or null", { maxCostMicroUsd: "1.5" }],
  ])("rejects typed (%s)", (_label, overrides) => {
    expect(() => validateCheckpointContents(contents(overrides))).toThrow(PlatformError);
  });

  test("every required field is structural — the null-object probe fails typed", () => {
    const asRecord = contents() as unknown as Record<string, unknown>;
    // The three environment/cost bindings are legitimately null-able;
    // the other seven are structurally required.
    const required = [
      "executionId",
      "planId",
      "planRevision",
      "contextArtifactRefs",
      "lastEventPosition",
      "resourceClass",
      "requiredCapabilities",
    ];
    for (const key of required) {
      const broken = { ...asRecord, [key]: null } as unknown as CheckpointContents;
      expect(() => validateCheckpointContents(broken)).toThrow(PlatformError);
    }
  });

  test("resume facts follow the same shape discipline", () => {
    expect(() => validateResumeFacts(facts())).not.toThrow();
    expect(() => validateResumeFacts(facts({ planRevision: -1 }))).toThrow(PlatformError);
  });
});

// ---------------------------------------------------------------------------
// Integrity — the digest over the canonical form
// ---------------------------------------------------------------------------

describe("checkpoint integrity (tamper rejection)", () => {
  test("an intact record verifies (no failure)", () => {
    expect(checkpointIntegrityFailure(recordOf(contents()), sha256)).toBeNull();
  });

  test("a tampered contents field fails the digest recomputation", () => {
    const tampered = recordOf(contents());
    const broken = {
      ...tampered,
      contents: contents({ lastEventPosition: 8 }),
    };
    const failure = checkpointIntegrityFailure(broken, sha256);
    expect(failure).toMatch(/digest mismatch/i);
  });

  test("a tampered stored digest fails", () => {
    const broken = recordOf(contents(), sha256("not-the-real-digest"));
    expect(checkpointIntegrityFailure(broken, sha256)).toMatch(/digest mismatch/i);
  });

  test("contents that bind to a different execution identity fail the identity check", () => {
    const foreign = recordOf(contents());
    const broken = { ...foreign, executionId: OTHER_EXECUTION_ID };
    expect(checkpointIntegrityFailure(broken, sha256)).toMatch(/identity mismatch/i);
  });

  test("the canonical form is key-order stable (digest reproducibility)", () => {
    const a = contents();
    const b = contents();
    const aJson = canonicalCheckpointJson({
      ...a,
      requiredCapabilities: [...a.requiredCapabilities],
    });
    // Same logical contents, differently-ordered key insertion:
    const reordered = {
      maxCostMicroUsd: a.maxCostMicroUsd,
      requiredCapabilities: a.requiredCapabilities,
      environmentSpecDigest: a.environmentSpecDigest,
      environmentId: a.environmentId,
      resourceClass: a.resourceClass,
      lastEventPosition: a.lastEventPosition,
      contextArtifactRefs: a.contextArtifactRefs,
      planRevision: a.planRevision,
      planId: a.planId,
      executionId: a.executionId,
    } satisfies CheckpointContents;
    expect(canonicalCheckpointJson(reordered)).toBe(aJson);
    expect(checkpointDigestInput(a)).toBe(checkpointDigestInput(reordered));
  });

  test("every content field is covered by the digest", () => {
    const base = contents();
    const digests = new Set([sha256(checkpointDigestInput(base))]);
    for (const key of Object.keys(base) as (keyof CheckpointContents)[]) {
      const mutated = { ...base, [key]: mutatedValue(key) } as CheckpointContents;
      digests.add(sha256(checkpointDigestInput(mutated)));
    }
    // 1 base + 10 distinct single-field mutations = 11 distinct digests.
    expect(digests.size).toBe(11);
  });
});

function mutatedValue(key: keyof CheckpointContents): unknown {
  switch (key) {
    case "executionId":
      return OTHER_EXECUTION_ID;
    case "planId":
      return "plan-2";
    case "planRevision":
      return 4;
    case "contextArtifactRefs":
      return ["artifact:ctx/other"];
    case "lastEventPosition":
      return 8;
    case "resourceClass":
      return "large";
    case "environmentId":
      return "00000000-0000-7000-8000-0000000000e1";
    case "environmentSpecDigest":
      return "a".repeat(64);
    case "requiredCapabilities":
      return ["cap-c"];
    case "maxCostMicroUsd":
      return "120000";
  }
}

// ---------------------------------------------------------------------------
// Compatibility — plan identity and revision discipline
// ---------------------------------------------------------------------------

describe("checkpoint compatibility (revision discipline)", () => {
  test("identical facts are compatible", () => {
    expect(checkpointIncompatibility(contents(), facts())).toBeNull();
  });

  test("a NEWER revision is not incompatibility (material change decides)", () => {
    expect(checkpointIncompatibility(contents(), facts({ planRevision: 5 }))).toBeNull();
  });

  test("a STALE downgrade revision is incompatible", () => {
    expect(checkpointIncompatibility(contents(), facts({ planRevision: 2 }))).toMatch(
      /stale downgrade/i,
    );
  });

  test("a different plan is incompatible", () => {
    expect(checkpointIncompatibility(contents(), facts({ planId: "plan-2" }))).toMatch(
      /cannot be resumed under plan/i,
    );
  });
});

// ---------------------------------------------------------------------------
// The materiality rule (LNG-003)
// ---------------------------------------------------------------------------

describe("the materiality rule", () => {
  test("MATERIAL_CHANGE_DIMENSIONS covers exactly the six admission-relevant dimensions", () => {
    expect([...MATERIAL_CHANGE_DIMENSIONS].sort()).toEqual([
      "environmentId",
      "environmentSpecDigest",
      "maxCostMicroUsd",
      "planRevision",
      "requiredCapabilities",
      "resourceClass",
    ]);
  });

  test("an unchanged resume is NOT materially changed (no re-admission)", () => {
    expect(materialChangeBetween(contents(), facts())).toEqual([]);
    // Capability order is not a material fact.
    expect(
      materialChangeBetween(contents(), facts({ requiredCapabilities: ["cap-b", "cap-a"] })),
    ).toEqual([]);
  });

  test.each([
    ["planRevision", { planRevision: 4 }],
    ["resourceClass", { resourceClass: "large" }],
    ["environmentId", { environmentId: "00000000-0000-7000-8000-0000000000e1" }],
    ["environmentSpecDigest", { environmentSpecDigest: "b".repeat(64) }],
    ["requiredCapabilities", { requiredCapabilities: ["cap-a", "cap-b", "cap-c"] }],
    ["maxCostMicroUsd", { maxCostMicroUsd: "9000000" }],
  ])("a changed %s is materially changed", (dimension, overrides) => {
    expect(materialChangeBetween(contents(), facts(overrides))).toContain(dimension);
  });

  test("materialFactsOf projects the checkpoint's admission facts", () => {
    const projected = materialFactsOf(contents());
    expect(projected.planId).toBe("plan-1");
    expect(projected.planRevision).toBe(3);
    expect(projected.resourceClass).toBe("standard");
    expect(materialChangeBetween(contents(), projected)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The lease domain
// ---------------------------------------------------------------------------

const NOW = "2026-09-15T12:00:00.000Z";

const lease = (overrides: Partial<LeaseRecord> = {}): LeaseRecord => ({
  executionId: EXECUTION_ID,
  applicationId: "00000000-0000-7000-8000-0000000000a1",
  tenantId: "00000000-0000-7000-8000-0000000000t1",
  ownerId: "worker-1",
  epoch: 2,
  acquiredAt: "2026-09-15T11:59:00.000Z",
  expiresAt: "2026-09-15T12:01:00.000Z",
  lastHeartbeatAt: "2026-09-15T11:59:30.000Z",
  heartbeatCount: 3,
  releasedAt: null,
  releaseCause: null,
  ...overrides,
});

describe("the lease-validity guard (stale workers fail closed)", () => {
  test("the exact (owner, epoch) claim on a live lease is accepted", () => {
    expect(leaseGuardRejection(lease(), { ownerId: "worker-1", epoch: 2 }, NOW)).toBeNull();
  });

  test("no lease row at all fails closed", () => {
    const rejection = leaseGuardRejection(null, { ownerId: "worker-1", epoch: 1 }, NOW);
    expect(rejection?.code).toBe("INVALID_STATE_TRANSITION");
    expect(rejection?.reason).toMatch(/no execution lease is held/i);
  });

  test("a released lease fails closed (even for the last owner)", () => {
    const rejection = leaseGuardRejection(
      lease({ releasedAt: NOW, releaseCause: "paused" }),
      { ownerId: "worker-1", epoch: 2 },
      NOW,
    );
    expect(rejection?.code).toBe("INVALID_STATE_TRANSITION");
    expect(rejection?.reason).toMatch(/released/i);
  });

  test("a superseded epoch (a newer worker re-acquired) fails closed", () => {
    const rejection = leaseGuardRejection(
      lease({ epoch: 3 }),
      { ownerId: "worker-1", epoch: 2 },
      NOW,
    );
    expect(rejection?.code).toBe("INVALID_STATE_TRANSITION");
    expect(rejection?.reason).toMatch(/epoch mismatch/i);
  });

  test("a foreign live owner fails closed (lease conflicts fail closed)", () => {
    const rejection = leaseGuardRejection(
      lease({ ownerId: "worker-2" }),
      { ownerId: "worker-1", epoch: 2 },
      NOW,
    );
    expect(rejection?.code).toBe("INVALID_STATE_TRANSITION");
    expect(rejection?.reason).toMatch(/held by another owner/i);
  });

  test("an expired lease fails closed typed EXPIRED (the stale-worker class)", () => {
    const rejection = leaseGuardRejection(
      lease({ expiresAt: "2026-09-15T11:59:59.000Z" }),
      { ownerId: "worker-1", epoch: 2 },
      NOW,
    );
    expect(rejection?.code).toBe("EXPIRED");
    expect(rejection?.reason).toMatch(/expired/i);
  });

  test("classifyLease: held / expired / released", () => {
    expect(classifyLease(lease(), NOW)).toBe("held");
    expect(classifyLease(lease({ expiresAt: NOW }), NOW)).toBe("expired");
    expect(classifyLease(lease({ releasedAt: NOW, releaseCause: "paused" }), NOW)).toBe("released");
  });

  test("the release-cause vocabulary is the governed set", () => {
    expect([...LEASE_RELEASE_CAUSES].sort()).toEqual([
      "human-interruption",
      "paused",
      "terminated",
      "worker-released",
    ]);
  });
});

// ---------------------------------------------------------------------------
// Wake-ups
// ---------------------------------------------------------------------------

const wakeUp = (overrides: Partial<WakeUpRecord> = {}): WakeUpRecord => ({
  id: "00000000-0000-7000-8000-0000000000w1",
  applicationId: "00000000-0000-7000-8000-0000000000a1",
  tenantId: "00000000-0000-7000-8000-0000000000t1",
  executionId: EXECUTION_ID,
  wakeKey: "wake-1",
  cause: "tool-timeout",
  earliestWakeAt: "2026-09-15T13:00:00.000Z",
  status: "scheduled",
  appliedAt: null,
  appliedOperationKey: null,
  supersedeCause: null,
  createdAt: NOW,
  updatedAt: NOW,
  ...overrides,
});

describe("wake-ups (deterministic ordering + the write-once status machine)", () => {
  test("the status vocabulary is frozen", () => {
    expect([...WAKE_UP_STATUSES]).toEqual(["scheduled", "applied", "superseded"]);
  });

  test("scheduled -> applied | superseded only; terminal states have NO outgoing edge", () => {
    expect(canTransitionWakeUp("scheduled", "applied")).toBe(true);
    expect(canTransitionWakeUp("scheduled", "superseded")).toBe(true);
    expect(canTransitionWakeUp("applied", "scheduled")).toBe(false);
    expect(canTransitionWakeUp("applied", "superseded")).toBe(false);
    expect(canTransitionWakeUp("superseded", "applied")).toBe(false);
    expect(canTransitionWakeUp("superseded", "superseded")).toBe(false);
  });

  test("due ordering is (earliestWakeAt, id) — deterministic", () => {
    const a = wakeUp();
    const b = wakeUp({
      id: "00000000-0000-7000-8000-0000000000w2",
      earliestWakeAt: "2026-09-15T12:30:00.000Z",
    });
    const c = wakeUp({
      id: "00000000-0000-7000-8000-0000000000w0",
      earliestWakeAt: "2026-09-15T13:00:00.000Z",
    });
    expect([a, b, c].sort(compareWakeUpOrder).map((record) => record.id)).toEqual([
      b.id,
      c.id,
      a.id,
    ]);
  });
});

// ---------------------------------------------------------------------------
// The durable operation state (stable keys)
// ---------------------------------------------------------------------------

describe("the durable operation-state key scheme", () => {
  test("the operation kind vocabulary covers the governed operations", () => {
    expect(LONG_RUNNING_OPERATION_KINDS).toContain("checkpoint");
    expect(LONG_RUNNING_OPERATION_KINDS).toContain("resume");
    expect(LONG_RUNNING_OPERATION_KINDS).toContain("lease-acquire");
    expect(LONG_RUNNING_OPERATION_KINDS).toContain("interrupt");
    expect(LONG_RUNNING_OPERATION_KINDS).toContain("wakeup-apply");
    for (const kind of LONG_RUNNING_OPERATION_KINDS) {
      expect(isLongRunningOperationKind(kind)).toBe(true);
    }
    expect(isLongRunningOperationKind("nope")).toBe(false);
  });

  test("the operation key is kind + execution-scoped discriminator", () => {
    expect(longRunningOperationKey("resume", `${EXECUTION_ID}:retry-1`)).toBe(
      `lrop:resume:${EXECUTION_ID}:retry-1`,
    );
  });

  test("the discriminator is execution-scoped by construction (the WORK-024 lesson)", () => {
    const d1 = executionScopedDiscriminator(EXECUTION_ID, "retry-1");
    const d2 = executionScopedDiscriminator(OTHER_EXECUTION_ID, "retry-1");
    expect(d1).not.toBe(d2);
  });
});
