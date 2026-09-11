/**
 * Validation-state consistency contract (VAL-001, acceptance criterion 2).
 *
 * The three governed state files under `spec/validation-state/` are the ONE
 * authority for validation program state. This module defines the
 * mechanical consistency rules between them — the same rules the standalone
 * checker `scripts/validation-check.py` enforces from the command line and
 * the vitest suite runs in CI. Pure functions over parsed JSON: no file
 * access, no mutation, deterministic verdicts.
 */

import type { ValidationStateSnapshot } from "./program";

/** One mechanical inconsistency found in a validation state snapshot. */
export interface StateViolation {
  readonly kind:
    | "program-mismatch"
    | "frontier-mismatch"
    | "unknown-work-order"
    | "missing-work-order"
    | "inflight-not-eligible-status"
    | "dependency-unknown"
    | "dependency-cycle"
    | "dependency-not-complete"
    | "concurrency-exceeded"
    | "eligible-but-inflight"
    | "status-mismatch";
  readonly detail: string;
}

/** All statuses a work order may legally hold in program state. */
export const WORK_ORDER_STATUSES = [
  "planned",
  "eligible",
  "in-flight",
  "complete",
  "void",
] as const;

export type WorkOrderStatus = (typeof WORK_ORDER_STATUSES)[number];

/**
 * Check a full validation state snapshot for mechanical consistency.
 *
 * Rules:
 *  - the three files describe the same program and agree on the
 *    concurrency ceiling;
 *  - every id referenced by frontier/dependency state exists in program
 *    state and every program-state id has a dependency entry;
 *  - in-flight ids are declared with an authorizing status (never
 *    "planned");
 *  - dependencies reference known ids and contain no cycles;
 *  - no dependency of an eligible/in-flight item is incomplete;
 *  - the in-flight count respects the three-worker ceiling;
 *  - program status and frontier status agree.
 */
export function checkValidationStateConsistency(
  state: ValidationStateSnapshot,
): readonly StateViolation[] {
  const violations: StateViolation[] = [];
  const { program, frontier, dependencies } = state;

  if (program.program !== frontier.program || program.program !== dependencies.program) {
    violations.push({
      kind: "program-mismatch",
      detail: `program identifiers disagree: program=${program.program} frontier=${frontier.program} dependencies=${dependencies.program}`,
    });
  }
  if (frontier.program !== program.program) {
    // covered by the first rule; kept defensive for partial snapshots
    violations.push({
      kind: "frontier-mismatch",
      detail: `frontier program is ${frontier.program}`,
    });
  }
  if (program.maxConcurrentWorkers !== frontier.maxConcurrentWorkers) {
    violations.push({
      kind: "concurrency-exceeded",
      detail: `maxConcurrentWorkers disagrees: program=${program.maxConcurrentWorkers} frontier=${frontier.maxConcurrentWorkers}`,
    });
  }
  if (program.status !== frontier.status) {
    violations.push({
      kind: "status-mismatch",
      detail: `program status ${program.status} != frontier status ${frontier.status}`,
    });
  }
  if (frontier.maxConcurrentWorkers !== 3) {
    violations.push({
      kind: "concurrency-exceeded",
      detail: `the validation roadmap fixes maxConcurrentWorkers at 3, frontier declares ${frontier.maxConcurrentWorkers}`,
    });
  }

  const known = new Set(Object.keys(program.workOrders));
  const depMap = new Map(Object.entries(dependencies.dependencies));

  for (const id of [...frontier.inFlight, ...frontier.eligible, ...frontier.blocked]) {
    if (!known.has(id)) {
      violations.push({ kind: "unknown-work-order", detail: `frontier references unknown ${id}` });
    }
  }
  for (const id of known) {
    if (!depMap.has(id)) {
      violations.push({
        kind: "missing-work-order",
        detail: `program state declares ${id} but dependency state has no entry`,
      });
    }
  }
  for (const [id, deps] of depMap) {
    if (!known.has(id)) {
      violations.push({
        kind: "unknown-work-order",
        detail: `dependency state declares ${id} but program state does not`,
      });
    }
    for (const dep of deps) {
      if (!known.has(dep)) {
        violations.push({ kind: "dependency-unknown", detail: `${id} depends on unknown ${dep}` });
      }
    }
    if (hasCycle(id, depMap, new Set<string>())) {
      violations.push({
        kind: "dependency-cycle",
        detail: `dependency cycle reachable from ${id}`,
      });
    }
  }

  for (const id of frontier.inFlight) {
    const declared = program.workOrders[id]?.status;
    if (declared !== undefined && declared === "planned") {
      violations.push({
        kind: "inflight-not-eligible-status",
        detail: `${id} is in flight but program state still declares it ${declared}`,
      });
    }
  }
  for (const id of frontier.eligible) {
    if (frontier.inFlight.includes(id)) {
      violations.push({
        kind: "eligible-but-inflight",
        detail: `${id} is both eligible and in flight`,
      });
    }
  }
  if (frontier.inFlight.length > frontier.maxConcurrentWorkers) {
    violations.push({
      kind: "concurrency-exceeded",
      detail: `${frontier.inFlight.length} work orders in flight exceeds the ceiling of ${frontier.maxConcurrentWorkers}`,
    });
  }

  const complete = (id: string): boolean => program.workOrders[id]?.status === "complete";
  for (const id of [...frontier.inFlight, ...frontier.eligible]) {
    for (const dep of depMap.get(id) ?? []) {
      if (!complete(dep)) {
        violations.push({
          kind: "dependency-not-complete",
          detail: `${id} is eligible/in-flight but dependency ${dep} is not complete`,
        });
      }
    }
  }

  return violations;
}

/** Depth-first cycle detection over the dependency map. */
function hasCycle(
  start: string,
  depMap: Map<string, readonly string[]>,
  visited: Set<string>,
): boolean {
  if (visited.has(start)) {
    return true;
  }
  visited.add(start);
  for (const dep of depMap.get(start) ?? []) {
    if (hasCycle(dep, depMap, new Set(visited))) {
      return true;
    }
  }
  return false;
}
