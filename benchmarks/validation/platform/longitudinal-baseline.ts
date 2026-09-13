/**
 * The platform-side longitudinal-baseline driver (VAL-030).
 *
 * The baseline-freeze slice that opens the longitudinal learning wave:
 * what learning will be measured AGAINST is FROZEN before any learning
 * happens — and every later learning claim must beat this reference arm.
 *
 *   * the frozen-baseline manifest vocabulary — content-addressed by
 *     construction: every manifest entry pins an app digest (over the
 *     frozen application-portfolio artifact) plus a golden
 *     workload-corpus revision (over the pinned workload content), with
 *     digests over the pinned artifacts — NEVER the artifacts copied.
 *     The registry is APPEND-ONLY: a correction is a NEW workload
 *     revision (a new registry entry), never an edit of a committed
 *     one — history never mutates;
 *   * the PURE derivations that make the freeze trustworthy —
 *     `deriveFreezeIntegrity` (the manifest digest agreement: ANY
 *     mutation of a frozen app version, workload revision or recorded
 *     trajectory FAILS the digest check — a drifting baseline is
 *     unrepresentable, and a tamperer who edits the recorded steps AND
 *     re-declares the digest is still caught by the equivalence-class
 *     membership backstop), `deriveRerunEquivalence` (a control re-run
 *     over the deterministic fixtures reproduces the recorded
 *     trajectory-digest equivalence class), `deriveLedgerExactlyOnce`
 *     (every control run is ONE immutable longitudinal-experiment
 *     identity per the VAL-007 discipline — a duplicate identity, a
 *     drifted identity content or a re-run that minted a second
 *     identity all FAIL), `deriveAccountingHonesty` (usage measured on
 *     the live rail, none-reported honestly offline, latency always
 *     measured) and `deriveInertLearningCompliance` (the control-run
 *     semantics: learning explicitly INERT — no reuse, no caching
 *     hints, no competence shortcuts);
 *   * the digest discipline (FNV-1a over canonical content — payload
 *     digests only, never payload bytes in evidence);
 *   * the control-run driver: the workload admission (the budget guard
 *     precedes ANY dispatch or effect work), the gated dispatch rounds
 *     (each round rides the competence-system gate that the control
 *     contract demands be inert; a REUSED round dispatches nothing and
 *     is mechanically visible), the effect steps in the declared
 *     (equivalent) ordering, the verification step (a competence
 *     shortcut that skips it is caught by the class membership), the
 *     trajectory capture through the recorder, the exactly-once
 *     identity observation through the longitudinal ledger, and the
 *     re-run probe (the control re-run reproduces the recorded class
 *     and NEVER creates a second ledger identity).
 *
 * Honesty invariants:
 *   * a mutated frozen artifact (app version, workload revision,
 *     recorded trajectory) never passes the freeze check — both the
 *     digest agreement AND the class membership must hold;
 *   * the registry never edits: an overwritten committed revision
 *     FAILS the registry agreement leg;
 *   * one control run, one immutable experiment identity — the re-run
 *     re-observes the SAME identity (replayed), never mints one;
 *   * the control run makes its OWN dispatches (the inert-learning
 *     floor): a reused or shortcut round under-dispatches and FAILS;
 *   * usage is measured (live) or honestly none (offline); latency is
 *     always measured, never estimated;
 *   * evidence carries payload DIGESTS, never payload bytes.
 *
 * Everything is seam-injected here (the lab contract); the integration
 * seam binds the REAL platform path and — for the live row — the REAL
 * model gateway dispatch (env-gated, BYOK, measured — never
 * fabricated).
 */

import type { LabUsage, LabVerificationCriterion } from "./derive";

// ---------------------------------------------------------------------------
// The control-run vocabulary (the reference arm every learning claim must beat)
// ---------------------------------------------------------------------------

/**
 * The control arm's learning mode: learning is explicitly INERT — no
 * reuse of prior trajectories, no caching hints, no competence
 * shortcuts. The control run is the reference arm, never the optimized
 * arm.
 */
export const CONTROL_LEARNING_MODE = "inert" as const;

/**
 * The longitudinal-experiment kind every control run registers as (the
 * VAL-007 experiment vocabulary — a baseline measurement).
 */
export const CONTROL_EXPERIMENT_KIND = "baseline-measurement";

/**
 * The learning-contamination probes the corpus declares (the vocabulary
 * the later discrimination phases drive over the contaminated fixture
 * variants — designed here, pinned now):
 *
 *   * `trajectory-reuse` — the run reuses a previously recorded
 *     trajectory instead of dispatching its own rounds (no fresh model
 *     work: the round is served from a reuse cache);
 *   * `caching-hint` — the run injects caching hints into its dispatch
 *     rounds (the round still dispatches, but the hint is
 *     contamination the inert contract forbids);
 *   * `competence-shortcut` — the run takes a competence shortcut and
 *     skips the verification boundary (the trajectory lacks the
 *     verification step — mechanically out of the recorded class).
 */
export const LEARNING_CONTAMINATION_KINDS = [
  "trajectory-reuse",
  "caching-hint",
  "competence-shortcut",
] as const;

export type LearningContaminationKind = (typeof LEARNING_CONTAMINATION_KINDS)[number];

export function isLearningContaminationKind(value: string): value is LearningContaminationKind {
  return (LEARNING_CONTAMINATION_KINDS as readonly string[]).includes(value);
}

/** The re-run probes the corpus declares (the control re-run). */
export const RERUN_PROBES = [
  // re-drive the SAME frozen workload after the original control run
  // completed: the re-run must reproduce the recorded trajectory-digest
  // equivalence class and NEVER create a second ledger identity
  "after-completion",
] as const;

export type RerunProbe = (typeof RERUN_PROBES)[number];

export function isRerunProbe(value: string): value is RerunProbe {
  return (RERUN_PROBES as readonly string[]).includes(value);
}

/** The dispatch-round modes the competence-system gate can return. */
export const CONTROL_ROUND_MODES = ["fresh", "reused", "hinted"] as const;

export type ControlRoundMode = (typeof CONTROL_ROUND_MODES)[number];

// ---------------------------------------------------------------------------
// The frozen-baseline manifest vocabulary (content-addressed by construction)
// ---------------------------------------------------------------------------

/**
 * The frozen application-portfolio artifact — the app version the
 * manifest's app digest addresses. The artifact is declared ONCE (in
 * the corpus); every other reference is a DIGEST over it, never a copy.
 */
export interface BaselineAppArtifact {
  /** The portfolio application (e.g. "portfolio:text-generation"). */
  readonly appId: string;
  /** The frozen application version tag (e.g. "v1"). */
  readonly appVersion: string;
  /** The app's pinned task vocabulary (the task kind it submits). */
  readonly taskKind: string;
  /** The public integration surface the app rides (e.g. "sdk"). */
  readonly integrationSurface: string;
}

/** One declared workload effect (the digest's input — never copied elsewhere). */
export interface BaselineWorkloadEffect {
  /** The effect's identity (e.g. "order:notify-customer"). */
  readonly effect: string;
  /** The frozen target key (e.g. "ORD-501"). */
  readonly key: string;
  /** The value the effect moves (micro-USD; the guard's demand input). */
  readonly amountMicro: number;
}

/**
 * The golden workload-corpus revision — the pinned workload content a
 * frozen app version runs. A correction is a NEW revision number (the
 * registry is append-only); mutating a committed revision's content
 * under the SAME number is unrepresentable.
 */
export interface BaselineWorkloadRevision {
  /** The golden workload's identity (e.g. "golden:rag-retrieval"). */
  readonly workloadId: string;
  /** The golden corpus revision (append-only: corrections bump it). */
  readonly revision: number;
  /** The dispatch demand: the control run makes its OWN model rounds. */
  readonly dispatchRounds: number;
  /** The declared budget guard input (admission precedes any work). */
  readonly quotaMicro: number;
  /** The declared effect set, in declaration order (the digest's input). */
  readonly effects: readonly BaselineWorkloadEffect[];
}

/**
 * The content-addressed manifest entry: the app digest + the workload
 * revision, digests over the pinned artifacts — NEVER the artifacts
 * copied. The manifest digest addresses the entry's own content.
 */
export interface BaselineManifestEntry {
  readonly appId: string;
  /** The digest over the frozen app artifact. */
  readonly appDigest: string;
  readonly workloadId: string;
  /** The pinned golden workload revision number. */
  readonly workloadRevision: number;
  /** The digest over the pinned workload revision content. */
  readonly workloadDigest: string;
  /** The digest over this manifest's own content (tamper detection). */
  readonly manifestDigest: string;
}

/** One append-only registry commit of a frozen manifest. */
export interface BaselineRegistryEntry {
  /** The workload revision this commit freezes. */
  readonly workloadRevision: number;
  readonly manifest: BaselineManifestEntry;
  /** The commit stamp (fixture-side; deterministic in the fake world). */
  readonly committedAt: string;
}

// ---------------------------------------------------------------------------
// Digests (evidence carries DIGESTS, never payload bytes)
// ---------------------------------------------------------------------------

/** The FNV-1a digest helper (the validation-program digest discipline). */
export function longitudinalDigestOf(value: unknown): string {
  const text = typeof value === "string" ? value : (JSON.stringify(value) ?? "null");
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

/** The digest over the frozen app artifact (the manifest's app address). */
export function appDigestOf(artifact: BaselineAppArtifact): string {
  return longitudinalDigestOf([
    artifact.appId,
    artifact.appVersion,
    artifact.taskKind,
    artifact.integrationSurface,
  ]);
}

/** The digest over the golden workload revision content. */
export function workloadDigestOf(workload: BaselineWorkloadRevision): string {
  return longitudinalDigestOf([
    workload.workloadId,
    workload.revision,
    workload.dispatchRounds,
    workload.quotaMicro,
    workload.effects.map((effect) => [effect.effect, effect.key, effect.amountMicro]),
  ]);
}

/** The manifest digest over the entry's own content (the entry's address). */
export function manifestDigestOf(entry: Omit<BaselineManifestEntry, "manifestDigest">): string {
  return longitudinalDigestOf([
    entry.appId,
    entry.appDigest,
    entry.workloadId,
    entry.workloadRevision,
    entry.workloadDigest,
  ]);
}

// ---------------------------------------------------------------------------
// The trajectory vocabulary (the recorded control trajectory)
// ---------------------------------------------------------------------------

/** The trajectory step kinds (the recorded control run's step families). */
export const TRAJECTORY_STEP_KINDS = ["dispatch", "effect", "verification"] as const;

export type TrajectoryStepKind = (typeof TRAJECTORY_STEP_KINDS)[number];

/**
 * One recorded trajectory step — the step's identity (ordinal, kind,
 * detail) drives the trajectory digest; the step's own digest carries
 * the step's payload-free content fingerprint.
 */
export interface TrajectoryStepRecord {
  /** 1-based ordinal within the control run's recorded trajectory. */
  readonly ordinal: number;
  readonly kind: TrajectoryStepKind;
  /** The step's identity detail (e.g. "round-2", "order:notify-customer"). */
  readonly detail: string;
  /** The step's own content digest (payload-free). */
  readonly digest: string;
}

/**
 * The recorded trajectory: the captured steps plus the DECLARED digest
 * recorded at capture time (the freeze-integrity chain's middle link:
 * steps → declared digest → equivalence-class membership).
 */
export interface RecordedTrajectory {
  readonly steps: readonly TrajectoryStepRecord[];
  readonly declaredDigest: string;
}

/**
 * The trajectory digest: FNV-1a over the steps' identities in ordinal
 * order — deterministic and payload-free.
 */
export function trajectoryDigestOf(steps: readonly TrajectoryStepRecord[]): string {
  return longitudinalDigestOf(steps.map((step) => [step.ordinal, step.kind, step.detail]));
}

/**
 * The workload admission (PURE): the declared quota must cover the
 * declared effect demand — admission precedes ANY dispatch or effect
 * work. A rejected guard is an honest PRECONDITION failure (the control
 * run records the rejection, never a partial application).
 */
export function deriveWorkloadAdmission(workload: BaselineWorkloadRevision): {
  readonly allowed: boolean;
  readonly reason: string | null;
  readonly demandedMicro: number;
} {
  const demandedMicro = workload.effects.reduce((sum, effect) => sum + effect.amountMicro, 0);
  if (demandedMicro > workload.quotaMicro) {
    return {
      allowed: false,
      reason:
        `the budget guard rejected the workload: the declared effect demand ${demandedMicro} ` +
        `micro-USD exceeds the declared quota ${workload.quotaMicro} micro-USD`,
      demandedMicro,
    };
  }
  return { allowed: true, reason: null, demandedMicro };
}

/**
 * The canonical control trajectory for one workload under one effect
 * ordering (PURE): the guard-rejection shape records EXACTLY one
 * verification step (the honest precondition failure — no dispatch, no
 * effect); the admitted shape records the dispatch rounds, the effects
 * in the given (equivalent) ordering and the verification step.
 */
export function controlTrajectoryStepsOf(input: {
  readonly workload: BaselineWorkloadRevision;
  /** The effect ordering (a permutation of the effect indexes). */
  readonly effectOrder?: readonly number[];
}): TrajectoryStepRecord[] {
  const admission = deriveWorkloadAdmission(input.workload);
  if (!admission.allowed) {
    return [
      {
        ordinal: 1,
        kind: "verification",
        detail: "guard-rejected",
        digest: longitudinalDigestOf([
          "guard-rejected",
          admission.demandedMicro,
          input.workload.quotaMicro,
        ]),
      },
    ];
  }
  const order = input.effectOrder ?? input.workload.effects.map((_, index) => index);
  const steps: TrajectoryStepRecord[] = [];
  for (let round = 1; round <= input.workload.dispatchRounds; round += 1) {
    steps.push({
      ordinal: steps.length + 1,
      kind: "dispatch",
      detail: `round-${round}`,
      digest: longitudinalDigestOf(["dispatch", round, "fresh"]),
    });
  }
  for (const index of order) {
    const effect = input.workload.effects[index];
    if (effect === undefined) {
      continue;
    }
    steps.push({
      ordinal: steps.length + 1,
      kind: "effect",
      detail: effect.effect,
      digest: longitudinalDigestOf([effect.effect, effect.key, effect.amountMicro]),
    });
  }
  steps.push({
    ordinal: steps.length + 1,
    kind: "verification",
    detail: "criteria-recorded",
    digest: longitudinalDigestOf([
      "criteria-recorded",
      ...input.workload.effects.map((effect) => effect.effect).sort(),
    ]),
  });
  return steps;
}

/** The trajectory's public event view: `${kind}:${detail}` at the ordinal. */
export interface TrajectoryEventView {
  readonly type: string;
  readonly sequence: number;
}

/** Project the recorded steps onto the public event view (PURE). */
export function trajectoryEventsOf(steps: readonly TrajectoryStepRecord[]): TrajectoryEventView[] {
  return steps.map((step) => ({ type: `${step.kind}:${step.detail}`, sequence: step.ordinal }));
}

/**
 * The app-side trajectory digest over the PUBLIC event read (the SDK's
 * listEvents): the SAME basis as the recorder's trajectory digest, so
 * the app mechanically re-derives the platform's own claim over the
 * public wire — never trusting it.
 */
export function appTrajectoryDigestOf(
  events: readonly { readonly type: string; readonly sequence: number }[],
): string {
  return longitudinalDigestOf(
    events.map((event) => {
      const separator = event.type.indexOf(":");
      const kind = separator < 0 ? event.type : event.type.slice(0, separator);
      const detail = separator < 0 ? "" : event.type.slice(separator + 1);
      return [event.sequence, kind, detail];
    }),
  );
}

/**
 * The trajectory-digest equivalence class for one workload (PURE): the
 * digests of the canonical control trajectories under each DECLARED
 * equivalent effect ordering. A single declared ordering yields the
 * single-member class; independent effects may declare equivalent
 * orderings (the comparator-harness equivalence-class discipline).
 */
export function trajectoryClassOf(input: {
  readonly workload: BaselineWorkloadRevision;
  /** The declared equivalent orderings (default: the declaration order). */
  readonly equivalentOrderings?: readonly (readonly number[])[];
}): string[] {
  const orderings = input.equivalentOrderings ?? [input.workload.effects.map((_, index) => index)];
  return orderings.map((order) =>
    trajectoryDigestOf(controlTrajectoryStepsOf({ workload: input.workload, effectOrder: order })),
  );
}

// ---------------------------------------------------------------------------
// PURE derivations (the oracle floor)
// ---------------------------------------------------------------------------

/** The freeze-integrity facts (every leg's input — digests only). */
export interface FreezeIntegrityFacts {
  /** The pinned manifest (the frozen entry the corpus declared). */
  readonly manifest: BaselineManifestEntry;
  /** The app artifact as it exists NOW (the observed artifact). */
  readonly observedApp: BaselineAppArtifact;
  /** The workload revision as it exists NOW (the observed content). */
  readonly observedWorkload: BaselineWorkloadRevision;
  /**
   * The recorded baseline trajectory (null before the first control run
   * records it — the pre-run freeze check covers the manifest legs).
   */
  readonly recordedTrajectory: RecordedTrajectory | null;
  /** The corpus-pinned trajectory-digest equivalence class. */
  readonly expectedTrajectoryClass: readonly string[];
  /** The registry's committed entry for the pin (null when never committed). */
  readonly registryEntry: BaselineRegistryEntry | null;
}

/** The freeze-integrity verdict (the manifest digest agreement, every leg). */
export interface FreezeIntegrityVerdict {
  /** The manifest's own digest agrees with its recomputed content. */
  readonly manifestSelfAgreement: boolean;
  /** The observed app artifact still digests to the pinned app digest. */
  readonly appArtifactAgreement: boolean;
  /** The observed workload revision still digests to the pinned digest. */
  readonly workloadRevisionAgreement: boolean;
  /**
   * The recorded trajectory's recomputed digest agrees with its declared
   * digest AND is a member of the pinned equivalence class (a tamperer
   * who edits both is still caught by the class backstop).
   */
  readonly recordedTrajectoryAgreement: boolean;
  /** The registry's committed content is the frozen content (append-only). */
  readonly registryAgreement: boolean;
  /** Every leg agreed (a single disagreement fails the row honestly). */
  readonly agreed: boolean;
  readonly criteria: readonly LabVerificationCriterion[];
}

/**
 * Derive the freeze integrity (PURE — the manifest digest agreement):
 * ANY mutation of a frozen app version, workload revision or recorded
 * trajectory FAILS the digest check — a drifting baseline is
 * unrepresentable. The chain is tamper-evident end to end: the app
 * artifact digests to the pinned app digest; the workload revision
 * digests to the pinned workload digest; the manifest's own content
 * digests to its manifest digest; the registry's committed entry holds
 * EXACTLY the frozen manifest; and the recorded trajectory recomputes
 * to its declared digest AND reproduces a member of the pinned
 * equivalence class.
 */
export function deriveFreezeIntegrity(facts: FreezeIntegrityFacts): FreezeIntegrityVerdict {
  const criteria: LabVerificationCriterion[] = [];

  // 1. The manifest self-agreement (the manifest's own digest).
  const manifestSelfAgreement = manifestDigestOf(facts.manifest) === facts.manifest.manifestDigest;
  criteria.push({
    criterionId: "manifest-self-agreement",
    strategy: "deterministic",
    status: manifestSelfAgreement ? "PASS" : "FAIL",
    evidence: [
      `appId:${facts.manifest.appId}`,
      `workload:${facts.manifest.workloadId}@r${facts.manifest.workloadRevision}`,
      `declaredManifestDigest:${facts.manifest.manifestDigest}`,
      `recomputedManifestDigest:${manifestDigestOf(facts.manifest)}`,
      manifestSelfAgreement
        ? "agreed"
        : "DISAGREED (the frozen manifest's own content was tampered)",
    ],
  });

  // 2. The app artifact agreement (the frozen app version).
  const observedAppDigest = appDigestOf(facts.observedApp);
  const appArtifactAgreement = observedAppDigest === facts.manifest.appDigest;
  criteria.push({
    criterionId: "app-artifact-agreement",
    strategy: "deterministic",
    status: appArtifactAgreement ? "PASS" : "FAIL",
    evidence: [
      `pinnedAppDigest:${facts.manifest.appDigest}`,
      `observedAppDigest:${observedAppDigest}`,
      `appVersion:${facts.observedApp.appVersion}`,
      appArtifactAgreement
        ? "agreed (the frozen app version is intact)"
        : "DISAGREED (the frozen app version was mutated after the registry commit)",
    ],
  });

  // 3. The workload revision agreement (the golden workload content).
  const observedWorkloadDigest = workloadDigestOf(facts.observedWorkload);
  const workloadRevisionAgreement =
    observedWorkloadDigest === facts.manifest.workloadDigest &&
    facts.observedWorkload.revision === facts.manifest.workloadRevision &&
    facts.observedWorkload.workloadId === facts.manifest.workloadId;
  criteria.push({
    criterionId: "workload-revision-agreement",
    strategy: "deterministic",
    status: workloadRevisionAgreement ? "PASS" : "FAIL",
    evidence: [
      `pinnedWorkloadDigest:${facts.manifest.workloadDigest}`,
      `observedWorkloadDigest:${observedWorkloadDigest}`,
      `pinnedRevision:r${facts.manifest.workloadRevision}`,
      `observedRevision:r${facts.observedWorkload.revision}`,
      workloadRevisionAgreement
        ? "agreed (the golden workload revision is intact)"
        : "DISAGREED (the committed workload revision was mutated — a correction must be a NEW revision)",
    ],
  });

  // 4. The recorded trajectory agreement (the recorded baseline).
  let recordedTrajectoryAgreement = true;
  if (facts.recordedTrajectory === null) {
    criteria.push({
      criterionId: "recorded-trajectory-agreement",
      strategy: "deterministic",
      status: "PASS",
      evidence: ["trajectory:not-yet-recorded (the pre-run freeze check covers the manifest legs)"],
    });
  } else {
    const recomputed = trajectoryDigestOf(facts.recordedTrajectory.steps);
    const digestAgreement = recomputed === facts.recordedTrajectory.declaredDigest;
    const classMembership = facts.expectedTrajectoryClass.includes(
      facts.recordedTrajectory.declaredDigest,
    );
    recordedTrajectoryAgreement = digestAgreement && classMembership;
    criteria.push({
      criterionId: "recorded-trajectory-agreement",
      strategy: "deterministic",
      status: recordedTrajectoryAgreement ? "PASS" : "FAIL",
      evidence: [
        `declaredDigest:${facts.recordedTrajectory.declaredDigest}`,
        `recomputedDigest:${recomputed}`,
        `classMembership:${String(classMembership)}`,
        `classSize:${facts.expectedTrajectoryClass.length}`,
        recordedTrajectoryAgreement
          ? "agreed (the recorded baseline trajectory is intact and in-class)"
          : "DISAGREED (the recorded trajectory drifted — a drifting baseline is unrepresentable)",
      ],
    });
  }

  // 5. The registry agreement (the append-only commit).
  const registryAgreement =
    facts.registryEntry !== null &&
    facts.registryEntry.manifest.manifestDigest === facts.manifest.manifestDigest &&
    facts.registryEntry.workloadRevision === facts.manifest.workloadRevision;
  criteria.push({
    criterionId: "registry-agreement",
    strategy: "deterministic",
    status: registryAgreement ? "PASS" : "FAIL",
    evidence: [
      facts.registryEntry === null
        ? "registryEntry:none (the pin was never committed)"
        : `registryManifestDigest:${facts.registryEntry.manifest.manifestDigest}`,
      `pinnedManifestDigest:${facts.manifest.manifestDigest}`,
      registryAgreement
        ? "agreed (the registry's committed content is the frozen content)"
        : "DISAGREED (the committed registry entry was edited — the registry is append-only)",
    ],
  });

  const agreed =
    manifestSelfAgreement &&
    appArtifactAgreement &&
    workloadRevisionAgreement &&
    recordedTrajectoryAgreement &&
    registryAgreement;
  return {
    manifestSelfAgreement,
    appArtifactAgreement,
    workloadRevisionAgreement,
    recordedTrajectoryAgreement,
    registryAgreement,
    agreed,
    criteria,
  };
}

/** The re-run equivalence verdict (the control re-run's membership). */
export interface RerunEquivalenceVerdict {
  /** The re-run's trajectory digest reproduces the recorded class. */
  readonly reproduced: boolean;
  readonly observedDigest: string;
  readonly classSize: number;
  readonly criteria: readonly LabVerificationCriterion[];
}

/**
 * Derive the re-run equivalence (PURE): a control re-run over the
 * deterministic fixtures must reproduce the recorded trajectory-digest
 * equivalence class — the re-run's observed digest is a MEMBER of the
 * pinned class (either equivalent ordering is honest reproduction; a
 * drifting re-run is mechanically out of class).
 */
export function deriveRerunEquivalence(input: {
  readonly expectedClass: readonly string[];
  readonly observedTrajectoryDigest: string;
}): RerunEquivalenceVerdict {
  const membership = input.expectedClass.includes(input.observedTrajectoryDigest);
  const nonDegenerate = input.expectedClass.length > 0;
  const reproduced = membership && nonDegenerate;
  return {
    reproduced,
    observedDigest: input.observedTrajectoryDigest,
    classSize: input.expectedClass.length,
    criteria: [
      {
        criterionId: "rerun-trajectory-class-membership",
        strategy: "deterministic",
        status: reproduced ? "PASS" : "FAIL",
        evidence: [
          `observedDigest:${input.observedTrajectoryDigest}`,
          `classSize:${input.expectedClass.length}`,
          `membership:${String(membership)}`,
          reproduced
            ? "reproduced (the control re-run reproduced the recorded class)"
            : "DRIFTED (the re-run's trajectory digest is outside the recorded class)",
        ],
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// The ledger exactly-once discipline (VAL-007)
// ---------------------------------------------------------------------------

/**
 * The control run's experiment key: the stable identity basis — one
 * execution of one pinned baseline is ONE longitudinal experiment.
 */
export function controlRunKeyOf(input: {
  readonly executionId: string;
  readonly manifest: BaselineManifestEntry;
}): string {
  return [
    "control",
    input.manifest.appId,
    input.manifest.workloadId,
    `r${input.manifest.workloadRevision}`,
    input.executionId,
  ].join(":");
}

/**
 * The stable longitudinal-experiment identity for one control run (the
 * VAL-007 `exp-<kind>-<digest>` form, content-derived — never a minted
 * random id).
 */
export function controlIdentityIdOf(runKey: string): string {
  return `exp-${CONTROL_EXPERIMENT_KIND}-${longitudinalDigestOf(runKey)}`;
}

/**
 * The identity's content digest: the manifest digest + the trajectory
 * digest — the immutable content one identity binds.
 */
export function identityContentDigestOf(input: {
  readonly manifestDigest: string;
  readonly trajectoryDigest: string;
}): string {
  return longitudinalDigestOf([input.manifestDigest, input.trajectoryDigest]);
}

/** The ledger's own facts (the derivation's input — digests only). */
export interface LongitudinalLedgerFacts {
  readonly identities: readonly {
    readonly identityId: string;
    readonly runKey: string;
    readonly contentDigest: string;
  }[];
}

/** One identity observation the driver made through the ledger. */
export interface LedgerObservation {
  readonly contentDigest: string;
  readonly identityId: string | null;
  /** True when the ledger replayed the existing identity (no new one). */
  readonly replayed: boolean;
  /** True when the ledger honestly REFUSED (immutable identity content). */
  readonly refused: boolean;
}

/** The ledger exactly-once verdict. */
export interface LedgerExactlyOnceVerdict {
  /** Exactly ONE identity exists for the control run's key. */
  readonly exactlyOnce: boolean;
  /** The identities recorded for the key (LEAKY > 1). */
  readonly duplicateCount: number;
  /** The recorded identity is the derived stable form. */
  readonly identityStable: boolean;
  /** Every observation bound the SAME content (the identity never drifted). */
  readonly contentImmutable: boolean;
  /** The re-run re-observed the SAME identity (never a second one). */
  readonly reobservationReplayed: boolean;
  readonly criteria: readonly LabVerificationCriterion[];
}

/**
 * Derive the ledger exactly-once discipline (PURE, the VAL-007
 * discipline re-derived for the control-run shape): every control run
 * is ONE immutable longitudinal-experiment identity. A duplicate
 * identity for the key (the LEAKY ledger), an identity whose content
 * drifted between observations, an identity not in the derived stable
 * form, or a re-run that minted/refused instead of replaying the SAME
 * identity — each FAILs mechanically.
 */
export function deriveLedgerExactlyOnce(input: {
  readonly runKey: string;
  readonly ledgerFacts: LongitudinalLedgerFacts;
  readonly observations: readonly LedgerObservation[];
}): LedgerExactlyOnceVerdict {
  const mine = input.ledgerFacts.identities.filter((identity) => identity.runKey === input.runKey);
  const exactlyOnce = mine.length === 1;
  const identityStable = exactlyOnce && mine[0]?.identityId === controlIdentityIdOf(input.runKey);
  const contentDigests = new Set(
    input.observations.map((observation) => observation.contentDigest),
  );
  const contentImmutable = contentDigests.size <= 1;
  const last = input.observations[input.observations.length - 1] ?? null;
  const reobservationReplayed =
    input.observations.length <= 1 ||
    (last?.replayed === true &&
      !last.refused &&
      last.identityId !== null &&
      last.identityId === (mine[0]?.identityId ?? null));
  const agreed = exactlyOnce && identityStable && contentImmutable && reobservationReplayed;
  return {
    exactlyOnce,
    duplicateCount: mine.length,
    identityStable,
    contentImmutable,
    reobservationReplayed,
    criteria: [
      {
        criterionId: "ledger-exactly-once",
        strategy: "deterministic",
        status: exactlyOnce ? "PASS" : "FAIL",
        evidence: [
          `runKey:${input.runKey}`,
          `identityCount:${mine.length}`,
          exactlyOnce
            ? "one-immutable-identity"
            : "DUPLICATED (the ledger admitted more than one identity for one control run)",
        ],
      },
      {
        criterionId: "ledger-identity-stable",
        strategy: "deterministic",
        status: identityStable ? "PASS" : "FAIL",
        evidence: [
          `derivedIdentityId:${controlIdentityIdOf(input.runKey)}`,
          `recordedIdentityId:${mine[0]?.identityId ?? "none"}`,
        ],
      },
      {
        criterionId: "ledger-identity-content-immutable",
        strategy: "deterministic",
        status: contentImmutable ? "PASS" : "FAIL",
        evidence: [
          `distinctContentDigests:${contentDigests.size}`,
          contentImmutable
            ? "content-never-drifted"
            : "DRIFTED (the identity's content changed between observations)",
        ],
      },
      {
        criterionId: "ledger-rerun-reobservation",
        strategy: "deterministic",
        status: reobservationReplayed ? "PASS" : "FAIL",
        evidence: [
          `observations:${input.observations.length}`,
          `lastReplayed:${String(last?.replayed ?? false)}`,
          `lastRefused:${String(last?.refused ?? false)}`,
          reobservationReplayed
            ? "replayed-the-same-identity (the re-run created NO second identity)"
            : "RE-ARBITRATED (the re-run did not replay the same identity)",
        ],
      },
      {
        criterionId: "ledger-exactly-once-summary",
        strategy: "deterministic",
        status: agreed ? "PASS" : "FAIL",
        evidence: [
          `exactlyOnce:${String(exactlyOnce)}`,
          `identityStable:${String(identityStable)}`,
          `contentImmutable:${String(contentImmutable)}`,
          `reobservationReplayed:${String(reobservationReplayed)}`,
        ],
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Accounting honesty (measured or honestly none — never estimated)
// ---------------------------------------------------------------------------

/** The accounting honesty verdict. */
export interface AccountingHonestyVerdict {
  readonly honest: boolean;
  readonly criteria: readonly LabVerificationCriterion[];
}

/**
 * Derive the accounting honesty (PURE): latency is ALWAYS measured
 * (non-negative, never null — never estimated); usage is MEASURED on
 * the live rail (a live row without measured usage FAILs) and
 * NONE-REPORTED honestly offline (a fabricated usage on an offline row
 * FAILs — the offline rows dispatch no model, so any usage is a
 * fabrication).
 */
export function deriveAccountingHonesty(input: {
  readonly needsDispatch: boolean;
  readonly usage: LabUsage | null;
  readonly latencyMs: number | null;
}): AccountingHonestyVerdict {
  const latencyMeasured =
    typeof input.latencyMs === "number" && Number.isFinite(input.latencyMs) && input.latencyMs >= 0;
  const usageHonest = input.needsDispatch
    ? input.usage !== null && input.usage.inputTokens >= 0 && input.usage.outputTokens >= 0
    : input.usage === null;
  const honest = latencyMeasured && usageHonest;
  return {
    honest,
    criteria: [
      {
        criterionId: "latency-measured",
        strategy: "deterministic",
        status: latencyMeasured ? "PASS" : "FAIL",
        evidence: [
          `latencyMs:${typeof input.latencyMs === "number" ? input.latencyMs : "none"}`,
          latencyMeasured ? "measured" : "NOT-MEASURED (latency is never estimated)",
        ],
      },
      {
        criterionId: "usage-honest",
        strategy: "deterministic",
        status: usageHonest ? "PASS" : "FAIL",
        evidence: [
          input.needsDispatch
            ? `usage:${input.usage === null ? "none (a live row demands MEASURED usage)" : "measured"}`
            : `usage:${input.usage === null ? "none-reported (offline — honest)" : "FABRICATED (an offline row dispatches no model)"}`,
        ],
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Inert-learning compliance (the control-run semantics)
// ---------------------------------------------------------------------------

/** The inert-learning compliance verdict. */
export interface InertLearningVerdict {
  /** Learning was explicitly INERT for the whole control run. */
  readonly inert: boolean;
  /** The contamination the derivation caught (null when inert). */
  readonly contamination: LearningContaminationKind | null;
  readonly criteria: readonly LabVerificationCriterion[];
}

/**
 * Derive the inert-learning compliance (PURE — the control-run
 * semantics): every dispatch round must be a FRESH round (no reuse, no
 * caching hints) and the verification boundary must not be
 * shortcircuited. The control run is the REFERENCE ARM — any
 * competence-system advantage is contamination and FAILs the control
 * contract, with the contamination kind named mechanically.
 */
export function deriveInertLearningCompliance(input: {
  readonly rounds: readonly { readonly mode: ControlRoundMode }[];
  readonly verificationShortcutUsed: boolean;
  readonly expectedRounds: number;
}): InertLearningVerdict {
  const reused = input.rounds.some((round) => round.mode === "reused");
  const hinted = input.rounds.some((round) => round.mode === "hinted");
  const contamination: LearningContaminationKind | null = reused
    ? "trajectory-reuse"
    : hinted
      ? "caching-hint"
      : input.verificationShortcutUsed
        ? "competence-shortcut"
        : null;
  const observedDispatches = input.rounds.filter((round) => round.mode !== "reused").length;
  const ownDispatches = observedDispatches === input.expectedRounds;
  const inert = contamination === null && ownDispatches;
  return {
    inert,
    contamination,
    criteria: [
      {
        criterionId: "control-learning-inert",
        strategy: "deterministic",
        status: contamination === null ? "PASS" : "FAIL",
        evidence: [
          `mode:${CONTROL_LEARNING_MODE}`,
          `contamination:${contamination ?? "none"}`,
          `rounds:${input.rounds.length}`,
          contamination === null
            ? "inert (no reuse, no caching hints, no competence shortcuts)"
            : "CONTAMINATED (the control contract demands inert learning)",
        ],
      },
      {
        criterionId: "control-own-dispatches",
        strategy: "deterministic",
        status: ownDispatches ? "PASS" : "FAIL",
        evidence: [
          `expectedDispatches:${input.expectedRounds}`,
          `observedDispatches:${observedDispatches}`,
          ownDispatches
            ? "the-control-run-made-its-own-dispatches"
            : "UNDER-DISPATCHED (a reused round dispatched nothing)",
        ],
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// The terminal↔criteria agreement (the anyFail→FAILED invariant, both directions)
// ---------------------------------------------------------------------------

/**
 * Derive the terminal↔criteria agreement (PURE — the anyFail→FAILED
 * invariant): a terminal COMPLETED holds IFF no verification criterion
 * failed, and a terminal FAILED REQUIRES at least one failed criterion.
 * Any fabricated mix is mechanically unrepresentable.
 */
export function deriveTerminalCriteriaAgreement(facts: {
  readonly terminal: string | null;
  readonly verificationStatuses: readonly string[];
}): { readonly agreement: boolean; readonly evidence: readonly string[] } {
  const failed = facts.verificationStatuses.filter((status) => status === "FAIL").length;
  const passed = facts.verificationStatuses.filter((status) => status === "PASS").length;
  const isCompleted = facts.terminal === "COMPLETED";
  const noFail = failed === 0;
  const agreement = facts.terminal !== null && isCompleted === noFail;
  return {
    agreement,
    evidence: [
      `terminal:${facts.terminal ?? "none"}`,
      `criteria:${passed}pass+${failed}fail`,
      `invariant:${isCompleted ? "COMPLETED-implies-no-FAIL" : "FAILED-implies-a-FAIL"}`,
      agreement ? "agreed" : "DISAGREED (a fabricated outcome-criteria mix)",
    ],
  };
}

// ---------------------------------------------------------------------------
// The lifecycle ports (bound to the REAL platform path at the crown)
// ---------------------------------------------------------------------------

/**
 * The append-only frozen-baseline registry port: commits are NEW
 * entries (a correction is a NEW workload revision); an edit of a
 * committed pin is forbidden (the honest registry refuses it — the
 * `admitEdits` fake variant is the adversarial world).
 */
export interface FrozenBaselineRegistryPort {
  /** Append one frozen manifest (append-only; idempotent on identical re-commit). */
  commit(manifest: BaselineManifestEntry, committedAt: string): BaselineRegistryEntry;
  /** The committed entry for one pin (null when never committed). */
  entryFor(pin: {
    readonly appId: string;
    readonly workloadId: string;
    readonly workloadRevision: number;
  }): BaselineRegistryEntry | null;
  /** The append-only commit history for one (appId, workloadId). */
  historyOf(appId: string, workloadId: string): readonly BaselineRegistryEntry[];
}

/**
 * The longitudinal ledger port (the VAL-007 discipline at the control
 * run boundary): one immutable experiment identity per control run.
 */
export interface LongitudinalLedgerPort {
  /**
   * Observe one control run: the first observation RECORDS the identity;
   * a re-observation with the SAME content REPLAYS it (never a second
   * identity); a re-observation with DIFFERENT content is REFUSED (the
   * identity's content is immutable). The LEAKY variant admits
   * duplicates — the mechanical catch.
   */
  observeControlRun(input: {
    readonly runKey: string;
    readonly contentDigest: string;
  }): Promise<LedgerObservation>;
  /** The ledger's own facts (the derivation's input). */
  facts(): LongitudinalLedgerFacts;
}

/**
 * The control recorder port: the trajectory capture with deterministic
 * digests. The FIRST capture per execution is the recorded BASELINE
 * (immutable once recorded); a re-run captures a fresh trajectory the
 * equivalence derivation judges.
 */
export interface ControlRecorderPort {
  /** Begin a fresh capture for one execution (the re-run resets the latest). */
  beginCapture(executionId: string): void;
  /** Capture one trajectory step (digests only). */
  capture(executionId: string, step: TrajectoryStepRecord): void;
  /** The LATEST capture (the re-run's when a re-run happened). */
  latestCapture(executionId: string): RecordedTrajectory | null;
  /** The FIRST capture — the recorded baseline (immutable once recorded). */
  baselineCapture(executionId: string): RecordedTrajectory | null;
}

/**
 * The competence-system gate the control run demands be INERT: each
 * dispatch round passes the gate BEFORE the round is driven (a REUSED
 * round dispatches nothing — mechanically visible in the trajectory
 * and the model-call count).
 */
export interface ControlLearningPort {
  gateRound(input: { readonly round: number }): Promise<{ readonly mode: ControlRoundMode }>;
  /** Whether the competence system would shortcut the verification boundary. */
  verificationShortcut(): boolean;
}

// ---------------------------------------------------------------------------
// The dispatch seam (the live row's REAL model round)
// ---------------------------------------------------------------------------

/** The outcome of ONE dispatch attempt (one seam roundtrip). */
export interface ControlDispatchOutcome {
  readonly kind: "success" | "failure";
  readonly usage?: LabUsage;
  readonly category?: string;
  readonly message?: string;
  readonly latencyMs: number;
}

/** The dispatch seam: one model round per call (the live row). */
export type ControlDispatch = (input: {
  readonly round: number;
  readonly attempt: number;
}) => Promise<ControlDispatchOutcome>;

/** The RETRYABLE dispatch-failure categories (bounded retry applies to these ONLY). */
const RETRYABLE_DISPATCH_CATEGORIES: ReadonlySet<string> = new Set([
  "transport-failure",
  "rate-limit",
  "provider-unavailable",
]);

/** Whether the dispatch-failure category may be retried (honest taxonomy). */
export function isRetryableDispatchCategory(category: string): boolean {
  return RETRYABLE_DISPATCH_CATEGORIES.has(category);
}

// ---------------------------------------------------------------------------
// The corpus row contract (the oracle)
// ---------------------------------------------------------------------------

/** The corpus row (the full oracle — AC1's per-row contract). */
export interface LongitudinalCorpusRow {
  readonly rowId: string;
  readonly description: string;
  /**
   * The baseline manifest entry: the app digest + the workload revision,
   * digests over the pinned artifacts — never the artifacts copied.
   */
  readonly manifest: BaselineManifestEntry;
  /**
   * The frozen app artifact (declared ONCE here — the manifest's app
   * digest addresses it; every other reference is a digest).
   */
  readonly appArtifact: BaselineAppArtifact;
  /** The golden workload revision (the manifest's workload digest addresses it). */
  readonly workload: BaselineWorkloadRevision;
  /**
   * The declared equivalent effect orderings (the equivalence class's
   * basis — independent effects may declare equivalent orderings).
   */
  readonly effectOrderings?: readonly (readonly number[])[];
  /** The expected terminal. */
  readonly expectedTerminal: "COMPLETED" | "FAILED";
  /**
   * The trajectory-digest equivalence class the control run must
   * reproduce (the recorded baseline's accepted trajectories).
   */
  readonly expectedTrajectoryClass: readonly string[];
  /**
   * The control run's OWN dispatch demand (the inert-learning floor:
   * the run makes its own model rounds — a reused round under-dispatches).
   */
  readonly expectedModelCalls: number;
  /** The re-run probe the row drives (absent on non-rerun rows). */
  readonly rerun?: { readonly probe: RerunProbe };
  /**
   * The learning-contamination probe vocabulary (the phase-2
   * discrimination hooks — pinned now, driven later).
   */
  readonly contamination?: { readonly kind: LearningContaminationKind };
  /** Whether the row's work demands a REAL model dispatch (the live rail). */
  readonly needsDispatch: boolean;
  /** The live gate (absent for offline rows — always drivable). */
  readonly liveGate?: {
    readonly envVars: readonly string[];
    readonly requirement: string;
  };
  /** The expected outcomes (the oracle proper). */
  readonly expected: {
    readonly terminal: "COMPLETED" | "FAILED";
    /** The row's total durable executions after the row settles. */
    readonly executions: number;
    /** The row's total distinct idempotency keys. */
    readonly idempotencyRecords: number;
    /** The app-side submission expectations (the app's own contract). */
    readonly appCreated: number;
    readonly replayedSubmissions: number;
    readonly rejectedSubmissions: number;
    /** Exactly ONE longitudinal-experiment identity per control run. */
    readonly ledgerIdentities: number;
  };
}

// ---------------------------------------------------------------------------
// Run results
// ---------------------------------------------------------------------------

/** The full control-run result (the honest baseline contract). */
export interface LongitudinalRunResult {
  readonly rowId: string;
  readonly terminal: "COMPLETED" | "FAILED";
  readonly criteria: readonly LabVerificationCriterion[];
  readonly freeze: FreezeIntegrityVerdict;
  readonly learning: InertLearningVerdict;
  readonly ledger: LedgerExactlyOnceVerdict;
  readonly rerun: RerunEquivalenceVerdict | null;
  readonly accounting: AccountingHonestyVerdict;
  /** The original control run's recorded trajectory digest. */
  readonly trajectoryDigest: string | null;
  /** The re-run's trajectory digest (rerun rows only). */
  readonly rerunTrajectoryDigest: string | null;
  /** The longitudinal-experiment identity the ledger holds for the run. */
  readonly identityId: string | null;
  /** The control run's OWN model dispatches (fresh or hinted rounds). */
  readonly observedModelCalls: number;
  /** The measured usage (the live row; null offline — none-reported honestly). */
  readonly usage: LabUsage | null;
  readonly totalLatencyMs: number;
  /** The honest failure cause (null on healthy runs). */
  readonly failure: { readonly category: string; readonly message: string } | null;
}

// ---------------------------------------------------------------------------
// The control-run chain (one run's machinery)
// ---------------------------------------------------------------------------

interface ChainOptions {
  readonly executionId: string;
  readonly row: LongitudinalCorpusRow;
  readonly recorder: ControlRecorderPort;
  readonly learning: ControlLearningPort;
  readonly effectOrder: readonly number[];
  readonly dispatch?: ControlDispatch;
  readonly retry: {
    readonly maxExtraAttempts: number;
    readonly backoffMs: number;
    readonly sleep: (ms: number) => Promise<void>;
  };
  readonly now: () => Date;
}

/** One driven control chain's outcome. */
interface ChainOutcome {
  readonly outcome: "COMPLETED" | "FAILED";
  readonly modelCalls: number;
  readonly usage: LabUsage | null;
  readonly rounds: readonly { readonly mode: ControlRoundMode }[];
  readonly failure: { readonly category: string; readonly message: string } | null;
}

/**
 * Drive ONE control run's machinery: the workload admission (the guard
 * precedes ANY dispatch or effect work — a rejected workload records
 * EXACTLY the guard-rejection trajectory), the gated dispatch rounds
 * (each round passes the competence-system gate; a REUSED round
 * dispatches nothing and is mechanically visible; the live row's REAL
 * model round rides the dispatch seam with bounded retry on RETRYABLE
 * categories only), the effect steps in the declared (equivalent)
 * ordering, the verification step (UNLESS the competence system
 * shortcuts it — the honest catch), and the trajectory capture through
 * the recorder (the digest is deterministic over the workload content,
 * so a re-run reproduces it).
 */
async function driveControlChain(options: ChainOptions): Promise<ChainOutcome> {
  const { row, recorder } = options;
  const steps: TrajectoryStepRecord[] = [];
  const rounds: { mode: ControlRoundMode }[] = [];
  let usage: LabUsage | null = null;
  let failure: { category: string; message: string } | null = null;

  /** Capture one step through the recorder (ordinal = the capture order). */
  const capture = (step: Omit<TrajectoryStepRecord, "ordinal">): void => {
    const record: TrajectoryStepRecord = { ordinal: steps.length + 1, ...step };
    steps.push(record);
    recorder.capture(options.executionId, record);
  };

  // ---- the workload admission (the guard precedes any work) ----
  const admission = deriveWorkloadAdmission(row.workload);
  if (!admission.allowed) {
    capture({
      kind: "verification",
      detail: "guard-rejected",
      digest: longitudinalDigestOf([
        "guard-rejected",
        admission.demandedMicro,
        row.workload.quotaMicro,
      ]),
    });
    return {
      outcome: "FAILED",
      modelCalls: 0,
      usage: null,
      rounds: [],
      failure: {
        category: "precondition-rejected",
        message: admission.reason ?? "the budget guard rejected the workload",
      },
    };
  }

  // ---- the gated dispatch rounds (the control run's own model work) ----
  for (let round = 1; round <= row.workload.dispatchRounds; round += 1) {
    const gate = await options.learning.gateRound({ round });
    rounds.push({ mode: gate.mode });
    if (gate.mode === "reused") {
      // A REUSED round dispatched NOTHING — no step, no model call (the
      // contamination the inert contract catches).
      continue;
    }
    if (row.needsDispatch && options.dispatch !== undefined) {
      let roundFailure: { category: string; message: string } | null = null;
      for (let attempt = 1; ; attempt += 1) {
        const outcome = await options.dispatch({ round, attempt });
        if (outcome.kind === "success") {
          if (outcome.usage !== undefined) {
            usage = {
              inputTokens: outcome.usage.inputTokens,
              outputTokens: outcome.usage.outputTokens,
              ...(outcome.usage.costUsd === undefined ? {} : { costUsd: outcome.usage.costUsd }),
            };
          }
          break;
        }
        const retryable = isRetryableDispatchCategory(outcome.category ?? "");
        if (!retryable || attempt > options.retry.maxExtraAttempts) {
          roundFailure = {
            category: outcome.category ?? "unknown",
            message: outcome.message ?? "provider failure (no provider message)",
          };
          break;
        }
        await options.retry.sleep(options.retry.backoffMs);
      }
      if (roundFailure !== null) {
        failure = roundFailure;
        break;
      }
    }
    capture({
      kind: "dispatch",
      detail: `round-${round}`,
      digest: longitudinalDigestOf(["dispatch", round, gate.mode]),
    });
  }

  // ---- the effect steps (the declared equivalent ordering) ----
  if (failure === null) {
    for (const index of options.effectOrder) {
      const effect = row.workload.effects[index];
      if (effect === undefined) {
        continue;
      }
      capture({
        kind: "effect",
        detail: effect.effect,
        digest: longitudinalDigestOf([effect.effect, effect.key, effect.amountMicro]),
      });
    }
  }

  // ---- the verification step (UNLESS the competence shortcut skips it) ----
  if (failure === null && !options.learning.verificationShortcut()) {
    capture({
      kind: "verification",
      detail: "criteria-recorded",
      digest: longitudinalDigestOf([
        "criteria-recorded",
        ...row.workload.effects.map((effect) => effect.effect).sort(),
      ]),
    });
  }

  // The in-chain trajectory is the LOCAL capture (the driver derives the
  // official digest from the RECORDER's own reads — the drift catch).
  return {
    outcome: failure === null ? "COMPLETED" : "FAILED",
    modelCalls: rounds.filter((round) => round.mode !== "reused").length,
    usage,
    rounds,
    failure,
  };
}

// ---------------------------------------------------------------------------
// The row driver
// ---------------------------------------------------------------------------

/**
 * Drive one longitudinal corpus row as a CONTROL RUN through the
 * platform path: the original chain (the trajectory capture through
 * the recorder), the exactly-once identity observation through the
 * longitudinal ledger, the freeze-integrity verdict over the registry
 * and the recorded baseline, the re-run probe (the control re-run
 * reproduces the recorded class and NEVER creates a second identity),
 * and the row-level mechanical criteria (freeze integrity + inert
 * learning + ledger exactly-once + re-run equivalence + accounting
 * honesty). The honest terminal is FAILED when any execution failed,
 * any criterion failed or any failure was observed — never a
 * partial-success shortcut.
 */
export async function driveControlRun(options: {
  readonly row: LongitudinalCorpusRow;
  /** The landed execution identity the control run drives. */
  readonly executionId: string;
  readonly registry: FrozenBaselineRegistryPort;
  readonly ledger: LongitudinalLedgerPort;
  readonly recorder: ControlRecorderPort;
  readonly learning: ControlLearningPort;
  /** The dispatch seam (the live row only). */
  readonly dispatch?: ControlDispatch;
  /** Bounded retry policy for RETRYABLE dispatch failures (the live row). */
  readonly retry?: {
    readonly maxExtraAttempts: number;
    readonly backoffMs: number;
    readonly sleep: (ms: number) => Promise<void>;
  };
  readonly now: () => Date;
}): Promise<LongitudinalRunResult> {
  const { row } = options;
  if (row.needsDispatch && options.dispatch === undefined) {
    throw new Error(
      `corpus row ${row.rowId} demands a dispatch seam but none was bound ` +
        "(the live row's REAL model round requires it)",
    );
  }
  const retry = options.retry ?? {
    maxExtraAttempts: 0,
    backoffMs: 0,
    sleep: async () => {},
  };
  const runStartedAt = options.now().getTime();
  const runKey = controlRunKeyOf({ executionId: options.executionId, manifest: row.manifest });
  const effectOrder = row.effectOrderings?.[0] ?? row.workload.effects.map((_, index) => index);
  const observations: LedgerObservation[] = [];

  // ---- the original control run ----
  options.recorder.beginCapture(options.executionId);
  const original = await driveControlChain({
    executionId: options.executionId,
    row,
    recorder: options.recorder,
    learning: options.learning,
    effectOrder,
    ...(options.dispatch === undefined ? {} : { dispatch: options.dispatch }),
    retry,
    now: options.now,
  });
  const originalCapture = options.recorder.latestCapture(options.executionId);
  const trajectoryDigest =
    originalCapture === null ? null : trajectoryDigestOf(originalCapture.steps);
  const recordedTrajectory = options.recorder.baselineCapture(options.executionId);
  observations.push(
    await options.ledger.observeControlRun({
      runKey,
      contentDigest: identityContentDigestOf({
        manifestDigest: row.manifest.manifestDigest,
        trajectoryDigest: trajectoryDigest ?? "",
      }),
    }),
  );

  // ---- the freeze-integrity verdict ----
  const freeze = deriveFreezeIntegrity({
    manifest: row.manifest,
    observedApp: row.appArtifact,
    observedWorkload: row.workload,
    recordedTrajectory,
    expectedTrajectoryClass: row.expectedTrajectoryClass,
    registryEntry: options.registry.entryFor({
      appId: row.manifest.appId,
      workloadId: row.manifest.workloadId,
      workloadRevision: row.manifest.workloadRevision,
    }),
  });

  // ---- the re-run probe (the control re-run) ----
  let rerun: RerunEquivalenceVerdict | null = null;
  let rerunTrajectoryDigest: string | null = null;
  if (row.rerun !== undefined) {
    options.recorder.beginCapture(options.executionId);
    await driveControlChain({
      executionId: options.executionId,
      row,
      recorder: options.recorder,
      learning: options.learning,
      effectOrder,
      ...(options.dispatch === undefined ? {} : { dispatch: options.dispatch }),
      retry,
      now: options.now,
    });
    const rerunCapture = options.recorder.latestCapture(options.executionId);
    rerunTrajectoryDigest = rerunCapture === null ? null : trajectoryDigestOf(rerunCapture.steps);
    observations.push(
      await options.ledger.observeControlRun({
        runKey,
        contentDigest: identityContentDigestOf({
          manifestDigest: row.manifest.manifestDigest,
          trajectoryDigest: rerunTrajectoryDigest ?? trajectoryDigest ?? "",
        }),
      }),
    );
    rerun = deriveRerunEquivalence({
      expectedClass: row.expectedTrajectoryClass,
      observedTrajectoryDigest: rerunTrajectoryDigest ?? "",
    });
  }

  // ---- the ledger exactly-once + the learning compliance ----
  const ledger = deriveLedgerExactlyOnce({
    runKey,
    ledgerFacts: options.ledger.facts(),
    observations,
  });
  const learning = deriveInertLearningCompliance({
    rounds: original.rounds,
    verificationShortcutUsed: options.learning.verificationShortcut(),
    // The inert-learning floor is the ADMITTED dispatch demand: a
    // guard-rejected workload honestly dispatched zero rounds (the
    // precondition failure — never a reuse under-dispatch).
    expectedRounds: deriveWorkloadAdmission(row.workload).allowed ? row.workload.dispatchRounds : 0,
  });
  const totalLatencyMs = options.now().getTime() - runStartedAt;
  const accounting = deriveAccountingHonesty({
    needsDispatch: row.needsDispatch,
    usage: original.usage,
    latencyMs: totalLatencyMs,
  });

  // ---- the row-level criteria ----
  const criteria = deriveLongitudinalRowCriteria({
    row,
    freeze,
    learning,
    ledger,
    rerun,
    accounting,
    trajectoryDigest,
    observedModelCalls: original.modelCalls,
    failure: original.failure,
  });

  const anyFail =
    original.failure !== null ||
    criteria.some((criterion) => criterion.status === "FAIL") ||
    original.outcome === "FAILED";

  return {
    rowId: row.rowId,
    terminal: anyFail ? "FAILED" : "COMPLETED",
    criteria,
    freeze,
    learning,
    ledger,
    rerun,
    accounting,
    trajectoryDigest,
    rerunTrajectoryDigest,
    identityId: observations[0]?.identityId ?? null,
    observedModelCalls: original.modelCalls,
    usage: original.usage,
    totalLatencyMs,
    failure: original.failure,
  };
}

// ---------------------------------------------------------------------------
// Mechanical verification (the oracle floor)
// ---------------------------------------------------------------------------

/**
 * Derive the row-level mechanical criteria (PURE): the freeze-integrity
 * legs, the inert-learning compliance, the ledger exactly-once
 * discipline, the re-run equivalence (rerun rows; an explicit
 * not-probed note otherwise), the accounting honesty, the trajectory
 * class membership of the ORIGINAL run, and the honest outcome
 * contract.
 */
export function deriveLongitudinalRowCriteria(input: {
  readonly row: LongitudinalCorpusRow;
  readonly freeze: FreezeIntegrityVerdict;
  readonly learning: InertLearningVerdict;
  readonly ledger: LedgerExactlyOnceVerdict;
  readonly rerun: RerunEquivalenceVerdict | null;
  readonly accounting: AccountingHonestyVerdict;
  readonly trajectoryDigest: string | null;
  readonly observedModelCalls: number;
  readonly failure: { readonly category: string; readonly message: string } | null;
}): LabVerificationCriterion[] {
  const criteria: LabVerificationCriterion[] = [];

  // 1-5. The freeze-integrity legs (manifest self-agreement, app
  //      artifact, workload revision, recorded trajectory, registry).
  criteria.push(...input.freeze.criteria);

  // 6. The inert-learning compliance (the control-run semantics).
  criteria.push(...input.learning.criteria);

  // 7. The ledger exactly-once discipline (VAL-007).
  criteria.push(...input.ledger.criteria);

  // 8. The re-run equivalence (rerun rows only).
  if (input.rerun !== null) {
    criteria.push(...input.rerun.criteria);
  } else {
    criteria.push({
      criterionId: "rerun-not-probed",
      strategy: "deterministic",
      status: "PASS",
      evidence: [
        `probe:none (the row ${input.row.rowId} declares no re-run — the class is still pinned)`,
      ],
    });
  }

  // 9. The accounting honesty (measured or honestly none).
  criteria.push(...input.accounting.criteria);

  // 10. The original run's own class membership (the baseline the
  //     corpus pinned is the trajectory the control run reproduces).
  const membership =
    input.trajectoryDigest !== null &&
    input.row.expectedTrajectoryClass.includes(input.trajectoryDigest);
  criteria.push({
    criterionId: "trajectory-class-membership",
    strategy: "deterministic",
    status: membership ? "PASS" : "FAIL",
    evidence: [
      `trajectoryDigest:${input.trajectoryDigest ?? "none"}`,
      `classSize:${input.row.expectedTrajectoryClass.length}`,
      membership
        ? "in-class"
        : "OUT-OF-CLASS (the control run did not reproduce the recorded class)",
    ],
  });

  // 11. The control run's own dispatches (the inert-learning floor).
  criteria.push({
    criterionId: "control-own-dispatch-count",
    strategy: "deterministic",
    status: input.observedModelCalls === input.row.expectedModelCalls ? "PASS" : "FAIL",
    evidence: [`expected:${input.row.expectedModelCalls}`, `observed:${input.observedModelCalls}`],
  });

  // 12. The honest outcome contract: the mechanically derived terminal
  //     matches the oracle's terminal.
  const derivedTerminal: "COMPLETED" | "FAILED" = input.failure !== null ? "FAILED" : "COMPLETED";
  criteria.push({
    criterionId: "row-outcome-contract",
    strategy: "deterministic",
    status: derivedTerminal === input.row.expected.terminal ? "PASS" : "FAIL",
    evidence: [
      `expectedTerminal:${input.row.expected.terminal}`,
      `derivedTerminal:${derivedTerminal}`,
      `failure:${input.failure?.category ?? "none"}`,
    ],
  });

  return criteria;
}

// ---------------------------------------------------------------------------
// The app-side control contract (PURE verification of app observations)
// ---------------------------------------------------------------------------

/**
 * Judge the app-side observations against the row's control-run
 * contract (PURE): the terminal↔criteria agreement over the PUBLIC
 * result read (the anyFail→FAILED invariant probed at the customer
 * boundary), the expected terminal met, the app-side trajectory digest
 * (mechanically re-derived over the public events read — never
 * trusting the platform's claim) reproducing the recorded equivalence
 * class, the control run's own dispatch count (a reused or
 * shortcut-contaminated run under-dispatches and is mechanically
 * visible in the public route read), and — the rerun rows — the re-run
 * trajectory class membership and the replay identity preservation.
 */
export function verifyLongitudinalBaselineAppContract(input: {
  readonly row: LongitudinalCorpusRow;
  /** The observed terminal from the public execution read. */
  readonly terminal: string | null;
  /** The verification statuses from the public result read. */
  readonly verificationStatuses: readonly string[];
  /** The app-side trajectory digest over the public events read. */
  readonly trajectoryDigest: string | null;
  /** The re-run's app-side trajectory digest (rerun rows only). */
  readonly rerunTrajectoryDigest: string | null;
  /** The observed model-call count from the public route read. */
  readonly observedModelCalls: number | null;
  /** The replay receipt observation (rerun rows only). */
  readonly replay: {
    readonly replayed: boolean;
    readonly executionId: string;
    readonly rejection: { readonly code: string } | null;
  } | null;
}): LabVerificationCriterion[] {
  const criteria: LabVerificationCriterion[] = [];

  // 1. The terminal↔criteria agreement over the public result read.
  const agreement = deriveTerminalCriteriaAgreement({
    terminal: input.terminal,
    verificationStatuses: input.verificationStatuses,
  });
  criteria.push({
    criterionId: "app-terminal-criteria-agreement",
    strategy: "deterministic",
    status: agreement.agreement ? "PASS" : "FAIL",
    evidence: agreement.evidence,
  });

  // 2. The expected terminal met (the app's own outcome contract).
  criteria.push({
    criterionId: "app-expected-terminal",
    strategy: "deterministic",
    status: input.terminal === input.row.expected.terminal ? "PASS" : "FAIL",
    evidence: [`expected:${input.row.expected.terminal}`, `observed:${input.terminal ?? "none"}`],
  });

  // 3. The trajectory class membership (the app mechanically re-derives
  //    the platform's own claim over the public events read).
  const membership =
    input.trajectoryDigest !== null &&
    input.row.expectedTrajectoryClass.includes(input.trajectoryDigest);
  criteria.push({
    criterionId: "app-trajectory-class-membership",
    strategy: "deterministic",
    status: membership ? "PASS" : "FAIL",
    evidence: [
      `trajectoryDigest:${input.trajectoryDigest ?? "none"}`,
      `classSize:${input.row.expectedTrajectoryClass.length}`,
      membership
        ? "in-class"
        : "OUT-OF-CLASS (the observed trajectory drifted from the recorded baseline)",
    ],
  });

  // 4. The control run made its OWN dispatches (the inert-learning
  //    floor at the customer boundary: a reused or shortcut run
  //    under-dispatches and the public route read shows it).
  criteria.push({
    criterionId: "app-control-run-inert",
    strategy: "deterministic",
    status: input.observedModelCalls === input.row.expectedModelCalls ? "PASS" : "FAIL",
    evidence: [
      `expectedModelCalls:${input.row.expectedModelCalls}`,
      `observedModelCalls:${input.observedModelCalls ?? "none"}`,
      input.observedModelCalls === input.row.expectedModelCalls
        ? "the-control-run-made-its-own-dispatches"
        : "CONTAMINATED (the run under-dispatched — reuse or a competence shortcut)",
    ],
  });

  // 5. The rerun rows: the re-run's trajectory class membership.
  if (input.row.rerun !== undefined) {
    const rerunMembership =
      input.rerunTrajectoryDigest !== null &&
      input.row.expectedTrajectoryClass.includes(input.rerunTrajectoryDigest);
    criteria.push({
      criterionId: "app-rerun-trajectory-class",
      strategy: "deterministic",
      status: rerunMembership ? "PASS" : "FAIL",
      evidence: [
        `rerunTrajectoryDigest:${input.rerunTrajectoryDigest ?? "none"}`,
        `classSize:${input.row.expectedTrajectoryClass.length}`,
        rerunMembership
          ? "reproduced"
          : "DRIFTED (the re-run's trajectory digest is outside the recorded class)",
      ],
    });

    // 6. The rerun rows: the replay identity preservation (a second
    //    identity is a re-arbitration).
    const replay = input.replay;
    const replayOk =
      replay?.replayed === true && replay.rejection === null && replay.executionId !== "";
    criteria.push({
      criterionId: "app-replay-identity-preserved",
      strategy: "deterministic",
      status: replayOk ? "PASS" : "FAIL",
      evidence: [
        `replayed:${String(replay?.replayed ?? false)}`,
        `executionId:${replay?.executionId ? "present" : "none"}`,
        `rejection:${replay?.rejection?.code ?? "none"}`,
        `probe:${input.row.rerun.probe}`,
      ],
    });
  }

  return criteria;
}
