/**
 * Shared learning non-authority scanners (WORK-014 discrimination).
 *
 * One definition of the LEARNING-NONAUTHORITY boundary, two uses — the
 * architecture gate runs the rules over the REAL learning tree, and the
 * discrimination proofs mutate the REAL source and require the scanners
 * to flag exactly the weakened protection (the WORK-005/WORK-013
 * red-record pattern).
 *
 * Rules (each maps to a Work Order mutant):
 *  - `cross-module-import`        learning imports another module
 *                                 (M2 policy, M3 capability, M4 budget,
 *                                 M5 verification, M6 executions,
 *                                 M17 planning);
 *  - `platform-import`            inner layers touch the platform;
 *  - `planner-vocabulary`         M17: a second planning authority;
 *  - `execution-lifecycle`        M6: execution state authority;
 *  - `deterministicization-authority` M19: promotion/rollout ownership;
 *  - `provider-identifier`        M18: provider contract leak;
 *  - `scorecard-mutation-surface` M9: a scorecard update/delete path;
 *  - `shadow-class-unpinned`      M15: the record-class pin removed;
 *  - `authority-deps`             M7: a service/evaluator dep outside
 *                                 {store, digest, generateId, now}.
 */

import { PROVIDER_IDENTIFIER } from "./patterns";

export interface LearningBoundaryFile {
  readonly path: string;
  readonly content: string;
}

const CROSS_MODULE_IMPORT = /^\.\.\/\.\.\/([a-z0-9-]+)\//;
const PLATFORM_IMPORT = /^\.\.\/\.\.\/\.\.\/platform\//;
const PLANNER_VOCABULARY =
  /\b(selectStrategy|buildPlan|PLANNER_VERSION|planExecution|composeCandidates)\b/;
const EXECUTION_LIFECYCLE =
  /\b(nextState|canTransition|recordPlanningDecision|EXECUTION_COMMANDS|appendEvent|transitionExecution)\b/;
const DETERMINISTICIZATION_AUTHORITY =
  /\b(promoteCandidate|canaryRollout|rolloutReplacement|applyDeterministicReplacement|replaceRoute)\b/;
const SCORECARD_MUTATION = /\b(updateScorecard|deleteScorecard|mutateScorecard)\b/;
const SHADOW_CLASS_PIN = /recordClass\s*!==\s*["']shadow["']/;
const AUTHORITY_DEPS_FIELDS =
  /\breadonly\s+(store|digest|generateId|now|policy|policyInputs|budget|budgetAuthority|capability|capabilityAuthority|authorization|admission|routeExplorer|dispatch|executor|toolRuntime|sandbox)\s*:/g;

export function learningNonAuthorityViolations(files: readonly LearningBoundaryFile[]): string[] {
  const violations: string[] = [];

  for (const file of files) {
    const isAdapter = file.path.includes("/adapters/");
    const isInnerLayer =
      file.path.includes("/domain/") ||
      file.path.includes("/application/") ||
      file.path.includes("/ports/") ||
      file.path.endsWith("/public.ts");

    for (const specifier of [...file.content.matchAll(/from\s+["'](\.[^"']+)["']/g)].map(
      (match) => match[1] ?? "",
    )) {
      const cross = CROSS_MODULE_IMPORT.exec(specifier);
      if (cross !== null && cross[1] !== "shared") {
        violations.push(`cross-module-import:${file.path}:${cross[1]}`);
      }
      if (isInnerLayer && PLATFORM_IMPORT.test(specifier)) {
        violations.push(`platform-import:${file.path}`);
      }
    }

    if (PLANNER_VOCABULARY.test(file.content)) {
      violations.push(`planner-vocabulary:${file.path}`);
    }
    if (EXECUTION_LIFECYCLE.test(file.content)) {
      violations.push(`execution-lifecycle:${file.path}`);
    }
    if (DETERMINISTICIZATION_AUTHORITY.test(file.content)) {
      violations.push(`deterministicization-authority:${file.path}`);
    }
    if (SCORECARD_MUTATION.test(file.content)) {
      violations.push(`scorecard-mutation-surface:${file.path}`);
    }
    if (!isAdapter && PROVIDER_IDENTIFIER.test(file.content)) {
      violations.push(`provider-identifier:${file.path}`);
    }
  }

  // M15: the shadow record validation must physically pin class 'shadow'.
  const shadowDomain = files.find((file) => file.path.endsWith("/domain/shadow.ts"));
  if (shadowDomain === undefined || !SHADOW_CLASS_PIN.test(shadowDomain.content)) {
    violations.push("shadow-class-unpinned:src/modules/learning/domain/shadow.ts");
  }

  // M7: the learning services expose exactly the non-authoritative deps.
  for (const name of ["LearningServiceDeps", "ShadowEvaluatorDeps"]) {
    const owner =
      name === "LearningServiceDeps"
        ? files.find((file) => file.path.endsWith("/application/learning-service.ts"))
        : files.find((file) => file.path.endsWith("/application/shadow-evaluator.ts"));
    if (owner === undefined) {
      violations.push(`authority-deps:${name}:missing-owner`);
      continue;
    }
    const match = new RegExp(`interface ${name} \\{([\\s\\S]*?)\\}`).exec(owner.content);
    if (match === null) {
      violations.push(`authority-deps:${name}:missing-interface`);
      continue;
    }
    const fields = [...(match[1] ?? "").matchAll(AUTHORITY_DEPS_FIELDS)].map(
      (field) => field[1] ?? "",
    );
    const illegal = fields.filter(
      (field) => !["store", "digest", "generateId", "now"].includes(field),
    );
    for (const field of illegal) {
      violations.push(`authority-deps:${name}:${field}`);
    }
    for (const required of ["store", "digest", "generateId", "now"]) {
      if (!fields.includes(required)) {
        violations.push(`authority-deps:${name}:missing-${required}`);
      }
    }
  }

  return violations;
}

/**
 * Planner-side learning-consumption scanners (M1/M8/M13).
 *
 *  - `consultation-before-selection`: the learning consultation must
 *    happen AFTER the governed selection (an earlier consultation is
 *    the wiring half of "learning changes live routing");
 *  - `selection-ignores-learning`: the code between the selection call
 *    and the selected-candidate binding must not reference learning;
 *  - `selection-reference-mutated`: the durable record must bind
 *    `selectedStrategyId: selected.strategyId` (never a learning
 *    preference);
 *  - `adapter-validation-removed`: the planning learning adapter must
 *    validate every consulted signal (M13).
 */
export function plannerLearningViolations(plannerSource: string, adapterSource: string): string[] {
  const violations: string[] = [];

  const selectionCall = plannerSource.indexOf("const selection = selectStrategy(");
  const consultationCall = plannerSource.search(/deps\.learningSignals\??\.consult\(/);
  if (selectionCall === -1) {
    violations.push("missing-governed-selection");
  }
  if (consultationCall !== -1) {
    if (selectionCall === -1 || consultationCall < selectionCall) {
      violations.push("consultation-before-selection");
    }
    const selectedBinding = plannerSource.indexOf("const selected = selection.selected;");
    if (selectedBinding === -1 || consultationCall < selectedBinding) {
      violations.push("consultation-before-selected-binding");
    } else {
      // Between the selection call and the selected binding, learning
      // must not appear (the selection is computed free of learning).
      const segment = plannerSource.slice(selectionCall, selectedBinding);
      if (/learning/i.test(segment)) {
        violations.push("selection-segment-references-learning");
      }
    }
  }

  // The DURABLE decision record must bind the governed selection (the
  // unique record-shape pattern — never a learning preference).
  if (
    !plannerSource.includes(
      "selectedStrategyId: selected.strategyId,\n        selectionRationale: selection.rationale,",
    )
  ) {
    violations.push("selection-reference-mutated");
  }

  if (!adapterSource.includes("validateConsultedSignal(consulted)")) {
    violations.push("adapter-validation-removed");
  }

  return violations;
}
