/**
 * Execution resume resource re-admission adapter (sandbox module; WORK-028,
 * LNG-003 / acceptance criterion 4 — the sandbox compute-environment
 * re-consultation seam).
 *
 * Implements the executions module's `ResourceReAdmission` port (the
 * executions PUBLIC barrel — the WORK-012 `execution-ledger` adapter
 * precedent: type coupling to the owner's barrel only) against the REAL
 * sandbox module surfaces:
 *
 *   * the ENVIRONMENT CATALOG (WORK-012): a materially changed resume
 *     that binds a compute environment must find it in the CURRENT
 *     catalog, in the `available` lifecycle state (suspended/retired
 *     environments admit nothing — the catalog's own admission
 *     contract), and — when the resume carries an
 *     `environmentSpecDigest` — matching the CURRENT specification
 *     digest (a re-registered environment specification is a STALE
 *     admission and fails closed, never silently re-pins);
 *   * the SANDBOX ADMIPTION CHAIN (REQUIRED seam, the WORK-012
 *     policy/capability/budget chain): the CURRENT environment record's
 *     declared facts (kind + hosts + secretRefs) are re-submitted through
 *     the CURRENT admission authority state — a materially changed
 *     resume re-enters the live admission chain, not a snapshot.
 *
 * The adapter holds no decision logic of its own; it maps facts and
 * delegates (the seam-adapter discipline). `requiredCapabilities` /
 * `resourceClass` are the executions-side materiality vocabulary — they
 * are structural fields of the checkpoint contract validated by the
 * executions domain; the sandbox axis re-admits through the environment's
 * CURRENT declared facts (the capability requirement of the environment
 * is part of its immutable, digest-bound specification).
 */

import type { ResourceReAdmission } from "../../executions/public";
import { kindExecutes } from "../domain/environment";
import type { ComputeEnvironmentRecord, EnvironmentCatalog, SandboxAdmission } from "../public";

export function createExecutionResumeReadmission(
  catalog: EnvironmentCatalog,
  admission: SandboxAdmission,
): ResourceReAdmission {
  return {
    async readmit(request) {
      const facts = request.resumeFacts;
      if (facts.environmentId === null) {
        // No compute binding: the sandbox axis has nothing to re-admit
        // (the policy/budget axes own this resume).
        return { allowed: true };
      }
      const environment: ComputeEnvironmentRecord | null = await catalog.get(
        request.execution.applicationId,
        facts.environmentId,
      );
      if (environment === null) {
        return {
          allowed: false,
          reason: `the resume binds compute environment ${facts.environmentId}, which does not exist in the current catalog`,
          denialCode: "CAPABILITY_UNAVAILABLE",
        };
      }
      if (environment.status !== "available") {
        return {
          allowed: false,
          reason: `the resume binds compute environment ${environment.slug}, which is ${environment.status} (suspended/retired environments admit nothing)`,
          denialCode: "CAPABILITY_UNAVAILABLE",
        };
      }
      if (
        facts.environmentSpecDigest !== null &&
        facts.environmentSpecDigest !== environment.specDigest
      ) {
        return {
          allowed: false,
          reason:
            "the resume pins an outdated environment specification digest (the environment was re-registered under a different specification; stale admissions fail closed)",
          denialCode: "CAPABILITY_UNAVAILABLE",
        };
      }
      // The CURRENT admission chain re-consultation: the live record's
      // declared facts through the live authority state.
      const decision = await admission.admit({
        tenantId: request.execution.tenantId,
        applicationId: request.execution.applicationId,
        executionId: request.execution.id,
        kind: environment.kind,
        hosts: kindExecutes(environment.kind) ? environment.spec.network.allowedHosts : [],
        secretRefs: kindExecutes(environment.kind) ? environment.spec.secrets.secretRefs : [],
      });
      if (!decision.allowed) {
        return {
          allowed: false,
          reason: decision.reason,
          denialCode: "CAPABILITY_UNAVAILABLE",
        };
      }
      return { allowed: true };
    },
  };
}
