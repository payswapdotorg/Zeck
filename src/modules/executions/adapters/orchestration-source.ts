/**
 * Orchestration candidate source (executions module adapter;
 * WORK-045 / D-04) — the `WaitingExecutionSource` seam
 * implementation.
 *
 * Lists executions currently in one of the three governed wait
 * states (read-only over the module's own table) and maps each
 * authoritative status to the provider-neutral orchestration wait
 * kind. The mapping is DOMAIN knowledge — the frozen execution
 * vocabulary stays in the executions module; the platform
 * orchestration plane sees only the neutral wait kinds (pinned by
 * the D-04 architecture suite):
 *
 *   WAITING_TOOL  -> callback (the tool result notifies the intake)
 *   WAITING_USER  -> callback (the user response notifies the intake)
 *   WAITING_HUMAN -> approval (a human records approve/reject)
 *
 * Both callback kinds and the approval kind may carry a deadline
 * (repository-configured, default: none) — the deadline elapse is
 * applied through the governed expiration path, never by the
 * provider's clock.
 *
 * This adapter is READ-ONLY: it never writes execution state and
 * never imports platform internals beyond the port contract types
 * (the module-adapter-bridges-to-platform pattern).
 */
import type { DatabasePort } from "../../../platform/db/port";
import type {
  OrchestrationCandidate,
  OrchestrationWaitKind,
  WaitingExecutionSource,
} from "../../../platform/workflow/port";

/** The authoritative wait statuses this source surfaces (domain vocabulary). */
const WAITING_STATUSES = ["WAITING_TOOL", "WAITING_USER", "WAITING_HUMAN"] as const;

/** The status -> orchestration wait-kind mapping (domain-owned). */
const STATUS_TO_WAIT_KIND: Readonly<
  Record<(typeof WAITING_STATUSES)[number], OrchestrationWaitKind>
> = Object.freeze({
  WAITING_TOOL: "callback",
  WAITING_USER: "callback",
  WAITING_HUMAN: "approval",
});

export interface WaitDeadlinePolicy {
  /**
   * Default wait deadline in milliseconds applied when arming (the
   * deadline elapses through the governed expiration path). Zero or
   * absent = no deadline (the wait resolves only by notification).
   */
  readonly waitTimeoutMs: number;
}

export interface OrchestrationSourceDeps {
  /** The platform DatabasePort (read-only usage in this adapter). */
  readonly db: DatabasePort;
  /** Repository-configured deadline policy (see deploy/manifests). */
  readonly deadlines: WaitDeadlinePolicy;
  readonly now: () => Date;
}

interface WaitingRow {
  readonly id: string;
  readonly application_id: string;
  readonly tenant_id: string;
  readonly status: string;
  readonly updated_at: Date | string;
}

export class SqlOrchestrationSource implements WaitingExecutionSource {
  constructor(private readonly deps: OrchestrationSourceDeps) {}

  async listOrchestrationCandidates(limit: number): Promise<readonly OrchestrationCandidate[]> {
    const result = await this.deps.db.execute<WaitingRow>({
      sql: `SELECT id, application_id, tenant_id, status, updated_at
FROM executions.executions
WHERE status IN ('WAITING_TOOL', 'WAITING_USER', 'WAITING_HUMAN')
ORDER BY updated_at ASC
LIMIT $1`,
      parameters: [limit],
    });
    return result.rows.flatMap((row) => {
      const waitKind = STATUS_TO_WAIT_KIND[row.status as (typeof WAITING_STATUSES)[number]];
      if (waitKind === undefined) {
        return [];
      }
      const enteredWaitAt =
        row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at);
      const deadline =
        this.deps.deadlines.waitTimeoutMs > 0
          ? new Date(
              (this.deps.deadlines.waitTimeoutMs > 0
                ? Date.parse(enteredWaitAt)
                : this.deps.now().getTime()) + this.deps.deadlines.waitTimeoutMs,
            ).toISOString()
          : null;
      return [
        {
          executionId: row.id,
          applicationId: row.application_id,
          tenantId: row.tenant_id,
          waitKind,
          deadline,
          enteredWaitAt,
        },
      ];
    });
  }
}

/** Convenience factory matching the module conventions. */
export function createOrchestrationSource(deps: OrchestrationSourceDeps): WaitingExecutionSource {
  return new SqlOrchestrationSource(deps);
}
