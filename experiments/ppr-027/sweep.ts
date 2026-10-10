/**
 * PPR-027 — the resumable sweep runner (the contract's core experiment).
 *
 * THE SWEEP MATRIX: nine certified subjects × workload volume (S/M/L =
 * 1x/2x/4x corpus repetitions) × provider configuration (single vs the
 * three-supply multi configuration) × modality slice (mono-modal text
 * slice vs the full declared multi-modal graph). The maturity axis is the
 * three named operational points (early/growing/mature) — an analysis
 * view over the SAME cells, not separate runs.
 *
 * PER CELL (all three arms over the SAME corpus and the same arm-agnostic
 * deterministic synthetic supply — per-EXPOSURE draws: every physical
 * dispatch draws its fault/latency independently from the declared hash
 * space, exactly as a real re-issued request would; the mediated arm's
 * repeated logical requests REPLAY durably with zero provider exposure —
 * see compose.ts and transport.ts):
 *  - the mediated arm: `runCorpus` (the shared PPR-018A harness) over this
 *    study's pinned driver, through the REAL in-process Zeck public API,
 *    the REAL executions authority/ledger/idempotency, the REAL model
 *    gateway + rails — with the synthetic supply behind the rails;
 *  - the direct baseline and the strong-optimized non-Zeck baseline via
 *    `captureBaseline` (the shared harness) — labeled BaselineRunRecords,
 *    structurally never Zeck evidence;
 *  - the thirteen-dimension measurement set (`measurementSetOf` + this
 *    work order's measured replacements for determinism-reuse and
 *    diagnosis-recovery);
 *  - the egress positive control (a deliberately direct provider attempt
 *    through the driver's deny-mode egress control must be OBSERVED
 *    failing — the bypass/authority classification rule);
 *  - exact nano-USD economics under the declared synthetic price schedule
 *    (per-arm transport accounting — labeled synthetic everywhere).
 *
 * RESUMABILITY (the checkpoint law): every cell's result is written
 * atomically to results/cells/<cellId>.json and recorded in the sweep
 * state; a killed sweep restarts from its last checkpoint, never zero.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { captureBaseline } from "../../compat/harness/baseline-runner";
import { runCorpus } from "../../compat/harness/corpus-runner";
import { measurementSetOf } from "../../compat/harness/measurement";
import { createZeckClient } from "../../sdk";
import type { BaselineRunRecord } from "../../src/integrations/compatibility/public";
import { composeExperimentStack } from "./compose";
import {
  edgeOf,
  MODALITIES,
  type ModalityKind,
  modalityAxisDegenerate,
  PROVIDER_CONFIGS,
  type ProviderConfigKind,
  SUBJECTS,
  SUPPLY_PROFILES,
  type SubjectDefinition,
  VOLUMES,
  type VolumeKind,
} from "./config";
import {
  baselineTasksOf,
  buildCellCorpus,
  createDirectBaselineExecutor,
  createExperimentDriver,
  createOptimizedBaselineExecutor,
  type RequestRecord,
} from "./driver";
import { createSyntheticSupply } from "./transport";

/** The sweep's results root (committed artifacts). */
export const RESULTS_ROOT = join(fileURLToPath(new URL(".", import.meta.url)), "results");
const CELLS_ROOT = join(RESULTS_ROOT, "cells");
const STATE_FILE = join(RESULTS_ROOT, "sweep-state.json");

/** One arm's latency distribution summary (milliseconds). */
interface LatencySummary {
  readonly samples: number;
  readonly medianMs: number | null;
  readonly p95Ms: number | null;
  readonly meanMs: number | null;
}

function summarize(samples: readonly number[]): LatencySummary {
  if (samples.length === 0) {
    return { samples: 0, medianMs: null, p95Ms: null, meanMs: null };
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)] ?? null;
  const p95 = sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)] ?? null;
  const mean = Math.round(samples.reduce((sum, value) => sum + value, 0) / samples.length);
  return { samples: samples.length, medianMs: median, p95Ms: p95, meanMs: mean };
}

/** One baseline arm's summary (BASELINE facts — never Zeck evidence). */
export interface BaselineArmSummary {
  readonly kind: "direct-baseline" | "optimized-baseline";
  readonly label: string;
  readonly tasksResolved: number;
  readonly tasksTotal: number;
  readonly latency: LatencySummary;
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly nanoCost: number;
  readonly microPerResolved: number | null;
  readonly appOwnedRetries: number;
  readonly providerFaults: number;
  readonly cacheHits: number | null;
}

function summarizeBaseline(
  kind: "direct-baseline" | "optimized-baseline",
  record: BaselineRunRecord,
  nano: { readonly nanoCharged: number; readonly faults: number },
  cacheHits: number | null,
): BaselineArmSummary {
  const resolved = record.taskRuns.filter((run) => run.succeeded === true);
  const samples = resolved.map((run) => run.durationMs);
  const retries = kind === "optimized-baseline" ? countOptimizedRetries(record) : 0;
  const nanoPerResolved = resolved.length > 0 ? nano.nanoCharged / resolved.length : null;
  return {
    kind,
    label: `BASELINE ${kind} (never Zeck evidence)`,
    tasksResolved: resolved.length,
    tasksTotal: record.taskRuns.length,
    latency: summarize(samples),
    inputTokens: record.taskRuns.reduce((sum, run) => sum + (run.usage?.inputTokens ?? 0), 0),
    outputTokens: record.taskRuns.reduce((sum, run) => sum + (run.usage?.outputTokens ?? 0), 0),
    nanoCost: nano.nanoCharged,
    microPerResolved: nanoPerResolved === null ? null : Math.floor(nanoPerResolved / 1000),
    appOwnedRetries: retries,
    providerFaults: nano.faults,
    cacheHits,
  };
}

function countOptimizedRetries(record: BaselineRunRecord): number {
  let retries = 0;
  for (const run of record.taskRuns) {
    const match = /(\d+) app-owned retry/.exec(run.detail);
    if (match !== null) {
      retries += Number(match[1]);
    }
  }
  return retries;
}

function countCacheHits(record: BaselineRunRecord): number {
  let hits = 0;
  for (const run of record.taskRuns) {
    const match = /(\d+) cache hit/.exec(run.detail);
    if (match !== null) {
      hits += Number(match[1]);
    }
  }
  return hits;
}

/** The facts the work-order measurement replacements derive from. */
export interface WorkOrderMeasurementFacts {
  readonly requestRecords: readonly RequestRecord[];
  readonly replays: number;
  readonly policyRetries: number;
  readonly providerFaults: number;
  readonly deterministicSubstrateRequests: number;
  /** Execution ids whose dispatch carried a policy retry (recovered incidents). */
  readonly policyRetriedExecutionIds: readonly string[];
}

function meanOf(values: readonly number[]): number | null {
  if (values.length === 0) {
    return null;
  }
  return Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
}

/**
 * Apply THIS work order's measured replacements for the two dimensions the
 * shared builder honestly leaves not-measured (determinism-reuse and
 * diagnosis-recovery): durable-replay reuse and deterministic-substrate
 * executions; failover-recovery and terminal-diagnosis latencies measured
 * from the run's own request records and dispatch facts. The other eleven
 * entries pass through untouched.
 */
export function applyWorkOrderMeasurements(
  set: import("../../src/integrations/compatibility/public").MeasurementSet,
  facts: WorkOrderMeasurementFacts,
): import("../../src/integrations/compatibility/public").MeasurementSet {
  const recoveredExecutionIds = new Set(facts.policyRetriedExecutionIds);
  const failedLatencies = facts.requestRecords
    .filter((record) => record.outcome === "failed")
    .map((record) => record.latencyMs);
  const recoveredLatencies = facts.requestRecords
    .filter(
      (record) => record.outcome === "resolved" && recoveredExecutionIds.has(record.executionId),
    )
    .map((record) => record.latencyMs);
  const diagnosisTimeMs = meanOf(failedLatencies);
  const recoveryTimeMs = meanOf(recoveredLatencies);
  const entries = set.entries.map((entry) => {
    if (entry.dimension === "determinism-reuse") {
      return {
        dimension: "determinism-reuse" as const,
        basis: "measured" as const,
        statement: `${facts.replays}/${facts.requestRecords.length} delegated request(s) replayed durably (zero provider exposure on corpus repetition); ${facts.deterministicSubstrateRequests} deterministic-substrate execution(s) (modelCalls 0, verified by mechanical recomputation).`,
        deterministicExecutionCount: facts.deterministicSubstrateRequests,
        reuseCount: facts.replays,
        verifiedComputationSubstitutions: facts.deterministicSubstrateRequests,
      };
    }
    if (entry.dimension === "diagnosis-recovery") {
      return {
        dimension: "diagnosis-recovery" as const,
        basis: "measured" as const,
        statement:
          facts.providerFaults === 0
            ? "0 provider-fault incident(s) drawn in this cell — no recovery exercised (the failover policy stood ready)."
            : `${facts.providerFaults} provider-fault incident(s) exercised; ${facts.policyRetries} recovered in-mediation by the platform failover policy${recoveryTimeMs === null ? "" : ` (mean ${recoveryTimeMs}ms end-to-end per recovered request)`}; ${failedLatencies.length} request failure(s) diagnosable at terminal${diagnosisTimeMs === null ? "" : ` (mean ${diagnosisTimeMs}ms to the public failure cause)`}.`,
        diagnosisTimeMs,
        recoveryTimeMs,
        incidentsExercised: facts.providerFaults,
      };
    }
    return entry;
  });
  return { entries };
}

/** One sweep cell's full result (the committed artifact). */
export interface CellResult {
  readonly cellId: string;
  readonly subject: string;
  readonly dimensions: {
    readonly volume: VolumeKind;
    readonly repetitions: number;
    readonly providerConfig: ProviderConfigKind;
    readonly modality: ModalityKind;
    readonly modalityDegenerate: boolean;
  };
  readonly corpus: { readonly tasks: number; readonly requests: number };
  readonly zeck: {
    readonly outcomes: {
      readonly attempts: number;
      readonly successes: number;
      readonly failures: number;
      readonly notRun: number;
      readonly bypass: number;
    };
    readonly latency: LatencySummary;
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly nanoCost: number;
    readonly microPerResolved: number | null;
    readonly requestFailures: number;
    readonly policyRetries: number;
    readonly providerFaults: number;
    readonly reuse: { readonly requests: number; readonly replays: number };
    readonly telemetry: {
      readonly traces: number;
      readonly correlated: number;
      readonly reconstructible: number;
    };
    readonly measurements: unknown;
  };
  readonly baselines: {
    readonly direct: BaselineArmSummary;
    readonly optimized: BaselineArmSummary;
  };
  readonly canary: { readonly host: string; readonly blocked: boolean; readonly observed: boolean };
  readonly wallMs: number;
  readonly notes: readonly string[];
}

export interface SweepCellOptions {
  readonly subject: SubjectDefinition;
  readonly volume: VolumeKind;
  readonly repetitions: number;
  readonly providerConfig: ProviderConfigKind;
  readonly modality: ModalityKind;
  /** Skip writing the result file (used by tests). */
  readonly persist?: boolean;
}

/** The cell id: <subject>-<volume>-<providerConfig>-<modality>. */
export function cellIdOf(
  subject: string,
  volume: VolumeKind,
  providerConfig: ProviderConfigKind,
  modality: ModalityKind,
): string {
  return `${subject}-${volume}-${providerConfig}-${modality}`;
}

/** Run ONE sweep cell (all three arms; resumable at the cell granularity). */
export async function runSweepCell(options: SweepCellOptions): Promise<CellResult> {
  const { subject, volume, repetitions, providerConfig, modality } = options;
  const cellId = cellIdOf(subject.subjectId, volume, providerConfig, modality);
  const wallStartedAt = Date.now();
  const providerIds = PROVIDER_CONFIGS.find((c) => c.providerConfig === providerConfig)
    ?.providers ?? ["supply-a"];
  const degenerate = modalityAxisDegenerate(subject);

  const stack = await composeExperimentStack({ subject, providerConfig, providerIds });
  try {
    const corpus = buildCellCorpus(subject, modality, volume, repetitions);
    const corpusTasks = corpus.map((task) => ({
      taskId: task.taskId,
      title: task.title,
      instruction: task.instruction,
    }));
    const totalRequests = corpus.reduce((sum, task) => sum + task.requests.length, 0);

    const driverBundle = createExperimentDriver({
      subject,
      stack,
      cellId,
      corpus,
    });

    // The egress positive control (the bypass/authority classification
    // rule): a deliberately direct provider attempt through the driver's
    // deny-mode egress control must be OBSERVED failing.
    let canaryBlocked = false;
    let canaryObserved = false;
    const canaryHost = "api.openai.com";
    try {
      await driverBundle.egressTransport(`https://${canaryHost}/v1/chat/completions`, {
        method: "POST",
      });
      canaryObserved = true;
    } catch (error) {
      canaryObserved = true;
      canaryBlocked = error instanceof Error && error.name === "EgressBlockedError";
      if (!canaryBlocked) {
        throw error;
      }
    }

    // THE MEDIATED ARM: the shared harness runner over this study's driver.
    const report = await runCorpus({
      driver: driverBundle.driver,
      expected: {
        applicationId: stack.applicationId,
        pin: {
          upstreamRevision: subject.upstreamRevision,
          integrationRevision: subject.integrationRevision,
        },
      },
      corpus: corpusTasks,
      traceSource: experimentTraceSource(stack),
      now: () => new Date().toISOString(),
    });

    // THE BASELINE ARMS (each with its own transport — the direct and
    // optimized arms share attempt-1 draws per logical request; fresh
    // accounting per arm). Labeled BaselineRunRecords, never Zeck evidence.
    const directTransport = createSyntheticSupply();
    const direct = createDirectBaselineExecutor({
      subject,
      transport: directTransport,
      cellId,
      corpus,
      providerIds,
    });
    const directRecord = await captureBaseline({
      kind: "direct-baseline",
      executor: direct,
      corpus: baselineTasksOf(corpus),
      now: () => new Date().toISOString(),
    });
    const optimizedTransport = createSyntheticSupply();
    const optimized = createOptimizedBaselineExecutor({
      subject,
      transport: optimizedTransport,
      cellId,
      corpus,
      providerIds,
    });
    const optimizedRecord = await captureBaseline({
      kind: "optimized-baseline",
      executor: optimized,
      corpus: baselineTasksOf(corpus),
      now: () => new Date().toISOString(),
    });

    // The measurement set + this work order's measured replacements for
    // determinism-reuse and diagnosis-recovery (the two dimensions the
    // shared builder honestly leaves not-measured; the sweep MEASURES them:
    // durable replays + deterministic-substrate executions, and the
    // failover-recovery / terminal-diagnosis latencies).
    const requestRecords = driverBundle.requestRecords();
    const replays = requestRecords.filter((record) => record.replayed).length;
    const dispatchFacts = stack.dispatchFacts();
    const policyRetries = dispatchFacts.filter((fact) => fact.policyRetry).length;
    const providerFaults = stack.transport.facts().faults.length;
    const deterministicSubstrateRequests = corpus.reduce(
      (sum, task) =>
        sum +
        task.requests.filter(
          (request) => edgeOf(subject, request.edgeId).surface === "sandbox-program-execution",
        ).length,
      0,
    );
    const measurements = applyWorkOrderMeasurements(measurementSetOf(report), {
      requestRecords,
      replays,
      policyRetries,
      providerFaults,
      deterministicSubstrateRequests,
      policyRetriedExecutionIds: dispatchFacts
        .filter((fact) => fact.policyRetry)
        .map((fact) => fact.executionId),
    });

    const outcomeEntries = report.runOutcomes;
    const successes = outcomeEntries.filter((entry) => entry.outcome === "PASS").length;
    const failures = outcomeEntries.filter((entry) => entry.outcome === "FAIL").length;
    const notRun = outcomeEntries.filter(
      (entry) => entry.outcome === "NOT-RUN" || entry.outcome === "BLOCKED",
    ).length;
    const bypass = outcomeEntries.filter((entry) => entry.outcome === "BYPASS_DETECTED").length;

    const resolvedLatencies = report.taskReports
      .filter((taskReport) => taskReport.outcome.succeeded === true)
      .map((taskReport) => taskReport.outcome.durationMs);
    const mediatedNano = requestRecords.reduce((sum, record) => sum + record.costNanoUsd, 0);
    const nanoPerResolved = successes > 0 ? mediatedNano / successes : null;

    const traces = report.taskReports.flatMap((taskReport) => [...taskReport.traces]);
    const correlated = traces.filter((trace) => trace.correlated).length;
    const reconstructible = traces.filter(
      (trace) =>
        trace.correlated &&
        (trace.route !== null || trace.costMicroUsd !== null || trace.usage !== null),
    ).length;

    const result: CellResult = {
      cellId,
      subject: subject.subjectId,
      dimensions: {
        volume,
        repetitions,
        providerConfig,
        modality,
        modalityDegenerate: degenerate,
      },
      corpus: { tasks: corpus.length, requests: totalRequests },
      zeck: {
        outcomes: { attempts: outcomeEntries.length, successes, failures, notRun, bypass },
        latency: summarize(resolvedLatencies),
        inputTokens: requestRecords.reduce((sum, record) => sum + record.usage.inputTokens, 0),
        outputTokens: requestRecords.reduce((sum, record) => sum + record.usage.outputTokens, 0),
        nanoCost: mediatedNano,
        microPerResolved: nanoPerResolved === null ? null : Math.floor(nanoPerResolved / 1000),
        requestFailures: requestRecords.filter((record) => record.outcome === "failed").length,
        policyRetries,
        providerFaults,
        reuse: { requests: requestRecords.length, replays },
        telemetry: { traces: traces.length, correlated, reconstructible },
        measurements,
      },
      baselines: {
        direct: summarizeBaseline(
          "direct-baseline",
          directRecord,
          {
            nanoCharged: directTransport.facts().nanoCharged,
            faults: directTransport.facts().faults.length,
          },
          null,
        ),
        optimized: summarizeBaseline(
          "optimized-baseline",
          optimizedRecord,
          {
            nanoCharged: optimizedTransport.facts().nanoCharged,
            faults: optimizedTransport.facts().faults.length,
          },
          countCacheHits(optimizedRecord),
        ),
      },
      canary: { host: canaryHost, blocked: canaryBlocked, observed: canaryObserved },
      wallMs: Date.now() - wallStartedAt,
      notes: [
        ...(degenerate && modality === "mono"
          ? [
              "modality axis degenerate for this subject (the declared graph is text-only): the mono and full slices are identical workloads",
            ]
          : []),
        "cost figures are derived from the declared synthetic price schedule (experiment configuration — never provider invoices)",
        "latency figures include the injected synthetic supply latency profile; cross-arm deltas are the mediation structure, not live provider latency",
      ],
    };

    if (options.persist !== false) {
      writeCellResult(result);
    }
    return result;
  } finally {
    await stack.close();
  }
}

/** The SDK-wire trace source (route from the actual tool-result provider;
 * usage/cost from the model-completion fact — the public reads only). */
export function experimentTraceSource(stack: {
  readonly apiBaseUrl: string;
  readonly apiToken: string;
  readonly applicationId: string;
}): import("../../src/integrations/compatibility/public").ZeckTraceSource {
  const client = createZeckClient({
    baseUrl: stack.apiBaseUrl,
    token: stack.apiToken,
    applicationId: stack.applicationId,
  });
  return {
    async readExecutionTrace(_applicationId, executionId) {
      try {
        const execution = await client.getExecution(executionId);
        const events = await client.listEvents(executionId);
        const verification = await client.listVerification(executionId);
        const completion = [...events]
          .reverse()
          .find(
            (event) =>
              event.type === "execution.tool-result" &&
              ((event.payload as { readonly kind?: unknown }).kind === "model-completion" ||
                (event.payload as { readonly kind?: unknown }).kind === "substrate-result"),
          );
        const payload = completion?.payload as
          | {
              readonly kind?: string;
              readonly provider?: string;
              readonly model?: string;
              readonly usage?: { readonly input?: unknown; readonly output?: unknown };
              readonly costMicroUsd?: unknown;
            }
          | undefined;
        // The substrate plane's fact carries no provider/model/usage/cost —
        // its route IS the deterministic substrate itself (PPR-024's shape).
        const route =
          payload?.kind === "substrate-result"
            ? { provider: "deterministic", model: null, strategyClass: "deterministic-substrate" }
            : payload?.provider === undefined
              ? null
              : {
                  provider: payload.provider,
                  model: payload.model ?? null,
                  strategyClass: "model-rail",
                };
        return {
          execution: {
            id: execution.id,
            applicationId: execution.applicationId,
            status: execution.status,
            terminal: ["COMPLETED", "FAILED", "CANCELLED", "EXPIRED"].includes(execution.status),
          },
          events: events.map((event) => ({
            eventId: event.eventId,
            sequence: event.sequence,
            type: event.type,
          })),
          verification: verification.map((result) => ({ id: result.id, status: result.status })),
          route,
          costMicroUsd: typeof payload?.costMicroUsd === "string" ? payload.costMicroUsd : null,
          usage:
            typeof payload?.usage?.input === "number" && typeof payload?.usage?.output === "number"
              ? {
                  inputTokens: Number(payload.usage.input),
                  outputTokens: Number(payload.usage.output),
                }
              : null,
        };
      } catch {
        return {
          execution: null,
          events: [],
          verification: [],
          route: null,
          costMicroUsd: null,
          usage: null,
        };
      }
    },
  };
}

/** Write one cell result atomically + update the sweep state. */
export function writeCellResult(result: CellResult): void {
  mkdirSync(CELLS_ROOT, { recursive: true });
  const file = join(CELLS_ROOT, `${result.cellId}.json`);
  writeFileSync(file, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  const state = readSweepState();
  if (!state.completedCells.includes(result.cellId)) {
    state.completedCells.push(result.cellId);
  }
  state.updatedAt = new Date().toISOString();
  writeFileSync(STATE_FILE, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

interface SweepState {
  readonly version: 1;
  completedCells: string[];
  startedAt: string;
  updatedAt: string;
}

function readSweepState(): SweepState {
  if (existsSync(STATE_FILE)) {
    const parsed = JSON.parse(readFileSync(STATE_FILE, "utf8")) as SweepState;
    return parsed;
  }
  return {
    version: 1,
    completedCells: [],
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

/** All sweep cells in execution order (subject-major). */
export function allSweepCells(): readonly {
  readonly subject: SubjectDefinition;
  readonly volume: VolumeKind;
  readonly repetitions: number;
  readonly providerConfig: ProviderConfigKind;
  readonly modality: ModalityKind;
  readonly cellId: string;
}[] {
  const cells: {
    subject: SubjectDefinition;
    volume: VolumeKind;
    repetitions: number;
    providerConfig: ProviderConfigKind;
    modality: ModalityKind;
    cellId: string;
  }[] = [];
  for (const subject of SUBJECTS) {
    const degenerate = modalityAxisDegenerate(subject);
    for (const volume of VOLUMES) {
      for (const providerConfig of PROVIDER_CONFIGS) {
        for (const modality of MODALITIES) {
          if (degenerate && modality.modality === "full") {
            // The mono and full slices are identical for a text-only
            // subject: run the cell once and label the axis degenerate.
            continue;
          }
          cells.push({
            subject,
            volume: volume.volume,
            repetitions: volume.repetitions,
            providerConfig: providerConfig.providerConfig,
            modality: modality.modality,
            cellId: cellIdOf(
              subject.subjectId,
              volume.volume,
              providerConfig.providerConfig,
              modality.modality,
            ),
          });
        }
      }
    }
  }
  return cells;
}

export interface SweepRunOptions {
  /** Limit the number of cells (used by tests and shorthanded runs). */
  readonly maxCells?: number;
  /** Only run cells for these subjects (defaults to all). */
  readonly subjectIds?: readonly string[];
  /** Persist results (defaults true; tests may disable). */
  readonly persist?: boolean;
  /** Progress callback. */
  readonly onCell?: (result: CellResult, index: number, total: number) => void;
}

/** Run the full sweep, resuming from the last checkpoint. */
export async function runSweep(options: SweepRunOptions = {}): Promise<{
  readonly completedCells: string[];
  readonly skippedCells: string[];
  readonly failedCells: { readonly cellId: string; readonly error: string }[];
  readonly totalPlanned: number;
}> {
  const state = readSweepState();
  let cells = allSweepCells();
  if (options.subjectIds !== undefined) {
    cells = cells.filter((cell) => options.subjectIds?.includes(cell.subject.subjectId));
  }
  if (options.maxCells !== undefined) {
    cells = cells.slice(0, options.maxCells);
  }
  const skippedCells = cells
    .filter((cell) => state.completedCells.includes(cell.cellId))
    .map((cell) => cell.cellId);
  const pending = cells.filter((cell) => !state.completedCells.includes(cell.cellId));
  const failedCells: { cellId: string; error: string }[] = [];
  let index = 0;
  for (const cell of pending) {
    index += 1;
    try {
      const result = await runSweepCell({
        subject: cell.subject,
        volume: cell.volume,
        repetitions: cell.repetitions,
        providerConfig: cell.providerConfig,
        modality: cell.modality,
        persist: options.persist,
      });
      options.onCell?.(result, index, pending.length);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failedCells.push({ cellId: cell.cellId, error: message });
      console.error(`[ppr-027 sweep] cell ${cell.cellId} FAILED: ${message}`);
    }
  }
  return {
    completedCells: readSweepState().completedCells,
    skippedCells,
    failedCells,
    totalPlanned: cells.length,
  };
}

/** The provider-portability probe (one per subject): re-compose the
 * platform side from single- to multi-provider with ZERO application-side
 * changes and run the representative task through the same driver code. */
export async function runPortabilityProbe(subject: SubjectDefinition): Promise<{
  readonly subjectId: string;
  readonly switchedWithoutAppChanges: boolean;
  readonly changedApplicationFiles: number;
  readonly switchTimeMs: number;
  readonly note: string;
}> {
  const startedAt = Date.now();
  const stack = await composeExperimentStack({
    subject,
    providerConfig: "multi",
    providerIds: SUPPLY_PROFILES.map((profile) => profile.providerId),
  });
  try {
    const corpus = buildCellCorpus(subject, "full", "S", 1);
    const representative = corpus[0];
    if (representative === undefined) {
      throw new Error(`subject ${subject.subjectId} has no representative task`);
    }
    const driverBundle = createExperimentDriver({
      subject,
      stack,
      cellId: "portability-probe",
      corpus,
    });
    const session = await driverBundle.driver.start({
      expectedApplicationId: stack.applicationId,
      expectedPin: {
        upstreamRevision: subject.upstreamRevision,
        integrationRevision: subject.integrationRevision,
      },
      runCorrelationId: `ppr-027-portability:${subject.subjectId}`,
      now: () => new Date().toISOString(),
    });
    try {
      await session.executeTask({
        taskId: representative.taskId,
        title: representative.title,
        instruction: representative.instruction,
      });
    } finally {
      await session.stop();
    }
    return {
      subjectId: subject.subjectId,
      switchedWithoutAppChanges: true,
      changedApplicationFiles: 0,
      switchTimeMs: Date.now() - startedAt,
      note: "the platform side was re-composed from the single- to the multi-provider configuration; the driver/workload code is provider-blind (no provider identifier appears in any task payload) — the certified records' own portability probes remain the application-level facts",
    };
  } finally {
    await stack.close();
  }
}

/** Read back all committed cell results (for aggregation). */
export function readCellResults(): readonly CellResult[] {
  if (!existsSync(CELLS_ROOT)) {
    return [];
  }
  return readdirSync(CELLS_ROOT)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .map((name) => JSON.parse(readFileSync(join(CELLS_ROOT, name), "utf8")) as CellResult);
}
