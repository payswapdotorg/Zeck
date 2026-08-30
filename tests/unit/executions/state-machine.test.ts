/**
 * Unit: execution state machine completeness (WORK-006 acceptance
 * criterion 2; checkpoints IMPLEMENTATION-COMPLETENESS and
 * EXECUTION-PROVENANCE — the frozen legality oracle).
 *
 * Proves the domain table IS the complete transition table of
 * `spec/contracts.md`: every legal edge resolves, every illegal
 * (state, command) pair is rejected with the canonical
 * `INVALID_STATE_TRANSITION`, terminal states accept NO command (final),
 * and the vocabulary is exactly the frozen one (14 states, 18 command
 * edge classes = 16 specific edges + cancel/expire from all 10
 * non-terminal sources = 36 concrete edges).
 */

import { describe, expect, test } from "vitest";
import {
  canTransition,
  EXECUTION_COMMANDS,
  EXECUTION_STATES,
  isExecutionCommand,
  isExecutionStatus,
  isTerminal,
  NON_TERMINAL_STATUSES,
  nextState,
  TERMINAL_STATUSES,
  TRANSITION_TABLE,
} from "../../../src/modules/executions/domain/state-machine";
import { PlatformError } from "../../../src/shared/errors";

/** The legal edges as a (from, command) set — derived ONLY from the table. */
const LEGAL = new Set(TRANSITION_TABLE.map((edge) => `${edge.from}|${edge.command}`));

async function expectInvalidState(from: string, command: string): Promise<PlatformError> {
  try {
    nextState(from as never, command as never);
  } catch (error) {
    const platformError = error as PlatformError;
    expect(platformError).toBeInstanceOf(PlatformError);
    expect(platformError.code).toBe("INVALID_STATE_TRANSITION");
    expect(platformError.details).toEqual({ from, command });
    return platformError;
  }
  throw new Error(`expected (${from}, ${command}) to be rejected as illegal`);
}

describe("unit: execution state machine (frozen transition table)", () => {
  test("vocabulary is exactly the frozen one: 14 states, 14 commands, 4 terminal, 10 non-terminal", () => {
    expect(EXECUTION_STATES).toHaveLength(14);
    expect(EXECUTION_COMMANDS).toHaveLength(14);
    expect(TERMINAL_STATUSES).toEqual(["COMPLETED", "FAILED", "CANCELLED", "EXPIRED"]);
    expect(NON_TERMINAL_STATUSES).toHaveLength(10);
    expect(new Set(NON_TERMINAL_STATUSES).has("COMPLETED")).toBe(false);
    for (const status of EXECUTION_STATES) {
      expect(isTerminal(status)).toBe(TERMINAL_STATUSES.includes(status));
    }
  });

  test("the table carries exactly the 18 command edge classes (36 concrete edges)", () => {
    // 16 state-specific edges...
    const specific = TRANSITION_TABLE.filter(
      (edge) => edge.command !== "cancel" && edge.command !== "expire",
    );
    expect(specific).toHaveLength(16);
    // ...plus cancel from every non-terminal state and expire from every
    // non-terminal state (10 each) — 18 classes, 36 entries total.
    expect(TRANSITION_TABLE.filter((edge) => edge.command === "cancel")).toHaveLength(10);
    expect(TRANSITION_TABLE.filter((edge) => edge.command === "expire")).toHaveLength(10);
    expect(TRANSITION_TABLE).toHaveLength(36);
  });

  test("every legal edge of spec/contracts.md resolves to exactly the mandated next state", () => {
    const mandated: Array<[string, string, string]> = [
      ["CREATED", "authorize", "AUTHORIZED"],
      ["AUTHORIZED", "plan", "PLANNING"],
      ["PLANNING", "queue", "QUEUED"],
      ["QUEUED", "start", "RUNNING"],
      ["RUNNING", "wait-tool", "WAITING_TOOL"],
      ["WAITING_TOOL", "resume", "RUNNING"],
      ["RUNNING", "wait-user", "WAITING_USER"],
      ["WAITING_USER", "resume", "RUNNING"],
      ["RUNNING", "wait-human", "WAITING_HUMAN"],
      ["WAITING_HUMAN", "resume", "RUNNING"],
      ["RUNNING", "verify", "VERIFYING"],
      ["VERIFYING", "pass", "COMPLETED"],
      ["VERIFYING", "replan", "REPLANNING"],
      ["REPLANNING", "queue", "QUEUED"],
      ["RUNNING", "fail", "FAILED"],
      ["VERIFYING", "fail", "FAILED"],
    ];
    for (const [from, command, to] of mandated) {
      expect(nextState(from as never, command as never)).toBe(to);
      expect(canTransition(from as never, command as never)).toBe(true);
    }
    for (const from of NON_TERMINAL_STATUSES) {
      expect(nextState(from, "cancel")).toBe("CANCELLED");
      expect(nextState(from, "expire")).toBe("EXPIRED");
    }
  });

  test("EVERY illegal (state, command) pair is rejected — full 14x14 exhaustive sweep", async () => {
    for (const from of EXECUTION_STATES) {
      for (const command of EXECUTION_COMMANDS) {
        const key = `${from}|${command}`;
        if (LEGAL.has(key)) {
          expect(canTransition(from, command)).toBe(true);
        } else {
          expect(canTransition(from, command)).toBe(false);
          await expectInvalidState(from, command);
        }
      }
    }
  });

  test("terminal states accept NO command (finality; no resurrection/branching)", async () => {
    for (const terminal of TERMINAL_STATUSES) {
      for (const command of EXECUTION_COMMANDS) {
        expect(canTransition(terminal, command)).toBe(false);
        const error = await expectInvalidState(terminal, command);
        expect(error.message).toContain("terminal");
      }
    }
  });

  test("unknown states/commands fail the vocabulary guards", () => {
    expect(isExecutionStatus("RUNNING")).toBe(true);
    expect(isExecutionStatus("PAUSED")).toBe(false);
    expect(isExecutionCommand("authorize")).toBe(true);
    expect(isExecutionCommand("pause")).toBe(false);
  });
});
