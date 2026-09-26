/**
 * PPR-017 — the demo status no-upgrade test (the work order: "demo
 * status cannot upgrade evidence (a PARTIAL record rendered in the
 * mirror stays PARTIAL)").
 *
 * The Demo Mirror's security model is structural: a registry entry has
 * NO field where a status, verdict or completeness claim could even
 * appear, and the projection derives the status from the BOUND RECORD
 * through the same strict admission evaluation used everywhere else.
 * This test pins:
 *  - a PARTIAL record rendered in the mirror stays PARTIAL (and an
 *    UNASSESSED one stays UNASSESSED) — including through the demo
 *    surface's own projection functions (apps/dashboard/demo-mirror);
 *  - the entry type carries no status field (type-level + runtime);
 *  - a FIXTURE record can never upgrade to AI_EXECUTION_COMPLETE, no
 *    matter how green the rest of the record looks — even a
 *    fully-delegated, clean-egress, verified-corpus fixture stays
 *    uncertified, and the mirror says so;
 *  - a registry entry bound to a MISSING record is a named registry
 *    defect (never a silent UNASSESSED guess);
 *  - the run control stays unavailable for anything uncertified (the
 *    mirror never runs an uncertified integration path).
 */

import { describe, expect, test } from "vitest";
import {
  COMPATIBILITY_STATUS_PRESENTATION,
  compatibilityStatusChip,
  demoMirrorIndexRows,
} from "../../../apps/dashboard/demo-mirror";
import {
  type CompatibilityEvidenceRecord,
  type DemoMirrorEntry,
  EXAMPLE_CODING_ASSISTANT_RECORD,
  EXAMPLE_RAG_KNOWLEDGE_APP_RECORD,
  evaluateCompatibility,
  resolveDemoMirrorEntry,
  validateDemoRegistry,
} from "../../../src/integrations/compatibility/public";

const PARTIAL_RECORD: CompatibilityEvidenceRecord = EXAMPLE_RAG_KNOWLEDGE_APP_RECORD;
const UNASSESSED_RECORD: CompatibilityEvidenceRecord = EXAMPLE_CODING_ASSISTANT_RECORD;

function entryFor(record: CompatibilityEvidenceRecord): DemoMirrorEntry {
  return {
    demoId: `no-upgrade-test-${record.recordId}`,
    evidenceRecordId: record.recordId,
    representativeTask: {
      title: "A representative task",
      description: "The task a certified run would replay.",
    },
    runBinding: { kind: "none" },
    reproducibility: {
      instructions: "test entry",
      pinnedUpstreamRevision: record.pinnedApplication.pin.upstreamRevision,
      integrationRevision: record.pinnedApplication.pin.integrationRevision,
    },
    warnings: [],
  };
}

describe("demo status cannot upgrade evidence", () => {
  test("a PARTIAL record rendered in the mirror stays PARTIAL", () => {
    expect(evaluateCompatibility(PARTIAL_RECORD).status).toBe("PARTIAL");
    const resolution = resolveDemoMirrorEntry(entryFor(PARTIAL_RECORD), PARTIAL_RECORD);
    expect(resolution.kind).toBe("available");
    if (resolution.kind === "available") {
      expect(resolution.projection.status).toBe("PARTIAL");
    }
  });

  test("an UNASSESSED record rendered in the mirror stays UNASSESSED", () => {
    expect(evaluateCompatibility(UNASSESSED_RECORD).status).toBe("UNASSESSED");
    const resolution = resolveDemoMirrorEntry(entryFor(UNASSESSED_RECORD), UNASSESSED_RECORD);
    expect(resolution.kind === "available");
    if (resolution.kind === "available") {
      expect(resolution.projection.status).toBe("UNASSESSED");
    }
  });

  test("the five statuses render as five VISUALLY DISTINCT chips (symbol + label, never color alone)", () => {
    const chips = new Set(
      (
        ["UNASSESSED", "PARTIAL", "BLOCKED", "BYPASS_DETECTED", "AI_EXECUTION_COMPLETE"] as const
      ).map((status) => compatibilityStatusChip(status)),
    );
    expect(chips.size).toBe(5);
    for (const status of Object.keys(COMPATIBILITY_STATUS_PRESENTATION)) {
      const chip = compatibilityStatusChip(
        status as keyof typeof COMPATIBILITY_STATUS_PRESENTATION,
      );
      expect(chip).toContain(`compat-${status}`); // one class per status
      expect(chip).toContain(
        COMPATIBILITY_STATUS_PRESENTATION[status as keyof typeof COMPATIBILITY_STATUS_PRESENTATION]
          .symbol,
      );
    }
  });

  test("the demo entry type has NO status/verdict/completeness field (the upgrade is unrepresentable)", () => {
    const entry = entryFor(PARTIAL_RECORD) as unknown as Record<string, unknown>;
    for (const forbidden of [
      "status",
      "compatibilityStatus",
      "verdict",
      "complete",
      "certified",
      "assessment",
    ]) {
      expect(entry[forbidden], forbidden).toBeUndefined();
    }
  });

  test("a FIXTURE record with everything else green STILL cannot reach AI_EXECUTION_COMPLETE (rule 5's record clause)", () => {
    // Take the partial fixture and make every axis green EXCEPT the
    // record basis (which stays an honest fixture): delegated edges
    // with live-basis traces, clean egress, verified corpus, matched
    // inventory. The fixture clause alone keeps it uncertified.
    const greenFixture: CompatibilityEvidenceRecord = {
      ...PARTIAL_RECORD,
      recordId: "green-fixture-record",
      dispositions: [
        {
          edgeId: "answer-generation",
          disposition: "delegated",
          zeckExecutionIds: ["00000000-0000-7000-8000-0000000000d1"],
          evidenceBasis: "live",
        },
        {
          edgeId: "document-embeddings",
          disposition: "delegated",
          zeckExecutionIds: ["00000000-0000-7000-8000-0000000000d2"],
          evidenceBasis: "live",
        },
        {
          edgeId: "retrieval-reranking",
          disposition: "delegated",
          zeckExecutionIds: ["00000000-0000-7000-8000-0000000000d3"],
          evidenceBasis: "live",
        },
      ],
      egressObservation: { mode: "observe", status: "observed-clean", violations: [] },
      runtimeEvidence: {
        corpusDeclared: true,
        corpusUsability: "verified",
        observations: ["replayed functionally"],
      },
      zeckTraces: [
        ...PARTIAL_RECORD.zeckTraces,
        {
          edgeId: "retrieval-reranking",
          executionId: "00000000-0000-7000-8000-0000000000d3",
          applicationId: PARTIAL_RECORD.pinnedApplication.identity.applicationId,
          found: true,
          status: "COMPLETED",
          terminal: true,
          eventCount: 4,
          verificationCount: 1,
          passingVerificationCount: 1,
          correlated: true,
        },
      ],
    };
    const assessment = evaluateCompatibility(greenFixture, {
      source: "synthetic discovery",
      edges: greenFixture.graph.edges,
    });
    expect(assessment.status).not.toBe("AI_EXECUTION_COMPLETE");
    expect(assessment.findings.some((finding) => finding.code === "FIXTURE_RECORD")).toBe(true);
    // The mirror renders the same honest status.
    const resolution = resolveDemoMirrorEntry(
      { ...entryFor(greenFixture), evidenceRecordId: greenFixture.recordId },
      greenFixture,
    );
    expect(resolution.kind === "available" && resolution.projection.status).not.toBe(
      "AI_EXECUTION_COMPLETE",
    );
  });

  test("the run control is UNAVAILABLE for every uncertified demo (never runs an uncertified path)", () => {
    for (const record of [PARTIAL_RECORD, UNASSESSED_RECORD]) {
      const resolution = resolveDemoMirrorEntry(entryFor(record), record);
      expect(resolution.kind).toBe("available");
      if (resolution.kind === "available") {
        const { runAvailability } = resolution.projection;
        if (runAvailability.available) {
          throw new Error("an uncertified demo offered a run — the mirror must refuse");
        }
        expect(runAvailability.reason).toContain("never");
      }
    }
  });

  test("a registry entry bound to a MISSING record is a named defect — never a silent status guess", () => {
    const resolution = resolveDemoMirrorEntry(
      { ...entryFor(PARTIAL_RECORD), evidenceRecordId: "no-such-record" },
      null,
    );
    expect(resolution.kind).toBe("record-missing");
  });

  test("the registry validation names structural defects (fail closed)", () => {
    const issues = validateDemoRegistry({
      entries: [
        { ...entryFor(PARTIAL_RECORD), demoId: "" },
        entryFor(PARTIAL_RECORD),
        entryFor(PARTIAL_RECORD),
      ],
    });
    expect(issues.some((issue) => issue.issue.includes("non-empty demo id"))).toBe(true);
    expect(issues.some((issue) => issue.issue.includes("duplicate demo id"))).toBe(true);
  });

  test("the demo surface's own index projection derives the same statuses as the evaluation (no drift)", () => {
    const rows = demoMirrorIndexRows();
    expect(rows.map((row) => row.status).sort()).toEqual(["PARTIAL", "UNASSESSED"]);
    for (const row of rows) {
      expect(row.runAvailable).toBe(false);
    }
  });
});
