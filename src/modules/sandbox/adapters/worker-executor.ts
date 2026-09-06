/**
 * Worker-fabric work executor (sandbox module adapter; WORK-046 / D-05)
 * — the `ExecutionWorkExecutor` seam implementation.
 *
 * Resolves and executes the admitted work of one execution through the
 * owning module's FULL authority chain — the sandbox service's
 * admission (policy → capability → budget, fail-closed) and the
 * provider registry. The worker fabric has NO admission powers of its
 * own: this adapter is where policy-before-dispatch, capability-before-
 * provider and budget-before-billable-work happen for worker-executed
 * compute.
 *
 * THE TASK CONTRACT (the execution's declared task): worker-executable
 * work carries a `sandbox` block —
 *
 * ```json
 * {
 *   "sandbox": {
 *     "environmentId": "<compute-environment uuid>",
 *     "command": "python3",
 *     "args": ["analyze.py", "--mode", "batch"],
 *     "publicEnv": { "MODE": "batch" }
 *   }
 * }
 * ```
 *
 * Everything else is `not-executable` by this executor (other
 * participants own those kinds; the fabric reports the honest
 * not-executable refusal — never a silent drop, never a second
 * authority).
 *
 * CONVERGENCE (the deterministic sandbox key): the key is
 * `worker-exec:<executionId>` — sandbox execution identity is
 * idempotent per execution. A prior TERMINAL sandbox replays its
 * recorded outcome (re-selection converges to the same durable
 * evidence); a prior crashed mid-dispatch sandbox fails closed
 * (`NON_CONVERGENT_EXTERNAL_EFFECT` — the honest unknown-effect
 * barrier; duplicate provider effects are structurally prevented).
 *
 * COOPERATIVE INTERRUPTION: the executor checks the abort signal
 * BEFORE dispatch (a cancelled execution never dispatches compute);
 * during execution the admitted wall-clock bound governs; after
 * execution the completion fence converges late cancellations through
 * the authority (never worker-side).
 */
import type {
  ExecutionWorkExecutor,
  LeaseFence,
  WorkEvidence,
  WorkExecutionOutcome,
  WorkExecutionRequest,
  WorkerLeaseClaim,
  WorkObservation,
  WorkResolution,
  WorkResolutionRequest,
} from "../../../platform/compute/port";
import { PlatformError } from "../../../shared/errors";
import type { SandboxService } from "../application/sandbox-service";
import type { SandboxTask } from "../domain/sandbox";
import { validateSandboxTask } from "../domain/sandbox";

/** The deterministic sandbox key of one execution's worker work. */
export function workerSandboxKey(executionId: string): string {
  return `worker-exec:${executionId}`;
}

/** The governed-path denial codes surfaced as permanent refusals. */
const DENIAL_CODES: ReadonlySet<string> = new Set([
  "POLICY_DENIED",
  "BUDGET_EXCEEDED",
  "CAPABILITY_UNAVAILABLE",
  "TENANT_SCOPE_VIOLATION",
  "INVALID_STATE_TRANSITION",
  "NON_CONVERGENT_EXTERNAL_EFFECT",
]);

interface SandboxBlock {
  readonly environmentId: string;
  readonly task: SandboxTask;
}

/** Parse + validate the task's sandbox block (fail closed). */
function sandboxBlockOf(
  task: Readonly<Record<string, unknown>>,
): SandboxBlock | { readonly reason: string } {
  const sandbox = task.sandbox;
  if (sandbox === undefined || sandbox === null) {
    return { reason: "the task declares no sandbox work (no `sandbox` block)" };
  }
  if (typeof sandbox !== "object" || Array.isArray(sandbox)) {
    return { reason: "task.sandbox must be an object" };
  }
  const block = sandbox as Record<string, unknown>;
  const environmentId = block.environmentId;
  if (typeof environmentId !== "string" || environmentId.length === 0) {
    return { reason: "task.sandbox.environmentId is required (the compute environment)" };
  }
  const args = Array.isArray(block.args)
    ? block.args.filter((arg): arg is string => typeof arg === "string")
    : [];
  const publicEnv: Record<string, string> = {};
  if (
    block.publicEnv !== undefined &&
    block.publicEnv !== null &&
    typeof block.publicEnv === "object"
  ) {
    for (const [name, value] of Object.entries(block.publicEnv as Record<string, unknown>)) {
      if (typeof value === "string") {
        publicEnv[name] = value;
      }
    }
  }
  const candidate: SandboxTask = {
    command: typeof block.command === "string" ? block.command : "",
    args,
    publicEnv,
  };
  const validation = validateSandboxTask(candidate);
  if (!validation.valid) {
    return {
      reason: `task.sandbox is not a valid sandbox task: ${validation.reason ?? "invalid"}`,
    };
  }
  return { environmentId, task: candidate };
}

export interface SandboxWorkExecutorDeps {
  /** The governed sandbox service (admission + dispatch + evidence). */
  readonly service: SandboxService;
  /** The pre-dispatch lease fence check (composed from the lease authority). */
  readonly leaseGuard: (
    applicationId: string,
    executionId: string,
    claim: WorkerLeaseClaim,
  ) => Promise<LeaseFence | null>;
  /** The worker's actor id (provenance on every sandbox action). */
  readonly workerActorId: string;
}

/** Evidence criterion of the sandbox work observation. */
const EVIDENCE_CRITERION = "sandbox-execution";
const EVIDENCE_STRATEGY = "sandbox-runtime-outcome";

export function createSandboxWorkExecutor(deps: SandboxWorkExecutorDeps): ExecutionWorkExecutor {
  const service = deps.service;
  const guard = deps.leaseGuard;
  const workerActorId = deps.workerActorId;

  return {
    resolve(request: WorkResolutionRequest): WorkResolution {
      const block = sandboxBlockOf(request.task);
      if ("reason" in block) {
        return { kind: "not-executable", reason: block.reason };
      }
      return {
        kind: "sandbox-work",
        computeEnvironmentId: block.environmentId,
        sandboxKey: workerSandboxKey(request.executionId),
      };
    },

    async execute(request: WorkExecutionRequest): Promise<WorkExecutionOutcome> {
      const block = sandboxBlockOf(request.task);
      if ("reason" in block) {
        return { outcome: "not-executable", reason: block.reason };
      }
      const actor = {
        actorId: request.worker.actorId || workerActorId,
        applicationId: request.applicationId,
        tenantId: request.tenantId,
      };
      const sandboxKey = workerSandboxKey(request.executionId);

      // THE FENCE re-check before provider dispatch: a stale worker
      // never dispatches compute.
      const fence = await guard(request.applicationId, request.executionId, request.claim);
      if (fence !== null) {
        return {
          outcome: "refused",
          kind: "fenced",
          reason: `lease fence (${fence.fenceClass}): ${fence.reason}`,
        };
      }

      // COOPERATIVE INTERRUPTION at the dispatch boundary: a cancelled
      // or drained execution never dispatches paid compute.
      if (request.signal?.aborted === true) {
        return {
          outcome: "refused",
          kind: "interrupted",
          reason: "the work was interrupted before dispatch (cancellation or drain)",
        };
      }

      // 1. Admission (policy -> capability -> budget) + the idempotent
      //    sandbox identity: the deterministic key converges repeats.
      let record: Awaited<ReturnType<SandboxService["createSandboxExecution"]>>;
      try {
        record = await service.createSandboxExecution(
          {
            executionId: request.executionId,
            environmentId: block.environmentId,
            task: block.task,
          },
          sandboxKey,
          actor,
        );
      } catch (error) {
        if (error instanceof PlatformError && DENIAL_CODES.has(error.code)) {
          return {
            outcome: "refused",
            kind: "governed",
            reason: `${error.code}: ${error.message}`,
          };
        }
        throw error;
      }
      if (record.status === "denied") {
        return {
          outcome: "refused",
          kind: "governed",
          reason: `sandbox admission denied (${record.denialClass ?? "unknown"}): ${record.denialReason ?? "no reason recorded"}`,
        };
      }

      // 2. Dispatch through the provider registry (substrate fail-closed
      //    when unwired; terminal replays converge).
      let dispatched: Awaited<ReturnType<SandboxService["dispatchSandboxExecution"]>>;
      try {
        dispatched = await service.dispatchSandboxExecution(
          { applicationId: request.applicationId, sandboxId: record.id },
          actor,
        );
      } catch (error) {
        if (error instanceof PlatformError && DENIAL_CODES.has(error.code)) {
          // The honest unknown-effect barrier (a prior dispatch crashed
          // mid-flight) or a governed dispatch refusal: permanent.
          return {
            outcome: "refused",
            kind: "governed",
            reason: `${error.code}: ${error.message}`,
          };
        }
        throw error;
      }

      // 3. Map the durable sandbox outcome onto the neutral work
      //    observation (worker-plane evidence — NEVER execution
      //    authority; the completion effect rides the verification
      //    discipline).
      return { outcome: "executed", observation: observationOf(dispatched, request) };
    },
  };
}

function observationOf(
  record: {
    readonly id: string;
    readonly status: string;
    readonly outcomeClass: string | null;
    readonly failureClass: string | null;
    readonly failureMessage: string | null;
    readonly retryable: boolean;
    readonly outputDigest: string | null;
    readonly output: Readonly<Record<string, unknown>> | null;
    readonly usageMicroUsd: string | null;
  },
  request: WorkExecutionRequest,
): WorkObservation {
  const evidence: WorkEvidence = {
    criterion: EVIDENCE_CRITERION,
    strategy: EVIDENCE_STRATEGY,
    verdict: record.outcomeClass === "sandbox-success" ? "met" : "unmet",
    evidence: [
      `sandbox:${record.id}`,
      ...(record.outputDigest === null ? [] : [record.outputDigest]),
    ],
    recordedBy: request.worker.workerId,
  };
  if (record.outcomeClass === "sandbox-success") {
    return {
      outcomeClass: "work-success",
      outputDigest: record.outputDigest,
      summary:
        record.output === null
          ? null
          : {
              sandboxId: record.id,
              ...(record.output.exitCode !== undefined
                ? { exitCode: record.output.exitCode as number }
                : {}),
              ...(record.output.durationMs !== undefined
                ? { durationMs: record.output.durationMs as number }
                : {}),
            },
      usageMicroUsd: record.usageMicroUsd,
      failure: null,
      evidence,
    };
  }
  return {
    outcomeClass: "work-failure",
    outputDigest: record.outputDigest,
    summary: record.output === null ? null : { sandboxId: record.id },
    usageMicroUsd: record.usageMicroUsd,
    failure: {
      failureClass: record.failureClass ?? "sandbox-execution",
      message: record.failureMessage ?? "the sandbox execution failed",
      retryable: record.retryable,
    },
    evidence,
  };
}
