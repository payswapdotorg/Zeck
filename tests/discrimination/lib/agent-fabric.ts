/**
 * Shared agent-fabric boundary scanner (WORK-011).
 *
 * Used by BOTH the architecture gate
 * (tests/architecture/agent-fabric-boundary.test.ts) and the
 * discrimination proofs
 * (tests/discrimination/agent-fabric.discrimination.test.ts) — one
 * definition of each protection, two uses, so a weakened protection is
 * provably rejected (the WORK-003/006/007/010 scanner discipline).
 *
 * Every violation id corresponds to a named WORK-011 discrimination
 * boundary (M1..M24 in the Work Order's HIGH_ASSURANCE profile).
 */

export interface AgentFabricFile {
  /** POSIX path relative to the repository root. */
  readonly path: string;
  readonly content: string;
}

export type AgentFabricViolation = string;

/** Strip comments so prose cannot satisfy code-shape assertions. */
export function codeOnly(content: string): string {
  return content.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

function isAgentsModule(path: string): boolean {
  return path.startsWith("src/modules/agents/");
}

/** The canonical protected files the scanner reasons about. */
export const AGENT_FABRIC_CANONICAL_PATHS = [
  "src/modules/agents/public.ts",
  "src/modules/agents/domain/agent.ts",
  "src/modules/agents/domain/agent-version.ts",
  "src/modules/agents/domain/session.ts",
  "src/modules/agents/domain/workspace.ts",
  "src/modules/agents/domain/credential.ts",
  "src/modules/agents/domain/approval.ts",
  "src/modules/agents/domain/permissions.ts",
  "src/modules/agents/ports/agent-provider.ts",
  "src/modules/agents/ports/agent-admission.ts",
  "src/modules/agents/ports/agent-execution-ledger.ts",
  "src/modules/agents/ports/agent-store.ts",
  "src/modules/agents/application/agent-registry.ts",
  "src/modules/agents/application/session-service.ts",
  "src/modules/agents/adapters/policy-agent-admission.ts",
  "src/modules/agents/adapters/execution-ledger.ts",
  "src/modules/agents/adapters/sql-agent-store.ts",
] as const;

export function hasCanonicalAgentFabric(files: readonly AgentFabricFile[]): boolean {
  const paths = new Set(files.map((f) => f.path));
  return AGENT_FABRIC_CANONICAL_PATHS.every((path) => paths.has(path));
}

/**
 * Scan a source tree (the agents module files + optionally the broader
 * src tree) for agent-fabric boundary violations. Pure: returns the
 * violation ids (empty = clean).
 */
export function agentFabricViolations(files: readonly AgentFabricFile[]): AgentFabricViolation[] {
  const violations: AgentFabricViolation[] = [];
  const byPath = new Map(files.map((f) => [f.path, f] as const));
  const agentsFiles = files.filter((f) => isAgentsModule(f.path));

  const service = byPath.get("src/modules/agents/application/session-service.ts");
  const providerPort = byPath.get("src/modules/agents/ports/agent-provider.ts");
  const storePort = byPath.get("src/modules/agents/ports/agent-store.ts");
  const registry = byPath.get("src/modules/agents/application/agent-registry.ts");
  const publicBarrel = byPath.get("src/modules/agents/public.ts");
  const sqlStore = byPath.get("src/modules/agents/adapters/sql-agent-store.ts");
  const admissionAdapter = byPath.get("src/modules/agents/adapters/policy-agent-admission.ts");
  const ledgerAdapter = byPath.get("src/modules/agents/adapters/execution-ledger.ts");

  // ---- M1: Agent is not a second execution abstraction ----
  if (
    publicBarrel !== undefined &&
    /ExecutionStatus|EXECUTION_STATES|TRANSITION_TABLE/.test(codeOnly(publicBarrel.content))
  ) {
    violations.push("agent-execution-status-vocabulary");
  }
  for (const f of agentsFiles) {
    if (
      f.path.includes("/domain/") &&
      /\b(CREATED|AUTHORIZED|VERIFYING|REPLANNING)\b/.test(codeOnly(f.content))
    ) {
      violations.push("agent-second-execution-state-machine");
      break;
    }
  }
  // No DML against other modules' authority tables.
  for (const f of agentsFiles) {
    if (
      /\b(INSERT|UPDATE|DELETE)\s+(INTO\s+)?(executions|platform|policies|capabilities|budgets|tools)\./i.test(
        codeOnly(f.content),
      )
    ) {
      violations.push("agent-writes-authority-tables");
      break;
    }
  }

  // ---- M2: AgentProvider stays distinct from ModelProvider ----
  if (providerPort !== undefined) {
    const code = codeOnly(providerPort.content);
    if (/models\/public/.test(providerPort.content) || /ModelProvider/.test(code)) {
      violations.push("agent-provider-models-collapse");
    }
    if (!/readonly runtimeKind:\s*string/.test(code) || !/executeSession\(/.test(code)) {
      violations.push("agent-provider-contract-shape");
    }
    if (/complete\(request|stream\(request/.test(code)) {
      violations.push("agent-provider-inference-contract");
    }
  }

  // ---- M3/M4: workspace scope checks (tenant + application) ----
  if (service !== undefined && !/checkWorkspaceScope\(/.test(codeOnly(service.content))) {
    violations.push("agent-workspace-scope-check-missing");
  }

  // ---- M5: execution binding + tenant guard ----
  if (service !== undefined) {
    const code = codeOnly(service.content);
    if (!/ledger\.getExecution\(/.test(code)) {
      violations.push("agent-execution-binding-missing");
    }
    if (!/execution\.tenantId !== actor\.tenantId/.test(code)) {
      violations.push("agent-execution-tenant-check-missing");
    }
  }

  // ---- M6: definition validation (raw secrets rejected at publish) ----
  if (registry !== undefined && !/validateAgentDefinition\(/.test(codeOnly(registry.content))) {
    violations.push("agent-definition-validation-missing");
  }

  // ---- M7: the runtime contract carries references, never secret values ----
  if (providerPort !== undefined) {
    const code = codeOnly(providerPort.content);
    if (!/readonly credentials: readonly CredentialGrantReference\[\]/.test(code)) {
      violations.push("agent-runtime-secret-field");
    }
    if (/(apiKey|api_key|plaintext|password|bearerToken)\s*[:?]/i.test(code)) {
      violations.push("agent-runtime-secret-field");
    }
  }
  if (sqlStore !== undefined && /credential_value|secret_value|plaintext/i.test(sqlStore.content)) {
    violations.push("agent-store-secret-column");
  }

  // ---- M8: grant usability re-validation at dispatch ----
  if (service !== undefined && !/grantIsUsable\(/.test(codeOnly(service.content))) {
    violations.push("agent-grant-usability-check-missing");
  }

  // ---- M9: effective permissions only (the intersection) ----
  if (service !== undefined) {
    const code = codeOnly(service.content);
    if (/requestedPermissions/.test(code) && /effectivePermissions:\s*[^d]/.test(code)) {
      // the session bundle must carry the DECISION's set, not the definition's
      const carriesRequested =
        /effectivePermissions:\s*(version|input)\.definition\.requestedPermissions/.test(code);
      if (carriesRequested) {
        violations.push("agent-permission-intersection-bypass");
      }
    }
    if (!/decision\.effectivePermissions/.test(code)) {
      violations.push("agent-permission-intersection-bypass");
    }
  }

  // ---- M10: policy admission REQUIRED (no default-allow) ----
  if (service !== undefined) {
    const code = codeOnly(service.content);
    if (!/admission\.admit\(/.test(code)) {
      violations.push("agent-policy-gate-missing");
    }
    const denialBranch =
      /if \(!decision\.allowed\) \{[\s\S]{0,600}?POLICY_DENIED[\s\S]{0,600}?\}/.exec(code);
    if (denialBranch === null) {
      violations.push("agent-policy-gate-no-denial-branch");
    }
  }

  // ---- M11: tool permission check at dispatch ----
  if (service !== undefined) {
    const code = codeOnly(service.content);
    if (!/effectivePermissions\.tools\.includes\(/.test(code)) {
      violations.push("agent-tool-permission-check-missing");
    }
  }

  // ---- M12: the approval gate (policy-designated) ----
  if (service !== undefined) {
    const code = codeOnly(service.content);
    const gatedAssignment = /const gated =[\s\S]{0,400}?;/.exec(code);
    if (
      gatedAssignment === null ||
      !/actionRequiresApproval\(/.test(gatedAssignment[0]) ||
      !/autonomyEngagesApprovalGate\(/.test(gatedAssignment[0])
    ) {
      violations.push("agent-approval-gate-missing");
    }
    if (!/approvalAuthorizesDispatch\(/.test(code)) {
      violations.push("agent-approval-authorization-check-missing");
    }
  }

  // ---- M13: side effect impossible before approval (status guard) ----
  if (service !== undefined) {
    const code = codeOnly(service.content);
    if (!/session\.status !== "running"[\s\S]{0,700}?cannot dispatch actions/.test(code)) {
      violations.push("agent-session-status-dispatch-guard-missing");
    }
  }

  // ---- M14: approval decisions are tenant-guarded ----
  if (service !== undefined) {
    const code = codeOnly(service.content);
    if (!/approval\.tenantId !== actor\.tenantId[\s\S]{0,500}?TENANT_SCOPE_VIOLATION/.test(code)) {
      violations.push("agent-approval-tenant-check-missing");
    }
  }

  // ---- M15/M16: versions are immutable; rollback selects, never mutates ----
  if (storePort !== undefined) {
    const code = codeOnly(storePort.content);
    if (/updateVersion|deleteVersion|mutateVersion/.test(code)) {
      violations.push("agent-version-update-path");
    }
  }
  if (registry !== undefined) {
    const code = codeOnly(registry.content);
    if (!/insertSelection\(/.test(code)) {
      violations.push("agent-selection-append-path-missing");
    }
    if (!/appendSelection\(\s*input,\s*"rollback"/.test(code)) {
      violations.push("agent-rollback-selection-missing");
    }
  }

  // ---- M17/M18: unique-key convergence (SQL store ON CONFLICT arbitration) ----
  if (sqlStore !== undefined) {
    const content = sqlStore.content;
    if (!/ON CONFLICT \(application_id, slug\) DO NOTHING/.test(content)) {
      violations.push("agent-registration-no-convergence");
    }
    if (!/ON CONFLICT \(application_id, session_key\) DO NOTHING/.test(content)) {
      violations.push("agent-session-no-convergence");
    }
  }

  // ---- M19: session lifecycle rides execution identity authority ----
  if (service !== undefined) {
    const code = codeOnly(service.content);
    if (/INSERT INTO executions\.|UPDATE executions\./.test(code)) {
      violations.push("agent-executions-table-write");
    }
  }

  // ---- M20: evidence flows through the canonical ledger ----
  if (service !== undefined) {
    const code = codeOnly(service.content);
    if (!/ledger\.recordStepEvent\(/.test(code)) {
      violations.push("agent-evidence-ledger-bypass");
    }
    if (!/agent-session-started/.test(code) || !/agent-session-completed/.test(code)) {
      violations.push("agent-evidence-lifecycle-events-missing");
    }
  }

  // ---- M21: provenance payload sufficiency (who/what/when/why) ----
  if (service !== undefined) {
    const code = codeOnly(service.content);
    const startedPayload = /agent-session-started",[\s\S]{0,1200}?\},\n {8}\{/.exec(code);
    if (
      startedPayload === null ||
      !/policyEvidence/.test(startedPayload[0]) ||
      !/agentVersionId/.test(startedPayload[0]) ||
      !/inputDigest/.test(startedPayload[0])
    ) {
      violations.push("agent-evidence-provenance-stripped");
    }
  }

  // ---- M22: provider SDKs/vendor types stay out ----
  for (const f of agentsFiles) {
    if (
      /from ["'](openai|@anthropic-ai|groq-sdk|@mistralai|cohere-ai|@google\/generative-ai|@azure\/openai|@aws-sdk)/.test(
        f.content,
      )
    ) {
      violations.push("agent-provider-sdk-import");
      break;
    }
  }
  if (
    publicBarrel !== undefined &&
    /openrouter|anthropic|openai|gemini|groq|mistral|cohere/i.test(publicBarrel.content)
  ) {
    violations.push("agent-public-vendor-identifiers");
  }

  // ---- M23: no second policy/capability/budget authority ----
  for (const f of agentsFiles) {
    if (
      /interface\s+(PolicyAuthority|CapabilityRegistry|BudgetAuthority|BudgetService)\b/.test(
        codeOnly(f.content),
      )
    ) {
      violations.push("agent-second-authority");
      break;
    }
  }
  if (admissionAdapter !== undefined) {
    if (
      !/from ["']\.\.\/\.\.\/policies\/public["']/.test(admissionAdapter.content) ||
      !/admitDispatch/.test(admissionAdapter.content)
    ) {
      violations.push("agent-admission-not-delegating");
    }
  }
  if (ledgerAdapter !== undefined) {
    if (
      !/from ["']\.\.\/\.\.\/executions\/public["']/.test(ledgerAdapter.content) ||
      !/recordStepEvent/.test(ledgerAdapter.content)
    ) {
      violations.push("agent-ledger-not-delegating");
    }
  }

  // ---- M24: the adapter seam is execution-agnostic ----
  if (providerPort !== undefined) {
    const code = codeOnly(providerPort.content);
    if (/ExecutionStatus|wait-human|WAITING_HUMAN|waitHuman|resume\(/.test(code)) {
      violations.push("agent-provider-execution-coupled");
    }
  }

  // ---- The step-event vocabulary stays owned by executions ----
  for (const f of files) {
    if (!isAgentsModule(f.path) && f.path.startsWith("src/modules/executions/")) continue;
    if (!isAgentsModule(f.path) && f.path.startsWith("src/")) {
      if (/STEP_EVENT_COMMANDS\s*=/.test(codeOnly(f.content))) {
        violations.push("agent-step-vocabulary-duplicated");
        break;
      }
    }
  }

  return violations;
}
