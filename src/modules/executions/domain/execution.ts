/**
 * Execution aggregate types (executions module domain; WORK-006).
 *
 * `createExecution(input, idempotencyKey, actor)` per `spec/contracts.md`
 * ("Execution creation"): the input identifies application/environment,
 * task, optional input artifact references, desired quality/cost/latency
 * constraints and optional user metadata. Provider selection is FORBIDDEN
 * in the public create contract (frozen platform rule) — there is no
 * provider/rail/connection field on the input type, the service rejects
 * unknown input keys (provider fields are unrepresentable, not merely
 * ignored), and the write-path scanner pins the type.
 *
 * Money, when constraints carry cost bounds, is integer micro-USD strings
 * only (the established WORK-004 convention; floats are never accepted).
 */

import type { ExecutionStatus } from "./state-machine";

/** Actor identity for provenance + scope (tenant is server-derived upstream). */
export interface ExecutionActor {
  readonly actorId: string;
  readonly tenantId: string;
}

/** Desired quality/cost/latency constraints. Cost bounds are micro-USD strings. */
export interface ExecutionConstraints {
  readonly maxCostMicroUsd?: string;
  readonly maxLatencyMs?: number;
  readonly minQuality?: number;
  readonly [key: string]: unknown;
}

/** The create input (provider-selection-free by construction). */
export interface ExecutionCreateInput {
  readonly applicationId: string;
  readonly environmentId?: string;
  readonly task: Readonly<Record<string, unknown>>;
  readonly inputArtifactRefs?: readonly string[];
  readonly constraints?: ExecutionConstraints;
  readonly metadata?: Readonly<Record<string, unknown>>;
  /** End user the execution (and any spend) is attributed to. */
  readonly userId?: string;
}

/** The exact input keys the create contract accepts — excess keys are rejected. */
export const CREATE_INPUT_KEYS: readonly string[] = [
  "applicationId",
  "environmentId",
  "task",
  "inputArtifactRefs",
  "constraints",
  "metadata",
  "userId",
];

/** Provider-selection vocabulary that must NEVER appear in a create input. */
export const FORBIDDEN_INPUT_KEYS: readonly string[] = [
  "provider",
  "providerId",
  "model",
  "modelId",
  "rail",
  "connectionId",
  "connection",
  "agent",
  "agentId",
];

/** The durable execution row as seen by readers (public shape, no secrets). */
export interface ExecutionRecord {
  readonly id: string;
  readonly applicationId: string;
  readonly tenantId: string;
  readonly environmentId: string | null;
  /** End user the execution (and any spend) is attributed to ('' when none). */
  readonly userId: string;
  readonly status: ExecutionStatus;
  readonly task: Readonly<Record<string, unknown>>;
  readonly inputArtifactRefs: readonly string[];
  readonly constraints: ExecutionConstraints | null;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly requestFingerprint: string;
  readonly lastEventSequence: number;
  readonly verificationRefs: readonly string[];
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly terminalAt: string | null;
}

/** Durable create/refresh outcome handed back for the SAME logical request. */
export interface ExecutionReceipt {
  readonly executionId: string;
  readonly applicationId: string;
  readonly tenantId: string;
  readonly environmentId: string | null;
  readonly status: ExecutionStatus;
  readonly lastEventSequence: number;
  readonly verificationRefs: readonly string[];
  readonly createdAt: string;
  readonly terminalAt: string | null;
  /** True when a previous request's durable outcome was replayed. */
  readonly replayed: boolean;
}
