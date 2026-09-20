/**
 * PPR-003 — the journey harness runner.
 *
 * THE ORDER (the fail-closed discipline):
 *
 *   0. PREFLIGHT — argument + URL-hygiene validation (a target URL
 *      carrying embedded credentials is refused before any request).
 *   1. THE IDENTITY GATE — the deployed plane is attested at the
 *      EXPECTED EXACT REVISION (the repository's own verification
 *      authority). A refused gate records EVERY journey step as
 *      not-run with the refusal as the reason and fails the run —
 *      drift never reaches a single journey assertion.
 *   2. THE 12 JOURNEYS — in the work order's order, over real HTTP.
 *   3. THE REPORT — assembled, secret-scanned over its OWN serialized
 *      form (the harness's output must be clean), and emitted.
 *
 * Exit codes: 0 = every executed step passed (not-run boundaries are
 * honest, never failures); 1 = any step failed, any finding fired, or
 * the identity gate refused; 2 = the harness's own preflight refusal.
 */

import type { EnvironmentId } from "../../src/platform/deployment/naming";
import { capabilityCoverageMatrix, summarizeMatrix } from "./capability-matrix";
import { createContext, type HarnessContext, OWNERS } from "./context";
import { expectedRevisionOf, identityGate } from "./identity-gate";
import { JOURNEYS, journeyRecordsOf } from "./journeys";
import { scanForSecrets, urlCarriesCredentials } from "./secret-safety";
import type {
  Finding,
  FindingSeverity,
  GateOutcome,
  HarnessReport,
  HarnessRunOutcome,
  JourneyStepRecord,
  NotRunBoundary,
  StepStatus,
} from "./types";

export type { HarnessRunOutcome };

/** The harness's fixed NOT RUN boundaries (the credential-honesty doctrine). */
export const NOT_RUN_BOUNDARIES: readonly NotRunBoundary[] = Object.freeze([
  {
    check:
      "The final acceptance run against the real public Zeck URL (the deployed PPR-002 preview) at its exact revision",
    reason:
      "The public URL does not exist at harness-delivery time (PPR-002's live provisioning is the Lead's credentialed run, in parallel). The harness is proven end to end against a locally-booted Zeck plane (the deploy chain's local mode) and the repository's machine manifests; the final run is the Lead's, the moment the preview is live.",
    owner: "Lead post-deployment run",
  },
  {
    check:
      "Credentialed journey steps (guided sandbox start, first text execution lifecycle, inspection, export) without transport credentials",
    reason:
      "The harness accepts a bearer credential + application id through ZECK_JOURNEY_TOKEN / ZECK_JOURNEY_APPLICATION_ID; without them every credentialed step records the honest not-run state with this owner (the bootstrap plane's auth boundary itself IS asserted — the 401 step).",
    owner: OWNERS.leadCredentialed,
  },
  {
    check:
      "Live provider rails for provider-gated workload families (voice/image/video/vision/3D/browser/computer-use live rows)",
    reason:
      "No provider credentials exist in this environment, and a provider-gated family is never reported as live success without the required access — the harness asserts the honest disclosure, never the completion (docs/developer/AVAILABILITY.md).",
    owner: "Lead credentialed re-run (provider rails)",
  },
  {
    check:
      "A real browser session's console-error capture and interactive keyboard/focus traversal",
    reason:
      "The harness is an HTTP/DOM-level acceptance harness (the repository's own assertion grammar). It records the HTTP-observable proxies (resource integrity, structural focus affordances); the interactive browser pass is the Lead's post-deployment verification.",
    owner: OWNERS.leadBrowserPass,
  },
  {
    check:
      "The /health ready state on a plane whose authoritative relational dependency is unprovisioned (the no-PG local plane)",
    reason:
      "The local plane supports the deploy chain's documented no-PG degradation: /health answers the honest fail-closed 503 down with controlPlane ready. The harness records that state exactly (with the run's explicit degraded allowance); the ready state is the provisioned deployment's fact.",
    owner:
      "Harness operator (configure the environment's dependency, or run with the explicit degraded allowance)",
  },
] as const);

/** The harness run options (the parameterization the Lead drives). */
export interface HarnessRunOptions {
  readonly targetUrl: string;
  readonly environment: EnvironmentId;
  readonly expectedRevision?: string;
  readonly allowDegraded: boolean;
  readonly credentials: { readonly token: string; readonly applicationId: string } | null;
  /** A label for the report's mode field (url | local-plane | negative-drill). */
  readonly mode: string;
}

/** A preflight refusal (exit 2). */
export interface PreflightRefusal {
  readonly exitCode: 2;
  readonly reason: string;
}

/** Validate the run options (the preflight; fail-closed, exit-2 semantics). */
export function preflight(options: HarnessRunOptions): PreflightRefusal | null {
  let parsed: URL;
  try {
    parsed = new URL(options.targetUrl);
  } catch {
    return { exitCode: 2, reason: `the target URL is not a valid URL: ${options.targetUrl}` };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return {
      exitCode: 2,
      reason: `the target URL must be http(s): ${options.targetUrl}`,
    };
  }
  if (urlCarriesCredentials(options.targetUrl)) {
    return {
      exitCode: 2,
      reason:
        "the target URL carries embedded credentials (scheme://user:pass@host) — refused by the URL-hygiene doctrine before any request is made",
    };
  }
  const revision = expectedRevisionOf(options.expectedRevision);
  if (revision.error !== undefined) {
    return { exitCode: 2, reason: revision.error };
  }
  if (
    options.credentials !== null &&
    (options.credentials.token.length === 0 || options.credentials.applicationId.length === 0)
  ) {
    return {
      exitCode: 2,
      reason: "credentials require both a non-empty token and a non-empty application id",
    };
  }
  return null;
}

/** The not-run step every journey records when the identity gate refused. */
function blockedSteps(
  journeys: readonly { readonly id: string; readonly title: string }[],
  reason: string,
): readonly JourneyStepRecord[] {
  return journeys.map((journey) => ({
    id: "identity-gate-blocked",
    journey: journey.id,
    title: "The whole journey is blocked by the fail-closed identity gate",
    surface: "GET /identity (the whole-run gate)",
    status: "not-run" as StepStatus,
    evidence: null,
    observed: `the gate refused: ${reason}`,
    expected: "the deployed plane attests the expected exact revision before any journey asserts",
    notRun: {
      reason: `identity gate refusal: ${reason}`,
      owner: OWNERS.leadPostDeployment,
    },
  }));
}

/** Derive the acceptance-gate verdicts from the recorded steps. */
function gatesOf(
  steps: readonly JourneyStepRecord[],
  gate: { verified: boolean; reason?: string },
): readonly GateOutcome[] {
  const stepOf = (journey: string, id: string): JourneyStepRecord | undefined =>
    steps.find((step) => step.journey === journey && step.id === id);
  const outcomeOf = (step: JourneyStepRecord | undefined): StepStatus | "gate-refused" => {
    if (!gate.verified) {
      return "gate-refused";
    }
    return step === undefined ? "not-run" : step.status;
  };
  const gates: readonly { readonly gate: string; readonly journey: string; readonly id: string }[] =
    [
      { gate: "public URL reachable", journey: "discover", id: "reachability" },
      { gate: "exact revision attested", journey: "discover", id: "identity-facts" },
      { gate: "/health verified", journey: "discover", id: "health" },
      { gate: "/identity verified", journey: "discover", id: "identity-facts" },
      {
        gate: "first sandbox execution works",
        journey: "first-text-execution",
        id: "execution-lifecycle",
      },
      {
        gate: "all 22 capability families discoverable",
        journey: "capability-discovery",
        id: "matrix-target-disclosure",
      },
      {
        gate: "executions inspectable (result/evidence/cost)",
        journey: "execution-inspection",
        id: "inspection-surfaces",
      },
      { gate: "compare reachable", journey: "compare", id: "compare-console" },
      { gate: "export/reproduce reachable", journey: "export-reproduce", id: "export-bundle" },
      {
        gate: "agent integration discoverable",
        journey: "agent-onboarding",
        id: "machine-artifacts",
      },
      {
        gate: "provider/free-tier state truthful (route boundaries honest)",
        journey: "production-deployment",
        id: "route-table",
      },
      { gate: "trust/limits reachable", journey: "trust-limits", id: "limits-envelope" },
    ];
  return gates.map((entry) => {
    const step = stepOf(entry.journey, entry.id);
    const status = outcomeOf(step);
    return {
      gate: entry.gate,
      status: status === "gate-refused" ? "not-run" : status,
      evidence:
        status === "gate-refused"
          ? `the identity gate refused the whole run: ${gate.reason ?? "unverified plane"}`
          : step === undefined
            ? "no step recorded (the journey did not reach this step)"
            : `${step.observed} (${step.surface})`,
    };
  });
}

/** Run the harness (the full, ordered discipline). */
export async function runJourneyHarness(options: HarnessRunOptions): Promise<HarnessRunOutcome> {
  const refusal = preflight(options);
  if (refusal !== null) {
    throw new Error(`harness preflight refused: ${refusal.reason}`);
  }
  const startedAt = new Date();
  const started = Date.now();
  const revision = expectedRevisionOf(options.expectedRevision);

  // THE IDENTITY GATE (fail-closed for the whole run).
  const gate = await identityGate(options.targetUrl, revision.revision, options.environment);

  const ctx: HarnessContext = createContext({
    targetUrl: options.targetUrl.replace(/\/$/, ""),
    environment: options.environment,
    allowDegraded: options.allowDegraded,
    credentials: options.credentials,
  });

  // The 22-family coverage matrix — ONE derivation shared by the
  // capability journey (which fills the target probes) and the report.
  const matrix = capabilityCoverageMatrix();
  ctx.matrix = matrix;
  const problems: string[] = [];

  if (!gate.verified) {
    // Drift: NO journey asserts. Every step records the blocked state,
    // and the refusal itself is a recorded finding (the class follows
    // the refusal's nature: transport vs identity deviation).
    for (const step of blockedSteps(JOURNEYS, gate.reason ?? "unverified plane")) {
      ctx.steps.push(step);
    }
    const transportRefusal = /unreachable|fetch failed|ECONNREFUSED|aborted|timeout/i.test(
      gate.reason ?? "",
    );
    ctx.findings.push({
      journey: "discover",
      step: "identity-gate",
      surface: `${options.targetUrl}/identity`,
      observed: `the identity gate refused the whole run: ${gate.reason ?? "unverified plane"}`,
      expected:
        "the deployed plane attests the expected exact revision before any journey asserts (the fail-closed whole-run gate)",
      severity: "blocker",
      defectClass: transportRefusal ? "reachability" : "identity-drift",
      evidence: `expected revision ${revision.revision}`,
      viableSolutions: [
        transportRefusal
          ? "restore the target's transport (the plane must answer GET /identity before any acceptance verdict)"
          : "repoint the plane at the expected revision (or re-run the harness with the plane's actual exact revision — the gate pins the run to one revision by design)",
      ],
      recommendedSolution: transportRefusal
        ? "the acceptance run cannot proceed on an unreachable target — restore delivery first"
        : "align the deployed revision with the expected revision; the harness is then re-run end to end",
      verificationRequirement:
        "a re-run passes the identity gate and executes the 12 journeys against the verified plane",
    });
    problems.push(`the identity gate refused the whole run: ${gate.reason ?? "unverified plane"}`);
  } else {
    // The 12 journeys, in order.
    for (const journey of JOURNEYS) {
      ctx.journey = { id: journey.id, title: journey.title };
      try {
        await journey.run(ctx);
      } catch (error) {
        // A journey crash is a harness-class defect — recorded, never silent.
        ctx.steps.push({
          id: "journey-internal-error",
          journey: journey.id,
          title: "The journey's execution deviated",
          surface: "the harness itself",
          status: "fail",
          evidence: null,
          observed: `unexpected error: ${(error as Error).message}`,
          expected: "the journey completes and records its steps",
          defectClass: "harness-internal",
        });
        problems.push(`journey ${journey.id} deviated: ${(error as Error).message}`);
      }
    }
  }

  const failedSteps = ctx.steps.filter((step) => step.status === "fail");
  if (failedSteps.length > 0) {
    problems.push(
      `${failedSteps.length} step(s) failed: ${failedSteps.map((step) => `${step.journey}/${step.id}`).join(", ")}`,
    );
  }
  if (ctx.findings.length > 0) {
    problems.push(`${ctx.findings.length} finding(s) recorded`);
  }

  const finishedAt = new Date();
  const summary = {
    journeys: JOURNEYS.length,
    stepsTotal: ctx.steps.length,
    stepsPassed: ctx.steps.filter((step) => step.status === "pass").length,
    stepsFailed: failedSteps.length,
    stepsNotRun: ctx.steps.filter((step) => step.status === "not-run").length,
    findingsBySeverity: severityCounts(ctx.findings),
    ...summarizeMatrix(matrix),
  };

  const report: HarnessReport = {
    tool: "tests/journey/run (PPR-003 public user-journey acceptance harness)",
    schemaVersion: 1,
    mode: options.mode,
    targetUrl: ctx.targetUrl,
    expectedRevision: revision.revision,
    environment: options.environment,
    allowDegraded: options.allowDegraded,
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: Date.now() - started,
    identityGate: gate,
    journeys: journeyRecordsOf(JOURNEYS, ctx.steps),
    capabilityMatrix: matrix,
    findings: ctx.findings,
    notRun: NOT_RUN_BOUNDARIES,
    gates: gatesOf(ctx.steps, gate),
    summary,
    selfScan: { checked: "the harness's own serialized report", clean: true, note: "" },
    problems,
  };

  // THE SELF-SCAN (the harness's own output must be secret-free).
  const serialized = JSON.stringify(report);
  const selfMatches = scanForSecrets(serialized);
  const selfScan =
    selfMatches.length === 0
      ? {
          checked: "the harness's own serialized report" as const,
          clean: true,
          note: "no secret-shaped value appears in the report (redaction held at every finding)",
        }
      : {
          checked: "the harness's own serialized report" as const,
          clean: false,
          note: `secret-shaped content detected in the report by pattern: ${selfMatches
            .map((match) => match.patternName)
            .join(
              "; ",
            )} — the report is NOT emitted with the content; the finding owner must correct the surface that leaked it`,
        };

  const finalProblems = selfScan.clean
    ? problems
    : [...problems, "the report self-scan failed (secret-shaped content)"];
  const finalReport: HarnessReport = { ...report, selfScan, problems: finalProblems };

  const exitCode = finalProblems.length === 0 ? 0 : 1;
  return { report: finalReport, exitCode };
}

/** Count findings by severity. */
function severityCounts(findings: readonly Finding[]): Readonly<Record<FindingSeverity, number>> {
  return {
    blocker: findings.filter((finding) => finding.severity === "blocker").length,
    major: findings.filter((finding) => finding.severity === "major").length,
    minor: findings.filter((finding) => finding.severity === "minor").length,
  };
}
