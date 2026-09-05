/**
 * Deployment health/readiness route (WORK-042 AC6; D1.0 §16).
 *
 * THE CONTROL-PLANE/DEPENDENCY DISTINCTION, ON THE WIRE: this route
 * answering at all is the control-plane availability fact; the
 * dependency readiness facts arrive through the injected probe seam
 * (`dependencyReadiness`). The two are reported SEPARATELY — never as
 * one opaque health bit.
 *
 * FAIL-CLOSED AUTHORITY: a dependency carrying the authoritative role
 * that is not READY makes the whole plane DOWN (503). Non-authoritative
 * dependencies degrade the plane explicitly (200 with status
 * "degraded" and the dependency's degraded mode) — never silently
 * healthy, never silently down.
 *
 * SECRET-FREE: the response is scrubbed (secret-shaped keys AND
 * credential-shaped value substrings in free-form details). A probe
 * that fails is reported fail-closed without internals.
 *
 * TRANSPORT ONLY: the readiness computation itself is not transport's
 * business — composition injects the probe (the platform readiness
 * evaluator is wired by the composition root; see
 * src/platform/deployment/readiness.ts).
 */

import type { FastifyInstance } from "fastify";
import { scrubSecretShapedKeys } from "../serialization";

export type DependencyStatusWire = "ready" | "degraded" | "unavailable";

export interface DependencyReadinessWire {
  /** Infrastructure concern name (e.g. "relational-state"). */
  readonly name: string;
  readonly authority: "authoritative" | "non-authoritative";
  readonly status: DependencyStatusWire;
  /** Explicit degraded mode for non-authoritative, not-ready dependencies. */
  readonly degradedMode?: string;
  /** Operational detail (scrubbed before crossing the wire). */
  readonly detail?: string | null;
}

export interface HealthRoutesDeps {
  /** The injected dependency readiness probe (composition-owned). */
  readonly dependencyReadiness: () => Promise<readonly DependencyReadinessWire[]>;
}

interface HealthResponse {
  readonly status: "ready" | "degraded" | "down";
  readonly controlPlane: "ready";
  readonly dependencies: readonly unknown[];
}

/** Credential-shaped substrings never cross the health wire (value level). */
function redactDetailWire(detail: string | null | undefined): string | null {
  if (typeof detail !== "string") {
    return null;
  }
  return (
    detail
      .replace(/([a-z][a-z0-9+.-]*:\/\/)([^\s/@:]+):([^\s/@]+)@/gi, "$1[redacted]@")
      .replace(/\b(?:sk|pk|ghp|gho|xox[baprs]|AKIA)[A-Za-z0-9_-]{16,}\b/g, "[redacted]")
      .replace(
        /\b(bearer|authorization|token|secret|password|api[-_]?key)\b["'\s:=]+[A-Za-z0-9._~+/=-]{20,}/gi,
        "$1 [redacted]",
      )
      // biome-ignore lint/suspicious/noControlCharactersInRegex: control-char stripping is the point.
      .replace(/[\u0000-\u001f\u007f]/g, " ")
      .slice(0, 200)
      .trim()
  );
}

function wireDependency(dependency: DependencyReadinessWire): Record<string, unknown> {
  return {
    name: dependency.name,
    authority: dependency.authority,
    status: dependency.status,
    ...(dependency.degradedMode === undefined ? {} : { degradedMode: dependency.degradedMode }),
    ...(dependency.detail === undefined ? {} : { detail: redactDetailWire(dependency.detail) }),
  };
}

export function registerHealthRoutes(app: FastifyInstance, deps: HealthRoutesDeps): void {
  app.get("/health", async (_request, reply) => {
    let dependencies: readonly DependencyReadinessWire[];
    try {
      dependencies = await deps.dependencyReadiness();
    } catch {
      // The probe itself failed: readiness is UNATTESTABLE — fail closed,
      // no internals leaked.
      const body: HealthResponse = {
        status: "down",
        controlPlane: "ready",
        dependencies: [],
      };
      return await reply.code(503).send(body);
    }
    const scrubbed = dependencies
      .map(wireDependency)
      .map((entry) => scrubSecretShapedKeys(entry) as Record<string, unknown>);
    const authoritativeDown = dependencies.some(
      (dependency) => dependency.authority === "authoritative" && dependency.status !== "ready",
    );
    const anyDegraded = dependencies.some((dependency) => dependency.status !== "ready");
    const body: HealthResponse = {
      status: authoritativeDown ? "down" : anyDegraded ? "degraded" : "ready",
      controlPlane: "ready",
      dependencies: scrubbed,
    };
    return await reply.code(authoritativeDown ? 503 : 200).send(body);
  });
}
