/**
 * Discrimination: the verification authority boundary (WORK-013 CRITICAL
 * boundaries; checkpoint contracts VERIFICATION-SEPARATION,
 * POLICY-BEFORE-DISPATCH, EXECUTION-PROVENANCE, TENANT-ISOLATION,
 * IDENTITY-IDEMPOTENCY, AUTH-PRESERVATION).
 *
 * Every protection is proven by a mutant that removes it. The 26
 * mandatory mutants of the Work Order:
 *
 *   STATIC (the shared scanner over mutated REAL source — the red-record
 *   pattern; the architecture gate runs the same scanner over the real
 *   tree, so it FAILS under exactly these mutations):
 *     M1  provider HTTP 200 → PASS (verdict mapping gutted / provider
 *         status shortcut introduced in the model-judge adapter).
 *     M2  model self-certifies (criterion binding check removed).
 *     M3  tool success → PASS (tool-axis vocabulary enters the module).
 *     M5  INCONCLUSIVE coerced to PASS (status rewrite introduced).
 *     M7  evaluator bypasses policy (gate deleted / moved after the
 *         evaluator / denial branch dropped).
 *     M8  human evaluation bypasses policy (request admission removed).
 *     M9  tenant binding removed.
 *     M13 verification writes around the canonical execution ledger
 *         (ledger adapter bypassed / executions tables referenced).
 *     M14 verifier creates a second execution state machine (lifecycle
 *         vocabulary introduced).
 *     M15 model evaluator gains policy authority (PolicyAuthority enters
 *         a non-admission file).
 *     M16 candidate comparison bypasses the planner (gate removed).
 *     M17 provider-specific evaluator type leaks into domain contracts.
 *     M18 deterministic verification replaced by a hidden AI call
 *         (deterministic evaluator imports the models module).
 *     M20 evaluator version validation removed / M21 criteria binding
 *         validation removed / M24 provenance validation removed /
 *         M4 PASS-evidence validation removed (domain result model
 *         gutted); M5/M6 conclusion derivation gutted.
 *     M25 the target-resolution fail-closed rejection branch removed
 *         (verification certifies a result without an actual target).
 *     M26 replan/escalation becomes verifier-owned (a replan transition
 *         method/call enters the port or the service — INT-005).
 *
 *   RUNTIME RED RECORDS (observed violations under CONSTRUCTED wiring
 *   mutants — the wiring failure each static protection makes
 *   unrepresentable; production blocks the identical scenario):
 *     R1 (M1) a fabricated completion (pass without PASS results) is
 *         rejected by the executions authority — no provider-success or
 *         planner-success shortcut to completion exists.
 *     R2 (M7) a no-policy-set authority fails closed (no default allow);
 *         a mutant allow-all admission would evaluate — production:
 *         typed POLICY_DENIED, zero results.
 *     R3 (M13) a no-op ledger wired → verification "succeeds" with ZERO
 *         canonical execution events (violation); production: the
 *         requested/result/conclusion envelopes all exist.
 *     R4 (M5/M22) an INCONCLUSIVE-only evaluation never completes the
 *         execution and never records a PASS.
 *     R5 (M1/M2) a model judge that answers with a raw provider success
 *         payload (no bound verdict) produces INCONCLUSIVE, never PASS.
 *     R6 (M25) an over-accepting target resolver certifies a GHOST
 *         target (violation recorded); the honest resolver fails closed
 *         BEFORE any evaluation (production).
 *
 * The remaining mandatory mutants are proven dynamically in the unit and
 * real-PostgreSQL suites (they are behavioral, not source-shaped):
 *     M3/M4/M5/M6/M12/M19/M22/M23 and the tenant/execution/artifact
 *     binding halves of M9/M10/M11 — see
 *     tests/unit/verification/verification-service.test.ts and
 *     tests/integration/postgres/verification-*.test.ts.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import {
  createPolicyAuthority,
  InMemoryPolicyStore,
  nodePolicyHasher,
  type PolicyAuthority,
} from "../../src/modules/policies/public";
import type { TargetResolver } from "../../src/modules/verification/ports/target-resolvers";
import type {
  VerificationAdmission,
  VerificationAdmissionDecision,
} from "../../src/modules/verification/ports/verification-admission";
import type { VerificationLedger } from "../../src/modules/verification/ports/verification-ledger";
import { PlatformError } from "../../src/shared/errors";
import {
  createInMemoryVerificationWorld,
  type InMemoryVerificationWorld,
} from "../unit/verification/fakes";
import {
  type VerificationBoundaryFile,
  verificationAuthorityViolations,
} from "./lib/verification-authority";

const REPO_ROOT = join(process.cwd());

const TREE_PATHS = [
  "src/modules/verification/application/verification-service.ts",
  "src/modules/verification/adapters/model-judge-evaluator.ts",
  "src/modules/verification/adapters/deterministic-evaluators.ts",
  "src/modules/verification/adapters/policy-verification-admission.ts",
  "src/modules/verification/adapters/execution-ledger.ts",
  "src/modules/verification/domain/result.ts",
  "src/modules/verification/domain/conclusion.ts",
  "src/modules/verification/domain/comparison.ts",
  "src/modules/verification/domain/evaluator.ts",
  "src/modules/verification/domain/human.ts",
  "src/modules/verification/domain/criteria.ts",
  "src/modules/verification/ports/verification-ledger.ts",
];

function realTree(): VerificationBoundaryFile[] {
  return TREE_PATHS.map((path) => ({
    path,
    content: readFileSync(join(REPO_ROOT, path), "utf8"),
  }));
}

function treePath(index: number): string {
  const path = TREE_PATHS[index];
  if (path === undefined) {
    throw new Error(`missing canonical path at index ${index}`);
  }
  return path;
}

function mutate(
  tree: VerificationBoundaryFile[],
  path: string,
  replacement: (content: string) => string,
): VerificationBoundaryFile[] {
  return tree.map((file) =>
    file.path === path ? { ...file, content: replacement(file.content) } : file,
  );
}

/** Assert the scanner catches a mutant (violations non-empty). */
function expectCaught(tree: VerificationBoundaryFile[], ...expected: string[]): void {
  const violations = verificationAuthorityViolations(tree);
  expect(violations.length, `mutant not caught: ${JSON.stringify(violations)}`).toBeGreaterThan(0);
  for (const violation of expected) {
    expect(
      violations.some((entry) => entry.startsWith(violation)),
      violations.join(", "),
    ).toBe(true);
  }
}

// ---------------------------------------------------------------------------
// STATIC MUTANTS
// ---------------------------------------------------------------------------

describe("static mutants — the scanner catches every removed protection", () => {
  test("M1: model-judge verdict mapping gutted (provider success → PASS)", () => {
    const tree = mutate(realTree(), treePath(1), (content) =>
      content.replace(
        'status: judgment.meetsCriteria ? "PASS" : "FAIL",',
        'status: "PASS", // mutant: provider answered, good enough',
      ),
    );
    expectCaught(tree, "model-judge-verdict-mapping-missing");
  });

  test("M1: provider HTTP status shortcut introduced in the judge adapter", () => {
    const tree = mutate(realTree(), treePath(1), (content) =>
      content.replace(
        '      const rubric = String(criteria.definition.rubric ?? "");',
        '      if ((evidence.facts as Record<string, unknown>).httpStatus === 200) {\n        return { status: "PASS", observations: ["http 200"], evidenceRefs: evidence.evidenceRefs };\n      }\n      const rubric = String(criteria.definition.rubric ?? "");',
      ),
    );
    expectCaught(tree, "model-judge-provider-success-shortcut");
  });

  test("M2: criterion binding check removed (model self-certification)", () => {
    const tree = mutate(realTree(), treePath(1), (content) =>
      content.replace(
        "      if (judgment.criterionId !== criteria.criterionId) {",
        "      if (false) { // mutant: accept any judgment",
      ),
    );
    expectCaught(tree, "model-judge-binding-check-missing");
  });

  test("M3: tool-axis outcome vocabulary enters the verification module", () => {
    const tree = mutate(realTree(), treePath(0), (content) =>
      content.replace(
        "  async function runEvaluation(",
        '  const TOOL_AXIS_FALLBACK = "tool-success"; // mutant\n  async function runEvaluation(',
      ),
    );
    expectCaught(tree, "verification-tool-axis-vocabulary");
  });

  test("M5: INCONCLUSIVE coerced to PASS via textual rewrite", () => {
    const tree = mutate(realTree(), treePath(0), (content) =>
      content.replace(
        "    return concludeEvaluation({",
        '    results.forEach((result) => { (result as { status?: string }).status = result.status.replace("INCONCLUSIVE", "PASS"); }); // mutant\n    return concludeEvaluation({',
      ),
    );
    expectCaught(tree, "verify-status-coercion-to-pass");
  });

  test("M7: the evaluator policy gate is deleted (no admission at the evaluator boundary)", () => {
    const tree = mutate(realTree(), treePath(0), (content) =>
      content.replace(
        /const decision = await admission\.admit\(\{\n {8}action,\n {8}tenantId: run\.tenantId,[\s\S]*?\n {6}\}\);/,
        "const decision = { allowed: true } as const; // mutant: no admission",
      ),
    );
    expectCaught(tree, "verify-policy-gate-missing");
  });

  test("M7: the evaluator policy gate moves AFTER the evaluator", () => {
    const tree = mutate(realTree(), treePath(0), (content) =>
      content
        .replace(
          /const decision = await admission\.admit\(\{\n {8}action,\n {8}tenantId: run\.tenantId,[\s\S]*?\n {6}\}\);/,
          "const decision = { allowed: true } as const; // mutant: admission removed from before the evaluator",
        )
        .replace(
          "      const result = buildResult(run, criteria, {\n        evaluator: evaluator.identity,\n        status: outcome.status,",
          '      const gate = await admission.admit({ action: "model-evaluation", tenantId: run.tenantId, applicationId: run.applicationId, executionId: run.executionId, provider: evaluator.identity.kind === "model" ? evaluator.identity.id : undefined }); void gate; // mutant: gate after evaluation\n      const result = buildResult(run, criteria, {\n        evaluator: evaluator.identity,\n        status: outcome.status,',
        ),
    );
    expectCaught(tree, "verify-policy-gate-after-evaluator");
  });

  test("M7: the evaluator admission denial branch is dropped (deny becomes allow)", () => {
    const tree = mutate(realTree(), treePath(0), (content) =>
      content.replace(
        "      if (!decision.allowed) {",
        "      if (false) { // mutant: denial branch dropped",
      ),
    );
    expectCaught(tree, "verify-policy-gate-no-denial-branch");
  });

  test("M9: the tenant comparison inside the execution binding is removed", () => {
    const tree = mutate(realTree(), treePath(0), (content) =>
      content.replace(
        "    if (execution.tenantId !== tenantId) {",
        "    if (false) { // mutant: no tenant comparison",
      ),
    );
    expectCaught(tree, "verify-tenant-comparison-missing");
  });

  test("M10: the terminal-execution discipline inside the binding is removed", () => {
    const tree = mutate(realTree(), treePath(0), (content) =>
      content.replace("execution is terminal in", "mutant: terminal check removed for"),
    );
    expectCaught(tree, "verify-terminal-discipline-missing");
  });

  test("M8: human evaluation request admission removed", () => {
    const tree = mutate(realTree(), treePath(0), (content) =>
      content.replace(
        '      // POLICY admission (REQUIRED seam — the human-escalation gate).\n      const decision = await admission.admit({\n        action: "human-evaluation",',
        "      const decision = await Promise.resolve({ allowed: true } as const); void admission; // mutant\n      void ({} as never);",
      ),
    );
    expectCaught(tree, "human-request-policy-gate-missing");
  });

  test("M13: the ledger adapter writes around the canonical path", () => {
    const tree = mutate(realTree(), treePath(4), (content) =>
      content.replace(
        "      const outcome = await service.recordStepEvent(",
        '      const outcome = await Promise.resolve({ sequence: 0, type: "nope", replayed: false }); void service; // mutant',
      ),
    );
    expectCaught(tree, "ledger-adapter-bypasses-canonical-path");
  });

  test("M13: the service references the executions tables directly", () => {
    const tree = mutate(realTree(), treePath(0), (content) =>
      content.replace(
        "  async function bindExecution(",
        '  const DIRECT_TABLE_ACCESS = "INSERT INTO executions.execution_events"; // mutant\n  async function bindExecution(',
      ),
    );
    expectCaught(tree, "verification-references-executions-tables");
  });

  test("M14: a second execution state machine vocabulary is introduced", () => {
    const tree = mutate(realTree(), treePath(8), (content) =>
      content.replace(
        "export interface EvidenceBundle {",
        'export const MUTANT_LIFECYCLE = ["RUNNING", "WAITING_TOOL", "SUCCEEDED"] as const; // mutant\nexport interface EvidenceBundle {',
      ),
    );
    expectCaught(tree, "verification-defines-execution-lifecycle");
  });

  test("M15: the model evaluator gains policy authority", () => {
    const tree = mutate(realTree(), treePath(1), (content) =>
      content.replace(
        'import type { ModelJudge } from "../ports/model-judge";',
        'import type { PolicyAuthority } from "../../policies/public";\nimport type { ModelJudge } from "../ports/model-judge";',
      ),
    );
    expectCaught(tree, "verification-holds-policy-authority");
  });

  test("M16: the comparison planner gate is removed", () => {
    const tree = mutate(realTree(), treePath(0), (content) =>
      content.replace(
        "        ...validateComparison({ ...input, tenantId: input.actor.tenantId }),\n        ...validatePlannerAuthorization(input.plannerAuthorization),",
        "        ...validateComparison({ ...input, tenantId: input.actor.tenantId }),",
      ),
    );
    expectCaught(tree, "comparison-planner-gate-missing");
  });

  test("M17: a provider-specific evaluator type leaks into domain contracts", () => {
    const tree = mutate(realTree(), treePath(8), (content) =>
      content.replace(
        "export interface EvaluationContext {",
        "export interface AnthropicJudgeOptions { model: string } // mutant\nexport interface EvaluationContext {",
      ),
    );
    expectCaught(tree, "provider-identifier-in-domain-contracts");
  });

  test("M18: the deterministic evaluator secretly imports the models module", () => {
    const tree = mutate(realTree(), treePath(2), (content) =>
      content.replace(
        'import type { CriterionKind } from "../domain/criteria";',
        'import type { ModelRequest } from "../../models/public";\nimport type { CriterionKind } from "../domain/criteria";\nvoid ({} as ModelRequest);',
      ),
    );
    expectCaught(tree, "deterministic-evaluator-imports-authority-or-model");
  });

  test("M4: the PASS-requires-evidence domain validation is gutted", () => {
    const tree = mutate(realTree(), treePath(5), (content) =>
      content.replace(
        '} else if (result.status === "PASS" && result.evidence.length === 0) {\n    issues.push("PASS requires at least one evidence reference (no evidence, no PASS)");\n  }',
        "",
      ),
    );
    expectCaught(tree, "result-domain-pass-evidence-validation-missing");
  });

  test("M20: the evaluator-version validation is gutted", () => {
    const tree = mutate(realTree(), treePath(5), (content) =>
      content.replace(
        '    issues.push("evaluator must carry a known kind, a non-empty id and a non-empty version");',
        '    issues.push("evaluator must carry a known kind and a non-empty id");',
      ),
    );
    expectCaught(tree, "result-domain-evaluator-version-validation-missing");
  });

  test("M21: the criteria-binding validation is gutted", () => {
    const tree = mutate(realTree(), treePath(5), (content) =>
      content.replace(
        '    issues.push("criterionId must be a non-empty string (criteria binding is mandatory)");',
        '    issues.push("criterionId optional");',
      ),
    );
    expectCaught(tree, "result-domain-criteria-binding-validation-missing");
  });

  test("M24: the provenance validation is gutted", () => {
    const tree = mutate(realTree(), treePath(5), (content) =>
      content.replace(
        '    issues.push("provenance must bind the evaluationId and actorId (no detached results)");',
        '    issues.push("provenance optional");',
      ),
    );
    expectCaught(tree, "result-domain-provenance-validation-missing");
  });

  test("M5/M6: the conclusion derivation pass-check is gutted", () => {
    const tree = mutate(realTree(), treePath(6), (content) =>
      content.replace(
        'if (latest === undefined || latest.status !== "PASS") {',
        "if (latest === undefined) { // mutant: any result counts as met",
      ),
    );
    expectCaught(tree, "conclusion-pass-check-missing");
  });

  test("M5/M6: the conclusion unmet surfacing is gutted", () => {
    const tree = mutate(realTree(), treePath(6), (content) =>
      content
        .replace(
          "  const requiredUnmet: UnmetCriterion[] = [];",
          "  const unmet: UnmetCriterion[] = []; void unmet; // mutant\n  const requiredUnmet: UnmetCriterion[] = [];",
        )
        .replace(
          "  return { criteriaMet: requiredUnmet.length === 0, requiredUnmet };",
          "  return { criteriaMet: true, requiredUnmet: [] }; // mutant: always met",
        ),
    );
    expectCaught(tree, "conclusion-unmet-surfacing-missing");
  });

  test("M25: the target-resolution fail-closed rejection is gutted (certify without an actual target)", () => {
    const tree = mutate(realTree(), treePath(0), (content) =>
      content.replace(
        "    if (!resolution.resolved) {",
        "    if (false) { // mutant: unresolved targets evaluate anyway",
      ),
    );
    expectCaught(tree, "verify-target-resolution-fail-closed");
  });

  test("M26: the verifier issues a replan transition itself (replanning becomes verifier-owned)", () => {
    const tree = mutate(realTree(), treePath(0), (content) =>
      content.replace(
        "  async function concludeEvaluation(",
        '  async function mutantReplan(executionId: string, applicationId: string, actor: { actorId: string; tenantId: string }) { await transitions.replan({ executionId, applicationId, actor }, "mutant-replan"); } // mutant: the verifier replans\n  async function concludeEvaluation(',
      ),
    );
    expectCaught(tree, "verification-owns-replanning-transitions");
  });

  test("M26: the adapter issues a replan transition command (planner authority seized)", () => {
    const tree = mutate(realTree(), treePath(4), (content) =>
      content.replace(
        '          command: "verify",',
        '          command: "replan", // mutant: verifier-owned replanning',
      ),
    );
    expectCaught(tree, "verification-owns-replanning-transitions");
  });

  test("M26: the transition port grows a replan method (the planner's authority in the verifier's port)", () => {
    const tree = mutate(realTree(), treePath(11), (content) =>
      content.replace(
        "  /** VERIFYING → COMPLETED, bound to at least one PASS verification result. */",
        "  /** MUTANT: the verifier decides to replan itself. */\n  replan(\n    input: ExecutionTransitionInput,\n    idempotencyKey: string,\n  ): Promise<ExecutionTransitionOutcome>;\n  /** VERIFYING → COMPLETED, bound to at least one PASS verification result. */",
      ),
    );
    expectCaught(tree, "verification-owns-replanning-transitions");
  });
});

// ---------------------------------------------------------------------------
// RUNTIME RED RECORDS
// ---------------------------------------------------------------------------

async function expectCode(promise: Promise<unknown>, code: string): Promise<void> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(PlatformError);
    expect((error as PlatformError).code).toBe(code);
    return;
  }
  throw new Error(`expected PlatformError ${code}`);
}

describe("runtime red records — the wiring failures the static protections make unrepresentable", () => {
  test("R1 (M1): a fabricated completion is rejected by the executions authority", async () => {
    const w: InMemoryVerificationWorld = createInMemoryVerificationWorld();
    const executionId = w.seedExecution("RUNNING");
    // Drive to VERIFYING legitimately, then attempt pass WITHOUT results.
    await w.transitions.verify(
      {
        executionId,
        applicationId: w.ledger.executions.get(executionId)?.applicationId ?? "",
        actor: w.actor(),
      },
      "k-verify",
    );
    await expectCode(
      w.transitions.pass(
        {
          executionId,
          applicationId: w.ledger.executions.get(executionId)?.applicationId ?? "",
          actor: w.actor(),
          verificationResults: [],
        },
        "k-pass-1",
      ),
      "VERIFICATION_FAILED",
    );
    // A pass with only non-PASS results is equally rejected.
    await expectCode(
      w.transitions.pass(
        {
          executionId,
          applicationId: w.ledger.executions.get(executionId)?.applicationId ?? "",
          actor: w.actor(),
          verificationResults: [
            {
              criterionId: "c",
              strategy: "verification:model",
              status: "INCONCLUSIVE",
              recordedBy: "x",
            },
          ],
        },
        "k-pass-2",
      ),
      "VERIFICATION_FAILED",
    );
    expect(w.ledger.executions.get(executionId)?.status).toBe("VERIFYING");
  });

  test("R2 (M7): a no-policy-set authority fails closed — no default allow exists", async () => {
    const policyStore = new InMemoryPolicyStore();
    const authority: PolicyAuthority = createPolicyAuthority({
      store: policyStore,
      hasher: nodePolicyHasher,
    });
    // The REAL policy admission adapter over the REAL authority with NO
    // published set — every admission fails closed.
    const { createPolicyVerificationAdmission } = await import(
      "../../src/modules/verification/adapters/policy-verification-admission"
    );
    const admission = createPolicyVerificationAdmission(authority);
    const decision = await admission.admit({
      action: "evaluate",
      tenantId: "t",
      applicationId: "a",
      executionId: "e",
    });
    expect(decision.allowed).toBe(false);
    // The mutant wiring (allow-all admission) would let evaluation run —
    // production fails closed with zero results (proven in the unit suite).
    const allowAll: VerificationAdmission = {
      admit: async () => ({ allowed: true }) as VerificationAdmissionDecision,
    };
    const mutantDecision = await allowAll.admit({
      action: "evaluate",
      tenantId: "t",
      applicationId: "a",
      executionId: "e",
    });
    expect(mutantDecision.allowed).toBe(true); // the violation, recorded
  });

  test("R3 (M13): a no-op ledger wired — verification proceeds with ZERO canonical events (violation recorded)", async () => {
    const w = createInMemoryVerificationWorld();
    await w.declare({
      criterionId: "count",
      kind: "invariant",
      definition: { assertions: [{ path: "count", op: "eq", value: 1 }] },
    });
    const executionId = w.seedExecution("RUNNING");
    // The no-op ledger mutant: swallows every step event.
    const noOpLedger: VerificationLedger = {
      recordStepEvent: async () => ({ sequence: 0, type: "no-op", replayed: false }),
      getExecution: async (applicationId, id) => w.ledger.getExecution(applicationId, id),
    };
    // Wire it by constructing a service over the mutant seam.
    const { createVerificationService } = await import(
      "../../src/modules/verification/application/verification-service"
    );
    const mutantService = createVerificationService({
      store: w.store,
      admission: w.admission,
      ledger: noOpLedger,
      transitions: w.transitions,
      evaluators: [
        (
          await import("../../src/modules/verification/adapters/deterministic-evaluators")
        ).createInvariantEvaluator(),
      ],
      generateId: () =>
        `00000000-0000-7000-8000-${Math.floor(Math.random() * 1e12)
          .toString()
          .padStart(12, "0")}`,
      now: () => new Date("2026-01-01T00:00:00Z"),
      hashInput: (text) => `h-${text.length}`,
    });
    // The criterion is already declared (the world shares the store).
    const conclusion = await mutantService.verifyTarget(
      {
        applicationId: "00000000-0000-7000-8000-0000000000a1",
        executionId,
        actor: w.actor(),
        target: { kind: "record", ref: "out" },
        criteria: [{ criterionId: "count", version: 1 }],
        evidence: { facts: { count: 1 }, evidenceRefs: ["r"] },
      },
      "key-noop-ledger",
    );
    // The VIOLATION: results exist with zero canonical ledger events.
    expect(conclusion.criteriaMet).toBe(true);
    expect(w.ledger.events.get(executionId)).toEqual([]);
    // Production (the real wiring, proven above and in the unit suite):
    // the same flow produces requested + result + conclusion envelopes.
    const real = await w.service.verifyTarget(
      {
        applicationId: "00000000-0000-7000-8000-0000000000a1",
        executionId,
        actor: w.actor(),
        target: { kind: "record", ref: "out-2" },
        criteria: [{ criterionId: "count", version: 1 }],
        evidence: { facts: { count: 1 }, evidenceRefs: ["r"] },
      },
      "key-real-ledger",
    );
    expect(real.criteriaMet).toBe(true);
    const types = (w.ledger.events.get(executionId) ?? []).map((event) => event.type);
    expect(types).toContain("execution.verification-requested");
    expect(types).toContain("execution.verification-recorded");
  });

  test("R4 (M5/M22): an INCONCLUSIVE-only evaluation never completes and never records PASS", async () => {
    const w = createInMemoryVerificationWorld();
    await w.declare({
      criterionId: "unknowable",
      kind: "model-judged",
      definition: { rubric: "anything" },
    });
    w.modelJudge.judgment = () => ({
      criterionId: "unknowable",
      meetsCriteria: "unknown",
      rationale: "cannot tell",
      judgeIdentity: {},
    });
    const executionId = w.seedExecution("RUNNING");
    const conclusion = await w.service.verifyExecution(
      {
        applicationId: "00000000-0000-7000-8000-0000000000a1",
        executionId,
        actor: w.actor(),
        criteria: [{ criterionId: "unknowable", version: 1 }],
        evidence: { facts: { x: 1 }, evidenceRefs: ["r"] },
      },
      "key-inconclusive",
    );
    expect(conclusion.criteriaMet).toBe(false);
    expect(conclusion.completed).toBe(false);
    expect(conclusion.requiredUnmet[0]?.status).toBe("INCONCLUSIVE");
    const results = await w.service.listResults(
      "00000000-0000-7000-8000-0000000000a1",
      executionId,
    );
    expect(results.every((result) => result.status !== "PASS")).toBe(true);
    expect(w.ledger.executions.get(executionId)?.status).toBe("VERIFYING");
  });

  test("R5 (M1/M2): a raw provider-success judge payload produces INCONCLUSIVE, never PASS", async () => {
    const w = createInMemoryVerificationWorld();
    await w.declare({
      criterionId: "semantics",
      kind: "model-judged",
      definition: { rubric: "cited sources" },
    });
    // The judge answers like a mutated provider adapter would: HTTP 200,
    // text "looks correct", no bound verdict.
    w.modelJudge.judgment = () =>
      ({
        criterionId: "semantics",
        meetsCriteria: "unknown",
        rationale: 'provider returned 200 OK with body "looks correct"',
        judgeIdentity: { provider: "rail-x" },
      }) as never;
    const executionId = w.seedExecution("RUNNING");
    const conclusion = await w.service.verifyExecution(
      {
        applicationId: "00000000-0000-7000-8000-0000000000a1",
        executionId,
        actor: w.actor(),
        criteria: [{ criterionId: "semantics", version: 1 }],
        evidence: { facts: { answer: "…" }, evidenceRefs: ["artifact:a"] },
      },
      "key-raw-provider",
    );
    expect(conclusion.criteriaMet).toBe(false);
    expect(conclusion.completed).toBe(false);
    const results = await w.service.listResults(
      "00000000-0000-7000-8000-0000000000a1",
      executionId,
    );
    expect(results[0]?.status).toBe("INCONCLUSIVE");
  });

  test("R6 (M25): an over-accepting resolver certifies a GHOST target (violation) — the honest resolver fails closed BEFORE evaluation", async () => {
    const w = createInMemoryVerificationWorld();
    await w.declare({
      criterionId: "count",
      kind: "invariant",
      definition: { assertions: [{ path: "count", op: "eq", value: 1 }] },
    });
    const executionId = w.seedExecution("RUNNING");
    const { createVerificationService } = await import(
      "../../src/modules/verification/application/verification-service"
    );
    const { createInvariantEvaluator } = await import(
      "../../src/modules/verification/adapters/deterministic-evaluators"
    );
    const applicationId = "00000000-0000-7000-8000-0000000000a1";
    // A GHOST target — an artifact digest that does not exist anywhere.
    const ghost = {
      kind: "artifact",
      ref: "ghost-digest-000",
      revision: "ghost-digest-000",
    } as const;

    const buildService = (resolver: TargetResolver) =>
      createVerificationService({
        store: w.store,
        admission: w.admission,
        ledger: w.ledger,
        transitions: w.transitions,
        evaluators: [createInvariantEvaluator()],
        resolvers: { artifact: resolver },
        generateId: () =>
          `00000000-0000-7000-8000-${Math.floor(Math.random() * 1e12)
            .toString()
            .padStart(12, "0")}`,
        now: () => new Date("2026-01-01T00:00:00Z"),
        hashInput: (text) => `h-${text.length}`,
      });

    // PRODUCTION: the honest resolver reports the ghost unresolved — the
    // service fails closed BEFORE any evaluation (typed failure, no result).
    const honest: TargetResolver = {
      resolveTarget: async () => ({ resolved: false, reason: "no such artifact in scope" }),
    };
    await expectCode(
      buildService(honest).verifyTarget(
        {
          applicationId,
          executionId,
          actor: w.actor(),
          target: ghost,
          criteria: [{ criterionId: "count", version: 1 }],
          evidence: { facts: { count: 1 }, evidenceRefs: ["r"] },
        },
        "key-honest-ghost",
      ),
      "TENANT_SCOPE_VIOLATION",
    );
    // Zero results exist for the honest attempt — nothing was certified.
    expect(await w.service.listResults(applicationId, executionId)).toEqual([]);

    // The MUTANT wiring: a resolver that accepts anything — the violation,
    // recorded (verification certifies a result without an actual target).
    const overAccepting: TargetResolver = {
      resolveTarget: async () => ({ resolved: true }),
    };
    const violation = await buildService(overAccepting).verifyTarget(
      {
        applicationId,
        executionId,
        actor: w.actor(),
        target: ghost,
        criteria: [{ criterionId: "count", version: 1 }],
        evidence: { facts: { count: 1 }, evidenceRefs: ["r"] },
      },
      "key-mutant-ghost",
    );
    expect(violation.criteriaMet).toBe(true); // PASS for a target that never existed
  });
});
