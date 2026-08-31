/**
 * SQL deployment store (deployments module adapter; WORK-023).
 *
 * The durable implementation of the `DeploymentStore` port over the
 * provider-neutral `DatabasePort` (migration
 * `0012_deployment_fabric.sql`). Physical invariants live in the
 * migration (artifact immutability, guarded lifecycle, append-only
 * journal); this adapter maps rows <-> domain records and converges
 * exactly like the WORK-011/017 SQL stores:
 *
 *  - profile/plan inserts: UNIQUE (application, identity, version)
 *    arbitration — an identical digest re-reads and converges; a
 *    different digest under the same identity+version fails closed;
 *  - deployment insert: UNIQUE (application, slug) + the creation
 *    fingerprint check converge idempotent replays;
 *  - `applyGuardedMutation`: the single-row guarded UPDATE arbitrates
 *    concurrent mutations (first writer wins; duplicates converge on
 *    the committed row);
 *  - `appendEvent`: UNIQUE (application, idempotency_key) converges
 *    retried lifecycle requests;
 *  - every read is scope-filtered (application);
 *  - the environment lookup is the executions-store read-only
 *    cross-module precedent (applications.environments by id).
 */

import type { DatabasePort } from "../../../platform/db/port";
import { PlatformError } from "../../../shared/errors";
import type {
  DeploymentEventKind,
  DeploymentEventRecord,
  DeploymentStatus,
} from "../domain/deployment";
import type {
  ChannelBinding,
  DeploymentPlan,
  DeploymentSessionPolicy,
  PlanAgentRef,
} from "../domain/plan";
import type {
  DeploymentChannelKind,
  DeploymentIoModality,
  DeploymentLatencyClass,
  DeploymentModality,
  DeploymentProfile,
  DeploymentResourceClass,
  DeploymentSideEffectClass,
} from "../domain/profile";
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

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "23505"
  );
}

interface ProfileRow {
  readonly profile_id: string;
  readonly version: number;
  readonly application_id: string;
  readonly tenant_id: string;
  readonly modality: string;
  readonly channel_kinds: string[];
  readonly required_capabilities: string[];
  readonly latency_class: string;
  readonly resource_class: string;
  readonly side_effect_class: string;
  readonly input_modalities: string[];
  readonly output_modalities: string[];
  readonly description: string | null;
  readonly digest: string;
  readonly created_by: string;
  readonly created_at: Date | string;
}

function toProfile(row: ProfileRow): DeploymentProfile {
  return {
    profileId: row.profile_id,
    version: row.version,
    applicationId: row.application_id,
    tenantId: row.tenant_id,
    modality: row.modality as DeploymentModality,
    channelKinds: row.channel_kinds as readonly DeploymentChannelKind[],
    requiredCapabilities: row.required_capabilities,
    latencyClass: row.latency_class as DeploymentLatencyClass,
    resourceClass: row.resource_class as DeploymentResourceClass,
    sideEffectClass: row.side_effect_class as DeploymentSideEffectClass,
    inputModalities: row.input_modalities as readonly DeploymentIoModality[],
    outputModalities: row.output_modalities as readonly DeploymentIoModality[],
    description: row.description,
    digest: row.digest,
    createdBy: row.created_by,
    createdAt:
      row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
  };
}

const PROFILE_COLUMNS = `profile_id, version, application_id, tenant_id, modality,
    channel_kinds, required_capabilities, latency_class, resource_class, side_effect_class,
    input_modalities, output_modalities, description, digest, created_by, created_at`;

interface PlanRow {
  readonly plan_id: string;
  readonly version: number;
  readonly application_id: string;
  readonly tenant_id: string;
  readonly profile_id: string;
  readonly profile_version: number;
  readonly agent_id: string;
  readonly agent_version: string;
  readonly agent_kind: string;
  readonly external_descriptor: { ref: string; descriptor: string } | null;
  readonly environment_id: string;
  readonly channel_bindings: ChannelBinding[];
  readonly session_policy: DeploymentSessionPolicy;
  readonly description: string | null;
  readonly digest: string;
  readonly created_by: string;
  readonly created_at: Date | string;
}

function toPlan(row: PlanRow): DeploymentPlan {
  const agentRef: PlanAgentRef = {
    agentId: row.agent_id,
    agentVersion: row.agent_version,
    agentKind: row.agent_kind as "zeck" | "byoa",
    ...(row.external_descriptor === null ? {} : { externalDescriptor: row.external_descriptor }),
  };
  return {
    planId: row.plan_id,
    version: row.version,
    applicationId: row.application_id,
    tenantId: row.tenant_id,
    profileRef: { profileId: row.profile_id, version: row.profile_version },
    agentRef,
    environmentId: row.environment_id,
    channelBindings: row.channel_bindings,
    sessionPolicy: row.session_policy,
    description: row.description,
    digest: row.digest,
    createdBy: row.created_by,
    createdAt:
      row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
  };
}

const PLAN_COLUMNS = `plan_id, version, application_id, tenant_id, profile_id, profile_version,
    agent_id, agent_version, agent_kind, external_descriptor, environment_id, channel_bindings,
    session_policy, description, digest, created_by, created_at`;

interface DeploymentRow {
  readonly id: string;
  readonly application_id: string;
  readonly tenant_id: string;
  readonly environment_id: string;
  readonly agent_id: string;
  readonly agent_version: string;
  readonly agent_kind: string;
  readonly slug: string;
  readonly name: string;
  readonly description: string | null;
  readonly status: string;
  readonly current_plan_id: string;
  readonly current_plan_version: number;
  readonly revision: number;
  readonly creation_fingerprint: string;
  readonly created_at: Date | string;
  readonly updated_at: Date | string;
}

interface EventRow {
  readonly id: string;
  readonly application_id: string;
  readonly tenant_id: string;
  readonly deployment_id: string;
  readonly kind: string;
  readonly actor_id: string;
  readonly cause: string | null;
  readonly prior_plan_version: number | null;
  readonly current_plan_version: number | null;
  readonly execution_id: string | null;
  readonly event_seq: string | number;
  readonly idempotency_key: string;
  readonly created_at: Date | string;
}

function toEvent(row: EventRow): DeploymentEventRecord {
  return {
    id: row.id,
    applicationId: row.application_id,
    tenantId: row.tenant_id,
    deploymentId: row.deployment_id,
    kind: row.kind as DeploymentEventKind,
    actorId: row.actor_id,
    cause: row.cause,
    priorPlanVersion: row.prior_plan_version,
    currentPlanVersion: row.current_plan_version,
    executionId: row.execution_id,
    eventSeq: Number(row.event_seq),
    idempotencyKey: row.idempotency_key,
    createdAt:
      row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
  };
}

const EVENT_COLUMNS = `id, application_id, tenant_id, deployment_id, kind, actor_id, cause,
    prior_plan_version, current_plan_version, execution_id, event_seq, idempotency_key, created_at`;

const DEPLOYMENT_COLUMNS = `id, application_id, tenant_id, environment_id, agent_id, agent_version,
    agent_kind, slug, name, description, status, current_plan_id, current_plan_version, revision,
    creation_fingerprint, created_at, updated_at`;

export class SqlDeploymentStore implements DeploymentStore {
  constructor(private readonly db: DatabasePort) {}

  async insertProfile(input: ProfileInsertInput): Promise<ProfileInsertOutcome> {
    const p = input.profile;
    try {
      const result = await this.db.execute<ProfileRow>({
        sql: `INSERT INTO deployments.deployment_profiles (
    ${PROFILE_COLUMNS})
VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7::jsonb, $8, $9, $10, $11::jsonb, $12::jsonb, $13, $14, $15, $16)
RETURNING ${PROFILE_COLUMNS}`,
        parameters: [
          p.profileId,
          p.version,
          p.applicationId,
          p.tenantId,
          p.modality,
          JSON.stringify(p.channelKinds),
          JSON.stringify(p.requiredCapabilities),
          p.latencyClass,
          p.resourceClass,
          p.sideEffectClass,
          JSON.stringify(p.inputModalities),
          JSON.stringify(p.outputModalities),
          p.description,
          input.digest,
          p.createdBy,
          new Date().toISOString(),
        ],
      });
      const row = result.rows[0];
      if (row !== undefined) {
        return { status: "published", profile: toProfile(row) };
      }
    } catch (error) {
      if (isUniqueViolation(error)) {
        const existing = await this.findProfile(p.applicationId, p.profileId, p.version);
        if (existing === null) {
          throw new PlatformError({
            code: "PROVIDER_ERROR",
            message: "profile insert arbitration failed but the committed row is unreadable",
          });
        }
        if (existing.digest !== input.digest) {
          throw new PlatformError({
            code: "IDEMPOTENCY_KEY_REUSED",
            message:
              "profile version already exists with a different body; published artifacts are immutable",
            details: { profileId: p.profileId, version: p.version },
          });
        }
        return { status: "converged", profile: existing };
      }
      throw error;
    }
    throw new PlatformError({ code: "PROVIDER_ERROR", message: "profile insert returned no row" });
  }

  async findProfile(
    applicationId: string,
    profileId: string,
    version: number,
  ): Promise<DeploymentProfile | null> {
    const result = await this.db.execute<ProfileRow>({
      sql: `SELECT ${PROFILE_COLUMNS} FROM deployments.deployment_profiles
WHERE application_id = $1 AND profile_id = $2 AND version = $3`,
      parameters: [applicationId, profileId, version],
    });
    const row = result.rows[0];
    return row === undefined ? null : toProfile(row);
  }

  async listProfileVersions(
    applicationId: string,
    profileId: string,
  ): Promise<readonly DeploymentProfile[]> {
    const result = await this.db.execute<ProfileRow>({
      sql: `SELECT ${PROFILE_COLUMNS} FROM deployments.deployment_profiles
WHERE application_id = $1 AND profile_id = $2 ORDER BY version`,
      parameters: [applicationId, profileId],
    });
    return result.rows.map(toProfile);
  }

  async insertPlan(input: PlanInsertInput): Promise<PlanInsertOutcome> {
    const p = input.plan;
    try {
      const result = await this.db.execute<PlanRow>({
        sql: `INSERT INTO deployments.deployment_plans (
    ${PLAN_COLUMNS})
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, $12::jsonb, $13::jsonb, $14, $15, $16, $17)
RETURNING ${PLAN_COLUMNS}`,
        parameters: [
          p.planId,
          p.version,
          p.applicationId,
          p.tenantId,
          p.profileRef.profileId,
          p.profileRef.version,
          p.agentRef.agentId,
          p.agentRef.agentVersion,
          p.agentRef.agentKind,
          p.agentRef.externalDescriptor === undefined
            ? null
            : JSON.stringify(p.agentRef.externalDescriptor),
          p.environmentId,
          JSON.stringify(p.channelBindings),
          JSON.stringify(p.sessionPolicy),
          p.description,
          input.digest,
          p.createdBy,
          new Date().toISOString(),
        ],
      });
      const row = result.rows[0];
      if (row !== undefined) {
        return { status: "published", plan: toPlan(row) };
      }
    } catch (error) {
      if (isUniqueViolation(error)) {
        const existing = await this.findPlan(p.applicationId, p.planId, p.version);
        if (existing === null) {
          throw new PlatformError({
            code: "PROVIDER_ERROR",
            message: "plan insert arbitration failed but the committed row is unreadable",
          });
        }
        if (existing.digest !== input.digest) {
          throw new PlatformError({
            code: "IDEMPOTENCY_KEY_REUSED",
            message:
              "plan version already exists with a different body; published artifacts are immutable",
            details: { planId: p.planId, version: p.version },
          });
        }
        return { status: "converged", plan: existing };
      }
      throw error;
    }
    throw new PlatformError({ code: "PROVIDER_ERROR", message: "plan insert returned no row" });
  }

  async findPlan(
    applicationId: string,
    planId: string,
    version: number,
  ): Promise<DeploymentPlan | null> {
    const result = await this.db.execute<PlanRow>({
      sql: `SELECT ${PLAN_COLUMNS} FROM deployments.deployment_plans
WHERE application_id = $1 AND plan_id = $2 AND version = $3`,
      parameters: [applicationId, planId, version],
    });
    const row = result.rows[0];
    return row === undefined ? null : toPlan(row);
  }

  async listPlanVersions(
    applicationId: string,
    planId: string,
  ): Promise<readonly DeploymentPlan[]> {
    const result = await this.db.execute<PlanRow>({
      sql: `SELECT ${PLAN_COLUMNS} FROM deployments.deployment_plans
WHERE application_id = $1 AND plan_id = $2 ORDER BY version`,
      parameters: [applicationId, planId],
    });
    return result.rows.map(toPlan);
  }

  async insertDeployment(input: DeploymentInsertInput): Promise<DeploymentInsertOutcome> {
    try {
      const result = await this.db.execute<{ id: string }>({
        sql: `INSERT INTO deployments.deployments (
    id, application_id, tenant_id, environment_id, agent_id, agent_version, agent_kind, slug, name,
    description, status, current_plan_id, current_plan_version, revision, creation_fingerprint,
    created_by, idempotency_key, created_at, updated_at)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'active', $11, $12, 0, $13, $14, $15, $16, $16)
RETURNING id`,
        parameters: [
          input.deploymentId,
          input.applicationId,
          input.tenantId,
          input.environmentId,
          input.agentId,
          input.agentVersion,
          input.agentKind,
          input.slug,
          input.name,
          input.description,
          input.initialPlanId,
          input.initialPlanVersion,
          input.creationFingerprint,
          input.createdBy,
          input.idempotencyKey,
          input.createdAt,
        ],
      });
      const row = result.rows[0];
      if (row !== undefined) {
        return { status: "created", deploymentId: row.id };
      }
    } catch (error) {
      if (isUniqueViolation(error)) {
        const existing = await this.findDeploymentBySlug(input.applicationId, input.slug);
        if (existing !== null) {
          const record = await this.findDeployment(input.applicationId, existing.id);
          if (record !== null && record.creationFingerprint === input.creationFingerprint) {
            return { status: "converged", deploymentId: existing.id };
          }
        }
        throw new PlatformError({
          code: "IDEMPOTENCY_KEY_REUSED",
          message: "deployment slug already exists with a different creation fingerprint",
        });
      }
      throw error;
    }
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message: "deployment insert returned no row",
    });
  }

  async findDeployment(applicationId: string, deploymentId: string) {
    const result = await this.db.execute<DeploymentRow>({
      sql: `SELECT ${DEPLOYMENT_COLUMNS} FROM deployments.deployments
WHERE application_id = $1 AND id = $2`,
      parameters: [applicationId, deploymentId],
    });
    const row = result.rows[0];
    if (row === undefined) return null;
    return {
      id: row.id,
      applicationId: row.application_id,
      tenantId: row.tenant_id,
      environmentId: row.environment_id,
      agentId: row.agent_id,
      agentVersion: row.agent_version,
      agentKind: row.agent_kind as "zeck" | "byoa",
      slug: row.slug,
      name: row.name,
      description: row.description,
      status: row.status as DeploymentStatus,
      currentPlanId: row.current_plan_id,
      currentPlanVersion: row.current_plan_version,
      revision: row.revision,
      creationFingerprint: row.creation_fingerprint,
      createdAt:
        row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
      updatedAt:
        row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at),
    };
  }

  async findDeploymentBySlug(applicationId: string, slug: string) {
    const result = await this.db.execute<{ id: string }>({
      sql: `SELECT id FROM deployments.deployments WHERE application_id = $1 AND slug = $2`,
      parameters: [applicationId, slug],
    });
    const row = result.rows[0];
    return row === undefined ? null : { id: row.id };
  }

  async listDeployments(applicationId: string) {
    const result = await this.db.execute<{ id: string; slug: string; status: string }>({
      sql: `SELECT id, slug, status FROM deployments.deployments
WHERE application_id = $1 ORDER BY created_at, id`,
      parameters: [applicationId],
    });
    return result.rows.map((row) => ({ id: row.id, slug: row.slug, status: row.status }));
  }

  async applyGuardedMutation(input: GuardedMutation) {
    const updated = await this.db.execute<{ revision: number }>({
      sql: `UPDATE deployments.deployments
SET status = $1,
    current_plan_id = COALESCE($2, current_plan_id),
    current_plan_version = COALESCE($3, current_plan_version),
    revision = revision + CASE WHEN $4 THEN 1 ELSE 0 END,
    updated_at = $5
WHERE application_id = $6 AND id = $7 AND status = $8 AND current_plan_version = $9
RETURNING revision`,
      parameters: [
        input.toStatus,
        input.toPlanId,
        input.toPlanVersion,
        input.advanceRevision,
        new Date().toISOString(),
        input.applicationId,
        input.deploymentId,
        input.expectedStatus,
        input.expectedPlanVersion ?? -1,
      ],
    });
    const row = updated.rows[0];
    if (row !== undefined) {
      return { status: "applied" as const, revision: row.revision };
    }
    // First writer already moved the row (or the guard disagrees):
    // converge when the committed state equals the target; fail closed
    // when it does not.
    const current = await this.findDeployment(input.applicationId, input.deploymentId);
    if (current === null) {
      throw new PlatformError({
        code: "PROVIDER_ERROR",
        message: `deployment ${input.deploymentId} not found`,
      });
    }
    const converged =
      (input.toPlanVersion === null || current.currentPlanVersion === input.toPlanVersion) &&
      (input.toPlanId === null || current.currentPlanId === input.toPlanId) &&
      current.status === input.toStatus;
    if (converged) {
      return { status: "converged" as const, revision: current.revision };
    }
    throw new PlatformError({
      code: "INVALID_STATE_TRANSITION",
      message: `deployment ${current.slug} guard disagreed: row is ${current.status}@v${current.currentPlanVersion}; the guarded mutation expected ${input.expectedStatus}@v${String(input.expectedPlanVersion)} (first writer wins; replays converge on the committed state)`,
    });
  }

  async appendEvent(input: JournalAppendInput): Promise<DeploymentEventRecord> {
    try {
      const result = await this.db.execute<EventRow>({
        sql: `INSERT INTO deployments.deployment_events (
    ${EVENT_COLUMNS})
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, DEFAULT, $11, $12)
RETURNING ${EVENT_COLUMNS}`,
        parameters: [
          input.eventId,
          input.applicationId,
          input.tenantId,
          input.deploymentId,
          input.kind,
          input.actorId,
          input.cause,
          input.priorPlanVersion,
          input.currentPlanVersion,
          input.executionId,
          input.idempotencyKey,
          input.createdAt,
        ],
      });
      const row = result.rows[0];
      if (row !== undefined) {
        return toEvent(row);
      }
    } catch (error) {
      if (isUniqueViolation(error)) {
        // A retried lifecycle request converges on the committed event.
        const existing = await this.listEvents(input.applicationId, input.deploymentId);
        const replay = existing.find((event) => event.idempotencyKey === input.idempotencyKey);
        if (replay !== undefined) {
          return replay;
        }
      }
      throw error;
    }
    throw new PlatformError({ code: "PROVIDER_ERROR", message: "event insert returned no row" });
  }

  async listEvents(applicationId: string, deploymentId: string) {
    const result = await this.db.execute<EventRow>({
      sql: `SELECT ${EVENT_COLUMNS} FROM deployments.deployment_events
WHERE application_id = $1 AND deployment_id = $2 ORDER BY event_seq`,
      parameters: [applicationId, deploymentId],
    });
    return result.rows.map(toEvent);
  }
}
