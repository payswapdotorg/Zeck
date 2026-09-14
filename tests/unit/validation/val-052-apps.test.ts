/**
 * VAL-052 acceptance criteria 1, 2, 4, 5 and 7 (the app boundary +
 * the configuration consistency + the honest verdicts): the
 * final-report application over the public SDK boundary.
 *
 *   * the corpus + configuration consistency: config.json mirrors the
 *     exported task slice exactly; the row ids unique; every honest
 *     row declares the full thirteen-family verification core and the
 *     full governed program slice; every probe row's expected failed
 *     criteria NAMED per the pinned vocabulary; the task bodies carry
 *     REFERENCES ONLY; the configuration is secret-free;
 *   * the app over the honest fake world: every offline honest row
 *     lands ONE durable execution and settles COMPLETED with all
 *     boundary criteria and all thirteen mechanical criteria PASSing
 *     — the boundary-re-derived inventory reconciling against the
 *     REAL governed state (46 work orders, 45 complete + VAL-052
 *     honestly in flight); the usage is honestly none offline;
 *   * the live boundary: exactly ONE env-gated live row; NOT RUN
 *     without OPENROUTER_API_KEY (the env var NAMED, zero
 *     submissions); the offline fake world refuses the live rail
 *     outright (a live confirmation is never fabricated offline —
 *     even with the credential set, the POST is refused and the app
 *     FAILs the submission-landed criterion honestly);
 *   * the adversarial report-probe rows: each settles FAILED with the
 *     app honestly confirming the expected FAILED verdict and its
 *     NAMED failed criteria;
 *   * the customer-boundary discriminations: forcing each of the
 *     seven controlled fakes onto the honest rows FAILs the named
 *     criteria; a terminal override FAILs the app-expected-terminal; a
 *     fabricated pass-with-fail FAILs the terminal↔criteria agreement.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  FINAL_REPORT_TASKS,
  runFinalReportApp,
} from "../../../benchmarks/validation/apps/final-report/application";
import type { ReportProbeKind } from "../../../benchmarks/validation/apps/final-report/corpus";
import {
  FINAL_REPORT_ROW_IDS,
  FINAL_REPORT_TASK_KIND,
  FINAL_REPORT_VERIFICATION_FAMILIES,
  finalReportRowById,
  LIVE_CORPUS_ROWS,
  liveGateOpen,
  OFFLINE_CORPUS_ROWS,
  PROBE_FAILED_CRITERIA_OF,
  pinnedReportInputDigest,
} from "../../../benchmarks/validation/apps/final-report/corpus";
import { loadRealReportWorld } from "../../../benchmarks/validation/apps/final-report/driver";
import {
  createFinalReportFakeApiWorld,
  createTickClock,
} from "../../../benchmarks/validation/apps/final-report/fixtures";
import { validateHarnessEvidence } from "../../../benchmarks/validation/harness";

const baseConfig = {
  applicationId: "app-1",
  baseUrl: "https://fake.example.test",
  tokenEnvVar: "ZECK_VALIDATION_TOKEN",
  applicationRevision: "0123456789abcdef0123456789abcdef01234567",
  corpusRevision: "0123456789abcdef0123456789abcdef01234567",
  integrationSurface: "final-report:release-gate",
  pollIntervalMs: 10,
  completionTimeoutMs: 5_000,
};

const WORLD = loadRealReportWorld();

async function runAppOverFakeWorld(options: {
  readonly taskIndex: number;
  readonly clock?: ReturnType<typeof createTickClock>;
  readonly probe?: ReportProbeKind;
  readonly terminal?: "COMPLETED" | "FAILED";
  readonly verificationStatuses?: readonly string[];
  readonly fabricatePassWithFail?: boolean;
  readonly env?: Record<string, string | undefined>;
}) {
  const clock = options.clock ?? createTickClock();
  const world = createFinalReportFakeApiWorld({
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
  const outcome = await runFinalReportApp({
    config: baseConfig,
    token: "test-token",
    transport: world.transport,
    world: WORLD,
    now: clock.now,
    sleep: async () => {},
    environment: {
      runtime: "bun test",
      toolchain: "bun",
      database: "none",
      configuration: { suite: "val-052-apps" },
    },
    runSuffix: "unit",
    taskIndex: options.taskIndex,
    env: options.env ?? {},
  });
  return { outcome, world };
}

const HONEST_ROW_IDS = [
  "inventory-consolidated-governed-state",
  "release-gate-nine-conditions",
  "program-coverage-and-disclosures",
  "deadline-remainder-honest",
  "acceptance-chain-carried",
];
const PROBE_ROW_IDS = [
  "probe-missing-work-order",
  "probe-deleted-evidence-document",
  "probe-boundary-without-env-var",
  "probe-protocol-stripped-finding",
  "probe-phantom-coverage",
  "probe-silent-omission",
  "probe-self-declared-acceptance",
];

// ---------------------------------------------------------------------------
// The corpus + configuration consistency
// ---------------------------------------------------------------------------

describe("VAL-052 corpus + configuration consistency", () => {
  test("config.json mirrors the exported task slice exactly", () => {
    const config = JSON.parse(
      readFileSync(
        join(process.cwd(), "benchmarks/validation/apps/final-report/config.json"),
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
        readonly programSlice: string;
        readonly verificationFamilies: readonly string[];
        readonly expectedVerdict: string;
        readonly expectedFailedCriteria: readonly string[];
        readonly expectedTerminal: string;
        readonly probe?: string;
        readonly liveGate?: readonly string[];
      }[];
    };
    expect(config.tokenEnvVar).toBe("ZECK_VALIDATION_TOKEN");
    expect(config.integrationSurface).toBe("final-report:release-gate");
    expect(config.corpusVersion).toBe("val-052-final-report-v1");
    expect(config.corpusInputDigest).toBe(pinnedReportInputDigest());
    expect(config.tasks.map((task) => task.rowId)).toEqual([...FINAL_REPORT_ROW_IDS]);
    expect(JSON.stringify(config.tasks)).toEqual(JSON.stringify(FINAL_REPORT_TASKS));
    for (const task of config.tasks) {
      expect(task.kind).toBe(FINAL_REPORT_TASK_KIND);
      const row = finalReportRowById(task.rowId);
      expect(row, task.rowId).not.toBeNull();
      expect(task.programSlice).toBe(row?.programSlice);
      expect(task.verificationFamilies).toEqual([...(row?.verificationFamilies ?? [])]);
      expect(task.expectedVerdict).toBe(row?.expected.verdict);
      expect(task.expectedFailedCriteria).toEqual([...(row?.expected.failedCriteria ?? [])]);
      expect(task.expectedTerminal).toBe(row?.expected.terminal);
      expect(task.probe ?? undefined).toBe(row?.probe?.kind);
      expect(task.liveGate ?? undefined).toEqual(row?.liveGate?.envVars);
    }
    expect(JSON.stringify(config)).not.toMatch(/sk-[A-Za-z0-9]{20,}/);
    expect(JSON.stringify(config)).not.toContain("Bearer ");
  });

  test("the row ids are unique and every row declares the full thirteen-family verification core", () => {
    expect(new Set(FINAL_REPORT_ROW_IDS).size).toBe(FINAL_REPORT_ROW_IDS.length);
    expect(FINAL_REPORT_ROW_IDS).toHaveLength(13);
    for (const row of OFFLINE_CORPUS_ROWS) {
      // The verdict vocabulary is the declared vocabulary only.
      expect(["COMPLETED", "FAILED", "NOT-RUN"], row.rowId).toContain(row.expected.verdict);
      expect(row.verificationFamilies, row.rowId).toEqual([...FINAL_REPORT_VERIFICATION_FAMILIES]);
      expect(FINAL_REPORT_VERIFICATION_FAMILIES).toHaveLength(13);
      expect(row.programSlice, row.rowId).toContain("the full governed program of record");
    }
    for (const rowId of HONEST_ROW_IDS) {
      const row = finalReportRowById(rowId);
      expect(row?.expected.verdict).toBe("COMPLETED");
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
      expect(row.expected.verdict).toBe("FAILED");
      expect(row.expected.terminal).toBe("FAILED");
      expect(row.expected.failedCriteria, row.rowId).toEqual([
        ...(PROBE_FAILED_CRITERIA_OF[row.probe?.kind as ReportProbeKind] ?? []),
      ]);
      expect(row.expected.failedCriteria.length, row.rowId).toBeGreaterThan(0);
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
    expect(pinnedReportInputDigest()).toMatch(/^[0-9a-f]{8}$/);
    expect(pinnedReportInputDigest()).toBe(pinnedReportInputDigest());
    for (const rowId of FINAL_REPORT_ROW_IDS) {
      expect(finalReportRowById(rowId)?.rowId).toBe(rowId);
    }
    expect(finalReportRowById("no-such-row")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// The app over the honest fake world
// ---------------------------------------------------------------------------

describe("VAL-052 the app over the honest fake world", () => {
  test("every offline honest row lands ONE durable execution and settles COMPLETED", async () => {
    for (const rowId of HONEST_ROW_IDS) {
      const taskIndex = FINAL_REPORT_ROW_IDS.indexOf(rowId);
      const { outcome, world } = await runAppOverFakeWorld({ taskIndex });
      expect(world.createdExecutions, rowId).toBe(1);
      expect(outcome.observedTerminal, rowId).toBe("COMPLETED");
      expect(outcome.passed, rowId).toBe(true);
      expect(outcome.verdict, rowId).toBe("COMPLETED");
      expect(outcome.notRunReason, rowId).toBeNull();
      expect(validateHarnessEvidence(outcome.evidence), rowId).toEqual([]);
      expect(outcome.evidence.workOrder, rowId).toBe("VAL-052");
      expect(outcome.evidence.integrationSurface, rowId).toBe("final-report:release-gate");
      expect(outcome.evidence.request?.taskKind, rowId).toBe(FINAL_REPORT_TASK_KIND);
      const failedApp = outcome.appCriteria.filter((criterion) => criterion.status === "FAIL");
      expect(failedApp, `${rowId}: ${JSON.stringify(failedApp)}`).toEqual([]);
      const failedReport = outcome.reportCriteria.filter(
        (criterion) => criterion.status === "FAIL",
      );
      expect(failedReport, `${rowId}: ${JSON.stringify(failedReport)}`).toEqual([]);
      expect(outcome.reportCriteria, rowId).toHaveLength(13);
      // The offline usage is honestly none-reported (the inventory is
      // pure derivation over the RECORDED governed state — never a
      // fabricated measurement).
      expect(outcome.usage, rowId).toBeNull();
      expect(outcome.submissionLatencyMs, rowId).toBeGreaterThanOrEqual(0);
    }
  });

  test("the boundary-re-derived inventory reconciles against the REAL governed state (46/45/1)", async () => {
    const taskIndex = FINAL_REPORT_ROW_IDS.indexOf("inventory-consolidated-governed-state");
    const { outcome } = await runAppOverFakeWorld({ taskIndex });
    // The boundary re-derivation re-adjudicated the returned package
    // against the world of record: all thirteen criteria PASS.
    expect(outcome.reportCriteria.map((criterion) => criterion.criterionId)).toEqual([
      ...FINAL_REPORT_VERIFICATION_FAMILIES,
    ]);
    const completeness = outcome.reportCriteria.find(
      (criterion) => criterion.criterionId === "inventory-completeness",
    );
    expect(completeness?.evidence).toContain("registered-work-orders:46");
    expect(completeness?.evidence).toContain("inventoried-work-orders:46");
    const registration = outcome.reportCriteria.find(
      (criterion) => criterion.criterionId === "inventory-registration",
    );
    expect(registration?.evidence).toContain("complete:45");
    expect(
      registration?.evidence.some((line) =>
        line.startsWith("in-flight-work-order:VAL-052:planned"),
      ),
    ).toBe(true);
    const acceptance = outcome.reportCriteria.find(
      (criterion) => criterion.criterionId === "acceptance-chain-honesty",
    );
    expect(acceptance?.evidence).toContain("carried-by-pr-merge:34");
    expect(acceptance?.evidence).toContain("carried-by-program-state-finalize:11");
    const deadline = outcome.reportCriteria.find(
      (criterion) => criterion.criterionId === "deadline-remainder-honesty",
    );
    expect(deadline?.evidence).toContain("completion-timestamp:2026-09-14T21:10:45Z");
    expect(deadline?.evidence).toContain("remaining-window:PT2H49M15S");
    expect(deadline?.evidence).toContain("incomplete-at-report-time:VAL-052:planned");
  });

  test("the nine-gate adjudication is re-derived AT THE BOUNDARY with the evidence NAMED", async () => {
    const taskIndex = FINAL_REPORT_ROW_IDS.indexOf("release-gate-nine-conditions");
    const { outcome } = await runAppOverFakeWorld({ taskIndex });
    for (const family of [
      "gate-category-coverage",
      "gate-integration-paths",
      "gate-thresholds-bounded",
      "gate-longitudinal-learning",
      "gate-economic-fairness",
      "gate-not-run-disclosure",
      "gate-findings-protocol",
      "gate-reproducibility",
      "acceptance-chain-honesty",
    ]) {
      const criterion = outcome.reportCriteria.find((entry) => entry.criterionId === family);
      expect(criterion?.status, family).toBe("PASS");
      expect(criterion?.evidence.length, family).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// The adversarial probe rows over the app boundary
// ---------------------------------------------------------------------------

describe("VAL-052 the adversarial report-probe rows settle FAILED with the NAMED criteria", () => {
  test("each probe row settles FAILED and the app confirms the expected verdict + NAMED criteria", async () => {
    for (const rowId of PROBE_ROW_IDS) {
      const taskIndex = FINAL_REPORT_ROW_IDS.indexOf(rowId);
      const { outcome, world } = await runAppOverFakeWorld({ taskIndex });
      expect(world.createdExecutions, rowId).toBe(1);
      expect(outcome.observedTerminal, rowId).toBe("FAILED");
      expect(outcome.passed, rowId).toBe(true);
      expect(outcome.verdict, rowId).toBe("FAILED");
      expect(outcome.notRunReason, rowId).toBeNull();
      const row = finalReportRowById(rowId);
      const expectedNamed = [...(row?.expected.failedCriteria ?? [])].sort();
      const observedNamed = outcome.reportCriteria
        .filter((criterion) => criterion.status === "FAIL")
        .map((criterion) => criterion.criterionId)
        .sort();
      expect(observedNamed, rowId).toEqual(expectedNamed);
      const failedApp = outcome.appCriteria.filter((criterion) => criterion.status === "FAIL");
      expect(failedApp, `${rowId}: ${JSON.stringify(failedApp)}`).toEqual([]);
      expect(validateHarnessEvidence(outcome.evidence), rowId).toEqual([]);
    }
  });

  test("the probe offenders are NAMED in the boundary-re-derived evidence", async () => {
    const taskIndex = FINAL_REPORT_ROW_IDS.indexOf("probe-missing-work-order");
    const { outcome } = await runAppOverFakeWorld({ taskIndex });
    const completeness = outcome.reportCriteria.find(
      (criterion) => criterion.criterionId === "inventory-completeness",
    );
    expect(completeness?.status).toBe("FAIL");
    expect(completeness?.evidence).toContain(
      "omitted-work-order:VAL-031 (registered complete, never inventoried)",
    );
    const taskIndex2 = FINAL_REPORT_ROW_IDS.indexOf("probe-self-declared-acceptance");
    const { outcome: outcome2 } = await runAppOverFakeWorld({ taskIndex: taskIndex2 });
    const acceptance = outcome2.reportCriteria.find(
      (criterion) => criterion.criterionId === "acceptance-chain-honesty",
    );
    expect(acceptance?.status).toBe("FAIL");
    expect(
      acceptance?.evidence.some((line) =>
        line.startsWith(
          "self-declared-acceptance:VAL-052 (the Architect's acceptance is carried by the authority chain",
        ),
      ),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The live boundary (honest NOT RUN + the live-rail refusal)
// ---------------------------------------------------------------------------

describe("VAL-052 the live boundary is honest", () => {
  test("the live row is NOT RUN without OPENROUTER_API_KEY (the env var NAMED, zero submissions)", async () => {
    const taskIndex = FINAL_REPORT_ROW_IDS.indexOf("live-gate-confirmation-slice");
    const { outcome, world } = await runAppOverFakeWorld({ taskIndex, env: {} });
    expect(world.createdExecutions).toBe(0);
    expect(outcome.verdict).toBe("NOT-RUN");
    expect(outcome.notRunReason).toBe(
      "NOT RUN: OPENROUTER_API_KEY absent (the live confirmation slice demands the operator-authorized rail)",
    );
    expect(outcome.passed).toBe(true);
    expect(outcome.submission).toBeNull();
    expect(outcome.observedTerminal).toBeNull();
    expect(outcome.reportCriteria).toEqual([]);
    const liveGate = outcome.appCriteria.find(
      (criterion) => criterion.criterionId === "app-live-gate-honest",
    );
    expect(liveGate?.status).toBe("PASS");
    expect(liveGate?.evidence.join(" ")).toContain("OPENROUTER_API_KEY absent");
    expect(validateHarnessEvidence(outcome.evidence)).toEqual([]);
  });

  test("the offline fake world refuses the live rail even WITH the credential set (an honest submission failure)", async () => {
    const taskIndex = FINAL_REPORT_ROW_IDS.indexOf("live-gate-confirmation-slice");
    const { outcome, world } = await runAppOverFakeWorld({
      taskIndex,
      env: { OPENROUTER_API_KEY: "operator-authorized" },
    });
    // The gate is OPEN (the credential is present) but the offline
    // fake world REFUSES the live rail at the POST boundary — the app
    // fails the submission-landed criterion honestly (never a
    // fabricated live confirmation).
    expect(world.createdExecutions).toBe(0);
    expect(outcome.passed).toBe(false);
    expect(outcome.verdict).toBe("FAILED");
    expect(outcome.submission?.rejection?.code).toBe("CAPABILITY_UNAVAILABLE");
    expect(outcome.submission?.rejection?.status).toBe(503);
    const landed = outcome.appCriteria.find(
      (criterion) => criterion.criterionId === "submission-landed",
    );
    expect(landed?.status).toBe("FAIL");
    expect(landed?.evidence.join(" ")).toContain(
      "rejection:CAPABILITY_UNAVAILABLE/503:the submission never landed a durable execution",
    );
    expect(outcome.reportCriteria).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The customer-boundary discriminations (the controlled fakes)
// ---------------------------------------------------------------------------

describe("VAL-052 the controlled fakes forced onto the honest rows FAIL the named criteria", () => {
  const HONEST_INDEX = FINAL_REPORT_ROW_IDS.indexOf("inventory-consolidated-governed-state");

  test("forcing each of the seven probe shapes onto the honest row FAILs the named criteria", async () => {
    for (const probe of [
      "missing-work-order",
      "deleted-evidence-document",
      "boundary-without-env-var",
      "protocol-stripped-finding",
      "phantom-coverage",
      "silent-omission",
      "self-declared-acceptance",
    ] as const) {
      const { outcome } = await runAppOverFakeWorld({ taskIndex: HONEST_INDEX, probe });
      expect(outcome.verdict, probe).toBe("FAILED");
      const expectedNamed = [...PROBE_FAILED_CRITERIA_OF[probe]].sort();
      const observedNamed = outcome.reportCriteria
        .filter((criterion) => criterion.status === "FAIL")
        .map((criterion) => criterion.criterionId)
        .sort();
      expect(observedNamed, probe).toEqual(expectedNamed);
      // The boundary contract itself still pins the HONEST row's
      // expectation — the forced fake contradicts it.
      const verdictPin = outcome.appCriteria.find(
        (criterion) => criterion.criterionId === "app-report-verdict",
      );
      expect(verdictPin?.status, probe).toBe("FAIL");
      const namedPin = outcome.appCriteria.find(
        (criterion) => criterion.criterionId === "app-failed-criteria-named",
      );
      expect(namedPin?.status, probe).toBe("FAIL");
      expect(outcome.passed, probe).toBe(false);
    }
  });

  test("a terminal override FAILs the app-expected-terminal criterion", async () => {
    const { outcome } = await runAppOverFakeWorld({
      taskIndex: HONEST_INDEX,
      terminal: "FAILED",
    });
    const criterion = outcome.appCriteria.find(
      (entry) => entry.criterionId === "app-expected-terminal",
    );
    expect(criterion?.status).toBe("FAIL");
    expect(criterion?.evidence).toContain("expected:COMPLETED");
    expect(criterion?.evidence).toContain("observed:FAILED");
    expect(outcome.passed).toBe(false);
  });

  test("a fabricated pass-with-fail FAILs the terminal↔criteria agreement", async () => {
    const probeIndex = FINAL_REPORT_ROW_IDS.indexOf("probe-missing-work-order");
    const { outcome } = await runAppOverFakeWorld({
      taskIndex: probeIndex,
      fabricatePassWithFail: true,
    });
    const criterion = outcome.appCriteria.find(
      (entry) => entry.criterionId === "app-terminal-criteria-agreement",
    );
    expect(criterion?.status).toBe("FAIL");
    expect(criterion?.evidence.join(" ")).toContain("terminal:COMPLETED");
    expect(criterion?.evidence.join(" ")).toContain("statuses:FAIL,PASS");
    expect(outcome.passed).toBe(false);
  });

  test("the boundary re-derivation never trusts the platform's own claim (a forced probe is caught even when the platform reports PASS)", async () => {
    // The probe row's platform terminal is overridden to COMPLETED —
    // the boundary-re-derived oracles still FAIL the dishonest shape.
    const probeIndex = FINAL_REPORT_ROW_IDS.indexOf("probe-silent-omission");
    const { outcome } = await runAppOverFakeWorld({
      taskIndex: probeIndex,
      terminal: "COMPLETED",
      verificationStatuses: ["PASS", "PASS"],
    });
    expect(outcome.verdict).toBe("FAILED");
    expect(
      outcome.reportCriteria
        .filter((criterion) => criterion.status === "FAIL")
        .map((criterion) => criterion.criterionId),
    ).toEqual(["deadline-remainder-honesty"]);
    expect(outcome.passed).toBe(false);
  });
});
