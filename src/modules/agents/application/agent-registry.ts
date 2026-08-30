/**
 * Agent registry application service (agents module; WORK-011,
 * AGT-003/AGT-004/ACP-001/ACP-002).
 *
 * THE inventory/versioning authority surface of the agent fabric:
 *
 *   registerAgent      → stable identity + catalog record (converges)
 *   publishVersion     → immutable validated version artifact (write-once)
 *   promote            → append a selection record (a valid version runs)
 *   rollback           → append a selection record (a previously valid
 *                        version runs again — artifacts never mutate)
 *   suspend/resume/retire → agent identity lifecycle only
 *
 * Authority discipline:
 *   - versions are INSERT-ONLY (the store port has no update/delete; the
 *     SQL migration physically rejects mutations) — promotion/rollback
 *     change WHICH version is selected, never a version's contents
 *     (discrimination M15/M16);
 *   - identity convergence: re-registering the same slug converges on
 *     the durable row (M17); publishing the same (agent, version) with
 *     the same digest converges, a different digest fails
 *     `IDEMPOTENCY_KEY_REUSED`;
 *   - the registry holds NO admission logic: running a version inside an
 *     execution is the session service's governed path.
 */

import { PlatformError } from "../../../shared/errors";
import { isUuid } from "../../../shared/ids";
import {
  AGENT_LIFECYCLE_TRANSITIONS,
  type AgentLifecycleStatus,
  type AgentRecord,
  type AgentRegistrationInput,
  validateAgentRegistration,
} from "../domain/agent";
import {
  type AgentDefinition,
  type AgentSelectionRecord,
  type AgentVersionRecord,
  canonicalDefinitionJson,
  validateAgentDefinition,
} from "../domain/agent-version";
import type { AgentStore } from "../ports/agent-store";

export interface AgentActor {
  readonly actorId: string;
  readonly applicationId: string;
  readonly tenantId: string;
}

export interface AgentRegistryDeps {
  readonly store: AgentStore;
  readonly generateId: () => string;
  readonly now: () => Date;
  /** Content digest over the canonical definition (adapters own crypto). */
  readonly hashDefinition: (canonicalJson: string) => string;
}

export interface RegisterAgentInput extends AgentRegistrationInput {}

export interface PublishVersionInput {
  readonly agentId: string;
  readonly version: string;
  readonly definition: Readonly<AgentDefinition>;
}

export interface PromoteInput {
  readonly agentId: string;
  readonly targetVersionId: string;
  readonly reason?: string;
}

export interface RollbackInput {
  readonly agentId: string;
  readonly targetVersionId: string;
  readonly reason?: string;
}

export interface AgentRegistry {
  registerAgent(
    input: RegisterAgentInput,
    idempotencyKey: string,
    actor: AgentActor,
  ): Promise<AgentRecord>;
  publishVersion(
    input: PublishVersionInput,
    idempotencyKey: string,
    actor: AgentActor,
  ): Promise<AgentVersionRecord>;
  promote(
    input: PromoteInput,
    idempotencyKey: string,
    actor: AgentActor,
  ): Promise<AgentSelectionRecord>;
  rollback(
    input: RollbackInput,
    idempotencyKey: string,
    actor: AgentActor,
  ): Promise<AgentSelectionRecord>;
  suspend(agentId: string, idempotencyKey: string, actor: AgentActor): Promise<AgentRecord>;
  resume(agentId: string, idempotencyKey: string, actor: AgentActor): Promise<AgentRecord>;
  retire(agentId: string, idempotencyKey: string, actor: AgentActor): Promise<AgentRecord>;
  getAgent(applicationId: string, agentId: string): Promise<AgentRecord | null>;
  getAgentBySlug(applicationId: string, slug: string): Promise<AgentRecord | null>;
  listVersions(applicationId: string, agentId: string): Promise<readonly AgentVersionRecord[]>;
  listSelections(applicationId: string, agentId: string): Promise<readonly AgentSelectionRecord[]>;
  currentSelection(applicationId: string, agentId: string): Promise<AgentSelectionRecord | null>;
}

const VERSION_PATTERN = /^\d+\.\d+\.\d+$/;

export function createAgentRegistry(deps: AgentRegistryDeps): AgentRegistry {
  const { store, generateId, now, hashDefinition } = deps;

  const iso = () => now().toISOString();

  const requireAgent = async (applicationId: string, agentId: string): Promise<AgentRecord> => {
    const agent = await store.findAgentById(applicationId, agentId);
    if (agent === null) {
      throw new PlatformError({
        code: "AGENT_ERROR",
        message: `agent ${agentId} is not registered in this application`,
        details: { agentId },
      });
    }
    return agent;
  };

  const scopedAgent = async (actor: AgentActor, agentId: string): Promise<AgentRecord> => {
    const agent = await requireAgent(actor.applicationId, agentId);
    if (agent.tenantId !== actor.tenantId) {
      throw new PlatformError({
        code: "TENANT_SCOPE_VIOLATION",
        message: "agent belongs to another tenant",
        details: { agentId },
      });
    }
    return agent;
  };

  const requireVersion = async (
    applicationId: string,
    versionId: string,
  ): Promise<AgentVersionRecord> => {
    const version = await store.findVersionById(applicationId, versionId);
    if (version === null) {
      throw new PlatformError({
        code: "AGENT_ERROR",
        message: `agent version ${versionId} does not exist in this application`,
        details: { versionId },
      });
    }
    return version;
  };

  const appendSelection = async (
    input: { readonly agentId: string; readonly targetVersionId: string; readonly reason?: string },
    kind: "initial" | "promotion" | "rollback",
    rollbackOf: string | null,
    idempotencyKey: string,
    actor: AgentActor,
  ): Promise<AgentSelectionRecord> => {
    const agent = await scopedAgent(actor, input.agentId);
    const version = await requireVersion(actor.applicationId, input.targetVersionId);
    if (version.agentId !== agent.id) {
      throw new PlatformError({
        code: "AGENT_ERROR",
        message: "agent version belongs to another agent",
        details: { versionId: input.targetVersionId },
      });
    }
    // Only VALIDATED artifacts may be selected (unregistered/invalid
    // versions cannot run — ADR-0013 verification expectation).
    if (version.validationState !== "valid") {
      throw new PlatformError({
        code: "AGENT_ERROR",
        message: `agent version ${version.version} is not validated (${version.validationState}) and cannot be selected`,
        details: { versionId: version.id, validationState: version.validationState },
      });
    }
    if (kind === "rollback") {
      const current = await store.latestSelectionForAgent(actor.applicationId, agent.id);
      if (current === null) {
        throw new PlatformError({
          code: "AGENT_ERROR",
          message: "rollback requires an existing selection to roll back",
          details: { agentId: agent.id },
        });
      }
      if (current.selectedVersionId === version.id) {
        // Rolling back to the already-selected version converges.
        return current;
      }
    }
    const claim = await store.insertSelection({
      id: generateId(),
      applicationId: actor.applicationId,
      tenantId: actor.tenantId,
      agentId: agent.id,
      selectedVersionId: version.id,
      kind,
      rollbackOf,
      selectedBy: actor.actorId,
      reason: input.reason ?? null,
      selectedAt: iso(),
      selectionKey: idempotencyKey,
    });
    if (!claim.claimed) {
      const existing = claim.record;
      // Converge only on the SAME logical selection (same target version).
      if (existing.selectedVersionId !== version.id) {
        throw new PlatformError({
          code: "IDEMPOTENCY_KEY_REUSED",
          message: "selection key was already used for a different selection",
          details: { selectionId: existing.id, selectedVersionId: existing.selectedVersionId },
        });
      }
      return existing;
    }
    return claim.record;
  };

  const lifecycleTransition = async (
    agentId: string,
    next: AgentLifecycleStatus,
    actor: AgentActor,
  ): Promise<AgentRecord> => {
    const agent = await scopedAgent(actor, agentId);
    if (agent.status === next) {
      return agent; // converge on the durable state
    }
    if (!AGENT_LIFECYCLE_TRANSITIONS[agent.status].includes(next)) {
      throw new PlatformError({
        code: "INVALID_STATE_TRANSITION",
        message: `agent lifecycle cannot move ${agent.status} -> ${next}`,
        details: { agentId: agent.id, from: agent.status, to: next },
      });
    }
    return store.transitionAgentLifecycle(actor.applicationId, agent.id, next, iso());
  };

  return {
    async registerAgent(input, idempotencyKey, actor) {
      // Registration is idempotent by its own durable identity anchor
      // (application_id, slug): convergence happens in the store; the
      // caller key is accepted for contract uniformity.
      void idempotencyKey;
      const check = validateAgentRegistration(input);
      if (!check.valid) {
        throw new PlatformError({
          code: "AGENT_ERROR",
          message: `invalid agent registration: ${check.reason}`,
        });
      }
      if (input.applicationId !== actor.applicationId || input.tenantId !== actor.tenantId) {
        throw new PlatformError({
          code: "TENANT_SCOPE_VIOLATION",
          message: "agent registration scope must match the acting principal",
        });
      }
      const existing = await store.findAgentBySlug(actor.applicationId, input.slug);
      if (existing !== null) {
        if (existing.tenantId !== actor.tenantId) {
          throw new PlatformError({
            code: "TENANT_SCOPE_VIOLATION",
            message: "agent slug already registered to another tenant",
            details: { slug: input.slug },
          });
        }
        // Duplicate registration converges on the durable identity (M17):
        // one stable identity per (application, slug); conflicting
        // registrations are impossible by the unique constraint.
        return existing;
      }
      const claim = await store.insertAgent({
        id: generateId(),
        applicationId: actor.applicationId,
        tenantId: actor.tenantId,
        slug: input.slug,
        name: input.name,
        description: input.description ?? null,
        createdAt: iso(),
      });
      return claim.record;
    },

    async publishVersion(input, idempotencyKey, actor) {
      // Publishing is idempotent by the version identity anchor
      // (application_id, agent_id, version) + definition digest: the
      // store converges and the digest conflict is rejected below.
      void idempotencyKey;
      const agent = await scopedAgent(actor, input.agentId);
      if (agent.status === "retired") {
        throw new PlatformError({
          code: "AGENT_ERROR",
          message: "retired agents cannot publish new versions",
          details: { agentId: agent.id },
        });
      }
      if (typeof input.version !== "string" || !VERSION_PATTERN.test(input.version)) {
        throw new PlatformError({
          code: "AGENT_ERROR",
          message: "version must be major.minor.patch numerics",
        });
      }
      // Fail-closed definition validation: malformed declarations and
      // RAW SECRETS never become governable artifacts (M6).
      const check = validateAgentDefinition(input.definition);
      if (!check.valid) {
        throw new PlatformError({
          code: "AGENT_ERROR",
          message: `invalid agent definition: ${check.reason}`,
        });
      }
      const digest = hashDefinition(canonicalDefinitionJson(input.definition));
      const claim = await store.insertVersion({
        id: generateId(),
        applicationId: actor.applicationId,
        tenantId: actor.tenantId,
        agentId: agent.id,
        version: input.version,
        definition: input.definition as unknown as Readonly<Record<string, unknown>>,
        definitionDigest: digest,
        // Synchronous validation: rows are born with their terminal
        // validation outcome ("pending" exists for future async
        // validation regimes; WORK-011 validates at publish).
        validationState: "valid",
        validationNotes: null,
        createdAt: iso(),
      });
      if (!claim.claimed) {
        const existing = claim.record;
        if (existing.definitionDigest !== digest) {
          throw new PlatformError({
            code: "IDEMPOTENCY_KEY_REUSED",
            message: `version ${input.version} already exists with a different definition`,
            details: { versionId: existing.id, definitionDigest: existing.definitionDigest },
          });
        }
        return existing;
      }
      // First valid version moves the identity forward on its lifecycle.
      const fresh = await store.findAgentById(actor.applicationId, agent.id);
      if (fresh !== null && fresh.status === "registered") {
        await store.transitionAgentLifecycle(actor.applicationId, fresh.id, "validated", iso());
      }
      return claim.record;
    },

    async promote(input, idempotencyKey, actor) {
      const selection = await appendSelection(input, "promotion", null, idempotencyKey, actor);
      // A promoted (selected) validated agent becomes available.
      const agent = await store.findAgentById(actor.applicationId, input.agentId);
      if (agent !== null && agent.status === "validated") {
        await store.transitionAgentLifecycle(actor.applicationId, agent.id, "available", iso());
      }
      return selection;
    },

    async rollback(input, idempotencyKey, actor) {
      const current = await store.latestSelectionForAgent(actor.applicationId, input.agentId);
      return appendSelection(input, "rollback", current?.id ?? null, idempotencyKey, actor);
    },

    async suspend(agentId, _idempotencyKey, actor) {
      return lifecycleTransition(agentId, "suspended", actor);
    },

    async resume(agentId, _idempotencyKey, actor) {
      return lifecycleTransition(agentId, "available", actor);
    },

    async retire(agentId, _idempotencyKey, actor) {
      return lifecycleTransition(agentId, "retired", actor);
    },

    async getAgent(applicationId, agentId) {
      if (!isUuid(agentId)) {
        return null;
      }
      return store.findAgentById(applicationId, agentId);
    },

    async getAgentBySlug(applicationId, slug) {
      return store.findAgentBySlug(applicationId, slug);
    },

    async listVersions(applicationId, agentId) {
      return store.listVersionsByAgent(applicationId, agentId);
    },

    async listSelections(applicationId, agentId) {
      return store.listSelectionsForAgent(applicationId, agentId);
    },

    async currentSelection(applicationId, agentId) {
      return store.latestSelectionForAgent(applicationId, agentId);
    },
  };
}
