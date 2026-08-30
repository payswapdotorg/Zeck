/**
 * Public contract barrel of the `executions` module.
 *
 * This file is the ONLY supported import surface for other modules and for
 * the API layer (`IMPLEMENTATION.md` §2, `spec/contracts.md` "Public
 * module rule"). Everything else under `src/modules/executions/` is private
 * to this module.
 *
 * WORK-006 introduces the execution identity, lifecycle and event core:
 * the `Execution` primary abstraction (`spec/architecture.md` §2.1), its
 * frozen state machine (`spec/contracts.md` transition table — the single
 * write path), the append-only ordered `EventEnvelope` ledger with
 * per-execution gapless sequences, durable verification-result records and
 * the completion binding, and request-idempotent creation
 * (`createExecution(input, idempotencyKey, actor)` — provider selection is
 * forbidden in the public create contract; the provider fabric underneath
 * is the models/connections fabric from WORK-003, never named here).
 *
 * Authority seams (consulted, never bypassed, never reimplemented):
 *  - policy admission: `ExecutionAuthorizationPort` (REQUIRED at service
 *    construction — no default-allow exists; the engine is WORK-007);
 *  - budget reservation at dispatch: the WORK-004 `BudgetAuthority`
 *    (`src/modules/budgets/public.ts`) passed as an optional service dep.
 */

import type { ModuleDescriptor } from "../../shared/module";
import type {
  AppliedTransition,
  ExecutionService,
  ExecutionTransitionCommand,
  TransitionOutcome,
} from "./application/execution-service";
import { createExecutionService } from "./application/execution-service";
import type { AppendEventInput, EventEnvelope } from "./domain/event";
import { eventTypeFor } from "./domain/event";
import type {
  ExecutionActor,
  ExecutionConstraints,
  ExecutionCreateInput,
  ExecutionReceipt,
  ExecutionRecord,
} from "./domain/execution";
import { CREATE_INPUT_KEYS, FORBIDDEN_INPUT_KEYS } from "./domain/execution";
import type { ExecutionCommand, ExecutionStatus, TransitionEdge } from "./domain/state-machine";
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
} from "./domain/state-machine";
import type {
  VerificationResultInput,
  VerificationResultRecord,
  VerificationResultStatus,
} from "./domain/verification";
import type { ExecutionAuthorizationPort } from "./ports/authorization";
import type { ExecutionsIdempotencyPort } from "./ports/execution-idempotency";
import type { ExecutionStore } from "./ports/execution-store";

export const moduleDescriptor: ModuleDescriptor = { id: "executions" };

// Application services + commands/outcomes.
// Domain: execution identity + create contract (provider-selection-free).
// Domain: the frozen state machine (single legality oracle).
// Domain: EventEnvelope ledger + durable verification results.
// Module ports (provider-neutral; implemented by adapters).
export type {
  AppendEventInput,
  AppliedTransition,
  EventEnvelope,
  ExecutionActor,
  ExecutionAuthorizationPort,
  ExecutionCommand,
  ExecutionConstraints,
  ExecutionCreateInput,
  ExecutionReceipt,
  ExecutionRecord,
  ExecutionService,
  ExecutionStatus,
  ExecutionStore,
  ExecutionsIdempotencyPort,
  ExecutionTransitionCommand,
  TransitionEdge,
  TransitionOutcome,
  VerificationResultInput,
  VerificationResultRecord,
  VerificationResultStatus,
};
export {
  CREATE_INPUT_KEYS,
  canTransition,
  createExecutionService,
  EXECUTION_COMMANDS,
  EXECUTION_STATES,
  eventTypeFor,
  FORBIDDEN_INPUT_KEYS,
  isExecutionCommand,
  isExecutionStatus,
  isTerminal,
  NON_TERMINAL_STATUSES,
  nextState,
  TERMINAL_STATUSES,
  TRANSITION_TABLE,
};
