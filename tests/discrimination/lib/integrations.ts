/**
 * Shared integration-surface scanners (WORK-016 discrimination, M1–M26).
 *
 * One definition of each protection, two uses — the architecture gate
 * runs the rules over the REAL trees, and the discrimination proofs
 * mutate the REAL source and require the scanners to flag exactly the
 * weakened protection (the WORK-005/013/014/015 red-record pattern).
 */

export interface SurfaceFile {
  readonly path: string;
  readonly content: string;
}

/** External agent framework identifiers (M10/M20). */
export const FRAMEWORK_IDENTIFIER =
  /\b(LangGraph|CrewAI|AutoGen|OpenAIAgentsSDK|AnthropicAgentSDK|langgraph|crewai|autogen|openai-agents)\w*/;

/** Module authorities the integration must never import (M4–M7, M12, M13, M26). */
const AUTHORITY_MODULE_IMPORT =
  /from\s+["'][^"']*modules\/(policies|budgets|verification|learning|capabilities|tools|models)\/(public|internal|domain|application|ports|adapters)/;

/** Outbound network/SQL channels (M1, M2, M11, M25). */
export const NETWORK_OR_SQL =
  /\bfrom\s+["'](node:http|node:https|node:net|node:tls|undici|axios|got|node-fetch|pg|postgres)["']|\bfetch\s*\(|\b(INSERT INTO|UPDATE\s+[a-z]+\.[a-z_]+|DELETE FROM)\b/;

/** WorkflowOS-side state-mutation verbs (M1/M2/M9). */
const WORKFLOWOS_MUTATION_VERB =
  /\b(updateTask|setTaskStatus|transitionWorkflow|mutateWorkflowOs|workflowosClient|updateWorkItem|patchWorkflow)\s*\(/;

/** A second registry/store defined inside the integration tree (M19, M9). */
const SECOND_AUTHORITY_PATTERN =
  /\bclass\s+\w*(AgentRegistry|WorkflowOs|WorkflowStore|ExecutionRegistry|PolicyEngine|IdempotencyLedger)|\bworkflowStates\s*[:=]/;

/** Secret-shaped fields in BYOA contracts (M23/M24). */
const SECRET_SHAPED_FIELD =
  /\b(apiKey|apiSecret|secretValue|plaintextSecret|bearerToken|password)\s*[?]?:/;

/** Authority-mutation calls a MEASUREMENT surface must never make (§21). */
export const MEASUREMENT_MUTATION_CALL =
  /\.(createExecution|transition|registerAgent|publishVersion|promote|rollback|suspend|resume|retire|reserve|settle|release|publish|submitWork|createSession|runSession|recordStepEvent|recordAction)\s*\(/;

export function integrationSurfaceViolations(files: readonly SurfaceFile[]): string[] {
  const violations: string[] = [];
  for (const file of files) {
    if (file.path.startsWith("src/integrations/")) {
      if (AUTHORITY_MODULE_IMPORT.test(file.content)) {
        violations.push(`authority-import:${file.path}`);
      }
      if (NETWORK_OR_SQL.test(file.content)) {
        violations.push(`mutation-channel:${file.path}`);
      }
      if (WORKFLOWOS_MUTATION_VERB.test(file.content)) {
        violations.push(`workflowos-mutation-verb:${file.path}`);
      }
      if (SECOND_AUTHORITY_PATTERN.test(file.content)) {
        violations.push(`second-authority:${file.path}`);
      }
      if (file.path.endsWith("domain/byoa.ts") && SECRET_SHAPED_FIELD.test(file.content)) {
        violations.push(`byoa-secret-surface:${file.path}`);
      }
      const match = FRAMEWORK_IDENTIFIER.exec(file.content);
      if (match !== null) {
        violations.push(`framework-identifier:${file.path}:${match[0]}`);
      }
    }
    if (file.path.startsWith("benchmarks/")) {
      if (NETWORK_OR_SQL.test(file.content)) {
        violations.push(`benchmark-sql-or-network:${file.path}`);
      }
      const match = FRAMEWORK_IDENTIFIER.exec(file.content);
      if (match !== null) {
        violations.push(`framework-identifier:${file.path}:${match[0]}`);
      }
    }
    if (
      file.path === "benchmarks/harness.ts" ||
      file.path === "benchmarks/report.ts" ||
      file.path === "benchmarks/contract.ts"
    ) {
      if (MEASUREMENT_MUTATION_CALL.test(file.content)) {
        violations.push(`measurement-mutation-call:${file.path}`);
      }
    }
    if (file.path === "benchmarks/strategies.ts") {
      if (
        /\.(publish|promote|rollback|suspend|resume|retire|reserve|settle|release)\s*\(/.test(
          file.content,
        )
      ) {
        violations.push(`strategy-authority-mutation:${file.path}`);
      }
      if (AUTHORITY_MODULE_IMPORT.test(file.content)) {
        violations.push(`strategy-authority-import:${file.path}`);
      }
    }
  }
  return violations;
}

/**
 * The executions-authority delegation scan (M3/M25): the submission path
 * must call `createExecution` on the injected authority and must hold NO
 * alternative execution-creation surface (no direct row writes, no
 * generateId-for-executions).
 */
export function executionDelegationViolations(serviceSource: string): string[] {
  const violations: string[] = [];
  // The LIVE delegation (await-call) — comments cannot satisfy the rule.
  if (!/\bawait\s+executions\.createExecution\s*\(/.test(serviceSource)) {
    violations.push("submission-must-delegate-to-createExecution");
  }
  if (/\bgenerateId\s*\(/.test(serviceSource)) {
    violations.push("integration-must-not-mint-execution-identities");
  }
  return violations;
}

/**
 * The BYOA registration delegation scan (M19): registration must call
 * the injected registry authority and hold no local agent store.
 */
export function byoaRegistrationViolations(source: string): string[] {
  const violations: string[] = [];
  if (!/deps\.agents\.registerAgent\(/.test(source)) {
    violations.push("byoa-registration-must-delegate-to-registry");
  }
  if (/[Aa]gents\s*[:=]\s*new\s+Map|agentStore\s*[:=]/.test(source)) {
    violations.push("byoa-must-not-own-an-agent-store");
  }
  return violations;
}

/**
 * The sanitization scan (M21/M22/M23): the provider wrapper must map
 * observations through the CLOSED field set (no observation spread, no
 * execution-status field accepted from the external side).
 */
export function byoaSanitizationViolations(source: string): string[] {
  const violations: string[] = [];
  if (/\.\.\.observation/.test(source)) {
    violations.push("observation-spread");
  }
  if (
    /\bobservation\.(status|permissions|executionStatus)\b/.test(source) ||
    /\(observation\s+as[^)]*\)\s*\.\s*(status|permissions|executionStatus)/.test(source)
  ) {
    violations.push("external-side-authority-field-trusted");
  }
  return violations;
}
