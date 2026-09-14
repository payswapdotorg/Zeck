/**
 * The customer-journey application's deterministic fixtures (VAL-050,
 * AC2 + the AC6 discrimination battery's controlled fakes).
 *
 * The controlled world the journey driver and the app execute against:
 *
 *   * the fake public API world — the transport-level fake over the
 *     SDK's injected seam (the create/replay semantics at the POST
 *     boundary, the honest outcome shapes at the read boundary, the
 *     journey observation package at the result boundary). The
 *     discrimination knobs: `probe` forces an adversarial journey
 *     shape onto an HONEST row (the controlled fakes of the
 *     discrimination battery — a dropped stage, an orphaned state, a
 *     duplicated resume, a boundary leak, a hidden residual);
 *     `terminal`/`verificationStatuses` override the honest outcome;
 *     `fabricatePassWithFail` settles a FAILED-expected row into a
 *     COMPLETED terminal WITH a FAIL verification status;
 *   * the LIVE RAIL HONESTY: the offline fake world NEVER serves a
 *     live-gated row — the POST boundary refuses any row whose live
 *     gate is declared (the live slice demands the operator-authorized
 *     REAL rail; a fake serving it would fabricate a live journey);
 *   * the tick clock re-exported from the VAL-040 fixtures (imported,
 *     never copied, never modified).
 *
 * Everything is deterministic: no network, no randomness, no
 * credentials — every offline row is reproducible from the repository
 * alone.
 */

import type { TransportImplementation } from "../../harness/harness";
import type { TickClock } from "../economic-baseline/fixtures";
import { createTickClock } from "../economic-baseline/fixtures";
import type { CustomerJourneyCorpusRow, JourneyProbeKind } from "./corpus";
import { CUSTOMER_JOURNEY_CORPUS } from "./corpus";
import { journeyObservationFor } from "./driver";

export type { TickClock };
export { createTickClock };

/**
 * The transport-level fake public API implementing the platform's OWN
 * semantics at the customer boundary (mirroring the VAL-049 fake
 * world over THIS slice's corpus): POST /executions (the
 * create/replay semantics — and the live-rail refusal), GET
 * /executions/:id (the row settles to its honest outcome on the read
 * path) and GET /executions/:id/results (the honest result package
 * carrying the journey observation).
 */
export function createJourneyFakeApiWorld(options: {
  readonly clock: TickClock;
  /**
   * Force an adversarial journey probe onto the row (the
   * discrimination knob — the controlled fake of the battery).
   */
  readonly probe?: JourneyProbeKind;
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

  /** The row of one submitted task body (the corpus slice of record). */
  const rowOf = (rowId: string): CustomerJourneyCorpusRow | null =>
    CUSTOMER_JOURNEY_CORPUS.find((candidate) => candidate.rowId === rowId) ?? null;

  /** The row's honest outcome shape (derived from the corpus itself). */
  const honestOutcomeFor = (rowId: string): { terminal: string; statuses: string[] } => {
    const row = rowOf(rowId);
    if (row === null) {
      return { terminal: "FAILED", statuses: ["FAIL"] };
    }
    if (row.expected.terminal === "COMPLETED") {
      return { terminal: "COMPLETED", statuses: ["PASS", "PASS"] };
    }
    return { terminal: "FAILED", statuses: ["FAIL", "PASS"] };
  };

  /** The effective outcome for one row (the knobs override the honest shape). */
  const outcomeFor = (rowId: string): { terminal: string; statuses: string[] } => {
    const honest = honestOutcomeFor(rowId);
    if (options.fabricatePassWithFail === true && honest.terminal === "FAILED") {
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
      const rowId = String((body.task as { rowId?: unknown } | null)?.rowId ?? "");
      const row = rowOf(rowId);
      if (row === null) {
        return jsonResponse(422, {
          code: "CAPABILITY_UNAVAILABLE",
          message: `no journey corpus row ${rowId}`,
          retryable: false,
        });
      }
      // THE LIVE RAIL HONESTY: the offline fake world never serves a
      // live-gated row — the live journey slice demands the
      // operator-authorized REAL rail (a fake serving it would
      // fabricate a live journey).
      if (row.liveGate !== undefined) {
        return jsonResponse(503, {
          code: "CAPABILITY_UNAVAILABLE",
          message:
            "the offline fake world never serves the live rail: the live journey slice demands the operator-authorized REAL platform path",
          retryable: false,
        });
      }
      const fingerprint = fingerprintOf(body);
      const existing = records.get(key);
      if (existing !== undefined && existing.fingerprint === fingerprint) {
        const row2 = rows.get(existing.executionId);
        return jsonResponse(201, {
          executionId: existing.executionId,
          applicationId: body.applicationId ?? "app-1",
          status: row2?.status ?? "CREATED",
          createdAt: new Date(row2?.createdAt ?? 0).toISOString(),
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
        taskRowId: rowId,
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
      if (row.status === "CREATED" && !settled.has(row.id)) {
        settled.add(row.id);
        row.status = outcomeFor(row.taskRowId).terminal;
      }
      return jsonResponse(200, {
        id: row.id,
        applicationId: "app-1",
        environmentId: null,
        status: row.status,
        task: { kind: "customer-journey.lifecycle.v1", input: "journey" },
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
      const corpusRow = rowOf(row.taskRowId);
      // The journey observation package: the honest trace over the
      // corpus row, denatured only by the effective probe (the row's
      // own declared probe, or the forced discrimination knob).
      const observation =
        corpusRow === null
          ? null
          : journeyObservationFor(
              corpusRow,
              options.probe === undefined ? {} : { probe: options.probe },
            );
      const outcome = outcomeFor(row.taskRowId);
      const pass = row.status === "COMPLETED";
      return jsonResponse(200, {
        executionId: row.id,
        status: row.status === "CREATED" ? "RUNNING" : row.status,
        route: {
          provider: "journey-ledger",
          model: "recorded-journey-replay",
          strategyClass: "customer-journey",
          modelCalls: 1,
        },
        cost: pass
          ? { totalMicroUsd: observation?.reported.totalCostMicroUsd ?? "0", currency: "usd" }
          : null,
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
        journey: observation,
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
