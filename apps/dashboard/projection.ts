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
// Attention derivation (Home "Needs your attention")
// ---------------------------------------------------------------------------

export type AttentionKind = "decision" | "failed";

export interface AttentionLink {
  readonly label: string;
  readonly href: string;
}

export interface AttentionItem {
  readonly kind: AttentionKind;
  readonly title: string;
  readonly body: string;
  readonly links: readonly AttentionLink[];
}

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
}

export type FormErrors = Partial<Record<keyof ExecutionFormValues, string>>;

const DOLLARS_PATTERN = /^\d+(\.\d{1,2})?$/;

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
  return {
    applicationId: values.applicationId,
    ...(values.environmentId.length > 0 ? { environmentId: values.environmentId } : {}),
    task: { kind: "outcome", description: values.outcome },
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
