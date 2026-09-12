/**
 * The multimodal-transformation chain orchestration (VAL-018).
 *
 * The PLATFORM-side chain a customer's `transform-multimodal` task
 * rides, built ENTIRELY over the EXISTING proven rails (no rail code
 * duplicated):
 *
 *   stage 1 "vision"                — the source image + the seeded
 *     instruction dispatched through the EXISTING multimodal dispatch
 *     binding (the OpenRouter vision rail in production bindings;
 *     controlled fakes in tests) as a `describe-image` task whose
 *     question is the structured-description instruction;
 *   stage 2 "structured-description" — the vision answer derived into
 *     the structured JSON description by the PURE
 *     `deriveStructuredDescription` (the shared cross-modal bridge from
 *     the three-d platform slice) — no network, no randomness;
 *   stage 3 "derived-media"         — the structured description
 *     rendered into a deterministic derived prompt and dispatched
 *     through the EXISTING imagegen rail (the dashscope
 *     multimodal-generation rail in production bindings) as a
 *     text-to-image request.
 *
 * Honesty invariants (by construction):
 *   * each stage's output is mechanically verified BEFORE the next
 *     stage consumes it (chain-of-custody oracle floor);
 *   * a stage failure ABORTS the chain with the exact stage recorded
 *     (chain-abort propagation — later stages are never executed);
 *   * per-stage provenance (request digest, response digest, measured
 *     latency, measured usage) travels on the chain outcome and into
 *     evidence; payload DIGESTS only, never payloads;
 *   * the pre-chain discriminations (wrong modality, fixture-digest
 *     mismatch, blank instruction) reject BEFORE any network effect;
 *   * the stage-3 bounded retry policy retries RETRYABLE failures
 *     only; non-retryable failures are never retried; waits are part
 *     of the measured latency.
 */

import type {
  LabDispatchOutcome,
  LabRoute,
  LabUsage,
  LabVerificationCriterion,
} from "../../platform/derive";
import type { PlatformLifecyclePort } from "../../platform/driver";
import {
  buildImagegenRequestBody,
  type ImagegenRail,
  type ImagegenRailOutcome,
  type ImagegenTask,
} from "../../platform/imagegen";
import {
  dimensionsAreSane,
  parseRasterDimensions,
  sniffRasterContainer,
} from "../../platform/imagegen-raster";
import {
  type DescribeImageTask,
  deriveMultimodalPlan,
  deriveMultimodalVerification,
  type MultimodalTask,
} from "../../platform/multimodal";
import {
  deriveStructuredDescription,
  deriveStructuredDescriptionVerification,
  type StructuredDescription,
  serializeStructuredDescription,
} from "../../platform/three-d";
import { imageFixture, mediaDigest } from "../shared/media";
import { transformationInstructionFixture } from "./fixtures";

// ---------------------------------------------------------------------------
// Task vocabulary (the chain's own, plus the foreign tasks it rejects)
// ---------------------------------------------------------------------------

/** The chain task: a synthetic source image + a seeded instruction. */
export interface TransformMultimodalTask {
  readonly kind: "transform-multimodal";
  /** The deterministic synthetic source-image fixture key. */
  readonly source: string;
  /** The seeded instruction fixture key (the structured-description request). */
  readonly instruction: string;
}

/**
 * Tasks the chain driver accepts: the in-vocabulary chain task, or a
 * foreign task (imagegen / multimodal vocabulary) which the chain
 * binding rejects as wrong-modality BEFORE any network effect — the
 * corpus's own wrong-modality rejection row, driven honestly.
 */
export type TransformationChainTask = TransformMultimodalTask | ImagegenTask | MultimodalTask;

/** A fixture absent from the materialization is a NOT RUN boundary. */
export class TransformationFixtureNotMaterializedError extends Error {
  constructor(key: string) {
    super(`transformation fixture not materialized (NOT RUN boundary): ${key}`);
    this.name = "TransformationFixtureNotMaterializedError";
  }
}

// ---------------------------------------------------------------------------
// Materialization + dispatch-plan derivation (pure)
// ---------------------------------------------------------------------------

/** One chain task's materialized inputs and ground truth. */
export interface MaterializedTransformationInput {
  readonly sourceKey: string;
  /** sha256-16 of the deterministic synthetic source-image bytes. */
  readonly sourceDigest: string;
  readonly instructionKey: string;
  /** sha256-16 of the instruction text bytes. */
  readonly instructionDigest: string;
  /** The exact instruction text dispatched as the vision question. */
  readonly instruction: string;
  /** The source fixture's own ground-truth annotation (oracle provenance). */
  readonly annotation: string;
}

/** Materialize one chain task's inputs deterministically (no environment). */
export function materializeTransformationInput(
  task: TransformMultimodalTask,
): MaterializedTransformationInput {
  let image: { readonly png: Buffer; readonly annotation: string };
  try {
    image = imageFixture(task.source);
  } catch {
    throw new TransformationFixtureNotMaterializedError(task.source);
  }
  let instruction: ReturnType<typeof transformationInstructionFixture>;
  try {
    instruction = transformationInstructionFixture(task.instruction);
  } catch {
    throw new TransformationFixtureNotMaterializedError(task.instruction);
  }
  return {
    sourceKey: task.source,
    sourceDigest: mediaDigest(image.png),
    instructionKey: instruction.key,
    instructionDigest: mediaDigest(Buffer.from(instruction.instruction, "utf8")),
    instruction: instruction.instruction,
    annotation: image.annotation,
  };
}

/** Route facts + stage facts recorded on the execution ledger. */
export interface TransformationChainPlan {
  readonly kind: "chain" | "wrong-modality";
  /** One route per REAL dispatch stage (vision + derived-media) — or the honest rejection route. */
  readonly stageRoutes: readonly LabRoute[];
  /** The stage-1 vision task (null for wrong-modality rejections). */
  readonly describeTask: DescribeImageTask | null;
  readonly sourceKey: string | null;
  readonly sourceDigest: string | null;
  readonly instructionKey: string | null;
  readonly instructionDigest: string | null;
  readonly instruction: string | null;
  readonly annotation: string | null;
  readonly rejectionReason: string | null;
}

/**
 * Derive the chain plan for one task. An absent fixture throws (NOT
 * RUN), never silently degrades; a task whose kind is outside the
 * chain vocabulary derives the honest wrong-modality rejection plan
 * (drivable — the binding fails the execution BEFORE any network
 * effect, so the vocabulary boundary is provable end to end).
 */
export function deriveTransformationChainPlan(
  task: TransformationChainTask,
  options: {
    readonly visionProvider: string;
    readonly visionModel: string;
    readonly imagegenProvider: string;
    readonly imagegenModel: string;
  },
): TransformationChainPlan {
  const kind = (task as { kind?: unknown }).kind;
  if (kind !== "transform-multimodal") {
    return {
      kind: "wrong-modality",
      stageRoutes: [
        {
          provider: "none",
          model: "none",
          strategyClass: "wrong-modality-rejection",
        },
      ],
      describeTask: null,
      sourceKey: null,
      sourceDigest: null,
      instructionKey: null,
      instructionDigest: null,
      instruction: null,
      annotation: null,
      rejectionReason: `task kind ${String(kind)} is outside the multimodal-transformation vocabulary`,
    };
  }
  const chainTask = task as TransformMultimodalTask;
  const materialized = materializeTransformationInput(chainTask);
  return {
    kind: "chain",
    stageRoutes: [
      {
        provider: options.visionProvider,
        model: options.visionModel,
        strategyClass: "chained-multimodal-transformation-vision",
      },
      {
        provider: options.imagegenProvider,
        model: options.imagegenModel,
        strategyClass: "chained-multimodal-transformation-derived-media",
      },
    ],
    describeTask: {
      kind: "describe-image",
      image: chainTask.source,
      question: materialized.instruction,
    },
    sourceKey: materialized.sourceKey,
    sourceDigest: materialized.sourceDigest,
    instructionKey: materialized.instructionKey,
    instructionDigest: materialized.instructionDigest,
    instruction: materialized.instruction,
    annotation: materialized.annotation,
    rejectionReason: null,
  };
}

// ---------------------------------------------------------------------------
// The derived-media stage derivation (pure)
// ---------------------------------------------------------------------------

/**
 * Render the structured description into the derived-media generation
 * prompt. DETERMINISTIC: the same description always yields the same
 * prompt text (so, for a pinned description, the same stage-3 request
 * digest). The description fields are DATA — never instructions.
 */
export function deriveDerivedMediaPrompt(description: StructuredDescription): string {
  const colors = description.colors.join(" and ");
  return (
    `A flat minimal illustration of ${description.subject}, rendered in ${colors} tones, ` +
    `on a ${description.background} background. ${description.composition}. ` +
    "Minimal flat vector style, even lighting, no shadows, no text, no watermark."
  );
}

/**
 * Derive the verification criteria for the derived-media stage. The
 * oracle floor: a provider failure FAILS the stage mechanically;
 * delivered outputs are verified mechanically ONLY (valid raster
 * container, declared dimensions, non-empty payload, digest capture) —
 * never aesthetic judgment.
 */
export function deriveDerivedMediaVerification(
  options: {
    /** The derived prompt text (provenance reference). */
    readonly derivedPrompt: string;
    /** sha256-16 of the canonical stage-3 rail request body. */
    readonly requestDigest: string;
    /** The declared derived-media size (dimension ground truth). */
    readonly declaredSize: { readonly width: number; readonly height: number } | null;
  },
  outcome: ImagegenRailOutcome,
): LabVerificationCriterion[] {
  if (outcome.kind === "failure") {
    return [
      {
        criterionId: "provider-dispatch",
        strategy: "deterministic",
        status: "FAIL",
        evidence: [
          `provider-failure:${outcome.category}`,
          `retryable:${String(outcome.retryable)}`,
          `message:${truncate(outcome.message, 160)}`,
          `requestDigest:${options.requestDigest}`,
        ],
      },
    ];
  }
  const bytes = outcome.image.bytes;
  const digest = mediaDigest(bytes);
  const container = sniffRasterContainer(bytes);
  const dims = parseRasterDimensions(bytes);
  const promptDigest = mediaDigest(Buffer.from(options.derivedPrompt, "utf8"));
  const criteria: LabVerificationCriterion[] = [];

  // 1. Valid raster container (PNG/JPEG magic bytes — never by extension).
  criteria.push({
    criterionId: "raster-container",
    strategy: "deterministic",
    status: container !== "unknown" ? "PASS" : "FAIL",
    evidence: [`container:${container}`, `bytes:${bytes.length}`, `digest:${digest}`],
  });

  // 2. Declared dimensions: parseable, mechanically sane, and equal to
  //    the declared size when one is declared (the request must be
  //    honored, not approximated).
  let dimensionsPass = dims !== null && dimensionsAreSane(dims);
  const dimensionEvidence = [
    `parsed:${dims === null ? "none" : `${dims.width}x${dims.height}`}`,
    `digest:${digest}`,
  ];
  if (options.declaredSize !== null) {
    dimensionEvidence.push(
      `requested:${options.declaredSize.width}x${options.declaredSize.height}`,
    );
    if (
      dims === null ||
      dims.width !== options.declaredSize.width ||
      dims.height !== options.declaredSize.height
    ) {
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
    status: bytes.length > 0 ? "PASS" : "FAIL",
    evidence: [`bytes:${bytes.length}`, `digest:${digest}`],
  });

  // 4. Digest capture (payload DIGESTS in evidence, never payloads;
  //    the stage's provenance references travel with it).
  criteria.push({
    criterionId: "digest-captured",
    strategy: "deterministic",
    status: bytes.length > 0 ? "PASS" : "FAIL",
    evidence: [
      `digest:${digest}`,
      "algorithm:sha256",
      `requestDigest:${options.requestDigest}`,
      `promptDigest:${promptDigest}`,
    ],
  });

  return criteria;
}

// ---------------------------------------------------------------------------
// The chained dispatch binding (three stages over the EXISTING rails)
// ---------------------------------------------------------------------------

/** The chain's stage identifiers, in execution order. */
export type TransformationStageId = "vision" | "structured-description" | "derived-media";

/** One stage's execution record: provenance + criteria + honest failure. */
export interface TransformationStageOutcome {
  readonly stageId: TransformationStageId;
  /** Whether the stage actually executed (false = never reached: the chain aborted earlier). */
  readonly executed: boolean;
  /** sha256-16 of the canonical stage request (null when not executed). */
  readonly requestDigest: string | null;
  /** sha256-16 of the stage's output payload (content / JSON / raster; null when not executed or failed). */
  readonly responseDigest: string | null;
  /** Measured stage latency in milliseconds (null when not executed). */
  readonly latencyMs: number | null;
  /** Measured provider usage (null when not executed or not reported). */
  readonly usage: LabUsage | null;
  /** The stage's mechanical verification criteria (empty when not executed). */
  readonly criteria: readonly LabVerificationCriterion[];
  /** The honest failure when the stage failed. */
  readonly failure: {
    readonly category: string;
    readonly message: string;
    readonly retryable: boolean;
  } | null;
}

/** The chained dispatch outcome. */
export interface ChainDispatchOutcome {
  readonly kind: "success" | "failure";
  /** The stage where the chain aborted (null on success / pre-chain rejection). */
  readonly abortedAtStage: TransformationStageId | null;
  /** A pre-chain rejection (wrong-modality / digest mismatch / blank instruction) — before ANY stage. */
  readonly rejection: { readonly category: string; readonly message: string } | null;
  /** All three stages, in execution order, with honest executed flags. */
  readonly stages: readonly TransformationStageOutcome[];
  /** Summed REAL usage across the executed dispatch stages. */
  readonly usage: LabUsage | null;
  /** The final derived-media facts on success. */
  readonly derivedMedia: {
    readonly digest: string;
    readonly width: number | null;
    readonly height: number | null;
    readonly container: string;
    readonly requestDigest: string;
  } | null;
}

/** The bounded retry policy for the derived-media stage (retryable only). */
export interface ChainImagegenRetryPolicy {
  readonly attempts: number;
  readonly delayMs: number;
  readonly sleep?: (ms: number) => Promise<void>;
}

/** The internal, per-stage mutable accumulator (frozen on the outcome). */
interface StageAccumulator {
  stageId: TransformationStageId;
  executed: boolean;
  requestDigest: string | null;
  responseDigest: string | null;
  latencyMs: number | null;
  usage: LabUsage | null;
  criteria: readonly LabVerificationCriterion[];
  failure: {
    readonly category: string;
    readonly message: string;
    readonly retryable: boolean;
  } | null;
}

/** The bounded retry policy for the derived-media stage. */
interface StageFailure {
  readonly category: string;
  readonly message: string;
  readonly retryable: boolean;
}

function newStage(stageId: TransformationStageId): StageAccumulator {
  return {
    stageId,
    executed: false,
    requestDigest: null,
    responseDigest: null,
    latencyMs: null,
    usage: null,
    criteria: [],
    failure: null,
  };
}

function addUsage(usage: LabUsage | undefined, total: LabUsage | null): LabUsage | null {
  if (usage === undefined) {
    return total;
  }
  return {
    inputTokens: (total?.inputTokens ?? 0) + usage.inputTokens,
    outputTokens: (total?.outputTokens ?? 0) + usage.outputTokens,
    ...(usage.costUsd === undefined && total?.costUsd === undefined
      ? {}
      : { costUsd: (total?.costUsd ?? 0) + (usage.costUsd ?? 0) }),
  };
}

/**
 * Bind the chained multimodal-transformation dispatch over the
 * EXISTING rails: the injected vision dispatch function (the REAL
 * multimodal dispatch binding in production — its own discriminations
 * and bounded retry apply to stage 1) and the injected imagegen rail
 * (the REAL dashscope multimodal-generation rail, text-to-image mode,
 * in production). The stage-2 derivation is PURE.
 */
export function createMultimodalTransformationBinding(options: {
  /** Stage-1 vision dispatch — the EXISTING multimodal dispatch binding. */
  readonly visionDispatch: (input: {
    readonly executionId: string;
    readonly task: MultimodalTask;
    readonly provider: string;
    readonly model: string;
  }) => Promise<LabDispatchOutcome>;
  readonly visionProvider: string;
  readonly visionModel: string;
  /** Stage-3 derived-media rail — the EXISTING imagegen rail (text-to-image mode). */
  readonly imagegenRail?: ImagegenRail;
  readonly imagegenProvider: string;
  readonly imagegenModel: string;
  /** The declared derived-media size (dimension verification ground truth). */
  readonly derivedMediaSize: { readonly width: number; readonly height: number } | null;
  /** The bounded retry policy for the derived-media stage (default: no retry). */
  readonly imagegenRetry?: ChainImagegenRetryPolicy;
  /** Overridable for discrimination tests (defaults to the pure materializer). */
  readonly materialize?: (task: TransformMultimodalTask) => MaterializedTransformationInput;
  /** Shared rail-call counter (honest zero-call assertions). */
  readonly railCalls?: { count: number };
  readonly now: () => Date;
}): (input: {
  readonly executionId: string;
  readonly task: TransformationChainTask;
  /** Oracle truth: the corpus row's / fixture's own containsText terms. */
  readonly oracle?: { readonly containsText?: readonly string[] };
}) => Promise<ChainDispatchOutcome> {
  const materialize = options.materialize ?? materializeTransformationInput;
  const railCalls = options.railCalls ?? { count: 0 };
  const retry = options.imagegenRetry ?? { attempts: 0, delayMs: 0 };
  const sleep =
    retry.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  const rejectionOutcome = (category: string, message: string): ChainDispatchOutcome => ({
    kind: "failure",
    abortedAtStage: null,
    rejection: { category, message },
    stages: [newStage("vision"), newStage("structured-description"), newStage("derived-media")],
    usage: null,
    derivedMedia: null,
  });

  return async (input) => {
    // 1. Wrong-modality discrimination BEFORE any materialization or
    //    network effect: the chain vocabulary is closed.
    const kind = (input.task as { kind?: unknown }).kind;
    if (kind !== "transform-multimodal") {
      return rejectionOutcome(
        "wrong-modality",
        `task kind ${String(kind)} is outside the multimodal-transformation vocabulary`,
      );
    }
    const task = input.task as TransformMultimodalTask;

    // 2. The plan (REAL materialization) vs the injected materializer:
    //    a tampered/swapped materialization is rejected BEFORE any
    //    network effect.
    const plan = deriveTransformationChainPlan(task, {
      visionProvider: options.visionProvider,
      visionModel: options.visionModel,
      imagegenProvider: options.imagegenProvider,
      imagegenModel: options.imagegenModel,
    });
    const materialized = materialize(task);
    if (
      materialized.sourceDigest !== plan.sourceDigest ||
      materialized.sourceKey !== plan.sourceKey ||
      materialized.instructionDigest !== plan.instructionDigest ||
      materialized.instructionKey !== plan.instructionKey
    ) {
      return rejectionOutcome(
        "fixture-digest-mismatch",
        `materialized fixture digests disagree with the planned digests for fixtures ${plan.sourceKey}+${plan.instructionKey}`,
      );
    }
    // 3. Blank-instruction discrimination (never a paid dispatch).
    if (materialized.instruction.trim().length === 0) {
      return rejectionOutcome(
        "invalid-request",
        "blank instruction rejected before any paid dispatch",
      );
    }

    const describeTask: DescribeImageTask = {
      kind: "describe-image",
      image: task.source,
      question: materialized.instruction,
    };
    const visionStage = newStage("vision");
    const descriptionStage = newStage("structured-description");
    const derivedMediaStage = newStage("derived-media");
    const stages = [visionStage, descriptionStage, derivedMediaStage];
    let totalUsage: LabUsage | null = null;

    // ---- Stage 1: vision (the EXISTING multimodal dispatch) ----
    const visionPlan = deriveMultimodalPlan(describeTask, {
      provider: options.visionProvider,
      model: options.visionModel,
    });
    visionStage.requestDigest = mediaDigest(
      Buffer.from(
        JSON.stringify({
          model: options.visionModel,
          prompt: visionPlan.prompt,
          fixtureDigest: visionPlan.fixtureDigest,
        }),
        "utf8",
      ),
    );
    const visionStartedAt = options.now();
    const visionOutcome = await options.visionDispatch({
      executionId: input.executionId,
      task: describeTask,
      provider: options.visionProvider,
      model: options.visionModel,
    });
    visionStage.latencyMs = options.now().getTime() - visionStartedAt.getTime();
    visionStage.executed = true;
    visionStage.criteria = deriveMultimodalVerification(describeTask, visionOutcome, {
      containsText: input.oracle?.containsText,
    });
    if (visionOutcome.kind === "failure") {
      visionStage.usage = null;
      visionStage.failure = {
        category: visionOutcome.category,
        message: visionOutcome.message,
        retryable: visionOutcome.retryable,
      };
      return {
        kind: "failure",
        abortedAtStage: "vision",
        rejection: null,
        stages,
        usage: totalUsage,
        derivedMedia: null,
      };
    }
    visionStage.usage = visionOutcome.usage ?? null;
    totalUsage = addUsage(visionOutcome.usage, totalUsage);
    const visionAnswer = visionOutcome.content;
    visionStage.responseDigest = mediaDigest(Buffer.from(visionAnswer, "utf8"));
    // The stage's output is mechanically verified BEFORE stage 2
    // consumes it: a FAIL criterion (e.g. a missing oracle term) aborts
    // the chain at this stage — there is no provider-success shortcut.
    if (visionStage.criteria.some((criterion) => criterion.status === "FAIL")) {
      visionStage.failure = {
        category: "stage-verification-failed",
        message: "the vision stage failed its mechanical verification criteria",
        retryable: false,
      };
      return {
        kind: "failure",
        abortedAtStage: "vision",
        rejection: null,
        stages,
        usage: totalUsage,
        derivedMedia: null,
      };
    }

    // ---- Stage 2: structured description (PURE derivation) ----
    descriptionStage.requestDigest = visionStage.responseDigest;
    const descriptionStartedAt = options.now();
    const descriptionResult = deriveStructuredDescription(visionAnswer);
    descriptionStage.latencyMs = options.now().getTime() - descriptionStartedAt.getTime();
    descriptionStage.executed = true;
    descriptionStage.criteria = deriveStructuredDescriptionVerification(descriptionResult, {
      containsText: input.oracle?.containsText,
    });
    if (descriptionResult.kind === "invalid") {
      descriptionStage.failure = {
        category: "malformed-structured-description",
        message: descriptionResult.reason,
        retryable: false,
      };
      return {
        kind: "failure",
        abortedAtStage: "structured-description",
        rejection: null,
        stages,
        usage: totalUsage,
        derivedMedia: null,
      };
    }
    const description = descriptionResult.description;
    descriptionStage.responseDigest = mediaDigest(
      Buffer.from(serializeStructuredDescription(description), "utf8"),
    );
    // Verified before stage 3 consumes it (chain-of-custody oracle).
    if (descriptionStage.criteria.some((criterion) => criterion.status === "FAIL")) {
      descriptionStage.failure = {
        category: "stage-verification-failed",
        message: "the structured-description stage failed its mechanical verification criteria",
        retryable: false,
      };
      return {
        kind: "failure",
        abortedAtStage: "structured-description",
        rejection: null,
        stages,
        usage: totalUsage,
        derivedMedia: null,
      };
    }

    // ---- Stage 3: derived media (the EXISTING imagegen rail) ----
    const derivedPrompt = deriveDerivedMediaPrompt(description);
    const requestBody = buildImagegenRequestBody({
      model: options.imagegenModel,
      prompt: derivedPrompt,
      ...(options.derivedMediaSize === null ? {} : { size: options.derivedMediaSize }),
    });
    const stage3RequestDigest = mediaDigest(Buffer.from(JSON.stringify(requestBody), "utf8"));
    derivedMediaStage.requestDigest = stage3RequestDigest;
    if (options.imagegenRail === undefined || options.imagegenRail.mode !== "text-to-image") {
      derivedMediaStage.executed = true;
      const failure: StageFailure =
        options.imagegenRail === undefined
          ? {
              category: "wrong-modality",
              message:
                "no imagegen rail configured for the derived-media stage (NOT RUN boundary — the imagegen credential is absent)",
              retryable: false,
            }
          : {
              category: "wrong-modality",
              message: `the derived-media stage requires the text-to-image rail (configured rail mode: ${options.imagegenRail.mode})`,
              retryable: false,
            };
      derivedMediaStage.failure = failure;
      derivedMediaStage.criteria = [
        {
          criterionId: "provider-dispatch",
          strategy: "deterministic",
          status: "FAIL",
          evidence: [
            `provider-failure:${failure.category}`,
            "retryable:false",
            `message:${truncate(failure.message, 160)}`,
            `requestDigest:${stage3RequestDigest}`,
          ],
        },
      ];
      return {
        kind: "failure",
        abortedAtStage: "derived-media",
        rejection: null,
        stages,
        usage: totalUsage,
        derivedMedia: null,
      };
    }
    const rail = options.imagegenRail;
    const dispatchInput = {
      model: options.imagegenModel,
      prompt: derivedPrompt,
      ...(options.derivedMediaSize === null ? {} : { size: options.derivedMediaSize }),
    };
    railCalls.count += 1;
    const derivedStartedAt = options.now();
    let railOutcome: ImagegenRailOutcome = await rail.dispatch(dispatchInput);
    for (
      let attempt = 0;
      attempt < retry.attempts && railOutcome.kind === "failure" && railOutcome.retryable;
      attempt += 1
    ) {
      await sleep(retry.delayMs);
      railCalls.count += 1;
      railOutcome = await rail.dispatch(dispatchInput);
    }
    derivedMediaStage.latencyMs = options.now().getTime() - derivedStartedAt.getTime();
    derivedMediaStage.executed = true;
    derivedMediaStage.criteria = deriveDerivedMediaVerification(
      { derivedPrompt, requestDigest: stage3RequestDigest, declaredSize: options.derivedMediaSize },
      railOutcome,
    );
    if (railOutcome.kind === "failure") {
      derivedMediaStage.usage = null;
      derivedMediaStage.failure = {
        category: railOutcome.category,
        message: railOutcome.message,
        retryable: railOutcome.retryable,
      };
      return {
        kind: "failure",
        abortedAtStage: "derived-media",
        rejection: null,
        stages,
        usage: totalUsage,
        derivedMedia: null,
      };
    }
    derivedMediaStage.usage = railOutcome.usage ?? null;
    totalUsage = addUsage(railOutcome.usage, totalUsage);
    const image = railOutcome.image;
    derivedMediaStage.responseDigest = mediaDigest(image.bytes);
    // The delivered artifact is mechanically verified before the chain
    // may succeed: a malformed payload or dimension mismatch FAILS the
    // chain — never a fabricated completion.
    if (derivedMediaStage.criteria.some((criterion) => criterion.status === "FAIL")) {
      derivedMediaStage.failure = {
        category: "stage-verification-failed",
        message: "the derived-media stage failed its mechanical verification criteria",
        retryable: false,
      };
      return {
        kind: "failure",
        abortedAtStage: "derived-media",
        rejection: null,
        stages,
        usage: totalUsage,
        derivedMedia: null,
      };
    }

    return {
      kind: "success",
      abortedAtStage: null,
      rejection: null,
      stages,
      usage: totalUsage,
      derivedMedia: {
        digest: mediaDigest(image.bytes),
        width: image.width,
        height: image.height,
        container: sniffRasterContainer(image.bytes),
        requestDigest: stage3RequestDigest,
      },
    };
  };
}

// ---------------------------------------------------------------------------
// The platform-side chain execution driver (mirrors driver.ts)
// ---------------------------------------------------------------------------

export interface TransformationRunPorts {
  readonly lifecycle: PlatformLifecyclePort;
  readonly dispatch: (input: {
    readonly executionId: string;
    readonly task: TransformationChainTask;
    readonly oracle?: { readonly containsText?: readonly string[] };
  }) => Promise<ChainDispatchOutcome>;
  readonly now: () => Date;
}

/** The chain driver's result (platform facts + per-stage provenance). */
export interface MultimodalTransformationRunResult {
  readonly executionId: string;
  readonly terminal: "COMPLETED" | "FAILED";
  readonly criteria: readonly LabVerificationCriterion[];
  readonly stages: readonly TransformationStageOutcome[];
  readonly usage: LabUsage | null;
  readonly dispatchLatencyMs: number | null;
  readonly visionAnswerDigest: string | null;
  readonly structuredDescriptionDigest: string | null;
  readonly derivedMediaDigest: string | null;
  readonly derivedMediaDimensions: { readonly width: number; readonly height: number } | null;
  readonly derivedMediaRequestDigest: string | null;
  readonly abortedAtStage: TransformationStageId | null;
}

/**
 * Drive one submitted multimodal-transformation execution to
 * completion through the platform path: the canonical lifecycle (one
 * execution), BOTH stage planning decisions recorded BEFORE the
 * dispatch (intent before effect, per stage), the chained dispatch
 * through the injected port (measured end to end), and the mechanical
 * verification criteria — the per-stage criteria plus the chain
 * integrity/abort record — completing the execution.
 *
 * A missing fixture aborts BEFORE any lifecycle mutation (NOT RUN —
 * the thrown TransformationFixtureNotMaterializedError); a stage
 * failure or pre-chain rejection completes as FAILED (honest, never
 * completed).
 */
export async function driveMultimodalTransformationExecution(options: {
  readonly executionId: string;
  readonly task: TransformationChainTask;
  readonly route: {
    readonly visionProvider: string;
    readonly visionModel: string;
    readonly imagegenProvider: string;
    readonly imagegenModel: string;
  };
  /** Oracle truth: the corpus row's / fixture's own containsText terms. */
  readonly oracle?: { readonly containsText?: readonly string[] };
  readonly ports: TransformationRunPorts;
}): Promise<MultimodalTransformationRunResult> {
  const { executionId, task, route, ports } = options;

  // 1. The chain plan is derived BEFORE any lifecycle mutation: an
  //    absent fixture aborts here (NOT RUN — nothing was driven).
  const plan = deriveTransformationChainPlan(task, route);

  // 2. Canonical lifecycle up to RUNNING.
  await ports.lifecycle.transition({ executionId, step: "authorize", reason: "val-018-authorize" });
  await ports.lifecycle.transition({ executionId, step: "plan", reason: "val-018-plan" });
  // 3. Durable planning decisions — one per REAL dispatch stage (or the
  //    honest rejection route) — intent before effect.
  for (const stageRoute of plan.stageRoutes) {
    await ports.lifecycle.recordPlanningDecision({ executionId, route: stageRoute });
  }
  await ports.lifecycle.transition({ executionId, step: "queue", reason: "val-018-queue" });
  await ports.lifecycle.transition({ executionId, step: "start", reason: "val-018-start" });

  // 4. The chained dispatch through the injected port (measured).
  const dispatchStartedAt = ports.now();
  const outcome = await ports.dispatch({
    executionId,
    task,
    ...(options.oracle === undefined ? {} : { oracle: options.oracle }),
  });
  const dispatchLatencyMs = ports.now().getTime() - dispatchStartedAt.getTime();

  // 5. Mechanical verification derivation: the executed stages'
  //    criteria, plus the chain integrity / abort / rejection record.
  const criteria: LabVerificationCriterion[] = [];
  for (const stage of outcome.stages) {
    criteria.push(...stage.criteria);
  }
  if (outcome.rejection !== null) {
    criteria.push({
      criterionId: "chain-rejected",
      strategy: "deterministic",
      status: "FAIL",
      evidence: [
        `category:${outcome.rejection.category}`,
        `message:${truncate(outcome.rejection.message, 160)}`,
      ],
    });
  } else if (outcome.abortedAtStage !== null) {
    const failedStage = outcome.stages.find((stage) => stage.stageId === outcome.abortedAtStage);
    criteria.push({
      criterionId: "chain-aborted",
      strategy: "deterministic",
      status: "FAIL",
      evidence: [
        `stage:${outcome.abortedAtStage}`,
        `category:${String(failedStage?.failure?.category ?? "unknown")}`,
        `message:${truncate(String(failedStage?.failure?.message ?? "unknown"), 160)}`,
      ],
    });
  } else {
    criteria.push({
      criterionId: "chain-integrity",
      strategy: "deterministic",
      status: "PASS",
      evidence: [
        "stages:3/3",
        `visionAnswerDigest:${String(outcome.stages[0]?.responseDigest ?? "n/a")}`,
        `descriptionDigest:${String(outcome.stages[1]?.responseDigest ?? "n/a")}`,
        `derivedMediaDigest:${String(outcome.stages[2]?.responseDigest ?? "n/a")}`,
      ],
    });
  }
  const anyFail = criteria.some((criterion) => criterion.status === "FAIL");
  const verdict: "pass" | "fail" = anyFail ? "fail" : "pass";

  await ports.lifecycle.transition({ executionId, step: "verify", reason: "val-018-verify" });
  await ports.lifecycle.complete({
    executionId,
    verdict,
    criteria,
    reason: anyFail ? "val-018-mechanical-verification-failed" : "val-018-verified",
  });

  return {
    executionId,
    terminal: anyFail ? "FAILED" : "COMPLETED",
    criteria,
    stages: outcome.stages,
    usage: outcome.usage,
    dispatchLatencyMs,
    visionAnswerDigest: outcome.stages[0]?.responseDigest ?? null,
    structuredDescriptionDigest: outcome.stages[1]?.responseDigest ?? null,
    derivedMediaDigest: outcome.derivedMedia?.digest ?? null,
    derivedMediaDimensions:
      outcome.derivedMedia !== null && outcome.derivedMedia.width !== null
        ? { width: outcome.derivedMedia.width, height: outcome.derivedMedia.height ?? 0 }
        : null,
    derivedMediaRequestDigest: outcome.stages[2]?.requestDigest ?? null,
    abortedAtStage: outcome.abortedAtStage,
  };
}

function truncate(value: string, bound: number): string {
  return value.length <= bound ? value : `${value.slice(0, bound)}…`;
}
