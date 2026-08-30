/**
 * Shared policy-before-dispatch admission scanner (WORK-007).
 *
 * One definition of the POLICY-BEFORE-DISPATCH static boundary, two uses —
 * the architecture gate over the REAL src tree, and the discrimination
 * proofs over synthetic gate-removal mutations (the execution-write-path
 * scanner pattern from WORK-006).
 *
 * The boundary under protection (WORK-007 acceptance criterion 4;
 * checkpoint contract POLICY-BEFORE-DISPATCH proof class "static";
 * `spec/architecture.md` §2.4):
 *
 *   1. `authorize-gate-present` — the executions transition service's
 *      authorize branch consults `authorization.evaluate` (the REQUIRED
 *      policy-admission seam) between the branch marker and the next
 *      command's seam: no gate, no authorize write.
 *   2. `authorize-gate-before-write` — inside that window, the evaluation
 *      call precedes ANY mutation-port call (`appendEvent` /
 *      `updateExecutionForTransition`): admission strictly precedes the
 *      authorize state write.
 *   3. `deny-by-default` — the policies module admits nothing without a
 *      configured set: the application authority loads the current set and
 *      fails closed on null (the deny-by-default return path must exist;
 *      its removal is a mutation the architecture gate flags).
 *   4. `no-default-allow` — the policies module ships no factory that
 *      unconditionally allows (`createAllowAll…`, `alwaysAllow…`, or an
 *      `allowed: true as const` shortcut) — the WORK-003 A3 precedent
 *      extended to the engine itself.
 *   5. `seams-delegate-to-authority` — the two seam adapters
 *      (executions authorize seam, models dispatch seam) call the
 *      authority; they contain no local allow/deny logic of their own.
 */

export interface PolicyGateFile {
  readonly path: string;
  readonly content: string;
}

const SERVICE_PATH = "src/modules/executions/application/execution-service.ts";
const AUTHORITY_PATH = "src/modules/policies/application/policy-authority.ts";
const EXECUTION_SEAM_PATH = "src/modules/policies/adapters/execution-authorization.ts";
const DISPATCH_SEAM_PATH = "src/modules/policies/adapters/dispatch-admission.ts";

export const POLICY_GATE_CANONICAL_PATHS = [
  SERVICE_PATH,
  AUTHORITY_PATH,
  EXECUTION_SEAM_PATH,
  DISPATCH_SEAM_PATH,
] as const;

/** Extract the authorize branch window from the transition service source. */
function authorizeBranchWindow(serviceSource: string): string | null {
  const start = serviceSource.indexOf('command.command === "authorize"');
  if (start < 0) {
    return null;
  }
  const end = serviceSource.indexOf("let reservationId", start);
  return serviceSource.slice(start, end < 0 ? serviceSource.length : end);
}

export function policyBeforeDispatchViolations(files: readonly PolicyGateFile[]): string[] {
  const violations: string[] = [];
  const byPath = new Map(files.map((file) => [file.path, file] as const));

  // (1) + (2) the authorize gate: present and before any write.
  const service = byPath.get(SERVICE_PATH);
  if (service === undefined) {
    violations.push("authorize-gate-service-missing");
  } else {
    const window = authorizeBranchWindow(service.content);
    if (window === null) {
      violations.push("authorize-branch-missing");
    } else {
      const evaluateAt = window.indexOf("authorization.evaluate");
      if (evaluateAt < 0) {
        violations.push("authorize-gate-missing");
      } else {
        const appendAt = window.indexOf("appendEvent");
        const updateAt = window.indexOf("updateExecutionForTransition");
        const firstWrite = [appendAt, updateAt]
          .filter((index) => index >= 0)
          .sort((a, b) => a - b)[0];
        if (firstWrite !== undefined && firstWrite < evaluateAt) {
          violations.push("authorize-gate-after-write");
        }
        // The gate must FAIL CLOSED on denial: a real denial branch
        // (`if (!decision.allowed) { … }`) must exist BEFORE the first write —
        // a decision token alone is not a gate.
        const beforeFirstWrite = window.slice(
          0,
          firstWrite === undefined ? window.length : firstWrite,
        );
        if (!/if\s*\(\s*!decision\.allowed\s*\)\s*\{/.test(beforeFirstWrite)) {
          violations.push("authorize-gate-no-denial-branch");
        }
      }
    }
    // The service cannot be constructed without the authorization seam.
    if (!/readonly authorization: ExecutionAuthorizationPort/.test(service.content)) {
      violations.push("authorization-seam-not-required");
    }
  }

  // (3) deny-by-default: the authority fails closed when no set is loaded.
  const authority = byPath.get(AUTHORITY_PATH);
  if (authority === undefined) {
    violations.push("policy-authority-missing");
  } else {
    if (!/no effective policy set is configured \(deny-by-default\)/.test(authority.content)) {
      violations.push("deny-by-default-removed");
    }
  }

  // (4) no default-allow anywhere in the policies module.
  for (const file of files) {
    if (!file.path.startsWith("src/modules/policies/")) {
      continue;
    }
    if (/createAllowAll\w*|alwaysAllow\w*|allowed:\s*true\s*as const/.test(file.content)) {
      violations.push(`no-default-allow-violation:${file.path}`);
    }
  }

  // (5) the seam adapters delegate to the authority (no local decisions).
  const executionSeam = byPath.get(EXECUTION_SEAM_PATH);
  if (executionSeam === undefined) {
    violations.push("execution-seam-adapter-missing");
  } else if (!/authority\.admit\(/.test(executionSeam.content)) {
    violations.push("execution-seam-does-not-delegate");
  }
  const dispatchSeam = byPath.get(DISPATCH_SEAM_PATH);
  if (dispatchSeam === undefined) {
    violations.push("dispatch-seam-adapter-missing");
  } else if (!/authority\.admitDispatch\(/.test(dispatchSeam.content)) {
    violations.push("dispatch-seam-does-not-delegate");
  }

  return violations;
}

/** True when the canonical protected surface exists in the scanned set. */
export function hasCanonicalPolicyGate(files: readonly PolicyGateFile[]): boolean {
  const byPath = new Map(files.map((file) => [file.path, file] as const));
  const service = byPath.get(SERVICE_PATH);
  const authority = byPath.get(AUTHORITY_PATH);
  return (
    service !== undefined &&
    authority !== undefined &&
    service.content.includes("authorization.evaluate") &&
    service.content.includes("POLICY_DENIED_EVENT_TYPE") &&
    authority.content.includes("deny-by-default") &&
    byPath.get(EXECUTION_SEAM_PATH) !== undefined &&
    byPath.get(DISPATCH_SEAM_PATH) !== undefined
  );
}
