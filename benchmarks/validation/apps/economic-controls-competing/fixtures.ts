/**
 * The economic-controls-competing application's deterministic fixtures
 * (VAL-043, AC2 + the AC6 discrimination battery's controlled fakes).
 *
 * The controlled world the competing driver and the app execute
 * against:
 *
 *   * the COMPETING recorded-trace executor — the deterministic
 *     platform-path executor binding for the OFFLINE rows: each
 *     request replays the trace round's RECORDED competitor-interface
 *     facts (the settled aggregate usage in the ROUTED rail's
 *     manifest-declared currency, the pool endpoint observation, the
 *     internal-attempt count, the recorded latencies and verdicts, the
 *     gateway's own charge observation) — zero network, zero
 *     credentials, zero randomness, exactly reproducible from the
 *     repository. The executor routes through the declared
 *     model-selection table and reports the settings it applied (the
 *     honest shape; the knobs denature it): `undeclaredToggle` (an
 *     applied setting the declared configuration does not name — the
 *     undocumented-configuration catch), `misrouteClass` (a class
 *     routed onto a rail the model-selection table does not declare
 *     for it — the routing-conformance catch), `exceedInternalAttempts`
 *     (a request reporting more internal attempts than the recorded
 *     trace / the declared posture — the retry-posture and
 *     replay-fidelity catches), `conflateCurrency` (usage denominated
 *     in a currency that mismatches the routed rail's — the
 *     mixed-currency conflation catch), `estimateOnly` (the requests
 *     report ONLY quotes — the estimate-backed cost-per-resolution
 *     catch), `dropFailedRounds` (the executor refuses the failed
 *     requests — the post-hoc arm exclusion catch), `truncateSamples`
 *     (the sample-size violation catch) and `fabricateEndpoint` (an
 *     endpoint observation that contradicts the recorded trace — the
 *     fabricated-observation catch);
 *   * the mutated-configuration builder — an in-place
 *     configuration-bound edit with a STALE digest (the
 *     configuration-integrity catch), the honest corrected-revision
 *     builder (a NEW revision, digest recomputed) and the
 *     PINNED-ORDERING variant (the competitor configured with pinned
 *     provider ordering — variance "none": an honest alternative
 *     configuration whose observed endpoint variance FAILs the
 *     behavior-variance oracle, the between-runs silent-routing-change
 *     catch);
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
import {
  type CompetitorConfigRevision,
  competitorConfigFor,
  computeCompetitorConfigDigest,
} from "./competitor-config";
import { COMPETING_CORPUS } from "./corpus";
import type { CompetingCorpusRow, CompetitorExecutor } from "./driver";
import { economicDigestOf } from "./driver";

export type { TickClock };
export { createFakeLedger, createFakeLifecycle, createFakeSubmissionSeam, createTickClock };

// ---------------------------------------------------------------------------
// The competing recorded-trace executor (the offline binding)
// ---------------------------------------------------------------------------

/** The competing replay executor's discrimination knobs. */
export interface CompetingReplayExecutorKnobs {
  /**
   * The undocumented-configuration masquerade: the executor reports
   * (and claims to apply) a setting the declared configuration does
   * not name — the configuration-conformance oracle FAILs it
   * mechanically.
   */
  readonly undeclaredToggle?: string;
  /**
   * The routing deviation: the named task class is routed onto a rail
   * the model-selection table does not declare for it (the fallback
   * rail for the table's rail) — the model-selection-conformance
   * oracle FAILs it.
   */
  readonly misrouteClass?: string;
  /**
   * The retry-posture escalation: every request reports this many
   * EXTRA internal attempts beyond the recorded trace (and the
   * declared automatic-fallback bound) — the retry-posture and
   * replay-fidelity oracles FAIL it.
   */
  readonly exceedInternalAttempts?: number;
  /**
   * The mixed-currency conflation: usage denominated in a currency
   * that mismatches the routed rail's pinned price denomination (or
   * sits outside the pinned FX table — e.g. GBP) — the normalization
   * FAILs.
   */
  readonly conflateCurrency?: PriceCurrency;
  /**
   * The estimate-backed shape: the requests report ONLY quotes (no
   * measured usage) — the cost-per-resolved is REFUSED (never
   * estimate-backed) and the comparison FAILs.
   */
  readonly estimateOnly?: boolean;
  /**
   * The post-hoc arm exclusion: the executor refuses (skips) every
   * FAILED request — the executed slice drops the non-resolved tasks
   * and the slice-conformance oracle FAILs.
   */
  readonly dropFailedRounds?: boolean;
  /**
   * The sample-size violation: the executor skips every round after
   * the first `truncateSamples` dispatched rounds — the sufficiency
   * oracle FAILs.
   */
  readonly truncateSamples?: number;
  /**
   * The fabricated-observation shape: the executor reports the given
   * endpoint instead of the recorded trace's — the replay-fidelity
   * oracle FAILs it (an observation that contradicts the record).
   */
  readonly fabricateEndpoint?: string;
}

/**
 * Create the COMPETING recorded-trace executor: the deterministic
 * platform-path binding for the OFFLINE rows. Each request replays
 * the trace round's recorded competitor-interface facts — the settled
 * AGGREGATE usage denominated in the ROUTED rail's manifest-declared
 * currency (the competitor's internal retry amortization is inside
 * the aggregate), the pool endpoint observation, the internal-attempt
 * count, the recorded latency and verdict, the gateway's own charge
 * observation — routed through the declared model-selection table
 * with the applied-settings report (the honest shape; the knobs
 * denature it).
 */
export function createCompetingReplayExecutor(options: {
  readonly row: CompetingCorpusRow;
  readonly clock?: TickClock;
  readonly knobs?: CompetingReplayExecutorKnobs;
}): CompetitorExecutor {
  const { row } = options;
  if (row.competingReplay.length === 0) {
    throw new Error(`corpus row ${row.rowId} has no competitor trace plans (a live row?)`);
  }
  const manifest = manifestRevisionOf(row.arm.priceRevision);
  if (manifest === null) {
    throw new Error(`the arm's price revision ${row.arm.priceRevision} is not pinned`);
  }
  const config = competitorConfigFor(row.competitorConfigRevision);
  const dispatched = new Set<string>();
  const executedOrder: string[] = [];
  return async ({ taskId, attempt, taskClass }) => {
    if (options.clock !== undefined) {
      await options.clock.tick();
    }
    const plan = row.competingReplay.find((candidate) => candidate.taskId === taskId);
    if (plan === undefined) {
      return {
        kind: "failure",
        category: "slice-task-missing",
        message: `no competitor trace plan for task ${taskId}`,
        latencyMs: 0,
        requestDigest: economicDigestOf({ taskId, attempt, missing: true }),
        route: null,
        routedEndpoint: null,
        internalAttempts: 0,
        appliedSettings: [],
      };
    }
    const recorded = plan.recorded;
    if (recorded === undefined) {
      return {
        kind: "failure",
        category: "replan-missing",
        message: `the trace plan ${taskId} carries no recorded facts (a live-only plan)`,
        latencyMs: 0,
        requestDigest: economicDigestOf({ taskId, attempt, missing: true }),
        route: null,
        routedEndpoint: null,
        internalAttempts: 0,
        appliedSettings: [],
      };
    }
    if (attempt > 1) {
      // The recorded traces carry no client-side retries: a further
      // driver-side attempt is an honest non-retryable stop.
      return {
        kind: "failure",
        category: "replay-exhausted",
        message: `the recorded trace for ${taskId} has no client-side attempt ${attempt}`,
        latencyMs: 0,
        requestDigest: economicDigestOf({ taskId, attempt, exhausted: true }),
        route: null,
        routedEndpoint: null,
        internalAttempts: 0,
        appliedSettings: [],
      };
    }
    const final = recorded.internalAttempts[recorded.internalAttempts.length - 1];

    // The post-hoc arm exclusion: the executor refuses the request
    // when its settled outcome is a FAILURE (the conformance oracle
    // catches).
    if (options.knobs?.dropFailedRounds === true && final?.outcome === "failure") {
      return {
        kind: "skipped",
        skipReason: `post-hoc exclusion of the failed request ${taskId}`,
        latencyMs: 0,
        requestDigest: economicDigestOf({ taskId, attempt, excluded: true }),
        route: null,
        routedEndpoint: null,
        internalAttempts: 0,
        appliedSettings: [],
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
            routedEndpoint: null,
            internalAttempts: 0,
            appliedSettings: [],
          };
        }
        dispatched.add(taskId);
        executedOrder.push(taskId);
      }
    }

    // The route: the model-selection table's declared rail for the
    // class (the misroute knob denatures it onto the fallback rail —
    // the model-selection-conformance oracle catches).
    const honestRoute = routeForClassOf(config, taskClass);
    const misrouted =
      options.knobs?.misrouteClass !== undefined && options.knobs.misrouteClass === plan.taskClass;
    const route = misrouted ? config.fallbackRoute : honestRoute;

    // The honest currency: the ROUTED rail's manifest-declared
    // denomination (the conflation knob denatures it).
    const railCurrency: PriceCurrency =
      resolveListPrice(manifest, route.provider, route.model, "input")?.currency ?? "USD";
    const currency: PriceCurrency = options.knobs?.conflateCurrency ?? railCurrency;

    // The usage: the request's reported AGGREGATE (the competitor's
    // interface granularity — the internal retry amortization is
    // inside); the estimate-backed shape reports ONLY the quote.
    const usage =
      options.knobs?.estimateOnly === true
        ? undefined
        : {
            inputTokens: recorded.reportedUsage.inputTokens,
            outputTokens: recorded.reportedUsage.outputTokens,
            currency,
            ...(recorded.reportedChargeUsd === undefined
              ? {}
              : { costUsd: recorded.reportedChargeUsd }),
          };

    // The internal attempts: the recorded count (the escalation knob
    // inflates it beyond the declared posture).
    const internalAttempts =
      recorded.internalAttempts.length + (options.knobs?.exceedInternalAttempts ?? 0);

    // The endpoint observation: the recorded trace's (the fabrication
    // knob contradicts the record).
    const routedEndpoint = options.knobs?.fabricateEndpoint ?? plan.routedEndpoint;

    // The applied settings: the declared configuration's toggle names
    // (the masquerade knob adds an undeclared one).
    const applied = config.entries.map((entry) => entry.name);
    if (options.knobs?.undeclaredToggle !== undefined) {
      applied.push(options.knobs.undeclaredToggle);
    }

    const requestDigest = economicDigestOf({
      taskId,
      attempt,
      route,
      endpoint: routedEndpoint,
      internalAttempts,
      usage: recorded.reportedUsage,
    });
    if (final !== undefined && final.outcome === "success") {
      return {
        kind: "success",
        content: recorded.responseText ?? "confirm",
        ...(usage === undefined ? {} : { usage }),
        ...(options.knobs?.estimateOnly === true
          ? {
              estimateQuote: {
                inputTokens: recorded.reportedUsage.inputTokens,
                outputTokens: recorded.reportedUsage.outputTokens,
              },
            }
          : recorded.estimateQuote !== undefined
            ? { estimateQuote: recorded.estimateQuote }
            : {}),
        latencyMs: recorded.internalAttempts.reduce((sum, attempt) => sum + attempt.latencyMs, 0),
        requestDigest,
        route: { provider: route.provider, model: route.model },
        routedEndpoint,
        internalAttempts,
        appliedSettings: applied,
      };
    }
    return {
      kind: "failure",
      category: final?.category ?? "unknown",
      message: `the recorded request ${taskId} failed (${final?.category ?? "unknown"})`,
      ...(usage === undefined ? {} : { usage }),
      latencyMs: recorded.internalAttempts.reduce((sum, attempt) => sum + attempt.latencyMs, 0),
      requestDigest,
      route: { provider: route.provider, model: route.model },
      routedEndpoint,
      internalAttempts,
      appliedSettings: applied,
    };
  };
}

/** The model-selection resolver (the fixture-local binding of the config derivation). */
function routeForClassOf(
  config: CompetitorConfigRevision,
  taskClass: string,
): CompetitorConfigRevision["routes"][number] {
  return config.routes.find((route) => route.taskClass === taskClass) ?? config.fallbackRoute;
}

// ---------------------------------------------------------------------------
// The mutated / corrected / pinned-ordering configurations
// ---------------------------------------------------------------------------

/**
 * Build a MUTATED configuration revision for the discrimination
 * battery: one toggle's bound edited IN PLACE while the recorded
 * digest stays STALE (the "configuration correction applied in place"
 * shape — the configuration-integrity digest disagreement catch). The
 * honest correction is a NEW revision (see COMPETITOR_CONFIG's
 * cmp-rev-002).
 */
export function mutatedCompetitorConfigOf(
  revision: string,
  mutation: {
    readonly name: string;
    readonly bound: Readonly<Record<string, unknown>>;
  },
): CompetitorConfigRevision {
  const base = competitorConfigFor(revision);
  const entries = base.entries.map((entry) =>
    entry.name === mutation.name ? { ...entry, bound: mutation.bound } : entry,
  );
  // The digest is NOT recomputed — the in-place mutation is exactly
  // the shape the content-addressing must catch.
  return { ...base, entries, digest: base.digest };
}

/** Build a corrected configuration revision the HONEST way (a NEW revision, digest recomputed). */
export function correctedCompetitorConfigRevision(
  base: CompetitorConfigRevision,
  mutation: {
    readonly name: string;
    readonly bound: Readonly<Record<string, unknown>>;
  },
  newRevision: string,
): CompetitorConfigRevision {
  const entries = base.entries.map((entry) =>
    entry.name === mutation.name ? { ...entry, bound: mutation.bound } : entry,
  );
  return {
    revision: newRevision,
    entries,
    routes: base.routes,
    fallbackRoute: base.fallbackRoute,
    digest: computeCompetitorConfigDigest({
      entries,
      routes: base.routes,
      fallbackRoute: base.fallbackRoute,
    }),
    supersedes: base.revision,
  };
}

/**
 * Build the PINNED-ORDERING configuration variant: the competitor
 * configured with pinned provider ordering (variance "none" — an
 * honest alternative posture the competitor documents). Under this
 * configuration, OBSERVED endpoint variance across a run's equivalent
 * requests FAILs the behavior-variance oracle (the between-runs
 * silent-routing-change catch); identical observations PASS
 * (reproduced). The digest is RECOMPUTED — this is a legitimately
 * declared configuration, not a mutation.
 */
export function pinnedOrderingConfigOf(revision: string): CompetitorConfigRevision {
  const base = competitorConfigFor(revision);
  const entries = base.entries.map((entry) =>
    entry.kind === "provider-routing"
      ? {
          ...entry,
          bound: {
            ...entry.bound,
            ordering: "pinned",
            variance:
              "none (the provider ordering is pinned: equivalent requests must ride the same endpoint — any deviation is a silent routing change)",
          },
        }
      : entry,
  );
  return {
    ...base,
    entries,
    digest: computeCompetitorConfigDigest({
      entries,
      routes: base.routes,
      fallbackRoute: base.fallbackRoute,
    }),
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
export function createCompetingFakeApiWorld(options: {
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
    const row = COMPETING_CORPUS.find((candidate) => candidate.rowId === rowId);
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
        task: { kind: "economic-controls-competing.experiment.v1", input: "experiment" },
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
          strategyClass: "economic-controls-competing",
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

/** The trace-plan lookup helper (digest references only). */
export function tracePlanOf(row: CompetingCorpusRow, taskId: string) {
  return row.competingReplay.find((candidate) => candidate.taskId === taskId);
}
