/**
 * The pinned-application integration runtime contract (PPR-018A scope
 * item 1; ACR-006 §2 + ACR-007 §1/§3) — the DOMAIN half.
 *
 * A certified run (a corpus proof run, or a Demo Mirror run) may only
 * execute through ONE exact application revision plus ONE exact Zeck
 * integration revision — the same pins the bound evidence record
 * carries. This module defines the runtime-binding vocabulary and the
 * fail-closed exactness checks that make UNPINNED application
 * execution structurally impossible:
 *
 *  - a runtime session descriptor names the exact pins it started with;
 *  - `validateRuntimeBinding` compares a session (or a requested
 *    binding) against the expected record binding — BOTH revision
 *    pins and the application identity must match EXACTLY (comparison
 *    is exact string equality; a different pin is a different object,
 *    never an update — the revisions.ts discipline);
 *  - `runtimeBindingIssues` is the fail-closed guard the runner and
 *    the Demo Mirror run service call BEFORE any task execution: a
 *    mismatched or missing binding is a named defect, never a
 *    best-effort run.
 *
 * RUN-LEVEL OUTCOME VOCABULARY (the work order's completeness rules):
 * the corpus runner must distinguish PASS / NOT-RUN / BLOCKED / FAIL /
 * BYPASS_DETECTED. This vocabulary is RUN-level (what one corpus task
 * or one demo run did); it is NOT the application-level compatibility
 * status (status.ts owns that, derived from whole records — nothing
 * here upgrades or echoes it).
 *
 * Pure and total: no environment, no clock, no I/O.
 */

import type { ApplicationIdentity, RevisionPin } from "./revisions";
import { revisionPinsEqual } from "./revisions";

/** The exact runtime binding a certified run must execute. */
export interface RuntimeBinding {
  /** The Zeck application identity the integration's executions carry. */
  readonly applicationId: string;
  /** BOTH exact revision pins (upstream application + Zeck integration). */
  readonly pin: RevisionPin;
}

/** What a started pinned runtime reports about itself (fail-closed facts). */
export interface RuntimeSessionDescriptor {
  /** The runtime's registry id (the Demo Mirror runBinding's runtime id). */
  readonly runtimeId: string;
  readonly applicationId: string;
  readonly pin: RevisionPin;
  /** When the session started (ISO timestamp, from the injected clock). */
  readonly startedAt: string;
}

/** A named runtime-binding defect (machine-readable, rendered verbatim). */
export interface RuntimeBindingIssue {
  readonly field: string;
  readonly issue: string;
}

/** Validate a runtime binding object's structure (mandatory, non-empty). */
export function validateRuntimeBinding(binding: unknown): readonly RuntimeBindingIssue[] {
  if (typeof binding !== "object" || binding === null) {
    return [{ field: "runtimeBinding", issue: "runtime binding must be an object" }];
  }
  const record = binding as { applicationId?: unknown; pin?: unknown };
  const issues: RuntimeBindingIssue[] = [];
  if (typeof record.applicationId !== "string" || record.applicationId.trim().length === 0) {
    issues.push({
      field: "runtimeBinding.applicationId",
      issue: "the runtime binding's application id is mandatory",
    });
  }
  const pin = record.pin as
    | { upstreamRevision?: unknown; integrationRevision?: unknown }
    | undefined;
  if (
    typeof pin?.upstreamRevision !== "string" ||
    pin.upstreamRevision.trim().length === 0 ||
    typeof pin?.integrationRevision !== "string" ||
    pin.integrationRevision.trim().length === 0
  ) {
    issues.push({
      field: "runtimeBinding.pin",
      issue: "the runtime binding carries BOTH exact revision pins (upstream + integration)",
    });
  }
  return issues;
}

/**
 * The exactness guard: does a session (or requested runtime) match the
 * binding the evidence record carries? EXACT equality on the application
 * id and BOTH pins — anything else is a named defect. Pure.
 */
export function runtimeBindingIssues(
  expected: RuntimeBinding,
  actual: RuntimeBinding,
): readonly RuntimeBindingIssue[] {
  const issues: RuntimeBindingIssue[] = [];
  if (expected.applicationId !== actual.applicationId) {
    issues.push({
      field: "runtimeBinding.applicationId",
      issue: `the runtime's application id (${actual.applicationId}) does not match the bound record's application id (${expected.applicationId}) — a certified run may only execute the exact pinned application`,
    });
  }
  if (!revisionPinsEqual(expected.pin, actual.pin)) {
    issues.push({
      field: "runtimeBinding.pin",
      issue: `the runtime's revision pins (upstream ${actual.pin.upstreamRevision}, integration ${actual.pin.integrationRevision}) do not match the bound record's pins (upstream ${expected.pin.upstreamRevision}, integration ${expected.pin.integrationRevision}) — unpinned application execution is refused, never best-effort`,
    });
  }
  return issues;
}

/** Convenience: true only when the binding matches exactly. */
export function runtimeBindingMatches(expected: RuntimeBinding, actual: RuntimeBinding): boolean {
  return runtimeBindingIssues(expected, actual).length === 0;
}

/** The expected runtime binding of one pinned application record. */
export function runtimeBindingOf(pinned: {
  readonly identity: ApplicationIdentity;
  readonly pin: RevisionPin;
}): RuntimeBinding {
  return { applicationId: pinned.identity.applicationId, pin: pinned.pin };
}

// ---------------------------------------------------------------------------
// The run-level outcome vocabulary (the work order's completeness rules)
// ---------------------------------------------------------------------------

/**
 * The run-level outcome vocabulary. These are NOT application-level
 * compatibility statuses (status.ts owns those); they name what ONE
 * run (one corpus task, one demo execution) did:
 *
 *  - PASS: real external execution with exact revision/evidence;
 *  - NOT-RUN: infrastructure/credential/access unavailable;
 *  - BLOCKED: a known required external capability is unavailable;
 *  - FAIL: the certified application path did not preserve required
 *    behavior (the task's own declared success check failed);
 *  - BYPASS_DETECTED: a material AI edge escaped Zeck during the run.
 */
export const RUN_OUTCOMES = ["PASS", "NOT-RUN", "BLOCKED", "FAIL", "BYPASS_DETECTED"] as const;
export type RunOutcome = (typeof RUN_OUTCOMES)[number];

export function isRunOutcome(value: unknown): value is RunOutcome {
  return typeof value === "string" && (RUN_OUTCOMES as readonly string[]).includes(value);
}

/** Why a run did not pass (the honest NOT-RUN/BLOCKED cause, with its owner). */
export interface RunNotRunCause {
  readonly outcome: "NOT-RUN" | "BLOCKED";
  readonly cause: string;
  readonly owner: string;
}

/**
 * Derive the run-level outcome from the run's own facts. Pure, and
 * fail-closed in the honest direction:
 *  - any observed-passing egress violation, or any edge execution that
 *    the runtime itself reports as direct-provider, is BYPASS_DETECTED
 *    (it overrides everything — a bypassed run is never PASS/FAIL);
 *  - a declared unavailability (NOT-RUN/BLOCKED cause) wins over
 *    success — a run that both succeeded and claims unavailability is
 *    a named inconsistency, rendered NOT-RUN (never quietly PASS);
 *  - the task's declared success check decides PASS vs FAIL;
 *  - no success fact at all ⇒ the explicit unavailability must name
 *    itself, else the outcome is NOT-RUN with the generic honest cause.
 */
export function deriveRunOutcome(facts: {
  readonly succeeded: boolean | null;
  readonly bypassObserved: boolean;
  readonly unavailable?: RunNotRunCause | null;
}): RunOutcome {
  if (facts.bypassObserved) {
    return "BYPASS_DETECTED";
  }
  if (facts.unavailable !== null && facts.unavailable !== undefined) {
    return facts.unavailable.outcome;
  }
  if (facts.succeeded === null) {
    return "NOT-RUN";
  }
  return facts.succeeded ? "PASS" : "FAIL";
}

// ---------------------------------------------------------------------------
// The per-run observation vocabulary (what a pinned session reports back)
// ---------------------------------------------------------------------------

/** One delegated edge's execution as the runtime observed it. */
export interface EdgeExecutionObservation {
  /** The declared material edge the execution belongs to. */
  readonly edgeId: string;
  /** The Zeck execution id the edge delegated through. */
  readonly executionId: string;
  /**
   * The runtime-side outcome: `resolved` (terminal COMPLETED through
   * Zeck), `failed` (terminal non-COMPLETED), `not-found` (the Zeck
   * execution could not be read back) or `pending`.
   */
  readonly outcome: "resolved" | "failed" | "not-found" | "pending";
  readonly latencyMs: number | null;
  readonly usage?: { readonly inputTokens: number; readonly outputTokens: number } | null;
  readonly costMicroUsd?: string | null;
}

/** The outcome of one representative task executed through a pinned session. */
export interface TaskRunOutcome {
  readonly taskId: string;
  /**
   * The task's own declared success check (the corpus's mechanical
   * verification — the application work order's success definition,
   * never a Zeck verification authority). `null` when the run could
   * not execute the task at all.
   */
  readonly succeeded: boolean | null;
  /** The verbatim observation backing the success fact. */
  readonly detail: string;
  readonly durationMs: number;
  readonly edgeExecutions: readonly EdgeExecutionObservation[];
  readonly failureCount: number;
  readonly retryCount: number;
  /** The run-level egress observation of the certified environment, when carried. */
  readonly egressObservation?: import("./evidence").EgressObservation | null;
  /** Honest unavailability, when the run could not execute (owner named). */
  readonly unavailable?: RunNotRunCause | null;
}

/** Validate a task run outcome's structure (fail-closed, machine-readable). */
export function validateTaskRunOutcome(outcome: unknown): readonly RuntimeBindingIssue[] {
  if (typeof outcome !== "object" || outcome === null) {
    return [{ field: "taskRunOutcome", issue: "task run outcome must be an object" }];
  }
  const record = outcome as Record<string, unknown>;
  const issues: RuntimeBindingIssue[] = [];
  if (typeof record.taskId !== "string" || record.taskId.trim().length === 0) {
    issues.push({ field: "taskRunOutcome.taskId", issue: "task id is mandatory" });
  }
  if (typeof record.detail !== "string" || record.detail.trim().length === 0) {
    issues.push({
      field: "taskRunOutcome.detail",
      issue: "the run's verbatim observation is mandatory",
    });
  }
  if (
    typeof record.durationMs !== "number" ||
    record.durationMs < 0 ||
    !Number.isFinite(record.durationMs)
  ) {
    issues.push({
      field: "taskRunOutcome.durationMs",
      issue: "the run's duration (ms) is mandatory",
    });
  }
  if (typeof record.succeeded !== "boolean" && record.succeeded !== null) {
    issues.push({
      field: "taskRunOutcome.succeeded",
      issue: "succeeded is boolean (the task's own check) or null (not executed)",
    });
  }
  if (record.edgeExecutions !== undefined && !Array.isArray(record.edgeExecutions)) {
    issues.push({
      field: "taskRunOutcome.edgeExecutions",
      issue: "edge executions must be an array",
    });
  }
  return issues;
}
