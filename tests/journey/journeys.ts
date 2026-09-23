/**
 * PPR-003 — the 12 public user journeys (the work order's set, in
 * order): discover; capability discovery; sandbox start; first text
 * execution; execution inspection; evidence/cost; validation rerun;
 * compare; export/reproduce; trust/limits; agent onboarding;
 * production/deployment.
 *
 * Each journey composes REAL HTTP round trips against the target and
 * records pass | fail | not-run with evidence for every step. The
 * honest-boundary steps (the 401/422/503 vocabulary of the bootstrap
 * composition) are genuine PASSES on any correctly-composed plane; the
 * credential-gated steps record not-run with their owner when this
 * environment carries no transport credential; the experience-surface
 * steps record the honest served/not-served fact. NOTHING is assumed.
 *
 * The order is the work order's own order and is pinned by the
 * contract unit test.
 */

import { type ExecutionStatus, TERMINAL_STATUSES } from "../../src/shared/wire";
import {
  capabilityCoverageMatrix,
  examplesManifestParityProblems,
  matrixIntegrityProblems,
} from "./capability-matrix";
import {
  type AuditedSurface,
  auditFetchedSurface,
  auditSurface,
  type HarnessContext,
  OWNERS,
  raiseDimensionFindings,
  raiseFinding,
  recordStep,
} from "./context";
import { carriesAvailabilityDisclosure, titleOf } from "./dom";
import { excerptOf, fetchSurface } from "./http";
import {
  followLandingChain,
  isLandingRedirectStatus,
  landingChainDescription,
  landingChainEvidence,
  MAX_LANDING_REDIRECT_HOPS,
} from "./landing-chain";
import { capabilitySeamComposition, ROUTE_PROBES, routeProbeProblem } from "./route-probes";
import type { JourneyRecord, StepEvidence } from "./types";

/** One journey definition (id + title + the ordered steps). */
export interface JourneyDefinition {
  readonly id: string;
  readonly title: string;
  readonly run: (ctx: HarnessContext) => Promise<void>;
}

/** The honest-boundary helper: the JSON error code of an API answer. */
function errorCodeOf(body: string): string {
  try {
    return String((JSON.parse(body) as { code?: unknown }).code ?? "");
  } catch {
    return "";
  }
}

/** Record an HTML experience step: full audit when served, honest not-run when not. */
async function experienceStep(
  ctx: HarnessContext,
  stepId: string,
  title: string,
  path: string,
): Promise<"pass" | "fail" | "not-run"> {
  const audited = await auditSurface(ctx, path);
  const evidence = audited.fetch.evidence;
  if (!audited.fetch.ok) {
    recordStep(ctx, {
      id: stepId,
      title,
      surface: path,
      status: "fail",
      evidence,
      observed: `transport failure: ${evidence.transportError ?? "unknown"}`,
      expected: "the experience surface answers over HTTP",
      defectClass: "reachability",
    });
    raiseFinding(ctx, {
      step: stepId,
      surface: path,
      observed: `the surface did not answer: ${evidence.transportError ?? "unknown"}`,
      expected: "the deployed experience surface answers over HTTP",
      severity: "major",
      defectClass: "reachability",
      evidence: `transport failure after ${evidence.durationMs}ms`,
      viableSolutions: [
        "verify the deployment's routing for the experience surface",
        "verify the plane process is serving (the /health and /identity facts of the same run distinguish transport failure from route absence)",
      ],
      recommendedSolution:
        "the run's own /health and /identity evidence localizes the failure (transport vs route); fix the delivery path accordingly — trade-off: none, this is a hard availability defect",
      verificationRequirement:
        "re-run this harness: the experience surface must answer and the step must record its served state",
    });
    return "fail";
  }
  if (!audited.isHtml) {
    recordStep(ctx, {
      id: stepId,
      title,
      surface: path,
      status: "not-run",
      evidence,
      observed: `answered ${evidence.status} ${evidence.contentType ?? "(no content type)"} — no HTML experience composition is served at this path by this plane`,
      expected:
        "an HTML experience page (the console composition) when the deployment serves the experience; the honest served/not-served fact otherwise",
      notRun: {
        reason: `the target serves no HTML experience composition at ${path} (answered ${evidence.status} ${evidence.contentType ?? "?"})`,
        owner: OWNERS.leadPostDeployment,
      },
    });
    return "not-run";
  }
  // Served HTML: run every dimension + findings for failures.
  raiseDimensionFindings(ctx, stepId, new URL(path, ctx.targetUrl).toString(), audited);
  const dimensionFailure = audited.dimensions.find((dimension) => dimension.status === "fail");
  recordStep(ctx, {
    id: stepId,
    title,
    surface: path,
    status: dimensionFailure === undefined ? "pass" : "fail",
    evidence,
    observed:
      dimensionFailure === undefined
        ? `HTML experience page served (title: ${titleOf(audited.fetch.body).slice(0, 80)}) with every audited dimension passing`
        : `HTML experience page served, dimensions failed: ${audited.dimensions
            .filter((d) => d.status === "fail")
            .map((d) => d.dimension)
            .join(", ")}`,
    expected: "an HTML experience page passing every audited cross-cutting dimension",
    ...(dimensionFailure === undefined ? {} : { defectClass: dimensionFailure.defectClass }),
    dimensions: audited.dimensions,
  });
  return dimensionFailure === undefined ? "pass" : "fail";
}

/**
 * Record the discover-landing step for a SERVED HTML landing — the same
 * full treatment for a direct landing and a chain-landed surface
 * (PPR-011): the dimension audit's findings first, then the step, with
 * the followed chain disclosed in the observed when the landing was
 * reached over redirects (chainPrefix is "" for a direct landing).
 */
function recordHtmlLanding(
  ctx: HarnessContext,
  landing: {
    readonly audited: AuditedSurface;
    readonly url: string;
    readonly surface: string;
    readonly findingStepId: string;
    readonly chainPrefix: string;
  },
): void {
  raiseDimensionFindings(ctx, landing.findingStepId, landing.url, landing.audited);
  const failure = landing.audited.dimensions.find((dimension) => dimension.status === "fail");
  recordStep(ctx, {
    id: "discover-landing",
    title: "The newcomer's landing surface",
    surface: landing.surface,
    status: failure === undefined ? "pass" : "fail",
    evidence: landing.audited.fetch.evidence,
    observed:
      failure === undefined
        ? `${landing.chainPrefix}HTML landing served (title: ${titleOf(landing.audited.fetch.body).slice(0, 80)}) with every audited dimension passing`
        : `${landing.chainPrefix}HTML landing served, dimensions failed: ${landing.audited.dimensions
            .filter((dimension) => dimension.status === "fail")
            .map((dimension) => dimension.dimension)
            .join(", ")}`,
    expected: "an HTML landing passing every audited dimension",
    ...(failure === undefined ? {} : { defectClass: failure.defectClass }),
    dimensions: landing.audited.dimensions,
  });
}

/**
 * PPR-011 — the redirect-following landing: the root answered a redirect
 * status with a Location header, so the plane's own bridge is followed
 * manually (bounded, same-origin) and the surface the newcomer actually
 * lands on gets the honest treatment for the chain's result — the landed
 * HTML surface the full audit; the non-HTML terminal and the cross-origin
 * hop the honest not-run; the loop, the over-budget chain and the
 * unreachable hop a landing-chain FINDING (a real browser fails to land
 * too).
 */
async function recordChainLanding(ctx: HarnessContext, rootEvidence: StepEvidence): Promise<void> {
  const chain = await followLandingChain(ctx, new URL("/", ctx.targetUrl).toString());
  const prefix = landingChainDescription(chain.hops);
  if (chain.kind === "html") {
    // The landed surface gets the EXACT treatment a direct HTML landing
    // gets — the full audit over the chain's own terminal fetch.
    const audited = await auditFetchedSurface(ctx, chain.url, chain.response);
    recordHtmlLanding(ctx, {
      audited,
      url: chain.url,
      surface: "/",
      findingStepId: "discover-landing",
      chainPrefix: prefix,
    });
    return;
  }
  if (chain.kind === "non-html") {
    recordStep(ctx, {
      id: "discover-landing",
      title: "The newcomer's landing surface",
      surface: "/",
      status: "not-run",
      evidence: chain.evidence,
      observed: `${prefix}answered ${chain.terminalStatus} ${chain.contentType ?? "(no content type)"} — no HTML landing is served by this plane`,
      expected: "an HTML landing when the deployment serves the experience composition",
      notRun: {
        reason: `the landing chain terminates in a non-HTML answer (${chain.terminalStatus} ${chain.contentType ?? "?"})`,
        owner: OWNERS.leadPostDeployment,
      },
    });
    return;
  }
  if (chain.kind === "cross-origin") {
    recordStep(ctx, {
      id: "discover-landing",
      title: "The newcomer's landing surface",
      surface: "/",
      status: "not-run",
      evidence: rootEvidence,
      observed: `${prefix}the chain's next hop ${chain.hopUrl} leaves the plane's origin — cross-origin following is out of audit scope`,
      expected:
        "an HTML landing on the plane's own origin when the deployment serves the experience composition",
      notRun: {
        reason: `the landing chain leaves the plane's origin (a hop redirects to ${chain.hopUrl}); cross-origin following is out of audit scope`,
        owner: OWNERS.leadPostDeployment,
      },
    });
    return;
  }
  // loop | budget-exceeded | unreachable — the chain fails to land.
  const observed =
    chain.kind === "loop"
      ? `${prefix}the landing chain loops back to ${chain.loopUrl} — a real browser fails to land too`
      : chain.kind === "budget-exceeded"
        ? `${prefix}the landing chain exceeds the ${MAX_LANDING_REDIRECT_HOPS}-hop budget without reaching a served HTML surface — a real browser fails to land too`
        : `${prefix}the chain's hop ${chain.hopUrl} did not answer (transport failure: ${chain.transportError})`;
  raiseFinding(ctx, {
    step: "discover-landing",
    surface: "/",
    observed,
    expected: `the landing chain terminates in a served HTML surface within ${MAX_LANDING_REDIRECT_HOPS} same-origin hops`,
    severity: "major",
    defectClass: "landing-chain",
    evidence: landingChainEvidence(chain.hops),
    viableSolutions: ["fix the route chain (loop/over-budget redirects)"],
    recommendedSolution: "repair the redirect chain, then re-run this harness",
    verificationRequirement: "the harness's discover journey records discover-landing = pass",
  });
  recordStep(ctx, {
    id: "discover-landing",
    title: "The newcomer's landing surface",
    surface: "/",
    status: "fail",
    evidence: rootEvidence,
    observed,
    expected: `the landing chain terminates in a served HTML surface within ${MAX_LANDING_REDIRECT_HOPS} same-origin hops`,
    defectClass: "landing-chain",
  });
}

// ---------------------------------------------------------------------------
// Journey 1 — discover
// ---------------------------------------------------------------------------

async function journeyDiscover(ctx: HarnessContext): Promise<void> {
  // 1. Reachability (the acceptance gate: the public URL is reachable).
  const root = await auditSurface(ctx, "/");
  if (!root.fetch.ok) {
    recordStep(ctx, {
      id: "reachability",
      title: "The public URL is reachable",
      surface: "/",
      status: "fail",
      evidence: root.fetch.evidence,
      observed: `transport failure: ${root.fetch.evidence.transportError ?? "unknown"}`,
      expected: "the public URL answers over HTTP",
      defectClass: "reachability",
    });
    raiseFinding(ctx, {
      step: "reachability",
      surface: "/",
      observed: `the public URL did not answer: ${root.fetch.evidence.transportError ?? "unknown"}`,
      expected: "the deployed public URL answers over HTTP",
      severity: "blocker",
      defectClass: "reachability",
      evidence: `transport failure after ${root.fetch.evidence.durationMs}ms`,
      viableSolutions: [
        "verify the delivery host is serving (the deployment chain's own smoke covers the same fact)",
        "verify DNS/routing for the public URL",
      ],
      recommendedSolution:
        "restore the delivery path, then re-run this harness — trade-off: none, this is the first acceptance gate",
      verificationRequirement: "the harness's discover journey records reachability = pass",
    });
    return;
  }
  const rootEvidence = root.fetch.evidence;
  const rootHtml = root.isHtml;
  recordStep(ctx, {
    id: "reachability",
    title: "The public URL is reachable",
    surface: "/",
    status: "pass",
    evidence: rootEvidence,
    observed: `answered ${rootEvidence.status} ${rootEvidence.contentType ?? "(no content type)"}`,
    expected: "the public URL answers over HTTP (any honest answer class)",
  });
  if (rootHtml) {
    // A served HTML landing: the discovery surface itself is audited.
    recordHtmlLanding(ctx, {
      audited: root,
      url: new URL("/", ctx.targetUrl).toString(),
      surface: "/",
      findingStepId: "reachability",
      chainPrefix: "",
    });
  } else if (
    rootEvidence.status !== null &&
    isLandingRedirectStatus(rootEvidence.status) &&
    rootEvidence.location !== undefined
  ) {
    // PPR-011 — the plane's own redirect bridge: the root answered a
    // redirect with a Location header, so the chain is followed manually
    // (bounded, same-origin) and the landed surface audited.
    await recordChainLanding(ctx, rootEvidence);
  } else {
    recordStep(ctx, {
      id: "discover-landing",
      title: "The newcomer's landing surface",
      surface: "/",
      status: "not-run",
      evidence: rootEvidence,
      observed: `answered ${rootEvidence.status} ${rootEvidence.contentType ?? "(no content type)"} — no HTML landing is served by this plane`,
      expected: "an HTML landing when the deployment serves the experience composition",
      notRun: {
        reason: `the target serves no HTML landing at / (answered ${rootEvidence.status} ${rootEvidence.contentType ?? "?"})`,
        owner: OWNERS.leadPostDeployment,
      },
    });
  }

  // 2. Identity facts (the newcomer-visible deployment identity).
  const identity = await auditSurface(ctx, "/identity");
  if (!identity.fetch.ok || identity.fetch.evidence.status !== 200) {
    recordStep(ctx, {
      id: "identity-facts",
      title: "The deployment identity is newcomer-visible",
      surface: "/identity",
      status: "fail",
      evidence: identity.fetch.evidence,
      observed: `answered ${identity.fetch.evidence.status ?? "transport failure"}`,
      expected: "GET /identity answers 200 with the runtime identity document",
      defectClass: "identity-drift",
    });
  } else {
    let revision = "?";
    let runtimeId = "?";
    try {
      const parsed = JSON.parse(identity.fetch.body) as {
        runtimeIdentityId?: string;
        identity?: { gitRevision?: string };
      };
      revision = parsed.identity?.gitRevision?.slice(0, 12) ?? "?";
      runtimeId = parsed.runtimeIdentityId?.slice(0, 16) ?? "?";
    } catch {
      // observed stays the parse failure
    }
    recordStep(ctx, {
      id: "identity-facts",
      title: "The deployment identity is newcomer-visible",
      surface: "/identity",
      status: "pass",
      evidence: identity.fetch.evidence,
      observed: `runtime identity ${runtimeId} at revision ${revision}`,
      expected: "GET /identity answers 200 with the runtime identity document",
    });
  }

  // 3. Health semantics (the control-plane/dependency distinction).
  const health = await auditSurface(ctx, "/health");
  const healthEvidence = health.fetch.evidence;
  if (!health.fetch.ok) {
    recordStep(ctx, {
      id: "health",
      title: "Health semantics (control plane / dependency distinction)",
      surface: "/health",
      status: "fail",
      evidence: healthEvidence,
      observed: `transport failure: ${healthEvidence.transportError ?? "unknown"}`,
      expected: "GET /health answers with the honest control-plane/dependency facts",
      defectClass: "health-semantics",
    });
    return;
  }
  let healthStatus = "unknown";
  let controlPlane = "unknown";
  try {
    const parsed = JSON.parse(health.fetch.body) as { status?: string; controlPlane?: string };
    healthStatus = parsed.status ?? "unknown";
    controlPlane = parsed.controlPlane ?? "unknown";
  } catch {
    // parse failure handled below
  }
  const statusOk =
    health.fetch.evidence.status === 200 &&
    (healthStatus === "ready" || healthStatus === "degraded");
  const degradedDownOk =
    health.fetch.evidence.status === 503 && healthStatus === "down" && ctx.allowDegraded;
  if (controlPlane !== "ready" || (!statusOk && !degradedDownOk)) {
    recordStep(ctx, {
      id: "health",
      title: "Health semantics (control plane / dependency distinction)",
      surface: "/health",
      status: "fail",
      evidence: healthEvidence,
      observed: `answered ${health.fetch.evidence.status} with status ${healthStatus}, controlPlane ${controlPlane}`,
      expected:
        "controlPlane ready with status ready|degraded (200), or the honest fail-closed 503 down when the degraded allowance is explicit",
      defectClass: "health-semantics",
    });
    raiseFinding(ctx, {
      step: "health",
      surface: "/health",
      observed: `GET /health answered ${health.fetch.evidence.status} with status ${healthStatus} and controlPlane ${controlPlane}`,
      expected:
        "the honest health vocabulary: controlPlane ready, and status ready|degraded on 200 — or the explicit 503 down with the run's degraded allowance",
      severity: "major",
      defectClass: "health-semantics",
      evidence: `body sha256 ${healthEvidence.bodySha256 ?? "?"}`,
      viableSolutions: [
        "if the authoritative dependency is genuinely unattested, that is the honest state — configure the environment's dependency or run the harness with the explicit degraded allowance",
        "if the dependency IS attested, the health projection is misclassifying — a platform defect",
      ],
      recommendedSolution:
        "classify first (the observed facts say which branch applies); the fail-closed 503 is the honest unprovisioned state, never a bug — trade-off: the degraded allowance is explicit per run, never silent",
      verificationRequirement:
        "re-run this harness with the environment's dependency configured (or the explicit allowance): the health step records the ready/degraded vocabulary",
    });
    return;
  }
  recordStep(ctx, {
    id: "health",
    title: "Health semantics (control plane / dependency distinction)",
    surface: "/health",
    status: "pass",
    evidence: healthEvidence,
    observed: `answered ${health.fetch.evidence.status} with status ${healthStatus}, controlPlane ${controlPlane}${degradedDownOk ? " (the explicit fail-closed down state; run allowance active)" : ""}`,
    expected: "the honest health vocabulary with the control plane ready",
  });

  // 4. The public governed artifact (the discoverable trust document).
  const policy = await auditSurface(ctx, "/sandbox/data-policy");
  const policyEvidence = policy.fetch.evidence;
  let policyOk = policy.fetch.ok && policy.fetch.evidence.status === 200;
  let policyObserved = `answered ${policy.fetch.evidence.status ?? "transport failure"}`;
  if (policyOk) {
    try {
      const parsed = JSON.parse(policy.fetch.body) as { artifact?: unknown; digest?: unknown };
      policyOk =
        typeof parsed.artifact === "string" &&
        parsed.artifact.length > 0 &&
        typeof parsed.digest === "string";
      policyObserved = policyOk
        ? "the versioned policy artifact with its digest"
        : "200 without the versioned artifact + digest shape";
    } catch {
      policyOk = false;
      policyObserved = "200 with a non-JSON body";
    }
  }
  recordStep(ctx, {
    id: "public-artifact",
    title: "The public governed data-policy artifact",
    surface: "/sandbox/data-policy",
    status: policyOk ? "pass" : "fail",
    evidence: policyEvidence,
    observed: policyObserved,
    expected:
      "200 with the versioned policy artifact + digest (the one unauthenticated public document)",
    ...(policyOk ? {} : { defectClass: "route-boundary" }),
  });
}

// ---------------------------------------------------------------------------
// Journey 2 — capability discovery (the 22-family matrix)
// ---------------------------------------------------------------------------

async function journeyCapabilityDiscovery(ctx: HarnessContext): Promise<void> {
  // 1. Matrix integrity (repo-side — the machine truth the harness pins).
  const rows = ctx.matrix.length > 0 ? ctx.matrix : capabilityCoverageMatrix();
  if (ctx.matrix.length === 0) {
    ctx.matrix = rows;
  }
  const integrity = [...matrixIntegrityProblems(rows), ...examplesManifestParityProblems()];
  recordStep(ctx, {
    id: "matrix-integrity",
    title: "The 22-family coverage matrix derives cleanly from the machine manifest",
    surface: "docs/developer/machine/capability-manifest.json",
    status: integrity.length === 0 ? "pass" : "fail",
    evidence: null,
    observed:
      integrity.length === 0
        ? `${rows.length} workload families, every example path existing, classifications in the honest vocabulary, gates as env var names`
        : integrity.join("; "),
    expected:
      "every family maps to discovery location, availability state, example path and provider/access explanation",
    ...(integrity.length === 0 ? {} : { defectClass: "matrix-integrity" }),
  });
  if (integrity.length > 0) {
    raiseFinding(ctx, {
      step: "matrix-integrity",
      surface: "docs/developer/machine/capability-manifest.json",
      observed: integrity.join("; "),
      expected:
        "the machine manifest reconciles with the examples inventory and the repository tree",
      severity: "blocker",
      defectClass: "matrix-integrity",
      evidence: "matrix derivation problems (repo-side)",
      viableSolutions: [
        "correct the manifest or the examples inventory so the two reconcile and every example path exists",
      ],
      recommendedSolution:
        "the machine manifest is validated against the examples' own exported metadata by tests/unit/developer-docs/machine-schemas.test.ts — run that suite to localize the drift; trade-off: none (drift is a test failure by the kit's own discipline)",
      verificationRequirement: "this harness's matrix-integrity step records pass",
    });
  }

  // 2. Target-side disclosure: every family's console discovery route.
  let served = 0;
  let notServed = 0;
  let failed = 0;
  const firstFailures: string[] = [];
  for (const row of rows) {
    const probed = await auditSurface(ctx, row.discoveryLocation.consoleRoute);
    const evidence = probed.fetch.evidence;
    if (!probed.fetch.ok) {
      row.targetProbe = {
        status: "fail",
        observed: `transport failure: ${evidence.transportError ?? "unknown"}`,
        defectClass: "reachability",
      };
      failed += 1;
      firstFailures.push(`${row.family}: transport failure`);
      continue;
    }
    if (!probed.isHtml) {
      row.targetProbe = {
        status: "not-run",
        observed: `answered ${evidence.status} ${evidence.contentType ?? "?"} — no console composition at this route`,
      };
      notServed += 1;
      continue;
    }
    const body = probed.fetch.body;
    const namesFamily = body.toLowerCase().includes(row.family.toLowerCase());
    const discloses = carriesAvailabilityDisclosure(body);
    const gateVisible =
      row.classification === "runnable" || new RegExp(`${row.gatedBy ?? ""}`).test(body);
    if (namesFamily && discloses && gateVisible) {
      row.targetProbe = {
        status: "pass",
        observed: `HTML family page served with the honest availability disclosure (${row.classification})`,
      };
      served += 1;
    } else {
      row.targetProbe = {
        status: "fail",
        observed: `HTML family page served but the disclosure is incomplete (family named: ${namesFamily}, availability state disclosed: ${discloses}, gate ${row.gatedBy ?? "—"} visible: ${gateVisible})`,
        defectClass: "disclosure-honesty",
      };
      failed += 1;
      firstFailures.push(`${row.family}: ${row.targetProbe.observed}`);
    }
  }
  const allNotServed = served === 0 && failed === 0 && notServed === rows.length;
  recordStep(ctx, {
    id: "matrix-target-disclosure",
    title: "Every family's discovery surface discloses its honest availability state",
    surface: "/console/playground/:family (22 routes)",
    status: allNotServed ? "not-run" : failed === 0 ? "pass" : "fail",
    evidence: null,
    observed: allNotServed
      ? "no console composition is served by this plane — every family route answered non-HTML; discovery location falls back to the machine manifest (repository-resident)"
      : `${served} family pages served with honest disclosure, ${notServed} not served (no console composition), ${failed} disclosure failures${firstFailures.length > 0 ? `: ${firstFailures.slice(0, 3).join("; ")}` : ""}`,
    expected:
      "every served family page names its family, discloses an availability state and shows its gate; provider-gated is never presented as live success",
    ...(failed === 0 ? {} : { defectClass: "disclosure-honesty" }),
    ...(allNotServed
      ? {
          notRun: {
            reason: "the target serves no console composition at /console/playground/:family",
            owner: OWNERS.leadPostDeployment,
          },
        }
      : {}),
  });
  if (failed > 0) {
    raiseFinding(ctx, {
      step: "matrix-target-disclosure",
      surface: "/console/playground/:family",
      observed: firstFailures.slice(0, 5).join("; "),
      expected:
        "every served family page carries the honest availability disclosure (the mandated state vocabulary)",
      severity: "major",
      defectClass: "disclosure-honesty",
      evidence: `${failed} of ${rows.length} family probes failed the disclosure assertion`,
      viableSolutions: [
        "correct the family page's disclosure section (the mandated Available / Provider-gated / Requires access / NOT RUN vocabulary)",
        "if the console is mid-reorganization (PPR-001), land the disclosure in the reorganized surface and keep the machine manifest as the truth source",
      ],
      recommendedSolution:
        "the disclosure must come from the same machine manifest the harness pins (no second authority) — render the manifest's classification verbatim; trade-off: the console reorganization must carry the state vocabulary forward",
      verificationRequirement:
        "re-run this harness: every served family route records target-probe pass",
    });
  }

  // 3. The playground index (the catalog surface).
  await experienceStep(
    ctx,
    "capability-catalog",
    "The capability catalog surface",
    "/console/playground",
  );
}

// ---------------------------------------------------------------------------
// Journey 3 — sandbox start
// ---------------------------------------------------------------------------

async function journeySandboxStart(ctx: HarnessContext): Promise<void> {
  // 1. The safety envelope answers honestly.
  const quotas = await auditSurface(ctx, "/sandbox/quotas");
  const quotasEvidence = quotas.fetch.evidence;
  const quotasOk =
    quotas.fetch.ok &&
    (quotas.fetch.evidence.status === 422 || quotas.fetch.evidence.status === 200);
  recordStep(ctx, {
    id: "sandbox-envelope",
    title: "The sandbox safety envelope answers honestly",
    surface: "/sandbox/quotas",
    status: quotasOk ? "pass" : "fail",
    evidence: quotasEvidence,
    observed: quotas.fetch.ok
      ? `answered ${quotas.fetch.evidence.status} ${errorCodeOf(quotas.fetch.body) || "(no code)"}`
      : `transport failure: ${quotasEvidence.transportError ?? "unknown"}`,
    expected:
      "the honest answer class (200 when the governance capability is bound, 422 CAPABILITY_UNAVAILABLE when unbound)",
    ...(quotasOk ? {} : { defectClass: "route-boundary" }),
  });

  // 2. The unauthenticated start boundary (the honest 401 — never a fabricated run).
  const textTaskShape = JSON.stringify({
    applicationId: "00000000-0000-0000-0000-000000000000",
    task: { kind: "summarize", doc: "quarterly-report-01", maxWords: 60 },
  });
  const unauthenticated = await fetchSurface(new URL("/executions", ctx.targetUrl).toString(), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: "Bearer journey-probe-unauthenticated",
      "x-zeck-application": "00000000-0000-0000-0000-000000000000",
      "idempotency-key": `journey-${Date.now()}`,
    },
    body: textTaskShape,
  });
  const unauthCode = errorCodeOf(unauthenticated.body);
  const unauthOk =
    unauthenticated.ok &&
    unauthenticated.evidence.status === 401 &&
    unauthCode === "AUTHENTICATION_FAILED";
  recordStep(ctx, {
    id: "unauthenticated-start-boundary",
    title: "An unauthenticated sandbox start is refused honestly",
    surface: "POST /executions",
    status: unauthOk ? "pass" : "fail",
    evidence: unauthenticated.evidence,
    observed: unauthenticated.ok
      ? `answered ${unauthenticated.evidence.status} ${unauthCode || "(no code)"}`
      : `transport failure: ${unauthenticated.evidence.transportError ?? "unknown"}`,
    expected:
      "the honest 401 AUTHENTICATION_FAILED (the auth boundary is enforced; no capability is fabricated)",
    ...(unauthOk ? {} : { defectClass: "route-boundary" }),
  });
  if (!unauthOk) {
    raiseFinding(ctx, {
      step: "unauthenticated-start-boundary",
      surface: "POST /executions",
      observed: `the unauthenticated create answered ${unauthenticated.evidence.status ?? "transport failure"} ${unauthCode}`,
      expected: "the honest 401 AUTHENTICATION_FAILED of the enforced auth boundary",
      severity: "blocker",
      defectClass: "route-boundary",
      evidence: `status ${unauthenticated.evidence.status ?? "?"}, body sha256 ${unauthenticated.evidence.bodySha256 ?? "?"}`,
      viableSolutions: ["restore the authenticate seam's fail-closed refusal on the create route"],
      recommendedSolution:
        "the create route must reach the authenticate seam and refuse — never fabricate a capability to appear usable; trade-off: none (this is the security boundary)",
      verificationRequirement: "this harness's unauthenticated-start-boundary step records pass",
    });
  }

  // 3. The credentialed guided start (the real sandbox path).
  if (ctx.credentials === null) {
    recordStep(ctx, {
      id: "authenticated-start",
      title: "The guided sandbox start creates a real execution",
      surface: "POST /executions",
      status: "not-run",
      evidence: null,
      observed: "no transport credential is configured for this run",
      expected: "a governed sandbox execution created through the public API",
      notRun: {
        reason:
          "ZECK_JOURNEY_TOKEN (+ ZECK_JOURNEY_APPLICATION_ID) is not set — the credentialed journey steps are the Lead's boundary",
        owner: OWNERS.leadCredentialed,
      },
    });
    return;
  }
  const created = await fetchSurface(new URL("/executions", ctx.targetUrl).toString(), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${ctx.credentials.token}`,
      "x-zeck-application": ctx.credentials.applicationId,
      "idempotency-key": `journey-start-${Date.now()}`,
    },
    body: JSON.stringify({
      applicationId: ctx.credentials.applicationId,
      task: { kind: "summarize", doc: "quarterly-report-01", maxWords: 60 },
      metadata: { origin: "ppr-003-journey-harness", family: "text", sandbox: "disposable" },
    }),
  });
  const createdCode = errorCodeOf(created.body);
  if (!created.ok || created.evidence.status !== 201) {
    recordStep(ctx, {
      id: "authenticated-start",
      title: "The guided sandbox start creates a real execution",
      surface: "POST /executions",
      status: "fail",
      evidence: created.evidence,
      observed: `answered ${created.evidence.status ?? "transport failure"} ${createdCode}`,
      expected: "201 with the execution receipt (the governed create contract)",
      defectClass: "route-boundary",
    });
    raiseFinding(ctx, {
      step: "authenticated-start",
      surface: "POST /executions",
      observed: `the credentialed create answered ${created.evidence.status ?? "transport failure"} ${createdCode}`,
      expected: "201 with the execution receipt",
      severity: "major",
      defectClass: "route-boundary",
      evidence: `body sha256 ${created.evidence.bodySha256 ?? "?"} (redacted excerpt: ${excerptOf(created.body)})`,
      viableSolutions: [
        "verify the credential is valid for the target's authenticate seam (the 401/403 variants distinguish credential from scope)",
        "verify the application scope authorizes the create on this plane",
      ],
      recommendedSolution:
        "classify by the observed error code first; the harness never retries with a different scope than the one it was given",
      verificationRequirement:
        "the credentialed start records 201 and the execution id flows into the inspection journeys",
    });
    return;
  }
  try {
    // The pinned wire receipt contract (src/api/serialization.ts
    // toWireReceipt) carries the execution's id as `executionId` —
    // never `id` (the PPR-008 local materialized run recorded the
    // harness-side parse mismatch; fixed here).
    const receipt = JSON.parse(created.body) as { executionId?: string };
    ctx.artifacts.executionId = receipt.executionId ?? null;
  } catch {
    // handled by the null check below
  }
  recordStep(ctx, {
    id: "authenticated-start",
    title: "The guided sandbox start creates a real execution",
    surface: "POST /executions",
    status: ctx.artifacts.executionId !== null ? "pass" : "fail",
    evidence: created.evidence,
    observed:
      ctx.artifacts.executionId !== null
        ? `201 with executionId ${ctx.artifacts.executionId}`
        : "201 without an executionId in the receipt (the wire receipt contract carries executionId)",
    expected: "201 with the execution receipt (executionId present — the wire receipt contract)",
    ...(ctx.artifacts.executionId !== null ? {} : { defectClass: "route-boundary" }),
  });
}

// ---------------------------------------------------------------------------
// Journey 4 — first text execution (the lifecycle to terminal state)
// ---------------------------------------------------------------------------

async function journeyFirstExecution(ctx: HarnessContext): Promise<void> {
  if (ctx.credentials === null || ctx.artifacts.executionId === null) {
    recordStep(ctx, {
      id: "execution-lifecycle",
      title: "The first text execution reaches a terminal state",
      surface: "GET /executions/:id",
      status: "not-run",
      evidence: null,
      observed:
        ctx.credentials === null
          ? "no transport credential is configured for this run"
          : "no execution was created by the sandbox-start journey (its step records why)",
      expected: "the execution drives to a terminal state with its verification outcome",
      notRun: {
        reason:
          ctx.credentials === null
            ? "ZECK_JOURNEY_TOKEN is not set — the credentialed journey steps are the Lead's boundary"
            : "the sandbox-start journey did not produce an execution to drive",
        owner: ctx.credentials === null ? OWNERS.leadCredentialed : OWNERS.leadPostDeployment,
      },
    });
    return;
  }
  const executionUrl = new URL(
    `/executions/${encodeURIComponent(ctx.artifacts.executionId)}`,
    ctx.targetUrl,
  ).toString();
  const headers = {
    authorization: `Bearer ${ctx.credentials.token}`,
    "x-zeck-application": ctx.credentials.applicationId,
  };
  let status = "?";
  let terminal = false;
  let lastEvidence: StepEvidence | null = null;
  for (let poll = 0; poll < 60 && !terminal; poll += 1) {
    const fetched = await fetchSurface(executionUrl, { headers });
    lastEvidence = fetched.evidence;
    if (!fetched.ok || fetched.evidence.status !== 200) {
      break;
    }
    try {
      const parsed = JSON.parse(fetched.body) as { status?: string };
      status = parsed.status ?? "?";
      terminal = TERMINAL_STATUSES.includes(status as ExecutionStatus);
    } catch {
      break;
    }
    if (!terminal) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 500));
    }
  }
  const verification = await fetchSurface(`${executionUrl}/verification`, { headers });
  let verificationOutcome = "unrecorded";
  let verificationAllPass = false;
  if (verification.ok && verification.evidence.status === 200) {
    try {
      const parsed: unknown = JSON.parse(verification.body);
      // The wire contract: an ARRAY of verification results (each with a
      // status — toWireVerification); the outcome records the distinct
      // statuses (all-pass iff results are recorded and every one passes).
      // A non-array body is recorded unparsed — never fabricated.
      if (Array.isArray(parsed)) {
        const statuses = [
          ...new Set(
            parsed.map((entry) =>
              typeof entry === "object" && entry !== null
                ? String((entry as { status?: unknown }).status ?? "?")
                : "?",
            ),
          ),
        ];
        verificationOutcome =
          parsed.length === 0 ? "none recorded" : `${statuses.join("/")} (${parsed.length})`;
        verificationAllPass = parsed.length > 0 && statuses.length === 1 && statuses[0] === "PASS";
      } else {
        verificationOutcome = "recorded (unparsed)";
      }
    } catch {
      verificationOutcome = "recorded (unparsed)";
    }
    ctx.artifacts.verificationOutcome = verificationOutcome;
  }
  ctx.artifacts.executionTerminalStatus = terminal ? status : null;
  const passed = terminal && status === "COMPLETED" && verificationAllPass;
  recordStep(ctx, {
    id: "execution-lifecycle",
    title: "The first text execution reaches a terminal state",
    surface: executionUrl,
    status: passed ? "pass" : "fail",
    evidence: lastEvidence,
    observed: `terminal: ${terminal}, status: ${status}, verification: ${verificationOutcome}`,
    expected:
      "COMPLETED with a PASS verification outcome (the acceptance gate: the first sandbox execution works)",
    ...(passed ? {} : { defectClass: "route-boundary" }),
  });
  if (!passed) {
    raiseFinding(ctx, {
      step: "execution-lifecycle",
      surface: executionUrl,
      observed: `the first sandbox execution ended ${terminal ? `terminal ${status}` : "non-terminal after the bounded poll window"} with verification ${verificationOutcome}`,
      expected: "COMPLETED with a PASS verification outcome",
      severity: "major",
      defectClass: "route-boundary",
      evidence: `final status ${status}, verification ${verificationOutcome} (body sha256 ${lastEvidence?.bodySha256 ?? "?"})`,
      viableSolutions: [
        "if the failure is an honest rail gap (provider-gated), the deployment's provider allowlist decides — record the boundary, never force it",
        "if the failure is a platform defect, the execution's own events/verification records localize it (inspect through this same harness's inspection journey)",
      ],
      recommendedSolution:
        "read the execution's event trail through the inspection journey before scoping a correction — the honest failure vocabulary (NOT RUN vs FAILED) determines the Work Order; trade-off: none (this is the core acceptance gate)",
      verificationRequirement:
        "a re-run records COMPLETED + PASS for the first sandbox text execution",
    });
  }
}

// ---------------------------------------------------------------------------
// Journey 5 — execution inspection
// ---------------------------------------------------------------------------

async function journeyInspection(ctx: HarnessContext): Promise<void> {
  if (ctx.credentials === null || ctx.artifacts.executionId === null) {
    recordStep(ctx, {
      id: "inspection-surfaces",
      title: "Result, activity and verification are inspectable",
      surface: "GET /executions/:id{,/events,/verification,/results}",
      status: "not-run",
      evidence: null,
      observed:
        ctx.credentials === null
          ? "no transport credential is configured for this run"
          : "no execution was created by the sandbox-start journey",
      expected: "the execution's receipt, events, verification and results all answer 200",
      notRun: {
        reason:
          ctx.credentials === null
            ? "ZECK_JOURNEY_TOKEN is not set — the credentialed journey steps are the Lead's boundary"
            : "the sandbox-start journey did not produce an execution to inspect",
        owner: ctx.credentials === null ? OWNERS.leadCredentialed : OWNERS.leadPostDeployment,
      },
    });
  } else {
    const headers = {
      authorization: `Bearer ${ctx.credentials.token}`,
      "x-zeck-application": ctx.credentials.applicationId,
    };
    const id = encodeURIComponent(ctx.artifacts.executionId);
    const surfaces: readonly { readonly label: string; readonly suffix: string }[] = [
      { label: "receipt", suffix: "" },
      { label: "events", suffix: "/events" },
      { label: "verification", suffix: "/verification" },
      { label: "results", suffix: "/results" },
    ];
    const observations: string[] = [];
    let allOk = true;
    for (const surface of surfaces) {
      const fetched = await fetchSurface(
        new URL(`/executions/${id}${surface.suffix}`, ctx.targetUrl).toString(),
        { headers },
      );
      const ok = fetched.ok && fetched.evidence.status === 200;
      allOk = allOk && ok;
      let observation = `${surface.label}: ${fetched.evidence.status ?? "transport failure"}`;
      if (surface.label === "events" && ok) {
        try {
          const parsed = JSON.parse(fetched.body) as { events?: unknown[] };
          observation = `events: 200 (${parsed.events?.length ?? 0} events)`;
        } catch {
          // the raw observation stands
        }
      }
      observations.push(observation);
    }
    recordStep(ctx, {
      id: "inspection-surfaces",
      title: "Result, activity and verification are inspectable",
      surface: `GET /executions/${id}{,/events,/verification,/results}`,
      status: allOk ? "pass" : "fail",
      evidence: null,
      observed: observations.join(", "),
      expected: "every inspection surface answers 200 (the 'How Zeck did it' hierarchy)",
      ...(allOk ? {} : { defectClass: "route-boundary" }),
    });
  }
  await experienceStep(
    ctx,
    "inspection-console",
    "The execution explorer console surface",
    ctx.artifacts.executionId === null
      ? "/console/executions"
      : `/console/executions/${encodeURIComponent(ctx.artifacts.executionId)}`,
  );
}

// ---------------------------------------------------------------------------
// Journey 6 — evidence/cost
// ---------------------------------------------------------------------------

async function journeyEvidenceCost(ctx: HarnessContext): Promise<void> {
  if (ctx.credentials === null || ctx.artifacts.executionId === null) {
    recordStep(ctx, {
      id: "receipt-cost",
      title: "The result package carries the evidence and cost facts",
      surface: "GET /executions/:id/results",
      status: "not-run",
      evidence: null,
      observed:
        ctx.credentials === null
          ? "no transport credential is configured for this run"
          : "no execution was created by the sandbox-start journey",
      expected:
        "the result package carries the cost/usage projection over the ledger facts (honestly null until a governed writer settles usage)",
      notRun: {
        reason:
          ctx.credentials === null
            ? "ZECK_JOURNEY_TOKEN is not set — the credentialed journey steps are the Lead's boundary"
            : "the sandbox-start journey did not produce an execution",
        owner: ctx.credentials === null ? OWNERS.leadCredentialed : OWNERS.leadPostDeployment,
      },
    });
  } else {
    const headers = {
      authorization: `Bearer ${ctx.credentials.token}`,
      "x-zeck-application": ctx.credentials.applicationId,
    };
    // The result package (IMPLEMENTATION.md §6) is the designed home of
    // the cost/usage facts — the projection over the durable ledger (the
    // receipt surface's wire contract carries the identity/status facts
    // only). The VALUES are honestly null until a governed writer
    // settles usage facts (the PPR-008 evidence record's wire
    // constraint) — the step verifies the projection is served and
    // honest, never a fabricated number.
    const fetched = await fetchSurface(
      new URL(
        `/executions/${encodeURIComponent(ctx.artifacts.executionId)}/results`,
        ctx.targetUrl,
      ).toString(),
      { headers },
    );
    let carriesCost = false;
    let observed = `answered ${fetched.evidence.status ?? "transport failure"}`;
    if (fetched.ok && fetched.evidence.status === 200) {
      try {
        const parsed = JSON.parse(fetched.body) as Record<string, unknown>;
        carriesCost = "cost" in parsed && "usage" in parsed;
        observed = carriesCost
          ? `the result package carries the cost/usage projection (cost: ${JSON.stringify(
              parsed.cost ?? null,
            )}, usage: ${JSON.stringify(parsed.usage ?? null)}${
              parsed.cost == null || parsed.usage == null
                ? " — honestly null until a governed writer settles usage facts"
                : ""
            })`
          : `the result package carries no cost/usage projection (keys: ${Object.keys(parsed)
              .slice(0, 12)
              .join(", ")})`;
      } catch {
        observed = "200 with a non-JSON body";
      }
    }
    recordStep(ctx, {
      id: "receipt-cost",
      title: "The result package carries the evidence and cost facts",
      surface: `GET /executions/${encodeURIComponent(ctx.artifacts.executionId)}/results`,
      status: carriesCost ? "pass" : "fail",
      evidence: fetched.evidence,
      observed,
      expected:
        "the result package carries the cost/usage projection over the ledger facts (honestly null until a governed writer settles usage)",
      ...(carriesCost ? {} : { defectClass: "route-boundary" }),
    });
  }
  await experienceStep(
    ctx,
    "usage-console",
    "The usage/economics console surface",
    "/console/applications/usage",
  );
}

// ---------------------------------------------------------------------------
// Journey 7 — validation rerun
// ---------------------------------------------------------------------------

async function journeyValidationRerun(ctx: HarnessContext): Promise<void> {
  await experienceStep(ctx, "validation-lab", "The Validation Lab surface", "/console/validation");
  await experienceStep(
    ctx,
    "validation-agent",
    "The agent-facing validation view",
    "/console/validation/agent",
  );
}

// ---------------------------------------------------------------------------
// Journey 8 — compare
// ---------------------------------------------------------------------------

async function journeyCompare(ctx: HarnessContext): Promise<void> {
  await experienceStep(ctx, "compare-console", "The compare surface", "/console/compare");
}

// ---------------------------------------------------------------------------
// Journey 9 — export/reproduce
// ---------------------------------------------------------------------------

async function journeyExportReproduce(ctx: HarnessContext): Promise<void> {
  const consoleState = await experienceStep(
    ctx,
    "export-console",
    "The reproducibility export surface",
    "/console/executions",
  );
  if (ctx.credentials !== null && ctx.artifacts.executionId !== null) {
    const id = encodeURIComponent(ctx.artifacts.executionId);
    if (consoleState === "not-run") {
      // The bundle is the EXPERIENCE surface's machine artifact (the
      // console composition's export route): when the plane serves no
      // experience composition the honest record is the not-run boundary
      // — same owner as every experience step (the deployed plane's run).
      recordStep(ctx, {
        id: "export-bundle",
        title: "The reproducibility bundle exports as verbatim JSON",
        surface: `/console/executions/${id}/export/bundle.json`,
        status: "not-run",
        evidence: null,
        observed:
          "no HTML experience composition is served by this plane — the bundle is the experience surface's machine artifact",
        expected: "the execution's reproducibility bundle exports",
        notRun: {
          reason:
            "the target serves no HTML experience composition (the export console's own step records the honest not-served fact); the bundle is served by the experience surface only",
          owner: OWNERS.leadPostDeployment,
        },
      });
      return;
    }
    const bundle = await auditSurface(ctx, `/console/executions/${id}/export/bundle.json`);
    const bundleOk =
      bundle.fetch.ok &&
      bundle.fetch.evidence.status === 200 &&
      (() => {
        try {
          JSON.parse(bundle.fetch.body);
          return true;
        } catch {
          return false;
        }
      })();
    recordStep(ctx, {
      id: "export-bundle",
      title: "The reproducibility bundle exports as verbatim JSON",
      surface: `/console/executions/${id}/export/bundle.json`,
      status: bundleOk ? "pass" : "fail",
      evidence: bundle.fetch.evidence,
      observed: bundle.fetch.ok
        ? `answered ${bundle.fetch.evidence.status} ${bundleOk ? "with a JSON bundle" : "(non-JSON body)"}`
        : `transport failure: ${bundle.fetch.evidence.transportError ?? "unknown"}`,
      expected: "the verbatim-JSON reproducibility bundle (the machine view plus recipe)",
      ...(bundleOk ? {} : { defectClass: "route-boundary" }),
    });
  } else {
    recordStep(ctx, {
      id: "export-bundle",
      title: "The reproducibility bundle exports as verbatim JSON",
      surface: "/console/executions/:id/export/bundle.json",
      status: "not-run",
      evidence: null,
      observed:
        ctx.credentials === null
          ? "no transport credential is configured for this run"
          : "no execution was created by the sandbox-start journey",
      expected: "the execution's reproducibility bundle exports",
      notRun: {
        reason:
          ctx.credentials === null
            ? "ZECK_JOURNEY_TOKEN is not set — the credentialed journey steps are the Lead's boundary"
            : "the sandbox-start journey did not produce an execution to export",
        owner: ctx.credentials === null ? OWNERS.leadCredentialed : OWNERS.leadPostDeployment,
      },
    });
  }
}

// ---------------------------------------------------------------------------
// Journey 10 — trust/limits
// ---------------------------------------------------------------------------

async function journeyTrustLimits(ctx: HarnessContext): Promise<void> {
  await experienceStep(ctx, "trust-evidence", "The trust evidence surface", "/trust/evidence");
  await experienceStep(ctx, "trust-limits-policies", "The policy surface", "/admin/policies");
  const quotas = await auditSurface(ctx, "/sandbox/quotas");
  const quotasOk = quotas.fetch.ok;
  recordStep(ctx, {
    id: "limits-envelope",
    title: "The limits envelope is reachable",
    surface: "/sandbox/quotas",
    status: quotasOk ? "pass" : "fail",
    evidence: quotas.fetch.evidence,
    observed: quotas.fetch.ok
      ? `answered ${quotas.fetch.evidence.status} ${errorCodeOf(quotas.fetch.body) || "(no code)"}`
      : `transport failure: ${quotas.fetch.evidence.transportError ?? "unknown"}`,
    expected: "the sandbox governance seam answers (200 bound or the honest 422 unbound)",
    ...(quotasOk ? {} : { defectClass: "route-boundary" }),
  });
}

// ---------------------------------------------------------------------------
// Journey 11 — agent onboarding
// ---------------------------------------------------------------------------

async function journeyAgentOnboarding(ctx: HarnessContext): Promise<void> {
  await experienceStep(
    ctx,
    "agent-quickstart",
    "The agent quickstart surface",
    "/console/quickstart",
  );
  // The machine-readable onboarding artifacts (repo-resident truth).
  const { harnessRepositoryRoot } = await import("./identity-gate");
  const { existsSync, readFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const root = harnessRepositoryRoot();
  const machineArtifacts = [
    "docs/developer/machine/openapi.json",
    "docs/developer/machine/capability-manifest.json",
    "docs/developer/machine/examples-manifest.json",
    "docs/developer/machine/env-vars.json",
    "docs/developer/machine/error-codes.json",
    "docs/developer/machine/integration-recipe.json",
    "docs/developer/machine/surface-boundaries.json",
  ];
  const missing: string[] = [];
  for (const artifact of machineArtifacts) {
    if (!existsSync(join(root, artifact))) {
      missing.push(artifact);
    } else {
      try {
        JSON.parse(readFileSync(join(root, artifact), "utf8"));
      } catch {
        missing.push(`${artifact} (present but not valid JSON)`);
      }
    }
  }
  recordStep(ctx, {
    id: "machine-artifacts",
    title: "The machine onboarding artifacts are present and parseable",
    surface: "docs/developer/machine/*.json",
    status: missing.length === 0 ? "pass" : "fail",
    evidence: null,
    observed:
      missing.length === 0
        ? `${machineArtifacts.length} machine artifacts present and JSON-parseable (validated against the wire contract by the kit's own suite)`
        : `missing/invalid: ${missing.join(", ")}`,
    expected: "every machine artifact exists and parses (the agent's onboarding truth)",
    ...(missing.length === 0 ? {} : { defectClass: "matrix-integrity" }),
  });
}

// ---------------------------------------------------------------------------
// Journey 12 — production/deployment
// ---------------------------------------------------------------------------

async function journeyProductionDeployment(ctx: HarnessContext): Promise<void> {
  // 1. The full public-route honest-boundary sweep (the public-smoke grammar).
  const problems: string[] = [];
  let authBoundary = 0;
  let capabilityUnbound = 0;
  let capabilitySeamUnbound = 0;
  let capabilitySeamMaterialized = 0;
  let publicArtifact = 0;
  for (const [index, probe] of ROUTE_PROBES.entries()) {
    const fetched = await fetchSurface(new URL(probe.path, ctx.targetUrl).toString(), {
      method: probe.method,
      headers: {
        authorization: "Bearer journey-probe",
        "x-zeck-application": "00000000-0000-0000-0000-000000000000",
        "idempotency-key": `journey-route-${index}`,
        ...(probe.body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(probe.body === undefined ? {} : { body: probe.body }),
    });
    if (!fetched.ok) {
      problems.push(
        `${probe.route}: the route did not answer (${fetched.evidence.transportError ?? "unknown"})`,
      );
      continue;
    }
    const problem = routeProbeProblem(
      probe,
      fetched.evidence.status ?? 0,
      errorCodeOf(fetched.body),
    );
    if (problem !== null) {
      problems.push(problem);
      continue;
    }
    if (probe.expect === "auth-boundary") {
      authBoundary += 1;
    } else if (probe.expect === "capability-unbound") {
      capabilityUnbound += 1;
    } else if (probe.expect === "capability-or-auth-boundary") {
      // Record WHICH composition class answered — the honest boundary is
      // composition-dependent (unbound 422 / materialized 401) and the
      // summary reports the observed composition fact.
      const composition = capabilitySeamComposition(
        fetched.evidence.status ?? 0,
        errorCodeOf(fetched.body),
      );
      if (composition === "unbound") {
        capabilitySeamUnbound += 1;
      } else if (composition === "materialized") {
        capabilitySeamMaterialized += 1;
      }
    } else {
      publicArtifact += 1;
    }
  }
  const capabilitySeamTotal = capabilitySeamUnbound + capabilitySeamMaterialized;
  recordStep(ctx, {
    id: "route-table",
    title: "Every public route answers its honest boundary",
    surface: "the public route table (26 routes)",
    status: problems.length === 0 ? "pass" : "fail",
    evidence: null,
    observed:
      problems.length === 0
        ? `${ROUTE_PROBES.length} routes probed: ${authBoundary} auth-boundary (401), ${capabilityUnbound} capability-unbound (422), ${capabilitySeamTotal} capability-or-auth-boundary (${capabilitySeamUnbound} unbound-composition 422 / ${capabilitySeamMaterialized} materialized-composition 401), ${publicArtifact} public-artifact (200)`
        : problems.slice(0, 5).join("; ") +
          (problems.length > 5 ? ` (+${problems.length - 5} more)` : ""),
    expected: "the honest boundary semantics of the deployed public route table",
    ...(problems.length === 0 ? {} : { defectClass: "route-boundary" }),
  });
  if (problems.length > 0) {
    raiseFinding(ctx, {
      step: "route-table",
      surface: "the public route table",
      observed: problems.slice(0, 5).join("; "),
      expected:
        "every public route answers its honest boundary (401 / 422 / the 200 public artifact)",
      severity: "major",
      defectClass: "route-boundary",
      evidence: `${problems.length} route probes deviated`,
      viableSolutions: [
        "restore the honest boundary semantics on the deviating routes (the route table is frozen — the composition must refuse, never fabricate)",
      ],
      recommendedSolution:
        "the deviating route's composition must answer its honest class again — no capability is ever fabricated to make a route appear usable; trade-off: none (this is the public contract)",
      verificationRequirement: "a re-run records every route probe at its honest boundary",
    });
  }

  // 2. The deployment documentation surfaces (repo-resident runbooks).
  const { harnessRepositoryRoot } = await import("./identity-gate");
  const { existsSync } = await import("node:fs");
  const { join } = await import("node:path");
  const root = harnessRepositoryRoot();
  const docs = ["deploy/PUBLIC-DEPLOYMENT.md", "deploy/README.md", "docs/developer/PRODUCTION.md"];
  const missing = docs.filter((doc) => !existsSync(join(root, doc)));
  recordStep(ctx, {
    id: "deployment-docs",
    title: "The production/deployment path documentation is present",
    surface: "deploy/PUBLIC-DEPLOYMENT.md (+ runbooks)",
    status: missing.length === 0 ? "pass" : "fail",
    evidence: null,
    observed:
      missing.length === 0
        ? "the public deployment runbook, the deploy README and the production guide are present"
        : `missing: ${missing.join(", ")}`,
    expected: "the deployment path is documented (the runbook the Lead's provisioning follows)",
    ...(missing.length === 0 ? {} : { defectClass: "matrix-integrity" }),
  });
}

/** The 12 journeys, in the work order's order (pinned by the contract test). */
export const JOURNEYS: readonly JourneyDefinition[] = Object.freeze([
  { id: "discover", title: "Discover Zeck", run: journeyDiscover },
  { id: "capability-discovery", title: "Discover capabilities", run: journeyCapabilityDiscovery },
  { id: "sandbox-start", title: "Start the sandbox safely", run: journeySandboxStart },
  { id: "first-text-execution", title: "First text execution", run: journeyFirstExecution },
  { id: "execution-inspection", title: "Inspect the execution", run: journeyInspection },
  { id: "evidence-cost", title: "Inspect evidence and cost", run: journeyEvidenceCost },
  { id: "validation-rerun", title: "Validation rerun", run: journeyValidationRerun },
  { id: "compare", title: "Compare", run: journeyCompare },
  { id: "export-reproduce", title: "Export / reproduce", run: journeyExportReproduce },
  { id: "trust-limits", title: "Trust and limits", run: journeyTrustLimits },
  { id: "agent-onboarding", title: "Agent onboarding", run: journeyAgentOnboarding },
  {
    id: "production-deployment",
    title: "Production / deployment path",
    run: journeyProductionDeployment,
  },
] as const);

/** Group the recorded steps into journey records (the report's shape). */
export function journeyRecordsOf(
  journeys: readonly JourneyDefinition[],
  steps: readonly import("./types").JourneyStepRecord[],
): readonly JourneyRecord[] {
  return journeys.map((journey) => ({
    id: journey.id,
    title: journey.title,
    steps: steps.filter((step) => step.journey === journey.id),
  }));
}
