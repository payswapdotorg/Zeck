/**
 * The economic-adjusted-cost application's deterministic fixtures
 * (VAL-044, AC2 + the AC6 discrimination battery's controlled fakes).
 *
 * The controlled world the synthesis driver and the app execute
 * against:
 *
 *   * the RECORDED ARM INPUTS — the digest-referenced bundles resolved
 *     from the three arms' RECORDED corpora through the driver's own
 *     extractor (the same derivation the input-integrity oracle
 *     verifies against): never copies, never re-measurements, never
 *     re-pricings. The adversarial knobs denature the honest bundle:
 *     `qualityInflation` (a claimed attainment above the recomputed
 *     one — the quality-inflated denominator catch), `latencyOmission`
 *     (the per-run latencies stripped — the latency-omitting
 *     comparison catch), `failureHiding` (the retry-overhead share and
 *     the failed rounds' cost zeroed — the failure-hiding catch),
 *     `estimateConflation` (the estimate share absorbed into the
 *     measured total — the estimate-conflation catch) and
 *     `remeasurement` (a re-measured outcome masquerading as the
 *     recorded result — the input-integrity catch). The corpus's six
 *     probe rows declare exactly these variants;
 *   * the fake accounting rails re-export (the REAL recorder +
 *     evaluation binding the driver seals the verified inputs
 *     through) and the mutated-manifest builders IMPORTED from the
 *     VAL-040 fixtures (never copied, never modified);
 *   * the fake public API world — the transport-level fake over the
 *     SDK's injected seam (the create/replay semantics at the POST
 *     boundary, the honest outcome shapes at the read boundary, the
 *     fabrication knobs).
 *
 * The fake ledger, the fake submission seam, the fake lifecycle and
 * the tick clock are the VAL-040 fixtures — IMPORTED from their
 * existing module (never copied, never modified).
 *
 * Everything is deterministic: no network, no randomness, no
 * credentials — every offline row is reproducible from the repository
 * alone (the recorded arm corpora are themselves deterministic).
 */

import type { TransportImplementation } from "../../harness/harness";
import {
  createFakeLedger,
  createFakeLifecycle,
  createFakeSubmissionSeam,
  createTickClock,
  type TickClock,
} from "../economic-baseline/fixtures";
import { ADJUSTED_CORPUS, honestInputsOf } from "./corpus";
import type { AdversarialVariantKind, RecordedArmInput } from "./driver";
import { pooledFactsOf } from "./driver";

/** The REAL accounting rails re-export (the driver's sealing binding). */
export { createRealAccountingRails } from "../economic-baseline/driver";
/** The mutated price-manifest builders re-export (the VAL-040 fixtures, imported). */
export { correctedManifestRevision, mutatedManifestOf } from "../economic-baseline/fixtures";
export { honestInputsOf } from "./corpus";
export type { TickClock };
export { createFakeLedger, createFakeLifecycle, createFakeSubmissionSeam, createTickClock };

// ---------------------------------------------------------------------------
// The recorded arm inputs (the digest-referenced bundles + the variants)
// ---------------------------------------------------------------------------

/** The adversarial input knobs (the discrimination battery's fakes). */
export interface AdversarialInputKnobs {
  /** A claimed attainment above the recomputed one (the quality-inflated denominator). */
  readonly qualityInflation?: boolean;
  /** The per-run latencies stripped from every input (the latency omission). */
  readonly latencyOmission?: boolean;
  /** The retry-overhead share and the failed rounds' cost zeroed (the failure hiding). */
  readonly failureHiding?: boolean;
  /** The estimate share absorbed into the measured total (the estimate conflation). */
  readonly estimateConflation?: boolean;
  /** A re-measured run count on the first input (the re-measurement masquerade). */
  readonly remeasurement?: boolean;
}

/** Apply one adversarial shape to the honest recorded inputs (PURE). */
export function applyAdversarialVariant(
  inputs: readonly RecordedArmInput[],
  knobs: AdversarialInputKnobs,
): readonly RecordedArmInput[] {
  if (knobs.qualityInflation === true) {
    const pooled = pooledFactsOf(inputs);
    const attainment = pooled.runs > 0 ? pooled.resolved / pooled.runs : 0;
    const inflated = attainment + 0.125;
    return inputs.map((input, index) =>
      index === 0 ? { ...input, claimed: { attainment: inflated } } : input,
    );
  }
  if (knobs.latencyOmission === true) {
    return inputs.map((input) => ({
      ...input,
      recorded: { ...input.recorded, perRunLatencyMs: [] },
    }));
  }
  if (knobs.failureHiding === true) {
    return inputs.map((input) => ({
      ...input,
      recorded: {
        ...input.recorded,
        retryOverheadMicroUsd: "0",
        failedRoundsMicroUsd: "0",
      },
    }));
  }
  if (knobs.estimateConflation === true) {
    return inputs.map((input) => {
      const measured = BigInt(input.recorded.measuredCostMicroUsd);
      const estimated = BigInt(input.recorded.estimatedCostMicroUsd);
      const retry = BigInt(input.recorded.retryOverheadMicroUsd);
      const failedRounds = BigInt(input.recorded.failedRoundsMicroUsd);
      const conflated = measured + estimated;
      return {
        ...input,
        recorded: {
          ...input.recorded,
          measuredCostMicroUsd: conflated.toString(),
          estimatedCostMicroUsd: "0",
          directExecutionMicroUsd: (conflated - retry).toString(),
          resolvedRoundsMicroUsd: (conflated - failedRounds).toString(),
        },
      };
    });
  }
  if (knobs.remeasurement === true) {
    return inputs.map((input, index) =>
      index === 0
        ? {
            ...input,
            recorded: { ...input.recorded, runCount: input.recorded.runCount + 1 },
          }
        : input,
    );
  }
  return inputs;
}

/** The knobs of one declared adversarial variant kind (PURE). */
export function knobsOfVariant(kind: AdversarialVariantKind): AdversarialInputKnobs {
  switch (kind) {
    case "quality-inflation":
      return { qualityInflation: true };
    case "latency-omission":
      return { latencyOmission: true };
    case "failure-hiding":
      return { failureHiding: true };
    case "estimate-conflation":
      return { estimateConflation: true };
    case "remeasurement":
      return { remeasurement: true };
    case "below-minimum-claim":
      // The below-minimum claim is a ROW-level dishonesty (the verdict
      // claimed below the pre-registered minimums) — the inputs stay
      // the honest recorded bundles.
      return {};
  }
}

/**
 * The recorded inputs of one corpus row (DETERMINISTIC): the honest
 * digest-referenced bundles resolved from the arms' RECORDED corpora,
 * with the row's declared adversarial variant applied when the row is
 * a probe (the probe rows' expected terminals pin exactly these
 * denatured shapes).
 */
export function inputsForRow(row: {
  readonly armSet: readonly Parameters<typeof honestInputsOf>[0][number][];
  readonly adversarial?: AdversarialVariantKind;
}): readonly RecordedArmInput[] {
  const honest = honestInputsOf(row.armSet);
  if (row.adversarial === undefined) {
    return honest;
  }
  return applyAdversarialVariant(honest, knobsOfVariant(row.adversarial));
}

// ---------------------------------------------------------------------------
// The fake public API world (the app's transport-level fake)
// ---------------------------------------------------------------------------

/**
 * The transport-level fake public API implementing the platform's OWN
 * semantics at the customer boundary (mirroring the VAL-040 fake
 * world over THIS slice's corpus):
 *
 *  - POST /executions — the create/replay semantics (the first
 *    insert's synchronous critical section wins; a same-fingerprint
 *    re-issue replays the committed receipt; a different fingerprint
 *    gets the typed 409 IDEMPOTENCY_KEY_REUSED);
 *  - GET /executions/:id — the row settles to its honest outcome on
 *    the read path, unless an override knob is set;
 *  - GET /executions/:id/results — the honest result package: the
 *    COMPLETED rows carry all-PASS verification statuses.
 *
 * Discrimination knobs: `terminal`/`verificationStatuses` override the
 * honest outcome; `fabricatePassWithFail` settles a FAILED-expected
 * row into a COMPLETED terminal WITH a FAIL verification status (the
 * app-level adversarial probe).
 */
export function createAdjustedFakeApiWorld(options: {
  readonly clock: TickClock;
  /** Override the honest terminal (the discrimination knob). */
  readonly terminal?: "COMPLETED" | "FAILED";
  /** Override the honest verification statuses (the discrimination knob). */
  readonly verificationStatuses?: readonly string[];
  /** The adversarial knob: COMPLETED terminal WITH a FAIL status. */
  readonly fabricatePassWithFail?: boolean;
}): {
  readonly transport: TransportImplementation;
  readonly createdExecutions: number;
  readonly rows: Map<
    string,
    { id: string; key: string; taskRowId: string; status: string; createdAt: number }
  >;
  readonly records: Map<string, { fingerprint: string; executionId: string }>;
} {
  const rows = new Map<
    string,
    { id: string; key: string; taskRowId: string; status: string; createdAt: number }
  >();
  const records = new Map<string, { fingerprint: string; executionId: string }>();
  const settled = new Set<string>();
  const TERMINAL = new Set(["COMPLETED", "FAILED", "CANCELLED", "EXPIRED"]);
  let sequence = 0;
  let createdExecutions = 0;
  const clock = options.clock;

  /** The row's honest outcome shape (derived from the corpus itself). */
  const honestOutcomeFor = (rowId: string): { terminal: string; statuses: string[] } => {
    const row = ADJUSTED_CORPUS.find((candidate) => candidate.rowId === rowId);
    if (row === undefined) {
      return { terminal: "FAILED", statuses: ["FAIL"] };
    }
    if (row.expected.terminal === "COMPLETED") {
      return { terminal: "COMPLETED", statuses: ["PASS", "PASS"] };
    }
    // The honest FAILED shape: the failure criterion FAILs visibly.
    return { terminal: "FAILED", statuses: ["FAIL", "PASS"] };
  };

  /** The effective outcome for one row (the knobs override the honest shape). */
  const outcomeFor = (rowId: string): { terminal: string; statuses: string[] } => {
    const honest = honestOutcomeFor(rowId);
    if (options.fabricatePassWithFail === true && honest.terminal === "FAILED") {
      // The ADVERSARIAL fabrication: the FAILED-expected row settles
      // COMPLETED while its verification carries a FAIL status.
      return { terminal: "COMPLETED", statuses: ["FAIL", "PASS"] };
    }
    return {
      terminal: options.terminal ?? honest.terminal,
      statuses:
        options.verificationStatuses === undefined
          ? honest.statuses
          : [...options.verificationStatuses],
    };
  };

  const fingerprintOf = (body: unknown): string => JSON.stringify(body ?? null);

  const transport: TransportImplementation = async (input: unknown, init?: unknown) => {
    const url = String(input);
    const method = String((init as RequestInit | undefined)?.method ?? "GET").toUpperCase();
    await clock.tick();

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
      const fingerprint = fingerprintOf(body);
      const existing = records.get(key);
      if (existing !== undefined && existing.fingerprint === fingerprint) {
        const row = rows.get(existing.executionId);
        return jsonResponse(201, {
          executionId: existing.executionId,
          applicationId: body.applicationId ?? "app-1",
          status: row?.status ?? "CREATED",
          createdAt: new Date(row?.createdAt ?? 0).toISOString(),
          replayed: true,
          lastEventSequence: 1,
        });
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
      rows.set(id, {
        id,
        key,
        taskRowId: String((body.task as { rowId?: unknown } | null)?.rowId ?? ""),
        status: "CREATED",
        createdAt: clock.now().getTime(),
      });
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
      // The row settles on the read path — ONCE, and never backwards.
      if (row.status === "CREATED" && !settled.has(row.id)) {
        settled.add(row.id);
        row.status = outcomeFor(row.taskRowId).terminal;
      }
      return jsonResponse(200, {
        id: row.id,
        applicationId: "app-1",
        environmentId: null,
        status: row.status,
        task: { kind: "economic-adjusted-cost.experiment.v1", input: "synthesis" },
        constraints: null,
        metadata: {},
        createdAt: new Date(row.createdAt).toISOString(),
        updatedAt: new Date(clock.now().getTime()).toISOString(),
        terminalAt: TERMINAL.has(row.status) ? new Date(clock.now().getTime()).toISOString() : null,
      });
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
      const outcome = outcomeFor(row.taskRowId);
      const pass = row.status === "COMPLETED";
      return jsonResponse(200, {
        executionId: row.id,
        status: row.status === "CREATED" ? "RUNNING" : row.status,
        route: {
          provider: "synthesis",
          model: "recorded-arm-corpora",
          strategyClass: "economic-adjusted-cost",
          modelCalls: 1,
        },
        cost: pass ? { totalMicroUsd: "0", currency: "usd" } : null,
        usage: null,
        outputArtifacts: [],
        verification: outcome.statuses.map((status, index) => ({
          id: `v${index + 1}`,
          executionId: row.id,
          criterionId: `criterion-${index + 1}`,
          strategy: "deterministic",
          status,
          recordedBy: "fake-platform",
        })),
        warnings: [],
        terminalAt: TERMINAL.has(row.status) ? new Date(clock.now().getTime()).toISOString() : null,
      });
    }

    return jsonResponse(500, {
      code: "INTERNAL",
      message: `unmapped fake route ${url}`,
      retryable: true,
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

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
