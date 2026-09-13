/**
 * The economic-controls-optimized application's deterministic fixtures
 * (VAL-042, AC2 + the AC6 discrimination battery's controlled fakes).
 *
 * The controlled world the optimized driver and the app execute
 * against:
 *
 *   * the OPTIMIZED recorded-replay executor — the deterministic
 *     platform-path executor binding for the OFFLINE rows: each
 *     dispatch attempt replays the round plan's RECORDED accounting
 *     facts (settled usage tokens in the ROUTED rail's
 *     manifest-declared currency, the recorded latencies and verdicts,
 *     the raw payload's token count) — zero network, zero credentials,
 *     zero randomness, exactly reproducible from the repository. The
 *     executor routes through the declared inventory's routing table
 *     and reports the optimizations it applied (the honest shape; the
 *     knobs denature it): `masqueradeOptimization` (an applied
 *     optimization the inventory does not name — the
 *     undeclared-optimization catch), `misrouteClass` (a class routed
 *     onto a rail the table does not declare for it — the
 *     routing-conformance catch), `fabricateCompression` (an
 *     understated dispatched-token count — the replay-fidelity and
 *     compression-bound catches), `conflateCurrency` (usage
 *     denominated in a currency that mismatches the routed rail's —
 *     the mixed-currency conflation catch), `estimateOnly` (the
 *     rounds report ONLY planner quotes — the estimate-backed
 *     cost-per-resolution catch), `dropFailedRounds` (the executor
 *     refuses the failed rounds — the post-hoc arm exclusion catch)
 *     and `truncateSamples` (the sample-size violation catch);
 *   * the mutated-inventory builder — an in-place optimization-bound
 *     edit with a STALE digest (the inventory-integrity catch) and the
 *     honest corrected-revision builder (a NEW revision, digest
 *     recomputed);
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
 * alone.
 */

import type { TransportImplementation } from "../../harness/harness";
import {
  createFakeLedger,
  createFakeLifecycle,
  createFakeSubmissionSeam,
  createTickClock,
  type TickClock,
} from "../economic-baseline/fixtures";
import type { PriceCurrency } from "../economic-baseline/pricing";
import { manifestRevisionOf, resolveListPrice } from "../economic-baseline/pricing";
import { OPTIMIZED_CORPUS } from "./corpus";
import type { OptimizedCorpusRow, OptimizedExecutor, OptimizedRecordedRound } from "./driver";
import { economicDigestOf } from "./driver";
import {
  BATCHED_THROUGHPUT_NAME,
  computeInventoryDigest,
  inventoryFor,
  MODEL_ROUTING_NAME,
  type OptimizationInventoryRevision,
  PROMPT_COMPRESSION_NAME,
  PROVIDER_SIDE_NAME,
  routeForClass,
} from "./optimizations";

export type { TickClock };
export { createFakeLedger, createFakeLifecycle, createFakeSubmissionSeam, createTickClock };

// ---------------------------------------------------------------------------
// The optimized recorded-replay executor (the offline binding)
// ---------------------------------------------------------------------------

/** The optimized replay executor's discrimination knobs. */
export interface OptimizedReplayExecutorKnobs {
  /**
   * The undeclared-optimization masquerade: the executor reports (and
   * claims to apply) an optimization the declared inventory does not
   * name — the inventory-conformance oracle FAILs it mechanically.
   */
  readonly masqueradeOptimization?: string;
  /**
   * The routing deviation: the named task class is routed onto a rail
   * the routing table does not declare for it (the expensive rail for
   * the cheap class) — the routing-conformance oracle FAILs it.
   */
  readonly misrouteClass?: string;
  /**
   * The token-understatement masquerade: the executor reports FEWER
   * dispatched input tokens than the recorded facts — the
   * replay-fidelity and compression-bound oracles FAIL it.
   */
  readonly fabricateCompression?: { readonly inputTokens: number };
  /**
   * The mixed-currency conflation: usage denominated in a currency
   * that mismatches the routed rail's pinned price denomination (or
   * sits outside the pinned FX table — e.g. GBP) — the normalization
   * FAILs.
   */
  readonly conflateCurrency?: PriceCurrency;
  /**
   * The estimate-backed shape: the rounds report ONLY planner quotes
   * (no measured usage) — the cost-per-resolved is REFUSED (never
   * estimate-backed) and the comparison FAILs.
   */
  readonly estimateOnly?: boolean;
  /**
   * The post-hoc arm exclusion: the executor refuses (skips) every
   * FAILED round — the executed slice drops the non-resolved tasks
   * and the slice-conformance oracle FAILs.
   */
  readonly dropFailedRounds?: boolean;
  /**
   * The sample-size violation: the executor skips every round after
   * the first `truncateSamples` dispatched rounds — the sufficiency
   * oracle FAILs.
   */
  readonly truncateSamples?: number;
}

/**
 * The applied-optimization report of one honest dispatched round: the
 * routing + the compression on every dispatch, plus the batched names
 * on the batched rail's rounds (PURE).
 */
export function appliedOptimizationsOf(route: {
  readonly provider: string;
  readonly model: string;
}): readonly string[] {
  const applied: string[] = [MODEL_ROUTING_NAME, PROMPT_COMPRESSION_NAME];
  if (route.provider === "batch-relay") {
    applied.push(BATCHED_THROUGHPUT_NAME, PROVIDER_SIDE_NAME);
  }
  return applied;
}

/**
 * Create the OPTIMIZED recorded-replay executor: the deterministic
 * platform-path binding for the OFFLINE rows. Each attempt replays
 * the round plan's recorded accounting facts — the usage tokens
 * denominated in the ROUTED rail's manifest-declared currency, the
 * raw payload's token count, the recorded latencies and the recorded
 * verdicts — routed through the declared inventory's routing table
 * with the applied-optimization report (the honest shape; the knobs
 * denature it).
 */
export function createOptimizedReplayExecutor(options: {
  readonly row: OptimizedCorpusRow;
  readonly clock?: TickClock;
  readonly knobs?: OptimizedReplayExecutorKnobs;
}): OptimizedExecutor {
  const { row } = options;
  if (row.optimizedReplay.length === 0) {
    throw new Error(`corpus row ${row.rowId} has no optimized round plans (a live row?)`);
  }
  const manifest = manifestRevisionOf(row.arm.priceRevision);
  if (manifest === null) {
    throw new Error(`the arm's price revision ${row.arm.priceRevision} is not pinned`);
  }
  const inventory = inventoryFor(row.optimizationInventoryRevision);
  const dispatched = new Set<string>();
  const executedOrder: string[] = [];
  return async ({ taskId, attempt, taskClass }) => {
    if (options.clock !== undefined) {
      await options.clock.tick();
    }
    const plan = row.optimizedReplay.find((candidate) => candidate.taskId === taskId);
    if (plan === undefined) {
      return {
        kind: "failure",
        category: "slice-task-missing",
        message: `no optimized round plan for task ${taskId}`,
        latencyMs: 0,
        requestDigest: economicDigestOf({ taskId, attempt, missing: true }),
        route: null,
        appliedOptimizations: [],
      };
    }
    const recorded = plan.recorded;
    if (recorded === undefined) {
      return {
        kind: "failure",
        category: "replan-missing",
        message: `the round plan ${taskId} carries no recorded facts (a live-only plan)`,
        latencyMs: 0,
        requestDigest: economicDigestOf({ taskId, attempt, missing: true }),
        route: null,
        appliedOptimizations: [],
      };
    }
    const recordedAttempt = recorded.attempts[attempt - 1];
    if (recordedAttempt === undefined) {
      // The replay's recorded attempt sequence is exhausted: a further
      // retry is an honest non-retryable stop.
      return {
        kind: "failure",
        category: "replay-exhausted",
        message: `the recorded replay for ${taskId} has no attempt ${attempt}`,
        latencyMs: 0,
        requestDigest: economicDigestOf({ taskId, attempt, exhausted: true }),
        route: null,
        appliedOptimizations: [],
      };
    }
    const final = recorded.attempts[recorded.attempts.length - 1];

    // The post-hoc arm exclusion: the executor refuses the round when
    // its recorded outcome is a FAILURE (the conformance oracle catches).
    if (options.knobs?.dropFailedRounds === true && final?.outcome === "failure") {
      return {
        kind: "skipped",
        skipReason: `post-hoc exclusion of the failed round ${taskId}`,
        latencyMs: 0,
        requestDigest: economicDigestOf({ taskId, attempt, excluded: true }),
        route: null,
        appliedOptimizations: [],
      };
    }
    // The sample-size violation: the executor skips every round after
    // the first `truncateSamples` dispatched rounds.
    if (options.knobs?.truncateSamples !== undefined) {
      if (!dispatched.has(taskId)) {
        if (executedOrder.length >= options.knobs.truncateSamples) {
          return {
            kind: "skipped",
            skipReason: `sample truncated after ${options.knobs.truncateSamples} rounds`,
            latencyMs: 0,
            requestDigest: economicDigestOf({ taskId, attempt, truncated: true }),
            route: null,
            appliedOptimizations: [],
          };
        }
        dispatched.add(taskId);
        executedOrder.push(taskId);
      }
    }

    // The route: the routing table's declared rail for the class (the
    // misroute knob denatures it onto a rail the table does not
    // declare — the routing-conformance oracle catches).
    const honestRoute = routeForClass(inventory, taskClass);
    const misrouted =
      options.knobs?.misrouteClass !== undefined && options.knobs.misrouteClass === plan.taskClass;
    const route = misrouted ? inventory.fallbackRoute : honestRoute;

    // The honest currency: the ROUTED rail's manifest-declared
    // denomination (the conflation knob denatures it).
    const railCurrency: PriceCurrency =
      resolveListPrice(manifest, route.provider, route.model, "input")?.currency ?? "USD";
    const currency: PriceCurrency = options.knobs?.conflateCurrency ?? railCurrency;

    // The usage: the recorded dispatched tokens + the raw payload's
    // count (the estimate-backed shape reports ONLY the planner quote —
    // the fabrication knob understates the dispatched count — the
    // replay-fidelity and compression-bound oracles catch).
    const usage =
      options.knobs?.estimateOnly === true || recordedAttempt.usage === undefined
        ? undefined
        : {
            inputTokens:
              options.knobs?.fabricateCompression?.inputTokens ?? recordedAttempt.usage.inputTokens,
            outputTokens: recordedAttempt.usage.outputTokens,
            rawInputTokens: recorded.rawInputTokens,
            currency,
          };

    const applied = [...appliedOptimizationsOf(route)];
    if (options.knobs?.masqueradeOptimization !== undefined) {
      applied.push(options.knobs.masqueradeOptimization);
    }

    if (recordedAttempt.outcome === "success") {
      return {
        kind: "success",
        content: recorded.responseText ?? "confirm",
        ...(usage === undefined ? {} : { usage }),
        ...(options.knobs?.estimateOnly === true && recordedAttempt.usage !== undefined
          ? {
              estimateQuote: {
                inputTokens: recordedAttempt.usage.inputTokens,
                outputTokens: recordedAttempt.usage.outputTokens,
              },
            }
          : recorded.estimateQuote !== undefined && attempt === recorded.attempts.length
            ? { estimateQuote: recorded.estimateQuote }
            : {}),
        latencyMs: recordedAttempt.latencyMs,
        requestDigest: economicDigestOf({
          taskId,
          attempt,
          route,
          usage: recordedAttempt.usage,
        }),
        route: { provider: route.provider, model: route.model },
        appliedOptimizations: applied,
      };
    }
    return {
      kind: "failure",
      category: recordedAttempt.category ?? "unknown",
      message: `the recorded round ${taskId} failed at attempt ${attempt} (${recordedAttempt.category ?? "unknown"})`,
      ...(usage === undefined ? {} : { usage }),
      latencyMs: recordedAttempt.latencyMs,
      requestDigest: economicDigestOf({ taskId, attempt, route, usage: recordedAttempt.usage }),
      route: { provider: route.provider, model: route.model },
      appliedOptimizations: applied,
    };
  };
}

// ---------------------------------------------------------------------------
// The mutated inventory (the inventory-integrity discrimination)
// ---------------------------------------------------------------------------

/**
 * Build a MUTATED inventory revision for the discrimination battery:
 * one optimization's bound edited IN PLACE while the recorded digest
 * stays STALE (the "bound correction applied in place" shape — the
 * inventory-integrity digest disagreement catch). The honest
 * correction is a NEW revision (see OPTIMIZATION_INVENTORY's
 * opt-rev-002).
 */
export function mutatedInventoryOf(
  revision: string,
  mutation: {
    readonly name: string;
    readonly bound: Readonly<Record<string, unknown>>;
  },
): OptimizationInventoryRevision {
  const base = inventoryFor(revision);
  const entries = base.entries.map((entry) =>
    entry.name === mutation.name ? { ...entry, bound: mutation.bound } : entry,
  );
  // The digest is NOT recomputed — the in-place mutation is exactly
  // the shape the content-addressing must catch.
  return { ...base, entries, digest: base.digest };
}

/** Build a corrected inventory revision the HONEST way (a NEW revision, digest recomputed). */
export function correctedInventoryRevision(
  base: OptimizationInventoryRevision,
  mutation: {
    readonly name: string;
    readonly bound: Readonly<Record<string, unknown>>;
  },
  newRevision: string,
): OptimizationInventoryRevision {
  const entries = base.entries.map((entry) =>
    entry.name === mutation.name ? { ...entry, bound: mutation.bound } : entry,
  );
  return {
    revision: newRevision,
    entries,
    routes: base.routes,
    fallbackRoute: base.fallbackRoute,
    digest: computeInventoryDigest({
      entries,
      routes: base.routes,
      fallbackRoute: base.fallbackRoute,
    }),
    supersedes: base.revision,
  };
}

/** The mutated price-manifest builder re-export (the VAL-040 fixture, imported). */
export { correctedManifestRevision, mutatedManifestOf } from "../economic-baseline/fixtures";

/** The mutated manifest type re-export. */
export type { PriceManifestRevision } from "../economic-baseline/pricing";

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
export function createOptimizedFakeApiWorld(options: {
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
    const row = OPTIMIZED_CORPUS.find((candidate) => candidate.rowId === rowId);
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
        task: { kind: "economic-controls-optimized.experiment.v1", input: "experiment" },
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
          provider: "fake-rail",
          model: "fake-model",
          strategyClass: "economic-controls-optimized",
          modelCalls: 1,
        },
        cost: pass ? { totalMicroUsd: "22", currency: "usd" } : null,
        usage: pass ? { inputTokens: 120, outputTokens: 30 } : null,
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

/** The round-plan lookup helper (digest references only). */
export function planOf(
  row: OptimizedCorpusRow,
  taskId: string,
): OptimizedRecordedRound | undefined {
  return row.optimizedReplay.find((candidate) => candidate.taskId === taskId);
}
