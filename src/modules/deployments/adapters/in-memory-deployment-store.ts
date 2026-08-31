/**
 * In-memory deployment store (deployments module adapter; WORK-023).
 *
 * The test/world implementation of the `DeploymentStore` port with the
 * SAME arbitration contract as the SQL store.
 */

import { PlatformError } from "../../../shared/errors";
import type {
  DeploymentEventKind,
  DeploymentEventRecord,
  DeploymentStatus,
} from "../domain/deployment";
import { canTransitionDeployment } from "../domain/deployment";
import type { DeploymentPlan } from "../domain/plan";
import type { DeploymentProfile } from "../domain/profile";
import type {
  DeploymentInsertInput,
  DeploymentInsertOutcome,
  DeploymentStore,
  GuardedMutation,
  JournalAppendInput,
  PlanInsertInput,
  PlanInsertOutcome,
  ProfileInsertInput,
  ProfileInsertOutcome,
} from "../ports/deployment-store";

interface MemoryDeployment {
  readonly id: string;
  readonly applicationId: string;
  readonly tenantId: string;
  readonly environmentId: string;
  readonly agentId: string;
  readonly agentVersion: string;
  readonly agentKind: "zeck" | "byoa";
  readonly slug: string;
  readonly name: string;
  readonly description: string | null;
  status: DeploymentStatus;
  currentPlanId: string;
  currentPlanVersion: number;
  revision: number;
  readonly creationFingerprint: string;
  readonly createdAt: string;
  updatedAt: string;
}

export class InMemoryDeploymentStore implements DeploymentStore {
  private readonly profiles = new Map<string, DeploymentProfile>();
  private readonly plans = new Map<string, DeploymentPlan>();
  private readonly deployments = new Map<string, MemoryDeployment>();
  private readonly bySlug = new Map<string, string>();
  private readonly events: DeploymentEventRecord[] = [];
  private seq = 0;

  private profileKey(applicationId: string, profileId: string, version: number): string {
    return `${applicationId}:${profileId}:${version}`;
  }

  private planKey(applicationId: string, planId: string, version: number): string {
    return `${applicationId}:${planId}:${version}`;
  }

  private deploymentKey(applicationId: string, deploymentId: string): string {
    return `${applicationId}:${deploymentId}`;
  }

  async insertProfile(input: ProfileInsertInput): Promise<ProfileInsertOutcome> {
    const key = this.profileKey(
      input.profile.applicationId,
      input.profile.profileId,
      input.profile.version,
    );
    const existing = this.profiles.get(key);
    if (existing !== undefined) {
      if (existing.digest !== input.digest) {
        throw new PlatformError({
          code: "IDEMPOTENCY_KEY_REUSED",
          message: "profile version already exists with a different body",
        });
      }
      return { status: "converged", profile: existing };
    }
    const profile: DeploymentProfile = {
      ...input.profile,
      digest: input.digest,
      createdAt: new Date().toISOString(),
    };
    this.profiles.set(key, profile);
    return { status: "published", profile };
  }

  async findProfile(applicationId: string, profileId: string, version: number) {
    return this.profiles.get(this.profileKey(applicationId, profileId, version)) ?? null;
  }

  async listProfileVersions(applicationId: string, profileId: string) {
    return [...this.profiles.values()]
      .filter((p) => p.applicationId === applicationId && p.profileId === profileId)
      .sort((a, b) => a.version - b.version);
  }

  async insertPlan(input: PlanInsertInput): Promise<PlanInsertOutcome> {
    const key = this.planKey(input.plan.applicationId, input.plan.planId, input.plan.version);
    const existing = this.plans.get(key);
    if (existing !== undefined) {
      if (existing.digest !== input.digest) {
        throw new PlatformError({
          code: "IDEMPOTENCY_KEY_REUSED",
          message: "plan version already exists with a different body",
        });
      }
      return { status: "converged", plan: existing };
    }
    const plan: DeploymentPlan = {
      ...input.plan,
      digest: input.digest,
      createdAt: new Date().toISOString(),
    };
    this.plans.set(key, plan);
    return { status: "published", plan };
  }

  async findPlan(applicationId: string, planId: string, version: number) {
    return this.plans.get(this.planKey(applicationId, planId, version)) ?? null;
  }

  async listPlanVersions(applicationId: string, planId: string) {
    return [...this.plans.values()]
      .filter((p) => p.applicationId === applicationId && p.planId === planId)
      .sort((a, b) => a.version - b.version);
  }

  async insertDeployment(input: DeploymentInsertInput): Promise<DeploymentInsertOutcome> {
    const slugKey = `${input.applicationId}:${input.slug}`;
    const existingId = this.bySlug.get(slugKey);
    if (existingId !== undefined) {
      const existing = this.deployments.get(this.deploymentKey(input.applicationId, existingId));
      if (existing !== undefined && existing.creationFingerprint === input.creationFingerprint) {
        return { status: "converged", deploymentId: existing.id };
      }
      throw new PlatformError({
        code: "IDEMPOTENCY_KEY_REUSED",
        message: "deployment slug already exists with a different creation fingerprint",
      });
    }
    const deployment: MemoryDeployment = {
      id: input.deploymentId,
      applicationId: input.applicationId,
      tenantId: input.tenantId,
      environmentId: input.environmentId,
      agentId: input.agentId,
      agentVersion: input.agentVersion,
      agentKind: input.agentKind,
      slug: input.slug,
      name: input.name,
      description: input.description,
      status: "active",
      currentPlanId: input.initialPlanId,
      currentPlanVersion: input.initialPlanVersion,
      revision: 0,
      creationFingerprint: input.creationFingerprint,
      createdAt: input.createdAt,
      updatedAt: input.createdAt,
    };
    this.deployments.set(this.deploymentKey(input.applicationId, deployment.id), deployment);
    this.bySlug.set(slugKey, deployment.id);
    return { status: "created", deploymentId: deployment.id };
  }

  async findDeployment(applicationId: string, deploymentId: string) {
    const d = this.deployments.get(this.deploymentKey(applicationId, deploymentId));
    if (d === undefined) return null;
    return {
      id: d.id,
      applicationId: d.applicationId,
      tenantId: d.tenantId,
      environmentId: d.environmentId,
      agentId: d.agentId,
      agentVersion: d.agentVersion,
      agentKind: d.agentKind,
      slug: d.slug,
      name: d.name,
      description: d.description,
      status: d.status,
      currentPlanId: d.currentPlanId,
      currentPlanVersion: d.currentPlanVersion,
      revision: d.revision,
      creationFingerprint: d.creationFingerprint,
      createdAt: d.createdAt,
      updatedAt: d.updatedAt,
    };
  }

  async findDeploymentBySlug(applicationId: string, slug: string) {
    const id = this.bySlug.get(`${applicationId}:${slug}`);
    return id === undefined ? null : { id };
  }

  async listDeployments(applicationId: string) {
    return [...this.deployments.values()]
      .filter((d) => d.applicationId === applicationId)
      .map((d) => ({ id: d.id, slug: d.slug, status: d.status }));
  }

  async applyGuardedMutation(input: GuardedMutation) {
    const d = this.deployments.get(this.deploymentKey(input.applicationId, input.deploymentId));
    if (d === undefined) {
      throw new PlatformError({ code: "PROVIDER_ERROR", message: "deployment not found" });
    }
    const guardOk =
      d.status === input.expectedStatus &&
      (input.expectedPlanVersion === null || d.currentPlanVersion === input.expectedPlanVersion);
    if (guardOk) {
      if (input.toStatus !== d.status && !canTransitionDeployment(d.status, input.toStatus)) {
        throw new PlatformError({
          code: "INVALID_STATE_TRANSITION",
          message: `deployment ${d.slug} cannot move from ${d.status} to ${input.toStatus}`,
        });
      }
      d.status = input.toStatus;
      if (input.toPlanId !== null) d.currentPlanId = input.toPlanId;
      if (input.toPlanVersion !== null) d.currentPlanVersion = input.toPlanVersion;
      if (input.advanceRevision) d.revision += 1;
      d.updatedAt = new Date().toISOString();
      return { status: "applied" as const, revision: d.revision };
    }
    const converged =
      (input.toPlanVersion === null || d.currentPlanVersion === input.toPlanVersion) &&
      (input.toPlanId === null || d.currentPlanId === input.toPlanId) &&
      d.status === input.toStatus;
    if (converged) {
      return { status: "converged" as const, revision: d.revision };
    }
    throw new PlatformError({
      code: "INVALID_STATE_TRANSITION",
      message: `deployment ${d.slug} guard disagreed: row is ${d.status}@v${d.currentPlanVersion}`,
    });
  }

  async appendEvent(input: JournalAppendInput): Promise<DeploymentEventRecord> {
    const existing = this.events.find(
      (event) =>
        event.applicationId === input.applicationId &&
        event.idempotencyKey === input.idempotencyKey,
    );
    if (existing !== undefined) {
      return existing;
    }
    const event: DeploymentEventRecord = {
      id: input.eventId,
      applicationId: input.applicationId,
      tenantId: input.tenantId,
      deploymentId: input.deploymentId,
      kind: input.kind as DeploymentEventKind,
      actorId: input.actorId,
      cause: input.cause,
      priorPlanVersion: input.priorPlanVersion,
      currentPlanVersion: input.currentPlanVersion,
      executionId: input.executionId,
      eventSeq: ++this.seq,
      idempotencyKey: input.idempotencyKey,
      createdAt: input.createdAt,
    };
    this.events.push(event);
    return event;
  }

  async listEvents(applicationId: string, deploymentId: string) {
    return this.events
      .filter(
        (event) => event.applicationId === applicationId && event.deploymentId === deploymentId,
      )
      .sort((a, b) => a.eventSeq - b.eventSeq);
  }
}
