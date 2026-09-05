/**
 * Deployment readiness model (D1.0 §16; Work Order WORK-042 AC6/AC9).
 *
 * DISTINCTION (the AC6 contract): control-plane availability and
 * dependency readiness are SEPARATE facts. The control plane is the
 * Zeck API surface itself; dependencies are the infrastructure
 * services behind the ports. A control plane can be up while its
 * dependencies are degraded, and that state is reported explicitly —
 * never as a single opaque "unhealthy".
 *
 * FAIL-CLOSED AUTHORITY (AC9 / D1.0 §17): the authoritative relational
 * dependency (PostgreSQL) must be READY or the whole plane is DOWN.
 * No secondary datastore is ever promoted; the degraded-mode table in
 * the provider manifest is the only permitted degradation vocabulary,
 * and only for non-authoritative dependencies.
 *
 * SECRET-FREE DIAGNOSTICS: probe details are free-form operationally,
 * so they are redacted before entering any report: URL credentials,
 * token-shaped substrings and authorization headers are replaced;
 * everything is length-capped. The report structure carries only
 * concerns, statuses, authority roles and degradation modes.
 */

import type { DeploymentManifest } from "./manifest";
import { providerForConcern } from "./manifest";

export type DependencyStatus = "ready" | "degraded" | "unavailable";

export type ReadinessOverall = "ready" | "degraded" | "down" | "unavailable";

export interface DependencyProbeResult {
  /** The infrastructure concern probed (must map to a declared provider). */
  readonly concern: string;
  readonly status: DependencyStatus;
  /** Operational detail (redacted before entering any report). */
  readonly detail?: string;
}

export interface DependencyReadiness {
  readonly concern: string;
  readonly provider: string;
  readonly authority: "authoritative" | "non-authoritative";
  readonly status: DependencyStatus;
  /** The explicit degraded mode from the provider manifest (degraded/unavailable, non-authoritative only). */
  readonly degradedMode: string | null;
  /** Redacted, length-capped operational detail. */
  readonly detail: string | null;
}

export interface ReadinessReport {
  readonly overall: ReadinessOverall;
  readonly controlPlane: "ready" | "unavailable";
  readonly dependencies: readonly DependencyReadiness[];
}

/** Detail redaction: credential-shaped substrings never enter a report. */
export function redactDetail(detail: string | undefined): string | null {
  if (detail === undefined) {
    return null;
  }
  const redacted = detail
    // URL-embedded credentials: scheme://user:password@host → scheme://[redacted]@host
    .replace(/([a-z][a-z0-9+.-]*:\/\/)([^\s/@:]+):([^\s/@]+)@/gi, "$1[redacted]@")
    // Token-shaped literals (common provider token prefixes).
    .replace(/\b(?:sk|pk|ghp|gho|xox[baprs]|AKIA)[A-Za-z0-9_-]{16,}\b/g, "[redacted]")
    // Bearer/authorization header values.
    .replace(
      /\b(bearer|authorization|token|secret|password|api[-_]?key)\b["'\s:=]+[A-Za-z0-9._~+/=-]{20,}/gi,
      "$1 [redacted]",
    )
    // Control characters are never diagnostics.
    // biome-ignore lint/suspicious/noControlCharactersInRegex: control-char stripping is the point.
    .replace(/[\u0000-\u001f\u007f]/g, " ");
  return redacted.slice(0, 200).trim();
}

/**
 * Evaluate deployment readiness from control-plane availability and
 * dependency probe results, against the manifest's provider map.
 *
 * Rules:
 * - every probe concern must map to a declared provider (fail closed);
 * - an authoritative dependency that is not READY ⇒ overall "down";
 * - a non-authoritative dependency not READY ⇒ overall "degraded" with
 *   the provider's explicit degraded mode;
 * - control plane unavailable ⇒ overall "unavailable" (the report may
 *   still be logged, but it cannot be served by the plane itself).
 */
export function evaluateReadiness(
  manifest: DeploymentManifest,
  input: { controlPlaneAvailable: boolean; probes: readonly DependencyProbeResult[] },
): ReadinessReport {
  const problems: string[] = [];
  const dependencies: DependencyReadiness[] = input.probes.map((probe) => {
    const provider = providerForConcern(manifest, probe.concern);
    if (provider === undefined) {
      problems.push(`probe concern "${probe.concern}" has no declared provider`);
    }
    const authority = provider?.degradation.authority ?? "non-authoritative";
    const nonAuthoritativeDegraded =
      probe.status !== "ready" && authority === "non-authoritative"
        ? (provider?.degradation.mode ?? "unspecified-degraded-mode")
        : null;
    return {
      concern: probe.concern,
      provider: provider?.id ?? "unknown",
      authority,
      status: probe.status,
      degradedMode: nonAuthoritativeDegraded,
      detail: redactDetail(probe.detail),
    };
  });
  if (problems.length > 0) {
    throw new Error(`readiness evaluation failed closed: ${problems.join("; ")}`);
  }

  const controlPlane: "ready" | "unavailable" = input.controlPlaneAvailable
    ? "ready"
    : "unavailable";

  const authoritativeDown = dependencies.some(
    (dependency) => dependency.authority === "authoritative" && dependency.status !== "ready",
  );
  const nonAuthoritativeDown = dependencies.some(
    (dependency) => dependency.authority !== "authoritative" && dependency.status !== "ready",
  );

  let overall: ReadinessOverall;
  if (!input.controlPlaneAvailable) {
    overall = "unavailable";
  } else if (authoritativeDown) {
    overall = "down";
  } else if (nonAuthoritativeDown) {
    overall = "degraded";
  } else {
    overall = "ready";
  }
  return { overall, controlPlane, dependencies };
}

/** The probe set an environment's resources imply (concerns, unique, manifest order). */
export function expectedProbeConcerns(
  manifest: DeploymentManifest,
  environment: string,
): readonly string[] {
  const resources = manifest.resources[environment as keyof typeof manifest.resources] ?? [];
  const concerns: string[] = [];
  for (const provider of manifest.providers) {
    if (resources.some((resource) => resource.concern === provider.concern)) {
      concerns.push(provider.concern);
    }
  }
  return concerns;
}

/** HTTP status for a readiness report served by the control plane. */
export function httpStatusForReadiness(report: ReadinessOverall): number {
  if (report === "down" || report === "unavailable") {
    return 503;
  }
  return 200;
}
