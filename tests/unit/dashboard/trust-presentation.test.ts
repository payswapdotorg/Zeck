/**
 * Dashboard trust-presentation tests (WORK-038).
 *
 * The ONE trust-state presentation module (trust.ts): the shared axis
 * vocabulary, the result-view trust summary (four separate facts, each
 * linked to its evidence location), the evidence-view axes table, the
 * evidence-ref links (a ref becomes a LINK only when the platform
 * exposes an artifact with that id — otherwise verbatim, never a
 * fabricated target), the artifact metadata/lineage/verification
 * presentations, and the contextual traversal strip.
 *
 * Mutant-style pins (AC9): a UI-only value mistaken for platform
 * verification truth FAILS here — a fabricated evidence link (linking a
 * ref with no public object), a merged single- verdict, or an invented
 * artifact fact each differ from the honest rendering on the same input.
 */

import { describe, expect, test } from "vitest";
import { distinctionList } from "../../../apps/dashboard/components";
import {
  checksReferencing,
  competenceDetailFacts,
  competenceDiscoveryFacts,
  consumesArtifact,
  evaluationStatusRows,
  inputArtifactRefsOf,
} from "../../../apps/dashboard/projection";
import {
  artifactMetadataTable,
  artifactParentLineage,
  artifactUsageReferences,
  artifactVerificationReferences,
  axisEvidenceLocation,
  contextTraversal,
  evidenceRefLink,
  evidenceRefLinks,
  TRUST_AXIS_LABELS,
  TRUST_NOTE,
  trustAxesTable,
  trustAxisLabel,
  trustSummarySection,
} from "../../../apps/dashboard/trust";
import type {
  ArtifactReference,
  Execution,
  ExecutionEvent,
  ExecutionResult,
  VerificationResult,
} from "../../../sdk";

const EXECUTION_ID = "00000000-0000-7000-8000-0000000000e1";

function executionOf(status: string): Execution {
  return {
    id: EXECUTION_ID,
    applicationId: "00000000-0000-7000-8000-0000000000a1",
    environmentId: null,
    status: status as Execution["status"],
    task: { kind: "outcome", description: "Contract risk analysis" },
    constraints: null,
    metadata: {},
    createdAt: "2026-09-15T12:00:00Z",
    updatedAt: "2026-09-15T12:03:42Z",
    terminalAt: null,
  };
}

function artifactOf(id: string, digest: string | null): ArtifactReference {
  return { id, digest, createdAt: "2026-09-15T12:03:40Z" };
}

function resultOf(
  route: ExecutionResult["route"],
  verification: VerificationResult[],
  artifacts: ArtifactReference[],
): ExecutionResult {
  return {
    executionId: EXECUTION_ID,
    status: "RUNNING",
    route,
    cost: null,
    usage: null,
    outputArtifacts: artifacts,
    verification,
    warnings: [],
    terminalAt: null,
  };
}

function checkOf(
  id: string,
  status: string,
  confidence: number | null,
  evidenceRefs: readonly string[],
): VerificationResult {
  return {
    id: `v-${id}`,
    executionId: EXECUTION_ID,
    criterionId: `criterion-${id}`,
    strategy: "digest-check",
    status: status as VerificationResult["status"],
    confidence,
    evaluator: { kind: "check", id: "evaluator-1", version: "3" },
    evidenceRefs,
    recordedAt: "2026-09-15T12:03:41Z",
  };
}

function eventOf(
  type: string,
  sequence: number,
  payload: Record<string, unknown> = {},
): ExecutionEvent {
  return {
    eventId: `ev-${sequence}`,
    executionId: EXECUTION_ID,
    type,
    sequence,
    occurredAt: "2026-09-15T12:00:05Z",
    payload,
  };
}

describe("the shared axis vocabulary (one source for every route)", () => {
  test("the four axis labels are the distinct user-language dimensions (never merged)", () => {
    expect(TRUST_AXIS_LABELS.provider).toBe("Provider success");
    expect(TRUST_AXIS_LABELS.execution).toBe("Execution success");
    expect(TRUST_AXIS_LABELS.quality).toBe("Quality success");
    expect(TRUST_AXIS_LABELS.policy).toBe("Policy success");
    const labels = Object.values(TRUST_AXIS_LABELS).join(" ");
    expect(labels).not.toMatch(/overall|merged|score|rating/i);
  });

  test("trustAxisLabel maps every kind (the mutant defining a second vocabulary fails)", () => {
    expect(trustAxisLabel("provider")).toBe("Provider success");
    expect(trustAxisLabel("execution")).toBe("Execution success");
    expect(trustAxisLabel("quality")).toBe("Quality success");
    expect(trustAxisLabel("policy")).toBe("Policy success");
  });

  test("TRUST_NOTE is the never-a-score sentence (no forbidden vocabulary)", () => {
    expect(TRUST_NOTE).toContain("never merged into a single score");
    expect(TRUST_NOTE).not.toMatch(/overall|rating/i);
  });
});

describe("axisEvidenceLocation (AC4 — contextual drill-down, never through an index)", () => {
  test("the provider axis links to the route facts on THIS execution", () => {
    const location = axisEvidenceLocation(
      { kind: "provider", label: "x", detail: "y", source: "z" },
      EXECUTION_ID,
    );
    expect(location.href).toBe(`/runs/${EXECUTION_ID}?tab=evidence#route-facts`);
  });

  test("the quality axis links to the verification results on THIS execution", () => {
    const location = axisEvidenceLocation(
      { kind: "quality", label: "x", detail: "y", source: "z" },
      EXECUTION_ID,
    );
    expect(location.href).toBe(`/runs/${EXECUTION_ID}?tab=evidence#verification-results`);
  });

  test("the execution and policy axes link to THIS execution's activity timeline", () => {
    for (const kind of ["execution", "policy"] as const) {
      const location = axisEvidenceLocation(
        { kind, label: "x", detail: "y", source: "z" },
        EXECUTION_ID,
      );
      expect(location.href).toBe(`/runs/${EXECUTION_ID}?tab=activity`);
    }
  });

  test("every location is contextual (same execution id, no index route)", () => {
    for (const kind of ["provider", "execution", "quality", "policy"] as const) {
      const location = axisEvidenceLocation(
        { kind, label: "x", detail: "y", source: "z" },
        EXECUTION_ID,
      );
      expect(location.href).toContain(`/runs/${EXECUTION_ID}`);
      expect(location.href).not.toContain("/runs?");
      expect(location.href).not.toContain("/assets/artifacts?");
    }
  });
});

describe("evidence reference links (AC2 — link only what publicly exists)", () => {
  const artifacts = [artifactOf("art-1", "d1"), artifactOf("art-2", null)];

  test("a ref matching a recorded output artifact becomes a contextual artifact link", () => {
    const html = evidenceRefLink("art-1", artifacts, EXECUTION_ID);
    expect(html).toContain('href="/assets/artifacts/art-1?executionId=');
    expect(html).toContain("art-1");
  });

  test("a ref with NO public object stays verbatim — the mutant linking it fails (AC9)", () => {
    const html = evidenceRefLink("opaque-ref-9", artifacts, EXECUTION_ID);
    expect(html).not.toContain("href=");
    expect(html).toContain("opaque-ref-9");
    expect(html).toContain("no public object with this id");
    // The fabrication mutant: linking a ref the platform never exposed
    // as an artifact would emit an href — pinned to differ.
    const fabricated = `<a href="/assets/artifacts/opaque-ref-9">opaque-ref-9</a>`;
    expect(html).not.toBe(fabricated);
  });

  test("empty refs render the honest no-refs marker", () => {
    expect(evidenceRefLinks([], artifacts, EXECUTION_ID)).toContain("no evidence refs recorded");
  });

  test("mixed refs link only the resolvable ones", () => {
    const html = evidenceRefLinks(["art-2", "opaque-7"], artifacts, EXECUTION_ID);
    expect(html).toContain('href="/assets/artifacts/art-2?');
    expect(html).not.toContain('href="/assets/artifacts/opaque-7');
    expect(html).toContain("opaque-7");
  });

  test("hostile ref content passes through the escape boundary", () => {
    const hostile = '<script>alert("x")</script>';
    const html = evidenceRefLink(hostile, [artifactOf(hostile, null)], EXECUTION_ID);
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });
});

describe("trustSummarySection (AC1 — the result-view trust summary)", () => {
  const verification = [checkOf("1", "PASS", 0.9, ["art-1"]), checkOf("2", "FAIL", null, [])];
  const result = resultOf(
    { provider: "p", model: "m", strategyClass: "hybrid", modelCalls: 4 },
    verification,
    [artifactOf("art-1", "d1")],
  );

  test("renders the four axes as four separate labeled facts, each with its evidence link", () => {
    const html = trustSummarySection({
      execution: executionOf("COMPLETED"),
      result,
      events: [eventOf("execution.created", 1), eventOf("execution.authorize", 2)],
    });
    for (const label of [
      "Provider success",
      "Execution success",
      "Quality success",
      "Policy success",
    ]) {
      expect(html).toContain(label);
    }
    expect((html.match(/class="trust-summary-axis"/g) ?? []).length).toBe(4);
    expect((html.match(/class="axis-evidence"/g) ?? []).length).toBe(4);
  });

  test("the summary carries the verification chip and the never-a-score note", () => {
    const html = trustSummarySection({ execution: executionOf("COMPLETED"), result, events: [] });
    expect(html).toContain("1/2 checks passed");
    expect(html).toContain("never merged into a single score");
    expect(html).not.toMatch(/overall|rating|magic/i);
  });

  test("the merge mutant (one overall verdict) differs from the honest rendering (AC9)", () => {
    const html = trustSummarySection({
      execution: executionOf("COMPLETED"),
      result,
      events: [eventOf("execution.created", 1), eventOf("execution.authorize", 2)],
    });
    const merged = '<li class="trust-summary-axis"><span class="axis-kind">Overall</span>';
    expect(html).not.toContain(merged);
    expect(html).not.toMatch(/overall (success|trust|confidence)/i);
  });
});

describe("trustAxesTable (AC2/AC3 — the evidence-view axes table)", () => {
  test("each axis row carries its label, facts, source and a contextual evidence link", () => {
    const html = trustAxesTable(
      [
        { kind: "provider", label: "l", detail: "d", source: "s" },
        { kind: "execution", label: "l", detail: "d", source: "s" },
        { kind: "quality", label: "l", detail: "d", source: "s" },
        { kind: "policy", label: "l", detail: "d", source: "s" },
      ],
      EXECUTION_ID,
    );
    expect((html.match(/<th scope="row">/g) ?? []).length).toBe(4);
    expect((html.match(/<td><a href=/g) ?? []).length).toBe(4);
    expect(html).toContain("See the evidence");
    expect(html).toContain("never merged into a single score");
  });

  test("axis values render escaped (hostile labels never inject)", () => {
    const html = trustAxesTable(
      [{ kind: "quality", label: "<script>x</script>", detail: "d", source: "s" }],
      EXECUTION_ID,
    );
    expect(html).not.toContain("<script>");
  });
});

describe("artifact presentations (AC5)", () => {
  test("metadata renders exactly the public reference fields — the invented-fact mutant fails (AC9)", () => {
    const html = artifactMetadataTable(artifactOf("art-1", "sha256:abc"));
    expect(html).toContain("art-1");
    expect(html).toContain("sha256:abc");
    expect(html).toContain("created");
    // The public wire carries ONLY id/digest/createdAt — no size, no
    // mime type, no content: a mutant inventing them differs.
    expect(html).not.toMatch(/size|mime|content-type|bytes/i);
    const nullDigest = artifactMetadataTable(artifactOf("art-2", null));
    expect(nullDigest).toContain("not recorded by the platform");
  });

  test("parent lineage links the recorded inputs; the honest absence renders otherwise", () => {
    const html = artifactParentLineage(["art-parent-1"], EXECUTION_ID);
    expect(html).toContain('href="/assets/artifacts/art-parent-1?');
    const none = artifactParentLineage([], EXECUTION_ID);
    expect(none).toContain("No input artifact references are recorded");
  });

  test("verification references list the checks whose evidence refs point at the artifact", () => {
    const verification = [
      checkOf("1", "PASS", 0.9, ["art-1"]),
      checkOf("2", "FAIL", null, ["art-other"]),
    ];
    const html = artifactVerificationReferences(verification, "art-1", EXECUTION_ID);
    expect(html).toContain("criterion-1");
    expect(html).not.toContain("criterion-2");
    expect(html).toContain("PASS");
    const none = artifactVerificationReferences(verification, "art-none", EXECUTION_ID);
    expect(none).toContain(
      "No verification check on the producing execution records this artifact",
    );
  });

  test("usage references render the consuming executions; the honest scope note renders", () => {
    const html = artifactUsageReferences([{ executionId: "exec-2", title: "Second analysis" }]);
    expect(html).toContain('href="/runs/exec-2"');
    expect(html).toContain("Second analysis");
    expect(html).toContain("no cross-work usage route");
    const none = artifactUsageReferences([]);
    expect(none).toContain("No execution opened in this browser records this artifact");
  });

  test("contextTraversal links result/evidence/activity (and the artifact when given)", () => {
    const withArtifact = contextTraversal({
      executionId: EXECUTION_ID,
      artifactId: "art-1",
      includeArtifact: true,
    });
    expect(withArtifact).toContain(`href="/runs/${EXECUTION_ID}"`);
    expect(withArtifact).toContain(`href="/runs/${EXECUTION_ID}?tab=evidence"`);
    expect(withArtifact).toContain(`href="/runs/${EXECUTION_ID}?tab=activity"`);
    expect(withArtifact).toContain('href="/assets/artifacts/art-1?');
    const without = contextTraversal({ executionId: EXECUTION_ID, includeArtifact: false });
    expect(without).not.toContain("/assets/artifacts/");
  });
});

describe("the lineage derivations (platform facts only)", () => {
  test("inputArtifactRefsOf reads ONLY the execution.created payload", () => {
    const events = [
      eventOf("execution.created", 1, { inputArtifactRefs: ["art-a", "art-b"] }),
      eventOf("execution.authorize", 2),
      eventOf("execution.start", 3, { inputArtifactRefs: ["hostile-injection"] }),
    ];
    expect(inputArtifactRefsOf(events)).toEqual(["art-a", "art-b"]);
  });

  test("non-array, absent, or non-string payloads yield the honest empty list", () => {
    expect(inputArtifactRefsOf([])).toEqual([]);
    expect(
      inputArtifactRefsOf([eventOf("execution.created", 1, { inputArtifactRefs: "art-a" })]),
    ).toEqual([]);
    expect(
      inputArtifactRefsOf([eventOf("execution.created", 1, { inputArtifactRefs: [7, null] })]),
    ).toEqual([]);
  });

  test("consumesArtifact matches only exact recorded input ids", () => {
    const events = [eventOf("execution.created", 1, { inputArtifactRefs: ["art-a"] })];
    expect(consumesArtifact(events, "art-a")).toBe(true);
    expect(consumesArtifact(events, "art-b")).toBe(false);
  });

  test("checksReferencing filters by the recorded evidence refs", () => {
    const verification = [checkOf("1", "PASS", 0.9, ["art-1"]), checkOf("2", "FAIL", null, [])];
    expect(checksReferencing(verification, "art-1").map((check) => check.criterionId)).toEqual([
      "criterion-1",
    ]);
    expect(checksReferencing(verification, "art-2")).toEqual([]);
  });
});

describe("the competence fact families (AC6/AC7 — only when available from the API)", () => {
  test("discovery carries exactly the five discovery families, every cell the explicit absence", () => {
    const facts = competenceDiscoveryFacts();
    expect(facts.map((fact) => fact.label)).toEqual([
      "Task outcome",
      "Relevance",
      "Success rate",
      "Typical cost and time",
      "Verification status",
    ]);
    expect(facts.every((fact) => fact.backed === false)).toBe(true);
    expect(facts.every((fact) => fact.fact.includes("not exposed by the public API"))).toBe(true);
  });

  test("detail carries exactly the six detail families, every cell the explicit absence", () => {
    const facts = competenceDetailFacts();
    expect(facts.map((fact) => fact.label)).toEqual([
      "Provenance",
      "Procedures",
      "Validation population",
      "Uncertainty",
      "Compatibility",
      "Promotion state",
    ]);
    expect(facts.every((fact) => fact.backed === false)).toBe(true);
    const promotion = facts.find((fact) => fact.label === "Promotion state");
    expect(promotion?.fact).toContain("implies a promotion");
  });
});

describe("the evaluation status distinction (AC8)", () => {
  test("the four statuses are distinct rows — never merged, never implied", () => {
    const rows = evaluationStatusRows();
    expect(rows.map((row) => row.kind)).toEqual([
      "observation",
      "recommendation",
      "validation",
      "production",
    ]);
    expect(rows.every((row) => row.backed === false)).toBe(true);
    const html = distinctionList(rows);
    expect((html.match(/class="distinction-state"/g) ?? []).length).toBe(4);
    expect(html).toContain("Observation");
    expect(html).toContain("Recommendation");
    expect(html).toContain("Validation");
    expect(html).toContain("Authoritative production status");
  });

  test("the advisory boundary is stated: recommendations never change work until validation/promotion", () => {
    const recommendation = evaluationStatusRows().find((row) => row.kind === "recommendation");
    expect(recommendation?.fact).toContain("advisory only");
    expect(recommendation?.fact).toContain("validation and promotion rules");
    const production = evaluationStatusRows().find((row) => row.kind === "production");
    expect(production?.fact).toContain("never implied by an observation or a recommendation");
  });
});
