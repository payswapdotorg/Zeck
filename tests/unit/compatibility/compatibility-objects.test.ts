/**
 * PPR-017 — schema/conformance tests for every compatibility object
 * (the work order's first required test: "schema/conformance tests for
 * every compatibility object").
 *
 * Covers the four object families of the ACR-006 layer:
 *  1. the execution-surface taxonomy (the 20-surface ACR-006 §1
 *     vocabulary, ADDITIVE — never touching the 22-family manifest);
 *  2. the application execution graph + discovered inventories;
 *  3. exact revision pinning (both revisions mandatory, immutable);
 *  4. the compatibility evidence record (every axis of ACR-006 §3).
 *
 * Conformance here means: the vocabulary is exactly the approved one,
 * valid objects validate, and every malformed shape fails closed with
 * a NAMED issue (never a silent default).
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import {
  COMPATIBILITY_ADMISSION_RULES,
  COMPATIBILITY_STATUSES,
  dispositionOf,
  EVIDENCE_BASES,
  EXECUTION_SURFACE_LABELS,
  EXECUTION_SURFACES,
  isExecutionSurface,
  validateCompatibilityEvidenceRecord,
  validateDiscoveredInventory,
  validateExecutionGraph,
  validatePinnedApplication,
  validateRevisionPin,
} from "../../../src/integrations/compatibility/public";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

// ---------------------------------------------------------------------------
// 1. The execution-surface taxonomy (ACR-006 §1 verbatim, additive)
// ---------------------------------------------------------------------------

describe("the execution-surface taxonomy (ACR-006 §1)", () => {
  test("carries exactly the 20 ACR-006 surfaces, in the approved order", () => {
    expect([...EXECUTION_SURFACES]).toEqual([
      "text-generation",
      "structured-generation",
      "vision-image-understanding",
      "embeddings",
      "reranking",
      "retrieval-context-computation",
      "speech-recognition",
      "speech-generation",
      "image-generation",
      "video-generation",
      "three-d-generation",
      "realtime-multimodal-session",
      "search-ai-search",
      "extraction-document-intelligence",
      "browser-use-intelligence",
      "computer-use-intelligence",
      "agent-delegation",
      "deterministic-computation",
      "sandbox-program-execution",
      "human-escalation",
    ]);
  });

  test("every surface has a human-readable label", () => {
    for (const surface of EXECUTION_SURFACES) {
      const label = EXECUTION_SURFACE_LABELS[surface];
      expect(label, surface).toBeTruthy();
    }
  });

  test("the vocabulary is total: isExecutionSurface accepts members and rejects everything else", () => {
    for (const surface of EXECUTION_SURFACES) {
      expect(isExecutionSurface(surface)).toBe(true);
    }
    expect(isExecutionSurface("llm")).toBe(false);
    expect(isExecutionSurface("text")).toBe(false);
    expect(isExecutionSurface("")).toBe(false);
    expect(isExecutionSurface(42)).toBe(false);
    expect(isExecutionSurface(null)).toBe(false);
  });

  test("ADDITIVE to the 22-family manifest: the taxonomy never imports or rewrites capability truth", () => {
    // Additivity is structural: the taxonomy module is standalone (no
    // import of the capability manifest, the capabilities module, or
    // any availability/classification vocabulary), and the machine
    // manifest itself still carries its 22 families untouched. A
    // surface classification therefore asserts NOTHING about platform
    // availability — the two vocabularies coexist without a mapping
    // (overlapping names like image-generation are two different
    // concepts: an application edge's surface vs a platform family).
    const taxonomySource = readFileSync(
      resolve(REPO_ROOT, "src/integrations/compatibility/domain/execution-surfaces.ts"),
      "utf8",
    );
    expect(taxonomySource).not.toMatch(/from\s+["']/); // standalone: zero imports
    expect(taxonomySource).toContain("ADDITIVE");
    const manifest = JSON.parse(
      readFileSync(resolve(REPO_ROOT, "docs/developer/machine/capability-manifest.json"), "utf8"),
    ) as { workloadFamilies: { family: string }[] };
    expect(manifest.workloadFamilies).toHaveLength(22);
  });
});

// ---------------------------------------------------------------------------
// 2. The application execution graph + discovered inventories
// ---------------------------------------------------------------------------

const VALID_EDGE = {
  edgeId: "main-completion",
  component: "chat loop",
  surface: "text-generation",
  transport: "provider client seam",
  externalExecution: "direct provider model invocation",
  materiality: "the main model call invokes a provider model directly",
};

describe("the application execution graph", () => {
  test("a well-formed graph validates clean", () => {
    const issues = validateExecutionGraph({ edges: [VALID_EDGE] });
    expect(issues).toEqual([]);
  });

  test("an edge outside the ACR-006 surface vocabulary is rejected (fail closed)", () => {
    const issues = validateExecutionGraph({
      edges: [{ ...VALID_EDGE, surface: "provider-router" }],
    });
    expect(issues).toHaveLength(1);
    expect(issues[0]?.field).toBe("surface");
  });

  test("every edge axis is mandatory: a missing axis is a named issue", () => {
    for (const field of ["edgeId", "component", "transport", "externalExecution", "materiality"]) {
      const edge = { ...VALID_EDGE } as Record<string, unknown>;
      delete edge[field];
      const issues = validateExecutionGraph({ edges: [edge] });
      expect(
        issues.some((issue) => issue.field === field),
        field,
      ).toBe(true);
    }
  });

  test("duplicate edge ids are rejected (the disposition/trace keys stay unambiguous)", () => {
    const issues = validateExecutionGraph({
      edges: [VALID_EDGE, { ...VALID_EDGE, component: "another" }],
    });
    expect(issues.some((issue) => issue.issue.includes("duplicate edge id"))).toBe(true);
  });

  test("an EMPTY graph is rejected: no-AI-edges is a declaration, never an omission", () => {
    const issues = validateExecutionGraph({ edges: [] });
    expect(issues.some((issue) => issue.issue.includes("at least one edge"))).toBe(true);
  });

  test("a discovered inventory validates with the same discipline and requires provenance", () => {
    expect(
      validateDiscoveredInventory({ source: "static seam analysis", edges: [VALID_EDGE] }),
    ).toEqual([]);
    expect(
      validateDiscoveredInventory({ edges: [VALID_EDGE] }).some(
        (issue) => issue.field === "inventory.source",
      ),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 3. Exact revision pinning
// ---------------------------------------------------------------------------

describe("exact revision pinning", () => {
  const VALID_PIN = {
    upstreamRevision: "0aa24a9e59423eafab8732447289ac8735d26928",
    integrationRevision: "work/PPR-017-compatibility-foundation@0aa24a9",
  };

  test("both revisions are mandatory: an absent pin is rejected", () => {
    expect(validateRevisionPin(VALID_PIN)).toEqual([]);
    expect(
      validateRevisionPin({ upstreamRevision: "", integrationRevision: "x" }).some(
        (issue) => issue.field === "pin.upstreamRevision",
      ),
    ).toBe(true);
    expect(
      validateRevisionPin({ upstreamRevision: "x" }).some(
        (issue) => issue.field === "pin.integrationRevision",
      ),
    ).toBe(true);
    expect(validateRevisionPin(null).length).toBeGreaterThan(0);
  });

  test("a pinned application requires identity AND pin (all three identity fields)", () => {
    const pinned = {
      identity: {
        name: "Example app",
        repository: "https://example.invalid/app",
        applicationId: "00000000-0000-7000-8000-0000000000c1",
      },
      pin: VALID_PIN,
    };
    expect(validatePinnedApplication(pinned)).toEqual([]);
    for (const field of ["name", "repository", "applicationId"]) {
      const identity = { ...pinned.identity } as Record<string, unknown>;
      delete identity[field];
      expect(
        validatePinnedApplication({ identity, pin: VALID_PIN }).some(
          (issue) => issue.field === `identity.${field}`,
        ),
        field,
      ).toBe(true);
    }
  });

  test("the pin types expose NO mutation path (immutability is structural)", async () => {
    // TypeScript readonly surfaces are compile-time; the runtime
    // discipline is that no function in the layer writes a pin —
    // pinned here by asserting the only pin operations are validate +
    // compare (the barrel exports no setter/patcher for pins).
    const barrel = await import("../../../src/integrations/compatibility/public");
    const pinOperations = Object.keys(barrel).filter((name) => /pin/i.test(name));
    expect(pinOperations.sort()).toEqual([
      "revisionPinsEqual",
      "validatePinnedApplication",
      "validateRevisionPin",
    ]);
  });
});

// ---------------------------------------------------------------------------
// 4. The compatibility evidence record (every ACR-006 §3 axis)
// ---------------------------------------------------------------------------

const VALID_RECORD = {
  recordId: "conformance-record",
  recordBasis: "fixture",
  pinnedApplication: {
    identity: {
      name: "Example app",
      repository: "https://example.invalid/app",
      applicationId: "00000000-0000-7000-8000-0000000000c1",
    },
    pin: {
      upstreamRevision: "f".repeat(40),
      integrationRevision: "0".repeat(40),
    },
  },
  graph: { edges: [VALID_EDGE] },
  dispositions: [
    {
      edgeId: "main-completion",
      disposition: "not-run",
      cause: "proof not started",
      owner: "lead",
    },
  ],
  egressObservation: { mode: "observe", status: "not-run", violations: [] },
  providerCredentials: [{ envVarName: "EXAMPLE_PROVIDER_API_KEY", present: false }],
  runtimeEvidence: { corpusDeclared: false, corpusUsability: "not-run", observations: [] },
  comparison: [],
  zeckTraces: [],
  limitations: [],
  notRunCauses: [{ area: "proof", cause: "not started", owner: "lead" }],
  recordedAt: "2026-09-26T00:00:00Z",
};

describe("the compatibility evidence record", () => {
  test("the well-formed conformance record validates clean", () => {
    expect(validateCompatibilityEvidenceRecord(VALID_RECORD)).toEqual([]);
  });

  test("every axis is mandatory and named when malformed", () => {
    const cases: [string, unknown][] = [
      ["recordId", { ...VALID_RECORD, recordId: "" }],
      ["recordBasis", { ...VALID_RECORD, recordBasis: "guessed" }],
      ["pinnedApplication", { ...VALID_RECORD, pinnedApplication: null }],
      ["egressObservation", { ...VALID_RECORD, egressObservation: { mode: "sometimes" } }],
      ["runtimeEvidence", { ...VALID_RECORD, runtimeEvidence: null }],
      ["recordedAt", { ...VALID_RECORD, recordedAt: "" }],
    ];
    for (const [field, malformed] of cases) {
      const issues = validateCompatibilityEvidenceRecord(malformed);
      expect(issues.length, field).toBeGreaterThan(0);
    }
  });

  test("the egress observation vocabulary is closed", () => {
    const issues = validateCompatibilityEvidenceRecord({
      ...VALID_RECORD,
      egressObservation: { mode: "observe", status: "pretty-clean", violations: [] },
    });
    expect(issues.some((issue) => issue.field === "egressObservation.status")).toBe(true);
  });

  test("credential facts carry NAMES ONLY: a value-shaped credential fact is unrepresentable", () => {
    // A fact without the presence boolean fails; there is no field
    // where a secret VALUE could even appear (the shape is name+bool).
    const issues = validateCompatibilityEvidenceRecord({
      ...VALID_RECORD,
      providerCredentials: [{ envVarName: "EXAMPLE_PROVIDER_API_KEY" }],
    });
    expect(issues.some((issue) => issue.field === "providerCredentials")).toBe(true);
  });

  test("a delegated disposition requires execution ids AND an evidence basis", () => {
    const issues = validateCompatibilityEvidenceRecord({
      ...VALID_RECORD,
      dispositions: [{ edgeId: "main-completion", disposition: "delegated" }],
    });
    expect(issues.filter((issue) => issue.field === "dispositions").length).toBe(2);
  });

  test("dispositions reference DECLARED edges only (unknown edge ids rejected)", () => {
    const issues = validateCompatibilityEvidenceRecord({
      ...VALID_RECORD,
      dispositions: [
        { edgeId: "undeclared-edge", disposition: "not-run", cause: "x", owner: "lead" },
      ],
    });
    expect(issues.some((issue) => issue.issue.includes("unknown edge"))).toBe(true);
  });

  test("every evidence basis of the rule-5 vocabulary is expressible and closed", () => {
    expect([...EVIDENCE_BASES]).toEqual(["live", "fixture", "mock", "simulated-provider"]);
    const issues = validateCompatibilityEvidenceRecord({
      ...VALID_RECORD,
      dispositions: [
        {
          edgeId: "main-completion",
          disposition: "delegated",
          zeckExecutionIds: ["00000000-0000-7000-8000-0000000000d1"],
          evidenceBasis: "vibes",
        },
      ],
    });
    expect(issues.some((issue) => issue.issue.includes("evidence basis"))).toBe(true);
  });

  test("dispositionOf resolves an edge's disposition and misses honestly", () => {
    const record = VALID_RECORD as unknown as Parameters<typeof dispositionOf>[0];
    expect(dispositionOf(record, "main-completion")?.disposition).toBe("not-run");
    expect(dispositionOf(record, "absent-edge")).toBeNull();
  });

  test("the status vocabulary and the five admission rules are exactly ACR-006 §4", () => {
    expect([...COMPATIBILITY_STATUSES]).toEqual([
      "UNASSESSED",
      "PARTIAL",
      "BLOCKED",
      "BYPASS_DETECTED",
      "AI_EXECUTION_COMPLETE",
    ]);
    expect(COMPATIBILITY_ADMISSION_RULES).toHaveLength(5);
    expect(COMPATIBILITY_ADMISSION_RULES.map((rule) => rule.id)).toEqual([
      "EVERY_DECLARED_EDGE_DELEGATED",
      "DIRECT_EGRESS_ABSENT_OR_BLOCKED",
      "CORPUS_FUNCTIONALLY_USABLE",
      "ZECK_EVIDENCE_FOR_EVERY_DELEGATED_EDGE",
      "NO_FIXTURE_COUNTED_AS_EXTERNAL_PASS",
    ]);
  });
});
