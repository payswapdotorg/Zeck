/**
 * The 3D generation/rendering platform slice (VAL-018).
 *
 * The PLATFORM (Zeck's operators/runtime) — never the application —
 * derives, from a customer-submitted cross-modal/3D task:
 *   1. the structured-description derivation from a vision answer (the
 *      shared cross-modal bridge: image -> structured JSON description),
 *   2. the 3D generation dispatch plan (seeded prompt + declared
 *      geometry parameters, canonical request body, request-level
 *      reproducibility digest), and
 *   3. the mechanical verification criteria a 3D completion is judged by
 *      (container validity + digest capture — never aesthetic or
 *      geometric judgment beyond the container's own structure).
 *
 * NO 3D PROVIDER RAIL EXISTS anywhere in the program's authorized
 * access set. That absence is an explicit, honest NOT RUN boundary —
 * never a fabricated equivalent: the dispatch binding records a
 * `three-d-rail-absent` failure when driven, and the exact missing
 * access requirement (provider/model candidates, why needed, experiment
 * unlocked, minimum credential) is surfaced to the operator via
 * `THREE_D_ACCESS_REQUIREMENT` (recorded in the evidence document and
 * mechanically asserted by tests) per the roadmap's provider-access
 * policy.
 *
 * The derivations are PURE: no network, no environment, no randomness.
 * Honesty invariants (by construction):
 *   * a prompt fixture absent from the materialization is a thrown
 *     NOT-RUN signal BEFORE any lifecycle mutation (never a silent
 *     empty dispatch); the empty prompt materializes as the corpus's
 *     own edge row and is rejected BEFORE any paid dispatch;
 *   * a materialization whose digest disagrees with the plan is
 *     rejected BEFORE any network effect (fixture-digest-mismatch);
 *   * a task whose kind is outside the 3D vocabulary — or whose
 *     declared geometry is mechanically invalid (negative dimensions,
 *     zero resolution, unknown primitive) — is rejected BEFORE any
 *     network effect (wrong-modality / invalid-geometry);
 *   * with no rail configured (the current, honest state) a driven
 *     dispatch fails with `three-d-rail-absent` — the platform never
 *     fabricates a 3D artifact;
 *   * a malformed 3D payload FAILS the mechanical container criterion —
 *     never a fabricated completion;
 *   * dispatch timing and usage are measured, never estimated;
 *     the planning decision is recorded BEFORE the dispatch;
 *   * evidence carries payload DIGESTS, never payloads.
 */

import { mediaDigest } from "../apps/shared/media";
import { threeDPromptFixture } from "../apps/shared/three-d-scenes";
import type { LabRoute, LabUsage, LabVerificationCriterion } from "./derive";
import type { PlatformLifecyclePort } from "./driver";

// ---------------------------------------------------------------------------
// Structured-description derivation from a vision answer (the shared
// cross-modal bridge — pure)
// ---------------------------------------------------------------------------

/**
 * The structured description schema: the fixed field contract a vision
 * answer is derived into. The SAME schema serves both the multimodal
 * transformation chain (image -> structured description -> derived
 * media) and, when a rail later exists, 3D scene generation (structured
 * description -> 3D artifact).
 */
export interface StructuredDescription {
  /** The main subject in one to three words. */
  readonly subject: string;
  /** The subject's main color names (lowercase words). */
  readonly colors: readonly string[];
  /** The background in one to three words. */
  readonly background: string;
  /** The spatial layout / trend direction in one short phrase. */
  readonly composition: string;
}

/** The required fields, in canonical serialization order. */
export const STRUCTURED_DESCRIPTION_FIELDS = [
  "subject",
  "colors",
  "background",
  "composition",
] as const;

/** The derivation outcome: a valid description or an honest reason. */
export type StructuredDescriptionResult =
  | { readonly kind: "valid"; readonly description: StructuredDescription }
  | { readonly kind: "invalid"; readonly reason: string };

/**
 * Derive the structured description from a vision answer. PURE: no
 * network, no randomness. The extraction tolerates markdown fences and
 * surrounding prose (the model's answer is data, never instructions);
 * a JSON object that is unparseable — or whose required fields are
 * missing, empty, or of the wrong type — is an HONEST invalid result
 * (never a silently degraded description, never a fabricated one).
 */
export function deriveStructuredDescription(visionAnswer: string): StructuredDescriptionResult {
  const first = visionAnswer.indexOf("{");
  const last = visionAnswer.lastIndexOf("}");
  if (first < 0 || last <= first) {
    return { kind: "invalid", reason: "no JSON object found in the vision answer" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(visionAnswer.slice(first, last + 1));
  } catch (error) {
    return {
      kind: "invalid",
      reason: `unparseable JSON (${error instanceof Error ? error.message : String(error)})`,
    };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { kind: "invalid", reason: "the JSON payload is not an object" };
  }
  const record = parsed as Record<string, unknown>;
  const fieldError = (name: string, why: string): StructuredDescriptionResult => ({
    kind: "invalid",
    reason: `field "${name}" ${why}`,
  });
  const subject = record.subject;
  if (typeof subject !== "string" || subject.trim().length === 0) {
    return fieldError("subject", "is missing or not a non-empty string");
  }
  const colors = record.colors;
  if (!Array.isArray(colors) || colors.length === 0) {
    return fieldError("colors", "is missing or an empty array");
  }
  const colorTerms: string[] = [];
  for (const color of colors) {
    if (typeof color !== "string" || color.trim().length === 0) {
      return fieldError("colors", "contains a non-string or empty entry");
    }
    colorTerms.push(color.trim());
  }
  const background = record.background;
  if (typeof background !== "string" || background.trim().length === 0) {
    return fieldError("background", "is missing or not a non-empty string");
  }
  const composition = record.composition;
  if (typeof composition !== "string" || composition.trim().length === 0) {
    return fieldError("composition", "is missing or not a non-empty string");
  }
  return {
    kind: "valid",
    description: {
      subject: subject.trim(),
      colors: colorTerms,
      background: background.trim(),
      composition: composition.trim(),
    },
  };
}

/** Canonical (deterministic) serialization of a structured description. */
export function serializeStructuredDescription(description: StructuredDescription): string {
  const ordered: Record<string, unknown> = {};
  for (const field of STRUCTURED_DESCRIPTION_FIELDS) {
    ordered[field] = description[field];
  }
  return JSON.stringify(ordered);
}

/**
 * Derive the verification criteria for the structured-description
 * stage. The oracle floor: an invalid derivation FAILS the stage
 * mechanically; a valid derivation must carry every oracle term (the
 * fixture's own ground truth — never re-derived) inside its serialized
 * fields.
 */
export function deriveStructuredDescriptionVerification(
  result: StructuredDescriptionResult,
  oracle?: { readonly containsText?: readonly string[] },
): LabVerificationCriterion[] {
  if (result.kind === "invalid") {
    return [
      {
        criterionId: "structured-description-valid",
        strategy: "deterministic",
        status: "FAIL",
        evidence: [`invalid:${truncate(result.reason, 160)}`],
      },
    ];
  }
  const serialized = serializeStructuredDescription(result.description);
  const criteria: LabVerificationCriterion[] = [
    {
      criterionId: "structured-description-valid",
      strategy: "deterministic",
      status: "PASS",
      evidence: [
        `fields:${STRUCTURED_DESCRIPTION_FIELDS.join(",")}`,
        `digest:${mediaDigest(Buffer.from(serialized, "utf8"))}`,
      ],
    },
  ];
  for (const term of oracle?.containsText ?? []) {
    const present = serialized.toLowerCase().includes(term.toLowerCase());
    criteria.push({
      criterionId: `contains:${term}`,
      strategy: "deterministic",
      status: present ? "PASS" : "FAIL",
      evidence: [
        present ? `term-present:${term}` : `term-missing:${term}`,
        `digest:${mediaDigest(Buffer.from(serialized, "utf8"))}`,
      ],
    });
  }
  return criteria;
}

// ---------------------------------------------------------------------------
// 3D task vocabulary + deterministic materialization
// ---------------------------------------------------------------------------

/** The declared geometry parameters (the task's own mechanical ground truth). */
export interface ThreeGeometryParameters {
  /** The primitive kind the generation must produce. */
  readonly primitive: "box" | "sphere" | "cylinder" | "composite";
  /** Declared bounding dimensions [x, y, z] in the spec's own units (all > 0). */
  readonly dimensions: readonly [number, number, number];
  /** Mesh subdivision resolution (>= 1). */
  readonly resolution: number;
  /** The container format the 3D artifact must arrive in. */
  readonly format: "glb" | "obj";
}

/** The 3D generation task: a seeded prompt + declared geometry parameters. */
export interface GenerateThreeDTask {
  readonly kind: "generate-3d";
  /** The seeded 3D prompt fixture key. The empty string is the corpus's own empty-prompt edge row. */
  readonly prompt: string;
  readonly geometry: ThreeGeometryParameters;
}

/** The task kinds the 3D vocabulary serves. */
export type ThreeDTaskKind = GenerateThreeDTask["kind"];

/** A fixture (or vocabulary member) absent from the materialization is a NOT RUN boundary. */
export class ThreeDFixtureNotMaterializedError extends Error {
  constructor(key: string) {
    super(`three-d fixture not materialized (NOT RUN boundary): ${key}`);
    this.name = "ThreeDFixtureNotMaterializedError";
  }
}

/** One 3D task's materialized dispatch inputs and ground truth. */
export interface MaterializedThreeDInput {
  readonly prompt: string;
  readonly promptKey: string;
  /** sha256-16 of the prompt text bytes (request-level reproducibility). */
  readonly promptDigest: string;
  /** Fixture provenance (recorded in evidence; never an aesthetic oracle). */
  readonly annotation: string;
  /**
   * The declared geometry, passed through VERBATIM (the binding —
   * never the materializer — rejects mechanically invalid values
   * BEFORE any network effect; materialization stays honest).
   */
  readonly geometry: ThreeGeometryParameters;
}

/** Materialize one 3D task's dispatch inputs deterministically (no environment). */
export function materializeThreeDInput(task: GenerateThreeDTask): MaterializedThreeDInput {
  const kind = (task as { kind?: unknown }).kind;
  if (kind !== "generate-3d") {
    // A task kind outside the 3D vocabulary: honestly not materializable
    // by this slice (the binding reports wrong-modality).
    throw new ThreeDFixtureNotMaterializedError(String(kind));
  }
  let fixture: ReturnType<typeof threeDPromptFixture>;
  try {
    fixture = threeDPromptFixture(task.prompt);
  } catch {
    throw new ThreeDFixtureNotMaterializedError(task.prompt);
  }
  return {
    prompt: fixture.prompt,
    promptKey: fixture.key,
    promptDigest: mediaDigest(Buffer.from(fixture.prompt, "utf8")),
    annotation: fixture.annotation,
    geometry: task.geometry,
  };
}

// ---------------------------------------------------------------------------
// Dispatch-plan derivation (pure, request-level reproducible)
// ---------------------------------------------------------------------------

/** The canonical rail request body (byte-stable for request digests). */
export function buildThreeDRequestBody(input: {
  readonly model: string;
  readonly prompt: string;
  readonly geometry: ThreeGeometryParameters;
}): Readonly<Record<string, unknown>> {
  return {
    model: input.model,
    input: {
      prompt: input.prompt,
      geometry: {
        primitive: input.geometry.primitive,
        dimensions: [...input.geometry.dimensions],
        resolution: input.geometry.resolution,
      },
      format: input.geometry.format,
    },
    parameters: { n: 1 },
  };
}

/** Route facts + request facts recorded on the execution ledger. */
export interface ThreeDDispatchPlan {
  readonly route: LabRoute;
  readonly prompt: string;
  readonly promptKey: string;
  readonly promptDigest: string;
  readonly annotation: string;
  readonly geometry: ThreeGeometryParameters;
  /**
   * sha256-16 over the canonical serialized rail request body — the
   * request-level reproducibility reference (the same task always
   * derives the same request, so the same request digest).
   */
  readonly requestDigest: string;
}

/**
 * Derive the dispatch plan for one 3D task. An absent prompt fixture
 * throws (NOT RUN), never silently degrades; the request digest makes
 * every dispatch reproducible at the request level.
 */
export function deriveThreeDPlan(
  task: GenerateThreeDTask,
  options: { readonly provider: string; readonly model: string },
): ThreeDDispatchPlan {
  const materialized = materializeThreeDInput(task);
  const body = buildThreeDRequestBody({
    model: options.model,
    prompt: materialized.prompt,
    geometry: materialized.geometry,
  });
  return {
    route: {
      provider: options.provider,
      model: options.model,
      strategyClass: "single-shot-three-d",
    },
    prompt: materialized.prompt,
    promptKey: materialized.promptKey,
    promptDigest: materialized.promptDigest,
    annotation: materialized.annotation,
    geometry: materialized.geometry,
    requestDigest: mediaDigest(Buffer.from(JSON.stringify(body), "utf8")),
  };
}

// ---------------------------------------------------------------------------
// 3D "render" verification: container validity + digest (pure)
// ---------------------------------------------------------------------------

/** The 3D container kinds verification accepts (sniffed, never by extension). */
export type ThreeDContainerKind = "glb" | "obj" | "unknown";

/** GLB magic: the four ASCII bytes "glTF" (little-endian 0x46546C67). */
const GLB_MAGIC = Buffer.from([0x67, 0x6c, 0x54, 0x46]);

/** One inspected 3D container: the kind + its own declared structure. */
export interface ThreeDContainerInspection {
  readonly kind: ThreeDContainerKind;
  /** GLB: the container's declared version; OBJ/unknown: null. */
  readonly version: number | null;
  /** GLB: the total length declared in the header; OBJ/unknown: null. */
  readonly declaredLength: number | null;
  /** OBJ: the counted vertex ("v ") and face ("f ") lines; else null/null. */
  readonly vertexLines: number | null;
  readonly faceLines: number | null;
}

/**
 * Inspect a 3D payload's container by structure: GLB by its magic +
 * header (version, declared total length); OBJ by decodable text with
 * vertex/face lines; anything else is honestly "unknown".
 */
export function inspectThreeDContainer(bytes: Buffer): ThreeDContainerInspection {
  if (bytes.length >= 12 && bytes.subarray(0, 4).equals(GLB_MAGIC)) {
    return {
      kind: "glb",
      version: bytes.readUInt32LE(4),
      declaredLength: bytes.readUInt32LE(8),
      vertexLines: null,
      faceLines: null,
    };
  }
  if (looksLikeText(bytes)) {
    const text = bytes.toString("utf8");
    let vertexLines = 0;
    let faceLines = 0;
    for (const line of text.split(/\r?\n/)) {
      if (/^v\s/.test(line)) {
        vertexLines += 1;
      } else if (/^f\s/.test(line)) {
        faceLines += 1;
      }
    }
    if (vertexLines > 0 || faceLines > 0) {
      return { kind: "obj", version: null, declaredLength: null, vertexLines, faceLines };
    }
  }
  return {
    kind: "unknown",
    version: null,
    declaredLength: null,
    vertexLines: null,
    faceLines: null,
  };
}

function looksLikeText(bytes: Buffer): boolean {
  const sample = bytes.subarray(0, Math.min(bytes.length, 4096));
  let suspicious = 0;
  for (const byte of sample) {
    // Control characters other than tab/newline/CR make binary payload.
    if (byte < 0x09 || (byte > 0x0d && byte < 0x20)) {
      suspicious += 1;
    }
  }
  return suspicious === 0;
}

/**
 * The mechanical well-formedness of a 3D container (its OWN structure,
 * never an aesthetic or geometric judgment):
 *   * GLB: known magic, version 1 or 2, and the header's declared total
 *     length equal to the payload's actual length (a truncated or
 *     padded GLB is a mechanical failure);
 *   * OBJ: decodable text carrying at least one vertex line AND one
 *     face line (a renderable mesh must declare both);
 *   * anything else: unknown (a failure).
 */
export function threeDContainerIsWellFormed(
  inspection: ThreeDContainerInspection,
  bytes: Buffer,
): { readonly wellFormed: boolean; readonly detail: string } {
  if (inspection.kind === "glb") {
    const version = inspection.version ?? 0;
    const declared = inspection.declaredLength ?? -1;
    if (version !== 1 && version !== 2) {
      return { wellFormed: false, detail: `glb-version:${version}` };
    }
    if (declared !== bytes.length) {
      return { wellFormed: false, detail: `glb-length:${declared}!=${bytes.length}` };
    }
    if (bytes.length < 20) {
      // 12-byte header + at least one chunk header: no payload chunks.
      return { wellFormed: false, detail: "glb-no-chunks" };
    }
    return { wellFormed: true, detail: `glb-v${version}:${bytes.length}` };
  }
  if (inspection.kind === "obj") {
    const vertices = inspection.vertexLines ?? 0;
    const faces = inspection.faceLines ?? 0;
    if (vertices === 0 || faces === 0) {
      return { wellFormed: false, detail: `obj-lines:v${vertices},f${faces}` };
    }
    return { wellFormed: true, detail: `obj:v${vertices},f${faces}` };
  }
  return { wellFormed: false, detail: "container:unknown" };
}

/** One successfully delivered 3D artifact from a rail. */
export interface ThreeDRailArtifact {
  readonly bytes: Buffer;
  /** The sniffed container kind ("glb" | "obj" | "unknown"). */
  readonly container: ThreeDContainerKind;
}

/** The rail dispatch outcome: a delivered 3D artifact or an honest failure. */
export type ThreeDRailOutcome =
  | { readonly kind: "success"; readonly artifact: ThreeDRailArtifact; readonly usage?: LabUsage }
  | {
      readonly kind: "failure";
      readonly category: string;
      readonly message: string;
      readonly retryable: boolean;
    };

/**
 * Derive the verification criteria for one 3D outcome.
 *
 * The oracle floor: a provider/rail failure (including the honest
 * three-d-rail-absent boundary) FAILS the run mechanically — no
 * shortcut. A delivered artifact is verified mechanically ONLY: a
 * well-formed container of the task's declared format (glb/obj), a
 * non-empty payload, and digest capture. Never aesthetic judgment,
 * never a fabricated pass.
 */
export function deriveThreeDVerification(
  task: GenerateThreeDTask,
  outcome: ThreeDRailOutcome,
): LabVerificationCriterion[] {
  if (outcome.kind === "failure") {
    // A provider/rail failure fails the run mechanically — no shortcut.
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
  const bytes = outcome.artifact.bytes;
  const digest = mediaDigest(bytes);
  const inspection = inspectThreeDContainer(bytes);
  const wellFormed = threeDContainerIsWellFormed(inspection, bytes);
  const materialized = materializeThreeDInput(task);
  const criteria: LabVerificationCriterion[] = [];

  // 1. Valid 3D container (GLB/OBJ structure — never by extension).
  criteria.push({
    criterionId: "three-d-container",
    strategy: "deterministic",
    status: wellFormed.wellFormed ? "PASS" : "FAIL",
    evidence: [
      `container:${inspection.kind}`,
      wellFormed.detail,
      `bytes:${bytes.length}`,
      `digest:${digest}`,
      `fixture:${materialized.promptKey}`,
    ],
  });

  // 2. The container format matches the task's declared format.
  const formatMatches = inspection.kind === task.geometry.format;
  criteria.push({
    criterionId: "container-format-declared",
    strategy: "deterministic",
    status: formatMatches ? "PASS" : "FAIL",
    evidence: [
      `declared:${task.geometry.format}`,
      `sniffed:${inspection.kind}`,
      `digest:${digest}`,
    ],
  });

  // 3. Non-empty payload.
  criteria.push({
    criterionId: "payload-nonempty",
    strategy: "deterministic",
    status: bytes.length > 0 ? "PASS" : "FAIL",
    evidence: [`bytes:${bytes.length}`, `digest:${digest}`],
  });

  // 4. Digest capture (the sha256 reference recorded on the ledger —
  //    payload DIGESTS in evidence, never payloads).
  criteria.push({
    criterionId: "digest-captured",
    strategy: "deterministic",
    status: bytes.length > 0 ? "PASS" : "FAIL",
    evidence: [`digest:${digest}`, "algorithm:sha256", `fixture:${materialized.promptKey}`],
  });

  return criteria;
}

// ---------------------------------------------------------------------------
// The surfaced missing-access requirement (the roadmap's
// provider-access policy — never a fabricated 3D equivalent)
// ---------------------------------------------------------------------------

/** The exact missing provider-access requirement surfaced to the operator. */
export interface MissingAccessRequirement {
  readonly capability: string;
  readonly providerCandidates: readonly {
    readonly provider: string;
    readonly models: readonly string[];
    readonly note: string;
  }[];
  readonly whyNeeded: string;
  readonly experimentUnlocked: string;
  readonly minimumCredential: string;
}

/**
 * NO authorized provider in the program's access set (Kimi, Qwen,
 * Muse, OpenRouter's exposed models, OpenAI, Meta AI, Seedance,
 * Gemini) currently serves a 3D generation/rendering rail. This is the
 * exact requirement the operator must decide on — surfaced per the
 * roadmap's provider-access policy, never substituted with a
 * fabricated equivalent. Secrets themselves are env-materialized at
 * the platform binding when access arrives — never in the repository,
 * logs or reports.
 */
export const THREE_D_ACCESS_REQUIREMENT: MissingAccessRequirement = {
  capability: "model:three-d",
  providerCandidates: [
    {
      provider: "meshy",
      models: ["Meshy-4", "meshy-3d-mesh-v2"],
      note: "text/image-to-3D mesh generation with GLB output and a synchronous-plus-task API",
    },
    {
      provider: "tripo3d",
      models: ["tripo-3d-v2.5"],
      note: "text/image-to-3D mesh generation with GLB/OBJ output",
    },
    {
      provider: "rodin (hyper3d)",
      models: ["rodin-v2"],
      note: "image-to-3D mesh generation with PBR materials and GLB output",
    },
  ],
  whyNeeded:
    "the 3D generation/rendering sub-slice needs one REAL 3D provider rail; every candidate in the authorized access set is text/image/audio-only, so the 3D dispatch is an honest NOT RUN boundary (never a fabricated equivalent)",
  experimentUnlocked:
    "the REAL end-to-end 3D run of the three-d-rendering application rows (submission -> lifecycle -> REAL 3D dispatch -> container/digest verification), the per-row economics and latency of 3D generation, and the cross-modal chain image -> structured description -> 3D artifact",
  minimumCredential:
    "one 3D generation provider API key with text/image-to-3D quota (for example a Meshy or Tripo key), env-materialized at the platform binding under a name like THREE_D_API_KEY — never stored in the repository, logs or reports",
};

// ---------------------------------------------------------------------------
// The dispatch binding (vocabulary/geometry/digest discriminations +
// the honest NOT-RUN rail boundary)
// ---------------------------------------------------------------------------

/** A 3D generation provider rail: one REAL endpoint (none exists yet). */
export interface ThreeDRail {
  readonly railId: string;
  dispatch(input: {
    readonly model: string;
    readonly prompt: string;
    readonly geometry: ThreeGeometryParameters;
  }): Promise<ThreeDRailOutcome>;
}

/** The bounded retry policy for RETRYABLE rail failures only. */
export interface ThreeDRetryPolicy {
  /** Additional attempts after the first (0 = no retry). */
  readonly attempts: number;
  /** The wait between attempts (milliseconds). */
  readonly delayMs: number;
  /** Injectable for tests (defaults to a real timed sleep). */
  readonly sleep?: (ms: number) => Promise<void>;
}

/** Mechanically validate the declared geometry (pure). */
export function validateThreeGeometry(geometry: ThreeGeometryParameters): {
  readonly valid: boolean;
  readonly reason: string;
} {
  const primitives = ["box", "sphere", "cylinder", "composite"] as const;
  if (!primitives.includes(geometry.primitive as (typeof primitives)[number])) {
    return { valid: false, reason: `unknown primitive "${String(geometry.primitive)}"` };
  }
  for (const dimension of geometry.dimensions) {
    if (typeof dimension !== "number" || !Number.isFinite(dimension) || dimension <= 0) {
      return { valid: false, reason: `non-positive dimension ${String(dimension)}` };
    }
  }
  if (
    typeof geometry.resolution !== "number" ||
    !Number.isInteger(geometry.resolution) ||
    geometry.resolution < 1
  ) {
    return { valid: false, reason: `invalid resolution ${String(geometry.resolution)}` };
  }
  if (geometry.format !== "glb" && geometry.format !== "obj") {
    return { valid: false, reason: `unknown format "${String(geometry.format)}"` };
  }
  return { valid: true, reason: "ok" };
}

/**
 * Bind the 3D dispatch, enforcing the pre-dispatch discriminations
 * BEFORE any network effect:
 *   * wrong modality (a task whose kind is outside the 3D vocabulary);
 *   * fixture-digest mismatch (a tampered/swapped materialization);
 *   * blank prompt (the corpus's empty-prompt edge row — never a paid
 *     dispatch on a provably-invalid request);
 *   * invalid declared geometry (negative dimensions, zero resolution,
 *     unknown primitive — the corpus's own mesh-spec edge rows).
 *
 * With no rail configured — the CURRENT, honest state (no authorized
 * 3D provider exists) — a driven dispatch returns the
 * `three-d-rail-absent` failure: the NOT RUN boundary made mechanical.
 * When operator-authorized 3D access later exists, the same binding
 * lights up over the REAL rail with the bounded retry policy for
 * RETRYABLE failures only. Every attempt is a REAL dispatch; measured
 * latencies include any retry waits.
 */
export function createThreeDDispatchBinding(options: {
  /** The 3D rail (NONE exists today — the honest NOT RUN boundary). */
  readonly rail?: ThreeDRail;
  /** Overridable for discrimination tests (defaults to the pure materializer). */
  readonly materialize?: (task: GenerateThreeDTask) => MaterializedThreeDInput;
  /** The bounded retry policy (default: no retry — single attempt). */
  readonly retry?: ThreeDRetryPolicy;
  readonly railCalls?: { count: number };
}): (input: {
  readonly executionId: string;
  readonly task: GenerateThreeDTask;
  readonly provider: string;
  readonly model: string;
}) => Promise<ThreeDRailOutcome> {
  const materialize = options.materialize ?? materializeThreeDInput;
  const calls = options.railCalls ?? { count: 0 };
  const retry = options.retry ?? { attempts: 0, delayMs: 0 };
  const sleep =
    retry.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  return async (input) => {
    // 1. Wrong-modality discrimination BEFORE any materialization or
    //    network effect: the vocabulary is closed.
    const kind = (input.task as { kind?: unknown }).kind;
    if (kind !== "generate-3d") {
      return {
        kind: "failure",
        category: "wrong-modality",
        message: `task kind ${String(kind)} is outside the three-d vocabulary`,
        retryable: false,
      };
    }
    const plan = deriveThreeDPlan(input.task, { provider: input.provider, model: input.model });
    const materialized = materialize(input.task);
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
    // 4. Declared-geometry validation (the corpus's mesh-spec edge rows).
    const geometry = validateThreeGeometry(materialized.geometry);
    if (!geometry.valid) {
      return {
        kind: "failure",
        category: "invalid-geometry",
        message: `declared geometry rejected before any dispatch: ${geometry.reason}`,
        retryable: false,
      };
    }
    // 5. Rail routing: no 3D rail exists in the authorized access set —
    //    the honest NOT RUN boundary, never a fabricated artifact.
    if (options.rail === undefined) {
      return {
        kind: "failure",
        category: "three-d-rail-absent",
        message:
          "no 3D generation provider rail exists in the authorized access set (NOT RUN boundary — the access requirement is surfaced in docs/work-items/VAL-018.md)",
        retryable: false,
      };
    }
    const dispatchInput = {
      model: input.model,
      prompt: materialized.prompt,
      geometry: materialized.geometry,
    };
    calls.count += 1;
    let outcome = await options.rail.dispatch(dispatchInput);
    for (
      let attempt = 0;
      attempt < retry.attempts && outcome.kind === "failure" && outcome.retryable;
      attempt += 1
    ) {
      await sleep(retry.delayMs);
      calls.count += 1;
      outcome = await options.rail.dispatch(dispatchInput);
    }
    return outcome;
  };
}

// ---------------------------------------------------------------------------
// The platform-side execution driver (mirrors driver.ts for three-d)
// ---------------------------------------------------------------------------

export interface ThreeDRunPorts {
  readonly lifecycle: PlatformLifecyclePort;
  readonly dispatch: (input: {
    readonly executionId: string;
    readonly task: GenerateThreeDTask;
    readonly provider: string;
    readonly model: string;
  }) => Promise<ThreeDRailOutcome>;
  readonly now: () => Date;
}

/** The driver's result (PlatformRunResult shape + three-d facts). */
export interface ThreeDRunResult {
  readonly executionId: string;
  readonly terminal: "COMPLETED" | "FAILED";
  readonly criteria: readonly LabVerificationCriterion[];
  readonly usage: LabUsage | null;
  readonly dispatchLatencyMs: number | null;
  /** sha256-16 of the delivered artifact on success (digest, never payload). */
  readonly artifactDigest: string | null;
  readonly artifactContainer: ThreeDContainerKind | null;
  readonly requestDigest: string | null;
}

/**
 * Drive one submitted 3D execution to completion through the platform
 * path. A missing prompt fixture aborts BEFORE any lifecycle mutation
 * (NOT RUN — the thrown ThreeDFixtureNotMaterializedError); a rail
 * failure (including the honest rail-absent boundary) completes as
 * FAILED (honest, never completed).
 */
export async function driveThreeDExecution(options: {
  readonly executionId: string;
  readonly task: GenerateThreeDTask;
  readonly provider: string;
  readonly model: string;
  readonly ports: ThreeDRunPorts;
}): Promise<ThreeDRunResult> {
  const { executionId, task, provider, model, ports } = options;

  // 1. The dispatch plan is derived BEFORE any lifecycle mutation: an
  //    absent fixture aborts here (NOT RUN — nothing was driven).
  const plan = deriveThreeDPlan(task, { provider, model });

  // 2. Canonical lifecycle up to RUNNING.
  await ports.lifecycle.transition({ executionId, step: "authorize", reason: "val-018-authorize" });
  await ports.lifecycle.transition({ executionId, step: "plan", reason: "val-018-plan" });
  // 3. Durable planning decision (route facts) — intent before effect.
  await ports.lifecycle.recordPlanningDecision({ executionId, route: plan.route });
  await ports.lifecycle.transition({ executionId, step: "queue", reason: "val-018-queue" });
  await ports.lifecycle.transition({ executionId, step: "start", reason: "val-018-start" });

  // 4. The dispatch through the injected port (measured).
  const dispatchStartedAt = ports.now();
  const outcome = await ports.dispatch({ executionId, task, provider, model });
  const dispatchLatencyMs = ports.now().getTime() - dispatchStartedAt.getTime();

  // 5. Mechanical verification derivation.
  const criteria = deriveThreeDVerification(task, outcome);
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
    usage: outcome.kind === "success" ? (outcome.usage ?? null) : null,
    dispatchLatencyMs,
    artifactDigest: outcome.kind === "success" ? mediaDigest(outcome.artifact.bytes) : null,
    artifactContainer: outcome.kind === "success" ? outcome.artifact.container : null,
    requestDigest: plan.requestDigest,
  };
}

function truncate(value: string, bound: number): string {
  return value.length <= bound ? value : `${value.slice(0, bound)}…`;
}
