/**
 * Shared deterministic-first planner order scanner (WORK-009).
 *
 * One definition of the ADR-0007 ordering boundary, two uses — the
 * architecture gate over the REAL planner source, and the discrimination
 * proofs over synthetic bypass mutations — so a weakened protection is
 * provably rejected (the WORK-005 `capability-gate-order.ts` pattern).
 *
 * The boundary under protection: in the planner's `planExecution`
 * pipeline, the model route explorer (`routeExplorer.explore(`) may be
 * consulted ONLY AFTER the deterministic-sufficiency decision — a real
 * call: `const sufficiency = sufficiencyEvaluator(` — AND only inside a
 * conditional gated on the sufficiency outcome NOT being `sufficient`.
 * A provider-first planner (explorer before sufficiency), an ungated
 * explorer call, or a sufficiency decision replaced by a constant (the
 * evaluator never consulted) are all violations.
 */

const SUFFICIENCY_ASSIGN_CALL = /const\s+sufficiency\s*=\s*sufficiencyEvaluator\(/;
const EXPLORER_CALL = "routeExplorer.explore(";
const GATING_CONDITIONAL = 'sufficiency.outcome !== "sufficient"';

export function plannerOrderViolations(source: string): string[] {
  const violations: string[] = [];

  const assignMatch = SUFFICIENCY_ASSIGN_CALL.exec(source);
  if (assignMatch === null) {
    violations.push("missing-deterministic-sufficiency-decision");
  }
  const sufficiencyIndex = assignMatch === null ? -1 : assignMatch.index;

  const explorerIndex = source.indexOf(EXPLORER_CALL);
  if (explorerIndex === -1) {
    // Scanner sanity: the explorer seam under protection must exist.
    violations.push("no-route-explorer-call-found");
    return violations;
  }

  // 1. The sufficiency decision must exist BEFORE the explorer call.
  if (sufficiencyIndex === -1 || sufficiencyIndex > explorerIndex) {
    violations.push("route-exploration-before-deterministic-sufficiency");
  }

  // 2. The explorer call must be gated on the sufficiency outcome — the
  //    governing conditional must appear between the sufficiency decision
  //    and the explorer call (an ungated call is an always-consult
  //    provider-first mutant).
  const conditionalIndex = source.lastIndexOf(GATING_CONDITIONAL, explorerIndex);
  if (conditionalIndex === -1 || (sufficiencyIndex !== -1 && conditionalIndex < sufficiencyIndex)) {
    violations.push("route-exploration-not-gated-on-sufficiency-outcome");
  }

  // 3. Every explorer call site must obey the same rules.
  let callIndex = source.indexOf(EXPLORER_CALL);
  while (callIndex !== -1) {
    const precedingSufficiency =
      SUFFICIENCY_ASSIGN_CALL.exec(source.slice(0, callIndex))?.index ?? -1;
    const precedingConditional = source.lastIndexOf(GATING_CONDITIONAL, callIndex);
    if (precedingSufficiency === -1 || precedingSufficiency > callIndex) {
      violations.push(`explorer-call-before-sufficiency@${callIndex}`);
    }
    if (precedingConditional === -1 || precedingConditional < precedingSufficiency) {
      violations.push(`explorer-call-ungated@${callIndex}`);
    }
    callIndex = source.indexOf(EXPLORER_CALL, callIndex + 1);
  }

  return violations;
}
