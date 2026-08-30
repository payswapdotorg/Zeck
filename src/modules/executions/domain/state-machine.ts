/**
 * Execution lifecycle state machine (executions module domain; WORK-006).
 *
 * The SINGLE authority for execution status (`IMPLEMENTATION.md` §5:
 * "/executions alone owns the execution state machine"). This module is a
 * pure data structure + functions: the transition table of
 * `spec/contracts.md` ("Core transition commands") is frozen here and every
 * write path consults `nextState` — there is no alternative table, no
 * default-allow edge and no second state machine.
 *
 * Vocabulary (the full table of `spec/contracts.md`): 14 states, 18 command
 * edge classes — 16 state-specific edges plus `cancel` and `expire`, each
 * legal from every non-terminal state (10 sources). Terminal states
 * (COMPLETED, FAILED, CANCELLED, EXPIRED) have NO outgoing edge: they are
 * final, and every mutating retry against them fails
 * `INVALID_STATE_TRANSITION` (durable finality is additionally enforced
 * physically by migration 0004's terminal-immutability trigger).
 */

import { PlatformError } from "../../../shared/errors";

export const EXECUTION_STATES = [
  "CREATED",
  "AUTHORIZED",
  "PLANNING",
  "QUEUED",
  "RUNNING",
  "WAITING_TOOL",
  "WAITING_USER",
  "WAITING_HUMAN",
  "VERIFYING",
  "REPLANNING",
  "COMPLETED",
  "FAILED",
  "CANCELLED",
  "EXPIRED",
] as const;

export type ExecutionStatus = (typeof EXECUTION_STATES)[number];

export const EXECUTION_COMMANDS = [
  "authorize",
  "plan",
  "queue",
  "start",
  "wait-tool",
  "wait-user",
  "wait-human",
  "resume",
  "verify",
  "pass",
  "replan",
  "fail",
  "cancel",
  "expire",
] as const;

export type ExecutionCommand = (typeof EXECUTION_COMMANDS)[number];

/** States with NO outgoing edge — final by contract, immutable by schema. */
export const TERMINAL_STATUSES: readonly ExecutionStatus[] = [
  "COMPLETED",
  "FAILED",
  "CANCELLED",
  "EXPIRED",
];

export function isTerminal(status: ExecutionStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

/** Every non-terminal state — the source set of the `cancel`/`expire` edges. */
export const NON_TERMINAL_STATUSES: readonly ExecutionStatus[] = EXECUTION_STATES.filter(
  (status) => !isTerminal(status),
);

export interface TransitionEdge {
  readonly from: ExecutionStatus;
  readonly command: ExecutionCommand;
  readonly to: ExecutionStatus;
}

/**
 * The frozen transition table. The 16 state-specific edges of
 * `spec/contracts.md` plus the expanded `cancel`/`expire` classes (one entry
 * per non-terminal source state) so the table IS the complete legality
 * relation — nothing is derived by convention.
 */
export const TRANSITION_TABLE: readonly TransitionEdge[] = [
  { from: "CREATED", command: "authorize", to: "AUTHORIZED" },
  { from: "AUTHORIZED", command: "plan", to: "PLANNING" },
  { from: "PLANNING", command: "queue", to: "QUEUED" },
  { from: "QUEUED", command: "start", to: "RUNNING" },
  { from: "RUNNING", command: "wait-tool", to: "WAITING_TOOL" },
  { from: "WAITING_TOOL", command: "resume", to: "RUNNING" },
  { from: "RUNNING", command: "wait-user", to: "WAITING_USER" },
  { from: "WAITING_USER", command: "resume", to: "RUNNING" },
  { from: "RUNNING", command: "wait-human", to: "WAITING_HUMAN" },
  { from: "WAITING_HUMAN", command: "resume", to: "RUNNING" },
  { from: "RUNNING", command: "verify", to: "VERIFYING" },
  { from: "VERIFYING", command: "pass", to: "COMPLETED" },
  { from: "VERIFYING", command: "replan", to: "REPLANNING" },
  { from: "REPLANNING", command: "queue", to: "QUEUED" },
  { from: "RUNNING", command: "fail", to: "FAILED" },
  { from: "VERIFYING", command: "fail", to: "FAILED" },
  ...NON_TERMINAL_STATUSES.map((from) => ({
    from,
    command: "cancel" as const,
    to: "CANCELLED" as const,
  })),
  ...NON_TERMINAL_STATUSES.map((from) => ({
    from,
    command: "expire" as const,
    to: "EXPIRED" as const,
  })),
];

const EDGE_INDEX = new Map<string, ExecutionStatus>(
  TRANSITION_TABLE.map((edge) => [`${edge.from}|${edge.command}`, edge.to]),
);

export function isExecutionStatus(value: unknown): value is ExecutionStatus {
  return typeof value === "string" && (EXECUTION_STATES as readonly string[]).includes(value);
}

export function isExecutionCommand(value: unknown): value is ExecutionCommand {
  return typeof value === "string" && (EXECUTION_COMMANDS as readonly string[]).includes(value);
}

/** Is `command` legal from `from`? Exactly the frozen table, nothing else. */
export function canTransition(from: ExecutionStatus, command: ExecutionCommand): boolean {
  return EDGE_INDEX.has(`${from}|${command}`);
}

/**
 * Resolve the next state for a command, or throw the canonical
 * `INVALID_STATE_TRANSITION`. The ONLY legality oracle of the module —
 * illegal edges, unknown commands and terminal-source commands all fail
 * typed with the attempted (from, command) pair in details.
 */
export function nextState(from: ExecutionStatus, command: ExecutionCommand): ExecutionStatus {
  const to = EDGE_INDEX.get(`${from}|${command}`);
  if (to === undefined) {
    throw new PlatformError({
      code: "INVALID_STATE_TRANSITION",
      message: isTerminal(from)
        ? `execution is terminal in ${from}; no transitions leave a terminal state`
        : `command ${command} is not legal from ${from}`,
      details: { from, command },
    });
  }
  return to;
}
