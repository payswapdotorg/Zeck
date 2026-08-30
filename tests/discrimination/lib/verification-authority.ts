/**
 * Shared verification-authority boundary scanner (WORK-013).
 *
 * One definition of the VERIFICATION-SEPARATION / POLICY-BEFORE-DISPATCH /
 * canonical-ledger / no-second-authority static boundary, two uses — the
 * architecture gate over the REAL src tree, and the discrimination proofs
 * over synthetic source mutations (the WORK-006/007/010 scanner pattern).
 *
 * The boundary under protection (WORK-013 acceptance criteria 1–6;
 * checkpoint contracts VERIFICATION-SEPARATION, POLICY-BEFORE-DISPATCH,
 * EXECUTION-PROVENANCE, TENANT-ISOLATION, IDENTITY-IDEMPOTENCY,
 * AUTH-PRESERVATION; architecture-lock invariants 3/6/14):
 *
 *   1. `verify-policy-gate-*` — inside the evaluation window, the REQUIRED
 *      policy-admission seam (`admission.admit`) is consulted BEFORE any
 *      evaluator runs, with a fail-closed denial branch (no gate, no
 *      evaluation; M7).
 *   2. `verify-tenant-binding` — the execution binding (tenant scope +
 *      terminal discipline) is asserted before admission/evaluation (M9/M10).
 *   3. `verify-durable-intent` / `verify-ledger-intent-event` — the
 *      evaluation journal claim and the `execution.verification-requested`
 *      ledger event precede the evaluation (§14 intent-before-effect; M13).
 *   4. `verify-conclusion-evidence` — results are recorded durably and the
 *      conclusion envelope rides the canonical ledger; completion
 *      (`transitions.pass`) happens only under criteriaMet, AFTER the
 *      durable conclusion evidence (no pass shortcut; M1 family).
 *   5. `verify-inconclusive-not-acceptance` — the conclusion derivation
 *      must treat non-PASS as unmet: the `status !== "PASS"` comparison is
 *      load-bearing (M5/M22); no status coercion to PASS exists anywhere.
 *   6. `verify-revision-binding` — revision-matching in the conclusion
 *      (M12) and the pass-input revision filter exist.
 *   7. `human-gate-*` — human evaluation requests are policy-admitted
 *      (M8) and decisions are attributable (decidedBy mandatory; M19).
 *   8. `comparison-planner-gate` — candidate comparison validates the
 *      planner authorization and never forces a winner (M16).
 *   9. `model-judge-verdict-basis` — the model-judge adapter maps only a
 *      criterion-BOUND `meetsCriteria` judgment to PASS/FAIL; an unbound
 *      judgment is INCONCLUSIVE (M1/M2: provider success / model
 *      self-certification can never produce PASS).
 *  10. `deterministic-no-model-import` / `verification-imports-*` — the
 *      deterministic evaluators import no models surface (M18); the
 *      verification module imports no policies/tools/agents internals
 *      (M15/seam discipline) and references no executions tables (M13).
 *  11. `no-second-execution-state-machine` — the verification module
 *      defines no execution lifecycle vocabulary (M14): the statuses are
 *      the evaluator-job vocabulary only (denied|evaluating|concluded),
 *      and the only transitions issued are verify/pass through the port.
 *  12. `pass-requires-results` — the pass input is built from durable
 *      results (never empty by construction; the executions authority
 *      enforces ≥1 PASS).
 */

export interface VerificationBoundaryFile {
  readonly path: string;
  readonly content: string;
}

const SERVICE_PATH = "src/modules/verification/application/verification-service.ts";
const MODEL_JUDGE_PATH = "src/modules/verification/adapters/model-judge-evaluator.ts";
const DETERMINISTIC_PATH = "src/modules/verification/adapters/deterministic-evaluators.ts";
const POLICY_ADAPTER_PATH = "src/modules/verification/adapters/policy-verification-admission.ts";
const LEDGER_ADAPTER_PATH = "src/modules/verification/adapters/execution-ledger.ts";

export const VERIFICATION_CANONICAL_PATHS = [
  SERVICE_PATH,
  MODEL_JUDGE_PATH,
  DETERMINISTIC_PATH,
  POLICY_ADAPTER_PATH,
  LEDGER_ADAPTER_PATH,
] as const;

export function verificationAuthorityViolations(
  files: readonly VerificationBoundaryFile[],
): string[] {
  const violations: string[] = [];
  const byPath = new Map(files.map((file) => [file.path, file] as const));
  const service = byPath.get(SERVICE_PATH);
  const modelJudge = byPath.get(MODEL_JUDGE_PATH);
  const deterministic = byPath.get(DETERMINISTIC_PATH);
  const policyAdapter = byPath.get(POLICY_ADAPTER_PATH);
  const ledgerAdapter = byPath.get(LEDGER_ADAPTER_PATH);

  if (service === undefined) {
    return ["verification-service-missing"];
  }

  // The evaluation window: from runEvaluation to concludeEvaluation.
  const runStart = service.content.indexOf("async function runEvaluation");
  const concludeStart = service.content.indexOf("async function concludeEvaluation");
  const runWindow =
    runStart >= 0 && concludeStart > runStart
      ? service.content.slice(runStart, concludeStart)
      : null;
  if (runWindow === null) {
    violations.push("verification-evaluation-window-missing");
  } else {
    // (1) policy gate before evaluator dispatch + fail-closed branch (M7).
    // The EVALUATOR admission is anchored by its provider-fact line
    // (unique to the per-evaluator admission request).
    const admitAt = runWindow.indexOf('provider: evaluator.identity.kind === "model"');
    const evaluateAt = runWindow.indexOf("evaluator.evaluate(");
    if (admitAt < 0) {
      violations.push("verify-policy-gate-missing");
    } else if (evaluateAt >= 0 && admitAt > evaluateAt) {
      violations.push("verify-policy-gate-after-evaluator");
    } else if (!/if\s*\(\s*!decision\.allowed\s*\)\s*\{/.test(runWindow)) {
      violations.push("verify-policy-gate-no-denial-branch");
    }
    // (5) INCONCLUSIVE is never acceptance (M5/M22): the conclusion
    // comparison and the human/comparison status handling must exist.
    if (!runWindow.includes('"INCONCLUSIVE"')) {
      violations.push("verify-inconclusive-status-missing");
    }
  }

  // The verifyFlow window: tenant binding → admission → claim → ledger
  // intent → evaluation (order discipline).
  const flowStart = service.content.indexOf("async function verifyFlow");
  const flowEnd = service.content.indexOf("const service: VerificationService");
  const flowWindow =
    flowStart >= 0 && flowEnd > flowStart
      ? service.content.slice(flowStart, flowEnd)
      : service.content;
  const bindAt = flowWindow.indexOf("await bindExecution(");
  const claimAt = flowWindow.indexOf("store.claimEvaluation(");
  const intentEventAt = flowWindow.indexOf('"verification-requested"');
  if (bindAt < 0) {
    violations.push("verify-tenant-binding-missing");
  } else {
    const admissionAt = flowWindow.indexOf(
      "await admission.admit({",
      flowWindow.indexOf("verifyFlow"),
    );
    if (admissionAt >= 0 && bindAt > admissionAt) {
      violations.push("verify-tenant-binding-after-admission");
    }
  }
  // The tenant comparison + terminal discipline INSIDE bindExecution are
  // the M9/M10 load-bearing checks (their removal must be detectable).
  if (!service.content.includes("execution.tenantId !== tenantId")) {
    violations.push("verify-tenant-comparison-missing");
  }
  if (!/executions? is terminal/.test(service.content)) {
    violations.push("verify-terminal-discipline-missing");
  }
  if (claimAt >= 0 && intentEventAt >= 0 && intentEventAt < claimAt) {
    // The intent event is recorded right after the claim; both must
    // precede runEvaluation.
    const runCallAt = flowWindow.indexOf("await runEvaluation(");
    if (runCallAt >= 0 && claimAt > runCallAt) {
      violations.push("verify-durable-intent-after-evaluation");
    }
  } else if (claimAt < 0) {
    violations.push("verify-durable-intent-missing");
  }
  if (!flowWindow.includes('"verification-requested"')) {
    violations.push("verify-ledger-intent-event-missing");
  }

  // (4) conclusion evidence before the pass transition; pass only on met.
  const concludeWindow =
    concludeStart >= 0
      ? service.content.slice(concludeStart, flowStart > concludeStart ? flowStart : undefined)
      : "";
  if (concludeWindow.length === 0) {
    violations.push("verify-conclusion-window-missing");
  } else {
    const completeAt = concludeWindow.indexOf("store.completeEvaluation(");
    const passAt = concludeWindow.indexOf("transitions.pass(");
    if (passAt >= 0 && completeAt >= 0 && passAt < completeAt) {
      violations.push("verify-pass-before-durable-conclusion");
    }
    if (!concludeWindow.includes("criteriaMet && run.lifecycle")) {
      violations.push("verify-pass-not-gated-on-criteria-met");
    }
    if (!concludeWindow.includes('"verification-recorded"')) {
      violations.push("verify-conclusion-ledger-event-missing");
    }
    // (6) revision binding (M12).
    if (
      !concludeWindow.includes("target.revision") &&
      !service.content.includes("targetRevision")
    ) {
      violations.push("verify-revision-binding-missing");
    }
  }
  // (5) status coercion to PASS must not exist anywhere (M5): no textual
  // INCONCLUSIVE→PASS rewrite and no PASS default; the comparison's
  // decisive-winner PASS is the only legitimate assignment (guarded by
  // the explicit passing.length === 1 selection check above).
  if (
    /replace\(\s*["']INCONCLUSIVE["']\s*,\s*["']PASS["']\s*\)/.test(service.content) ||
    /\?\?\s*"PASS"/.test(service.content) ||
    /status\s*\|\|\s*"PASS"/.test(service.content)
  ) {
    violations.push("verify-status-coercion-to-pass");
  }

  // (7) human gates (M8/M19).
  const humanRequestWindow = service.content.slice(
    service.content.indexOf("async requestHumanEvaluation"),
    service.content.indexOf("async submitHumanDecision"),
  );
  if (
    !humanRequestWindow.includes("admission.admit(") ||
    !/if\s*\(\s*!decision\.allowed\s*\)\s*\{/.test(humanRequestWindow)
  ) {
    violations.push("human-request-policy-gate-missing");
  }
  const humanDecisionWindow = service.content.slice(
    service.content.indexOf("async submitHumanDecision"),
    service.content.indexOf("async compareCandidates"),
  );
  if (!humanDecisionWindow.includes("validateHumanDecision")) {
    violations.push("human-decision-validation-missing");
  }

  // (8) comparison planner gate (M16): the service validates the planner
  // authorization and the domain validator pins the initiator vocabulary.
  const comparisonWindow = service.content.slice(
    service.content.indexOf("async compareCandidates"),
  );
  if (!comparisonWindow.includes("validatePlannerAuthorization")) {
    violations.push("comparison-planner-gate-missing");
  }
  const comparisonDomain = byPath.get("src/modules/verification/domain/comparison.ts");
  if (comparisonDomain === undefined || !comparisonDomain.content.includes('"planner"')) {
    violations.push("comparison-initiator-vocabulary-missing");
  }
  if (!/passing\.length\s*===\s*1/.test(comparisonWindow)) {
    violations.push("comparison-winner-selection-not-explicit");
  }

  // (9) model-judge verdict basis (M1/M2).
  if (modelJudge === undefined) {
    violations.push("model-judge-adapter-missing");
  } else {
    if (!modelJudge.content.includes("judgment.criterionId !== criteria.criterionId")) {
      violations.push("model-judge-binding-check-missing");
    }
    if (!modelJudge.content.includes('"unknown"')) {
      violations.push("model-judge-unknown-handling-missing");
    }
    if (
      !/meetsCriteria\s*\?\s*"PASS"\s*:\s*"FAIL"|meetsCriteria \? "PASS" : "FAIL"/.test(
        modelJudge.content,
      )
    ) {
      violations.push("model-judge-verdict-mapping-missing");
    }
    // A provider success/status shortcut to PASS is unrepresentable:
    // the adapter must not read HTTP status or provider outcome classes.
    if (/httpStatus|providerSuccess|PROVIDER_AXIS|status === 200/.test(modelJudge.content)) {
      violations.push("model-judge-provider-success-shortcut");
    }
  }

  // (10) import discipline (M13/M15/M17/M18).
  if (deterministic !== undefined) {
    if (/from\s+"(\.\.\/)+(models|policies|tools|agents)\//.test(deterministic.content)) {
      violations.push("deterministic-evaluator-imports-authority-or-model");
    }
  } else {
    violations.push("deterministic-evaluators-missing");
  }
  if (policyAdapter !== undefined) {
    if (!policyAdapter.content.includes("authority.admitDispatch(")) {
      violations.push("policy-admission-adapter-does-not-delegate");
    }
    if (/export function create(Default|AllowAll)/.test(policyAdapter.content)) {
      violations.push("policy-admission-default-allow-shipped");
    }
  } else {
    violations.push("policy-admission-adapter-missing");
  }
  if (ledgerAdapter !== undefined) {
    if (!ledgerAdapter.content.includes("service.recordStepEvent(")) {
      violations.push("ledger-adapter-bypasses-canonical-path");
    }
    if (!ledgerAdapter.content.includes("service.transition(")) {
      violations.push("transition-adapter-bypasses-executions-authority");
    }
  } else {
    violations.push("ledger-adapter-missing");
  }

  // Domain validation presence (M4/M20/M21/M24): the result model's
  // immutability-in-shape checks are load-bearing — removing them must be
  // a detectable architecture change, not a silent regression.
  const resultDomain = byPath.get("src/modules/verification/domain/result.ts");
  if (resultDomain === undefined) {
    violations.push("result-domain-missing");
  } else {
    if (!resultDomain.content.includes("PASS requires at least one evidence reference")) {
      violations.push("result-domain-pass-evidence-validation-missing");
    }
    if (!resultDomain.content.includes("criteria binding is mandatory")) {
      violations.push("result-domain-criteria-binding-validation-missing");
    }
    if (!resultDomain.content.includes("non-empty version")) {
      violations.push("result-domain-evaluator-version-validation-missing");
    }
    if (!resultDomain.content.includes("no detached results")) {
      violations.push("result-domain-provenance-validation-missing");
    }
  }
  const conclusionDomain = byPath.get("src/modules/verification/domain/conclusion.ts");
  if (conclusionDomain === undefined) {
    violations.push("conclusion-domain-missing");
  } else {
    if (!conclusionDomain.content.includes('latest.status !== "PASS"')) {
      violations.push("conclusion-pass-check-missing");
    }
    if (!conclusionDomain.content.includes("requiredUnmet.length === 0")) {
      violations.push("conclusion-unmet-surfacing-missing");
    }
  }

  // Whole-module scans over every verification file.
  for (const file of files) {
    if (!file.path.startsWith("src/modules/verification/")) {
      continue;
    }
    // M13: no direct executions-table access.
    if (/executions\.(executions|execution_events|verification_results)/.test(file.content)) {
      violations.push(`verification-references-executions-tables:${file.path}`);
    }
    // M3: the tool-axis outcome vocabulary never enters the verification
    // module (tool success is evidence at best, never a verdict).
    if (/["'](tool-success|tool-failure)["']/.test(file.content)) {
      violations.push(`verification-tool-axis-vocabulary:${file.path}`);
    }
    // M15: no policies authority logic in evaluators/adapters besides the
    // delegating admission adapter.
    if (
      file.path !== POLICY_ADAPTER_PATH &&
      /createPolicyAuthority|PolicyAuthority\b/.test(file.content)
    ) {
      violations.push(`verification-holds-policy-authority:${file.path}`);
    }
    // M18/provider-fabric: the verification module never imports the
    // models, tools or agents modules (its evaluators are its own
    // adapters; the model judge dispatches through its own port).
    if (/from\s+"(\.\.\/)+(models|tools|agents)\//.test(file.content)) {
      violations.push(`verification-imports-provider-fabric:${file.path}`);
    }
    // M14: no second execution state machine (lifecycle vocabulary).
    const lifecycleVocabulary =
      /"(RUNNING|WAITING_TOOL|WAITING_USER|WAITING_HUMAN|REPLANNING|QUEUED|AUTHORIZED)"/g;
    const matches = file.content.match(lifecycleVocabulary);
    if (matches !== null) {
      // The terminal-status read in the service (TERMINAL_STATUSES const)
      // and the RUNNING/VERIFYING entry check are reads of the authority's
      // vocabulary, not a second machine — allowed exactly there.
      const allowed =
        file.path === SERVICE_PATH &&
        matches.every((match) => match === '"RUNNING"' || match === '"VERIFYING"');
      if (!allowed) {
        violations.push(
          `verification-defines-execution-lifecycle:${file.path}:${matches.join(",")}`,
        );
      }
    }
    // M17: provider-specific identifiers never leak into domain contracts.
    if (file.path.includes("/domain/") && providerIdentifierPattern().test(file.content)) {
      violations.push(`provider-identifier-in-domain-contracts:${file.path}`);
    }
    // No default-allow admission anywhere in the module.
    if (/allowed:\s*true\s*\}\s*;?\s*\/\/\s*default/.test(file.content)) {
      violations.push(`default-allow-admission:${file.path}`);
    }
  }

  return violations;
}

function providerIdentifierPattern(): RegExp {
  return /\b(OpenRouter|Anthropic|OpenAI|Gemini|Groq|Mistral|Cohere|Azure)\w*/;
}

export function hasCanonicalVerificationAuthority(
  files: readonly VerificationBoundaryFile[],
): boolean {
  const paths = new Set(files.map((file) => file.path));
  return VERIFICATION_CANONICAL_PATHS.every((path) => paths.has(path));
}
