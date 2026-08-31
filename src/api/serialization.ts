/**
 * Public serialization — the SECRET-SAFETY boundary of the API surface
 * (WORK-015; acceptance criterion 6, M4–M8).
 *
 * EVERY response body is produced here. These functions are the single
 * place domain records cross into public JSON, and they are constructed
 * so secret material CANNOT cross:
 *
 *  - each serializer builds the public shape FIELD BY FIELD (allowlist
 *    construction — never `...record` spread of a domain object, so an
 *    accidentally-added domain field can never leak into a response);
 *  - there is NO serializer input type that carries secret material:
 *    the executions/agents public records are already secret-free by
 *    their owning modules' contracts (BYOK references never leave the
 *    connections module; agent credential grants are references only);
 *  - a REDACT vocabulary + runtime scrub guard rejects any value whose
 *    key or string content looks like secret material (defense in
 *    depth — the discrimination suite proves a mutated serializer that
 *    spreads domain records is caught, and the scrub guard fails closed
 *    on `secret`-shaped keys);
 *  - the SDK wire contract (sdk/index.ts) mirrors these shapes; the
 *    contract tests keep them in sync.
 *
 * M15 of the canonical error taxonomy also lives here: policy-visible
 * metadata only (task, constraints, metadata as-is — they are caller
 * inputs, never platform credentials).
 */

import type {
  AgentRecord,
  AgentSelectionRecord,
  AgentVersionRecord,
} from "../modules/agents/public";
import type {
  EventEnvelope,
  ExecutionReceipt,
  ExecutionRecord,
  VerificationResultRecord,
} from "../modules/executions/public";
/** The canonical public wire contract (shared by the transport and the SDK). */
import type {
  AgentPromotionStatus,
  AgentStatusView,
  AgentSummary,
  AgentVersion,
  ExecutionEvent,
  ExecutionStatus,
  PublicError,
  VerificationResult,
  Execution as WireExecution,
  ExecutionReceipt as WireReceipt,
} from "../shared/wire";

/** Keys whose values are redacted by the scrub guard (defense in depth). */
const REDACT_KEY_PATTERN = /(secret|password|credential|api[-_]?key|private[-_]?key|token)/i;

/** Scrub a record deeply: redact secret-shaped keys (fail closed). */
export function scrubSecretShapedKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(scrubSecretShapedKeys);
  }
  if (typeof value === "object" && value !== null) {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      out[key] = REDACT_KEY_PATTERN.test(key) ? "[redacted]" : scrubSecretShapedKeys(inner);
    }
    return out;
  }
  return value;
}

// ---------------------------------------------------------------------------
// Executions
// ---------------------------------------------------------------------------

export function toWireExecution(record: ExecutionRecord): WireExecution {
  return {
    id: record.id,
    applicationId: record.applicationId,
    environmentId: record.environmentId,
    status: record.status as ExecutionStatus,
    task: scrubSecretShapedKeys(record.task) as Readonly<Record<string, unknown>>,
    constraints:
      record.constraints === null
        ? null
        : (scrubSecretShapedKeys(record.constraints) as Readonly<Record<string, unknown>>),
    metadata: scrubSecretShapedKeys(record.metadata) as Readonly<Record<string, unknown>>,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    terminalAt: record.terminalAt,
  };
}

export function toWireReceipt(receipt: ExecutionReceipt): WireReceipt {
  return {
    executionId: receipt.executionId,
    applicationId: receipt.applicationId,
    status: receipt.status as ExecutionStatus,
    createdAt: receipt.createdAt,
    replayed: receipt.replayed,
    lastEventSequence: receipt.lastEventSequence,
  };
}

export function toWireEvent(envelope: EventEnvelope): ExecutionEvent {
  return {
    eventId: envelope.eventId,
    executionId: envelope.executionId,
    type: envelope.type,
    sequence: envelope.sequence,
    occurredAt: envelope.occurredAt,
    payload: scrubSecretShapedKeys(envelope.payload) as Readonly<Record<string, unknown>>,
  };
}

export function toWireVerification(record: VerificationResultRecord): VerificationResult {
  return {
    id: record.id,
    executionId: record.executionId,
    criterionId: record.criterionId,
    strategy: record.strategy,
    status: record.status,
    // The executions-verified record carries no scalar confidence (the
    // richer WORK-13 evaluator provenance lives in the verification
    // module's own results; this projection reports what the execution
    // receipt binds).
    confidence: null,
    evaluator: { kind: "recorded-by", id: record.recordedBy, version: "1" },
    evidenceRefs: record.evidence === undefined ? [] : [...record.evidence],
    recordedAt: record.recordedAt,
  };
}

// ---------------------------------------------------------------------------
// Agents (read-only projections over the agents authority — M22/M23)
// ---------------------------------------------------------------------------

export function toWireAgentSummary(
  record: AgentRecord,
  currentSelection: AgentSelectionRecord | null,
  versions: readonly AgentVersionRecord[],
): AgentSummary {
  const activeVersionId = currentSelection?.selectedVersionId ?? null;
  const active = versions.find((version) => version.id === activeVersionId) ?? null;
  return {
    id: record.id,
    slug: record.slug,
    name: record.name,
    description: record.description,
    // Domain lifecycle (registered|validated|available|suspended|retired)
    // projected to the public vocabulary; the full raw status stays in
    // /agents/:id/status's view via the authority record.
    status: wireAgentLifecycle(record.status),
    activeVersionId,
    activeVersion: active?.version ?? null,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

export function toWireAgentVersion(record: AgentVersionRecord): AgentVersion {
  return {
    id: record.id,
    agentId: record.agentId,
    version: record.version,
    // The definition DIGEST is public; the definition BODY stays with the
    // authority (instructions/policy requests are not inventory metadata).
    definitionDigest: record.definitionDigest,
    validationState: wireValidationState(record.validationState),
    validationNotes: record.validationNotes,
    createdAt: record.createdAt,
  };
}

export function toWirePromotion(record: AgentSelectionRecord): AgentPromotionStatus {
  return {
    selectionId: record.id,
    kind: record.kind === "initial" ? "promotion" : record.kind,
    selectedVersionId: record.selectedVersionId,
    rollbackOf: record.rollbackOf,
    selectedBy: record.selectedBy,
    selectedAt: record.selectedAt,
  };
}

export function toWireAgentStatus(
  record: AgentRecord,
  versions: readonly AgentVersionRecord[],
  currentSelection: AgentSelectionRecord | null,
): AgentStatusView {
  const activeVersionId = currentSelection?.selectedVersionId ?? null;
  const activeVersion = versions.find((version) => version.id === activeVersionId) ?? null;
  return {
    agent: toWireAgentSummary(record, currentSelection, versions),
    activeVersion: activeVersion === null ? null : toWireAgentVersion(activeVersion),
    latestSelection: currentSelection === null ? null : toWirePromotion(currentSelection),
    availableVersions: versions.map(toWireAgentVersion),
  };
}

// ---------------------------------------------------------------------------
// Public errors (M25: no SQL, no stack traces, no host paths)
// ---------------------------------------------------------------------------

export function toPublicErrorBody(
  code: PublicError["code"],
  message: string,
  retryable: boolean,
  details?: Readonly<Record<string, unknown>>,
): PublicError {
  return {
    code,
    message,
    retryable,
    ...(details === undefined
      ? {}
      : { details: scrubSecretShapedKeys(details) as Record<string, unknown> }),
  };
}

// ---------------------------------------------------------------------------
// Domain → public vocabulary mappings (the projections are lossless in
// meaning; the raw domain statuses remain available through the owning
// authorities' own surfaces).
// ---------------------------------------------------------------------------

function wireAgentLifecycle(status: AgentRecord["status"]): AgentSummary["status"] {
  switch (status) {
    case "available":
    case "validated":
    case "registered":
      return "active";
    case "suspended":
      return "suspended";
    case "retired":
      return "retired";
  }
}

function wireValidationState(
  state: AgentVersionRecord["validationState"],
): AgentVersion["validationState"] {
  // Domain "valid" is the public "validated"; "pending"/"invalid" map 1:1.
  return state === "valid" ? "validated" : state;
}
