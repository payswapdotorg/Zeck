/**
 * The determinization-maturity application's deterministic fixtures
 * (VAL-036, AC2).
 *
 * The controlled world the platform driver and the app execute
 * against:
 *
 *   * the fake maturity history port — the READ-ONLY recorded
 *     lifecycle history (the pinned family histories: the promoted
 *     walks, the per-generation MEASURED facts and the accounting
 *     ledgers VAL-032..035 produced, pre-seeded). The honest port is
 *     never rewritten by a run (the input digest is stable); the
 *     adversarial variants are the discrimination shapes:
 *     `gapped` DROPS a family's generation 3 (a gapped series),
 *     `unmeasured` marks a generation's measurements ABSENT,
 *     `unreconciled` ALTERS the accounting numbers (the ledger the
 *     claims no longer match) and `mutating` REWRITES the recorded
 *     history over the run (the read-only catch);
 *   * the fake maturity report ledger — APPEND-ONLY: an identical
 *     re-append REPLAYS (idempotent), a different report under the
 *     same familyId is REFUSED, and the `rewrite-input` variant
 *     reaches into the recorded history and REWRITES it on append
 *     (the read-only catch);
 *   * the fake API world — the transport-level fake implementing the
 *     platform's OWN maturity semantics at the customer boundary,
 *     with the same discrimination knobs (`terminal`, `uncited`,
 *     `gapped`, `extrapolated`, `misclassified`, `aggregatesavings`,
 *     `unreconciled`, `unreported`);
 *   * the tick clock — the deterministic injectable clock.
 *
 * Everything is digests and identities — payload bytes never enter
 * the fixtures, and no credential is ever read.
 */

import type { TransportImplementation } from "../../harness/harness";
import type {
  AccountingLedgerEntry,
  AppMaturityObservation,
  FamilyLifecycleRecord,
  MaturityAnalysisFacts,
  MaturityAnalysisPort,
  MaturityCorpusRow,
  MaturityReportPort,
  MaturityReportRecord,
  PromotionGenerationRecord,
} from "../../platform/determinization-maturity";
import {
  maturityInputDigestOf,
  maturityReportDigestOf,
  maturityTrajectoryStepsOf,
} from "../../platform/determinization-maturity";
import type { DiscoveryProposalRecord } from "../../platform/learning-discovery";
import type { TrajectoryStepKind } from "../../platform/longitudinal-baseline";
import { longitudinalDigestOf, trajectoryEventsOf } from "../../platform/longitudinal-baseline";
import { DETERMINIZATION_MATURITY_CORPUS, FAMILY_HISTORIES, familyHistoryById } from "./corpus";

// ---------------------------------------------------------------------------
// The tick clock (deterministic wall-clock)
// ---------------------------------------------------------------------------

/** The deterministic injectable clock (advances with simulated roundtrips). */
export interface TickClock {
  readonly now: () => Date;
  /** Advance the clock synchronously (no yield). */
  readonly tick: () => void;
}

/** Create the tick clock (every read advances the clock deterministically). */
export function createTickClock(stepMs = 5): TickClock {
  let at = Date.parse("2026-01-05T00:00:00.000Z");
  return {
    now: () => new Date(at),
    tick: () => {
      at += stepMs;
    },
  };
}

// ---------------------------------------------------------------------------
// The fake maturity history port (the read-only recorded input)
// ---------------------------------------------------------------------------

/** The adversarial history-port variants (the discrimination shapes). */
export type FakeHistoryVariant = "gapped" | "unmeasured" | "unreconciled" | "mutating";

/** The fake read-only maturity history port (with its variant). */
export interface FakeMaturityHistoryPort extends MaturityAnalysisPort {
  /** The number of history reads served (the read-only audit). */
  readonly readCount: () => number;
}

/**
 * Create the fake maturity history port: the pinned family histories
 * served READ-ONLY. The adversarial variants: `gapped` drops the
 * text-summarization family's generation 3 (the gapped-series
 * discrimination), `unmeasured` marks the RAG family's generation 4
 * as having absent measurements, `unreconciled` doubles the recorded
 * accounting numbers (the claims no longer match the ledgers), and
 * `mutating` appends a fabricated lifecycle record on the SECOND read
 * (the recorded history rewrites itself — the read-only catch).
 */
export function createMaturityHistoryPort(variant?: FakeHistoryVariant): FakeMaturityHistoryPort {
  let reads = 0;
  let factsReads = 0;
  const lifecycleFor = (familyId: string): readonly FamilyLifecycleRecord[] => {
    reads += 1;
    const history = familyHistoryById(familyId);
    if (history === null) {
      return [];
    }
    if (variant === "mutating" && reads > 2) {
      return [
        ...history.lifecycleRecords,
        {
          familyId,
          proposalId: "cand-learning-discovery-fabricated-mutation",
          kind: "cache",
          generation: 99,
          evidenceDigest: "fabricated-mutation-evidence",
        },
      ];
    }
    return history.lifecycleRecords;
  };
  const generationsFor = (familyId: string): readonly PromotionGenerationRecord[] => {
    reads += 1;
    const history = familyHistoryById(familyId);
    if (history === null) {
      return [];
    }
    let generations = history.generations;
    if (variant === "gapped" && familyId === "text-summarization") {
      generations = generations.filter((generation) => generation.generation !== 3);
    }
    if (variant === "unmeasured" && familyId === "rag-retrieval") {
      generations = generations.map((generation) =>
        generation.generation === 4 ? { ...generation, measured: false } : generation,
      );
    }
    return generations;
  };
  const accountingFor = (familyId: string): readonly AccountingLedgerEntry[] => {
    reads += 1;
    const history = familyHistoryById(familyId);
    if (history === null) {
      return [];
    }
    if (variant === "unreconciled") {
      return history.accountingEntries.map((entry) => ({ ...entry, microUsd: entry.microUsd * 2 }));
    }
    return history.accountingEntries;
  };
  const facts = (): MaturityAnalysisFacts => {
    factsReads += 1;
    const mutationDrift = variant === "mutating" && factsReads > 1 ? 1 : 0;
    const lifecycleRecordCount = FAMILY_HISTORIES.reduce(
      (total, history) => total + history.lifecycleRecords.length,
      0,
    );
    const generationRecordCount = FAMILY_HISTORIES.reduce(
      (total, history) => total + history.generations.length,
      0,
    );
    const accountingEntryCount = FAMILY_HISTORIES.reduce(
      (total, history) => total + history.accountingEntries.length,
      0,
    );
    return {
      familyIds: FAMILY_HISTORIES.map((history) => history.familyId).sort(),
      lifecycleRecordCount: lifecycleRecordCount + mutationDrift,
      generationRecordCount,
      accountingEntryCount,
      registryProposalIds: FAMILY_HISTORIES.flatMap((history) =>
        history.lifecycleRecords.map((record) => record.proposalId),
      ).sort(),
    };
  };
  const proposalFor = (proposalId: string): DiscoveryProposalRecord | null => {
    for (const history of FAMILY_HISTORIES) {
      for (const record of history.lifecycleRecords) {
        if (record.proposalId === proposalId) {
          return {
            proposalId,
            kind: record.kind,
            citation: { trajectoryDigests: [], replayIdentities: [] },
            minedStructureDigest: record.evidenceDigest,
            lifecycleStage: "promoted",
          };
        }
      }
    }
    return null;
  };
  return {
    lifecycleFor,
    generationsFor,
    accountingFor,
    facts,
    proposalFor,
    readCount: () => reads,
  };
}

// ---------------------------------------------------------------------------
// The fake maturity report ledger (append-only)
// ---------------------------------------------------------------------------

/** The fake append-only maturity report ledger (with its variant). */
export interface FakeMaturityReportLedger extends MaturityReportPort {
  /** The ledger's full append log (the audit). */
  readonly appendLog: () => readonly { readonly digest: string; readonly replayed: boolean }[];
}

/**
 * Create the fake maturity report ledger: APPEND-ONLY — an identical
 * re-append REPLAYS (idempotent), a different report under the same
 * familyId is REFUSED. The `rewrite-input` variant reaches into the
 * recorded history and mutates it on append (the read-only catch the
 * driver's before/after input digest fires).
 */
export function createMaturityReportLedger(options?: {
  readonly mutateInputOnAppend?: () => void;
}): FakeMaturityReportLedger {
  const reportsByFamily = new Map<string, MaturityReportRecord[]>();
  const log: { digest: string; replayed: boolean }[] = [];
  const reportsFor = (familyId: string): readonly MaturityReportRecord[] =>
    reportsByFamily.get(familyId) ?? [];
  return {
    append: async (record) => {
      const existing = reportsFor(record.familyId);
      const digest = maturityReportDigestOf(record);
      const prior = existing.find((entry) => entry.familyId === record.familyId);
      if (prior !== undefined) {
        if (maturityReportDigestOf(prior) === digest) {
          log.push({ digest, replayed: true });
          return { accepted: true, replayed: true, refused: false };
        }
        log.push({ digest, replayed: false });
        return { accepted: false, replayed: false, refused: true };
      }
      const appended: MaturityReportRecord = { ...record, ordinal: existing.length + 1 };
      reportsByFamily.set(record.familyId, [...existing, appended]);
      log.push({ digest, replayed: false });
      options?.mutateInputOnAppend?.();
      return { accepted: true, replayed: false, refused: false };
    },
    reportsFor,
    appendLog: () => [...log],
  };
}

// ---------------------------------------------------------------------------
// The fake API world (the transport-level boundary)
// ---------------------------------------------------------------------------

/**
 * The transport-level fake public API implementing the platform's OWN
 * maturity semantics at the customer boundary:
 *
 *  - POST /executions — the per-row create semantics (each maturity
 *    submission lands its OWN durable execution under its OWN
 *    idempotency key);
 *  - GET /executions/:id — the row settles to its honest terminal on
 *    the read path, never backwards;
 *  - GET /executions/:id/events — the canonical maturity trajectory
 *    surfaced as the public step-event journal;
 *  - GET /executions/:id/results — the honest per-row result: the
 *    route's modelCalls (the run's own dispatches — zero offline, the
 *    live row's REAL measured round), the honest verification
 *    statuses, honestly-absent offline usage, the classification read
 *    back, the refusal reason read back, the curve series read back
 *    (the points the platform surfaced), the savings attribution read
 *    back, and the report-recorded flag.
 *
 * Discrimination knobs: `terminal` overrides the honest terminal;
 * `uncited` drops the last accounting digest from the surfaced
 * citation; `gapped` drops generation 3 from the surfaced curve
 * series; `extrapolated` flips generation 4's point source;
 * `misclassified` surfaces the OPPOSITE classification;
 * `aggregatesavings` surfaces the savings without the per-mechanism
 * breakdown; `unreconciled` inflates the surfaced total;
 * `unreported` surfaces no report record.
 */
export function createMaturityFakeApiWorld(options: {
  readonly clock: TickClock;
  readonly terminal?: "COMPLETED" | "FAILED";
  readonly uncited?: boolean;
  readonly gapped?: boolean;
  readonly extrapolated?: boolean;
  readonly misclassified?: boolean;
  readonly aggregatesavings?: boolean;
  readonly unreconciled?: boolean;
  readonly unreported?: boolean;
}): {
  readonly transport: TransportImplementation;
  readonly createdExecutions: number;
  readonly rows: Map<string, { readonly id: string; readonly taskRowId: string; status: string }>;
  readonly records: Map<string, { fingerprint: string; executionId: string }>;
} {
  const rows = new Map<string, { id: string; taskRowId: string; status: string }>();
  const records = new Map<string, { fingerprint: string; executionId: string }>();
  const settled = new Set<string>();
  let sequence = 0;
  let createdExecutions = 0;
  const clock = options.clock;

  const rowById = (rowId: string): MaturityCorpusRow | null =>
    DETERMINIZATION_MATURITY_CORPUS.find((candidate) => candidate.rowId === rowId) ?? null;

  /** The honest classification surfaced for a row (the knob flips it). */
  const surfacedClassificationOf = (row: MaturityCorpusRow): string => {
    if (options.misclassified !== true) {
      return row.claimedClassification;
    }
    if (row.claimedClassification === "determinized-stable") {
      return "variable-resilient";
    }
    if (row.claimedClassification === "variable-resilient") {
      return "determinized-stable";
    }
    if (row.claimedClassification === "determinizing-trending") {
      return "determinized-stable";
    }
    return "determinizing-trending";
  };

  /** The row's surfaced curve series (the knobs break its integrity). */
  const surfacedCurveOf = (row: MaturityCorpusRow) => {
    let points = row.curveSeries.map((point) => ({ ...point }));
    if (options.gapped === true) {
      points = points.filter((point) => point.generation !== 3);
    }
    if (options.extrapolated === true) {
      points = points.map((point) =>
        point.generation === 4 ? { ...point, pointSource: "extrapolated" as const } : point,
      );
    }
    return points;
  };

  /** The row's surfaced savings (the knobs break the reconciliation). */
  const surfacedSavingsOf = (row: MaturityCorpusRow) => {
    if (options.aggregatesavings === true) {
      return { totalMicroUsd: row.claimedSavings.totalMicroUsd, perMechanism: null };
    }
    if (options.unreconciled === true) {
      return {
        totalMicroUsd: row.claimedSavings.totalMicroUsd + 1,
        perMechanism: row.claimedSavings.perMechanism,
      };
    }
    return row.claimedSavings;
  };

  const jsonResponse = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });

  const transport: TransportImplementation = async (input: unknown, init?: unknown) => {
    const url = String(input);
    const method = String((init as RequestInit | undefined)?.method ?? "GET").toUpperCase();
    await Promise.resolve();
    clock.tick();

    if (url.endsWith("/executions") && method === "POST") {
      const headers = (init as { headers?: Record<string, string> }).headers ?? {};
      const key = headers["idempotency-key"] ?? headers["Idempotency-Key"] ?? "";
      if (key.length === 0) {
        return jsonResponse(422, {
          code: "CAPABILITY_UNAVAILABLE",
          message: "POST routes require an Idempotency-Key header",
          retryable: false,
        });
      }
      const body = JSON.parse(String((init as { body?: string }).body ?? "null")) as Record<
        string,
        unknown
      >;
      const fingerprint = JSON.stringify(body ?? null);
      const task = (body.task ?? null) as { rowId?: unknown } | null;
      const taskRowId = String(task?.rowId ?? "");
      const existing = records.get(key);
      if (existing !== undefined && existing.fingerprint === fingerprint) {
        const row = rows.get(existing.executionId);
        if (row !== undefined) {
          return jsonResponse(201, {
            executionId: row.id,
            applicationId: body.applicationId ?? "app-1",
            status: row.status,
            createdAt: new Date(clock.now().getTime()).toISOString(),
            replayed: true,
            lastEventSequence: 1,
          });
        }
      }
      if (existing !== undefined && existing.fingerprint !== fingerprint) {
        return jsonResponse(409, {
          code: "IDEMPOTENCY_KEY_REUSED",
          message: "idempotency key was already used with a different request fingerprint",
          retryable: false,
        });
      }
      sequence += 1;
      createdExecutions += 1;
      const id = `fake-exec-${sequence}`;
      rows.set(id, { id, taskRowId, status: "CREATED" });
      records.set(key, { fingerprint, executionId: id });
      return jsonResponse(201, {
        executionId: id,
        applicationId: body.applicationId ?? "app-1",
        status: "CREATED",
        createdAt: new Date(clock.now().getTime()).toISOString(),
        replayed: false,
        lastEventSequence: 1,
      });
    }

    const execMatch = url.match(/\/executions\/([^/]+)$/);
    if (execMatch !== null && method === "GET") {
      const row = rows.get(execMatch[1] ?? "");
      if (row === undefined) {
        return jsonResponse(404, {
          code: "CAPABILITY_UNAVAILABLE",
          message: "execution not found",
          retryable: false,
        });
      }
      const corpusRow = rowById(row.taskRowId);
      const honestTerminal =
        corpusRow === null ? "FAILED" : (options.terminal ?? corpusRow.expected.terminal);
      if (row.status === "CREATED" && !settled.has(row.id)) {
        settled.add(row.id);
        row.status = honestTerminal;
      }
      return jsonResponse(200, {
        id: row.id,
        applicationId: "app-1",
        environmentId: null,
        status: row.status,
        task: { kind: "determinization-maturity.learning-curve.v1", input: "maturity" },
        constraints: null,
        metadata: {},
        createdAt: new Date(clock.now().getTime()).toISOString(),
        updatedAt: new Date(clock.now().getTime()).toISOString(),
        terminalAt:
          row.status === "COMPLETED" || row.status === "FAILED"
            ? new Date(clock.now().getTime()).toISOString()
            : null,
      });
    }

    const eventsMatch = url.match(/\/executions\/([^/]+)\/events$/);
    if (eventsMatch !== null && method === "GET") {
      const row = rows.get(eventsMatch[1] ?? "");
      if (row === undefined) {
        return jsonResponse(404, {
          code: "CAPABILITY_UNAVAILABLE",
          message: "execution not found",
          retryable: false,
        });
      }
      const corpusRow = rowById(row.taskRowId);
      const steps =
        corpusRow === null
          ? []
          : maturityTrajectoryStepsOf({
              rowId: corpusRow.rowId,
              verdict: corpusRow.expected.verdict,
              generationCount: corpusRow.curveSeries.length,
              reportAppended: corpusRow.expected.verdict === "maturity-established",
            }).map((step, index) => ({
              ordinal: index + 1,
              kind: (step.kind.startsWith("maturity:report")
                ? "effect"
                : step.kind.startsWith("maturity:immaturity")
                  ? "verification"
                  : "dispatch") as TrajectoryStepKind,
              detail: `${step.kind}:${step.detail}`,
              digest: longitudinalDigestOf([corpusRow.rowId, step.kind, step.detail]),
            }));
      return jsonResponse(
        200,
        trajectoryEventsOf(steps).map((event, index) => ({
          eventId: `${row.id}-ev-${index + 1}`,
          executionId: row.id,
          type: event.type,
          sequence: event.sequence,
          occurredAt: new Date(clock.now().getTime()).toISOString(),
          payload: {},
        })),
      );
    }

    const resultMatch = url.match(/\/executions\/([^/]+)\/results$/);
    if (resultMatch !== null && method === "GET") {
      const row = rows.get(resultMatch[1] ?? "");
      if (row === undefined) {
        return jsonResponse(404, {
          code: "CAPABILITY_UNAVAILABLE",
          message: "execution not found",
          retryable: false,
        });
      }
      const corpusRow = rowById(row.taskRowId);
      const pass = row.status === "COMPLETED";
      const needsDispatch = corpusRow?.needsDispatch ?? false;
      const citationDigests =
        corpusRow === null || options.uncited !== true
          ? (corpusRow?.citation.accountingEntryDigests ?? [])
          : (corpusRow?.citation.accountingEntryDigests ?? []).slice(0, -1);
      return jsonResponse(200, {
        executionId: row.id,
        status: row.status === "CREATED" ? "RUNNING" : row.status,
        route: {
          provider: "fake-rail",
          model: "fake-model",
          strategyClass: "determinization-maturity",
          modelCalls: corpusRow?.expected.modelCalls ?? 0,
        },
        cost: pass && needsDispatch ? { totalMicroUsd: "40", currency: "usd" } : null,
        usage: needsDispatch ? { inputTokens: 30, outputTokens: 6 } : null,
        outputArtifacts: [],
        verification: (pass ? ["PASS", "PASS"] : ["FAIL", "PASS"]).map((status, index) => ({
          id: `v${index + 1}`,
          executionId: row.id,
          criterionId: `criterion-${index + 1}`,
          strategy: "deterministic",
          status,
          recordedBy: "fake-platform",
        })),
        classification: corpusRow === null ? null : surfacedClassificationOf(corpusRow),
        refusalReason: corpusRow?.expected.refusalReason ?? null,
        curveSeries:
          corpusRow === null
            ? []
            : surfacedCurveOf(corpusRow).map((point) => ({
                generation: point.generation,
                displacedModelCalls: point.displacedModelCalls,
                measuredCostMicroUsd: point.measuredCostMicroUsd,
                measuredLatencyMs: point.measuredLatencyMs,
                measured: point.measured,
                pointSource: point.pointSource,
                generationDigest: point.generationDigest,
                lifecycleProposalIds: [...point.lifecycleProposalIds],
              })),
        savings: corpusRow === null ? null : surfacedSavingsOf(corpusRow),
        reportRecorded:
          options.unreported === true
            ? false
            : (corpusRow?.expected.verdict ?? "immaturity-honest") === "maturity-established",
        citationDigests,
      });
    }

    return jsonResponse(404, {
      code: "CAPABILITY_UNAVAILABLE",
      message: `no fake route for ${method} ${url}`,
      retryable: false,
    });
  };

  return {
    transport,
    get createdExecutions() {
      return createdExecutions;
    },
    rows,
    records,
  };
}

// ---------------------------------------------------------------------------
// The honest stack (the world the offline corpus executes against)
// ---------------------------------------------------------------------------

/** The honest offline stack (the read-only history + the append-only report ledger + the clock). */
export function createHonestMaturityStack(): {
  readonly history: FakeMaturityHistoryPort;
  readonly reportLedger: FakeMaturityReportLedger;
  readonly clock: TickClock;
} {
  return {
    history: createMaturityHistoryPort(),
    reportLedger: createMaturityReportLedger(),
    clock: createTickClock(),
  };
}

/** The observation shape re-export (the app's boundary contract basis). */
export type { AppMaturityObservation };
/** The read-only input digest helper (re-export for the consistency tests). */
export { maturityInputDigestOf };
