/**
 * VAL-050 acceptance criteria 1, 2, 4, 5 and 7 (the app boundary +
 * the configuration consistency + the honest verdicts): the
 * end-to-end customer journey application over the public SDK
 * boundary.
 *
 *   * the corpus + configuration consistency: config.json mirrors the
 *     exported task slice exactly; the row ids unique; every honest
 *     row declares the FULL five-stage lifecycle and all five
 *     integrity families; every probe row's expected failed criteria
 *     NAMED per the pinned vocabulary; every stage recorded-input
 *     digest well-formed (FNV-1a, payload-free); the daily-usage
 *     portfolio references resolve against the RECORDED corpora
 *     (VAL-010 fixtures + VAL-019 tasks); the stage economics'
 *     basis digests re-derive over VAL-049's audited rows (the
 *     carried cost basis); the task bodies carry REFERENCES ONLY;
 *   * the app over the honest fake world: every offline honest row
 *     lands ONE durable execution and settles COMPLETED with all
 *     boundary criteria and all five integrity criteria PASSing; the
 *     declared re-issue row replays under the same idempotency key
 *     (never double-creates); the usage is honestly none offline;
 *   * the live boundary: exactly ONE env-gated live row; NOT RUN
 *     without OPENROUTER_API_KEY (the env var NAMED, zero
 *     submissions); the offline fake world refuses the live rail
 *     outright (a live journey is never fabricated offline);
 *   * the adversarial journey-probe rows: each settles FAILED with
 *     the app honestly confirming the expected FAILED verdict and
 *     its NAMED failed criteria;
 *   * the customer-boundary discriminations: forcing any of the five
 *     controlled fakes onto an HONEST row FAILs the named criteria;
 *     a terminal override FAILs the app-expected-terminal; a
 *     fabricated pass-with-fail FAILs the terminal↔criteria
 *     agreement; a rejected submission FAILs the submission-landed
 *     criterion honestly.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { runCustomerJourneyApp } from "../../../benchmarks/validation/apps/customer-journey/application";
import type { JourneyProbeKind } from "../../../benchmarks/validation/apps/customer-journey/corpus";
import {
  CARRIED_AUDIT_ROW_IDS,
  CUSTOMER_JOURNEY_CORPUS,
  CUSTOMER_JOURNEY_CORPUS_VERSION,
  CUSTOMER_JOURNEY_ROW_IDS,
  CUSTOMER_JOURNEY_TASK_KIND,
  JOURNEY_INTEGRITY_FAMILIES,
  JOURNEY_STAGES,
  journeyRowById,
  journeyTaskBodyFor,
  LIVE_CORPUS_ROWS,
  liveGateOpen,
  OFFLINE_CORPUS_ROWS,
  PROBE_FAILED_CRITERIA_OF,
  pinnedJourneyInputDigest,
  RECORDED_PORTFOLIO,
} from "../../../benchmarks/validation/apps/customer-journey/corpus";
import { journeyObservationFor } from "../../../benchmarks/validation/apps/customer-journey/driver";
import {
  createJourneyFakeApiWorld,
  createTickClock,
} from "../../../benchmarks/validation/apps/customer-journey/fixtures";
import { CUSTOMER_SERVICE_TASKS } from "../../../benchmarks/validation/apps/customer-service/application";
import { auditRowById } from "../../../benchmarks/validation/apps/economic-audit/corpus";
import { economicDigestOf } from "../../../benchmarks/validation/apps/economic-baseline/driver";
import { MATERIALIZED_FIXTURE_KEYS } from "../../../benchmarks/validation/apps/shared/fixtures";
import { validateHarnessEvidence } from "../../../benchmarks/validation/harness";

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

async function runAppOverFakeWorld(options: {
  readonly taskIndex: number;
  readonly clock?: ReturnType<typeof createTickClock>;
  readonly probe?: JourneyProbeKind;
  readonly terminal?: "COMPLETED" | "FAILED";
  readonly verificationStatuses?: readonly string[];
  readonly fabricatePassWithFail?: boolean;
  readonly env?: Record<string, string | undefined>;
}) {
  const clock = options.clock ?? createTickClock();
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
      configuration: { suite: "val-050-apps" },
    },
    runSuffix: "unit",
    taskIndex: options.taskIndex,
    env: options.env ?? {},
  });
  return { outcome, world };
}

const HONEST_ROW_IDS = [
  "full-journey-recorded-portfolio",
  "journey-continuation-resume",
  "journey-idempotent-reissue",
];
const PROBE_ROW_IDS = [
  "probe-dropped-stage",
  "probe-orphaned-state",
  "probe-double-driven-resume",
  "probe-boundary-leak",
  "probe-residual-hiding",
];

// ---------------------------------------------------------------------------
// The corpus + configuration consistency
// ---------------------------------------------------------------------------

describe("VAL-050 corpus + configuration consistency", () => {
  test("config.json mirrors the exported task slice exactly", () => {
    const config = JSON.parse(
      readFileSync(
        join(process.cwd(), "benchmarks/validation/apps/customer-journey/config.json"),
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
        readonly stages: readonly string[];
        readonly expectedVerdict: string;
        readonly expectedFailedCriteria: readonly string[];
        readonly probe?: string;
        readonly liveGate?: readonly string[];
      }[];
    };
    expect(config.tokenEnvVar).toBe("ZECK_VALIDATION_TOKEN");
    expect(config.integrationSurface).toBe("customer-journey:lifecycle");
    expect(config.corpusVersion).toBe(CUSTOMER_JOURNEY_CORPUS_VERSION);
    expect(config.corpusInputDigest).toBe(pinnedJourneyInputDigest());
    expect(config.tasks.map((task) => task.rowId)).toEqual([...CUSTOMER_JOURNEY_ROW_IDS]);
    for (const task of config.tasks) {
      expect(task.kind).toBe(CUSTOMER_JOURNEY_TASK_KIND);
      const row = journeyRowById(task.rowId);
      expect(row, task.rowId).not.toBeNull();
      expect(task.stages).toEqual(row?.stages.map((stage) => stage.stage));
      expect(task.expectedVerdict).toBe(row?.expected.verdict);
      expect(task.expectedFailedCriteria).toEqual([...(row?.expected.failedCriteria ?? [])]);
      expect(task.probe ?? undefined).toBe(row?.probe?.kind);
      expect(task.liveGate ?? undefined).toEqual(row?.liveGate?.envVars);
    }
    expect(JSON.stringify(config)).not.toMatch(/sk-[A-Za-z0-9]{20,}/);
    expect(JSON.stringify(config)).not.toContain("Bearer ");
  });

  test("the row ids are unique and every honest row declares the full lifecycle + all five families", () => {
    expect(new Set(CUSTOMER_JOURNEY_ROW_IDS).size).toBe(CUSTOMER_JOURNEY_ROW_IDS.length);
    expect(CUSTOMER_JOURNEY_CORPUS_VERSION).toBe("val-050-customer-journey-v1");
    for (const row of CUSTOMER_JOURNEY_CORPUS) {
      // The verdict vocabulary is the declared vocabulary only.
      expect(["JOURNEY-COMPLETED", "JOURNEY-FAILED", "NOT-RUN"], row.rowId).toContain(
        row.expected.verdict,
      );
      // The integrity families are the declared vocabulary only.
      for (const family of row.integrityFamilies) {
        expect(JOURNEY_INTEGRITY_FAMILIES, row.rowId).toContain(family);
      }
    }
    for (const rowId of HONEST_ROW_IDS) {
      const row = journeyRowById(rowId);
      expect(row?.stages.map((stage) => stage.stage)).toEqual([...JOURNEY_STAGES]);
      expect(row?.integrityFamilies).toEqual([...JOURNEY_INTEGRITY_FAMILIES]);
      expect(row?.expected.verdict).toBe("JOURNEY-COMPLETED");
      expect(row?.expected.failedCriteria).toEqual([]);
      expect(row?.expected.terminal).toBe("COMPLETED");
      expect(row?.probe).toBeUndefined();
      expect(row?.needsDispatch).toBe(false);
    }
  });

  test("every probe row FAILs exactly its pinned NAMED criteria", () => {
    const probes = OFFLINE_CORPUS_ROWS.filter((row) => row.probe !== undefined);
    expect(probes.map((row) => row.rowId)).toEqual(PROBE_ROW_IDS);
    expect(new Set(probes.map((row) => row.probe?.kind)).size).toBe(5);
    for (const row of probes) {
      expect(row?.expected.verdict).toBe("JOURNEY-FAILED");
      expect(row?.expected.terminal).toBe("FAILED");
      expect(row?.expected.failedCriteria, row.rowId).toEqual([
        ...(PROBE_FAILED_CRITERIA_OF[row.probe?.kind as JourneyProbeKind] ?? []),
      ]);
      // A FAILED verdict always NAMEs at least one failed criterion.
      expect(row.expected.failedCriteria.length, row.rowId).toBeGreaterThan(0);
    }
  });

  test("every stage recorded-input digest is a payload-free FNV-1a and the portfolio resolves", () => {
    for (const row of CUSTOMER_JOURNEY_CORPUS) {
      for (const stage of row.stages) {
        expect(stage.recordedInputDigests.length, `${row.rowId}/${stage.stage}`).toBeGreaterThan(0);
        for (const digest of stage.recordedInputDigests) {
          expect(digest, `${row.rowId}/${stage.stage}`).toMatch(/^[0-9a-f]{8}$/);
        }
      }
    }
    // The daily-usage portfolio references resolve against the
    // RECORDED corpora (VAL-010 fixtures + VAL-019 tasks) — the
    // recorded rows are referenced, never re-measured.
    const recordedKeys = new Set(MATERIALIZED_FIXTURE_KEYS);
    const recordedTickets = new Set(CUSTOMER_SERVICE_TASKS.map((task) => task.ticket));
    for (const ref of RECORDED_PORTFOLIO) {
      expect(ref.recordedRowIds.length, ref.appId).toBeGreaterThan(0);
      if (ref.workOrder === "VAL-010") {
        for (const key of ref.recordedRowIds) {
          expect(recordedKeys, `${ref.appId}/${key}`).toContain(key);
        }
      } else {
        for (const ticket of ref.recordedRowIds) {
          expect(recordedTickets, `${ref.appId}/${ticket}`).toContain(ticket);
        }
      }
    }
    // The daily-usage stage composes the full recorded portfolio.
    const dailyUsage = journeyRowById("full-journey-recorded-portfolio")?.stages.find(
      (stage) => stage.stage === "daily-usage",
    );
    expect(dailyUsage?.recordedInputDigests.length).toBe(RECORDED_PORTFOLIO.length);
  });

  test("the stage economics' basis anchors re-derive over VAL-049's audited rows (the carried cost basis)", () => {
    expect(CARRIED_AUDIT_ROW_IDS.length).toBeGreaterThan(0);
    for (const auditRowId of CARRIED_AUDIT_ROW_IDS) {
      const auditRow = auditRowById(auditRowId);
      expect(auditRow, auditRowId).not.toBeNull();
      const recomputed = economicDigestOf({
        workOrder: "VAL-049",
        auditRowId: auditRow?.rowId,
        recordedDigests: auditRow?.evidence.map((reference) => reference.recordedDigest),
      });
      for (const row of CUSTOMER_JOURNEY_CORPUS) {
        for (const stage of row.stages) {
          if (stage.economics.basisAuditRowId === auditRowId) {
            expect(stage.economics.basisDigest, `${row.rowId}/${stage.stage}`).toBe(recomputed);
            expect(stage.economics.basisDigest).toMatch(/^[0-9a-f]{8}$/);
          }
        }
      }
    }
    // A drifted (unknown) audit anchor is unrepresentable in the corpus.
    expect(auditRowById("no-such-audit-row")).toBeNull();
  });

  test("the task bodies carry references only (never prices, never result copies)", () => {
    for (const row of CUSTOMER_JOURNEY_CORPUS) {
      const body = JSON.stringify(journeyTaskBodyFor({ row }));
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
    expect(pinnedJourneyInputDigest()).toMatch(/^[0-9a-f]{8}$/);
    expect(pinnedJourneyInputDigest()).toBe(pinnedJourneyInputDigest());
    for (const rowId of CUSTOMER_JOURNEY_ROW_IDS) {
      expect(journeyRowById(rowId)?.rowId).toBe(rowId);
    }
    expect(journeyRowById("no-such-row")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The app over the honest fake world
// ---------------------------------------------------------------------------

describe("VAL-050 the app over the honest fake world", () => {
  test("every offline honest row lands ONE durable execution and settles COMPLETED", async () => {
    for (const rowId of HONEST_ROW_IDS) {
      const taskIndex = CUSTOMER_JOURNEY_ROW_IDS.indexOf(rowId);
      const { outcome, world } = await runAppOverFakeWorld({ taskIndex });
      expect(world.createdExecutions, rowId).toBe(1);
      expect(outcome.observedTerminal, rowId).toBe("COMPLETED");
      expect(outcome.passed, rowId).toBe(true);
      expect(outcome.verdict, rowId).toBe("JOURNEY-COMPLETED");
      expect(validateHarnessEvidence(outcome.evidence), rowId).toEqual([]);
      const failedApp = outcome.appCriteria.filter((criterion) => criterion.status === "FAIL");
      expect(failedApp, `${rowId}: ${JSON.stringify(failedApp)}`).toEqual([]);
      const failedJourney = outcome.journeyCriteria.filter(
        (criterion) => criterion.status === "FAIL",
      );
      expect(failedJourney, `${rowId}: ${JSON.stringify(failedJourney)}`).toEqual([]);
      // The offline usage is honestly none-reported (the stages replay
      // recorded workloads — the economics are the recorded basis).
      expect(outcome.usage, rowId).toBeNull();
      expect(outcome.notRunReason, rowId).toBeNull();
      expect(outcome.submissionLatencyMs, rowId).toBeGreaterThanOrEqual(0);
    }
  });

  test("the continuation row resumes exactly once (the resumed stage lands exactly two executions)", async () => {
    const taskIndex = CUSTOMER_JOURNEY_ROW_IDS.indexOf("journey-continuation-resume");
    const { outcome } = await runAppOverFakeWorld({ taskIndex });
    const continuation = outcome.journeyCriteria.find(
      (criterion) => criterion.criterionId === "continuation-exactly-once",
    );
    expect(continuation?.status).toBe("PASS");
    expect(continuation?.evidence.join(" ")).toContain("declared-failure-stage:daily-usage");
    expect(continuation?.evidence.join(" ")).toContain("daily-usage:executions=2,resumed=true");
  });

  test("the idempotent re-issue row replays under the same key (never double-creates)", async () => {
    const taskIndex = CUSTOMER_JOURNEY_ROW_IDS.indexOf("journey-idempotent-reissue");
    const { outcome, world } = await runAppOverFakeWorld({ taskIndex });
    expect(world.createdExecutions).toBe(1);
    expect(outcome.resubmission).not.toBeNull();
    expect(outcome.resubmission?.replayed).toBe(true);
    expect(outcome.resubmission?.executionId).toBe(outcome.submission?.executionId);
    const replay = outcome.appCriteria.find(
      (criterion) => criterion.criterionId === "app-resubmission-replay",
    );
    expect(replay?.status).toBe("PASS");
    expect(outcome.passed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The live boundary (honest NOT RUN)
// ---------------------------------------------------------------------------

describe("VAL-050 the live boundary (honest NOT RUN)", () => {
  test("the live row stays NOT RUN when OPENROUTER_API_KEY is absent (the env var NAMED, zero submissions)", async () => {
    const taskIndex = CUSTOMER_JOURNEY_ROW_IDS.indexOf("live-journey-slice");
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

  test("the offline fake world refuses the live rail outright (a live journey is never fabricated offline)", async () => {
    const taskIndex = CUSTOMER_JOURNEY_ROW_IDS.indexOf("live-journey-slice");
    const { outcome, world } = await runAppOverFakeWorld({
      taskIndex,
      env: { OPENROUTER_API_KEY: "operator-authorized" },
    });
    // The gate is open but the fake world honestly refuses the live
    // rail — the submission never lands (never a fabricated live journey).
    expect(world.createdExecutions).toBe(0);
    expect(outcome.passed).toBe(false);
    expect(outcome.verdict).toBe("JOURNEY-FAILED");
    expect(outcome.notRunReason).toBeNull();
    expect(outcome.observedTerminal).toBeNull();
    expect(outcome.appCriteria.map((criterion) => criterion.criterionId)).toEqual([
      "submission-landed",
    ]);
    expect(outcome.appCriteria[0]?.status).toBe("FAIL");
  });
});

// ---------------------------------------------------------------------------
// The adversarial journey-probe rows over the app boundary
// ---------------------------------------------------------------------------

describe("VAL-050 the adversarial journey-probe rows over the app boundary", () => {
  test("each adversarial probe row settles FAILED (the app observes the honest failure, criteria NAMED)", async () => {
    for (const rowId of PROBE_ROW_IDS) {
      const taskIndex = CUSTOMER_JOURNEY_ROW_IDS.indexOf(rowId);
      const row = journeyRowById(rowId);
      const { outcome, world } = await runAppOverFakeWorld({ taskIndex });
      expect(world.createdExecutions, rowId).toBe(1);
      expect(outcome.observedTerminal, rowId).toBe("FAILED");
      expect(outcome.verdict, rowId).toBe("JOURNEY-FAILED");
      expect(outcome.passed, rowId).toBe(true);
      expect(validateHarnessEvidence(outcome.evidence), rowId).toEqual([]);
      const failedApp = outcome.appCriteria.filter((criterion) => criterion.status === "FAIL");
      expect(failedApp, `${rowId}: ${JSON.stringify(failedApp)}`).toEqual([]);
      // The boundary re-derivation FAILs exactly the row's pinned
      // NAMED criteria (never trusting the platform's own claim).
      const failedJourney = outcome.journeyCriteria
        .filter((criterion) => criterion.status === "FAIL")
        .map((criterion) => criterion.criterionId)
        .sort();
      expect(failedJourney, rowId).toEqual([...(row?.expected.failedCriteria ?? [])].sort());
    }
  });
});

// ---------------------------------------------------------------------------
// The customer-boundary discriminations (the controlled fakes)
// ---------------------------------------------------------------------------

describe("VAL-050 customer-boundary discriminations (the controlled fakes)", () => {
  const honestIndex = CUSTOMER_JOURNEY_ROW_IDS.indexOf("full-journey-recorded-portfolio");

  test("forcing each controlled fake onto the HONEST row FAILs the named criteria", async () => {
    const cases: readonly { readonly probe: JourneyProbeKind; readonly named: string }[] = [
      { probe: "dropped-stage", named: "stage-completeness" },
      { probe: "orphaned-state", named: "cross-stage-idempotency" },
      { probe: "double-driven-resume", named: "continuation-exactly-once" },
      { probe: "boundary-leak", named: "customer-boundary" },
      { probe: "residual-hiding", named: "accounting-reconciliation" },
    ];
    for (const testCase of cases) {
      const { outcome } = await runAppOverFakeWorld({
        taskIndex: honestIndex,
        probe: testCase.probe,
      });
      expect(outcome.passed, testCase.probe).toBe(false);
      // The honest row's contract cannot absorb a denatured journey:
      // the failed-criteria-named pin catches the divergence.
      const named = outcome.appCriteria.find(
        (criterion) => criterion.criterionId === "app-failed-criteria-named",
      );
      expect(named?.status, testCase.probe).toBe("FAIL");
      // The specific integrity criterion FAILs at the boundary.
      const integrity = outcome.journeyCriteria.find(
        (criterion) => criterion.criterionId === testCase.named,
      );
      expect(integrity?.status, testCase.probe).toBe("FAIL");
    }
  });

  test("a terminal override FAILs the app-expected-terminal criterion", async () => {
    const { outcome } = await runAppOverFakeWorld({ taskIndex: honestIndex, terminal: "FAILED" });
    expect(outcome.observedTerminal).toBe("FAILED");
    expect(outcome.passed).toBe(false);
    const expected = outcome.appCriteria.find(
      (criterion) => criterion.criterionId === "app-expected-terminal",
    );
    expect(expected?.status).toBe("FAIL");
  });

  test("a fabricated pass-with-fail FAILs the app-terminal-criteria-agreement criterion", async () => {
    const taskIndex = CUSTOMER_JOURNEY_ROW_IDS.indexOf("probe-dropped-stage");
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
        configuration: { suite: "val-050-apps" },
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

describe("VAL-050 the pinned observation vocabulary", () => {
  test("the honest observation derivation matches the row declarations exactly", () => {
    for (const rowId of [...HONEST_ROW_IDS, ...PROBE_ROW_IDS]) {
      const row = journeyRowById(rowId);
      if (row === null) {
        throw new Error(`no row ${rowId}`);
      }
      const observation = journeyObservationFor(row);
      expect(observation.rowId).toBe(rowId);
      expect(observation.usage).toBeNull();
      expect(observation.journeyDigest).toMatch(/^[0-9a-f]{8}$/);
      // The journey digest is stable per row + shape.
      expect(journeyObservationFor(row).journeyDigest).toBe(observation.journeyDigest);
    }
  });
});
