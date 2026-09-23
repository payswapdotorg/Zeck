/**
 * PPR-003 — the harness execution context: the step recorder, the
 * surface auditor (fetch + secret-scan + the cross-cutting dimension
 * checks) and the shared run state the 12 journeys compose through.
 *
 * Every step's evidence is the DEP-040 grammar: URL, method, status,
 * content type, body sha256, duration — digests, never raw bodies.
 * Findings quote only redacted excerpts. The harness never fixes
 * anything: a finding is the input to the next smallest-valid
 * correction Work Order.
 */

import type { EnvironmentId } from "../../src/platform/deployment/naming";
import {
  hasActiveNavSemantics,
  hasMainLandmark,
  hasPrimaryNav,
  hasSearchLandmark,
  hasSkipLink,
  hasViewportMeta,
  internalLinksOf,
  isHtmlSurface,
  resourceUrlsOf,
  responsivePlanOf,
} from "./dom";
import { fetchSurface, type SurfaceFetch } from "./http";
import { scanForSecrets } from "./secret-safety";
import type {
  DimensionOutcome,
  Finding,
  FindingSeverity,
  JourneyStepRecord,
  StepEvidence,
  StepStatus,
} from "./types";

/** The harness's transport credentials (names carried in env, values never rendered). */
export interface HarnessCredentials {
  readonly token: string;
  readonly applicationId: string;
}

/** The shared run state (journey artifacts flow forward in order). */
export interface HarnessContext {
  readonly targetUrl: string;
  readonly environment: EnvironmentId;
  readonly allowDegraded: boolean;
  readonly credentials: HarnessCredentials | null;
  /** The current journey (id + title) the recorder attributes steps to. */
  journey: { id: string; title: string };
  readonly steps: JourneyStepRecord[];
  readonly findings: Finding[];
  /** The 22-family coverage matrix (one derivation, shared with the report). */
  matrix: import("./types").CapabilityMatrixRow[];
  /** Artifacts the journeys hand forward (the execution of the sandbox path). */
  artifacts: {
    executionId: string | null;
    executionTerminalStatus: string | null;
    verificationOutcome: string | null;
  };
}

export function createContext(options: {
  readonly targetUrl: string;
  readonly environment: EnvironmentId;
  readonly allowDegraded: boolean;
  readonly credentials: HarnessCredentials | null;
}): HarnessContext {
  return {
    targetUrl: options.targetUrl,
    environment: options.environment,
    allowDegraded: options.allowDegraded,
    credentials: options.credentials,
    journey: { id: "preflight", title: "Preflight" },
    steps: [],
    findings: [],
    matrix: [],
    artifacts: {
      executionId: null,
      executionTerminalStatus: null,
      verificationOutcome: null,
    },
  };
}

/** Record one step (the only path into the report's step list). */
export function recordStep(
  ctx: HarnessContext,
  step: {
    readonly id: string;
    readonly title: string;
    readonly surface: string;
    readonly status: StepStatus;
    readonly evidence?: StepEvidence | null;
    readonly observed: string;
    readonly expected: string;
    readonly defectClass?: string;
    readonly notRun?: { readonly reason: string; readonly owner: string };
    readonly dimensions?: readonly DimensionOutcome[];
  },
): void {
  ctx.steps.push({
    id: step.id,
    journey: ctx.journey.id,
    title: step.title,
    surface: step.surface,
    status: step.status,
    evidence: step.evidence ?? null,
    observed: step.observed,
    expected: step.expected,
    ...(step.defectClass === undefined ? {} : { defectClass: step.defectClass }),
    ...(step.notRun === undefined ? {} : { notRun: step.notRun }),
    ...(step.dimensions === undefined || step.dimensions.length === 0
      ? {}
      : { dimensions: step.dimensions }),
  });
}

/** Raise a finding (the full work-order contract — every field mandatory). */
export function raiseFinding(
  ctx: HarnessContext,
  finding: {
    readonly step: string;
    readonly surface: string;
    readonly observed: string;
    readonly expected: string;
    readonly severity: FindingSeverity;
    readonly defectClass: string;
    readonly evidence: string;
    readonly viableSolutions: readonly string[];
    readonly recommendedSolution: string;
    readonly verificationRequirement: string;
  },
): void {
  ctx.findings.push({
    journey: ctx.journey.id,
    step: finding.step,
    surface: finding.surface,
    observed: finding.observed,
    expected: finding.expected,
    severity: finding.severity,
    defectClass: finding.defectClass,
    evidence: finding.evidence,
    viableSolutions: finding.viableSolutions,
    recommendedSolution: finding.recommendedSolution,
    verificationRequirement: finding.verificationRequirement,
  });
}

/** The shared finding template for a failed dimension (the correction-WO input). */
export function dimensionFinding(
  ctx: HarnessContext,
  stepId: string,
  surface: string,
  dimension: string,
  observed: string,
  defectClass: string,
  evidence: string,
): void {
  raiseFinding(ctx, {
    step: stepId,
    surface,
    observed,
    expected: `the served experience surface carries the structural ${dimension} affordance`,
    severity: "minor",
    defectClass,
    evidence,
    viableSolutions: [
      `correct the ${dimension} gap in the experience surface's shell (the structural contract, not the layout)`,
      `if the gap is intentional for this surface, record the exception in the console's own a11y/responsive contract and update this harness's expectation in the same change`,
    ],
    recommendedSolution: `${observed} — the smallest valid correction is a shell-level fix (the affordance is rendered by the shared page shell, so one correction covers every page that renders it); trade-off: none for the structural contract, but the fix must land on the console's current branch (PPR-001 is reorganizing the console in parallel)`,
    verificationRequirement: `re-run this harness against the deployed URL: the ${dimension} dimension of ${surface} must record pass`,
  });
}

/** The secret-exposure finding (blocker — the recorded URL-hygiene class). */
export function secretExposureFinding(
  ctx: HarnessContext,
  stepId: string,
  surface: string,
  patternName: string,
  redactedShape: string,
  evidence: string,
): void {
  raiseFinding(ctx, {
    step: stepId,
    surface,
    observed: `a secret-shaped value (${patternName}) appeared in the served surface: ${redactedShape}`,
    expected: "no secret value is ever served (names, never values — the disclosure rules)",
    severity: "blocker",
    defectClass: "secret-exposure",
    evidence,
    viableSolutions: [
      "remove the secret value from the serving surface and rotate the exposed credential (a leaked value is compromised regardless of removal)",
      "audit how the value reached the surface (rendering path, configuration projection, or an artifact) and close that path",
    ],
    recommendedSolution:
      "rotate-then-remove: the credential must be treated as compromised (rotation first), then the serving path corrected so the value cannot reappear; trade-off: rotation requires operator action the harness cannot perform",
    verificationRequirement:
      "re-run this harness: the secret-safety dimension must record clean for the affected surface, and the harness's own report self-scan must stay clean",
  });
}

/** The audited surface (fetch + the cross-cutting dimension outcomes). */
export interface AuditedSurface {
  readonly fetch: SurfaceFetch;
  readonly isHtml: boolean;
  readonly dimensions: readonly DimensionOutcome[];
  /** The redacted secret matches (never the values). */
  readonly secretMatches: readonly {
    readonly patternName: string;
    readonly redactedShape: string;
  }[];
}

/** The maximum resource/navigation link probes per page (bounded, bounded, bounded). */
const MAX_RESOURCE_PROBES = 12;
const MAX_NAVIGATION_PROBES = 20;

/**
 * Fetch a surface and run every cross-cutting dimension over it:
 * secret safety (every body), and — for HTML experience surfaces —
 * keyboard/focus structure, the responsive plan, reduced motion, the
 * console-error signal (resource integrity) and navigation.
 */
export async function auditSurface(
  ctx: HarnessContext,
  path: string,
  options: {
    readonly method?: string;
    readonly headers?: Record<string, string>;
    readonly body?: string;
  } = {},
): Promise<AuditedSurface> {
  const url = new URL(path, ctx.targetUrl).toString();
  const fetched = await fetchSurface(url, options);
  return auditFetchedSurface(ctx, url, fetched);
}

/**
 * Run the full cross-cutting audit over an ALREADY-FETCHED surface
 * (PPR-011: the landing chain's terminal fetch is audited here so the
 * landed surface gets the exact audit a directly-fetched landing gets,
 * without a second request for the same surface).
 */
export async function auditFetchedSurface(
  ctx: HarnessContext,
  url: string,
  fetched: SurfaceFetch,
): Promise<AuditedSurface> {
  const dimensions: DimensionOutcome[] = [];

  if (!fetched.ok) {
    return { fetch: fetched, isHtml: false, dimensions, secretMatches: [] };
  }

  // Secret safety — EVERY served body, HTML or not.
  const secretMatches = scanForSecrets(fetched.body);
  if (secretMatches.length > 0) {
    dimensions.push({
      dimension: "secret-safety",
      status: "fail",
      observed: secretMatches
        .map((match) => `${match.patternName} (${match.redactedShape})`)
        .join("; "),
      defectClass: "secret-exposure",
    });
  }

  const html = isHtmlSurface(fetched.evidence.contentType, fetched.body);
  if (html) {
    dimensions.push(...(await htmlDimensions(ctx, url, fetched.body)));
  }
  return { fetch: fetched, isHtml: html, dimensions, secretMatches };
}

/** The HTML-surface dimensions (structural, layout-independent by design). */
async function htmlDimensions(
  _ctx: HarnessContext,
  url: string,
  body: string,
): Promise<readonly DimensionOutcome[]> {
  const outcomes: DimensionOutcome[] = [];

  // keyboard/focus structure.
  const keyboardOk =
    hasSkipLink(body) &&
    hasMainLandmark(body) &&
    hasPrimaryNav(body) &&
    hasActiveNavSemantics(body);
  outcomes.push({
    dimension: "keyboard/focus",
    status: keyboardOk ? "pass" : "fail",
    observed: keyboardOk
      ? "skip link, main landmark, primary nav and aria-current active semantics present"
      : `structural keyboard/focus affordances incomplete (skip link: ${hasSkipLink(body)}, main landmark: ${hasMainLandmark(body)}, primary nav: ${hasPrimaryNav(body)}, aria-current: ${hasActiveNavSemantics(body)}, search landmark: ${hasSearchLandmark(body)}, viewport meta: ${hasViewportMeta(body)})`,
    ...(keyboardOk ? {} : { defectClass: "accessibility-structure" }),
  });

  // responsive plan (desktop/tablet/mobile) — the served CSS markers.
  const plan = responsivePlanOf(body);
  const responsiveOk = plan.mobile && plan.tabletOrDesktop;
  outcomes.push({
    dimension: "desktop/tablet/mobile",
    status: responsiveOk ? "pass" : "fail",
    observed: responsiveOk
      ? "mobile and tablet/desktop media-query classes present in the served CSS"
      : `responsive plan incomplete (mobile breakpoint: ${plan.mobile}, tablet/desktop breakpoint: ${plan.tabletOrDesktop}, viewport meta: ${hasViewportMeta(body)})`,
    ...(responsiveOk ? {} : { defectClass: "responsive-plan" }),
  });

  // reduced motion.
  outcomes.push({
    dimension: "reduced-motion",
    status: plan.reducedMotion ? "pass" : "fail",
    observed: plan.reducedMotion
      ? "prefers-reduced-motion rule present in the served CSS"
      : "no prefers-reduced-motion rule in the served CSS",
    ...(plan.reducedMotion ? {} : { defectClass: "reduced-motion" }),
  });

  // console-error signal (resource integrity — the HTTP-observable part).
  const resources = resourceUrlsOf(body, url).slice(0, MAX_RESOURCE_PROBES);
  const broken: string[] = [];
  for (const resource of resources) {
    const probed = await fetchSurface(resource);
    if (!probed.ok || probed.evidence.status === null || probed.evidence.status >= 400) {
      broken.push(`${resource} → ${probed.evidence.status ?? "transport failure"}`);
    }
  }
  outcomes.push({
    dimension: "browser-console-errors (resource integrity)",
    status: broken.length === 0 ? "pass" : "fail",
    observed:
      broken.length === 0
        ? `${resources.length} referenced resources all answered 2xx/3xx`
        : `broken referenced resources: ${broken.join(", ")}`,
    ...(broken.length === 0 ? {} : { defectClass: "console-error-signal" }),
  });

  // navigation (the internal link graph answers).
  const links = internalLinksOf(body, url).slice(0, MAX_NAVIGATION_PROBES);
  const deadLinks: string[] = [];
  for (const link of links) {
    const probed = await fetchSurface(link);
    if (!probed.ok || probed.evidence.status === null || probed.evidence.status >= 500) {
      deadLinks.push(`${link} → ${probed.evidence.status ?? "transport failure"}`);
    }
  }
  outcomes.push({
    dimension: "navigation",
    status: deadLinks.length === 0 ? "pass" : "fail",
    observed:
      deadLinks.length === 0
        ? `${links.length} internal navigation targets all answered < 500`
        : `dead navigation targets: ${deadLinks.join(", ")}`,
    ...(deadLinks.length === 0 ? {} : { defectClass: "navigation" }),
  });

  return outcomes;
}

/** Fold dimension failures into findings for a step's surface. */
export function raiseDimensionFindings(
  ctx: HarnessContext,
  stepId: string,
  url: string,
  audited: AuditedSurface,
): void {
  const evidence = audited.fetch.evidence;
  const evidenceText = `status ${evidence.status ?? "?"}, body sha256 ${evidence.bodySha256 ?? "?"}, durationMs ${evidence.durationMs}`;
  for (const match of audited.secretMatches) {
    secretExposureFinding(ctx, stepId, url, match.patternName, match.redactedShape, evidenceText);
  }
  for (const outcome of audited.dimensions) {
    if (outcome.status !== "fail" || outcome.defectClass === "secret-exposure") {
      continue;
    }
    dimensionFinding(
      ctx,
      stepId,
      url,
      outcome.dimension,
      outcome.observed,
      outcome.defectClass ?? "harness-internal",
      evidenceText,
    );
  }
}

/** The standard not-run owner vocabulary (the harness's fixed boundaries). */
export const OWNERS = {
  leadPostDeployment:
    "Lead post-deployment run (point the harness at the deployed public URL + the exact revision)",
  leadCredentialed: "Lead credentialed re-run (transport credential for the public preview)",
  leadBrowserPass:
    "Lead post-deployment browser pass (a real browser session; the harness's HTTP-observable proxies are recorded here)",
} as const;
