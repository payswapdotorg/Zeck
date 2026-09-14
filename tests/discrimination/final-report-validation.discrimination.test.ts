/**
 * VAL-052 acceptance criterion 6 — the discrimination battery: the FINAL
 * REPORT / RELEASE-GATE machinery against controlled fakes, driven
 * through the application's REAL seams.
 *
 * Every catch the work order names is probed at the SEAM level: the
 * seven controlled fakes (a missing work order, a deleted evidence
 * document, a reasonless NOT RUN boundary, a protocol-stripped finding,
 * a phantom coverage claim, a silently dropped incomplete work order, a
 * self-declared acceptance) are forced onto an HONEST row's report
 * package and driven through the REAL application code —
 * `runFinalReportApp` over the public SDK/harness boundary (the
 * injected transport seam) — proving the boundary-re-derived THIRTEEN
 * mechanical oracles actually DETECT each denatured report (the NAMED
 * criterion FAILing with the mechanism named in evidence), never the
 * transport fake in isolation:
 *
 *   * each controlled fake forced onto the HONEST row FAILs the NAMED
 *     oracle at the boundary (with the honest control — the
 *     undenatured contrast pair — PASSing the same oracle);
 *   * each probe row's OWN report package settles FAILED with exactly
 *     its pinned NAMED criteria (the row-level catch);
 *   * REPLAY DETERMINISM: the same package re-derived twice is
 *     bit-stable, the same row driven twice over fresh fake worlds
 *     lands the identical verdict, and a controlled mutation between
 *     replays flips the verdict and the package digest (a flipped
 *     verdict never reproduces);
 *   * a RUBBER-STAMP oracle (one that passes everything) FAILs the
 *     suite: it passes every controlled fake, the REAL re-derivation
 *     contradicts it on each, and a platform claiming ALL-PASS
 *     statuses over a denatured report still FAILs the app's report
 *     contract;
 *   * a FAVORABLE-SUBSET battery (the honest rows only) would
 *     fake-pass — the omitted probe rows are NAMED;
 *   * the LIVE RAIL is honest: NOT RUN without OPENROUTER_API_KEY (the
 *     env var NAMED, zero submissions) and the offline fake world
 *     REFUSES the live rail even with the credential set;
 *   * every offline AC the unit suites cover is re-proven at the seam.
 *
 * The expectations are STATE-AGNOSTIC: every governed-state count
 * derives at run time over the same file the app reads (46 registered
 * work orders is the one FIXED invariant), so the battery stays green
 * across the VAL-052 finalize (45 complete + VAL-052 in flight at the
 * claim head → 46 complete + 0 in flight once the Lead's finalize
 * lands — the silent-omission shape is VACUOUS then, and its pinned
 * FAILED verdict is honestly contradicted by the derived COMPLETED).
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { runFinalReportApp } from "../../benchmarks/validation/apps/final-report/application";
import type { ReportProbeKind } from "../../benchmarks/validation/apps/final-report/corpus";
import {
  FINAL_REPORT_ROW_IDS,
  FINAL_REPORT_VERIFICATION_FAMILIES,
  finalReportRowById,
  GOVERNED_PROGRAM_STATE_PATH,
  LIVE_CORPUS_ROWS,
  liveGateOpen,
  OFFLINE_CORPUS_ROWS,
  OPERATOR_DEADLINE_UTC,
  PROBE_FAILED_CRITERIA_OF,
  pinnedReportInputDigest,
} from "../../benchmarks/validation/apps/final-report/corpus";
import type { ReportPackage } from "../../benchmarks/validation/apps/final-report/driver";
import {
  deriveReleaseGateVerdict,
  isoDurationOfMs,
  loadRealReportWorld,
  releaseGateAdjudicationOf,
  reportPackageFor,
  verifyFinalReportIntegrity,
} from "../../benchmarks/validation/apps/final-report/driver";
import {
  createFinalReportFakeApiWorld,
  createTickClock,
} from "../../benchmarks/validation/apps/final-report/fixtures";
import { validateHarnessEvidence } from "../../benchmarks/validation/harness";
import type { LabVerificationCriterion } from "../../benchmarks/validation/platform/derive";

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

// ---------------------------------------------------------------------------
// The state-agnostic derivation basis (the SAME governed-state file the
// app reads — READ-ONLY; only the TOTAL registered count 46 is a FIXED
// invariant, every count below derives at run time)
// ---------------------------------------------------------------------------

const stateFile = JSON.parse(
  readFileSync(join(process.cwd(), GOVERNED_PROGRAM_STATE_PATH), "utf8"),
) as {
  readonly asOf: string;
  readonly workOrders: Readonly<
    Record<
      string,
      {
        readonly status: string;
        readonly title: string;
        readonly mergedAs?: { readonly pr: number; readonly mergeCommit: string };
      }
    >
  >;
};
const registeredIds = Object.keys(stateFile.workOrders);
const completeIds = registeredIds.filter((id) => stateFile.workOrders[id]?.status === "complete");
const incompleteOfWorkOrder = registeredIds
  .filter((id) => stateFile.workOrders[id]?.status !== "complete")
  .map((id) => ({ workOrderId: id, status: stateFile.workOrders[id]?.status ?? "unknown" }));
const prMergeIds = registeredIds.filter((id) => stateFile.workOrders[id]?.mergedAs !== undefined);
const finalizeIds = completeIds.filter((id) => stateFile.workOrders[id]?.mergedAs === undefined);
const asOf = stateFile.asOf;
const derivedRemainingWindow = isoDurationOfMs(
  Math.max(Date.parse(OPERATOR_DEADLINE_UTC) - Date.parse(asOf), 0),
);
const val052Status = stateFile.workOrders["VAL-052"]?.status ?? "unregistered";
/** The silent-omission shape is dishonest exactly while work orders remain incomplete. */
const silentOmissionVacuous = incompleteOfWorkOrder.length === 0;

/** Drive the REAL app over the fake public API world (the SDK seam). */
async function runAppOverFakeWorld(options: {
  readonly taskIndex: number;
  readonly probe?: ReportProbeKind;
  readonly terminal?: "COMPLETED" | "FAILED";
  readonly verificationStatuses?: readonly string[];
  readonly fabricatePassWithFail?: boolean;
  readonly env?: Record<string, string | undefined>;
}) {
  const clock = createTickClock();
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
      configuration: { suite: "val-052-discrimination" },
    },
    runSuffix: "discrimination",
    taskIndex: options.taskIndex,
    env: options.env ?? {},
  });
  return { outcome, world };
}

const HONEST_ROW_ID = "inventory-consolidated-governed-state";
const HONEST_INDEX = FINAL_REPORT_ROW_IDS.indexOf(HONEST_ROW_ID);
const honestRow = finalReportRowById(HONEST_ROW_ID);
if (honestRow === null) {
  throw new Error(`unknown corpus row ${HONEST_ROW_ID}`);
}

const criterion = (
  outcome: { readonly reportCriteria: readonly LabVerificationCriterion[] },
  criterionId: string,
): LabVerificationCriterion | undefined =>
  outcome.reportCriteria.find((entry) => entry.criterionId === criterionId);

const failedCriteriaOf = (outcome: {
  readonly reportCriteria: readonly LabVerificationCriterion[];
}): readonly string[] =>
  outcome.reportCriteria
    .filter((entry) => entry.status === "FAIL")
    .map((entry) => entry.criterionId)
    .sort();

/**
 * The seven controlled fakes, each with its NAMED oracle and the
 * mechanism evidence token (the corpus-pinned offenders are stable; the
 * silent-omission token derives from the recorded status).
 */
const CONTROLLED_FAKES: readonly {
  readonly probe: ReportProbeKind;
  readonly namedOracle: string;
  readonly mechanismToken: string;
}[] = [
  {
    probe: "missing-work-order",
    namedOracle: "inventory-completeness",
    mechanismToken: "omitted-work-order:VAL-031 (registered complete, never inventoried)",
  },
  {
    probe: "deleted-evidence-document",
    namedOracle: "inventory-evidence-resolution",
    mechanismToken:
      "unresolved-evidence-document:VAL-033 (docs/work-items/VAL-033.md does not resolve)",
  },
  {
    probe: "boundary-without-env-var",
    namedOracle: "gate-not-run-disclosure",
    mechanismToken: "reasonless-not-run-boundary:live-journey-slice (no gating env var named)",
  },
  {
    probe: "protocol-stripped-finding",
    namedOracle: "gate-findings-protocol",
    mechanismToken: "protocol-stripped-finding:F-01-live-rail-credential-custody",
  },
  {
    probe: "phantom-coverage",
    namedOracle: "inventory-completeness",
    mechanismToken:
      "phantom-inventory-entry:VAL-027 (not a registered work order of the governed state)",
  },
  {
    probe: "silent-omission",
    namedOracle: "deadline-remainder-honesty",
    mechanismToken: `silently-dropped-incomplete:VAL-052 (status ${val052Status} at report time, never named)`,
  },
  {
    probe: "self-declared-acceptance",
    namedOracle: "acceptance-chain-honesty",
    mechanismToken:
      "self-declared-acceptance:VAL-052 (the Architect's acceptance is carried by the authority chain",
  },
];

// ---------------------------------------------------------------------------
// 1..7 — the seven controlled fakes, each DETECTED at the seam
// ---------------------------------------------------------------------------

describe("discrimination: a missing work order (the inventory silently omits a registered WO)", () => {
  test("forcing the missing-work-order fake onto the HONEST row FAILs inventory-completeness with the omitted work order NAMED", async () => {
    const { outcome } = await runAppOverFakeWorld({
      taskIndex: HONEST_INDEX,
      probe: "missing-work-order",
    });
    expect(outcome.verdict).toBe("FAILED");
    const completeness = criterion(outcome, "inventory-completeness");
    expect(completeness?.status).toBe("FAIL");
    expect(completeness?.evidence.join(" ")).toContain(
      "omitted-work-order:VAL-031 (registered complete, never inventoried)",
    );
    expect(outcome.passed).toBe(false);
  });

  test("the honest control (the contrast pair): the undenatured row PASSes the same oracle at the seam", async () => {
    const { outcome } = await runAppOverFakeWorld({ taskIndex: HONEST_INDEX });
    expect(outcome.verdict).toBe("COMPLETED");
    const failed = failedCriteriaOf(outcome);
    expect(failed).toEqual([]);
    const completeness = criterion(outcome, "inventory-completeness");
    expect(completeness?.status).toBe("PASS");
    expect(completeness?.evidence.join(" ")).toContain(
      `registered-work-orders:${registeredIds.length}`,
    );
  });

  test("the row-level catch: the probe row settles FAILED with exactly its pinned criteria", async () => {
    const taskIndex = FINAL_REPORT_ROW_IDS.indexOf("probe-missing-work-order");
    const { outcome } = await runAppOverFakeWorld({ taskIndex });
    expect(outcome.observedTerminal).toBe("FAILED");
    expect(failedCriteriaOf(outcome)).toEqual(
      [...PROBE_FAILED_CRITERIA_OF["missing-work-order"]].sort(),
    );
  });
});

describe("discrimination: a deleted evidence document (a complete WO's evidence unresolvable)", () => {
  test("forcing the deleted-evidence-document fake onto the HONEST row FAILs inventory-evidence-resolution with the unresolvable document NAMED", async () => {
    const { outcome } = await runAppOverFakeWorld({
      taskIndex: HONEST_INDEX,
      probe: "deleted-evidence-document",
    });
    expect(outcome.verdict).toBe("FAILED");
    const resolution = criterion(outcome, "inventory-evidence-resolution");
    expect(resolution?.status).toBe("FAIL");
    expect(resolution?.evidence.join(" ")).toContain(
      "unresolved-evidence-document:VAL-033 (docs/work-items/VAL-033.md does not resolve)",
    );
    // ONLY the resolution oracle catches it (the entry is still present
    // and honestly titled — completeness and registration PASS).
    expect(criterion(outcome, "inventory-completeness")?.status).toBe("PASS");
    expect(criterion(outcome, "inventory-registration")?.status).toBe("PASS");
    expect(outcome.passed).toBe(false);
  });

  test("the honest control: every complete work order's evidence document resolves with a re-derivable digest at the seam", async () => {
    const { outcome } = await runAppOverFakeWorld({ taskIndex: HONEST_INDEX });
    const resolution = criterion(outcome, "inventory-evidence-resolution");
    expect(resolution?.status).toBe("PASS");
    expect(resolution?.evidence.join(" ")).toContain(
      "val-001-evidence-location:benchmarks/validation/evidence/VAL-001.md",
    );
    expect(
      resolution?.evidence.some((line) => line.startsWith("in-flight-evidence:VAL-052:")),
    ).toBe(true);
  });

  test("the row-level catch: the probe row settles FAILED with exactly its pinned criteria", async () => {
    const taskIndex = FINAL_REPORT_ROW_IDS.indexOf("probe-deleted-evidence-document");
    const { outcome } = await runAppOverFakeWorld({ taskIndex });
    expect(outcome.observedTerminal).toBe("FAILED");
    expect(failedCriteriaOf(outcome)).toEqual(
      [...PROBE_FAILED_CRITERIA_OF["deleted-evidence-document"]].sort(),
    );
  });
});

describe("discrimination: a reasonless NOT RUN boundary (the gating env var stripped)", () => {
  test("forcing the boundary-without-env-var fake onto the HONEST row FAILs gate-not-run-disclosure with the reasonless boundary NAMED", async () => {
    const { outcome } = await runAppOverFakeWorld({
      taskIndex: HONEST_INDEX,
      probe: "boundary-without-env-var",
    });
    expect(outcome.verdict).toBe("FAILED");
    const disclosure = criterion(outcome, "gate-not-run-disclosure");
    expect(disclosure?.status).toBe("FAIL");
    expect(disclosure?.evidence.join(" ")).toContain(
      "reasonless-not-run-boundary:live-journey-slice (no gating env var named)",
    );
    expect(outcome.passed).toBe(false);
  });

  test("the honest control: every NOT RUN boundary names its gating env var at the seam", async () => {
    const { outcome } = await runAppOverFakeWorld({ taskIndex: HONEST_INDEX });
    const disclosure = criterion(outcome, "gate-not-run-disclosure");
    expect(disclosure?.status).toBe("PASS");
    const evidence = disclosure?.evidence.join(" ") ?? "";
    expect(evidence).toContain("not-run:live-journey-slice gated on OPENROUTER_API_KEY");
    expect(evidence).toContain("not-run:real-sql-integration-crowns gated on ZECK_PG_TEST_URL");
  });

  test("the row-level catch: the probe row settles FAILED with exactly its pinned criteria", async () => {
    const taskIndex = FINAL_REPORT_ROW_IDS.indexOf("probe-boundary-without-env-var");
    const { outcome } = await runAppOverFakeWorld({ taskIndex });
    expect(outcome.observedTerminal).toBe("FAILED");
    expect(failedCriteriaOf(outcome)).toEqual(
      [...PROBE_FAILED_CRITERIA_OF["boundary-without-env-var"]].sort(),
    );
  });
});

describe("discrimination: a protocol-stripped finding (the seven-part protocol emptied)", () => {
  test("forcing the protocol-stripped-finding fake onto the HONEST row FAILs gate-findings-protocol with the stripped finding NAMED", async () => {
    const { outcome } = await runAppOverFakeWorld({
      taskIndex: HONEST_INDEX,
      probe: "protocol-stripped-finding",
    });
    expect(outcome.verdict).toBe("FAILED");
    const findings = criterion(outcome, "gate-findings-protocol");
    expect(findings?.status).toBe("FAIL");
    const evidence = findings?.evidence.join(" ") ?? "";
    expect(evidence).toContain("protocol-stripped-finding:F-01-live-rail-credential-custody");
    expect(evidence).toContain(
      "hidden-residual-risk:F-01-live-rail-credential-custody (no residual risk named)",
    );
    expect(outcome.passed).toBe(false);
  });

  test("the honest control: every material finding carries its seven-part protocol + residual risk at the seam", async () => {
    const { outcome } = await runAppOverFakeWorld({ taskIndex: HONEST_INDEX });
    const findings = criterion(outcome, "gate-findings-protocol");
    expect(findings?.status).toBe("PASS");
    expect(
      findings?.evidence.some((line) =>
        line.startsWith("finding:F-01-live-rail-credential-custody:seven-part-protocol-complete"),
      ),
    ).toBe(true);
  });

  test("the row-level catch: the probe row settles FAILED with exactly its pinned criteria", async () => {
    const taskIndex = FINAL_REPORT_ROW_IDS.indexOf("probe-protocol-stripped-finding");
    const { outcome } = await runAppOverFakeWorld({ taskIndex });
    expect(outcome.observedTerminal).toBe("FAILED");
    expect(failedCriteriaOf(outcome)).toEqual(
      [...PROBE_FAILED_CRITERIA_OF["protocol-stripped-finding"]].sort(),
    );
  });
});

describe("discrimination: a phantom coverage claim (a never-registered work order cited)", () => {
  test("forcing the phantom-coverage fake onto the HONEST row FAILs inventory-completeness AND gate-category-coverage with the phantom NAMED", async () => {
    const { outcome } = await runAppOverFakeWorld({
      taskIndex: HONEST_INDEX,
      probe: "phantom-coverage",
    });
    expect(outcome.verdict).toBe("FAILED");
    expect(failedCriteriaOf(outcome)).toEqual(
      [...PROBE_FAILED_CRITERIA_OF["phantom-coverage"]].sort(),
    );
    const completeness = criterion(outcome, "inventory-completeness");
    expect(completeness?.status).toBe("FAIL");
    expect(completeness?.evidence.join(" ")).toContain(
      "phantom-inventory-entry:VAL-027 (not a registered work order of the governed state)",
    );
    const coverage = criterion(outcome, "gate-category-coverage");
    expect(coverage?.status).toBe("FAIL");
    expect(coverage?.evidence.join(" ")).toContain(
      "phantom-coverage:ambient-voice-translation→VAL-027 (VAL-027 is not a registered work order)",
    );
    expect(outcome.passed).toBe(false);
  });

  test("the honest control: every application category cites its completed work order at the seam", async () => {
    const { outcome } = await runAppOverFakeWorld({ taskIndex: HONEST_INDEX });
    const coverage = criterion(outcome, "gate-category-coverage");
    expect(coverage?.status).toBe("PASS");
    const evidence = coverage?.evidence.join(" ") ?? "";
    expect(evidence).toContain("categories:10/10");
    expect(evidence).toContain(
      "category:text-generation-extraction-transformation→VAL-010:complete",
    );
  });

  test("the row-level catch: the probe row settles FAILED with exactly its pinned criteria", async () => {
    const taskIndex = FINAL_REPORT_ROW_IDS.indexOf("probe-phantom-coverage");
    const { outcome } = await runAppOverFakeWorld({ taskIndex });
    expect(outcome.observedTerminal).toBe("FAILED");
    expect(failedCriteriaOf(outcome)).toEqual(
      [...PROBE_FAILED_CRITERIA_OF["phantom-coverage"]].sort(),
    );
  });
});

describe("discrimination: a silently dropped incomplete work order (the deadline accounting hides it)", () => {
  test("forcing the silent-omission fake onto the HONEST row FAILs deadline-remainder-honesty with the dropped work order NAMED (state-aware)", async () => {
    const { outcome } = await runAppOverFakeWorld({
      taskIndex: HONEST_INDEX,
      probe: "silent-omission",
    });
    if (silentOmissionVacuous) {
      // Post-finalize VACUITY: nothing is incomplete, so the empty
      // incomplete list IS the honest derivation — the forced fake
      // coincides with it (nothing left to omit).
      expect(outcome.verdict).toBe("COMPLETED");
      expect(failedCriteriaOf(outcome)).toEqual([]);
      expect(outcome.passed).toBe(true);
      return;
    }
    expect(outcome.verdict).toBe("FAILED");
    const deadline = criterion(outcome, "deadline-remainder-honesty");
    expect(deadline?.status).toBe("FAIL");
    for (const item of incompleteOfWorkOrder) {
      expect(deadline?.evidence.join(" ")).toContain(
        `silently-dropped-incomplete:${item.workOrderId} (status ${item.status} at report time, never named)`,
      );
    }
    expect(outcome.passed).toBe(false);
  });

  test("the honest control: every incomplete work order is NAMED with its status at the seam", async () => {
    const { outcome } = await runAppOverFakeWorld({ taskIndex: HONEST_INDEX });
    const deadline = criterion(outcome, "deadline-remainder-honesty");
    expect(deadline?.status).toBe("PASS");
    const evidence = deadline?.evidence.join(" ") ?? "";
    expect(evidence).toContain(`completion-timestamp:${asOf}`);
    expect(evidence).toContain(`remaining-window:${derivedRemainingWindow}`);
    expect(evidence).toContain(
      `incomplete-at-report-time:${
        incompleteOfWorkOrder.map((item) => `${item.workOrderId}:${item.status}`).join(",") ||
        "none"
      }`,
    );
  });

  test("the row-level catch: the probe row settles with its pinned criteria (state-aware: VACUOUS once nothing is incomplete)", async () => {
    const taskIndex = FINAL_REPORT_ROW_IDS.indexOf("probe-silent-omission");
    const { outcome } = await runAppOverFakeWorld({ taskIndex });
    expect(outcome.observedTerminal).toBe("FAILED");
    if (silentOmissionVacuous) {
      // The pinned FAILED verdict is honestly contradicted by the
      // derived COMPLETED — the app FAILs its own verdict pins rather
      // than fabricating a failure.
      expect(outcome.verdict).toBe("COMPLETED");
      expect(failedCriteriaOf(outcome)).toEqual([]);
      const failedApp = outcome.appCriteria
        .filter((entry) => entry.status === "FAIL")
        .map((entry) => entry.criterionId)
        .sort();
      expect(failedApp).toEqual(["app-failed-criteria-named", "app-report-verdict"]);
      expect(outcome.passed).toBe(false);
      return;
    }
    expect(outcome.verdict).toBe("FAILED");
    expect(failedCriteriaOf(outcome)).toEqual(
      [...PROBE_FAILED_CRITERIA_OF["silent-omission"]].sort(),
    );
  });
});

describe("discrimination: a self-declared acceptance (the report claims the Architect's acceptance)", () => {
  test("forcing the self-declared-acceptance fake onto the HONEST row FAILs acceptance-chain-honesty with the forgery NAMED", async () => {
    const { outcome } = await runAppOverFakeWorld({
      taskIndex: HONEST_INDEX,
      probe: "self-declared-acceptance",
    });
    expect(outcome.verdict).toBe("FAILED");
    const acceptance = criterion(outcome, "acceptance-chain-honesty");
    expect(acceptance?.status).toBe("FAIL");
    const evidence = acceptance?.evidence.join(" ") ?? "";
    expect(evidence).toContain(
      "self-declared-acceptance:VAL-052 (the Architect's acceptance is carried by the authority chain",
    );
    // The second offender derives from the recorded status: a dishonest
    // in-flight acceptance while VAL-052 is planned; an uncarried
    // acceptance once the finalize completes it.
    if (!silentOmissionVacuous) {
      expect(evidence).toContain(
        `dishonest-in-flight-acceptance:VAL-052 (status ${val052Status}; the acceptance must honestly remain pending the authority chain)`,
      );
    } else {
      expect(evidence).toContain("uncarried-acceptance:VAL-052");
    }
    expect(outcome.passed).toBe(false);
  });

  test("the honest control: the acceptance is carried by the authority chain, never self-declared, at the seam", async () => {
    const { outcome } = await runAppOverFakeWorld({ taskIndex: HONEST_INDEX });
    const acceptance = criterion(outcome, "acceptance-chain-honesty");
    expect(acceptance?.status).toBe("PASS");
    const evidence = acceptance?.evidence.join(" ") ?? "";
    expect(evidence).toContain(`carried-by-pr-merge:${prMergeIds.length}`);
    expect(evidence).toContain(`carried-by-program-state-finalize:${finalizeIds.length}`);
    expect(evidence).toContain("self-declared:none");
  });

  test("the row-level catch: the probe row settles FAILED with exactly its pinned criteria", async () => {
    const taskIndex = FINAL_REPORT_ROW_IDS.indexOf("probe-self-declared-acceptance");
    const { outcome } = await runAppOverFakeWorld({ taskIndex });
    expect(outcome.observedTerminal).toBe("FAILED");
    expect(failedCriteriaOf(outcome)).toEqual(
      [...PROBE_FAILED_CRITERIA_OF["self-declared-acceptance"]].sort(),
    );
  });
});

// ---------------------------------------------------------------------------
// 8 — replay determinism (the same package re-derived bit-stable)
// ---------------------------------------------------------------------------

describe("discrimination: replay determinism", () => {
  test("the same report package re-derived twice yields BIT-IDENTICAL criteria (honest + every fake)", () => {
    for (const fake of CONTROLLED_FAKES) {
      if (fake.probe === "silent-omission" && silentOmissionVacuous) {
        continue;
      }
      const report = reportPackageFor(honestRow, WORLD, { probe: fake.probe });
      const first = JSON.stringify(
        verifyFinalReportIntegrity({ row: honestRow, world: WORLD, report }),
      );
      const second = JSON.stringify(
        verifyFinalReportIntegrity({ row: honestRow, world: WORLD, report }),
      );
      expect(second, fake.probe).toBe(first);
      // The package itself is a pure derivation (re-derived identical).
      expect(reportPackageFor(honestRow, WORLD, { probe: fake.probe })).toEqual(report);
    }
    const honest = reportPackageFor(honestRow, WORLD);
    expect(
      JSON.stringify(verifyFinalReportIntegrity({ row: honestRow, world: WORLD, report: honest })),
    ).toBe(
      JSON.stringify(verifyFinalReportIntegrity({ row: honestRow, world: WORLD, report: honest })),
    );
    expect(reportPackageFor(honestRow, WORLD)).toEqual(honest);
  });

  test("the same row driven twice over fresh fake worlds lands the IDENTICAL verdict and report criteria", async () => {
    const firstRun = await runAppOverFakeWorld({ taskIndex: HONEST_INDEX });
    const secondRun = await runAppOverFakeWorld({ taskIndex: HONEST_INDEX });
    expect(secondRun.outcome.verdict).toBe(firstRun.outcome.verdict);
    expect(JSON.stringify(secondRun.outcome.reportCriteria)).toBe(
      JSON.stringify(firstRun.outcome.reportCriteria),
    );
    // A flipped verdict on replay would FAIL here — the re-derivation
    // must reproduce bit-for-bit.
    expect(secondRun.outcome.passed).toBe(true);
    // And the same holds for a denatured report (the fake is stable too).
    const firstFake = await runAppOverFakeWorld({
      taskIndex: HONEST_INDEX,
      probe: "missing-work-order",
    });
    const secondFake = await runAppOverFakeWorld({
      taskIndex: HONEST_INDEX,
      probe: "missing-work-order",
    });
    expect(secondFake.outcome.verdict).toBe(firstFake.outcome.verdict);
    expect(JSON.stringify(secondFake.outcome.reportCriteria)).toBe(
      JSON.stringify(firstFake.outcome.reportCriteria),
    );
  });

  test("a controlled mutation between replays flips the verdict and the package digest (determinism is discriminating, never vacuous)", () => {
    const honest = reportPackageFor(honestRow, WORLD);
    const honestVerdict = deriveReleaseGateVerdict({
      row: honestRow,
      world: WORLD,
      report: honest,
    });
    expect(honestVerdict.verdict).toBe("COMPLETED");
    // The mutation: the replay drops one registered work order from the
    // inventory (a durable read that silently lost a work order).
    const mutated: ReportPackage = {
      ...honest,
      inventory: honest.inventory.filter((entry) => entry.workOrderId !== "VAL-031"),
    };
    const mutatedVerdict = deriveReleaseGateVerdict({
      row: honestRow,
      world: WORLD,
      report: mutated,
    });
    expect(mutatedVerdict.verdict).toBe("FAILED");
    expect(mutatedVerdict.failedCriteria).toContain("inventory-completeness");
    // The re-derived package digest over the mutated inventory differs
    // (the same FNV-1a convention the driver pins) — a durable read
    // that silently lost a work order is digest-visible.
    const mutatedDigest = reportPackageFor(honestRow, WORLD, {
      probe: "missing-work-order",
    }).packageDigest;
    expect(mutatedDigest === honest.packageDigest).toBe(false);
    expect(mutated.inventory.length).toBe(honest.inventory.length - 1);
  });
});

// ---------------------------------------------------------------------------
// 9 — a rubber-stamp oracle (one that passes everything) FAILs the suite
// ---------------------------------------------------------------------------

/** The controlled RUBBER-STAMP oracle: passes everything, re-derives nothing. */
const rubberStampOracle = (report: ReportPackage): readonly LabVerificationCriterion[] =>
  FINAL_REPORT_VERIFICATION_FAMILIES.map((family) => ({
    criterionId: family,
    strategy: "deterministic",
    status: "PASS",
    evidence: [`rubber-stamp:${report.rowId} passed without re-derivation`],
  }));

describe("discrimination: a rubber-stamp oracle", () => {
  test("the confession: a pass-everything oracle passes EVERY controlled fake (worthless on its own)", () => {
    for (const fake of CONTROLLED_FAKES) {
      const report = reportPackageFor(honestRow, WORLD, { probe: fake.probe });
      const stamped = rubberStampOracle(report);
      expect(
        stamped.every((entry) => entry.status === "PASS"),
        fake.probe,
      ).toBe(true);
    }
  });

  test("the suite FAILs it: the REAL boundary re-derivation contradicts the stamp on every non-vacuous fake (the named criteria FAIL where the stamp says PASS)", () => {
    for (const fake of CONTROLLED_FAKES) {
      if (fake.probe === "silent-omission" && silentOmissionVacuous) {
        // Post-finalize the silent-omission shape is vacuous — the
        // honest control itself is all-PASS, so the stamp agreeing with
        // it there is not a contradiction (the other six still are).
        continue;
      }
      const report = reportPackageFor(honestRow, WORLD, { probe: fake.probe });
      const stamped = rubberStampOracle(report);
      const real = verifyFinalReportIntegrity({ row: honestRow, world: WORLD, report });
      // An oracle that passes everything cannot satisfy this suite: the
      // real machinery FAILs the named criterion the stamp passed.
      const named = real.find((entry) => entry.criterionId === fake.namedOracle);
      expect(named?.status, fake.probe).toBe("FAIL");
      const stampedNamed = stamped.find((entry) => entry.criterionId === fake.namedOracle);
      expect(stampedNamed?.status, fake.probe).toBe("PASS");
      expect(
        deriveReleaseGateVerdict({ row: honestRow, world: WORLD, report }).verdict,
        fake.probe,
      ).toBe("FAILED");
    }
  });

  test("the seam-level rubber stamp: a platform claiming ALL-PASS statuses over a denatured report still FAILs the app contract", async () => {
    // The platform's own verification claims PASS,PASS (the rubber
    // stamp) while the report package is denatured — the app re-derives
    // AT THE BOUNDARY and refuses to trust the claim.
    const { outcome } = await runAppOverFakeWorld({
      taskIndex: HONEST_INDEX,
      probe: "missing-work-order",
      verificationStatuses: ["PASS", "PASS"],
    });
    expect(outcome.verificationStatuses).toEqual(["PASS", "PASS"]);
    expect(outcome.verdict).toBe("FAILED");
    expect(outcome.passed).toBe(false);
    expect(criterion(outcome, "inventory-completeness")?.status).toBe("FAIL");
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
      const taskIndex = FINAL_REPORT_ROW_IDS.indexOf(rowId);
      const { outcome } = await runAppOverFakeWorld({ taskIndex });
      expect(outcome.passed, rowId).toBe(true);
      expect(failedCriteriaOf(outcome), rowId).toEqual([]);
    }
    // The favorable subset omits EXACTLY the seven adversarial probe
    // rows (NAMED) — every one of which carries a non-empty pinned
    // failed-criteria vocabulary the subset would never exercise.
    expect(OMITTED_ROW_IDS).toEqual([
      "probe-missing-work-order",
      "probe-deleted-evidence-document",
      "probe-boundary-without-env-var",
      "probe-protocol-stripped-finding",
      "probe-phantom-coverage",
      "probe-silent-omission",
      "probe-self-declared-acceptance",
    ]);
    for (const rowId of OMITTED_ROW_IDS) {
      const row = finalReportRowById(rowId);
      expect(row?.probe?.kind, rowId).toBeDefined();
      expect(
        row?.probe ? PROBE_FAILED_CRITERIA_OF[row.probe.kind].length : 0,
        rowId,
      ).toBeGreaterThan(0);
    }
  });

  test("the full battery FAILs each omitted probe row's pinned criteria (the subset hid every discrimination; state-aware for the vacuous silent-omission shape)", async () => {
    for (const rowId of OMITTED_ROW_IDS) {
      const taskIndex = FINAL_REPORT_ROW_IDS.indexOf(rowId);
      const row = finalReportRowById(rowId);
      const { outcome } = await runAppOverFakeWorld({ taskIndex });
      expect(outcome.observedTerminal, rowId).toBe("FAILED");
      const vacuous = rowId === "probe-silent-omission" && silentOmissionVacuous;
      if (vacuous) {
        // Post-finalize the shape is vacuous: the derived verdict
        // flips to COMPLETED and the app FAILs its own corpus pins —
        // never a fabricated failure.
        expect(outcome.verdict, rowId).toBe("COMPLETED");
        expect(failedCriteriaOf(outcome), rowId).toEqual([]);
        expect(outcome.passed, rowId).toBe(false);
        continue;
      }
      expect(failedCriteriaOf(outcome), rowId).toEqual(
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
    const taskIndex = FINAL_REPORT_ROW_IDS.indexOf("live-gate-confirmation-slice");
    const { outcome, world } = await runAppOverFakeWorld({ taskIndex, env: {} });
    expect(world.createdExecutions).toBe(0);
    expect(outcome.verdict).toBe("NOT-RUN");
    expect(outcome.notRunReason).toBe(
      "NOT RUN: OPENROUTER_API_KEY absent (the live confirmation slice demands the operator-authorized rail)",
    );
    expect(outcome.submission).toBeNull();
    expect(outcome.passed).toBe(true);
    expect(outcome.appCriteria.map((entry) => entry.criterionId)).toEqual(["app-live-gate-honest"]);
  });

  test("the offline fake world REFUSES the live rail even with the credential set (a live confirmation is never fabricated offline)", async () => {
    const taskIndex = FINAL_REPORT_ROW_IDS.indexOf("live-gate-confirmation-slice");
    const { outcome, world } = await runAppOverFakeWorld({
      taskIndex,
      env: { OPENROUTER_API_KEY: "operator-authorized" },
    });
    expect(world.createdExecutions).toBe(0);
    expect(outcome.passed).toBe(false);
    expect(outcome.verdict).toBe("FAILED");
    const landed = outcome.appCriteria.find((entry) => entry.criterionId === "submission-landed");
    expect(landed?.status).toBe("FAIL");
    expect(outcome.submission?.rejection?.code).toBe("CAPABILITY_UNAVAILABLE");
    expect(outcome.submission?.rejection?.status).toBe(503);
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
  test("every offline honest row lands ONE durable execution and settles COMPLETED with all THIRTEEN oracles PASSing", async () => {
    for (const rowId of [
      "inventory-consolidated-governed-state",
      "release-gate-nine-conditions",
      "program-coverage-and-disclosures",
      "deadline-remainder-honest",
      "acceptance-chain-carried",
    ]) {
      const taskIndex = FINAL_REPORT_ROW_IDS.indexOf(rowId);
      const { outcome, world } = await runAppOverFakeWorld({ taskIndex });
      expect(world.createdExecutions, rowId).toBe(1);
      expect(outcome.observedTerminal, rowId).toBe("COMPLETED");
      expect(outcome.verdict, rowId).toBe("COMPLETED");
      expect(outcome.reportCriteria, rowId).toHaveLength(FINAL_REPORT_VERIFICATION_FAMILIES.length);
      const failedApp = outcome.appCriteria.filter((entry) => entry.status === "FAIL");
      expect(failedApp, rowId).toEqual([]);
      const failedReport = failedCriteriaOf(outcome);
      expect(failedReport, `${rowId}: ${JSON.stringify(failedReport)}`).toEqual([]);
      // The offline usage is honestly none-reported (the inventory is
      // pure derivation over the RECORDED governed state — never a
      // fabricated measurement).
      expect(outcome.usage, rowId).toBeNull();
      expect(outcome.notRunReason, rowId).toBeNull();
      expect(validateHarnessEvidence(outcome.evidence), rowId).toEqual([]);
    }
  });

  test("the boundary-re-derived inventory reconciles against the REAL governed state (46 registered — the FIXED invariant; the split DERIVED)", async () => {
    const { outcome } = await runAppOverFakeWorld({ taskIndex: HONEST_INDEX });
    const completeness = criterion(outcome, "inventory-completeness");
    expect(completeness?.evidence).toContain(`registered-work-orders:${registeredIds.length}`);
    expect(completeness?.evidence).toContain(`inventoried-work-orders:${registeredIds.length}`);
    expect(registeredIds).toHaveLength(46);
    const registration = criterion(outcome, "inventory-registration");
    expect(registration?.evidence).toContain(`complete:${completeIds.length}`);
    expect(registration?.evidence).toContain(`not-complete:${incompleteOfWorkOrder.length}`);
    const acceptance = criterion(outcome, "acceptance-chain-honesty");
    expect(acceptance?.evidence).toContain(`carried-by-pr-merge:${prMergeIds.length}`);
    expect(acceptance?.evidence).toContain(
      `carried-by-program-state-finalize:${finalizeIds.length}`,
    );
    const deadline = criterion(outcome, "deadline-remainder-honesty");
    expect(deadline?.evidence).toContain(`completion-timestamp:${asOf}`);
    expect(deadline?.evidence).toContain(`remaining-window:${derivedRemainingWindow}`);
  });

  test("the NINE-gate adjudication is re-derived AT THE BOUNDARY with the evidence NAMED (all nine conditions PASS)", async () => {
    const taskIndex = FINAL_REPORT_ROW_IDS.indexOf("release-gate-nine-conditions");
    const { outcome } = await runAppOverFakeWorld({ taskIndex });
    const adjudication = releaseGateAdjudicationOf(outcome.reportCriteria);
    expect(adjudication).toHaveLength(9);
    expect(adjudication.map((gate) => gate.condition)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    for (const gate of adjudication) {
      expect(gate.status, gate.family).toBe("PASS");
      expect(gate.evidenceNamed.length, gate.family).toBeGreaterThan(0);
    }
  });

  test("the honest criteria at the seam EQUAL the pure offline derivation (bit-stable parity)", async () => {
    const { outcome } = await runAppOverFakeWorld({ taskIndex: HONEST_INDEX });
    const pure = verifyFinalReportIntegrity({
      row: honestRow,
      world: WORLD,
      report: reportPackageFor(honestRow, WORLD),
    });
    expect(JSON.stringify(outcome.reportCriteria)).toBe(JSON.stringify(pure));
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
    const taskIndex = FINAL_REPORT_ROW_IDS.indexOf("probe-missing-work-order");
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
    const outcome = await runFinalReportApp({
      config: baseConfig,
      token: "test-token",
      transport: rejectingTransport,
      world: WORLD,
      now: clock.now,
      sleep: async () => {},
      environment: {
        runtime: "bun test",
        toolchain: "bun",
        database: "none",
        configuration: { suite: "val-052-discrimination" },
      },
      runSuffix: "discrimination",
      taskIndex: HONEST_INDEX,
      env: {},
    });
    expect(outcome.passed).toBe(false);
    expect(outcome.verdict).toBe("FAILED");
    expect(outcome.appCriteria.map((entry) => entry.criterionId)).toEqual(["submission-landed"]);
    expect(outcome.appCriteria[0]?.status).toBe("FAIL");
    expect(outcome.submission?.rejection?.code).toBe("CAPABILITY_UNAVAILABLE");
  });

  test("the digest discipline at the seam: payload-free FNV-1a digests, a stable corpus input digest and the mechanical verdict vocabulary", async () => {
    const { outcome } = await runAppOverFakeWorld({ taskIndex: HONEST_INDEX });
    // The verdict vocabulary is the declared vocabulary only.
    const vocabulary = new Set(["COMPLETED", "FAILED", "NOT-RUN"]);
    expect(vocabulary.has(outcome.verdict)).toBe(true);
    for (const entry of outcome.reportCriteria) {
      expect(FINAL_REPORT_VERIFICATION_FAMILIES).toContain(entry.criterionId);
    }
    // The corpus input digest is stable (the reproducibility pin).
    expect(pinnedReportInputDigest()).toMatch(/^[0-9a-f]{8}$/);
    expect(pinnedReportInputDigest()).toBe(pinnedReportInputDigest());
    // The package digests are payload-free FNV-1a forms.
    const honest = reportPackageFor(honestRow, WORLD);
    expect(honest.packageDigest).toMatch(/^[0-9a-f]{8}$/);
    for (const entry of honest.inventory) {
      if (entry.status === "complete") {
        expect(entry.evidence.contentDigest, entry.workOrderId).toMatch(/^[0-9a-f]{8}$/);
      }
    }
    // Every controlled fake's verdict NAMED its oracle (the vocabulary
    // discipline holds across the whole battery, vacuous shape aside).
    for (const fake of CONTROLLED_FAKES) {
      if (fake.probe === "silent-omission" && silentOmissionVacuous) {
        continue;
      }
      const verdict = deriveReleaseGateVerdict({
        row: honestRow,
        world: WORLD,
        report: reportPackageFor(honestRow, WORLD, { probe: fake.probe }),
      });
      expect(vocabulary.has(verdict.verdict), fake.probe).toBe(true);
      expect(verdict.failedCriteria, fake.probe).toContain(fake.namedOracle);
    }
  });
});
