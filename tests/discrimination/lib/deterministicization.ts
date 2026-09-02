/**
 * Shared deterministicization boundary scanners (WORK-021
 * discrimination; DTR-001..DTR-004).
 *
 * One definition of the deterministicization boundary, two uses — the
 * discrimination proofs mutate the REAL source in memory and require
 * these scanners to flag exactly the weakened protection (the
 * WORK-005/013/014/017/020 red-record pattern), and the same rules
 * document the boundary for the evidence ledger.
 *
 * Rules (each maps to a WORK-021 mutant):
 *  - `dtr-service-authority-deps`        the lifecycle service's deps
 *    are exactly {store, digest, generateId, now} — no policy,
 *    capability, budget, admission, sandbox or execution authority
 *    (LEARNING-NONAUTHORITY / no second authority);
 *  - `dtr-planner-execution-vocabulary`  the learning deterministicization
 *    files carry no planner/execution state vocabulary (learning cannot
 *    write planner/execution state);
 *  - `dtr-mutation-surface`              no update/delete surface for
 *    deterministicization rows anywhere in learning;
 *  - `dtr-gate-verdict-bypassed`         the promotion gate's verdict is
 *    derived fail-closed from the reasons (never a constant promote —
 *    THE AC6 mutant);
 *  - `dtr-gate-stage-check-removed`      the gate pushes a reason for a
 *    MISSING stage record (unknown evidence fails closed);
 *  - `dtr-gate-insufficient-amplified`   an 'insufficient' stage record
 *    stays a fail-closed reason (evidence is never amplified);
 *  - `dtr-gate-canary-threshold-removed` the canary match-rate check is
 *    present (configurable statistical thresholds);
 *  - `dtr-gate-config-validated`         the gate config is validated
 *    fail-closed (no nonsense thresholds);
 *  - `dtr-provenance-presence-removed`   the domain validator enforces
 *    the non-empty source-execution/corpus provenance (identity);
 *  - `dtr-program-required-removed`      every candidate class except
 *    'removal' must carry a replacement program;
 *  - `dtr-executor-dispatch-bypassed`    the deterministic-replacement
 *    executor dispatches ONLY through the sandbox service (create +
 *    dispatch; no alternate execution path);
 *  - `dtr-executor-confinement-removed`  the executor consults the
 *    confinement check BEFORE dispatch (substrate grants);
 *  - `dtr-second-executor-surface`       exactly ONE implementation of
 *    the DeterministicReplacementExecutor port in the tools tree;
 *  - `dtr-service-gate-failclosed`       the service refuses to apply a
 *    promotion when the gate verdict is not 'promote' (the runtime AC6
 *    half — the gate evaluation is binding, never advisory-then-ignore);
 *  - `dtr-rollback-restoration-removed`  the rollback decision records
 *    the incumbent restoration target (reversible promotion).
 *
 * Planner-side rules (planner + adapter + consultation domain):
 *  - `dtr-consultation-before-selection` the consultation happens AFTER
 *    the governed selection (post-selection capture only);
 *  - `dtr-promoted-only-direction`       only a PROMOTED candidate
 *    implies the deterministic direction (the anyPromoted gate);
 *  - `dtr-adapter-validation-removed`    the planning adapter validates
 *    every consulted candidate fail-closed at the seam.
 */

import { PROVIDER_IDENTIFIER } from "./patterns";

export interface DtrBoundaryFile {
  readonly path: string;
  readonly content: string;
}

/** Strip comments (block + line) so scanners hit CODE, not prose. */
export function stripDtrComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/^\s*\/\/.*$/gm, " ");
}

const PLANNER_EXECUTION_VOCABULARY =
  /\b(selectStrategy|buildPlan|recordPlanningDecision|transitionExecution|appendEvent|planExecution|composeCandidates)\b/;

const DTR_MUTATION_SURFACE =
  /\b(updateDeterministicizationCandidate|deleteDeterministicizationCandidate|mutateDeterministicizationCandidate|updateStageEvidence|deleteStageEvidence|updateDecision|deleteDecision|rewriteRollout)\b/;

const SERVICE_PATH = "src/modules/learning/application/deterministicization-service.ts";
const GATE_PATH = "src/modules/learning/domain/deterministicization-gate.ts";
const DOMAIN_PATH = "src/modules/learning/domain/deterministicization.ts";
const EXECUTOR_PATH = "src/modules/tools/adapters/deterministic-replacement-sandbox-executor.ts";

export function deterministicizationNonAuthorityViolations(
  files: readonly DtrBoundaryFile[],
): string[] {
  const violations: string[] = [];
  const byPath = new Map(files.map((file) => [file.path, file]));

  for (const file of files) {
    const code = stripDtrComments(file.content);
    const isLearningDtr =
      file.path.startsWith("src/modules/learning/") && /eterministic/.test(file.path);
    if (isLearningDtr) {
      if (PLANNER_EXECUTION_VOCABULARY.test(code)) {
        violations.push(`dtr-planner-execution-vocabulary:${file.path}`);
      }
      if (DTR_MUTATION_SURFACE.test(code)) {
        violations.push(`dtr-mutation-surface:${file.path}`);
      }
      if (PROVIDER_IDENTIFIER.test(code)) {
        violations.push(`dtr-provider-identifier:${file.path}`);
      }
    }
  }

  // The service deps are the non-authoritative quartet ONLY.
  const service = byPath.get(SERVICE_PATH);
  if (service !== undefined) {
    const depsMatch = /export interface DeterministicizationServiceDeps \{([^}]*)\}/.exec(
      service.content,
    );
    if (depsMatch === null) {
      violations.push("dtr-service-authority-deps:interface-missing");
    } else {
      const depsBody = depsMatch[1] ?? "";
      const deps = [...depsBody.matchAll(/readonly\s+([a-zA-Z]+)\s*:/g)].map(
        (match) => match[1] ?? "",
      );
      const allowed = new Set(["store", "digest", "generateId", "now"]);
      for (const dep of deps) {
        if (!allowed.has(dep)) {
          violations.push(`dtr-service-authority-deps:${dep}`);
        }
      }
    }
    // The service binds the gate verdict: a not-promote verdict NEVER
    // applies a promotion (the runtime AC6 half).
    if (!service.content.includes('evaluation.verdict !== "promote"')) {
      violations.push("dtr-service-gate-failclosed");
    }
    if (!service.content.includes("candidate.incumbent.rollbackTarget")) {
      violations.push("dtr-rollback-restoration-removed");
    }
  }

  // THE AC6 static anchor: the gate verdict is DERIVED fail-closed from
  // the accumulated reasons, never a constant.
  const gate = byPath.get(GATE_PATH);
  if (gate !== undefined) {
    if (!gate.content.includes('verdict: reasons.length === 0 ? "promote" : "not-promoted"')) {
      violations.push("dtr-gate-verdict-bypassed");
    }
    if (!gate.content.includes("evidence record exists (unknown evidence fails closed)")) {
      violations.push("dtr-gate-stage-check-removed");
    }
    if (
      !gate.content.includes("honestly records insufficiency (never amplified into confidence)")
    ) {
      violations.push("dtr-gate-insufficient-amplified");
    }
    // The threshold is APPLIED to the canary quality delta (the exact
    // comparison — a rename/removal of the applied check is flagged;
    // a bare identifier mention is not a protection).
    if (!gate.content.includes("rollout.qualityDelta < config.minimumCanaryMatchRate")) {
      violations.push("dtr-gate-canary-threshold-removed");
    }
    if (!/\bfunction validatePromotionGateConfig\s*\(/.test(gate.content)) {
      violations.push("dtr-gate-config-validated");
    }
  }

  // The domain validator: provenance presence + program-required.
  const domain = byPath.get(DOMAIN_PATH);
  if (domain !== undefined) {
    const code = stripDtrComments(domain.content);
    if (
      !code.includes('requireNonEmptyStringList(provenance, "sourceExecutionIds"') ||
      !code.includes('requireDigest(provenance, "corpusDigest"')
    ) {
      violations.push("dtr-provenance-presence-removed");
    }
    if (!code.includes('candidate.candidateClass !== "removal"')) {
      violations.push("dtr-program-required-removed");
    }
  }

  // The executor: sandbox-only dispatch + pre-dispatch confinement.
  const executor = byPath.get(EXECUTOR_PATH);
  if (executor !== undefined) {
    const code = stripDtrComments(executor.content);
    if (
      !code.includes("service.createSandboxExecution") ||
      !code.includes("service.dispatchSandboxExecution")
    ) {
      violations.push("dtr-executor-dispatch-bypassed");
    }
    if (!code.includes("replacementConfinementCheck(dispatch.contract, environment)")) {
      violations.push("dtr-executor-confinement-removed");
    }
  }

  return violations;
}

export function deterministicizationExecutorSurfaceViolations(
  files: readonly DtrBoundaryFile[],
): string[] {
  const violations: string[] = [];
  const implementors = files.filter(
    (file) =>
      file.path.startsWith("src/modules/tools/") &&
      file.content.includes("DeterministicReplacementExecutor"),
  );
  const shipped = implementors.filter((file) => file.path === EXECUTOR_PATH);
  if (shipped.length !== 1) {
    violations.push("dtr-executor-missing");
  }
  for (const file of implementors) {
    if (
      file.path !== EXECUTOR_PATH &&
      /class\s+\w+|function create\w+Executor/.test(file.content)
    ) {
      violations.push(`dtr-second-executor-surface:${file.path}`);
    }
  }
  return violations;
}

export function plannerDeterministicizationViolations(input: {
  readonly plannerSource: string;
  readonly adapterSource: string;
  readonly consultationSource: string;
}): string[] {
  const violations: string[] = [];
  const { plannerSource, adapterSource, consultationSource } = input;
  const plannerCode = stripDtrComments(plannerSource);

  // The consultation is captured AFTER the governed selection: the
  // deterministicization consult call must appear after the selection
  // anchor (the `selected` binding) in the planner's flow.
  const consultIndex = plannerCode.indexOf("deterministicizationSignals.consult");
  const selectedIndex = plannerCode.indexOf("selected.strategyId");
  if (consultIndex === -1) {
    violations.push("dtr-consultation-missing");
  } else if (selectedIndex === -1 || consultIndex < selectedIndex) {
    violations.push("dtr-consultation-before-selection");
  }
  // The consultation capture never feeds the selection (the decision
  // records the governed selection, never the implied preference).
  if (
    plannerCode.includes(
      "selectedStrategyId: deterministicizationConsultation?.preferredStrategyId",
    )
  ) {
    violations.push("dtr-selection-reference-mutated");
  }

  // Only a PROMOTED candidate carries the deterministic direction.
  const consultationCode = stripDtrComments(consultationSource);
  if (!consultationCode.includes('signal.status === "promoted"')) {
    violations.push("dtr-promoted-only-direction");
  }

  // The adapter validates every consulted candidate at the seam.
  const adapterCode = stripDtrComments(adapterSource);
  if (!adapterCode.includes("validateConsultedDeterministicizationSignal(consulted)")) {
    violations.push("dtr-adapter-validation-removed");
  }

  return violations;
}
