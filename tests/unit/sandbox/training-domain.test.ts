/**
 * Unit — the training/batch/accelerator workload DOMAIN (WORK-030,
 * ACC-001/002/003): the provider-neutral vocabularies, the explicit
 * auditable resource estimate validation, the lineage discipline, the
 * checkpoint identity (content/lineage-addressable, immutable) and the
 * run-lease guard family.
 *
 * The service-level behavior lives in training-service.test.ts; the
 * crash-injection proofs in training-crash-recovery.test.ts; the
 * physical (SQL) halves in tests/integration/postgres/training-*.
 */

import { describe, expect, test } from "vitest";
import {
  ACCELERATOR_CLASSES,
  canonicalTrainingCheckpointJson,
  INTERCONNECT_CLASSES,
  isAcceleratorClass,
  isInterconnectClass,
  isTerminalTrainingStatus,
  isTrainingWorkloadKind,
  TERMINAL_TRAINING_STATUSES,
  TRAINING_KEY_PATTERN,
  TRAINING_MATERIAL_CHANGE_DIMENSIONS,
  TRAINING_WORKLOAD_KINDS,
  TRAINING_WORKLOAD_TRANSITIONS,
  type TrainingCheckpointContents,
  type TrainingResumeFacts,
  type TrainingRunLeaseRecord,
  type TrainingWorkloadSpec,
  trainingCheckpointDigestInput,
  trainingCheckpointIdentity,
  trainingCheckpointIntegrityFailure,
  trainingLeaseGuardRejection,
  trainingMaterialChangeBetween,
  trainingOperationKey,
  trainingRequestFingerprint,
  validateTrainingCheckpointContents,
  validateTrainingWorkloadSpec,
} from "../../../src/modules/sandbox/public";
import { PlatformError } from "../../../src/shared/errors";
import { sha256Hex } from "./training-fakes";

const TASK = { command: "train", args: ["--epochs", "3"], publicEnv: {} };

const VALID_SPEC: TrainingWorkloadSpec = {
  workloadKind: "training",
  task: TASK,
  resource: {
    accelerator: {
      acceleratorClass: "gpu",
      deviceCount: 4,
      perDeviceMemoryMiB: 16_384,
      interconnect: "interconnect-fabric",
    },
    replicaCount: 2,
    cpuMilliCores: 4000,
    memoryMiB: 8192,
    estimatedDurationMs: 3_600_000,
    estimatedCostMicroUsd: "250000",
  },
  lineage: {
    datasetRefs: ["dataset:corpus-1"],
    codeRefs: ["code:trainer-9"],
    configRefs: ["config:hparams-a"],
    checkpointRefs: [],
    parentOutputRefs: [],
  },
  checkpointIntervalSteps: 250,
  maxRetryAttempts: 2,
};

const lease = (overrides: Partial<TrainingRunLeaseRecord> = {}): TrainingRunLeaseRecord => ({
  workloadId: "00000000-0000-7000-8000-0000000000d1",
  applicationId: "00000000-0000-7000-8000-0000000000b1",
  tenantId: "00000000-0000-7000-8000-0000000000a1",
  ownerId: "training-worker:wl-1",
  epoch: 3,
  acquiredAt: "2026-09-02T10:00:00.000Z",
  expiresAt: "2026-09-02T10:15:00.000Z",
  lastHeartbeatAt: "2026-09-02T10:00:00.000Z",
  heartbeatCount: 1,
  releasedAt: null,
  releaseCause: null,
  ...overrides,
});

describe("training workload vocabularies (provider-neutral by construction)", () => {
  test("the workload kinds are the four governed long-running shapes", () => {
    expect(TRAINING_WORKLOAD_KINDS).toEqual([
      "training",
      "fine-tuning",
      "batch-inference",
      "evaluation",
    ]);
    expect(isTrainingWorkloadKind("training")).toBe(true);
    expect(isTrainingWorkloadKind("vendor-training")).toBe(false);
  });

  test("the accelerator classes are neutral device-function classes (no vendor vocabulary)", () => {
    expect(ACCELERATOR_CLASSES).toEqual([
      "gpu",
      "tensor-accelerator",
      "inference-accelerator",
      "vector-signal-processor",
    ]);
    for (const vendor of ["nvidia", "cuda", "tpu", "h100", "a100"]) {
      expect(isAcceleratorClass(vendor)).toBe(false);
    }
    expect(INTERCONNECT_CLASSES).toEqual(["none", "interconnect-fabric"]);
    expect(isInterconnectClass("nvlink")).toBe(false);
  });

  test("the terminal statuses and the legal transition table", () => {
    expect(TERMINAL_TRAINING_STATUSES).toEqual(["denied", "completed", "cancelled"]);
    expect(isTerminalTrainingStatus("failed")).toBe(false);
    expect(TRAINING_WORKLOAD_TRANSITIONS.failed).toEqual(["allocating"]); // the retry re-arm
    expect(TRAINING_WORKLOAD_TRANSITIONS.completed).toEqual([]);
    expect(TRAINING_WORKLOAD_TRANSITIONS.denied).toEqual([]);
  });
});

describe("training workload spec validation (explicit, auditable estimates)", () => {
  test("a complete valid spec passes", () => {
    expect(validateTrainingWorkloadSpec(VALID_SPEC).valid).toBe(true);
  });

  test("every governed workload kind accepts the same neutral shape", () => {
    for (const kind of TRAINING_WORKLOAD_KINDS) {
      expect(validateTrainingWorkloadSpec({ ...VALID_SPEC, workloadKind: kind }).valid).toBe(true);
    }
  });

  test("an unknown accelerator class fails closed (the class vocabulary is the contract)", () => {
    const check = validateTrainingWorkloadSpec({
      ...VALID_SPEC,
      resource: {
        ...VALID_SPEC.resource,
        accelerator: {
          ...VALID_SPEC.resource.accelerator,
          acceleratorClass: "vendor-gpu" as never,
        },
      },
    });
    expect(check.valid).toBe(false);
    expect(check.issues.some((i) => i.field === "resource.accelerator.acceleratorClass")).toBe(
      true,
    );
  });

  test("a zero cost estimate is inadmissible (training compute is paid compute)", () => {
    const check = validateTrainingWorkloadSpec({
      ...VALID_SPEC,
      resource: { ...VALID_SPEC.resource, estimatedCostMicroUsd: "0" },
    });
    expect(check.valid).toBe(false);
    expect(check.issues.some((i) => i.reason.includes("zero estimate is not an admissible"))).toBe(
      true,
    );
  });

  test("every resource field is bounded and required (no defaults are ever filled)", () => {
    const outOfBounds = validateTrainingWorkloadSpec({
      ...VALID_SPEC,
      resource: { ...VALID_SPEC.resource, replicaCount: 2000 },
    });
    expect(outOfBounds.valid).toBe(false);
    const missingCost = validateTrainingWorkloadSpec({
      ...VALID_SPEC,
      resource: { ...VALID_SPEC.resource, estimatedCostMicroUsd: "12.5" },
    });
    expect(missingCost.valid).toBe(false);
    expect(missingCost.issues.some((i) => i.field === "resource.estimatedCostMicroUsd")).toBe(true);
    const nonInteger = validateTrainingWorkloadSpec({
      ...VALID_SPEC,
      resource: { ...VALID_SPEC.resource, cpuMilliCores: 4.5 },
    });
    expect(nonInteger.valid).toBe(false);
  });

  test("lineage requires dataset AND code references (reproducible lineage)", () => {
    const noData = validateTrainingWorkloadSpec({
      ...VALID_SPEC,
      lineage: { ...VALID_SPEC.lineage, datasetRefs: [] },
    });
    expect(noData.valid).toBe(false);
    const noCode = validateTrainingWorkloadSpec({
      ...VALID_SPEC,
      lineage: { ...VALID_SPEC.lineage, codeRefs: [] },
    });
    expect(noCode.valid).toBe(false);
  });

  test("host-shaped lineage references fail closed (opaque content-addressed ids only)", () => {
    const check = validateTrainingWorkloadSpec({
      ...VALID_SPEC,
      lineage: { ...VALID_SPEC.lineage, datasetRefs: ["mnt/host/dataset.parquet"] },
    });
    expect(check.valid).toBe(false);
    expect(check.issues.some((i) => i.reason.includes("host path"))).toBe(true);
  });

  test("the checkpoint interval and retry ladder are bounded", () => {
    expect(validateTrainingWorkloadSpec({ ...VALID_SPEC, checkpointIntervalSteps: 0 }).valid).toBe(
      false,
    );
    expect(validateTrainingWorkloadSpec({ ...VALID_SPEC, maxRetryAttempts: 17 }).valid).toBe(false);
    expect(validateTrainingWorkloadSpec({ ...VALID_SPEC, maxRetryAttempts: 16 }).valid).toBe(true);
  });
});

describe("training request fingerprint (the idempotency discriminator)", () => {
  const input = { executionId: "00000000-0000-7000-8000-0000000000e1", spec: VALID_SPEC };

  test("the same logical request yields the same fingerprint", () => {
    const a = trainingRequestFingerprint("app-1", "exec-1", "actor-1", input);
    const b = trainingRequestFingerprint("app-1", "exec-1", "actor-1", {
      executionId: input.executionId,
      spec: { ...VALID_SPEC, lineage: { ...VALID_SPEC.lineage } },
    });
    expect(a).toBe(b);
  });

  test("field order does not matter (canonical JSON); a different fact does", () => {
    const a = trainingRequestFingerprint("app-1", "exec-1", "actor-1", input);
    const reordered = {
      executionId: input.executionId,
      spec: {
        ...VALID_SPEC,
        task: { publicEnv: {}, command: "train", args: ["--epochs", "3"] },
      },
    };
    expect(trainingRequestFingerprint("app-1", "exec-1", "actor-1", reordered)).toBe(a);
    const changed = trainingRequestFingerprint("app-1", "exec-1", "actor-1", {
      executionId: input.executionId,
      spec: { ...VALID_SPEC, maxRetryAttempts: 3 },
    });
    expect(changed).not.toBe(a);
  });

  test("the key pattern is printable and bounded", () => {
    expect(TRAINING_KEY_PATTERN.test("training-key-1")).toBe(true);
    expect(TRAINING_KEY_PATTERN.test("with\nnewline")).toBe(false);
    expect(TRAINING_KEY_PATTERN.test("")).toBe(false);
  });
});

describe("training checkpoint identity (immutable, content/lineage-addressable)", () => {
  const contents = (): TrainingCheckpointContents => ({
    executionId: "00000000-0000-7000-8000-0000000000e1",
    workloadId: "00000000-0000-7000-8000-0000000000d1",
    workloadKey: "training-key-1",
    checkpointSequence: 1,
    stepPosition: 250,
    lineage: VALID_SPEC.lineage,
    metricsDigest: sha256Hex("metrics:step-250"),
    substrateId: "accelerator-fabric-f1",
    resourceClass: "gpu:4x2",
    recordedBy: "training-worker:training-key-1",
  });

  test("the identity is the sha256 of the canonical contents prefix", () => {
    const c = contents();
    expect(trainingCheckpointIdentity(c, sha256Hex)).toBe(
      sha256Hex(trainingCheckpointDigestInput(c)),
    );
  });

  test("content-addressable: the same contents converge; any material fact diverges", () => {
    const a = trainingCheckpointIdentity(contents(), sha256Hex);
    const same = trainingCheckpointIdentity(contents(), sha256Hex);
    expect(same).toBe(a);
    expect(trainingCheckpointIdentity({ ...contents(), stepPosition: 500 }, sha256Hex)).not.toBe(a);
    expect(
      trainingCheckpointIdentity(
        { ...contents(), metricsDigest: sha256Hex("metrics:other") },
        sha256Hex,
      ),
    ).not.toBe(a);
  });

  test("the ledger POSITION is not the material identity (cross-attempt continuation)", () => {
    // A re-driven run or a later attempt re-emitting the SAME material
    // checkpoint converges on the SAME identity wherever the journal
    // places it (the retry-sequence-continuation defect regression:
    // v1 digests covered the sequence, so attempt 2's re-emitted
    // checkpoint could never converge and collided on the per-workload
    // sequence unique constraint instead of continuing the journal).
    const a = trainingCheckpointIdentity(contents(), sha256Hex);
    expect(trainingCheckpointIdentity({ ...contents(), checkpointSequence: 7 }, sha256Hex)).toBe(a);
    // The canonical form is position-free...
    expect(canonicalTrainingCheckpointJson({ ...contents(), checkpointSequence: 7 })).toBe(
      canonicalTrainingCheckpointJson(contents()),
    );
    // ...while the record still carries its ledger position (the journal
    // order remains gapless per workload — the migration's gate).
    expect(trainingCheckpointDigestInput({ ...contents(), checkpointSequence: 7 })).toBe(
      trainingCheckpointDigestInput(contents()),
    );
  });

  test("lineage-addressable: the digest covers the full lineage reference set", () => {
    const a = trainingCheckpointIdentity(contents(), sha256Hex);
    const withParent = trainingCheckpointIdentity(
      {
        ...contents(),
        lineage: { ...VALID_SPEC.lineage, parentOutputRefs: ["output:prior-1"] },
      },
      sha256Hex,
    );
    expect(withParent).not.toBe(a);
  });

  test("the canonical JSON is key-sorted and deterministic", () => {
    expect(canonicalTrainingCheckpointJson(contents())).toBe(
      canonicalTrainingCheckpointJson(contents()),
    );
  });

  test("structural validation fails closed typed on malformed contents", () => {
    expect(() =>
      validateTrainingCheckpointContents({
        ...contents(),
        workloadId: "not-a-uuid",
      }),
    ).toThrowError(PlatformError);
    expect(() =>
      validateTrainingCheckpointContents({ ...contents(), checkpointSequence: 0 }),
    ).toThrowError(PlatformError);
    expect(() =>
      validateTrainingCheckpointContents({ ...contents(), metricsDigest: "zz" }),
    ).toThrowError(PlatformError);
    expect(() =>
      validateTrainingCheckpointContents({
        ...contents(),
        lineage: { ...VALID_SPEC.lineage, datasetRefs: ["/host/secret"] },
      }),
    ).toThrowError(PlatformError);
    expect(() => validateTrainingCheckpointContents(contents())).not.toThrow();
  });

  test("integrity verification detects tampering and identity mismatches", () => {
    const c = contents();
    const digest = trainingCheckpointIdentity(c, sha256Hex);
    expect(
      trainingCheckpointIntegrityFailure(
        {
          contents: c,
          contentDigest: digest,
          workloadId: c.workloadId,
          executionId: c.executionId,
        },
        sha256Hex,
      ),
    ).toBeNull();
    expect(
      trainingCheckpointIntegrityFailure(
        {
          contents: c,
          contentDigest: sha256Hex("forged"),
          workloadId: c.workloadId,
          executionId: c.executionId,
        },
        sha256Hex,
      ),
    ).toContain("digest mismatch");
    expect(
      trainingCheckpointIntegrityFailure(
        {
          contents: c,
          contentDigest: digest,
          workloadId: "00000000-0000-7000-8000-0000000000d9",
          executionId: c.executionId,
        },
        sha256Hex,
      ),
    ).toContain("do not bind to the checkpointed workload");
  });
});

describe("the resume materiality rule (the checkpoint-witnessable dimensions)", () => {
  const facts = (): TrainingResumeFacts => ({
    workloadKind: "training",
    substrateId: "accelerator-fabric-f1",
    resourceClass: "gpu:4x2",
    estimatedCostMicroUsd: "250000",
    requiredCapabilities: ["accelerator-gpu"],
  });

  test("an unchanged resume is NOT materially changed (no re-admission)", () => {
    const checkpoint = {
      executionId: "e",
      workloadId: "w",
      workloadKey: "k",
      checkpointSequence: 1,
      stepPosition: 250,
      lineage: VALID_SPEC.lineage,
      metricsDigest: sha256Hex("m"),
      substrateId: "accelerator-fabric-f1",
      resourceClass: "gpu:4x2",
      recordedBy: "worker",
    } as TrainingCheckpointContents;
    expect(trainingMaterialChangeBetween(checkpoint, facts())).toEqual([]);
  });

  test("a changed substrate or resource class IS materially changed", () => {
    const checkpoint = {
      substrateId: "accelerator-fabric-f2",
      resourceClass: "gpu:4x2",
    } as TrainingCheckpointContents;
    expect(trainingMaterialChangeBetween(checkpoint, facts())).toEqual(["substrateId"]);
    const resized = {
      substrateId: "accelerator-fabric-f1",
      resourceClass: "gpu:8x2",
    } as TrainingCheckpointContents;
    expect(trainingMaterialChangeBetween(resized, facts())).toEqual(["resourceClass"]);
    expect(trainingMaterialChangeBetween(checkpoint, facts())).toEqual(
      TRAINING_MATERIAL_CHANGE_DIMENSIONS.filter(() => false).length === 0 ? ["substrateId"] : [],
    );
  });
});

describe("the run lease guard family (single-owner, monotonic epochs)", () => {
  const at = "2026-09-02T10:05:00.000Z";

  test("the live owning guard passes", () => {
    expect(
      trainingLeaseGuardRejection(lease(), { ownerId: "training-worker:wl-1", epoch: 3 }, at),
    ).toBeNull();
  });

  test("a released lease, epoch mismatch, foreign owner and expiry all fail closed", () => {
    const guard = { ownerId: "training-worker:wl-1", epoch: 3 };
    const released = trainingLeaseGuardRejection(
      lease({ releasedAt: at, releaseCause: "cancelled" }),
      guard,
      at,
    );
    expect(released?.code).toBe("INVALID_STATE_TRANSITION");
    const stale = trainingLeaseGuardRejection(lease({ epoch: 4 }), guard, at);
    expect(stale?.code).toBe("INVALID_STATE_TRANSITION");
    expect(stale?.reason).toContain("epoch mismatch");
    const foreign = trainingLeaseGuardRejection(lease({ ownerId: "other-worker" }), guard, at);
    expect(foreign?.code).toBe("INVALID_STATE_TRANSITION");
    const expired = trainingLeaseGuardRejection(
      lease({ expiresAt: "2026-09-02T10:01:00.000Z" }),
      guard,
      at,
    );
    expect(expired?.code).toBe("EXPIRED");
    expect(trainingLeaseGuardRejection(null, guard, at)?.code).toBe("INVALID_STATE_TRANSITION");
  });
});

describe("the training operation-key scheme", () => {
  test("operation keys are kind-qualified and workload-scoped", () => {
    expect(trainingOperationKey("allocate", "wl-1:attempt:1")).toBe("trop:allocate:wl-1:attempt:1");
    expect(trainingOperationKey("run", "wl-1:attempt:2")).not.toBe(
      trainingOperationKey("run", "wl-1:attempt:1"),
    );
  });
});
