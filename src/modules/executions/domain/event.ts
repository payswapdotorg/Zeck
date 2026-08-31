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
 *
 * WORK-010 extends the event vocabulary with STEP EVENTS — non-transition
 * envelopes that record governed sub-execution observations (tool
 * invocations) on the SAME single ledger, through the SAME single write
 * path, WITHOUT touching execution status: a step event appends its
 * envelope and advances `last_event_sequence` via the identity-preserving
 * row write (the policy-denied precedent — status stays exactly what it
 * was; only the sequence advances). Step events are append-only evidence
 * bound to the parent execution; they are NOT lifecycle transitions and
 * can never move the state machine (a terminal execution accepts none —
 * physical terminal immutability of the row makes that unrepresentable).
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
  readonly command: EventCommand;
  readonly actor: ExecutionActor;
  readonly cause?: string;
  readonly reference?: Readonly<Record<string, unknown>>;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly occurredAt: string;
}

/**
 * Step-event commands (WORK-010): non-transition observation commands whose
 * envelopes the ledger records for governed sub-execution activity. The
 * vocabulary is OWNED HERE (executions owns the event vocabulary); the
 * tools runtime is the first producer, agents (WORK-011) extend it through
 * the same `recordStepEvent` seam.
 */
export const STEP_EVENT_COMMANDS = [
  "tool-requested",
  "tool-result",
  "tool-denied",
  // WORK-011 (agents) — agent session evidence commands. Additive
  // vocabulary extension: agent session start (inputs + authorization
  // context), significant agent actions, and session completion
  // (outputs) ride the SAME ledger through the SAME recordStepEvent
  // seam; the agents module produces these events but owns none of the
  // vocabulary (this module remains the single event-vocabulary
  // authority).
  "agent-session-started",
  "agent-action-recorded",
  "agent-session-completed",
  // WORK-013 (verification) — verification evidence commands. Additive
  // vocabulary extension: the verification authority's durable evidence
  // (evaluation intents, recorded results/conclusions, mediated human
  // evaluation requests/decisions, candidate comparisons) rides the SAME
  // ledger through the SAME recordStepEvent seam; the verification
  // module produces these events but owns none of the vocabulary (this
  // module remains the single event-vocabulary authority, and the
  // execution lifecycle itself stays untouched — these are
  // status-preserving observations, never transitions).
  "verification-requested",
  "verification-recorded",
  "human-evaluation-requested",
  "human-decision-recorded",
  "comparison-recorded",
] as const;
export type StepEventCommand = (typeof STEP_EVENT_COMMANDS)[number];

/** Every command that may produce a ledger envelope (transition + step). */
export type EventCommand = ExecutionCommand | "create" | StepEventCommand;

export function isStepEventCommand(value: string): value is StepEventCommand {
  return (STEP_EVENT_COMMANDS as readonly string[]).includes(value);
}

/** Event type vocabulary (creation + one type per transition command). */
export function eventTypeFor(command: EventCommand): string {
  if (command === "create") {
    return "execution.created";
  }
  return `execution.${command}`;
}

/**
 * Event type of the DURABLE policy-admission denial record (WORK-007): a
 * denied `authorize` transition journals its denial evidence on this ledger
 * (journal-then-fail, the WORK-003 dispatch-journal precedent) WITHOUT
 * leaving CREATED — the row's status write is the identity-preserving
 * sequence advance through the same single write path. Denial evidence is
 * append-only like every envelope.
 */
export const POLICY_DENIED_EVENT_TYPE = "execution.policy-denied";

/**
 * Event type of the DURABLE planning decision record (WORK-009): the
 * deterministic-first planner's decision (selected plan, candidate
 * strategies, route rationale, deterministic-sufficiency decision, policy
 * inputs, subgraph evidence) is appended by `recordPlanningDecision` while
 * the execution is in a planning phase (PLANNING/REPLANNING) — the same
 * single write path, the same gapless sequencing, the same idempotency
 * arbitration. The status write is the identity-preserving sequence
 * advance (the policy-denied precedent). The planning module owns decision
 * semantics; this ledger owns durability.
 */
export const PLANNING_DECISION_EVENT_TYPE = "planning.decision-recorded";
