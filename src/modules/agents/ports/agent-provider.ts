/**
 * AgentProvider port (agents module outbound; WORK-011, AGT-001).
 *
 * THE contract that keeps the agent RUNTIME contract distinct from the
 * model-INFERENCE contract — the deliberate counterpart of the models
 * module's `ModelProvider` and the answer to discrimination M2:
 *
 *   ModelProvider  → answers INFERENCE capability
 *                    (`complete(request, context)` — one model call)
 *   AgentProvider  → represents an AGENT RUNTIME capable of executing a
 *                    governed agent session (`executeSession(identity,
 *                    task)` — a governed participant run)
 *
 * An AgentProvider receives the ALREADY-GOVERNED runtime identity: the
 * scoped effective permissions, scoped credential-grant REFERENCES (never
 * secret values — discrimination M7), the workspace identity and the
 * session binding. It returns an OBSERVATION. The shapes carry no
 * stores, services, authorities or ledgers (the tools adapter-shape
 * discipline) — a provider cannot mutate platform authority state
 * because it is structurally never handed any such surface.
 *
 * Runtime kinds are NEUTRAL strings ("local", "customer-hosted",
 * "hosted", or any future agent substrate — ADR-0016): vendor identity
 * never leaks into domain contracts, no provider-specific API type
 * crosses this port, and no provider becomes an authority. WORK-016
 * owns external/BYOA interoperability adapters; this port is the seam
 * those adapters will implement.
 */

import type { AutonomyMode } from "../../policies/public";
import type { CredentialGrantReference } from "../domain/credential";
import type { EffectivePermissions } from "../domain/permissions";
import type { WorkspaceIdentity } from "../domain/workspace";

/**
 * The explicit runtime identity of one governed agent session. Every
 * scope dimension is server-derived and explicit — tenant/application
 * scope is NEVER inferred from user-supplied runtime fields.
 */
export interface AgentRuntimeIdentity {
  readonly executionId: string;
  readonly sessionId: string;
  readonly agentId: string;
  readonly agentVersionId: string;
  readonly applicationId: string;
  readonly tenantId: string;
  /** The workspace execution-environment boundary (tenant/app/execution bound). */
  readonly workspace: Readonly<WorkspaceIdentity>;
  /** Policy-approved permissions ONLY (never the requested superset). */
  readonly permissions: Readonly<EffectivePermissions>;
  /** Scoped credential-grant REFERENCES (never raw secret values). */
  readonly credentials: readonly CredentialGrantReference[];
  /** The effective autonomy the policy granted this session. */
  readonly autonomy: AutonomyMode;
}

/** The task the agent runtime executes within the governed session. */
export interface AgentSessionTask {
  /** The agent version's immutable standing instruction. */
  readonly instructions: string;
  /** One-way digest of the session input (provenance without retention). */
  readonly inputDigest: string;
  /** Artifact references the session input binds to (no inline payloads). */
  readonly inputArtifactRefs: readonly string[];
  /** Wall-clock ceiling for the run (milliseconds). */
  readonly maxDurationMs: number;
}

/** Axis-neutral session observation classes (never verification classes). */
export const AGENT_SESSION_OUTCOME_CLASSES = ["session-success", "session-failure"] as const;
export type AgentSessionOutcomeClass = (typeof AGENT_SESSION_OUTCOME_CLASSES)[number];

/** The neutral observation a provider returns for one session run. */
export interface AgentSessionObservation {
  readonly outcomeClass: AgentSessionOutcomeClass;
  /** Digest of the produced output (provenance; full output stays session-side). */
  readonly outputDigest: string | null;
  /** Neutral, structured output (schema-free; never a provider-native type). */
  readonly output: Readonly<Record<string, unknown>> | null;
  /** Human-readable failure reason on session-failure. */
  readonly failureReason: string | null;
}

/**
 * The neutral agent-runtime adapter contract. Implementations (future
 * local/customer-hosted/hosted runtimes, WORK-016 BYOA adapters) receive
 * governed work only AFTER the session service's admission chain has
 * allowed it; they cannot bypass policy/capability/budget authorities
 * because those live upstream of this seam.
 */
export interface AgentProvider {
  /** Neutral runtime kind ("local" | "customer-hosted" | "hosted" | future). */
  readonly runtimeKind: string;
  /** Execute one governed agent session; failures surface as observations. */
  executeSession(
    identity: Readonly<AgentRuntimeIdentity>,
    task: Readonly<AgentSessionTask>,
  ): Promise<AgentSessionObservation>;
}

/** Composition-owned registry of available runtimes (never an authority). */
export interface AgentProviderRegistry {
  readonly runtimeKinds: readonly string[];
  providerFor(runtimeKind: string): AgentProvider | null;
}
