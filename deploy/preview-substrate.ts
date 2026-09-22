/**
 * deploy/preview-substrate — PPR-008: the deterministic sandbox substrate.
 *
 * WHAT THIS IS (the honest label, stated everywhere it produces a record):
 * a repository-resident DETERMINISTIC drive that takes a created sandbox
 * execution to an honest terminal receipt on the MATERIALIZED preview
 * plane. There is NO MODEL behind it — no model credentials are bound on the
 * preview (the economics and codebase-analysis seams stay honestly unbound)
 * — and it never masquerades as a model-backed run: every durable record it
 * produces carries the origin label `preview-deterministic-substrate`, the
 * ledger envelopes carry it as their provenance cause, the verification
 * result names it as its strategy and recorder, the execution's metadata
 * carries the `substrateOrigin` fact, and the zero-cost/zero-usage facts
 * are recorded as durable ledger payload facts.
 *
 * WHAT IT IS NOT: it is not an execution runtime, not a planner, not a
 * verification authority and not a second state machine. It owns NO
 * durability — every write goes through the execution service's OWN single
 * write path (the state machine's frozen legality rules, the idempotency
 * arbitration, the append-only gapless event ledger; NO bypass, NO direct
 * table writes). The "plan" it records is the truthful statement that the
 * deterministic strategy was selected with zero model calls and no provider
 * route; the output it records is a fixed deterministic function of the task
 * record (a summary-shaped fixture that says plainly what it is).
 *
 * THE HOOK POINT (the work order's design choice, documented with its
 * trade-offs in deploy/evidence/ppr-008.json): an INLINE POST-CREATE DRIVE
 * in the composition — this wrapper decorates the REAL execution service and
 * drives the execution to terminal inside the creating request, then returns
 * the CURRENT durable receipt (the create response is already the terminal
 * receipt). Trade-offs: (+) no background scheduler, queue or worker exists
 * on a serverless isolate — the inline drive is the only composition-owned
 * seam that needs none; (+) the drive's operations carry DETERMINISTIC
 * idempotency keys (`substrate:<executionId>:<step>`), so replays and
 * CONCURRENT drives of the same execution converge on the same durable
 * outcome (arbitration replays the winner's work); (+) the drive is
 * status-driven and resumable — a retry at any non-terminal state walks the
 * REMAINING legal edges only; (−) the creating request absorbs the drive's
 * round trips (bounded: the preview plane's executions are exactly the
 * sandbox executions — there is no other runtime behind this plane, stated
 * plainly in deploy/PUBLIC-DEPLOYMENT.md); (−) the drive refuses states it
 * cannot legally walk (WAITING_* — unreachable on this plane, where nothing
 * else drives executions) with the canonical INVALID_STATE_TRANSITION.
 *
 * ENGAGEMENT BOUNDARY: the wrapper is installed ONLY by the materialized
 * preview composition (deploy/api.ts binds it when the authority set
 * materializes); the unbound local/dev shapes never see it.
 */

import type { ExecutionService } from "../src/modules/executions/public";
import { PlatformError } from "../src/shared/errors";
import { deterministicPreviewUuid } from "./preview-authorities";

/** The honest origin label every substrate-produced record carries. */
export const SUBSTRATE_ORIGIN = "preview-deterministic-substrate";

/** The metadata key the substrate merges into created executions (caller keys are preserved). */
export const SUBSTRATE_METADATA_KEY = "substrateOrigin";

export interface DeterministicSubstrateDeps {
  /** The REAL execution service (the only write path the substrate uses). */
  readonly inner: ExecutionService;
  /** The substrate worker principal (the drive's provenance actor). */
  readonly actor: { readonly actorId: string; readonly tenantId: string };
  readonly generateId: () => string;
  readonly now: () => Date;
}

/** Deterministic per-execution idempotency key of one substrate step. */
function substrateKey(executionId: string, step: string): string {
  return `substrate:${executionId}:${step}`;
}

/** The deterministic planning-decision record (the /results route's route summary reads this shape). */
function planningDecisionPayloadOf(
  task: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  return {
    selectedStrategyId: SUBSTRATE_ORIGIN,
    candidates: [
      {
        strategyId: SUBSTRATE_ORIGIN,
        plan: {
          steps: [] as readonly unknown[],
          strategyClass: "deterministic-only",
          modelCalls: 0,
        },
        rationale:
          "the preview deterministic substrate was selected: no model credentials are bound on this plane, so the deterministic strategy executes the task with zero model calls and no provider route",
      },
    ],
    origin: SUBSTRATE_ORIGIN,
    deterministic: true,
    modelBacked: false,
    taskKind: typeof task.kind === "string" ? task.kind : null,
  };
}

/** The deterministic output fixture of a task (a fixed function of the task record — never a model output). */
export function deterministicOutputOf(
  task: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const kind = typeof task.kind === "string" ? task.kind : "unknown";
  if (kind === "summarize") {
    const source =
      typeof task.doc === "string"
        ? task.doc
        : typeof task.input === "string"
          ? task.input
          : "an unspecified source document";
    const maxWords = typeof task.maxWords === "number" ? task.maxWords : null;
    const summary =
      `Deterministic preview summary of ${source}: this output was produced by the ` +
      `repository-resident deterministic substrate (${SUBSTRATE_ORIGIN}); no model was involved. ` +
      `On a credentialed plane this task would execute the governed provider route instead.`;
    return {
      kind: "summarize",
      summary,
      words: summary.split(/\s+/).length,
      ...(maxWords === null ? {} : { maxWords }),
      origin: SUBSTRATE_ORIGIN,
      modelBacked: false,
    };
  }
  return {
    kind,
    note: `deterministic substrate output (origin: ${SUBSTRATE_ORIGIN}; no model was involved)`,
    origin: SUBSTRATE_ORIGIN,
    modelBacked: false,
  };
}

/** The immutable runtime-metadata snapshot of the substrate admission. */
function admissionPayloadOf(task: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return {
    origin: SUBSTRATE_ORIGIN,
    runtime: "deterministic",
    deterministic: true,
    modelBacked: false,
    taskKind: typeof task.kind === "string" ? task.kind : null,
    substrateVersion: 1,
  };
}

/** The completion facts: the deterministic output + the truthful zero-cost/zero-usage record. */
function completionPayloadOf(task: Readonly<Record<string, unknown>>): Record<string, unknown> {
  return {
    origin: SUBSTRATE_ORIGIN,
    output: deterministicOutputOf(task),
    costMicroUsd: "0",
    usage: { inputTokens: 0, outputTokens: 0 },
    modelBacked: false,
  };
}

interface DriveArgs {
  readonly applicationId: string;
  readonly executionId: string;
  readonly tenantId: string;
}

/**
 * Drive one execution to an honest terminal state THROUGH the inner
 * service's own state machine: CREATED → authorize → AUTHORIZED → plan →
 * PLANNING → (the deterministic planning decision) → queue → QUEUED →
 * start → RUNNING → (the substrate's sandbox-admitted / sandbox-completed
 * step events) → verify → VERIFYING → pass (with the substrate's PASS
 * verification result) → COMPLETED. Status-driven and resumable: a
 * non-terminal execution resumes at its CURRENT state's remaining legal
 * edge; a terminal execution is returned untouched (terminal finality).
 */
async function driveToTerminal(deps: DeterministicSubstrateDeps, args: DriveArgs): Promise<void> {
  const { inner, actor } = deps;
  const { applicationId, executionId, tenantId } = args;
  for (;;) {
    const row = await inner.getExecution(applicationId, executionId);
    if (row === null) {
      throw new PlatformError({
        code: "PROVIDER_ERROR",
        message: "the substrate drive lost the execution row (rows are never deleted)",
      });
    }
    const scope = {
      applicationId,
      executionId,
      tenantId,
      actorId: actor.actorId,
    };
    switch (row.status) {
      case "CREATED": {
        await inner.transition(
          { ...scope, command: "authorize", reason: SUBSTRATE_ORIGIN },
          substrateKey(executionId, "authorize"),
        );
        continue;
      }
      case "AUTHORIZED": {
        await inner.transition(
          { ...scope, command: "plan", reason: SUBSTRATE_ORIGIN },
          substrateKey(executionId, "plan"),
        );
        continue;
      }
      case "PLANNING": {
        // The truthful plan selection: deterministic-only, zero model calls.
        await inner.recordPlanningDecision(
          {
            applicationId,
            executionId,
            tenantId,
            actorId: actor.actorId,
            decisionId: deterministicPreviewUuid("substrate-decision", executionId),
            planId: deterministicPreviewUuid("substrate-plan", executionId),
            payload: planningDecisionPayloadOf(row.task),
          },
          substrateKey(executionId, "plan-decision"),
        );
        await inner.transition(
          { ...scope, command: "queue", reason: SUBSTRATE_ORIGIN },
          substrateKey(executionId, "queue"),
        );
        continue;
      }
      case "QUEUED": {
        await inner.transition(
          { ...scope, command: "start", reason: SUBSTRATE_ORIGIN },
          substrateKey(executionId, "start"),
        );
        continue;
      }
      case "RUNNING": {
        // The substrate's own sandbox evidence on the SAME ledger the
        // lifecycle uses (recordStepEvent — the single write path; status
        // unchanged, sequence advances).
        await inner.recordStepEvent(
          {
            executionId,
            applicationId,
            actor,
            command: "sandbox-admitted",
            cause: SUBSTRATE_ORIGIN,
            reference: { origin: SUBSTRATE_ORIGIN, runtime: "deterministic", modelBacked: false },
            payload: admissionPayloadOf(row.task),
          },
          substrateKey(executionId, "sandbox-admitted"),
        );
        const completed = await inner.recordStepEvent(
          {
            executionId,
            applicationId,
            actor,
            command: "sandbox-completed",
            cause: SUBSTRATE_ORIGIN,
            reference: {
              origin: SUBSTRATE_ORIGIN,
              costMicroUsd: "0",
              usage: { inputTokens: 0, outputTokens: 0 },
            },
            payload: completionPayloadOf(row.task),
          },
          substrateKey(executionId, "sandbox-completed"),
        );
        await inner.transition(
          { ...scope, command: "verify", reason: SUBSTRATE_ORIGIN },
          substrateKey(executionId, "verify"),
        );
        void completed;
        continue;
      }
      case "VERIFYING": {
        // The honest verification outcome: the criterion is exactly what the
        // substrate can truthfully attest — its deterministic output was
        // recorded on the ledger — recorded by the substrate itself.
        await inner.transition(
          {
            ...scope,
            command: "pass",
            reason: SUBSTRATE_ORIGIN,
            verificationResults: [
              {
                criterionId: "deterministic-output-recorded",
                strategy: SUBSTRATE_ORIGIN,
                status: "PASS" as const,
                recordedBy: SUBSTRATE_ORIGIN,
                evidence: [`ledger:sandbox-completed:${executionId}`],
              },
            ],
          },
          substrateKey(executionId, "pass"),
        );
        continue;
      }
      case "COMPLETED":
      case "FAILED":
      case "CANCELLED":
      case "EXPIRED": {
        // Terminal finality: the drive converges and touches nothing.
        return;
      }
      default: {
        // WAITING_TOOL / WAITING_USER / WAITING_HUMAN / REPLANNING: the
        // substrate has no legal edge from these states — refuse honestly.
        throw new PlatformError({
          code: "INVALID_STATE_TRANSITION",
          message: `the deterministic substrate cannot drive an execution in ${row.status} (no waiting or replanning state is reachable on the materialized preview plane; the drive only walks the deterministic path)`,
          details: { executionId, status: row.status },
        });
      }
    }
  }
}

/**
 * The deterministic-substrate execution seam: the REAL service decorated
 * with the inline post-create drive. `createExecution` merges the honest
 * `substrateOrigin` metadata fact (the caller's own metadata keys are
 * preserved), delegates to the real service's idempotent create, drives the
 * created execution to terminal through the real service's own state
 * machine (only within the substrate worker's own tenant scope), and
 * returns the CURRENT durable receipt — the create response IS the honest
 * terminal receipt. Every other method delegates unchanged.
 */
export function createDeterministicSubstrateExecutions(
  deps: DeterministicSubstrateDeps,
): ExecutionService {
  const { inner } = deps;
  return {
    async createExecution(input, idempotencyKey, actor) {
      const labeled = {
        ...input,
        metadata: {
          ...(input.metadata ?? {}),
          [SUBSTRATE_METADATA_KEY]: SUBSTRATE_ORIGIN,
        },
      };
      const receipt = await inner.createExecution(labeled, idempotencyKey, actor);
      if (receipt.tenantId === deps.actor.tenantId) {
        await driveToTerminal(deps, {
          applicationId: input.applicationId,
          executionId: receipt.executionId,
          tenantId: receipt.tenantId,
        });
      }
      // Re-read the CURRENT durable row: the receipt reflects the terminal
      // state the drive just committed (or the replayed durable outcome).
      const row = await inner.getExecution(input.applicationId, receipt.executionId);
      if (row === null) {
        throw new PlatformError({
          code: "PROVIDER_ERROR",
          message: "the substrate drive lost the execution row (rows are never deleted)",
        });
      }
      return {
        executionId: row.id,
        applicationId: row.applicationId,
        tenantId: row.tenantId,
        environmentId: row.environmentId,
        status: row.status,
        lastEventSequence: row.lastEventSequence,
        verificationRefs: row.verificationRefs,
        createdAt: row.createdAt,
        terminalAt: row.terminalAt,
        replayed: receipt.replayed,
      };
    },
    async transition(command, idempotencyKey) {
      return inner.transition(command, idempotencyKey);
    },
    async recordPlanningDecision(input, idempotencyKey) {
      return inner.recordPlanningDecision(input, idempotencyKey);
    },
    async recordStepEvent(input, idempotencyKey) {
      return inner.recordStepEvent(input, idempotencyKey);
    },
    async getExecution(applicationId, executionId) {
      return inner.getExecution(applicationId, executionId);
    },
    async listEvents(applicationId, executionId) {
      return inner.listEvents(applicationId, executionId);
    },
    async listVerificationResults(applicationId, executionId) {
      return inner.listVerificationResults(applicationId, executionId);
    },
  };
}
