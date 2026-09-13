/**
 * VAL-030 acceptance criteria 1, 2, 4, 5: the longitudinal-baseline
 * platform slice against controlled fakes — the control-run vocabulary
 * (the inert-learning mode, the experiment kind, the contamination and
 * re-run probes), the PURE derivations that make the freeze
 * trustworthy (the workload admission, the canonical control
 * trajectory and its equivalence class, the freeze-integrity matrix —
 * honest agreement, a mutated app artifact / workload revision /
 * recorded trajectory each FAILING, the tamperer who re-declares the
 * digest still caught by the class-membership backstop, an appended
 * correction passing as a NEW registry revision while an in-place edit
 * is unrepresentable, the re-run equivalence, the ledger exactly-once
 * discipline, the accounting honesty, the inert-learning compliance
 * and the terminal↔criteria agreement), the digest discipline
 * (deterministic and payload-free), and the control-run driver over
 * every offline corpus row — including the ADVERSARIAL worlds: a
 * drifting recorded baseline, a drifting re-run, a LEAKY ledger that
 * mints a duplicate identity, and the three learning-contamination
 * shapes (trajectory reuse, caching hints, the competence shortcut).
 */

import { describe, expect, test } from "vitest";
import {
  baselineManifestFor,
  LONGITUDINAL_CORPUS,
  OFFLINE_CORPUS_ROWS,
} from "../../../benchmarks/validation/apps/longitudinal-baseline/corpus";
import {
  createDefaultFrozenBaselineRegistry,
  createFakeControlRecorder,
  createFakeLongitudinalLedger,
  createFrozenBaselineRegistry,
  createInertLearningFake,
  createTickClock,
  SUPERSEDED_RAG_MANIFEST,
  SUPERSEDED_RAG_WORKLOAD,
} from "../../../benchmarks/validation/apps/longitudinal-baseline/fixtures";
import {
  appDigestOf,
  appTrajectoryDigestOf,
  type BaselineAppArtifact,
  type BaselineManifestEntry,
  type BaselineWorkloadRevision,
  CONTROL_EXPERIMENT_KIND,
  CONTROL_LEARNING_MODE,
  CONTROL_ROUND_MODES,
  controlIdentityIdOf,
  controlRunKeyOf,
  controlTrajectoryStepsOf,
  deriveAccountingHonesty,
  deriveFreezeIntegrity,
  deriveInertLearningCompliance,
  deriveLedgerExactlyOnce,
  deriveRerunEquivalence,
  deriveTerminalCriteriaAgreement,
  deriveWorkloadAdmission,
  driveControlRun,
  identityContentDigestOf,
  isLearningContaminationKind,
  isRerunProbe,
  isRetryableDispatchCategory,
  LEARNING_CONTAMINATION_KINDS,
  type LongitudinalCorpusRow,
  longitudinalDigestOf,
  manifestDigestOf,
  RERUN_PROBES,
  TRAJECTORY_STEP_KINDS,
  trajectoryClassOf,
  trajectoryDigestOf,
  trajectoryEventsOf,
  workloadDigestOf,
} from "../../../benchmarks/validation/platform/longitudinal-baseline";

const rowById = (rowId: string): LongitudinalCorpusRow => {
  const row = LONGITUDINAL_CORPUS.find((candidate) => candidate.rowId === rowId);
  if (row === undefined) {
    throw new Error(`unknown corpus row ${rowId}`);
  }
  return row;
};

/** Drive one offline row over a purpose-built fake stack. */
async function driveRowOverStack(options: {
  readonly row: LongitudinalCorpusRow;
  readonly executionId?: string;
  readonly drift?: "rerun" | "recorded";
  readonly leaky?: boolean;
  readonly contaminate?: "trajectory-reuse" | "caching-hint" | "competence-shortcut";
}): Promise<ReturnType<typeof driveControlRun>> {
  const { row } = options;
  const clock = createTickClock();
  const registry = createDefaultFrozenBaselineRegistry();
  const ledger = createFakeLongitudinalLedger({
    ...(options.leaky === undefined ? {} : { leaky: options.leaky }),
  });
  const recorder = createFakeControlRecorder({
    ...(options.drift === undefined ? {} : { drift: options.drift }),
  });
  const learning = createInertLearningFake({
    ...(options.contaminate === undefined ? {} : { contaminate: options.contaminate }),
  });
  return driveControlRun({
    row,
    executionId: options.executionId ?? `exec-unit-${row.rowId}`,
    registry,
    ledger,
    recorder,
    learning,
    now: clock.now,
  });
}

// ---------------------------------------------------------------------------
// The vocabulary + the tokens
// ---------------------------------------------------------------------------

describe("VAL-030 platform vocabulary", () => {
  test("the control-run vocabulary is pinned (inert learning, baseline-measurement)", () => {
    expect(CONTROL_LEARNING_MODE).toBe("inert");
    expect(CONTROL_EXPERIMENT_KIND).toBe("baseline-measurement");
  });

  test("the learning-contamination vocabulary is pinned (three probes)", () => {
    expect(LEARNING_CONTAMINATION_KINDS).toEqual([
      "trajectory-reuse",
      "caching-hint",
      "competence-shortcut",
    ]);
    for (const kind of LEARNING_CONTAMINATION_KINDS) {
      expect(isLearningContaminationKind(kind)).toBe(true);
    }
    expect(isLearningContaminationKind("fabricated")).toBe(false);
  });

  test("the re-run vocabulary is pinned (after-completion)", () => {
    expect(RERUN_PROBES).toEqual(["after-completion"]);
    expect(isRerunProbe("after-completion")).toBe(true);
    expect(isRerunProbe("after-lunch")).toBe(false);
  });

  test("the round modes, step kinds and retry taxonomy are pinned", () => {
    expect(CONTROL_ROUND_MODES).toEqual(["fresh", "reused", "hinted"]);
    expect(TRAJECTORY_STEP_KINDS).toEqual(["dispatch", "effect", "verification"]);
    expect(isRetryableDispatchCategory("transport-failure")).toBe(true);
    expect(isRetryableDispatchCategory("rate-limit")).toBe(true);
    expect(isRetryableDispatchCategory("provider-unavailable")).toBe(true);
    expect(isRetryableDispatchCategory("supervisor-halt")).toBe(false);
    expect(isRetryableDispatchCategory("unknown")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The workload admission (PURE)
// ---------------------------------------------------------------------------

describe("VAL-030 deriveWorkloadAdmission", () => {
  const admittedWorkload: BaselineWorkloadRevision = {
    workloadId: "golden:admission",
    revision: 1,
    dispatchRounds: 1,
    quotaMicro: 5_000,
    effects: [{ effect: "text:summary-written", key: "WS-101", amountMicro: 1_500 }],
  };

  test("a covering quota admits the declared demand", () => {
    const verdict = deriveWorkloadAdmission(admittedWorkload);
    expect(verdict.allowed).toBe(true);
    expect(verdict.reason).toBeNull();
    expect(verdict.demandedMicro).toBe(1_500);
  });

  test("an insufficient quota rejects BEFORE any dispatch or effect work", () => {
    const verdict = deriveWorkloadAdmission(rowById("oversized-batch-guard-rejected").workload);
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toContain("budget guard rejected");
    expect(verdict.demandedMicro).toBe(6_500);
  });

  test("an exactly-covering quota admits (the boundary is inclusive)", () => {
    const verdict = deriveWorkloadAdmission({
      ...admittedWorkload,
      effects: [{ effect: "ops:batch-a", key: "BATCH-601", amountMicro: 5_000 }],
    });
    expect(verdict.allowed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The canonical control trajectory + the equivalence class (PURE)
// ---------------------------------------------------------------------------

describe("VAL-030 controlTrajectoryStepsOf + trajectoryClassOf", () => {
  test("the admitted shape records rounds, effects in the declared order, then verification", () => {
    const row = rowById("rag-retrieval-corrected-baseline");
    const steps = controlTrajectoryStepsOf({ workload: row.workload });
    expect(steps.map((step) => [step.ordinal, step.kind, step.detail])).toEqual([
      [1, "dispatch", "round-1"],
      [2, "dispatch", "round-2"],
      [3, "effect", "rag:citations-attached"],
      [4, "effect", "rag:index-updated"],
      [5, "verification", "criteria-recorded"],
    ]);
  });

  test("the equivalent ordering re-orders ONLY the effect steps", () => {
    const row = rowById("order-settlement-equivalence-class");
    const steps = controlTrajectoryStepsOf({
      workload: row.workload,
      effectOrder: [1, 0],
    });
    expect(steps.map((step) => [step.kind, step.detail])).toEqual([
      ["dispatch", "round-1"],
      ["effect", "order:notify-warehouse"],
      ["effect", "order:notify-customer"],
      ["verification", "criteria-recorded"],
    ]);
  });

  test("the guard-rejected shape records EXACTLY one verification step", () => {
    const row = rowById("oversized-batch-guard-rejected");
    const steps = controlTrajectoryStepsOf({ workload: row.workload });
    expect(steps).toHaveLength(1);
    expect(steps[0]?.kind).toBe("verification");
    expect(steps[0]?.detail).toBe("guard-rejected");
  });

  test("the equivalence class holds one member by default, both orderings when declared", () => {
    const single = rowById("text-summarize-baseline");
    expect(trajectoryClassOf({ workload: single.workload })).toHaveLength(1);
    const dual = rowById("order-settlement-equivalence-class");
    const klass = trajectoryClassOf({
      workload: dual.workload,
      equivalentOrderings: [
        [0, 1],
        [1, 0],
      ],
    });
    expect(klass).toHaveLength(2);
    expect(new Set(klass).size).toBe(2);
    // Each member is the digest of the canonical steps under that ordering.
    for (const [index, order] of (
      [
        [0, 1],
        [1, 0],
      ] as const
    ).entries()) {
      expect(klass[index]).toBe(
        trajectoryDigestOf(
          controlTrajectoryStepsOf({ workload: dual.workload, effectOrder: order }),
        ),
      );
    }
    // The corpus pinned exactly this two-member class.
    expect(dual.expectedTrajectoryClass).toEqual(klass);
  });

  test("the app-side digest re-derives the recorder's basis over the public event view", () => {
    const row = rowById("rag-retrieval-corrected-baseline");
    const steps = controlTrajectoryStepsOf({ workload: row.workload });
    expect(appTrajectoryDigestOf(trajectoryEventsOf(steps))).toBe(trajectoryDigestOf(steps));
    // Colons inside effect details survive the public `${kind}:${detail}`
    // projection (the split is on the FIRST colon only).
    const settlement = controlTrajectoryStepsOf({
      workload: rowById("order-settlement-equivalence-class").workload,
    });
    expect(appTrajectoryDigestOf(trajectoryEventsOf(settlement))).toBe(
      trajectoryDigestOf(settlement),
    );
  });
});

// ---------------------------------------------------------------------------
// The terminal↔criteria agreement (the anyFail→FAILED invariant)
// ---------------------------------------------------------------------------

describe("VAL-030 deriveTerminalCriteriaAgreement (the anyFail→FAILED invariant)", () => {
  test("an honest COMPLETED (all criteria PASS) agrees", () => {
    const verdict = deriveTerminalCriteriaAgreement({
      terminal: "COMPLETED",
      verificationStatuses: ["PASS", "PASS", "PASS"],
    });
    expect(verdict.agreement).toBe(true);
  });

  test("an honest FAILED (the guard criterion FAILs visibly) agrees", () => {
    const verdict = deriveTerminalCriteriaAgreement({
      terminal: "FAILED",
      verificationStatuses: ["FAIL", "PASS"],
    });
    expect(verdict.agreement).toBe(true);
  });

  test("a FABRICATED pass-with-fail (COMPLETED + a FAIL criterion) DISAGREES", () => {
    const verdict = deriveTerminalCriteriaAgreement({
      terminal: "COMPLETED",
      verificationStatuses: ["PASS", "FAIL", "PASS"],
    });
    expect(verdict.agreement).toBe(false);
    expect(verdict.evidence.join(" ")).toContain("fabricated");
  });

  test("a FABRICATED fail-with-all-pass (FAILED + no FAIL criterion) DISAGREES", () => {
    const verdict = deriveTerminalCriteriaAgreement({
      terminal: "FAILED",
      verificationStatuses: ["PASS", "PASS"],
    });
    expect(verdict.agreement).toBe(false);
  });

  test("a missing terminal (a run that never settled) DISAGREES", () => {
    const verdict = deriveTerminalCriteriaAgreement({
      terminal: null,
      verificationStatuses: ["PASS"],
    });
    expect(verdict.agreement).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The freeze-integrity matrix (the manifest digest agreement, every leg)
// ---------------------------------------------------------------------------

describe("VAL-030 deriveFreezeIntegrity (the freeze matrix)", () => {
  const row = rowById("rag-retrieval-corrected-baseline");

  const honestFacts = (overrides?: {
    readonly observedApp?: BaselineAppArtifact;
    readonly observedWorkload?: BaselineWorkloadRevision;
    readonly manifest?: BaselineManifestEntry;
    readonly recordedSteps?: readonly {
      readonly ordinal: number;
      readonly kind: "dispatch" | "effect" | "verification";
      readonly detail: string;
      readonly digest: string;
    }[];
    readonly redeclaredDigest?: string;
  }) => {
    const registry = createDefaultFrozenBaselineRegistry();
    const steps = overrides?.recordedSteps ?? controlTrajectoryStepsOf({ workload: row.workload });
    const declaredDigest =
      overrides?.redeclaredDigest ??
      trajectoryDigestOf(controlTrajectoryStepsOf({ workload: row.workload }));
    return {
      manifest: overrides?.manifest ?? row.manifest,
      observedApp: overrides?.observedApp ?? row.appArtifact,
      observedWorkload: overrides?.observedWorkload ?? row.workload,
      recordedTrajectory: { steps, declaredDigest },
      expectedTrajectoryClass: row.expectedTrajectoryClass,
      registryEntry: registry.entryFor({
        appId: row.manifest.appId,
        workloadId: row.manifest.workloadId,
        workloadRevision: row.manifest.workloadRevision,
      }),
    };
  };

  test("the honest world agrees on EVERY leg", () => {
    const verdict = deriveFreezeIntegrity(honestFacts());
    expect(verdict.manifestSelfAgreement).toBe(true);
    expect(verdict.appArtifactAgreement).toBe(true);
    expect(verdict.workloadRevisionAgreement).toBe(true);
    expect(verdict.recordedTrajectoryAgreement).toBe(true);
    expect(verdict.registryAgreement).toBe(true);
    expect(verdict.agreed).toBe(true);
    expect(verdict.criteria.every((criterion) => criterion.status === "PASS")).toBe(true);
  });

  test("the pre-run freeze check (no recorded trajectory yet) passes on the manifest legs", () => {
    const facts = honestFacts();
    const verdict = deriveFreezeIntegrity({ ...facts, recordedTrajectory: null });
    expect(verdict.agreed).toBe(true);
    expect(
      verdict.criteria.find(
        (criterion) => criterion.criterionId === "recorded-trajectory-agreement",
      )?.status,
    ).toBe("PASS");
    expect(
      (
        verdict.criteria.find(
          (criterion) => criterion.criterionId === "recorded-trajectory-agreement",
        )?.evidence ?? []
      ).join(" "),
    ).toContain("not-yet-recorded");
  });

  test("a MUTATED app artifact FAILS the digest check", () => {
    const verdict = deriveFreezeIntegrity(
      honestFacts({ observedApp: { ...row.appArtifact, appVersion: "v2" } }),
    );
    expect(verdict.appArtifactAgreement).toBe(false);
    expect(verdict.agreed).toBe(false);
    expect(
      verdict.criteria.find((criterion) => criterion.criterionId === "app-artifact-agreement")
        ?.status,
    ).toBe("FAIL");
  });

  test("a MUTATED workload revision FAILS the digest check", () => {
    const verdict = deriveFreezeIntegrity(
      honestFacts({
        observedWorkload: { ...row.workload, quotaMicro: 6_001 },
      }),
    );
    expect(verdict.workloadRevisionAgreement).toBe(false);
    expect(verdict.agreed).toBe(false);
  });

  test("a MUTATED workload revision NUMBER (same digest-bearing content) FAILs too", () => {
    const verdict = deriveFreezeIntegrity(
      honestFacts({ observedWorkload: { ...row.workload, revision: 3 } }),
    );
    expect(verdict.workloadRevisionAgreement).toBe(false);
    expect(verdict.agreed).toBe(false);
  });

  test("a MUTATED recorded trajectory FAILS the digest check", () => {
    const steps = controlTrajectoryStepsOf({ workload: row.workload });
    const mutated = steps.map((step, index) =>
      index === steps.length - 1 ? { ...step, detail: `${step.detail}:drifted` } : step,
    );
    const verdict = deriveFreezeIntegrity(honestFacts({ recordedSteps: mutated }));
    expect(verdict.recordedTrajectoryAgreement).toBe(false);
    expect(verdict.agreed).toBe(false);
  });

  test("a tamperer who edits the steps AND re-declares the digest is caught by the class backstop", () => {
    const steps = controlTrajectoryStepsOf({ workload: row.workload });
    const mutated = steps.map((step, index) =>
      index === steps.length - 1 ? { ...step, detail: `${step.detail}:drifted` } : step,
    );
    // The digest is recomputed over the mutated steps (self-consistent)
    // — but the mutated trajectory is OUT of the pinned class.
    const verdict = deriveFreezeIntegrity(
      honestFacts({ recordedSteps: mutated, redeclaredDigest: trajectoryDigestOf(mutated) }),
    );
    expect(verdict.recordedTrajectoryAgreement).toBe(false);
    expect(verdict.agreed).toBe(false);
    expect(
      (
        verdict.criteria.find(
          (criterion) => criterion.criterionId === "recorded-trajectory-agreement",
        )?.evidence ?? []
      ).join(" "),
    ).toContain("classMembership:false");
  });

  test("a tampered manifest self-digest FAILs its own leg", () => {
    const verdict = deriveFreezeIntegrity(
      honestFacts({ manifest: { ...row.manifest, manifestDigest: "deadbeef" } }),
    );
    expect(verdict.manifestSelfAgreement).toBe(false);
    expect(verdict.agreed).toBe(false);
  });

  test("an appended correction passes as a NEW registry revision (never an edit)", () => {
    const registry = createFrozenBaselineRegistry();
    // The correction history: r1 (superseded), r2 (the corpus pin), r3 (a
    // later correction) — each a NEW append-only commit.
    registry.commit(SUPERSEDED_RAG_MANIFEST, "2025-01-01T00:00:00.000Z");
    registry.commit(row.manifest, "2025-01-01T00:01:00.000Z");
    const ragApp: BaselineAppArtifact = {
      appId: "portfolio:rag",
      appVersion: "v1",
      taskKind: "rag.retrieve.v1",
      integrationSurface: "sdk",
    };
    const correction: BaselineWorkloadRevision = {
      ...SUPERSEDED_RAG_WORKLOAD,
      revision: 3,
      quotaMicro: 6_500,
    };
    const correctionManifest = baselineManifestFor(ragApp, correction);
    registry.commit(correctionManifest, "2025-02-01T00:00:00.000Z");
    // The append-only history holds ALL THREE revisions in order.
    expect(
      registry
        .historyOf("portfolio:rag", "golden:rag-retrieval")
        .map((entry) => entry.workloadRevision),
    ).toEqual([1, 2, 3]);
    // The freeze verdict over the NEW revision agrees on every leg.
    const verdict = deriveFreezeIntegrity({
      manifest: correctionManifest,
      observedApp: ragApp,
      observedWorkload: correction,
      recordedTrajectory: null,
      expectedTrajectoryClass: trajectoryClassOf({ workload: correction }),
      registryEntry: registry.entryFor({
        appId: "portfolio:rag",
        workloadId: "golden:rag-retrieval",
        workloadRevision: 3,
      }),
    });
    expect(verdict.agreed).toBe(true);
  });

  test("an edit of a committed revision is refused by the honest registry and FAILs the freeze through the adversarial one", () => {
    // The honest registry REFUSES the edit outright (append-only).
    const honest = createDefaultFrozenBaselineRegistry();
    const row = rowById("text-summarize-baseline");
    const mutatedManifest: BaselineManifestEntry = {
      ...row.manifest,
      workloadDigest: "deadbeef",
      manifestDigest: manifestDigestOf({
        appId: row.manifest.appId,
        appDigest: row.manifest.appDigest,
        workloadId: row.manifest.workloadId,
        workloadRevision: row.manifest.workloadRevision,
        workloadDigest: "deadbeef",
      }),
    };
    expect(() => honest.commit(mutatedManifest, "2025-03-01T00:00:00.000Z")).toThrow(
      "append-only violation",
    );
    // The ADVERSARIAL registry overwrites the committed pin in place —
    // the freeze-integrity derivation must FAIL the edited pin.
    const adversarial = createFrozenBaselineRegistry({ admitEdits: true });
    const clock = createTickClock();
    const originalEntry = adversarial.commit(row.manifest, "2025-01-01T00:00:00.000Z");
    const editedEntry = adversarial.commit(mutatedManifest, "2025-03-01T00:00:00.000Z");
    expect(editedEntry.manifest.manifestDigest).not.toBe(originalEntry.manifest.manifestDigest);
    const verdict = deriveFreezeIntegrity({
      manifest: row.manifest,
      observedApp: row.appArtifact,
      observedWorkload: row.workload,
      recordedTrajectory: null,
      expectedTrajectoryClass: row.expectedTrajectoryClass,
      registryEntry: adversarial.entryFor({
        appId: row.manifest.appId,
        workloadId: row.manifest.workloadId,
        workloadRevision: row.manifest.workloadRevision,
      }),
    });
    expect(verdict.registryAgreement).toBe(false);
    expect(verdict.agreed).toBe(false);
    expect(clock.now().getTime()).toBeGreaterThanOrEqual(0);
  });

  test("a pin that was never committed FAILs the registry leg", () => {
    const facts = honestFacts();
    const verdict = deriveFreezeIntegrity({ ...facts, registryEntry: null });
    expect(verdict.registryAgreement).toBe(false);
    expect(verdict.agreed).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The re-run equivalence (the control re-run's class membership)
// ---------------------------------------------------------------------------

describe("VAL-030 deriveRerunEquivalence", () => {
  test("an honest re-run (the observed digest is a class member) reproduces", () => {
    const row = rowById("text-summarize-baseline");
    const [member] = row.expectedTrajectoryClass;
    const verdict = deriveRerunEquivalence({
      expectedClass: row.expectedTrajectoryClass,
      observedTrajectoryDigest: member ?? "",
    });
    expect(verdict.reproduced).toBe(true);
    expect(verdict.classSize).toBe(1);
    expect(verdict.criteria.every((criterion) => criterion.status === "PASS")).toBe(true);
  });

  test("a DRIFTING re-run (outside the recorded class) FAILs", () => {
    const row = rowById("text-summarize-baseline");
    const verdict = deriveRerunEquivalence({
      expectedClass: row.expectedTrajectoryClass,
      observedTrajectoryDigest: longitudinalDigestOf("drifted"),
    });
    expect(verdict.reproduced).toBe(false);
    expect(verdict.criteria[0]?.status).toBe("FAIL");
    expect(verdict.criteria[0]?.evidence.join(" ")).toContain("DRIFTED");
  });

  test("either equivalent ordering reproduces a multi-member class; a degenerate class never does", () => {
    const row = rowById("order-settlement-equivalence-class");
    for (const member of row.expectedTrajectoryClass) {
      expect(
        deriveRerunEquivalence({
          expectedClass: row.expectedTrajectoryClass,
          observedTrajectoryDigest: member,
        }).reproduced,
      ).toBe(true);
    }
    expect(
      deriveRerunEquivalence({ expectedClass: [], observedTrajectoryDigest: "00000000" })
        .reproduced,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The ledger exactly-once discipline (VAL-007)
// ---------------------------------------------------------------------------

describe("VAL-030 deriveLedgerExactlyOnce", () => {
  const runKey = "control:portfolio:research:golden:research-digest:r1:exec-1";
  const contentDigest = identityContentDigestOf({
    manifestDigest: "f9fd5b2b",
    trajectoryDigest: "1c2d3e4f",
  });

  const factsFor = (
    identities: readonly {
      readonly identityId: string;
      readonly runKey: string;
      readonly contentDigest: string;
    }[],
  ) => ({ identities });

  test("the honest ledger holds exactly ONE stable immutable identity", () => {
    const identityId = controlIdentityIdOf(runKey);
    const verdict = deriveLedgerExactlyOnce({
      runKey,
      ledgerFacts: factsFor([{ identityId, runKey, contentDigest }]),
      observations: [{ contentDigest, identityId, replayed: false, refused: false }],
    });
    expect(verdict.exactlyOnce).toBe(true);
    expect(verdict.duplicateCount).toBe(1);
    expect(verdict.identityStable).toBe(true);
    expect(verdict.contentImmutable).toBe(true);
    expect(verdict.reobservationReplayed).toBe(true);
    expect(verdict.criteria.every((criterion) => criterion.status === "PASS")).toBe(true);
  });

  test("a DUPLICATE identity for one control run FAILs (the LEAKY ledger)", () => {
    const identityId = controlIdentityIdOf(runKey);
    const verdict = deriveLedgerExactlyOnce({
      runKey,
      ledgerFacts: factsFor([
        { identityId, runKey, contentDigest },
        { identityId: `${identityId}-dup-2`, runKey, contentDigest },
      ]),
      observations: [
        { contentDigest, identityId, replayed: false, refused: false },
        { contentDigest, identityId: `${identityId}-dup-2`, replayed: false, refused: false },
      ],
    });
    expect(verdict.exactlyOnce).toBe(false);
    expect(verdict.duplicateCount).toBe(2);
    expect(
      verdict.criteria.find((criterion) => criterion.criterionId === "ledger-exactly-once")?.status,
    ).toBe("FAIL");
  });

  test("the control re-run re-observes the SAME identity (never a second one)", () => {
    const identityId = controlIdentityIdOf(runKey);
    const verdict = deriveLedgerExactlyOnce({
      runKey,
      ledgerFacts: factsFor([{ identityId, runKey, contentDigest }]),
      observations: [
        { contentDigest, identityId, replayed: false, refused: false },
        { contentDigest, identityId, replayed: true, refused: false },
      ],
    });
    expect(verdict.exactlyOnce).toBe(true);
    expect(verdict.reobservationReplayed).toBe(true);
    expect(verdict.criteria.every((criterion) => criterion.status === "PASS")).toBe(true);
  });

  test("a re-run that MINTED a second identity FAILs the re-observation leg", () => {
    const identityId = controlIdentityIdOf(runKey);
    const verdict = deriveLedgerExactlyOnce({
      runKey,
      ledgerFacts: factsFor([
        { identityId, runKey, contentDigest },
        { identityId: `${identityId}-dup-2`, runKey, contentDigest },
      ]),
      observations: [
        { contentDigest, identityId, replayed: false, refused: false },
        { contentDigest, identityId: `${identityId}-dup-2`, replayed: false, refused: false },
      ],
    });
    expect(verdict.reobservationReplayed).toBe(false);
  });

  test("a re-run the ledger REFUSED (drifted identity content) FAILs", () => {
    const identityId = controlIdentityIdOf(runKey);
    const verdict = deriveLedgerExactlyOnce({
      runKey,
      ledgerFacts: factsFor([{ identityId, runKey, contentDigest }]),
      observations: [
        { contentDigest, identityId, replayed: false, refused: false },
        { contentDigest: "aaaaaaaa", identityId, replayed: false, refused: true },
      ],
    });
    expect(verdict.reobservationReplayed).toBe(false);
    expect(verdict.contentImmutable).toBe(false);
  });

  test("an identity NOT in the derived stable form FAILs the stability leg", () => {
    const verdict = deriveLedgerExactlyOnce({
      runKey,
      ledgerFacts: factsFor([{ identityId: "exp-made-up-1234", runKey, contentDigest }]),
      observations: [
        { contentDigest, identityId: "exp-made-up-1234", replayed: false, refused: false },
      ],
    });
    expect(verdict.identityStable).toBe(false);
    expect(
      verdict.criteria.find((criterion) => criterion.criterionId === "ledger-identity-stable")
        ?.status,
    ).toBe("FAIL");
  });
});

// ---------------------------------------------------------------------------
// The accounting honesty (measured or honestly none — never estimated)
// ---------------------------------------------------------------------------

describe("VAL-030 deriveAccountingHonesty", () => {
  test("an offline row reports NO usage honestly (latency still measured)", () => {
    const verdict = deriveAccountingHonesty({
      needsDispatch: false,
      usage: null,
      latencyMs: 12,
    });
    expect(verdict.honest).toBe(true);
    expect(verdict.criteria.every((criterion) => criterion.status === "PASS")).toBe(true);
  });

  test("an offline row that FABRICATES usage FAILs (no model was dispatched)", () => {
    const verdict = deriveAccountingHonesty({
      needsDispatch: false,
      usage: { inputTokens: 1, outputTokens: 1 },
      latencyMs: 12,
    });
    expect(verdict.honest).toBe(false);
    expect(
      (
        verdict.criteria.find((criterion) => criterion.criterionId === "usage-honest")?.evidence ??
        []
      ).join(" "),
    ).toContain("FABRICATED");
  });

  test("a live row demands MEASURED usage; its absence FAILs", () => {
    expect(
      deriveAccountingHonesty({
        needsDispatch: true,
        usage: { inputTokens: 30, outputTokens: 6 },
        latencyMs: 44,
      }).honest,
    ).toBe(true);
    expect(
      deriveAccountingHonesty({ needsDispatch: true, usage: null, latencyMs: 44 }).honest,
    ).toBe(false);
  });

  test("latency is NEVER estimated (null or negative FAILs)", () => {
    expect(
      deriveAccountingHonesty({ needsDispatch: false, usage: null, latencyMs: null }).honest,
    ).toBe(false);
    expect(
      deriveAccountingHonesty({ needsDispatch: false, usage: null, latencyMs: -1 }).honest,
    ).toBe(false);
    expect(
      deriveAccountingHonesty({ needsDispatch: false, usage: null, latencyMs: 0 }).honest,
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The inert-learning compliance (the control-run semantics)
// ---------------------------------------------------------------------------

describe("VAL-030 deriveInertLearningCompliance", () => {
  test("an all-fresh run with the verification boundary intact is INERT", () => {
    const verdict = deriveInertLearningCompliance({
      rounds: [{ mode: "fresh" }, { mode: "fresh" }],
      verificationShortcutUsed: false,
      expectedRounds: 2,
    });
    expect(verdict.inert).toBe(true);
    expect(verdict.contamination).toBeNull();
    expect(verdict.criteria.every((criterion) => criterion.status === "PASS")).toBe(true);
  });

  test("a REUSED round names trajectory-reuse and under-dispatches", () => {
    const verdict = deriveInertLearningCompliance({
      rounds: [{ mode: "fresh" }, { mode: "reused" }],
      verificationShortcutUsed: false,
      expectedRounds: 2,
    });
    expect(verdict.inert).toBe(false);
    expect(verdict.contamination).toBe("trajectory-reuse");
    expect(
      verdict.criteria.find((criterion) => criterion.criterionId === "control-own-dispatches")
        ?.status,
    ).toBe("FAIL");
  });

  test("a HINTED round names caching-hint (the trajectory shape alone never catches it)", () => {
    const verdict = deriveInertLearningCompliance({
      rounds: [{ mode: "hinted" }, { mode: "hinted" }],
      verificationShortcutUsed: false,
      expectedRounds: 2,
    });
    expect(verdict.inert).toBe(false);
    expect(verdict.contamination).toBe("caching-hint");
    // The rounds still dispatched — only the inert contract catches the hint.
    expect(
      verdict.criteria.find((criterion) => criterion.criterionId === "control-own-dispatches")
        ?.status,
    ).toBe("PASS");
  });

  test("a verification SHORTCUT names competence-shortcut; under-dispatching rounds fail too", () => {
    expect(
      deriveInertLearningCompliance({
        rounds: [{ mode: "fresh" }, { mode: "fresh" }],
        verificationShortcutUsed: true,
        expectedRounds: 2,
      }).contamination,
    ).toBe("competence-shortcut");
    expect(
      deriveInertLearningCompliance({
        rounds: [{ mode: "fresh" }],
        verificationShortcutUsed: false,
        expectedRounds: 3,
      }).inert,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The digest discipline + the identity derivations
// ---------------------------------------------------------------------------

describe("VAL-030 digest discipline", () => {
  test("the digests are deterministic, distinct and payload-free", () => {
    const artifact: BaselineAppArtifact = {
      appId: "portfolio:rag",
      appVersion: "v1",
      taskKind: "rag.retrieve.v1",
      integrationSurface: "sdk",
    };
    const workload: BaselineWorkloadRevision = {
      workloadId: "golden:rag-retrieval",
      revision: 2,
      dispatchRounds: 2,
      quotaMicro: 6_000,
      effects: [
        { effect: "rag:citations-attached", key: "CIT-201", amountMicro: 2_200 },
        { effect: "rag:index-updated", key: "IDX-201", amountMicro: 800 },
      ],
    };
    // Deterministic and well-shaped.
    expect(appDigestOf(artifact)).toBe(appDigestOf(artifact));
    expect(workloadDigestOf(workload)).toBe(workloadDigestOf(workload));
    for (const digest of [appDigestOf(artifact), workloadDigestOf(workload)]) {
      expect(digest).toMatch(/^[0-9a-f]{8}$/);
    }
    // Distinct inputs, distinct digests.
    expect(appDigestOf({ ...artifact, appVersion: "v2" })).not.toBe(appDigestOf(artifact));
    expect(longitudinalDigestOf("a")).not.toBe(longitudinalDigestOf("b"));
    // The digests never leak the payload bytes.
    expect(appDigestOf(artifact)).not.toContain("portfolio:rag");
    expect(workloadDigestOf(workload)).not.toContain("CIT-201");
    expect(workloadDigestOf(workload)).not.toContain("2200");
  });

  test("the control identity derivations are stable and content-derived", () => {
    const row = rowById("research-digest-rerun-equivalence");
    const executionId = "exec-identity";
    const runKey = controlRunKeyOf({ executionId, manifest: row.manifest });
    expect(runKey).toBe(
      [
        "control",
        row.manifest.appId,
        row.manifest.workloadId,
        `r${row.manifest.workloadRevision}`,
        executionId,
      ].join(":"),
    );
    const identityId = controlIdentityIdOf(runKey);
    expect(identityId).toBe(`exp-${CONTROL_EXPERIMENT_KIND}-${longitudinalDigestOf(runKey)}`);
    // The identity's content digest binds the manifest + trajectory digests.
    expect(
      identityContentDigestOf({ manifestDigest: "aaaaaaaa", trajectoryDigest: "bbbbbbbb" }),
    ).toBe(identityContentDigestOf({ manifestDigest: "aaaaaaaa", trajectoryDigest: "bbbbbbbb" }));
    expect(
      identityContentDigestOf({ manifestDigest: "aaaaaaaa", trajectoryDigest: "cccccccc" }),
    ).not.toBe(
      identityContentDigestOf({ manifestDigest: "aaaaaaaa", trajectoryDigest: "bbbbbbbb" }),
    );
  });
});

// ---------------------------------------------------------------------------
// The driver over every offline row (the honest stack)
// ---------------------------------------------------------------------------

describe("VAL-030 driver over the honest offline corpus", () => {
  test("every offline row reaches its oracle terminal with every criterion PASS", async () => {
    for (const row of OFFLINE_CORPUS_ROWS) {
      const result = await driveRowOverStack({ row });
      expect(result.terminal, `${row.rowId} terminal`).toBe(row.expected.terminal);
      const failed = result.criteria.filter((criterion) => criterion.status === "FAIL");
      expect(failed, `${row.rowId}: ${JSON.stringify(failed)}`).toEqual([]);
      // The trajectory digest is IN the pinned class.
      expect(result.trajectoryDigest).not.toBeNull();
      expect(row.expectedTrajectoryClass).toContain(result.trajectoryDigest);
      // The control run made its OWN dispatches.
      expect(result.observedModelCalls).toBe(row.expectedModelCalls);
      // Exactly ONE immutable ledger identity in the derived stable form.
      expect(result.identityId).toBe(
        controlIdentityIdOf(
          controlRunKeyOf({ executionId: `exec-unit-${row.rowId}`, manifest: row.manifest }),
        ),
      );
      expect(result.freeze.agreed).toBe(true);
      expect(result.ledger.exactlyOnce).toBe(true);
      expect(result.learning.inert).toBe(true);
      expect(result.accounting.honest).toBe(true);
    }
  });

  test("the guard-rejected row fails BEFORE any dispatch (the honest precondition shape)", async () => {
    const row = rowById("oversized-batch-guard-rejected");
    const result = await driveRowOverStack({ row });
    expect(result.terminal).toBe("FAILED");
    expect(result.failure?.category).toBe("precondition-rejected");
    expect(result.observedModelCalls).toBe(0);
    expect(result.usage).toBeNull();
    // The recorded trajectory is EXACTLY the guard-rejection shape.
    expect(result.trajectoryDigest).toBe(row.expectedTrajectoryClass[0]);
    expect(result.trajectoryDigest).toBe(
      trajectoryDigestOf(controlTrajectoryStepsOf({ workload: row.workload })),
    );
  });

  test("the re-run row reproduces the recorded class and NEVER mints a second identity", async () => {
    const row = rowById("research-digest-rerun-equivalence");
    const result = await driveRowOverStack({ row });
    expect(result.terminal).toBe("COMPLETED");
    expect(result.rerun?.reproduced).toBe(true);
    expect(result.rerunTrajectoryDigest).toBe(result.trajectoryDigest);
    expect(result.ledger.exactlyOnce).toBe(true);
    expect(result.ledger.reobservationReplayed).toBe(true);
    expect(result.ledger.duplicateCount).toBe(1);
    expect(
      result.criteria.find(
        (criterion) => criterion.criterionId === "rerun-trajectory-class-membership",
      )?.status,
    ).toBe("PASS");
  });

  test("the equivalence-class row reproduces the class under its first declared ordering", async () => {
    const row = rowById("order-settlement-equivalence-class");
    const result = await driveRowOverStack({ row });
    expect(result.terminal).toBe("COMPLETED");
    expect(result.trajectoryDigest).toBe(row.expectedTrajectoryClass[0]);
    expect(row.expectedTrajectoryClass).toContain(result.trajectoryDigest ?? "");
    expect(row.expectedTrajectoryClass).toHaveLength(2);
  });

  test("a dispatch row without a dispatch seam is a configuration error", async () => {
    const row = LONGITUDINAL_CORPUS.find((candidate) => candidate.needsDispatch);
    expect(row).toBeDefined();
    const clock = createTickClock();
    await expect(
      driveControlRun({
        row: row as LongitudinalCorpusRow,
        executionId: "exec-live",
        registry: createDefaultFrozenBaselineRegistry(),
        ledger: createFakeLongitudinalLedger(),
        recorder: createFakeControlRecorder(),
        learning: createInertLearningFake(),
        now: clock.now,
      }),
    ).rejects.toThrow("demands a dispatch seam");
  });
});

// ---------------------------------------------------------------------------
// The adversarial worlds (the drift / leak / contamination catches)
// ---------------------------------------------------------------------------

describe("VAL-030 adversarial control-run worlds", () => {
  test("a DRIFTED recorded baseline FAILs the freeze (a drifting baseline is unrepresentable)", async () => {
    const row = rowById("rag-retrieval-corrected-baseline");
    const result = await driveRowOverStack({ row, drift: "recorded" });
    expect(result.terminal).toBe("FAILED");
    expect(result.freeze.recordedTrajectoryAgreement).toBe(false);
    expect(
      result.criteria.find((criterion) => criterion.criterionId === "recorded-trajectory-agreement")
        ?.status,
    ).toBe("FAIL");
  });

  test("a DRIFTED re-run FAILs the re-run equivalence", async () => {
    const row = rowById("research-digest-rerun-equivalence");
    const result = await driveRowOverStack({ row, drift: "rerun" });
    expect(result.terminal).toBe("FAILED");
    expect(result.rerun?.reproduced).toBe(false);
    expect(result.rerunTrajectoryDigest).not.toBe(result.trajectoryDigest);
    expect(
      result.criteria.find(
        (criterion) => criterion.criterionId === "rerun-trajectory-class-membership",
      )?.status,
    ).toBe("FAIL");
  });

  test("a LEAKY ledger (a duplicate identity) FAILs the exactly-once discipline", async () => {
    const row = rowById("research-digest-rerun-equivalence");
    const result = await driveRowOverStack({ row, leaky: true });
    expect(result.terminal).toBe("FAILED");
    expect(result.ledger.exactlyOnce).toBe(false);
    expect(result.ledger.duplicateCount).toBe(2);
    expect(
      result.criteria.find((criterion) => criterion.criterionId === "ledger-exactly-once")?.status,
    ).toBe("FAIL");
  });

  test("a trajectory-REUSE contaminated run FAILs the control contract", async () => {
    const row = rowById("probe-reuse-contamination");
    const result = await driveRowOverStack({ row, contaminate: "trajectory-reuse" });
    expect(result.terminal).toBe("FAILED");
    expect(result.learning.inert).toBe(false);
    expect(result.learning.contamination).toBe("trajectory-reuse");
    expect(result.observedModelCalls).toBe(0);
    expect(
      result.criteria.find((criterion) => criterion.criterionId === "control-own-dispatch-count")
        ?.status,
    ).toBe("FAIL");
    // The reused round recorded NO dispatch step — the trajectory is
    // mechanically out of the recorded class.
    expect(
      result.criteria.find((criterion) => criterion.criterionId === "trajectory-class-membership")
        ?.status,
    ).toBe("FAIL");
  });

  test("a caching-HINT contaminated run FAILs the inert contract (the trajectory alone never catches it)", async () => {
    const row = rowById("probe-caching-hint-contamination");
    const result = await driveRowOverStack({ row, contaminate: "caching-hint" });
    expect(result.terminal).toBe("FAILED");
    expect(result.learning.contamination).toBe("caching-hint");
    expect(result.observedModelCalls).toBe(row.expectedModelCalls);
    expect(
      result.criteria.find((criterion) => criterion.criterionId === "control-learning-inert")
        ?.status,
    ).toBe("FAIL");
  });

  test("a competence-SHORTCUT contaminated run FAILs (the verification step is missing)", async () => {
    const row = rowById("probe-competence-shortcut-contamination");
    const result = await driveRowOverStack({ row, contaminate: "competence-shortcut" });
    expect(result.terminal).toBe("FAILED");
    expect(result.learning.contamination).toBe("competence-shortcut");
    expect(
      result.criteria.find((criterion) => criterion.criterionId === "trajectory-class-membership")
        ?.status,
    ).toBe("FAIL");
  });
});
