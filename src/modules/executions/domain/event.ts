/**
 * EventEnvelope ledger types (executions module domain; WORK-006).
 *
 * Every persisted execution event contains at least the fields of
 * `IMPLEMENTATION.md` §4 (eventId, executionId, applicationId, type,
 * sequence, occurredAt, producerModule, schemaVersion, payload) and — for
 * the EXECUTION-PROVENANCE contract — the durable provenance chain
 * (who/what/why): the transition `command` (what), the `actor` (who), the
 * `cause` (why: free-text reason class) and the `reference` (what durable
 * facts the transition is bound to: verification result ids, budget
 * reservation id, artifact references).
 *
 * The ledger is APPEND-ONLY (physically enforced by migration 0004) and the
 * per-execution `sequence` is GAPLESS: sequence 1 is the creation envelope
 * and every committed transition takes max(sequence) + 1 inside the
 * transaction that updates the execution row (row lock + unique index +
 * gapless trigger). Gapless (rather than merely strictly-monotonic) is a
 * deliberate design decision: the ledger is the authoritative ordered
 * history — every sequence number denotes exactly one committed envelope,
 * so consumers never have to distinguish a missing event from an
 * in-flight one, and physical triggers can reject gaps outright.
 */

import type { ExecutionActor } from "./execution";
import type { ExecutionCommand } from "./state-machine";

export interface EventEnvelope {
  readonly eventId: string;
  readonly executionId: string;
  readonly applicationId: string;
  readonly tenantId: string;
  readonly sequence: number;
  readonly type: string;
  readonly command: string;
  readonly actor: Readonly<Record<string, unknown>>;
  readonly cause: string | null;
  readonly reference: Readonly<Record<string, unknown>>;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly occurredAt: string;
  readonly producerModule: string;
  readonly schemaVersion: number;
}

/** Input shape for appending one envelope (the port carries provenance). */
export interface AppendEventInput {
  readonly eventId: string;
  readonly executionId: string;
  readonly applicationId: string;
  readonly tenantId: string;
  readonly sequence: number;
  readonly type: string;
  readonly command: ExecutionCommand | "create";
  readonly actor: ExecutionActor;
  readonly cause?: string;
  readonly reference?: Readonly<Record<string, unknown>>;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly occurredAt: string;
}

/** Event type vocabulary (creation + one type per transition command). */
export function eventTypeFor(command: ExecutionCommand | "create"): string {
  if (command === "create") {
    return "execution.created";
  }
  return `execution.${command}`;
}
