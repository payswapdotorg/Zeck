/**
 * Shared codebase-opportunity boundary scanners (WORK-022
 * discrimination).
 *
 * One definition of the opportunity-analysis boundary, two uses — the
 * architecture gate (tests/architecture/opportunity-analysis-boundary)
 * runs the rules over the REAL tree, and the discrimination proofs
 * mutate the REAL source in memory and require the scanners to flag
 * exactly the weakened protection (the WORK-005/WORK-013/WORK-014
 * red-record pattern).
 *
 * Rules (each maps to a Work Order mutant):
 *  - `analyzer-authority-deps`  M2/M4/M5/M6/M20: the analyzer service's
 *                              deps are exactly {store, digest,
 *                              generateId, now} — no policy, capability,
 *                              budget, sandbox or execution authority;
 *  - `code-execution-import`   M20/M21: the learning tree imports no
 *                              node:fs / node:child_process / node:os;
 *  - `code-mutation-vocabulary`
 *                              M21: no code-writing/exec vocabulary in
 *                              learning CODE (comments stripped);
 *  - `rating-pass-vocabulary`  M10: the rating answer vocabulary is
 *                              preference-only (no PASS/FAIL literal in
 *                              the evaluation-rating domain code);
 *  - `voi-gate-removed`        M24: the strict expected-information-gain
 *                              gate is present in the prompt decision;
 *  - `finding-state-vocabulary-mutated`
 *                              M18: FINDING_STATES is exactly
 *                              advisory|candidate|verified (no
 *                              'promoted');
 *  - `equivalence-potential-mutated`
 *                              M15: the insertable deterministic-
 *                              equivalence potentials never contain
 *                              'verified-equivalent';
 *  - `verified-evidence-gate-removed`
 *                              M15/M16: the verified transition still
 *                              requires validated equivalence evidence.
 */

import type { LearningBoundaryFile } from "./learning";

export type OpportunityBoundaryFile = LearningBoundaryFile;

/** Strip comments (block + line) so scanners hit CODE, not prose. */
export function stripSourceComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");
}

const CODE_EXECUTION_IMPORT = /from\s+["']node:(fs|fs\/promises|child_process|os)["']/;
const CODE_MUTATION_VOCABULARY =
  /\b(writeFile|appendFile|rmSync|unlinkSync|renameSync|mkdirSync|spawnSync|execSync|spawn|execFile|child_process|new Function|eval\(|gitClone|gitPush)\b/;
const RATING_PASS_LITERAL = /["'](PASS|FAIL|VERIFIED|AUTHORIZED)["']/;

export function opportunityAnalysisViolations(files: readonly OpportunityBoundaryFile[]): string[] {
  const violations: string[] = [];

  for (const file of files) {
    const code = stripSourceComments(file.content);

    if (CODE_EXECUTION_IMPORT.test(file.content)) {
      violations.push(`code-execution-import:${file.path}`);
    }
    if (CODE_MUTATION_VOCABULARY.test(code)) {
      violations.push(`code-mutation-vocabulary:${file.path}`);
    }
  }

  // M2/M4/M5/M6/M20: the analyzer service exposes exactly the
  // non-authoritative quartet.
  const analyzer = files.find((file) =>
    file.path.endsWith("src/modules/learning/application/opportunity-analyzer.ts"),
  );
  if (analyzer === undefined) {
    violations.push("analyzer-authority-deps:missing-owner");
  } else {
    const match = /interface OpportunityAnalyzerDeps \{([\s\S]*?)\}/.exec(analyzer.content);
    if (match === null) {
      violations.push("analyzer-authority-deps:missing-interface");
    } else {
      const fields = [...(match[1] ?? "").matchAll(/readonly\s+(\w+)\s*:/g)].map(
        (field) => field[1] ?? "",
      );
      const illegal = fields.filter(
        (field) => !["store", "digest", "generateId", "now"].includes(field),
      );
      for (const field of illegal) {
        violations.push(`analyzer-authority-deps:${field}`);
      }
      for (const required of ["store", "digest", "generateId", "now"]) {
        if (!fields.includes(required)) {
          violations.push(`analyzer-authority-deps:missing-${required}`);
        }
      }
    }
  }

  // M10: the rating answer vocabulary is preference-only.
  const ratingDomain = files.find((file) =>
    file.path.endsWith("src/modules/learning/domain/evaluation-rating.ts"),
  );
  if (ratingDomain === undefined) {
    violations.push("rating-pass-vocabulary:missing-owner");
  } else if (RATING_PASS_LITERAL.test(stripSourceComments(ratingDomain.content))) {
    violations.push("rating-pass-vocabulary:src/modules/learning/domain/evaluation-rating.ts");
  }

  // M24: the strict value-of-information gate is present.
  const humanEvaluation = files.find((file) =>
    file.path.endsWith("src/modules/learning/domain/human-evaluation.ts"),
  );
  if (
    humanEvaluation === undefined ||
    !humanEvaluation.content.includes("gain <= config.userFrictionThreshold")
  ) {
    violations.push("voi-gate-removed:src/modules/learning/domain/human-evaluation.ts");
  }

  // M18: the finding-state vocabulary is exactly the three advisory
  // states — 'promoted' is unrepresentable.
  const opportunityDomain = files.find((file) =>
    file.path.endsWith("src/modules/learning/domain/opportunity-analysis.ts"),
  );
  if (opportunityDomain === undefined) {
    violations.push("finding-state-vocabulary-mutated:missing-owner");
  } else {
    const states = /export const FINDING_STATES = \[([^\]]*)\] as const;/.exec(
      opportunityDomain.content,
    );
    const parsed = (states?.[1] ?? "")
      .split(",")
      .map((item) => item.trim().replaceAll('"', "").replaceAll("'", ""));
    if (
      states === null ||
      parsed.length !== 3 ||
      !parsed.includes("advisory") ||
      !parsed.includes("candidate") ||
      !parsed.includes("verified") ||
      parsed.includes("promoted")
    ) {
      violations.push(
        "finding-state-vocabulary-mutated:src/modules/learning/domain/opportunity-analysis.ts",
      );
    }
    const potentials =
      /export const DETERMINISTIC_EQUIVALENCE_POTENTIALS = \[([^\]]*)\] as const;/.exec(
        opportunityDomain.content,
      );
    const parsedPotentials = (potentials?.[1] ?? "")
      .split(",")
      .map((item) => item.trim().replaceAll('"', "").replaceAll("'", ""));
    if (
      potentials === null ||
      parsedPotentials.includes("verified-equivalent") ||
      !parsedPotentials.includes("none") ||
      !parsedPotentials.includes("candidate-replacement")
    ) {
      violations.push(
        "equivalence-potential-mutated:src/modules/learning/domain/opportunity-analysis.ts",
      );
    }
  }

  // M15/M16: the verified transition requires validated equivalence
  // evidence (the gate removal is the mutant).
  const transitions = files.find((file) =>
    file.path.endsWith("src/modules/learning/domain/finding-transitions.ts"),
  );
  if (
    transitions === undefined ||
    !transitions.content.includes('if (toState === "verified")') ||
    !transitions.content.includes("validateVerifiedEquivalenceEvidence(input.verifiedEquivalence)")
  ) {
    violations.push(
      "verified-evidence-gate-removed:src/modules/learning/domain/finding-transitions.ts",
    );
  }

  return violations;
}

/**
 * Planner-side opportunity-consumption scanners (M17/M19): the
 * consultation happens AFTER the governed selection, the durable record
 * binds the governed selection, and the adapter validates every
 * consulted finding.
 */
export function plannerOpportunityViolations(
  plannerSource: string,
  adapterSource: string,
): string[] {
  const violations: string[] = [];

  const selectionCall = plannerSource.indexOf("const selection = selectStrategy(");
  const selectedBinding = plannerSource.indexOf("const selected = selection.selected;");
  const consultationCall = plannerSource.search(/deps\.opportunitySignals\??\.consult\(/);
  if (selectionCall === -1) {
    violations.push("missing-governed-selection");
  }
  if (consultationCall !== -1) {
    if (selectedBinding === -1 || consultationCall < selectedBinding) {
      violations.push("consultation-before-selected-binding");
    } else if (selectionCall !== -1) {
      // Between the selection call and the selected binding, opportunity
      // consultation must not appear (the selection is computed free of it).
      const segment = plannerSource.slice(selectionCall, selectedBinding);
      if (/opportunity/i.test(segment)) {
        violations.push("selection-segment-references-opportunity");
      }
    }
  }

  // The DURABLE decision record must bind the governed selection.
  if (
    !plannerSource.includes(
      "selectedStrategyId: selected.strategyId,\n        selectionRationale: selection.rationale,",
    )
  ) {
    violations.push("selection-reference-mutated");
  }

  if (!adapterSource.includes("validateConsultedOpportunitySignal(consulted)")) {
    violations.push("adapter-validation-removed");
  }

  return violations;
}
