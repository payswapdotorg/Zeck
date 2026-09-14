/**
 * The economic-substrate-runtime application's deterministic fixtures
 * (VAL-046, AC2 + the AC6 discrimination battery's controlled fakes).
 *
 * The controlled world the synthesis driver and the app execute
 * against:
 *
 *   * the RECORDED WINDOW INPUTS — the digest-referenced bundles
 *     resolved from the pinned telemetry corpus through the same
 *     extractor the input-integrity oracle verifies against: never
 *     copies, never re-measurements, never re-pricings. The
 *     adversarial CLAIM knobs denature the honest bundle's CLAIMS
 *     (the claims ride OUTSIDE the recorded facts — exactly the
 *     gaming surface the oracles catch): `startupHiding` (a claimed
 *     zero startup share against a recorded warm-up — the
 *     startup-hiding catch), `readinessInflation` (a claimed
 *     first-usable at the first REFUSED probe's timestamp — the
 *     readiness-inflation catch), `reservedConflation` (a claimed
 *     measured total absorbing the standing reservation while claiming
 *     a zero reserved share — the reserved/measured conflation catch),
 *     `failureAmortizationAway` (claimed-away restart/eviction shares
 *     against recorded failure counts — the amortization-away catch).
 *     The FACTS-level knobs (for the discrimination battery):
 *     `remeasurement` (a re-measured served run count masquerading as
 *     the recorded result — the input-integrity catch),
 *     `silentAbsorption` (zeroed substrate cost fields — the
 *     readiness-adjusted family's own absorption catch) and
 *     `firstDispatchedMisattribution` (a startup duration using the
 *     first-dispatched point — the readiness misattribution catch).
 *     The ROW-level knobs: `postHocExclusion` (a pre-registered window
 *     dropped from the executed set);
 *   * the fake accounting rails re-export (the REAL recorder +
 *     evaluation binding the driver seals the verified inputs through)
 *     and the fake ledger/lifecycle/submission-seam/tick-clock
 *     re-exports IMPORTED from the VAL-040 fixtures (never copied,
 *     never modified);
 *   * the fake public API world — the transport-level fake over the
 *     SDK's injected seam (the create/replay semantics at the POST
 *     boundary, the honest outcome shapes at the read boundary, the
 *     fabrication knobs).
 *
 * Everything is deterministic: no network, no randomness, no
 * credentials — every offline row is reproducible from the repository
 * alone (the recorded telemetry corpus is itself deterministic).
 */

import type { TransportImplementation } from "../../harness/harness";
import {
  createFakeLedger,
  createFakeLifecycle,
  createFakeSubmissionSeam,
  createTickClock,
  type TickClock,
} from "../economic-baseline/fixtures";
import type { HonestWindowBundle } from "./corpus";
import { honestWindowInputsOf, SUBSTRATE_CORPUS } from "./corpus";
import type { SubstrateAdversarialKind, SubstrateWindowInput } from "./driver";

/** The REAL accounting rails re-export (the driver's sealing binding). */
export { createRealAccountingRails } from "../economic-baseline/driver";
export { honestWindowInputsOf } from "./corpus";
export type { HonestWindowBundle, TickClock };
export { createFakeLedger, createFakeLifecycle, createFakeSubmissionSeam, createTickClock };

// ---------------------------------------------------------------------------
// The adversarial input knobs (the discrimination battery's fakes)
// ---------------------------------------------------------------------------

/** The adversarial input knobs (each names the criterion it must FAIL). */
export interface SubstrateAdversarialInputKnobs {
  /** A claimed zero startup share against a recorded warm-up (the startup hiding). */
  readonly startupHiding?: boolean;
  /** A claimed first-usable at the first REFUSED probe (the readiness inflation). */
  readonly readinessInflation?: boolean;
  /** A claimed measured total absorbing the standing reservation (the reserved/measured conflation). */
  readonly reservedConflation?: boolean;
  /** Claimed-away restart/eviction shares against recorded failure counts (the amortization-away). */
  readonly failureAmortizationAway?: boolean;
  /** A re-measured served run count on the first window (the re-measurement masquerade). */
  readonly remeasurement?: boolean;
  /** Zeroed substrate cost fields (the silent absorption — the readiness-adjusted family's catch). */
  readonly silentAbsorption?: boolean;
  /** A startup duration using the first-dispatched point (the misattribution). */
  readonly firstDispatchedMisattribution?: boolean;
}

/**
 * Apply one adversarial shape to the honest window inputs (PURE). The
 * CLAIM knobs denature the bundles' CLAIMS (outside the recorded
 * facts — the gaming surface); the FACTS knobs denature the recorded
 * facts themselves (the integrity catch's surface).
 */
export function applySubstrateAdversarialVariant(
  inputs: readonly SubstrateWindowInput[],
  knobs: SubstrateAdversarialInputKnobs,
): readonly SubstrateWindowInput[] {
  if (knobs.startupHiding === true) {
    return inputs.map((input, index) =>
      index === 0 ? { ...input, claimed: { ...input.claimed, startupShareMicroUsd: "0" } } : input,
    );
  }
  if (knobs.readinessInflation === true) {
    return inputs.map((input, index) => {
      if (index !== 0) {
        return input;
      }
      const firstProbe = input.facts.readinessProbes[0];
      return {
        ...input,
        claimed: {
          ...input.claimed,
          firstUsableAtMs: firstProbe === undefined ? 0 : firstProbe.atMs,
        },
      };
    });
  }
  if (knobs.reservedConflation === true) {
    return inputs.map((input) => {
      const reserved = BigInt(input.facts.reservedMicroUsd);
      if (reserved === 0n) {
        return input;
      }
      return {
        ...input,
        claimed: {
          ...input.claimed,
          reservedShareMicroUsd: "0",
          measuredMicroUsd: (BigInt(input.facts.measuredMicroUsd) + reserved).toString(),
        },
      };
    });
  }
  if (knobs.failureAmortizationAway === true) {
    return inputs.map((input) =>
      input.facts.restarts > 0 || input.facts.evictions > 0
        ? {
            ...input,
            claimed: {
              ...input.claimed,
              restartShareMicroUsd: "0",
              evictionShareMicroUsd: "0",
            },
          }
        : input,
    );
  }
  if (knobs.remeasurement === true) {
    return inputs.map((input, index) =>
      index === 0
        ? {
            ...input,
            facts: { ...input.facts, servedRuns: input.facts.servedRuns + 1 },
          }
        : input,
    );
  }
  if (knobs.silentAbsorption === true) {
    return inputs.map((input) => ({
      ...input,
      facts: {
        ...input.facts,
        startupShareMicroUsd: "0",
        sustainedShareMicroUsd: "0",
        restartShareMicroUsd: "0",
        evictionShareMicroUsd: "0",
        reservedShareMicroUsd: "0",
        measuredMicroUsd: "0",
        reservedMicroUsd: "0",
        totalMicroUsd: "0",
      },
    }));
  }
  if (knobs.firstDispatchedMisattribution === true) {
    return inputs.map((input, index) => {
      if (index !== 0) {
        return input;
      }
      const misattributedStartup = input.facts.firstDispatchedAtMs - input.facts.coldStartBeganAtMs;
      return {
        ...input,
        facts: {
          ...input.facts,
          startupMs: misattributedStartup,
        },
      };
    });
  }
  return inputs;
}

/** The knobs of one declared adversarial variant kind (PURE). */
export function knobsOfSubstrateVariant(
  kind: SubstrateAdversarialKind,
): SubstrateAdversarialInputKnobs {
  switch (kind) {
    case "startup-hiding":
      return { startupHiding: true };
    case "readiness-inflation":
      return { readinessInflation: true };
    case "reserved-conflation":
      return { reservedConflation: true };
    case "failure-amortization-away":
      return { failureAmortizationAway: true };
    case "remeasurement":
      return { remeasurement: true };
    case "post-hoc-exclusion":
      // The post-hoc exclusion is a ROW-level dishonesty (a
      // pre-registered window dropped from the executed set) — the
      // inputs stay the honest recorded bundles.
      return {};
    case "below-minimum-claim":
      // The below-minimum claim is a ROW-level dishonesty (the verdict
      // claimed below the pre-registered minimums) — the inputs stay
      // the honest recorded bundles.
      return {};
  }
}

/**
 * The window inputs of one corpus row (DETERMINISTIC): the honest
 * digest-referenced bundles resolved from the recorded telemetry
 * corpus, with the row's declared adversarial variant applied when the
 * row is a probe (the probe rows' expected terminals pin exactly these
 * denatured shapes — the post-hoc exclusion drops the last window).
 */
export function windowInputsForRow(row: {
  readonly windowSet: readonly Parameters<typeof honestWindowInputsOf>[0][number][];
  readonly adversarial?: SubstrateAdversarialKind;
}): readonly SubstrateWindowInput[] {
  const honest = honestWindowInputsOf(row.windowSet);
  if (row.adversarial === undefined) {
    return honest;
  }
  if (row.adversarial === "post-hoc-exclusion") {
    return honest.slice(0, Math.max(0, honest.length - 1));
  }
  return applySubstrateAdversarialVariant(honest, knobsOfSubstrateVariant(row.adversarial));
}

// ---------------------------------------------------------------------------
// The fake public API world (the app's transport-level fake)
// ---------------------------------------------------------------------------

/**
 * The transport-level fake public API implementing the platform's OWN
 * semantics at the customer boundary (mirroring the VAL-040 fake world
 * over THIS slice's corpus):
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
export function createSubstrateFakeApiWorld(options: {
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
    const row = SUBSTRATE_CORPUS.find((candidate) => candidate.rowId === rowId);
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
        task: { kind: "economic-substrate-runtime.experiment.v1", input: "synthesis" },
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
          provider: "substrate",
          model: "recorded-substrate-telemetry",
          strategyClass: "economic-substrate-runtime",
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
