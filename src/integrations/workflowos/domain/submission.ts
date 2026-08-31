/**
 * WorkflowOS submission domain (WORK-016 / WOS-001, WOS-004, AGT-007,
 * ACP-005 — the provider-neutral WorkflowOS-facing contract).
 *
 * THE CONCEPT-MAPPING CONTRACT (WOS-004) — conservative by design:
 *
 * ```text
 * WorkflowOS work/session/workspace/tool concept   Zeck concept
 * ---------------------------------------------------------------
 * workRef        (external reference)         → execution identity
 *                                              (submitted, never owned)
 * sessionRef     (external reference)         → opaque provenance echo
 * workspaceRef   (external reference)         → opaque provenance echo
 *                                              (or a Zeck environmentId
 *                                              when explicitly provided)
 * tool references (inside the task)           → the Zeck task vocabulary
 *                                              (capability resolution is
 *                                              the authorities' job)
 * WorkflowOS workflow/task lifecycle states   → NOT MAPPED — preserved as
 *                                              external references only
 *                                              (WorkflowOS owns them;
 *                                              WOS-002)
 * ```
 *
 * EXTERNAL REFERENCES ARE NEVER AUTHORIZATION: workRef/sessionRef/
 * workspaceRef are shape-validated OPAQUE strings. They never carry or
 * influence tenant/application scope — the effective scope is the
 * server-derived `IntegrationActor` (durable membership), and a request
 * carrying tenantId/applicationId keys is rejected fail-closed (the
 * closed-vocabulary rule, the WORK-015 M2/M3 discipline).
 *
 * NO SECOND STATE MACHINE: the mapping produces an ordinary
 * `ExecutionCreateInput` — the executions authority's own create path
 * (policy admission, idempotency arbitration, durable identity) is THE
 * only write path. This domain holds no lifecycle of its own.
 */

import type {
  ExecutionConstraints,
  ExecutionCreateInput,
} from "../../../modules/executions/public";

/** The server-derived scope of an integration caller (never from request). */
export interface IntegrationActor {
  readonly actorId: string;
  /** The application the integration principal is durably bound to. */
  readonly applicationId: string;
  readonly tenantId: string;
}

/** The exact keys the submission contract accepts — excess keys are rejected. */
export const SUBMISSION_INPUT_KEYS: readonly string[] = [
  "workRef",
  "sessionRef",
  "workspaceRef",
  "environmentId",
  "task",
  "inputArtifactRefs",
  "constraints",
  "metadata",
  "userId",
];

/**
 * Scope/authority vocabulary that must NEVER appear in a submission.
 * The application/tenant scope is derived server-side from the actor.
 */
export const SUBMISSION_FORBIDDEN_KEYS: readonly string[] = [
  "applicationId",
  "tenantId",
  "ownerId",
  "provider",
  "providerId",
  "executionId",
  "agentId",
];

/** Opaque external reference: printable ASCII, 1..200 chars (never parsed). */
const EXTERNAL_REF_PATTERN = /^[\x21-\x7e]{1,200}$/;

const WORKFLOWOS_IDEMPOTENCY_KEY_PATTERN = /^[\x21-\x7e]{1,200}$/;

/** The provider-neutral WorkflowOS execution-submission request. */
export interface WorkflowOsSubmissionRequest {
  /** The WorkflowOS work item being delegated (opaque external reference). */
  readonly workRef: string;
  /** The WorkflowOS session the submission belongs to (optional, opaque). */
  readonly sessionRef?: string;
  /** The WorkflowOS workspace the submission belongs to (optional, opaque). */
  readonly workspaceRef?: string;
  /**
   * A Zeck execution environment the workspace maps to (optional). This is
   * a REAL Zeck environment identifier — never a WorkflowOS workspace id.
   */
  readonly environmentId?: string;
  /** The Zeck task vocabulary (capability resolution stays with authorities). */
  readonly task: Readonly<Record<string, unknown>>;
  readonly inputArtifactRefs?: readonly string[];
  readonly constraints?: ExecutionConstraints;
  readonly metadata?: Readonly<Record<string, unknown>>;
  /** End user the execution (and any spend) is attributed to. */
  readonly userId?: string;
}

export type SubmissionCheck =
  | { readonly valid: true; readonly value: WorkflowOsSubmissionRequest }
  | { readonly valid: false; readonly reason: string };

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const checkExternalRef = (container: Record<string, unknown>, key: string): string | null => {
  const value = container[key];
  if (value === undefined) {
    return null;
  }
  if (typeof value !== "string" || !EXTERNAL_REF_PATTERN.test(value)) {
    return `${key} must be an opaque external reference (printable ASCII, 1..200 chars)`;
  }
  return null;
};

/** Pure, fail-closed validation of a WorkflowOS submission request. */
export function validateSubmissionRequest(input: unknown): SubmissionCheck {
  if (!isPlainObject(input)) {
    return { valid: false, reason: "submission request must be a JSON object" };
  }
  const raw = input as Record<string, unknown>;

  for (const key of Object.keys(raw)) {
    if (!SUBMISSION_INPUT_KEYS.includes(key)) {
      return {
        valid: false,
        reason: SUBMISSION_FORBIDDEN_KEYS.includes(key)
          ? `${key} is rejected: integration scope is derived server-side from the actor (never from the request)`
          : `unknown submission field: ${key}`,
      };
    }
  }

  const workRef = raw.workRef;
  if (typeof workRef !== "string" || !EXTERNAL_REF_PATTERN.test(workRef)) {
    return {
      valid: false,
      reason: "workRef is required (opaque external reference, printable ASCII, 1..200 chars)",
    };
  }
  for (const optionalRef of ["sessionRef", "workspaceRef"]) {
    const error = checkExternalRef(raw, optionalRef);
    if (error !== null) {
      return { valid: false, reason: error };
    }
  }
  const environmentId = raw.environmentId;
  if (environmentId !== undefined && typeof environmentId !== "string") {
    return { valid: false, reason: "environmentId must be a string (a Zeck environment id)" };
  }
  const task = raw.task;
  if (!isPlainObject(task) || Object.keys(task).length === 0) {
    return { valid: false, reason: "task must be a non-empty object (the Zeck task vocabulary)" };
  }
  const inputArtifactRefs = raw.inputArtifactRefs;
  if (
    inputArtifactRefs !== undefined &&
    (!Array.isArray(inputArtifactRefs) || inputArtifactRefs.some((ref) => typeof ref !== "string"))
  ) {
    return {
      valid: false,
      reason: "inputArtifactRefs must be an array of artifact reference strings",
    };
  }
  const constraints = raw.constraints;
  if (constraints !== undefined && !isPlainObject(constraints)) {
    return { valid: false, reason: "constraints must be an object when present" };
  }
  const metadata = raw.metadata;
  if (metadata !== undefined && !isPlainObject(metadata)) {
    return { valid: false, reason: "metadata must be an object when present" };
  }
  const userId = raw.userId;
  if (userId !== undefined && (typeof userId !== "string" || userId.length > 200)) {
    return { valid: false, reason: "userId must be a string (max 200 chars) when present" };
  }

  const value: WorkflowOsSubmissionRequest = {
    workRef,
    ...(raw.sessionRef === undefined ? {} : { sessionRef: raw.sessionRef as string }),
    ...(raw.workspaceRef === undefined ? {} : { workspaceRef: raw.workspaceRef as string }),
    ...(environmentId === undefined ? {} : { environmentId }),
    task,
    ...(inputArtifactRefs === undefined
      ? {}
      : { inputArtifactRefs: inputArtifactRefs as readonly string[] }),
    ...(constraints === undefined ? {} : { constraints: constraints as ExecutionConstraints }),
    ...(metadata === undefined ? {} : { metadata: metadata as Readonly<Record<string, unknown>> }),
    ...(userId === undefined ? {} : { userId }),
  };
  return { valid: true, value };
}

/** Pure validation of the integration idempotency key (the authority's shape). */
export function isValidIntegrationIdempotencyKey(key: string): boolean {
  return WORKFLOWOS_IDEMPOTENCY_KEY_PATTERN.test(key);
}

/** The provenance block the mapping embeds (external refs preserved, never state). */
export interface WorkflowOsExternalProvenance {
  readonly source: "workflowos";
  readonly workRef: string;
  readonly sessionRef?: string;
  readonly workspaceRef?: string;
}

/**
 * THE concept mapping (pure): a submission + the server-derived actor
 * scope → an ordinary `ExecutionCreateInput` for the executions
 * authority. External references are preserved as metadata provenance
 * (WOS-004) — never duplicated state, never scope.
 */
export function submissionToExecutionInput(
  request: WorkflowOsSubmissionRequest,
  actor: IntegrationActor,
): ExecutionCreateInput {
  const provenance: WorkflowOsExternalProvenance = {
    source: "workflowos",
    workRef: request.workRef,
    ...(request.sessionRef === undefined ? {} : { sessionRef: request.sessionRef }),
    ...(request.workspaceRef === undefined ? {} : { workspaceRef: request.workspaceRef }),
  };
  const metadata: Record<string, unknown> = {
    ...(request.metadata ?? {}),
    workflowos: provenance,
  };
  return {
    applicationId: actor.applicationId,
    ...(request.environmentId === undefined ? {} : { environmentId: request.environmentId }),
    task: request.task,
    ...(request.inputArtifactRefs === undefined
      ? {}
      : { inputArtifactRefs: request.inputArtifactRefs }),
    ...(request.constraints === undefined ? {} : { constraints: request.constraints }),
    metadata,
    ...(request.userId === undefined ? {} : { userId: request.userId }),
  };
}
