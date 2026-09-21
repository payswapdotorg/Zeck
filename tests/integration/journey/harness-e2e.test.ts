/**
 * PPR-003 — the harness's real-subprocess proof (the integration
 * battery: REAL deploy/api.ts plane processes over real HTTP; the
 * deploy chain's local mode with the documented no-PG degradation —
 * this pod carries no PostgreSQL, and the plane's /health then answers
 * the honest fail-closed 503 down with controlPlane ready, which the
 * harness records under its explicit degraded allowance).
 *
 * Proves, end to end:
 *  1. THE LOCAL-PLANE RUN — the identity gate verifies, the 12 journeys
 *     execute in order, every executed step PASSES on the honest
 *     bootstrap composition (the 401/422/503 boundaries are the
 *     plane's honest vocabulary, not defects), the credential-gated and
 *     experience-surface steps record their not-run boundaries with
 *     owners, and the report self-scan is clean.
 *  2. THE WRONG-REVISION NEGATIVE — a real plane attesting a wrong
 *     revision: the gate refuses the whole run (12 blocked, 0
 *     executed, the exact reason).
 *  3. THE UNREACHABLE NEGATIVE — a reserved-then-closed port:
 *     reachability finding recorded, a well-formed report, no crash.
 *  4. THE SECRET-LEAK NEGATIVE — a fixture page carrying a
 *     runtime-built secret-shaped value: the secret-exposure finding
 *     fires, redacted, and the output stays clean.
 *
 * The console-composition surfaces are honestly NOT exercised here:
 * the local plane is the bootstrap composition (the deploy chain's
 * local mode) — no HTML experience is served, and those steps record
 * their not-run state with the owner (the Lead's post-deployment run
 * against the deployed experience). Nothing is fabricated.
 */

import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { expectedRevisionOf } from "../../../tests/journey/identity-gate";
import { bootLocalPlane, type LocalPlane } from "../../../tests/journey/local-plane";
import {
  negativeSecretLeak,
  negativeUnreachable,
  negativeWrongRevision,
} from "../../../tests/journey/negatives";
import { type HarnessRunOutcome, runJourneyHarness } from "../../../tests/journey/runner";

let plane: LocalPlane;
let outcome: HarnessRunOutcome;

beforeAll(async () => {
  plane = await bootLocalPlane({ label: "ppr-003-integration-proof" });
  afterAll(async () => {
    await plane.stop();
  });
  outcome = await runJourneyHarness({
    targetUrl: plane.baseUrl,
    environment: "local",
    allowDegraded: true,
    credentials: null,
    mode: "local-plane (integration proof)",
  });
});

describe("PPR-003 AC1: the local-plane run (real deploy/api.ts, real HTTP)", () => {
  test("the identity gate verifies and the 12 journeys execute in order", () => {
    expect(outcome.report.identityGate.verified).toBe(true);
    expect(outcome.report.identityGate.attested?.gitRevision).toBe(
      expectedRevisionOf(undefined).revision,
    );
    expect(outcome.report.journeys.map((journey) => journey.id)).toEqual([
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
    ]);
    // The honest bootstrap plane: every EXECUTED step passes; the
    // credential-gated/experience steps record their not-run boundary.
    expect(outcome.report.summary.stepsFailed).toBe(0);
    expect(outcome.report.summary.stepsPassed).toBeGreaterThan(0);
    expect(outcome.report.summary.stepsNotRun).toBeGreaterThan(0);
    expect(outcome.exitCode).toBe(0);
    expect(outcome.report.selfScan.clean).toBe(true);
    expect(outcome.report.problems).toEqual([]);
  });

  test("the discover journey records the honest boundary facts", () => {
    const discover = outcome.report.journeys[0];
    if (discover === undefined) {
      throw new Error("the discover journey is missing");
    }
    const reachability = discover.steps.find((step) => step.id === "reachability");
    expect(reachability?.status).toBe("pass");
    expect(reachability?.observed).toContain("404"); // the API plane: no HTML landing — the honest fact
    const landing = discover.steps.find((step) => step.id === "discover-landing");
    expect(landing?.status).toBe("not-run");
    expect(landing?.notRun?.owner).toContain("Lead");
    const identityFacts = discover.steps.find((step) => step.id === "identity-facts");
    expect(identityFacts?.status).toBe("pass");
    const health = discover.steps.find((step) => step.id === "health");
    // The no-PG degradation: the honest fail-closed 503 down under the
    // run's explicit degraded allowance.
    expect(health?.status).toBe("pass");
    expect(health?.observed).toContain("503");
    expect(health?.observed).toContain("controlPlane ready");
    const policy = discover.steps.find((step) => step.id === "public-artifact");
    expect(policy?.status).toBe("pass");
  });

  test("the capability matrix records 22 families with honest target probes", () => {
    expect(outcome.report.capabilityMatrix.length).toBe(22);
    expect(outcome.report.summary.familiesTotal).toBe(22);
    // The bootstrap plane serves no console composition: every family
    // route is honestly not-served (never a fabricated pass).
    expect(outcome.report.summary.familiesNotServed).toBe(22);
    expect(outcome.report.summary.familiesWithServedDisclosure).toBe(0);
    expect(outcome.report.summary.familiesDisclosureFailed).toBe(0);
    const matrixStep = outcome.report.journeys
      .find((journey) => journey.id === "capability-discovery")
      ?.steps.find((step) => step.id === "matrix-integrity");
    expect(matrixStep?.status).toBe("pass");
  });

  test("the production journey's route table records the honest boundaries", () => {
    const routeTable = outcome.report.journeys
      .find((journey) => journey.id === "production-deployment")
      ?.steps.find((step) => step.id === "route-table");
    expect(routeTable?.status).toBe("pass");
    expect(routeTable?.observed).toContain("26 routes probed");
    expect(routeTable?.observed).toContain("18 auth-boundary (401)");
    expect(routeTable?.observed).toContain("7 capability-unbound (422)");
    expect(routeTable?.observed).toContain("1 public-artifact (200)");
  });

  test("the credentialed steps record their not-run boundary with the Lead owner", () => {
    const start = outcome.report.journeys
      .find((journey) => journey.id === "sandbox-start")
      ?.steps.find((step) => step.id === "authenticated-start");
    expect(start?.status).toBe("not-run");
    expect(start?.notRun?.reason).toContain("ZECK_JOURNEY_TOKEN");
    const lifecycle = outcome.report.journeys
      .find((journey) => journey.id === "first-text-execution")
      ?.steps.find((step) => step.id === "execution-lifecycle");
    expect(lifecycle?.status).toBe("not-run");
    // The unauthenticated boundary IS asserted (the honest 401).
    const boundary = outcome.report.journeys
      .find((journey) => journey.id === "sandbox-start")
      ?.steps.find((step) => step.id === "unauthenticated-start-boundary");
    expect(boundary?.status).toBe("pass");
    expect(boundary?.observed).toContain("401");
  });

  test("the gates map the acceptance verdicts honestly", () => {
    const gates = new Map(outcome.report.gates.map((gate) => [gate.gate, gate.status]));
    expect(gates.get("public URL reachable")).toBe("pass");
    expect(gates.get("exact revision attested")).toBe("pass");
    expect(gates.get("/health verified")).toBe("pass");
    expect(gates.get("first sandbox execution works")).toBe("not-run");
    expect(gates.get("all 22 capability families discoverable")).toBe("not-run");
    expect(gates.get("agent integration discoverable")).toBe("pass");
  });
});

describe("PPR-003 AC3: the wrong-revision negative (fail-closed whole-run gate)", () => {
  test("a plane attesting a wrong revision refuses the run before any journey asserts", async () => {
    const drill = await negativeWrongRevision(expectedRevisionOf(undefined).revision);
    expect(drill.refused).toBe(true);
    expect(drill.blockedSteps).toBe(12);
    expect(drill.executedSteps).toBe(0);
    expect(drill.reason).toContain("does not match the expected revision");
  }, 120_000);
});

describe("PPR-003 AC3: the unreachable negative (findings, never a crash)", () => {
  test("an unreachable target records the reachability finding and a well-formed report", async () => {
    const drill = await negativeUnreachable();
    expect(drill.refusedCleanly).toBe(true);
    expect(drill.reachabilityFinding).toBe(true);
    expect(drill.reportProduced).toBe(true);
    expect(drill.reason.length).toBeGreaterThan(0);
  }, 120_000);
});

describe("PPR-003 AC3: the secret-leak negative (the redacted finding fires)", () => {
  test("a page leaking a secret-shaped value fires the secret-exposure finding, redacted", async () => {
    const drill = await negativeSecretLeak();
    expect(drill.findingFired).toBe(true);
    expect(drill.redactedEvidence).toBe(true);
    expect(drill.outputClean).toBe(true);
  }, 60_000);
});
