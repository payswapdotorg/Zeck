/**
 * Queue/workflow replay planning after transport or orchestration
 * loss (platform recovery plane; WORK-048 / D-07, acceptance
 * criterion 3: "Queue/workflow messages can be replayed after
 * transport/orchestration loss without duplicating durable
 * authoritative effects").
 *
 * THE MODEL (authority unchanged, D1.0 §10 / D-04):
 *
 *   - Queue messages are POINTERS; the durable dispatch envelope in
 *     PostgreSQL (`queue_transport.dispatch_envelopes`) is the
 *     intent record. A transport provider that loses every message
 *     loses NO authority — the envelopes say what must flow.
 *   - Workflow instances are provider mechanisms; the durable wait
 *     records (`workflow_orchestration.waits`) plus the executions
 *     authority say which executions are WAITING and why. An
 *     orchestration provider that loses its instances loses no
 *     authority — the arm/recovery scans re-arm from PostgreSQL.
 *
 * THIS MODULE is the bounded RECOVERY PLANNER: it reads the durable
 * transport/orchestration state and classifies exactly what the
 * recovery procedure must do (fail-closed classification — every
 * state has an explicit recovery class; unknown states are errors,
 * never guesses). The EXECUTION of the plan composes the existing
 * governed machinery (dispatcher republish/replay, fabric recovery
 * re-drive, coordinator arm/recovery) — no new execution authority
 * is created here, and replay convergence rides the EXISTING
 * dispatch/execution idempotency (deterministic correlation keys,
 * the single execution write path), never provider-side dedup.
 */

import type { DatabasePort } from "../db/port";
import { type DispatchEnvelope, isDispatchEnvelopeState } from "../queue/port";

/** Fail-closed transport-recovery planning error. */
export class TransportRecoveryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TransportRecoveryError";
  }
}

/** The recovery classes for dispatch envelopes after transport loss. */
export type EnvelopeRecoveryClass =
  | "republish"
  /** Delivered-but-unsettled: transport lost; re-drive from authority. */
  | "re-drive"
  /** Terminal: nothing to recover. */
  | "converged"
  /** Bounded failure: the dead-letter/replay budget path (operator). */
  | "dead-lettered";

export interface EnvelopeRecoveryItem {
  readonly envelopeId: string;
  readonly correlationKey: string;
  readonly executionId: string;
  readonly state: DispatchEnvelope["state"];
  readonly recoveryClass: EnvelopeRecoveryClass;
  readonly appliedAt: string | null;
}

export interface TransportRecoveryPlan {
  readonly items: readonly EnvelopeRecoveryItem[];
  readonly byClass: Readonly<Record<EnvelopeRecoveryClass, number>>;
  /** True when the plan is complete (every envelope classified). */
  readonly planned: boolean;
}

/**
 * Plan the queue recovery after transport loss: classify EVERY
 * dispatch envelope by its durable state.
 *
 *   recorded            → republish  (publication never accepted)
 *   backlogged          → republish  (publish budget exhausted during
 *                                      the outage; bounded retry)
 *   published           → re-drive   (the message may be LOST in the
 *                                      provider; the governed effect
 *                                      may not have been applied —
 *                                      the executions authority
 *                                      re-drive converges it WITHOUT
 *                                      the queue: fresh claim, fresh
 *                                      lease epoch, idempotent start)
 *   consumed            → converged  (the transport finished carrying
 *                                      the dispatch; nothing to do)
 *   dead-lettered       → dead-lettered (the bounded replay path)
 */
export async function planTransportRecovery(
  db: DatabasePort,
  limit = 1000,
): Promise<TransportRecoveryPlan> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 10_000) {
    throw new TransportRecoveryError("limit must be an integer in [1, 10000]");
  }
  const result = await db.execute<{
    readonly id: string;
    readonly correlation_key: string;
    readonly execution_id: string;
    readonly state: string;
    readonly applied_at: string | null;
  }>({
    sql: `SELECT id, correlation_key, execution_id, state, applied_at
          FROM queue_transport.dispatch_envelopes
          ORDER BY created_at, id
          LIMIT $1`,
    parameters: [limit],
  });
  const items: EnvelopeRecoveryItem[] = [];
  for (const row of result.rows) {
    if (!isDispatchEnvelopeState(row.state)) {
      // A state outside the closed vocabulary is corruption, not a
      // recovery decision — fail closed.
      throw new TransportRecoveryError(
        `dispatch envelope ${row.id} has unknown state "${row.state}" (outside the transport vocabulary)`,
      );
    }
    let recoveryClass: EnvelopeRecoveryClass;
    switch (row.state) {
      case "recorded":
      case "backlogged":
        recoveryClass = "republish";
        break;
      case "published":
        recoveryClass = row.applied_at === null ? "re-drive" : "converged";
        break;
      case "consumed":
        recoveryClass = "converged";
        break;
      case "dead-lettered":
        recoveryClass = "dead-lettered";
        break;
    }
    items.push({
      envelopeId: row.id,
      correlationKey: row.correlation_key,
      executionId: row.execution_id,
      state: row.state,
      recoveryClass,
      appliedAt: row.applied_at,
    });
  }
  const byClass: Record<EnvelopeRecoveryClass, number> = {
    republish: 0,
    "re-drive": 0,
    converged: 0,
    "dead-lettered": 0,
  };
  for (const item of items) {
    byClass[item.recoveryClass] += 1;
  }
  return {
    items: Object.freeze([...items]),
    byClass: Object.freeze({ ...byClass }),
    planned: result.rows.length < limit,
  };
}

/** The orchestration-loss recovery plan (the durable wait scan). */
export interface OrchestrationRecoveryPlan {
  /** Waits whose provider instance may be gone (non-terminal). */
  readonly liveWaits: number;
  /** Waits in `recorded`/`deferred` (never started or outage-exhausted). */
  readonly startableWaits: number;
  /** Waits in `signaled` (effect possibly unapplied — recovery applies). */
  readonly signaledWaits: number;
  /** Terminal waits (converged). */
  readonly terminalWaits: number;
  /** The execution ids with at least one non-terminal wait. */
  readonly waitingExecutions: readonly string[];
  /** True when the scan is complete. */
  readonly planned: boolean;
}

const WAIT_STATES_TERMINAL = new Set(["settled", "elapsed", "superseded", "abandoned"]);
const WAIT_STATES_STARTABLE = new Set(["recorded", "deferred"]);

/**
 * Plan the workflow/orchestration recovery after orchestration-loss:
 * scan the durable wait records (NOT the provider) and classify what
 * the coordinator recovery must do. The existing arm/recovery scans
 * execute the plan — this is the bounded, auditable classification
 * evidence for the drill.
 */
export async function planOrchestrationRecovery(
  db: DatabasePort,
  limit = 1000,
): Promise<OrchestrationRecoveryPlan> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 10_000) {
    throw new TransportRecoveryError("limit must be an integer in [1, 10000]");
  }
  const result = await db.execute<{
    readonly execution_id: string;
    readonly state: string;
  }>({
    sql: `SELECT execution_id, state
          FROM workflow_orchestration.waits
          ORDER BY created_at, id
          LIMIT $1`,
    parameters: [limit],
  });
  let liveWaits = 0;
  let startableWaits = 0;
  let signaledWaits = 0;
  let terminalWaits = 0;
  const waitingExecutions = new Set<string>();
  for (const row of result.rows) {
    if (WAIT_STATES_TERMINAL.has(row.state)) {
      terminalWaits += 1;
      continue;
    }
    liveWaits += 1;
    waitingExecutions.add(row.execution_id);
    if (WAIT_STATES_STARTABLE.has(row.state)) {
      startableWaits += 1;
    } else if (row.state === "signaled") {
      signaledWaits += 1;
    }
  }
  return Object.freeze({
    liveWaits,
    startableWaits,
    signaledWaits,
    terminalWaits,
    waitingExecutions: Object.freeze([...waitingExecutions]),
    planned: result.rows.length < limit,
  });
}
