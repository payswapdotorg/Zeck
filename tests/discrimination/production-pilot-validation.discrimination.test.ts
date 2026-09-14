/**
 * VAL-051 acceptance criterion 6 — the discrimination battery: the
 * PRODUCTION-STYLE PILOT WITH SUSTAINED OBSERVATION machinery against
 * controlled fakes, driven through the application's REAL seams.
 *
 * Every catch the work order names is probed at the SEAM level: the
 * seven controlled fakes (a cherry-picked window, a dropped shift, a
 * duplicated resume, a normalized drift, a hidden incident, a hidden
 * residual, a boundary leak) are forced onto an HONEST row's pilot
 * window and driven through the REAL application code —
 * `runProductionPilotApp` over the public SDK/harness boundary (the
 * injected transport seam) — proving the boundary-re-derived EIGHT
 * observation oracles actually DETECT each denatured window (the NAMED
 * criterion FAILing with the mechanism named in evidence), never the
 * transport fake in isolation:
 *
 *   * each controlled fake forced onto the HONEST row FAILs the NAMED
 *     oracle at the boundary (with the honest control — the
 *     undenatured contrast pair — PASSing the same oracle);
 *   * each probe row's OWN window settles FAILED with exactly its
 *     pinned NAMED criteria (the row-level catch);
 *   * REPLAY DETERMINISM: the same observation re-derived twice is
 *     bit-stable, the same row driven twice over fresh fake worlds
 *     lands the identical verdict, and a controlled mutation between
 *     replays flips the verdict and the window digest (a flipped
 *     verdict never reproduces);
 *   * a RUBBER-STAMP oracle (one that passes everything) FAILs the
 *     suite: it passes every controlled fake, the REAL re-derivation
 *     contradicts it on each, and a platform claiming ALL-PASS
 *     statuses over a denatured pilot still FAILs the app's pilot
 *     contract (the boundary never trusts the platform's own claim);
 *   * a FAVORABLE-SUBSET battery (the honest rows only) would
 *     fake-pass — the omitted probe rows are NAMED and each carries a
 *     non-empty pinned failed-criteria vocabulary the subset would
 *     never exercise;
 *   * the LIVE RAIL stays honestly NOT RUN: without the credential
 *     (the env var NAMED) zero submissions land, and the offline fake
 *     world REFUSES the live rail even with the credential set (a
 *     live pilot window is never fabricated offline);
 *   * every offline AC the unit suites cover is re-proven at the seam
 *     (the honest rows' eight oracles, the exactly-once continuation,
 *     the three honest drift classifications, the terminal/agreement/
 *     submission contract pins, the references-only discipline and the
 *     mechanical verdict vocabulary).
 */

import { describe, expect, test } from "vitest";
import { economicDigestOf } from "../../benchmarks/validation/apps/economic-baseline/driver";
import { runProductionPilotApp } from "../../benchmarks/validation/apps/production-pilot/application";
import type { PilotProbeKind } from "../../benchmarks/validation/apps/production-pilot/corpus";
import {
  LIVE_CORPUS_ROWS,
  liveGateOpen,
  OFFLINE_CORPUS_ROWS,
  PILOT_OBSERVATION_FAMILIES,
  PROBE_FAILED_CRITERIA_OF,
  PRODUCTION_PILOT_ROW_IDS,
  pilotRowById,
} from "../../benchmarks/validation/apps/production-pilot/corpus";
import type { PilotObservation } from "../../benchmarks/validation/apps/production-pilot/driver";
import {
  derivePilotVerdict,
  FOREIGN_APPLICATION_ID,
  pilotObservationFor,
  verifyProductionPilotIntegrity,
} from "../../benchmarks/validation/apps/production-pilot/driver";
import {
  createPilotFakeApiWorld,
  createTickClock,
} from "../../benchmarks/validation/apps/production-pilot/fixtures";
import type { LabVerificationCriterion } from "../../benchmarks/validation/platform/derive";

const baseConfig = {
  applicationId: "app-1",
  baseUrl: "https://fake.example.test",
  tokenEnvVar: "ZECK_VALIDATION_TOKEN",
  applicationRevision: "0123456789abcdef0123456789abcdef01234567",
  corpusRevision: "0123456789abcdef0123456789abcdef01234567",
  integrationSurface: "production-pilot:observation",
  pollIntervalMs: 10,
  completionTimeoutMs: 5_000,
};

/** Drive the REAL app over the fake public API world (the SDK seam). */
async function runAppOverFakeWorld(options: {
  readonly taskIndex: number;
  readonly probe?: PilotProbeKind;
  readonly terminal?: "COMPLETED" | "FAILED";
  readonly verificationStatuses?: readonly string[];
  readonly fabricatePassWithFail?: boolean;
  readonly env?: Record<string, string | undefined>;
}) {
  const clock = createTickClock();
  const world = createPilotFakeApiWorld({
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
  const outcome = await runProductionPilotApp({
    config: baseConfig,
    token: "test-token",
    transport: world.transport,
    now: clock.now,
    sleep: async () => {},
    environment: {
      runtime: "bun test",
      toolchain: "bun",
      database: "none",
      configuration: { suite: "val-051-discrimination" },
    },
    runSuffix: "discrimination",
    taskIndex: options.taskIndex,
    env: options.env ?? {},
  });
  return { outcome, world };
}

const HONEST_ROW_ID = "full-window-recorded-basis";
const HONEST_INDEX = PRODUCTION_PILOT_ROW_IDS.indexOf(HONEST_ROW_ID);
const honestRow = pilotRowById(HONEST_ROW_ID);
if (honestRow === null) {
  throw new Error(`unknown corpus row ${HONEST_ROW_ID}`);
}

/**
 * The seven controlled fakes, each with its NAMED oracle, the honest
 * row whose discipline it denatures and the mechanism evidence token.
 */
const CONTROLLED_FAKES: readonly {
  readonly probe: PilotProbeKind;
  readonly rowId: string;
  readonly namedOracle: string;
  readonly mechanismToken: string;
  /** The honest control's PASSING evidence token on the same oracle. */
  readonly controlToken: string;
}[] = [
  {
    probe: "window-cherry-picking",
    rowId: "full-window-recorded-basis",
    namedOracle: "window-honesty",
    mechanismToken: "omitted-segment:shift-5",
    controlToken: "observed-window:1-5",
  },
  {
    probe: "dropped-shift",
    rowId: "full-window-recorded-basis",
    namedOracle: "schedule-completeness",
    mechanismToken: "missing-shift:shift-4",
    controlToken: "observed-shifts:shift-1>shift-2>shift-3>shift-4>shift-5",
  },
  {
    probe: "double-driven-resume",
    rowId: "window-incident-resume",
    namedOracle: "continuation-exactly-once",
    mechanismToken: "resume-violation:shift-4",
    controlToken: "shift-4:executions=2,resumed=true",
  },
  {
    probe: "drift-normalizing",
    rowId: "window-drift-declared",
    namedOracle: "drift-classification-honesty",
    mechanismToken: "normalized-drift:shift-4",
    controlToken: "shift-4:classification=drifting,mechanism=provider-route-inefficiency",
  },
  {
    probe: "incident-hiding",
    rowId: "window-incident-resume",
    namedOracle: "incident-honesty",
    mechanismToken: "hidden-incident:shift-4",
    controlToken: "recorded-incidents:1",
  },
  {
    probe: "residual-hiding",
    rowId: "full-window-recorded-basis",
    namedOracle: "end-of-window-accounting",
    mechanismToken: "cost-residual:-4800",
    controlToken: "cost-residual:0",
  },
  {
    probe: "boundary-leak",
    rowId: "full-window-recorded-basis",
    namedOracle: "customer-boundary",
    mechanismToken: "boundary-leak:shift-4",
    controlToken: "observed-identities:1",
  },
];

const pilotCriteriaOf = (outcome: {
  readonly pilotCriteria: readonly LabVerificationCriterion[];
}) => outcome.pilotCriteria;

const criterion = (
  outcome: { readonly pilotCriteria: readonly LabVerificationCriterion[] },
  criterionId: string,
): LabVerificationCriterion | undefined =>
  pilotCriteriaOf(outcome).find((entry) => entry.criterionId === criterionId);

// ---------------------------------------------------------------------------
// 1..7 — the seven controlled fakes, each DETECTED at the seam
// ---------------------------------------------------------------------------

describe("discrimination: a cherry-picked window (the pilot observes a sub-window)", () => {
  test("forcing the window-cherry-picking fake onto the HONEST row FAILs window-honesty with the omitted segment NAMED", async () => {
    const { outcome } = await runAppOverFakeWorld({
      taskIndex: HONEST_INDEX,
      probe: "window-cherry-picking",
    });
    expect(outcome.verdict).toBe("PILOT-FAILED");
    const honesty = criterion(outcome, "window-honesty");
    expect(honesty?.status).toBe("FAIL");
    expect(honesty?.evidence.join(" ")).toContain("omitted-segment:shift-5");
    // The omitted segment's recorded cost is never hidden (the
    // accounting oracle names the window-basis residual: 400 microUsd).
    const accounting = criterion(outcome, "end-of-window-accounting");
    expect(accounting?.status).toBe("FAIL");
    expect(accounting?.evidence.join(" ")).toContain("window-basis-residual:400");
    // The honest row's contract cannot absorb the denatured window.
    expect(outcome.passed).toBe(false);
  });

  test("the honest control (the contrast pair): the undenatured row PASSes the same oracle at the seam", async () => {
    const { outcome } = await runAppOverFakeWorld({ taskIndex: HONEST_INDEX });
    expect(outcome.verdict).toBe("PILOT-COMPLETED");
    const failed = pilotCriteriaOf(outcome).filter((entry) => entry.status === "FAIL");
    expect(failed).toEqual([]);
    expect(criterion(outcome, "window-honesty")?.evidence.join(" ")).toContain(
      "observed-window:1-5",
    );
  });

  test("the row-level catch: the probe row settles FAILED with exactly its pinned criteria", async () => {
    const rowId = "probe-window-cherry-picking";
    const taskIndex = PRODUCTION_PILOT_ROW_IDS.indexOf(rowId);
    const { outcome } = await runAppOverFakeWorld({ taskIndex });
    expect(outcome.observedTerminal).toBe("FAILED");
    expect(outcome.verdict).toBe("PILOT-FAILED");
    const failed = pilotCriteriaOf(outcome)
      .filter((entry) => entry.status === "FAIL")
      .map((entry) => entry.criterionId)
      .sort();
    expect(failed).toEqual([...PROBE_FAILED_CRITERIA_OF["window-cherry-picking"]].sort());
  });
});

describe("discrimination: a dropped shift (a scheduled shift silently never lands)", () => {
  test("forcing the dropped-shift fake onto the HONEST row FAILs schedule-completeness with the shift NAMED", async () => {
    const { outcome } = await runAppOverFakeWorld({
      taskIndex: HONEST_INDEX,
      probe: "dropped-shift",
    });
    expect(outcome.verdict).toBe("PILOT-FAILED");
    const completeness = criterion(outcome, "schedule-completeness");
    expect(completeness?.status).toBe("FAIL");
    expect(completeness?.evidence.join(" ")).toContain("missing-shift:shift-4");
    // The dropped shift's recorded cost is never hidden (the accounting
    // oracle names the window-basis residual: 9600 microUsd).
    const accounting = criterion(outcome, "end-of-window-accounting");
    expect(accounting?.status).toBe("FAIL");
    expect(accounting?.evidence.join(" ")).toContain("window-basis-residual:9600");
    expect(outcome.passed).toBe(false);
  });

  test("the honest control: every scheduled shift lands exactly once in schedule order at the seam", async () => {
    const { outcome } = await runAppOverFakeWorld({ taskIndex: HONEST_INDEX });
    const completeness = criterion(outcome, "schedule-completeness");
    expect(completeness?.status).toBe("PASS");
    expect(completeness?.evidence.join(" ")).toContain(
      "observed-shifts:shift-1>shift-2>shift-3>shift-4>shift-5",
    );
  });

  test("the row-level catch: the probe row settles FAILED with exactly its pinned criteria", async () => {
    const taskIndex = PRODUCTION_PILOT_ROW_IDS.indexOf("probe-dropped-shift");
    const { outcome } = await runAppOverFakeWorld({ taskIndex });
    expect(outcome.observedTerminal).toBe("FAILED");
    const failed = pilotCriteriaOf(outcome)
      .filter((entry) => entry.status === "FAIL")
      .map((entry) => entry.criterionId)
      .sort();
    expect(failed).toEqual([...PROBE_FAILED_CRITERIA_OF["dropped-shift"]].sort());
  });
});

describe("discrimination: a duplicated resume (the resumed shift driven twice)", () => {
  test("forcing the double-driven-resume fake onto the incident row FAILs continuation-exactly-once with the counts NAMED", async () => {
    const taskIndex = PRODUCTION_PILOT_ROW_IDS.indexOf("window-incident-resume");
    const { outcome } = await runAppOverFakeWorld({
      taskIndex,
      probe: "double-driven-resume",
    });
    expect(outcome.verdict).toBe("PILOT-FAILED");
    const continuation = criterion(outcome, "continuation-exactly-once");
    expect(continuation?.status).toBe("FAIL");
    const evidence = continuation?.evidence.join(" ") ?? "";
    expect(evidence).toContain("resume-violation:shift-4");
    expect(evidence).toContain("observed executions=3");
    // The three-criterion probe: the unauthorized spend is NAMED too
    // (28800 observed over the 19200 reservation; budget exceeded).
    const envelope = criterion(outcome, "budget-policy-envelope");
    expect(envelope?.status).toBe("FAIL");
    const envelopeEvidence = envelope?.evidence.join(" ") ?? "";
    expect(envelopeEvidence).toContain("unauthorized-spend:shift-4");
    expect(envelopeEvidence).toContain("budget-exceeded");
    // And the duplicated work's residual is NAMED (9600 microUsd).
    const accounting = criterion(outcome, "end-of-window-accounting");
    expect(accounting?.status).toBe("FAIL");
    expect(accounting?.evidence.join(" ")).toContain("unexplained-residual:shift-4");
    expect(outcome.passed).toBe(false);
  });

  test("the honest control: the declared incident resumes EXACTLY ONCE (two durable executions) at the seam", async () => {
    const taskIndex = PRODUCTION_PILOT_ROW_IDS.indexOf("window-incident-resume");
    const { outcome } = await runAppOverFakeWorld({ taskIndex });
    const continuation = criterion(outcome, "continuation-exactly-once");
    expect(continuation?.status).toBe("PASS");
    const evidence = continuation?.evidence.join(" ") ?? "";
    expect(evidence).toContain("declared-incident:shift-4");
    expect(evidence).toContain("shift-4:executions=2,resumed=true");
  });

  test("the row-level catch: the probe row settles FAILED with exactly its pinned criteria", async () => {
    const taskIndex = PRODUCTION_PILOT_ROW_IDS.indexOf("probe-double-driven-resume");
    const { outcome } = await runAppOverFakeWorld({ taskIndex });
    expect(outcome.observedTerminal).toBe("FAILED");
    const failed = pilotCriteriaOf(outcome)
      .filter((entry) => entry.status === "FAIL")
      .map((entry) => entry.criterionId)
      .sort();
    expect(failed).toEqual([...PROBE_FAILED_CRITERIA_OF["double-driven-resume"]].sort());
  });
});

describe("discrimination: a normalized drift (beyond-band drift reported within bounds)", () => {
  test("forcing the drift-normalizing fake onto the declared-drift row FAILs drift-classification-honesty with the segment and mechanism NAMED", async () => {
    const taskIndex = PRODUCTION_PILOT_ROW_IDS.indexOf("window-drift-declared");
    const { outcome } = await runAppOverFakeWorld({ taskIndex, probe: "drift-normalizing" });
    expect(outcome.verdict).toBe("PILOT-FAILED");
    const drift = criterion(outcome, "drift-classification-honesty");
    expect(drift?.status).toBe("FAIL");
    const evidence = drift?.evidence.join(" ") ?? "";
    expect(evidence).toContain("normalized-drift:shift-4");
    expect(evidence).toContain("beyond band 480");
    // The normalized delta surfaces as the unexplained residual (1152
    // microUsd) — drift is never silently normalized away.
    const accounting = criterion(outcome, "end-of-window-accounting");
    expect(accounting?.status).toBe("FAIL");
    expect(accounting?.evidence.join(" ")).toContain("unexplained-residual:shift-4 (1152)");
    expect(outcome.passed).toBe(false);
  });

  test("the honest control: the beyond-band deviation is classified DRIFTING with the mechanism NAMED at the seam", async () => {
    const taskIndex = PRODUCTION_PILOT_ROW_IDS.indexOf("window-drift-declared");
    const { outcome } = await runAppOverFakeWorld({ taskIndex });
    const drift = criterion(outcome, "drift-classification-honesty");
    expect(drift?.status).toBe("PASS");
    expect(drift?.evidence.join(" ")).toContain(
      "shift-4:classification=drifting,mechanism=provider-route-inefficiency",
    );
  });

  test("the row-level catch: the probe row settles FAILED with exactly its pinned criteria", async () => {
    const taskIndex = PRODUCTION_PILOT_ROW_IDS.indexOf("probe-drift-normalizing");
    const { outcome } = await runAppOverFakeWorld({ taskIndex });
    expect(outcome.observedTerminal).toBe("FAILED");
    const failed = pilotCriteriaOf(outcome)
      .filter((entry) => entry.status === "FAIL")
      .map((entry) => entry.criterionId)
      .sort();
    expect(failed).toEqual([...PROBE_FAILED_CRITERIA_OF["drift-normalizing"]].sort());
  });
});

describe("discrimination: a hidden incident (the resumed shift's failure never recorded)", () => {
  test("forcing the incident-hiding fake onto the incident row FAILs incident-honesty with the incident NAMED", async () => {
    const taskIndex = PRODUCTION_PILOT_ROW_IDS.indexOf("window-incident-resume");
    const { outcome } = await runAppOverFakeWorld({ taskIndex, probe: "incident-hiding" });
    expect(outcome.verdict).toBe("PILOT-FAILED");
    const incident = criterion(outcome, "incident-honesty");
    expect(incident?.status).toBe("FAIL");
    const evidence = incident?.evidence.join(" ") ?? "";
    expect(evidence).toContain("hidden-incident:shift-4");
    expect(evidence).toContain("resumed execution with no incident record");
    // ONLY the incident oracle catches it (the resume itself landed
    // exactly once — the continuation oracle PASSes).
    expect(criterion(outcome, "continuation-exactly-once")?.status).toBe("PASS");
    expect(outcome.passed).toBe(false);
  });

  test("the honest control: the incident is recorded and attributed at the seam", async () => {
    const taskIndex = PRODUCTION_PILOT_ROW_IDS.indexOf("window-incident-resume");
    const { outcome } = await runAppOverFakeWorld({ taskIndex });
    const incident = criterion(outcome, "incident-honesty");
    expect(incident?.status).toBe("PASS");
    const evidence = incident?.evidence.join(" ") ?? "";
    expect(evidence).toContain("recorded-incidents:1");
    expect(evidence).toContain("shift-4:incident=recorded,mechanism=recorded-failure-machinery");
  });

  test("the row-level catch: the probe row settles FAILED with exactly its pinned criteria", async () => {
    const taskIndex = PRODUCTION_PILOT_ROW_IDS.indexOf("probe-incident-hiding");
    const { outcome } = await runAppOverFakeWorld({ taskIndex });
    expect(outcome.observedTerminal).toBe("FAILED");
    const failed = pilotCriteriaOf(outcome)
      .filter((entry) => entry.status === "FAIL")
      .map((entry) => entry.criterionId)
      .sort();
    expect(failed).toEqual([...PROBE_FAILED_CRITERIA_OF["incident-hiding"]].sort());
  });
});

describe("discrimination: a hidden residual (the reported window total hides observed spend)", () => {
  test("forcing the residual-hiding fake onto the HONEST row FAILs end-of-window-accounting with the exact residual NAMED", async () => {
    const { outcome } = await runAppOverFakeWorld({
      taskIndex: HONEST_INDEX,
      probe: "residual-hiding",
    });
    expect(outcome.verdict).toBe("PILOT-FAILED");
    const accounting = criterion(outcome, "end-of-window-accounting");
    expect(accounting?.status).toBe("FAIL");
    // The exact hidden amount: half the daily-usage shift's observed cost.
    const honest = pilotObservationFor(honestRow);
    const dailyUsage = honest.shifts.find((record) => record.workload === "daily-usage");
    expect(dailyUsage).toBeDefined();
    const hidden = BigInt(dailyUsage?.observedCostMicroUsd ?? "0") / 2n;
    expect(accounting?.evidence.join(" ")).toContain(`cost-residual:-${hidden.toString()}`);
    expect(hidden.toString()).toBe("4800");
    // ONLY the accounting oracle catches it (the window, schedule,
    // continuation, drift, boundary are all honest here).
    for (const family of [
      "window-honesty",
      "schedule-completeness",
      "continuation-exactly-once",
      "drift-classification-honesty",
      "incident-honesty",
      "budget-policy-envelope",
      "customer-boundary",
    ]) {
      expect(criterion(outcome, family)?.status, family).toBe("PASS");
    }
    expect(outcome.passed).toBe(false);
  });

  test("the honest control: the reported total reconciles shift-for-shift with zero residual at the seam", async () => {
    const { outcome } = await runAppOverFakeWorld({ taskIndex: HONEST_INDEX });
    const accounting = criterion(outcome, "end-of-window-accounting");
    expect(accounting?.status).toBe("PASS");
    const evidence = accounting?.evidence.join(" ") ?? "";
    expect(evidence).toContain("cost-residual:0");
    expect(evidence).toContain("release-residual:0");
  });

  test("the row-level catch: the probe row settles FAILED with exactly its pinned criteria", async () => {
    const taskIndex = PRODUCTION_PILOT_ROW_IDS.indexOf("probe-residual-hiding");
    const { outcome } = await runAppOverFakeWorld({ taskIndex });
    expect(outcome.observedTerminal).toBe("FAILED");
    const failed = pilotCriteriaOf(outcome)
      .filter((entry) => entry.status === "FAIL")
      .map((entry) => entry.criterionId)
      .sort();
    expect(failed).toEqual([...PROBE_FAILED_CRITERIA_OF["residual-hiding"]].sort());
  });
});

describe("discrimination: a boundary leak (a shift under another customer's identity)", () => {
  test("forcing the boundary-leak fake onto the HONEST row FAILs customer-boundary with the foreign identity NAMED", async () => {
    const { outcome } = await runAppOverFakeWorld({
      taskIndex: HONEST_INDEX,
      probe: "boundary-leak",
    });
    expect(outcome.verdict).toBe("PILOT-FAILED");
    const boundary = criterion(outcome, "customer-boundary");
    expect(boundary?.status).toBe("FAIL");
    const evidence = boundary?.evidence.join(" ") ?? "";
    expect(evidence).toContain("boundary-leak:shift-4");
    expect(evidence).toContain(FOREIGN_APPLICATION_ID);
    expect(evidence).toContain("not app-pilot-customer");
    expect(outcome.passed).toBe(false);
  });

  test("the honest control: every shift executes under the pilot's own customer identity at the seam", async () => {
    const { outcome } = await runAppOverFakeWorld({ taskIndex: HONEST_INDEX });
    const boundary = criterion(outcome, "customer-boundary");
    expect(boundary?.status).toBe("PASS");
    expect(boundary?.evidence.join(" ")).toContain("observed-identities:1");
  });

  test("the row-level catch: the probe row settles FAILED with exactly its pinned criteria", async () => {
    const taskIndex = PRODUCTION_PILOT_ROW_IDS.indexOf("probe-boundary-leak");
    const { outcome } = await runAppOverFakeWorld({ taskIndex });
    expect(outcome.observedTerminal).toBe("FAILED");
    const failed = pilotCriteriaOf(outcome)
      .filter((entry) => entry.status === "FAIL")
      .map((entry) => entry.criterionId)
      .sort();
    expect(failed).toEqual([...PROBE_FAILED_CRITERIA_OF["boundary-leak"]].sort());
  });
});

// ---------------------------------------------------------------------------
// 8 — replay determinism (the same observation re-derived bit-stable)
// ---------------------------------------------------------------------------

describe("discrimination: replay determinism", () => {
  test("the same observation re-derived twice yields BIT-IDENTICAL criteria (honest + every fake)", () => {
    for (const fake of CONTROLLED_FAKES) {
      const row = pilotRowById(fake.rowId);
      if (row === null) {
        throw new Error(`unknown corpus row ${fake.rowId}`);
      }
      const observation = pilotObservationFor(row, { probe: fake.probe });
      const first = JSON.stringify(verifyProductionPilotIntegrity({ row, observation }));
      const second = JSON.stringify(verifyProductionPilotIntegrity({ row, observation }));
      expect(second, fake.probe).toBe(first);
      // The observation itself is a pure derivation (re-derived identical).
      expect(pilotObservationFor(row, { probe: fake.probe })).toEqual(observation);
    }
    const honest = pilotObservationFor(honestRow);
    expect(
      JSON.stringify(verifyProductionPilotIntegrity({ row: honestRow, observation: honest })),
    ).toBe(JSON.stringify(verifyProductionPilotIntegrity({ row: honestRow, observation: honest })));
  });

  test("the same row driven twice over fresh fake worlds lands the IDENTICAL verdict and pilot criteria", async () => {
    const firstRun = await runAppOverFakeWorld({ taskIndex: HONEST_INDEX });
    const secondRun = await runAppOverFakeWorld({ taskIndex: HONEST_INDEX });
    expect(secondRun.outcome.verdict).toBe(firstRun.outcome.verdict);
    expect(JSON.stringify(secondRun.outcome.pilotCriteria)).toBe(
      JSON.stringify(firstRun.outcome.pilotCriteria),
    );
    // A flipped verdict on replay would FAIL here — the re-derivation
    // must reproduce bit-for-bit.
    expect(secondRun.outcome.passed).toBe(true);
    // And the same holds for a denatured window (the fake is stable too).
    const firstFake = await runAppOverFakeWorld({
      taskIndex: HONEST_INDEX,
      probe: "dropped-shift",
    });
    const secondFake = await runAppOverFakeWorld({
      taskIndex: HONEST_INDEX,
      probe: "dropped-shift",
    });
    expect(secondFake.outcome.verdict).toBe(firstFake.outcome.verdict);
    expect(JSON.stringify(secondFake.outcome.pilotCriteria)).toBe(
      JSON.stringify(firstFake.outcome.pilotCriteria),
    );
  });

  test("a controlled mutation between replays flips the verdict and the window digest (determinism is discriminating, never vacuous)", () => {
    const honest = pilotObservationFor(honestRow);
    const honestVerdict = derivePilotVerdict({ row: honestRow, observation: honest });
    expect(honestVerdict.verdict).toBe("PILOT-COMPLETED");
    // The mutation: the replay drops one shift record (a durable read
    // that silently lost the daily-usage execution).
    const mutated: PilotObservation = {
      ...honest,
      shifts: honest.shifts.filter((record) => record.workload !== "daily-usage"),
    };
    const mutatedVerdict = derivePilotVerdict({ row: honestRow, observation: mutated });
    expect(mutatedVerdict.verdict).toBe("PILOT-FAILED");
    expect(mutatedVerdict.failedCriteria).toContain("schedule-completeness");
    // The re-derived window digest over the mutated shift list differs
    // (the same FNV-1a convention the driver pins) — a durable read
    // that silently lost a shift is digest-visible.
    const mutatedDigest = economicDigestOf({
      rowId: honest.rowId,
      window: `${honest.window.startShift}-${honest.window.endShift}`,
      shifts: mutated.shifts.map((record) => `${record.shiftId}:${record.executions}`),
    });
    expect(mutatedDigest === honest.windowDigest).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 9 — a rubber-stamp oracle (one that passes everything) FAILs the suite
// ---------------------------------------------------------------------------

/** The controlled RUBBER-STAMP oracle: passes everything, re-derives nothing. */
const rubberStampOracle = (observation: PilotObservation): readonly LabVerificationCriterion[] =>
  PILOT_OBSERVATION_FAMILIES.map((family) => ({
    criterionId: family,
    strategy: "deterministic",
    status: "PASS",
    evidence: [`rubber-stamp:${observation.rowId} passed without re-derivation`],
  }));

describe("discrimination: a rubber-stamp oracle", () => {
  test("the confession: a pass-everything oracle passes EVERY controlled fake (worthless on its own)", () => {
    for (const fake of CONTROLLED_FAKES) {
      const row = pilotRowById(fake.rowId);
      if (row === null) {
        throw new Error(`unknown corpus row ${fake.rowId}`);
      }
      const observation = pilotObservationFor(row, { probe: fake.probe });
      const stamped = rubberStampOracle(observation);
      expect(
        stamped.every((entry) => entry.status === "PASS"),
        fake.probe,
      ).toBe(true);
    }
  });

  test("the suite FAILs it: the REAL boundary re-derivation contradicts the stamp on EVERY fake (the named criteria FAIL where the stamp says PASS)", () => {
    for (const fake of CONTROLLED_FAKES) {
      const row = pilotRowById(fake.rowId);
      if (row === null) {
        throw new Error(`unknown corpus row ${fake.rowId}`);
      }
      const observation = pilotObservationFor(row, { probe: fake.probe });
      const stamped = rubberStampOracle(observation);
      const real = verifyProductionPilotIntegrity({ row, observation });
      // An oracle that passes everything cannot satisfy this suite: the
      // real machinery FAILs the named criterion the stamp passed.
      const named = real.find((entry) => entry.criterionId === fake.namedOracle);
      expect(named?.status, fake.probe).toBe("FAIL");
      const stampedNamed = stamped.find((entry) => entry.criterionId === fake.namedOracle);
      expect(stampedNamed?.status, fake.probe).toBe("PASS");
      expect(derivePilotVerdict({ row, observation }).verdict, fake.probe).toBe("PILOT-FAILED");
    }
  });

  test("the seam-level rubber stamp: a platform claiming ALL-PASS statuses over a denatured pilot still FAILs the app contract", async () => {
    // The platform's own verification claims PASS,PASS (the rubber
    // stamp) while the pilot window is denatured — the app re-derives
    // AT THE BOUNDARY and refuses to trust the claim.
    const { outcome } = await runAppOverFakeWorld({
      taskIndex: HONEST_INDEX,
      probe: "dropped-shift",
      verificationStatuses: ["PASS", "PASS"],
    });
    expect(outcome.verificationStatuses).toEqual(["PASS", "PASS"]);
    expect(outcome.verdict).toBe("PILOT-FAILED");
    expect(outcome.passed).toBe(false);
    expect(criterion(outcome, "schedule-completeness")?.status).toBe("FAIL");
    const named = outcome.appCriteria.find(
      (entry) => entry.criterionId === "app-failed-criteria-named",
    );
    expect(named?.status).toBe("FAIL");
  });
});

// ---------------------------------------------------------------------------
// 10 — a favorable-subset battery (the honest rows only) would fake-pass
// ---------------------------------------------------------------------------

describe("discrimination: a favorable-subset battery", () => {
  const HONEST_ROW_IDS = OFFLINE_CORPUS_ROWS.filter((row) => row.probe === undefined).map(
    (row) => row.rowId,
  );
  const OMITTED_ROW_IDS = OFFLINE_CORPUS_ROWS.filter((row) => row.probe !== undefined).map(
    (row) => row.rowId,
  );

  test("the tempting fake-pass: the honest-only subset drives green at the seam (omitting exactly the seven probe rows, NAMED)", async () => {
    for (const rowId of HONEST_ROW_IDS) {
      const taskIndex = PRODUCTION_PILOT_ROW_IDS.indexOf(rowId);
      const { outcome } = await runAppOverFakeWorld({ taskIndex });
      expect(outcome.passed, rowId).toBe(true);
      const failed = pilotCriteriaOf(outcome).filter((entry) => entry.status === "FAIL");
      expect(failed, rowId).toEqual([]);
    }
    // The favorable subset omits EXACTLY the seven adversarial probe
    // rows (NAMED) — every one of which carries a non-empty pinned
    // failed-criteria vocabulary the subset would never exercise.
    expect(OMITTED_ROW_IDS).toEqual([
      "probe-window-cherry-picking",
      "probe-dropped-shift",
      "probe-double-driven-resume",
      "probe-drift-normalizing",
      "probe-incident-hiding",
      "probe-residual-hiding",
      "probe-boundary-leak",
    ]);
    for (const rowId of OMITTED_ROW_IDS) {
      const row = pilotRowById(rowId);
      expect(row?.probe?.kind, rowId).toBeDefined();
      expect(
        row?.probe ? PROBE_FAILED_CRITERIA_OF[row.probe.kind].length : 0,
        rowId,
      ).toBeGreaterThan(0);
    }
  });

  test("the full battery FAILs each omitted probe row's pinned criteria (the subset hid every discrimination)", async () => {
    for (const rowId of OMITTED_ROW_IDS) {
      const taskIndex = PRODUCTION_PILOT_ROW_IDS.indexOf(rowId);
      const row = pilotRowById(rowId);
      const { outcome } = await runAppOverFakeWorld({ taskIndex });
      expect(outcome.observedTerminal, rowId).toBe("FAILED");
      const failed = pilotCriteriaOf(outcome)
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
// 11 — the live-rail boundary (the honest NOT RUN pin)
// ---------------------------------------------------------------------------

describe("discrimination: the live-rail boundary (NOT RUN honesty)", () => {
  test("the live row stays NOT RUN without OPENROUTER_API_KEY (the env var NAMED, zero submissions)", async () => {
    const taskIndex = PRODUCTION_PILOT_ROW_IDS.indexOf("live-pilot-window");
    const { outcome, world } = await runAppOverFakeWorld({ taskIndex, env: {} });
    expect(world.createdExecutions).toBe(0);
    expect(outcome.verdict).toBe("NOT-RUN");
    expect(outcome.notRunReason).toContain("OPENROUTER_API_KEY");
    expect(outcome.submission).toBeNull();
    expect(outcome.passed).toBe(true);
    expect(outcome.appCriteria.map((entry) => entry.criterionId)).toEqual(["app-live-gate-honest"]);
  });

  test("the offline fake world REFUSES the live rail even with the credential set (a live pilot window is never fabricated offline)", async () => {
    const taskIndex = PRODUCTION_PILOT_ROW_IDS.indexOf("live-pilot-window");
    const { outcome, world } = await runAppOverFakeWorld({
      taskIndex,
      env: { OPENROUTER_API_KEY: "operator-authorized" },
    });
    expect(world.createdExecutions).toBe(0);
    expect(outcome.passed).toBe(false);
    expect(outcome.verdict).toBe("PILOT-FAILED");
    const landed = outcome.appCriteria.find((entry) => entry.criterionId === "submission-landed");
    expect(landed?.status).toBe("FAIL");
    // The derivation-level pin: the gate consults the env honestly.
    const liveRow = LIVE_CORPUS_ROWS[0];
    if (liveRow === undefined) {
      throw new Error("the corpus declares no live row");
    }
    expect(liveGateOpen(liveRow, {})).toBe(false);
    expect(liveGateOpen(liveRow, { OPENROUTER_API_KEY: "" })).toBe(false);
    expect(liveGateOpen(liveRow, { OPENROUTER_API_KEY: "x" })).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 12 — every offline AC the unit suites cover, re-proven at the seam
// ---------------------------------------------------------------------------

describe("the seam-level offline AC coverage (the unit suites' pins over the app boundary)", () => {
  test("every offline honest row lands ONE durable execution and settles COMPLETED with all EIGHT oracles PASSing", async () => {
    for (const rowId of [
      "full-window-recorded-basis",
      "window-incident-resume",
      "window-drift-within-bounds",
      "window-drift-declared",
      "window-regression-declared",
    ]) {
      const taskIndex = PRODUCTION_PILOT_ROW_IDS.indexOf(rowId);
      const { outcome, world } = await runAppOverFakeWorld({ taskIndex });
      expect(world.createdExecutions, rowId).toBe(1);
      expect(outcome.observedTerminal, rowId).toBe("COMPLETED");
      expect(outcome.verdict, rowId).toBe("PILOT-COMPLETED");
      const failedApp = outcome.appCriteria.filter((entry) => entry.status === "FAIL");
      expect(failedApp, rowId).toEqual([]);
      const failedPilot = pilotCriteriaOf(outcome).filter((entry) => entry.status === "FAIL");
      expect(failedPilot, `${rowId}: ${JSON.stringify(failedPilot)}`).toEqual([]);
      // The offline usage is honestly none-reported (the shifts replay
      // recorded workloads — never a fabricated measurement).
      expect(outcome.usage, rowId).toBeNull();
      expect(outcome.notRunReason, rowId).toBeNull();
    }
  });

  test("the incident row resumes exactly once at the seam (two durable executions for the failed shift)", async () => {
    const taskIndex = PRODUCTION_PILOT_ROW_IDS.indexOf("window-incident-resume");
    const { outcome } = await runAppOverFakeWorld({ taskIndex });
    const continuation = criterion(outcome, "continuation-exactly-once");
    expect(continuation?.status).toBe("PASS");
    const evidence = continuation?.evidence.join(" ") ?? "";
    expect(evidence).toContain("declared-incident:shift-4");
    expect(evidence).toContain("shift-4:executions=2,resumed=true");
  });

  test("the drift rows classify honestly at the seam (within-bounds / drifting NAMED / regressing NAMED)", async () => {
    for (const [rowId, expectedEntry] of [
      ["window-drift-within-bounds", "shift-2:classification=within-bounds"],
      [
        "window-drift-declared",
        "shift-4:classification=drifting,mechanism=provider-route-inefficiency",
      ],
      [
        "window-regression-declared",
        "shift-5:classification=regressing,mechanism=output-quality-degradation",
      ],
    ] as const) {
      const taskIndex = PRODUCTION_PILOT_ROW_IDS.indexOf(rowId);
      const { outcome } = await runAppOverFakeWorld({ taskIndex });
      const drift = criterion(outcome, "drift-classification-honesty");
      expect(drift?.status, rowId).toBe("PASS");
      expect(drift?.evidence.join(" "), rowId).toContain(expectedEntry);
    }
  });

  test("the headroom row's reservations settle with the released remainder NAMED (the envelope over the seam)", async () => {
    const taskIndex = PRODUCTION_PILOT_ROW_IDS.indexOf("full-window-recorded-basis");
    const { outcome } = await runAppOverFakeWorld({ taskIndex });
    const envelope = criterion(outcome, "budget-policy-envelope");
    expect(envelope?.status).toBe("PASS");
    const evidence = envelope?.evidence.join(" ") ?? "";
    // 14850 reserved against 13500 observed — the 1350 release is NAMED.
    expect(evidence).toContain("released:1350");
    expect(evidence).toContain("ledger-append-only:true");
    expect(evidence).toContain("ledger-entries:6");
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

  test("a fabricated pass-with-fail FAILs the app-terminal-criteria-agreement criterion at the seam", async () => {
    const taskIndex = PRODUCTION_PILOT_ROW_IDS.indexOf("probe-dropped-shift");
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
    const outcome = await runProductionPilotApp({
      config: baseConfig,
      token: "test-token",
      transport: rejectingTransport,
      now: clock.now,
      sleep: async () => {},
      environment: {
        runtime: "bun test",
        toolchain: "bun",
        database: "none",
        configuration: { suite: "val-051-discrimination" },
      },
      runSuffix: "discrimination",
      taskIndex: HONEST_INDEX,
      env: {},
    });
    expect(outcome.passed).toBe(false);
    expect(outcome.verdict).toBe("PILOT-FAILED");
    expect(outcome.appCriteria.map((entry) => entry.criterionId)).toEqual(["submission-landed"]);
    expect(outcome.appCriteria[0]?.status).toBe("FAIL");
    expect(outcome.submission?.rejection?.code).toBe("CAPABILITY_UNAVAILABLE");
  });

  test("the honest observation at the seam matches the row declarations exactly (economics + drift deltas, digest-stable)", async () => {
    const { outcome } = await runAppOverFakeWorld({ taskIndex: HONEST_INDEX });
    const observation = pilotObservationFor(honestRow);
    expect(JSON.stringify(outcome.pilotCriteria)).toBe(
      JSON.stringify(verifyProductionPilotIntegrity({ row: honestRow, observation })),
    );
    // The shift economics equal the recorded declarations plus the
    // declared drift deltas (the carried VAL-049/050 basis — never
    // re-priced at the seam).
    for (const record of observation.shifts) {
      const declaration = honestRow.schedule.find((shift) => shift.shiftId === record.shiftId);
      expect(declaration).toBeDefined();
      expect(record.observedCostMicroUsd).toBe(declaration?.economics.costMicroUsd);
      expect(record.observedLatencyMs).toBe(declaration?.economics.latencyMs);
    }
    // The window digest is bit-stable per row + shape.
    expect(pilotObservationFor(honestRow).windowDigest).toBe(observation.windowDigest);
  });

  test("the verdict vocabulary is mechanical (only the declared vocabulary, failed criteria NAMED exactly)", async () => {
    const vocabulary = new Set(["PILOT-COMPLETED", "PILOT-FAILED", "NOT-RUN"]);
    for (const fake of CONTROLLED_FAKES) {
      const row = pilotRowById(fake.rowId);
      if (row === null) {
        throw new Error(`unknown corpus row ${fake.rowId}`);
      }
      const observation = pilotObservationFor(row, { probe: fake.probe });
      const verdict = derivePilotVerdict({ row, observation });
      expect(vocabulary.has(verdict.verdict), fake.probe).toBe(true);
      expect(verdict.failedCriteria, fake.probe).toContain(fake.namedOracle);
    }
    const { outcome } = await runAppOverFakeWorld({ taskIndex: HONEST_INDEX });
    expect(vocabulary.has(outcome.verdict)).toBe(true);
    // Every criterion id is the declared observation vocabulary only.
    for (const entry of pilotCriteriaOf(outcome)) {
      expect(PILOT_OBSERVATION_FAMILIES).toContain(entry.criterionId);
    }
    expect(pilotCriteriaOf(outcome)).toHaveLength(PILOT_OBSERVATION_FAMILIES.length);
  });
});
