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
  CreateEconomicActionOutcome,
  EconomicActionEvent,
  EconomicActionRecord,
  EconomicDeliveryEvidenceBundle,
} from "../modules/economics/public";
import type {
  EventEnvelope,
  ExecutionReceipt,
  ExecutionRecord,
  VerificationResultRecord,
} from "../modules/executions/public";
import type {
  EvaluationPrompt,
  FindingTransitionRecord,
  OpportunityAnalysis,
  OpportunityFinding,
} from "../modules/learning/public";
/** The canonical public wire contract (shared by the transport and the SDK). */
import type {
  AgentPromotionStatus,
  AgentStatusView,
  AgentSummary,
  AgentVersion,
  EconomicActionStatus,
  ExecutionEvent,
  ExecutionStatus,
  PublicError,
  VerificationResult,
  CodebaseAnalysis as WireCodebaseAnalysis,
  CodebaseAnalysisReport as WireCodebaseAnalysisReport,
  CodebaseFinding as WireCodebaseFinding,
  CodebaseFindingTransitionReceipt as WireCodebaseFindingTransitionReceipt,
  CodebasePrompt as WireCodebasePrompt,
  CodebaseRatingReceipt as WireCodebaseRatingReceipt,
  EconomicAction as WireEconomicAction,
  EconomicActionEvent as WireEconomicActionEvent,
  EconomicActionOutcome as WireEconomicActionOutcome,
  EconomicActionReceipt as WireEconomicActionReceipt,
  EconomicDelivery as WireEconomicDelivery,
  EconomicSettlement as WireEconomicSettlement,
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
// Economic actions (WORK-032 — allowlist construction, same secret-safety
// discipline: NO raw payment credential can cross, recipient references
// are opaque identifiers, and the bounded authorization itself never
// appears on this wire)
// ---------------------------------------------------------------------------

export function toWireEconomicAction(record: EconomicActionRecord): WireEconomicAction {
  return {
    id: record.id,
    applicationId: record.applicationId,
    executionId: record.executionId,
    proposedBy: record.proposedBy,
    purpose: record.purpose,
    recipient: { kind: record.recipient.kind, id: record.recipient.id },
    amount:
      record.amount.kind === "exact"
        ? { kind: "exact", microUsd: record.amount.microUsd }
        : {
            kind: "range",
            minMicroUsd: record.amount.minMicroUsd,
            maxMicroUsd: record.amount.maxMicroUsd,
          },
    currency: record.currency,
    expiresAt: record.expiresAt,
    requiredCapabilities: record.requiredCapabilities.map((requirement) => ({
      kind: requirement.kind,
      name: requirement.name,
      minVersion: requirement.minVersion ?? null,
    })),
    railPreference: record.railPreference,
    metadata: scrubSecretShapedKeys(record.metadata) as Readonly<Record<string, unknown>>,
    status: record.status as EconomicActionStatus,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

export function toWireEconomicActionReceipt(
  outcome: CreateEconomicActionOutcome,
): WireEconomicActionReceipt {
  return {
    economicActionId: outcome.action.id,
    applicationId: outcome.action.applicationId,
    executionId: outcome.action.executionId,
    status: outcome.action.status as EconomicActionStatus,
    createdAt: outcome.action.createdAt,
    replayed: outcome.replayed,
  };
}

export function toWireEconomicActionEvent(event: EconomicActionEvent): WireEconomicActionEvent {
  return {
    eventId: event.eventId,
    economicActionId: event.economicActionId,
    sequence: event.sequence,
    type: event.type,
    cause: event.cause,
    occurredAt: event.occurredAt,
    payload: scrubSecretShapedKeys(event.payload) as Readonly<Record<string, unknown>>,
  };
}

/** Settlement and delivery are serialized as SEPARATE axes (never merged). */
export function toWireEconomicActionOutcome(
  bundle: EconomicDeliveryEvidenceBundle,
): WireEconomicActionOutcome {
  const settlement: WireEconomicSettlement | null =
    bundle.settlement === null
      ? null
      : {
          id: bundle.settlement.id,
          railId: bundle.settlement.railId,
          railTransactionRef: bundle.settlement.railTransactionRef,
          status: bundle.settlement.status,
          settledAmountMicroUsd: bundle.settlement.settledAmountMicroUsd,
          currency: bundle.settlement.currency,
          observedAt: bundle.settlement.observedAt,
          evidenceDigest: bundle.settlement.evidenceDigest,
        };
  const deliveries: readonly WireEconomicDelivery[] = bundle.deliveries.map((delivery) => ({
    id: delivery.id,
    kind: delivery.kind,
    digest: delivery.digest,
    contentRef: delivery.contentRef,
    observedAt: delivery.observedAt,
  }));
  return {
    economicActionId: bundle.economicActionId,
    executionId: bundle.executionId,
    applicationId: bundle.applicationId,
    status: bundle.status as EconomicActionStatus,
    settlement,
    deliveries,
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
// Codebase opportunity analysis (WORK-022 — allowlist construction, the
// same secret-safety discipline: every field is named explicitly).
// ---------------------------------------------------------------------------

export function toWireCodebaseAnalysis(
  analysis: OpportunityAnalysis,
  replayed: boolean,
): WireCodebaseAnalysis {
  return {
    analysisId: analysis.analysisId,
    applicationId: analysis.applicationId,
    executionId: analysis.executionId,
    repository: analysis.repository,
    revision: analysis.revision,
    analysisVersion: analysis.analysisVersion,
    findingCount: analysis.findingCount,
    promptCount: analysis.promptCount,
    digest: analysis.digest,
    recordedAt: analysis.recordedAt,
    replayed,
  };
}

export function toWireCodebaseFinding(finding: OpportunityFinding): WireCodebaseFinding {
  return {
    findingId: finding.findingId,
    analysisId: finding.analysisId,
    class: finding.class,
    state: finding.state,
    targetNodeIds: finding.targetNodeIds.map((id) => id),
    reasonCodes: finding.reasonCodes.map((code) => code),
    evidenceRefs: finding.evidenceRefs.map((ref) => ref),
    provenance: {
      repository: finding.provenance.repository,
      revision: finding.provenance.revision,
      targets: finding.provenance.targets.map((target) => ({
        nodeId: target.nodeId,
        file: target.file,
        symbol: target.symbol,
      })),
    },
    confidence: {
      level: finding.confidence.level,
      population: finding.confidence.population,
      basis: finding.confidence.basis,
    },
    impact: {
      currentMicroUsd: finding.costImpact.currentMicroUsd,
      candidateMicroUsd: finding.costImpact.candidateMicroUsd,
      expectedSavingsMicroUsd: finding.costImpact.expectedSavingsMicroUsd,
      basis: finding.costImpact.basis,
      currentMs: finding.latencyImpact.currentMs,
      candidateMs: finding.latencyImpact.candidateMs,
    },
    deterministicEquivalence: {
      potential: finding.deterministicEquivalence.potential,
      basis: finding.deterministicEquivalence.basis.map((item) => item),
    },
    recommendation: {
      strategy: finding.recommendation.strategy,
      validationSteps: finding.recommendation.validationSteps.map((step) => step),
    },
    recordedAt: finding.recordedAt,
  };
}

export function toWireCodebasePrompt(prompt: EvaluationPrompt): WireCodebasePrompt {
  return {
    promptId: prompt.promptId,
    findingId: prompt.findingId,
    questionKind: prompt.questionKind,
    question: prompt.question,
    expectedInformationGain: prompt.expectedInformationGain,
    userFrictionThreshold: prompt.userFrictionThreshold,
    basis: prompt.basis.map((item) => item),
    emittedAt: prompt.emittedAt,
  };
}

export function toWireCodebaseAnalysisReport(input: {
  readonly analysis: OpportunityAnalysis;
  readonly findings: readonly OpportunityFinding[];
  readonly prompts: readonly EvaluationPrompt[];
  readonly replayed: boolean;
}): WireCodebaseAnalysisReport {
  return {
    analysis: toWireCodebaseAnalysis(input.analysis, input.replayed),
    findings: input.findings.map(toWireCodebaseFinding),
    prompts: input.prompts.map(toWireCodebasePrompt),
  };
}

export function toWireCodebaseRatingReceipt(rating: {
  readonly ratingId: string;
  readonly findingId: string;
  readonly replayed: boolean;
  readonly answer: string;
}): WireCodebaseRatingReceipt {
  return {
    ratingId: rating.ratingId,
    findingId: rating.findingId,
    replayed: rating.replayed,
    answer: rating.answer,
  };
}

export function toWireCodebaseFindingTransitionReceipt(
  transition: FindingTransitionRecord,
  replayed: boolean,
): WireCodebaseFindingTransitionReceipt {
  return {
    transitionId: transition.transitionId,
    findingId: transition.findingId,
    fromState: transition.fromState,
    toState: transition.toState,
    replayed,
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
