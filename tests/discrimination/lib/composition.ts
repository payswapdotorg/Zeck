/**
 * Shared tool-composition non-authority scanners (WORK-017
 * discrimination).
 *
 * One definition of the WORK-017 boundaries, two uses — the
 * architecture gate runs related rules over the REAL trees, and the
 * discrimination proofs mutate the REAL source and require the
 * scanners to flag exactly the weakened protection (the WORK-014
 * red-record pattern).
 *
 * Rules (each maps to a Work Order mutant):
 *  - `synthesis-vocabulary`        M24: WORK-018's synthesis surface
 *                                  appearing in the composition trees;
 *  - `dispatch-vocabulary`         M19: a composition service gaining
 *                                  an execution/dispatch surface;
 *  - `authority-deps`              M19: the composition advisor deps
 *                                  outside {store, digest, generateId,
 *                                  now};
 *  - `history-mutation-surface`    M15: a set/activation update/delete
 *                                  path appearing;
 *  - `floor-removed`               M10: the minimum-population floor
 *                                  removed from the analysis;
 *  - `cycle-check-removed`         M7: the deterministic cycle check
 *                                  removed from the composition
 *                                  validation;
 *  - `policy-gate-removed`         M5: the consultation policy gate
 *                                  removed from the planning domain;
 *  - `adapter-validation-removed`  M11/M12/M13/M26: the planning
 *                                  adapter's fail-closed validation
 *                                  removed;
 *  - `selection-reference-mutated` M18: the durable decision binding
 *                                  the composition preference instead
 *                                  of the governed selection;
 *  - `consultation-before-selection` M18: the composition consultation
 *                                  moved before the governed selection;
 *  - `provenance-removed`          M11: the recommendation validation
 *                                  dropping the provenance requirement;
 *  - `window-removed`              M12: the evaluation-window
 *                                  requirement dropped.
 */

export interface CompositionBoundaryFile {
  readonly path: string;
  readonly content: string;
}

const SYNTHESIS_VOCABULARY =
  /\b(generateProgram|synthesizeTool|synthesizedTool|emitCode|codegen|compiledTool|ephemeralProgram)\b/;
const DISPATCH_VOCABULARY =
  /\b(executeTool|dispatchTool|invokeTool|runComposition|executeComposition)\b/;
const HISTORY_MUTATION_VOCABULARY =
  /\b(updateRecommendationSet|deleteRecommendationSet|mutateRecommendation|rewriteHistory)\b/;

export function compositionLearningViolations(files: readonly CompositionBoundaryFile[]): string[] {
  const violations: string[] = [];
  for (const file of files) {
    if (SYNTHESIS_VOCABULARY.test(file.content)) {
      violations.push(`synthesis-vocabulary:${file.path}`);
    }
    if (DISPATCH_VOCABULARY.test(file.content)) {
      violations.push(`dispatch-vocabulary:${file.path}`);
    }
    if (HISTORY_MUTATION_VOCABULARY.test(file.content)) {
      violations.push(`history-mutation-surface:${file.path}`);
    }
  }

  // M19: the composition advisor exposes exactly the
  // non-authoritative quartet.
  const advisor = files.find((file) =>
    file.path.endsWith("learning/application/composition-advisor.ts"),
  );
  if (advisor === undefined) {
    violations.push("authority-deps:missing-advisor");
  } else {
    const match = /interface CompositionAdvisorDeps \{([\s\S]*?)\}/.exec(advisor.content);
    if (match === null) {
      violations.push("authority-deps:missing-interface");
    } else {
      const fields = [...(match[1] ?? "").matchAll(/readonly\s+(\w+)\s*:/g)].map(
        (field) => field[1] ?? "",
      );
      for (const field of fields) {
        if (!["store", "digest", "generateId", "now"].includes(field)) {
          violations.push(`authority-deps:${field}`);
        }
      }
    }
  }

  // M10: the minimum-population floor guards the supported status.
  const analysis = files.find((file) =>
    file.path.endsWith("learning/domain/composition-analysis.ts"),
  );
  if (analysis === undefined) {
    violations.push("floor-removed:missing-analysis");
  } else if (!analysis.content.includes("population < MINIMUM_SEQUENCE_POPULATION")) {
    violations.push("floor-removed:analysis");
  }

  // M7: the deterministic cycle check guards the composition shape.
  const composition = files.find((file) => file.path.endsWith("learning/domain/composition.ts"));
  if (composition === undefined) {
    violations.push("cycle-check-removed:missing-composition");
  } else if (!composition.content.includes("compositionCycleExists(composition)")) {
    violations.push("cycle-check-removed:composition");
  }

  // M11/M12: the recommendation validation keeps the provenance and
  // the evaluation-window requirements.
  if (analysis !== undefined) {
    if (!analysis.content.includes("refs.length === 0")) {
      violations.push("provenance-removed:analysis-validation");
    }
    if (!/must be a non-empty timestamp \(M12 evaluation window\)/.test(analysis.content)) {
      violations.push("window-removed:analysis-validation");
    }
  }

  return violations;
}

export function plannerCompositionViolations(
  plannerSource: string,
  adapterSource: string,
  consultationSource: string,
): string[] {
  const violations: string[] = [];

  // M18: the consultation must happen AFTER the governed selection.
  const selectionCall = plannerSource.indexOf("const selection = selectStrategy(");
  const compositionCall = plannerSource.search(/deps\.compositionRecommendations\??\.consult\(/);
  if (compositionCall !== -1) {
    if (selectionCall === -1 || compositionCall < selectionCall) {
      violations.push("consultation-before-selection");
    }
    const selectedBinding = plannerSource.indexOf("const selected = selection.selected;");
    if (selectedBinding === -1 || compositionCall < selectedBinding) {
      violations.push("consultation-before-selected-binding");
    }
  }

  // M18: the durable decision must bind the governed selection.
  if (
    !plannerSource.includes(
      "selectedStrategyId: selected.strategyId,\n        selectionRationale: selection.rationale,",
    )
  ) {
    violations.push("selection-reference-mutated");
  }

  // M11/M12/M13/M26: the planning adapter validates every consulted
  // recommendation.
  if (!adapterSource.includes("validateConsultedCompositionRecommendation(consulted)")) {
    violations.push("adapter-validation-removed");
  }

  // M5: the consultation domain's policy gate must reject forbidden
  // tools before any preference is computed.
  if (!consultationSource.includes("deniedTools?.includes(toolId) === true")) {
    violations.push("policy-gate-removed");
  }

  return violations;
}
