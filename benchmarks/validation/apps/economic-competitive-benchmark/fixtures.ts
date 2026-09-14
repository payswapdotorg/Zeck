/**
 * The economic-competitive-benchmark application's deterministic
 * fixtures (VAL-048, AC2 + the AC6 discrimination battery's controlled
 * fakes).
 *
 * The controlled world the competitive driver and the app execute
 * against:
 *
 *   * the RECORDED COMPETITIVE INPUTS — the digest-referenced arm
 *     bundles resolved from the imported recorded corpora through the
 *     same extractor the input-integrity oracle verifies against:
 *     never copies, never re-measurements, never re-pricings. The
 *     adversarial variants denature the honest bundles' shapes (the
 *     gaming surface the oracles catch): `unitPooling` (another
 *     cohort's rounds appended to the row's blocks — the unit
 *     comparability catch), `remeasurement` (a re-measured cost on the
 *     zeck arm's first block — the input-integrity catch). The
 *     ROW-level dishonest shapes (the cherry-picked portfolio subset,
 *     the sample-starved verdict claim) and the CLAIM-level
 *     dishonesties (the basis switch, the unpaired statistic, the
 *     inflated p-value) live in the corpus's probe rows;
 *   * the REAL accounting rails re-export (the recorder + evaluation
 *     binding the driver seals the verified inputs through) and the
 *     fake ledger/lifecycle/submission-seam/tick-clock re-exports
 *     IMPORTED from the VAL-040 fixtures (never copied, never
 *     modified);
 *   * the fake public API world — the transport-level fake over the
 *     SDK's injected seam (the create/replay semantics at the POST
 *     boundary, the honest outcome shapes at the read boundary, the
 *     fabrication knobs).
 *
 * Everything is deterministic: no network, no randomness, no
 * credentials — every offline row is reproducible from the repository
 * alone (the recorded corpora + the pinned manifests are themselves
 * deterministic).
 */

import type { TransportImplementation } from "../../harness/harness";
import {
  createFakeLedger,
  createFakeLifecycle,
  createFakeSubmissionSeam,
  createTickClock,
  type TickClock,
} from "../economic-baseline/fixtures";
import { COMPETITIVE_CORPUS, honestCompetitiveInputsOf, ZERO_COHORT } from "./corpus";
import type {
  CompetitiveAdversarialKind,
  CompetitiveArmReference,
  RecordedCompetitiveArm,
} from "./driver";

/** The REAL accounting rails re-export (the driver's sealing binding). */
export { createRealAccountingRails } from "../economic-baseline/driver";
export { honestCompetitiveInputsOf } from "./corpus";
export type { TickClock };
export { createFakeLedger, createFakeLifecycle, createFakeSubmissionSeam, createTickClock };

// ---------------------------------------------------------------------------
// The adversarial input knobs (the discrimination battery's fakes)
// ---------------------------------------------------------------------------

/** The adversarial input knobs (each names the criterion it must FAIL). */
export interface CompetitiveAdversarialInputKnobs {
  /** Another cohort's rounds appended to every arm's blocks (the unit pooling). */
  readonly unitPooling?: boolean;
  /** A re-measured cost on the zeck arm's first block (the re-measurement masquerade). */
  readonly remeasurement?: boolean;
}

/**
 * Apply one adversarial shape to the honest competitive inputs (PURE).
 * The variants denature the arm bundles' BLOCKS (the gaming surface):
 * the unit-pooling knob appends the zero-resolved cohort's rounds to
 * every arm (incomparable units pooled into the paired set); the
 * re-measurement knob denatures the zeck arm's first block's cost
 * (a re-measurement masquerading as derivation).
 */
export function applyCompetitiveAdversarialVariant(
  inputs: readonly RecordedCompetitiveArm[],
  knobs: CompetitiveAdversarialInputKnobs,
): readonly RecordedCompetitiveArm[] {
  if (knobs.unitPooling === true) {
    const zeroInputs = honestCompetitiveInputsOf(ZERO_COHORT.armSet);
    return inputs.map((arm) => {
      const zeroArm = zeroInputs.find(
        (candidate) => candidate.reference.armKind === arm.reference.armKind,
      );
      if (zeroArm === undefined) {
        return arm;
      }
      const pooledRounds = [...arm.facts.rounds, ...zeroArm.facts.rounds].map((round, index) => ({
        ...round,
        roundIndex: index,
      }));
      const measured = pooledRounds.reduce(
        (total, round) => total + BigInt(round.measuredCostMicroUsd),
        0n,
      );
      const resolved = pooledRounds.filter((round) => round.resolved).length;
      const resolvedShare = pooledRounds
        .filter((round) => round.resolved)
        .reduce((total, round) => total + BigInt(round.measuredCostMicroUsd), 0n);
      const failedShare = pooledRounds
        .filter((round) => !round.resolved)
        .reduce((total, round) => total + BigInt(round.measuredCostMicroUsd), 0n);
      const retry = pooledRounds.reduce(
        (total, round) => total + BigInt(round.retryOverheadMicroUsd),
        0n,
      );
      return {
        ...arm,
        facts: {
          ...arm.facts,
          rounds: pooledRounds,
          runCount: pooledRounds.length,
          resolvedCount: resolved,
          measuredCostMicroUsd: measured.toString(),
          retryOverheadMicroUsd: retry.toString(),
          resolvedRoundsMicroUsd: resolvedShare.toString(),
          failedRoundsMicroUsd: failedShare.toString(),
          costPerResolvedMicroUsd: resolved > 0 ? (measured / BigInt(resolved)).toString() : null,
        },
      };
    });
  }
  if (knobs.remeasurement === true) {
    return inputs.map((arm) => {
      if (arm.reference.armKind !== "zeck" || arm.facts.rounds.length === 0) {
        return arm;
      }
      const first = arm.facts.rounds[0];
      if (first === undefined) {
        return arm;
      }
      const denatured = {
        ...first,
        measuredCostMicroUsd: (BigInt(first.measuredCostMicroUsd) + 1n).toString(),
      };
      const rounds = [denatured, ...arm.facts.rounds.slice(1)];
      const measured = rounds.reduce(
        (total, round) => total + BigInt(round.measuredCostMicroUsd),
        0n,
      );
      return {
        ...arm,
        facts: {
          ...arm.facts,
          rounds,
          measuredCostMicroUsd: measured.toString(),
        },
      };
    });
  }
  return inputs;
}

/** The knobs of one declared adversarial variant kind (PURE). */
export function knobsOfCompetitiveVariant(
  kind: CompetitiveAdversarialKind,
): CompetitiveAdversarialInputKnobs {
  switch (kind) {
    case "subset-cherry-picking":
      // The cherry-picked portfolio is a ROW-level dishonesty (the
      // declared weights omitting recorded classes) — the inputs stay
      // the honest recorded bundles.
      return {};
    case "unit-pooling":
      return { unitPooling: true };
    case "cost-basis-switching":
      // The basis switch is a CLAIM-level dishonesty (the row's claimed
      // comparison riding mixed bases) — the inputs stay the honest
      // recorded bundles.
      return {};
    case "unpaired-statistics":
      // The unpaired statistic is a CLAIM-level dishonesty (the row's
      // claimed statistic discarding the pairing) — the inputs stay
      // the honest recorded bundles.
      return {};
    case "confidence-inflation":
      // The confidence inflation is a CLAIM-level dishonesty (the
      // fabricated p-value) — the inputs stay the honest recorded
      // bundles.
      return {};
    case "sample-starvation":
      // The sample starvation is a ROW-level dishonesty (the
      // below-minimum verdict claim) — the inputs stay the honest
      // recorded bundles.
      return {};
  }
}

/**
 * The competitive inputs of one corpus row (DETERMINISTIC): the honest
 * digest-referenced bundles resolved from the recorded corpora, with
 * the row's declared adversarial variant applied when the row is a
 * probe (the subset-cherry-picking, basis-switching, unpaired-statistics,
 * confidence-inflation and sample-starvation dishonesties are ROW- or
 * CLAIM-level — their inputs stay the honest recorded bundles).
 */
export function competitiveInputsForRow(row: {
  readonly armSet: readonly CompetitiveArmReference[];
  readonly adversarial?: CompetitiveAdversarialKind;
}): readonly RecordedCompetitiveArm[] {
  const honest = honestCompetitiveInputsOf(row.armSet);
  if (row.adversarial === undefined) {
    return honest;
  }
  return applyCompetitiveAdversarialVariant(honest, knobsOfCompetitiveVariant(row.adversarial));
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
export function createCompetitiveFakeApiWorld(options: {
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
    const row = COMPETITIVE_CORPUS.find((candidate) => candidate.rowId === rowId);
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
        task: { kind: "economic-competitive-benchmark.experiment.v1", input: "competitive" },
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
          provider: "competitive-ledger",
          model: "recorded-competitive-history",
          strategyClass: "economic-competitive-benchmark",
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
