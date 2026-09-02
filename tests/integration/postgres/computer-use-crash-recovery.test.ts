/**
 * Real-PostgreSQL crash-injection proofs — the PHYSICAL half of the
 * CONCURRENCY-CRASH-SAFETY checkpoint contract for the governed
 * computer-use fabric (WORK-027; CUI-001/002/003; the blocking
 * checkpoints SELF-HOSTING-BOUNDARY + EXECUTION-PROVENANCE).
 *
 * The unit suite (tests/unit/tools/computer-use-crash-recovery.test.ts,
 * C1-C10) proves the behavioral half over the in-memory world. THIS
 * suite proves the kill/restart discipline against REAL PostgreSQL
 * (migrations 0001..0023): every authority is REAL and SURVIVES the
 * process death (the WORK-007 policy engine, the WORK-005 capability
 * registry, the WORK-003 connections module behind the secret-mediation
 * seam, the WORK-004 budgets SQL wallet, the WORK-012 sandbox module
 * behind the terminal executor and the FROZEN executions module with
 * the canonical EventEnvelope ledger). The world's `boot(point)`
 * primitive arms ONE durable-boundary crash point per booted process
 * (before/after the durable commit or the external effect); the
 * process dies mid-flight and a re-booted service over the SAME PG
 * store must converge with EXACTLY ONE durable row / ledger event /
 * wallet mutation / sandbox execution per stable idempotency key.
 *
 * THE PROOF RECORDS (the required critical boundaries):
 *   SESSION CREATION  P1 crash-after the durable operation claim →
 *                     restart converges (one session, one completed
 *                     operation, one wallet reservation, admitted
 *                     ledger evidence once)
 *   WALLET            P2 crash-after the budget reservation → the
 *                     retry's keyed reserve converges (ONE reservation
 *                     row — the physical budget-before-spend boundary)
 *   SESSION IDENTITY  P3 crash-after the session insert → the restart
 *                     converges onto the SAME row and completes the
 *                     environment open (the prior process died between
 *                     the session row and the environment boundary)
 *   EXTERNAL OPEN     P4 crash-after the isolated environment open →
 *                     the restart converges (one session, the env-open
 *                     ledger evidence exactly once)
 *   ACTION DISPATCH   P5 crash-after the action insert → the restart
 *                     converges onto the SAME action (one row, one
 *                     ledger intent + result event set)
 *   LEDGER INTENT     P6 crash-after the canonical ledger intent
 *                     commit → the frozen ledger deduplicates the
 *                     retried intent by its stable key
 *   OBSERVATION       P7 crash-after the observation insert (the first
 *                     durable write past the external effect) → the
 *                     retry converges the observation set EXACTLY ONCE
 *                     (one row per action frame — no duplicate append)
 *   TERMINAL RAIL     P8 a terminal-exec action dies after the REAL
 *                     sandbox run → the retry's keyed sandbox dispatch
 *                     REPLAYS the completed execution (single-dispatch
 *                     semantics: the external terminal effect runs
 *                     ONCE, the same sandbox row converges)
 *   ESCALATION        P9 crash-after the escalation insert → the
 *                     restart converges (one escalation row, one mode
 *                     move, the new mode's environment once)
 *   TERMINATION       P10 crash-after the guarded terminal session
 *                     mutation → the restart converges (terminal
 *                     exactly once, the reservation SETTLES exactly
 *                     once)
 *                     P11 crash-after the durable operation completion
 *                     → the retry replays the terminal outcome and
 *                     settles NOTHING new
 *   CREDENTIAL        P12 crash-after the credentialed admission
 *   HANDOFF           bundle insert → the restart replays the SAME
 *                     opaque grant reference; the BYOK material
 *                     appears in ZERO durable computer-use bytes
 *   OUTCOME REPLAY    P13 a completed createSession from a dead
 *                     process replays its OUTCOME with ZERO new
 *                     durable rows (sessions, operations, ledger
 *                     events, wallet reservations)
 */

import { createHash } from "node:crypto";
import { describe, expect, test } from "vitest";
import {
  type ComputerUseSessionRequest,
  canonicalComputerUseJson,
} from "../../../src/modules/tools/public";
import {
  type ComputerUseCrashPoint,
  type ComputerUsePgWorld,
  count,
  deterministicDeclaration,
  diesDuring,
  one,
  seedComputerUseWorld,
} from "./computer-use-world";
import { definePgSuite, type PgContext } from "./harness";

const sha256Hex = (value: string): string =>
  createHash("sha256").update(value, "utf8").digest("hex");

definePgSuite(
  "computer-use crash-injection proofs (WORK-027) on real PostgreSQL",
  (ctx: PgContext) => {
    let world: ComputerUsePgWorld;

    const freshWorld = async () => {
      world = await seedComputerUseWorld(ctx.port);
      return world;
    };

    const runningExecution = () => world.driveToRunning(world.boot(null).executions);

    const sessionRequest = (
      executionId: string,
      overrides: Partial<ComputerUseSessionRequest> = {},
    ): ComputerUseSessionRequest => ({
      applicationId: world.applicationId,
      executionId,
      actor: world.actor(),
      task: {
        kind: "structured-data-retrieval",
        requirementAtoms: ["atom-a", "atom-b"],
        qualityTarget: 0.9,
      },
      candidates: {
        deterministic: ["computer-use-api-det"],
        browser: "computer-use-browser-isolated",
        desktop: "computer-use-desktop-isolated",
      },
      connectionRef: null,
      ...overrides,
    });

    const apiCall = (target = "api.example.com/v1/data") => ({
      actionType: "api-call" as const,
      target,
      input: {},
    });

    const terminalCall = () => ({
      actionType: "terminal-exec" as const,
      target: "/workspace/report.txt",
      input: { command: "ls", args: ["/workspace"] },
    });

    // ---- durable-state counters (the physical side-effect proofs) ----

    const sessionsOf = (executionId: string) =>
      count(
        world.db,
        "SELECT 1 FROM tools.computer_use_sessions WHERE application_id = $1 AND execution_id = $2",
        [world.applicationId, executionId],
      );

    const operationsOf = (kind: string) =>
      count(
        world.db,
        "SELECT 1 FROM tools.computer_use_operations WHERE application_id = $1 AND operation_kind = $2",
        [world.applicationId, kind],
      );

    const completedOperationsOf = (kind: string) =>
      count(
        world.db,
        "SELECT 1 FROM tools.computer_use_operations WHERE application_id = $1 AND operation_kind = $2 AND status = 'completed'",
        [world.applicationId, kind],
      );

    const actionsOf = (sessionId: string) =>
      count(
        world.db,
        "SELECT 1 FROM tools.computer_use_actions WHERE application_id = $1 AND session_id = $2",
        [world.applicationId, sessionId],
      );

    const observationsOf = (actionId: string) =>
      count(
        world.db,
        "SELECT 1 FROM tools.computer_use_observations WHERE application_id = $1 AND action_id = $2",
        [world.applicationId, actionId],
      );

    const escalationsOf = (sessionId: string) =>
      count(
        world.db,
        "SELECT 1 FROM tools.computer_use_escalations WHERE application_id = $1 AND session_id = $2",
        [world.applicationId, sessionId],
      );

    const reservationsOf = () =>
      count(
        world.db,
        "SELECT 1 FROM budgets.reservations r JOIN budgets.wallets w ON w.id = r.wallet_id WHERE w.application_id = $1",
        [world.applicationId],
      );

    const sandboxRows = () =>
      count(world.db, "SELECT 1 FROM sandbox.sandbox_executions WHERE application_id = $1", [
        world.applicationId,
      ]);

    const sessionEvents = async (sessionId: string) => {
      const rows = await world.db.execute<{ type: string }>({
        sql: "SELECT type FROM executions.execution_events WHERE application_id = $1 AND payload->>'sessionId' = $2",
        parameters: [world.applicationId, sessionId],
      });
      return rows.rows.map((row) => row.type);
    };

    const actionEvents = async (actionId: string) => {
      const rows = await world.db.execute<{ type: string }>({
        sql: "SELECT type FROM executions.execution_events WHERE application_id = $1 AND payload->>'actionId' = $2",
        parameters: [world.applicationId, actionId],
      });
      return rows.rows.map((row) => row.type);
    };

    const sessionRow = (sessionKey: string) =>
      one<{
        id: string;
        status: string;
        current_mode: string;
        environment_ref: string | null;
        escalation_count: number;
        admission: { secretGrantRef: string | null; budgetOperationId: string | null };
      }>(
        world.db,
        "SELECT * FROM tools.computer_use_sessions WHERE application_id = $1 AND session_key = $2",
        [world.applicationId, sessionKey],
      );

    const reservationStatus = async () => {
      const row = await one<{ status: string; n: number }>(
        world.db,
        "SELECT r.status, COUNT(*)::int AS n FROM budgets.reservations r JOIN budgets.wallets w ON w.id = r.wallet_id WHERE w.application_id = $1 GROUP BY r.status",
        [world.applicationId],
      );
      return row;
    };

    describe("P-proofs: session creation boundaries", () => {
      test("P1: crash AFTER the durable operation claim → restart converges (one session, one operation, one reservation, evidence once)", async () => {
        await freshWorld();
        const executionId = await runningExecution();
        const dying = world.boot({
          target: "store",
          method: "beginComputerUseOperation",
          when: "after",
        } satisfies ComputerUseCrashPoint);
        await diesDuring(
          () => dying.service.createSession(sessionRequest(executionId), "p1-key"),
          dying.crashed,
        );
        // The claim survived; NOTHING else did.
        expect(await sessionsOf(executionId)).toBe(0);
        expect(await operationsOf("session-create")).toBe(1);
        expect(await reservationsOf()).toBe(0);
        const live = world.boot();
        const receipt = await live.service.createSession(sessionRequest(executionId), "p1-key");
        expect(receipt.replayed).toBe(false);
        expect(receipt.status).toBe("active");
        expect(receipt.environmentRef).not.toBeNull();
        expect(await sessionsOf(executionId)).toBe(1);
        expect(await completedOperationsOf("session-create")).toBe(1);
        expect(await operationsOf("session-create")).toBe(1);
        expect(await reservationsOf()).toBe(1);
        const events = await sessionEvents(receipt.sessionId);
        expect(events.filter((type) => type === "execution.tool-requested")).toHaveLength(1);
        expect(events.filter((type) => type === "execution.tool-result")).toHaveLength(1);
      });

      test("P2: crash AFTER the budget reservation → the retry's keyed reserve converges (ONE physical reservation)", async () => {
        await freshWorld();
        const executionId = await runningExecution();
        const dying = world.boot({
          target: "budgets",
          method: "reserve",
          when: "after",
        } satisfies ComputerUseCrashPoint);
        await diesDuring(
          () => dying.service.createSession(sessionRequest(executionId), "p2-key"),
          dying.crashed,
        );
        // The wallet reservation is PHYSICALLY durable; no session row yet.
        expect(await reservationsOf()).toBe(1);
        expect(await sessionsOf(executionId)).toBe(0);
        const live = world.boot();
        const receipt = await live.service.createSession(sessionRequest(executionId), "p2-key");
        expect(receipt.status).toBe("active");
        // The retry's reserve with the SAME stable budget operation id
        // (derived from the durable session identity) converges: ONE
        // reservation row, ONE wallet debit.
        expect(await reservationsOf()).toBe(1);
        expect(await sessionsOf(executionId)).toBe(1);
      });

      test("P3: crash AFTER the session insert → restart converges onto the SAME row and completes the environment open", async () => {
        await freshWorld();
        const executionId = await runningExecution();
        const dying = world.boot({
          target: "store",
          method: "insertSession",
          when: "after",
        } satisfies ComputerUseCrashPoint);
        await diesDuring(
          () => dying.service.createSession(sessionRequest(executionId), "p3-key"),
          dying.crashed,
        );
        const persisted = await sessionRow("p3-key");
        expect(persisted?.status).toBe("active");
        expect(persisted?.environment_ref).toBeNull();
        const live = world.boot();
        const receipt = await live.service.createSession(sessionRequest(executionId), "p3-key");
        expect(receipt.replayed).toBe(true);
        expect(receipt.sessionId).toBe(persisted?.id);
        expect(receipt.status).toBe("active");
        // The prior process died between the session row and the
        // environment boundary: the restart converges the open.
        expect(receipt.environmentRef).not.toBeNull();
        expect(await sessionsOf(executionId)).toBe(1);
        expect(await completedOperationsOf("session-create")).toBe(1);
        // The admitted ledger evidence converged exactly once (the
        // crash fell between the session insert and the event append;
        // the replay's KEYED append converged it).
        const events = await sessionEvents(receipt.sessionId);
        expect(events.filter((type) => type === "execution.tool-requested")).toHaveLength(1);
        expect(events.filter((type) => type === "execution.tool-result")).toHaveLength(1);
      });

      test("P4: crash AFTER the external environment open → restart converges (one session, env-open evidence once)", async () => {
        await freshWorld();
        const executionId = await runningExecution();
        const dying = world.boot({
          target: "environment",
          method: "open",
          when: "after",
        } satisfies ComputerUseCrashPoint);
        await diesDuring(
          () => dying.service.createSession(sessionRequest(executionId), "p4-key"),
          dying.crashed,
        );
        const persisted = await sessionRow("p4-key");
        expect(persisted?.status).toBe("active");
        expect(persisted?.environment_ref).toBeNull();
        const live = world.boot();
        const receipt = await live.service.createSession(sessionRequest(executionId), "p4-key");
        expect(receipt.replayed).toBe(true);
        expect(receipt.environmentRef).not.toBeNull();
        expect(await sessionsOf(executionId)).toBe(1);
        // The env-open ledger evidence exists exactly once (the durable
        // event key converged the restart's append).
        const events = await sessionEvents(receipt.sessionId);
        expect(events.filter((type) => type === "execution.tool-requested")).toHaveLength(1);
        expect(events.filter((type) => type === "execution.tool-result")).toHaveLength(1);
        // The durable env-open key converged the re-open: exactly ONE
        // external open effect, the restart's open is a REPLAY that
        // returns the SAME environment reference.
        const opens = world.environment.activity().filter((entry) => entry.operation === "open");
        expect(opens.filter((entry) => !entry.replayed)).toHaveLength(1);
        expect(opens.filter((entry) => entry.replayed)).toHaveLength(1);
      });
    });

    describe("P-proofs: action dispatch boundaries", () => {
      const admittedSession = async (sessionKey: string) => {
        const executionId = await runningExecution();
        const live = world.boot();
        const receipt = await live.service.createSession(sessionRequest(executionId), sessionKey);
        return receipt;
      };

      test("P5: crash AFTER the action insert → restart converges onto the SAME action (one row, one ledger evidence set)", async () => {
        await freshWorld();
        const receipt = await admittedSession("p5-session");
        const dying = world.boot({
          target: "store",
          method: "insertAction",
          when: "after",
        } satisfies ComputerUseCrashPoint);
        await diesDuring(
          () =>
            dying.service.dispatchAction(
              world.applicationId,
              receipt.sessionId,
              apiCall(),
              "p5-action",
            ),
          dying.crashed,
        );
        // The action row exists, still dispatching; the operation claim
        // is pending.
        expect(await actionsOf(receipt.sessionId)).toBe(1);
        const live = world.boot();
        const result = await live.service.dispatchAction(
          world.applicationId,
          receipt.sessionId,
          apiCall(),
          "p5-action",
        );
        expect(result.status).toBe("succeeded");
        expect(result.replayed).toBe(false);
        expect(await actionsOf(receipt.sessionId)).toBe(1);
        expect(await observationsOf(result.actionId)).toBe(1);
        const events = await actionEvents(result.actionId);
        expect(events.filter((type) => type === "execution.tool-requested")).toHaveLength(1);
        expect(events.filter((type) => type === "execution.tool-result")).toHaveLength(1);
        expect(await completedOperationsOf("action-dispatch")).toBe(1);
        // The external environment act happened exactly once (the
        // dying process died BEFORE the effect; the retry's keyed act
        // is the one and only non-replayed entry).
        const acts = world.environment.activity().filter((entry) => entry.operation === "action");
        expect(acts.filter((entry) => !entry.replayed)).toHaveLength(1);
      });

      test("P6: crash AFTER the canonical ledger intent commit → the frozen ledger deduplicates the retried intent by key", async () => {
        await freshWorld();
        const receipt = await admittedSession("p6-session");
        const dying = world.boot({
          target: "executions",
          method: "recordStepEvent",
          when: "after",
        } satisfies ComputerUseCrashPoint);
        await diesDuring(
          () =>
            dying.service.dispatchAction(
              world.applicationId,
              receipt.sessionId,
              apiCall(),
              "p6-action",
            ),
          dying.crashed,
        );
        const live = world.boot();
        const result = await live.service.dispatchAction(
          world.applicationId,
          receipt.sessionId,
          apiCall(),
          "p6-action",
        );
        expect(result.status).toBe("succeeded");
        expect(await actionsOf(receipt.sessionId)).toBe(1);
        // The FROZEN ledger converged the retried intent: exactly ONE
        // tool-requested event for this action identity (the stable key
        // discipline of the canonical EventEnvelope write path).
        const events = await actionEvents(result.actionId);
        expect(events.filter((type) => type === "execution.tool-requested")).toHaveLength(1);
        expect(events.filter((type) => type === "execution.tool-result")).toHaveLength(1);
      });

      test("P7: crash AFTER the observation insert → the retry converges the observation set EXACTLY ONCE (one row per action frame)", async () => {
        await freshWorld();
        const receipt = await admittedSession("p7-session");
        // The durable-boundary death point past the external effect: the
        // first durable write the live process makes after the
        // environment act (the observation insert). The action row stays
        // `dispatching`; the observation is durable.
        const dying = world.boot({
          target: "store",
          method: "insertObservation",
          when: "after",
        } satisfies ComputerUseCrashPoint);
        await diesDuring(
          () =>
            dying.service.dispatchAction(
              world.applicationId,
              receipt.sessionId,
              apiCall(),
              "p7-action",
            ),
          dying.crashed,
        );
        const persisted = await world.store.findActionByKey(
          world.applicationId,
          receipt.sessionId,
          "p7-action",
        );
        expect(persisted?.status).toBe("dispatching");
        expect(await observationsOf(persisted?.id ?? "none")).toBe(1);
        const live = world.boot();
        const result = await live.service.dispatchAction(
          world.applicationId,
          receipt.sessionId,
          apiCall(),
          "p7-action",
        );
        expect(result.status).toBe("succeeded");
        expect(result.actionId).toBe(persisted?.id);
        expect(await actionsOf(receipt.sessionId)).toBe(1);
        // EXACTLY ONCE: the retry converged onto the prior process's
        // observation row (same action, same frame digest) instead of
        // appending a duplicate.
        expect(await observationsOf(result.actionId)).toBe(1);
        const events = await actionEvents(result.actionId);
        expect(events.filter((type) => type === "execution.tool-requested")).toHaveLength(1);
        expect(events.filter((type) => type === "execution.tool-result")).toHaveLength(1);
        // The external environment act is keyed by the stable action
        // key: the dying process's act is the ONE non-replayed effect;
        // the retry's act is a REPLAY that returns the cached outcome.
        const acts = world.environment.activity().filter((entry) => entry.operation === "action");
        expect(acts.filter((entry) => !entry.replayed)).toHaveLength(1);
        expect(acts.filter((entry) => entry.replayed)).toHaveLength(1);
      });

      test("P8: a terminal-exec action dies AFTER the REAL sandbox run → the retry REPLAYS the completed sandbox execution (the external effect runs ONCE)", async () => {
        await freshWorld();
        const executionId = await runningExecution();
        const live = world.boot();
        const receipt = await live.service.createSession(
          sessionRequest(executionId, {
            task: { kind: "terminal-task", requirementAtoms: ["atom-a"], qualityTarget: 0.9 },
            candidates: {
              deterministic: [],
              browser: null,
              desktop: "computer-use-desktop-isolated",
            },
          }),
          "p8-session",
        );
        expect(receipt.mode).toBe("desktop");
        // The death point past the REAL sandbox run: the observation
        // insert (the first durable write after the process executed).
        const dying = world.boot({
          target: "store",
          method: "insertObservation",
          when: "before",
        } satisfies ComputerUseCrashPoint);
        await diesDuring(
          () =>
            dying.service.dispatchAction(
              world.applicationId,
              receipt.sessionId,
              terminalCall(),
              "p8-action",
            ),
          dying.crashed,
        );
        const persisted = await world.store.findActionByKey(
          world.applicationId,
          receipt.sessionId,
          "p8-action",
        );
        expect(persisted?.status).toBe("dispatching");
        // The sandbox execution already ran (the external effect).
        expect(await sandboxRows()).toBe(1);
        const sandboxIdBefore = await one<{ id: string }>(
          world.db,
          "SELECT id FROM sandbox.sandbox_executions WHERE application_id = $1",
          [world.applicationId],
        );
        const restarted = world.boot();
        const result = await restarted.service.dispatchAction(
          world.applicationId,
          receipt.sessionId,
          terminalCall(),
          "p8-action",
        );
        expect(result.status).toBe("succeeded");
        // Single-dispatch semantics: the sandbox row converged onto the
        // SAME id — the retry did NOT spawn a second sandbox execution
        // (the external terminal effect runs ONCE per stable key).
        expect(result.sandboxExecutionId).not.toBeNull();
        expect(result.sandboxExecutionId).toBe(sandboxIdBefore?.id);
        expect(await sandboxRows()).toBe(1);
        expect(await actionsOf(receipt.sessionId)).toBe(1);
        const sandboxRow = await one<{ status: string }>(
          world.db,
          "SELECT status FROM sandbox.sandbox_executions WHERE id = $1",
          [result.sandboxExecutionId],
        );
        expect(sandboxRow?.status).toBe("completed");
      });
    });

    describe("P-proofs: escalation + termination boundaries", () => {
      const escalatedSetup = async () => {
        await freshWorld();
        await world.register(
          deterministicDeclaration({
            capabilityId: "computer-use-api-det-estimated",
            qualityConfidence: "estimated",
          }),
        );
        const executionId = await runningExecution();
        const live = world.boot();
        const receipt = await live.service.createSession(
          sessionRequest(executionId, {
            candidates: {
              deterministic: ["computer-use-api-det-estimated"],
              browser: "computer-use-browser-isolated",
              desktop: "computer-use-desktop-isolated",
            },
          }),
          "p9-session",
        );
        expect(receipt.mode).toBe("deterministic");
        world.environment.injectNextActionFailure();
        const failed = await live.service.dispatchAction(
          world.applicationId,
          receipt.sessionId,
          apiCall(),
          "p9-failed-action",
        );
        expect(failed.status).toBe("failed");
        const failedAction = (
          await world.store.listActions(world.applicationId, receipt.sessionId)
        ).find((item) => item.id === failed.actionId);
        const digest = sha256Hex(
          canonicalComputerUseJson({
            actionId: failedAction?.id,
            status: failedAction?.status,
            failureClass: failedAction?.failureClass,
            resultDigest: failedAction?.resultDigest,
          }),
        );
        return {
          receipt,
          escalationRequest: {
            targetMode: "browser" as const,
            insufficiency: {
              stage: "deterministic" as const,
              reasonCode: "action-failed",
              reasonDetail: "the deterministic API call failed in the environment",
              failedActionId: failed.actionId,
              evidenceDigest: digest,
            },
          },
        };
      };

      test("P9: crash AFTER the escalation insert → restart converges (one row, one mode move, the new mode's environment once)", async () => {
        const setup = await escalatedSetup();
        const dying = world.boot({
          target: "store",
          method: "insertEscalation",
          when: "after",
        } satisfies ComputerUseCrashPoint);
        await diesDuring(
          () =>
            dying.service.escalate(
              world.applicationId,
              setup.receipt.sessionId,
              setup.escalationRequest,
              "p9-esc",
            ),
          dying.crashed,
        );
        // The escalation row is durable; the mode move did NOT happen.
        expect(await escalationsOf(setup.receipt.sessionId)).toBe(1);
        expect((await sessionRow("p9-session"))?.current_mode).toBe("deterministic");
        const restarted = world.boot();
        const escalated = await restarted.service.escalate(
          world.applicationId,
          setup.receipt.sessionId,
          setup.escalationRequest,
          "p9-esc",
        );
        expect(escalated.replayed).toBe(true);
        expect(escalated.mode).toBe("browser");
        expect(await escalationsOf(setup.receipt.sessionId)).toBe(1);
        const row = await sessionRow("p9-session");
        expect(row?.current_mode).toBe("browser");
        expect(row?.escalation_count).toBe(1);
        expect(row?.environment_ref).not.toBeNull();
        // The escalation's ledger evidence + the browser environment open
        // each exist exactly once: session-admitted, action-requested,
        // escalation-admitted (3 tool-requested) and env-open
        // deterministic, action-failed, env-open browser (3 tool-result).
        const events = await sessionEvents(setup.receipt.sessionId);
        expect(events.filter((type) => type === "execution.tool-requested")).toHaveLength(3);
        expect(events.filter((type) => type === "execution.tool-result")).toHaveLength(3);
        // The browser environment opened exactly once across the crash.
        const browserOpens = world.environment
          .activity()
          .filter((entry) => entry.operation === "open" && entry.mode === "browser");
        expect(browserOpens.filter((entry) => !entry.replayed)).toHaveLength(1);
      });

      test("P10: crash AFTER the guarded terminal session mutation → restart converges (terminal once, settle EXACTLY ONCE)", async () => {
        await freshWorld();
        const executionId = await runningExecution();
        const live = world.boot();
        const receipt = await live.service.createSession(
          sessionRequest(executionId),
          "p10-session",
        );
        await live.service.dispatchAction(
          world.applicationId,
          receipt.sessionId,
          apiCall(),
          "p10-action",
        );
        expect(await reservationsOf()).toBe(1);
        const dying = world.boot({
          target: "store",
          method: "applyGuardedSessionMutation",
          when: "after",
        } satisfies ComputerUseCrashPoint);
        await diesDuring(
          () =>
            dying.service.terminate(
              world.applicationId,
              receipt.sessionId,
              "completed",
              "p10-term",
            ),
          dying.crashed,
        );
        // The terminal move is durable; the settlement did not happen.
        expect((await sessionRow("p10-session"))?.status).toBe("completed");
        expect((await reservationStatus())?.status).toBe("active");
        const restarted = world.boot();
        const terminal = await restarted.service.terminate(
          world.applicationId,
          receipt.sessionId,
          "completed",
          "p10-term",
        );
        expect(terminal.replayed).toBe(true);
        expect(terminal.status).toBe("completed");
        expect(await sessionsOf(executionId)).toBe(1);
        // The reservation SETTLES exactly once (one row, settled once —
        // the keyed settlement converged).
        const status = await reservationStatus();
        expect(status?.status).toBe("settled");
        expect(status?.n).toBe(1);
        const events = await sessionEvents(receipt.sessionId);
        expect(events.filter((type) => type === "execution.tool-result")).toHaveLength(3);
      });

      test("P11: crash AFTER the durable operation completion → the retry replays the terminal outcome and settles NOTHING new", async () => {
        await freshWorld();
        const executionId = await runningExecution();
        const live = world.boot();
        const receipt = await live.service.createSession(
          sessionRequest(executionId),
          "p11-session",
        );
        await live.service.dispatchAction(
          world.applicationId,
          receipt.sessionId,
          apiCall(),
          "p11-action",
        );
        const dying = world.boot({
          target: "store",
          method: "completeOperation",
          when: "after",
        } satisfies ComputerUseCrashPoint);
        await diesDuring(
          () =>
            dying.service.terminate(
              world.applicationId,
              receipt.sessionId,
              "completed",
              "p11-term",
            ),
          dying.crashed,
        );
        const settled = await reservationStatus();
        expect(settled?.status).toBe("settled");
        const eventsBefore = (await sessionEvents(receipt.sessionId)).length;
        const restarted = world.boot();
        const replay = await restarted.service.terminate(
          world.applicationId,
          receipt.sessionId,
          "completed",
          "p11-term",
        );
        expect(replay.replayed).toBe(true);
        expect(replay.status).toBe("completed");
        // The replayed terminal receipt settles NOTHING new (the settle
        // is exactly-once per stable key) and appends NO new ledger
        // evidence.
        expect(await reservationStatus()).toMatchObject({ status: "settled", n: 1 });
        expect((await sessionEvents(receipt.sessionId)).length).toBe(eventsBefore);
        expect(await sessionsOf(executionId)).toBe(1);
      });
    });

    describe("P-proofs: credential handoff + outcome replay", () => {
      test("P12: crash AFTER the credentialed admission bundle insert → the restart replays the SAME opaque grant reference (material in ZERO durable bytes)", async () => {
        await freshWorld();
        const executionId = await runningExecution();
        const request = sessionRequest(executionId, {
          candidates: {
            deterministic: ["computer-use-api-credentialed"],
            browser: null,
            desktop: null,
          },
          connectionRef: world.connectionId,
        });
        const dying = world.boot({
          target: "store",
          method: "insertSession",
          when: "after",
        } satisfies ComputerUseCrashPoint);
        await diesDuring(() => dying.service.createSession(request, "p12-key"), dying.crashed);
        const persisted = await sessionRow("p12-key");
        expect(persisted?.status).toBe("active");
        expect(persisted?.admission.secretGrantRef).toContain("cu-grant:");
        const live = world.boot();
        const receipt = await live.service.createSession(request, "p12-key");
        expect(receipt.replayed).toBe(true);
        expect(receipt.sessionId).toBe(persisted?.id);
        // The SAME opaque grant reference (the credential handoff is a
        // durable reference, never a re-mediation divergence).
        const replayed = await sessionRow("p12-key");
        expect(replayed?.admission.secretGrantRef).toBe(persisted?.admission.secretGrantRef);
        expect(replayed?.admission.secretGrantRef).not.toContain("DO-NOT-LEAK");
        // The BYOK material appears in ZERO durable computer-use bytes.
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
        expect(await sessionsOf(executionId)).toBe(1);
      });

      test("P13: a completed createSession from a dead process replays its OUTCOME with ZERO new durable rows", async () => {
        await freshWorld();
        const executionId = await runningExecution();
        const first = world.boot();
        const receipt = await first.service.createSession(sessionRequest(executionId), "p13-key");
        expect(receipt.replayed).toBe(false);
        expect(await sessionsOf(executionId)).toBe(1);
        expect(await reservationsOf()).toBe(1);
        const eventsBefore = (await sessionEvents(receipt.sessionId)).length;
        const operationsBefore = await operationsOf("session-create");
        // A SECOND process (a restart after success) replays: same
        // session, same environment reference, ZERO new durable rows.
        const second = world.boot();
        const replay = await second.service.createSession(sessionRequest(executionId), "p13-key");
        expect(replay.replayed).toBe(true);
        expect(replay.sessionId).toBe(receipt.sessionId);
        expect(replay.environmentRef).toBe(receipt.environmentRef);
        expect(await sessionsOf(executionId)).toBe(1);
        expect(await reservationsOf()).toBe(1);
        expect(await operationsOf("session-create")).toBe(operationsBefore);
        expect((await sessionEvents(receipt.sessionId)).length).toBe(eventsBefore);
      });
    });
  },
);
