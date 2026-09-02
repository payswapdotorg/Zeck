/**
 * Checkpoint domain (executions module domain; WORK-028, LNG-001).
 *
 * A CHECKPOINT is the durable, integrity-protected restart point of a
 * long-running execution. The Work Order's implementation requirement
 * makes the contents STRUCTURAL — every field is a required, typed
 * column of the restart contract, never optional metadata:
 *
 *   * `executionId` — the checkpoint binds to the EXISTING execution
 *     identity (there is no second execution identity — the frozen
 *     invariant; checkpoints REFERENCE executions, they never become
 *     one);
 *   * `planId` + `planRevision` — the plan/revision the execution was
 *     running under at checkpoint time (resume REJECTS incompatible
 *     revisions — see `checkpointIncompatibility`);
 *   * `contextArtifactRefs` — the context/artifact references of the
 *     restart state;
 *   * `lastEventPosition` — the last durable event position the worker
 *     had consumed (recovery replays only what is not durably
 *     committed beyond this position);
 *   * the MATERIAL FACTS of admission (`resourceClass`,
 *     `environmentId`, `environmentSpecDigest`,
 *     `requiredCapabilities`, `maxCostMicroUsd`) — the dimensions the
 *     resume materiality rule compares to decide re-admission
 *     (LNG-003: a materially changed resume re-enters the CURRENT
 *     policy/budget/capability controls).
 *
 * INTEGRITY: the checkpoint content digest is a sha256 over the
 * canonical serialization below; resume RECOMPUTES it and rejects a
 * mismatch (tampered/corrupt checkpoints fail closed). The digest is
 * computed by the application service through an injected digest
 * function (provider-neutral); this module owns the canonical form so
 * the digest is stable across processes and stores.
 */

import { PlatformError } from "../../../shared/errors";

/** The structural restart contents of one checkpoint (all fields required). */
export interface CheckpointContents {
  readonly executionId: string;
  readonly planId: string;
  readonly planRevision: number;
  readonly contextArtifactRefs: readonly string[];
  readonly lastEventPosition: number;
  readonly resourceClass: string;
  readonly environmentId: string | null;
  readonly environmentSpecDigest: string | null;
  readonly requiredCapabilities: readonly string[];
  readonly maxCostMicroUsd: string | null;
}

/** The material admission facts the resume materiality rule compares. */
export interface ResumeFacts {
  readonly planId: string;
  readonly planRevision: number;
  readonly resourceClass: string;
  readonly environmentId: string | null;
  readonly environmentSpecDigest: string | null;
  readonly requiredCapabilities: readonly string[];
  readonly maxCostMicroUsd: string | null;
}

/** The durable checkpoint record (write-once, per-execution sequence). */
export interface CheckpointRecord {
  readonly id: string;
  readonly applicationId: string;
  readonly tenantId: string;
  readonly executionId: string;
  /** Per-execution monotonic sequence (1..N, write-once per sequence). */
  readonly checkpointSequence: number;
  readonly contents: CheckpointContents;
  /** sha256 hex over `canonicalCheckpointJson(contents)` at record time. */
  readonly contentDigest: string;
  /** The worker/actor identity that recorded the checkpoint. */
  readonly recordedBy: string;
  readonly createdAt: string;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MICRO_USD_PATTERN = /^\d{1,19}$/;

/** Structural validation — rejects malformed contents typed (POLICY_DENIED is the input-contract code of this module). */
export function validateCheckpointContents(contents: CheckpointContents): void {
  if (typeof contents.executionId !== "string" || !UUID_PATTERN.test(contents.executionId)) {
    throw new PlatformError({
      code: "POLICY_DENIED",
      message: "checkpoint contents require a valid executionId (the existing execution identity)",
    });
  }
  if (typeof contents.planId !== "string" || contents.planId.length === 0) {
    throw new PlatformError({
      code: "POLICY_DENIED",
      message: "checkpoint contents require a non-empty planId",
    });
  }
  if (!Number.isInteger(contents.planRevision) || contents.planRevision < 1) {
    throw new PlatformError({
      code: "POLICY_DENIED",
      message: "checkpoint contents require a positive integer planRevision",
    });
  }
  if (
    !Array.isArray(contents.contextArtifactRefs) ||
    contents.contextArtifactRefs.some((ref) => typeof ref !== "string")
  ) {
    throw new PlatformError({
      code: "POLICY_DENIED",
      message: "checkpoint contents require contextArtifactRefs as an array of strings",
    });
  }
  if (!Number.isInteger(contents.lastEventPosition) || contents.lastEventPosition < 1) {
    throw new PlatformError({
      code: "POLICY_DENIED",
      message: "checkpoint contents require a positive integer lastEventPosition",
    });
  }
  if (typeof contents.resourceClass !== "string" || contents.resourceClass.length === 0) {
    throw new PlatformError({
      code: "POLICY_DENIED",
      message: "checkpoint contents require a non-empty resourceClass",
    });
  }
  if (contents.environmentId !== null && !UUID_PATTERN.test(contents.environmentId)) {
    throw new PlatformError({
      code: "POLICY_DENIED",
      message: "checkpoint contents require a valid environmentId or null",
    });
  }
  if (
    contents.environmentSpecDigest !== null &&
    !/^[0-9a-f]{64}$/.test(contents.environmentSpecDigest)
  ) {
    throw new PlatformError({
      code: "POLICY_DENIED",
      message: "checkpoint contents require a 64-hex environmentSpecDigest or null",
    });
  }
  if (
    !Array.isArray(contents.requiredCapabilities) ||
    contents.requiredCapabilities.some((cap) => typeof cap !== "string")
  ) {
    throw new PlatformError({
      code: "POLICY_DENIED",
      message: "checkpoint contents require requiredCapabilities as an array of strings",
    });
  }
  if (contents.maxCostMicroUsd !== null && !MICRO_USD_PATTERN.test(contents.maxCostMicroUsd)) {
    throw new PlatformError({
      code: "POLICY_DENIED",
      message: "checkpoint contents require maxCostMicroUsd as an integer micro-USD string or null",
    });
  }
}

/** Validate the resume facts (same shape discipline as the contents). */
export function validateResumeFacts(facts: ResumeFacts): void {
  validateCheckpointContents({
    executionId: "00000000-0000-7000-8000-0000000000ff",
    planId: facts.planId,
    planRevision: facts.planRevision,
    contextArtifactRefs: [],
    lastEventPosition: 1,
    resourceClass: facts.resourceClass,
    environmentId: facts.environmentId,
    environmentSpecDigest: facts.environmentSpecDigest,
    requiredCapabilities: facts.requiredCapabilities,
    maxCostMicroUsd: facts.maxCostMicroUsd,
  });
}

/** Deterministic key-recursive canonical JSON (the digest base). */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.keys(record)
      .sort()
      .map((key) => [key, canonicalize(record[key])]);
  }
  return value;
}

/**
 * The canonical serialization of the checkpoint contents — the digest
 * base. Key-sorted, whitespace-free, stable across processes/stores.
 */
export function canonicalCheckpointJson(contents: CheckpointContents): string {
  return JSON.stringify(canonicalize(contents));
}

/**
 * The checkpoint digest input handed to the injected digest function.
 * The digest covers the FULL structural contents — any field tampering
 * changes it.
 */
export function checkpointDigestInput(contents: CheckpointContents): string {
  return `zeck:checkpoint:v1:${canonicalCheckpointJson(contents)}`;
}

/**
 * INTEGRITY VERIFICATION (the resume requirement): recompute the digest
 * over the record's contents and compare against the stored digest.
 * Returns the failure reason, or null when the checkpoint is intact.
 */
export function checkpointIntegrityFailure(
  record: Pick<CheckpointRecord, "contents" | "contentDigest" | "executionId">,
  digest: (input: string) => string,
): string | null {
  if (record.contents.executionId !== record.executionId) {
    return "checkpoint identity mismatch: contents do not bind to the checkpointed execution";
  }
  const recomputed = digest(checkpointDigestInput(record.contents));
  if (recomputed !== record.contentDigest) {
    return "checkpoint content digest mismatch: the durable checkpoint is corrupt or was tampered with";
  }
  return null;
}

/** The material-change dimensions (LNG-003 materiality vocabulary). */
export const MATERIAL_CHANGE_DIMENSIONS = [
  "planRevision",
  "resourceClass",
  "environmentId",
  "environmentSpecDigest",
  "requiredCapabilities",
  "maxCostMicroUsd",
] as const;

export type MaterialChangeDimension = (typeof MATERIAL_CHANGE_DIMENSIONS)[number];

/**
 * THE MATERIALIZITY RULE (explicit, as the Work Order requires): a resume
 * is MATERIALLY CHANGED when any admission-relevant fact differs from the
 * checkpointed fact. Returns the list of changed dimensions (empty = an
 * unchanged resume, which skips re-admission — the crash-recovery
 * precedent: an identical retry resumes without re-consulting admission).
 */
export function materialChangeBetween(
  checkpoint: CheckpointContents,
  facts: ResumeFacts,
): readonly MaterialChangeDimension[] {
  const changed: MaterialChangeDimension[] = [];
  if (checkpoint.planRevision !== facts.planRevision) {
    changed.push("planRevision");
  }
  if (checkpoint.resourceClass !== facts.resourceClass) {
    changed.push("resourceClass");
  }
  if (checkpoint.environmentId !== facts.environmentId) {
    changed.push("environmentId");
  }
  if (checkpoint.environmentSpecDigest !== facts.environmentSpecDigest) {
    changed.push("environmentSpecDigest");
  }
  const checkpointCaps = [...checkpoint.requiredCapabilities].sort().join("\u0000");
  const factsCaps = [...facts.requiredCapabilities].sort().join("\u0000");
  if (checkpointCaps !== factsCaps) {
    changed.push("requiredCapabilities");
  }
  if (checkpoint.maxCostMicroUsd !== facts.maxCostMicroUsd) {
    changed.push("maxCostMicroUsd");
  }
  return changed;
}

/**
 * INCOMPATIBILITY (the resume requirement "reject incompatible
 * revisions"): a checkpoint CANNOT be resumed under a different plan, or
 * under an OLDER revision than the one it was recorded at (no rewind).
 * A NEWER revision is not incompatibility — it is a MATERIAL CHANGE
 * (re-admission decides whether the resume is admissible).
 * Returns the rejection reason, or null when compatible.
 */
export function checkpointIncompatibility(
  checkpoint: CheckpointContents,
  facts: ResumeFacts,
): string | null {
  if (checkpoint.planId !== facts.planId) {
    return `checkpoint belongs to plan ${checkpoint.planId}; it cannot be resumed under plan ${facts.planId}`;
  }
  if (facts.planRevision < checkpoint.planRevision) {
    return `checkpoint was recorded at plan revision ${checkpoint.planRevision}; revision ${facts.planRevision} is a stale downgrade (incompatible)`;
  }
  return null;
}

/** The material facts of a checkpoint, as the resume comparison input. */
export function materialFactsOf(contents: CheckpointContents): ResumeFacts {
  return {
    planId: contents.planId,
    planRevision: contents.planRevision,
    resourceClass: contents.resourceClass,
    environmentId: contents.environmentId,
    environmentSpecDigest: contents.environmentSpecDigest,
    requiredCapabilities: contents.requiredCapabilities,
    maxCostMicroUsd: contents.maxCostMicroUsd,
  };
}
