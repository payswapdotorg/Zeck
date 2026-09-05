/**
 * Zeck dashboard projection — pure view-model derivation (WORK-033).
 *
 * EVERY function here derives presentation facts from the public wire
 * shapes ONLY (the SDK re-exports of src/shared/wire.ts). Nothing here
 * calls the network, holds state, or invents a platform fact. The honesty
 * rules (UX-ARCHITECTURE §26, WORK-033 trust checkpoint):
 *  - the four trust axes are derived separately and never conflated;
 *  - no confidence verdict exists without verification results;
 *  - titles and stage labels are heuristics over PUBLIC task/event
 *    fields, always falling back to the honest identifier;
 *  - unknown event types render verbatim;
 *  - secret-shaped values are never displayed, even inside otherwise
 *    public records (defense in depth on top of the API's own scrub).
 */

import {
  type AgentStatusView,
  EXECUTION_STATUSES,
  type Execution,
  type ExecutionEvent,
  type ExecutionRequest,
  type ExecutionResult,
  FORBIDDEN_REQUEST_KEYS,
  TERMINAL_STATUSES,
  type VerificationResult,
} from "../../sdk";

/** The navigation-only recents cookie (see the evidence doc disclosure). */
export const RECENTS_COOKIE = "zeck_recent_executions";
/** The appearance preference cookie (presentation state only). */
export const APPEARANCE_COOKIE = "zeck_appearance";
/** Maximum remembered executions (most-recent-first). */
export const MAX_RECENTS = 8;

// ---------------------------------------------------------------------------
// Secret-shape redaction (defense in depth; M7)
// ---------------------------------------------------------------------------

const SECRET_SHAPE_KEY =
  /secret|token|password|passphrase|credential|apikey|api[-_]?key|private[-_]?key/i;

/** Does this field name look like it could carry secret material? */
export function isSecretShapedKey(key: string): boolean {
  return SECRET_SHAPE_KEY.test(key);
}

/**
 * Redact secret-shaped values inside an otherwise public record so that
 * hostile task/metadata/payload content can never echo through the
 * presentation boundary (the API already scrubs its responses; this is
 * the dashboard-side second line, M7).
 */
export function redactSecretShaped(value: unknown, depth = 0): unknown {
  if (depth > 4) {
    return "…";
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactSecretShaped(item, depth + 1));
  }
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      out[key] = isSecretShapedKey(key) ? "[not displayed]" : redactSecretShaped(inner, depth + 1);
    }
    return out;
  }
  return value;
}

/** Top-level task fields rendered in the "Understood task" view (redacted). */
export function safeTaskPairs(task: Readonly<Record<string, unknown>>): [string, string][] {
  const pairs: [string, string][] = [];
  for (const [key, value] of Object.entries(task)) {
    const safeValue = isSecretShapedKey(key) ? "[not displayed]" : redactSecretShaped(value);
    pairs.push([key, typeof safeValue === "string" ? safeValue : stringifyValue(safeValue)]);
  }
  return pairs;
}

function stringifyValue(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }
  if (value === null || value === undefined) {
    return "—";
  }
  try {
    return JSON.stringify(value) ?? "—";
  } catch {
    return "—";
  }
}

// ---------------------------------------------------------------------------
// Titles, labels, stages
// ---------------------------------------------------------------------------

/**
 * The execution title heuristic: PUBLIC summary fields of the task record
 * when present, else the honest identifier (never fabricated).
 */
export function executionTitle(
  task: Readonly<Record<string, unknown>>,
  executionId: string,
): string {
  for (const key of ["description", "outcome", "goal", "title", "prompt"]) {
    const value = task[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return executionId;
}

/** Friendly, user-language status labels (UX §3.1). */
export function statusLabel(status: string): string {
  switch (status) {
    case "CREATED":
      return "Created";
    case "AUTHORIZED":
      return "Authorized";
    case "PLANNING":
      return "Planning";
    case "QUEUED":
      return "Queued";
    case "RUNNING":
      return "Running";
    case "WAITING_TOOL":
      return "Waiting for a tool";
    case "WAITING_USER":
      return "Waiting for you";
    case "WAITING_HUMAN":
      return "Waiting for review";
    case "VERIFYING":
      return "Verifying";
    case "REPLANNING":
      return "Replanning";
    case "COMPLETED":
      return "Completed";
    case "FAILED":
      return "Failed";
    case "CANCELLED":
      return "Cancelled";
    case "EXPIRED":
      return "Expired";
    default:
      return status;
  }
}

/** Symbols communicate status WITHOUT relying on color (a11y contract). */
export function statusSymbol(status: string): string {
  switch (status) {
    case "COMPLETED":
      return "✓";
    case "FAILED":
      return "✕";
    case "CANCELLED":
      return "⊘";
    case "EXPIRED":
      return "⏱";
    case "WAITING_TOOL":
    case "WAITING_USER":
    case "WAITING_HUMAN":
      return "⏸";
    case "VERIFYING":
      return "◎";
    case "CREATED":
      return "○";
    default:
      return "●";
  }
}

/**
 * The executions-owned step-event command vocabulary (WORK-010…032) as
 * the PUBLIC wire spells them: every step event's wire type is
 * `execution.<command>` (the platform's own `eventTypeFor`). WORK-040
 * normalizes BOTH spellings — the real prefixed wire type and the bare
 * command string the WORK-037-era fixtures recorded — to ONE vocabulary
 * so the same derivation reads fixtures and the real wire identically
 * (never a second status language: the names are the platform's own).
 */
const STEP_EVENT_COMMANDS: ReadonlySet<string> = new Set([
  "tool-requested",
  "tool-result",
  "tool-denied",
  "agent-session-started",
  "agent-action-recorded",
  "agent-session-completed",
  "verification-requested",
  "verification-recorded",
  "human-evaluation-requested",
  "human-decision-recorded",
  "comparison-recorded",
  "sandbox-admitted",
  "sandbox-denied",
  "sandbox-completed",
  "economic-action-recorded",
  "economic-action-denied",
  "economic-action-authorized",
  "economic-action-settled",
  "economic-action-failed",
  "checkpoint-recorded",
  "interruption-requested",
  "wake-up-scheduled",
  "wake-up-applied",
  "resume-recorded",
  "resume-denied",
]);

/** The canonical step-event command of a wire event type (both spellings). */
export function normalizeStepEventType(eventType: string): string {
  if (eventType.startsWith("execution.")) {
    const command = eventType.slice("execution.".length);
    if (STEP_EVENT_COMMANDS.has(command)) {
      return command;
    }
  }
  return eventType;
}

/** Known command events → friendly stage labels; unknown types stay verbatim. */
export function eventStageLabel(eventType: string): string {
  switch (normalizeStepEventType(eventType)) {
    case "execution.created":
      return "Created";
    case "execution.authorize":
      return "Authorized";
    case "execution.plan":
      return "Planning";
    case "execution.queue":
      return "Queued";
    case "execution.start":
      return "Started";
    case "execution.wait-tool":
      return "Waiting for a tool";
    case "execution.wait-user":
      return "Waiting for you";
    case "execution.wait-human":
      return "Waiting for review";
    case "execution.verify":
      return "Verifying";
    case "execution.pass":
      return "Completed";
    case "execution.fail":
      return "Failed";
    case "execution.cancel":
      return "Cancelled";
    case "execution.expire":
      return "Expired";
    case "execution.resume":
      return "Resumed";
    case "execution.replan":
      return "Replanning";
    case "execution.policy-denied":
      return "Policy denied admission";
    case "planning.decision-recorded":
      return "Planning decision recorded";
    // WORK-028's long-running ledger vocabulary (public on the event
    // stream): the platform's OWN observation events, labeled with its
    // own vocabulary — the lease/heartbeat mechanics stay internal.
    case "checkpoint-recorded":
      return "Checkpoint recorded";
    case "interruption-requested":
      return "Interruption requested";
    case "wake-up-scheduled":
      return "Wake-up scheduled";
    case "wake-up-applied":
      return "Wake-up applied";
    case "resume-recorded":
      return "Recovered (resume recorded)";
    case "resume-denied":
      return "Resume denied";
    default:
      return eventType;
  }
}

/** The live stage label derived from the execution status (same vocabulary). */
export function currentStageLabel(status: string): string {
  return statusLabel(status);
}

/** Is the status terminal (COMPLETED/FAILED/CANCELLED/EXPIRED)? */
export function isTerminal(status: string): boolean {
  return (TERMINAL_STATUSES as readonly string[]).includes(status);
}

/** Rank in the public status order (CREATED first); unknown ranks lowest. */
export function statusRank(status: string): number {
  const index = (EXECUTION_STATUSES as readonly string[]).indexOf(status);
  return index < 0 ? 0 : index;
}

/** Elapsed duration (createdAt → terminalAt, else createdAt → now) in ms. */
export function durationMs(createdAt: string, terminalAt: string | null, now: number): number {
  const start = Date.parse(createdAt);
  const end = terminalAt === null ? now : Date.parse(terminalAt);
  if (!Number.isFinite(start) || !Number.isFinite(end)) {
    return 0;
  }
  return Math.max(0, end - start);
}

/** Events in chronological order (by sequence, occurredAt as tie-break). */
export function chronologicalEvents(events: readonly ExecutionEvent[]): ExecutionEvent[] {
  return [...events].sort(
    (a, b) => a.sequence - b.sequence || a.occurredAt.localeCompare(b.occurredAt),
  );
}

// ---------------------------------------------------------------------------
// The four trust axes (UX §26 — never conflated, never synthesized)
// ---------------------------------------------------------------------------

export type TrustAxisKind = "provider" | "execution" | "quality" | "policy";

export interface TrustAxis {
  readonly kind: TrustAxisKind;
  readonly label: string;
  readonly detail: string;
  readonly source: string;
}

/**
 * Provider success: only ever claims what the route summary records.
 * Never claims more than the recorded model-call count.
 */
export function deriveProviderAxis(result: ExecutionResult): TrustAxis {
  const route = result.route;
  if (route === null) {
    return {
      kind: "provider",
      label: "No route recorded yet",
      detail: "The execution result carries no route summary yet.",
      source: "ExecutionResult.route (public wire)",
    };
  }
  if (route.modelCalls <= 0) {
    return {
      kind: "provider",
      label: "No provider calls recorded yet",
      detail: "A route is recorded but no model calls have completed.",
      source: "ExecutionResult.route (public wire)",
    };
  }
  return {
    kind: "provider",
    label: `Provider calls completed (${route.modelCalls})`,
    detail: `The route summary records ${route.modelCalls} completed model call(s).`,
    source: "ExecutionResult.route (public wire)",
  };
}

/** Execution success: the honest lifecycle status, in user language. */
export function deriveExecutionAxis(execution: Execution): TrustAxis {
  const label = statusLabel(execution.status);
  const detail = isTerminal(execution.status)
    ? `The execution reached the terminal state ${label.toLowerCase()}.`
    : `The execution is in progress; the live status is ${execution.status}.`;
  return {
    kind: "execution",
    label: isTerminal(execution.status)
      ? `Execution ${label.toLowerCase()}`
      : `In progress (${execution.status})`,
    detail,
    source: "Execution.status (public wire)",
  };
}

/**
 * Quality success: ONLY verification results may speak. Zero results ⇒
 * the honest "No verification results recorded" — NEVER a confidence
 * verdict (WORK-033 trust checkpoint; the UI never manufactures
 * correctness or confidence).
 */
export function deriveQualityAxis(verification: readonly VerificationResult[]): TrustAxis {
  if (verification.length === 0) {
    return {
      kind: "quality",
      label: "No verification results recorded",
      detail: "The platform has not recorded verification results for this execution.",
      source: "ExecutionResult.verification / listVerification (public wire)",
    };
  }
  const passed = verification.filter((check) => check.status === "PASS").length;
  return {
    kind: "quality",
    label: `${passed} of ${verification.length} checks passed`,
    detail:
      "Each check is a platform verification result; a check may pass, fail or be inconclusive.",
    source: "ExecutionResult.verification / listVerification (public wire)",
  };
}

/**
 * Policy success: admitted only when the platform record proves progress
 * past CREATED (an authorize-or-later event, or a status past CREATED);
 * an `execution.policy-denied` event is surfaced honestly as denial.
 */
export function derivePolicyAxis(
  execution: Execution,
  events: readonly ExecutionEvent[],
): TrustAxis {
  const denied = events.some((event) => event.type === "execution.policy-denied");
  if (denied) {
    return {
      kind: "policy",
      label: "Policy denied admission",
      detail:
        "A policy-denied event is recorded on this execution; policy is the admission authority.",
      source: "execution.policy-denied event (public wire)",
    };
  }
  const progressed =
    statusRank(execution.status) >= statusRank("AUTHORIZED") ||
    events.some((event) => event.type !== "execution.created");
  if (progressed) {
    return {
      kind: "policy",
      label: "Admitted by policy",
      detail: "The execution record shows progression past creation (authorize or later).",
      source: "Execution.status + events (public wire)",
    };
  }
  return {
    kind: "policy",
    label: "Not yet admitted",
    detail: "No authorization evidence is recorded yet.",
    source: "Execution.status + events (public wire)",
  };
}

/** The four axes, derived separately (provider/execution/quality/policy). */
export function deriveTrustAxes(
  execution: Execution,
  result: ExecutionResult,
  events: readonly ExecutionEvent[],
): TrustAxis[] {
  return [
    deriveProviderAxis(result),
    deriveExecutionAxis(execution),
    deriveQualityAxis(result.verification),
    derivePolicyAxis(execution, events),
  ];
}

/**
 * The compact verification chip for the header: pass-count text, or the
 * honest no-results note. NEVER a confidence verdict by itself.
 */
export function deriveVerificationChip(verification: readonly VerificationResult[]): string {
  if (verification.length === 0) {
    return "No verification results";
  }
  const passed = verification.filter((check) => check.status === "PASS").length;
  return `${passed}/${verification.length} checks passed`;
}

/**
 * A derived "high confidence" summary chip is allowed ONLY when every
 * check passed AND every confidence value is present — and the chip must
 * carry its derivation ("N/N checks passed") so it stays explainable.
 */
export function deriveConfidenceChip(verification: readonly VerificationResult[]): string | null {
  if (verification.length === 0) {
    return null;
  }
  const allPassed = verification.every((check) => check.status === "PASS");
  const allConfident = verification.every((check) => check.confidence !== null);
  if (!allPassed || !allConfident) {
    return null;
  }
  return `High confidence — ${verification.length}/${verification.length} checks passed`;
}

// ---------------------------------------------------------------------------
// Attention derivation (Home "Needs your attention"; the Attention
// primitive's vocabulary lives in attention.ts — WORK-035)
// ---------------------------------------------------------------------------

export type { AttentionItem, AttentionLink } from "./attention";

import type { AttentionItem } from "./attention";

/** Derive attention items from LIVE execution records (never cached). */
export function deriveAttention(executions: readonly Execution[]): AttentionItem[] {
  const items: AttentionItem[] = [];
  for (const execution of executions) {
    const title = executionTitle(execution.task, execution.id);
    if (execution.status === "WAITING_USER" || execution.status === "WAITING_HUMAN") {
      items.push({
        kind: "decision",
        title: "Decision needed",
        body: `"${title}" is waiting for ${
          execution.status === "WAITING_USER" ? "your decision" : "a human review"
        }. This is a normal governed state, not an error.`,
        links: [{ label: "Open the execution", href: `/runs/${encodeURIComponent(execution.id)}` }],
      });
    } else if (execution.status === "FAILED") {
      items.push({
        kind: "failed",
        title: "Zeck could not complete an execution",
        body: `"${title}" failed. Open it for the plain-language explanation and recovery actions.`,
        links: [
          { label: "Open the execution", href: `/runs/${encodeURIComponent(execution.id)}` },
          {
            label: "Start a new attempt",
            href: `/build/execution?outcome=${encodeURIComponent(title)}&applicationId=${encodeURIComponent(
              execution.applicationId,
            )}`,
          },
        ],
      });
    }
  }
  return items;
}

// ---------------------------------------------------------------------------
// Recents cookie (navigation-only presentation state — disclosed)
// ---------------------------------------------------------------------------

/** Parse the recents cookie (comma-separated ids, most-recent-first). */
export function parseRecents(cookieValue: string | undefined): string[] {
  if (cookieValue === undefined || cookieValue.trim().length === 0) {
    return [];
  }
  return cookieValue
    .split(",")
    .map((id) => id.trim())
    .filter((id) => id.length > 0);
}

/** Serialize ids for the cookie (most-recent-first). */
export function serializeRecents(ids: readonly string[]): string {
  return ids.join(",");
}

/** Add an id at the front, deduplicated, capped at MAX_RECENTS. */
export function addRecent(ids: readonly string[], id: string): string[] {
  return [id, ...ids.filter((existing) => existing !== id)].slice(0, MAX_RECENTS);
}

// ---------------------------------------------------------------------------
// Form → ExecutionRequest mapping (the ONLY create surface)
// ---------------------------------------------------------------------------

export const QUALITY_OPTIONS: readonly [string, string][] = [
  ["", "No explicit quality target"],
  ["0.5", "Standard (0.5)"],
  ["0.8", "High (0.8)"],
  ["0.95", "Highest (0.95)"],
];

export interface ExecutionFormValues {
  readonly applicationId: string;
  readonly environmentId: string;
  readonly outcome: string;
  readonly spendLimitDollars: string;
  readonly quality: string;
  readonly latencySeconds: string;
  readonly userId: string;
  /**
   * WORK-036 (AC2): optional input artifact references (one per line or
   * comma-separated), mapped to `ExecutionRequest.inputArtifactRefs`.
   * Parsed/validated into refs at build time.
   */
  readonly attachments: string;
}

export type FormErrors = Partial<Record<keyof ExecutionFormValues, string>>;

const DOLLARS_PATTERN = /^\d+(\.\d{1,2})?$/;
const ARTIFACT_REF_PATTERN = /^[0-9a-zA-Z][0-9a-zA-Z._-]{0,127}$/;

/**
 * Parse the composer's attachments field into artifact references
 * (WORK-036 AC2): whitespace/comma separated ids; empty input ⇒ [].
 * Returns null when any token is not a plausible artifact reference —
 * the caller surfaces a per-field error, never a silent drop.
 */
export function parseAttachmentRefs(input: string): string[] | null {
  const tokens = input
    .split(/[\n,]+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
  for (const token of tokens) {
    if (!ARTIFACT_REF_PATTERN.test(token)) {
      return null;
    }
  }
  return tokens;
}

/**
 * Dollars → integer micro-USD string, using integer/BigInt arithmetic
 * ONLY (the platform money discipline — never floats).
 */
export function dollarsToMicroUsd(dollars: string): string | null {
  if (!DOLLARS_PATTERN.test(dollars)) {
    return null;
  }
  const [wholePart, fractionPart = ""] = dollars.split(".");
  const fraction = fractionPart.padEnd(6, "0");
  const micro = BigInt(wholePart || "0") * 1_000_000n + BigInt(fraction);
  return micro.toString();
}

/** Validate the step-1/step-2 form fields; errors are per-field strings. */
export function validateExecutionForm(form: Readonly<Record<string, string>>): {
  readonly values: ExecutionFormValues | null;
  readonly errors: FormErrors;
} {
  const values: ExecutionFormValues = {
    applicationId: (form.applicationId ?? "").trim(),
    environmentId: (form.environmentId ?? "").trim(),
    outcome: form.outcome ?? "",
    spendLimitDollars: (form.spendLimitDollars ?? "").trim(),
    quality: (form.quality ?? "").trim(),
    latencySeconds: (form.latencySeconds ?? "").trim(),
    userId: (form.userId ?? "").trim(),
    attachments: form.attachments ?? "",
  };
  const errors: FormErrors = {};
  if (values.applicationId.length === 0) {
    errors.applicationId = "The application id is required (the governed scope of the execution).";
  }
  if (values.outcome.trim().length === 0) {
    errors.outcome = "Describe the outcome you want Zeck to accomplish.";
  }
  if (values.spendLimitDollars.length > 0 && dollarsToMicroUsd(values.spendLimitDollars) === null) {
    errors.spendLimitDollars = "Enter a spend limit as a dollar amount, e.g. 10.50.";
  }
  if (values.latencySeconds.length > 0 && !/^\d+$/.test(values.latencySeconds)) {
    errors.latencySeconds = "Enter the maximum latency in whole seconds, e.g. 120.";
  }
  if (values.latencySeconds.length > 0 && /^0+$/.test(values.latencySeconds)) {
    errors.latencySeconds = "The latency limit must be greater than zero seconds.";
  }
  if (!QUALITY_OPTIONS.some(([value]) => value === values.quality)) {
    errors.quality = "Choose one of the listed quality targets.";
  }
  if (values.attachments.trim().length > 0 && parseAttachmentRefs(values.attachments) === null) {
    errors.attachments =
      "Enter input artifact references — one id per line or comma-separated (letters, digits, dots, dashes, underscores).";
  }
  return { values: Object.keys(errors).length === 0 ? values : null, errors };
}

/**
 * Map validated form values to the ExecutionRequest (the closed public
 * vocabulary — this builder can NEVER emit a forbidden key, whatever the
 * submitted form contains).
 */
export function buildExecutionRequest(values: ExecutionFormValues): ExecutionRequest {
  const constraints: Record<string, unknown> = {};
  const micro = dollarsToMicroUsd(values.spendLimitDollars);
  if (micro !== null && values.spendLimitDollars.length > 0) {
    constraints.maxCostMicroUsd = micro;
  }
  if (values.latencySeconds.length > 0) {
    constraints.maxLatencyMs = Number(values.latencySeconds) * 1000;
  }
  if (values.quality.length > 0) {
    constraints.minQuality = Number(values.quality);
  }
  const artifactRefs = parseAttachmentRefs(values.attachments) ?? [];
  return {
    applicationId: values.applicationId,
    ...(values.environmentId.length > 0 ? { environmentId: values.environmentId } : {}),
    task: { kind: "outcome", description: values.outcome },
    ...(artifactRefs.length > 0 ? { inputArtifactRefs: artifactRefs } : {}),
    ...(Object.keys(constraints).length > 0 ? { constraints } : {}),
    ...(values.userId.length > 0 ? { userId: values.userId } : {}),
  };
}

/** The forbidden request vocabulary (re-exported for the dashboard tests). */
export function forbiddenRequestKeys(): readonly string[] {
  return FORBIDDEN_REQUEST_KEYS;
}

// ---------------------------------------------------------------------------
// Command/search helpers
// ---------------------------------------------------------------------------

/** Does the token look like an execution identifier (uuid-ish or long id)? */
export function looksLikeExecutionId(token: string): boolean {
  if (token.length < 20 || token.length > 64) {
    return false;
  }
  return /^[0-9a-zA-Z][0-9a-zA-Z-]*$/.test(token);
}

// ---------------------------------------------------------------------------
// WORK-036: honest failure classification (AC10) and the wait question (AC8)
// ---------------------------------------------------------------------------

/**
 * The failure dimension a user is looking at — derived ONLY from platform
 * facts, never a heuristic guess:
 *  - "execution": the execution status is FAILED (the run itself did not
 *    complete — the recoverable/provider/infrastructure vs task question
 *    is answered by the RECORDED reason, never invented);
 *  - "quality": the execution COMPLETED but verification recorded FAIL
 *    checks (the work ran; the outcome did not pass its checks);
 *  - "none": neither fact exists.
 * The two are DISTINCT facts and never merged (the four-success-dimension
 * discipline: execution success ≠ quality success).
 */
export type FailureDimension = "execution" | "quality" | "none";

export interface FailureClassification {
  readonly dimension: FailureDimension;
  /** The platform-recorded failure reason (last fail event's message), or null. */
  readonly recordedReason: string | null;
  /** FAILED verification check count when the dimension is quality. */
  readonly failedChecks: number;
}

/** Classify what failed from the public facts (never infers, never merges). */
export function classifyFailure(
  execution: Execution,
  result: ExecutionResult,
  events: readonly ExecutionEvent[],
): FailureClassification {
  const ordered = chronologicalEvents(events);
  let recordedReason: string | null = null;
  for (let index = ordered.length - 1; index >= 0; index -= 1) {
    const event = ordered[index];
    if (event === undefined || !event.type.includes("fail")) {
      continue;
    }
    const payload = event.payload as Record<string, unknown>;
    for (const key of ["message", "error", "reason", "detail"]) {
      const value = payload[key];
      if (typeof value === "string" && value.trim().length > 0) {
        recordedReason = value;
        break;
      }
    }
    break;
  }
  const failedChecks = result.verification.filter((check) => check.status === "FAIL").length;
  if (execution.status === "FAILED") {
    return { dimension: "execution", recordedReason, failedChecks };
  }
  if (execution.status === "COMPLETED" && failedChecks > 0) {
    return { dimension: "quality", recordedReason: null, failedChecks };
  }
  return { dimension: "none", recordedReason: null, failedChecks };
}

/**
 * The authoritative recoverability facts for a failed run (AC10) —
 * derived ONLY from platform-typed fields on the public event stream:
 *  - a literal `retryable` boolean (the platform's own recoverability
 *    bit, as its failure records carry it);
 *  - the platform's own failure/outcome class vocabulary (`failureClass` /
 *    `outcomeClass` strings recorded by the platform's producers).
 *
 * This is a STRICTLY TYPED field read on the platform's own vocabulary
 * keys — NEVER a heuristic over free-text reasons. The recorded message
 * is displayed verbatim; it is never classified by the dashboard. When no
 * typed fact exists, the honest limitation is represented explicitly
 * (retryable === null && failureClass === null) — never a guessed
 * "recoverable" badge.
 */
export interface RecoverabilityFacts {
  /** The platform's literal retryable bit, when an event recorded one. */
  readonly retryable: boolean | null;
  /** The platform's own failure/outcome class, when an event recorded one. */
  readonly failureClass: string | null;
  /** The event type that carried the most recently recorded fact. */
  readonly source: string | null;
}

/**
 * Scan the public event stream chronologically for typed recoverability
 * facts. The MOST RECENT recorded fact wins per fact (the same last-event
 * precedent as `classifyFailure`'s recorded reason); `source` reports the
 * event that carried the retryable bit when one exists, else the event
 * that carried the class. Free-text fields (message/error/reason/detail)
 * are never consulted here.
 */
export function deriveRecoverability(events: readonly ExecutionEvent[]): RecoverabilityFacts {
  const ordered = chronologicalEvents(events);
  let retryable: boolean | null = null;
  let failureClass: string | null = null;
  let retryableSource: string | null = null;
  let classSource: string | null = null;
  for (const event of ordered) {
    const payload = event.payload as Record<string, unknown>;
    if (typeof payload.retryable === "boolean") {
      retryable = payload.retryable;
      retryableSource = event.type;
    }
    const classValue =
      typeof payload.failureClass === "string" && payload.failureClass.trim().length > 0
        ? payload.failureClass
        : typeof payload.outcomeClass === "string" && payload.outcomeClass.trim().length > 0
          ? payload.outcomeClass
          : null;
    if (classValue !== null) {
      failureClass = classValue;
      classSource = event.type;
    }
  }
  return { retryable, failureClass, source: retryableSource ?? classSource };
}

/**
 * The recorded wait question (AC8): the last wait event's question/message
 * payload in plain language, or null when the event carries none. Never
 * fabricated — a missing question renders the honest "no detail recorded"
 * note.
 */
export function waitQuestion(events: readonly ExecutionEvent[]): string | null {
  const ordered = chronologicalEvents(events);
  for (let index = ordered.length - 1; index >= 0; index -= 1) {
    const event = ordered[index];
    if (event === undefined || !event.type.startsWith("execution.wait-")) {
      continue;
    }
    const payload = event.payload as Record<string, unknown>;
    for (const key of ["question", "message", "prompt", "detail"]) {
      const value = payload[key];
      if (typeof value === "string" && value.trim().length > 0) {
        return value;
      }
    }
    return null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// WORK-037: the Build experience — workload creation (through the ONE
// governed execution create contract), long-running workload facts, the
// training/evaluation/release distinction, and the agent/deployment
// at-a-glance fact grids. Everything here is a pure derivation from the
// public wire shapes ONLY (the same honesty rules as the rest of this
// file: a typed platform fact or an explicit absence, never an invention).
// ---------------------------------------------------------------------------

/** The workload composer's round-trip keys (hidden fields + query params). */
export const WORKLOAD_FORM_KEYS: readonly string[] = [
  "applicationId",
  "purpose",
  "budgetDollars",
  "datasets",
  "userId",
  "idempotencyKey",
];

export interface WorkloadFormValues {
  readonly applicationId: string;
  readonly purpose: string;
  readonly budgetDollars: string;
  readonly datasets: string;
  readonly userId: string;
}

export type WorkloadFormErrors = Partial<Record<keyof WorkloadFormValues, string>>;

/**
 * Validate the workload composer. The workload is governed work: it maps
 * onto the SAME closed `ExecutionRequest` vocabulary (the budget becomes
 * the request's cost constraint; the datasets become input artifact
 * references) — never a second create contract.
 */
export function validateWorkloadForm(form: Readonly<Record<string, string>>): {
  readonly values: WorkloadFormValues | null;
  readonly errors: WorkloadFormErrors;
} {
  const values: WorkloadFormValues = {
    applicationId: (form.applicationId ?? "").trim(),
    purpose: form.purpose ?? "",
    budgetDollars: (form.budgetDollars ?? "").trim(),
    datasets: form.datasets ?? "",
    userId: (form.userId ?? "").trim(),
  };
  const errors: WorkloadFormErrors = {};
  if (values.applicationId.length === 0) {
    errors.applicationId =
      "The application id is required (the governed scope of the workload and its budget).";
  }
  if (values.purpose.trim().length === 0) {
    errors.purpose = "Describe what the workload should accomplish.";
  }
  if (values.budgetDollars.length > 0 && dollarsToMicroUsd(values.budgetDollars) === null) {
    errors.budgetDollars = "Enter the budget as a dollar amount, e.g. 50.00.";
  }
  if (values.datasets.trim().length > 0 && parseAttachmentRefs(values.datasets) === null) {
    errors.datasets =
      "Enter dataset artifact references — one id per line or comma-separated (letters, digits, dots, dashes, underscores).";
  }
  return { values: Object.keys(errors).length === 0 ? values : null, errors };
}

/**
 * Map validated workload values to the ExecutionRequest (the closed public
 * vocabulary — the same builder guarantees as the execution composer: a
 * forbidden key can never be emitted).
 */
export function buildWorkloadRequest(values: WorkloadFormValues): ExecutionRequest {
  const datasetRefs = parseAttachmentRefs(values.datasets) ?? [];
  const micro = dollarsToMicroUsd(values.budgetDollars);
  return {
    applicationId: values.applicationId,
    task: { kind: "outcome", description: values.purpose },
    ...(datasetRefs.length > 0 ? { inputArtifactRefs: datasetRefs } : {}),
    ...(micro !== null && values.budgetDollars.length > 0
      ? { constraints: { maxCostMicroUsd: micro } }
      : {}),
    ...(values.userId.length > 0 ? { userId: values.userId } : {}),
  };
}

// ---------------------------------------------------------------------------
// Long-running workload facts (AC8) — typed event facts ONLY
// ---------------------------------------------------------------------------

export interface WorkloadCheckpointFact {
  /** The platform's own checkpoint sequence number (typed payload field). */
  readonly sequence: number;
  readonly occurredAt: string;
  /** The platform's own position marker (typed payload field). */
  readonly lastEventPosition: number | null;
  readonly source: string;
}

export type WorkloadRecoveryKind = "recovered" | "resume-denied" | "interrupted" | "woken";

export interface WorkloadRecoveryFact {
  readonly kind: WorkloadRecoveryKind;
  readonly occurredAt: string;
  readonly source: string;
}

export interface WorkloadFacts {
  readonly checkpointCount: number;
  readonly lastCheckpoint: WorkloadCheckpointFact | null;
  readonly recovery: WorkloadRecoveryFact | null;
  /** True when ANY long-running fact exists (the section renders then). */
  readonly present: boolean;
}

/**
 * The recovery event vocabulary — the platform's OWN long-running event
 * types (WORK-028's additive ledger vocabulary, public on the event
 * stream). Lease/heartbeat events are NOT in this map: their mechanics
 * are platform-internal and are never surfaced (AC8).
 */
const WORKLOAD_RECOVERY_EVENT_KINDS: Readonly<Record<string, WorkloadRecoveryKind>> = {
  "resume-recorded": "recovered",
  "resume-denied": "resume-denied",
  "interruption-requested": "interrupted",
  "wake-up-applied": "woken",
};

/**
 * Derive the long-running workload facts from the PUBLIC event stream:
 * checkpoint events (`checkpoint-recorded`, the platform's own typed
 * payload: checkpointSequence + lastEventPosition) and the recovery
 * events (resume/interruption/wake-up). Free-text fields are never
 * consulted; lease/worker/epoch fields are never read (they do not cross
 * the public payload — and the dashboard would not show them anyway).
 */
export function deriveWorkloadFacts(events: readonly ExecutionEvent[]): WorkloadFacts {
  const ordered = chronologicalEvents(events);
  let checkpointCount = 0;
  let lastCheckpoint: WorkloadCheckpointFact | null = null;
  let recovery: WorkloadRecoveryFact | null = null;
  for (const event of ordered) {
    if (normalizeStepEventType(event.type) === "checkpoint-recorded") {
      checkpointCount += 1;
      const payload = event.payload as Record<string, unknown>;
      const sequence =
        typeof payload.checkpointSequence === "number"
          ? payload.checkpointSequence
          : checkpointCount;
      const position =
        typeof payload.lastEventPosition === "number" ? payload.lastEventPosition : null;
      lastCheckpoint = {
        sequence,
        occurredAt: event.occurredAt,
        lastEventPosition: position,
        source: event.type,
      };
      continue;
    }
    const kind = WORKLOAD_RECOVERY_EVENT_KINDS[normalizeStepEventType(event.type)];
    if (kind !== undefined) {
      recovery = { kind, occurredAt: event.occurredAt, source: event.type };
    }
  }
  return {
    checkpointCount,
    lastCheckpoint,
    recovery,
    present: checkpointCount > 0 || recovery !== null,
  };
}

/**
 * The declared budget constraint recorded on the execution record (a
 * public wire fact — `Execution.constraints.maxCostMicroUsd`), read as an
 * integer micro-USD string. Null when no cost constraint is recorded.
 */
export function declaredBudgetMicroUsd(execution: Execution): string | null {
  const constraints = execution.constraints as Record<string, unknown> | null;
  const value = constraints?.maxCostMicroUsd;
  return typeof value === "string" && value.length > 0 ? value : null;
}

// ---------------------------------------------------------------------------
// The training/evaluation/release distinction (AC7) — the four states are
// NAMED and DISTINCT; none is ever derived from another; the release state
// is never presented (no public fact exists for it, and this surface never
// claims one).
// ---------------------------------------------------------------------------

export type TrainingReleaseStateKind =
  | "compute-complete"
  | "training-complete"
  | "evaluation-passed"
  | "release-approved";

export interface TrainingStateRow {
  readonly kind: TrainingReleaseStateKind;
  readonly label: string;
  /**
   * The row's answer: a live platform fact, or the explicit honest
   * absence ("not exposed by the public contract" — never a guess).
   */
  readonly fact: string;
  /** True when a live platform fact backs the row (drives the marker). */
  readonly backed: boolean;
}

/**
 * The four-state distinction, derived from the run's public facts:
 *  - compute complete: the terminal status (the one public completion fact);
 *  - training complete: the SAME terminal status — stated explicitly as
 *    NOT separately distinguished by the public contract (the training
 *    authority's workload states are not public);
 *  - evaluation passed: the verification results (the public evaluation
 *    facts — pass counts, never a fabricated verdict);
 *  - release approved: the explicit absence — no release state exists on
 *    the public execution contract, and completing or evaluating never
 *    implies one.
 */
export function trainingStateRows(
  execution: Execution,
  verification: readonly VerificationResult[],
): readonly TrainingStateRow[] {
  const completed = execution.status === "COMPLETED";
  const passed = verification.filter((check) => check.status === "PASS").length;
  return [
    {
      kind: "compute-complete",
      label: "Compute complete",
      fact: completed
        ? `Yes — the execution reached the terminal state ${statusLabel(execution.status)}.`
        : `Not yet — the live status is ${execution.status} (${statusLabel(execution.status)}).`,
      backed: true,
    },
    {
      kind: "training-complete",
      label: "Training complete",
      fact: completed
        ? "The public contract exposes exactly one completion fact — the terminal status above. It does not separately distinguish training completion from compute completion; the training authority's own workload states are not public."
        : "Not yet — and when the run completes, the public contract will still expose only the terminal status (the training authority's own workload states are not public).",
      backed: true,
    },
    {
      kind: "evaluation-passed",
      label: "Evaluation passed",
      fact:
        verification.length === 0
          ? "No verification results are recorded — evaluation has no public facts on this run yet."
          : `${passed} of ${verification.length} verification checks passed — the run's verification results are the public evaluation facts (see the Evidence view).`,
      backed: verification.length > 0,
    },
    {
      kind: "release-approved",
      label: "Release approved",
      fact: "No release state exists on the public execution contract — this page never presents one. Release decisions belong to a platform authority that is not exposed here, and training completion or evaluation outcomes never imply release approval.",
      backed: false,
    },
  ];
}

/**
 * The static completion explainer for the workload PROPOSAL (before any
 * run exists): what each of the four states WILL be, as facts or explicit
 * absences — the same vocabulary as `trainingStateRows`, stated ahead of
 * commitment so the user knows what completion will and will not mean.
 */
export function completionExplainerRows(): readonly TrainingStateRow[] {
  return [
    {
      kind: "compute-complete",
      label: "Compute complete",
      fact: "Will show as the run's terminal Completed status — the one public completion fact.",
      backed: false,
    },
    {
      kind: "training-complete",
      label: "Training complete",
      fact: "The public contract will not separately distinguish training completion from compute completion (the training authority's own workload states are not public) — the run's status is the fact.",
      backed: false,
    },
    {
      kind: "evaluation-passed",
      label: "Evaluation passed",
      fact: "Will show from the run's verification results (the Evidence view) — evaluation is a separate fact from completion and is never implied by it.",
      backed: false,
    },
    {
      kind: "release-approved",
      label: "Release approved",
      fact: "Never claimed: no release state exists on the public execution contract. Completion and evaluation never imply release approval.",
      backed: false,
    },
  ];
}

// ---------------------------------------------------------------------------
// At-a-glance fact grids (AC3/AC4) — every cell a platform fact or an
// explicit honest absence, so the glance never invents health, quality,
// cost or deployment facts the API does not carry.
// ---------------------------------------------------------------------------

export interface GlanceFact {
  readonly label: string;
  /** The platform fact, or the honest absence statement. */
  readonly fact: string;
  /** True when a live platform fact backs the cell. */
  readonly backed: boolean;
}

/**
 * The agent at-a-glance grid (AC3): purpose, capabilities,
 * tools/integrations, autonomy, approvals, quality, cost, version and
 * current deployment — each either a fact from the public agent
 * projection (description, active version + its validation state) or the
 * explicit absence (the projection carries no such facts; deployment
 * availability is a distinct authority and is never presented as an
 * execution status).
 */
export function agentGlanceFacts(status: AgentStatusView): readonly GlanceFact[] {
  const active = status.activeVersion;
  return [
    {
      label: "Purpose",
      fact:
        status.agent.description ??
        "No description is recorded on the agent record — the inventory projection carries only what the platform recorded.",
      backed: status.agent.description !== null,
    },
    {
      label: "Capabilities",
      fact: "The public agent projection carries no capability facts — capabilities are governed platform-side and are not exposed per agent.",
      backed: false,
    },
    {
      label: "Tools and integrations",
      fact: "The public agent projection carries no tool or integration facts.",
      backed: false,
    },
    {
      label: "Autonomy",
      fact: "Autonomy is governed by policy at dispatch, not by the agent record — the public agent projection carries no autonomy facts.",
      backed: false,
    },
    {
      label: "Approvals",
      fact: "Approval requirements live in the governing policy; when a run needs an approval it surfaces as a waiting state on that execution — the agent record carries no approval facts.",
      backed: false,
    },
    {
      label: "Quality",
      fact:
        active === null
          ? "No active version is selected — no validation state to show."
          : `Active version validation state: ${active.validationState}${
              active.validationNotes === null ? "" : ` (${active.validationNotes})`
            }.`,
      backed: active !== null,
    },
    {
      label: "Cost",
      fact: "The public API exposes no per-agent cost facts — costs are recorded per execution on each run's header facts.",
      backed: false,
    },
    {
      label: "Version",
      fact:
        active === null
          ? "No active version is selected."
          : `${active.version} (definition digest ${active.definitionDigest}).`,
      backed: active !== null,
    },
    {
      label: "Current deployment",
      fact: "The public agent projection carries no deployment facts — deployment availability is a separate authority, not yet exposed, and is never represented as an execution status.",
      backed: false,
    },
  ];
}

/**
 * The deployment at-a-glance grid (AC4): availability, version, health,
 * channels/endpoints, activity and operational controls. The public API
 * exposes NO deployment authority, so every cell states the explicit
 * absence — never a fabricated availability, health or version fact
 * (Implementation Requirement 4: operational statistics only when backed
 * by API facts).
 */
export function deploymentGlanceFacts(): readonly GlanceFact[] {
  return [
    {
      label: "Availability",
      fact: "Not exposed by the public API — no deployment authority is public yet, so no availability fact can be shown (and availability is never represented as an execution status).",
      backed: false,
    },
    {
      label: "Version",
      fact: "Not exposed by the public API — the deployed version would come from the deployment authority's own projection when it ships.",
      backed: false,
    },
    {
      label: "Health",
      fact: "Not exposed by the public API — no health metric is invented here; health facts will come from the deployment authority.",
      backed: false,
    },
    {
      label: "Channels and endpoints",
      fact: "Not exposed by the public API — channels and endpoints are deployment-authority facts; none are rendered.",
      backed: false,
    },
    {
      label: "Activity",
      fact: "Not exposed by the public API — the closest live record today is each execution's own event stream (open a run to see its activity).",
      backed: false,
    },
    {
      label: "Operational controls",
      fact: "Not exposed by the public API — pause, rollback and version change have no governed deployment-command route yet, so this dashboard renders no action buttons for them; when the authority ships, each action routes through its governed API with a consequence preview before commitment.",
      backed: false,
    },
  ];
}

/**
 * The deployment/execution distinction statement (the Work Order's key
 * invariant, rendered on every deployment surface): a Deployment is
 * persistent availability; an Execution is one governed unit of work.
 */
export const DEPLOYMENT_EXECUTION_DISTINCTION =
  "A Deployment is persistent availability of an agent or program. An Execution is one governed unit of work. Deployment availability is never an execution status, and an execution's status never describes a deployment.";

// ---------------------------------------------------------------------------
// WORK-038 — artifact lineage/provenance derivations (pure view-models over
// the public wire facts only: the execution.created event's recorded input
// artifact references, and the verification results' recorded evidence refs)
// ---------------------------------------------------------------------------

/**
 * The input artifact references a producing execution consumed, from the
 * platform's own `execution.created` event payload (the one public wire
 * record of what an execution read as inputs). Only string values count;
 * absent or non-array payloads yield the honest empty list — never a
 * guessed parent.
 */
export function inputArtifactRefsOf(events: readonly ExecutionEvent[]): readonly string[] {
  const created = events.find((event) => event.type === "execution.created");
  if (created === undefined) {
    return [];
  }
  const payload = created.payload as Readonly<Record<string, unknown>>;
  const refs = payload.inputArtifactRefs;
  if (!Array.isArray(refs)) {
    return [];
  }
  return refs.filter((ref): ref is string => typeof ref === "string" && ref.trim().length > 0);
}

/**
 * True when an execution's recorded input references include the artifact
 * (usage is the platform's own per-execution record — never a
 * dashboard-invented usage claim).
 */
export function consumesArtifact(events: readonly ExecutionEvent[], artifactId: string): boolean {
  return inputArtifactRefsOf(events).some((ref) => ref === artifactId);
}

/**
 * The verification checks whose RECORDED evidence refs point at the given
 * artifact — the platform's own artifact→evidence linkage (the public
 * wire's only authority for which checks used which artifacts).
 */
export function checksReferencing(
  verification: readonly VerificationResult[],
  artifactId: string,
): readonly VerificationResult[] {
  return verification.filter((check) => check.evidenceRefs.some((ref) => ref === artifactId));
}

// ---------------------------------------------------------------------------
// WORK-038 — the competence experience fact families (AC6/AC7): discovery
// and detail facts render ONLY when available from the API — none are
// public today, so every cell states the explicit absence, anchored to
// where each fact WILL come from. Competence is presented as reusable
// validated behavior governed by the competence authority — never as an
// autonomous authority and never implying an unauthorized promotion.
// ---------------------------------------------------------------------------

/** The competence discovery fact families (AC6). */
export function competenceDiscoveryFacts(): readonly GlanceFact[] {
  return [
    {
      label: "Task outcome",
      fact: "What the competence accomplishes, in outcome terms — a competence-authority fact, not exposed by the public API yet.",
      backed: false,
    },
    {
      label: "Relevance",
      fact: "How well the competence matches your kind of work — a competence-authority ranking fact, not exposed by the public API yet.",
      backed: false,
    },
    {
      label: "Success rate",
      fact: "The validated share of governed runs that used this competence and met their outcome — a competence-authority statistic, not exposed by the public API yet.",
      backed: false,
    },
    {
      label: "Typical cost and time",
      fact: "The recorded cost/time profile of runs using the competence — a competence-authority statistic, not exposed by the public API yet.",
      backed: false,
    },
    {
      label: "Verification status",
      fact: "The verification checks that validate the competence and their current standing — a competence-authority fact, not exposed by the public API yet.",
      backed: false,
    },
  ];
}

/** The competence detail fact families (AC7 — only when available from the API). */
export function competenceDetailFacts(): readonly GlanceFact[] {
  return [
    {
      label: "Provenance",
      fact: "Where the competence came from and what evidence backs it — a competence-authority fact, not exposed by the public API yet.",
      backed: false,
    },
    {
      label: "Procedures",
      fact: "The validated way of accomplishing the work the competence represents — a competence-authority fact, not exposed by the public API yet.",
      backed: false,
    },
    {
      label: "Validation population",
      fact: "The population of runs the competence's validation was measured over — a competence-authority fact, not exposed by the public API yet.",
      backed: false,
    },
    {
      label: "Uncertainty",
      fact: "The recorded uncertainty of the competence's outcome statistics — a competence-authority fact, not exposed by the public API yet.",
      backed: false,
    },
    {
      label: "Compatibility",
      fact: "The kinds of work and constraints the competence is validated for — a competence-authority fact, not exposed by the public API yet.",
      backed: false,
    },
    {
      label: "Promotion state",
      fact: "The competence authority's promotion state, decided by its own validation and promotion rules — not exposed by the public API, and nothing on this page implies a promotion or a validated state.",
      backed: false,
    },
  ];
}

// ---------------------------------------------------------------------------
// WORK-038 — the evaluation status distinction (AC8): observation,
// recommendation, validation and authoritative production are four
// DISTINCT statuses — learning stays advisory until the existing
// validation/promotion rules are satisfied, and no status is ever
// implied by another.
// ---------------------------------------------------------------------------

export type EvaluationStatusKind = "observation" | "recommendation" | "validation" | "production";

export interface EvaluationStatusRow {
  readonly kind: EvaluationStatusKind;
  readonly label: string;
  /** A live platform fact, or the explicit honest absence. */
  readonly fact: string;
  /** True when a live platform fact backs the row. */
  readonly backed: boolean;
}

/**
 * The four evaluation statuses, each an explicit honest absence today
 * (no public evaluation authority): the distinction vocabulary renders
 * ahead of the facts so no observation is ever mistaken for a
 * recommendation, a validation or an authoritative production status.
 */
export function evaluationStatusRows(): readonly EvaluationStatusRow[] {
  return [
    {
      kind: "observation",
      label: "Observation",
      fact: "What the platform observed about how work went — recorded per execution on the public event stream (the closest live record today: open a run's activity). A cross-work evaluation observation surface is not exposed by the public API yet.",
      backed: false,
    },
    {
      kind: "recommendation",
      label: "Recommendation",
      fact: "An advisory improvement proposal derived from observations — advisory only: it never changes how work runs until the existing validation and promotion rules are satisfied. No public recommendation surface exists yet.",
      backed: false,
    },
    {
      kind: "validation",
      label: "Validation",
      fact: "A measured evaluation over a defined population that backs (or refutes) a recommendation — decided by the platform's validation rules. No public validation surface exists yet; per-execution verification results are the live public checks today.",
      backed: false,
    },
    {
      kind: "production",
      label: "Authoritative production status",
      fact: "The platform's authoritative statement that a validated improvement is in effect for governed work — granted by the existing promotion rules, never by this dashboard and never implied by an observation or a recommendation. No public surface exists yet.",
      backed: false,
    },
  ];
}

// ---------------------------------------------------------------------------
// WORK-039: the control-plane derivations — policy denial, spend, provider
// routing, environments, approvals and the learning-authority distinctions.
// Every derivation reads ONLY platform-typed public fields; nothing here
// computes an authority client-side (policy stays the authorization
// boundary, accounting stays canonical, learning never authorizes).
// ---------------------------------------------------------------------------

/**
 * The recorded policy denial (AC2): reads ONLY the `execution.policy-denied`
 * event's payload — the platform's own recorded `{ denied, reason }` pair.
 * The reason is the controlling rule in the platform's own words; it is
 * rendered verbatim, never classified or reworded by this projection. No
 * other event type and no other payload key can produce a denial fact (a
 * fabricated-reason mutant differs on the same input — pinned by D19).
 */
export interface PolicyDenialFact {
  /** The platform-recorded denial reason, verbatim. */
  readonly reason: string;
  /** When the denial was recorded. */
  readonly occurredAt: string;
}

export function policyDenialOf(events: readonly ExecutionEvent[]): PolicyDenialFact | null {
  for (const event of chronologicalEvents(events)) {
    if (event.type !== "execution.policy-denied") {
      continue;
    }
    const payload = event.payload as Record<string, unknown>;
    const reason = payload.reason;
    if (typeof reason === "string" && reason.trim().length > 0) {
      return { reason, occurredAt: event.occurredAt };
    }
  }
  return null;
}

/** One run's spend facts (AC3): the recorded cost, the declared limit, the routed provider. */
export interface RunSpendFact {
  readonly executionId: string;
  /** Integer micro-USD string when the platform recorded a settled cost, else null. */
  readonly costMicroUsd: string | null;
  /** The declared per-execution spend limit (constraints.maxCostMicroUsd), else null. */
  readonly limitMicroUsd: string | null;
  /** The opaque routed provider (neutral string) when a route is recorded, else null. */
  readonly provider: string | null;
}

/**
 * Derive one run's spend facts from the public records ONLY: the settled
 * cost from the run's own result package, the declared limit from the
 * execution's recorded constraints, the provider from the route summary.
 * A missing fact stays null — never zero, never a guess (D20).
 */
export function runSpendFacts(execution: Execution, result: ExecutionResult): RunSpendFact {
  return {
    executionId: execution.id,
    costMicroUsd: result.cost === null ? null : result.cost.totalMicroUsd,
    limitMicroUsd: declaredBudgetMicroUsd(execution),
    provider: result.route === null ? null : result.route.provider,
  };
}

/**
 * Sum integer micro-USD strings (AC3): BigInt only — never floats, never
 * parsed decimals. Non-string / non-integer values contribute NOTHING
 * (the honest skip: a malformed value never becomes a fabricated total).
 */
export function sumMicroUsd(values: readonly string[]): string {
  let total = 0n;
  for (const value of values) {
    if (/^\d{1,19}$/.test(value)) {
      total += BigInt(value);
    }
  }
  return total.toString();
}

/** One provider category's usage (AC3 "major categories"): the routed runs and their recorded spend. */
export interface ProviderCategoryFact {
  /** The opaque provider string (neutral — never a connection handle). */
  readonly provider: string;
  readonly runCount: number;
  /** The sum of the recorded costs of these runs (integer micro-USD string). */
  readonly totalMicroUsd: string;
  /** The run ids in this category (each links to its run page). */
  readonly executionIds: readonly string[];
}

/**
 * Group the runs' spend facts by routed provider (AC3 "major categories"):
 * the platform's own opaque provider strings — null (deterministic route)
 * groups as "(no provider recorded)". Grouping NEVER invents a provider a
 * run did not record (D20).
 */
export function providerCategoryFacts(
  facts: readonly RunSpendFact[],
): readonly ProviderCategoryFact[] {
  const groups = new Map<string, RunSpendFact[]>();
  for (const fact of facts) {
    const key = fact.provider ?? "(no provider recorded)";
    const bucket = groups.get(key);
    if (bucket === undefined) {
      groups.set(key, [fact]);
    } else {
      bucket.push(fact);
    }
  }
  return [...groups.entries()]
    .map(([provider, runs]) => ({
      provider,
      runCount: runs.length,
      totalMicroUsd: sumMicroUsd(
        runs.map((run) => run.costMicroUsd).filter((value): value is string => value !== null),
      ),
      executionIds: runs.map((run) => run.executionId),
    }))
    .sort((a, b) => a.provider.localeCompare(b.provider));
}

/** One environment's live facts (AC5): the runs recorded against it in this browser's scope. */
export interface EnvironmentFact {
  /** The recorded environment id, or the honest default marker. */
  readonly environmentId: string | null;
  readonly runCount: number;
  readonly executionIds: readonly string[];
}

/**
 * Group the runs by their RECORDED environment id (AC5): `null` is the
 * platform's own "no environment recorded" fact — rendered as the default
 * environment honestly, never invented. The environments authority's own
 * inventory/configuration is not public (stated, never worked around).
 */
export function environmentFacts(executions: readonly Execution[]): readonly EnvironmentFact[] {
  const groups = new Map<string | null, Execution[]>();
  for (const execution of executions) {
    const bucket = groups.get(execution.environmentId);
    if (bucket === undefined) {
      groups.set(execution.environmentId, [execution]);
    } else {
      bucket.push(execution);
    }
  }
  return [...groups.entries()]
    .map(([environmentId, runs]) => ({
      environmentId,
      runCount: runs.length,
      executionIds: runs.map((run) => run.id),
    }))
    .sort((a, b) => {
      if (a.environmentId === null) {
        return b.environmentId === null ? 0 : 1;
      }
      if (b.environmentId === null) {
        return -1;
      }
      return a.environmentId < b.environmentId ? -1 : a.environmentId > b.environmentId ? 1 : 0;
    });
}

/**
 * The live approval queue (AC5/AC8): runs recorded in a waiting state —
 * WAITING_USER (the end user's decision) and WAITING_HUMAN (a human
 * review the governing policy required). These are the platform's own
 * approval facts; who the approvers ARE is membership data the public API
 * does not expose (the honest absence on the team surface).
 */
export interface ApprovalQueueFact {
  readonly executionId: string;
  readonly status: "WAITING_USER" | "WAITING_HUMAN";
}

export function approvalQueueFacts(executions: readonly Execution[]): readonly ApprovalQueueFact[] {
  return executions
    .filter(
      (execution) => execution.status === "WAITING_USER" || execution.status === "WAITING_HUMAN",
    )
    .map((execution) => ({
      executionId: execution.id,
      status: execution.status as "WAITING_USER" | "WAITING_HUMAN",
    }));
}

/**
 * The authoritative production record (AC7): the agent inventory's own
 * selection facts — the platform's promotion/rollback decisions, with WHO
 * selected and WHEN. This is the live "authoritative production behavior"
 * the learning distinction anchors to: an authoritative change of what
 * governed work runs, decided by the platform's selection rules — never
 * by a recommendation and never by this dashboard.
 */
export interface AgentSelectionFact {
  readonly agentId: string;
  readonly agentName: string;
  readonly kind: "promotion" | "rollback";
  readonly selectedBy: string;
  readonly selectedAt: string;
  readonly rollbackOf: string | null;
}

export function agentSelectionFacts(status: AgentStatusView): AgentSelectionFact | null {
  const selection = status.latestSelection;
  if (selection === null) {
    return null;
  }
  return {
    agentId: status.agent.id,
    agentName: status.agent.name,
    kind: selection.kind,
    selectedBy: selection.selectedBy,
    selectedAt: selection.selectedAt,
    rollbackOf: selection.rollbackOf,
  };
}

/**
 * The recommendation disposition vocabulary (AC6): the three dispositions
 * a platform recommendation carries — advisory / review / applicable —
 * each its own row, never derived from another, each the explicit absence
 * today (no public recommendation surface; the structure renders ahead of
 * the facts, exactly like the W038 competence families).
 */
export type RecommendationDispositionKind = "advisory" | "review" | "applicable";

export interface RecommendationDispositionRow {
  readonly kind: RecommendationDispositionKind;
  readonly label: string;
  readonly fact: string;
  readonly backed: boolean;
}

export function recommendationDispositionRows(): readonly RecommendationDispositionRow[] {
  return [
    {
      kind: "advisory",
      label: "Advisory",
      fact: "A recommendation the platform derived from observed evidence — presented for your judgment. Advisory recommendations change nothing on their own: they are never authorization, and they are never applied automatically.",
      backed: false,
    },
    {
      kind: "review",
      label: "Review",
      fact: "A recommendation that asks for a human decision before anything changes — the review step in the platform's own promotion rules. No public review surface exists yet; when one ships, its decisions render here as their own facts.",
      backed: false,
    },
    {
      kind: "applicable",
      label: "Applicable",
      fact: "A recommendation the platform has validated as applicable to specific work — still not applied: application is a governed platform operation with its own consequence preview, never a dashboard-side mutation. No public applicable-recommendation surface exists yet.",
      backed: false,
    },
  ];
}

/**
 * The learning-authority distinction rows (AC7, IR6): evidence,
 * recommendation and authoritative production — three DISTINCT stages,
 * never conflated. The evidence row and the production row state their
 * LIVE public anchors (per-execution verification; the agent inventory's
 * selection records); the recommendation row carries the boundary
 * sentence: learning produces recommendations and evidence, never
 * authorization.
 */
export interface LearningAuthorityRow {
  readonly kind: "evidence" | "recommendation" | "production";
  readonly label: string;
  readonly fact: string;
  readonly backed: boolean;
}

export function learningAuthorityRows(): readonly LearningAuthorityRow[] {
  return [
    {
      kind: "evidence",
      label: "Evidence",
      fact: "What the platform observed and recorded — per-execution verification results, events and settled facts. Evidence is live through the governed API: open a run's Evidence view, or the Trust evidence surface. Evidence describes what happened; it never authorizes anything.",
      backed: true,
    },
    {
      kind: "recommendation",
      label: "Recommendation",
      fact: "An advisory improvement proposal derived from evidence — advisory only. Learning produces recommendations and evidence, never authorization: no recommendation can change policy, budget, connections or what governed work runs, and no recommendation is applied automatically (application is a governed platform operation with its own rules). No public recommendation surface exists yet.",
      backed: false,
    },
    {
      kind: "production",
      label: "Authoritative production behavior",
      fact: "What governed work actually runs — decided by the platform's own selection rules. The live public record today is the agent inventory's selection facts (promotions and rollbacks, each with who selected and when); open an agent's page for its selection record. A production change is never implied by an observation or a recommendation.",
      backed: true,
    },
  ];
}

// ---------------------------------------------------------------------------
// WORK-040 — advanced inspection + multimodal derivations (pure view-models
// over the public wire shapes ONLY; every fact below is read from the
// recorded event payloads exactly as the platform writes them — never
// re-derived, never approximated, absent fields stay absent).
// ---------------------------------------------------------------------------

/**
 * The planning-decision event type (the platform's own public type —
 * `PLANNING_DECISION_EVENT_TYPE`): the durable record the planner appends
 * while a run is in a planning phase. Its payload is the FULL planning
 * decision record; this derivation reads the closed set of fields the
 * inspection surface presents, each null-safe (a missing field renders as
 * its own absence — never a guess).
 */
export const PLANNING_DECISION_EVENT_TYPE = "planning.decision-recorded";

/** One candidate strategy as the planning record carried it (AC1). */
export interface PlanningCandidateFact {
  readonly strategyId: string;
  readonly expectedCostMicroUsd: string | null;
  readonly expectedQuality: number | null;
  readonly expectedLatencyMs: number | null;
  readonly verificationStrategy: string | null;
  readonly modelCalls: number | null;
  readonly admissible: boolean;
  /** The typed inadmissible reason (only when admissible is false). */
  readonly inadmissibleReason: string | null;
  readonly routeRationaleCode: string | null;
  readonly routeRationaleDetail: string | null;
}

/** One admissible substrate candidate with its resource characteristics. */
export interface SubstrateCandidateFact {
  readonly substrateId: string;
  readonly version: string | null;
  readonly adapterRef: string | null;
  readonly isolation: string | null;
  readonly latencyClass: string | null;
  readonly cpuMilliCores: number | null;
  readonly memoryMiB: number | null;
  readonly estimatedDurationMs: number | null;
  readonly estimatedCostMicroUsd: string | null;
}

/** One inadmissible substrate candidate with its TYPED reason. */
export interface SubstrateRejectionFact {
  readonly substrateId: string;
  readonly version: string | null;
  readonly reason: string | null;
  readonly detail: string | null;
}

/** The substrate-selection record as the planning decision carried it. */
export interface SubstrateSelectionFact {
  readonly outcome: string | null;
  readonly workloadClass: string | null;
  readonly admissible: readonly SubstrateCandidateFact[];
  readonly inadmissible: readonly SubstrateRejectionFact[];
  readonly selectedSubstrateId: string | null;
  readonly selectedVersion: string | null;
  readonly rationale: string | null;
}

/** The planning decision fact (AC1 — the expert inspection source). */
export interface PlanningDecisionFact {
  readonly decisionId: string | null;
  readonly plannerVersion: string | null;
  readonly sequence: number;
  readonly occurredAt: string;
  /** The task profile's risk level (the platform's own vocabulary). */
  readonly riskLevel: string | null;
  readonly qualityTarget: number | null;
  readonly maxCostMicroUsd: string | null;
  readonly maxLatencyMs: number | null;
  readonly requiresSemanticReasoning: boolean | null;
  /** The effective-policy admission capture (allow/deny + set identity). */
  readonly policyOutcome: string | null;
  readonly policySetId: string | null;
  readonly policySetVersion: string | null;
  /** The capability resolution capture. */
  readonly capabilitySatisfied: boolean | null;
  readonly capabilityCatalogRevision: string | null;
  readonly unmetCapabilityIds: readonly string[];
  readonly satisfiedCapabilityCount: number | null;
  /** The deterministic-first sufficiency decision. */
  readonly sufficiencyOutcome: string | null;
  readonly semanticReasoningRequired: boolean | null;
  readonly deterministicQualityEstimate: number | null;
  readonly candidates: readonly PlanningCandidateFact[];
  readonly selectedStrategyId: string | null;
  readonly selectionRationale: string | null;
  readonly subgraphEvidenceCount: number;
  readonly substrate: SubstrateSelectionFact | null;
  /** The record's own integrity anchor (the platform's digest). */
  readonly recordDigest: string | null;
}

function numberOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function booleanOrNull(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function stringArrayOrNull(value: unknown): string[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const ids = value.filter((entry): entry is string => typeof entry === "string");
  return ids.length === value.length ? ids : null;
}

function candidatesOf(record: Readonly<Record<string, unknown>>): readonly PlanningCandidateFact[] {
  const raw = record.candidates;
  if (!Array.isArray(raw)) {
    return [];
  }
  return raw.flatMap((entry) => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      return [];
    }
    const candidate = entry as Readonly<Record<string, unknown>>;
    const rationale =
      candidate.routeRationale === null || typeof candidate.routeRationale !== "object"
        ? null
        : (candidate.routeRationale as Readonly<Record<string, unknown>>);
    return [
      {
        strategyId: stringOrNull(candidate.strategyId) ?? "(unnamed strategy)",
        expectedCostMicroUsd: stringOrNull(candidate.expectedCostMicroUsd),
        expectedQuality: numberOrNull(candidate.expectedQuality),
        expectedLatencyMs: numberOrNull(candidate.expectedLatencyMs),
        verificationStrategy: stringOrNull(candidate.verificationStrategy),
        modelCalls: numberOrNull(candidate.modelCalls),
        admissible: candidate.admissible === true,
        inadmissibleReason: stringOrNull(candidate.inadmissibleReason),
        routeRationaleCode: rationale === null ? null : stringOrNull(rationale.code),
        routeRationaleDetail: rationale === null ? null : stringOrNull(rationale.detail),
      },
    ];
  });
}

function substrateSelectionOf(
  record: Readonly<Record<string, unknown>>,
): SubstrateSelectionFact | null {
  const raw = record.substrateSelection;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return null;
  }
  const selection = raw as Readonly<Record<string, unknown>>;
  const readCandidate = (entry: unknown): SubstrateCandidateFact | null => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      return null;
    }
    const candidate = entry as Readonly<Record<string, unknown>>;
    const resource =
      candidate.resource === null || typeof candidate.resource !== "object"
        ? null
        : (candidate.resource as Readonly<Record<string, unknown>>);
    return {
      substrateId: stringOrNull(candidate.substrateId) ?? "(unnamed substrate)",
      version: stringOrNull(candidate.version),
      adapterRef: stringOrNull(candidate.adapterRef),
      isolation: stringOrNull(candidate.isolation),
      latencyClass: stringOrNull(candidate.latencyClass),
      cpuMilliCores: resource === null ? null : numberOrNull(resource.cpuMilliCores),
      memoryMiB: resource === null ? null : numberOrNull(resource.memoryMiB),
      estimatedDurationMs: resource === null ? null : numberOrNull(resource.estimatedDurationMs),
      estimatedCostMicroUsd:
        resource === null ? null : stringOrNull(resource.estimatedCostMicroUsd),
    };
  };
  const readRejection = (entry: unknown): SubstrateRejectionFact | null => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      return null;
    }
    const rejection = entry as Readonly<Record<string, unknown>>;
    return {
      substrateId: stringOrNull(rejection.substrateId) ?? "(unnamed substrate)",
      version: stringOrNull(rejection.version),
      reason: stringOrNull(rejection.reason),
      detail: stringOrNull(rejection.detail),
    };
  };
  const selected =
    selection.selected === null || typeof selection.selected !== "object"
      ? null
      : (selection.selected as Readonly<Record<string, unknown>>);
  return {
    outcome: stringOrNull(selection.outcome),
    workloadClass: stringOrNull(selection.workloadClass),
    admissible: Array.isArray(selection.admissible)
      ? selection.admissible.flatMap((entry) => {
          const candidate = readCandidate(entry);
          return candidate === null ? [] : [candidate];
        })
      : [],
    inadmissible: Array.isArray(selection.inadmissible)
      ? selection.inadmissible.flatMap((entry) => {
          const rejection = readRejection(entry);
          return rejection === null ? [] : [rejection];
        })
      : [],
    selectedSubstrateId: selected === null ? null : stringOrNull(selected.substrateId),
    selectedVersion: selected === null ? null : stringOrNull(selected.version),
    rationale: stringOrNull(selection.rationale),
  };
}

/**
 * The recorded planning decision of a run's public event stream — the
 * LAST `planning.decision-recorded` envelope's payload, read field by
 * field (the real planner's own record). Null when the stream carries
 * none (no planning decision is invented or approximated).
 */
export function planningDecisionOf(events: readonly ExecutionEvent[]): PlanningDecisionFact | null {
  const decision = chronologicalEvents(events)
    .reverse()
    .find((event) => event.type === PLANNING_DECISION_EVENT_TYPE);
  if (decision === undefined) {
    return null;
  }
  const record = decision.payload as Readonly<Record<string, unknown>>;
  const taskProfile =
    record.taskProfile === null || typeof record.taskProfile !== "object"
      ? null
      : (record.taskProfile as Readonly<Record<string, unknown>>);
  const policyInputs =
    record.policyInputs === null || typeof record.policyInputs !== "object"
      ? null
      : (record.policyInputs as Readonly<Record<string, unknown>>);
  const capabilityResolution =
    record.capabilityResolution === null || typeof record.capabilityResolution !== "object"
      ? null
      : (record.capabilityResolution as Readonly<Record<string, unknown>>);
  const sufficiency =
    record.deterministicSufficiency === null || typeof record.deterministicSufficiency !== "object"
      ? null
      : (record.deterministicSufficiency as Readonly<Record<string, unknown>>);
  const unmetIds =
    capabilityResolution === null ? null : stringArrayOrNull(capabilityResolution.unmetIds);
  const satisfiedIds =
    capabilityResolution === null ? null : stringArrayOrNull(capabilityResolution.satisfiedIds);
  const subgraph = Array.isArray(record.subgraphEvidence) ? record.subgraphEvidence.length : 0;
  return {
    decisionId: stringOrNull(record.decisionId),
    plannerVersion: stringOrNull(record.plannerVersion),
    sequence: decision.sequence,
    occurredAt: decision.occurredAt,
    riskLevel: taskProfile === null ? null : stringOrNull(taskProfile.riskLevel),
    qualityTarget: taskProfile === null ? null : numberOrNull(taskProfile.qualityTarget),
    maxCostMicroUsd: taskProfile === null ? null : stringOrNull(taskProfile.maxCostMicroUsd),
    maxLatencyMs: taskProfile === null ? null : numberOrNull(taskProfile.maxLatencyMs),
    requiresSemanticReasoning:
      taskProfile === null ? null : booleanOrNull(taskProfile.requiresSemanticReasoning),
    policyOutcome: policyInputs === null ? null : stringOrNull(policyInputs.outcome),
    policySetId: policyInputs === null ? null : stringOrNull(policyInputs.policySetId),
    policySetVersion:
      policyInputs === null
        ? null
        : policyInputs.policySetVersion === undefined || policyInputs.policySetVersion === null
          ? null
          : String(policyInputs.policySetVersion),
    capabilitySatisfied:
      capabilityResolution === null ? null : booleanOrNull(capabilityResolution.satisfied),
    capabilityCatalogRevision:
      capabilityResolution === null ? null : stringOrNull(capabilityResolution.catalogRevision),
    unmetCapabilityIds: unmetIds ?? [],
    satisfiedCapabilityCount: satisfiedIds === null ? null : satisfiedIds.length,
    sufficiencyOutcome: sufficiency === null ? null : stringOrNull(sufficiency.outcome),
    semanticReasoningRequired:
      sufficiency === null ? null : booleanOrNull(sufficiency.semanticReasoningRequired),
    deterministicQualityEstimate:
      sufficiency === null ? null : numberOrNull(sufficiency.deterministicQualityEstimate),
    candidates: candidatesOf(record),
    selectedStrategyId: stringOrNull(record.selectedStrategyId),
    selectionRationale: stringOrNull(record.selectionRationale),
    subgraphEvidenceCount: subgraph,
    substrate: substrateSelectionOf(record),
    recordDigest: stringOrNull(record.recordDigest),
  };
}

// ---------------------------------------------------------------------------
// Computer-use facts (AC2 — the tool-axis step events' own payloads)
// ---------------------------------------------------------------------------

/** One computer-use session evidence row (the recorded payload facts). */
export interface ComputerUseSessionFact {
  readonly sessionId: string | null;
  readonly mode: string | null;
  readonly phase: string | null;
  readonly environmentRef: string | null;
  /** The isolation verdict: 0 = the environment inherited no host state. */
  readonly inheritedHostStateCount: number | null;
  readonly deterministicFirst: boolean | null;
  readonly routeStageCount: number | null;
  readonly occurredAt: string;
  readonly sequence: number;
}

/** One computer-use denial (journal-then-fail: the recorded typed denial). */
export interface ComputerUseDenialFact {
  readonly sessionId: string | null;
  readonly mode: string | null;
  readonly denialClass: string | null;
  readonly code: string | null;
  readonly reason: string | null;
  readonly occurredAt: string;
  readonly sequence: number;
}

export interface ComputerUseFacts {
  readonly sessions: readonly ComputerUseSessionFact[];
  readonly denials: readonly ComputerUseDenialFact[];
  readonly present: boolean;
}

/**
 * The computer-use facts of a run's public event stream: the tool-axis
 * step events (`tool-requested` / `tool-result` / `tool-denied`) whose
 * payloads carry computer-use session evidence (sessionId, mode, phase,
 * environmentRef, inheritedHostStateCount, deterministicFirst,
 * routeStageCount) and the typed denials ({denied, denialClass, code,
 * reason}) — exactly the real computer-use service's public payload
 * shapes. Non-computer-use tool events (a payload without any of these
 * keys) contribute nothing.
 */
export function computerUseFactsOf(events: readonly ExecutionEvent[]): ComputerUseFacts {
  const sessions: ComputerUseSessionFact[] = [];
  const denials: ComputerUseDenialFact[] = [];
  for (const event of chronologicalEvents(events)) {
    const command = normalizeStepEventType(event.type);
    if (command !== "tool-requested" && command !== "tool-result" && command !== "tool-denied") {
      continue;
    }
    const payload = event.payload as Readonly<Record<string, unknown>>;
    if (payload.denied === true) {
      denials.push({
        sessionId: stringOrNull(payload.sessionId),
        mode: stringOrNull(payload.mode),
        denialClass: stringOrNull(payload.denialClass),
        code: stringOrNull(payload.code),
        reason: stringOrNull(payload.reason),
        occurredAt: event.occurredAt,
        sequence: event.sequence,
      });
      continue;
    }
    if (
      payload.sessionId === undefined &&
      payload.mode === undefined &&
      payload.phase === undefined &&
      payload.environmentRef === undefined &&
      payload.inheritedHostStateCount === undefined &&
      payload.deterministicFirst === undefined &&
      payload.routeStageCount === undefined
    ) {
      continue;
    }
    sessions.push({
      sessionId: stringOrNull(payload.sessionId),
      mode: stringOrNull(payload.mode),
      phase: stringOrNull(payload.phase),
      environmentRef: stringOrNull(payload.environmentRef),
      inheritedHostStateCount: numberOrNull(payload.inheritedHostStateCount),
      deterministicFirst: booleanOrNull(payload.deterministicFirst),
      routeStageCount: numberOrNull(payload.routeStageCount),
      occurredAt: event.occurredAt,
      sequence: event.sequence,
    });
  }
  return { sessions, denials, present: sessions.length > 0 || denials.length > 0 };
}

// ---------------------------------------------------------------------------
// Agent-session facts (AC3/AC4 — realtime, messaging and media evidence)
// ---------------------------------------------------------------------------

/** One agent-session evidence row (the recorded payload facts). */
export interface AgentSessionEventFact {
  readonly stage: "session-started" | "action" | "session-completed";
  readonly occurredAt: string;
  readonly sequence: number;
  readonly callerRef: string | null;
  readonly participantRef: string | null;
  readonly railCapabilityId: string | null;
  readonly routeClass: string | null;
  readonly plannerOutcome: string | null;
  readonly reasonCodes: readonly string[];
  readonly responsePreview: string | null;
}

export interface AgentSessionFacts {
  readonly events: readonly AgentSessionEventFact[];
  readonly sessionCount: number;
  readonly present: boolean;
}

/**
 * The agent-session facts of a run's public event stream: the
 * `agent-session-*` step events (the shared vocabulary realtime,
 * messaging and media evidence ALL ride — the deployments module owns
 * none of it). The payload fields are each modality's own: callerRef /
 * participantRef / railCapabilityId (session starts), routeClass /
 * plannerOutcome / reasonCodes / responsePreview (turns). Every field is
 * read exactly as recorded; a payload without any known key contributes
 * only its lifecycle stage.
 */
export function agentSessionFactsOf(events: readonly ExecutionEvent[]): AgentSessionFacts {
  const rows: AgentSessionEventFact[] = [];
  let sessionCount = 0;
  for (const event of chronologicalEvents(events)) {
    const command = normalizeStepEventType(event.type);
    if (
      command !== "agent-session-started" &&
      command !== "agent-action-recorded" &&
      command !== "agent-session-completed"
    ) {
      continue;
    }
    if (command === "agent-session-started") {
      sessionCount += 1;
    }
    const payload = event.payload as Readonly<Record<string, unknown>>;
    const reasonCodes = stringArrayOrNull(payload.reasonCodes) ?? [];
    rows.push({
      stage:
        command === "agent-session-started"
          ? "session-started"
          : command === "agent-session-completed"
            ? "session-completed"
            : "action",
      occurredAt: event.occurredAt,
      sequence: event.sequence,
      callerRef: stringOrNull(payload.callerRef),
      participantRef: stringOrNull(payload.participantRef),
      railCapabilityId: stringOrNull(payload.railCapabilityId),
      routeClass: stringOrNull(payload.routeClass),
      plannerOutcome: stringOrNull(payload.plannerOutcome),
      reasonCodes,
      responsePreview: stringOrNull(payload.responsePreview),
    });
  }
  return { events: rows, sessionCount, present: rows.length > 0 };
}

// ---------------------------------------------------------------------------
// Media-generation facts (AC4 — the media payload's own vocabulary)
// ---------------------------------------------------------------------------

/** One media job evidence row (the recorded payload facts). */
export interface MediaJobEventFact {
  readonly stage: "job-submitted" | "job-dispatched" | "observation" | "artifact" | "job-completed";
  readonly occurredAt: string;
  readonly sequence: number;
  readonly generationKind: string | null;
  readonly verificationMode: string | null;
  readonly inputArtifactDigest: string | null;
  readonly preprocessingDigest: string | null;
  readonly postprocessingDigest: string | null;
  readonly outputArtifactDigest: string | null;
  readonly providerStateLabel: string | null;
  readonly verifiedByAuthority: boolean | null;
}

export interface MediaFacts {
  readonly events: readonly MediaJobEventFact[];
  readonly present: boolean;
}

/**
 * The media-generation facts of a run's public event stream: the
 * `agent-session-*` events whose payloads carry the media vocabulary
 * (generationKind, digests, providerStateLabel, verifiedByAuthority —
 * exactly the real media service's public payload shapes). Artifact
 * digests are REFERENCES ONLY; media content never rides the ledger.
 */
export function mediaFactsOf(events: readonly ExecutionEvent[]): MediaFacts {
  const rows: MediaJobEventFact[] = [];
  for (const event of chronologicalEvents(events)) {
    const command = normalizeStepEventType(event.type);
    if (
      command !== "agent-session-started" &&
      command !== "agent-action-recorded" &&
      command !== "agent-session-completed"
    ) {
      continue;
    }
    const payload = event.payload as Readonly<Record<string, unknown>>;
    const generationKind = stringOrNull(payload.generationKind);
    // The media payload's own vocabulary (the real media service's public
    // keys): a payload carrying ANY of these keys is media evidence; a
    // realtime/messaging payload (callerRef, routeClass, …) is NOT.
    const isMedia =
      generationKind !== null ||
      payload.verifiedByAuthority !== undefined ||
      payload.postprocessingDigest !== undefined ||
      payload.preprocessingDigest !== undefined ||
      payload.inputArtifactDigest !== undefined ||
      payload.verificationMode !== undefined ||
      payload.providerStateLabel !== undefined ||
      payload.role === "generated-output";
    if (!isMedia) {
      continue;
    }
    rows.push({
      stage:
        command === "agent-session-started"
          ? "job-submitted"
          : command === "agent-session-completed"
            ? "job-completed"
            : payload.role === "generated-output"
              ? "artifact"
              : payload.preprocessingDigest !== undefined ||
                  payload.providerStateLabel !== undefined
                ? "job-dispatched"
                : "observation",
      occurredAt: event.occurredAt,
      sequence: event.sequence,
      generationKind,
      verificationMode: stringOrNull(payload.verificationMode),
      inputArtifactDigest: stringOrNull(payload.inputArtifactDigest),
      preprocessingDigest: stringOrNull(payload.preprocessingDigest),
      postprocessingDigest: stringOrNull(payload.postprocessingDigest),
      outputArtifactDigest:
        payload.role === "generated-output" ? stringOrNull(payload.descriptorDigest) : null,
      providerStateLabel: stringOrNull(payload.providerStateLabel),
      verifiedByAuthority: booleanOrNull(payload.verifiedByAuthority),
    });
  }
  return { events: rows, present: rows.length > 0 };
}

// ---------------------------------------------------------------------------
// Training/accelerator facts (AC7 — the training payload's own vocabulary)
// ---------------------------------------------------------------------------

/** One training checkpoint evidence row (the recorded payload facts). */
export interface TrainingCheckpointFact {
  readonly checkpointSequence: number | null;
  readonly stepPosition: number | null;
  readonly metricsDigest: string | null;
  readonly occurredAt: string;
}

export interface TrainingFacts {
  readonly workloadId: string | null;
  readonly workloadKind: string | null;
  readonly status: string | null;
  readonly attempt: number | null;
  readonly admitted: boolean;
  readonly denied: boolean;
  readonly denialCode: string | null;
  readonly denialReason: string | null;
  readonly outcomeClass: string | null;
  readonly stepsCompleted: number | null;
  readonly outputArtifactDigest: string | null;
  readonly usageMicroUsd: string | null;
  readonly checkpoints: readonly TrainingCheckpointFact[];
  readonly present: boolean;
}

/**
 * The training/accelerator facts of a run's public event stream: the
 * `sandbox-*` step events whose payloads carry the training workload
 * vocabulary (workloadId, workloadKind, attempt, resource, outcomeClass,
 * stepsCompleted, usageMicroUsd — exactly the real training service's
 * public payload shapes) plus the training checkpoints
 * (`checkpoint-recorded` with checkpointSequence/stepPosition/
 * metricsDigest). Non-training sandbox events (a payload without the
 * workload vocabulary) contribute nothing.
 */
export function trainingFactsOf(events: readonly ExecutionEvent[]): TrainingFacts {
  let workloadId: string | null = null;
  let workloadKind: string | null = null;
  let status: string | null = null;
  let attempt: number | null = null;
  let admitted = false;
  let denied = false;
  let denialCode: string | null = null;
  let denialReason: string | null = null;
  let outcomeClass: string | null = null;
  let stepsCompleted: number | null = null;
  let outputArtifactDigest: string | null = null;
  let usageMicroUsd: string | null = null;
  const checkpoints: TrainingCheckpointFact[] = [];
  for (const event of chronologicalEvents(events)) {
    const command = normalizeStepEventType(event.type);
    const payload = event.payload as Readonly<Record<string, unknown>>;
    if (
      command === "sandbox-admitted" ||
      command === "sandbox-denied" ||
      command === "sandbox-completed"
    ) {
      if (
        payload.workloadId === undefined &&
        payload.workloadKey === undefined &&
        payload.workloadKind === undefined
      ) {
        continue;
      }
      workloadId = stringOrNull(payload.workloadId) ?? workloadId;
      workloadKind = stringOrNull(payload.workloadKind) ?? workloadKind;
      status = stringOrNull(payload.status) ?? status;
      attempt = numberOrNull(payload.attempt) ?? attempt;
      if (command === "sandbox-admitted") {
        admitted = true;
      }
      if (command === "sandbox-denied" && payload.denied === true) {
        denied = true;
        denialCode = stringOrNull(payload.code);
        denialReason = stringOrNull(payload.reason);
      }
      if (command === "sandbox-completed") {
        outcomeClass = stringOrNull(payload.outcomeClass) ?? outcomeClass;
        stepsCompleted = numberOrNull(payload.stepsCompleted) ?? stepsCompleted;
        outputArtifactDigest = stringOrNull(payload.outputArtifactDigest) ?? outputArtifactDigest;
        usageMicroUsd = stringOrNull(payload.usageMicroUsd) ?? usageMicroUsd;
      }
      continue;
    }
    if (command === "checkpoint-recorded" && payload.metricsDigest !== undefined) {
      checkpoints.push({
        checkpointSequence: numberOrNull(payload.checkpointSequence),
        stepPosition: numberOrNull(payload.stepPosition),
        metricsDigest: stringOrNull(payload.metricsDigest),
        occurredAt: event.occurredAt,
      });
    }
  }
  return {
    workloadId,
    workloadKind,
    status,
    attempt,
    admitted,
    denied,
    denialCode,
    denialReason,
    outcomeClass,
    stepsCompleted,
    outputArtifactDigest,
    usageMicroUsd,
    checkpoints,
    present: admitted || denied || outcomeClass !== null || checkpoints.length > 0,
  };
}

// ---------------------------------------------------------------------------
// Economic-action facts (AC8 — the execution-bound provenance timeline)
// ---------------------------------------------------------------------------

/** One economic-action provenance row (the event type IS the phase). */
export interface EconomicTimelineRow {
  readonly phase: "recorded" | "denied" | "authorized" | "settled" | "failed";
  readonly economicActionId: string | null;
  readonly occurredAt: string;
  readonly sequence: number;
}

export interface EconomicFacts {
  readonly timeline: readonly EconomicTimelineRow[];
  readonly actionIds: readonly string[];
  readonly present: boolean;
}

/**
 * The economic-action facts of a run's public event stream: the
 * `economic-action-*` step events — the execution-bound provenance
 * timeline. The public payload carries the economicActionId (the
 * provenance link); the bounded envelope (purpose, recipient, amount,
 * expiration), the authorization result and the settlement correlation
 * are the economics authority's own records and do NOT cross this wire —
 * this derivation never guesses them.
 */
export function economicFactsOf(events: readonly ExecutionEvent[]): EconomicFacts {
  const phases: Readonly<Record<string, EconomicTimelineRow["phase"]>> = {
    "economic-action-recorded": "recorded",
    "economic-action-denied": "denied",
    "economic-action-authorized": "authorized",
    "economic-action-settled": "settled",
    "economic-action-failed": "failed",
  };
  const timeline: EconomicTimelineRow[] = [];
  for (const event of chronologicalEvents(events)) {
    const phase = phases[normalizeStepEventType(event.type)];
    if (phase === undefined) {
      continue;
    }
    timeline.push({
      phase,
      economicActionId: stringOrNull(
        (event.payload as Readonly<Record<string, unknown>>).economicActionId,
      ),
      occurredAt: event.occurredAt,
      sequence: event.sequence,
    });
  }
  const actionIds = [
    ...new Set(
      timeline.map((row) => row.economicActionId).filter((id): id is string => id !== null),
    ),
  ];
  return { timeline, actionIds, present: timeline.length > 0 };
}

// ---------------------------------------------------------------------------
// Edge/embodied facts (AC6 — the workload-class evidence + the boundary)
// ---------------------------------------------------------------------------

export interface EdgeFacts {
  readonly workloadClass: string | null;
  readonly substrateId: string | null;
  readonly isolation: string | null;
  readonly latencyClass: string | null;
  readonly present: boolean;
}

/**
 * The edge/embodied facts of a run: the workload class the planning
 * decision's substrate selection recorded (the platform's own frozen
 * vocabulary: edge / embodied), with the selected substrate's isolation
 * and latency characteristics. The current physical command and the
 * local safety state are NOT public facts — the boundary sentence (the
 * hard-real-time safety loop stays local) renders on the surface; this
 * derivation never manufactures a command or safety fact.
 */
export function edgeFactsOf(decision: PlanningDecisionFact | null): EdgeFacts {
  const workloadClass = decision?.substrate?.workloadClass ?? null;
  const isEdge = workloadClass === "edge" || workloadClass === "embodied";
  const substrate = decision?.substrate ?? null;
  const selected =
    substrate === null
      ? null
      : (substrate.admissible.find(
          (candidate) => candidate.substrateId === substrate.selectedSubstrateId,
        ) ?? null);
  return {
    workloadClass: workloadClass,
    substrateId: isEdge ? (substrate?.selectedSubstrateId ?? null) : null,
    isolation: isEdge ? (selected?.isolation ?? null) : null,
    latencyClass: isEdge ? (selected?.latencyClass ?? null) : null,
    present: isEdge,
  };
}
