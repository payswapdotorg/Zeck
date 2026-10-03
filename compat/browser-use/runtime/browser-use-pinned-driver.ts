/**
 * The PPR-024 Browser Use pinned-runtime driver — the PPR-018A plug-in surface
 * (`compat/harness/runtime.ts`'s `definePinnedRuntime` discipline), shipped
 * as worker surface for the Tech Lead's merge-time binding (the same
 * provenance-disclosed pattern PPR-019/PPR-020/PPR-022/PPR-023 established:
 * the Lead registers this driver through `createRuntimeRegistry` +
 * `createDemoRunService` at the deployment seam — the worker never
 * activates their own demo).
 *
 * It composes the worker's EXISTING proof pieces verbatim — no adapter or
 * harness logic is reimplemented:
 *
 *  - `composeProofStack` (harness/compose.ts): the real Zeck public API
 *    composed in-process (the platform suites' own `seedApiWorld`) + the
 *    real model gateway over the sandbox's GLM supply rail + the Zeck-side
 *    substrate driver hosting the pinned runtime's own BrowserSession over
 *    the real Chromium + the two-plane execution driver;
 *  - `createAdapterServer` (adapter/server.ts): the local two-surface
 *    OpenAI-compatible + substrate-relay endpoint whose ONLY backend is
 *    the Zeck public API — the ACR-007 Application Delegation Boundary
 *    the unmodified pinned Browser Use runtime points at (ChatOpenAI
 *    base_url + the Delegating session/tools constructor seams);
 *  - `createEgressProxy` (harness/egress-proxy.ts): the default-deny
 *    proof-environment egress control for the Browser Use application
 *    runtime (and the substrate browser's own external egress);
 *  - `runCorpusTasks` (harness/corpus-runner.ts): the representative
 *    corpus tasks executed through the REAL pinned Browser Use
 *    application process inside the certified proof environment
 *    (credential-scrubbed allowlist environment + deny proxy), verified
 *    mechanically;
 *  - `createSdkTraceSource` (harness/trace.ts): the read-only public SDK
 *    wire reads the PPR-018A demo-run service correlates through.
 *
 * The driver is a TRANSLATION boundary only (ports/runtime.ts / ACR-007
 * §1): pinned task → the corpus's own task (by taskId; the bound demo
 * entry's representative task names browseruse-agent-combined — the
 * two-plane combined task) → the pinned Browser Use application process
 * → the corpus's mechanical verification → TaskRunOutcome. It adds NO
 * provider selection, retry routing, budget accounting, verification or
 * optimization logic — those stay with Zeck.
 *
 * LIFECYCLE: the certified proof environment (the in-process Zeck public
 * API + the adapter + the substrate driver — ONE exact application +
 * integration revision pair) is composed LAZILY on the first certified
 * start and kept warm for the process's lifetime. Every `start()` returns
 * a session over that shared environment; a session's `stop()` ends the
 * session (a stopped session executes nothing) without tearing down the
 * certified plane. The harness's own gates (exact pins, session-descriptor
 * re-verification, credential erasure) run on every session.
 */

import { mkdirSync } from "node:fs";
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
  BROWSER_USE_UPSTREAM_REPOSITORY,
  BROWSER_USE_UPSTREAM_REVISION,
} from "../graph/execution-graph";
import {
  existsBrowserUseRuntime,
  PROVIDER_CREDENTIAL_ENV_NAMES,
  runCorpusTasks,
  type CorpusRunnerOptions,
  type CorpusTaskOutcome,
} from "../harness/corpus-runner";
import { composeProofStack, type ProofStack } from "../harness/compose";
import { createEgressProxy, type EgressProxy } from "../harness/egress-proxy";
import { createSdkTraceSource } from "../harness/trace";

/** The registry id (the Demo Mirror entry's runBinding.runtime names THIS). */
export const BROWSER_USE_RUNTIME_ID = "compat/browser-use";

/**
 * The Zeck integration revision this binding pins (the proof-time
 * placeholder is the governed delivery base the PPR-024 branch was cut
 * from — d51b5a59d53ef7824074acc4fce6726f065fcec5, the PPR-023
 * delivered-records commit and main head at branch time. The Lead
 * re-pins the binding to the actual merge base at delivery, the exact
 * class precedent the PPR-019/PPR-020/PPR-022/PPR-023 bindings
 * established. A different pin is a different object — never an update.)
 */
export const BROWSER_USE_INTEGRATION_REVISION = "d51b5a59d53ef7824074acc4fce6726f065fcec5";

/**
 * The Zeck application identity the certified proof composition's
 * executions run under — the applicationId the bound evidence record
 * pins (the battery's composed world: the process's first seeded
 * application). The started session reports the environment's ACTUAL
 * application id in its descriptor; the harness verifies it against the
 * record's binding on every run (a mismatch is a named refusal).
 */
const BROWSER_USE_APPLICATION_ID = "00000000-0000-7000-8000-00000000b001";

/** The exact pins this driver starts (must equal the bound record's). */
const BROWSER_USE_PIN: RevisionPin = {
  upstreamRevision: BROWSER_USE_UPSTREAM_REVISION,
  integrationRevision: BROWSER_USE_INTEGRATION_REVISION,
};

/** Where demo-run workspaces live (per-run subdirectories under this root). */
const DEMO_WORK_ROOT =
  process.env.PPR_024_DEMO_WORK_ROOT ?? join(tmpdir(), "ppr-024-demo");

/** The supply pacing the certified battery used (the rail's dispatch interval). */
const SUPPLY_PACING_MS = 2000;

/** The sandbox's Chromium for the substrate browser (the actuation rail). */
function browserExecutablePath(): string | undefined {
  const candidates = [
    process.env.PPR_024_BROWSER_PATH,
    "/home/z/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome",
  ].filter((candidate): candidate is string => typeof candidate === "string" && candidate.length > 0);
  return candidates[0];
}

/** The composed certified proof environment (the shared pinned runtime). */
interface BrowserUseProofEnvironment {
  readonly stack: ProofStack;
  readonly proxy: EgressProxy;
  readonly workRoot: string;
}

/** The lazily-composed singleton (ONE exact application + integration revision pair per process). */
let environment: Promise<BrowserUseProofEnvironment> | null = null;

/**
 * Compose (or attach to) the certified proof environment. The first
 * caller composes; a failed composition is retryable (never cached as
 * broken). This is the worker's own battery composition — the same
 * pieces `run-battery.ts` starts, kept warm for the deployment.
 * (Exported: the battery composes the certified plane FIRST so the
 * driver's bound application identity is the process's first seed.)
 */
export function browserUseProofEnvironment(): Promise<BrowserUseProofEnvironment> {
  if (environment === null) {
    const composed = (async (): Promise<BrowserUseProofEnvironment> => {
      mkdirSync(DEMO_WORK_ROOT, { recursive: true });
      const proxy = await createEgressProxy();
      const stack = await composeProofStack({
        substrateProxyServer: proxy.url,
        substrateProxyBypass: "127.0.0.1,localhost",
        minDispatchIntervalMs: SUPPLY_PACING_MS,
      });
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
export function browserUseDemoTraceSource(): ZeckTraceSource {
  let source: ZeckTraceSource | null = null;
  return {
    async readExecutionTrace(applicationId, executionId) {
      if (environment === null) {
        return TRACE_READ_NOT_FOUND;
      }
      try {
        const composed = await environment;
        source = createSdkTraceSource({
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
  proof: BrowserUseProofEnvironment,
): TaskRunOutcome {
  // The rail facts of THIS run's executions only (the shared environment
  // accumulates facts across runs; the outcome's execution ids scope it).
  const executionIds = new Set(outcome.edgeExecutions.map((edge) => edge.executionId));
  const railFacts = proof.stack.railFacts().filter((fact) => executionIds.has(fact.executionId));
  const substrateFacts = proof.stack
    .substrateFacts()
    .filter((fact) => executionIds.has(fact.executionId));
  const factsByExecution = new Map<string, { latencyMs: number | null; usage: { inputTokens: number; outputTokens: number } | null }>();
  for (const fact of railFacts) {
    const existing = factsByExecution.get(fact.executionId) ?? { latencyMs: 0, usage: null };
    factsByExecution.set(fact.executionId, {
      latencyMs: (existing.latencyMs ?? 0) + (fact.latencyMs ?? 0),
      usage: fact.usage,
    });
  }
  for (const fact of substrateFacts) {
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
      `Corpus task ${outcome.taskId} executed through the pinned unmodified Browser Use runtime ` +
      `(upstream ${BROWSER_USE_UPSTREAM_REVISION}) with Zeck as its sole AI execution authority on BOTH planes: ` +
      `the corpus's mechanical verification ${outcome.resolved ? "PASSED" : "FAILED"} (${outcome.checkOutput}); ` +
      `CLI exit code ${outcome.exitCode}${outcome.timedOut ? " (wall-clock timeout hit)" : ""}; ` +
      `${outcome.edgeExecutions.length} delegated edge execution(s) through the Zeck public API ` +
      `(${outcome.railUsage.dispatches} model-rail dispatch(es), ${outcome.substrateUsage.operations} substrate ` +
      `operation(s), ${outcome.railUsage.failures} provider failure(s)); egress ${egressObservation.status} under the default-deny proof control.` +
      (tail.length === 0 ? "" : ` Browser Use output tail: ${tail}`),
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
 * The Browser Use pinned-runtime driver (the PPR-018A plug-in). Registered by
 * the deployment composition through `createRuntimeRegistry`; started
 * only by the harness's corpus runner or demo-run service (both verify
 * the binding before and after every start).
 */
export const browserUsePinnedRuntimeDriver: PinnedRuntimeDriver = definePinnedRuntime({
  runtimeId: BROWSER_USE_RUNTIME_ID,
  identity: {
    name: "Browser Use",
    repository: BROWSER_USE_UPSTREAM_REPOSITORY,
    applicationId: BROWSER_USE_APPLICATION_ID,
  },
  pin: BROWSER_USE_PIN,
  start: async (context) => {
    // The driver verifies the binding it was handed (fail-closed — the
    // harness re-verifies both the driver's pins and the started
    // session's descriptor; a mismatched start is refused here too).
    const bindingIssues = runtimeBindingIssues(
      { applicationId: context.expectedApplicationId, pin: context.expectedPin },
      { applicationId: BROWSER_USE_APPLICATION_ID, pin: BROWSER_USE_PIN },
    );
    if (bindingIssues.length > 0) {
      throw new Error(
        `the Browser Use pinned runtime refuses to start against a mismatched binding: ${bindingIssues
          .map((issue) => issue.issue)
          .join("; ")}`,
      );
    }
    const proof = await browserUseProofEnvironment();
    // Credential-presence facts of the composing environment (NAMES +
    // booleans, never values — the same observation the battery records
    // as the scrub basis). The Browser Use application process receives
    // the credential-scrubbed allowlist environment by construction
    // (corpus-runner); a credential-bearing deployment is refused by the
    // harness's erasure gate.
    const environmentFacts = PROVIDER_CREDENTIAL_ENV_NAMES.map((name) => ({
      envVarName: name,
      present: typeof process.env[name] === "string" && (process.env[name] ?? "").length > 0,
    }));
    let stopped = false;
    const session: PinnedRuntimeSession = {
      descriptor: {
        runtimeId: BROWSER_USE_RUNTIME_ID,
        applicationId: proof.stack.applicationId,
        pin: BROWSER_USE_PIN,
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
        if (!existsBrowserUseRuntime()) {
          return notRunOutcome(
            task,
            startedAt,
            `the pinned Browser Use runtime is absent (${BROWSER_USE_UPSTREAM_REVISION}) — install it per the demo entry's reproducibility instructions`,
            "deployment",
          );
        }
        const activeProof = await browserUseProofEnvironment();
        // A fresh workspace per demo run: every run is a real new Browser
        // Use agent execution over the corpus's own task.
        const runRoot = join(
          activeProof.workRoot,
          `run-${corpusTask.taskId.replace(/[^a-z0-9-]+/gi, "-")}-${startedAt}`,
        );
        const options: CorpusRunnerOptions = {
          adapter: activeProof.stack.adapter,
          proxy: activeProof.proxy,
          workspaceRoot: runRoot,
          railFacts: activeProof.stack.railFacts,
          substrateFacts: activeProof.stack.substrateFacts,
          fixtureUrl: `http://127.0.0.1:${(await fixturePageOf(activeProof)).port}/`,
          ...(browserExecutablePath() === undefined ? {} : {}),
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

/** The lazily-served fixture page of the composed environment (per-process). */
let fixturePageSingleton: {
  readonly port: number;
} | null = null;
async function fixturePageOf(
  proof: BrowserUseProofEnvironment,
): Promise<{ readonly port: number }> {
  if (fixturePageSingleton !== null) {
    return fixturePageSingleton;
  }
  const { createRevealTokenPage, FIXTURE_PAGE_PORT } = await import("../harness/fixture-page");
  const { REVEAL_BUTTON_TEXT, REVEAL_TOKEN, REVEAL_TOKEN_MARKER } = await import("../corpus/tasks");
  const page = createRevealTokenPage({
    port: FIXTURE_PAGE_PORT,
    token: REVEAL_TOKEN,
    buttonText: REVEAL_BUTTON_TEXT,
    tokenMarker: REVEAL_TOKEN_MARKER,
  });
  // Wait for the bind (the fallback port path binds asynchronously).
  await page.ready();
  fixturePageSingleton = { port: page.port };
  void proof;
  return fixturePageSingleton;
}

/**
 * The PPR-024 worker-shipped deployment seam factory: the PPR-018A
 * harness composition (`createRuntimeRegistry` with the Browser Use driver
 * registered + `createDemoRunService`) wrapped as the Demo Mirror run
 * executor the dashboard's POST route hands to `demoMirrorRunHandler`.
 * Every authorization gate (derived status, pinned-runtime binding,
 * registry resolution, exact pins, credential erasure) stays the
 * harness's own — this factory only wires the certified pieces
 * together. The Lead binds it at merge; the worker ships it as surface.
 */
export function createBrowserUseDemoRunExecutor(): DemoRunExecutor {
  const registry = createRuntimeRegistry({ drivers: [browserUsePinnedRuntimeDriver] });
  const service = createDemoRunService({
    registry,
    traceSource: browserUseDemoTraceSource(),
    credentialEnvVarNames: PROVIDER_CREDENTIAL_ENV_NAMES,
    now: () => new Date().toISOString(),
  });
  return {
    run: (entry, record, inventory) => service.run(entry, record, inventory ?? null),
  };
}
