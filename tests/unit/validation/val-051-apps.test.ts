/**
 * VAL-051 acceptance criteria 1, 2, 4, 5 and 7 (the app boundary +
 * the configuration consistency + the honest verdicts): the
 * production-style pilot application over the public SDK boundary.
 *
 *   * the corpus + configuration consistency: config.json mirrors the
 *     exported task slice exactly; the row ids unique; every honest
 *     row declares the full five-shift schedule and all eight
 *     observation families; every probe row's expected failed criteria
 *     NAMED per the pinned vocabulary; every shift recorded-input
 *     digest well-formed (FNV-1a, payload-free) and chained exactly
 *     into the VAL-050 journey basis (whose stages carry the VAL-049
 *     audited economics); the task bodies carry REFERENCES ONLY;
 *   * the app over the honest fake world: every offline honest row
 *     lands ONE durable execution and settles COMPLETED with all
 *     boundary criteria and all eight observation criteria PASSing;
 *     the usage is honestly none offline;
 *   * the live boundary: exactly ONE env-gated live row; NOT RUN
 *     without OPENROUTER_API_KEY (the env var NAMED, zero
 *     submissions); the offline fake world refuses the live rail
 *     outright (a live pilot window is never fabricated offline);
 *   * the adversarial pilot-probe rows: each settles FAILED with the
 *     app honestly confirming the expected FAILED verdict and its
 *     NAMED failed criteria;
 *   * the customer-boundary discriminations: forcing each of the
 *     seven controlled fakes onto the honest rows FAILs the named
 *     criteria; a terminal override FAILs the app-expected-terminal; a
 *     fabricated pass-with-fail FAILs the terminal↔criteria agreement;
 *     a rejected submission FAILs the submission-landed criterion
 *     honestly.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { journeyRowById } from "../../../benchmarks/validation/apps/customer-journey/corpus";
import { economicDigestOf } from "../../../benchmarks/validation/apps/economic-baseline/driver";
import { runProductionPilotApp } from "../../../benchmarks/validation/apps/production-pilot/application";
import type { PilotProbeKind } from "../../../benchmarks/validation/apps/production-pilot/corpus";
import {
  CARRIED_AUDIT_ROW_IDS,
  LIVE_CORPUS_ROWS,
  liveGateOpen,
  OFFLINE_CORPUS_ROWS,
  PILOT_OBSERVATION_FAMILIES,
  PILOT_WORKLOADS,
  PROBE_FAILED_CRITERIA_OF,
  PRODUCTION_PILOT_CORPUS,
  PRODUCTION_PILOT_CORPUS_VERSION,
  PRODUCTION_PILOT_ROW_IDS,
  PRODUCTION_PILOT_TASK_KIND,
  pilotRowById,
  pilotTaskBodyFor,
  pinnedPilotInputDigest,
} from "../../../benchmarks/validation/apps/production-pilot/corpus";
import { pilotObservationFor } from "../../../benchmarks/validation/apps/production-pilot/driver";
import {
  createPilotFakeApiWorld,
  createTickClock,
} from "../../../benchmarks/validation/apps/production-pilot/fixtures";
import { validateHarnessEvidence } from "../../../benchmarks/validation/harness";

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

async function runAppOverFakeWorld(options: {
  readonly taskIndex: number;
  readonly clock?: ReturnType<typeof createTickClock>;
  readonly probe?: PilotProbeKind;
  readonly terminal?: "COMPLETED" | "FAILED";
  readonly verificationStatuses?: readonly string[];
  readonly fabricatePassWithFail?: boolean;
  readonly env?: Record<string, string | undefined>;
}) {
  const clock = options.clock ?? createTickClock();
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
      configuration: { suite: "val-051-apps" },
    },
    runSuffix: "unit",
    taskIndex: options.taskIndex,
    env: options.env ?? {},
  });
  return { outcome, world };
}

const HONEST_ROW_IDS = [
  "full-window-recorded-basis",
  "window-incident-resume",
  "window-drift-within-bounds",
  "window-drift-declared",
  "window-regression-declared",
];
const PROBE_ROW_IDS = [
  "probe-window-cherry-picking",
  "probe-dropped-shift",
  "probe-double-driven-resume",
  "probe-drift-normalizing",
  "probe-incident-hiding",
  "probe-residual-hiding",
  "probe-boundary-leak",
];

// ---------------------------------------------------------------------------
// The corpus + configuration consistency
// ---------------------------------------------------------------------------

describe("VAL-051 corpus + configuration consistency", () => {
  test("config.json mirrors the exported task slice exactly", () => {
    const config = JSON.parse(
      readFileSync(
        join(process.cwd(), "benchmarks/validation/apps/production-pilot/config.json"),
        "utf8",
      ),
    ) as {
      readonly tokenEnvVar: string;
      readonly integrationSurface: string;
      readonly corpusVersion: string;
      readonly corpusInputDigest: string;
      readonly tasks: readonly {
        readonly kind: string;
        readonly rowId: string;
        readonly window: { readonly startShift: number; readonly endShift: number };
        readonly shifts: readonly string[];
        readonly observationFamilies: readonly string[];
        readonly expectedVerdict: string;
        readonly expectedFailedCriteria: readonly string[];
        readonly expectedTerminal: string;
        readonly incidents: readonly number[];
        readonly driftShifts: readonly number[];
        readonly probe?: string;
        readonly liveGate?: readonly string[];
      }[];
    };
    expect(config.tokenEnvVar).toBe("ZECK_VALIDATION_TOKEN");
    expect(config.integrationSurface).toBe("production-pilot:observation");
    expect(config.corpusVersion).toBe(PRODUCTION_PILOT_CORPUS_VERSION);
    expect(config.corpusInputDigest).toBe(pinnedPilotInputDigest());
    expect(config.tasks.map((task) => task.rowId)).toEqual([...PRODUCTION_PILOT_ROW_IDS]);
    for (const task of config.tasks) {
      expect(task.kind).toBe(PRODUCTION_PILOT_TASK_KIND);
      const row = pilotRowById(task.rowId);
      expect(row, task.rowId).not.toBeNull();
      expect(task.window).toEqual(row?.window);
      expect(task.shifts).toEqual(row?.schedule.map((shift) => shift.workload));
      expect(task.observationFamilies).toEqual([...(row?.observationFamilies ?? [])]);
      expect(task.expectedVerdict).toBe(row?.expected.verdict);
      expect(task.expectedFailedCriteria).toEqual([...(row?.expected.failedCriteria ?? [])]);
      expect(task.expectedTerminal).toBe(row?.expected.terminal);
      expect(task.incidents).toEqual(row?.incidents.map((incident) => incident.shiftIndex));
      expect(task.driftShifts).toEqual(row?.declaredDrift.map((drift) => drift.shiftIndex));
      expect(task.probe ?? undefined).toBe(row?.probe?.kind);
      expect(task.liveGate ?? undefined).toEqual(row?.liveGate?.envVars);
    }
    expect(JSON.stringify(config)).not.toMatch(/sk-[A-Za-z0-9]{20,}/);
    expect(JSON.stringify(config)).not.toContain("Bearer ");
  });

  test("the row ids are unique and every honest row declares the full schedule + all eight families", () => {
    expect(new Set(PRODUCTION_PILOT_ROW_IDS).size).toBe(PRODUCTION_PILOT_ROW_IDS.length);
    expect(PRODUCTION_PILOT_CORPUS_VERSION).toBe("val-051-production-pilot-v1");
    for (const row of PRODUCTION_PILOT_CORPUS) {
      // The verdict vocabulary is the declared vocabulary only.
      expect(["PILOT-COMPLETED", "PILOT-FAILED", "NOT-RUN"], row.rowId).toContain(
        row.expected.verdict,
      );
      // The observation families are the declared vocabulary only.
      for (const family of row.observationFamilies) {
        expect(PILOT_OBSERVATION_FAMILIES, row.rowId).toContain(family);
      }
      expect(row.observationFamilies, row.rowId).toHaveLength(PILOT_OBSERVATION_FAMILIES.length);
      // Every shift's recorded input digests are payload-free FNV-1a forms.
      for (const shift of row.schedule) {
        expect(shift.recordedInputDigests.length, `${row.rowId}/${shift.shiftId}`).toBeGreaterThan(
          0,
        );
        for (const digest of shift.recordedInputDigests) {
          expect(digest, `${row.rowId}/${shift.shiftId}`).toMatch(/^[0-9a-f]{8}$/);
        }
      }
    }
    for (const rowId of HONEST_ROW_IDS) {
      const row = pilotRowById(rowId);
      expect(row?.schedule.map((shift) => shift.workload)).toEqual([...PILOT_WORKLOADS]);
      expect(row?.window).toEqual({ startShift: 1, endShift: 5 });
      expect(row?.observationFamilies).toEqual([...PILOT_OBSERVATION_FAMILIES]);
      expect(row?.expected.verdict).toBe("PILOT-COMPLETED");
      expect(row?.expected.failedCriteria).toEqual([]);
      expect(row?.expected.terminal).toBe("COMPLETED");
      expect(row?.probe).toBeUndefined();
      expect(row?.needsDispatch).toBe(false);
    }
  });

  test("every probe row FAILs exactly its pinned NAMED criteria", () => {
    const probes = OFFLINE_CORPUS_ROWS.filter((row) => row.probe !== undefined);
    expect(probes.map((row) => row.rowId)).toEqual(PROBE_ROW_IDS);
    expect(new Set(probes.map((row) => row.probe?.kind)).size).toBe(7);
    for (const row of probes) {
      expect(row?.expected.verdict).toBe("PILOT-FAILED");
      expect(row?.expected.terminal).toBe("FAILED");
      expect(row?.expected.failedCriteria, row.rowId).toEqual([
        ...(PROBE_FAILED_CRITERIA_OF[row.probe?.kind as PilotProbeKind] ?? []),
      ]);
      // A FAILED verdict always NAMEs at least one failed criterion.
      expect(row.expected.failedCriteria.length, row.rowId).toBeGreaterThan(0);
    }
  });

  test("the shifts chain exactly into the VAL-050 journey basis (the digest-chained recorded basis)", () => {
    const journey = journeyRowById("full-journey-recorded-portfolio");
    const continuation = journeyRowById("journey-continuation-resume");
    expect(journey).not.toBeNull();
    expect(continuation).not.toBeNull();
    for (const rowId of [...HONEST_ROW_IDS, ...PROBE_ROW_IDS]) {
      const row = pilotRowById(rowId);
      for (const shift of row?.schedule ?? []) {
        const stage = journey?.stages.find((entry) => entry.stage === shift.workload);
        expect(stage, `${rowId}/${shift.workload}`).not.toBeUndefined();
        // The recorded input digests are the VAL-050 stage's OWN
        // digests (chained, never rewritten).
        expect(shift.recordedInputDigests, `${rowId}/${shift.workload}`).toEqual(
          stage?.recordedInputDigests,
        );
        // The carried economics are the audited stage economics —
        // EXCEPT the declared incident's shift, which carries the
        // RECORDED continuation economics (the failed attempt plus
        // exactly one resume).
        const carriesIncident = row?.incidents.some(
          (incident) => incident.shiftIndex === shift.shiftIndex,
        );
        const expected =
          carriesIncident === true
            ? continuation?.stages.find((entry) => entry.stage === shift.workload)?.economics
            : stage?.economics;
        expect(shift.economics, `${rowId}/${shift.shiftId}`).toEqual(expected);
        // The basis anchors re-derive over VAL-049's audited rows.
        expect(shift.economics.basisDigest).toMatch(/^[0-9a-f]{8}$/);
      }
    }
    // The carried audit anchors resolve (the imported, never
    // rewritten, digest chain).
    expect(CARRIED_AUDIT_ROW_IDS.length).toBe(5);
  });

  test("the task bodies carry references only (never prices, never result copies)", () => {
    for (const row of PRODUCTION_PILOT_CORPUS) {
      const body = JSON.stringify(pilotTaskBodyFor({ row }));
      expect(body, row.rowId).not.toMatch(/microUsd|amount|token[s]?[,:"]/i);
      expect(body, row.rowId).not.toMatch(/sk-[A-Za-z0-9]{20,}/);
      expect(body, row.rowId).not.toMatch(/[0-9a-f]{8,}["']?:["'][0-9]/);
      expect(body, row.rowId).toContain(row.rowId);
    }
  });

  test("the live gating is honest (exactly ONE live row, NOT RUN without the credential)", () => {
    expect(LIVE_CORPUS_ROWS).toHaveLength(1);
    const liveRow = LIVE_CORPUS_ROWS[0];
    if (liveRow === undefined) {
      throw new Error("the live slice is empty");
    }
    expect(liveRow.needsDispatch).toBe(true);
    expect(liveRow.liveGate?.envVars).toEqual(["OPENROUTER_API_KEY"]);
    expect(liveRow.expected.verdict).toBe("NOT-RUN");
    expect(liveGateOpen(liveRow, {})).toBe(false);
    expect(liveGateOpen(liveRow, { OPENROUTER_API_KEY: "" })).toBe(false);
    expect(liveGateOpen(liveRow, { OPENROUTER_API_KEY: "operator-authorized" })).toBe(true);
    // The offline corpus stays drivable without any credential.
    for (const row of OFFLINE_CORPUS_ROWS) {
      expect(row.needsDispatch, row.rowId).toBe(false);
    }
  });

  test("the corpus input digest is stable and the row lookup resolves", () => {
    expect(pinnedPilotInputDigest()).toMatch(/^[0-9a-f]{8}$/);
    expect(pinnedPilotInputDigest()).toBe(pinnedPilotInputDigest());
    expect(pinnedPilotInputDigest()).toBe(
      economicDigestOf({
        version: PRODUCTION_PILOT_CORPUS_VERSION,
        rows: [...PRODUCTION_PILOT_ROW_IDS],
        customer: "app-pilot-customer",
      }),
    );
    for (const rowId of PRODUCTION_PILOT_ROW_IDS) {
      expect(pilotRowById(rowId)?.rowId).toBe(rowId);
    }
    expect(pilotRowById("no-such-row")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The app over the honest fake world
// ---------------------------------------------------------------------------

describe("VAL-051 the app over the honest fake world", () => {
  test("every offline honest row lands ONE durable execution and settles COMPLETED", async () => {
    for (const rowId of HONEST_ROW_IDS) {
      const taskIndex = PRODUCTION_PILOT_ROW_IDS.indexOf(rowId);
      const { outcome, world } = await runAppOverFakeWorld({ taskIndex });
      expect(world.createdExecutions, rowId).toBe(1);
      expect(outcome.observedTerminal, rowId).toBe("COMPLETED");
      expect(outcome.passed, rowId).toBe(true);
      expect(outcome.verdict, rowId).toBe("PILOT-COMPLETED");
      expect(validateHarnessEvidence(outcome.evidence), rowId).toEqual([]);
      const failedApp = outcome.appCriteria.filter((criterion) => criterion.status === "FAIL");
      expect(failedApp, `${rowId}: ${JSON.stringify(failedApp)}`).toEqual([]);
      const failedPilot = outcome.pilotCriteria.filter((criterion) => criterion.status === "FAIL");
      expect(failedPilot, `${rowId}: ${JSON.stringify(failedPilot)}`).toEqual([]);
      // The offline usage is honestly none-reported (the shifts
      // replay recorded workloads — the economics are the recorded
      // basis, never a fabricated measurement).
      expect(outcome.usage, rowId).toBeNull();
      expect(outcome.notRunReason, rowId).toBeNull();
      expect(outcome.submissionLatencyMs, rowId).toBeGreaterThanOrEqual(0);
    }
  });

  test("the incident row resumes exactly once through the recorded continuation machinery", async () => {
    const taskIndex = PRODUCTION_PILOT_ROW_IDS.indexOf("window-incident-resume");
    const { outcome } = await runAppOverFakeWorld({ taskIndex });
    const continuation = outcome.pilotCriteria.find(
      (criterion) => criterion.criterionId === "continuation-exactly-once",
    );
    expect(continuation?.status).toBe("PASS");
    expect(continuation?.evidence.join(" ")).toContain("declared-incident:shift-4");
    expect(continuation?.evidence.join(" ")).toContain("shift-4:executions=2,resumed=true");
    const incident = outcome.pilotCriteria.find(
      (criterion) => criterion.criterionId === "incident-honesty",
    );
    expect(incident?.status).toBe("PASS");
    expect(incident?.evidence.join(" ")).toContain("recorded-incidents:1");
  });

  test("the drift rows classify honestly at the boundary (within-bounds / drifting / regressing)", async () => {
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
      const drift = outcome.pilotCriteria.find(
        (criterion) => criterion.criterionId === "drift-classification-honesty",
      );
      expect(drift?.status, rowId).toBe("PASS");
      expect(drift?.evidence.join(" "), rowId).toContain(expectedEntry);
    }
  });
});

// ---------------------------------------------------------------------------
// The live boundary (honest NOT RUN)
// ---------------------------------------------------------------------------

describe("VAL-051 the live boundary (honest NOT RUN)", () => {
  test("the live row stays NOT RUN when OPENROUTER_API_KEY is absent (the env var NAMED, zero submissions)", async () => {
    const taskIndex = PRODUCTION_PILOT_ROW_IDS.indexOf("live-pilot-window");
    const { outcome, world } = await runAppOverFakeWorld({ taskIndex, env: {} });
    expect(world.createdExecutions).toBe(0);
    expect(outcome.verdict).toBe("NOT-RUN");
    expect(outcome.notRunReason).toContain("OPENROUTER_API_KEY");
    expect(outcome.passed).toBe(true);
    expect(outcome.submission).toBeNull();
    expect(outcome.observedTerminal).toBeNull();
    expect(outcome.appCriteria.map((criterion) => criterion.criterionId)).toEqual([
      "app-live-gate-honest",
    ]);
    expect(outcome.appCriteria[0]?.evidence.join(" ")).toContain("NOT RUN");
    expect(validateHarnessEvidence(outcome.evidence)).toEqual([]);
  });

  test("the offline fake world refuses the live rail outright (a live pilot window is never fabricated offline)", async () => {
    const taskIndex = PRODUCTION_PILOT_ROW_IDS.indexOf("live-pilot-window");
    const { outcome, world } = await runAppOverFakeWorld({
      taskIndex,
      env: { OPENROUTER_API_KEY: "operator-authorized" },
    });
    // The gate is open but the fake world honestly refuses the live
    // rail — the submission never lands (never a fabricated live window).
    expect(world.createdExecutions).toBe(0);
    expect(outcome.passed).toBe(false);
    expect(outcome.verdict).toBe("PILOT-FAILED");
    expect(outcome.notRunReason).toBeNull();
    expect(outcome.observedTerminal).toBeNull();
    expect(outcome.appCriteria.map((criterion) => criterion.criterionId)).toEqual([
      "submission-landed",
    ]);
    expect(outcome.appCriteria[0]?.status).toBe("FAIL");
  });
});

// ---------------------------------------------------------------------------
// The adversarial pilot-probe rows over the app boundary
// ---------------------------------------------------------------------------

describe("VAL-051 the adversarial pilot-probe rows over the app boundary", () => {
  test("each adversarial probe row settles FAILED (the app observes the honest failure, criteria NAMED)", async () => {
    for (const rowId of PROBE_ROW_IDS) {
      const taskIndex = PRODUCTION_PILOT_ROW_IDS.indexOf(rowId);
      const row = pilotRowById(rowId);
      const { outcome, world } = await runAppOverFakeWorld({ taskIndex });
      expect(world.createdExecutions, rowId).toBe(1);
      expect(outcome.observedTerminal, rowId).toBe("FAILED");
      expect(outcome.verdict, rowId).toBe("PILOT-FAILED");
      expect(outcome.passed, rowId).toBe(true);
      expect(validateHarnessEvidence(outcome.evidence), rowId).toEqual([]);
      const failedApp = outcome.appCriteria.filter((criterion) => criterion.status === "FAIL");
      expect(failedApp, `${rowId}: ${JSON.stringify(failedApp)}`).toEqual([]);
      // The boundary re-derivation FAILs exactly the row's pinned
      // NAMED criteria (never trusting the platform's own claim).
      const failedPilot = outcome.pilotCriteria
        .filter((criterion) => criterion.status === "FAIL")
        .map((criterion) => criterion.criterionId)
        .sort();
      expect(failedPilot, rowId).toEqual([...(row?.expected.failedCriteria ?? [])].sort());
    }
  });
});

// ---------------------------------------------------------------------------
// The customer-boundary discriminations (the controlled fakes)
// ---------------------------------------------------------------------------

describe("VAL-051 customer-boundary discriminations (the controlled fakes)", () => {
  test("forcing each controlled fake onto the honest rows FAILs the named criteria", async () => {
    const cases: readonly {
      readonly probe: PilotProbeKind;
      readonly rowId: string;
      readonly named: string;
    }[] = [
      {
        probe: "window-cherry-picking",
        rowId: "full-window-recorded-basis",
        named: "window-honesty",
      },
      {
        probe: "dropped-shift",
        rowId: "full-window-recorded-basis",
        named: "schedule-completeness",
      },
      {
        probe: "double-driven-resume",
        rowId: "window-incident-resume",
        named: "continuation-exactly-once",
      },
      {
        probe: "drift-normalizing",
        rowId: "window-drift-declared",
        named: "drift-classification-honesty",
      },
      { probe: "incident-hiding", rowId: "window-incident-resume", named: "incident-honesty" },
      {
        probe: "residual-hiding",
        rowId: "full-window-recorded-basis",
        named: "end-of-window-accounting",
      },
      { probe: "boundary-leak", rowId: "full-window-recorded-basis", named: "customer-boundary" },
    ];
    for (const testCase of cases) {
      const taskIndex = PRODUCTION_PILOT_ROW_IDS.indexOf(testCase.rowId);
      const { outcome } = await runAppOverFakeWorld({
        taskIndex,
        probe: testCase.probe,
      });
      expect(outcome.passed, testCase.probe).toBe(false);
      // The honest row's contract cannot absorb a denatured window:
      // the failed-criteria-named pin catches the divergence.
      const named = outcome.appCriteria.find(
        (criterion) => criterion.criterionId === "app-failed-criteria-named",
      );
      expect(named?.status, testCase.probe).toBe("FAIL");
      // The specific observation criterion FAILs at the boundary.
      const integrity = outcome.pilotCriteria.find(
        (criterion) => criterion.criterionId === testCase.named,
      );
      expect(integrity?.status, testCase.probe).toBe("FAIL");
      // The derived verdict is the honest FAILED verdict.
      expect(outcome.verdict, testCase.probe).toBe("PILOT-FAILED");
    }
  });

  test("a terminal override FAILs the app-expected-terminal criterion", async () => {
    const taskIndex = PRODUCTION_PILOT_ROW_IDS.indexOf("full-window-recorded-basis");
    const { outcome } = await runAppOverFakeWorld({ taskIndex, terminal: "FAILED" });
    expect(outcome.observedTerminal).toBe("FAILED");
    expect(outcome.passed).toBe(false);
    const expected = outcome.appCriteria.find(
      (criterion) => criterion.criterionId === "app-expected-terminal",
    );
    expect(expected?.status).toBe("FAIL");
  });

  test("a fabricated pass-with-fail FAILs the app-terminal-criteria-agreement criterion", async () => {
    const taskIndex = PRODUCTION_PILOT_ROW_IDS.indexOf("probe-dropped-shift");
    const { outcome } = await runAppOverFakeWorld({ taskIndex, fabricatePassWithFail: true });
    expect(outcome.observedTerminal).toBe("COMPLETED");
    expect(outcome.passed).toBe(false);
    const agreement = outcome.appCriteria.find(
      (criterion) => criterion.criterionId === "app-terminal-criteria-agreement",
    );
    expect(agreement?.status).toBe("FAIL");
  });

  test("a rejected submission FAILs the submission-landed criterion honestly", async () => {
    const clock = createTickClock();
    // Reject every POST at the transport level (the boundary refusal).
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
        configuration: { suite: "val-051-apps" },
      },
      runSuffix: "unit",
      taskIndex: 0,
      env: {},
    });
    expect(outcome.passed).toBe(false);
    expect(outcome.observedTerminal).toBeNull();
    expect(outcome.appCriteria.map((criterion) => criterion.criterionId)).toEqual([
      "submission-landed",
    ]);
  });
});

// ---------------------------------------------------------------------------
// The honest-observation vocabulary (the pure derivation is pinned)
// ---------------------------------------------------------------------------

describe("VAL-051 the pinned observation vocabulary", () => {
  test("the honest observation derivation matches the row declarations exactly", () => {
    for (const rowId of [...HONEST_ROW_IDS, ...PROBE_ROW_IDS]) {
      const row = pilotRowById(rowId);
      if (row === null) {
        throw new Error(`no row ${rowId}`);
      }
      const observation = pilotObservationFor(row);
      expect(observation.rowId).toBe(rowId);
      expect(observation.usage).toBeNull();
      expect(observation.windowDigest).toMatch(/^[0-9a-f]{8}$/);
      // The window digest is stable per row + shape.
      expect(pilotObservationFor(row).windowDigest).toBe(observation.windowDigest);
      // The drift report carries one entry per observed shift.
      expect(observation.driftReport.length).toBe(observation.shifts.length);
      // The ledger carries one spend entry per observed shift plus
      // the end-of-window release.
      expect(observation.ledger.length).toBe(observation.shifts.length + 1);
      expect(observation.ledger.at(-1)?.kind).toBe("release");
    }
  });
});
