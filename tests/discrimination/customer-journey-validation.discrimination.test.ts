/**
 * VAL-050 acceptance criterion 6 — the discrimination battery: the
 * END-TO-END CUSTOMER JOURNEY machinery against controlled fakes,
 * driven through the application's REAL seams.
 *
 * Every catch the work order names is probed at the SEAM level: the
 * five controlled fakes (a dropped stage, an orphaned state, a
 * duplicated resume, a boundary leak, a hidden residual) are forced
 * onto an HONEST row's journey and driven through the REAL
 * application code — `runCustomerJourneyApp` over the public
 * SDK/harness boundary (the injected transport seam) — proving the
 * boundary-re-derived oracles actually DETECT each denatured journey
 * (the NAMED criterion FAILing with the mechanism named in evidence),
 * never the transport fake in isolation:
 *
 *   * each controlled fake forced onto the HONEST row FAILs the
 *     NAMED oracle at the boundary (with the honest control — the
 *     undenatured contrast pair — PASSing the same oracle);
 *   * each probe row's OWN journey settles FAILED with exactly its
 *     pinned NAMED criteria (the row-level catch);
 *   * REPLAY DETERMINISM: the same observation re-derived twice is
 *     bit-stable, the same row driven twice over fresh fake worlds
 *     lands the identical verdict, and a controlled mutation between
 *     replays flips the verdict (a flipped verdict never reproduces);
 *   * a RUBBER-STAMP oracle (one that passes everything) FAILs the
 *     suite: it passes every controlled fake, the REAL re-derivation
 *     contradicts it on each, and a platform claiming all-PASS
 *     statuses over a denatured journey still FAILs the app's journey
 *     contract (the boundary never trusts the platform's own claim);
 *   * a FAVORABLE-SUBSET battery (the honest rows only) would
 *     fake-pass — the omitted probe rows are NAMED and the full
 *     battery FAILs each one's pinned criteria;
 *   * the LIVE RAIL honesty: the env-gated live row stays NOT RUN
 *     without OPENROUTER_API_KEY (the env var NAMED, zero
 *     submissions) and the offline fake world refuses the live rail
 *     outright (a live journey is never fabricated offline);
 *   * every offline AC the unit suites cover, re-proven at the seam
 *     level (the honest rows' durable executions, the continuation
 *     resume, the idempotent re-issue, the terminal/agreement/
 *     submission-landed discriminations, the mechanical verdict
 *     vocabulary, the digest discipline).
 */

import { describe, expect, test } from "vitest";
import { runCustomerJourneyApp } from "../../benchmarks/validation/apps/customer-journey/application";
import type { JourneyProbeKind } from "../../benchmarks/validation/apps/customer-journey/corpus";
import {
  CUSTOMER_JOURNEY_ROW_IDS,
  JOURNEY_INTEGRITY_FAMILIES,
  journeyRowById,
  LIVE_CORPUS_ROWS,
  liveGateOpen,
  OFFLINE_CORPUS_ROWS,
  PROBE_FAILED_CRITERIA_OF,
} from "../../benchmarks/validation/apps/customer-journey/corpus";
import type { JourneyObservation } from "../../benchmarks/validation/apps/customer-journey/driver";
import {
  deriveJourneyVerdict,
  FOREIGN_APPLICATION_ID,
  journeyObservationFor,
  verifyCustomerJourneyIntegrity,
} from "../../benchmarks/validation/apps/customer-journey/driver";
import {
  createJourneyFakeApiWorld,
  createTickClock,
} from "../../benchmarks/validation/apps/customer-journey/fixtures";
import { economicDigestOf } from "../../benchmarks/validation/apps/economic-baseline/driver";
import type { LabVerificationCriterion } from "../../benchmarks/validation/platform/derive";

const baseConfig = {
  applicationId: "app-1",
  baseUrl: "https://fake.example.test",
  tokenEnvVar: "ZECK_VALIDATION_TOKEN",
  applicationRevision: "0123456789abcdef0123456789abcdef01234567",
  corpusRevision: "0123456789abcdef0123456789abcdef01234567",
  integrationSurface: "customer-journey:lifecycle",
  pollIntervalMs: 10,
  completionTimeoutMs: 5_000,
};

/** Drive the REAL app over the fake public API world (the SDK seam). */
async function runAppOverFakeWorld(options: {
  readonly taskIndex: number;
  readonly probe?: JourneyProbeKind;
  readonly terminal?: "COMPLETED" | "FAILED";
  readonly verificationStatuses?: readonly string[];
  readonly fabricatePassWithFail?: boolean;
  readonly env?: Record<string, string | undefined>;
}) {
  const clock = createTickClock();
  const world = createJourneyFakeApiWorld({
    clock,
    ...(options.probe === undefined ? {} : { probe: options.probe }),
    ...(options.terminal === undefined ? {} : { terminal: options.terminal }),
    ...(options.verificationStatuses === undefined
      ? {}
      : { verificationStatuses: options.verificationStatuses }),
    ...(options.fabricatePassWithFail === undefined
      ? {}
      : { fabricatePassWithFail: options.fabricatePassWithFail }),
  });
  const outcome = await runCustomerJourneyApp({
    config: baseConfig,
    token: "test-token",
    transport: world.transport,
    now: clock.now,
    sleep: async () => {},
    environment: {
      runtime: "bun test",
      toolchain: "bun",
      database: "none",
      configuration: { suite: "val-050-discrimination" },
    },
    runSuffix: "discrimination",
    taskIndex: options.taskIndex,
    env: options.env ?? {},
  });
  return { outcome, world };
}

const HONEST_ROW_ID = "full-journey-recorded-portfolio";
const HONEST_INDEX = CUSTOMER_JOURNEY_ROW_IDS.indexOf(HONEST_ROW_ID);
const honestRow = journeyRowById(HONEST_ROW_ID);
if (honestRow === null) {
  throw new Error(`unknown corpus row ${HONEST_ROW_ID}`);
}

/** The five controlled fakes, each with its NAMED oracle + mechanism evidence token. */
const CONTROLLED_FAKES: readonly {
  readonly probe: JourneyProbeKind;
  readonly namedOracle: string;
  readonly mechanismToken: string;
}[] = [
  {
    probe: "dropped-stage",
    namedOracle: "stage-completeness",
    mechanismToken: "missing-stage:daily-usage",
  },
  {
    probe: "orphaned-state",
    namedOracle: "cross-stage-idempotency",
    mechanismToken: "orphaned-intent:daily-usage",
  },
  {
    probe: "double-driven-resume",
    namedOracle: "continuation-exactly-once",
    mechanismToken: "resume-violation:daily-usage",
  },
  {
    probe: "boundary-leak",
    namedOracle: "customer-boundary",
    mechanismToken: `boundary-leak:daily-usage`,
  },
  {
    probe: "residual-hiding",
    namedOracle: "accounting-reconciliation",
    mechanismToken: "cost-residual:-",
  },
];

const journeyCriteriaOf = (outcome: {
  readonly journeyCriteria: readonly LabVerificationCriterion[];
}) => outcome.journeyCriteria;

const criterion = (
  outcome: { readonly journeyCriteria: readonly LabVerificationCriterion[] },
  criterionId: string,
): LabVerificationCriterion | undefined =>
  journeyCriteriaOf(outcome).find((entry) => entry.criterionId === criterionId);

// ---------------------------------------------------------------------------
// 1..5 — the five controlled fakes, each DETECTED at the seam
// ---------------------------------------------------------------------------

describe("discrimination: a dropped stage (the journey machinery DETECTS it at the seam)", () => {
  test("forcing the dropped-stage fake onto the HONEST row FAILs stage-completeness with the stage NAMED", async () => {
    const { outcome } = await runAppOverFakeWorld({
      taskIndex: HONEST_INDEX,
      probe: "dropped-stage",
    });
    expect(outcome.verdict).toBe("JOURNEY-FAILED");
    const completeness = criterion(outcome, "stage-completeness");
    expect(completeness?.status).toBe("FAIL");
    expect(completeness?.evidence.join(" ")).toContain("missing-stage:daily-usage");
    // The accounting oracle names the dropped stage's missing cost too
    // (the observed stage sum falls below the recorded basis).
    const accounting = criterion(outcome, "accounting-reconciliation");
    expect(accounting?.status).toBe("FAIL");
    const evidence = accounting?.evidence.join(" ") ?? "";
    expect(evidence).toContain("recorded-cost-basis:");
    expect(evidence).toContain("observed-stage-sum:");
    // The honest row's contract cannot absorb the denatured journey.
    expect(outcome.passed).toBe(false);
  });

  test("the honest control (the contrast pair): the undenatured row PASSes the same oracle at the seam", async () => {
    const { outcome } = await runAppOverFakeWorld({ taskIndex: HONEST_INDEX });
    expect(outcome.verdict).toBe("JOURNEY-COMPLETED");
    const failed = journeyCriteriaOf(outcome).filter((entry) => entry.status === "FAIL");
    expect(failed).toEqual([]);
  });

  test("the row-level catch: the probe row settles FAILED with exactly its pinned criteria", async () => {
    const rowId = "probe-dropped-stage";
    const taskIndex = CUSTOMER_JOURNEY_ROW_IDS.indexOf(rowId);
    const { outcome } = await runAppOverFakeWorld({ taskIndex });
    expect(outcome.observedTerminal).toBe("FAILED");
    expect(outcome.verdict).toBe("JOURNEY-FAILED");
    const failed = journeyCriteriaOf(outcome)
      .filter((entry) => entry.status === "FAIL")
      .map((entry) => entry.criterionId)
      .sort();
    expect(failed).toEqual([...PROBE_FAILED_CRITERIA_OF["dropped-stage"]].sort());
  });
});

describe("discrimination: an orphaned state (the submitted intent never landed)", () => {
  test("forcing the orphaned-state fake onto the HONEST row FAILs cross-stage-idempotency with the intent NAMED", async () => {
    const { outcome } = await runAppOverFakeWorld({
      taskIndex: HONEST_INDEX,
      probe: "orphaned-state",
    });
    expect(outcome.verdict).toBe("JOURNEY-FAILED");
    const idempotency = criterion(outcome, "cross-stage-idempotency");
    expect(idempotency?.status).toBe("FAIL");
    expect(idempotency?.evidence.join(" ")).toContain("orphaned-intent:daily-usage");
    // NEVER the continuation oracle's catch (the orphaned stage is the
    // idempotency oracle's own violation).
    const continuation = criterion(outcome, "continuation-exactly-once");
    expect(continuation?.status).toBe("PASS");
    expect(outcome.passed).toBe(false);
  });

  test("the honest control: every submitted intent lands exactly one durable execution at the seam", async () => {
    const { outcome } = await runAppOverFakeWorld({ taskIndex: HONEST_INDEX });
    const idempotency = criterion(outcome, "cross-stage-idempotency");
    expect(idempotency?.status).toBe("PASS");
    expect(idempotency?.evidence.join(" ")).toContain("submitted-intents:5");
  });

  test("the row-level catch: the probe row settles FAILED with exactly its pinned criteria", async () => {
    const taskIndex = CUSTOMER_JOURNEY_ROW_IDS.indexOf("probe-orphaned-state");
    const { outcome } = await runAppOverFakeWorld({ taskIndex });
    expect(outcome.observedTerminal).toBe("FAILED");
    const failed = journeyCriteriaOf(outcome)
      .filter((entry) => entry.status === "FAIL")
      .map((entry) => entry.criterionId)
      .sort();
    expect(failed).toEqual([...PROBE_FAILED_CRITERIA_OF["orphaned-state"]].sort());
  });
});

describe("discrimination: a duplicated resume (the resumed stage driven twice)", () => {
  test("forcing the double-driven-resume fake onto the HONEST row FAILs continuation-exactly-once with the counts NAMED", async () => {
    const { outcome } = await runAppOverFakeWorld({
      taskIndex: HONEST_INDEX,
      probe: "double-driven-resume",
    });
    expect(outcome.verdict).toBe("JOURNEY-FAILED");
    const continuation = criterion(outcome, "continuation-exactly-once");
    expect(continuation?.status).toBe("FAIL");
    const evidence = continuation?.evidence.join(" ") ?? "";
    expect(evidence).toContain("resume-violation:daily-usage");
    expect(evidence).toContain("observed executions=2");
    // The duplicated work's cost is never hidden (the accounting oracle
    // names the re-priced stage).
    const accounting = criterion(outcome, "accounting-reconciliation");
    expect(accounting?.status).toBe("FAIL");
    expect(accounting?.evidence.join(" ")).toContain("re-priced-stage:daily-usage");
    expect(outcome.passed).toBe(false);
  });

  test("the honest control: no declared failure means exactly one execution per stage at the seam", async () => {
    const { outcome } = await runAppOverFakeWorld({ taskIndex: HONEST_INDEX });
    const continuation = criterion(outcome, "continuation-exactly-once");
    expect(continuation?.status).toBe("PASS");
    expect(continuation?.evidence.join(" ")).toContain("declared-failure-stage:none");
  });

  test("the row-level catch: the probe row settles FAILED with exactly its pinned criteria", async () => {
    const taskIndex = CUSTOMER_JOURNEY_ROW_IDS.indexOf("probe-double-driven-resume");
    const { outcome } = await runAppOverFakeWorld({ taskIndex });
    expect(outcome.observedTerminal).toBe("FAILED");
    const failed = journeyCriteriaOf(outcome)
      .filter((entry) => entry.status === "FAIL")
      .map((entry) => entry.criterionId)
      .sort();
    expect(failed).toEqual([...PROBE_FAILED_CRITERIA_OF["double-driven-resume"]].sort());
  });
});

describe("discrimination: a boundary leak (a stage under another customer's identity)", () => {
  test("forcing the boundary-leak fake onto the HONEST row FAILs customer-boundary with the foreign identity NAMED", async () => {
    const { outcome } = await runAppOverFakeWorld({
      taskIndex: HONEST_INDEX,
      probe: "boundary-leak",
    });
    expect(outcome.verdict).toBe("JOURNEY-FAILED");
    const boundary = criterion(outcome, "customer-boundary");
    expect(boundary?.status).toBe("FAIL");
    const evidence = boundary?.evidence.join(" ") ?? "";
    expect(evidence).toContain("boundary-leak:daily-usage");
    expect(evidence).toContain(FOREIGN_APPLICATION_ID);
    expect(outcome.passed).toBe(false);
  });

  test("the honest control: every stage executes under the journey's own customer identity", async () => {
    const { outcome } = await runAppOverFakeWorld({ taskIndex: HONEST_INDEX });
    const boundary = criterion(outcome, "customer-boundary");
    expect(boundary?.status).toBe("PASS");
    expect(boundary?.evidence.join(" ")).toContain("observed-identities:1");
  });

  test("the row-level catch: the probe row settles FAILED with exactly its pinned criteria", async () => {
    const taskIndex = CUSTOMER_JOURNEY_ROW_IDS.indexOf("probe-boundary-leak");
    const { outcome } = await runAppOverFakeWorld({ taskIndex });
    expect(outcome.observedTerminal).toBe("FAILED");
    const failed = journeyCriteriaOf(outcome)
      .filter((entry) => entry.status === "FAIL")
      .map((entry) => entry.criterionId)
      .sort();
    expect(failed).toEqual([...PROBE_FAILED_CRITERIA_OF["boundary-leak"]].sort());
  });
});

describe("discrimination: a hidden residual (the journey total hides stage cost)", () => {
  test("forcing the residual-hiding fake onto the HONEST row FAILs accounting-reconciliation with the exact residual NAMED", async () => {
    const { outcome } = await runAppOverFakeWorld({
      taskIndex: HONEST_INDEX,
      probe: "residual-hiding",
    });
    expect(outcome.verdict).toBe("JOURNEY-FAILED");
    const accounting = criterion(outcome, "accounting-reconciliation");
    expect(accounting?.status).toBe("FAIL");
    // The exact hidden amount: half the daily-usage stage's observed cost.
    const honest = journeyObservationFor(honestRow);
    const dailyUsage = honest.stages.find((record) => record.stage === "daily-usage");
    expect(dailyUsage).toBeDefined();
    const hidden = BigInt(dailyUsage?.costMicroUsd ?? "0") / 2n;
    expect(accounting?.evidence.join(" ")).toContain(`cost-residual:-${hidden.toString()}`);
    expect(outcome.passed).toBe(false);
  });

  test("the honest control: the reported total reconciles stage-for-stage with zero residual", async () => {
    const { outcome } = await runAppOverFakeWorld({ taskIndex: HONEST_INDEX });
    const accounting = criterion(outcome, "accounting-reconciliation");
    expect(accounting?.status).toBe("PASS");
    expect(accounting?.evidence.join(" ")).toContain("cost-residual:0");
  });

  test("the row-level catch: the probe row settles FAILED with exactly its pinned criteria", async () => {
    const taskIndex = CUSTOMER_JOURNEY_ROW_IDS.indexOf("probe-residual-hiding");
    const { outcome } = await runAppOverFakeWorld({ taskIndex });
    expect(outcome.observedTerminal).toBe("FAILED");
    const failed = journeyCriteriaOf(outcome)
      .filter((entry) => entry.status === "FAIL")
      .map((entry) => entry.criterionId)
      .sort();
    expect(failed).toEqual([...PROBE_FAILED_CRITERIA_OF["residual-hiding"]].sort());
  });
});

// ---------------------------------------------------------------------------
// 6 — replay determinism (the same observation re-derived bit-stable)
// ---------------------------------------------------------------------------

describe("discrimination: replay determinism", () => {
  test("the same observation re-derived twice yields BIT-IDENTICAL criteria (honest + every fake)", () => {
    for (const fake of CONTROLLED_FAKES) {
      const observation = journeyObservationFor(honestRow, { probe: fake.probe });
      const first = JSON.stringify(verifyCustomerJourneyIntegrity({ row: honestRow, observation }));
      const second = JSON.stringify(
        verifyCustomerJourneyIntegrity({ row: honestRow, observation }),
      );
      expect(second, fake.probe).toBe(first);
      // The observation itself is a pure derivation (re-derived identical).
      expect(journeyObservationFor(honestRow, { probe: fake.probe })).toEqual(observation);
    }
    const honest = journeyObservationFor(honestRow);
    expect(
      JSON.stringify(verifyCustomerJourneyIntegrity({ row: honestRow, observation: honest })),
    ).toBe(JSON.stringify(verifyCustomerJourneyIntegrity({ row: honestRow, observation: honest })));
  });

  test("the same row driven twice over fresh fake worlds lands the IDENTICAL verdict and journey digest", async () => {
    const firstRun = await runAppOverFakeWorld({ taskIndex: HONEST_INDEX });
    const secondRun = await runAppOverFakeWorld({ taskIndex: HONEST_INDEX });
    expect(secondRun.outcome.verdict).toBe(firstRun.outcome.verdict);
    expect(JSON.stringify(secondRun.outcome.journeyCriteria)).toBe(
      JSON.stringify(firstRun.outcome.journeyCriteria),
    );
    // A flipped verdict on replay would FAIL here — the re-derivation
    // must reproduce bit-for-bit.
    expect(secondRun.outcome.passed).toBe(true);
  });

  test("a controlled mutation between replays flips the verdict (determinism is discriminating, never vacuous)", () => {
    const honest = journeyObservationFor(honestRow);
    const honestVerdict = deriveJourneyVerdict({ row: honestRow, observation: honest });
    expect(honestVerdict.verdict).toBe("JOURNEY-COMPLETED");
    // The mutation: the replay drops one stage record (a durable read
    // that silently lost the daily-usage execution).
    const mutated: JourneyObservation = {
      ...honest,
      stages: honest.stages.filter((record) => record.stage !== "daily-usage"),
    };
    const mutatedVerdict = deriveJourneyVerdict({ row: honestRow, observation: mutated });
    expect(mutatedVerdict.verdict).toBe("JOURNEY-FAILED");
    expect(mutatedVerdict.failedCriteria).toContain("stage-completeness");
    // The re-derived journey digest over the mutated stage list differs
    // (the same FNV-1a convention the driver pins) — a durable read
    // that silently lost a stage is digest-visible.
    const mutatedDigest = economicDigestOf({
      rowId: honest.rowId,
      stages: mutated.stages.map((record) => `${record.stage}:${record.executions}`),
    });
    expect(mutatedDigest === honest.journeyDigest).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 7 — a rubber-stamp oracle (one that passes everything) FAILs the suite
// ---------------------------------------------------------------------------

/** The controlled RUBBER-STAMP oracle: passes everything, re-derives nothing. */
const rubberStampOracle = (observation: JourneyObservation): readonly LabVerificationCriterion[] =>
  JOURNEY_INTEGRITY_FAMILIES.map((family) => ({
    criterionId: family,
    strategy: "deterministic",
    status: "PASS",
    evidence: [`rubber-stamp:${observation.rowId} passed without re-derivation`],
  }));

describe("discrimination: a rubber-stamp oracle", () => {
  test("the confession: a pass-everything oracle passes EVERY controlled fake (worthless on its own)", () => {
    for (const fake of CONTROLLED_FAKES) {
      const observation = journeyObservationFor(honestRow, { probe: fake.probe });
      const stamped = rubberStampOracle(observation);
      expect(
        stamped.every((entry) => entry.status === "PASS"),
        fake.probe,
      ).toBe(true);
    }
  });

  test("the suite FAILs it: the REAL boundary re-derivation contradicts the stamp on EVERY fake (the named criteria FAIL where the stamp says PASS)", () => {
    for (const fake of CONTROLLED_FAKES) {
      const observation = journeyObservationFor(honestRow, { probe: fake.probe });
      const stamped = rubberStampOracle(observation);
      const real = verifyCustomerJourneyIntegrity({ row: honestRow, observation });
      // An oracle that passes everything cannot satisfy this suite: the
      // real machinery FAILs the named criterion the stamp passed.
      const named = real.find((entry) => entry.criterionId === fake.namedOracle);
      expect(named?.status, fake.probe).toBe("FAIL");
      const stampedNamed = stamped.find((entry) => entry.criterionId === fake.namedOracle);
      expect(stampedNamed?.status, fake.probe).toBe("PASS");
      expect(deriveJourneyVerdict({ row: honestRow, observation }).verdict, fake.probe).toBe(
        "JOURNEY-FAILED",
      );
    }
  });

  test("the seam-level rubber stamp: a platform claiming ALL-PASS statuses over a denatured journey still FAILs the app contract", async () => {
    // The platform's own verification claims PASS,PASS (the rubber
    // stamp) while the journey shape is denatured — the app re-derives
    // AT THE BOUNDARY and refuses to trust the claim.
    const { outcome } = await runAppOverFakeWorld({
      taskIndex: HONEST_INDEX,
      probe: "dropped-stage",
      verificationStatuses: ["PASS", "PASS"],
    });
    expect(outcome.verificationStatuses).toEqual(["PASS", "PASS"]);
    expect(outcome.verdict).toBe("JOURNEY-FAILED");
    expect(outcome.passed).toBe(false);
    expect(criterion(outcome, "stage-completeness")?.status).toBe("FAIL");
    const named = outcome.appCriteria.find(
      (entry) => entry.criterionId === "app-failed-criteria-named",
    );
    expect(named?.status).toBe("FAIL");
  });
});

// ---------------------------------------------------------------------------
// 8 — a favorable-subset battery (the honest rows only) would fake-pass
// ---------------------------------------------------------------------------

describe("discrimination: a favorable-subset battery", () => {
  const HONEST_ROW_IDS = OFFLINE_CORPUS_ROWS.filter((row) => row.probe === undefined).map(
    (row) => row.rowId,
  );
  const OMITTED_ROW_IDS = OFFLINE_CORPUS_ROWS.filter((row) => row.probe !== undefined).map(
    (row) => row.rowId,
  );

  test("the tempting fake-pass: the honest-only subset drives green at the seam (omitting exactly the five probe rows)", async () => {
    for (const rowId of HONEST_ROW_IDS) {
      const taskIndex = CUSTOMER_JOURNEY_ROW_IDS.indexOf(rowId);
      const { outcome } = await runAppOverFakeWorld({ taskIndex });
      expect(outcome.passed, rowId).toBe(true);
      const failed = journeyCriteriaOf(outcome).filter((entry) => entry.status === "FAIL");
      expect(failed, rowId).toEqual([]);
    }
    // The favorable subset omits EXACTLY the five adversarial probe
    // rows (NAMED) — every one of which carries a non-empty pinned
    // failed-criteria vocabulary the subset would never exercise.
    expect(OMITTED_ROW_IDS).toEqual([
      "probe-dropped-stage",
      "probe-orphaned-state",
      "probe-double-driven-resume",
      "probe-boundary-leak",
      "probe-residual-hiding",
    ]);
    for (const rowId of OMITTED_ROW_IDS) {
      const row = journeyRowById(rowId);
      expect(row?.probe?.kind, rowId).toBeDefined();
      expect(
        row?.probe ? PROBE_FAILED_CRITERIA_OF[row.probe.kind].length : 0,
        rowId,
      ).toBeGreaterThan(0);
    }
  });

  test("the full battery FAILs each omitted probe row's pinned criteria (the subset hid every discrimination)", async () => {
    for (const rowId of OMITTED_ROW_IDS) {
      const taskIndex = CUSTOMER_JOURNEY_ROW_IDS.indexOf(rowId);
      const row = journeyRowById(rowId);
      const { outcome } = await runAppOverFakeWorld({ taskIndex });
      expect(outcome.observedTerminal, rowId).toBe("FAILED");
      const failed = journeyCriteriaOf(outcome)
        .filter((entry) => entry.status === "FAIL")
        .map((entry) => entry.criterionId)
        .sort();
      expect(failed, rowId).toEqual(
        [...(row?.probe ? PROBE_FAILED_CRITERIA_OF[row.probe.kind] : [])].sort(),
      );
    }
  });
});

// ---------------------------------------------------------------------------
// 9 — the live-rail boundary (the honest NOT RUN pin)
// ---------------------------------------------------------------------------

describe("discrimination: the live-rail boundary (NOT RUN honesty)", () => {
  test("the live row stays NOT RUN without OPENROUTER_API_KEY (the env var NAMED, zero submissions)", async () => {
    const taskIndex = CUSTOMER_JOURNEY_ROW_IDS.indexOf("live-journey-slice");
    const { outcome, world } = await runAppOverFakeWorld({ taskIndex, env: {} });
    expect(world.createdExecutions).toBe(0);
    expect(outcome.verdict).toBe("NOT-RUN");
    expect(outcome.notRunReason).toContain("OPENROUTER_API_KEY");
    expect(outcome.submission).toBeNull();
    expect(outcome.passed).toBe(true);
    expect(outcome.appCriteria.map((entry) => entry.criterionId)).toEqual(["app-live-gate-honest"]);
  });

  test("the offline fake world REFUSES the live rail even with the credential set (a live journey is never fabricated offline)", async () => {
    const taskIndex = CUSTOMER_JOURNEY_ROW_IDS.indexOf("live-journey-slice");
    const { outcome, world } = await runAppOverFakeWorld({
      taskIndex,
      env: { OPENROUTER_API_KEY: "operator-authorized" },
    });
    expect(world.createdExecutions).toBe(0);
    expect(outcome.passed).toBe(false);
    expect(outcome.verdict).toBe("JOURNEY-FAILED");
    const landed = outcome.appCriteria.find((entry) => entry.criterionId === "submission-landed");
    expect(landed?.status).toBe("FAIL");
    // The derivation-level pin: the gate consults the env honestly.
    const liveRow = LIVE_CORPUS_ROWS[0];
    if (liveRow === undefined) {
      throw new Error("the corpus declares no live row");
    }
    expect(liveGateOpen(liveRow, {})).toBe(false);
    expect(liveGateOpen(liveRow, { OPENROUTER_API_KEY: "x" })).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 10 — every offline AC the unit suites cover, re-proven at the seam
// ---------------------------------------------------------------------------

describe("the seam-level offline AC coverage (the unit suites' pins over the app boundary)", () => {
  test("every offline honest row lands ONE durable execution and settles COMPLETED with all five oracles PASSing", async () => {
    for (const rowId of [
      "full-journey-recorded-portfolio",
      "journey-continuation-resume",
      "journey-idempotent-reissue",
    ]) {
      const taskIndex = CUSTOMER_JOURNEY_ROW_IDS.indexOf(rowId);
      const { outcome, world } = await runAppOverFakeWorld({ taskIndex });
      expect(world.createdExecutions, rowId).toBe(1);
      expect(outcome.observedTerminal, rowId).toBe("COMPLETED");
      expect(outcome.verdict, rowId).toBe("JOURNEY-COMPLETED");
      const failedApp = outcome.appCriteria.filter((entry) => entry.status === "FAIL");
      expect(failedApp, rowId).toEqual([]);
      const failedJourney = journeyCriteriaOf(outcome).filter((entry) => entry.status === "FAIL");
      expect(failedJourney, rowId).toEqual([]);
      expect(outcome.usage, rowId).toBeNull();
    }
  });

  test("the continuation row resumes exactly once at the seam (two durable executions for the failed stage)", async () => {
    const taskIndex = CUSTOMER_JOURNEY_ROW_IDS.indexOf("journey-continuation-resume");
    const { outcome } = await runAppOverFakeWorld({ taskIndex });
    const continuation = criterion(outcome, "continuation-exactly-once");
    expect(continuation?.status).toBe("PASS");
    const evidence = continuation?.evidence.join(" ") ?? "";
    expect(evidence).toContain("declared-failure-stage:daily-usage");
    expect(evidence).toContain("daily-usage:executions=2,resumed=true");
  });

  test("the idempotent re-issue row replays under the same key (never double-creates)", async () => {
    const taskIndex = CUSTOMER_JOURNEY_ROW_IDS.indexOf("journey-idempotent-reissue");
    const { outcome, world } = await runAppOverFakeWorld({ taskIndex });
    expect(world.createdExecutions).toBe(1);
    expect(outcome.resubmission?.replayed).toBe(true);
    expect(outcome.resubmission?.executionId).toBe(outcome.submission?.executionId);
    const replay = outcome.appCriteria.find(
      (entry) => entry.criterionId === "app-resubmission-replay",
    );
    expect(replay?.status).toBe("PASS");
  });

  test("a terminal override FAILs the app-expected-terminal criterion at the seam", async () => {
    const { outcome } = await runAppOverFakeWorld({ taskIndex: HONEST_INDEX, terminal: "FAILED" });
    expect(outcome.observedTerminal).toBe("FAILED");
    expect(outcome.passed).toBe(false);
    const expected = outcome.appCriteria.find(
      (entry) => entry.criterionId === "app-expected-terminal",
    );
    expect(expected?.status).toBe("FAIL");
  });

  test("a fabricated pass-with-fail FAILs the terminal↔criteria agreement at the seam", async () => {
    const taskIndex = CUSTOMER_JOURNEY_ROW_IDS.indexOf("probe-dropped-stage");
    const { outcome } = await runAppOverFakeWorld({ taskIndex, fabricatePassWithFail: true });
    expect(outcome.observedTerminal).toBe("COMPLETED");
    expect(outcome.passed).toBe(false);
    const agreement = outcome.appCriteria.find(
      (entry) => entry.criterionId === "app-terminal-criteria-agreement",
    );
    expect(agreement?.status).toBe("FAIL");
  });

  test("a rejected submission FAILs the submission-landed criterion honestly at the seam", async () => {
    const clock = createTickClock();
    const rejectingTransport = async () =>
      new Response(JSON.stringify({ code: "CAPABILITY_UNAVAILABLE", message: "no" }), {
        status: 503,
        headers: { "Content-Type": "application/json" },
      });
    const outcome = await runCustomerJourneyApp({
      config: baseConfig,
      token: "test-token",
      transport: rejectingTransport,
      now: clock.now,
      sleep: async () => {},
      environment: {
        runtime: "bun test",
        toolchain: "bun",
        database: "none",
        configuration: { suite: "val-050-discrimination" },
      },
      runSuffix: "discrimination",
      taskIndex: HONEST_INDEX,
      env: {},
    });
    expect(outcome.passed).toBe(false);
    expect(outcome.verdict).toBe("JOURNEY-FAILED");
    expect(outcome.appCriteria.map((entry) => entry.criterionId)).toEqual(["submission-landed"]);
    expect(outcome.appCriteria[0]?.status).toBe("FAIL");
    expect(outcome.submission?.rejection?.code).toBe("CAPABILITY_UNAVAILABLE");
  });

  test("the honest observation at the seam matches the row declarations exactly (stage-for-stage economics, digest-stable)", async () => {
    const { outcome } = await runAppOverFakeWorld({ taskIndex: HONEST_INDEX });
    const observation = journeyObservationFor(honestRow);
    expect(JSON.stringify(outcome.journeyCriteria)).toBe(
      JSON.stringify(verifyCustomerJourneyIntegrity({ row: honestRow, observation })),
    );
    // The stage economics equal the recorded declarations (the carried
    // VAL-049 basis — never re-priced at the seam).
    for (const record of observation.stages) {
      const declaration = honestRow.stages.find((stage) => stage.stage === record.stage);
      expect(declaration).toBeDefined();
      expect(record.costMicroUsd).toBe(declaration?.economics.costMicroUsd);
      expect(record.latencyMs).toBe(declaration?.economics.latencyMs);
      expect(record.basisDigest).toBe(declaration?.economics.basisDigest);
    }
  });

  test("the verdict vocabulary is mechanical (only the declared vocabulary, failed criteria NAMED exactly)", async () => {
    const vocabulary = new Set(["JOURNEY-COMPLETED", "JOURNEY-FAILED", "NOT-RUN"]);
    for (const probe of CONTROLLED_FAKES) {
      const observation = journeyObservationFor(honestRow, { probe: probe.probe });
      const verdict = deriveJourneyVerdict({ row: honestRow, observation });
      expect(vocabulary.has(verdict.verdict), probe.probe).toBe(true);
      expect(verdict.failedCriteria, probe.probe).toContain(probe.namedOracle);
    }
    const { outcome } = await runAppOverFakeWorld({ taskIndex: HONEST_INDEX });
    expect(vocabulary.has(outcome.verdict)).toBe(true);
    // Every criterion id is the declared integrity vocabulary only.
    for (const entry of journeyCriteriaOf(outcome)) {
      expect(JOURNEY_INTEGRITY_FAMILIES).toContain(entry.criterionId);
    }
  });
});
