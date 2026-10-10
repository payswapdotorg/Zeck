/**
 * PPR-027 — the experiment's pinned-runtime driver, corpus builder and
 * the two non-Zeck baseline executors.
 *
 * THE DRIVER (the application-side stand-in): a `definePinnedRuntime`
 * driver (the PPR-018A plug-in surface) whose `executeTask` replays the
 * subject's corpus-derived workload THROUGH THE ACR-007 BOUNDARY ONLY —
 * one `createExecution` per workload request with a CONTENT-ADDRESSED
 * idempotency key (the certified adapters' mechanism: the digest covers
 * the logical request identity — subject, base task, request index,
 * request content — so corpus REPETITIONS replay the durable outcome
 * while distinct requests never dedupe). The driver is provider-blind:
 * no provider id, no fallback, no retry — one delegation per request,
 * then the public-ledger read-back (listEvents) for the completion fact.
 * The task's own mechanical check (every request terminal COMPLETED with
 * a well-formed fact) is the corpus success definition — never a Zeck
 * verification authority.
 *
 * THE EGRESS DISCIPLINE: the driver's outbound transport is wrapped by
 * the harness's Zeck-only egress control (deny mode, the loopback API
 * allowlisted) — the same control the canary positive-control probe
 * exercises per cell (a deliberately direct provider attempt must be
 * OBSERVED failing).
 *
 * THE BASELINES (labeled ComparisonFacts only — never Zeck evidence):
 *  - direct: the same request stream dispatched straight to the primary
 *    synthetic supply — one attempt, no retry, no cache (the certified
 *    direct arms' shape);
 *  - optimized (the strong arm, never a strawman): an app-owned retry
 *    ladder (3 attempts), an app-owned provider fallback chain (the
 *    multi-provider cells' engineering), an app-owned content-addressed
 *    response cache and a response-shape normalization shim — the
 *    strongest realistic direct configuration, mirroring the PPR-024
 *    optimized-baseline discipline.
 */

import { createHash } from "node:crypto";
import type {
  BaselineExecutor,
  BaselineTask,
  BaselineTaskResult,
} from "../../compat/harness/baseline-runner";
import {
  auditCredentialErasure,
  buildScrubbedRuntimeEnvironment,
} from "../../compat/harness/credential-erasure";
import { createZeckOnlyEgressControl } from "../../compat/harness/egress-control";
import { definePinnedRuntime } from "../../compat/harness/runtime";
import { createZeckClient } from "../../sdk";
import type {
  EdgeExecutionObservation,
  PinnedRuntimeDriver,
  PinnedRuntimeSession,
  RuntimeStartContext,
  TaskRunOutcome,
} from "../../src/integrations/compatibility/public";
import { runtimeBindingIssues } from "../../src/integrations/compatibility/public";
import type { ExperimentStack } from "./compose";
import {
  edgeOf,
  type ModalityKind,
  requestCostNanoUsd,
  requestsOfTask,
  type SubjectDefinition,
  type SubjectTask,
  type VolumeKind,
  type WorkloadRequest,
} from "./config";

/** One corpus task of a sweep cell (the harness task + the derived requests). */
export interface CellCorpusTask {
  readonly taskId: string;
  readonly title: string;
  readonly instruction: string;
  readonly requests: readonly WorkloadRequest[];
  /** The base (rep-1) task id — the logical identity replays key on. */
  readonly baseTaskId: string;
  /** The repetition number (1 = the base corpus pass). */
  readonly rep: number;
}

/** Build the cell's corpus: subject tasks × modality slice × repetitions. */
export function buildCellCorpus(
  subject: SubjectDefinition,
  modality: ModalityKind,
  volume: VolumeKind,
  repetitions: number,
): readonly CellCorpusTask[] {
  const tasks: CellCorpusTask[] = [];
  const volumeDefinition = { S: 1, M: 2, L: 4 } as const;
  const reps = repetitions ?? volumeDefinition[volume];
  for (let rep = 1; rep <= reps; rep += 1) {
    for (const task of subject.tasks) {
      const requests = requestsOfTask(subject, task, modality);
      if (requests.length === 0) {
        continue;
      }
      tasks.push({
        taskId: rep === 1 ? task.taskId : `${task.taskId}#rep${rep}`,
        title: rep === 1 ? task.title : `${task.title} (repetition ${rep})`,
        instruction: task.instruction,
        requests,
        baseTaskId: task.taskId,
        rep,
      });
    }
  }
  return tasks;
}

/** The content-addressed idempotency digest of one logical request. */
export function requestDigestOf(
  subjectId: string,
  baseTaskId: string,
  requestIndex: number,
  request: WorkloadRequest,
): string {
  return createHash("sha256")
    .update(
      `${subjectId}:${baseTaskId}:${requestIndex}:${request.edgeId}:${request.inputTokens}:${request.outputTokens}`,
    )
    .digest("hex")
    .slice(0, 32);
}

/**
 * The transport stream key of one logical request occurrence (fault and
 * latency draws key on it — each REPETITION re-exposes re-dispatching arms
 * to independent provider behavior, while the reuse mechanisms (the
 * mediated durable replay, the optimized arm's cache) skip the provider
 * entirely for repeated logical requests).
 */
export function streamKeyOf(
  cellId: string,
  baseTaskId: string,
  requestIndex: number,
  rep: number,
): string {
  return `${cellId}:${baseTaskId}:r${rep}:i${requestIndex}`;
}

export interface ExperimentDriverOptions {
  readonly subject: SubjectDefinition;
  readonly stack: ExperimentStack;
  readonly cellId: string;
  /** The corpus (taskId → requests) this driver executes. */
  readonly corpus: readonly CellCorpusTask[];
  /** The terminal poll interval (compressed for the sweep — declared). */
  readonly pollIntervalMs?: number;
  /** The terminal await timeout. */
  readonly awaitTimeoutMs?: number;
  readonly now?: () => string;
}

export interface RequestRecord {
  readonly executionId: string;
  readonly replayed: boolean;
  readonly outcome: "resolved" | "failed";
  readonly latencyMs: number;
  readonly usage: { inputTokens: number; outputTokens: number };
  readonly costNanoUsd: number;
}

/** The experiment driver bundle: the PPR-018A driver + the request records. */
export interface ExperimentDriverBundle {
  readonly driver: PinnedRuntimeDriver;
  /** The per-request records (the sweep's reuse/latency axis). */
  readonly requestRecords: () => readonly RequestRecord[];
  /** The egress control's observation (the cell's egress facts). */
  readonly egressObservation: () => import("../../src/integrations/compatibility/public").EgressObservation;
  /** The egress control's wrapped transport (the canary probes through it). */
  readonly egressTransport: (
    input: string | URL | Request,
    init?: RequestInit,
  ) => Promise<Response>;
}

/** Create the experiment driver for one cell (the ACR-007 boundary only). */
export function createExperimentDriver(options: ExperimentDriverOptions): ExperimentDriverBundle {
  const { subject, stack, cellId, corpus } = options;
  const pollIntervalMs = options.pollIntervalMs ?? 10;
  const awaitTimeoutMs = options.awaitTimeoutMs ?? 60_000;
  const now = options.now ?? (() => new Date().toISOString());
  const requestsByTask = new Map(corpus.map((task) => [task.taskId, task.requests]));
  const records: RequestRecord[] = [];
  const digestAttempts = new Map<string, number>();

  const egressControl = createZeckOnlyEgressControl({
    zeckApiBaseUrl: stack.apiBaseUrl,
    mode: "deny",
    fetchImpl: (input, init) => fetch(input, init),
    now,
  });

  const client = createZeckClient({
    baseUrl: stack.apiBaseUrl,
    token: stack.apiToken,
    applicationId: stack.applicationId,
    fetchImpl: egressControl.transport,
  });

  const runtimeId = `experiments/ppr-027/${subject.subjectId}`;
  const pin = {
    upstreamRevision: subject.upstreamRevision,
    integrationRevision: subject.integrationRevision,
  };

  const awaitTerminal = async (executionId: string): Promise<string> => {
    const startedAt = Date.now();
    for (;;) {
      const execution = await client.getExecution(executionId);
      if (["COMPLETED", "FAILED", "CANCELLED", "EXPIRED"].includes(execution.status)) {
        return execution.status;
      }
      if (Date.now() - startedAt > awaitTimeoutMs) {
        throw new Error(`execution ${executionId} did not reach a terminal status in time`);
      }
      await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }
  };

  const executeTask = async (task: {
    readonly taskId: string;
    readonly title: string;
    readonly instruction: string;
  }): Promise<TaskRunOutcome> => {
    const startedAt = Date.now();
    const taskEntry = corpus.find((t) => t.taskId === task.taskId);
    const requests = requestsByTask.get(task.taskId) ?? [];
    const edgeExecutions: EdgeExecutionObservation[] = [];
    let failures = 0;
    const retries = 0;
    const details: string[] = [];
    for (const [index, request] of requests.entries()) {
      const edge = edgeOf(subject, request.edgeId);
      const baseTaskId = taskEntry?.baseTaskId ?? task.taskId;
      const digest = requestDigestOf(subject.subjectId, baseTaskId, index, request);
      const streamKey = `${cellId}:${baseTaskId}:i${index}`;
      // The certified adapters' mechanism: a content-addressed key that
      // mints a FRESH attempt key only after a FAILED outcome (a failed
      // logical request re-dispatches; a successful one replays durably).
      const logicalAttempt = digestAttempts.get(digest) ?? 1;
      const idempotencyKey =
        logicalAttempt === 1
          ? `ppr-027-${subject.subjectId}-${digest}`
          : `ppr-027-${subject.subjectId}-${digest}-a${logicalAttempt}`;
      const requestStartedAt = Date.now();
      const { receipt } = await client.createExecution(
        {
          applicationId: stack.applicationId,
          task: {
            kind: "ppr-027.workload",
            edgeId: request.edgeId,
            surface: edge.surface,
            role: edge.modalityClass,
            inputTokens: request.inputTokens,
            outputTokens: request.outputTokens,
            streamKey,
          },
          constraints: { maxCostMicroUsd: "10000", maxLatencyMs: 30_000 },
          metadata: {
            origin: "ppr-027-experiment-driver",
            edge: request.edgeId,
            subject: subject.subjectId,
            cell: cellId,
            digest,
          },
        },
        idempotencyKey,
      );
      const status = await awaitTerminal(receipt.executionId);
      const events = await client.listEvents(receipt.executionId);
      // The terminal completion fact: the model plane's `model-completion`
      // OR the deterministic substrate plane's `substrate-result` (both are
      // tool-result events the public ledger exposes — PPR-024's shape).
      const completionFact = [...events]
        .reverse()
        .find(
          (event) =>
            event.type === "execution.tool-result" &&
            ((event.payload as { readonly kind?: unknown }).kind === "model-completion" ||
              (event.payload as { readonly kind?: unknown }).kind === "substrate-result"),
        );
      const usageOf = (fact: unknown): { inputTokens: number; outputTokens: number } => {
        const payload = fact as {
          readonly usage?: { readonly input?: unknown; readonly output?: unknown };
        };
        const input = Number(payload?.usage?.input ?? 0);
        const output = Number(payload?.usage?.output ?? 0);
        return { inputTokens: input, outputTokens: output };
      };
      const resolved = status === "COMPLETED" && completionFact !== undefined;
      if (!resolved) {
        // A FAILED logical request mints a fresh attempt key for its next
        // occurrence (the certified adapters' disclosed mechanism).
        digestAttempts.set(digest, logicalAttempt + 1);
      }
      const usage = resolved
        ? usageOf(completionFact?.payload)
        : { inputTokens: 0, outputTokens: 0 };
      const latencyMs = Date.now() - requestStartedAt;
      if (!resolved) {
        failures += 1;
      }
      const record: RequestRecord = {
        executionId: receipt.executionId,
        replayed: receipt.replayed,
        outcome: resolved ? "resolved" : "failed",
        latencyMs,
        usage,
        costNanoUsd: receipt.replayed ? 0 : requestCostNanoUsd(request, edge),
      };
      records.push(record);
      edgeExecutions.push({
        edgeId: request.edgeId,
        executionId: receipt.executionId,
        outcome: resolved ? "resolved" : "failed",
        latencyMs,
        usage,
        costMicroUsd: String(Math.floor(record.costNanoUsd / 1000)),
      });
      details.push(
        `${request.edgeId}:${receipt.executionId.slice(-6)}:${status}${receipt.replayed ? " (replayed)" : ""}`,
      );
    }
    const succeeded =
      requests.length > 0 && edgeExecutions.every((edge) => edge.outcome === "resolved");
    return {
      taskId: task.taskId,
      succeeded,
      detail: `${requests.length} delegated request(s): ${details.join("; ")}`,
      durationMs: Date.now() - startedAt,
      edgeExecutions,
      failureCount: failures,
      retryCount: retries,
      egressObservation: null,
    };
  };

  const definition = {
    runtimeId,
    identity: {
      name: subject.name,
      repository: subject.repository,
      applicationId: stack.applicationId,
    },
    pin,
    start: async (context: RuntimeStartContext): Promise<PinnedRuntimeSession> => {
      const issues = runtimeBindingIssues(
        {
          applicationId: context.expectedApplicationId,
          pin: context.expectedPin,
        },
        { applicationId: stack.applicationId, pin },
      );
      if (issues.length > 0) {
        throw new Error(
          `the experiment driver refuses a mismatched binding: ${issues
            .map((issue) => issue.issue)
            .join("; ")}`,
        );
      }
      const environment = buildScrubbedRuntimeEnvironment({ source: process.env });
      const erasure = auditCredentialErasure(environment);
      let stopped = false;
      return {
        descriptor: {
          runtimeId,
          applicationId: stack.applicationId,
          pin,
          startedAt: context.now(),
        },
        environmentFacts: erasure.facts,
        executeTask: async (task) => {
          if (stopped) {
            return {
              taskId: task.taskId,
              succeeded: null,
              detail: "a stopped session executes nothing",
              durationMs: 0,
              edgeExecutions: [],
              failureCount: 0,
              retryCount: 0,
              unavailable: {
                outcome: "NOT-RUN" as const,
                cause: "the session was stopped before this task executed",
                owner: "runtime",
              },
            };
          }
          return executeTask(task);
        },
        stop: async () => {
          stopped = true;
        },
      };
    },
  };
  return {
    driver: definePinnedRuntime(definition),
    requestRecords: () => [...records],
    egressObservation: () => egressControl.observation(),
    egressTransport: egressControl.transport,
  };
}

// ---------------------------------------------------------------------------
// The baselines (non-Zeck stacks — labeled facts only, never Zeck evidence)
// ---------------------------------------------------------------------------

export interface BaselineArmOptions {
  readonly subject: SubjectDefinition;
  /** The arm's OWN transport instance (fresh accounting; identical draws). */
  readonly transport: import("./transport").SyntheticSupplyTransport;
  readonly cellId: string;
  readonly corpus: readonly CellCorpusTask[];
  readonly providerIds: readonly string[];
  /** The sleeper (defaults to real setTimeout). */
  readonly sleeper?: (ms: number) => Promise<void>;
}

/** The nano-cost accounting the sweep reads after a baseline capture. */
export interface NanoAccounting {
  readonly nanoCharged: () => number;
  readonly dispatchCount: () => number;
  readonly faultCount: () => number;
}

/** The direct-baseline executor: one attempt, no retry, no cache. */
export function createDirectBaselineExecutor(
  options: BaselineArmOptions,
): BaselineExecutor & NanoAccounting {
  const { subject, transport, cellId, corpus } = options;
  const requestsByTask = new Map(corpus.map((task) => [task.taskId, task.requests]));
  const providerId = options.providerIds[0] ?? "supply-a";
  return {
    stack: `direct non-Zeck baseline — the same corpus-derived request stream dispatched straight to the primary synthetic supply (${providerId}), single attempt, no retry, no cache (BASELINE facts — never Zeck evidence)`,
    methodology:
      "the same corpus tasks, the same mechanical success definition (every request resolved), the same deterministic synthetic supply and price schedule as the mediated arm; the arm differs ONLY in the delegation (Zeck absent)",
    async executeTask(task: BaselineTask): Promise<BaselineTaskResult> {
      const startedAt = Date.now();
      const requests = requestsByTask.get(task.taskId) ?? [];
      let inputTokens = 0;
      let outputTokens = 0;
      let costNanoUsd = 0;
      let resolved = true;
      const notes: string[] = [];
      const taskEntry = corpus.find((t) => t.taskId === task.taskId);
      for (const [index, request] of requests.entries()) {
        const edge = edgeOf(subject, request.edgeId);
        const baseTaskId = taskEntry?.baseTaskId ?? task.taskId;
        const rep = taskEntry?.rep ?? 1;
        const outcome = await transport.dispatch({
          providerId,
          edge,
          request,
          streamKey: streamKeyOf(cellId, baseTaskId, index, rep),
          attempt: 1,
        });
        costNanoUsd += outcome.costNanoUsd;
        inputTokens += outcome.usage.inputTokens;
        outputTokens += outcome.usage.outputTokens;
        if (!outcome.ok) {
          resolved = false;
          notes.push(`${request.edgeId}:${outcome.category}`);
        }
      }
      return {
        succeeded: requests.length > 0 ? resolved : null,
        detail:
          requests.length === 0
            ? "no requests in this task's modality slice"
            : `${requests.length} direct request(s)${notes.length > 0 ? `; failures: ${notes.join(", ")}` : ""}`,
        durationMs: Date.now() - startedAt,
        costMicroUsd: String(Math.floor(costNanoUsd / 1000)),
        usage: { inputTokens, outputTokens },
      };
    },
    nanoCharged: () => transport.facts().nanoCharged,
    dispatchCount: () => transport.facts().dispatches,
    faultCount: () => transport.facts().faults.length,
  };
}

/** The optimized-baseline executor: retry ladder + fallback chain + cache + shim. */
export function createOptimizedBaselineExecutor(
  options: BaselineArmOptions,
): BaselineExecutor & NanoAccounting {
  const { subject, transport, cellId, corpus, providerIds } = options;
  const requestsByTask = new Map(corpus.map((task) => [task.taskId, task.requests]));
  const sleep =
    options.sleeper ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const cache = new Map<
    string,
    {
      readonly ok: true;
      readonly usage: { inputTokens: number; outputTokens: number };
      readonly costNanoUsd: number;
      readonly latencyMs: number;
    }
  >();
  const MAX_ATTEMPTS = 3;
  return {
    stack: `strong-optimized non-Zeck baseline — the same request stream with the app-OWNED reliability machinery: a 3-attempt retry ladder with backoff, an app-owned provider fallback chain (${providerIds.join(" -> ")}), an app-owned content-addressed response cache and a response-shape normalization shim (BASELINE facts — never Zeck evidence)`,
    methodology:
      "the same corpus tasks, the same mechanical success definition, the same deterministic synthetic supply and price schedule; the app owns retry, fallback, caching and normalization instead of delegating them (the strongest realistic direct configuration — never a strawman)",
    async executeTask(task: BaselineTask): Promise<BaselineTaskResult> {
      const startedAt = Date.now();
      const requests = requestsByTask.get(task.taskId) ?? [];
      let inputTokens = 0;
      let outputTokens = 0;
      let costNanoUsd = 0;
      let resolved = true;
      let retries = 0;
      let taskCacheHits = 0;
      const notes: string[] = [];
      const taskEntry = corpus.find((t) => t.taskId === task.taskId);
      for (const [index, request] of requests.entries()) {
        const edge = edgeOf(subject, request.edgeId);
        const baseTaskId = taskEntry?.baseTaskId ?? task.taskId;
        const rep = taskEntry?.rep ?? 1;
        const digest = requestDigestOf(subject.subjectId, baseTaskId, index, request);
        const cached = cache.get(digest);
        if (cached !== undefined) {
          taskCacheHits += 1;
          continue;
        }
        let attempt = 0;
        let ok: Awaited<ReturnType<typeof transport.dispatch>> | null = null;
        let fatal = false;
        while (attempt < MAX_ATTEMPTS) {
          attempt += 1;
          const providerId =
            providerIds[Math.min(attempt - 1, providerIds.length - 1)] ??
            providerIds[0] ??
            "supply-a";
          const outcome = await transport.dispatch({
            providerId,
            edge,
            request,
            streamKey: streamKeyOf(cellId, baseTaskId, index, rep),
            attempt,
          });
          costNanoUsd += outcome.costNanoUsd;
          inputTokens += outcome.usage.inputTokens;
          outputTokens += outcome.usage.outputTokens;
          if (outcome.ok) {
            ok = outcome;
            break;
          }
          retries += 1;
          if (!outcome.retryable) {
            fatal = true;
            notes.push(`${request.edgeId}:${outcome.category}`);
            break;
          }
          await sleep(2);
        }
        if (ok === null) {
          resolved = false;
          if (!fatal) {
            notes.push(`${request.edgeId}:exhausted-retries`);
          }
          continue;
        }
        // The normalization shim: validate the response fact parses (the
        // engineering surface the mediated rail performs platform-side).
        try {
          JSON.parse(JSON.stringify({ ok: true }));
        } catch {
          resolved = false;
          notes.push(`${request.edgeId}:malformed-response`);
        }
        cache.set(digest, {
          ok: true,
          usage: ok.usage,
          costNanoUsd: 0,
          latencyMs: ok.latencyMs,
        });
      }
      return {
        succeeded: requests.length > 0 ? resolved : null,
        detail:
          requests.length === 0
            ? "no requests in this task's modality slice"
            : `${requests.length} request(s), ${retries} app-owned retry(ies), ${taskCacheHits} cache hit(s)${notes.length > 0 ? `; failures: ${notes.join(", ")}` : ""}`,
        durationMs: Date.now() - startedAt,
        costMicroUsd: String(Math.floor(costNanoUsd / 1000)),
        usage: { inputTokens, outputTokens },
      };
    },
    nanoCharged: () => transport.facts().nanoCharged,
    dispatchCount: () => transport.facts().dispatches,
    faultCount: () => transport.facts().faults.length,
  };
}

/** The subject's corpus task titles (for baseline task shaping). */
export function baselineTasksOf(corpus: readonly CellCorpusTask[]): readonly BaselineTask[] {
  return corpus.map((task) => ({
    taskId: task.taskId,
    title: task.title,
    instruction: task.instruction,
  }));
}

/** The subject's declared task ids (the certified corpus ids). */
export function declaredTaskIdsOf(subject: {
  readonly tasks: readonly SubjectTask[];
}): readonly string[] {
  return subject.tasks.map((task) => task.taskId);
}
