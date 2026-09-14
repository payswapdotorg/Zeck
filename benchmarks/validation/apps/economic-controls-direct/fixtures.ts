/**
 * The economic-controls-direct application's deterministic fixtures
 * (VAL-041, AC2 + the AC6 discrimination battery's controlled fakes).
 *
 * The controlled world the direct driver and the app execute against:
 *
 *   * the DIRECT recorded-trace executor — the deterministic
 *     platform-path executor binding for the OFFLINE rows: each
 *     attempt replays the trace round's RECORDED direct-rail facts
 *     (the per-attempt measured usage in the pinned rail's
 *     manifest-declared currency, the platform/gateway artifact
 *     observations, the recorded latencies and verdicts, the
 *     provider's own charge observation) — zero network, zero
 *     credentials, zero randomness, exactly reproducible from the
 *     repository. The honest dispatch reports an EMPTY artifact list;
 *     the knobs denature it: `shortcutArtifact` (a platform/gateway
 *     artifact smuggled into the dispatch — the platform-shortcut
 *     masquerade catch), `conflateCurrency` (usage denominated in a
 *     currency that mismatches the pinned rail's — the mixed-currency
 *     conflation catch), `estimateOnly` (the attempts report ONLY
 *     quotes — the estimate-backed cost-per-resolution catch),
 *     `dropFailedRounds` (the executor refuses the failed rounds —
 *     the post-hoc arm exclusion catch) and `truncateSamples` (the
 *     sample-size violation catch). The corpus's five probe rows
 *     carry the same denatured shapes as RECORDED data;
 *   * the mutated-manifest builder — an in-place price edit with a
 *     STALE digest (the manifest-integrity catch) — and the honest
 *     corrected-revision builder, IMPORTED from the VAL-040 fixtures
 *     (never copied, never modified);
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
import { DIRECT_CORPUS } from "./corpus";
import type { DirectCorpusRow, DirectExecutor } from "./driver";
import { economicDigestOf } from "./driver";

export type { TickClock };
export { createFakeLedger, createFakeLifecycle, createFakeSubmissionSeam, createTickClock };

// ---------------------------------------------------------------------------
// The direct recorded-trace executor (the offline binding)
// ---------------------------------------------------------------------------

/** The direct replay executor's discrimination knobs. */
export interface DirectReplayExecutorKnobs {
  /**
   * The platform-shortcut masquerade: the dispatch reports (and
   * claims to have ridden) a platform/gateway artifact — the
   * arm-conformance oracle FAILs it mechanically with the artifact
   * named.
   */
  readonly shortcutArtifact?: string;
  /**
   * The mixed-currency conflation: usage denominated in a currency
   * that mismatches the pinned rail's price denomination (or sits
   * outside the pinned FX table — e.g. GBP) — the normalization
   * FAILs.
   */
  readonly conflateCurrency?: PriceCurrency;
  /**
   * The estimate-backed shape: the attempts report ONLY quotes (no
   * measured usage) — the cost-per-resolved is REFUSED (never
   * estimate-backed) and the comparison FAILs.
   */
  readonly estimateOnly?: boolean;
  /**
   * The post-hoc arm exclusion: the executor refuses (skips) every
   * FAILED round — the executed slice drops the non-resolved tasks
   * and the sample-discipline oracle FAILs.
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
 * Create the DIRECT recorded-trace executor: the deterministic
 * platform-path binding for the OFFLINE rows. Each attempt replays
 * the trace round's recorded direct-rail facts — the attempt's own
 * measured usage denominated in the pinned rail's manifest-declared
 * currency (the client-side bounded retry is the driver's own: each
 * failed attempt is a SEPARATE fact), the platform/gateway artifact
 * observations (an honest direct dispatch reports NONE), the recorded
 * latency and verdict, the provider's own charge observation on the
 * settling attempt (the honest shape; the knobs denature it).
 */
export function createDirectReplayExecutor(options: {
  readonly row: DirectCorpusRow;
  readonly clock?: TickClock;
  readonly knobs?: DirectReplayExecutorKnobs;
}): DirectExecutor {
  const { row } = options;
  const manifest = manifestRevisionOf(row.arm.priceRevision);
  if (manifest === null) {
    throw new Error(`the arm's price revision ${row.arm.priceRevision} is not pinned`);
  }
  const railCurrency: PriceCurrency =
    resolveListPrice(manifest, row.arm.provider, row.arm.model, "input")?.currency ?? "USD";
  const dispatched = new Set<string>();
  const executedOrder: string[] = [];
  return async ({ taskId, attempt }) => {
    if (options.clock !== undefined) {
      await options.clock.tick();
    }
    const plan = row.directReplay.find((candidate) => candidate.taskId === taskId);
    if (plan === undefined) {
      // The sample-starved shape: no recorded plan for the
      // pre-registered task — an honest skip, never a fabricated run.
      return {
        kind: "skipped",
        skipReason: "sample-truncated (no recorded plan for the pre-registered task)",
        latencyMs: 0,
        requestDigest: economicDigestOf({ taskId, attempt, truncated: true }),
        platformArtifacts: [],
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
        platformArtifacts: [],
      };
    }
    const attemptFact = recorded.attempts[attempt - 1];
    if (attemptFact === undefined) {
      // The recorded traces carry the settled attempt sequence: a
      // further driver-side attempt is an honest non-retryable stop.
      return {
        kind: "failure",
        category: "replay-exhausted",
        message: `the recorded trace for ${taskId} has no client-side attempt ${attempt}`,
        latencyMs: 0,
        requestDigest: economicDigestOf({ taskId, attempt, exhausted: true }),
        platformArtifacts: [],
      };
    }
    const isFinal = attempt === recorded.attempts.length;

    // The post-hoc arm exclusion: the executor refuses the round when
    // its settled outcome is a FAILURE (the sample-discipline oracle
    // catches) — either from the trace's own probe marker or the knob.
    if (
      attemptFact.outcome === "failure" &&
      (recorded.postHocExcluded === true || options.knobs?.dropFailedRounds === true)
    ) {
      return {
        kind: "skipped",
        skipReason: `post-hoc exclusion of the failed round ${taskId}`,
        latencyMs: 0,
        requestDigest: economicDigestOf({ taskId, attempt, excluded: true }),
        platformArtifacts: [],
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
            platformArtifacts: [],
          };
        }
        dispatched.add(taskId);
        executedOrder.push(taskId);
      }
    }

    // The honest currency: the pinned rail's manifest-declared
    // denomination (the trace's own probe currency or the conflation
    // knob denatures it).
    const currency: PriceCurrency =
      options.knobs?.conflateCurrency ?? recorded.usageCurrency ?? railCurrency;

    // The usage: the attempt's OWN measured fact (the direct
    // granularity — the settling attempt carries the provider's own
    // charge observation); the estimate-backed shape reports ONLY the
    // quote.
    const estimateOnly = options.knobs?.estimateOnly === true || recorded.estimateOnly === true;
    const usage =
      attemptFact.usage === undefined || estimateOnly
        ? undefined
        : {
            inputTokens: attemptFact.usage.inputTokens,
            outputTokens: attemptFact.usage.outputTokens,
            currency,
            ...(isFinal && recorded.reportedChargeUsd !== undefined
              ? { costUsd: recorded.reportedChargeUsd }
              : {}),
          };

    // The platform/gateway artifact observations: the recorded trace's
    // own probe artifacts (the masquerade knob adds one).
    const platformArtifacts = [...(recorded.platformArtifacts ?? [])];
    if (options.knobs?.shortcutArtifact !== undefined) {
      platformArtifacts.push(options.knobs.shortcutArtifact);
    }

    const quote = recorded.estimateQuote;
    const requestDigest = economicDigestOf({
      taskId,
      attempt,
      usage: attemptFact.usage,
      currency,
      platformArtifacts,
    });
    if (attemptFact.outcome === "success") {
      return {
        kind: "success",
        content: recorded.responseText ?? "confirm",
        ...(usage === undefined ? {} : { usage }),
        ...(estimateOnly && quote !== undefined
          ? { estimateQuote: quote }
          : isFinal && quote !== undefined
            ? { estimateQuote: quote }
            : {}),
        latencyMs: attemptFact.latencyMs,
        requestDigest,
        platformArtifacts,
      };
    }
    return {
      kind: "failure",
      category: attemptFact.category ?? "unknown",
      message: `the recorded attempt ${attempt} of ${taskId} failed (${attemptFact.category ?? "unknown"})`,
      ...(usage === undefined ? {} : { usage }),
      latencyMs: attemptFact.latencyMs,
      requestDigest,
      platformArtifacts,
    };
  };
}

/** The mutated price-manifest builders re-export (the VAL-040 fixtures, imported). */
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
export function createDirectFakeApiWorld(options: {
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
    const row = DIRECT_CORPUS.find((candidate) => candidate.rowId === rowId);
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
        task: { kind: "economic-controls-direct.experiment.v1", input: "experiment" },
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
          strategyClass: "economic-controls-direct",
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
export function tracePlanOf(row: DirectCorpusRow, taskId: string) {
  return row.directReplay.find((candidate) => candidate.taskId === taskId);
}

/** The direct dispatch outcome type re-export (the executor contract). */
export type { DirectDispatchOutcome, DirectExecutor } from "./driver";
