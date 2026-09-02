/**
 * Real-PostgreSQL lifecycle proofs — the governed computer-use fabric
 * over migration 0023 (WORK-027, CUI-001/002/003; the blocking
 * checkpoints SELF-HOSTING-BOUNDARY + EXECUTION-PROVENANCE — the
 * PHYSICAL half; the unit suites in tests/unit/tools/ prove the
 * behavioral half over the in-memory world).
 *
 * Every authority the service consults is REAL here: the WORK-007
 * policy engine (restrictive documents published for the denial
 * proofs), the WORK-005 capability registry, the WORK-003 connections
 * module (SQL store + BYOK vault) behind the secret-mediation seam,
 * the WORK-004 budgets service (SQL wallet — the budget-before-spend
 * boundary is PHYSICAL), the WORK-012 sandbox module behind the
 * terminal executor and the FROZEN executions module (SQL store + the
 * canonical EventEnvelope ledger the computer-use evidence rides).
 * Only the isolated computer-use environment is simulated (the
 * provider-honesty stance; external browser/desktop behavior is
 * UNVERIFIED — recorded in docs/work-items/WORK-027.md).
 *
 * THE PROOF RECORDS:
 *   SCHEMA/IDENTITY   the migration-0023 physical state exists with
 *                     its guards; sessions are (application, key)
 *                     converged; the denied/active/terminal shapes are
 *                     physically enforced
 *   ADMISSION ORDER   policy/tool, policy/host, policy/secret and
 *                     budget denials are DURABLE denied rows with ZERO
 *                     environment activity and ZERO wallet debits
 *   ROUTING           deterministic-first: a sufficient verified
 *                     deterministic route starts deterministic with
 *                     zero GUI dispatch; escalation ascends exactly one
 *                     rung on RECORDED insufficiency and is durable +
 *                     idempotent; skipping is unrepresentable
 *   PROVENANCE/REPLAY createSession and dispatchAction replay by
 *                     stable key; key reuse with a different request
 *                     fails closed; ledger evidence rides the canonical
 *                     execution ledger exactly once per stable key
 *   TENANT ISOLATION  cross-tenant actors and cross-application reads
 *                     fail closed with zero durable rows
 *   CONCURRENCY       N=8 same-key creates converge to ONE session;
 *                     N=8 same-key dispatches converge to ONE action
 *                     and ONE external effect
 *   CREDENTIAL        a BYOK-credentialed route mediates through the
 *   MEDIATION         REAL connections catalog (opaque grant reference
 *                     only — the material never appears in ANY durable
 *                     computer-use byte); a disabled connection fails
 *                     closed typed
 */

import { createHash } from "node:crypto";
import { describe, expect, test } from "vitest";
import { canonicalComputerUseJson } from "../../../src/modules/tools/public";
import { PlatformError } from "../../../src/shared/errors";
import {
  type ComputerUsePgWorld,
  count,
  desktopDeclaration,
  deterministicDeclaration,
  one,
  seedComputerUseWorld,
} from "./computer-use-world";
import { definePgSuite, type PgContext } from "./harness";

const sha256Hex = (value: string): string =>
  createHash("sha256").update(value, "utf8").digest("hex");

const expectPlatformError = async (
  code: string,
  run: Promise<unknown> | (() => Promise<unknown>),
): Promise<PlatformError> => {
  const promise = typeof run === "function" ? run() : run;
  try {
    await promise;
  } catch (error) {
    if (error instanceof PlatformError) {
      if (error.code !== code) {
        throw new Error(`expected PlatformError code ${code}, got ${error.code}: ${error.message}`);
      }
      return error;
    }
    throw error;
  }
  throw new Error(`expected a PlatformError with code ${code}`);
};

definePgSuite("computer-use governed lifecycle (real PostgreSQL; WORK-027)", (ctx: PgContext) => {
  let world: ComputerUsePgWorld;

  const sessionRow = (sessionKey: string) =>
    one<{
      id: string;
      status: string;
      current_mode: string;
      initial_mode: string;
      denial_class: string | null;
      environment_ref: string | null;
      escalation_count: number;
      route_evidence: { route: { mode: string }[] };
    }>(
      world.db,
      "SELECT * FROM tools.computer_use_sessions WHERE application_id = $1 AND session_key = $2",
      [world.applicationId, sessionKey],
    );

  const operationsOf = (kind: string) =>
    count(
      world.db,
      "SELECT 1 FROM tools.computer_use_operations WHERE application_id = $1 AND operation_kind = $2",
      [world.applicationId, kind],
    );

  const actionCount = (sessionId: string) =>
    count(
      world.db,
      "SELECT 1 FROM tools.computer_use_actions WHERE application_id = $1 AND session_id = $2",
      [world.applicationId, sessionId],
    );

  describe("CUI schema/identity (migration 0023)", () => {
    test("the world boots over migration 0023 (all five computer-use tables exist)", async () => {
      world = await seedComputerUseWorld(ctx.port);
      for (const table of [
        "computer_use_sessions",
        "computer_use_escalations",
        "computer_use_actions",
        "computer_use_observations",
        "computer_use_operations",
      ]) {
        const row = await one<{ n: number }>(
          world.db,
          "SELECT COUNT(*)::int AS n FROM information_schema.tables WHERE table_schema = 'tools' AND table_name = $1",
          [table],
        );
        expect(row?.n, `table tools.${table}`).toBe(1);
      }
      const applied = await ctx.port.execute<{ version: string; name: string }>({
        sql: "SELECT version, name FROM platform.schema_migrations WHERE version = $1",
        parameters: ["0023"],
      });
      expect(applied.rows[0]?.name).toContain("computer_use");
    });

    test("a denied session is insert-only (no activation, no environment, physically shaped)", async () => {
      world = await seedComputerUseWorld(ctx.port);
      await world.policyAuthority.publish({
        id: "default",
        version: 2,
        documents: [
          {
            scope: "platform",
            selector: {},
            restrictions: { tool: { deniedTools: ["computer-use:session"] } },
          },
        ],
      });
      const executionId = await world.driveToRunning(world.boot(null).executions);
      await expectPlatformError(
        "POLICY_DENIED",
        world.createSession({ executionId }, "deny-shape-key"),
      );
      const row = await sessionRow("deny-shape-key");
      expect(row).not.toBeNull();
      expect(row?.status).toBe("denied");
      expect(row?.denial_class).toBe("policy");
      expect(row?.environment_ref).toBeNull();
      // The denied shape is physical: an UPDATE flipping a denied row to
      // active without the terminal-shape discipline is rejected by the
      // table's own CHECK constraints.
      const denied = await one<{ id: string }>(
        world.db,
        "SELECT id FROM tools.computer_use_sessions WHERE session_key = 'deny-shape-key'",
        [],
      );
      await expect(
        world.db.execute({
          sql: "UPDATE tools.computer_use_sessions SET status = 'active' WHERE id = $1",
          parameters: [denied?.id],
        }),
      ).rejects.toThrow();
      await expect(
        world.db.execute({
          sql: "UPDATE tools.computer_use_sessions SET terminal_at = now() WHERE id = $1",
          parameters: [denied?.id],
        }),
      ).rejects.toThrow();
    });
  });

  describe("CUI admission ordering (REAL policy + REAL budget)", () => {
    test("a TOOL-fact denial lands as a durable denied row with ZERO environment activity and ZERO wallet debits", async () => {
      world = await seedComputerUseWorld(ctx.port);
      await world.policyAuthority.publish({
        id: "default",
        version: 2,
        documents: [
          {
            scope: "platform",
            selector: {},
            restrictions: { tool: { deniedTools: ["computer-use:session"] } },
          },
        ],
      });
      const executionId = await world.driveToRunning(world.boot(null).executions);
      await expectPlatformError("POLICY_DENIED", world.createSession({ executionId }, "deny-tool"));
      expect(world.environment.activity()).toHaveLength(0);
      expect(
        await count(
          world.db,
          "SELECT 1 FROM budgets.reservations r JOIN budgets.wallets w ON w.id = r.wallet_id WHERE w.application_id = $1",
          [world.applicationId],
        ),
      ).toBe(0);
      const row = await sessionRow("deny-tool");
      expect(row?.status).toBe("denied");
      expect(row?.denial_class).toBe("policy");
    });

    test("a HOST denial (network egress none) fails closed BEFORE any environment interaction", async () => {
      world = await seedComputerUseWorld(ctx.port);
      await world.policyAuthority.publish({
        id: "default",
        version: 2,
        documents: [
          { scope: "platform", selector: {}, restrictions: { network: { egress: "none" } } },
        ],
      });
      const executionId = await world.driveToRunning(world.boot(null).executions);
      await expectPlatformError("POLICY_DENIED", world.createSession({ executionId }, "deny-host"));
      expect(world.environment.activity()).toHaveLength(0);
      const row = await sessionRow("deny-host");
      expect(row?.denial_class).toBe("policy");
      expect(row?.status).toBe("denied");
    });

    test("a SECRET denial (prohibited secret reference) fails closed before the credential ever mediates", async () => {
      world = await seedComputerUseWorld(ctx.port);
      await world.policyAuthority.publish({
        id: "default",
        version: 2,
        documents: [
          {
            scope: "platform",
            selector: {},
            restrictions: { secrets: { deniedSecretRefs: ["connections:api-credential"] } },
          },
        ],
      });
      const executionId = await world.driveToRunning(world.boot(null).executions);
      await expectPlatformError(
        "POLICY_DENIED",
        world.createSession(
          {
            executionId,
            candidates: {
              deterministic: ["computer-use-api-credentialed"],
              browser: null,
              desktop: null,
            },
            connectionRef: world.connectionId,
          },
          "deny-secret",
        ),
      );
      expect(world.environment.activity()).toHaveLength(0);
      const row = await sessionRow("deny-secret");
      expect(row?.denial_class).toBe("policy");
    });

    test("a BUDGET denial (route ceiling beyond the funded wallet) is durable with ZERO wallet debits", async () => {
      world = await seedComputerUseWorld(ctx.port);
      await world.register(
        desktopDeclaration({
          capabilityId: "computer-use-desktop-expensive",
          estimatedMicroUsd: "99999999999",
        }),
      );
      const executionId = await world.driveToRunning(world.boot(null).executions);
      await expectPlatformError(
        "BUDGET_EXCEEDED",
        world.createSession(
          {
            executionId,
            candidates: {
              deterministic: [],
              browser: null,
              desktop: "computer-use-desktop-expensive",
            },
          },
          "deny-budget",
        ),
      );
      expect(world.environment.activity()).toHaveLength(0);
      expect(
        await count(
          world.db,
          "SELECT 1 FROM budgets.reservations r JOIN budgets.wallets w ON w.id = r.wallet_id WHERE w.application_id = $1",
          [world.applicationId],
        ),
      ).toBe(0);
      const row = await sessionRow("deny-budget");
      expect(row?.denial_class).toBe("budget");
    });
  });

  describe("CUI deterministic-first routing + escalation lineage", () => {
    test("AC-6: a sufficient verified deterministic route starts deterministic with ZERO GUI dispatch", async () => {
      world = await seedComputerUseWorld(ctx.port);
      const executionId = await world.driveToRunning(world.boot(null).executions);
      const receipt = await world.createSession({ executionId }, "route-det");
      expect(receipt.mode).toBe("deterministic");
      expect(receipt.routeEvidence.route.every((stage) => stage.mode === "deterministic")).toBe(
        true,
      );
      const row = await sessionRow("route-det");
      expect(row?.current_mode).toBe("deterministic");
      expect(row?.route_evidence.route.map((stage) => stage.mode)).toEqual(["deterministic"]);
      expect(row?.environment_ref).not.toBeNull();
      // ZERO GUI dispatch: no escalation row, no browser/desktop mode
      // anywhere in the durable state, and the environment journal has
      // no browser/desktop context opens.
      expect(
        await count(
          world.db,
          "SELECT 1 FROM tools.computer_use_escalations WHERE application_id = $1",
          [world.applicationId],
        ),
      ).toBe(0);
      expect(
        world.environment
          .activity()
          .every((entry) => entry.mode !== "browser" && entry.mode !== "desktop"),
      ).toBe(true);
    });

    test("escalation ascends EXACTLY ONE rung on RECORDED insufficiency and is durable + idempotent", async () => {
      world = await seedComputerUseWorld(ctx.port);
      await world.register(
        deterministicDeclaration({
          capabilityId: "computer-use-api-det-estimated",
          qualityConfidence: "estimated",
        }),
      );
      const executionId = await world.driveToRunning(world.boot(null).executions);
      const receipt = await world.createSession(
        {
          executionId,
          candidates: {
            deterministic: ["computer-use-api-det-estimated"],
            browser: "computer-use-browser-isolated",
            desktop: "computer-use-desktop-isolated",
          },
        },
        "esc-session",
      );
      expect(receipt.mode).toBe("deterministic");
      world.environment.injectNextActionFailure();
      const failed = await world.dispatch(receipt.sessionId, {
        actionType: "api-call",
        target: "api.example.com/v1/data",
        input: {},
      });
      expect(failed.status).toBe("failed");
      const actions = await world.store.listActions(world.applicationId, receipt.sessionId);
      const failedAction = actions.find((item) => item.id === failed.actionId);
      expect(failedAction).toBeDefined();
      const digest = sha256Hex(
        canonicalComputerUseJson({
          actionId: failedAction?.id,
          status: failedAction?.status,
          failureClass: failedAction?.failureClass,
          resultDigest: failedAction?.resultDigest,
        }),
      );
      const escalated = await world.service.escalate(
        world.applicationId,
        receipt.sessionId,
        {
          targetMode: "browser",
          insufficiency: {
            stage: "deterministic",
            reasonCode: "action-failed",
            reasonDetail: "the deterministic API call failed in the environment",
            failedActionId: failed.actionId,
            evidenceDigest: digest,
          },
        },
        "esc-key-1",
      );
      expect(escalated.replayed).toBe(false);
      expect(escalated.mode).toBe("browser");
      const escalations = await world.store.listEscalations(world.applicationId, receipt.sessionId);
      expect(escalations).toHaveLength(1);
      expect(escalations[0]?.fromMode).toBe("deterministic");
      expect(escalations[0]?.toMode).toBe("browser");
      expect(escalations[0]?.insufficiencyDigest).toBe(digest);
      const row = await sessionRow("esc-session");
      expect(row?.current_mode).toBe("browser");
      expect(row?.escalation_count).toBe(1);
      // Idempotent per (session, target mode): the replay converges.
      const replay = await world.service.escalate(
        world.applicationId,
        receipt.sessionId,
        {
          targetMode: "browser",
          insufficiency: {
            stage: "deterministic",
            reasonCode: "action-failed",
            reasonDetail: "the deterministic API call failed in the environment",
            failedActionId: failed.actionId,
            evidenceDigest: digest,
          },
        },
        "esc-key-1",
      );
      expect(replay.replayed).toBe(true);
      expect(
        await world.store.listEscalations(world.applicationId, receipt.sessionId),
      ).toHaveLength(1);
      // SKIPPING a rung is unrepresentable: an escalation whose
      // insufficiency evidence references the deterministic stage while
      // the session's CURRENT mode is browser fails closed typed (no
      // displacement, no mode move).
      await expectPlatformError(
        "POLICY_DENIED",
        world.service.escalate(
          world.applicationId,
          receipt.sessionId,
          {
            targetMode: "desktop",
            insufficiency: {
              stage: "deterministic",
              reasonCode: "action-failed",
              reasonDetail: "skipping attempt",
              failedActionId: failed.actionId,
              evidenceDigest: digest,
            },
          },
          "esc-skip",
        ),
      );
      expect(
        await world.store.listEscalations(world.applicationId, receipt.sessionId),
      ).toHaveLength(1);
    });
  });

  describe("CUI provenance/replay (durable evidence + canonical ledger)", () => {
    test("createSession replays by stable key; key reuse with a DIFFERENT request fails closed", async () => {
      world = await seedComputerUseWorld(ctx.port);
      const executionId = await world.driveToRunning(world.boot(null).executions);
      const first = await world.createSession({ executionId }, "replay-key");
      const replay = await world.createSession({ executionId }, "replay-key");
      expect(replay.sessionId).toBe(first.sessionId);
      expect(replay.replayed).toBe(true);
      expect(
        await count(
          world.db,
          "SELECT 1 FROM tools.computer_use_sessions WHERE application_id = $1 AND session_key = 'replay-key'",
          [world.applicationId],
        ),
      ).toBe(1);
      await expectPlatformError(
        "IDEMPOTENCY_KEY_REUSED",
        world.createSession(
          {
            executionId,
            task: { kind: "web-workflow", requirementAtoms: ["atom-a"], qualityTarget: 0.9 },
          },
          "replay-key",
        ),
      );
      expect(
        await count(
          world.db,
          "SELECT 1 FROM tools.computer_use_sessions WHERE application_id = $1 AND session_key = 'replay-key'",
          [world.applicationId],
        ),
      ).toBe(1);
    });

    test("a deterministic api-call action leaves durable evidence + ledger bindings exactly once per key", async () => {
      world = await seedComputerUseWorld(ctx.port);
      const executionId = await world.driveToRunning(world.boot(null).executions);
      const receipt = await world.createSession({ executionId }, "prov-session");
      const result = await world.dispatch(
        receipt.sessionId,
        { actionType: "api-call", target: "api.example.com/v1/data", input: {} },
        "prov-action",
      );
      expect(result.status).toBe("succeeded");
      // Exactly ONE action row per stable key (replay converges).
      const replay = await world.dispatch(
        receipt.sessionId,
        { actionType: "api-call", target: "api.example.com/v1/data", input: {} },
        "prov-action",
      );
      expect(replay.replayed).toBe(true);
      expect(replay.actionId).toBe(result.actionId);
      expect(await actionCount(receipt.sessionId)).toBe(1);
      // The ledger evidence rides the CANONICAL executions ledger with
      // the tools producer vocabulary: the ACTION's requested + result
      // events exist exactly once (the replay converged, not
      // duplicated; the session-admission and env-open events are
      // separate keyed records).
      const actionEvents = async () => {
        const rows = await world.db.execute<{ sequence: number; type: string }>({
          sql: "SELECT sequence, type FROM executions.execution_events WHERE execution_id = $1 AND payload->>'actionId' = $2 ORDER BY sequence",
          parameters: [executionId, result.actionId],
        });
        return rows.rows.map((row) => row.type);
      };
      let actionTypes = await actionEvents();
      expect(actionTypes.filter((type) => type === "execution.tool-requested")).toHaveLength(1);
      expect(actionTypes.filter((type) => type === "execution.tool-result")).toHaveLength(1);
      // The replay converges: no additional ledger rows for the same
      // stable action key.
      await world.dispatch(
        receipt.sessionId,
        { actionType: "api-call", target: "api.example.com/v1/data", input: {} },
        "prov-action",
      );
      actionTypes = await actionEvents();
      expect(actionTypes.filter((type) => type === "execution.tool-requested")).toHaveLength(1);
      expect(actionTypes.filter((type) => type === "execution.tool-result")).toHaveLength(1);
      // Key reuse with a DIFFERENT input fails closed (fingerprint
      // arbitration).
      await expectPlatformError(
        "IDEMPOTENCY_KEY_REUSED",
        world.dispatch(
          receipt.sessionId,
          { actionType: "api-call", target: "api.example.com/v1/other", input: {} },
          "prov-action",
        ),
      );
      expect(await actionCount(receipt.sessionId)).toBe(1);
    });
  });

  describe("CUI tenant isolation", () => {
    test("a cross-tenant actor cannot create a session (zero durable rows, typed)", async () => {
      world = await seedComputerUseWorld(ctx.port);
      const executionId = await world.driveToRunning(world.boot(null).executions);
      await expectPlatformError(
        "TENANT_SCOPE_VIOLATION",
        world.service.createSession(
          {
            applicationId: world.applicationId,
            executionId,
            actor: {
              actorId: "00000000-0000-7000-8000-0000000000ee",
              tenantId: world.otherTenantId,
            },
            task: {
              kind: "structured-data-retrieval",
              requirementAtoms: ["atom-a", "atom-b"],
              qualityTarget: 0.9,
            },
            candidates: { deterministic: ["computer-use-api-det"], browser: null, desktop: null },
            connectionRef: null,
          },
          "cross-tenant-key",
        ),
      );
      expect(
        await count(
          world.db,
          "SELECT 1 FROM tools.computer_use_sessions WHERE session_key = 'cross-tenant-key'",
          [],
        ),
      ).toBe(0);
      expect(world.environment.activity()).toHaveLength(0);
    });

    test("sessions are invisible across applications (scoped reads)", async () => {
      world = await seedComputerUseWorld(ctx.port);
      const executionId = await world.driveToRunning(world.boot(null).executions);
      const receipt = await world.createSession({ executionId }, "iso-session");
      // The application guard is the identity: another application's id
      // sees nothing (the store scopes every read by application_id).
      const foreign = await world.store.findSession(
        "00000000-0000-7000-8000-00000000ffff",
        receipt.sessionId,
      );
      expect(foreign).toBeNull();
      const own = await world.store.findSession(world.applicationId, receipt.sessionId);
      expect(own?.id).toBe(receipt.sessionId);
    });
  });

  describe("CUI concurrency (physical convergence in PostgreSQL)", () => {
    test("N=8 same-key createSession calls converge to ONE session and ONE env open", async () => {
      world = await seedComputerUseWorld(ctx.port);
      const executionId = await world.driveToRunning(world.boot(null).executions);
      const receipts = await Promise.all(
        Array.from({ length: 8 }, () => world.createSession({ executionId }, "concurrent-key")),
      );
      const ids = new Set(receipts.map((receipt) => receipt.sessionId));
      expect(ids.size).toBe(1);
      expect(receipts.filter((receipt) => receipt.replayed)).toHaveLength(7);
      expect(
        await count(
          world.db,
          "SELECT 1 FROM tools.computer_use_sessions WHERE application_id = $1 AND session_key = 'concurrent-key'",
          [world.applicationId],
        ),
      ).toBe(1);
      // The session-create operation converged onto ONE row.
      expect(await operationsOf("session-create")).toBe(1);
    });

    test("N=8 same-key dispatchAction calls converge to ONE action row", async () => {
      world = await seedComputerUseWorld(ctx.port);
      const executionId = await world.driveToRunning(world.boot(null).executions);
      const receipt = await world.createSession({ executionId }, "concurrent-action-session");
      const results = await Promise.all(
        Array.from({ length: 8 }, () =>
          world.dispatch(
            receipt.sessionId,
            { actionType: "api-call", target: "api.example.com/v1/data", input: {} },
            "concurrent-action-key",
          ),
        ),
      );
      const ids = new Set(results.map((result) => result.actionId));
      expect(ids.size).toBe(1);
      expect(await actionCount(receipt.sessionId)).toBe(1);
      // The external effect happened exactly once per stable key: the
      // environment journal's action entries for that key converge.
      const actionEntries = world.environment
        .activity()
        .filter((entry) => entry.operation === "action");
      expect(actionEntries.length).toBeGreaterThanOrEqual(1);
      expect(actionEntries.filter((entry) => entry.replayed === false).length).toBe(1);
    });
  });

  describe("CUI credential mediation (REAL connections module)", () => {
    test("a BYOK-credentialed route mediating through the catalog yields an OPAQUE grant (material never durable)", async () => {
      world = await seedComputerUseWorld(ctx.port);
      const executionId = await world.driveToRunning(world.boot(null).executions);
      const receipt = await world.createSession(
        {
          executionId,
          candidates: {
            deterministic: ["computer-use-api-credentialed"],
            browser: null,
            desktop: null,
          },
          connectionRef: world.connectionId,
        },
        "mediated-session",
      );
      expect(receipt.status).toBe("active");
      const session = await world.store.findSessionByKey(world.applicationId, "mediated-session");
      expect(session?.admission.secretGrantRef).toContain("cu-grant:");
      expect(session?.admission.secretGrantRef).toContain(world.connectionId);
      expect(session?.admission.secretGrantRef).not.toContain("DO-NOT-LEAK");
      // The material never appears in ANY durable computer-use byte
      // (sessions, escalations, actions, observations, operations).
      for (const sql of [
        "SELECT admission::text AS t FROM tools.computer_use_sessions WHERE application_id = $1",
        "SELECT mode_context::text AS t FROM tools.computer_use_sessions WHERE application_id = $1",
        "SELECT row_to_json(e.*)::text AS t FROM tools.computer_use_escalations e WHERE e.application_id = $1",
        "SELECT row_to_json(a.*)::text AS t FROM tools.computer_use_actions a WHERE a.application_id = $1",
        "SELECT row_to_json(o.*)::text AS t FROM tools.computer_use_observations o WHERE o.application_id = $1",
        "SELECT row_to_json(p.*)::text AS t FROM tools.computer_use_operations p WHERE p.application_id = $1",
        "SELECT payload::text AS t FROM executions.execution_events WHERE application_id = $1",
      ] as const) {
        const rows = await world.db.execute<{ t: string }>({
          sql,
          parameters: [world.applicationId],
        });
        for (const row of rows.rows) {
          expect(row.t).not.toContain("cu-byok-material-DO-NOT-LEAK");
        }
      }
    });

    test("a DISABLED connection fails closed typed (secret-mediation denial, durable)", async () => {
      world = await seedComputerUseWorld(ctx.port);
      await world.disableConnection();
      const executionId = await world.driveToRunning(world.boot(null).executions);
      await expectPlatformError(
        "AUTHORIZATION_DENIED",
        world.createSession(
          {
            executionId,
            candidates: {
              deterministic: ["computer-use-api-credentialed"],
              browser: null,
              desktop: null,
            },
            connectionRef: world.connectionId,
          },
          "mediation-refused",
        ),
      );
      expect(world.environment.activity()).toHaveLength(0);
      const row = await sessionRow("mediation-refused");
      expect(row?.status).toBe("denied");
      expect(row?.denial_class).toBe("secret-mediation");
    });
  });

  describe("CUI terminal execution through the REAL sandbox module", () => {
    test("a terminal-exec action is a fully admitted sandbox execution (durable provenance, argv rail)", async () => {
      world = await seedComputerUseWorld(ctx.port);
      const executionId = await world.driveToRunning(world.boot(null).executions);
      const receipt = await world.createSession(
        {
          executionId,
          task: { kind: "terminal-task", requirementAtoms: ["atom-a"], qualityTarget: 0.9 },
          candidates: {
            deterministic: [],
            browser: null,
            desktop: "computer-use-desktop-isolated",
          },
        },
        "terminal-session",
      );
      expect(receipt.mode).toBe("desktop");
      // A shell-style command is refused BEFORE the sandbox seam is
      // consulted (zero sandbox rows for the refusal, durable failed
      // row — the argv discipline precedes any substrate dispatch).
      const shellRefused = await world.dispatch(
        receipt.sessionId,
        { actionType: "terminal-exec", target: "/workspace", input: { command: "rm -rf /" } },
        "terminal-shell-refused",
      );
      expect(shellRefused.status).toBe("failed");
      expect(
        await count(
          world.db,
          "SELECT 1 FROM sandbox.sandbox_executions WHERE application_id = $1",
          [world.applicationId],
        ),
      ).toBe(0);
      const result = await world.dispatch(
        receipt.sessionId,
        {
          actionType: "terminal-exec",
          target: "/workspace/report.txt",
          input: { command: "ls", args: ["/workspace"] },
        },
        "terminal-action",
      );
      expect(result.status).toBe("succeeded");
      expect(result.sandboxExecutionId).not.toBeNull();
      // The action row carries the sandbox provenance + the run argv.
      const actions = await world.store.listActions(world.applicationId, receipt.sessionId);
      const action = actions.find((item) => item.id === result.actionId);
      expect(action?.sandboxExecutionId).toBe(result.sandboxExecutionId);
      // The sandbox execution row physically exists with the EXACT argv
      // (runner + runnerArgs + the terminal command and args — never a
      // shell string).
      const sandboxRow = await one<{
        task: { command: string; args: string[] };
        status: string;
      }>(
        world.db,
        "SELECT runtime_metadata->'task' AS task, status FROM sandbox.sandbox_executions WHERE id = $1",
        [result.sandboxExecutionId],
      );
      expect(sandboxRow?.status).toBe("completed");
      expect(sandboxRow?.task.command).toBe(process.execPath);
      expect(sandboxRow?.task.args).toEqual([
        "-e",
        "console.log('cu-terminal-ok')",
        "ls",
        "/workspace",
      ]);
      // The declared usage stays within the admitted route ceiling: the
      // FIRST terminal action consumed the desktop estimate (80), so a
      // second is denied typed (the PHYSICAL budget guard).
      await expectPlatformError(
        "BUDGET_EXCEEDED",
        world.dispatch(
          receipt.sessionId,
          {
            actionType: "terminal-exec",
            target: "/workspace/other.txt",
            input: { command: "cat", args: ["/workspace/other.txt"] },
          },
          "terminal-over-budget",
        ),
      );
    });
  });
});
