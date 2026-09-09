/**
 * The executions-module recovery-invariants seam (WORK-048 / D-07 —
 * the module-side implementation of the platform recovery plane's
 * `ModuleInvariantSource`, sibling of the worker-fabric seam
 * precedent).
 *
 * The executions tables are module-private surface (WORK-006's
 * single-write-path boundary): the D-07 recovered-authority gate
 * verifies them through THIS adapter over the module's own tables —
 * the platform never queries them directly.
 *
 * Checks owned here (the frozen semantics, re-proved as explicit
 * queries because the restore ran with triggers disabled):
 *
 *   1. every execution status is inside the FROZEN 14-state
 *      vocabulary (the state-machine integrity; the vocabulary is
 *      injected by the composition root — the frozen list belongs to
 *      the architecture);
 *   2. per-execution event sequences are GAPLESS
 *      1..last_event_sequence (append-only ledger completeness — a
 *      partial restore is DETECTED, never silently accepted).
 */

import type { DatabasePort } from "../../../platform/db/port";
import type {
  AuthorityInvariantViolation,
  ModuleInvariantSource,
} from "../../../platform/recovery/authority-verification";
import { EXECUTION_STATES } from "../public";

export const EXECUTION_RECOVERY_CHECKS = [
  "execution-status-vocabulary",
  "execution-event-gapless-sequences",
] as const;

/**
 * The executions module's recovered-state invariants (fail closed on
 * a missing frozen vocabulary — the composition root must supply the
 * architecture's list).
 */
export function createExecutionRecoveryInvariants(
  db: DatabasePort,
  executionStatusVocabulary: readonly string[] = EXECUTION_STATES,
): ModuleInvariantSource {
  if (executionStatusVocabulary.length === 0) {
    throw new Error("the frozen execution status vocabulary is required (composition root)");
  }
  return {
    module: "executions",
    checks: [...EXECUTION_RECOVERY_CHECKS],
    async verify(): Promise<readonly AuthorityInvariantViolation[]> {
      const violations: AuthorityInvariantViolation[] = [];
      const vocabulary = executionStatusVocabulary.map((state) => `'${state}'`).join(", ");

      // 1. Execution states inside the frozen vocabulary.
      const badStatuses = await db.execute<{ readonly count: string }>({
        sql: `SELECT count(*) AS count FROM executions.executions WHERE status NOT IN (${vocabulary})`,
        parameters: [],
      });
      const badStatusCount = Number(badStatuses.rows[0]?.count ?? 0);
      if (badStatusCount > 0) {
        violations.push({
          check: "execution-status-vocabulary",
          detail: `${badStatusCount} executions outside the frozen state vocabulary`,
        });
      }

      // 2. Execution event ledger: gapless per-execution sequences.
      const gappedEvents = await db.execute<{ readonly count: string }>({
        sql: `SELECT count(*) AS count FROM (
               SELECT e.id
               FROM executions.executions e
               JOIN LATERAL (
                 SELECT count(*) AS rows, max(sequence) AS top
                 FROM executions.execution_events ev WHERE ev.execution_id = e.id
               ) s ON true
               WHERE s.rows <> s.top OR s.rows <> e.last_event_sequence
             ) g`,
        parameters: [],
      });
      const gappedCount = Number(gappedEvents.rows[0]?.count ?? 0);
      if (gappedCount > 0) {
        violations.push({
          check: "execution-event-gapless-sequences",
          detail: `${gappedCount} executions with gapped or truncated event ledgers (incomplete restore)`,
        });
      }

      return violations;
    },
  };
}
