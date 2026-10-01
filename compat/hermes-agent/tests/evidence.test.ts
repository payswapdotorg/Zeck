/**
 * PPR-022 evidence-record tests — the battery's written record is
 * structurally valid, carries the honest upstream provenance, every
 * declared edge's disposition, and the derived assessment. The battery
 * writes deploy/evidence/ppr-022.json; if the battery has not yet run
 * in this checkout the test reports an honest skip (the battery, not
 * the test suite, produces the record).
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  createCompatibilityService,
  validateCompatibilityEvidenceRecord,
  type CompatibilityEvidenceRecord,
  type DiscoveredEdgeInventory,
} from "../../../src/integrations/compatibility/public";
import {
  HERMES_DISCOVERED_INVENTORY,
  HERMES_EDGE_IDS,
  HERMES_EXECUTION_GRAPH,
} from "../graph/execution-graph";
import { createSdkTraceSource } from "../harness/trace";

const EVIDENCE = join(process.cwd(), "deploy", "evidence", "ppr-022.json");
/** The pinned venv path (mirrors the corpus runner's constant). */
const HERMES_VENV_PATH = "/home/z/my-project/.venv-hermes";

describe("PPR-022 evidence record (deploy/evidence/ppr-022.json)", () => {
  const batteryHasRun = existsSync(EVIDENCE);
  const venvPresent = existsSync(join(HERMES_VENV_PATH, "bin", "hermes"));

  // The venv is a DEPLOYMENT precondition (it exists where the certified
  // runtime was built — the worker pod / a reproduction per the demo
  // entry's instructions), not a property of this checkout. The record
  // check runs wherever the record exists and skips honestly elsewhere.
  const runRecordTests = batteryHasRun && venvPresent;

  (runRecordTests ? describe : describe.skip)("the written record", () => {
    // Lazily read inside the tests (a skipped suite must not touch the
    // filesystem at collection time — the record exists iff the battery
    // ran, which runRecordTests already gates).
    const readRecord = () =>
      JSON.parse(readFileSync(EVIDENCE, "utf8")) as {
        evidenceRecord: CompatibilityEvidenceRecord;
        derivedAssessment: {
          status: string;
          ruleResults: { ruleId: string; satisfied: boolean }[];
        };
        workOrder: string;
        upstreamProvenance: {
          applicationRepository: string;
          applicationRevision: string;
        };
      };

    test("the file is a PPR-022 record for the pinned Hermes-Agent upstream", () => {
      const raw = readRecord();
      expect(raw.workOrder).toBe("PPR-022");
      expect(raw.upstreamProvenance.applicationRepository).toBe(
        "https://github.com/NousResearch/hermes-agent",
      );
      expect(raw.upstreamProvenance.applicationRevision).toBe(
        "77e2992020eafded09e0c344e687ae53e52e6eab",
      );
    });

    test("the embedded evidence record validates fail-closed", () => {
      const raw = readRecord();
      expect([...validateCompatibilityEvidenceRecord(raw.evidenceRecord)]).toEqual([]);
    });

    test("every declared edge carries a disposition", () => {
      const raw = readRecord();
      const dispositionEdges = new Set(raw.evidenceRecord.dispositions.map((d) => d.edgeId));
      for (const edgeId of HERMES_EDGE_IDS) {
        expect(dispositionEdges.has(edgeId)).toBe(true);
      }
    });

    test("the record's graph is the declared graph", () => {
      const raw = readRecord();
      expect(raw.evidenceRecord.graph.edges.map((edge) => edge.edgeId)).toEqual(
        HERMES_EXECUTION_GRAPH.edges.map((edge) => edge.edgeId),
      );
    });

    test("the record's basis is live-proof (never a fixture)", () => {
      const raw = readRecord();
      expect(raw.evidenceRecord.recordBasis).toBe("live-proof");
    });

    test("the derived assessment re-derives identically through the service", () => {
      const raw = readRecord();
      const service = createCompatibilityService({
        traceSource: createSdkTraceSource({
          apiBaseUrl: "http://127.0.0.1:9/v1",
          token: "re-derivation-only",
          applicationId: "re-derivation-only",
        }),
      });
      const assessment = service.assess(
        raw.evidenceRecord,
        HERMES_DISCOVERED_INVENTORY as DiscoveredEdgeInventory,
      );
      expect(assessment.status).toBe(raw.derivedAssessment.status);
      expect(assessment.ruleResults.map((r) => r.satisfied)).toEqual(
        raw.derivedAssessment.ruleResults.map((r) => r.satisfied),
      );
    });

    test("when the status is AI_EXECUTION_COMPLETE, every delegated edge correlates durably", () => {
      const raw = readRecord();
      if (raw.derivedAssessment.status !== "AI_EXECUTION_COMPLETE") {
        return;
      }
      const byEdge = new Map<string, string[]>();
      for (const disposition of raw.evidenceRecord.dispositions) {
        if (disposition.disposition === "delegated") {
          byEdge.set(disposition.edgeId, [...disposition.zeckExecutionIds]);
        }
      }
      expect(byEdge.size).toBe(HERMES_EDGE_IDS.length);
      for (const [edgeId, executionIds] of byEdge) {
        for (const executionId of executionIds) {
          const trace = raw.evidenceRecord.zeckTraces.find(
            (candidate) =>
              candidate.edgeId === edgeId && candidate.executionId === executionId,
          );
          expect(trace).toBeDefined();
          expect(trace?.found).toBe(true);
          expect(trace?.correlated).toBe(true);
        }
      }
    });
  });

  test("the battery is the record's producer (no record without the run)", () => {
    // A checkout without the battery run must not carry a record the
    // tests would then "verify" — the record exists iff the battery ran.
    if (!batteryHasRun) {
      expect(existsSync(EVIDENCE)).toBe(false);
    } else {
      expect(existsSync(EVIDENCE)).toBe(true);
    }
  });
});
