/**
 * PPR-017 — the strict status admission machine tests (the work
 * order's "status transitions (demonstrated in tests)" evidence).
 *
 * Pins the ACR-006 §4 transition semantics over evidence records:
 *  - the FIVE admission rules each discriminate (each rule alone, when
 *    unmet, forbids AI_EXECUTION_COMPLETE — a weakened rule would be
 *    caught here);
 *  - the precedence: a detected bypass overrides everything; the five
 *    rules + no hard coverage defect produce AI_EXECUTION_COMPLETE;
 *    BLOCKED vs PARTIAL vs UNASSESSED follow the documented progress
 *    and external-ownership logic;
 *  - the fixture rule: a fixture record can NEVER certify, regardless
 *    of its contents (rule 5's record-level clause);
 *  - every finding is named and machine-readable (never silent).
 *
 * The COMPLETE case uses a SYNTHETIC live-proof-shaped record (a unit
 * proof of the admission FUNCTION, not a certification of any real
 * application — no application proof exists at PPR-017).
 */

import { describe, expect, test } from "vitest";
import {
  type CompatibilityEvidenceRecord,
  type EdgeDispositionEntry,
  type ExecutionGraphEdge,
  evaluateCompatibility,
} from "../../../src/integrations/compatibility/public";

const APP_ID = "00000000-0000-7000-8000-0000000000c1";
const EXECUTION_ID = "00000000-0000-7000-8000-0000000000d1";
const EXECUTION_ID_2 = "00000000-0000-7000-8000-0000000000d2";

const MAIN_EDGE: ExecutionGraphEdge = {
  edgeId: "main-completion",
  component: "chat loop",
  surface: "text-generation",
  transport: "provider client",
  externalExecution: "provider model",
  materiality: "the main model call",
};

const EMBEDDINGS_EDGE: ExecutionGraphEdge = {
  edgeId: "repo-embeddings",
  component: "indexer",
  surface: "embeddings",
  transport: "embedding client",
  externalExecution: "provider embedding service",
  materiality: "repository embeddings",
};

const DELEGATED_MAIN: EdgeDispositionEntry = {
  edgeId: "main-completion",
  disposition: "delegated",
  zeckExecutionIds: [EXECUTION_ID],
  evidenceBasis: "live",
};

const DELEGATED_EMBEDDINGS: EdgeDispositionEntry = {
  edgeId: "repo-embeddings",
  disposition: "delegated",
  zeckExecutionIds: [EXECUTION_ID_2],
  evidenceBasis: "live",
};

const CORRELATED_TRACE_MAIN: CompatibilityEvidenceRecord["zeckTraces"][number] = {
  edgeId: "main-completion",
  executionId: EXECUTION_ID,
  applicationId: APP_ID,
  found: true,
  status: "COMPLETED",
  terminal: true,
  eventCount: 6,
  verificationCount: 1,
  passingVerificationCount: 1,
  correlated: true,
};

const CORRELATED_TRACE_EMBEDDINGS: CompatibilityEvidenceRecord["zeckTraces"][number] = {
  edgeId: "repo-embeddings",
  executionId: EXECUTION_ID_2,
  applicationId: APP_ID,
  found: true,
  status: "COMPLETED",
  terminal: true,
  eventCount: 5,
  verificationCount: 1,
  passingVerificationCount: 1,
  correlated: true,
};

type RecordPatch = {
  [K in keyof CompatibilityEvidenceRecord]?: CompatibilityEvidenceRecord[K];
};

function record(patch: RecordPatch = {}): CompatibilityEvidenceRecord {
  return {
    recordId: "admission-test-record",
    recordBasis: "live-proof",
    pinnedApplication: {
      identity: {
        name: "Synthetic admission test application",
        repository: "https://example.invalid/synthetic",
        applicationId: APP_ID,
      },
      pin: { upstreamRevision: "a".repeat(40), integrationRevision: "b".repeat(40) },
    },
    graph: { edges: [MAIN_EDGE, EMBEDDINGS_EDGE] },
    dispositions: [],
    egressObservation: { mode: "observe", status: "not-run", violations: [] },
    providerCredentials: [],
    runtimeEvidence: { corpusDeclared: false, corpusUsability: "not-run", observations: [] },
    comparison: [],
    zeckTraces: [],
    limitations: [],
    notRunCauses: [],
    recordedAt: "2026-09-26T00:00:00Z",
    ...patch,
  };
}

/** The satisfied-on-every-axis record (all five rules pass, no coverage defect). */
function satisfyingRecord(patch: RecordPatch = {}): CompatibilityEvidenceRecord {
  return record({
    dispositions: [DELEGATED_MAIN, DELEGATED_EMBEDDINGS],
    egressObservation: { mode: "observe", status: "observed-clean", violations: [] },
    runtimeEvidence: {
      corpusDeclared: true,
      corpusUsability: "verified",
      observations: ["the representative corpus replayed functionally"],
    },
    zeckTraces: [CORRELATED_TRACE_MAIN, CORRELATED_TRACE_EMBEDDINGS],
    ...patch,
  });
}

const MATCHING_INVENTORY = {
  source: "synthetic static discovery",
  edges: [MAIN_EDGE, EMBEDDINGS_EDGE],
};

describe("the strict admission machine: each rule discriminates", () => {
  test("RULE 1: an undelegated edge alone forbids AI_EXECUTION_COMPLETE", () => {
    const assessment = evaluateCompatibility(
      satisfyingRecord({
        dispositions: [
          DELEGATED_MAIN,
          {
            edgeId: "repo-embeddings",
            disposition: "not-run",
            cause: "the embedding edge never ran through Zeck",
            owner: "lead",
          },
        ],
      }),
      MATCHING_INVENTORY,
    );
    expect(assessment.status).not.toBe("AI_EXECUTION_COMPLETE");
    expect(
      assessment.ruleResults.find((rule) => rule.ruleId === "EVERY_DECLARED_EDGE_DELEGATED")
        ?.satisfied,
    ).toBe(false);
  });

  test("RULE 1: a direct-provider edge disposition is a named BYPASS finding", () => {
    const assessment = evaluateCompatibility(
      satisfyingRecord({
        dispositions: [
          DELEGATED_MAIN,
          {
            edgeId: "repo-embeddings",
            disposition: "direct-provider",
            observationBasis:
              "runtime egress observation caught the indexer calling the provider embedding service directly",
          },
        ],
      }),
      MATCHING_INVENTORY,
    );
    expect(assessment.status).toBe("BYPASS_DETECTED");
    expect(
      assessment.findings.some((finding) => finding.code === "BYPASS_DIRECT_PROVIDER_EDGE"),
    ).toBe(true);
  });

  test("RULE 2: egress not run alone forbids AI_EXECUTION_COMPLETE (absence of egress is unproven)", () => {
    const assessment = evaluateCompatibility(
      satisfyingRecord({
        egressObservation: { mode: "observe", status: "not-run", violations: [] },
      }),
      MATCHING_INVENTORY,
    );
    expect(assessment.status).not.toBe("AI_EXECUTION_COMPLETE");
    expect(assessment.findings.some((finding) => finding.code === "EGRESS_NOT_RUN")).toBe(true);
  });

  test("RULE 2: observed-passing violations are a detected bypass; provably-blocked deny violations are not", () => {
    const observedPassing = satisfyingRecord({
      egressObservation: {
        mode: "observe",
        status: "violations-detected",
        violations: [
          {
            host: "provider.example",
            url: "https://provider.example/v1",
            rule: "deny provider hosts",
            at: "2026-09-26T00:00:00Z",
            blocked: false,
          },
        ],
      },
    });
    expect(evaluateCompatibility(observedPassing, MATCHING_INVENTORY).status).toBe(
      "BYPASS_DETECTED",
    );

    const provablyBlocked = satisfyingRecord({
      egressObservation: {
        mode: "deny",
        status: "provably-blocked",
        violations: [
          {
            host: "provider.example",
            url: "https://provider.example/v1",
            rule: "deny provider hosts",
            at: "2026-09-26T00:00:00Z",
            blocked: true,
          },
        ],
      },
    });
    expect(evaluateCompatibility(provablyBlocked, MATCHING_INVENTORY).status).toBe(
      "AI_EXECUTION_COMPLETE",
    );
  });

  test("RULE 2: a claimed provably-blocked status without blocked violations is an inconsistency finding, never COMPLETE", () => {
    const assessment = evaluateCompatibility(
      satisfyingRecord({
        egressObservation: {
          mode: "deny",
          status: "provably-blocked",
          violations: [
            {
              host: "provider.example",
              url: "https://provider.example/v1",
              rule: "deny",
              at: "2026-09-26T00:00:00Z",
              blocked: false,
            },
          ],
        },
      }),
      MATCHING_INVENTORY,
    );
    expect(assessment.status).not.toBe("AI_EXECUTION_COMPLETE");
    expect(
      assessment.findings.some((finding) => finding.code === "EGRESS_STATUS_INCONSISTENT"),
    ).toBe(true);
  });

  test("RULE 3: an undeclared or unusable corpus alone forbids AI_EXECUTION_COMPLETE", () => {
    for (const corpusUsability of ["not-verified", "not-run"] as const) {
      const assessment = evaluateCompatibility(
        satisfyingRecord({
          runtimeEvidence: { corpusDeclared: true, corpusUsability, observations: [] },
        }),
        MATCHING_INVENTORY,
      );
      expect(assessment.status).not.toBe("AI_EXECUTION_COMPLETE");
    }
    const undeclared = evaluateCompatibility(
      satisfyingRecord({
        runtimeEvidence: { corpusDeclared: false, corpusUsability: "not-run", observations: [] },
      }),
      MATCHING_INVENTORY,
    );
    expect(undeclared.findings.some((finding) => finding.code === "CORPUS_NOT_DECLARED")).toBe(
      true,
    );
  });

  test("RULE 4: a delegated edge without a correlated trace forbids AI_EXECUTION_COMPLETE", () => {
    const missing = evaluateCompatibility(
      satisfyingRecord({ zeckTraces: [CORRELATED_TRACE_MAIN] }),
      MATCHING_INVENTORY,
    );
    expect(missing.status).not.toBe("AI_EXECUTION_COMPLETE");
    expect(missing.findings.some((finding) => finding.code === "ZECK_TRACE_MISSING")).toBe(true);

    const uncorrelated = evaluateCompatibility(
      satisfyingRecord({
        zeckTraces: [
          CORRELATED_TRACE_MAIN,
          { ...CORRELATED_TRACE_EMBEDDINGS, verificationCount: 0, correlated: false },
        ],
      }),
      MATCHING_INVENTORY,
    );
    expect(uncorrelated.status).not.toBe("AI_EXECUTION_COMPLETE");
    expect(
      uncorrelated.findings.some((finding) => finding.code === "ZECK_TRACE_NOT_CORRELATED"),
    ).toBe(true);
  });

  test("RULE 4: a delegated edge whose execution never RESOLVED (no terminal COMPLETED with a PASS) forbids COMPLETE", () => {
    const assessment = evaluateCompatibility(
      satisfyingRecord({
        zeckTraces: [
          CORRELATED_TRACE_MAIN,
          { ...CORRELATED_TRACE_EMBEDDINGS, status: "FAILED", passingVerificationCount: 0 },
        ],
      }),
      MATCHING_INVENTORY,
    );
    expect(assessment.status).not.toBe("AI_EXECUTION_COMPLETE");
    expect(assessment.findings.some((finding) => finding.code === "ZECK_TRACE_NOT_RESOLVED")).toBe(
      true,
    );
  });

  test("RULE 5: a fixture-basis delegated edge is never an external PASS — even with everything else satisfied", () => {
    const assessment = evaluateCompatibility(
      satisfyingRecord({
        dispositions: [DELEGATED_MAIN, { ...DELEGATED_EMBEDDINGS, evidenceBasis: "fixture" }],
      }),
      MATCHING_INVENTORY,
    );
    expect(assessment.status).not.toBe("AI_EXECUTION_COMPLETE");
    expect(assessment.findings.some((finding) => finding.code === "FIXTURE_EVIDENCE_BASIS")).toBe(
      true,
    );
  });

  test("RULE 5 (record level): a FIXTURE record can NEVER certify, regardless of its contents", () => {
    const assessment = evaluateCompatibility(
      satisfyingRecord({ recordBasis: "fixture" }),
      MATCHING_INVENTORY,
    );
    expect(assessment.status).not.toBe("AI_EXECUTION_COMPLETE");
    expect(assessment.findings.some((finding) => finding.code === "FIXTURE_RECORD")).toBe(true);
  });
});

describe("the strict admission machine: statuses and precedence", () => {
  test("all five rules + a matched inventory derive AI_EXECUTION_COMPLETE (the synthetic positive case)", () => {
    const assessment = evaluateCompatibility(satisfyingRecord(), MATCHING_INVENTORY);
    expect(assessment.status).toBe("AI_EXECUTION_COMPLETE");
    expect(assessment.ruleResults.every((rule) => rule.satisfied)).toBe(true);
    expect(assessment.findings).toEqual([]);
  });

  test("a missing disposition is a named coverage defect (EDGE_MISSING_DISPOSITION), never silently out of scope", () => {
    const assessment = evaluateCompatibility(
      satisfyingRecord({ dispositions: [DELEGATED_MAIN] }),
      MATCHING_INVENTORY,
    );
    expect(assessment.status).not.toBe("AI_EXECUTION_COMPLETE");
    expect(assessment.findings.some((finding) => finding.code === "EDGE_MISSING_DISPOSITION")).toBe(
      true,
    );
  });

  test("UNASSESSED: no proof progress at all", () => {
    const assessment = evaluateCompatibility(
      record({
        dispositions: [
          {
            edgeId: "main-completion",
            disposition: "not-run",
            cause: "proof not started",
            owner: "lead",
          },
          {
            edgeId: "repo-embeddings",
            disposition: "not-run",
            cause: "proof not started",
            owner: "lead",
          },
        ],
      }),
      null,
    );
    expect(assessment.status).toBe("UNASSESSED");
  });

  test("BLOCKED: no progress AND every undelegated edge externally owned (provider/operator)", () => {
    const assessment = evaluateCompatibility(
      record({
        dispositions: [
          {
            edgeId: "main-completion",
            disposition: "not-run",
            cause: "the provider credential family is unavailable in this environment",
            owner: "provider",
          },
          {
            edgeId: "repo-embeddings",
            disposition: "not-run",
            cause: "the embedding rail is not operator-authorized",
            owner: "operator",
          },
        ],
      }),
      null,
    );
    expect(assessment.status).toBe("BLOCKED");
  });

  test("PARTIAL: proof progress exists but admission is unmet", () => {
    const assessment = evaluateCompatibility(
      record({
        dispositions: [
          DELEGATED_MAIN,
          { edgeId: "repo-embeddings", disposition: "not-run", cause: "later", owner: "lead" },
        ],
        zeckTraces: [CORRELATED_TRACE_MAIN],
      }),
      null,
    );
    expect(assessment.status).toBe("PARTIAL");
  });

  test("BYPASS_DETECTED overrides every other axis (a bypass is a bypass, even with a green corpus)", () => {
    const assessment = evaluateCompatibility(
      satisfyingRecord({
        dispositions: [
          DELEGATED_MAIN,
          {
            edgeId: "repo-embeddings",
            disposition: "direct-provider",
            observationBasis: "egress observation",
          },
        ],
      }),
      MATCHING_INVENTORY,
    );
    expect(assessment.status).toBe("BYPASS_DETECTED");
    expect(assessment.ruleResults.some((rule) => !rule.satisfied)).toBe(true);
  });

  test("an explicitly reclassified non-AI edge satisfies rule 1 for that edge (ordinary domain logic never has to surrender)", () => {
    const assessment = evaluateCompatibility(
      satisfyingRecord({
        dispositions: [
          DELEGATED_MAIN,
          {
            edgeId: "repo-embeddings",
            disposition: "non-ai",
            justification:
              "the indexer computes embeddings locally with a deterministic algorithm — audited, no AI service invoked",
          },
        ],
        zeckTraces: [CORRELATED_TRACE_MAIN],
      }),
      MATCHING_INVENTORY,
    );
    expect(assessment.status).toBe("AI_EXECUTION_COMPLETE");
    expect(
      assessment.ruleResults.find((rule) => rule.ruleId === "EVERY_DECLARED_EDGE_DELEGATED")
        ?.satisfied,
    ).toBe(true);
  });
});
