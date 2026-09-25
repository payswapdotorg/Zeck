/**
 * Real-PG: PPR-014 — the GAP-006 seam bindings (the economics +
 * codebase-analysis authorities) over the REAL relational rail.
 *
 * THE ORDER'S CORE PROOF (the work order's verification battery,
 * integration half — every step over the MATERIALIZED preview composition
 * `buildBootstrapApp` binds, never a hand-rolled world):
 *  - THE WALLET SEEDING's runtime idempotency: the cold-start gate seeds
 *    the funded developer wallet through the REAL budgets authority under
 *    DETERMINISTIC idempotency keys; a SECOND cold start (a second isolate
 *    over the same database) converges on the SAME rows — no second
 *    funding-settings row, no second credit, the ledger carries EXACTLY
 *    ONE credit-grant entry;
 *  - THE FULL ECONOMICS CHAIN: a real execution (the substrate drives it
 *    COMPLETED inline — PPR-008's pinned behavior) -> a credentialed
 *    create through the bound route -> AUTHORIZE through the composition's
 *    authority seam (the REAL policy admission over the published baseline
 *    -> the REAL capability admission over the REAL seed catalog -> budget
 *    reserve on the REAL 0003 ledger -> issuance) -> CHARGE through the
 *    composition's simulated rail (honestly disclosed: `railId` names it,
 *    `sim:<railId>:<n>` references it) -> budget settle (the unused range
 *    head released) -> the read seams answer the real wire shapes, and an
 *    idempotent charge replay moves NO further money;
 *  - THE FULL ANALYZER CHAIN: a credentialed create through the bound
 *    analysis route (the sparse §12/§13 subgraph — LOW confidence, so the
 *    VOI prompt fires) -> the MANDATORY executionId is a REAL execution
 *    row driven COMPLETED by the route's own lifecycle composition with
 *    the digest-bound verification evidence -> findings + prompts DURABLE
 *    (migration 0016) -> the read seam serves the advisory report -> an
 *    idempotent replay returns the SAME durable analysis.
 *
 * Skips with an explicit reason when ZECK_PG_TEST_URL is unset (the
 * credentialed re-run is the Lead's — recorded honestly).
 */

import { afterAll, expect, test } from "vitest";
import { buildBootstrapApp } from "../../../deploy/api";
import {
  PREVIEW_PAYMENT_RAIL_ID,
  PREVIEW_WALLET_GRANT_MICRO_USD,
  previewWalletFundingKey,
  previewWalletGrantKey,
} from "../../../deploy/preview-authorities";
import { uuidv7 } from "../../../src/shared/ids";
import type { PgContext } from "./harness";
import { definePgSuite } from "./harness";

const APPLICATION_ID = uuidv7();
const TRANSPORT_TOKEN = `zeck-ppr014-transport-${uuidv7()}`;

/** The composition's materialization variables (set/restored around builds). */
const MATERIALIZATION_VARIABLES: readonly string[] = [
  "ZECK_PG_ADMIN_URL",
  "ZECK_TRANSPORT_TOKEN",
  "ZECK_PREVIEW_APPLICATION_ID",
];

/** The test database's URL (the harness's own pool target). */
function testDatabaseUrl(ctx: PgContext): string {
  return `${ctx.adminUrl.replace(/\/[^/]*$/, "")}/${ctx.databaseName}`;
}

async function withMaterialization(
  ctx: PgContext,
  body: () => Promise<void> | void,
): Promise<void> {
  const previous: Record<string, string | undefined> = {};
  for (const key of MATERIALIZATION_VARIABLES) {
    previous[key] = process.env[key];
  }
  process.env.ZECK_PG_ADMIN_URL = testDatabaseUrl(ctx);
  process.env.ZECK_TRANSPORT_TOKEN = TRANSPORT_TOKEN;
  process.env.ZECK_PREVIEW_APPLICATION_ID = APPLICATION_ID;
  try {
    await body();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

const closers: {
  readonly server?: { readonly app: { close(): Promise<void> } };
  readonly close?: () => Promise<void>;
}[] = [];

afterAll(async () => {
  for (const entry of closers) {
    await entry.close?.();
    await entry.server?.app.close();
  }
});

/** The credentialed header set every probe carries (the bound boundary). */
function authHeaders(extra: Readonly<Record<string, string>> = {}): Record<string, string> {
  return {
    authorization: `Bearer ${TRANSPORT_TOKEN}`,
    "content-type": "application/json",
    ...extra,
  };
}

/** The application-scoped read headers (the scope header the GETs require). */
function readHeaders(): Record<string, string> {
  return {
    authorization: `Bearer ${TRANSPORT_TOKEN}`,
    "x-zeck-application": APPLICATION_ID,
  };
}

/** The developer wallet row of the preview application (the REAL ledger). */
async function developerWallet(db: PgContext["port"]): Promise<{ id: string; balance: string }> {
  const result = await db.execute<{ id: string; balance_micro_usd: string }>({
    sql: `SELECT id, balance_micro_usd::text AS balance_micro_usd FROM budgets.wallets
          WHERE application_id = $1 AND owner_kind = 'developer'`,
    parameters: [APPLICATION_ID],
  });
  const row = result.rows[0];
  if (row === undefined) {
    throw new Error("the preview developer wallet was not seeded");
  }
  return { id: row.id, balance: row.balance_micro_usd };
}

/** The budgets reservation row of an economics reservation operation. */
async function reservationOf(
  db: PgContext["port"],
  operationId: string,
): Promise<{ status: string; amount: string; settled: string | null } | null> {
  const result = await db.execute<{
    status: string;
    amount_micro_usd: string;
    settled_amount_micro_usd: string | null;
  }>({
    sql: `SELECT status, amount_micro_usd::text AS amount_micro_usd,
                 settled_amount_micro_usd::text AS settled_amount_micro_usd
          FROM budgets.reservations WHERE operation_id = $1`,
    parameters: [operationId],
  });
  const row = result.rows[0];
  return row === undefined
    ? null
    : { status: row.status, amount: row.amount_micro_usd, settled: row.settled_amount_micro_usd };
}

definePgSuite("the GAP-006 seam bindings over real PostgreSQL (PPR-014)", (ctx) => {
  // -------------------------------------------------------------------------
  // 1. The funded developer wallet (the cold-start seeding, idempotent)
  // -------------------------------------------------------------------------

  test("the cold-start gate seeds the funded developer wallet; a second cold start converges (no double credit)", async () => {
    await withMaterialization(ctx, async () => {
      // The FIRST isolate's cold start.
      const first = buildBootstrapApp({ environment: "local" });
      closers.push({
        server: first.server,
        close: async () => {
          await first.previewAuthorities?.close();
        },
      });
      const ready = await first.previewAuthorities?.ready;
      expect(ready?.ok).toBe(true);

      // The funded developer wallet on the REAL budgets ledger (0003).
      const wallet = await developerWallet(ctx.port);
      expect(wallet.balance).toBe(PREVIEW_WALLET_GRANT_MICRO_USD);

      // The funding-mode row: exactly ONE (the deterministic funding key).
      const funding = await ctx.port.execute<{ n: string }>({
        sql: `SELECT count(*)::text AS n FROM budgets.application_funding_settings
              WHERE application_id = $1`,
        parameters: [APPLICATION_ID],
      });
      expect(funding.rows[0]?.n).toBe("1");

      // The deterministic idempotency keys arbitrated on the platform
      // ledger (0001) — exactly the two recorded operations.
      const keys = await ctx.port.execute<{ idempotency_key: string }>({
        sql: `SELECT idempotency_key FROM platform.idempotency_records
              WHERE idempotency_key IN ($1, $2)`,
        parameters: [
          previewWalletFundingKey(APPLICATION_ID),
          previewWalletGrantKey(APPLICATION_ID),
        ],
      });
      expect(new Set(keys.rows.map((row) => row.idempotency_key))).toEqual(
        new Set([previewWalletFundingKey(APPLICATION_ID), previewWalletGrantKey(APPLICATION_ID)]),
      );

      // THE SECOND COLD START: a second isolate over the same database —
      // the seeding replays through the idempotency ledger and converges.
      const second = buildBootstrapApp({ environment: "local" });
      closers.push({
        server: second.server,
        close: async () => {
          await second.previewAuthorities?.close();
        },
      });
      const readyAgain = await second.previewAuthorities?.ready;
      expect(readyAgain?.ok).toBe(true);

      // STILL exactly one wallet, SAME balance (never a second credit).
      const wallets = await ctx.port.execute<{ n: string; balance: string }>({
        sql: `SELECT count(*)::text AS n,
                     max(balance_micro_usd::text) AS balance
              FROM budgets.wallets WHERE application_id = $1 AND owner_kind = 'developer'`,
        parameters: [APPLICATION_ID],
      });
      expect(wallets.rows[0]?.n).toBe("1");
      expect(wallets.rows[0]?.balance).toBe(PREVIEW_WALLET_GRANT_MICRO_USD);
      const fundingAgain = await ctx.port.execute<{ n: string }>({
        sql: `SELECT count(*)::text AS n FROM budgets.application_funding_settings
              WHERE application_id = $1`,
        parameters: [APPLICATION_ID],
      });
      expect(fundingAgain.rows[0]?.n).toBe("1");

      // The wallet's append-only ledger carries EXACTLY ONE entry: the
      // grant credit. No second grant, no replay noise.
      const ledger = await ctx.port.execute<{
        entry_class: string;
        direction: string;
        amount_micro_usd: string;
      }>({
        sql: `SELECT entry_class, direction, amount_micro_usd::text AS amount_micro_usd
              FROM budgets.ledger_entries WHERE wallet_id = $1
              ORDER BY occurred_at, id`,
        parameters: [wallet.id],
      });
      expect(
        ledger.rows.map((row) => `${row.entry_class}:${row.direction}:${row.amount_micro_usd}`),
      ).toEqual([`credit-grant:credit:${PREVIEW_WALLET_GRANT_MICRO_USD}`]);
    });
  });

  // -------------------------------------------------------------------------
  // 2. THE FULL ECONOMICS CHAIN on the materialized composition
  // -------------------------------------------------------------------------

  test("the FULL economics chain: real execution -> credentialed create -> authorize (real admissions + budget reserve + issuance) -> charge (the simulated rail) -> settle; the read seams answer", async () => {
    await withMaterialization(ctx, async () => {
      const app = buildBootstrapApp({ environment: "local" });
      closers.push({
        server: app.server,
        close: async () => {
          await app.previewAuthorities?.close();
        },
      });
      expect((await app.previewAuthorities?.ready)?.ok).toBe(true);
      const authorities = app.previewAuthorities;
      if (authorities === undefined) {
        throw new Error("the preview authorities did not materialize");
      }
      const scope = {
        actorId: authorities.seed.transportActorId,
        applicationId: APPLICATION_ID,
        tenantId: authorities.tenantId,
      };

      // The governing execution through the composition's executions
      // AUTHORITY (the "agent runtime / composition wiring" seam the
      // economics route's own frozen docstring names) — NOT the
      // substrate-driven sandbox route: the substrate's inline drive is
      // the plane's only runtime for ORDINARY sandbox tasks and drives
      // them to terminal receipts, while an economic action's boundary
      // events ride a NON-TERMINAL execution (the canonical ledger
      // accepts no step events on a terminal execution). The
      // composition-level authority call leaves the execution CREATED —
      // exactly the shape the production agent-runtime composition
      // produces (the material trade-off is recorded in
      // deploy/evidence/ppr-014.json).
      const executionReceipt = await authorities.executions.createExecution(
        {
          applicationId: APPLICATION_ID,
          task: { kind: "payment-checkout", input: "checkout-session-42" },
          metadata: { origin: "ppr-014-integration-proof", family: "economics" },
        },
        `ppr014-econ-exec-${uuidv7()}`,
        { actorId: authorities.seed.transportActorId, tenantId: authorities.tenantId },
      );
      expect(executionReceipt.status).toBe("CREATED");
      const executionId = executionReceipt.executionId;

      // CREATE through the bound route (the credentialed API surface). The
      // required capability is a REAL seed-catalog fact (the REAL
      // capability admission resolves it below — never an allowing fake).
      const createKey = `ppr014-econ-create-${uuidv7()}`;
      const created = await app.server.app.inject({
        method: "POST",
        url: "/economic-actions",
        headers: authHeaders({ "idempotency-key": createKey }),
        payload: JSON.stringify({
          applicationId: APPLICATION_ID,
          executionId,
          purpose: "purchase",
          recipient: { kind: "merchant", id: "merchant-42" },
          amount: { kind: "range", minMicroUsd: "1000", maxMicroUsd: "2000" },
          currency: "usd",
          expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
          requiredCapabilities: [{ kind: "tool", name: "document-retrieval" }],
        }),
      });
      expect(created.statusCode).toBe(201);
      const receipt = created.json<{
        economicActionId: string;
        status: string;
        replayed: boolean;
      }>();
      expect(receipt.status).toBe("proposed");
      expect(receipt.replayed).toBe(false);
      const actionId = receipt.economicActionId;

      // No money has moved yet: the wallet still carries the full grant.
      expect((await developerWallet(ctx.port)).balance).toBe(PREVIEW_WALLET_GRANT_MICRO_USD);

      // AUTHORIZE through the composition's authority seam: the REAL
      // policy admission (over the published baseline set) -> the REAL
      // capability admission (over the REAL seed catalog) -> budget
      // reserve on the REAL ledger -> the bounded authorization issued.
      const authorized = await authorities.economics.authorizeEconomicAction(
        { ...scope, economicActionId: actionId },
        `ppr014-econ-auth-${uuidv7()}`,
      );
      expect(authorized.denied).toBeUndefined();
      expect(authorized.action.status).toBe("authorized");
      expect(authorized.authorization).not.toBeNull();

      // The hold landed on the REAL budgets ledger: the range ceiling
      // (2000) reserved, one ACTIVE reservation row for econ-<actionId>.
      expect((await developerWallet(ctx.port)).balance).toBe("9998000");
      const hold = await reservationOf(ctx.port, `econ-${actionId}`);
      expect(hold?.status).toBe("active");
      expect(hold?.amount).toBe("2000");

      // CHARGE through the composition's own rail — the IN-REPO simulated
      // rail, honestly disclosed on every observation it produces.
      const chargeKey = `ppr014-econ-charge-${uuidv7()}`;
      const charged = await authorities.economics.chargeEconomicAction(
        { ...scope, economicActionId: actionId, amountMicroUsd: "1500" },
        authorities.paymentRail,
        chargeKey,
      );
      expect(charged.replayed).toBe(false);
      expect(charged.action.status).toBe("settled");
      expect(charged.authorization.status).toBe("consumed");
      expect(charged.settlement.status).toBe("confirmed");
      expect(charged.settlement.settledAmountMicroUsd).toBe("1500");
      expect(charged.settlement.railId).toBe(PREVIEW_PAYMENT_RAIL_ID);
      expect(charged.settlement.railTransactionRef).toBe(`sim:${PREVIEW_PAYMENT_RAIL_ID}:1`);

      // The rail saw EXACTLY ONE charge — the pinned recipient, the
      // substitution-checked amount, the pinned currency.
      expect(authorities.paymentRail.charges).toHaveLength(1);
      expect(authorities.paymentRail.charges[0]?.amountMicroUsd).toBe("1500");
      expect(authorities.paymentRail.charges[0]?.recipient).toEqual({
        kind: "merchant",
        id: "merchant-42",
      });
      expect(authorities.paymentRail.charges[0]?.currency).toBe("usd");

      // The REAL budgets settle: the charged 1500 spent, the unused 500
      // released back to the wallet.
      expect((await developerWallet(ctx.port)).balance).toBe("9998500");
      const settled = await reservationOf(ctx.port, `econ-${actionId}`);
      expect(settled?.status).toBe("settled");
      expect(settled?.settled).toBe("1500");

      // The IDEMPOTENT CHARGE REPLAY: the same key returns the durable
      // outcome with ZERO further rail side effects or money movement.
      const replayed = await authorities.economics.chargeEconomicAction(
        { ...scope, economicActionId: actionId, amountMicroUsd: "1500" },
        authorities.paymentRail,
        chargeKey,
      );
      expect(replayed.replayed).toBe(true);
      expect(replayed.settlement.id).toBe(charged.settlement.id);
      expect(authorities.paymentRail.charges).toHaveLength(1);
      expect((await developerWallet(ctx.port)).balance).toBe("9998500");

      // THE READ SEAMS (the credentialed API surface — the honest wire
      // shapes of the bound routes).
      const read = await app.server.app.inject({
        method: "GET",
        url: `/economic-actions/${actionId}`,
        headers: readHeaders(),
      });
      expect(read.statusCode).toBe(200);
      expect(read.json<{ id: string; status: string }>().status).toBe("settled");

      const events = await app.server.app.inject({
        method: "GET",
        url: `/economic-actions/${actionId}/events`,
        headers: readHeaders(),
      });
      expect(events.statusCode).toBe(200);
      const eventList = events.json<{ type: string; sequence: number }[]>();
      // The governed chain's own event vocabulary, IN ORDER (the
      // per-action append-only journal — the full chain's six events).
      expect(eventList.map((event) => event.type)).toEqual([
        "action.recorded",
        "authorization.issued",
        "payment.dispatched",
        "settlement.correlated",
        "authorization.consumed",
        "settlement.correlated",
      ]);
      expect(eventList.map((event) => event.sequence)).toEqual([1, 2, 3, 4, 5, 6]);

      const outcome = await app.server.app.inject({
        method: "GET",
        url: `/economic-actions/${actionId}/outcome`,
        headers: readHeaders(),
      });
      expect(outcome.statusCode).toBe(200);
      const bundle = outcome.json<{
        status: string;
        settlement: {
          railId: string;
          railTransactionRef: string;
          status: string;
          settledAmountMicroUsd: string;
        } | null;
        deliveries: unknown[];
      }>();
      expect(bundle.status).toBe("settled");
      expect(bundle.settlement?.railId).toBe(PREVIEW_PAYMENT_RAIL_ID);
      expect(bundle.settlement?.railTransactionRef).toBe(`sim:${PREVIEW_PAYMENT_RAIL_ID}:1`);
      expect(bundle.settlement?.settledAmountMicroUsd).toBe("1500");
      // Payment success is never delivered-as-verified: the delivery axis
      // is SEPARATE (no delivery observation was recorded in this chain).
      expect(bundle.deliveries).toEqual([]);
    });
  });

  // -------------------------------------------------------------------------
  // 3. THE FULL ANALYZER CHAIN on the materialized composition
  // -------------------------------------------------------------------------

  test("the FULL analyzer chain: real execution -> deterministic analysis -> findings + prompts recorded -> the read seam; the replay is durable", async () => {
    await withMaterialization(ctx, async () => {
      const app = buildBootstrapApp({ environment: "local" });
      closers.push({
        server: app.server,
        close: async () => {
          await app.previewAuthorities?.close();
        },
      });
      expect((await app.previewAuthorities?.ready)?.ok).toBe(true);

      const repository = "github.com/example/customer-app";
      const revision = "commit-abc123";
      // The sparse §12/§13 subgraph: LOW confidence -> the VOI prompt
      // fires (the analyzer's own value-of-information gate).
      const subgraph = {
        nodes: [
          {
            nodeId: "llm-const",
            kind: "model-call",
            label: "returnGreeting",
            provenance: { repository, revision, file: "src/greet.ts", symbol: "returnGreeting" },
            observation: {
              executionCount: 4,
              errorRate: 0.02,
              inputVariability: "low",
              semanticComplexity: "low",
              distinctOutputCount: 1,
              constantOutput: true,
              verificationPassCount: 3,
              verificationFailCount: 1,
              evidenceRefs: ["obs:const-1"],
            },
          },
        ],
        edges: [],
      };
      const analysisKey = `ppr014-analysis-${uuidv7()}`;
      const payload = JSON.stringify({
        applicationId: APPLICATION_ID,
        source: { repository, revision },
        subgraph,
      });

      // CREATE through the bound analysis route (credentialed).
      const created = await app.server.app.inject({
        method: "POST",
        url: "/codebase-analysis",
        headers: authHeaders({ "idempotency-key": analysisKey }),
        payload,
      });
      expect(created.statusCode).toBe(201);
      const body = created.json<{
        analysis: {
          analysisId: string;
          executionId: string;
          findingCount: number;
          promptCount: number;
          digest: string;
          replayed: boolean;
        };
        findings: { findingId: string; state: string }[];
        prompts: {
          question: string;
          expectedInformationGain: number;
          userFrictionThreshold: number;
        }[];
      }>();
      expect(body.analysis.replayed).toBe(false);
      expect(body.analysis.findingCount).toBeGreaterThan(0);
      expect(body.analysis.promptCount).toBeGreaterThan(0);
      expect(body.findings.length).toBe(body.analysis.findingCount);
      expect(body.prompts.length).toBe(body.analysis.promptCount);
      // The VOI inequality on every prompt (§13: gain > friction).
      for (const prompt of body.prompts) {
        expect(prompt.expectedInformationGain).toBeGreaterThan(prompt.userFrictionThreshold);
        expect(typeof prompt.question).toBe("string");
      }

      // The MANDATORY executionId: a REAL execution row, COMPLETED by the
      // route's own lifecycle composition, with the digest-bound
      // verification evidence (M2/M26 — the admission flowed through the
      // ALREADY-BOUND executions authority; no second admission path).
      const executionId = body.analysis.executionId;
      const row = await ctx.port.execute<{ status: string; verifications: string }>({
        sql: `SELECT e.status,
                     (SELECT count(*)::text FROM executions.verification_results r
                      WHERE r.execution_id = e.id) AS verifications
              FROM executions.executions e WHERE e.id = $1`,
        parameters: [executionId],
      });
      expect(row.rows[0]?.status).toBe("COMPLETED");
      expect(row.rows[0]?.verifications).toBe("1");
      const verification = await ctx.port.execute<{ evidence: string }>({
        sql: "SELECT evidence FROM executions.verification_results WHERE execution_id = $1",
        parameters: [executionId],
      });
      expect(JSON.stringify(verification.rows[0]?.evidence)).toContain(body.analysis.digest);

      // Findings + prompts DURABLE (migration 0016).
      const findings = await ctx.port.execute<{ n: string }>({
        sql: "SELECT count(*)::text AS n FROM learning.opportunity_findings WHERE analysis_id = $1",
        parameters: [body.analysis.analysisId],
      });
      expect(findings.rows[0]?.n).toBe(String(body.analysis.findingCount));
      const prompts = await ctx.port.execute<{ n: string }>({
        sql: "SELECT count(*)::text AS n FROM learning.opportunity_prompts WHERE analysis_id = $1",
        parameters: [body.analysis.analysisId],
      });
      expect(prompts.rows[0]?.n).toBe(String(body.analysis.promptCount));

      // THE READ SEAM: the advisory report (findings + prompts) served.
      const read = await app.server.app.inject({
        method: "GET",
        url: `/codebase-analysis/${body.analysis.analysisId}`,
        headers: readHeaders(),
      });
      expect(read.statusCode).toBe(200);
      const report = read.json<{
        analysis: { analysisId: string; executionId: string };
        findings: { findingId: string }[];
        prompts: { promptId: string }[];
      }>();
      expect(report.analysis.analysisId).toBe(body.analysis.analysisId);
      expect(report.analysis.executionId).toBe(executionId);
      expect(report.findings.length).toBe(body.analysis.findingCount);
      expect(report.prompts.length).toBe(body.analysis.promptCount);

      // THE IDEMPOTENT REPLAY: the same key returns the SAME durable
      // analysis (the real SQL arbitration — no second analysis row).
      const replay = await app.server.app.inject({
        method: "POST",
        url: "/codebase-analysis",
        headers: authHeaders({ "idempotency-key": analysisKey }),
        payload,
      });
      expect(replay.statusCode).toBe(201);
      const replayBody = replay.json<{ analysis: { analysisId: string; replayed: boolean } }>();
      expect(replayBody.analysis.analysisId).toBe(body.analysis.analysisId);
      expect(replayBody.analysis.replayed).toBe(true);
      const analyses = await ctx.port.execute<{ n: string }>({
        sql: "SELECT count(*)::text AS n FROM learning.opportunity_analyses WHERE application_id = $1",
        parameters: [APPLICATION_ID],
      });
      expect(analyses.rows[0]?.n).toBe("1");
    });
  });
});
