/**
 * Deployment service (deployments module application; WORK-023,
 * MOD-001..004/010).
 *
 * THE governed lifecycle of the deployment fabric. Every operation is
 * idempotent, audited and concurrency-safe; every mutation appends
 * journal evidence (actor, cause, prior/current plan version,
 * execution provenance) and NEVER rewrites history:
 *
 * ```text
 * publishProfile   → fail-closed body validation → immutable
 *                    versioned artifact (converge on identical digest)
 * publishPlan      → fail-closed reference resolution (profile EXISTS
 *                    in the store; agent version EXISTS through the
 *                    REQUIRED agent-inventory seam — a valid, active
 *                    agents-module version; environment EXISTS through
 *                    the REQUIRED environment resolver; every channel
 *                    binding COVERED by a registered modality adapter,
 *                    fail-closed) → immutable versioned artifact
 * createDeployment → identity binding (application, environment,
 *                    agent, agent-version — MOD-002) + the initial
 *                    plan (its agent reference MUST match the
 *                    binding) + journal "create"
 * promote          → the target plan must exist, MATCH the deployment
 *                    binding, and be a DIFFERENT version → guarded
 *                    single-row move + journal "promote"
 *                  (prior version preserved)
 * rollback         → the prior version is DERIVED from the journal
 *                    (the last promote/rollback's priorPlanVersion)
 *                    → guarded move + journal "rollback" — history is
 *                    never rewritten
 * suspend/resume   → guarded status transitions + journal events
 * retire           → terminal; the journal is history
 * ```
 *
 * The dependency surface is pinned: {store, agentInventory,
 * environmentResolver, adapters, digest, generateId, now} — there is
 * NO policy seam, budget seam, capability-grant seam or
 * execution-transition seam in this service. Admission happens in
 * the EXISTING authorities at execution time; the modality adapters
 * are infrastructure descriptors, never admission surfaces
 * (MOD-004). Deployment is an Execution-ADJACENT control-plane
 * object — nothing here dispatches, executes or verifies.
 */

import { PlatformError } from "../../../shared/errors";
import { isUuid } from "../../../shared/ids";
import type {
  CreateDeploymentInput,
  DeploymentEventRecord,
  DeploymentMutationInput,
  PromoteDeploymentInput,
} from "../domain/deployment";
import {
  canTransitionDeployment,
  DEPLOYMENT_KEY_PATTERN,
  deploymentCreationFingerprint,
  validateCause,
  validateCreateDeploymentInput,
} from "../domain/deployment";
import type { DeploymentPlan, DeploymentPlanInput } from "../domain/plan";
import { canonicalPlanJson, validateDeploymentPlanInput } from "../domain/plan";
import type { DeploymentProfile, DeploymentProfileInput } from "../domain/profile";
import { canonicalProfileJson, validateDeploymentProfileInput } from "../domain/profile";
import type { DeploymentAgentInventory } from "../ports/agent-inventory";
import type {
  DeploymentInsertInput,
  DeploymentStore,
  JournalAppendInput,
} from "../ports/deployment-store";
import type { DeploymentEnvironmentResolver } from "../ports/environment-resolver";
import type { ModalityAdapterRegistry } from "../ports/modality-adapter";

export interface DeploymentActor {
  readonly actorId: string;
  readonly applicationId: string;
  readonly tenantId: string;
}

export interface DeploymentServiceDeps {
  readonly store: DeploymentStore;
  /** REQUIRED — agent-version facts through the agents public seam. */
  readonly agentInventory: DeploymentAgentInventory;
  /** REQUIRED — environment facts through the applications seam. */
  readonly environmentResolver: DeploymentEnvironmentResolver;
  /** The modality-adapter registry (infrastructure descriptors). */
  readonly adapters: ModalityAdapterRegistry;
  /** Content-addressing digest (canonical JSON → hash). */
  readonly digest: (canonical: string) => string;
  readonly generateId: () => string;
  readonly now: () => Date;
}

export type PublishProfileOutcome = {
  readonly status: "published" | "converged";
  readonly profile: DeploymentProfile;
};

export type PublishPlanOutcome = {
  readonly status: "published" | "converged";
  readonly plan: DeploymentPlan;
};

export interface DeploymentService {
  publishProfile(
    input: DeploymentProfileInput,
    idempotencyImplicit: { readonly version: number },
    actor: DeploymentActor,
  ): Promise<PublishProfileOutcome>;
  publishPlan(
    input: DeploymentPlanInput,
    version: { readonly version: number },
    actor: DeploymentActor,
  ): Promise<PublishPlanOutcome>;
  createDeployment(
    input: CreateDeploymentInput,
    idempotencyKey: string,
    actor: DeploymentActor,
  ): Promise<{ readonly deploymentId: string; readonly replayed: boolean }>;
  promoteDeployment(
    input: PromoteDeploymentInput,
  ): Promise<{ readonly revision: number; readonly planVersion: number }>;
  rollbackDeployment(
    input: DeploymentMutationInput,
  ): Promise<{ readonly revision: number; readonly planVersion: number }>;
  suspendDeployment(input: DeploymentMutationInput): Promise<readonly DeploymentEventRecord[]>;
  resumeDeployment(input: DeploymentMutationInput): Promise<readonly DeploymentEventRecord[]>;
  retireDeployment(input: DeploymentMutationInput): Promise<readonly DeploymentEventRecord[]>;
  getDeployment(
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
      > & { readonly currentPlan: DeploymentPlan | null })
    | null
  >;
  listEvents(
    applicationId: string,
    deploymentId: string,
  ): Promise<readonly DeploymentEventRecord[]>;
}

function requireUuid(value: string, field: string): string {
  if (!isUuid(value)) {
    throw new PlatformError({ code: "PROVIDER_ERROR", message: `${field} must be a UUID` });
  }
  return value;
}

function requireKey(idempotencyKey: string): string {
  if (typeof idempotencyKey !== "string" || !DEPLOYMENT_KEY_PATTERN.test(idempotencyKey)) {
    throw new PlatformError({
      code: "PROVIDER_ERROR",
      message: "idempotencyKey must be a non-empty printable string (max 200 chars)",
    });
  }
  return idempotencyKey;
}

export function createDeploymentService(deps: DeploymentServiceDeps): DeploymentService {
  const { store, agentInventory, environmentResolver, adapters, digest, generateId, now } = deps;
  const iso = () => now().toISOString();

  /** Fail-closed resolution of one agent-version fact. */
  const resolveAgentVersion = async (
    applicationId: string,
    agentId: string,
    agentVersion: string,
  ) => {
    const fact = await agentInventory.findVersion(applicationId, agentId, agentVersion);
    if (fact === null) {
      throw new PlatformError({
        code: "AGENT_ERROR",
        message: `agent ${agentId} version ${agentVersion} is not registered in this application; the plan cannot bind an unknown agent version`,
      });
    }
    if (fact.validationState !== "valid") {
      throw new PlatformError({
        code: "AGENT_ERROR",
        message: `agent ${agentId} version ${agentVersion} is ${fact.validationState}; only valid agent versions may be deployed`,
      });
    }
    if (fact.agentStatus === "retired") {
      throw new PlatformError({
        code: "AGENT_ERROR",
        message: `agent ${agentId} is retired; a retired agent cannot be deployed`,
      });
    }
    return fact;
  };

  /** Fail-closed resolution of the environment binding. */
  const resolveEnvironment = async (applicationId: string, environmentId: string) => {
    const ref = await environmentResolver.resolve(applicationId, environmentId);
    if (ref === null) {
      throw new PlatformError({
        code: "PROVIDER_ERROR",
        message: `environment ${environmentId} is not registered in this application; deployment identity cannot bind to an unknown environment`,
      });
    }
    return ref;
  };

  /** Fail-closed modality-adapter coverage of every channel binding. */
  const resolveBindings = async (plan: DeploymentPlanInput) => {
    for (const binding of plan.channelBindings) {
      const adapter = adapters.forCapabilityId(binding.adapterCapabilityId);
      if (adapter === null) {
        throw new PlatformError({
          code: "CAPABILITY_UNAVAILABLE",
          message: `no modality adapter is registered for capability "${binding.adapterCapabilityId}"; the plan fails closed rather than binding an unservable channel`,
        });
      }
      if (!adapter.descriptor.channelKinds.includes(binding.channelKind)) {
        throw new PlatformError({
          code: "CAPABILITY_UNAVAILABLE",
          message: `modality adapter "${binding.adapterCapabilityId}" does not serve channel kind "${binding.channelKind}"`,
        });
      }
      const check = await adapter.checkBinding(binding);
      if (!check.ok) {
        throw new PlatformError({
          code: "CAPABILITY_UNAVAILABLE",
          message: `modality adapter "${binding.adapterCapabilityId}" refused the channel binding: ${check.reason}`,
        });
      }
    }
  };

  /** The guarded mutation driver: journal-first, row-guarded, converged. */
  const mutate = async (
    input: DeploymentMutationInput,
    kind: "promote" | "rollback" | "suspend" | "resume" | "retire",
    computeTargets: (current: {
      readonly status: import("../domain/deployment").DeploymentStatus;
      readonly currentPlanId: string;
      readonly currentPlanVersion: number;
      readonly revision: number;
      readonly events: readonly DeploymentEventRecord[];
    }) => {
      readonly toStatus: import("../domain/deployment").DeploymentStatus;
      readonly toPlanId: string | null;
      readonly toPlanVersion: number | null;
      readonly advanceRevision: boolean;
    },
  ): Promise<{
    readonly revision: number;
    readonly planVersion: number;
    readonly events: readonly DeploymentEventRecord[];
  }> => {
    requireUuid(input.applicationId, "applicationId");
    requireUuid(input.deploymentId, "deploymentId");
    requireKey(input.idempotencyKey);
    const causeCheck = validateCause(input.cause);
    if (!causeCheck.valid) {
      throw new PlatformError({ code: "PROVIDER_ERROR", message: causeCheck.reason });
    }
    const deployment = await store.findDeployment(input.applicationId, input.deploymentId);
    if (deployment === null) {
      throw new PlatformError({
        code: "PROVIDER_ERROR",
        message: `deployment ${input.deploymentId} not found in this application`,
      });
    }
    if (deployment.tenantId !== input.tenantId) {
      throw new PlatformError({
        code: "TENANT_SCOPE_VIOLATION",
        message: "deployment belongs to another tenant",
      });
    }
    // Idempotent replay fast path: the journal already holds this key.
    const existing = await store.listEvents(input.applicationId, input.deploymentId);
    const replay = existing.find((event) => event.idempotencyKey === input.idempotencyKey);
    if (replay !== undefined) {
      return {
        revision: deployment.revision,
        planVersion: deployment.currentPlanVersion,
        events: existing,
      };
    }
    const events = existing;
    const targets = computeTargets({
      status: deployment.status,
      currentPlanId: deployment.currentPlanId,
      currentPlanVersion: deployment.currentPlanVersion,
      revision: deployment.revision,
      events,
    });
    if (
      targets.toStatus !== deployment.status &&
      !canTransitionDeployment(deployment.status, targets.toStatus)
    ) {
      throw new PlatformError({
        code: "INVALID_STATE_TRANSITION",
        message: `deployment ${deployment.slug} cannot move from ${deployment.status} to ${targets.toStatus} (the journal and row converge on the committed state)`,
      });
    }
    // Plan moves are control-plane changes: NEVER on a terminal
    // deployment (retired deployments do not promote or roll back).
    if ((kind === "promote" || kind === "rollback") && deployment.status === "retired") {
      throw new PlatformError({
        code: "INVALID_STATE_TRANSITION",
        message: `deployment ${deployment.slug} is retired; retired deployments never promote or roll back`,
      });
    }
    // Status-mutation precondition (fail-closed, no idempotent no-ops):
    // suspend requires active; resume requires suspended.
    if (kind === "suspend" && deployment.status !== "active") {
      throw new PlatformError({
        code: "INVALID_STATE_TRANSITION",
        message: `deployment ${deployment.slug} is ${deployment.status}; suspension requires active`,
      });
    }
    if (kind === "resume" && deployment.status !== "suspended") {
      throw new PlatformError({
        code: "INVALID_STATE_TRANSITION",
        message: `deployment ${deployment.slug} is ${deployment.status}; resume requires suspended`,
      });
    }
    const applied = await store.applyGuardedMutation({
      applicationId: input.applicationId,
      deploymentId: input.deploymentId,
      expectedStatus: deployment.status,
      expectedPlanVersion: deployment.currentPlanVersion,
      toStatus: targets.toStatus,
      toPlanId: targets.toPlanId,
      toPlanVersion: targets.toPlanVersion,
      advanceRevision: targets.advanceRevision,
    });
    if (applied.status === "converged") {
      // A concurrent duplicate already committed the same logical
      // mutation: converge WITHOUT double-journaling (the winner's
      // event is the truth; the journal stays exact-once).
      return {
        revision: applied.revision,
        planVersion: targets.toPlanVersion ?? deployment.currentPlanVersion,
        events: await store.listEvents(input.applicationId, input.deploymentId),
      };
    }
    const journalInput: JournalAppendInput = {
      eventId: generateId(),
      applicationId: input.applicationId,
      tenantId: deployment.tenantId,
      deploymentId: input.deploymentId,
      kind,
      actorId: input.actorId,
      cause: input.cause ?? null,
      priorPlanVersion:
        kind === "promote" || kind === "rollback" ? deployment.currentPlanVersion : null,
      currentPlanVersion: kind === "promote" || kind === "rollback" ? targets.toPlanVersion : null,
      executionId: input.executionId ?? null,
      idempotencyKey: input.idempotencyKey,
      createdAt: iso(),
    };
    await store.appendJournalEvent(journalInput);
    const afterEvents = await store.listEvents(input.applicationId, input.deploymentId);
    return {
      revision: applied.revision,
      planVersion: targets.toPlanVersion ?? deployment.currentPlanVersion,
      events: afterEvents,
    };
  };

  return {
    async publishProfile(input, { version }, actor) {
      const check = validateDeploymentProfileInput(input);
      if (!check.valid) {
        throw new PlatformError({ code: "PROVIDER_ERROR", message: check.reason });
      }
      const bodyDigest = digest(canonicalProfileJson(input));
      const outcome = await store.insertProfile({
        profile: {
          profileId: input.profileId,
          version,
          applicationId: actor.applicationId,
          tenantId: actor.tenantId,
          modality: input.modality,
          channelKinds: [...input.channelKinds],
          requiredCapabilities: [...input.requiredCapabilities],
          latencyClass: input.latencyClass,
          resourceClass: input.resourceClass,
          sideEffectClass: input.sideEffectClass,
          inputModalities: [...input.inputModalities],
          outputModalities: [...input.outputModalities],
          description: input.description ?? null,
          createdBy: actor.actorId,
        },
        digest: bodyDigest,
      });
      return { status: outcome.status, profile: outcome.profile };
    },

    async publishPlan(input, { version }, actor) {
      const check = validateDeploymentPlanInput(input);
      if (!check.valid) {
        throw new PlatformError({ code: "PROVIDER_ERROR", message: check.reason });
      }
      // Fail-closed reference resolution THROUGH the module seams.
      const profile = await store.findProfile(
        actor.applicationId,
        input.profileRef.profileId,
        input.profileRef.version,
      );
      if (profile === null) {
        throw new PlatformError({
          code: "PROVIDER_ERROR",
          message: `profile ${input.profileRef.profileId}@${input.profileRef.version} is not published in this application; a plan cannot reference an unknown profile version`,
        });
      }
      await resolveAgentVersion(
        actor.applicationId,
        input.agentRef.agentId,
        input.agentRef.agentVersion,
      );
      await resolveEnvironment(actor.applicationId, input.environmentId);
      await resolveBindings(input);
      const planDigest = digest(canonicalPlanJson(input));
      const outcome = await store.insertPlan({
        plan: {
          planId: input.planId,
          version,
          applicationId: actor.applicationId,
          tenantId: actor.tenantId,
          profileRef: { ...input.profileRef },
          agentRef: { ...input.agentRef },
          environmentId: input.environmentId,
          channelBindings: [...input.channelBindings],
          sessionPolicy: { ...input.sessionPolicy },
          description: input.description ?? null,
          createdBy: actor.actorId,
        },
        digest: planDigest,
      });
      return { status: outcome.status, plan: outcome.plan };
    },

    async createDeployment(input, idempotencyKey, actor) {
      requireUuid(actor.applicationId, "applicationId");
      requireKey(idempotencyKey);
      const check = validateCreateDeploymentInput(input);
      if (!check.valid) {
        throw new PlatformError({ code: "PROVIDER_ERROR", message: check.reason });
      }
      // Fail-closed identity binding resolution (MOD-002).
      const environment = await resolveEnvironment(actor.applicationId, input.environmentId);
      if (environment.tenantId !== actor.tenantId) {
        throw new PlatformError({
          code: "TENANT_SCOPE_VIOLATION",
          message: "the deployment environment belongs to another tenant",
        });
      }
      await resolveAgentVersion(actor.applicationId, input.agentId, input.agentVersion);
      const fingerprint = deploymentCreationFingerprint(actor.applicationId, input);
      // Idempotent replay fast path.
      const bySlug = await store.findDeploymentBySlug(actor.applicationId, input.slug);
      if (bySlug !== null) {
        const existing = await store.findDeployment(actor.applicationId, bySlug.id);
        if (existing !== null) {
          if (existing.creationFingerprint !== fingerprint) {
            throw new PlatformError({
              code: "IDEMPOTENCY_KEY_REUSED",
              message: "deployment slug already exists with a different creation fingerprint",
              details: { deploymentId: existing.id },
            });
          }
          return { deploymentId: existing.id, replayed: true };
        }
      }
      // The initial plan must exist and MATCH the deployment binding.
      const planVersion = input.initialPlanVersion ?? 1;
      const plan = await store.findPlan(actor.applicationId, input.planId, planVersion);
      if (plan === null) {
        throw new PlatformError({
          code: "PROVIDER_ERROR",
          message: `plan ${input.planId}@${planVersion} is not published in this application; a deployment cannot start from an unknown plan`,
        });
      }
      if (
        plan.agentRef.agentId !== input.agentId ||
        plan.agentRef.agentVersion !== input.agentVersion ||
        plan.agentRef.agentKind !== input.agentKind
      ) {
        throw new PlatformError({
          code: "PROVIDER_ERROR",
          message:
            "the initial plan's agent reference must match the deployment identity binding (application, environment, agent, agent version — MOD-002)",
        });
      }
      if (plan.environmentId !== input.environmentId) {
        throw new PlatformError({
          code: "PROVIDER_ERROR",
          message: "the initial plan's environment must match the deployment environment binding",
        });
      }
      const insert: DeploymentInsertInput = {
        deploymentId: generateId(),
        applicationId: actor.applicationId,
        tenantId: actor.tenantId,
        slug: input.slug,
        name: input.name,
        description: input.description ?? null,
        environmentId: input.environmentId,
        agentId: input.agentId,
        agentVersion: input.agentVersion,
        agentKind: input.agentKind,
        initialPlanId: input.planId,
        initialPlanVersion: planVersion,
        creationFingerprint: fingerprint,
        createdBy: actor.actorId,
        idempotencyKey,
        createdAt: iso(),
      };
      const outcome = await store.insertDeployment(insert);
      // A concurrent duplicate that converged on the committed row NEVER
      // double-journals: the winner's create event is the truth (the
      // exact-once discipline — §10's "concurrent duplicate: single
      // durable result").
      if (outcome.status !== "converged") {
        await store.appendJournalEvent({
          eventId: generateId(),
          applicationId: actor.applicationId,
          tenantId: actor.tenantId,
          deploymentId: outcome.deploymentId,
          kind: "create",
          actorId: actor.actorId,
          cause: null,
          priorPlanVersion: null,
          currentPlanVersion: planVersion,
          executionId: null,
          idempotencyKey: `${idempotencyKey}:create`,
          createdAt: iso(),
        });
      }
      return {
        deploymentId: outcome.deploymentId,
        replayed: outcome.status === "converged",
      };
    },

    async promoteDeployment(input) {
      requireUuid(input.applicationId, "applicationId");
      const deployment = await store.findDeployment(input.applicationId, input.deploymentId);
      if (deployment === null) {
        throw new PlatformError({
          code: "PROVIDER_ERROR",
          message: `deployment ${input.deploymentId} not found in this application`,
        });
      }
      if (input.toPlanVersion === deployment.currentPlanVersion) {
        // Idempotent target: converging on the current version.
        return { revision: deployment.revision, planVersion: deployment.currentPlanVersion };
      }
      const targetPlan = await store.findPlan(
        input.applicationId,
        deployment.currentPlanId,
        input.toPlanVersion,
      );
      if (targetPlan === null) {
        throw new PlatformError({
          code: "PROVIDER_ERROR",
          message: `plan ${deployment.currentPlanId}@${input.toPlanVersion} is not published; promotion requires a published target version`,
        });
      }
      // Identity preservation (MOD-002 + ADR-0014 invariant 9): the
      // target plan's agent reference MUST match the deployment binding.
      if (
        targetPlan.agentRef.agentId !== deployment.agentId ||
        targetPlan.agentRef.agentVersion !== deployment.agentVersion ||
        targetPlan.agentRef.agentKind !== deployment.agentKind ||
        targetPlan.environmentId !== deployment.environmentId
      ) {
        throw new PlatformError({
          code: "PROVIDER_ERROR",
          message:
            "the promotion target's agent/environment reference must match the deployment identity binding (promotion preserves deployment identity; a different agent version is a different deployment)",
        });
      }
      const result = await mutate(input, "promote", (current) => ({
        toStatus: current.status,
        toPlanId: deployment.currentPlanId,
        toPlanVersion: input.toPlanVersion,
        advanceRevision: true,
      }));
      return { revision: result.revision, planVersion: result.planVersion };
    },

    async rollbackDeployment(input) {
      const events = await store.listEvents(input.applicationId, input.deploymentId);
      // The prior version is DERIVED from the journal (never caller-
      // asserted, never rewritten history).
      const moves = events.filter((event) => event.kind === "promote" || event.kind === "rollback");
      const last = moves.length > 0 ? moves[moves.length - 1] : undefined;
      const priorPlanVersion = last?.priorPlanVersion;
      if (priorPlanVersion === undefined || priorPlanVersion === null) {
        throw new PlatformError({
          code: "PROVIDER_ERROR",
          message:
            "no prior plan version exists to roll back to (the deployment is at its initial version)",
        });
      }
      const result = await mutate(input, "rollback", (current) => ({
        toStatus: current.status,
        toPlanId: current.currentPlanId,
        toPlanVersion: priorPlanVersion,
        advanceRevision: true,
      }));
      return { revision: result.revision, planVersion: result.planVersion };
    },

    async suspendDeployment(input) {
      await mutate(input, "suspend", () => ({
        toStatus: "suspended" as const,
        toPlanId: null,
        toPlanVersion: null,
        advanceRevision: false,
      }));
      return await store.listEvents(input.applicationId, input.deploymentId);
    },

    async resumeDeployment(input) {
      await mutate(input, "resume", () => ({
        toStatus: "active" as const,
        toPlanId: null,
        toPlanVersion: null,
        advanceRevision: false,
      }));
      return await store.listEvents(input.applicationId, input.deploymentId);
    },

    async retireDeployment(input) {
      await mutate(input, "retire", () => ({
        toStatus: "retired" as const,
        toPlanId: null,
        toPlanVersion: null,
        advanceRevision: false,
      }));
      return await store.listEvents(input.applicationId, input.deploymentId);
    },

    async getDeployment(applicationId, deploymentId) {
      requireUuid(applicationId, "applicationId");
      requireUuid(deploymentId, "deploymentId");
      const deployment = await store.findDeployment(applicationId, deploymentId);
      if (deployment === null) return null;
      const plan = await store.findPlan(
        applicationId,
        deployment.currentPlanId,
        deployment.currentPlanVersion,
      );
      const { creationFingerprint: _fingerprint, ...record } = deployment;
      return { ...record, currentPlan: plan };
    },

    async listEvents(applicationId, deploymentId) {
      requireUuid(applicationId, "applicationId");
      requireUuid(deploymentId, "deploymentId");
      return store.listEvents(applicationId, deploymentId);
    },
  };
}
