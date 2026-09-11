/**
 * Validation harness evidence contract (VAL-002, acceptance criterion 6).
 *
 * The harness emits evidence CONSUMABLE BY THE UNIVERSAL RECORDER
 * (VAL-004): a complete, deterministic, secret-free record of one
 * customer-style run — identity, revisions, the submitted request, the
 * completion timeline, the result digest, surfaced errors, assertion
 * verdicts and timings. The mechanical validator below is the
 * consumption gate the recorder (and the report projection) will rely
 * on: an incomplete evidence record can never count as delivered.
 */

import { createHash } from "node:crypto";

/** One poll observation in the completion timeline. */
export interface TimelineObservation {
  readonly at: string;
  readonly status: string;
}

/** One surfaced transport/API error. */
export interface SurfacedError {
  readonly at: string;
  readonly status: number | null;
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
}

/** One deterministic assertion verdict. */
export interface AssertionVerdict {
  readonly name: string;
  readonly passed: boolean;
  readonly detail: string;
}

/** The complete evidence record of one harness run. */
export interface HarnessEvidence {
  /** Stable run identity (derived by the run-identity contract). */
  readonly runId: string;
  readonly program: string;
  readonly workOrder: string;
  /** Zeck revision the app integrates with (dispatch base). */
  readonly baseRevision: string;
  readonly applicationRevision: string;
  readonly corpusRevision: string;
  readonly integrationSurface: string;
  /** The submitted execution request (task shape — never secrets). */
  readonly request: {
    readonly taskKind: string;
    readonly idempotencyKey: string;
    readonly constraints: Readonly<Record<string, unknown>> | null;
  } | null;
  /** Completion observations in poll order. */
  readonly timeline: readonly TimelineObservation[];
  /** Terminal status reached (null when the run timed out). */
  readonly terminalStatus: string | null;
  /** SHA-256 digest of the retrieved result JSON (null when none). */
  readonly resultDigest: string | null;
  /** Verification statuses of the retrieved result (when present). */
  readonly verificationStatuses: readonly string[];
  /** Errors surfaced through the public error-reporting modes. */
  readonly errors: readonly SurfacedError[];
  /** Deterministic assertion verdicts. */
  readonly assertions: readonly AssertionVerdict[];
  /** Wall-clock timings in milliseconds. */
  readonly timings: {
    readonly submitMs: number | null;
    readonly completionMs: number | null;
    readonly retrievalMs: number | null;
    readonly totalMs: number;
  };
}

/** One evidence rejection finding. */
export interface EvidenceViolation {
  readonly path: string;
  readonly reason: string;
}

const NON_EMPTY = /^.+$/;
const RUN_ID_SHAPE = /^val-run-[0-9a-f]{64}$/;
const SHA_256 = /^sha256:[0-9a-f]{64}$/;
const TERMINAL = ["COMPLETED", "FAILED", "CANCELLED", "EXPIRED"];

/**
 * Validate a harness evidence record for recorder consumption. Every
 * identity/revision field must be present and well-shaped; the run id
 * must carry the derived form; the timeline must be chronological and
 * non-empty when a terminal status is claimed; the result digest must
 * be a SHA-256; timings must be non-negative; assertion verdicts must
 * be named and decided.
 */
export function validateHarnessEvidence(evidence: HarnessEvidence): readonly EvidenceViolation[] {
  const violations: EvidenceViolation[] = [];
  const requireText = (path: string, value: unknown): void => {
    if (typeof value !== "string" || !NON_EMPTY.test(value)) {
      violations.push({ path, reason: "must be a non-empty string" });
    }
  };

  requireText("runId", evidence?.runId);
  if (typeof evidence?.runId === "string" && !RUN_ID_SHAPE.test(evidence.runId)) {
    violations.push({ path: "runId", reason: "must carry the derived val-run-<sha256> form" });
  }
  requireText("program", evidence?.program);
  requireText("workOrder", evidence?.workOrder);
  requireText("baseRevision", evidence?.baseRevision);
  requireText("applicationRevision", evidence?.applicationRevision);
  requireText("corpusRevision", evidence?.corpusRevision);
  requireText("integrationSurface", evidence?.integrationSurface);

  if (evidence?.request !== null && evidence?.request !== undefined) {
    requireText("request.taskKind", evidence.request.taskKind);
    requireText("request.idempotencyKey", evidence.request.idempotencyKey);
  }

  if (!Array.isArray(evidence?.timeline)) {
    violations.push({ path: "timeline", reason: "must be an array" });
  } else {
    evidence.timeline.forEach((observation, index) => {
      requireText(`timeline[${index}].at`, observation?.at);
      requireText(`timeline[${index}].status`, observation?.status);
    });
    for (let index = 1; index < evidence.timeline.length; index += 1) {
      const previous = evidence.timeline[index - 1]?.at ?? "";
      const current = evidence.timeline[index]?.at ?? "";
      if (previous > current) {
        violations.push({
          path: `timeline[${index}].at`,
          reason: "timeline observations must be chronological",
        });
      }
    }
  }

  if (typeof evidence?.terminalStatus === "string" && !TERMINAL.includes(evidence.terminalStatus)) {
    violations.push({ path: "terminalStatus", reason: "must be a terminal status or null" });
  }
  if (evidence?.terminalStatus !== null && evidence?.terminalStatus !== undefined) {
    if (!Array.isArray(evidence.timeline) || evidence.timeline.length === 0) {
      violations.push({
        path: "timeline",
        reason: "a terminal status requires at least one observation",
      });
    }
  }
  if (typeof evidence?.resultDigest === "string" && !SHA_256.test(evidence.resultDigest)) {
    violations.push({ path: "resultDigest", reason: "must be a sha256 hex digest or null" });
  }

  if (!Array.isArray(evidence?.errors)) {
    violations.push({ path: "errors", reason: "must be an array" });
  } else {
    evidence.errors.forEach((error, index) => {
      requireText(`errors[${index}].at`, error?.at);
      requireText(`errors[${index}].code`, error?.code);
      requireText(`errors[${index}].message`, error?.message);
    });
  }

  if (!Array.isArray(evidence?.assertions)) {
    violations.push({ path: "assertions", reason: "must be an array" });
  } else {
    evidence.assertions.forEach((verdict, index) => {
      requireText(`assertions[${index}].name`, verdict?.name);
      if (typeof verdict?.passed !== "boolean") {
        violations.push({
          path: `assertions[${index}].passed`,
          reason: "must be a decided boolean",
        });
      }
      requireText(`assertions[${index}].detail`, verdict?.detail);
    });
  }

  const timings = evidence?.timings;
  if (!timings || typeof timings.totalMs !== "number" || timings.totalMs < 0) {
    violations.push({ path: "timings.totalMs", reason: "must be a non-negative number" });
  } else {
    for (const field of ["submitMs", "completionMs", "retrievalMs"] as const) {
      const value = timings[field];
      if (value !== null && (typeof value !== "number" || value < 0)) {
        violations.push({
          path: `timings.${field}`,
          reason: "must be a non-negative number or null",
        });
      }
    }
  }

  return violations;
}

/** Deterministic result digest: SHA-256 over the canonical result JSON,
 * in the `sha256:<hex>` form the evidence contract requires. */
export function digestResult(result: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalJson(result)).digest("hex")}`;
}

/** Canonical JSON: sorted keys, no insignificant whitespace. */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}
