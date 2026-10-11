/**
 * The PPR-028A Aider pinned-runtime driver — the PPR-018A plug-in
 * surface (`compat/harness/runtime.ts`'s `definePinnedRuntime`
 * discipline), shipped as Worker A's surface for the Tech Lead's
 * merge-time binding and certification (PPR-028 Section B — the repair
 * of PPR-018's missing Demo Mirror activation; the exact worker-shipped
 * pattern PPR-020 through PPR-026 established: the worker ships the
 * driver and the executor factory, the Lead binds at the deployment
 * seam and owns final certification).
 *
 * PROVENANCE (disclosed): this file composes the PPR-018 worker's
 * EXISTING proof pieces verbatim — no adapter or harness logic is
 * reimplemented, and no second execution plane is added:
 *
 *  - `composeProofStack` (harness/compose.ts): the real Zeck public API
 *    composed in-process (the platform suites' own `seedApiWorld`) + the
 *    real model gateway over the sandbox's GLM supply rail + the rail
 *    worker driving every created execution through the executions
 *    authority's public transitions;
 *  - `createAdapterServer` (adapter/server.ts): the local
 *    OpenAI-compatible endpoint whose ONLY backend is the Zeck public
 *    API — the ACR-007 Application Delegation Boundary Aider's
 *    unmodified LiteLLM `openai/` provider points at;
 *  - `createEgressProxy` (harness/egress-proxy.ts): the default-deny
 *    proof-environment egress control wrapping the Aider runtime's
 *    outbound traffic;
 *  - `runCorpus` (harness/corpus-runner.ts): the representative corpus
 *    task executed through the REAL pinned Aider binary inside the
 *    certified proof environment (credential-scrubbed allowlist
 *    subprocess environment + deny proxy + isolated fresh git repo),
 *    verified mechanically by the task's own check script;
 *  - `createSdkTraceSource` (harness/trace.ts): the read-only public
 *    SDK wire reads the PPR-018A demo-run service correlates through.
 *
 * The driver is a TRANSLATION boundary only (ports/runtime.ts /
 * ACR-007 §1): demo task → the corpus's own declared representative
 * task (implement-function — the task the bound demo entry names) → the
 * pinned Aider runtime → the corpus's mechanical verification →
 * TaskRunOutcome. It adds NO provider selection, retry routing, budget
 * accounting, verification or optimization logic — those stay with
 * Zeck.
 *
 * EXACT-REVISION GATE (binding law): before every task execution the
 * driver verifies the pinned venv's `aider --version` output carries
 * the pinned upstream revision's own git-describe build tag
 * (`+g5dc9490bb` — the exact-commit marker of
 * 5dc9490bb35f9729ef2c95d00a19ccd30c26339c; the devNN counter varies
 * with the installer's tag base, the +g<short-sha> segment does not).
 * An absent or revision-mismatched runtime is an honest NOT-RUN refusal
 * with the owner named — never a fixture success, never a downgrade to
 * a synthetic response.
 *
 * LIFECYCLE: the certified proof environment (the in-process Zeck
 * public API + the adapter — ONE exact application + integration
 * revision pair) is composed LAZILY on the first certified start and
 * kept warm for the process's lifetime; nothing runs at dashboard
 * construction time (the executor factory only creates the registry
 * and the demo-run service — plain in-memory objects). Every `start()`
 * returns a session over that shared environment; a session's `stop()`
 * ends the session (a stopped session executes nothing) without
 * tearing down the certified plane. The harness's own gates (exact
 * pins, session-descriptor re-verification, credential erasure) run on
 * every session — this driver never substitutes its own authorization
 * for them.
 */

import { existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type DemoRunExecutor,
  type EdgeExecutionObservation,
  type EgressObservation,
  type EgressViolation,
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
import type { AdapterRequestLog, AdapterServer } from "../adapter/server";
import { createAdapterServer } from "../adapter/server";
import { CODING_CORPUS, type CorpusTask } from "../corpus/tasks";
import { AIDER_PINNED_REVISION, AIDER_REPOSITORY } from "../graph/execution-graph";
import {
  AIDER_VENV,
  type CorpusRunOutcome,
  PROVIDER_CREDENTIAL_ENV_NAMES,
  runCorpus,
  runProcess,
} from "../harness/corpus-runner";
import { composeProofStack, type ProofStack, type RailExecutionFact } from "../harness/compose";
import type { EgressProxy } from "../harness/egress-proxy";
import { createEgressProxy } from "../harness/egress-proxy";
import { createSdkTraceSource } from "../harness/trace";

/** The registry id (the Demo Mirror entry's runBinding.runtime names THIS). */
export const AIDER_RUNTIME_ID = "compat/aider";

/**
 * The Zeck integration revision this binding pins: the PPR-018
 * delivery's recorded integration revision (the worker's proof-time
 * branch head the Lead-reconstructed PR #158 merged — the exact
 * `evidenceRecord.pinnedApplication.pin.integrationRevision` of
 * deploy/evidence/ppr-018.json). The driver, the entry's
 * reproducibility block and the bound record all pin the SAME value; a
 * different pin is a different object — never an update (the Lead may
 * re-pin at certification, class precedent: the PPR-019 binding's
 * 51fdd3d re-pin).
 */
export const AIDER_INTEGRATION_REVISION = "ac2002b129e85476363ba23ee253b76ec880a016";

/**
 * The Zeck application identity the certified proof composition's
 * executions run under — the applicationId the bound evidence record
 * pins (the battery's composed world: the process's first seeded
 * application). The started session reports the environment's ACTUAL
 * application id in its descriptor; the harness verifies it against
 * the record's binding on every run (a mismatch is a named refusal,
 * never a best-effort run).
 */
const AIDER_APPLICATION_ID = "00000000-0000-7000-8000-00000000b001";

/** The exact pins this driver starts (must equal the bound record's). */
const AIDER_PIN: RevisionPin = {
  upstreamRevision: AIDER_PINNED_REVISION,
  integrationRevision: AIDER_INTEGRATION_REVISION,
};

/**
 * The exact-commit build tag the pinned runtime's `aider --version`
 * output must carry (the git-describe `+g<short-sha>` segment of the
 * pinned upstream revision 5dc9490bb35f9729ef2c95d00a19ccd30c26339c —
 * the marker that names the exact commit, independent of the devNN
 * counter the installer's tag base produces).
 */
export const AIDER_PINNED_BUILD_TAG = "+g5dc9490bb";

/**
 * The pinned runtime's own version stamp as THIS binding's certified
 * venv reports it (verified 2026-10-11 on the PPR-028A sandbox:
 * `/home/z/my-project/.venv-aider/bin/aider --version` →
 * `aider 0.86.3.dev53+g5dc9490bb`; the PPR-018 worker's environment
 * reported the same commit with a dev92 counter — the +g build tag is
 * the exact-commit assertion, the counter is installer tag-base
 * variance).
 */
export const AIDER_PINNED_VERSION_STAMP = "0.86.3.dev53+g5dc9490bb";

/** Where demo-run workspaces live (per-run subdirectories under this root). */
const DEMO_WORK_ROOT = process.env.PPR_018_DEMO_WORK_ROOT ?? join(tmpdir(), "ppr-018-demo");

/** The supply pacing the certified battery used (the rail's dispatch interval). */
const SUPPLY_PACING_MS = 4_000;

/**
 * The representative corpus task a certified demo run executes: the
 * corpus's own declaration (the bound demo entry's representative task
 * names implement-function — a real function implementation from a
 * spec, verified mechanically by the corpus's own check script). The
 * task's own mechanical verification IS the TaskRunOutcome's success
 * check — never a Zeck verification authority.
 */
const REPRESENTATIVE_CORPUS_TASK: CorpusTask | undefined = CODING_CORPUS.find(
  (task) => task.id === "implement-function",
);

/** The composed certified proof environment (the shared pinned runtime). */
interface AiderProofEnvironment {
  readonly stack: ProofStack;
  readonly adapter: AdapterServer;
  readonly workRoot: string;
}

/** The lazily-composed singleton (ONE exact application + integration revision pair per process). */
let environment: Promise<AiderProofEnvironment> | null = null;

/**
 * Compose (or attach to) the certified proof environment. The first
 * caller composes; a failed composition is retryable (never cached as
 * broken). This is the worker's own battery composition — the same
 * pieces `run-battery.ts` starts, kept warm for the deployment.
 */
function aiderProofEnvironment(): Promise<AiderProofEnvironment> {
  if (environment === null) {
    const composed = (async (): Promise<AiderProofEnvironment> => {
      mkdirSync(DEMO_WORK_ROOT, { recursive: true });
      const stack = await composeProofStack({ minDispatchIntervalMs: SUPPLY_PACING_MS });
      const adapter = await createAdapterServer({
        apiBaseUrl: stack.apiBaseUrl,
        token: stack.world.bearerToken,
        applicationId: stack.world.applicationId,
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

// ---------------------------------------------------------------------------
// The exact-revision gate (asserted on every run, never assumed)
// ---------------------------------------------------------------------------

/**
 * The pinned runtime's version-stamp matcher: does a `aider --version`
 * output carry the pinned revision's exact-commit build tag AS A
 * COMPLETE short-sha (not a prefix of a longer, different sha)? The
 * tag must end at a non-hex boundary — end of output, or a separator
 * such as the `.dirty` suffix setuptools_scm appends on dirty trees
 * of the pinned commit (still the pinned commit). A longer sha that
 * merely STARTS with `+g5dc9490bb` names a DIFFERENT commit and never
 * matches (the exactness the EXACT-REVISION GATE requires).
 */
const PINNED_BUILD_TAG_PATTERN = new RegExp(
  `${AIDER_PINNED_BUILD_TAG.replace(/[.+*?^${}()|[\]\\]/g, "\\$&")}(?![0-9a-f])`,
);

/** Does a `aider --version` output carry the pinned revision's exact-commit build tag? */
export function pinnedAiderVersionMatches(reportedVersionOutput: string): boolean {
  // The pinned revision's git-describe build tag (e.g. "aider
  // 0.86.3.dev53+g5dc9490bb") — the +g<short-sha> segment names the
  // exact commit the venv must have installed, matched as a complete
  // tag (see PINNED_BUILD_TAG_PATTERN above).
  return PINNED_BUILD_TAG_PATTERN.test(reportedVersionOutput);
}

/** The exact-revision verification's honest result (fail-closed, cause named). */
export interface PinnedAiderRevisionCheck {
  readonly ok: boolean;
  /** The version output the runtime reported (null when it could not run). */
  readonly reported: string | null;
  /** The honest refusal cause (empty when ok). */
  readonly cause: string;
}

/**
 * Verify the pinned Aider venv is installed at the exact pinned
 * upstream revision: the venv's own `aider --version` output must carry
 * the pinned revision's git-describe build tag. An absent venv, a
 * binary that cannot run, or a mismatched revision each refuse with a
 * named cause — a mismatched runtime is NEVER executed.
 */
export async function verifyPinnedAiderRevision(options: {
  readonly venvPath?: string;
} = {}): Promise<PinnedAiderRevisionCheck> {
  const venvPath = options.venvPath ?? AIDER_VENV;
  const binary = join(venvPath, "bin", "aider");
  if (!existsSync(binary)) {
    return {
      ok: false,
      reported: null,
      cause:
        `the pinned Aider venv is absent at ${venvPath} (expected upstream revision ${AIDER_PINNED_REVISION}) — ` +
        `install it per the demo entry's reproducibility instructions (python3 -m venv + pip install -e from the exact commit)`,
    };
  }
  const versionHome = join(tmpdir(), `ppr-018-aider-version-${process.pid}`);
  mkdirSync(versionHome, { recursive: true });
  const result = await runProcess(
    binary,
    ["--version"],
    versionHome,
    {
      PATH: `${venvPath}/bin:/usr/local/bin:/usr/bin:/bin`,
      HOME: versionHome,
      LC_ALL: "C.UTF-8",
      GIT_TERMINAL_PROMPT: "0",
      PYTHONUNBUFFERED: "1",
    },
    "",
    60_000,
  );
  const reported = `${result.stdout}${result.stderr}`.trim();
  if (result.exitCode !== 0 || reported.length === 0) {
    return {
      ok: false,
      reported: reported.length === 0 ? null : reported,
      cause:
        `the pinned Aider binary at ${binary} failed to report its version (exit code ${result.exitCode}) — ` +
        `the runtime's exact revision cannot be verified, so it is never executed`,
    };
  }
  if (!pinnedAiderVersionMatches(reported)) {
    return {
      ok: false,
      reported,
      cause:
        `the installed Aider reports version "${reported}" which does not carry the pinned upstream revision's ` +
        `build tag ${AIDER_PINNED_BUILD_TAG} (pinned revision ${AIDER_PINNED_REVISION}) — a revision-mismatched runtime is refused, never executed, and never replaced with a synthetic response`,
    };
  }
  return { ok: true, reported, cause: "" };
}

// ---------------------------------------------------------------------------
// The session surfaces
// ---------------------------------------------------------------------------

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
 * start; before that (or on a composition failure) every read is the
 * honest not-found read.
 */
export function aiderDemoTraceSource(): ZeckTraceSource {
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
          token: composed.stack.world.bearerToken,
          applicationId: composed.stack.world.applicationId,
        });
        return await source.readExecutionTrace(applicationId, executionId);
      } catch {
        return TRACE_READ_NOT_FOUND;
      }
    },
  };
}

/**
 * The provider-credential presence facts of the COMPOSING environment
 * (env-var NAMES + booleans, never values — the same observation the
 * battery records as the scrub basis). The Aider child receives the
 * credential-scrubbed allowlist environment by construction
 * (corpus-runner's scrubbedAiderEnv — the single provider-shaped
 * variable it carries is the disclosed LiteLLM client-side
 * placeholder, recorded in the bound record's limitations); a
 * credential-bearing deployment is refused by the harness's erasure
 * gate. Pure over the injected source.
 */
export function aiderEnvironmentFacts(
  source: Readonly<Record<string, string | undefined>> = process.env,
): { readonly envVarName: string; readonly present: boolean }[] {
  return PROVIDER_CREDENTIAL_ENV_NAMES.map((name) => ({
    envVarName: name,
    present: typeof source[name] === "string" && (source[name] ?? "").length > 0,
  }));
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
  outcome: CorpusRunOutcome,
  proof: AiderProofEnvironment,
  runLogs: readonly AdapterRequestLog[],
  runViolations: readonly EgressViolation[],
): TaskRunOutcome {
  // The rail facts of THIS run's executions only (the shared
  // environment accumulates facts across runs; the run's request logs
  // scope it — the adapter's own per-request execution log, further
  // stamped by the corpus runner's run context).
  const executionIds = new Set(runLogs.map((log) => log.executionId));
  const railFacts = proof.stack.railFacts().filter((fact) => executionIds.has(fact.executionId));
  const factsByExecution = new Map<string, RailExecutionFact[]>();
  for (const fact of railFacts) {
    const list = factsByExecution.get(fact.executionId) ?? [];
    list.push(fact);
    factsByExecution.set(fact.executionId, list);
  }

  const edgeExecutions: EdgeExecutionObservation[] = runLogs.map((log) => {
    const facts = factsByExecution.get(log.executionId) ?? [];
    const usage =
      facts.length === 0
        ? null
        : {
            inputTokens: facts.reduce((sum, fact) => sum + (fact.usage?.inputTokens ?? 0), 0),
            outputTokens: facts.reduce((sum, fact) => sum + (fact.usage?.outputTokens ?? 0), 0),
          };
    const latencyMs =
      facts.length === 0 ? null : facts.reduce((sum, fact) => sum + (fact.latencyMs ?? 0), 0);
    return {
      edgeId: log.edgeId,
      executionId: log.executionId,
      outcome: edgeOutcomeOf(log.terminal),
      latencyMs,
      ...(usage === null ? {} : { usage }),
      // The rail reports no micro-USD price (the battery's honest
      // cost-per-resolved-outcome boundary) — null, never fabricated.
      costMicroUsd: null,
    };
  });

  const violations = [...runViolations];
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
  const failedExecutions = runLogs.filter((log) => log.terminal !== "COMPLETED").length;
  const tail = outcome.aiderTail
    .slice(-400)
    .replace(/\s+/g, " ")
    .trim();

  return {
    taskId: task.taskId,
    succeeded: outcome.resolved,
    detail:
      `Representative corpus task ${REPRESENTATIVE_CORPUS_TASK?.id ?? "implement-function"}` +
      ` executed through the pinned unmodified Aider binary (upstream ${AIDER_PINNED_REVISION},` +
      ` version ${AIDER_PINNED_VERSION_STAMP}) with Zeck as its sole AI execution authority: the corpus's ` +
      `mechanical verification ${outcome.resolved ? "PASSED" : "FAILED"} (${outcome.checkOutput}); ` +
      `Aider exit code ${outcome.aiderExitCode}; ${outcome.commitCount} commit(s); ` +
      `${runLogs.length} delegated edge execution(s) through the Zeck public API ` +
      `(${failedExecutions} failed execution(s), ${retries} rail re-dispatch(s)); egress ` +
      `${egressObservation.status} under the default-deny proof control.` +
      (tail.length === 0 ? "" : ` Aider output tail: ${tail}`),
    durationMs: outcome.durationMs,
    edgeExecutions,
    failureCount: failedExecutions,
    retryCount: retries,
    egressObservation,
    unavailable: null,
  };
}

/**
 * The Aider pinned-runtime driver (the PPR-018A plug-in). Registered by
 * the deployment composition through `createRuntimeRegistry`; started
 * only by the harness's corpus runner or demo-run service (both verify
 * the binding before and after every start).
 */
export const aiderPinnedRuntimeDriver: PinnedRuntimeDriver = definePinnedRuntime({
  runtimeId: AIDER_RUNTIME_ID,
  identity: {
    name: "Aider",
    repository: AIDER_REPOSITORY,
    applicationId: AIDER_APPLICATION_ID,
  },
  pin: AIDER_PIN,
  start: async (context) => {
    // The driver verifies the binding it was handed (fail-closed — the
    // harness re-verifies both the driver's pins and the started
    // session's descriptor; a mismatched start is refused here too).
    const bindingIssues = runtimeBindingIssues(
      { applicationId: context.expectedApplicationId, pin: context.expectedPin },
      { applicationId: AIDER_APPLICATION_ID, pin: AIDER_PIN },
    );
    if (bindingIssues.length > 0) {
      throw new Error(
        `the Aider pinned runtime refuses to start against a mismatched binding: ${bindingIssues
          .map((issue) => issue.issue)
          .join("; ")}`,
      );
    }
    const proof = await aiderProofEnvironment();
    // The session's own default-deny egress proxy (the proof
    // environment's egress control for the Aider runtime; closed with
    // the session).
    const proxy: EgressProxy = await createEgressProxy();
    // Credential-presence facts of the composing environment (NAMES +
    // booleans, never values — the same observation the battery
    // records as the scrub basis). The Aider child receives the
    // credential-scrubbed allowlist environment by construction
    // (corpus-runner); a credential-bearing deployment is refused by
    // the harness's erasure gate.
    const environmentFacts = aiderEnvironmentFacts();
    let stopped = false;
    const session: PinnedRuntimeSession = {
      descriptor: {
        runtimeId: AIDER_RUNTIME_ID,
        applicationId: proof.stack.world.applicationId,
        pin: AIDER_PIN,
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
            "the declared corpus carries no implement-function representative task — the demo cannot translate the task",
            "worker",
          );
        }
        // THE EXACT-REVISION GATE: the pinned runtime's own version
        // output must carry the pinned revision's exact-commit build
        // tag — asserted on every run, never assumed. An absent or
        // mismatched runtime refuses honestly (never a fixture
        // success, never a synthetic response).
        const revision = await verifyPinnedAiderRevision();
        if (!revision.ok) {
          return notRunOutcome(task, startedAt, revision.cause, "deployment");
        }
        const activeProof = await aiderProofEnvironment();
        // A fresh workspace per demo run: every run is a real new
        // Aider execution over the corpus's own representative task.
        const runRoot = join(
          activeProof.workRoot,
          `run-${task.taskId.replace(/[^a-z0-9-]+/gi, "-")}-${startedAt}`,
        );
        // This run's adapter requests + egress violations (the shared
        // environment accumulates both across runs; the deltas scope
        // the observation to THIS run, further filtered by the corpus
        // runner's own run-context stamp on each request log).
        const logsBefore = activeProof.adapter.requests().length;
        const violationsBefore = proxy.violations().length;
        const [outcome] = await runCorpus(
          {
            adapter: activeProof.adapter,
            proxy,
            workspaceRoot: runRoot,
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
        const runLogs = activeProof.adapter
          .requests()
          .slice(logsBefore)
          .filter((log) => log.corpusTask === REPRESENTATIVE_CORPUS_TASK.id);
        const runViolations = proxy.violations().slice(violationsBefore);
        return taskRunOutcomeOf(task, outcome, activeProof, runLogs, runViolations);
      },
      async stop() {
        // Ends the SESSION only. The shared certified proof environment
        // (the deployment's pinned runtime) stays composed — the
        // harness stops what it started, and what it started is a
        // session over the exact pinned revision pair, not the plane
        // itself.
        stopped = true;
        proxy.close();
      },
    };
    return session;
  },
});

/**
 * The PPR-028A deployment seam factory: the PPR-018A harness
 * composition (`createRuntimeRegistry` with the Aider driver registered
 * + `createDemoRunService`) wrapped as the Demo Mirror run executor
 * the dashboard's POST route hands to `demoMirrorRunHandler`. Every
 * authorization gate (derived status, pinned-runtime binding, registry
 * resolution, exact pins, credential erasure) stays the harness's own —
 * this factory only wires the certified pieces together (nothing runs
 * at construction time).
 */
export function createAiderDemoRunExecutor(): DemoRunExecutor {
  const registry = createRuntimeRegistry({ drivers: [aiderPinnedRuntimeDriver] });
  const service = createDemoRunService({
    registry,
    traceSource: aiderDemoTraceSource(),
    credentialEnvVarNames: PROVIDER_CREDENTIAL_ENV_NAMES,
    now: () => new Date().toISOString(),
  });
  return {
    run: (entry, record, inventory) => service.run(entry, record, inventory ?? null),
  };
}
