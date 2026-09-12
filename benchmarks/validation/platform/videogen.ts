/**
 * The video-generation platform slice (VAL-016).
 *
 * The PLATFORM (Zeck's operators/runtime) — never the application —
 * derives, from a customer-submitted text-to-video task:
 *   1. the videogen dispatch plan (seeded storyboard prompt fixture,
 *      canonical rail request with request-level reproducibility
 *      digests, and route facts),
 *   2. the ASYNCHRONOUS REAL generation lifecycle as a TYPED state
 *      machine — submitted → task-id issued → bounded polling →
 *      terminal (succeeded with an artifact URL / failed with the
 *      provider-failure taxonomy) → artifact fetch — driven over the
 *      REAL dashscope-international video-synthesis task API (the
 *      `wan2.2-t2v-plus` rail with the async header
 *      `X-DashScope-Async: enable`; env-credential gated, never
 *      repository credentials), and
 *   3. the mechanical verification criteria a completion is judged by
 *      (MP4 `ftyp` container validity, declared byte-size bounds,
 *      canonical sha256 digest capture — plus the rail-reported
 *      duration/dimension bounds WHERE the rail reports them; never
 *      frame-level content claims, never aesthetic judgment).
 *
 * The derivations and the state machine are PURE: no network, no
 * environment, no randomness. The rail is REAL but
 * transport-injected (the production binding injects the global
 * fetch; unit and discrimination tests inject controlled fakes).
 * Honesty invariants (by construction):
 *   * a fixture absent from the materialization is a thrown NOT-RUN
 *     signal BEFORE any lifecycle mutation (never a silent empty
 *     dispatch);
 *   * a materialization whose digest disagrees with the plan is
 *     rejected BEFORE any network effect (fixture-digest mismatch);
 *   * a blank prompt or a zero-duration task is rejected BEFORE any
 *     paid dispatch (the corpus's own edge rows);
 *   * a task whose kind is outside the videogen vocabulary is
 *     rejected BEFORE any network effect (wrong-modality);
 *   * the async wait is BOUNDED (bounded poll attempts at a bounded
 *     interval within a declared wall-clock budget): a generation
 *     that exceeds the budget is an honest task-timeout failure
 *     (never an unbounded wait, never a fabricated completion);
 *   * a provider failure (or a malformed video payload) FAILS the
 *     execution — never completes it;
 *   * dispatch timing and usage are measured, never estimated;
 *   * the planning decision is recorded BEFORE the dispatch;
 *   * evidence carries payload DIGESTS, never payloads.
 */

import {
  type VideoPromptFixture,
  videoPromptDigest,
  videoPromptFixture,
} from "../apps/video-generation/prompts";
import type { LabRoute, LabUsage, LabVerificationCriterion } from "./derive";
import type { PlatformLifecyclePort } from "./driver";
import {
  mediaDigest,
  parseRailResolution,
  sniffMp4Container,
  VIDEO_BYTE_BOUNDS,
  videoBytesWithinBounds,
} from "./videogen-container";

// ---------------------------------------------------------------------------
// Task vocabulary (the pinned VAL-016 slice)
// ---------------------------------------------------------------------------

/**
 * Text-to-video generation: a seeded storyboard prompt fixture with
 * bounded declared parameters. `seconds: 0` is the corpus's own
 * zero-duration edge row — rejected BEFORE any paid dispatch.
 */
export interface GenerateVideoTask {
  readonly kind: "generate-video";
  /**
   * The seeded storyboard prompt fixture key (materialized
   * deterministically platform-side). The empty string is the corpus's
   * own empty-prompt edge row.
   */
  readonly prompt: string;
  /** The declared clip duration in seconds (> 0 when present). */
  readonly seconds?: number;
  /** The declared aspect ratio (mapped to the rail's size parameter). */
  readonly aspect?: "16:9" | "9:16";
}

export type VideogenTask = GenerateVideoTask;

/** The dispatch mode the videogen rail serves. */
export type VideogenMode = "text-to-video";

// ---------------------------------------------------------------------------
// Materialization (pure, deterministic — the VAL-003 recipes)
// ---------------------------------------------------------------------------

/** One task's materialized dispatch inputs and ground truth. */
export interface MaterializedVideogenInput {
  readonly mode: VideogenMode;
  /** The exact storyboard prompt text dispatched. */
  readonly prompt: string;
  readonly promptKey: string;
  /** sha256-16 of the prompt text bytes (request-level reproducibility). */
  readonly promptDigest: string;
  /** Fixture provenance (recorded in evidence; never an aesthetic oracle). */
  readonly annotation: string;
  /** The declared duration in seconds (default 5 when absent). */
  readonly duration: number;
  /** The declared rail size string (default "1280*720" for 16:9). */
  readonly sizeString: string;
  /** The declared dimensions the size string encodes. */
  readonly size: { readonly width: number; readonly height: number };
}

/** A fixture (or task vocabulary) absent from the materialization is a NOT RUN boundary. */
export class VideogenFixtureNotMaterializedError extends Error {
  constructor(key: string) {
    super(`videogen fixture not materialized (NOT RUN boundary): ${key}`);
    this.name = "VideogenFixtureNotMaterializedError";
  }
}

/** The default bounded duration the platform requests (5 seconds). */
export const DEFAULT_VIDEO_DURATION_SECONDS = 5;

/**
 * The rail-supported size for each declared aspect.
 *
 * 2026-09-12 Lead live re-pin: wan2.2-t2v-plus accepts ONLY the explicit
 * size whitelist (a submitted 1280*720 task fails with InvalidParameter
 * "size must be in 1080*1920,1920*1080,1440*1440,1632*1248,1248*1632,
 * 480*832,832*480,624*624" — live-observed on an ACCEPTED async task).
 * The 16:9 rows use 1920*1080; the 9:16 rows use 1080*1920.
 */
const ASPECT_SIZES: Record<"16:9" | "9:16", { width: number; height: number }> = {
  "16:9": { width: 1920, height: 1080 },
  "9:16": { width: 1080, height: 1920 },
};

/** Materialize one task's dispatch inputs deterministically (no environment). */
export function materializeVideogenInput(task: GenerateVideoTask): MaterializedVideogenInput {
  let fixture: VideoPromptFixture;
  try {
    fixture = videoPromptFixture(task.prompt);
  } catch {
    throw new VideogenFixtureNotMaterializedError(task.prompt);
  }
  const aspect = task.aspect ?? "16:9";
  const size = ASPECT_SIZES[aspect];
  return {
    mode: "text-to-video",
    prompt: fixture.prompt,
    promptKey: fixture.key,
    promptDigest: videoPromptDigest(fixture.prompt),
    annotation: fixture.annotation,
    duration: task.seconds ?? DEFAULT_VIDEO_DURATION_SECONDS,
    sizeString: `${size.width}*${size.height}`,
    size,
  };
}

// ---------------------------------------------------------------------------
// Dispatch-plan derivation (pure)
// ---------------------------------------------------------------------------

/**
 * The canonical rail request body (byte-stable for request digests):
 * the dashscope-international video-synthesis async task shape —
 * `{ model, input: { prompt }, parameters: { size, duration } }`.
 */
export function buildVideogenRequestBody(input: {
  readonly model: string;
  readonly prompt: string;
  readonly sizeString?: string;
  readonly duration?: number;
}): Readonly<Record<string, unknown>> {
  const parameters: Record<string, unknown> = {};
  if (input.sizeString !== undefined) {
    parameters.size = input.sizeString;
  }
  if (input.duration !== undefined) {
    parameters.duration = input.duration;
  }
  return {
    model: input.model,
    input: { prompt: input.prompt },
    ...(Object.keys(parameters).length === 0 ? {} : { parameters }),
  };
}

/** Route facts + request facts recorded on the execution ledger. */
export interface VideogenDispatchPlan {
  readonly route: LabRoute;
  readonly mode: VideogenMode;
  readonly prompt: string;
  readonly promptKey: string;
  readonly promptDigest: string;
  readonly duration: number;
  readonly sizeString: string;
  readonly size: { readonly width: number; readonly height: number };
  /**
   * sha256-16 over the canonical serialized rail request body — the
   * request-level reproducibility reference (the same task always
   * derives the same request, so the same request digest).
   */
  readonly requestDigest: string;
}

/**
 * Derive the dispatch plan for one videogen task. An absent fixture
 * throws (NOT RUN), never silently degrades; the request digest makes
 * every dispatch reproducible at the request level.
 */
export function deriveVideogenPlan(
  task: GenerateVideoTask,
  options: { readonly provider: string; readonly model: string },
): VideogenDispatchPlan {
  const materialized = materializeVideogenInput(task);
  const body = buildVideogenRequestBody({
    model: options.model,
    prompt: materialized.prompt,
    sizeString: materialized.sizeString,
    duration: materialized.duration,
  });
  return {
    route: {
      provider: options.provider,
      model: options.model,
      strategyClass: "async-text-to-video",
    },
    mode: materialized.mode,
    prompt: materialized.prompt,
    promptKey: materialized.promptKey,
    promptDigest: materialized.promptDigest,
    duration: materialized.duration,
    sizeString: materialized.sizeString,
    size: materialized.size,
    requestDigest: mediaDigest(Buffer.from(JSON.stringify(body), "utf8")),
  };
}

// ---------------------------------------------------------------------------
// The typed asynchronous lifecycle state machine (pure)
// ---------------------------------------------------------------------------

/**
 * The bounded async lifecycle contract (VAL-016 AC2): submitted →
 * task-id issued → polling (bounded attempts) → terminal (succeeded
 * with an artifact URL / failed with the provider-failure taxonomy);
 * a generation that exhausts the bounded poll budget ends in
 * `budget-exhausted` — never an unbounded wait.
 */
export type VideogenAsyncState =
  | { readonly phase: "submitted"; readonly polls: 0 }
  | { readonly phase: "task-issued"; readonly taskId: string; readonly polls: number }
  | { readonly phase: "polling"; readonly taskId: string; readonly polls: number }
  | {
      readonly phase: "succeeded";
      readonly taskId: string;
      readonly artifactUrl: string;
      readonly polls: number;
    }
  | {
      readonly phase: "failed";
      readonly taskId: string | null;
      readonly category: string;
      readonly message: string;
      readonly retryable: boolean;
      readonly polls: number;
    }
  | { readonly phase: "budget-exhausted"; readonly taskId: string; readonly polls: number };

/** The bounded poll budget: at most `maxPolls` poll attempts, ever. */
export interface VideogenAsyncLimits {
  readonly maxPolls: number;
}

/** One observed lifecycle event, fed to the pure reducer. */
export type VideogenAsyncEvent =
  | { readonly type: "task-issued"; readonly taskId: string }
  | {
      readonly type: "submit-failed";
      readonly category: string;
      readonly message: string;
      readonly retryable: boolean;
    }
  | {
      readonly type: "poll-observed";
      readonly status: string;
      readonly artifactUrl?: string;
      readonly code?: string;
      readonly message?: string;
    }
  | {
      readonly type: "poll-failed";
      readonly category: string;
      readonly message: string;
      readonly retryable: boolean;
    };

function failed(
  taskId: string | null,
  category: string,
  message: string,
  retryable: boolean,
  polls: number,
): VideogenAsyncState {
  return { phase: "failed", taskId, category, message, retryable, polls };
}

/**
 * The pure lifecycle reducer: advance the async state by one observed
 * event under the bounded poll budget. Total and deterministic — the
 * same (state, event, limits) always yields the same next state.
 *
 *   * submitted + task-issued → task-issued (task identity recorded);
 *   * submitted + submit-failed → failed (submission taxonomy);
 *   * non-terminal poll observations (PENDING / RUNNING / any other
 *     non-terminal provider status) keep polling while the budget
 *     lasts, then end in budget-exhausted (the honest declared
 *     boundary — never an unbounded wait);
 *   * SUCCEEDED with an artifact URL → succeeded (terminal);
 *   * SUCCEEDED without an artifact URL → failed (empty-output);
 *   * FAILED / CANCELED / UNKNOWN → failed (provider-task-failed,
 *     non-retryable, taxonomy message from the provider's own code);
 *   * retryable poll failures consume the budget while it lasts;
 *     non-retryable poll failures fail immediately.
 */
export function advanceVideogenAsyncState(
  state: VideogenAsyncState,
  event: VideogenAsyncEvent,
  limits: VideogenAsyncLimits,
): VideogenAsyncState {
  if (event.type === "task-issued") {
    if (state.phase === "submitted") {
      return { phase: "task-issued", taskId: event.taskId, polls: 0 };
    }
    return state;
  }
  if (event.type === "submit-failed") {
    if (state.phase === "submitted") {
      return failed(null, event.category, event.message, event.retryable, 0);
    }
    return state;
  }
  if (state.phase === "task-issued" || state.phase === "polling") {
    const taskId = state.taskId;
    const nextPolls = state.polls + 1;
    if (event.type === "poll-failed") {
      if (!event.retryable) {
        return failed(taskId, event.category, event.message, false, nextPolls);
      }
      return nextPolls >= limits.maxPolls
        ? { phase: "budget-exhausted", taskId, polls: nextPolls }
        : { phase: "polling", taskId, polls: nextPolls };
    }
    if (event.status === "SUCCEEDED") {
      if (event.artifactUrl !== undefined && event.artifactUrl.length > 0) {
        return {
          phase: "succeeded",
          taskId,
          artifactUrl: event.artifactUrl,
          polls: nextPolls,
        };
      }
      return failed(
        taskId,
        "empty-output",
        "task succeeded but returned no video artifact URL",
        true,
        nextPolls,
      );
    }
    if (event.status === "FAILED" || event.status === "CANCELED" || event.status === "UNKNOWN") {
      const message =
        event.message !== undefined && event.message.length > 0
          ? event.message
          : event.code !== undefined && event.code.length > 0
            ? event.code
            : `task ended in ${event.status}`;
      return failed(taskId, "provider-task-failed", message, false, nextPolls);
    }
    // PENDING / RUNNING / any other non-terminal status: keep polling
    // within the bounded budget.
    return nextPolls >= limits.maxPolls
      ? { phase: "budget-exhausted", taskId, polls: nextPolls }
      : { phase: "polling", taskId, polls: nextPolls };
  }
  return state;
}

// ---------------------------------------------------------------------------
// Mechanical verification derivation (pure)
// ---------------------------------------------------------------------------

/** The rail-reported facts captured on a successful dispatch. */
export interface RailReportedBounds {
  /** The clip duration the rail itself reported (seconds), when it does. */
  readonly durationSeconds: number | null;
  /** The resolution the rail itself reported, when it does. */
  readonly resolution: { readonly width: number; readonly height: number } | null;
}

/** One successfully delivered video artifact from a rail. */
export interface VideogenRailVideo {
  readonly bytes: Buffer;
  /** `mp4` iff a sane `ftyp` box opens the payload (magic bytes). */
  readonly container: "mp4" | "unknown";
  /** The major brand declared by the `ftyp` box (evidence only). */
  readonly majorBrand: string | null;
  readonly byteLength: number;
}

/** The rail dispatch outcome: a delivered artifact or an honest failure. */
export type VideogenRailOutcome =
  | {
      readonly kind: "success";
      readonly video: VideogenRailVideo;
      /** The provider task identity (issued at submission; recorded). */
      readonly taskId: string;
      /** The artifact URL the terminal task status carried. */
      readonly artifactUrl: string;
      /** The poll attempts consumed within the bounded budget. */
      readonly polls: number;
      /** Measured submission-to-terminal wall time (milliseconds). */
      readonly submissionToTerminalMs: number | null;
      /** Duration/dimension bounds the rail itself reported (else null). */
      readonly reported: RailReportedBounds;
      readonly usage?: LabUsage;
    }
  | {
      readonly kind: "failure";
      readonly category: string;
      readonly message: string;
      readonly retryable: boolean;
      /** The provider task identity when one was issued (else null). */
      readonly taskId: string | null;
      /** The poll attempts consumed before the failure. */
      readonly polls: number;
    };

/**
 * Derive the verification criteria for one videogen outcome.
 *
 * The oracle floor: a provider failure fails ANY run mechanically.
 * Generated outputs are verified mechanically ONLY — MP4 `ftyp`
 * container validity, declared byte-size bounds, canonical sha256
 * digest capture — never frame-level content claims, never aesthetic
 * judgment. The rail-reported duration/dimension bounds are enforced
 * exactly WHERE the rail reports them (a criterion appears only then;
 * an unreported bound is recorded as an honest fact, never guessed).
 */
export function deriveVideogenVerification(
  task: GenerateVideoTask,
  outcome: VideogenRailOutcome,
): LabVerificationCriterion[] {
  if (outcome.kind === "failure") {
    // A provider failure fails the run mechanically — no shortcut.
    return [
      {
        criterionId: "provider-dispatch",
        strategy: "deterministic",
        status: "FAIL",
        evidence: [
          `provider-failure:${outcome.category}`,
          `retryable:${String(outcome.retryable)}`,
          `taskId:${outcome.taskId ?? "none"}`,
          `polls:${String(outcome.polls)}`,
          `message:${truncate(outcome.message, 160)}`,
        ],
      },
    ];
  }
  const video = outcome.video;
  const digest = mediaDigest(video.bytes);
  const container = sniffMp4Container(video.bytes);
  const materialized = materializeVideogenInput(task);
  const criteria: LabVerificationCriterion[] = [];

  // 1. Valid MP4 container (the `ftyp` box, by magic bytes — never by
  //    extension, never by provider mime type).
  criteria.push({
    criterionId: "mp4-container",
    strategy: "deterministic",
    status: container.container === "mp4" ? "PASS" : "FAIL",
    evidence: [
      `container:${container.container}`,
      container.majorBrand === null ? "brand:none" : `brand:${container.majorBrand}`,
      `bytes:${video.byteLength}`,
      `digest:${digest}`,
      `fixture:${materialized.promptKey}`,
    ],
  });

  // 2. Byte-size bounds (non-empty AND within the declared bounds).
  criteria.push({
    criterionId: "payload-bounds",
    strategy: "deterministic",
    status: videoBytesWithinBounds(video.byteLength) ? "PASS" : "FAIL",
    evidence: [
      `bytes:${video.byteLength}`,
      `bounds:${VIDEO_BYTE_BOUNDS.minBytes}..${VIDEO_BYTE_BOUNDS.maxBytes}`,
      `digest:${digest}`,
      `fixture:${materialized.promptKey}`,
    ],
  });

  // 3. Digest capture (the canonical sha256 reference recorded on the
  //    ledger — payload DIGESTS in evidence, never payloads).
  criteria.push({
    criterionId: "digest-captured",
    strategy: "deterministic",
    status: video.byteLength > 0 ? "PASS" : "FAIL",
    evidence: [
      `digest:${digest}`,
      "algorithm:sha256",
      `fixture:${materialized.promptKey}`,
      `taskId:${outcome.taskId}`,
    ],
  });

  // 4. Duration bound WHERE the rail reports a duration (the corpus
  //    tolerance: within +/- 10 percent of the declared seconds, or
  //    one second, whichever is larger). Absent a rail report this
  //    criterion is honestly absent — never guessed.
  if (outcome.reported.durationSeconds !== null && task.seconds !== undefined) {
    const requested = task.seconds;
    const tolerance = Math.max(1, Math.ceil(requested * 0.1));
    const delta = Math.abs(outcome.reported.durationSeconds - requested);
    criteria.push({
      criterionId: "duration-reported-honored",
      strategy: "deterministic",
      status: delta <= tolerance ? "PASS" : "FAIL",
      evidence: [
        `railDuration:${outcome.reported.durationSeconds}`,
        `requested:${requested}`,
        `tolerance:${tolerance}`,
        `delta:${delta}`,
        `digest:${digest}`,
      ],
    });
  }

  // 5. Dimension bound WHERE the rail reports a resolution (exact
  //    equality with the declared size the request carried). Absent a
  //    rail report this criterion is honestly absent — never guessed.
  if (outcome.reported.resolution !== null) {
    const equal =
      outcome.reported.resolution.width === materialized.size.width &&
      outcome.reported.resolution.height === materialized.size.height;
    criteria.push({
      criterionId: "dimensions-reported-honored",
      strategy: "deterministic",
      status: equal ? "PASS" : "FAIL",
      evidence: [
        `railResolution:${outcome.reported.resolution.width}x${outcome.reported.resolution.height}`,
        `requested:${materialized.size.width}x${materialized.size.height}`,
        `digest:${digest}`,
      ],
    });
  }

  return criteria;
}

// ---------------------------------------------------------------------------
// The REAL provider rail (transport-injected)
// ---------------------------------------------------------------------------

/** The HTTP transport seam (the production binding injects fetch). */
export type HttpTransport = (
  url: string,
  init: {
    readonly method: string;
    readonly headers: Readonly<Record<string, string>>;
    readonly body?: string;
    readonly signal?: AbortSignal;
  },
) => Promise<Response>;

/** A video-generation provider rail: one mode, one REAL endpoint. */
export interface VideogenRail {
  readonly railId: string;
  readonly mode: VideogenMode;
  dispatch(input: {
    readonly model: string;
    readonly prompt: string;
    /** The declared rail size string (e.g. "1280*720"). */
    readonly sizeString?: string;
    /** The declared clip duration in seconds. */
    readonly duration?: number;
  }): Promise<VideogenRailOutcome>;
}

/** Map an HTTP status to the provider-failure taxonomy. */
function classifyHttpFailure(status: number): {
  readonly category: string;
  readonly retryable: boolean;
} {
  if (status === 400) return { category: "invalid-request", retryable: false };
  if (status === 401 || status === 403) return { category: "auth", retryable: false };
  if (status === 404) return { category: "model-unavailable", retryable: false };
  if (status === 429) return { category: "rate-limit", retryable: true };
  if (status >= 500) return { category: "provider-unavailable", retryable: true };
  return { category: "provider-error", retryable: status >= 500 };
}

function extractErrorMessage(body: unknown): string {
  const asRecord = body as {
    error?: { message?: unknown } | string;
    message?: unknown;
    code?: unknown;
  };
  const error = asRecord?.error;
  if (typeof error === "string") return error;
  const message =
    (error as { message?: unknown } | undefined)?.message ?? asRecord?.message ?? asRecord?.code;
  return typeof message === "string" ? message : "provider failure (no provider message)";
}

function truncate(value: string, bound: number): string {
  return value.length <= bound ? value : `${value.slice(0, bound)}…`;
}

function readNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** Extract the video artifact reference from a terminal task output. */
function extractVideoReference(output: unknown): string | null {
  const record = output as {
    video_url?: unknown;
    results?: readonly Record<string, unknown>[];
  };
  if (typeof record?.video_url === "string" && record.video_url.length > 0) {
    return record.video_url;
  }
  for (const result of record?.results ?? []) {
    for (const field of ["url", "video_url"] as const) {
      const value = result?.[field];
      if (typeof value === "string" && value.length > 0) {
        return value;
      }
    }
  }
  return null;
}

/** Extract the provider usage report honestly (never estimated). */
function extractUsage(body: unknown): LabUsage | undefined {
  const usage = (body as { usage?: Record<string, unknown> })?.usage;
  if (usage === undefined) {
    return undefined;
  }
  const inputTokens = readNumber(usage.input_tokens) ?? 0;
  const outputTokens =
    readNumber(usage.video_count) ??
    readNumber(usage.videoCount) ??
    readNumber(usage.output_tokens) ??
    0;
  return { inputTokens, outputTokens };
}

/** Extract the duration/dimension bounds the rail itself reports (else null). */
function extractRailReportedBounds(body: unknown): RailReportedBounds {
  const output = (body as { output?: Record<string, unknown> })?.output ?? {};
  const usage = (body as { usage?: Record<string, unknown> })?.usage ?? {};
  const durationSeconds =
    readNumber(output.video_duration) ??
    readNumber(output.duration) ??
    readNumber(usage.video_duration);
  const resolutionRaw =
    (typeof output.resolution === "string" ? output.resolution : undefined) ??
    (typeof output.size === "string" ? output.size : undefined);
  return {
    durationSeconds: durationSeconds === null ? null : durationSeconds,
    resolution: resolutionRaw === undefined ? null : parseRailResolution(resolutionRaw),
  };
}

/**
 * The REAL dashscope-international video-synthesis rail
 * (`wan2.2-t2v-plus`): the video-synthesis endpoint with model +
 * storyboard prompt (+ declared size/duration parameters) submitted
 * with the ASYNC HEADER (`X-DashScope-Async: enable`) — the endpoint
 * answers with the task identity; the rail then polls the REAL task
 * API within a BOUNDED window (bounded attempts at a bounded
 * interval) until a terminal status, fetches the artifact over the
 * SAME injected transport (a REAL fetch, never a fabrication) and
 * returns the delivered bytes for mechanical verification.
 * Credentials are env-materialized at the production binding — never
 * repository credentials.
 */
export function createDashscopeVideogenRail(options: {
  readonly transport: HttpTransport;
  readonly apiKey: string;
  readonly baseUrl?: string;
  /** The declared bounded wall-clock budget per attempt (default 240s). */
  readonly timeoutMs?: number;
  /** The bounded poll interval (default 2s). */
  readonly pollIntervalMs?: number;
  /** Injectable for tests (defaults to a real timed sleep). */
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
}): VideogenRail {
  const baseUrl = options.baseUrl ?? "https://dashscope-intl.aliyuncs.com";
  const timeoutMs = options.timeoutMs ?? 240_000;
  const pollIntervalMs = options.pollIntervalMs ?? 2_000;
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = options.now ?? Date.now;
  const generationUrl = `${baseUrl}/api/v1/services/aigc/video-generation/video-synthesis`;
  const taskUrl = `${baseUrl}/api/v1/tasks`;
  const maxPolls = Math.max(1, Math.ceil(timeoutMs / pollIntervalMs));
  const limits: VideogenAsyncLimits = { maxPolls };

  return {
    railId: "dashscope-videogen-text-to-video",
    mode: "text-to-video",
    async dispatch(input) {
      const startedAt = now();
      const body = buildVideogenRequestBody({
        model: input.model,
        prompt: input.prompt,
        sizeString: input.sizeString,
        duration: input.duration,
      });
      // 1. Submission with the ASYNC header — the rail's contract.
      let response: Response;
      try {
        response = await options.transport(generationUrl, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${options.apiKey}`,
            "Content-Type": "application/json",
            "X-DashScope-Async": "enable",
          },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (error) {
        return {
          kind: "failure",
          category: "transport",
          message: error instanceof Error ? error.message : String(error),
          retryable: true,
          taskId: null,
          polls: 0,
        };
      }
      let responseBody: unknown = null;
      try {
        responseBody = await response.json();
      } catch {
        responseBody = null;
      }
      if (!response.ok) {
        const classified = classifyHttpFailure(response.status);
        return {
          kind: "failure",
          category: classified.category,
          message: extractErrorMessage(responseBody),
          retryable: classified.retryable,
          taskId: null,
          polls: 0,
        };
      }
      if (responseBody === null || typeof responseBody !== "object") {
        return {
          kind: "failure",
          category: "malformed-provider-response",
          message: "provider returned a non-JSON success body",
          retryable: true,
          taskId: null,
          polls: 0,
        };
      }
      const output = (responseBody as { output?: unknown }).output;
      const taskId = (output as { task_id?: unknown })?.task_id;
      if (typeof taskId !== "string" || taskId.length === 0) {
        return {
          kind: "failure",
          category: "empty-output",
          message: "the async rail returned no task id",
          retryable: true,
          taskId: null,
          polls: 0,
        };
      }

      // 2. The bounded async lifecycle: poll the REAL task API,
      //    driving the typed state machine with each observation.
      let state: VideogenAsyncState = advanceVideogenAsyncState(
        { phase: "submitted", polls: 0 },
        { type: "task-issued", taskId },
        limits,
      );
      let lastTerminalBody: unknown = null;
      while (state.phase === "task-issued" || state.phase === "polling") {
        await sleep(pollIntervalMs);
        let pollResponse: Response;
        try {
          pollResponse = await options.transport(`${taskUrl}/${state.taskId}`, {
            method: "GET",
            headers: { Authorization: `Bearer ${options.apiKey}` },
            signal: AbortSignal.timeout(pollIntervalMs * 4),
          });
        } catch (error) {
          state = advanceVideogenAsyncState(
            state,
            {
              type: "poll-failed",
              category: "transport",
              message: error instanceof Error ? error.message : String(error),
              retryable: true,
            },
            limits,
          );
          continue;
        }
        let pollBody: unknown = null;
        try {
          pollBody = await pollResponse.json();
        } catch {
          pollBody = null;
        }
        if (!pollResponse.ok) {
          // A task poll that answers 404 is an honest task-not-found
          // (an invalid/expired task identity) — non-retryable; other
          // HTTP failures map to the provider-failure taxonomy.
          const notFound = pollResponse.status === 404;
          const classified = classifyHttpFailure(pollResponse.status);
          state = advanceVideogenAsyncState(
            state,
            {
              type: "poll-failed",
              category: notFound ? "task-not-found" : classified.category,
              message: notFound
                ? `the task identity was not found: ${state.taskId}`
                : extractErrorMessage(pollBody),
              retryable: notFound ? false : classified.retryable,
            },
            limits,
          );
          continue;
        }
        if (pollBody === null || typeof pollBody !== "object") {
          state = advanceVideogenAsyncState(
            state,
            {
              type: "poll-failed",
              category: "malformed-provider-response",
              message: "task poll returned a non-JSON body",
              retryable: true,
            },
            limits,
          );
          continue;
        }
        const pollOutput = (pollBody as { output?: unknown }).output;
        const status = (pollOutput as { task_status?: unknown })?.task_status;
        const artifactUrl = extractVideoReference(pollOutput);
        const outputRecord = pollOutput as { message?: unknown; code?: unknown };
        state = advanceVideogenAsyncState(
          state,
          {
            type: "poll-observed",
            status: typeof status === "string" ? status : "",
            ...(artifactUrl === null ? {} : { artifactUrl }),
            ...(typeof outputRecord?.message === "string" ? { message: outputRecord.message } : {}),
            ...(typeof outputRecord?.code === "string" ? { code: outputRecord.code } : {}),
          },
          limits,
        );
        if (state.phase === "succeeded") {
          lastTerminalBody = pollBody;
        }
      }

      // 3. The terminal states, honestly.
      if (state.phase === "succeeded") {
        const submissionToTerminalMs = now() - startedAt;
        return fetchVideoArtifact(
          options.transport,
          state,
          lastTerminalBody,
          submissionToTerminalMs,
        );
      }
      if (state.phase === "budget-exhausted") {
        return {
          kind: "failure",
          category: "task-timeout",
          message:
            `the task did not reach a terminal status within the declared bounded budget ` +
            `(${maxPolls} polls at ${pollIntervalMs}ms = ${timeoutMs}ms)`,
          retryable: true,
          taskId: state.taskId,
          polls: state.polls,
        };
      }
      if (state.phase === "failed") {
        return {
          kind: "failure",
          category: state.category,
          message: state.message,
          retryable: state.retryable,
          taskId: state.taskId,
          polls: state.polls,
        };
      }
      // state.phase === "submitted": unreachable by construction (a
      // task identity was issued before the loop began) — fail
      // honestly rather than fabricate a completion.
      return {
        kind: "failure",
        category: "lifecycle-violation",
        message: "the async lifecycle left the submitted phase without a task identity",
        retryable: false,
        taskId: null,
        polls: 0,
      };
    },
  };
}

/** Fetch the terminal artifact over the SAME injected transport (REAL fetch). */
async function fetchVideoArtifact(
  transport: HttpTransport,
  state: { readonly taskId: string; readonly artifactUrl: string; readonly polls: number },
  terminalBody: unknown,
  submissionToTerminalMs: number,
): Promise<VideogenRailOutcome> {
  let response: Response;
  try {
    response = await transport(state.artifactUrl, {
      method: "GET",
      headers: {},
      signal: AbortSignal.timeout(120_000),
    });
  } catch (error) {
    return {
      kind: "failure",
      category: "artifact-fetch",
      message: error instanceof Error ? error.message : String(error),
      retryable: true,
      taskId: state.taskId,
      polls: state.polls,
    };
  }
  if (!response.ok) {
    const classified = classifyHttpFailure(response.status);
    return {
      kind: "failure",
      category: "artifact-fetch",
      message: `video artifact fetch failed (${response.status})`,
      retryable: classified.retryable,
      taskId: state.taskId,
      polls: state.polls,
    };
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length === 0) {
    return {
      kind: "failure",
      category: "empty-output",
      message: "the video artifact payload is empty",
      retryable: true,
      taskId: state.taskId,
      polls: state.polls,
    };
  }
  const container = sniffMp4Container(bytes);
  return {
    kind: "success",
    video: {
      bytes,
      container: container.container,
      majorBrand: container.majorBrand,
      byteLength: bytes.length,
    },
    taskId: state.taskId,
    artifactUrl: state.artifactUrl,
    polls: state.polls,
    submissionToTerminalMs,
    reported: extractRailReportedBounds(terminalBody),
    ...attachUsage(extractUsage(terminalBody)),
  };
}

function attachUsage(usage: LabUsage | undefined): { usage?: LabUsage } {
  return usage === undefined ? {} : { usage };
}

// ---------------------------------------------------------------------------
// The dispatch binding (pre-dispatch discriminations)
// ---------------------------------------------------------------------------

/**
 * Bind the REAL videogen dispatch: route the task to the configured
 * rail, enforcing the pre-dispatch discriminations BEFORE any network
 * effect:
 *   * wrong modality (a task whose kind has no configured rail);
 *   * fixture-digest mismatch (a tampered/swapped materialization);
 *   * blank prompt (the corpus's empty-prompt edge row — the platform
 *     never spends a paid dispatch on a provably-invalid request);
 *   * zero-or-negative duration (the corpus's zero-seconds edge row).
 *
 * The binding applies the platform's bounded retry policy for
 * RETRYABLE provider failures only (rate limits, transient
 * unavailability, transport faults, budget-exhausted generations).
 * Non-retryable failures (invalid request, auth, wrong-modality,
 * digest mismatches, failed provider tasks) are never retried. Every
 * attempt is a REAL dispatch; the measured dispatch latency of the
 * driving execution includes any retry waits (honest end to end).
 */
export interface VideogenRetryPolicy {
  /** Additional attempts after the first (0 = no retry). */
  readonly attempts: number;
  /** The wait between attempts (milliseconds). */
  readonly delayMs: number;
  /** Injectable for tests (defaults to a real timed sleep). */
  readonly sleep?: (ms: number) => Promise<void>;
}

export function createVideogenDispatchBinding(options: {
  readonly rail?: VideogenRail;
  /** Overridable for discrimination tests (defaults to the pure materializer). */
  readonly materialize?: (task: GenerateVideoTask) => MaterializedVideogenInput;
  /** The bounded retry policy (default: no retry — single attempt). */
  readonly retry?: VideogenRetryPolicy;
  readonly transportCalls?: { count: number };
}): (input: {
  readonly executionId: string;
  readonly task: VideogenTask;
  readonly provider: string;
  readonly model: string;
}) => Promise<VideogenRailOutcome> {
  const materialize = options.materialize ?? materializeVideogenInput;
  const calls = options.transportCalls ?? { count: 0 };
  const retry = options.retry ?? { attempts: 0, delayMs: 0 };
  const sleep =
    retry.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  return async (input) => {
    // 1. Wrong-modality discrimination BEFORE any materialization or
    //    network effect: the vocabulary + rail routing is closed.
    const kind = (input.task as { kind?: unknown }).kind;
    if (kind !== "generate-video") {
      return {
        kind: "failure",
        category: "wrong-modality",
        message: `task kind ${String(kind)} is outside the videogen vocabulary`,
        retryable: false,
        taskId: null,
        polls: 0,
      };
    }
    const task = input.task as GenerateVideoTask;
    const plan = deriveVideogenPlan(task, { provider: input.provider, model: input.model });
    const materialized = materialize(task);
    // 2. Fixture-digest discrimination (tampered materialization).
    if (
      materialized.promptDigest !== plan.promptDigest ||
      materialized.promptKey !== plan.promptKey
    ) {
      return {
        kind: "failure",
        category: "fixture-digest-mismatch",
        message: `materialized fixture digest disagrees with the planned digest for fixture ${plan.promptKey}`,
        retryable: false,
        taskId: null,
        polls: 0,
      };
    }
    // 3. Blank-prompt discrimination (never a paid dispatch).
    if (materialized.prompt.trim().length === 0) {
      return {
        kind: "failure",
        category: "invalid-request",
        message: "blank prompt rejected before any paid dispatch",
        retryable: false,
        taskId: null,
        polls: 0,
      };
    }
    // 4. Zero-or-negative-duration discrimination (the corpus's
    //    zero-seconds edge row — never a paid dispatch).
    if (task.seconds !== undefined && task.seconds <= 0) {
      return {
        kind: "failure",
        category: "invalid-request",
        message: `zero-or-negative clip duration (${task.seconds}s) rejected before any paid dispatch`,
        retryable: false,
        taskId: null,
        polls: 0,
      };
    }
    // 5. Rail routing (wrong-modality when the rail is absent).
    const rail = options.rail;
    if (rail === undefined || rail.mode !== "text-to-video") {
      return {
        kind: "failure",
        category: "wrong-modality",
        message: `no rail configured for mode text-to-video (fixture ${materialized.promptKey})`,
        retryable: false,
        taskId: null,
        polls: 0,
      };
    }
    const dispatchInput = {
      model: input.model,
      prompt: materialized.prompt,
      sizeString: materialized.sizeString,
      duration: materialized.duration,
    };
    calls.count += 1;
    let outcome = await rail.dispatch(dispatchInput);
    for (
      let attempt = 0;
      attempt < retry.attempts && outcome.kind === "failure" && outcome.retryable;
      attempt += 1
    ) {
      await sleep(retry.delayMs);
      calls.count += 1;
      outcome = await rail.dispatch(dispatchInput);
    }
    return outcome;
  };
}

// ---------------------------------------------------------------------------
// The platform-side execution driver (mirrors driver.ts for videogen)
// ---------------------------------------------------------------------------

export interface VideogenRunPorts {
  readonly lifecycle: PlatformLifecyclePort;
  readonly dispatch: (input: {
    readonly executionId: string;
    readonly task: VideogenTask;
    readonly provider: string;
    readonly model: string;
  }) => Promise<VideogenRailOutcome>;
  readonly now: () => Date;
}

/** The driver's result (PlatformRunResult shape + videogen facts). */
export interface VideogenRunResult {
  readonly executionId: string;
  readonly terminal: "COMPLETED" | "FAILED";
  readonly criteria: readonly LabVerificationCriterion[];
  readonly usage: LabUsage | null;
  /** Measured wall time of the whole dispatch (incl. any retry waits). */
  readonly dispatchLatencyMs: number | null;
  /** The failure taxonomy category on a FAILED run (else null). */
  readonly failureCategory: string | null;
  /** sha256-16 of the delivered video on success (digest, never payload). */
  readonly videoDigest: string | null;
  readonly videoByteLength: number | null;
  readonly videoContainer: string | null;
  /** The provider task identity issued at submission (task accounting). */
  readonly taskId: string | null;
  /** The poll attempts consumed within the bounded budget. */
  readonly polls: number | null;
  /** Measured submission-to-terminal wall time on success (else null). */
  readonly submissionToTerminalMs: number | null;
  readonly requestDigest: string | null;
}

/**
 * Drive one submitted videogen execution to completion through the
 * platform path. A task whose KIND is outside the videogen vocabulary
 * completes as an honest wrong-modality FAILED run (the platform has
 * no rail for that modality — never a thrown NOT RUN, whose boundary
 * belongs to absent FIXTURES only). A missing fixture aborts BEFORE
 * any lifecycle mutation (NOT RUN — the thrown
 * VideogenFixtureNotMaterializedError); a provider failure completes
 * as FAILED (honest, never completed).
 */
export async function driveVideogenExecution(options: {
  readonly executionId: string;
  readonly task: VideogenTask;
  readonly provider: string;
  readonly model: string;
  readonly ports: VideogenRunPorts;
}): Promise<VideogenRunResult> {
  const { executionId, task, provider, model, ports } = options;

  // 0. Vocabulary check BEFORE plan derivation: a foreign kind has no
  //    materialization (and no route to plan) — it is an honest
  //    wrong-modality failure, driven through the canonical lifecycle
  //    with NO planning decision (nothing was plannable) and NO
  //    network effect.
  const taskKind = (task as { kind?: unknown }).kind;
  if (taskKind !== "generate-video") {
    await ports.lifecycle.transition({
      executionId,
      step: "authorize",
      reason: "val-016-authorize",
    });
    await ports.lifecycle.transition({ executionId, step: "plan", reason: "val-016-plan" });
    await ports.lifecycle.transition({ executionId, step: "queue", reason: "val-016-queue" });
    await ports.lifecycle.transition({ executionId, step: "start", reason: "val-016-start" });
    const outcome: VideogenRailOutcome = {
      kind: "failure",
      category: "wrong-modality",
      message: `task kind ${String(taskKind)} is outside the videogen vocabulary`,
      retryable: false,
      taskId: null,
      polls: 0,
    };
    const criteria = deriveVideogenVerification(task as GenerateVideoTask, outcome);
    await ports.lifecycle.transition({ executionId, step: "verify", reason: "val-016-verify" });
    await ports.lifecycle.complete({
      executionId,
      verdict: "fail",
      criteria,
      reason: "val-016-wrong-modality",
    });
    return {
      executionId,
      terminal: "FAILED",
      criteria,
      usage: null,
      dispatchLatencyMs: null,
      failureCategory: "wrong-modality",
      videoDigest: null,
      videoByteLength: null,
      videoContainer: null,
      taskId: null,
      polls: null,
      submissionToTerminalMs: null,
      requestDigest: null,
    };
  }

  // 1. The dispatch plan is derived BEFORE any lifecycle mutation: an
  //    absent fixture aborts here (NOT RUN — nothing was driven).
  const plan = deriveVideogenPlan(task as GenerateVideoTask, { provider, model });

  // 2. Canonical lifecycle up to RUNNING.
  await ports.lifecycle.transition({ executionId, step: "authorize", reason: "val-016-authorize" });
  await ports.lifecycle.transition({ executionId, step: "plan", reason: "val-016-plan" });
  // 3. Durable planning decision (route facts) — intent before effect.
  await ports.lifecycle.recordPlanningDecision({ executionId, route: plan.route });
  await ports.lifecycle.transition({ executionId, step: "queue", reason: "val-016-queue" });
  await ports.lifecycle.transition({ executionId, step: "start", reason: "val-016-start" });

  // 4. The REAL dispatch through the injected port (measured).
  const dispatchStartedAt = ports.now();
  const outcome = await ports.dispatch({ executionId, task, provider, model });
  const dispatchLatencyMs = ports.now().getTime() - dispatchStartedAt.getTime();

  // 5. Mechanical verification derivation.
  const criteria = deriveVideogenVerification(task as GenerateVideoTask, outcome);
  const anyFail = criteria.some((criterion) => criterion.status === "FAIL");
  const verdict: "pass" | "fail" = anyFail ? "fail" : "pass";

  await ports.lifecycle.transition({ executionId, step: "verify", reason: "val-016-verify" });
  await ports.lifecycle.complete({
    executionId,
    verdict,
    criteria,
    reason: anyFail ? "val-016-mechanical-verification-failed" : "val-016-verified",
  });

  return {
    executionId,
    terminal: anyFail ? "FAILED" : "COMPLETED",
    criteria,
    usage: outcome.kind === "success" ? (outcome.usage ?? null) : null,
    dispatchLatencyMs,
    failureCategory: outcome.kind === "failure" ? outcome.category : null,
    videoDigest: outcome.kind === "success" ? mediaDigest(outcome.video.bytes) : null,
    videoByteLength: outcome.kind === "success" ? outcome.video.byteLength : null,
    videoContainer: outcome.kind === "success" ? outcome.video.container : null,
    taskId: outcome.taskId,
    polls: outcome.polls,
    submissionToTerminalMs: outcome.kind === "success" ? outcome.submissionToTerminalMs : null,
    requestDigest: plan.requestDigest,
  };
}
