/**
 * The savings-attribution application's deterministic fixtures
 * (VAL-045, AC2).
 *
 * The controlled world the platform driver and the app execute
 * against:
 *
 *   * the fake attribution analysis port — the READ-ONLY recorded
 *     economics + lifecycle history (the pinned family economics: the
 *     promoted lifecycle walks, the promotion generations VAL-036's
 *     maturity curves hold, the accounting ledger entries, VAL-044's
 *     recorded incumbent baselines and the per-generation recorded
 *     savings totals, pre-seeded). The honest port is never rewritten
 *     by a run (the input digest is stable); the adversarial
 *     variants are the discrimination shapes: `gapped` DROPS a
 *     family's generation from the maturity curves (a gapped series),
 *     `swappedbaseline` SERVES another generation's recorded baseline
 *     where the claim's own should be (the swapped counterfactual),
 *     `unreconciled` ALTERS the recorded totals (the identity the
 *     claims no longer reconcile against) and `mutating` REWRITES the
 *     recorded history over the run (the read-only catch);
 *   * the fake attribution report ledger — APPEND-ONLY: an identical
 *     re-append REPLAYS (idempotent), a different report under the
 *     same familyId is REFUSED, and the `rewrite-input` variant
 *     reaches into the recorded history and REWRITES it on append
 *     (the read-only catch);
 *   * the fake API world — the transport-level fake implementing the
 *     platform's OWN attribution semantics at the customer boundary,
 *     with the same discrimination knobs (`terminal`,
 *     `attributedsplit`, `foldedresidual`, `gapped`, `inflatedtotal`,
 *     `unreported`);
 *   * the tick clock — the deterministic injectable clock.
 *
 * Everything is digests and identities — payload bytes never enter
 * the fixtures, and no credential is ever read.
 */

import type { TransportImplementation } from "../../harness/harness";
import type { FamilyLifecycleRecord } from "../../platform/determinization-maturity";
import type { DiscoveryProposalRecord } from "../../platform/learning-discovery";
import type { TrajectoryStepKind } from "../../platform/longitudinal-baseline";
import { longitudinalDigestOf, trajectoryEventsOf } from "../../platform/longitudinal-baseline";
import type {
  AppAttributionObservation,
  AttributionAnalysisFacts,
  AttributionAnalysisPort,
  AttributionCorpusRow,
  AttributionReportPort,
  SavingsAttributionReportRecord,
} from "../../platform/savings-attribution";
import {
  attributionInputDigestOf,
  attributionTrajectoryStepsOf,
  savingsAttributionReportDigestOf,
} from "../../platform/savings-attribution";
import {
  declaredSplitTotalsOf,
  FAMILY_ECONOMICS,
  familyEconomicsById,
  SAVINGS_ATTRIBUTION_CORPUS,
} from "./corpus";

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
// The fake attribution analysis port (the read-only recorded input)
// ---------------------------------------------------------------------------

/** The adversarial analysis-port variants (the discrimination shapes). */
export type FakeEconomicsVariant = "gapped" | "swappedbaseline" | "unreconciled" | "mutating";

/** The fake read-only attribution analysis port (with its variant). */
export interface FakeAttributionHistoryPort extends AttributionAnalysisPort {
  /** The number of history reads served (the read-only audit). */
  readonly readCount: () => number;
}

/**
 * Create the fake attribution analysis port: the pinned family
 * economics served READ-ONLY. The adversarial variants: `gapped`
 * drops the translation-glossary family's generation 2 from the
 * maturity curves (the gapped-series discrimination — the attribution
 * now cites a generation the served curves do not hold), the
 * `swappedbaseline` variant swaps the invoice-extraction family's
 * generation-3 reuse baseline into generation 2's place (the swapped
 * counterfactual — the claims measured against the served baselines
 * no longer match), `unreconciled` doubles the recorded savings
 * totals (the reconciliation identity the claims no longer satisfy)
 * and `mutating` appends a fabricated lifecycle record on the SECOND
 * read (the recorded history rewrites itself — the read-only catch).
 */
export function createAttributionHistoryPort(
  variant?: FakeEconomicsVariant,
): FakeAttributionHistoryPort {
  let reads = 0;
  let factsReads = 0;
  const lifecycleFor = (familyId: string) => {
    reads += 1;
    const economics = familyEconomicsById(familyId);
    if (economics === null) {
      return [];
    }
    if (variant === "mutating" && reads > 2) {
      const fabricated: FamilyLifecycleRecord = {
        familyId,
        proposalId: "cand-learning-discovery-fabricated-mutation",
        kind: "cache",
        generation: 99,
        evidenceDigest: "fabricated-mutation-evidence",
      };
      return [...economics.lifecycleRecords, fabricated];
    }
    return economics.lifecycleRecords;
  };
  const generationsFor = (familyId: string) => {
    reads += 1;
    const economics = familyEconomicsById(familyId);
    if (economics === null) {
      return [];
    }
    let generations = economics.generations;
    if (variant === "gapped" && familyId === "translation-glossary") {
      generations = generations.filter((generation) => generation.generation !== 2);
    }
    return generations;
  };
  const accountingFor = (familyId: string) => {
    reads += 1;
    const economics = familyEconomicsById(familyId);
    if (economics === null) {
      return [];
    }
    return economics.ledgerEntries;
  };
  const baselinesFor = (familyId: string) => {
    reads += 1;
    const economics = familyEconomicsById(familyId);
    if (economics === null) {
      return [];
    }
    let baselines = economics.baselines;
    if (variant === "swappedbaseline" && familyId === "invoice-extraction") {
      // The (reuse, g2) recorded baseline is REPLACED with the g3
      // baseline's costs (a favorable counterfactual swapped into the
      // g2 slot): the g2 claim's own cited baseline digest is gone
      // from the served population — the counterfactual leg catches
      // the swapped basis (the claim now measures against a baseline
      // that was never recorded where it should be).
      const generation3Reuse = economics.baselines.find(
        (baseline) => baseline.generation === 3 && baseline.mechanism === "reuse",
      );
      baselines = baselines.map((baseline) =>
        baseline.generation === 2 &&
        baseline.mechanism === "reuse" &&
        generation3Reuse !== undefined
          ? { ...generation3Reuse, generation: 2 }
          : baseline,
      );
    }
    return baselines;
  };
  const recordedTotalsFor = (familyId: string) => {
    reads += 1;
    const economics = familyEconomicsById(familyId);
    if (economics === null) {
      return [];
    }
    if (variant === "unreconciled") {
      return economics.recordedTotals.map((record) => ({
        ...record,
        totalMicroUsd: record.totalMicroUsd * 2,
      }));
    }
    return economics.recordedTotals;
  };
  const maturityReportsFor = (familyId: string) => {
    reads += 1;
    const economics = familyEconomicsById(familyId);
    if (economics === null) {
      return [];
    }
    return economics.maturityReports;
  };
  const facts = (): AttributionAnalysisFacts => {
    factsReads += 1;
    const mutationDrift = variant === "mutating" && factsReads > 1 ? 1 : 0;
    return {
      familyIds: FAMILY_ECONOMICS.map((economics) => economics.familyId).sort(),
      lifecycleRecordCount:
        FAMILY_ECONOMICS.reduce(
          (total, economics) => total + economics.lifecycleRecords.length,
          0,
        ) + mutationDrift,
      generationRecordCount: FAMILY_ECONOMICS.reduce(
        (total, economics) => total + economics.generations.length,
        0,
      ),
      accountingEntryCount: FAMILY_ECONOMICS.reduce(
        (total, economics) => total + economics.ledgerEntries.length,
        0,
      ),
      baselineCount: FAMILY_ECONOMICS.reduce(
        (total, economics) => total + economics.baselines.length,
        0,
      ),
      recordedTotalCount: FAMILY_ECONOMICS.reduce(
        (total, economics) => total + economics.recordedTotals.length,
        0,
      ),
      maturityReportCount: FAMILY_ECONOMICS.reduce(
        (total, economics) => total + economics.maturityReports.length,
        0,
      ),
      registryProposalIds: FAMILY_ECONOMICS.flatMap((economics) =>
        economics.lifecycleRecords.map((record) => record.proposalId),
      ).sort(),
    };
  };
  const proposalFor = (proposalId: string): DiscoveryProposalRecord | null => {
    for (const economics of FAMILY_ECONOMICS) {
      for (const record of economics.lifecycleRecords) {
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
    baselinesFor,
    recordedTotalsFor,
    maturityReportsFor,
    facts,
    proposalFor,
    readCount: () => reads,
  };
}

// ---------------------------------------------------------------------------
// The fake attribution report ledger (append-only)
// ---------------------------------------------------------------------------

/** The fake append-only attribution report ledger (with its variant). */
export interface FakeAttributionReportLedger extends AttributionReportPort {
  /** The ledger's full append log (the audit). */
  readonly appendLog: () => readonly { readonly digest: string; readonly replayed: boolean }[];
}

/**
 * Create the fake attribution report ledger: APPEND-ONLY — an
 * identical re-append REPLAYS (idempotent), a different report under
 * the same familyId is REFUSED. The `rewrite-input` variant reaches
 * into the recorded history and mutates it on append (the read-only
 * catch the driver's before/after input digest fires).
 */
export function createAttributionReportLedger(options?: {
  readonly mutateInputOnAppend?: () => void;
}): FakeAttributionReportLedger {
  const reportsByFamily = new Map<string, SavingsAttributionReportRecord[]>();
  const log: { digest: string; replayed: boolean }[] = [];
  const reportsFor = (familyId: string): readonly SavingsAttributionReportRecord[] =>
    reportsByFamily.get(familyId) ?? [];
  return {
    append: async (record) => {
      const existing = reportsFor(record.familyId);
      const digest = savingsAttributionReportDigestOf(record);
      const prior = existing.find((entry) => entry.familyId === record.familyId);
      if (prior !== undefined) {
        if (savingsAttributionReportDigestOf(prior) === digest) {
          log.push({ digest, replayed: true });
          return { accepted: true, replayed: true, refused: false };
        }
        log.push({ digest, replayed: false });
        return { accepted: false, replayed: false, refused: true };
      }
      const appended: SavingsAttributionReportRecord = { ...record, ordinal: existing.length + 1 };
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
 * attribution semantics at the customer boundary:
 *
 *  - POST /executions — the per-row create semantics (each attribution
 *    submission lands its OWN durable execution under its OWN
 *    idempotency key);
 *  - GET /executions/:id — the row settles to its honest terminal on
 *    the read path, never backwards;
 *  - GET /executions/:id/events — the canonical attribution
 *    trajectory surfaced as the public step-event journal;
 *  - GET /executions/:id/results — the honest per-row result: the
 *    route's modelCalls (the run's own dispatches — zero offline, the
 *    live row's REAL measured round), the honest verification
 *    statuses, honestly-absent offline usage, the per-mechanism
 *    attributed totals read back, the residual read back, the
 *    per-generation splits read back, the report-recorded flag and
 *    the refusal reason read back.
 *
 * Discrimination knobs: `terminal` overrides the honest terminal;
 * `attributedsplit` inflates the surfaced attributed numbers (a
 * split read-back mismatch); `foldedresidual` folds the surfaced
 * residual into the cache mechanism (a forced residual at the
 * boundary); `gapped` drops generation 2 from the surfaced
 * per-generation splits; `inflatedtotal` inflates the surfaced
 * per-generation recorded totals (the boundary reconciliation
 * identity breaks); `unreported` surfaces no report record.
 */
export function createAttributionFakeApiWorld(options: {
  readonly clock: TickClock;
  readonly terminal?: "COMPLETED" | "FAILED";
  readonly attributedsplit?: boolean;
  readonly foldedresidual?: boolean;
  readonly gapped?: boolean;
  readonly inflatedtotal?: boolean;
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

  const rowById = (rowId: string): AttributionCorpusRow | null =>
    SAVINGS_ATTRIBUTION_CORPUS.find((candidate) => candidate.rowId === rowId) ?? null;

  /** The row's surfaced attributed totals (the knobs break the read-back). */
  const surfacedAttributedOf = (row: AttributionCorpusRow) => {
    const declared = declaredSplitTotalsOf(row);
    if (options.attributedsplit === true) {
      return { ...declared.attributed, cache: declared.attributed.cache + 25 };
    }
    if (options.foldedresidual === true) {
      return {
        ...declared.attributed,
        cache: declared.attributed.cache + declared.residualMicroUsd,
      };
    }
    return declared.attributed;
  };

  /** The row's surfaced residual (the knobs break the honesty). */
  const surfacedResidualOf = (row: AttributionCorpusRow): number => {
    const declared = declaredSplitTotalsOf(row);
    if (options.foldedresidual === true) {
      return 0;
    }
    return declared.residualMicroUsd;
  };

  /** The row's surfaced per-generation splits (the knobs break the identity). */
  const surfacedPerGenerationOf = (row: AttributionCorpusRow) => {
    let splits = row.split.claims
      .map((claim) => claim.generation)
      .filter((generation, index, all) => all.indexOf(generation) === index)
      .sort((left, right) => left - right)
      .map((generation) => {
        const perMechanism = {
          reuse: 0,
          cache: 0,
          competence: 0,
          deterministicization: 0,
        } as Record<"reuse" | "cache" | "competence" | "deterministicization", number>;
        for (const claim of row.split.claims) {
          if (claim.generation === generation) {
            perMechanism[claim.mechanism] += claim.claimedMicroUsd;
          }
        }
        const declaredResidual =
          row.split.residual.find((claim) => claim.generation === generation)?.residualMicroUsd ??
          0;
        const attributed = Object.values(perMechanism).reduce((total, value) => total + value, 0);
        const economics = familyEconomicsById(row.familyId);
        const recordedTotalMicroUsd =
          economics?.recordedTotals.find((record) => record.generation === generation)
            ?.totalMicroUsd ?? attributed + declaredResidual;
        return {
          generation,
          perMechanism,
          residualMicroUsd: declaredResidual,
          recordedTotalMicroUsd,
        };
      });
    if (options.gapped === true) {
      splits = splits.filter((split) => split.generation !== 2);
    }
    if (options.inflatedtotal === true) {
      splits = splits.map((split) => ({
        ...split,
        recordedTotalMicroUsd: split.recordedTotalMicroUsd + 50,
      }));
    }
    return splits;
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
        task: { kind: "savings-attribution.mechanism-split.v1", input: "attribution" },
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
          : attributionTrajectoryStepsOf({
              rowId: corpusRow.rowId,
              verdict: corpusRow.expected.verdict,
              claimCount: corpusRow.split.claims.length,
              reportAppended: corpusRow.expected.verdict === "attribution-established",
            }).map((step, index) => ({
              ordinal: index + 1,
              kind: (step.kind.startsWith("attribution:report")
                ? "effect"
                : step.kind.startsWith("attribution:no-evidence")
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
      const declared = corpusRow === null ? null : declaredSplitTotalsOf(corpusRow);
      return jsonResponse(200, {
        executionId: row.id,
        status: row.status === "CREATED" ? "RUNNING" : row.status,
        route: {
          provider: "fake-rail",
          model: "fake-model",
          strategyClass: "savings-attribution",
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
        attributed: corpusRow === null ? null : surfacedAttributedOf(corpusRow),
        residualMicroUsd: corpusRow === null ? null : surfacedResidualOf(corpusRow),
        claimedTotalMicroUsd:
          corpusRow === null || declared === null
            ? null
            : Object.values(surfacedAttributedOf(corpusRow)).reduce(
                (total, value) => total + value,
                0,
              ) + surfacedResidualOf(corpusRow),
        perGeneration: corpusRow === null ? [] : surfacedPerGenerationOf(corpusRow),
        refusalReason: corpusRow?.expected.refusalReason ?? null,
        reportRecorded:
          options.unreported === true
            ? false
            : (corpusRow?.expected.verdict ?? "no-evidence-honest") === "attribution-established",
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

/** The honest offline stack (the read-only economics + the append-only report ledger + the clock). */
export function createHonestAttributionStack(): {
  readonly history: FakeAttributionHistoryPort;
  readonly reportLedger: FakeAttributionReportLedger;
  readonly clock: TickClock;
} {
  return {
    history: createAttributionHistoryPort(),
    reportLedger: createAttributionReportLedger(),
    clock: createTickClock(),
  };
}

/** The observation shape re-export (the app's boundary contract basis). */
export type { AppAttributionObservation };
/** The read-only input digest helper (re-export for the consistency tests). */
export { attributionInputDigestOf };
