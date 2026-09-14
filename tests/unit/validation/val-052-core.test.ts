/**
 * VAL-052 acceptance criteria 1, 2, 4, 5 and 6 (the machinery core):
 * the mechanical report + release-gate engine over the REAL governed
 * program state.
 *
 *   * the honest rows over the REAL governed state: all THIRTEEN
 *     mechanical criteria PASS and the verdict is COMPLETED — the
 *     consolidated-evidence-inventory reconciliation (every work
 *     order of the program present with its registered title,
 *     completion status and resolved evidence document — 46
 *     registered (the ONE FIXED invariant); the complete/in-flight
 *     split, the pr-merge/finalize-carried counts, the asOf-derived
 *     remaining window and every count pinned below DERIVE at run
 *     time over the SAME governed-state file the app reads, so the
 *     suite stays green across the VAL-052 finalize: 45 complete +
 *     VAL-052 in flight at the claim head, 46 complete + 0 in flight
 *     once the Lead's finalize lands), the NINE release-gate conditions
 *     adjudicated with the evidence NAMED, the deadline-remainder
 *     honesty (the completion timestamp, the remaining window against
 *     the pinned operator deadline) and the acceptance-chain honesty
 *     (carried by the authority chain, never self-declared);
 *   * the seven adversarial probe rows each FAIL exactly their pinned
 *     NAMED criteria with the offender NAMED in evidence;
 *   * the controlled fakes: package-level forgeries (a mistitled
 *     entry, a misstated status, a digest disagreement, an unbounded
 *     threshold claim, an unpaired comparison, a deadline mismatch)
 *     and the fake report worlds each FAIL the NAMED oracle;
 *   * the digest discipline (FNV-1a payload-free digests, the pinned
 *     corpus input digest) and replay determinism (bit-stable
 *     re-derivation).
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { economicDigestOf } from "../../../benchmarks/validation/apps/economic-baseline/driver";
import type { ReportProbeKind } from "../../../benchmarks/validation/apps/final-report/corpus";
import {
  APPLICATION_CATEGORIES,
  FINAL_REPORT_CORPUS,
  FINAL_REPORT_CORPUS_VERSION,
  FINAL_REPORT_ROW_IDS,
  FINAL_REPORT_VERIFICATION_FAMILIES,
  finalReportRowById,
  GOVERNED_PROGRAM_STATE_PATH,
  INTEGRATION_PATHS,
  liveGateOpen,
  MATERIAL_FINDINGS,
  NOT_RUN_BOUNDARIES,
  OPERATOR_DEADLINE_UTC,
  PROBE_FAILED_CRITERIA_OF,
  pinnedReportInputDigest,
  RELEASE_GATE_CONDITIONS,
  registeredEvidencePathOf,
  reportTaskBodyFor,
  SEVEN_PART_PROTOCOL_PARTS,
} from "../../../benchmarks/validation/apps/final-report/corpus";
import type { ReportPackage } from "../../../benchmarks/validation/apps/final-report/driver";
import {
  consolidatedInventoryOf,
  deriveReleaseGateVerdict,
  isoDurationOfMs,
  loadRealReportWorld,
  releaseGateAdjudicationOf,
  reportPackageFor,
  verificationFamilyOrder,
  verifyFinalReportIntegrity,
} from "../../../benchmarks/validation/apps/final-report/driver";
import { createFakeReportWorld } from "../../../benchmarks/validation/apps/final-report/fixtures";

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

const WORLD = loadRealReportWorld();

// ---------------------------------------------------------------------------
// The state-agnostic derivation basis — the SAME governed-state file
// the app reads (READ-ONLY), re-read here so every EXPECTED value below
// derives at run time: the counts are TRUE at the claim head (45 complete
// + VAL-052 planned, 34 pr-merge + 11 finalize-carried) AND after the
// Lead's VAL-052 finalize lands (46 complete + 0 in-flight) — only the
// TOTAL registered count 46 stays a FIXED invariant. The assertions
// pin the APP's derivation against THIS derived expectation.
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
const resolvedCompleteCount = completeIds.filter((id) =>
  existsSync(join(process.cwd(), registeredEvidencePathOf(id))),
).length;
const asOf = stateFile.asOf;
const derivedRemainingMs = Date.parse(OPERATOR_DEADLINE_UTC) - Date.parse(asOf);
const derivedRemainingWindow = isoDurationOfMs(Math.max(derivedRemainingMs, 0));
const val052Registered = stateFile.workOrders["VAL-052"];
const val052Status = val052Registered?.status ?? "unregistered";
const derivedVal052Carrier =
  val052Registered?.mergedAs !== undefined
    ? "pr-merge"
    : val052Registered?.status === "complete"
      ? "program-state-finalize"
      : "pending-authority-chain";

function rowOf(rowId: string) {
  const row = finalReportRowById(rowId);
  if (row === null) {
    throw new Error(`no corpus row ${rowId}`);
  }
  return row;
}

function packageOf(rowId: string): ReportPackage {
  return reportPackageFor(rowOf(rowId), WORLD);
}

function criteriaOf(rowId: string) {
  return verifyFinalReportIntegrity({ row: rowOf(rowId), world: WORLD, report: packageOf(rowId) });
}

function evidenceOf(rowId: string, criterionId: string): readonly string[] {
  const criterion = criteriaOf(rowId).find((candidate) => candidate.criterionId === criterionId);
  if (criterion === undefined) {
    throw new Error(`no criterion ${criterionId} for ${rowId}`);
  }
  return criterion.evidence;
}

// ---------------------------------------------------------------------------
// The honest report rows over the REAL governed state
// ---------------------------------------------------------------------------

describe("VAL-052 the honest report rows verify all thirteen mechanical criteria", () => {
  test("the canonical consolidated-inventory row PASSes every criterion in the declared order", () => {
    const criteria = criteriaOf("inventory-consolidated-governed-state");
    expect(criteria.map((criterion) => criterion.criterionId)).toEqual([
      ...FINAL_REPORT_VERIFICATION_FAMILIES,
    ]);
    for (const criterion of criteria) {
      expect(criterion.status, criterion.criterionId).toBe("PASS");
      expect(criterion.strategy, criterion.criterionId).toBe("deterministic");
    }
    expect(
      deriveReleaseGateVerdict({
        row: rowOf("inventory-consolidated-governed-state"),
        world: WORLD,
        report: packageOf("inventory-consolidated-governed-state"),
      }),
    ).toEqual({
      verdict: "COMPLETED",
      failedCriteria: [],
    });
  });

  test("every honest row derives the COMPLETED verdict over the REAL governed state", () => {
    for (const rowId of HONEST_ROW_IDS) {
      const verdict = deriveReleaseGateVerdict({
        row: rowOf(rowId),
        world: WORLD,
        report: packageOf(rowId),
      });
      expect(verdict.verdict, rowId).toBe("COMPLETED");
      expect(verdict.failedCriteria, rowId).toEqual([]);
    }
  });
});

describe("VAL-052 the consolidated inventory reconciles exactly against the REAL governed state", () => {
  const inventory = consolidatedInventoryOf(WORLD);

  test("the governed program state registers 46 work orders (the FIXED invariant) and the app's inventory split equals the RUN-TIME-DERIVED expectation", () => {
    expect(registeredIds).toHaveLength(46);
    expect(inventory.filter((entry) => entry.status === "complete")).toHaveLength(
      completeIds.length,
    );
    expect(
      inventory.filter((entry) => entry.status !== "complete").map((entry) => entry.workOrderId),
    ).toEqual(incompleteOfWorkOrder.map((item) => item.workOrderId));
    expect(registeredIds).toContain("VAL-052");
    expect(val052Registered?.title).toBe(
      "Final validation report, findings, solutions and release gate",
    );
    // The app's world IS the governed state of record (the same file,
    // READ-ONLY) — the asOf of record flows into every deadline
    // derivation below (never a hardcoded timestamp).
    expect(WORLD.programState.asOf).toBe(asOf);
    expect(WORLD.reportTimestamp).toBe(asOf);
  });

  test("the inventory holds EXACTLY the registered work orders — no omission, no phantom", () => {
    expect(inventory.map((entry) => entry.workOrderId)).toEqual(registeredIds);
    const completeness = evidenceOf(
      "inventory-consolidated-governed-state",
      "inventory-completeness",
    );
    expect(completeness).toContain(`registered-work-orders:${registeredIds.length}`);
    expect(completeness).toContain(`inventoried-work-orders:${registeredIds.length}`);
  });

  test("every entry's title and completion status match the registered record exactly", () => {
    for (const entry of inventory) {
      expect(entry.title, entry.workOrderId).toBe(stateFile.workOrders[entry.workOrderId]?.title);
      expect(entry.status, entry.workOrderId).toBe(stateFile.workOrders[entry.workOrderId]?.status);
    }
    const registration = evidenceOf(
      "inventory-consolidated-governed-state",
      "inventory-registration",
    );
    expect(registration).toContain(`titles-verified:${registeredIds.length}`);
    expect(registration).toContain(`complete:${completeIds.length}`);
    expect(registration).toContain(`not-complete:${incompleteOfWorkOrder.length}`);
    // Every work order not complete at report time is NAMED in-flight
    // with its DERIVED status (VAL-052:planned at the claim head; none
    // at all once the finalize lands — never a hardcoded list).
    const inFlightLines = registration.filter((line) => line.startsWith("in-flight-work-order:"));
    expect(inFlightLines).toHaveLength(incompleteOfWorkOrder.length);
    for (const item of incompleteOfWorkOrder) {
      expect(
        registration.some((line) =>
          line.startsWith(`in-flight-work-order:${item.workOrderId}:${item.status}`),
        ),
        item.workOrderId,
      ).toBe(true);
    }
  });

  test("every COMPLETE work order's evidence document resolves at its registered location with a re-derivable digest", () => {
    for (const entry of inventory) {
      expect(entry.evidence.registeredPath, entry.workOrderId).toBe(
        registeredEvidencePathOf(entry.workOrderId),
      );
      if (entry.status !== "complete") {
        continue;
      }
      expect(entry.evidence.resolved, entry.workOrderId).toBe(true);
      expect(entry.evidence.contentDigest, entry.workOrderId).toMatch(/^[0-9a-f]{8}$/);
      // The digest is the re-derivation over the world (payload-free FNV-1a).
      expect(entry.evidence.contentDigest, entry.workOrderId).toBe(
        WORLD.evidenceDocOf(entry.workOrderId).contentDigest,
      );
    }
    // VAL-001's registered evidence location is the evidence file, not a work item.
    expect(registeredEvidencePathOf("VAL-001")).toBe("benchmarks/validation/evidence/VAL-001.md");
    expect(registeredEvidencePathOf("VAL-051")).toBe("docs/work-items/VAL-051.md");
    const resolution = evidenceOf(
      "inventory-consolidated-governed-state",
      "inventory-evidence-resolution",
    );
    expect(resolution).toContain(`evidence-documents-resolved:${resolvedCompleteCount}`);
    expect(resolution).toContain(
      "val-001-evidence-location:benchmarks/validation/evidence/VAL-001.md",
    );
    expect(resolution.some((line) => line.startsWith("in-flight-evidence:VAL-052:"))).toBe(true);
  });

  test("the merge/finalize records are cited where recorded (pr-merge + finalize-carried counts DERIVED from the governed state)", () => {
    const withMerge = inventory.filter((entry) => entry.mergeRecord !== null);
    const finalizeCarried = inventory.filter(
      (entry) => entry.mergeRecord === null && entry.acceptanceCarrier === "program-state-finalize",
    );
    expect(withMerge).toHaveLength(prMergeIds.length);
    expect(finalizeCarried).toHaveLength(finalizeIds.length);
    expect(finalizeCarried.map((entry) => entry.workOrderId).sort()).toEqual(
      [...finalizeIds].sort(),
    );
    // The citations match the recorded mergedAs blocks exactly.
    for (const entry of withMerge) {
      const mergedAs = stateFile.workOrders[entry.workOrderId]?.mergedAs;
      expect(entry.mergeRecord?.pr, entry.workOrderId).toBe(mergedAs?.pr);
      expect(entry.mergeRecord?.mergeCommit, entry.workOrderId).toBe(mergedAs?.mergeCommit);
      expect(entry.acceptanceCarrier, entry.workOrderId).toBe("pr-merge");
    }
    expect(inventory.find((entry) => entry.workOrderId === "VAL-051")?.mergeRecord).toEqual({
      pr: 117,
      mergeCommit: "c679690d4065",
    });
    // VAL-052 — the recorded status of record (planned at the claim
    // head; complete once the Lead's finalize lands) with its
    // acceptance carrier DERIVED from the same governed state.
    const val052 = inventory.find((entry) => entry.workOrderId === "VAL-052");
    expect(val052?.status).toBe(val052Status);
    expect(val052?.mergeRecord).toEqual(
      val052Registered?.mergedAs === undefined
        ? null
        : {
            pr: val052Registered.mergedAs.pr,
            mergeCommit: val052Registered.mergedAs.mergeCommit,
          },
    );
    expect(val052?.acceptanceCarrier).toBe(derivedVal052Carrier);
    const acceptance = evidenceOf(
      "inventory-consolidated-governed-state",
      "acceptance-chain-honesty",
    );
    expect(acceptance).toContain(`carried-by-pr-merge:${prMergeIds.length}`);
    expect(acceptance).toContain(`carried-by-program-state-finalize:${finalizeIds.length}`);
    expect(acceptance).toContain("self-declared:none");
    expect(acceptance.some((line) => line.startsWith("pending-authority-chain:VAL-052"))).toBe(
      true,
    );
  });
});

describe("VAL-052 the nine release-gate conditions are adjudicated with the evidence NAMED", () => {
  test("all nine conditions PASS over the recorded evidence, each mapped to its family", () => {
    const adjudication = releaseGateAdjudicationOf(criteriaOf("release-gate-nine-conditions"));
    expect(adjudication).toHaveLength(9);
    expect(adjudication.map((gate) => gate.condition)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    const families = new Set(RELEASE_GATE_CONDITIONS.map((gate) => gate.family));
    expect(families.size).toBe(9);
    for (const family of RELEASE_GATE_CONDITIONS.map((gate) => gate.family)) {
      expect(FINAL_REPORT_VERIFICATION_FAMILIES, family).toContain(family);
    }
    for (const gate of adjudication) {
      expect(gate.status, gate.family).toBe("PASS");
      expect(gate.evidenceNamed.length, gate.family).toBeGreaterThan(0);
      expect(gate.statement.length, gate.family).toBeGreaterThan(0);
    }
  });

  test("gate 1 — every application category cites its completed work order (10 categories)", () => {
    const coverage = evidenceOf("program-coverage-and-disclosures", "gate-category-coverage");
    expect(coverage).toContain("categories:10/10");
    for (const category of APPLICATION_CATEGORIES) {
      expect(
        coverage.some((line) =>
          line.startsWith(`category:${category.category}→${category.workOrderId}:complete`),
        ),
        category.category,
      ).toBe(true);
    }
  });

  test("gate 2 — the public integration paths proven (SDK harness, capability matrix, e2e journey)", () => {
    const paths = evidenceOf("release-gate-nine-conditions", "gate-integration-paths");
    for (const path of INTEGRATION_PATHS) {
      expect(paths).toContain(`${path.surface}:${path.workOrderId}:complete`);
    }
  });

  test("gate 3 — the thresholds are explicitly bounded (no unbounded claim)", () => {
    const thresholds = evidenceOf("release-gate-nine-conditions", "gate-thresholds-bounded");
    expect(thresholds).toContain("thresholds:10");
    for (const line of thresholds.filter((entry) => entry.startsWith("threshold:"))) {
      expect(line).toMatch(/^threshold:VAL-\d{3}:bounded$/);
    }
  });

  test("gate 4 — longitudinal learning demonstrated with the recorded answer carried AS RECORDED", () => {
    const learning = evidenceOf("release-gate-nine-conditions", "gate-longitudinal-learning");
    expect(learning).toContain("learning-chain:7");
    expect(learning).toContain(
      "recorded-outcome:VAL-036:carried-as-recorded (a recorded tie or negative is a valid demonstration, never a failed gate)",
    );
  });

  test("gate 5 — every economic comparison cites its strong baselines (the paired structure)", () => {
    const economics = evidenceOf("release-gate-nine-conditions", "gate-economic-fairness");
    expect(economics).toContain("paired-comparisons:5");
    expect(economics).toContain("paired:VAL-044 vs baselines VAL-041+VAL-042+VAL-043");
  });

  test("gate 6 — every NOT RUN boundary discloses its exact reason and gating env var NAMED", () => {
    const boundaries = evidenceOf("program-coverage-and-disclosures", "gate-not-run-disclosure");
    expect(boundaries).toContain("not-run-boundaries:7");
    for (const boundary of NOT_RUN_BOUNDARIES) {
      expect(boundaries).toContain(`not-run:${boundary.scope} gated on ${boundary.envVar}`);
    }
    const disclosedEnvVars = new Set(NOT_RUN_BOUNDARIES.map((boundary) => boundary.envVar));
    expect([...disclosedEnvVars].sort()).toEqual([
      "OPENROUTER_API_KEY",
      "QWEN_API_KEY",
      "ZECK_PG_TEST_URL",
    ]);
  });

  test("gate 7 — every material finding carries its seven-part protocol + residual risk", () => {
    const findings = evidenceOf("program-coverage-and-disclosures", "gate-findings-protocol");
    expect(findings).toContain("material-findings:3");
    expect(SEVEN_PART_PROTOCOL_PARTS).toHaveLength(7);
    for (const finding of MATERIAL_FINDINGS) {
      for (const part of SEVEN_PART_PROTOCOL_PARTS) {
        expect(finding.protocol[part]?.length, `${finding.findingId}/${part}`).toBeGreaterThan(0);
      }
      expect(finding.residualRisk.length, finding.findingId).toBeGreaterThan(0);
      expect(
        findings.some((line) =>
          line.startsWith(`finding:${finding.findingId}:seven-part-protocol-complete`),
        ),
        finding.findingId,
      ).toBe(true);
    }
  });

  test("gate 8 — reproducibility carried by the VAL-049 replay-bit-stability record + the run identities", () => {
    const reproducibility = evidenceOf("release-gate-nine-conditions", "gate-reproducibility");
    expect(reproducibility).toContain("replay-bit-stability:VAL-049:complete");
    expect(reproducibility).toContain("immutable-run-identity:VAL-007:complete");
  });

  test("gate 9 — the acceptance is carried by the authority chain, never self-declared", () => {
    const acceptance = evidenceOf("acceptance-chain-carried", "acceptance-chain-honesty");
    expect(acceptance).toContain("self-declared:none");
    expect(acceptance).toContain(`carried-by-pr-merge:${prMergeIds.length}`);
    expect(acceptance).toContain(`carried-by-program-state-finalize:${finalizeIds.length}`);
  });
});

describe("VAL-052 deadline-remainder honesty over the pinned operator deadline", () => {
  test("the completion timestamp, the remaining window and the incomplete work orders NAMED (every value DERIVED from the governed state)", () => {
    const deadline = packageOf("deadline-remainder-honest").deadline;
    expect(deadline.reportTimestamp).toBe(asOf);
    expect(deadline.operatorDeadline).toBe(OPERATOR_DEADLINE_UTC);
    expect(OPERATOR_DEADLINE_UTC).toBe("2026-09-15T00:00:00Z");
    expect(deadline.remainingMs).toBe(derivedRemainingMs);
    expect(deadline.remainingWindow).toBe(derivedRemainingWindow);
    expect(deadline.incomplete).toEqual(incompleteOfWorkOrder);
    const evidence = evidenceOf("deadline-remainder-honest", "deadline-remainder-honesty");
    expect(evidence).toContain(`completion-timestamp:${asOf}`);
    expect(evidence).toContain(`operator-deadline:${OPERATOR_DEADLINE_UTC}`);
    expect(evidence).toContain(`remaining-window-ms:${derivedRemainingMs}`);
    expect(evidence).toContain(`remaining-window:${derivedRemainingWindow}`);
    expect(evidence).toContain(
      `incomplete-at-report-time:${
        incompleteOfWorkOrder.map((item) => `${item.workOrderId}:${item.status}`).join(",") ||
        "none"
      }`,
    );
  });

  test("the ISO-8601 duration helper names the window mechanically", () => {
    expect(isoDurationOfMs(0)).toBe("PT0H0M0S");
    expect(isoDurationOfMs(derivedRemainingMs)).toBe(derivedRemainingWindow);
    expect(isoDurationOfMs(3_600_000)).toBe("PT1H0M0S");
  });
});

// ---------------------------------------------------------------------------
// The seven adversarial probe rows (each FAILs its NAMED criteria)
// ---------------------------------------------------------------------------

describe("VAL-052 the seven adversarial probe rows each FAIL their pinned NAMED criteria", () => {
  test("the probe rows are exactly the seven declared shapes", () => {
    const probes = FINAL_REPORT_CORPUS.filter((row) => row.probe !== undefined);
    expect(probes.map((row) => row.rowId)).toEqual(PROBE_ROW_IDS);
    expect(new Set(probes.map((row) => row.probe?.kind)).size).toBe(7);
    for (const row of probes) {
      expect(row.expected.verdict).toBe("FAILED");
      expect(row.expected.terminal).toBe("FAILED");
      expect(row.expected.failedCriteria, row.rowId).toEqual([
        ...(PROBE_FAILED_CRITERIA_OF[row.probe?.kind as ReportProbeKind] ?? []),
      ]);
      expect(row.expected.failedCriteria.length, row.rowId).toBeGreaterThan(0);
      for (const criterion of row.expected.failedCriteria) {
        expect(FINAL_REPORT_VERIFICATION_FAMILIES, row.rowId).toContain(criterion);
      }
    }
  });

  test("probe-missing-work-order FAILs inventory-completeness with the omitted work order NAMED", () => {
    const verdict = deriveReleaseGateVerdict({
      row: rowOf("probe-missing-work-order"),
      world: WORLD,
      report: packageOf("probe-missing-work-order"),
    });
    expect(verdict.verdict).toBe("FAILED");
    expect(verdict.failedCriteria).toEqual(["inventory-completeness"]);
    // The omitted inventory is one entry short of the DERIVED registered
    // count (45 at the claim head; 46 once the finalize lands).
    expect(packageOf("probe-missing-work-order").inventory).toHaveLength(registeredIds.length - 1);
    expect(evidenceOf("probe-missing-work-order", "inventory-completeness")).toContain(
      "omitted-work-order:VAL-031 (registered complete, never inventoried)",
    );
  });

  test("probe-deleted-evidence-document FAILs inventory-evidence-resolution with the unresolvable document NAMED", () => {
    const verdict = deriveReleaseGateVerdict({
      row: rowOf("probe-deleted-evidence-document"),
      world: WORLD,
      report: packageOf("probe-deleted-evidence-document"),
    });
    expect(verdict.verdict).toBe("FAILED");
    expect(verdict.failedCriteria).toEqual(["inventory-evidence-resolution"]);
    const evidence = evidenceOf("probe-deleted-evidence-document", "inventory-evidence-resolution");
    expect(evidence).toContain(`evidence-documents-resolved:${resolvedCompleteCount - 1}`);
    expect(evidence).toContain(
      "unresolved-evidence-document:VAL-033 (docs/work-items/VAL-033.md does not resolve)",
    );
  });

  test("probe-boundary-without-env-var FAILs gate-not-run-disclosure with the reasonless boundary NAMED", () => {
    const verdict = deriveReleaseGateVerdict({
      row: rowOf("probe-boundary-without-env-var"),
      world: WORLD,
      report: packageOf("probe-boundary-without-env-var"),
    });
    expect(verdict.verdict).toBe("FAILED");
    expect(verdict.failedCriteria).toEqual(["gate-not-run-disclosure"]);
    expect(evidenceOf("probe-boundary-without-env-var", "gate-not-run-disclosure")).toContain(
      "reasonless-not-run-boundary:live-journey-slice (no gating env var named)",
    );
  });

  test("probe-protocol-stripped-finding FAILs gate-findings-protocol with the stripped finding NAMED", () => {
    const verdict = deriveReleaseGateVerdict({
      row: rowOf("probe-protocol-stripped-finding"),
      world: WORLD,
      report: packageOf("probe-protocol-stripped-finding"),
    });
    expect(verdict.verdict).toBe("FAILED");
    expect(verdict.failedCriteria).toEqual(["gate-findings-protocol"]);
    const evidence = evidenceOf("probe-protocol-stripped-finding", "gate-findings-protocol");
    expect(
      evidence.some((line) =>
        line.startsWith(
          'protocol-stripped-finding:F-01-live-rail-credential-custody (the "reproduction" part',
        ),
      ),
    ).toBe(true);
    expect(evidence).toContain(
      "hidden-residual-risk:F-01-live-rail-credential-custody (no residual risk named)",
    );
  });

  test("probe-phantom-coverage FAILs inventory-completeness AND gate-category-coverage with the phantom NAMED", () => {
    const verdict = deriveReleaseGateVerdict({
      row: rowOf("probe-phantom-coverage"),
      world: WORLD,
      report: packageOf("probe-phantom-coverage"),
    });
    expect(verdict.verdict).toBe("FAILED");
    expect([...verdict.failedCriteria].sort()).toEqual([
      "gate-category-coverage",
      "inventory-completeness",
    ]);
    expect(evidenceOf("probe-phantom-coverage", "inventory-completeness")).toContain(
      "phantom-inventory-entry:VAL-027 (not a registered work order of the governed state)",
    );
    expect(evidenceOf("probe-phantom-coverage", "gate-category-coverage")).toContain(
      "phantom-coverage:ambient-voice-translation→VAL-027 (VAL-027 is not a registered work order)",
    );
  });

  test("probe-silent-omission FAILs deadline-remainder-honesty with the dropped work order NAMED (state-aware: the shape is dishonest exactly while work orders remain incomplete)", () => {
    const verdict = deriveReleaseGateVerdict({
      row: rowOf("probe-silent-omission"),
      world: WORLD,
      report: packageOf("probe-silent-omission"),
    });
    expect(packageOf("probe-silent-omission").deadline.incomplete).toEqual([]);
    if (incompleteOfWorkOrder.length > 0) {
      expect(verdict.verdict).toBe("FAILED");
      expect(verdict.failedCriteria).toEqual(["deadline-remainder-honesty"]);
      const evidence = evidenceOf("probe-silent-omission", "deadline-remainder-honesty");
      for (const item of incompleteOfWorkOrder) {
        expect(evidence).toContain(
          `silently-dropped-incomplete:${item.workOrderId} (status ${item.status} at report time, never named)`,
        );
      }
    } else {
      // The probe is VACUOUS once nothing is incomplete (post-finalize):
      // the empty incomplete list IS the honest derivation — the verdict
      // flips to COMPLETED and the corpus pin contradicts it honestly.
      expect(verdict.verdict).toBe("COMPLETED");
      expect(verdict.failedCriteria).toEqual([]);
    }
  });

  test("probe-self-declared-acceptance FAILs acceptance-chain-honesty with the forgery NAMED", () => {
    const verdict = deriveReleaseGateVerdict({
      row: rowOf("probe-self-declared-acceptance"),
      world: WORLD,
      report: packageOf("probe-self-declared-acceptance"),
    });
    expect(verdict.verdict).toBe("FAILED");
    expect(verdict.failedCriteria).toEqual(["acceptance-chain-honesty"]);
    const evidence = evidenceOf("probe-self-declared-acceptance", "acceptance-chain-honesty");
    expect(
      evidence.some((line) =>
        line.startsWith(
          "self-declared-acceptance:VAL-052 (the Architect's acceptance is carried by the authority chain",
        ),
      ),
    ).toBe(true);
    // The second offender DERIVES from the recorded status: a
    // dishonest in-flight acceptance while VAL-052 is planned; an
    // uncarried acceptance once the finalize completes it.
    if (val052Registered?.status !== "complete") {
      expect(evidence).toContain(
        `dishonest-in-flight-acceptance:VAL-052 (status ${val052Status}; the acceptance must honestly remain pending the authority chain)`,
      );
    } else {
      expect(evidence.some((line) => line.startsWith("uncarried-acceptance:VAL-052"))).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// The controlled fakes (the AC6 discrimination shapes, package-level)
// ---------------------------------------------------------------------------

describe("VAL-052 the controlled fakes each FAIL the NAMED oracle", () => {
  const HONEST = packageOf("inventory-consolidated-governed-state");

  test("a mistitled inventory entry FAILs inventory-registration NAMED", () => {
    const forged: ReportPackage = {
      ...HONEST,
      inventory: HONEST.inventory.map((entry) =>
        entry.workOrderId === "VAL-002" ? { ...entry, title: "A wrong title" } : entry,
      ),
    };
    const criteria = verifyFinalReportIntegrity({
      row: rowOf("inventory-consolidated-governed-state"),
      world: WORLD,
      report: forged,
    });
    const criterion = criteria.find(
      (candidate) => candidate.criterionId === "inventory-registration",
    );
    expect(criterion?.status).toBe("FAIL");
    expect(criterion?.evidence.join(" ")).toContain(
      'mistitled-entry:VAL-002 (inventoried "A wrong title", registered "Customer-style SDK/API integration harness")',
    );
  });

  test("a misstated completion status FAILs inventory-registration NAMED (the forged status DERIVED against the recorded one)", () => {
    // The forged status is whatever the governed state does NOT record
    // for VAL-052 (planned at the claim head; complete post-finalize —
    // the misstatement is state-agnostic).
    const forgedStatus = val052Status === "complete" ? "planned" : "complete";
    const forged: ReportPackage = {
      ...HONEST,
      inventory: HONEST.inventory.map((entry) =>
        entry.workOrderId === "VAL-052" ? { ...entry, status: forgedStatus } : entry,
      ),
    };
    const criterion = verifyFinalReportIntegrity({
      row: rowOf("inventory-consolidated-governed-state"),
      world: WORLD,
      report: forged,
    }).find((candidate) => candidate.criterionId === "inventory-registration");
    expect(criterion?.status).toBe("FAIL");
    expect(criterion?.evidence.join(" ")).toContain(
      `misstated-status:VAL-052 (inventoried ${forgedStatus}, registered ${val052Status})`,
    );
  });

  test("a digest disagreement FAILs inventory-evidence-resolution NAMED (the re-derivation catch)", () => {
    const forged: ReportPackage = {
      ...HONEST,
      inventory: HONEST.inventory.map((entry) =>
        entry.workOrderId === "VAL-049"
          ? { ...entry, evidence: { ...entry.evidence, contentDigest: "deadbeef" } }
          : entry,
      ),
    };
    const criterion = verifyFinalReportIntegrity({
      row: rowOf("inventory-consolidated-governed-state"),
      world: WORLD,
      report: forged,
    }).find((candidate) => candidate.criterionId === "inventory-evidence-resolution");
    expect(criterion?.status).toBe("FAIL");
    expect(criterion?.evidence.join(" ")).toContain(
      "digest-disagreement:VAL-049 (inventoried deadbeef, re-derived",
    );
  });

  test("an unbounded threshold claim FAILs gate-thresholds-bounded NAMED", () => {
    const forged: ReportPackage = {
      ...HONEST,
      thresholds: HONEST.thresholds.map((claim) =>
        claim.workOrderId === "VAL-024" ? { ...claim, bound: "" } : claim,
      ),
    };
    const criterion = verifyFinalReportIntegrity({
      row: rowOf("inventory-consolidated-governed-state"),
      world: WORLD,
      report: forged,
    }).find((candidate) => candidate.criterionId === "gate-thresholds-bounded");
    expect(criterion?.status).toBe("FAIL");
    expect(criterion?.evidence).toContain("unbounded-threshold-claim:VAL-024 (no bound named)");
  });

  test("an unpaired economic comparison FAILs gate-economic-fairness NAMED", () => {
    const forged: ReportPackage = {
      ...HONEST,
      economicComparisons: HONEST.economicComparisons.map((claim) =>
        claim.workOrderId === "VAL-048" ? { ...claim, baselineWorkOrderIds: [] } : claim,
      ),
    };
    const criterion = verifyFinalReportIntegrity({
      row: rowOf("inventory-consolidated-governed-state"),
      world: WORLD,
      report: forged,
    }).find((candidate) => candidate.criterionId === "gate-economic-fairness");
    expect(criterion?.status).toBe("FAIL");
    expect(criterion?.evidence).toContain("unpaired-comparison:VAL-048 (no strong baseline cited)");
  });

  test("a deadline mismatch FAILs deadline-remainder-honesty NAMED", () => {
    const forged: ReportPackage = {
      ...HONEST,
      deadline: { ...HONEST.deadline, operatorDeadline: "2026-09-16T00:00:00Z" },
    };
    const criterion = verifyFinalReportIntegrity({
      row: rowOf("inventory-consolidated-governed-state"),
      world: WORLD,
      report: forged,
    }).find((candidate) => candidate.criterionId === "deadline-remainder-honesty");
    expect(criterion?.status).toBe("FAIL");
    expect(criterion?.evidence.join(" ")).toContain(
      "deadline-mismatch (cited 2026-09-16T00:00:00Z, pinned 2026-09-15T00:00:00Z)",
    );
  });

  test("a wrong-location evidence citation FAILs inventory-evidence-resolution NAMED", () => {
    const forged: ReportPackage = {
      ...HONEST,
      inventory: HONEST.inventory.map((entry) =>
        entry.workOrderId === "VAL-010"
          ? { ...entry, evidence: { ...entry.evidence, registeredPath: "docs/wrong-place.md" } }
          : entry,
      ),
    };
    const criterion = verifyFinalReportIntegrity({
      row: rowOf("inventory-consolidated-governed-state"),
      world: WORLD,
      report: forged,
    }).find((candidate) => candidate.criterionId === "inventory-evidence-resolution");
    expect(criterion?.status).toBe("FAIL");
    expect(criterion?.evidence.join(" ")).toContain(
      "wrong-evidence-location:VAL-010 (cited docs/wrong-place.md, registered docs/work-items/VAL-010.md)",
    );
  });

  test("a fake report world whose evidence document is absent FAILs the resolution oracle NAMED", () => {
    const fakeWorld = createFakeReportWorld({
      programState: {
        schemaVersion: 1,
        program: "zeck-validation",
        status: "active",
        asOf: "2026-09-14T21:10:45Z",
        workOrders: {
          "VAL-001": { status: "complete", title: "Validation lab bootstrap and governance" },
          "VAL-002": { status: "complete", title: "Customer-style SDK/API integration harness" },
        },
      },
      evidenceDocuments: {
        "benchmarks/validation/evidence/VAL-001.md": "the bootstrap evidence document",
        // VAL-002's work-item document deliberately absent (the deleted-evidence fake).
      },
    });
    const row = rowOf("inventory-consolidated-governed-state");
    const package_ = reportPackageFor(row, fakeWorld);
    expect(package_.inventory).toHaveLength(2);
    expect(package_.inventory[1]?.evidence.resolved).toBe(false);
    const criterion = verifyFinalReportIntegrity({ row, world: fakeWorld, report: package_ }).find(
      (candidate) => candidate.criterionId === "inventory-evidence-resolution",
    );
    expect(criterion?.status).toBe("FAIL");
    expect(criterion?.evidence.join(" ")).toContain(
      "unresolved-evidence-document:VAL-002 (docs/work-items/VAL-002.md does not resolve)",
    );
  });
});

// ---------------------------------------------------------------------------
// The digest discipline + replay determinism + the vocabulary
// ---------------------------------------------------------------------------

describe("VAL-052 digest discipline, replay determinism and the honest vocabulary", () => {
  test("the corpus input digest is stable and re-composes over the pinned vocabulary", () => {
    expect(pinnedReportInputDigest()).toMatch(/^[0-9a-f]{8}$/);
    expect(pinnedReportInputDigest()).toBe(pinnedReportInputDigest());
    expect(FINAL_REPORT_CORPUS_VERSION).toBe("val-052-final-report-v1");
    expect(FINAL_REPORT_ROW_IDS).toHaveLength(13);
    expect(new Set(FINAL_REPORT_ROW_IDS).size).toBe(FINAL_REPORT_ROW_IDS.length);
  });

  test("the report derivation is replay-deterministic (bit-stable re-derivation)", () => {
    const first = packageOf("inventory-consolidated-governed-state");
    const second = reportPackageFor(rowOf("inventory-consolidated-governed-state"), WORLD);
    expect(second.packageDigest).toBe(first.packageDigest);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    const verdictA = deriveReleaseGateVerdict({
      row: rowOf("inventory-consolidated-governed-state"),
      world: WORLD,
      report: first,
    });
    const verdictB = deriveReleaseGateVerdict({
      row: rowOf("inventory-consolidated-governed-state"),
      world: WORLD,
      report: second,
    });
    expect(verdictB).toEqual(verdictA);
    // A differently-derived package's digest differs (the digest discriminates).
    expect(packageOf("probe-missing-work-order").packageDigest).not.toBe(first.packageDigest);
    expect(packageOf("probe-silent-omission").packageDigest).not.toBe(first.packageDigest);
  });

  test("the verification family order is the declared thirteen-family order", () => {
    expect(verificationFamilyOrder()).toEqual([...FINAL_REPORT_VERIFICATION_FAMILIES]);
    expect(FINAL_REPORT_VERIFICATION_FAMILIES).toHaveLength(13);
  });

  test("the live gating is honest (exactly ONE live row, NOT RUN without the credential)", () => {
    const liveRows = FINAL_REPORT_CORPUS.filter((row) => row.liveGate !== undefined);
    expect(liveRows.map((row) => row.rowId)).toEqual(["live-gate-confirmation-slice"]);
    const liveRow = liveRows[0];
    if (liveRow === undefined) {
      throw new Error("the live slice is empty");
    }
    expect(liveRow.needsDispatch).toBe(true);
    expect(liveRow.liveGate?.envVars).toEqual(["OPENROUTER_API_KEY"]);
    expect(liveRow.expected.verdict).toBe("NOT-RUN");
    expect(liveGateOpen(liveRow, {})).toBe(false);
    expect(liveGateOpen(liveRow, { OPENROUTER_API_KEY: "" })).toBe(false);
    expect(liveGateOpen(liveRow, { OPENROUTER_API_KEY: "operator-authorized" })).toBe(true);
    for (const row of FINAL_REPORT_CORPUS) {
      if (row.liveGate === undefined) {
        expect(row.needsDispatch, row.rowId).toBe(false);
      }
    }
  });

  test("the task bodies carry references only (never evidence bodies, never secrets)", () => {
    for (const row of FINAL_REPORT_CORPUS) {
      const body = JSON.stringify(reportTaskBodyFor({ row }));
      expect(body, row.rowId).not.toMatch(/microUsd|amount|token[s]?[,:"]/i);
      expect(body, row.rowId).not.toMatch(/sk-[A-Za-z0-9]{20,}/);
      expect(body, row.rowId).toContain(row.rowId);
      expect(body, row.rowId).toContain(OPERATOR_DEADLINE_UTC);
    }
  });

  test("the package digests are payload-free FNV-1a forms over the evidence documents", () => {
    for (const entry of packageOf("inventory-consolidated-governed-state").inventory) {
      if (entry.status === "complete") {
        expect(entry.evidence.contentDigest).toMatch(/^[0-9a-f]{8}$/);
        expect(entry.evidence.contentDigest).toBe(
          economicDigestOf(
            readFileSync(join(process.cwd(), entry.evidence.registeredPath), "utf8"),
          ),
        );
      }
    }
  });
});
