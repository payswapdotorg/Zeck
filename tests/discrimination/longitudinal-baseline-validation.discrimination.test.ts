/**
 * VAL-030 acceptance criterion 6 — discrimination tests proving the
 * baseline freeze against controlled fakes (the four AC6 families):
 *
 *   * the MUTATED BASELINE ARTIFACT — an observed app artifact that no
 *     longer digests to the pinned app digest, an observed workload
 *     revision whose content was edited under the SAME revision number,
 *     a recorded trajectory that drifted after the registry commit, a
 *     tamperer who edits the recorded steps AND re-declares the digest,
 *     and an in-place EDIT of a committed registry pin each FAIL the
 *     freeze-integrity derivation (a drifting baseline is
 *     unrepresentable) — the honest registry refuses the edit outright;
 *
 *   * the LEARNING-CONTAMINATED RUN MASQUERADING AS CONTROL — each of
 *     the three contamination kinds (trajectory-reuse: the round
 *     dispatches NOTHING; caching-hint: the round dispatches WITH a
 *     hint only the inert contract can catch; competence-shortcut: the
 *     verification boundary is skipped) FAILs the inert-learning
 *     compliance and the row, including the reuse shape surfaced
 *     through the PUBLIC wire at the customer boundary — while the
 *     honest inert control passes like any baseline;
 *
 *   * the DUPLICATED LEDGER IDENTITY — a LEAKY ledger that admits a
 *     second immutable identity for ONE control run FAILs the
 *     exactly-once discipline; the fabricated minted-identity and
 *     refused-drift shapes FAIL the derivation too — the honest re-run
 *     re-observes the SAME identity and NEVER mints one;
 *
 *   * the TRAJECTORY DRIFT BETWEEN RE-RUNS — a drifting re-run whose
 *     trajectory digest lands outside the recorded equivalence class
 *     FAILs the re-run equivalence (through the recorder fake AND
 *     through the derivation over a fabricated drifted digest), and
 *     the drifting recorder between the run and the re-run FAILs the
 *     app's re-run class membership at the customer boundary — the
 *     honest re-run reproduces the class.
 */

import { describe, expect, test } from "vitest";
import { runLongitudinalApp } from "../../benchmarks/validation/apps/longitudinal-baseline/application";
import {
  LONGITUDINAL_CORPUS,
  OFFLINE_CORPUS_ROWS,
} from "../../benchmarks/validation/apps/longitudinal-baseline/corpus";
import {
  createDefaultFrozenBaselineRegistry,
  createFakeControlRecorder,
  createFakeLongitudinalLedger,
  createFrozenBaselineRegistry,
  createInertLearningFake,
  createLongitudinalFakeApiWorld,
  createTickClock,
} from "../../benchmarks/validation/apps/longitudinal-baseline/fixtures";
import {
  type BaselineAppArtifact,
  type BaselineManifestEntry,
  type BaselineWorkloadRevision,
  controlIdentityIdOf,
  controlRunKeyOf,
  controlTrajectoryStepsOf,
  deriveFreezeIntegrity,
  deriveLedgerExactlyOnce,
  deriveRerunEquivalence,
  driveControlRun,
  identityContentDigestOf,
  type LearningContaminationKind,
  type LongitudinalCorpusRow,
  manifestDigestOf,
  trajectoryDigestOf,
} from "../../benchmarks/validation/platform/longitudinal-baseline";

const REVISION = "4d4ab310d066a775e3d47f40e8f0b4cd02073371";

const rowById = (rowId: string): LongitudinalCorpusRow => {
  const row = LONGITUDINAL_CORPUS.find((candidate) => candidate.rowId === rowId);
  if (row === undefined) {
    throw new Error(`unknown corpus row ${rowId}`);
  }
  return row;
};

const taskIndexOf = (rowId: string): number => {
  const index = LONGITUDINAL_CORPUS.findIndex((candidate) => candidate.rowId === rowId);
  if (index < 0) {
    throw new Error(`unknown corpus row ${rowId}`);
  }
  return index;
};

/** Drive one offline row over a purpose-built fake stack (the adversarial variants). */
async function driveRowOverStack(options: {
  readonly row: LongitudinalCorpusRow;
  readonly registry?: ReturnType<typeof createDefaultFrozenBaselineRegistry>;
  readonly drift?: "rerun" | "recorded";
  readonly leaky?: boolean;
  readonly contaminate?: LearningContaminationKind;
}): Promise<ReturnType<typeof driveControlRun>> {
  const { row } = options;
  const clock = createTickClock();
  const registry = options.registry ?? createDefaultFrozenBaselineRegistry();
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
    executionId: `exec-disc-${row.rowId}`,
    registry,
    ledger,
    recorder,
    learning,
    now: clock.now,
  });
}

/** Run one app row over the fake API world (the customer-boundary catch). */
async function runAppOverFakeWorld(options: {
  readonly rowId: string;
  readonly contaminatedLearning?: boolean;
  readonly driftRecorder?: boolean;
}): Promise<Awaited<ReturnType<typeof runLongitudinalApp>>> {
  const clock = createTickClock();
  const world = createLongitudinalFakeApiWorld({
    clock,
    ...(options.contaminatedLearning === undefined
      ? {}
      : { contaminatedLearning: options.contaminatedLearning }),
    ...(options.driftRecorder === undefined ? {} : { driftRecorder: options.driftRecorder }),
  });
  return runLongitudinalApp({
    config: {
      applicationId: "app-1",
      baseUrl: "http://fake-zeck.local",
      tokenEnvVar: "ZECK_VALIDATION_TOKEN",
      applicationRevision: REVISION,
      corpusRevision: REVISION,
      integrationSurface: "sdk",
      pollIntervalMs: 1,
      completionTimeoutMs: 5_000,
    },
    token: "zeck-token-fake",
    transport: world.transport,
    now: clock.now,
    sleep: async (ms) => {
      clock.advance(ms);
    },
    environment: {
      runtime: "node test",
      toolchain: "vitest",
      database: "none",
      configuration: { suite: "val-030-discrimination" },
    },
    runSuffix: "disc",
    taskIndex: taskIndexOf(options.rowId),
  });
}

// ---------------------------------------------------------------------------
// Family 1: the mutated baseline artifact (the freeze-integrity catch)
// ---------------------------------------------------------------------------

describe("VAL-030 discrimination: the mutated baseline artifact (freeze integrity)", () => {
  const row = rowById("rag-retrieval-corrected-baseline");

  /** The honest freeze facts (the control shape the mutations diverge from). */
  const honestFacts = (overrides?: {
    readonly observedApp?: BaselineAppArtifact;
    readonly observedWorkload?: BaselineWorkloadRevision;
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
      manifest: row.manifest,
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

  test("a MUTATED app artifact (the observed app drifted from the pinned digest) FAILs", () => {
    const verdict = deriveFreezeIntegrity(
      honestFacts({
        observedApp: { ...row.appArtifact, appVersion: "v2-mutated" },
      }),
    );
    expect(verdict.appArtifactAgreement).toBe(false);
    expect(verdict.agreed).toBe(false);
    expect(
      verdict.criteria.find((criterion) => criterion.criterionId === "app-artifact-agreement")
        ?.status,
    ).toBe("FAIL");
    expect(
      (
        verdict.criteria.find((criterion) => criterion.criterionId === "app-artifact-agreement")
          ?.evidence ?? []
      ).join(" "),
    ).toContain("mutated after the registry commit");
  });

  test("a MUTATED workload revision (committed content edited under the SAME number) FAILs", () => {
    // The tamperer edits an effect amount but keeps the revision number —
    // a correction must be a NEW revision, never an edit.
    const observed: BaselineWorkloadRevision = {
      ...row.workload,
      effects: row.workload.effects.map((effect, index) =>
        index === 0 ? { ...effect, amountMicro: effect.amountMicro + 1 } : effect,
      ),
    };
    const verdict = deriveFreezeIntegrity(honestFacts({ observedWorkload: observed }));
    expect(verdict.workloadRevisionAgreement).toBe(false);
    expect(verdict.agreed).toBe(false);
    expect(
      verdict.criteria.find((criterion) => criterion.criterionId === "workload-revision-agreement")
        ?.status,
    ).toBe("FAIL");
    expect(
      (
        verdict.criteria.find(
          (criterion) => criterion.criterionId === "workload-revision-agreement",
        )?.evidence ?? []
      ).join(" "),
    ).toContain("must be a NEW revision");
  });

  test("a MUTATED recorded trajectory (post-capture drift) FAILs the driven control run", async () => {
    const result = await driveRowOverStack({ row, drift: "recorded" });
    // The drifted recorded baseline fails the row honestly — never a
    // fabricated completion.
    expect(result.terminal).toBe("FAILED");
    expect(result.freeze.recordedTrajectoryAgreement).toBe(false);
    expect(result.freeze.agreed).toBe(false);
    expect(
      result.criteria.find((criterion) => criterion.criterionId === "recorded-trajectory-agreement")
        ?.status,
    ).toBe("FAIL");
    expect(
      (
        result.criteria.find(
          (criterion) => criterion.criterionId === "recorded-trajectory-agreement",
        )?.evidence ?? []
      ).join(" "),
    ).toContain("DISAGREED");
  });

  test("a tamperer who edits the steps AND re-declares the digest is caught by the class backstop", () => {
    const steps = controlTrajectoryStepsOf({ workload: row.workload });
    const mutated = steps.map((step, index) =>
      index === steps.length - 1 ? { ...step, detail: `${step.detail}:drifted` } : step,
    );
    // The digest is recomputed over the mutated steps (self-consistent)
    // — but the mutated trajectory is OUT of the pinned equivalence
    // class, so the freeze still FAILs.
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

  test("an EDIT of a committed registry pin FAILs the driven control run (the honest registry refuses it)", async () => {
    const editedRow = rowById("text-summarize-baseline");
    const mutatedManifest: BaselineManifestEntry = {
      ...editedRow.manifest,
      workloadDigest: "deadbeef",
      manifestDigest: manifestDigestOf({
        appId: editedRow.manifest.appId,
        appDigest: editedRow.manifest.appDigest,
        workloadId: editedRow.manifest.workloadId,
        workloadRevision: editedRow.manifest.workloadRevision,
        workloadDigest: "deadbeef",
      }),
    };
    // The HONEST registry refuses the in-place edit outright.
    const honest = createDefaultFrozenBaselineRegistry();
    expect(() => honest.commit(mutatedManifest, "2025-03-01T00:00:00.000Z")).toThrow(
      "append-only violation",
    );
    // The ADVERSARIAL registry admits the edit (the pin is overwritten
    // in place) — the driven control run FAILs the registry leg.
    const adversarial = createFrozenBaselineRegistry({ admitEdits: true });
    adversarial.commit(editedRow.manifest, "2025-01-01T00:00:00.000Z");
    adversarial.commit(mutatedManifest, "2025-03-01T00:00:00.000Z");
    const result = await driveRowOverStack({ row: editedRow, registry: adversarial });
    expect(result.terminal).toBe("FAILED");
    expect(result.freeze.registryAgreement).toBe(false);
    expect(
      result.criteria.find((criterion) => criterion.criterionId === "registry-agreement")?.status,
    ).toBe("FAIL");
    expect(
      (
        result.criteria.find((criterion) => criterion.criterionId === "registry-agreement")
          ?.evidence ?? []
      ).join(" "),
    ).toContain("the registry is append-only");
  });

  test("the honest controls: every offline row's freeze agrees on EVERY leg (the control)", async () => {
    for (const row of OFFLINE_CORPUS_ROWS) {
      const result = await driveRowOverStack({ row });
      expect(result.freeze.agreed, `${row.rowId} freeze agreed`).toBe(true);
      expect(result.freeze.manifestSelfAgreement, `${row.rowId} manifest self`).toBe(true);
      expect(result.freeze.appArtifactAgreement, `${row.rowId} app artifact`).toBe(true);
      expect(result.freeze.workloadRevisionAgreement, `${row.rowId} workload revision`).toBe(true);
      expect(result.freeze.recordedTrajectoryAgreement, `${row.rowId} recorded trajectory`).toBe(
        true,
      );
      expect(result.freeze.registryAgreement, `${row.rowId} registry`).toBe(true);
      expect(result.terminal, `${row.rowId} terminal`).toBe(row.expected.terminal);
    }
  });
});

// ---------------------------------------------------------------------------
// Family 2: the learning-contaminated run masquerading as control
// ---------------------------------------------------------------------------

describe("VAL-030 discrimination: the learning-contaminated run masquerading as control", () => {
  test("a trajectory-REUSE contaminated run FAILs (the round dispatched NOTHING)", async () => {
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

  test("a caching-HINT contaminated run FAILs the inert contract (the trajectory shape alone never catches it)", async () => {
    const row = rowById("probe-caching-hint-contamination");
    const result = await driveRowOverStack({ row, contaminate: "caching-hint" });
    expect(result.terminal).toBe("FAILED");
    expect(result.learning.inert).toBe(false);
    expect(result.learning.contamination).toBe("caching-hint");
    // The hinted rounds still dispatched — ONLY the inert-learning
    // compliance catches the hint.
    expect(result.observedModelCalls).toBe(row.expectedModelCalls);
    expect(
      result.criteria.find((criterion) => criterion.criterionId === "control-learning-inert")
        ?.status,
    ).toBe("FAIL");
    expect(
      result.criteria.find((criterion) => criterion.criterionId === "control-learning-inert")
        ?.evidence ?? [],
    ).toContain("contamination:caching-hint");
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

  test("the reuse-contaminated run surfaced through the PUBLIC wire FAILs the app's control contract", async () => {
    const outcome = await runAppOverFakeWorld({
      rowId: "probe-reuse-contamination",
      contaminatedLearning: true,
    });
    expect(outcome.passed).toBe(false);
    // The public route read shows ZERO model calls (a reused round
    // dispatched nothing) — the inert-learning floor at the customer
    // boundary.
    expect(outcome.observedModelCalls).toBe(0);
    expect(
      outcome.appCriteria.find((criterion) => criterion.criterionId === "app-control-run-inert")
        ?.status,
    ).toBe("FAIL");
    expect(
      outcome.appCriteria.find(
        (criterion) => criterion.criterionId === "app-trajectory-class-membership",
      )?.status,
    ).toBe("FAIL");
  });

  test("the honest inert controls pass like any baseline (the reference arm)", async () => {
    for (const rowId of [
      "probe-reuse-contamination",
      "probe-caching-hint-contamination",
      "probe-competence-shortcut-contamination",
    ]) {
      const row = rowById(rowId);
      const result = await driveRowOverStack({ row });
      expect(result.terminal, `${rowId} terminal`).toBe("COMPLETED");
      expect(result.learning.inert, `${rowId} inert`).toBe(true);
      expect(result.learning.contamination, `${rowId} contamination`).toBeNull();
      expect(result.observedModelCalls, `${rowId} own dispatches`).toBe(row.expectedModelCalls);
      const failed = result.criteria.filter((criterion) => criterion.status === "FAIL");
      expect(failed, `${rowId}: ${JSON.stringify(failed)}`).toEqual([]);
    }
  });
});

// ---------------------------------------------------------------------------
// Family 3: the duplicated ledger identity (the exactly-once catch)
// ---------------------------------------------------------------------------

describe("VAL-030 discrimination: the duplicated ledger identity", () => {
  const row = rowById("research-digest-rerun-equivalence");
  const runKey = controlRunKeyOf({ executionId: "exec-disc-ledger", manifest: row.manifest });
  const identityId = controlIdentityIdOf(runKey);
  const contentDigest = identityContentDigestOf({
    manifestDigest: row.manifest.manifestDigest,
    trajectoryDigest: row.expectedTrajectoryClass[0] ?? "",
  });

  test("a LEAKY ledger that admits a DUPLICATE identity for one control run FAILs", async () => {
    const result = await driveRowOverStack({ row, leaky: true });
    expect(result.terminal).toBe("FAILED");
    expect(result.ledger.exactlyOnce).toBe(false);
    expect(result.ledger.duplicateCount).toBe(2);
    expect(
      result.criteria.find((criterion) => criterion.criterionId === "ledger-exactly-once")?.status,
    ).toBe("FAIL");
    expect(
      (
        result.criteria.find((criterion) => criterion.criterionId === "ledger-exactly-once")
          ?.evidence ?? []
      ).join(" "),
    ).toContain("DUPLICATED");
  });

  test("a re-run that MINTED a second identity FAILs (the fabricated minted shape)", () => {
    // The fabricated minted shape: the ledger holds TWO identities for
    // the key and the re-observation "created" a new one instead of
    // replaying the recorded identity.
    const verdict = deriveLedgerExactlyOnce({
      runKey,
      ledgerFacts: {
        identities: [
          { identityId, runKey, contentDigest },
          { identityId: `${identityId}-dup-1`, runKey, contentDigest },
        ],
      },
      observations: [
        { contentDigest, identityId, replayed: false, refused: false },
        { contentDigest, identityId: `${identityId}-dup-1`, replayed: false, refused: false },
      ],
    });
    expect(verdict.exactlyOnce).toBe(false);
    expect(verdict.duplicateCount).toBe(2);
    expect(verdict.reobservationReplayed).toBe(false);
    expect(
      verdict.criteria.find((criterion) => criterion.criterionId === "ledger-rerun-reobservation")
        ?.status,
    ).toBe("FAIL");
    expect(
      (
        verdict.criteria.find((criterion) => criterion.criterionId === "ledger-rerun-reobservation")
          ?.evidence ?? []
      ).join(" "),
    ).toContain("RE-ARBITRATED");
  });

  test("a re-observation with DRIFTED identity content is REFUSED and FAILs (the immutable content)", () => {
    const driftedContent = identityContentDigestOf({
      manifestDigest: row.manifest.manifestDigest,
      trajectoryDigest: "ffffffff",
    });
    const verdict = deriveLedgerExactlyOnce({
      runKey,
      ledgerFacts: { identities: [{ identityId, runKey, contentDigest }] },
      observations: [
        { contentDigest, identityId, replayed: false, refused: false },
        // The honest ledger REFUSES the drifted re-observation — and the
        // derivation FAILs the row (the identity's content is immutable).
        { contentDigest: driftedContent, identityId, replayed: false, refused: true },
      ],
    });
    expect(verdict.exactlyOnce).toBe(true);
    expect(verdict.contentImmutable).toBe(false);
    expect(verdict.reobservationReplayed).toBe(false);
    expect(
      verdict.criteria.find(
        (criterion) => criterion.criterionId === "ledger-identity-content-immutable",
      )?.status,
    ).toBe("FAIL");
  });

  test("the honest re-run does NOT mint a second identity (the control)", async () => {
    const result = await driveRowOverStack({ row });
    expect(result.terminal).toBe("COMPLETED");
    expect(result.ledger.exactlyOnce).toBe(true);
    expect(result.ledger.duplicateCount).toBe(1);
    expect(result.ledger.reobservationReplayed).toBe(true);
    expect(result.ledger.identityStable).toBe(true);
    // The ONE identity is the derived stable form for the driven
    // execution — never a minted id.
    expect(result.identityId).toBe(
      controlIdentityIdOf(
        controlRunKeyOf({
          executionId: `exec-disc-${row.rowId}`,
          manifest: row.manifest,
        }),
      ),
    );
  });
});

// ---------------------------------------------------------------------------
// Family 4: the trajectory drift between re-runs (the equivalence catch)
// ---------------------------------------------------------------------------

describe("VAL-030 discrimination: the trajectory drift between re-runs", () => {
  test("a DRIFTING re-run (out of the recorded equivalence class) FAILs the driven row", async () => {
    const row = rowById("research-digest-rerun-equivalence");
    const result = await driveRowOverStack({ row, drift: "rerun" });
    expect(result.terminal).toBe("FAILED");
    expect(result.rerun?.reproduced).toBe(false);
    expect(result.rerunTrajectoryDigest).not.toBe(result.trajectoryDigest);
    // The ORIGINAL trajectory stays in class; the re-run drifted out.
    expect(row.expectedTrajectoryClass).toContain(result.trajectoryDigest ?? "");
    expect(row.expectedTrajectoryClass).not.toContain(result.rerunTrajectoryDigest ?? "");
    expect(
      result.criteria.find(
        (criterion) => criterion.criterionId === "rerun-trajectory-class-membership",
      )?.status,
    ).toBe("FAIL");
    expect(
      (
        result.criteria.find(
          (criterion) => criterion.criterionId === "rerun-trajectory-class-membership",
        )?.evidence ?? []
      ).join(" "),
    ).toContain("DRIFTED");
  });

  test("a fabricated drifted re-run digest FAILs the re-run equivalence derivation", () => {
    const row = rowById("order-settlement-equivalence-class");
    // The two-member class: either equivalent ordering reproduces.
    for (const member of row.expectedTrajectoryClass) {
      expect(
        deriveRerunEquivalence({
          expectedClass: row.expectedTrajectoryClass,
          observedTrajectoryDigest: member,
        }).reproduced,
      ).toBe(true);
    }
    // The drifted digest is outside the class — mechanically FAILed.
    const drifted = trajectoryDigestOf(
      controlTrajectoryStepsOf({ workload: row.workload }).map((step, index) =>
        index === 0 ? { ...step, detail: `${step.detail}:drifted` } : step,
      ),
    );
    const verdict = deriveRerunEquivalence({
      expectedClass: row.expectedTrajectoryClass,
      observedTrajectoryDigest: drifted,
    });
    expect(verdict.reproduced).toBe(false);
    expect(
      verdict.criteria.find(
        (criterion) => criterion.criterionId === "rerun-trajectory-class-membership",
      )?.status,
    ).toBe("FAIL");
  });

  test("the drifting recorder between the run and the re-run FAILs the app's re-run class membership", async () => {
    const outcome = await runAppOverFakeWorld({
      rowId: "research-digest-rerun-equivalence",
      driftRecorder: true,
    });
    expect(outcome.passed).toBe(false);
    const row = rowById("research-digest-rerun-equivalence");
    // The original trajectory stays in class; the re-run drifted out.
    expect(row.expectedTrajectoryClass).toContain(outcome.trajectoryDigest ?? "");
    expect(row.expectedTrajectoryClass).not.toContain(outcome.rerunTrajectoryDigest ?? "");
    expect(
      outcome.appCriteria.find(
        (criterion) => criterion.criterionId === "app-rerun-trajectory-class",
      )?.status,
    ).toBe("FAIL");
  });

  test("the honest re-run reproduces the recorded class (the control)", async () => {
    const row = rowById("research-digest-rerun-equivalence");
    const result = await driveRowOverStack({ row });
    expect(result.terminal).toBe("COMPLETED");
    expect(result.rerun?.reproduced).toBe(true);
    expect(result.rerunTrajectoryDigest).toBe(result.trajectoryDigest);
    expect(row.expectedTrajectoryClass).toContain(result.rerunTrajectoryDigest ?? "");
    expect(
      result.criteria.find(
        (criterion) => criterion.criterionId === "rerun-trajectory-class-membership",
      )?.status,
    ).toBe("PASS");
  });
});
