/**
 * Deployment store port (deployments module outbound; WORK-023).
 *
 * The durable-state seam for profiles, plans, deployments and the
 * lifecycle journal (migration 0012). The arbitration contract (the
 * WORK-011/012/017 discipline):
 *
 *   - profiles/plans converge on their (application, identity,
 *     version) UNIQUE keys: an identical body (same digest) converges
 *     (replay); a different body under the same identity+version
 *     fails closed (artifacts are immutable once published);
 *   - deployment creation converges on (application, idempotency
 *     key) with fingerprint arbitration;
 *   - lifecycle mutations are GUARDED: the store takes the expected
 *     current state (status and, for plan moves, the prior plan
 *     version) and the physical single-row update arbitrates
 *     concurrent duplicates — first writer wins, duplicates converge
 *     on the committed row (INVALID_STATE_TRANSITION surfaces
 *     disagreement for the caller to re-read);
 *   - the journal is APPEND-ONLY, identity-ordered (event_seq), and
 *     the same idempotency key converges (UNIQUE) — a retried
 *     lifecycle request replays the committed event;
 *   - every read is scope-filtered (application); tenant identity is
 *     carried on every row and never dropped.
 */

import type { DeploymentEventRecord } from "../domain/deployment";
import type { DeploymentPlan, DeploymentPlanInput } from "../domain/plan";
import type { DeploymentProfile, DeploymentProfileInput } from "../domain/profile";

export interface ProfileInsertInput {
  readonly profile: Omit<DeploymentProfile, "digest" | "createdAt">;
  readonly digest: string;
}

export type ProfileInsertOutcome =
  | { readonly status: "published"; readonly profile: DeploymentProfile }
  /** The identical body at the same (identity, version) already exists. */
  | { readonly status: "converged"; readonly profile: DeploymentProfile };

export interface PlanInsertInput {
  readonly plan: Omit<DeploymentPlan, "digest" | "createdAt">;
  readonly digest: string;
}

export type PlanInsertOutcome =
  | { readonly status: "published"; readonly plan: DeploymentPlan }
  | { readonly status: "converged"; readonly plan: DeploymentPlan };

export interface DeploymentInsertInput {
  readonly deploymentId: string;
  readonly applicationId: string;
  readonly tenantId: string;
  readonly slug: string;
  readonly name: string;
  readonly description: string | null;
  readonly environmentId: string;
  readonly agentId: string;
  readonly agentVersion: string;
  readonly agentKind: "zeck" | "byoa";
  readonly initialPlanId: string;
  readonly initialPlanVersion: number;
  readonly creationFingerprint: string;
  readonly createdBy: string;
  readonly idempotencyKey: string;
  readonly createdAt: string;
}

export type DeploymentInsertOutcome =
  | { readonly status: "created"; readonly deploymentId: string }
  | { readonly status: "converged"; readonly deploymentId: string };

export interface JournalAppendInput {
  readonly eventId: string;
  readonly applicationId: string;
  readonly tenantId: string;
  readonly deploymentId: string;
  readonly kind: import("../domain/deployment").DeploymentEventKind;
  readonly actorId: string;
  readonly cause: string | null;
  readonly priorPlanVersion: number | null;
  readonly currentPlanVersion: number | null;
  readonly executionId: string | null;
  readonly idempotencyKey: string;
  readonly createdAt: string;
}

export interface GuardedMutation {
  readonly applicationId: string;
  readonly deploymentId: string;
  /** The expected CURRENT status (the guard). */
  readonly expectedStatus: import("../domain/deployment").DeploymentStatus;
  /** For plan moves: the expected current plan version (the guard). */
  readonly expectedPlanVersion: number | null;
  /** The target status after the mutation (usually unchanged). */
  readonly toStatus: import("../domain/deployment").DeploymentStatus;
  /** For plan moves: the target plan id + version. */
  readonly toPlanId: string | null;
  readonly toPlanVersion: number | null;
  /** Whether the revision counter advances (plan moves). */
  readonly advanceRevision: boolean;
}

export interface DeploymentStore {
  // ---- immutable artifacts ----
  insertProfile(input: ProfileInsertInput): Promise<ProfileInsertOutcome>;
  findProfile(
    applicationId: string,
    profileId: string,
    version: number,
  ): Promise<DeploymentProfile | null>;
  listProfileVersions(
    applicationId: string,
    profileId: string,
  ): Promise<readonly DeploymentProfile[]>;
  insertPlan(input: PlanInsertInput): Promise<PlanInsertOutcome>;
  findPlan(applicationId: string, planId: string, version: number): Promise<DeploymentPlan | null>;
  listPlanVersions(applicationId: string, planId: string): Promise<readonly DeploymentPlan[]>;

  // ---- deployments + journal ----
  insertDeployment(input: DeploymentInsertInput): Promise<DeploymentInsertOutcome>;
  findDeployment(
    applicationId: string,
    deploymentId: string,
  ): Promise<
    | (Pick<
        import("../domain/deployment").DeploymentRecord,
        | "id"
        | "applicationId"
        | "tenantId"
        | "environmentId"
        | "agentId"
        | "agentVersion"
        | "agentKind"
        | "slug"
        | "name"
        | "description"
        | "status"
        | "currentPlanId"
        | "currentPlanVersion"
        | "revision"
        | "createdAt"
        | "updatedAt"
      > & { readonly creationFingerprint: string })
    | null
  >;
  findDeploymentBySlug(
    applicationId: string,
    slug: string,
  ): Promise<{ readonly id: string } | null>;
  listDeployments(
    applicationId: string,
  ): Promise<readonly { readonly id: string; readonly slug: string; readonly status: string }[]>;
  /**
   * Apply one guarded lifecycle mutation to the deployment row (the
   * single-row arbitration; first writer wins, concurrent duplicates
   * converge on the committed row).
   */
  applyGuardedMutation(
    input: GuardedMutation,
  ): Promise<
    | { readonly status: "applied"; readonly revision: number }
    | { readonly status: "converged"; readonly revision: number }
  >;
  /** Append one lifecycle event (idempotent by key; identity-ordered). */
  appendJournalEvent(input: JournalAppendInput): Promise<DeploymentEventRecord>;
  /** The journal of one deployment in append order. */
  listEvents(
    applicationId: string,
    deploymentId: string,
  ): Promise<readonly DeploymentEventRecord[]>;
}

/** Re-exported input types for composition convenience. */
export type { DeploymentPlanInput, DeploymentProfileInput };
