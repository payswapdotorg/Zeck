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

/** Known command events → friendly stage labels; unknown types stay verbatim. */
export function eventStageLabel(eventType: string): string {
  switch (eventType) {
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
    if (event.type === "checkpoint-recorded") {
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
    const kind = WORKLOAD_RECOVERY_EVENT_KINDS[event.type];
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
