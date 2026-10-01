/**
 * The PPR-022 Hermes-Agent pinned-runtime driver — the PPR-018A plug-in surface
 * (`compat/harness/runtime.ts`'s `definePinnedRuntime` discipline), shipped
 * as worker surface for the Tech Lead's merge-time binding (the same
 * provenance-disclosed pattern PPR-019/PPR-020 established: the Lead
 * registers this driver through `createRuntimeRegistry` +
 * `createDemoRunService` at the deployment seam — the worker never
 * activates their own demo).
 *
 * It composes the worker's EXISTING proof pieces verbatim — no adapter or
 * harness logic is reimplemented:
 *
 *  - `composeProofStack` (harness/compose.ts): the real Zeck public API
 *    composed in-process (the platform suites' own `seedApiWorld`) + the
 *    real model gateway over the sandbox's multi-surface GLM supply rail +
 *    the rail worker driving every created execution through the
 *    executions authority's public transitions;
 *  - `createAdapterServer` (adapter/server.ts): the local multi-surface
 *    OpenAI-compatible endpoint whose ONLY backend is the Zeck public API
 *    — the ACR-007 Application Delegation Boundary the unmodified pinned
 *    Hermes runtime points at (model.provider=custom + the media tools'
 *    OpenAI-compatible backends);
 *  - `createEgressProxy` (harness/egress-proxy.ts): the default-deny
 *    proof-environment egress control for the Hermes runtime;
 *  - `runCorpus` (harness/corpus-runner.ts): one representative corpus
 *    task executed through the REAL pinned Hermes runtime inside the
 *    certified proof environment (credential-scrubbed allowlist
 *    environment + deny proxy + the app's own configuration surface),
 *    verified mechanically;
 *  - `createSdkTraceSource` (harness/trace.ts): the read-only public SDK
 *    wire reads the PPR-018A demo-run service correlates through.
 *
 * The driver is a TRANSLATION boundary only (ports/runtime.ts / ACR-007
 * §1): demo task → the corpus's own declared representative task
 * (implement-edit — the task the bound demo entry names) → the pinned
 * Hermes runtime → the corpus's mechanical verification →
 * TaskRunOutcome. It adds NO provider selection, retry routing, budget
 * accounting, verification or optimization logic — those stay with Zeck.
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
import { CORPUS_TASKS, type CorpusTask } from "../corpus/tasks";
import {
  HERMES_UPSTREAM_REPOSITORY,
  HERMES_UPSTREAM_REVISION,
} from "../graph/execution-graph";
import { type CorpusTaskOutcome, runCorpus, hermesVenvPresent, HERMES_VENV_DIR, PROVIDER_CREDENTIAL_ENV_NAMES } from "../harness/corpus-runner";
import { composeProofStack, type ProofStack, type RailExecutionFact } from "../harness/compose";
import { createEgressProxy } from "../harness/egress-proxy";
import { createSdkTraceSource } from "../harness/trace";

/** The registry id (the Demo Mirror entry's runBinding.runtime names THIS). */
export const HERMES_RUNTIME_ID = "compat/hermes-agent";

/**
 * The Zeck integration revision this binding pins (the PPR-022 Lead
 * binding re-pins the worker's proof-time placeholder to the governed
 * delivery base 241f162b24bcdd0e4a1b1c724425f7ccc39ccc4d — the exact
 * main head the PPR-022 branch was cut from and merges onto. A different
 * pin is a different object — never an update; class precedent: the
 * PPR-019/PPR-020 bindings' re-pins).
 */
export const HERMES_INTEGRATION_REVISION = "241f162b24bcdd0e4a1b1c724425f7ccc39ccc4d";

/**
 * The Zeck application identity the certified proof composition's
 * executions run under — the applicationId the bound evidence record
 * pins (the battery's composed world: the process's first seeded
 * application). The started session reports the environment's ACTUAL
 * application id in its descriptor; the harness verifies it against the
 * record's binding on every run (a mismatch is a named refusal).
 */
const HERMES_APPLICATION_ID = "00000000-0000-7000-8000-00000000b001";

/** The exact pins this driver starts (must equal the bound record's). */
const HERMES_PIN: RevisionPin = {
  upstreamRevision: HERMES_UPSTREAM_REVISION,
  integrationRevision: HERMES_INTEGRATION_REVISION,
};

/** Where demo-run workspaces live (per-run subdirectories under this root). */
const DEMO_WORK_ROOT = process.env.PPR_022_DEMO_WORK_ROOT ?? join(tmpdir(), "ppr-022-demo");

/** The supply pacing the certified battery used (the rail's dispatch interval). */
const SUPPLY_PACING_MS = 1600;

/**
 * The representative corpus task a certified demo run executes: the
 * corpus's own declaration (the bound demo entry's representative task
 * names implement-edit — a real code edit through the agent's file +
 * terminal tool path, verified mechanically by the corpus's own check).
 * The task's own mechanical verification IS the TaskRunOutcome's success
 * check — never a Zeck verification authority.
 */
const REPRESENTATIVE_CORPUS_TASK: CorpusTask | undefined = CORPUS_TASKS.find(
  (task) => task.taskId === "implement-edit",
);

/** The composed certified proof environment (the shared pinned runtime). */
interface HermesProofEnvironment {
  readonly stack: ProofStack;
  readonly adapter: AdapterServer;
  readonly workRoot: string;
}

/** The lazily-composed singleton (ONE exact application + integration revision pair per process). */
let environment: Promise<HermesProofEnvironment> | null = null;

/**
 * Compose (or attach to) the certified proof environment. The first
 * caller composes; a failed composition is retryable (never cached as
 * broken). This is the worker's own battery composition — the same
 * pieces `run-battery.ts` starts, kept warm for the deployment.
 */
function hermesProofEnvironment(): Promise<HermesProofEnvironment> {
  if (environment === null) {
    const composed = (async (): Promise<HermesProofEnvironment> => {
      mkdirSync(DEMO_WORK_ROOT, { recursive: true });
      const stack = await composeProofStack({ minDispatchIntervalMs: SUPPLY_PACING_MS });
      const adapter = await createAdapterServer({
        apiBaseUrl: stack.apiBaseUrl,
        token: stack.apiToken,
        applicationId: stack.applicationId,
      });
      return { stack, adapter, workRoot: DEMO_WORK_ROOT };
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
export function hermesDemoTraceSource(): ZeckTraceSource {
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
  proof: HermesProofEnvironment,
): TaskRunOutcome {
  // The rail facts of THIS run's executions only (the shared environment
  // accumulates facts across runs; the outcome's execution ids scope it).
  const executionIds = new Set(outcome.edgeExecutions.map((edge) => edge.executionId));
  const railFacts = proof.stack.railFacts().filter((fact) => executionIds.has(fact.executionId));
  const factsByExecution = new Map<string, RailExecutionFact[]>();
  for (const fact of railFacts) {
    const list = factsByExecution.get(fact.executionId) ?? [];
    list.push(fact);
    factsByExecution.set(fact.executionId, list);
  }
  const terminals = new Map(
    proof.adapter
      .requests()
      .filter((log) => executionIds.has(log.executionId))
      .map((log) => [log.executionId, log.terminal] as const),
  );

  const edgeExecutions: EdgeExecutionObservation[] = outcome.edgeExecutions.map((edge) => {
    const facts = factsByExecution.get(edge.executionId) ?? [];
    const usage =
      facts.length === 0
        ? null
        : {
            inputTokens: facts.reduce((sum, fact) => sum + (fact.usage?.inputTokens ?? 0), 0),
            outputTokens: facts.reduce((sum, fact) => sum + (fact.usage?.outputTokens ?? 0), 0),
          };
    const latencyMs = facts.length === 0 ? null : facts.reduce((sum, fact) => sum + (fact.latencyMs ?? 0), 0);
    return {
      edgeId: edge.edgeId,
      executionId: edge.executionId,
      outcome: edgeOutcomeOf(terminals.get(edge.executionId)),
      latencyMs,
      ...(usage === null ? {} : { usage }),
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

  const retries = [...factsByExecution.values()].reduce(
    (sum, facts) => sum + Math.max(0, facts.length - 1),
    0,
  );
  const tail = outcome.stdoutTail
    .slice(-400)
    .replace(/\s+/g, " ")
    .trim();

  return {
    taskId: task.taskId,
    succeeded: outcome.resolved,
    detail:
      `Representative corpus task ${REPRESENTATIVE_CORPUS_TASK?.taskId ?? "implement-edit"}` +
      ` executed through the pinned unmodified Hermes-Agent runtime (upstream ${HERMES_UPSTREAM_REVISION})` +
      ` with Zeck as its sole AI execution authority: the corpus's mechanical verification ` +
      `${outcome.resolved ? "PASSED" : "FAILED"} (${outcome.checkOutput}); driver exit code ` +
      `${outcome.exitCode}${outcome.timedOut ? " (wall-clock timeout hit)" : ""}; ` +
      `${outcome.edgeExecutions.length} delegated edge execution(s) through the Zeck public API ` +
      `(${outcome.railUsage.dispatches} rail dispatch(es), ${outcome.railUsage.failures} provider ` +
      `failure(s)); egress ${egressObservation.status} under the default-deny proof control.` +
      (tail.length === 0 ? "" : ` Hermes output tail: ${tail}`),
    durationMs: outcome.durationMs,
    edgeExecutions,
    failureCount: outcome.railUsage.failures,
    retryCount: retries,
    egressObservation,
    unavailable: null,
  };
}

/**
 * The Hermes-Agent pinned-runtime driver (the PPR-018A plug-in). Registered by
 * the deployment composition through `createRuntimeRegistry`; started
 * only by the harness's corpus runner or demo-run service (both verify
 * the binding before and after every start).
 */
export const hermesPinnedRuntimeDriver: PinnedRuntimeDriver = definePinnedRuntime({
  runtimeId: HERMES_RUNTIME_ID,
  identity: {
    name: "Hermes-Agent",
    repository: HERMES_UPSTREAM_REPOSITORY,
    applicationId: HERMES_APPLICATION_ID,
  },
  pin: HERMES_PIN,
  start: async (context) => {
    // The driver verifies the binding it was handed (fail-closed — the
    // harness re-verifies both the driver's pins and the started
    // session's descriptor; a mismatched start is refused here too).
    const bindingIssues = runtimeBindingIssues(
      { applicationId: context.expectedApplicationId, pin: context.expectedPin },
      { applicationId: HERMES_APPLICATION_ID, pin: HERMES_PIN },
    );
    if (bindingIssues.length > 0) {
      throw new Error(
        `the Hermes-Agent pinned runtime refuses to start against a mismatched binding: ${bindingIssues
          .map((issue) => issue.issue)
          .join("; ")}`,
      );
    }
    const proof = await hermesProofEnvironment();
    const proxy = await createEgressProxy();
    // Credential-presence facts of the composing environment (NAMES +
    // booleans, never values — the same observation the battery records
    // as the scrub basis). The Hermes child receives the
    // credential-scrubbed allowlist environment by construction
    // (corpus-runner); a credential-bearing deployment is refused by the
    // harness's erasure gate.
    const environmentFacts = PROVIDER_CREDENTIAL_ENV_NAMES.map((name) => ({
      envVarName: name,
      present: typeof process.env[name] === "string" && (process.env[name] ?? "").length > 0,
    }));
    let stopped = false;
    const session: PinnedRuntimeSession = {
      descriptor: {
        runtimeId: HERMES_RUNTIME_ID,
        applicationId: proof.stack.applicationId,
        pin: HERMES_PIN,
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
        if (REPRESENTATIVE_CORPUS_TASK === undefined) {
          return notRunOutcome(
            task,
            startedAt,
            "the declared corpus carries no implement-edit representative task — the demo cannot translate the task",
            "worker",
          );
        }
        if (!hermesVenvPresent(HERMES_VENV_DIR)) {
          return notRunOutcome(
            task,
            startedAt,
            `the pinned Hermes venv is absent at ${HERMES_VENV_DIR} (expected upstream revision ${HERMES_UPSTREAM_REVISION}) — build it per the demo entry's reproducibility instructions`,
            "deployment",
          );
        }
        const activeProof = await hermesProofEnvironment();
        // A fresh workspace per demo run: every run is a real new
        // Hermes agent execution over the corpus's own representative task.
        const runRoot = join(
          activeProof.workRoot,
          `run-${task.taskId.replace(/[^a-z0-9-]+/gi, "-")}-${startedAt}`,
        );
        const [outcome] = await runCorpus(
          {
            adapter: activeProof.adapter,
            proxy,
            workspaceRoot: runRoot,
            railFacts: activeProof.stack.railFacts,
          },
          [REPRESENTATIVE_CORPUS_TASK],
        );
        if (outcome === undefined) {
          return notRunOutcome(
            task,
            startedAt,
            "the corpus runner produced no outcome for the representative task",
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
        proxy.close();
      },
    };
    return session;
  },
});

/**
 * The PPR-022 worker-shipped deployment seam factory: the PPR-018A
 * harness composition (`createRuntimeRegistry` with the Hermes driver
 * registered + `createDemoRunService`) wrapped as the Demo Mirror run
 * executor the dashboard's POST route hands to `demoMirrorRunHandler`.
 * Every authorization gate (derived status, pinned-runtime binding,
 * registry resolution, exact pins, credential erasure) stays the
 * harness's own — this factory only wires the certified pieces
 * together. The Lead binds it at merge; the worker ships it as surface.
 */
export function createHermesDemoRunExecutor(): DemoRunExecutor {
  const registry = createRuntimeRegistry({ drivers: [hermesPinnedRuntimeDriver] });
  const service = createDemoRunService({
    registry,
    traceSource: hermesDemoTraceSource(),
    credentialEnvVarNames: PROVIDER_CREDENTIAL_ENV_NAMES,
    now: () => new Date().toISOString(),
  });
  return {
    run: (entry, record, inventory) => service.run(entry, record, inventory ?? null),
  };
}
