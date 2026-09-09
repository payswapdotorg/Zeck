/**
 * Deterministic provenance audit (platform execution-ir plane; WORK-049).
 *
 * Proves the exact, replayable provenance chain
 *
 *   governed plan (snapshot) → derived Execution IR → decision record
 *
 * with ZERO trust in the presented artifacts: every link is re-derived
 * and re-verified from the inputs:
 *
 *  1. the IR is re-validated (shape, vocabularies, structure, both
 *     content identities — including the losslessness proof: the plan
 *     semantics reconstructed from the IR must digest to the governed
 *     `planId`);
 *  2. the IR is RE-DERIVED from the snapshot: the re-derivation must
 *     produce the identical `irId` (re-derivation drift is a typed
 *     violation — identity idempotency);
 *  3. when a decision record is audited: it is re-validated (both
 *     digests), its plan/IR identities must match the audited chain, its
 *     provenance chain must be exact, and its hard constraints must
 *     hold against the IR and its recorded candidates;
 *  4. when a durable record is audited: it must come from the
 *     authoritative store (the ONLY durable decision-record authority) —
 *     the durable row's content must equal the presented record.
 *
 * The audit is PURE over its inputs (the durable variant takes the
 * store port) and returns bounded, typed violations instead of
 * throwing, so an auditor sees every broken link at once.
 */

import type { OptimizationConstraint } from "./constraints";
import { enforceHardConstraints } from "./constraints";
import type { CandidateRepresentation } from "./cost-model";
import { validateCandidateRepresentation } from "./cost-model";
import type { OptimizationDecisionRecord } from "./decision-record";
import { validateOptimizationDecision } from "./decision-record";
import type { OptimizationDecisionStore } from "./decision-store";
import type { ExecutionIr, GovernedPlanSnapshot, IrDigestPort } from "./ir";
import { deriveExecutionIr, validateExecutionIr } from "./ir";

/** The closed audit-violation vocabulary. */
export const PROVENANCE_AUDIT_CODES = [
  "ir-invalid",
  "re-derivation-drift",
  "plan-identity-chain-broken",
  "decision-invalid",
  "decision-ir-mismatch",
  "decision-plan-mismatch",
  "decision-provenance-broken",
  "hard-constraint-violation",
  "durable-record-foreign",
] as const;
export type ProvenanceAuditCode = (typeof PROVENANCE_AUDIT_CODES)[number];

export interface ProvenanceAuditViolation {
  readonly code: ProvenanceAuditCode;
  readonly detail: string;
}

export interface ProvenanceAuditResult {
  readonly ok: boolean;
  readonly violations: readonly ProvenanceAuditViolation[];
  /** The re-derived IR identity (evidence of the replay). */
  readonly derivedIrId: string | null;
}

const DETAIL_MAX = 300;

function detail(text: string): string {
  return text.length > DETAIL_MAX ? `${text.slice(0, DETAIL_MAX)}…` : text;
}

export interface ProvenanceAuditInput {
  readonly snapshot: GovernedPlanSnapshot;
  readonly ir: ExecutionIr;
  /** The decision record to audit against the chain, when present. */
  readonly decision?: OptimizationDecisionRecord;
  readonly digest: IrDigestPort;
}

/**
 * Audit the plan→IR (→ decision) provenance chain. Deterministic,
 * total, pure: same inputs, same verdict.
 */
export function auditExecutionProvenance(input: ProvenanceAuditInput): ProvenanceAuditResult {
  const violations: ProvenanceAuditViolation[] = [];

  // 1. Re-validate the presented IR (includes the losslessness proof:
  //    reconstructed plan semantics must digest to the governed planId).
  let ir: ExecutionIr | null = null;
  try {
    ir = validateExecutionIr(input.ir, input.digest);
  } catch (error) {
    violations.push({
      code: "ir-invalid",
      detail: detail(String(error)),
    });
  }

  // 2. Re-derive from the snapshot: identity idempotency (drift detection).
  let derivedIrId: string | null = null;
  try {
    const derived = deriveExecutionIr(input.snapshot, input.digest);
    derivedIrId = derived.irId;
    if (ir !== null && derived.irId !== ir.irId) {
      violations.push({
        code: "re-derivation-drift",
        detail: detail(
          `re-derivation produced irId ${derived.irId} but the presented IR carries ${ir.irId}`,
        ),
      });
    }
    if (ir !== null && derived.planId !== ir.planId) {
      violations.push({
        code: "plan-identity-chain-broken",
        detail: detail(
          `snapshot planId ${derived.planId} does not match the IR planId ${ir.planId}`,
        ),
      });
    }
  } catch (error) {
    violations.push({
      code: "ir-invalid",
      detail: detail(`snapshot re-derivation failed: ${String(error)}`),
    });
  }

  // 3. The decision record chain.
  if (input.decision !== undefined) {
    let decision: OptimizationDecisionRecord | null = null;
    try {
      decision = validateOptimizationDecision(input.decision, input.digest);
    } catch (error) {
      violations.push({
        code: "decision-invalid",
        detail: detail(String(error)),
      });
    }
    if (decision !== null && ir !== null) {
      if (decision.irId !== ir.irId) {
        violations.push({
          code: "decision-ir-mismatch",
          detail: detail(`decision irId ${decision.irId} does not match the audited IR ${ir.irId}`),
        });
      }
      if (decision.planId !== ir.planId) {
        violations.push({
          code: "decision-plan-mismatch",
          detail: detail(
            `decision planId ${decision.planId} does not match the audited IR plan ${ir.planId}`,
          ),
        });
      }
      if (
        decision.provenance.planProvenance.planId !== decision.planId ||
        decision.provenance.derivationProvenance.irId !== decision.irId
      ) {
        violations.push({
          code: "decision-provenance-broken",
          detail: "decision provenance does not match its own plan/IR identities",
        });
      }
      // Hard constraints must hold for the recorded decision.
      const constraints = decision.constraints as readonly OptimizationConstraint[];
      const candidates = decision.candidates.map((candidate) =>
        validateCandidateRepresentation({
          candidateId: candidate.candidateId,
          representationClass: candidate.representationClass,
          claim: candidate.claim,
        }),
      ) as readonly CandidateRepresentation[];
      const constraintViolations = enforceHardConstraints(ir, candidates, constraints);
      for (const violation of constraintViolations) {
        violations.push({
          code: "hard-constraint-violation",
          detail: detail(
            `${violation.code} on constraint ${violation.constraintId}: ${violation.detail}`,
          ),
        });
      }
    }
  }

  return { ok: violations.length === 0, violations, derivedIrId };
}

export interface DurableProvenanceAuditInput {
  readonly applicationId: string;
  readonly decisionId: string;
  readonly snapshot: GovernedPlanSnapshot;
  readonly ir: ExecutionIr;
  /** The AUTHORITATIVE durable store (the only decision-record authority). */
  readonly store: OptimizationDecisionStore;
  readonly digest: IrDigestPort;
}

export interface DurableProvenanceAuditResult extends ProvenanceAuditResult {
  readonly durableDecision: OptimizationDecisionRecord | null;
}

/**
 * Audit a DURABLE decision record: the record must be served by the
 * authoritative store (durable evidence outside the authoritative store
 * is rejected), then the full chain is audited deterministically.
 */
export async function auditDurableExecutionProvenance(
  input: DurableProvenanceAuditInput,
): Promise<DurableProvenanceAuditResult> {
  const durable = await input.store.get(input.applicationId, input.decisionId);
  if (durable === null) {
    return {
      ok: false,
      derivedIrId: null,
      durableDecision: null,
      violations: [
        {
          code: "durable-record-foreign",
          detail: detail(
            `decision ${input.decisionId} was not found in the authoritative store for application ${input.applicationId}`,
          ),
        },
      ],
    };
  }
  const audited = auditExecutionProvenance({
    snapshot: input.snapshot,
    ir: input.ir,
    decision: durable,
    digest: input.digest,
  });
  return { ...audited, durableDecision: durable };
}
