/**
 * The pinned-runtime factory (PPR-018A) — the plug-in surface every
 * application work order (PPR-018..027) implements ONCE per pinned
 * application/integration pair.
 *
 * `definePinnedRuntime` validates the registration fail-closed and
 * returns the `PinnedRuntimeDriver` the harness (corpus runner, Demo
 * Mirror run service) executes through. The driver is the ACR-007 §3
 * translation boundary:
 *
 *   application task/context
 *     → Zeck task + constraints + references
 *     → Zeck execution (through the public boundary — SDK over HTTP,
 *       or the in-process API composition)
 *     → result/evidence
 *     → application result
 *
 * The driver must NOT add provider selection, retry routing, budget
 * accounting, verification or optimization logic (the harness's
 * boundary law; the demo-run authorization re-verifies the pins and
 * the credential erasure of whatever the driver starts).
 */

import {
  type ApplicationIdentity,
  type PinnedRuntimeDriver,
  type PinnedRuntimeSession,
  type RevisionPin,
  validatePinnedApplication,
} from "../../src/integrations/compatibility/public";

/** A named factory-validation issue (fail-closed; rendered verbatim). */
export interface PinnedRuntimeDefinitionIssue {
  readonly field: string;
  readonly issue: string;
}

export interface PinnedRuntimeDefinition {
  /** The registry id (the Demo Mirror entry's runBinding.runtime names THIS). */
  readonly runtimeId: string;
  readonly identity: ApplicationIdentity;
  readonly pin: RevisionPin;
  /** Start ONE exact session (the harness hands you the expected binding — verify it). */
  readonly start: (
    context: Parameters<PinnedRuntimeDriver["start"]>[0],
  ) => Promise<PinnedRuntimeSession>;
}

/** Validate a runtime definition's structure (fail-closed). */
export function validatePinnedRuntimeDefinition(
  definition: PinnedRuntimeDefinition,
): readonly PinnedRuntimeDefinitionIssue[] {
  const issues: PinnedRuntimeDefinitionIssue[] = [];
  if (typeof definition.runtimeId !== "string" || definition.runtimeId.trim().length === 0) {
    issues.push({
      field: "runtimeId",
      issue: "the runtime id is mandatory (the demo binding names it)",
    });
  }
  for (const issue of validatePinnedApplication({
    identity: definition.identity,
    pin: definition.pin,
  })) {
    issues.push({ field: `pinnedApplication.${issue.field}`, issue: issue.issue });
  }
  if (typeof definition.start !== "function") {
    issues.push({
      field: "start",
      issue: "the runtime definition implements start(context) — one exact session per call",
    });
  }
  return issues;
}

/**
 * Define a pinned application runtime (the work-order plug-in). Throws
 * a named error on an invalid definition — a broken registration is
 * never silently accepted.
 */
export function definePinnedRuntime(definition: PinnedRuntimeDefinition): PinnedRuntimeDriver {
  const issues = validatePinnedRuntimeDefinition(definition);
  if (issues.length > 0) {
    throw new Error(
      `invalid pinned runtime definition: ${issues
        .map((issue) => `${issue.field}: ${issue.issue}`)
        .join("; ")}`,
    );
  }
  return {
    runtimeId: definition.runtimeId,
    identity: definition.identity,
    pin: definition.pin,
    start: definition.start,
  };
}

/**
 * The stable correlation id for one task execution (threaded into the
 * Zeck execution's metadata so the application's edge ↔ Zeck
 * execution correlation is durable — the ACR-007 §1 correlation
 * identifier).
 */
export function taskCorrelationIdOf(runCorrelationId: string, taskId: string): string {
  return `${runCorrelationId}::task:${taskId}`;
}
