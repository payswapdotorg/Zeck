/**
 * The image-generation platform slice (VAL-015).
 *
 * The PLATFORM (Zeck's operators/runtime) — never the application —
 * derives, from a customer-submitted image synthesis task:
 *   1. the imagegen dispatch plan (mode, seeded prompt or
 *      image+instruction edit, fixture digests and route facts),
 *   2. the REAL provider dispatch over an injected HTTP transport
 *      (the dashscope-international multimodal-generation rail for
 *      qwen-image — env-credential gated, never repository
 *      credentials), and
 *   3. the mechanical verification criteria a completion is judged by
 *      (raster container validity, declared dimensions, non-empty
 *      payload, digest capture — plus pixel-region change bounds
 *      against the synthetic source for transformations; never
 *      aesthetic judgment).
 *
 * The derivations are PURE: no network, no environment, no randomness.
 * The rails are REAL but transport-injected (the production binding
 * injects the global fetch; unit and discrimination tests inject
 * controlled fakes). Honesty invariants (by construction):
 *   * a fixture (prompt, edit, or source image) absent from the
 *     materialization is a thrown NOT-RUN signal BEFORE any lifecycle
 *     mutation (never a silent empty dispatch);
 *   * a materialization whose digest disagrees with the plan is
 *     rejected BEFORE any network effect (fixture-digest-mismatch);
 *   * a blank prompt is rejected BEFORE any paid dispatch (the
 *     corpus's own empty-prompt expected-FAILED edge row);
 *   * a task whose mode has no configured rail — or whose kind is
 *     outside the imagegen vocabulary — is rejected BEFORE any
 *     network effect (wrong-modality);
 *   * a provider failure (including genuinely corrupted source media
 *     the provider rejects) FAILS the execution — never completes it;
 *   * a malformed raster payload FAILS the mechanical container
 *     criterion — never a fabricated completion;
 *   * dispatch timing and usage are measured, never estimated;
 *   * the planning decision is recorded BEFORE the dispatch;
 *   * evidence carries payload DIGESTS, never payloads.
 */

import {
  type GenerationPromptFixture,
  generationPromptFixture,
  type ImageEditFixture,
  imageEditFixture,
  imageFixture,
  mediaDigest,
} from "../apps/shared/media";
import type { LabRoute, LabUsage, LabVerificationCriterion } from "./derive";
import type { PlatformLifecyclePort } from "./driver";
import {
  analyzeChangedRegion,
  changedCellsIntersectRegion,
  decodePngToRgb,
  dimensionsAreSane,
  parseRasterDimensions,
  regionToNormalized,
  sniffRasterContainer,
} from "./imagegen-raster";

// ---------------------------------------------------------------------------
// Task vocabulary (the pinned VAL-015 slice)
// ---------------------------------------------------------------------------

/** Text-to-image: a seeded prompt fixture (+ optional declared size). */
export interface GenerateImageTask {
  readonly kind: "generate-image";
  /**
   * The seeded prompt fixture key (materialized deterministically
   * platform-side). The empty string is the corpus's own empty-prompt
   * edge row — materialized as the empty prompt and rejected BEFORE
   * any paid dispatch (the honest expected-FAILED row).
   */
  readonly prompt: string;
  readonly width?: number;
  readonly height?: number;
}

/** Image-plus-instruction editing: a synthetic source + a seeded edit. */
export interface TransformImageTask {
  readonly kind: "transform-image";
  /** The deterministic synthetic source-image fixture key. */
  readonly source: string;
  /** The seeded edit-instruction fixture key (binds its own source). */
  readonly edit: string;
}

export type ImagegenTask = GenerateImageTask | TransformImageTask;

/** The two dispatch modes the imagegen rails serve. */
export type ImagegenMode = "text-to-image" | "image-to-image";

// ---------------------------------------------------------------------------
// Materialization (pure, deterministic — the VAL-003 recipes)
// ---------------------------------------------------------------------------

/** One task's materialized dispatch inputs and ground truth. */
export interface MaterializedImagegenInput {
  readonly mode: ImagegenMode;
  /** The exact prompt (generation) or instruction (edit) text dispatched. */
  readonly prompt: string;
  readonly promptKey: string;
  /** sha256-16 of the prompt text bytes (request-level reproducibility). */
  readonly promptDigest: string;
  /** Fixture provenance (recorded in evidence; never an aesthetic oracle). */
  readonly annotation: string;
  /** Generation rows: the task's declared raster size (when present). */
  readonly size: { readonly width: number; readonly height: number } | null;
  /** Transform rows: the deterministic synthetic source image. */
  readonly sourceKey: string | null;
  readonly sourceBytes: Buffer | null;
  readonly sourceDigest: string | null;
  /**
   * Transform rows: the instruction's declared TARGET REGION in source
   * pixel coordinates — the fixture's own mechanical ground truth.
   */
  readonly targetRegion: readonly [number, number, number, number] | null;
}

/** A fixture (or task vocabulary) absent from the materialization is a NOT RUN boundary. */
export class ImagegenFixtureNotMaterializedError extends Error {
  constructor(key: string) {
    super(`imagegen fixture not materialized (NOT RUN boundary): ${key}`);
    this.name = "ImagegenFixtureNotMaterializedError";
  }
}

/** Materialize one task's dispatch inputs deterministically (no environment). */
export function materializeImagegenInput(task: ImagegenTask): MaterializedImagegenInput {
  if (task.kind === "generate-image") {
    let fixture: GenerationPromptFixture;
    try {
      fixture = generationPromptFixture(task.prompt);
    } catch {
      throw new ImagegenFixtureNotMaterializedError(task.prompt);
    }
    const promptBytes = Buffer.from(fixture.prompt, "utf8");
    const size =
      task.width !== undefined && task.height !== undefined
        ? { width: task.width, height: task.height }
        : null;
    return {
      mode: "text-to-image",
      prompt: fixture.prompt,
      promptKey: fixture.key,
      promptDigest: mediaDigest(promptBytes),
      annotation: fixture.annotation,
      size,
      sourceKey: null,
      sourceBytes: null,
      sourceDigest: null,
      targetRegion: null,
    };
  }
  if (task.kind === "transform-image") {
    let edit: ImageEditFixture;
    try {
      edit = imageEditFixture(task.edit);
    } catch {
      throw new ImagegenFixtureNotMaterializedError(task.edit);
    }
    let image: { readonly png: Buffer; readonly annotation: string };
    try {
      image = imageFixture(edit.source);
    } catch {
      throw new ImagegenFixtureNotMaterializedError(edit.source);
    }
    const instructionBytes = Buffer.from(edit.instruction, "utf8");
    return {
      mode: "image-to-image",
      prompt: edit.instruction,
      promptKey: edit.key,
      promptDigest: mediaDigest(instructionBytes),
      annotation: edit.annotation,
      size: null,
      sourceKey: edit.source,
      sourceBytes: image.png,
      sourceDigest: mediaDigest(image.png),
      targetRegion: edit.targetRegion,
    };
  }
  // A task kind outside the imagegen vocabulary: honestly not
  // materializable by this slice (the binding reports wrong-modality).
  throw new ImagegenFixtureNotMaterializedError(String((task as { kind?: unknown }).kind));
}

// ---------------------------------------------------------------------------
// Dispatch-plan derivation (pure)
// ---------------------------------------------------------------------------

/** The canonical rail request body (byte-stable for request digests). */
export function buildImagegenRequestBody(input: {
  readonly model: string;
  readonly prompt: string;
  readonly sourceDataUri?: string;
  readonly size?: { readonly width: number; readonly height: number };
}): Readonly<Record<string, unknown>> {
  // 2026-09-12 Lead live re-pin: the multimodal-generation endpoint now
  // requires the input.messages content shape (the earlier input.prompt
  // shape returns 400 InvalidParameter "Field required: input.messages" —
  // observed when the operator lifted the image-generation quota). The
  // prompt rides as a text part; an edit's source image rides as an image
  // content part (the same part grammar the ASR rail uses for audio).
  const content: Record<string, string>[] = [];
  if (input.sourceDataUri !== undefined) {
    content.push({ image: input.sourceDataUri });
  }
  content.push({ text: input.prompt });
  const parameters: Record<string, unknown> = { n: 1 };
  if (input.size !== undefined) {
    parameters.size = `${input.size.width}*${input.size.height}`;
  }
  return {
    model: input.model,
    input: { messages: [{ role: "user", content }] },
    parameters,
  };
}

/** Encode image bytes as the provider data URI (never in evidence). */
export function toImageDataUri(bytes: Buffer): string {
  return `data:image/png;base64,${bytes.toString("base64")}`;
}

/** Route facts + request facts recorded on the execution ledger. */
export interface ImagegenDispatchPlan {
  readonly route: LabRoute;
  readonly mode: ImagegenMode;
  readonly prompt: string;
  readonly promptKey: string;
  readonly promptDigest: string;
  readonly sourceKey: string | null;
  readonly sourceDigest: string | null;
  readonly targetRegion: readonly [number, number, number, number] | null;
  readonly size: { readonly width: number; readonly height: number } | null;
  /**
   * sha256-16 over the canonical serialized rail request body — the
   * request-level reproducibility reference (the same task always
   * derives the same request, so the same request digest).
   */
  readonly requestDigest: string;
}

/**
 * Derive the dispatch plan for one imagegen task. An absent fixture
 * throws (NOT RUN), never silently degrades; the request digest makes
 * every dispatch reproducible at the request level.
 */
export function deriveImagegenPlan(
  task: ImagegenTask,
  options: { readonly provider: string; readonly model: string },
): ImagegenDispatchPlan {
  const materialized = materializeImagegenInput(task);
  const sourceDataUri =
    materialized.sourceBytes !== null ? toImageDataUri(materialized.sourceBytes) : undefined;
  const body = buildImagegenRequestBody({
    model: options.model,
    prompt: materialized.prompt,
    sourceDataUri,
    size: materialized.size ?? undefined,
  });
  return {
    route: {
      provider: options.provider,
      model: options.model,
      strategyClass: "single-shot-imagegen",
    },
    mode: materialized.mode,
    prompt: materialized.prompt,
    promptKey: materialized.promptKey,
    promptDigest: materialized.promptDigest,
    sourceKey: materialized.sourceKey,
    sourceDigest: materialized.sourceDigest,
    targetRegion: materialized.targetRegion,
    size: materialized.size,
    requestDigest: mediaDigest(Buffer.from(JSON.stringify(body), "utf8")),
  };
}

// ---------------------------------------------------------------------------
// Mechanical verification derivation (pure)
// ---------------------------------------------------------------------------

/** One successfully delivered raster from a rail. */
export interface ImagegenRailImage {
  readonly bytes: Buffer;
  readonly mimeType: "image/png" | "image/jpeg" | "image/unknown";
  /** Declared dimensions parsed from the raster's own container header. */
  readonly width: number | null;
  readonly height: number | null;
}

/** The rail dispatch outcome: a delivered raster or an honest failure. */
export type ImagegenRailOutcome =
  | { readonly kind: "success"; readonly image: ImagegenRailImage; readonly usage?: LabUsage }
  | {
      readonly kind: "failure";
      readonly category: string;
      readonly message: string;
      readonly retryable: boolean;
    };

/**
 * Derive the verification criteria for one imagegen outcome.
 *
 * The oracle floor: a provider failure fails ANY run mechanically.
 * Generated outputs are verified mechanically ONLY (valid raster
 * container, declared dimensions, non-empty payload, digest capture) —
 * never aesthetic judgment. Transformed outputs are additionally
 * verified against the edit fixture's own declared target region
 * (pixel-region change bounds derived from the deterministic synthetic
 * source): a real change must be present and the changed region must
 * intersect the target region.
 */
export function deriveImagegenVerification(
  task: ImagegenTask,
  outcome: ImagegenRailOutcome,
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
          `message:${truncate(outcome.message, 160)}`,
        ],
      },
    ];
  }
  const image = outcome.image;
  const digest = mediaDigest(image.bytes);
  const container = sniffRasterContainer(image.bytes);
  const dims = parseRasterDimensions(image.bytes);
  const materialized = materializeImagegenInput(task);
  const criteria: LabVerificationCriterion[] = [];

  // 1. Valid raster container (PNG/JPEG magic bytes — never by extension).
  criteria.push({
    criterionId: "raster-container",
    strategy: "deterministic",
    status: container !== "unknown" ? "PASS" : "FAIL",
    evidence: [
      `container:${container}`,
      `bytes:${image.bytes.length}`,
      `digest:${digest}`,
      `fixture:${materialized.promptKey}`,
    ],
  });

  // 2. Declared dimensions: parseable from the container, mechanically
  //    sane, and equal to the task's declared size when the task
  //    declares one (the request must be honored, not approximated).
  let dimensionsPass = dims !== null && dimensionsAreSane(dims);
  const dimensionEvidence = [
    `parsed:${dims === null ? "none" : `${dims.width}x${dims.height}`}`,
    `digest:${digest}`,
  ];
  if (task.kind === "generate-image" && task.width !== undefined && task.height !== undefined) {
    dimensionEvidence.push(`requested:${task.width}x${task.height}`);
    if (dims === null || dims.width !== task.width || dims.height !== task.height) {
      dimensionsPass = false;
    }
  }
  criteria.push({
    criterionId: "dimensions-declared",
    strategy: "deterministic",
    status: dimensionsPass ? "PASS" : "FAIL",
    evidence: dimensionEvidence,
  });

  // 3. Non-empty payload.
  criteria.push({
    criterionId: "payload-nonempty",
    strategy: "deterministic",
    status: image.bytes.length > 0 ? "PASS" : "FAIL",
    evidence: [`bytes:${image.bytes.length}`, `digest:${digest}`],
  });

  // 4. Digest capture (the sha256 reference recorded on the ledger —
  //    payload DIGESTS in evidence, never payloads).
  criteria.push({
    criterionId: "digest-captured",
    strategy: "deterministic",
    status: image.bytes.length > 0 ? "PASS" : "FAIL",
    evidence: [`digest:${digest}`, "algorithm:sha256", `fixture:${materialized.promptKey}`],
  });

  // 5-6. Transformations only: pixel-region change bounds against the
  //     deterministic synthetic source (the fixture's own ground truth).
  if (task.kind === "transform-image" && materialized.targetRegion !== null) {
    const targetRegion = materialized.targetRegion;
    const sourceRaster =
      materialized.sourceBytes !== null ? decodePngToRgb(materialized.sourceBytes) : null;
    const outputRaster = container === "png" ? decodePngToRgb(image.bytes) : null;
    if (sourceRaster === null || outputRaster === null) {
      // Honestly not pixel-comparable (e.g. a JPEG output has no
      // lossless decoder here): the change-bound criteria FAIL with
      // the mechanical reason recorded — never a fabricated pass.
      const reason =
        sourceRaster === null ? "source-not-pixel-decodable" : "output-not-pixel-decodable";
      criteria.push({
        criterionId: "change-present",
        strategy: "deterministic",
        status: "FAIL",
        evidence: [reason, `container:${container}`, `digest:${digest}`],
      });
      criteria.push({
        criterionId: "changed-region-intersects-target",
        strategy: "deterministic",
        status: "FAIL",
        evidence: [reason, `target:[${targetRegion.join(",")}]`, `digest:${digest}`],
      });
      return criteria;
    }
    const analysis = analyzeChangedRegion(sourceRaster, outputRaster);
    criteria.push({
      criterionId: "change-present",
      strategy: "deterministic",
      status: analysis.changedCellCount > 0 ? "PASS" : "FAIL",
      evidence: [
        `changedCells:${analysis.changedCellCount}`,
        `changedFraction:${analysis.changedFraction.toFixed(4)}`,
        analysis.changedBBox === null
          ? "changedBBox:none"
          : `changedBBox:[${analysis.changedBBox.map((v) => v.toFixed(4)).join(",")}]`,
        `digest:${digest}`,
        `sourceDigest:${materialized.sourceDigest}`,
      ],
    });
    const normalizedTarget = regionToNormalized(
      targetRegion,
      sourceRaster.width,
      sourceRaster.height,
    );
    const intersects = changedCellsIntersectRegion(analysis, normalizedTarget);
    criteria.push({
      criterionId: "changed-region-intersects-target",
      strategy: "deterministic",
      status: intersects ? "PASS" : "FAIL",
      evidence: [
        `target:[${targetRegion.join(",")}]`,
        analysis.changedBBox === null
          ? "changedBBox:none"
          : `changedBBox:[${analysis.changedBBox.map((v) => v.toFixed(4)).join(",")}]`,
        `intersection:${String(intersects)}`,
        `changedFraction:${analysis.changedFraction.toFixed(4)}`,
        `digest:${digest}`,
        `sourceDigest:${materialized.sourceDigest}`,
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

/** A image-generation provider rail: one mode, one REAL endpoint. */
export interface ImagegenRail {
  readonly railId: string;
  readonly mode: ImagegenMode;
  dispatch(input: {
    readonly model: string;
    readonly prompt: string;
    /** The synthetic source image as a data URI (image-to-image only). */
    readonly sourceDataUri?: string;
    readonly size?: { readonly width: number; readonly height: number };
  }): Promise<ImagegenRailOutcome>;
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

/** Collect every image reference string a dashscope output shape carries. */
function extractImageReferences(output: unknown): string[] {
  const references: string[] = [];
  const record = output as {
    choices?: {
      message?: { content?: unknown };
    }[];
    results?: readonly Record<string, unknown>[];
    image?: unknown;
    message?: { content?: unknown };
  };
  const collectContent = (content: unknown): void => {
    if (typeof content === "string") {
      if (content.startsWith("data:") || content.startsWith("http")) {
        references.push(content);
      }
      return;
    }
    if (Array.isArray(content)) {
      for (const part of content) {
        if (typeof part === "string") {
          collectContent(part);
        } else if (part !== null && typeof part === "object") {
          const image = (part as { image?: unknown }).image;
          if (typeof image === "string" && image.length > 0) {
            references.push(image);
          }
        }
      }
    }
  };
  for (const choice of record?.choices ?? []) {
    collectContent(choice?.message?.content);
  }
  collectContent(record?.message?.content);
  for (const result of record?.results ?? []) {
    for (const field of ["url", "b64_json", "image"] as const) {
      const value = result?.[field];
      if (typeof value === "string" && value.length > 0) {
        references.push(value);
      }
    }
  }
  if (typeof record?.image === "string" && record.image.length > 0) {
    references.push(record.image);
  }
  return references;
}

function extractUsage(body: unknown): LabUsage | undefined {
  const usage = (body as { usage?: Record<string, unknown> })?.usage;
  if (usage === undefined) {
    return undefined;
  }
  const inputTokens = readNumber(usage.input_tokens) ?? 0;
  const outputTokens =
    readNumber(usage.image_count) ??
    readNumber(usage.imageCount) ??
    readNumber(usage.output_tokens) ??
    0;
  return { inputTokens, outputTokens };
}

function readNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * The REAL dashscope-international multimodal-generation rail
 * (qwen-image): the multimodal-generation endpoint with model +
 * prompt (+ source image data-URI for edits), the image returned as
 * data/base64 (URL returns are fetched through the SAME injected
 * transport — still a REAL fetch, never a fabrication). When the
 * endpoint answers with a task id, the rail polls the REAL task API
 * within a bounded window. Credentials are env-materialized at the
 * production binding — never repository credentials.
 */
export function createDashscopeImagegenRail(options: {
  readonly transport: HttpTransport;
  readonly apiKey: string;
  readonly mode: ImagegenMode;
  readonly baseUrl?: string;
  readonly timeoutMs?: number;
  readonly pollIntervalMs?: number;
  /** Injectable for tests (defaults to a real timed sleep). */
  readonly sleep?: (ms: number) => Promise<void>;
}): ImagegenRail {
  const baseUrl = options.baseUrl ?? "https://dashscope-intl.aliyuncs.com";
  const timeoutMs = options.timeoutMs ?? 240_000;
  const pollIntervalMs = options.pollIntervalMs ?? 2_000;
  const sleep =
    options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const generationUrl = `${baseUrl}/api/v1/services/aigc/multimodal-generation/generation`;
  const taskUrl = `${baseUrl}/api/v1/tasks`;

  return {
    railId: `dashscope-imagegen-${options.mode}`,
    mode: options.mode,
    async dispatch(input) {
      const sourceDataUri = options.mode === "image-to-image" ? input.sourceDataUri : undefined;
      if (options.mode === "image-to-image" && sourceDataUri === undefined) {
        return {
          kind: "failure",
          category: "invalid-request",
          message: "image-to-image dispatch without a source image",
          retryable: false,
        };
      }
      if (options.mode === "text-to-image" && input.sourceDataUri !== undefined) {
        return {
          kind: "failure",
          category: "invalid-request",
          message: "text-to-image dispatch must not carry a source image",
          retryable: false,
        };
      }
      const body = buildImagegenRequestBody({
        model: input.model,
        prompt: input.prompt,
        sourceDataUri,
        size: input.size,
      });
      let response: Response;
      try {
        response = await options.transport(generationUrl, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${options.apiKey}`,
            "Content-Type": "application/json",
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
        };
      }
      if (responseBody === null || typeof responseBody !== "object") {
        return {
          kind: "failure",
          category: "malformed-provider-response",
          message: "provider returned a non-JSON success body",
          retryable: true,
        };
      }
      const output = (responseBody as { output?: unknown }).output;
      const usage = extractUsage(responseBody);

      // Prefer an inline result; otherwise poll the REAL task API when
      // the endpoint answers with a task id (bounded window).
      const inline = extractImageReferences(output);
      if (inline.length > 0) {
        return resolveImageReference(options.transport, inline[0] as string, usage);
      }
      const taskId = (output as { task_id?: unknown })?.task_id;
      if (typeof taskId === "string" && taskId.length > 0) {
        return pollTaskToCompletion({
          transport: options.transport,
          apiKey: options.apiKey,
          taskUrl,
          taskId,
          timeoutMs,
          pollIntervalMs,
          sleep,
        });
      }
      return {
        kind: "failure",
        category: "empty-output",
        message: "provider returned no image payload",
        retryable: true,
      };
    },
  };
}

async function pollTaskToCompletion(options: {
  readonly transport: HttpTransport;
  readonly apiKey: string;
  readonly taskUrl: string;
  readonly taskId: string;
  readonly timeoutMs: number;
  readonly pollIntervalMs: number;
  readonly sleep: (ms: number) => Promise<void>;
}): Promise<ImagegenRailOutcome> {
  const maxPolls = Math.max(1, Math.ceil(options.timeoutMs / options.pollIntervalMs));
  for (let poll = 0; poll < maxPolls; poll += 1) {
    await options.sleep(options.pollIntervalMs);
    let response: Response;
    try {
      response = await options.transport(`${options.taskUrl}/${options.taskId}`, {
        method: "GET",
        headers: { Authorization: `Bearer ${options.apiKey}` },
        signal: AbortSignal.timeout(options.pollIntervalMs * 4),
      });
    } catch (error) {
      return {
        kind: "failure",
        category: "transport",
        message: error instanceof Error ? error.message : String(error),
        retryable: true,
      };
    }
    let body: unknown = null;
    try {
      body = await response.json();
    } catch {
      body = null;
    }
    if (!response.ok) {
      const classified = classifyHttpFailure(response.status);
      return {
        kind: "failure",
        category: classified.category,
        message: extractErrorMessage(body),
        retryable: classified.retryable,
      };
    }
    if (body === null || typeof body !== "object") {
      return {
        kind: "failure",
        category: "malformed-provider-response",
        message: "task poll returned a non-JSON body",
        retryable: true,
      };
    }
    const output = (body as { output?: unknown }).output;
    const status = (output as { task_status?: unknown })?.task_status;
    if (status === "SUCCEEDED") {
      const references = extractImageReferences(output);
      if (references.length === 0) {
        return {
          kind: "failure",
          category: "empty-output",
          message: "task succeeded but returned no image payload",
          retryable: true,
        };
      }
      return resolveImageReference(options.transport, references[0] as string, extractUsage(body));
    }
    if (status === "FAILED" || status === "CANCELED" || status === "UNKNOWN") {
      const outputRecord = output as { message?: unknown; code?: unknown };
      return {
        kind: "failure",
        category: "provider-task-failed",
        message:
          typeof outputRecord?.message === "string"
            ? outputRecord.message
            : typeof outputRecord?.code === "string"
              ? outputRecord.code
              : `task ended in ${String(status)}`,
        retryable: false,
      };
    }
    // PENDING / RUNNING / anything else: keep polling within the bound.
  }
  return {
    kind: "failure",
    category: "task-timeout",
    message: "task did not reach a terminal status within the bounded poll window",
    retryable: true,
  };
}

/** Resolve one image reference (data/base64 or URL) to raster bytes. */
async function resolveImageReference(
  transport: HttpTransport,
  reference: string,
  usage: LabUsage | undefined,
): Promise<ImagegenRailOutcome> {
  let bytes: Buffer;
  if (reference.startsWith("data:")) {
    const commaIndex = reference.indexOf(",");
    if (commaIndex < 0) {
      return {
        kind: "failure",
        category: "malformed-provider-response",
        message: "image data URI without a payload",
        retryable: false,
      };
    }
    bytes = Buffer.from(reference.slice(commaIndex + 1), "base64");
  } else if (reference.startsWith("http://") || reference.startsWith("https://")) {
    let response: Response;
    try {
      response = await transport(reference, {
        method: "GET",
        headers: {},
        signal: AbortSignal.timeout(60_000),
      });
    } catch (error) {
      return {
        kind: "failure",
        category: "transport",
        message: error instanceof Error ? error.message : String(error),
        retryable: true,
      };
    }
    if (!response.ok) {
      const classified = classifyHttpFailure(response.status);
      return {
        kind: "failure",
        category: classified.category,
        message: `image fetch failed (${response.status})`,
        retryable: classified.retryable,
      };
    }
    bytes = Buffer.from(await response.arrayBuffer());
  } else {
    bytes = Buffer.from(reference, "base64");
  }
  if (bytes.length === 0) {
    return {
      kind: "failure",
      category: "empty-output",
      message: "provider returned an empty image payload",
      retryable: true,
    };
  }
  const container = sniffRasterContainer(bytes);
  const mimeType: ImagegenRailImage["mimeType"] =
    container === "png" ? "image/png" : container === "jpeg" ? "image/jpeg" : "image/unknown";
  const dims = parseRasterDimensions(bytes);
  return {
    kind: "success",
    image: {
      bytes,
      mimeType,
      width: dims === null ? null : dims.width,
      height: dims === null ? null : dims.height,
    },
    ...(usage === undefined ? {} : { usage }),
  };
}

// ---------------------------------------------------------------------------
// The dispatch binding (mode routing + pre-dispatch discriminations)
// ---------------------------------------------------------------------------

/**
 * Bind the REAL imagegen dispatch: route by mode to the configured
 * rails, enforcing the pre-dispatch discriminations BEFORE any network
 * effect:
 *   * wrong modality (a task whose kind/mode has no configured rail);
 *   * fixture-digest mismatch (a tampered/swapped materialization);
 *   * blank prompt (the corpus's empty-prompt edge row — the platform
 *     never spends a paid dispatch on a provably-invalid request);
 *   * edit-fixture source mismatch (a task whose declared source
 *     disagrees with the edit fixture's own bound source).
 *
 * The binding applies the platform's bounded retry policy for
 * RETRYABLE provider failures only (rate limits, transient
 * unavailability, transport faults). Non-retryable failures (invalid
 * request — e.g. genuinely corrupted source media — auth,
 * wrong-modality, digest mismatches) are never retried. Every attempt
 * is a REAL dispatch; the measured dispatch latency of the driving
 * execution includes any retry waits (honest end to end).
 */
export interface ImagegenRetryPolicy {
  /** Additional attempts after the first (0 = no retry). */
  readonly attempts: number;
  /** The wait between attempts (milliseconds). */
  readonly delayMs: number;
  /** Injectable for tests (defaults to a real timed sleep). */
  readonly sleep?: (ms: number) => Promise<void>;
}

export function createImagegenDispatchBinding(options: {
  readonly generation?: ImagegenRail;
  readonly transformation?: ImagegenRail;
  /** Overridable for discrimination tests (defaults to the pure materializer). */
  readonly materialize?: (task: ImagegenTask) => MaterializedImagegenInput;
  /** The bounded retry policy (default: no retry — single attempt). */
  readonly retry?: ImagegenRetryPolicy;
  readonly transportCalls?: { count: number };
}): (input: {
  readonly executionId: string;
  readonly task: ImagegenTask;
  readonly provider: string;
  readonly model: string;
}) => Promise<ImagegenRailOutcome> {
  const materialize = options.materialize ?? materializeImagegenInput;
  const calls = options.transportCalls ?? { count: 0 };
  const retry = options.retry ?? { attempts: 0, delayMs: 0 };
  const sleep =
    retry.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  return async (input) => {
    // 1. Wrong-modality discrimination BEFORE any materialization or
    //    network effect: the vocabulary + rail routing is closed.
    const kind = (input.task as { kind?: unknown }).kind;
    if (kind !== "generate-image" && kind !== "transform-image") {
      return {
        kind: "failure",
        category: "wrong-modality",
        message: `task kind ${String(kind)} is outside the imagegen vocabulary`,
        retryable: false,
      };
    }
    const plan = deriveImagegenPlan(input.task, { provider: input.provider, model: input.model });
    const materialized = materialize(input.task);
    // 2. Fixture-digest discrimination (tampered materialization).
    if (
      materialized.promptDigest !== plan.promptDigest ||
      materialized.promptKey !== plan.promptKey ||
      (plan.sourceDigest !== null && materialized.sourceDigest !== plan.sourceDigest) ||
      (plan.sourceKey !== null && materialized.sourceKey !== plan.sourceKey)
    ) {
      return {
        kind: "failure",
        category: "fixture-digest-mismatch",
        message: `materialized fixture digest disagrees with the planned digest for fixture ${plan.promptKey}`,
        retryable: false,
      };
    }
    // 3. Blank-prompt discrimination (never a paid dispatch).
    if (materialized.prompt.trim().length === 0) {
      return {
        kind: "failure",
        category: "invalid-request",
        message: "blank prompt rejected before any paid dispatch",
        retryable: false,
      };
    }
    // 4. Edit-fixture source consistency (the task's declared source
    //    must be the edit fixture's own bound source).
    if (input.task.kind === "transform-image" && materialized.sourceKey !== input.task.source) {
      return {
        kind: "failure",
        category: "edit-fixture-source-mismatch",
        message: `task source ${input.task.source} disagrees with the edit fixture's bound source ${String(materialized.sourceKey)}`,
        retryable: false,
      };
    }
    // 5. Mode routing (wrong-modality when the rail is absent or
    //    mode-mismatched).
    const rail =
      materialized.mode === "text-to-image" ? options.generation : options.transformation;
    if (rail === undefined || rail.mode !== materialized.mode) {
      return {
        kind: "failure",
        category: "wrong-modality",
        message: `no rail configured for mode ${materialized.mode} (fixture ${materialized.promptKey})`,
        retryable: false,
      };
    }
    const dispatchInput = {
      model: input.model,
      prompt: materialized.prompt,
      ...(materialized.sourceBytes !== null
        ? { sourceDataUri: toImageDataUri(materialized.sourceBytes) }
        : {}),
      ...(materialized.size !== null ? { size: materialized.size } : {}),
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
// The platform-side execution driver (mirrors driver.ts for imagegen)
// ---------------------------------------------------------------------------

export interface ImagegenRunPorts {
  readonly lifecycle: PlatformLifecyclePort;
  readonly dispatch: (input: {
    readonly executionId: string;
    readonly task: ImagegenTask;
    readonly provider: string;
    readonly model: string;
  }) => Promise<ImagegenRailOutcome>;
  readonly now: () => Date;
}

/** The driver's result (PlatformRunResult shape + imagegen facts). */
export interface ImagegenRunResult {
  readonly executionId: string;
  readonly terminal: "COMPLETED" | "FAILED";
  readonly criteria: readonly LabVerificationCriterion[];
  readonly usage: LabUsage | null;
  readonly dispatchLatencyMs: number | null;
  /** sha256-16 of the delivered raster on success (digest, never payload). */
  readonly imageDigest: string | null;
  readonly imageDimensions: { readonly width: number; readonly height: number } | null;
  readonly requestDigest: string | null;
}

/**
 * Drive one submitted imagegen execution to completion through the
 * platform path. A missing fixture aborts BEFORE any lifecycle mutation
 * (NOT RUN — the thrown ImagegenFixtureNotMaterializedError); a
 * provider failure completes as FAILED (honest, never completed).
 */
export async function driveImagegenExecution(options: {
  readonly executionId: string;
  readonly task: ImagegenTask;
  readonly provider: string;
  readonly model: string;
  readonly ports: ImagegenRunPorts;
}): Promise<ImagegenRunResult> {
  const { executionId, task, provider, model, ports } = options;

  // 1. The dispatch plan is derived BEFORE any lifecycle mutation: an
  //    absent fixture aborts here (NOT RUN — nothing was driven).
  const plan = deriveImagegenPlan(task, { provider, model });

  // 2. Canonical lifecycle up to RUNNING.
  await ports.lifecycle.transition({ executionId, step: "authorize", reason: "val-015-authorize" });
  await ports.lifecycle.transition({ executionId, step: "plan", reason: "val-015-plan" });
  // 3. Durable planning decision (route facts) — intent before effect.
  await ports.lifecycle.recordPlanningDecision({ executionId, route: plan.route });
  await ports.lifecycle.transition({ executionId, step: "queue", reason: "val-015-queue" });
  await ports.lifecycle.transition({ executionId, step: "start", reason: "val-015-start" });

  // 4. The REAL dispatch through the injected port (measured).
  const dispatchStartedAt = ports.now();
  const outcome = await ports.dispatch({ executionId, task, provider, model });
  const dispatchLatencyMs = ports.now().getTime() - dispatchStartedAt.getTime();

  // 5. Mechanical verification derivation.
  const criteria = deriveImagegenVerification(task, outcome);
  const anyFail = criteria.some((criterion) => criterion.status === "FAIL");
  const verdict: "pass" | "fail" = anyFail ? "fail" : "pass";

  await ports.lifecycle.transition({ executionId, step: "verify", reason: "val-015-verify" });
  await ports.lifecycle.complete({
    executionId,
    verdict,
    criteria,
    reason: anyFail ? "val-015-mechanical-verification-failed" : "val-015-verified",
  });

  return {
    executionId,
    terminal: anyFail ? "FAILED" : "COMPLETED",
    criteria,
    usage: outcome.kind === "success" ? (outcome.usage ?? null) : null,
    dispatchLatencyMs,
    imageDigest: outcome.kind === "success" ? mediaDigest(outcome.image.bytes) : null,
    imageDimensions:
      outcome.kind === "success" && outcome.image.width !== null && outcome.image.height !== null
        ? { width: outcome.image.width, height: outcome.image.height }
        : null,
    requestDigest: plan.requestDigest,
  };
}
