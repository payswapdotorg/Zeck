/**
 * Benchmark strategy compositions (WORK-016 — the FAIR COMPARISON layer).
 *
 * Three strategy kinds over the SAME governed substrate (§20 of the Work
 * Order: the same Execution, Policy, Capabilities, Budget, Verification
 * and Evidence contract — no hidden privileges for the native path):
 *
 *  1. `native-agent-session`   — a governed execution + an agent session
 *     dispatched through the agents session service's admission chain
 *     with a NATIVE local runtime provider;
 *  2. `byoa-agent-session`     — the identical admission chain with the
 *     external agent wrapped through the WORK-016 BYOA adapter
 *     (`createByoaAgentProvider` — the neutral port implementation);
 *  3. `workflowos-submission`  — the WORK-016 WorkflowOS integration
 *     submission contract (the external-submission entry seam).
 *
 * All three produce executions through the SAME injected executions
 * authority; all three drive the SAME canonical lifecycle (authorize →
 * plan → queue → start → verify → pass with durable verification
 * results — the only completion path); all three record evidence on the
 * same ledger. SETUP (agent registration) happens through the canonical
 * WORK-011 registry path BEFORE any measurement (the harness measures
 * only); the strategies themselves never mutate policy, budget, routing
 * or WorkflowOS state.
 *
 * The agents are DETERMINISTIC STUBS (benchmarks measure the substrate,
 * not a live model): each strategy's participant behavior is fixed, so
 * the comparison measures the GOVERNED PATHS (admission chain,
 * submission seam, evidence flow), with the stub determinism recorded
 * in the environmental notes.
 */

import {
  type ByoaExternalAgent,
  createByoaAgentProvider,
  type IntegrationActor,
  type WorkflowOsIntegrationService,
} from "../src/integrations/workflowos/public";
import type {
  AgentProvider,
  AgentRuntimeIdentity,
  AgentSessionObservation,
  AgentSessionTask,
} from "../src/modules/agents/public";
import type { ExecutionService } from "../src/modules/executions/public";
import type { BenchmarkTask } from "./contract";
import type { BenchmarkStrategy } from "./harness";

export interface BenchmarkStrategyDeps {
  /** THE executions authority (all strategies share it — fair comparison). */
  readonly executions: ExecutionService;
  readonly applicationId: string;
  readonly tenantId: string;
  readonly actorId: string;
  /** The governed agent-session admission chain (agents module service). */
  readonly sessions: {
    readonly createSession: (
      input: {
        readonly executionId: string;
        readonly agentId: string;
        readonly inputDigest: string;
      },
      idempotencyKey: string,
      actor: {
        readonly actorId: string;
        readonly applicationId: string;
        readonly tenantId: string;
      },
    ) => Promise<{ readonly id: string }>;
    readonly runSession: (
      sessionId: string,
      provider: AgentProvider,
      idempotencyKey: string,
      actor: {
        readonly actorId: string;
        readonly applicationId: string;
        readonly tenantId: string;
      },
    ) => Promise<AgentSessionObservation>;
  };
  /** The pre-registered agent identity (setup, through the registry authority). */
  readonly nativeAgentId: string;
  readonly byoaAgentId: string;
  /** The WorkflowOS integration service (the submission seam). */
  readonly workflowos: WorkflowOsIntegrationService;
}

/** A deterministic native runtime provider (a local governed participant). */
export function nativeStubProvider(): AgentProvider {
  return {
    runtimeKind: "local",
    async executeSession(
      _identity: Readonly<AgentRuntimeIdentity>,
      task: Readonly<AgentSessionTask>,
    ): Promise<AgentSessionObservation> {
      return {
        outcomeClass: "session-success",
        outputDigest: `native:${task.inputDigest}`,
        output: { runtime: "native", inputDigest: task.inputDigest },
        failureReason: null,
      };
    },
  };
}

/** A deterministic external agent implementing the NEUTRAL BYOA contract. */
export function byoaStubExternalAgent(): ByoaExternalAgent {
  return {
    descriptor: { name: "benchmark-external-agent", version: "1.0.0" },
    async executeSession(
      _identity: Readonly<AgentRuntimeIdentity>,
      task: Readonly<AgentSessionTask>,
    ): Promise<AgentSessionObservation> {
      return {
        outcomeClass: "session-success",
        outputDigest: `byoa:${task.inputDigest}`,
        output: { runtime: "byoa", inputDigest: task.inputDigest },
        failureReason: null,
      };
    },
  };
}

const canonicalVerdictFor = (task: BenchmarkTask) => ({
  criterionId: task.verification.criterionId,
  strategy: task.verification.strategy,
  status: task.verification.expectedStatus,
  recordedBy: "benchmark-harness",
  evidence: [`bench:${task.taskId}`],
});

/** Drive one execution through the canonical governed lifecycle. */
async function driveToCompletion(
  deps: BenchmarkStrategyDeps,
  executionId: string,
  task: BenchmarkTask,
  keyPrefix: string,
): Promise<void> {
  const actor = { actorId: deps.actorId, tenantId: deps.tenantId };
  const commands: readonly ("authorize" | "plan" | "queue" | "start" | "verify")[] = [
    "authorize",
    "plan",
    "queue",
    "start",
    "verify",
  ];
  for (const command of commands) {
    await deps.executions.transition(
      { command, applicationId: deps.applicationId, executionId, ...actor },
      `${keyPrefix}:${command}`,
    );
  }
  await deps.executions.transition(
    {
      command: "pass",
      applicationId: deps.applicationId,
      executionId,
      ...actor,
      verificationResults: [canonicalVerdictFor(task)],
    },
    `${keyPrefix}:pass`,
  );
}

const digestOf = (task: BenchmarkTask): string =>
  `bench-digest:${task.taskId}:${Object.keys(task.task).length}`;

/** Create the three fair-comparison strategies over the shared wiring. */
export function createBenchmarkStrategies(
  deps: BenchmarkStrategyDeps,
): readonly BenchmarkStrategy[] {
  const sessionActor = {
    actorId: deps.actorId,
    applicationId: deps.applicationId,
    tenantId: deps.tenantId,
  };
  const integrationActor: IntegrationActor = sessionActor;

  const runAgentSessionStrategy = (
    kind: "native-agent-session" | "byoa-agent-session",
    agentId: string,
    provider: AgentProvider,
  ): BenchmarkStrategy => ({
    kind,
    async runTask(task: BenchmarkTask, idempotencyKey: string) {
      // The execution the session binds to — through the SAME authority.
      const receipt = await deps.executions.createExecution(
        {
          applicationId: deps.applicationId,
          task: { ...task.task, benchmarkStrategy: kind },
          metadata: { benchmark: { taskId: task.taskId, strategy: kind } },
        },
        idempotencyKey,
        { actorId: deps.actorId, tenantId: deps.tenantId },
      );
      const executionId = receipt.executionId;
      // The session admission chain (policy → credentials → durable session).
      const session = await deps.sessions.createSession(
        { executionId, agentId, inputDigest: digestOf(task) },
        `${idempotencyKey}:session`,
        sessionActor,
      );
      await deps.sessions.runSession(session.id, provider, `${idempotencyKey}:run`, sessionActor);
      // The canonical lifecycle to the durable PASS (the only completion).
      await driveToCompletion(deps, executionId, task, `${idempotencyKey}:lifecycle`);
      return [executionId];
    },
  });

  return [
    runAgentSessionStrategy("native-agent-session", deps.nativeAgentId, nativeStubProvider()),
    runAgentSessionStrategy(
      "byoa-agent-session",
      deps.byoaAgentId,
      createByoaAgentProvider(byoaStubExternalAgent()),
    ),
    {
      kind: "workflowos-submission",
      async runTask(task: BenchmarkTask, idempotencyKey: string) {
        // The external-submission seam: the neutral WorkflowOS contract.
        const receipt = await deps.workflowos.submitWork(
          {
            workRef: `bench-work:${task.taskId}`,
            task: { ...task.task, benchmarkStrategy: "workflowos-submission" },
          },
          idempotencyKey,
          integrationActor,
        );
        const executionId = receipt.executionId;
        await driveToCompletion(deps, executionId, task, `${idempotencyKey}:lifecycle`);
        return [executionId];
      },
    },
  ];
}
