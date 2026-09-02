/**
 * Shared learned planning-policy boundary scanners (WORK-020
 * discrimination; LRN-002).
 *
 * One definition of the learned-policy non-authority boundary, two
 * uses — the discrimination proofs mutate the REAL source in memory
 * and require these scanners to flag exactly the weakened protection
 * (the WORK-005/WORK-013/WORK-014 red-record pattern), and the same
 * rules document the boundary for the architecture gate.
 *
 * Rules (each maps to a WORK-020 mutant):
 *  - `learned-policy-service-authority-deps`  the service's deps are
 *    exactly {store, digest, generateId, now} — no policy, capability,
 *    budget or execution authority (LEARNING-NONAUTHORITY);
 *  - `learned-policy-class-unpinned`          the frozen non-authority
 *    class check is present in the domain validation;
 *  - `publication-mode-vocabulary-mutated`    publication modes are
 *    exactly [canary, promoted] — 'shadow' is unrepresentable;
 *  - `evaluation-kind-vocabulary-mutated`     evaluation kinds are
 *    exactly [shadow, canary];
 *  - `learned-policy-mutation-surface`        no update/delete surface
 *    for learned policies/evaluations anywhere in learning;
 *  - `restriction-vocabulary-in-learning`     the learned-policy domain
 *    code carries NO policy restriction vocabulary (AC-2 at the
 *    source);
 *  - `canary-requires-publication-gate-removed`  the ran-in-canary
 *    gate is present in the service;
 *  - `publication-evidence-gates-removed`     the canary-requires-shadow
 *    and promoted-requires-both gates are present in the service;
 *  - `insufficient-evidence-gate-removed`     an insufficient-evidence
 *    evaluation never gates a publication.
 *
 * Planner-side rules (planner + adapter + strategy):
 *  - `consultation-before-admissibility`      the learned-policy
 *    consultation happens AFTER the hard policy admissibility filter;
 *  - `promoted-only-ordering-removed`         only a 'promoted'
 *    publication produces an ordering input;
 *  - `policy-recheck-removed`                 the ordering passes the
 *    CURRENT-policy recheck (learnedOrderingSubjects with `effective`);
 *  - `adapter-restriction-scan-removed`       the adapter scans the RAW
 *    learning output (and the projection) with the policies-owned
 *    restriction-vocabulary boundary;
 *  - `adapter-validation-removed`             the adapter validates the
 *    consulted record fail-closed;
 *  - `selection-reference-mutated`            the durable decision binds
 *    the governed selection, never a learned preference;
 *  - `deterministic-first-displaced`          the deterministic-first
 *    branch precedes the learned ordering branch in selectStrategy.
 */

import type { LearningBoundaryFile } from "./learning";

export type { LearningBoundaryFile };

/** Strip comments (block + line) so scanners hit CODE, not prose. */
export function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");
}

const LEARNED_POLICY_MUTATION =
  /\b(updateLearnedPolicy|deleteLearnedPolicy|mutateLearnedPolicy|updateLearnedPolicyEvaluation|deleteLearnedPolicyEvaluation)\b/;

const RESTRICTION_FIELD_KEYS =
  /\b(maxCostMicroUsd|minQuality|maxLatencyMs|allowedProviders|deniedProviders|allowedModels|deniedModels|allowedTools|deniedTools|allowedHosts|deniedHosts|allowedSecretRefs|deniedSecretRefs|maxAutonomy|minIsolation)\s*:/;

function parseVocabularyArray(source: string, name: string): string[] {
  const match = new RegExp(`export const ${name} = \\[([^\\]]*)\\] as const;`).exec(source);
  if (match === null) {
    return [];
  }
  return (match[1] ?? "")
    .split(",")
    .map((item) => item.trim().replaceAll('"', "").replaceAll("'", ""))
    .filter((item) => item.length > 0);
}

export function learnedPolicyNonAuthorityViolations(
  files: readonly LearningBoundaryFile[],
): string[] {
  const violations: string[] = [];

  // The learned-policy service exposes exactly the non-authoritative
  // quartet of deps.
  const service = files.find((file) =>
    file.path.endsWith("src/modules/learning/application/learned-policy-service.ts"),
  );
  if (service === undefined) {
    violations.push("learned-policy-service-authority-deps:missing-owner");
  } else {
    const match = /interface LearnedPolicyServiceDeps \{([\s\S]*?)\}/.exec(service.content);
    if (match === null) {
      violations.push("learned-policy-service-authority-deps:missing-interface");
    } else {
      const fields = [...(match[1] ?? "").matchAll(/readonly\s+(\w+)\s*:/g)].map(
        (field) => field[1] ?? "",
      );
      const illegal = fields.filter(
        (field) => !["store", "digest", "generateId", "now"].includes(field),
      );
      for (const field of illegal) {
        violations.push(`learned-policy-service-authority-deps:${field}`);
      }
      for (const required of ["store", "digest", "generateId", "now"]) {
        if (!fields.includes(required)) {
          violations.push(`learned-policy-service-authority-deps:missing-${required}`);
        }
      }
    }
    // The service-level gates (the explicit publication discipline).
    if (!service.content.includes("a canary evaluation requires a durable canary publication")) {
      violations.push("canary-requires-publication-gate-removed");
    }
    if (!service.content.includes("a canary publication requires a completed shadow evaluation")) {
      violations.push("publication-evidence-gates-removed:canary-requires-shadow");
    }
    if (
      !service.content.includes(
        "requires BOTH a shadow and a canary evaluation of this exact policy version",
      )
    ) {
      violations.push("publication-evidence-gates-removed:promoted-requires-both");
    }
    if (!service.content.includes("an insufficient-evidence record proves nothing")) {
      violations.push("insufficient-evidence-gate-removed");
    }
  }

  // The domain: the frozen non-authority class pin and the closed
  // vocabularies.
  const domain = files.find((file) =>
    file.path.endsWith("src/modules/learning/domain/learned-planning-policy.ts"),
  );
  if (domain === undefined) {
    violations.push("learned-policy-class-unpinned:missing-owner");
    violations.push("publication-mode-vocabulary-mutated:missing-owner");
    violations.push("evaluation-kind-vocabulary-mutated:missing-owner");
    violations.push("restriction-vocabulary-in-learning:missing-owner");
  } else {
    if (!domain.content.includes("policy.policyClass !== LEARNED_POLICY_CLASS")) {
      violations.push("learned-policy-class-unpinned");
    }
    const modes = parseVocabularyArray(domain.content, "LEARNED_POLICY_PUBLICATION_MODES");
    if (
      modes.length !== 2 ||
      !modes.includes("canary") ||
      !modes.includes("promoted") ||
      modes.includes("shadow")
    ) {
      violations.push("publication-mode-vocabulary-mutated");
    }
    const kinds = parseVocabularyArray(domain.content, "LEARNED_POLICY_EVALUATION_KINDS");
    if (kinds.length !== 2 || !kinds.includes("shadow") || !kinds.includes("canary")) {
      violations.push("evaluation-kind-vocabulary-mutated");
    }
    if (RESTRICTION_FIELD_KEYS.test(stripComments(domain.content))) {
      violations.push("restriction-vocabulary-in-learning");
    }
  }

  // No update/delete surface for the learned-policy axis anywhere in
  // the learning tree.
  for (const file of files) {
    if (LEARNED_POLICY_MUTATION.test(stripComments(file.content))) {
      violations.push(`learned-policy-mutation-surface:${file.path}`);
    }
  }

  return violations;
}

export function plannerLearnedPolicyViolations(
  plannerSource: string,
  adapterSource: string,
  strategySource: string,
): string[] {
  const violations: string[] = [];

  // The consultation happens AFTER the hard policy admissibility
  // filter (an earlier consultation is the wiring half of "learning
  // changes live routing").
  const admissibilityCall = plannerSource.indexOf("filterAdmissibility(candidate, effective)");
  const consultationCall = plannerSource.indexOf("deps.learnedPolicy.consult(");
  if (admissibilityCall === -1) {
    violations.push("missing-admissibility-filter");
  }
  if (
    consultationCall !== -1 &&
    (admissibilityCall === -1 || consultationCall < admissibilityCall)
  ) {
    violations.push("consultation-before-admissibility");
  }

  // ONLY a promoted publication produces an ordering input.
  if (!plannerSource.includes('view.publicationMode === "promoted"')) {
    violations.push("promoted-only-ordering-removed");
  }

  // The ordering passes the CURRENT-policy recheck.
  if (!plannerSource.includes("learnedOrderingSubjects(preference, effective)")) {
    violations.push("policy-recheck-removed");
  }

  // The adapter scans the RAW learning output with the policies-owned
  // restriction-vocabulary boundary (and the projection again).
  if (!adapterSource.includes("assertLearnedOutputFreeOfRestrictions(view.policy)")) {
    violations.push("adapter-restriction-scan-removed");
  }
  if (
    !adapterSource.includes("assertLearnedOutputFreeOfRestrictions(view.publication)") ||
    !adapterSource.includes("assertLearnedOutputFreeOfRestrictions(consulted)")
  ) {
    violations.push("adapter-projection-scan-removed");
  }
  if (!adapterSource.includes("validateConsultedLearnedPolicy(consulted)")) {
    violations.push("adapter-validation-removed");
  }

  // The DURABLE decision record must bind the governed selection.
  if (
    !plannerSource.includes(
      "selectedStrategyId: selected.strategyId,\n        selectionRationale: selection.rationale,",
    )
  ) {
    violations.push("selection-reference-mutated");
  }

  // The deterministic-first branch precedes the learned ordering
  // branch in selectStrategy (ADR-0007 is untouchable). The learned
  // branch is located by its CALL SITE (the import appears at the top
  // of the file); the deterministic branch by its guard.
  const deterministicBranch = strategySource.indexOf('sufficiency.outcome === "sufficient"');
  const learnedBranch = strategySource.indexOf("compareLearnedThenCheapFirst(a, b, learnedOrder)");
  if (deterministicBranch === -1 || learnedBranch === -1) {
    violations.push("deterministic-first-displaced:missing-branch");
  } else if (deterministicBranch > learnedBranch) {
    violations.push("deterministic-first-displaced");
  }

  return violations;
}
