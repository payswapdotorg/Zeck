/**
 * The 3D generation/rendering platform slice (VAL-018).
 *
 * The PLATFORM (Zeck's operators/runtime) — never the application —
 * derives, from a customer-submitted 3D task (scene rendering or
 * parametric mesh generation):
 *   1. the 3D dispatch plan (the exact deterministic spec text, its
 *      digest, camera/frames parameters and route facts),
 *   2. the provider dispatch over an injected rail — and here is the
 *      honest boundary: NO operator-authorized 3D-generation provider
 *      rail exists (the capability matrix's `model:three-d` row has
 *      zero candidate providers). The binding therefore reports the
 *      exact missing access requirement (THREE_D_ACCESS_REQUIREMENT
 *      — provider/model, why needed, experiment unlocked, minimum
 *      credential) as an honest non-retryable boundary failure BEFORE
 *      any network effect, and the REAL 3D dispatches remain recorded
 *      NOT RUN boundaries. NO fabricated 3D rail, endpoint or model
 *      result is ever substituted (the tech-lead contract's
 *      provider-access policy: record the exact gap, surface the
 *      minimum required test access, never convert unavailable
 *      evidence to PASS);
 *   3. the mechanical verification criteria a completion is judged by
 *      when a rail later exists: container validity (magic-byte
 *      glTF/STL/OBJ sniff — never extension, never provider mime),
 *      byte bounds, non-empty payload and sha256 digest capture — the
 *      work order's own "container validity and digest" rule.
 *
 * The derivations are PURE: no network, no environment, no randomness.
 * The rail seam (ThreeDRail) is the neutral contract an
 * operator-authorized provider binding will implement; unit and
 * discrimination tests inject controlled fakes to prove the machinery
 * offline (fakes are for tests only — never presented as a REAL rail).
 * Honesty invariants (by construction):
 *   * a spec fixture absent from the materialization is a thrown
 *     NOT-RUN signal BEFORE any lifecycle mutation (never a silent
 *     empty dispatch);
 *   * a materialization whose digest disagrees with the plan is
 *     rejected BEFORE any network effect (fixture-digest-mismatch);
 *   * a provably-invalid spec (empty scene, corrupted JSON, unknown
 *     primitive, invalid fields) is rejected BEFORE any paid dispatch
 *     — the corpus rows' own expected-FAILED edges;
 *   * a task outside the three-d vocabulary is rejected BEFORE any
 *     network effect (wrong-modality);
 *   * with no configured rail the dispatch is the honest
 *     no-authorized-3d-rail boundary failure carrying the surfaced
 *     access requirement — zero rail calls, zero network effect;
 *   * a rail failure (when a rail exists) FAILS the execution — never
 *     completes it;
 *   * dispatch timing and usage are measured, never estimated;
 *   * the planning decision is recorded BEFORE the dispatch;
 *   * evidence carries payload DIGESTS, never payloads.
 */

import {
  type MeshSpecFixture,
  mediaDigest,
  meshSpecFixture,
  type ThreeDSceneFixture,
  threeDSceneFixture,
} from "../apps/shared/media";
import type { LabRoute, LabUsage, LabVerificationCriterion } from "./derive";
import type { PlatformLifecyclePort } from "./driver";
import {
  sniffThreeDContainer,
  THREE_D_BYTE_BOUNDS,
  threeDBytesWithinBounds,
} from "./three-d-container";

// ---------------------------------------------------------------------------
// The surfaced 3D access requirement (the honest NOT RUN boundary)
// ---------------------------------------------------------------------------

/**
 * The exact missing provider-access requirement surfaced to the
 * operator per the validation tech-lead contract's provider-access
 * policy. Every field is grounded in repository artifacts (the
 * capability matrix's `model:three-d` row and PROVIDER_ACCESS
 * registry) — no invented vendor claims.
 */
export interface ProviderAccessRequirement {
  /** The capability the gap belongs to (the matrix row). */
  readonly capability: string;
  /** The missing provider/model access, stated exactly. */
  readonly providerModel: string;
  /** Why the access is needed. */
  readonly whyNeeded: string;
  /** The experiment the access unlocks. */
  readonly experimentUnlocked: string;
  /** The minimum credential that unlocks it (env-var NAME only, never a value). */
  readonly minimumCredential: string;
  readonly credentialEnvVar: string;
}

/**
 * The ONE surfaced 3D access requirement. Until an operator authorizes
 * a 3D-generation-capable provider, every REAL 3D dispatch in this
 * slice is a recorded NOT RUN boundary — never a fabricated
 * equivalent, never a silent pass.
 */
export const THREE_D_ACCESS_REQUIREMENT: ProviderAccessRequirement = {
  capability: "model:three-d",
  providerModel:
    "no 3D-generation provider/model exists in the authorized set (PROVIDER_ACCESS: openrouter, " +
    "qwen, openai, byteplus-ark, seedance — none 3D-capable; capability matrix row model:three-d " +
    "has zero candidate providers); the operator must select and authorize one " +
    "3D-generation-capable provider and model pair, then bind it onto the ThreeDRail seam",
  whyNeeded:
    "the VAL-018 3D generation/rendering sub-slice (three-d.render-scene.v1 and " +
    "three-d.mesh-from-spec.v1) requires REAL text-to-3D dispatches through the platform path; " +
    "without an authorized rail those REAL runs cannot be driven honestly, so they are recorded " +
    "NOT RUN boundaries with this exact requirement surfaced instead",
  experimentUnlocked:
    "the three-d.render-scene.v1 / three-d.mesh-from-spec.v1 REAL chained dispatch slices of the " +
    "VAL-018 crown run (healthy rows COMPLETED with container-valid/digest-verified REAL 3D " +
    "artifacts; the invalid-spec edge rows FAILED before any paid dispatch), closing the " +
    "model:three-d capability gap in the matrix",
  minimumCredential:
    "one 3D-generation-capable provider API key authorized for a single text-to-3D round trip " +
    "(scene spec in, glTF/OBJ/STL artifact out) — read from the environment at run time via the " +
    "declared env-var NAME only; no credential value ever appears in the repository, logs or reports",
  credentialEnvVar: "ZECK_3D_API_KEY",
};

// ---------------------------------------------------------------------------
// Task vocabulary (the pinned VAL-018 three-d slice — the corpus's own
// three-d.render-scene.v1 / three-d.mesh-from-spec.v1 row shapes)
// ---------------------------------------------------------------------------

/** Render a deterministic synthetic scene spec into a 3D artifact. */
export interface RenderSceneTask {
  readonly kind: "render-3d";
  /** The seeded scene-spec fixture key. */
  readonly scene: string;
  /** An optional declared camera viewpoint. */
  readonly camera?: string;
  /** An optional declared animation frame count. */
  readonly frames?: number;
}

/** Generate a valid mesh from a deterministic parametric spec. */
export interface MeshFromSpecTask {
  readonly kind: "mesh-from-spec";
  /** The seeded mesh-spec fixture key. */
  readonly spec: string;
}

export type ThreeDTask = RenderSceneTask | MeshFromSpecTask;

// ---------------------------------------------------------------------------
// Materialization (pure, deterministic — the seeded-spec recipe)
// ---------------------------------------------------------------------------

/** One task's materialized dispatch inputs and ground truth. */
export interface MaterializedThreeDInput {
  readonly kind: "render-3d" | "mesh-from-spec";
  readonly specKey: string;
  /** The exact spec text dispatched (deterministic per key). */
  readonly spec: string;
  /** sha256-16 of the spec text bytes (request-level reproducibility). */
  readonly specDigest: string;
  /** Fixture provenance (recorded in evidence; never a provider claim). */
  readonly annotation: string;
  /** Scene rows: the fixture's own declared object count (ground truth). */
  readonly objectCount: number | null;
  /** Mesh rows: the fixture's own declared primitive (ground truth). */
  readonly primitive: string | null;
  /** Render rows: the task's declared camera viewpoint, when present. */
  readonly camera: string | null;
  /** Render rows: the task's declared animation frame count, when present. */
  readonly frames: number | null;
}

/** A fixture (or task vocabulary) absent from the materialization is a NOT RUN boundary. */
export class ThreeDFixtureNotMaterializedError extends Error {
  constructor(key: string) {
    super(`three-d fixture not materialized (NOT RUN boundary): ${key}`);
    this.name = "ThreeDFixtureNotMaterializedError";
  }
}

/** Materialize one task's dispatch inputs deterministically (no environment). */
export function materializeThreeDInput(task: ThreeDTask): MaterializedThreeDInput {
  if (task.kind === "render-3d") {
    let fixture: ThreeDSceneFixture;
    try {
      fixture = threeDSceneFixture(task.scene);
    } catch {
      throw new ThreeDFixtureNotMaterializedError(task.scene);
    }
    const specBytes = Buffer.from(fixture.spec, "utf8");
    return {
      kind: "render-3d",
      specKey: fixture.key,
      spec: fixture.spec,
      specDigest: mediaDigest(specBytes),
      annotation: fixture.annotation,
      objectCount: fixture.objectCount,
      primitive: null,
      camera: task.camera ?? null,
      frames: task.frames ?? null,
    };
  }
  if (task.kind === "mesh-from-spec") {
    let fixture: MeshSpecFixture;
    try {
      fixture = meshSpecFixture(task.spec);
    } catch {
      throw new ThreeDFixtureNotMaterializedError(task.spec);
    }
    const specBytes = Buffer.from(fixture.spec, "utf8");
    return {
      kind: "mesh-from-spec",
      specKey: fixture.key,
      spec: fixture.spec,
      specDigest: mediaDigest(specBytes),
      annotation: fixture.annotation,
      objectCount: null,
      primitive: fixture.primitive,
      camera: null,
      frames: null,
    };
  }
  // A task kind outside the three-d vocabulary: honestly not
  // materializable by this slice (the binding reports wrong-modality).
  throw new ThreeDFixtureNotMaterializedError(String((task as { kind?: unknown }).kind));
}

// ---------------------------------------------------------------------------
// Spec validity derivation (pure — the corpus's own FAILED edge rows)
// ---------------------------------------------------------------------------

/** The closed primitive vocabulary the specs may declare. */
export const KNOWN_THREE_D_PRIMITIVES: readonly string[] = [
  "box",
  "sphere",
  "cylinder",
  "cone",
  "torus",
  "plane",
];

/** The mechanical reasons a spec is rejected before any paid dispatch. */
export type ThreeDSpecRejection =
  | "not-json"
  | "not-object"
  | "missing-objects"
  | "empty-scene"
  | "unknown-primitive"
  | "invalid-spec-field";

/** The mechanically parsed spec facts (the fixture's own ground truth). */
export interface ParsedThreeDSpec {
  /** Scene rows: the declared object count. */
  readonly objectCount: number;
  /** Mesh rows: the declared primitive. */
  readonly primitive: string | null;
}

function isPositiveNumberArray(value: unknown): boolean {
  if (!Array.isArray(value) || value.length === 0) {
    return false;
  }
  return value.every((entry) => typeof entry === "number" && Number.isFinite(entry) && entry > 0);
}

/**
 * Parse and mechanically validate one spec text against the closed
 * spec vocabulary: a provably-invalid spec is rejected BEFORE any paid
 * dispatch (the corpus rows' own expected-FAILED edges — empty scene,
 * corrupted spec, unknown primitive, invalid fields).
 */
export function parseThreeDSpec(input: {
  readonly kind: "render-3d" | "mesh-from-spec";
  readonly spec: string;
}):
  | { readonly ok: true; readonly parsed: ParsedThreeDSpec }
  | {
      readonly ok: false;
      readonly reason: ThreeDSpecRejection;
    } {
  let value: unknown;
  try {
    value = JSON.parse(input.spec);
  } catch {
    return { ok: false, reason: "not-json" };
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return { ok: false, reason: "not-object" };
  }
  const record = value as Record<string, unknown>;
  if (input.kind === "render-3d") {
    const objects = record.objects;
    if (!Array.isArray(objects)) {
      return { ok: false, reason: "missing-objects" };
    }
    if (objects.length === 0) {
      return { ok: false, reason: "empty-scene" };
    }
    for (const entry of objects) {
      if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
        return { ok: false, reason: "invalid-spec-field" };
      }
      const objectRecord = entry as Record<string, unknown>;
      const primitive = objectRecord.primitive;
      if (typeof primitive !== "string" || !KNOWN_THREE_D_PRIMITIVES.includes(primitive)) {
        return { ok: false, reason: "unknown-primitive" };
      }
      if (
        objectRecord.dimensions !== undefined &&
        !isPositiveNumberArray(objectRecord.dimensions)
      ) {
        return { ok: false, reason: "invalid-spec-field" };
      }
    }
    return { ok: true, parsed: { objectCount: objects.length, primitive: null } };
  }
  const primitive = record.primitive;
  if (typeof primitive !== "string" || !KNOWN_THREE_D_PRIMITIVES.includes(primitive)) {
    return { ok: false, reason: "unknown-primitive" };
  }
  if (!isPositiveNumberArray(record.dimensions)) {
    return { ok: false, reason: "invalid-spec-field" };
  }
  const resolution = record.resolution;
  if (typeof resolution !== "number" || !Number.isInteger(resolution) || resolution < 1) {
    return { ok: false, reason: "invalid-spec-field" };
  }
  return { ok: true, parsed: { objectCount: 1, primitive } };
}

// ---------------------------------------------------------------------------
// Dispatch-plan derivation (pure)
// ---------------------------------------------------------------------------

/**
 * The canonical NEUTRAL rail request body (byte-stable for request
 * digests). This is the platform-side derivation contract the future
 * operator-authorized 3D rail binding adapts onto its real provider
 * wire shape — declared honestly: no REAL endpoint exists today.
 */
export function buildThreeDRequestBody(input: {
  readonly model: string;
  readonly prompt: string;
  readonly camera?: string;
  readonly frames?: number;
}): Readonly<Record<string, unknown>> {
  const parameters: Record<string, unknown> = { n: 1 };
  if (input.camera !== undefined) {
    parameters.camera = input.camera;
  }
  if (input.frames !== undefined) {
    parameters.frames = input.frames;
  }
  return { model: input.model, input: { prompt: input.prompt }, parameters };
}

/** Route facts + request facts recorded on the execution ledger. */
export interface ThreeDDispatchPlan {
  readonly route: LabRoute;
  readonly kind: "render-3d" | "mesh-from-spec";
  readonly specKey: string;
  readonly specDigest: string;
  /** The exact spec text dispatched (the request's prompt). */
  readonly prompt: string;
  readonly camera: string | null;
  readonly frames: number | null;
  /**
   * sha256-16 over the canonical serialized rail request body — the
   * request-level reproducibility reference (the same task always
   * derives the same request, so the same request digest).
   */
  readonly requestDigest: string;
}

/**
 * Derive the dispatch plan for one 3D task. An absent spec fixture
 * throws (NOT RUN), never silently degrades; the request digest makes
 * every future dispatch reproducible at the request level.
 */
export function deriveThreeDPlan(
  task: ThreeDTask,
  options: { readonly provider: string; readonly model: string },
): ThreeDDispatchPlan {
  const materialized = materializeThreeDInput(task);
  const body = buildThreeDRequestBody({
    model: options.model,
    prompt: materialized.spec,
    camera: materialized.camera ?? undefined,
    frames: materialized.frames ?? undefined,
  });
  return {
    route: {
      provider: options.provider,
      model: options.model,
      strategyClass: "single-shot-three-d",
    },
    kind: materialized.kind,
    specKey: materialized.specKey,
    specDigest: materialized.specDigest,
    prompt: materialized.spec,
    camera: materialized.camera,
    frames: materialized.frames,
    requestDigest: mediaDigest(Buffer.from(JSON.stringify(body), "utf8")),
  };
}

// ---------------------------------------------------------------------------
// Mechanical verification derivation (pure)
// ---------------------------------------------------------------------------

/** One successfully delivered 3D artifact from a rail. */
export interface ThreeDArtifact {
  readonly bytes: Buffer;
  /** The rail-declared format (advisory only — verification sniffs the bytes). */
  readonly format: string;
}

/** The rail dispatch outcome: a delivered 3D artifact or an honest failure. */
export type ThreeDRailOutcome =
  | { readonly kind: "success"; readonly artifact: ThreeDArtifact; readonly usage?: LabUsage }
  | {
      readonly kind: "failure";
      readonly category: string;
      readonly message: string;
      readonly retryable: boolean;
      /**
       * Present exactly on the no-authorized-3d-rail boundary failure:
       * the surfaced access requirement (digest-level fields only —
       * never a credential value).
       */
      readonly accessRequirement?: ProviderAccessRequirement;
    };

/**
 * Derive the verification criteria for one 3D outcome. The oracle
 * floor: a provider failure (including the no-authorized-rail
 * boundary) fails ANY run mechanically. Delivered artifacts are
 * verified mechanically ONLY: container validity by magic-byte sniff
 * (never the rail's declared format), declared byte bounds, non-empty
 * payload and sha256 digest capture — the work order's "container
 * validity and digest" rule; never aesthetic or geometric judgment
 * here (a future work order may add geometric criteria when a REAL
 * rail exists to feed them).
 */
export function deriveThreeDVerification(
  task: ThreeDTask,
  outcome: ThreeDRailOutcome,
): LabVerificationCriterion[] {
  if (outcome.kind === "failure") {
    const evidence: string[] = [
      `provider-failure:${outcome.category}`,
      `retryable:${String(outcome.retryable)}`,
      `message:${truncate(outcome.message, 160)}`,
    ];
    if (outcome.accessRequirement !== undefined) {
      evidence.push(`access-gap:${outcome.accessRequirement.capability}`);
      evidence.push(`access-gap-credential-env-var:${outcome.accessRequirement.credentialEnvVar}`);
    }
    return [
      {
        criterionId: "provider-dispatch",
        strategy: "deterministic",
        status: "FAIL",
        evidence,
      },
    ];
  }
  const artifact = outcome.artifact;
  const digest = mediaDigest(artifact.bytes);
  const sniffed = sniffThreeDContainer(artifact.bytes);
  const materialized = materializeThreeDInput(task);
  const criteria: LabVerificationCriterion[] = [];

  // 1. Valid 3D container (magic-byte glTF/STL/OBJ sniff — the rail's
  //    declared format is advisory only and recorded as provenance).
  criteria.push({
    criterionId: "container-valid",
    strategy: "deterministic",
    status: sniffed.container !== "unknown" ? "PASS" : "FAIL",
    evidence: [
      `container:${sniffed.container}`,
      sniffed.detail === null ? "detail:none" : `detail:${sniffed.detail}`,
      `declared-format:${artifact.format}`,
      `bytes:${artifact.bytes.length}`,
      `digest:${digest}`,
      `fixture:${materialized.specKey}`,
    ],
  });

  // 2. Declared byte bounds (mechanical sanity).
  criteria.push({
    criterionId: "byte-bounds",
    strategy: "deterministic",
    status: threeDBytesWithinBounds(artifact.bytes.length) ? "PASS" : "FAIL",
    evidence: [
      `bytes:${artifact.bytes.length}`,
      `bounds:[${THREE_D_BYTE_BOUNDS.minBytes},${THREE_D_BYTE_BOUNDS.maxBytes}]`,
      `digest:${digest}`,
    ],
  });

  // 3. Non-empty payload.
  criteria.push({
    criterionId: "payload-nonempty",
    strategy: "deterministic",
    status: artifact.bytes.length > 0 ? "PASS" : "FAIL",
    evidence: [`bytes:${artifact.bytes.length}`, `digest:${digest}`],
  });

  // 4. Digest capture (the sha256 reference recorded on the ledger —
  //    payload DIGESTS in evidence, never payloads).
  criteria.push({
    criterionId: "digest-captured",
    strategy: "deterministic",
    status: artifact.bytes.length > 0 ? "PASS" : "FAIL",
    evidence: [`digest:${digest}`, "algorithm:sha256", `fixture:${materialized.specKey}`],
  });

  return criteria;
}

// ---------------------------------------------------------------------------
// The neutral rail seam (the future authorized provider binds here)
// ---------------------------------------------------------------------------

/**
 * A 3D-generation provider rail: one REAL endpoint family an
 * operator-authorized provider will bind onto. No concrete rail
 * constructor exists in this slice — there is NO authorized 3D
 * provider today (THREE_D_ACCESS_REQUIREMENT); controlled fakes
 * implementing this seam exist ONLY in tests and are never presented
 * as REAL rails.
 */
export interface ThreeDRail {
  readonly railId: string;
  dispatch(input: {
    readonly model: string;
    readonly prompt: string;
    readonly parameters?: Readonly<Record<string, unknown>>;
  }): Promise<ThreeDRailOutcome>;
}

// ---------------------------------------------------------------------------
// The dispatch binding (pre-dispatch discriminations + the honest
// no-authorized-rail boundary)
// ---------------------------------------------------------------------------

/**
 * Bind the 3D dispatch, enforcing the discriminations BEFORE any
 * network effect:
 *   * wrong modality (a task whose kind is outside the three-d
 *     vocabulary);
 *   * fixture-digest mismatch (a tampered/swapped materialization);
 *   * provably-invalid specs (empty scene, corrupted JSON, unknown
 *     primitive, invalid fields — the corpus's expected-FAILED edges);
 *   * the no-authorized-3d-rail boundary: with no configured rail the
 *     dispatch is an honest non-retryable failure carrying the exact
 *     surfaced access requirement — zero rail calls, zero network
 *     effect, never a fabricated completion.
 *
 * When a rail IS configured (tests, or a future authorized binding),
 * the platform's bounded retry policy applies to RETRYABLE rail
 * failures only; every attempt is a REAL dispatch and waits are part
 * of the measured latency.
 */
export interface ThreeDRetryPolicy {
  /** Additional attempts after the first (0 = no retry). */
  readonly attempts: number;
  /** The wait between attempts (milliseconds). */
  readonly delayMs: number;
  /** Injectable for tests (defaults to a real timed sleep). */
  readonly sleep?: (ms: number) => Promise<void>;
}

export function createThreeDDispatchBinding(options: {
  readonly rail?: ThreeDRail;
  /** Overridable for discrimination tests (defaults to the pure materializer). */
  readonly materialize?: (task: ThreeDTask) => MaterializedThreeDInput;
  /** The bounded retry policy (default: no retry — single attempt). */
  readonly retry?: ThreeDRetryPolicy;
  readonly transportCalls?: { count: number };
}): (input: {
  readonly executionId: string;
  readonly task: ThreeDTask;
  readonly provider: string;
  readonly model: string;
}) => Promise<ThreeDRailOutcome> {
  const materialize = options.materialize ?? materializeThreeDInput;
  const calls = options.transportCalls ?? { count: 0 };
  const retry = options.retry ?? { attempts: 0, delayMs: 0 };
  const sleep =
    retry.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  return async (input) => {
    // 1. Wrong-modality discrimination BEFORE any materialization or
    //    network effect: the vocabulary is closed.
    const kind = (input.task as { kind?: unknown }).kind;
    if (kind !== "render-3d" && kind !== "mesh-from-spec") {
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
      materialized.specDigest !== plan.specDigest ||
      materialized.specKey !== plan.specKey ||
      materialized.spec !== plan.prompt
    ) {
      return {
        kind: "failure",
        category: "fixture-digest-mismatch",
        message: `materialized spec digest ${materialized.specDigest} disagrees with the planned digest ${plan.specDigest} for fixture ${plan.specKey}`,
        retryable: false,
      };
    }
    // 3. Spec validity discrimination (the corpus's expected-FAILED
    //    edges are rejected before ANY paid dispatch).
    const parsed = parseThreeDSpec({ kind: materialized.kind, spec: materialized.spec });
    if (!parsed.ok) {
      return {
        kind: "failure",
        category: "invalid-request",
        message: `three-d spec rejected before any paid dispatch: ${parsed.reason}`,
        retryable: false,
      };
    }
    // 4. The honest authorized-rail boundary.
    if (options.rail === undefined) {
      return {
        kind: "failure",
        category: "no-authorized-3d-rail",
        message:
          "no operator-authorized 3D-generation provider rail exists (the REAL 3D dispatch is a " +
          "NOT RUN boundary; the exact access requirement is surfaced, never a fabricated equivalent)",
        retryable: false,
        accessRequirement: THREE_D_ACCESS_REQUIREMENT,
      };
    }
    const rail = options.rail;
    const parameters: Record<string, unknown> = {};
    if (materialized.camera !== null) {
      parameters.camera = materialized.camera;
    }
    if (materialized.frames !== null) {
      parameters.frames = materialized.frames;
    }
    const dispatchInput = {
      model: input.model,
      prompt: materialized.spec,
      ...(Object.keys(parameters).length > 0 ? { parameters } : {}),
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
// The platform-side execution driver (mirrors driver.ts for three-d)
// ---------------------------------------------------------------------------

export interface ThreeDRunPorts {
  readonly lifecycle: PlatformLifecyclePort;
  readonly dispatch: (input: {
    readonly executionId: string;
    readonly task: ThreeDTask;
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
  /** The sniffed container kind of the delivered artifact on success. */
  readonly artifactContainer: string | null;
  readonly requestDigest: string | null;
}

/**
 * Drive one submitted 3D execution to completion through the platform
 * path. A missing spec fixture aborts BEFORE any lifecycle mutation
 * (NOT RUN — the thrown ThreeDFixtureNotMaterializedError); a rail
 * failure — including the honest no-authorized-3d-rail boundary —
 * completes as FAILED (honest, never completed).
 */
export async function driveThreeDExecution(options: {
  readonly executionId: string;
  readonly task: ThreeDTask;
  readonly provider: string;
  readonly model: string;
  readonly ports: ThreeDRunPorts;
}): Promise<ThreeDRunResult> {
  const { executionId, task, provider, model, ports } = options;

  // 1. The dispatch plan is derived BEFORE any lifecycle mutation: an
  //    absent fixture aborts here (NOT RUN — nothing was driven).
  const plan = deriveThreeDPlan(task, { provider, model });

  // 2. Canonical lifecycle up to RUNNING.
  await ports.lifecycle.transition({
    executionId,
    step: "authorize",
    reason: "val-018-three-d-authorize",
  });
  await ports.lifecycle.transition({ executionId, step: "plan", reason: "val-018-three-d-plan" });
  // 3. Durable planning decision (route facts) — intent before effect.
  await ports.lifecycle.recordPlanningDecision({ executionId, route: plan.route });
  await ports.lifecycle.transition({ executionId, step: "queue", reason: "val-018-three-d-queue" });
  await ports.lifecycle.transition({ executionId, step: "start", reason: "val-018-three-d-start" });

  // 4. The dispatch through the injected port (measured).
  const dispatchStartedAt = ports.now();
  const outcome = await ports.dispatch({ executionId, task, provider, model });
  const dispatchLatencyMs = ports.now().getTime() - dispatchStartedAt.getTime();

  // 5. Mechanical verification derivation.
  const criteria = deriveThreeDVerification(task, outcome);
  const anyFail = criteria.some((criterion) => criterion.status === "FAIL");
  const verdict: "pass" | "fail" = anyFail ? "fail" : "pass";

  await ports.lifecycle.transition({
    executionId,
    step: "verify",
    reason: "val-018-three-d-verify",
  });
  await ports.lifecycle.complete({
    executionId,
    verdict,
    criteria,
    reason: anyFail ? "val-018-three-d-mechanical-verification-failed" : "val-018-three-d-verified",
  });

  const sniffed = outcome.kind === "success" ? sniffThreeDContainer(outcome.artifact.bytes) : null;
  return {
    executionId,
    terminal: anyFail ? "FAILED" : "COMPLETED",
    criteria,
    usage: outcome.kind === "success" ? (outcome.usage ?? null) : null,
    dispatchLatencyMs,
    artifactDigest: outcome.kind === "success" ? mediaDigest(outcome.artifact.bytes) : null,
    artifactContainer: sniffed === null ? null : sniffed.container,
    requestDigest: plan.requestDigest,
  };
}

function truncate(value: string, bound: number): string {
  return value.length <= bound ? value : `${value.slice(0, bound)}…`;
}
