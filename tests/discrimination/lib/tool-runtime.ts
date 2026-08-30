/**
 * Shared governed-tool-runtime boundary scanner (WORK-010).
 *
 * One definition of the POLICY-BEFORE-DISPATCH / admission-chain /
 * durable-intent / canonical-ledger static boundary, two uses — the
 * architecture gate over the REAL src tree, and the discrimination proofs
 * over synthetic source mutations (the WORK-006/007 scanner pattern).
 *
 * The boundary under protection (WORK-010 acceptance criteria 2/3/4/5;
 * checkpoint contracts POLICY-BEFORE-DISPATCH, EXTERNAL-SIDE-EFFECTS,
 * EXECUTION-PROVENANCE, BUDGET-INTEGRITY; architecture-lock invariants
 * 3/7/11):
 *
 *   1. `tool-policy-gate-*` — inside the runtime's `invoke` window, the
 *      REQUIRED policy-admission seam (`admission.admit`) is consulted
 *      BEFORE the tool registry dispatch hand-off (`executeAdmitted`),
 *      with a real fail-closed denial branch: no gate, no dispatch.
 *   2. `tool-capability-gate-*` — the REQUIRED capability seam
 *      (`capabilities.resolve`) is consulted in the same window, after the
 *      policy gate and before dispatch (IMPLEMENTATION.md §7 order).
 *   3. `tool-tenant-check` / `tool-terminal-check` — the execution binding
 *      (tenant scope + non-terminal status) is asserted before dispatch.
 *   4. `costed-tool-budget-bypass` — a costed tool with no wired budget
 *      authority fails closed (the fail-closed check must exist).
 *   5. `tool-durable-intent` / `tool-ledger-intent-event` — in the
 *      execution window, the durable intent row is claimed and the
 *      `execution.tool-requested` ledger event appended BEFORE the adapter
 *      executes (§14 intent-before-effect at the auditable boundary), and
 *      the `execution.tool-result` event is appended after execution,
 *      before the guarded outcome write.
 *   6. `tool-admission-seam-required` / `tool-capability-seam-required` /
 *      `tool-ledger-seam-required` — all three authority seams are
 *      REQUIRED runtime dependencies (no optional-bypass wiring).
 *   7. `no-default-allow-violation` / `no-noop-ledger-violation` — the
 *      tools module ships no allow-all admission and no no-op ledger.
 *   8. `*-seam-does-not-delegate` — the three seam adapters delegate to
 *      the REAL authorities (policies engine, capabilities registry,
 *      executions service); they hold no local decision logic.
 *   9. `tools-imports-model-or-agent` — the tools module never imports
 *      the models or agents modules (deterministic-first, provider/model
 *      independent by construction).
 *  10. `tools-references-executions-tables` — the tools module never
 *      references the executions module's physical tables (the ledger is
 *      reachable only through the executions public service).
 */

export interface ToolBoundaryFile {
  readonly path: string;
  readonly content: string;
}

const RUNTIME_PATH = "src/modules/tools/application/tool-runtime.ts";
const ADMISSION_ADAPTER_PATH = "src/modules/tools/adapters/policy-tool-admission.ts";
const CAPABILITY_GATE_PATH = "src/modules/tools/adapters/capability-gate.ts";
const LEDGER_ADAPTER_PATH = "src/modules/tools/adapters/execution-ledger.ts";

export const TOOL_RUNTIME_CANONICAL_PATHS = [
  RUNTIME_PATH,
  ADMISSION_ADAPTER_PATH,
  CAPABILITY_GATE_PATH,
  LEDGER_ADAPTER_PATH,
] as const;

/** The `invoke` admission window: from the invoke definition to executeAdmitted. */
function invokeWindow(source: string): string | null {
  const start = source.indexOf("const invoke = async (");
  if (start < 0) {
    return null;
  }
  const end = source.indexOf("const executeAdmitted = async (", start);
  return source.slice(start, end < 0 ? source.length : end);
}

/** The execution window: from executeAdmitted to the runtime return block. */
function executeWindow(source: string): string | null {
  const start = source.indexOf("const executeAdmitted = async (");
  if (start < 0) {
    return null;
  }
  const end = source.indexOf("return {\n    invoke,", start);
  return source.slice(start, end < 0 ? source.length : end);
}

export function toolRuntimeViolations(files: readonly ToolBoundaryFile[]): string[] {
  const violations: string[] = [];
  const byPath = new Map(files.map((file) => [file.path, file] as const));

  const runtime = byPath.get(RUNTIME_PATH);
  if (runtime === undefined) {
    return ["tool-runtime-missing"];
  }

  // (1)-(4) the admission chain inside the invoke window.
  const invoke = invokeWindow(runtime.content);
  if (invoke === null) {
    violations.push("tool-invoke-window-missing");
  } else {
    const admitAt = invoke.indexOf("admission.admit(");
    if (admitAt < 0) {
      violations.push("tool-policy-gate-missing");
    } else {
      // The gate must fail closed on denial BEFORE the MAIN dispatch path.
      // (The crash-recovery path may hand off earlier: it continues an
      // invocation whose admission evidence is already durable on the row.)
      const mainDispatchAt = invoke.lastIndexOf("executeAdmitted(");
      const beforeDispatch = mainDispatchAt < 0 ? invoke : invoke.slice(0, mainDispatchAt);
      if (!/if\s*\(\s*!decision\.allowed\s*\)\s*\{/.test(beforeDispatch)) {
        violations.push("tool-policy-gate-no-denial-branch");
      }
    }
    const capabilityAt = invoke.indexOf("capabilities.resolve(");
    if (capabilityAt < 0) {
      violations.push("tool-capability-gate-missing");
    }
    // The MAIN dispatch hand-off (the recovery hand-off precedes the chain
    // legitimately — see above).
    const dispatchAt = invoke.lastIndexOf("executeAdmitted(");
    if (dispatchAt >= 0) {
      if (admitAt >= 0 && admitAt > dispatchAt) {
        violations.push("tool-policy-gate-after-dispatch");
      }
      if (capabilityAt >= 0 && capabilityAt > dispatchAt) {
        violations.push("tool-capability-gate-after-dispatch");
      }
      // Policy BEFORE capability (IMPLEMENTATION.md §7: effective policy →
      // budget reservation → capability resolution → dispatch).
      if (admitAt >= 0 && capabilityAt >= 0 && admitAt > capabilityAt) {
        violations.push("tool-policy-gate-after-capability");
      }
    }
    // Budget fail-closed for costed tools without an authority.
    if (!/budgetAuthority === undefined/.test(invoke)) {
      violations.push("costed-tool-budget-bypass");
    }
    // The budget reservation itself must be inside the admission window.
    if (!/budgetAuthority\.reserve\(/.test(invoke)) {
      violations.push("tool-budget-reserve-missing");
    }
    // Tenant + terminal checks before dispatch.
    if (!/execution\.tenantId !== request\.actor\.tenantId/.test(invoke)) {
      violations.push("tool-tenant-check-missing");
    }
    if (!/COMPLETED/.test(invoke) || !/INVALID_STATE_TRANSITION/.test(invoke)) {
      violations.push("tool-terminal-check-missing");
    }
    // Tool resolution through the registry only (unregistered → typed).
    if (!/registry\.resolve\(request\.toolId\)/.test(invoke)) {
      violations.push("tool-registry-resolution-missing");
    }
  }

  // (5) durable intent + ledger events around the adapter execution.
  const execution = executeWindow(runtime.content);
  if (execution === null) {
    violations.push("tool-execute-window-missing");
  } else {
    const claimAt = execution.indexOf("store.claimDispatching(");
    const requestedAt = execution.indexOf('appendLedgerEvent(record, "tool-requested"');
    const adapterAt = execution.indexOf("adapter.execute(");
    const resultAt = execution.indexOf('appendLedgerEvent(record, "tool-result"');
    const outcomeAt = execution.indexOf("store.recordOutcome(");

    if (claimAt < 0) {
      violations.push("tool-durable-intent-missing");
    }
    if (requestedAt < 0) {
      violations.push("tool-ledger-intent-event-missing");
    }
    if (adapterAt < 0) {
      violations.push("tool-adapter-dispatch-missing");
    }
    if (resultAt < 0) {
      violations.push("tool-ledger-result-event-missing");
    }
    if (outcomeAt < 0) {
      violations.push("tool-outcome-recording-missing");
    }
    if (claimAt >= 0 && requestedAt >= 0 && claimAt > requestedAt) {
      violations.push("tool-ledger-intent-event-before-claim");
    }
    if (requestedAt >= 0 && adapterAt >= 0 && requestedAt > adapterAt) {
      violations.push("tool-ledger-intent-event-after-dispatch");
    }
    if (adapterAt >= 0 && resultAt >= 0 && resultAt < adapterAt) {
      violations.push("tool-ledger-result-event-before-dispatch");
    }
    if (resultAt >= 0 && outcomeAt >= 0 && outcomeAt < resultAt) {
      violations.push("tool-outcome-before-ledger-result-event");
    }
  }

  // (6) the authority seams are REQUIRED (not optional bypass wiring).
  if (!/readonly admission: ToolAdmission;/.test(runtime.content)) {
    violations.push("tool-admission-seam-not-required");
  }
  if (!/readonly capabilities: ToolCapabilityResolution;/.test(runtime.content)) {
    violations.push("tool-capability-seam-not-required");
  }
  if (!/readonly ledger: ExecutionLedger;/.test(runtime.content)) {
    violations.push("tool-ledger-seam-not-required");
  }
  if (!/readonly store: ToolInvocationStore;/.test(runtime.content)) {
    violations.push("tool-store-seam-not-required");
  }

  // (7)-(10) module-level boundaries over every tools file.
  for (const file of files) {
    if (!file.path.startsWith("src/modules/tools/")) {
      continue;
    }
    if (/createAllowAll\w*|alwaysAllow\w*|allowed:\s*true\s*as const/.test(file.content)) {
      violations.push(`no-default-allow-violation:${file.path}`);
    }
    if (/recordStepEvent:\s*async\s*\([^)]*\)\s*=>\s*\(\{\s*sequence:\s*0/.test(file.content)) {
      violations.push(`no-noop-ledger-violation:${file.path}`);
    }
    if (/(?:from|import)\s+["']\.\.\/\.\.\/(?:models|agents)\/public["']/.test(file.content)) {
      violations.push(`tools-imports-model-or-agent:${file.path}`);
    }
    if (/executions\.(?:executions|execution_events|verification_results)\b/.test(file.content)) {
      violations.push(`tools-references-executions-tables:${file.path}`);
    }
  }

  // (8) the seam adapters delegate to the REAL authorities.
  const admissionAdapter = byPath.get(ADMISSION_ADAPTER_PATH);
  if (admissionAdapter === undefined) {
    violations.push("tool-admission-adapter-missing");
  } else if (!/authority\.admitDispatch\(/.test(admissionAdapter.content)) {
    violations.push("tool-admission-seam-does-not-delegate");
  }
  const capabilityGate = byPath.get(CAPABILITY_GATE_PATH);
  if (capabilityGate === undefined) {
    violations.push("tool-capability-gate-adapter-missing");
  } else if (!/registry\.resolve\(/.test(capabilityGate.content)) {
    violations.push("tool-capability-seam-does-not-delegate");
  }
  const ledgerAdapter = byPath.get(LEDGER_ADAPTER_PATH);
  if (ledgerAdapter === undefined) {
    violations.push("tool-ledger-adapter-missing");
  } else if (!/service\.recordStepEvent\(/.test(ledgerAdapter.content)) {
    violations.push("tool-ledger-seam-does-not-delegate");
  }

  return violations;
}

/** True when the canonical protected surface exists in the scanned set. */
export function hasCanonicalToolRuntime(files: readonly ToolBoundaryFile[]): boolean {
  const byPath = new Map(files.map((file) => [file.path, file] as const));
  const runtime = byPath.get(RUNTIME_PATH);
  if (runtime === undefined) {
    return false;
  }
  const invoke = invokeWindow(runtime.content);
  const execution = executeWindow(runtime.content);
  return (
    invoke !== null &&
    execution !== null &&
    invoke.includes("admission.admit(") &&
    invoke.includes("capabilities.resolve(") &&
    execution.includes("store.claimDispatching(") &&
    execution.includes('appendLedgerEvent(record, "tool-requested"') &&
    execution.includes('appendLedgerEvent(record, "tool-result"') &&
    byPath.get(ADMISSION_ADAPTER_PATH) !== undefined &&
    byPath.get(CAPABILITY_GATE_PATH) !== undefined &&
    byPath.get(LEDGER_ADAPTER_PATH) !== undefined
  );
}
