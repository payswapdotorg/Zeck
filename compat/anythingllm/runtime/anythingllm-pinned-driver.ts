/**
 * The PPR-026 AnythingLLM pinned-runtime driver — the PPR-018A plug-in surface
 * (`compat/harness/runtime.ts`'s `definePinnedRuntime` discipline), shipped
 * as worker surface for the Tech Lead's merge-time binding (the same
 * provenance-disclosed pattern PPR-019/020/022/023/024/025 established:
 * the Lead registers this driver through `createRuntimeRegistry` +
 * `createDemoRunService` at the deployment seam — the worker never
 * activates their own demo).
 *
 * It composes the worker's EXISTING proof pieces verbatim — no adapter or
 * harness logic is reimplemented:
 *
 *  - `composeProofStack` (harness/compose.ts): the real Zeck public API
 *    composed in-process (the platform suites' own `seedApiWorld`) + the
 *    real model gateway over the sandbox's multi-surface GLM supply rail
 *    (chat text/vision, asr, tts) + the Zeck-side DETERMINISTIC
 *    embeddings executor (the recorded /embeddings 404 supply boundary)
 *    + the execution driver that drives every created execution through
 *    the executions authority's own transitions;
 *  - `createAdapterServer` (adapter/server.ts): the local multi-protocol
 *    endpoint (OpenAI-compatible /v1/* + the Ollama-native LOCAL-INFERENCE
 *    RAIL /api/*) whose ONLY backend is the Zeck public API — the ACR-007
 *    Application Delegation Boundary the unmodified pinned AnythingLLM
 *    runtime points at (the app's own documented env-configuration
 *    surface: LLM_PROVIDER/GENERIC_OPEN_AI_*, EMBEDDING_ENGINE/
 *    EMBEDDING_BASE_PATH, STT_PROVIDER/STT_OPEN_AI_COMPATIBLE_*,
 *    TTS_PROVIDER/TTS_OPEN_AI_COMPATIBLE_*, OLLAMA_BASE_PATH);
 *  - `createEgressProxy` (harness/egress-proxy.ts): the default-deny
 *    proof-environment egress control for the AnythingLLM application
 *    processes (server + collector);
 *  - `runCorpusTasks` (harness/corpus-runner.ts): the representative
 *    corpus tasks executed through the REAL pinned AnythingLLM processes
 *    (node server/index.js + node collector/index.js over the exact
 *    checkout, booted exactly the way the app's own docker-entrypoint
 *    boots them) inside the certified proof environment
 *    (credential-scrubbed allowlist environment + deny proxy), verified
 *    mechanically;
 *  - `createSdkTraceSource` (harness/trace.ts): the read-only public SDK
 *    wire reads the PPR-018A demo-run service correlates through.
 *
 * The driver is a TRANSLATION boundary only (ports/runtime.ts / ACR-007
 * §1): pinned task → the corpus's own task (by taskId; the bound demo
 * entry's representative task names anythingllm-rag-grounded-qa — the
 * RAG journey exercising the chat + embeddings surfaces) → the pinned
 * AnythingLLM application processes → the corpus's mechanical
 * verification → TaskRunOutcome. It adds NO provider selection, retry
 * routing, budget accounting, verification or optimization logic —
 * those stay with Zeck.
 *
 * LIFECYCLE: the certified proof environment (the in-process Zeck public
 * API + the adapter — ONE exact application + integration revision pair)
 * is composed LAZILY on the first certified start and kept warm for the
 * process's lifetime. Every `start()` returns a session over that shared
 * environment; a session's `stop()` ends the session (a stopped session
 * executes nothing) without tearing down the certified plane. The
 * harness's own gates (exact pins, session-descriptor re-verification,
 * credential erasure) run on every session.
 */

import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type DemoRunExecutor,
  type EdgeExecutionObservation,
  type EgressObservation,
  type PinnedRuntimeDriver,
  type PinnedRuntimeSession,
  type PinnedRuntimeTask,
  type RevisionPin,
  type TaskRunOutcome,
  type TraceRead,
  type ZeckTraceSource,
  runtimeBindingIssues,
} from "../../../src/integrations/compatibility/public";
import { createDemoRunService } from "../../../src/integrations/compatibility/public";
import { createRuntimeRegistry } from "../../../src/integrations/compatibility/public";
import { definePinnedRuntime } from "../../harness/runtime";
import { createAdapterServer, type AdapterServer } from "../adapter/server";
import { CORPUS_TASKS, REPRESENTATIVE_TASK_ID, type CorpusTask } from "../corpus/tasks";
import {
  ANYTHINGLLM_INTEGRATION_REVISION,
  ANYTHINGLLM_UPSTREAM_REPOSITORY,
  ANYTHINGLLM_UPSTREAM_REVISION,
} from "../graph/execution-graph";
import {
  buildAnythingLlmRuntimeEnvironment,
  existsAnythingLlmRuntime,
  PROVIDER_CREDENTIAL_ENV_NAMES,
  runCorpusTasks,
  type CorpusRunnerOptions,
  type CorpusTaskOutcome,
} from "../harness/corpus-runner";
import { auditCredentialErasure } from "../../harness/credential-erasure";
import { composeProofStack, type ProofStack } from "../harness/compose";
import { createEgressProxy, type EgressProxy } from "../harness/egress-proxy";
import { createSdkTraceSource } from "../harness/trace";

/** The registry id (the Demo Mirror entry's runBinding.runtime names THIS). */
export const ANYTHINGLLM_RUNTIME_ID = "compat/anythingllm" as const;

/** The Zeck integration revision this binding pins (the Lead re-pins at merge — the class precedent). */
export { ANYTHINGLLM_INTEGRATION_REVISION };

/**
 * The Zeck application identity the certified proof composition's
 * executions run under — the applicationId the bound evidence record
 * pins (the battery's composed world: the process's first seeded
 * application). The started session reports the environment's ACTUAL
 * application id in its descriptor; the harness verifies it against the
 * record's binding on every run (a mismatch is a named refusal).
 */
const ANYTHINGLLM_APPLICATION_ID = "00000000-0000-7000-8000-00000000b001";

/** The exact pins this driver starts (must equal the bound record's). */
const ANYTHINGLLM_PIN: RevisionPin = {
  upstreamRevision: ANYTHINGLLM_UPSTREAM_REVISION,
  integrationRevision: ANYTHINGLLM_INTEGRATION_REVISION,
};

/** Where demo-run workspaces live (per-run subdirectories under this root). */
const DEMO_WORK_ROOT =
  process.env.PPR_026_DEMO_WORK_ROOT ?? join(tmpdir(), "ppr-026-demo");

/** The supply pacing the certified battery used (the rail's dispatch interval). */
const SUPPLY_PACING_MS = 2000;

/** The composed certified proof environment (the shared pinned runtime). */
interface AnythingLlmProofEnvironment {
  readonly stack: ProofStack;
  readonly proxy: EgressProxy;
  readonly workRoot: string;
}

/** The lazily-composed singleton (ONE exact application + integration revision pair per process). */
let environment: Promise<AnythingLlmProofEnvironment> | null = null;

/**
 * Compose (or attach to) the certified proof environment. The first
 * caller composes; a failed composition is retryable (never cached as
 * broken). This is the worker's own battery composition — the same
 * pieces `run-battery.ts` starts, kept warm for the deployment.
 * (Exported: the battery composes the certified plane FIRST so the
 * driver's bound application identity is the process's first seed.)
 */
export function anythingLlmProofEnvironment(): Promise<AnythingLlmProofEnvironment> {
  if (environment === null) {
    const composed = (async (): Promise<AnythingLlmProofEnvironment> => {
      const proxy = await createEgressProxy();
      const stack = await composeProofStack({ minDispatchIntervalMs: SUPPLY_PACING_MS });
      return { stack, proxy, workRoot: DEMO_WORK_ROOT };
    })();
    composed.catch(() => {
      // A failed composition clears the slot: the next certified run
      // retries honestly instead of reusing a rejected promise.
      environment = null;
    });
    environment = composed;
  }
  return environment;
}

/** The honest not-found trace read (a miss is a named fact, never fabricated). */
const TRACE_READ_NOT_FOUND: TraceRead = {
  execution: null,
  events: [],
  verification: [],
  route: null,
  costMicroUsd: null,
  usage: null,
};

/**
 * The demo-run trace source: the worker's SDK wire reads over the
 * composed environment (read-only, public shapes only). Lazy by
 * necessity — the environment exists only after the first certified
 * start; before that every read is the honest not-found read.
 */
export function anythingLlmDemoTraceSource(): ZeckTraceSource {
  let source: ZeckTraceSource | null = null;
  return {
    async readExecutionTrace(applicationId, executionId) {
      if (environment === null) {
        return TRACE_READ_NOT_FOUND;
      }
      try {
        const composed = await environment;
        source ??= createSdkTraceSource({
          apiBaseUrl: composed.stack.apiBaseUrl,
          token: composed.stack.apiToken,
          applicationId: composed.stack.applicationId,
        });
        return await source.readExecutionTrace(applicationId, executionId);
      } catch {
        return TRACE_READ_NOT_FOUND;
      }
    },
  };
}

/** An honest NOT-RUN outcome (infrastructure unavailable, owner named — never a guessed run). */
function notRunOutcome(
  task: PinnedRuntimeTask,
  startedAt: number,
  cause: string,
  owner: string,
): TaskRunOutcome {
  return {
    taskId: task.taskId,
    succeeded: null,
    detail: cause,
    durationMs: Date.now() - startedAt,
    edgeExecutions: [],
    failureCount: 0,
    retryCount: 0,
    egressObservation: null,
    unavailable: { outcome: "NOT-RUN", cause, owner },
  };
}

/** The adapter log's terminal status → the runtime-side observation outcome. */
function edgeOutcomeOf(terminal: string | undefined): EdgeExecutionObservation["outcome"] {
  if (terminal === "COMPLETED") {
    return "resolved";
  }
  if (terminal === "FAILED" || terminal === "CANCELLED" || terminal === "EXPIRED") {
    return "failed";
  }
  if (terminal === undefined) {
    return "not-found";
  }
  return "pending";
}

/** Translate one corpus outcome into the harness's TaskRunOutcome shape. */
function taskRunOutcomeOf(
  task: PinnedRuntimeTask,
  outcome: CorpusTaskOutcome,
  proof: AnythingLlmProofEnvironment,
): TaskRunOutcome {
  // The rail facts of THIS run's executions only (the shared environment
  // accumulates facts across runs; the outcome's execution ids scope it).
  const executionIds = new Set(outcome.edgeExecutions.map((edge) => edge.executionId));
  const railFacts = proof.stack.railFacts().filter((fact) => executionIds.has(fact.executionId));
  const deterministicFacts = proof.stack
    .deterministicFacts()
    .filter((fact) => executionIds.has(fact.executionId));
  const factsByExecution = new Map<
    string,
    { latencyMs: number | null; usage: { inputTokens: number; outputTokens: number } | null }
  >();
  for (const fact of railFacts) {
    const existing = factsByExecution.get(fact.executionId) ?? { latencyMs: 0, usage: null };
    factsByExecution.set(fact.executionId, {
      latencyMs: (existing.latencyMs ?? 0) + (fact.latencyMs ?? 0),
      usage: fact.usage,
    });
  }
  for (const fact of deterministicFacts) {
    const existing = factsByExecution.get(fact.executionId) ?? { latencyMs: 0, usage: null };
    factsByExecution.set(fact.executionId, {
      latencyMs: (existing.latencyMs ?? 0) + (fact.latencyMs ?? 0),
      usage: existing.usage,
    });
  }
  const terminals = new Map(
    proof.stack.adapter
      .requests()
      .filter((log) => executionIds.has(log.executionId))
      .map((log) => [log.executionId, log.terminal] as const),
  );

  const edgeExecutions: EdgeExecutionObservation[] = outcome.edgeExecutions.map((edge) => {
    const facts = factsByExecution.get(edge.executionId);
    return {
      edgeId: edge.edgeId,
      executionId: edge.executionId,
      outcome: edgeOutcomeOf(terminals.get(edge.executionId)),
      latencyMs: facts?.latencyMs ?? null,
      ...(facts?.usage == null ? {} : { usage: facts.usage }),
      // The rail reports no micro-USD price (the battery's honest
      // cost-per-resolved-outcome boundary) — null, never fabricated.
      costMicroUsd: null,
    };
  });

  const violations = [...outcome.egressViolations];
  const egressObservation: EgressObservation = {
    mode: "deny",
    status:
      violations.length === 0
        ? "observed-clean"
        : violations.every((violation) => violation.blocked)
          ? "provably-blocked"
          : "violations-detected",
    violations,
  };

  const retries = railFacts.filter(
    (fact, index) =>
      railFacts.findIndex((other) => other.executionId === fact.executionId) !== index,
  ).length;
  const tail = outcome.stderrTail
    .slice(-400)
    .replace(/\s+/g, " ")
    .trim();

  return {
    taskId: task.taskId,
    succeeded: outcome.resolved,
    detail:
      `Corpus task ${outcome.taskId} executed through the pinned unmodified AnythingLLM runtime ` +
      `(upstream ${ANYTHINGLLM_UPSTREAM_REVISION}) with Zeck as its sole AI execution authority on every declared surface: ` +
      `the corpus's mechanical verification ${outcome.resolved ? "PASSED" : "FAILED"} (${outcome.checkOutput}); ` +
      `${outcome.edgeExecutions.length} delegated edge execution(s) through the Zeck public API ` +
      `(${outcome.railUsage.dispatches} model-rail dispatch(es), ${outcome.deterministicUsage.executions} deterministic ` +
      `embeddings execution(s) over ${outcome.deterministicUsage.vectors} vector(s), ${outcome.railUsage.failures} provider failure(s)); ` +
      `egress ${egressObservation.status} under the default-deny proof control.` +
      (tail.length === 0 ? "" : ` AnythingLLM log tail: ${tail}`),
    durationMs: outcome.durationMs,
    edgeExecutions,
    failureCount: outcome.railUsage.failures,
    retryCount: retries,
    egressObservation,
    unavailable: outcome.unavailable,
  };
}

/** Resolve the corpus task a pinned runtime task names (by taskId). */
function corpusTaskOf(task: PinnedRuntimeTask): CorpusTask | undefined {
  return CORPUS_TASKS.find((corpusTask) => corpusTask.taskId === task.taskId);
}

/**
 * The AnythingLLM pinned-runtime driver (the PPR-018A plug-in). Registered by
 * the deployment composition through `createRuntimeRegistry`; started
 * only by the harness's corpus runner or demo-run service (both verify
 * the binding before and after every start).
 */
export const anythingLlmPinnedRuntimeDriver: PinnedRuntimeDriver = definePinnedRuntime({
  runtimeId: ANYTHINGLLM_RUNTIME_ID,
  identity: {
    name: "AnythingLLM",
    repository: ANYTHINGLLM_UPSTREAM_REPOSITORY,
    applicationId: ANYTHINGLLM_APPLICATION_ID,
  },
  pin: ANYTHINGLLM_PIN,
  start: async (context) => {
    // The driver verifies the binding it was handed (fail-closed — the
    // harness re-verifies both the driver's pins and the started
    // session's descriptor; a mismatched start is refused here too).
    const bindingIssues = runtimeBindingIssues(
      { applicationId: context.expectedApplicationId, pin: context.expectedPin },
      { applicationId: ANYTHINGLLM_APPLICATION_ID, pin: ANYTHINGLLM_PIN },
    );
    if (bindingIssues.length > 0) {
      throw new Error(
        `the AnythingLLM pinned runtime refuses to start against a mismatched binding: ${bindingIssues
          .map((issue) => issue.issue)
          .join("; ")}`,
      );
    }
    const proof = await anythingLlmProofEnvironment();
    // Credential-presence facts of the CERTIFIED RUNTIME ENVIRONMENT (the
    // scrubbed allowlist environment the AnythingLLM application processes
    // actually receive — NAMES + booleans, never values; the same
    // observation the battery records as the scrub basis). The
    // AnythingLLM application processes receive the credential-scrubbed
    // environment by construction (corpus-runner); a credential-bearing
    // deployment is refused by the harness's erasure gate.
    const runtimeEnv = buildAnythingLlmRuntimeEnvironment({
      adapterUrl: proof.stack.adapter.url,
      proxyUrl: proof.proxy.url,
      // The environment-facts audit observes the scrub SHAPE (the same
      // builder the corpus runner composes with); the per-session ports
      // are assigned by the corpus runner at executeTask time.
      appPort: 0,
      collectorPort: 0,
    });
    const environmentFacts = auditCredentialErasure(runtimeEnv, PROVIDER_CREDENTIAL_ENV_NAMES).facts;
    let stopped = false;
    const session: PinnedRuntimeSession = {
      descriptor: {
        runtimeId: ANYTHINGLLM_RUNTIME_ID,
        applicationId: proof.stack.applicationId,
        pin: ANYTHINGLLM_PIN,
        startedAt: context.now(),
      },
      environmentFacts,
      async executeTask(task) {
        const startedAt = Date.now();
        if (stopped) {
          return notRunOutcome(
            task,
            startedAt,
            "the session was stopped before this task — a stopped session executes nothing",
            "runtime",
          );
        }
        const corpusTask = corpusTaskOf(task) ??
          CORPUS_TASKS.find((entry) => entry.taskId === REPRESENTATIVE_TASK_ID);
        if (corpusTask === undefined) {
          return notRunOutcome(
            task,
            startedAt,
            `the declared corpus carries no task named ${task.taskId} and no representative fallback — the driver cannot translate the task`,
            "worker",
          );
        }
        if (!existsAnythingLlmRuntime()) {
          return notRunOutcome(
            task,
            startedAt,
            `the pinned AnythingLLM runtime is absent (${ANYTHINGLLM_UPSTREAM_REVISION}) — install it per the demo entry's reproducibility instructions`,
            "deployment",
          );
        }
        const activeProof = await anythingLlmProofEnvironment();
        // A fresh run root per demo run: every run is a real new
        // AnythingLLM application process pair over the corpus's own
        // task.
        const runRoot = join(
          activeProof.workRoot,
          `run-${corpusTask.taskId.replace(/[^a-z0-9-]+/gi, "-")}-${startedAt}`,
        );
        const options: CorpusRunnerOptions = {
          adapter: activeProof.stack.adapter,
          proxy: activeProof.proxy,
          workspaceRoot: runRoot,
          railFacts: activeProof.stack.railFacts,
          deterministicFacts: activeProof.stack.deterministicFacts,
        };
        const [outcome] = await runCorpusTasks(options, [corpusTask]);
        if (outcome === undefined) {
          return notRunOutcome(
            task,
            startedAt,
            "the corpus runner produced no outcome for the task",
            "runtime",
          );
        }
        return taskRunOutcomeOf(task, outcome, activeProof);
      },
      async stop() {
        // Ends the SESSION only. The shared certified proof environment
        // (the deployment's pinned runtime) stays composed — the harness
        // stops what it started, and what it started is a session over
        // the exact pinned revision pair, not the plane itself.
        stopped = true;
      },
    };
    return session;
  },
});

/**
 * The PPR-026 worker-shipped deployment seam factory: the PPR-018A
 * harness composition (`createRuntimeRegistry` with the AnythingLLM
 * driver registered + `createDemoRunService`) wrapped as the Demo Mirror
 * run executor the dashboard's POST route hands to `demoMirrorRunHandler`.
 * Every authorization gate (derived status, pinned-runtime binding,
 * registry resolution, exact pins, credential erasure) stays the
 * harness's own — this factory only wires the certified pieces
 * together. The Lead binds it at merge; the worker ships it as surface.
 */
export function createAnythingLlmDemoRunExecutor(): DemoRunExecutor {
  const registry = createRuntimeRegistry({ drivers: [anythingLlmPinnedRuntimeDriver] });
  const service = createDemoRunService({
    registry,
    traceSource: anythingLlmDemoTraceSource(),
    credentialEnvVarNames: PROVIDER_CREDENTIAL_ENV_NAMES,
    now: () => new Date().toISOString(),
  });
  return {
    run: (entry, record, inventory) => service.run(entry, record, inventory ?? null),
  };
}
