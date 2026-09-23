/**
 * PPR-003 — the harness contract tests (the fast, declarative battery;
 * the real-subprocess proof lives in
 * tests/integration/journey/harness-e2e.test.ts).
 *
 * Pins:
 *  - the 12 journeys in the work order's exact order;
 *  - the 22-family coverage matrix (every family maps to its four
 *    facts; classifications in the honest vocabulary; gates as env var
 *    names; example paths exist; the examples inventory reconciles);
 *  - the route-probe table against the machine openapi.json (the
 *    public route table — no second authority) + the honest
 *    expectation counts;
 *  - the findings contract (every field present, the closed severity
 *    and defect-class vocabularies);
 *  - the secret-safety discipline (fires, redacts, URL-hygiene);
 *  - the preflight refusals (invalid URL, non-http, credential-carrying
 *    URL, malformed revision);
 *  - the fail-closed identity-gate blocking semantics and the
 *    acceptance-gate derivation;
 *  - the NOT RUN boundary registry (the real-public-URL run is the
 *    Lead post-deployment run);
 *  - the DOM structural helpers (responsive plan, keyboard/focus
 *    affordances, the availability vocabulary).
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  capabilityCoverageMatrix,
  examplesManifestParityProblems,
  matrixIntegrityProblems,
} from "../../../tests/journey/capability-matrix";
import { createContext, raiseFinding } from "../../../tests/journey/context";
import { DEFECT_CLASSES, isDefectClass } from "../../../tests/journey/defect-classes";
import {
  AVAILABILITY_VOCABULARY,
  carriesAvailabilityDisclosure,
  hasActiveNavSemantics,
  hasMainLandmark,
  hasPrimaryNav,
  hasSkipLink,
  hasViewportMeta,
  isHtmlSurface,
  responsivePlanOf,
} from "../../../tests/journey/dom";
import { expectedRevisionOf, harnessRepositoryRoot } from "../../../tests/journey/identity-gate";
import { JOURNEYS, journeyRecordsOf } from "../../../tests/journey/journeys";
import {
  capabilitySeamComposition,
  ROUTE_PROBES,
  routeProbeProblem,
} from "../../../tests/journey/route-probes";
import { NOT_RUN_BOUNDARIES, preflight } from "../../../tests/journey/runner";
import { scanForSecrets, urlCarriesCredentials } from "../../../tests/journey/secret-safety";

const REPOSITORY_ROOT = harnessRepositoryRoot();

/** The work order's own journey set, in order (the pinned contract). */
const WORK_ORDER_JOURNEYS = [
  "discover",
  "capability-discovery",
  "sandbox-start",
  "first-text-execution",
  "execution-inspection",
  "evidence-cost",
  "validation-rerun",
  "compare",
  "export-reproduce",
  "trust-limits",
  "agent-onboarding",
  "production-deployment",
] as const;

describe("PPR-003: the journey set is the work order's own, in order", () => {
  test("the 12 journeys carry the exact ids in the exact order", () => {
    expect(JOURNEYS.map((journey) => journey.id)).toEqual([...WORK_ORDER_JOURNEYS]);
  });

  test("every journey is runnable (a function) and titled", () => {
    for (const journey of JOURNEYS) {
      expect(typeof journey.run).toBe("function");
      expect(journey.title.length).toBeGreaterThan(0);
    }
  });

  test("journeyRecordsOf groups the steps by journey id", () => {
    const steps = [
      {
        journey: "discover",
        id: "a",
        title: "A",
        surface: "/",
        status: "pass" as const,
        evidence: null,
        observed: "",
        expected: "",
      },
      {
        journey: "compare",
        id: "b",
        title: "B",
        surface: "/",
        status: "not-run" as const,
        evidence: null,
        observed: "",
        expected: "",
      },
    ];
    const records = journeyRecordsOf(JOURNEYS, steps);
    expect(records.length).toBe(12);
    expect(records[0]?.steps.length).toBe(1);
    expect(records[7]?.steps.length).toBe(1);
  });
});

describe("PPR-003: the 22-family capability coverage matrix", () => {
  const matrix = capabilityCoverageMatrix();

  test("the machine manifest carries exactly 22 workload families", () => {
    expect(matrix.length).toBe(22);
  });

  test("every family maps to all four work-order facts", () => {
    for (const row of matrix) {
      expect(row.family.length).toBeGreaterThan(0);
      // (a) discovery location — the console route + the machine manifest.
      expect(row.discoveryLocation.consoleRoute).toBe(`/console/playground/${row.family}`);
      expect(row.discoveryLocation.machineManifest).toBe(
        "docs/developer/machine/capability-manifest.json",
      );
      // (b) availability state — classification + recorded string.
      expect(["runnable", "provider-gated"]).toContain(row.classification);
      expect(row.availability.length).toBeGreaterThan(0);
      // (c) example/runnable path — exists in the repository tree.
      expect(row.examplePath.startsWith("examples/")).toBe(true);
      // (d) provider/access explanation — carried.
      expect(row.providerAccessExplanation.length).toBeGreaterThan(0);
    }
  });

  test("matrix integrity is clean (existence, vocabulary, gate names)", () => {
    expect(matrixIntegrityProblems(matrix)).toEqual([]);
  });

  test("the examples inventory reconciles with the manifest", () => {
    expect(examplesManifestParityProblems()).toEqual([]);
  });

  test("the gated families carry env var NAME gates (never values)", () => {
    const gated = matrix.filter((row) => row.classification === "provider-gated");
    expect(gated.length).toBeGreaterThan(10);
    for (const row of gated) {
      if (row.gatedBy !== null) {
        // A credential gate: an env var NAME, never a value.
        expect(row.gatedBy).toMatch(/^[A-Z][A-Z0-9_]*$/);
      } else {
        // The honest no-rail boundary: the NOT RUN vocabulary is
        // recorded in the availability string (realtime-voice,
        // browser-use, computer-use — no authorized rail at all).
        expect(row.availability).toMatch(/NOT RUN/i);
      }
    }
    const runnable = matrix.filter((row) => row.classification === "runnable");
    for (const row of runnable) {
      expect(row.gatedBy).toBeNull();
    }
  });

  test("the provider-gated population is never presented as live success (the explanation carries the recorded boundary)", () => {
    for (const row of matrix) {
      if (row.classification === "provider-gated") {
        expect(row.providerAccessExplanation.length).toBeGreaterThan(0);
      }
    }
  });
});

describe("PPR-003: the public-route probe table (no second authority)", () => {
  const openapi = JSON.parse(
    readFileSync(join(REPOSITORY_ROOT, "docs/developer/machine/openapi.json"), "utf8"),
  ) as { paths: Record<string, Record<string, unknown>> };

  /** Normalize a probe path: concrete ids → the parameter placeholder *. */
  function normalizeProbePath(path: string): string {
    return path
      .replace(/\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, "/*")
      .replace(/\/finding-probe\//g, "/*/");
  }

  /** Normalize an openapi path: {param} → the placeholder *. */
  function normalizeOpenapiPath(path: string): string {
    return path.replace(/\/\{[^}]+\}/g, "/*");
  }

  test("the table covers the machine openapi route table exactly (identity/health excepted)", () => {
    const openapiPaths = Object.keys(openapi.paths).map(normalizeOpenapiPath);
    for (const probe of ROUTE_PROBES) {
      expect(
        openapiPaths,
        `probe path ${probe.path} must exist in the machine openapi route table`,
      ).toContain(normalizeProbePath(probe.path));
    }
    // The probe table covers every openapi path except /health and
    // /identity (the discover journey's own steps).
    const probed = new Set(ROUTE_PROBES.map((probe) => normalizeProbePath(probe.path)));
    const uncovered = openapiPaths.filter(
      (path) => !probed.has(path) && path !== "/health" && path !== "/identity",
    );
    expect(uncovered).toEqual([]);
  });

  test("the honest expectation counts (18 auth / 3 unbound / 4 capability-or-auth / 1 public artifact)", () => {
    expect(ROUTE_PROBES.filter((probe) => probe.expect === "auth-boundary").length).toBe(18);
    expect(ROUTE_PROBES.filter((probe) => probe.expect === "capability-unbound").length).toBe(3);
    expect(
      ROUTE_PROBES.filter((probe) => probe.expect === "capability-or-auth-boundary").length,
    ).toBe(4);
    expect(ROUTE_PROBES.filter((probe) => probe.expect === "public-artifact").length).toBe(1);
    expect(ROUTE_PROBES.length).toBe(26);
  });

  test("the boundary grammar accepts the honest answers and rejects deviations", () => {
    const authProbe = ROUTE_PROBES.find((probe) => probe.expect === "auth-boundary");
    expect(authProbe).toBeDefined();
    if (authProbe !== undefined) {
      expect(routeProbeProblem(authProbe, 401, "AUTHENTICATION_FAILED")).toBeNull();
      expect(routeProbeProblem(authProbe, 200, "")).toContain("expected the honest 401");
    }
    const unboundProbe = ROUTE_PROBES.find((probe) => probe.expect === "capability-unbound");
    expect(unboundProbe).toBeDefined();
    if (unboundProbe !== undefined) {
      expect(routeProbeProblem(unboundProbe, 422, "CAPABILITY_UNAVAILABLE")).toBeNull();
      expect(routeProbeProblem(unboundProbe, 200, "")).toContain("expected the honest 422");
    }
    // The credentials seams are composition-dependent (PPR-008): the
    // unbound composition's 422 AND the materialized composition's 401
    // are both honest boundaries; the composition classifier records
    // which class answered.
    const seamProbe = ROUTE_PROBES.find((probe) => probe.expect === "capability-or-auth-boundary");
    expect(seamProbe).toBeDefined();
    if (seamProbe !== undefined) {
      expect(routeProbeProblem(seamProbe, 422, "CAPABILITY_UNAVAILABLE")).toBeNull();
      expect(routeProbeProblem(seamProbe, 401, "AUTHENTICATION_FAILED")).toBeNull();
      expect(routeProbeProblem(seamProbe, 200, "")).toContain("composition-dependent");
      expect(routeProbeProblem(seamProbe, 500, "")).toContain("composition-dependent");
      expect(capabilitySeamComposition(422, "CAPABILITY_UNAVAILABLE")).toBe("unbound");
      expect(capabilitySeamComposition(401, "AUTHENTICATION_FAILED")).toBe("materialized");
      expect(capabilitySeamComposition(200, "")).toBeNull();
    }
    // The credentials issue probe is WELL-FORMED (a valid role) so a
    // materialized composition reaches the authenticate seam — the
    // composition fact, never a body-validation coincidence.
    const issueProbe = ROUTE_PROBES.find(
      (probe) => probe.expect === "capability-or-auth-boundary" && probe.method === "POST",
    );
    expect(issueProbe).toBeDefined();
    if (issueProbe !== undefined) {
      expect(issueProbe.body).toContain('"role":"member"');
    }
    const artifactProbe = ROUTE_PROBES.find((probe) => probe.expect === "public-artifact");
    expect(artifactProbe).toBeDefined();
    if (artifactProbe !== undefined) {
      expect(routeProbeProblem(artifactProbe, 200, "")).toBeNull();
      expect(routeProbeProblem(artifactProbe, 404, "")).toContain("expected 200");
    }
  });
});

describe("PPR-003: the findings contract (the 8-field format)", () => {
  test("a raised finding carries every mandatory field with closed vocabularies", () => {
    const ctx = createContext({
      targetUrl: "http://127.0.0.1:1",
      environment: "local",
      allowDegraded: true,
      credentials: null,
    });
    ctx.journey = { id: "discover", title: "Discover Zeck" };
    raiseFinding(ctx, {
      step: "reachability",
      surface: "/",
      observed: "observed fact",
      expected: "expected fact",
      severity: "major",
      defectClass: "reachability",
      evidence: "status 0",
      viableSolutions: ["solution a", "solution b"],
      recommendedSolution: "the recommendation with trade-offs",
      verificationRequirement: "the re-run requirement",
    });
    expect(ctx.findings.length).toBe(1);
    const finding = ctx.findings[0];
    if (finding === undefined) {
      throw new Error("unreachable");
    }
    expect(finding.journey).toBe("discover");
    expect(finding.step).toBe("reachability");
    expect(finding.surface).toBe("/");
    expect(finding.observed).toBe("observed fact");
    expect(finding.expected).toBe("expected fact");
    expect(["blocker", "major", "minor"]).toContain(finding.severity);
    expect(isDefectClass(finding.defectClass)).toBe(true);
    expect(finding.evidence.length).toBeGreaterThan(0);
    expect(finding.viableSolutions.length).toBeGreaterThan(0);
    expect(finding.recommendedSolution.length).toBeGreaterThan(0);
    expect(finding.verificationRequirement.length).toBeGreaterThan(0);
  });

  test("the defect-class vocabulary is closed and described", () => {
    expect(DEFECT_CLASSES.length).toBe(14);
    for (const defectClass of DEFECT_CLASSES) {
      expect(defectClass.id.length).toBeGreaterThan(0);
      expect(defectClass.description.length).toBeGreaterThan(20);
    }
    expect(isDefectClass("reachability")).toBe(true);
    expect(isDefectClass("not-a-class")).toBe(false);
  });
});

describe("PPR-003: the secret-safety discipline", () => {
  /** Runtime-built synthetic secret (no literal pattern in this file). */
  function syntheticSecret(): string {
    return ["s", "k-contractfixture", "0000000000"].join("");
  }

  test("the scan fires on a secret-shaped value and the report never echoes it", () => {
    const matches = scanForSecrets(`prefix ${syntheticSecret()} suffix`);
    expect(matches.length).toBe(1);
    const match = matches[0];
    if (match === undefined) {
      throw new Error("unreachable");
    }
    expect(match.patternName).toContain("OpenAI-style key literal");
    expect(match.redactedShape).not.toContain(syntheticSecret().slice(3));
    expect(match.redactedShape).toMatch(/sk-…\(\d+ chars\)/);
  });

  test("the scan is clean on credential NAMES (names, never values)", () => {
    expect(
      scanForSecrets(
        "OPENROUTER_API_KEY and QWEN_API_KEY are credential NAMES; set them in the environment",
      ),
    ).toEqual([]);
  });

  test("the URL-hygiene detector", () => {
    expect(urlCarriesCredentials("postgres://user:pass@host:5432/db")).toBe(true);
    expect(urlCarriesCredentials("https://user:pass@example.com")).toBe(true);
    expect(urlCarriesCredentials("https://example.com")).toBe(false);
    expect(urlCarriesCredentials("http://127.0.0.1:8787")).toBe(false);
  });
});

describe("PPR-003: the preflight refusals (exit-2 semantics)", () => {
  const base = {
    environment: "local" as const,
    allowDegraded: true,
    credentials: null,
    mode: "contract-test",
  };

  test("an invalid URL is refused", () => {
    const refusal = preflight({ ...base, targetUrl: "not-a-url" });
    expect(refusal?.exitCode).toBe(2);
    expect(refusal?.reason).toContain("not a valid URL");
  });

  test("a non-http protocol is refused", () => {
    const refusal = preflight({ ...base, targetUrl: "ftp://example.com" });
    expect(refusal?.exitCode).toBe(2);
    expect(refusal?.reason).toContain("http(s)");
  });

  test("a credential-carrying URL is refused before any request (the URL-hygiene doctrine)", () => {
    const refusal = preflight({ ...base, targetUrl: "http://user:secret@127.0.0.1:8787" });
    expect(refusal?.exitCode).toBe(2);
    expect(refusal?.reason).toContain("URL-hygiene");
  });

  test("a malformed expected revision is refused", () => {
    const refusal = preflight({
      ...base,
      targetUrl: "http://127.0.0.1:1",
      expectedRevision: "nothex",
    });
    expect(refusal?.exitCode).toBe(2);
    expect(refusal?.reason).toContain("40-hex");
  });

  test("empty credentials are refused (all-or-nothing)", () => {
    const refusal = preflight({
      ...base,
      targetUrl: "http://127.0.0.1:1",
      credentials: { token: "", applicationId: "" },
    });
    expect(refusal?.exitCode).toBe(2);
    expect(refusal?.reason).toContain("credentials require");
  });

  test("the expected-revision resolver rejects malformed overrides and defaults to HEAD shape", () => {
    expect(expectedRevisionOf("zzz").error ?? "").toContain("40-hex");
    const head = expectedRevisionOf(undefined);
    expect(head.error).toBeUndefined();
    expect(head.revision).toMatch(/^[0-9a-f]{40}$/);
  });
});

describe("PPR-003: the NOT RUN boundary registry", () => {
  test("every boundary carries a reason and an owner", () => {
    expect(NOT_RUN_BOUNDARIES.length).toBe(5);
    for (const boundary of NOT_RUN_BOUNDARIES) {
      expect(boundary.check.length).toBeGreaterThan(0);
      expect(boundary.reason.length).toBeGreaterThan(20);
      expect(boundary.owner.length).toBeGreaterThan(0);
    }
  });

  test("the real-public-URL run is owned by the Lead post-deployment run", () => {
    const boundary = NOT_RUN_BOUNDARIES.find((entry) =>
      entry.check.includes("real public Zeck URL"),
    );
    expect(boundary?.owner).toBe("Lead post-deployment run");
  });

  test("the browser-session and credentialed boundaries are owned, not silent", () => {
    const owners = NOT_RUN_BOUNDARIES.map((entry) => entry.owner).join(" ");
    expect(owners).toContain("Lead");
    expect(owners).toContain("browser");
  });
});

describe("PPR-003: the DOM structural helpers (layout-independent)", () => {
  const consoleLikePage = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Zeck — Home</title>
<style>@media (max-width: 640px) { .x { display:block } }
@media (max-width: 1024px) { .y { display:block } }
@media (prefers-reduced-motion: reduce) { * { animation: none } }</style>
</head><body>
<a class="skip-link" href="#main">Skip to main content</a>
<nav aria-label="Primary"><a href="/" aria-current="page">Home</a></nav>
<main id="main"><h1>Home</h1></main>
</body></html>`;

  test("the structural affordances are detected", () => {
    expect(hasViewportMeta(consoleLikePage)).toBe(true);
    expect(hasSkipLink(consoleLikePage)).toBe(true);
    expect(hasMainLandmark(consoleLikePage)).toBe(true);
    expect(hasPrimaryNav(consoleLikePage)).toBe(true);
    expect(hasActiveNavSemantics(consoleLikePage)).toBe(true);
  });

  test("the responsive plan and reduced motion derive from the served CSS", () => {
    const plan = responsivePlanOf(consoleLikePage);
    expect(plan.mobile).toBe(true);
    expect(plan.tabletOrDesktop).toBe(true);
    expect(plan.reducedMotion).toBe(true);
    const bare = responsivePlanOf("<html><head></head><body></body></html>");
    expect(bare.mobile).toBe(false);
    expect(bare.tabletOrDesktop).toBe(false);
    expect(bare.reducedMotion).toBe(false);
  });

  test("the availability-state vocabulary is the mandated set", () => {
    expect(AVAILABILITY_VOCABULARY).toEqual([
      "available",
      "runnable",
      "provider-gated",
      "requires access",
      "not run",
    ]);
    expect(carriesAvailabilityDisclosure("This family is provider-gated")).toBe(true);
    expect(carriesAvailabilityDisclosure("A plain page with no state")).toBe(false);
  });

  test("HTML surface detection", () => {
    expect(isHtmlSurface("text/html; charset=utf-8", "<!doctype html>")).toBe(true);
    expect(isHtmlSurface("application/json", "<!doctype html>")).toBe(false);
    expect(isHtmlSurface("text/html; charset=utf-8", "   ")).toBe(false);
  });
});
