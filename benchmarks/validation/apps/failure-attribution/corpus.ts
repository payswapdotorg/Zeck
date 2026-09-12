/**
 * The failure-attribution corpus (VAL-020, AC1): the declared rows of
 * the failure-injection and attribution application. Per row: the
 * injected/observed failure class, the expected attribution layer,
 * the retryability classification, and the expected terminal +
 * recovery outcome (the exact attempt-count and ordered
 * attempt-outcome sequence). Every offline row is deterministically
 * reproducible through the app's fault-injection fixtures (replaying
 * the REAL provider failure envelope shapes from the documented live
 * runs); the live rows are env-gated on the authorized rails and pin
 * the DOCUMENTED live postures of the operator credentials (the
 * quota-blocked QWEN imagegen, the video-synthesis tier boundary, the
 * OpenRouter credit-limit posture) — a posture change is an honest
 * finding that re-pins the row, never a silently tolerated mismatch
 * (the VAL-015 fails-honestly precedent).
 *
 * The pinned retry policy (mirroring the program's bounded-retry
 * precedent): retryable classes get at most TWO extra attempts; every
 * other class is single-attempt. Waits are measured, never counted as
 * attempts.
 */

import type {
  AttemptOutcome,
  AttributionClass,
  AttributionLayer,
  AttributionOracle,
  AttributionRailRequest,
} from "../../platform/failure-attribution";
import type { FaultScenario } from "./fixtures";

/** The pinned bounded-retry policy the corpus oracles assume. */
export const CORPUS_RETRY_POLICY = {
  maxExtraAttempts: 2,
} as const;

/** One row of the failure-attribution corpus (oracle included). */
export interface FailureCorpusRow extends AttributionOracle {
  readonly rowId: string;
  readonly kind: "dispatch-probe" | "tool-probe";
  readonly description: string;
  /** The offline fault-injection scenario (null for live rows). */
  readonly scenario: FaultScenario | null;
  /** The rail request (dispatch rows; the model template for live rows). */
  readonly railRequest?: {
    readonly rail: "dashscope" | "openrouter";
    readonly endpoint: "multimodal-generation" | "video-synthesis" | "chat-completions";
    /** The pinned model (offline determinism; the live default). */
    readonly model: string;
    /** Live rows: the env var that overrides the model. */
    readonly modelEnvVar?: string;
    readonly prompt: string;
    /** The unaffordable-budget posture (max_tokens omitted — see platform). */
    readonly unaffordableBudget?: boolean;
    /** The async-submission posture (X-DashScope-Async — see platform). */
    readonly asyncSubmission?: boolean;
  };
  /** The tool invocation (tool rows). */
  readonly toolInvocation?: {
    readonly tool: string;
    readonly arguments: Readonly<Record<string, unknown>>;
  };
  /** The live gate (absent for offline rows — always drivable). */
  readonly liveGate?: {
    readonly envVars: readonly string[];
    readonly requirement: string;
  };
  /** Provenance of the replayed/injected shape. */
  readonly source: string;
}

const or = (
  injectedClass: AttributionClass | null,
  injectedRetryable: boolean,
  attributionClass: AttributionClass | null,
  layer: AttributionLayer | null,
  attempts: number,
  attemptOutcomes: readonly AttemptOutcome[],
  terminal: "COMPLETED" | "FAILED",
): AttributionOracle => ({
  injectedClass,
  injectedRetryable,
  expected: { attributionClass, layer, attempts, attemptOutcomes, terminal },
});

const failures = (count: number): readonly AttemptOutcome[] =>
  Array.from({ length: count }, () => "failure" as const);

/** The pinned corpus: 11 offline injection rows + 4 live rail rows. */
export const FAILURE_CORPUS: readonly FailureCorpusRow[] = [
  {
    rowId: "transport-failure",
    kind: "dispatch-probe",
    description:
      "The HTTP exchange itself fails on every attempt (injected ECONNREFUSED): attributed TRANSPORT, retryable — bounded to exactly three attempts.",
    scenario: "transport-failure",
    railRequest: {
      rail: "dashscope",
      endpoint: "multimodal-generation",
      model: "qwen-image-2.0",
      prompt: "attribution probe: a single red umbrella on a white background",
    },
    ...or("transport-failure", true, "transport-failure", "transport", 3, failures(3), "FAILED"),
    source: "injected transport fault (the connection-refused class every live rail can produce)",
  },
  {
    rowId: "quota-envelope",
    kind: "dispatch-probe",
    description:
      "The dashscope AllocationQuota.FreeTierOnly 403 envelope (the documented QWEN imagegen quota posture): attributed PROVIDER/quota, NON-retryable — exactly one attempt.",
    scenario: "quota-envelope",
    railRequest: {
      rail: "dashscope",
      endpoint: "multimodal-generation",
      model: "qwen-image-2.0",
      prompt: "attribution probe: a single red umbrella on a white background",
    },
    ...or("quota", false, "quota", "provider", 1, failures(1), "FAILED"),
    source: "REAL live envelope (VAL-015/VAL-018 documented runs)",
  },
  {
    rowId: "openrouter-credit-402",
    kind: "dispatch-probe",
    description:
      "The OpenRouter credit-limit 402 envelope (nested error.code 402): attributed PROVIDER/quota, NON-retryable — exactly one attempt.",
    scenario: "openrouter-credit-402",
    railRequest: {
      rail: "openrouter",
      endpoint: "chat-completions",
      model: "meta-llama/llama-3.3-70b-instruct",
      prompt: "Reply with exactly the single word: healthy.",
    },
    ...or("quota", false, "quota", "provider", 1, failures(1), "FAILED"),
    source: "REAL live envelope (the documented OpenRouter credit-limit class)",
  },
  {
    rowId: "rate-limit",
    kind: "dispatch-probe",
    description:
      "The OpenRouter 429 rate-limit envelope on every attempt: attributed PROVIDER/rate-limit, RETRYABLE — bounded to exactly three attempts.",
    scenario: "rate-limit",
    railRequest: {
      rail: "openrouter",
      endpoint: "chat-completions",
      model: "meta-llama/llama-3.3-70b-instruct",
      prompt: "Reply with exactly the single word: healthy.",
    },
    ...or("rate-limit", true, "rate-limit", "provider", 3, failures(3), "FAILED"),
    source: "REAL live envelope class (OpenRouter 429; message text representative)",
  },
  {
    rowId: "invalid-request",
    kind: "dispatch-probe",
    description:
      "The dashscope InternalError.Algo.InvalidParameter 400 envelope: attributed PROVIDER/invalid-request, NON-retryable — exactly one attempt.",
    scenario: "invalid-request",
    railRequest: {
      rail: "dashscope",
      endpoint: "multimodal-generation",
      model: "qwen-image-2.0",
      prompt: "attribution probe: a single red umbrella on a white background",
    },
    ...or("invalid-request", false, "invalid-request", "provider", 1, failures(1), "FAILED"),
    source: "REAL live envelope (VAL-014 live review: the dedicated-task parameter rejection)",
  },
  {
    rowId: "access-denied",
    kind: "dispatch-probe",
    description:
      "The dashscope AccessDenied 403 envelope from the video-synthesis family: attributed PROVIDER/access-denied, NON-retryable — exactly one attempt.",
    scenario: "access-denied",
    railRequest: {
      rail: "dashscope",
      endpoint: "video-synthesis",
      model: "wan2.2-t2v-plus",
      prompt: "attribution probe: a paper boat drifting on a puddle",
    },
    ...or("access-denied", false, "access-denied", "provider", 1, failures(1), "FAILED"),
    source: "REAL live envelope (VAL-014/VAL-016 documented findings: the video tier boundary)",
  },
  {
    rowId: "empty-completion",
    kind: "dispatch-probe",
    description:
      "The empty-content 200 (the documented honest-empty shape): attributed PROVIDER/empty-completion, never retried, and completed as the honest SUCCESS with empty content (the VAL-014 rule — never a fabricated failure, never fabricated content).",
    scenario: "empty-completion",
    railRequest: {
      rail: "dashscope",
      endpoint: "multimodal-generation",
      model: "qwen-image-2.0",
      prompt: "attribution probe: a single red umbrella on a white background",
    },
    ...or(
      "empty-completion",
      false,
      "empty-completion",
      "provider",
      1,
      ["success-empty"],
      "COMPLETED",
    ),
    source: "REAL live shape (VAL-014 live run: honest empty transcripts on the REAL rail)",
  },
  {
    rowId: "tool-failure",
    kind: "tool-probe",
    description:
      "The governed tool executes and REJECTS the invocation (unknown inventory key): attributed TOOL/tool-failure, NON-retryable — exactly one attempt (a deterministic refusal reproduces itself).",
    scenario: null,
    toolInvocation: { tool: "inventory-lookup", arguments: { key: "SKU-UNKNOWN" } },
    ...or("tool-failure", false, "tool-failure", "tool", 1, failures(1), "FAILED"),
    source: "injected tool refusal (the tool-agent surface precedent)",
  },
  {
    rowId: "tool-timeout",
    kind: "tool-probe",
    description:
      "The governed tool exceeds its execution deadline on every attempt (a hanging archiver): attributed TOOL/tool-timeout, RETRYABLE — bounded to exactly three attempts, no result ever fabricated.",
    scenario: null,
    toolInvocation: { tool: "slow-archiver", arguments: { bytes: 2048 } },
    ...or("tool-timeout", true, "tool-timeout", "tool", 3, failures(3), "FAILED"),
    source: "injected deadline overrun (the honest-absence timeout class)",
  },
  {
    rowId: "healthy-recovery-after-retry",
    kind: "dispatch-probe",
    description:
      "A transient transport failure recovers on the SECOND attempt: the failure attempt is attributed and journaled, the retry completes — a COMPLETED execution with the retry history journaled exactly once per attempt.",
    scenario: "healthy-recovery-after-retry",
    railRequest: {
      rail: "openrouter",
      endpoint: "chat-completions",
      model: "meta-llama/llama-3.3-70b-instruct",
      prompt: "Reply with exactly the single word: healthy.",
    },
    ...or("transport-failure", true, null, null, 2, ["failure", "success"], "COMPLETED"),
    source: "injected transient fault then the healthy replay shape",
  },
  {
    rowId: "healthy-no-retry",
    kind: "dispatch-probe",
    description: "A clean first-attempt success: no attribution, exactly one attempt, COMPLETED.",
    scenario: "healthy-no-retry",
    railRequest: {
      rail: "openrouter",
      endpoint: "chat-completions",
      model: "meta-llama/llama-3.3-70b-instruct",
      prompt: "Reply with exactly the single word: healthy.",
    },
    ...or(null, false, null, null, 1, ["success"], "COMPLETED"),
    source: "the healthy OpenRouter-shaped replay",
  },
  // ---- LIVE rail rows (env-gated; the Lead drives them with the
  // operator-authorized credentials at review time) ----
  {
    rowId: "live-openrouter-healthy",
    kind: "dispatch-probe",
    description:
      "A REAL completion over the REAL OpenRouter rail (the VAL-019-proven default model): no attribution, exactly one attempt, COMPLETED.",
    scenario: null,
    railRequest: {
      rail: "openrouter",
      endpoint: "chat-completions",
      model: "meta-llama/llama-3.3-70b-instruct",
      modelEnvVar: "ZECK_VAL_020_OPENROUTER_MODEL",
      prompt: "Reply with exactly the single word: healthy.",
    },
    liveGate: {
      envVars: ["OPENROUTER_API_KEY"],
      requirement:
        "operator-authorized OpenRouter credential (env OPENROUTER_API_KEY) covering the default chat model",
    },
    ...or(null, false, null, null, 1, ["success"], "COMPLETED"),
    source: "the VAL-019 live-proven OpenRouter rail posture (credential-bearing)",
  },
  {
    // 2026-09-12 Lead live re-pin: the documented AllocationQuota.FreeTierOnly
    // 403 posture was REAL until ~22:40 UTC (VAL-014/015/018 live runs); the
    // operator then LIFTED the image-generation quota AND the endpoint's API
    // shape changed (input.messages now required — input.prompt is rejected).
    // The CURRENT genuine failure this canonical body produces is the REAL
    // 400 InvalidParameter envelope ("Field required: input.messages") —
    // attributed provider/invalid-request, NON-retryable. The posture change
    // is recorded here per the fails-honestly precedent.
    rowId: "live-qwen-imagegen-shape-rejected",
    kind: "dispatch-probe",
    description:
      "The REAL dashscope multimodal-generation dispatch with the canonical input.prompt body: the API's current shape contract rejects it with the 400 InvalidParameter envelope (Field required: input.messages) — attributed PROVIDER/invalid-request, NON-retryable, exactly one attempt, the honest FAILED terminal. (The earlier-documented AllocationQuota 403 posture was lifted by the operator on 2026-09-12; the quota-free rail now requires the input.messages shape.)",
    scenario: null,
    railRequest: {
      rail: "dashscope",
      endpoint: "multimodal-generation",
      model: "qwen-image-2.0",
      modelEnvVar: "ZECK_VAL_020_QWEN_IMAGE_MODEL",
      prompt: "a small red umbrella on a white background",
    },
    liveGate: {
      envVars: ["QWEN_API_KEY"],
      requirement:
        "operator-authorized dashscope-international credential (env QWEN_API_KEY); the CURRENT live posture is the shape-contract 400 InvalidParameter (the quota-blocked posture was lifted 2026-09-12 ~22:40 UTC)",
    },
    ...or("invalid-request", false, "invalid-request", "provider", 1, failures(1), "FAILED"),
    source:
      "REAL live posture (re-pinned 2026-09-12 22:45 UTC after the quota lift + API shape change)",
  },
  {
    rowId: "live-qwen-video-access-denied",
    kind: "dispatch-probe",
    description:
      "The REAL dashscope video-synthesis dispatch with the QWEN key's documented tier boundary: the AccessDenied 403 envelope attributed PROVIDER/access-denied, NON-retryable, exactly one attempt, the honest FAILED terminal.",
    scenario: null,
    railRequest: {
      rail: "dashscope",
      endpoint: "video-synthesis",
      model: "wan2.2-t2v-plus",
      modelEnvVar: "ZECK_VAL_020_QWEN_VIDEO_MODEL",
      prompt: "a paper boat drifting on a puddle",
    },
    liveGate: {
      envVars: ["QWEN_API_KEY"],
      requirement:
        "operator-authorized dashscope-international credential (env QWEN_API_KEY); the DOCUMENTED posture is the video-synthesis AccessDenied tier boundary",
    },
    ...or("access-denied", false, "access-denied", "provider", 1, failures(1), "FAILED"),
    source: "REAL live posture (VAL-014/VAL-016 documented findings)",
  },
  {
    // 2026-09-12 Lead live re-pin: with a bounded completion budget
    // (max_tokens: 16) the account's free allowance covers every available
    // model — no 402 is reachable. The GENUINE credit-limit posture is the
    // FULL DEFAULT completion budget (max_tokens omitted): the affordability
    // check rejects the request with the REAL 402 envelope. Live-proven on
    // the default chat model (qwen2.5-vl-72b: "You requested up to 115189
    // tokens, but can only afford 18871"); no premium-model pinning needed.
    rowId: "live-openrouter-credit-402",
    kind: "dispatch-probe",
    description:
      "The REAL OpenRouter dispatch requesting the model's FULL default completion budget (the unaffordable posture): the credit-limit 402 envelope attributed PROVIDER/quota, NON-retryable, exactly one attempt, the honest FAILED terminal.",
    scenario: null,
    railRequest: {
      rail: "openrouter",
      endpoint: "chat-completions",
      model: "qwen/qwen2.5-vl-72b-instruct",
      modelEnvVar: "ZECK_VAL_020_OPENROUTER_402_MODEL",
      prompt: "Reply with exactly the single word: healthy.",
      unaffordableBudget: true,
    },
    liveGate: {
      envVars: ["OPENROUTER_API_KEY"],
      requirement:
        "operator-authorized OpenRouter credential (env OPENROUTER_API_KEY); the unaffordable-budget posture requests the model's full default completion budget (max_tokens omitted) — the account's credit limit genuinely rejects it with the 402 envelope",
    },
    ...or("quota", false, "quota", "provider", 1, failures(1), "FAILED"),
    source:
      "the documented OpenRouter credit-limit envelope class (the work order's verbatim prefix; re-pinned to the unaffordable-budget producer 2026-09-12 22:50 UTC)",
  },
];

/** The offline rows (deterministic fault injection — always drivable). */
export const OFFLINE_CORPUS_ROWS: readonly FailureCorpusRow[] = FAILURE_CORPUS.filter(
  (row) => row.liveGate === undefined,
);

/** The live rows (env-gated on the authorized rails). */
export const LIVE_CORPUS_ROWS: readonly FailureCorpusRow[] = FAILURE_CORPUS.filter(
  (row) => row.liveGate !== undefined,
);

/** Whether every env var of the row's live gate is present. */
export function liveGateOpen(row: FailureCorpusRow, env: NodeJS.ProcessEnv): boolean {
  if (row.liveGate === undefined) {
    return true;
  }
  return row.liveGate.envVars.every((name) => (env[name] ?? "").length > 0);
}

/**
 * Resolve the rail request for one row. Offline rows are fully pinned
 * (deterministic request digests); live rows read their model from the
 * declared env var at CALL time (never at module scope — no import
 * side effects, and the crown resolves only when the gate is open).
 */
export function resolveRailRequest(row: FailureCorpusRow): AttributionRailRequest {
  if (row.railRequest === undefined) {
    throw new Error(`corpus row ${row.rowId} declares no rail request`);
  }
  const model =
    row.railRequest.modelEnvVar !== undefined &&
    (process.env[row.railRequest.modelEnvVar] ?? "").length > 0
      ? (process.env[row.railRequest.modelEnvVar] as string)
      : row.railRequest.model;
  return {
    rail: row.railRequest.rail,
    endpoint: row.railRequest.endpoint,
    model,
    prompt: row.railRequest.prompt,
    ...(row.railRequest.unaffordableBudget === true ? { unaffordableBudget: true } : {}),
    ...(row.railRequest.asyncSubmission === true ? { asyncSubmission: true } : {}),
  };
}
