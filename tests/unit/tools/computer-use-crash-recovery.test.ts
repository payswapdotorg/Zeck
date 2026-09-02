/**
 * Unit crash-injection C-proofs — the CRASH-SAFE KEYED OPERATIONS of the
 * governed computer-use service (WORK-027; CUI-001/002/003; the blocking
 * checkpoint contract CONCURRENCY-CRASH-SAFETY — the BEHAVIORAL half
 * over the in-memory world; the real-PostgreSQL suite
 * tests/integration/postgres/computer-use-crash-recovery.test.ts proves
 * the PHYSICAL half over migration 0023).
 *
 * The injector: a Proxy-based seam wrapper arms ONE durable-boundary
 * crash point per booted process (a method on the computer-use store,
 * the execution-ledger seam or the isolated environment, before/after
 * its durable commit or external effect) and kills the process
 * mid-flight. Every record asserts the point FIRED (a vacuous crash
 * proof fails) and that a re-booted service over the SAME world
 * converges with EXACTLY ONE durable row / external effect per stable
 * idempotency key.
 *
 * THE C-RECORDS:
 *   C1  session-create: crash AFTER the durable operation claim →
 *       restart converges (one session, one environment open)
 *   C2  session-create: crash AFTER the session insert (the durable
 *       identity exists, the admission bundle does not yet) → restart
 *       converges onto the SAME session row
 *   C3  session-create: crash AFTER the external environment open →
 *       the env-open key converges (the journal records the second
 *       open as a REPLAY — one external effect per key)
 *   C4  action-dispatch: crash AFTER the action insert → restart
 *       converges onto the same action (one row, one external effect)
 *   C5  action-dispatch: crash AFTER the external environment act (at
 *       the first durable write past the effect — the observation insert)
 *       → the environment journal's action entry is a REPLAY (exactly
 *       one external effect per stable action key)
 *
 *       (A throw FROM the environment seam itself is honestly absorbed
 *       by the service as a durable typed-failure record — fail-closed,
 *       never a fabricated success — so the durable-boundary death point
 *       that leaves the action `dispatching` is the observation insert.)
 *   C6  action-ledger: crash AFTER the canonical ledger intent commit
 *       → the retry converges onto the same action identity and the
 *       frozen ledger deduplicates the intent by key
 *   C7  escalation: crash AFTER the escalation insert → restart
 *       converges (one escalation row, the mode moves once)
 *   C8  termination: crash AFTER the terminal session mutation →
 *       restart converges (one terminal row, idempotent)
 *   C9  termination: crash AFTER the durable operation completion →
 *       the retry settles EXACTLY ONCE per key (no re-settle)
 *   C10 a completed operation from a dead process replays its
 *       OUTCOME, never re-runs the effect
 */

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  type ComputerUseActionRequest,
  type ComputerUseCapabilityDeclaration,
  type ComputerUseService,
  type ComputerUseSessionRequest,
  canonicalComputerUseJson,
  createComputerUseService,
  createExecutionLedgerAdapter,
} from "../../../src/modules/tools/public";
import {
  browserDeclaration,
  createInMemoryComputerUseWorld,
  desktopDeclaration,
} from "./computer-use-world";

const sha256Hex = (value: string): string =>
  createHash("sha256").update(value, "utf8").digest("hex");

/** The simulated process death (never a typed service error). */
class ProcessCrashError extends Error {
  constructor(point: string) {
    super(`simulated process crash at ${point}`);
    this.name = "ProcessCrashError";
  }
}

/** One armed durable-boundary crash point (per booted process). */
interface CrashPoint {
  readonly target: "store" | "ledger" | "environment";
  readonly method: string;
  readonly when: "before" | "after";
  /** Fire on the Nth invocation within THIS process (default 1). */
  readonly occurrence?: number;
}

function crashableSeam<T extends object>(target: T, label: string, point: CrashPoint | null) {
  let fired = false;
  if (point === null || point.target !== label) {
    return { proxy: target, crashed: () => fired };
  }
  const seen = new Map<string, number>();
  const proxy = new Proxy(target, {
    get(t, prop) {
      if (typeof prop !== "string") {
        return Reflect.get(t, prop, t);
      }
      const value = Reflect.get(t, prop, t);
      if (typeof value !== "function") {
        return value;
      }
      return (...args: unknown[]) => {
        const invocations = (seen.get(prop) ?? 0) + 1;
        seen.set(prop, invocations);
        const matches = prop === point.method && (point.occurrence ?? 1) === invocations;
        const die = (phase: "before" | "after") => {
          if (matches && point.when === phase) {
            fired = true;
            throw new ProcessCrashError(`${label}.${prop}#${invocations}:${phase}`);
          }
        };
        die("before");
        const result = (value as (...a: unknown[]) => unknown).apply(t, args);
        if (result instanceof Promise) {
          return result.then((resolved) => {
            die("after");
            return resolved;
          });
        }
        die("after");
        return result;
      };
    },
  });
  return { proxy, crashed: () => fired };
}

describe("computer-use crash-safety C-proofs (in-memory world)", () => {
  const scenario = async (): Promise<{
    readonly world: ReturnType<typeof createInMemoryComputerUseWorld>;
    readonly boot: (point?: CrashPoint | null) => {
      readonly service: ComputerUseService;
      readonly crashed: () => boolean;
    };
    readonly sessionRequest: (executionId: string) => ComputerUseSessionRequest;
    readonly uncertainRequest: (executionId: string) => ComputerUseSessionRequest;
    readonly apiCall: (target?: string) => ComputerUseActionRequest;
    readonly runningExecution: () => Promise<string>;
    readonly admittedSession: (key: string) => Promise<string>;
  }> => {
    const world = createInMemoryComputerUseWorld();
    const declarations: ComputerUseCapabilityDeclaration[] = [
      estimatedDeterministic({
        capabilityId: "computer-use-api-det",
        qualityConfidence: "verified",
      }),
      estimatedDeterministic({
        capabilityId: "computer-use-api-det-estimated",
        qualityConfidence: "estimated",
      }),
      browserDeclaration(),
      desktopDeclaration(),
    ];
    for (const declaration of declarations) {
      await world.register(declaration);
    }
    let idCounter = 90_000;
    const generateId = () => {
      idCounter += 1;
      return `00000000-0000-7000-8000-${String(idCounter).padStart(12, "0")}`;
    };
    const ledgerBase = createExecutionLedgerAdapter(world.executionService);
    const boot = (point: CrashPoint | null = null) => {
      const storeProcess = crashableSeam(world.store, "store", point);
      const ledgerProcess = crashableSeam(ledgerBase, "ledger", point);
      const environmentProcess = crashableSeam(world.environment, "environment", point);
      const service = createComputerUseService({
        registry: world.registry,
        policy: world.policy.impl,
        capabilities: world.capabilities.impl,
        secrets: world.secrets.impl,
        budgetAuthority: world.budgets.impl,
        store: storeProcess.proxy,
        ledger: ledgerProcess.proxy,
        environment: environmentProcess.proxy,
        terminal: world.terminal.impl,
        generateId,
        now: () => new Date(),
        digest: sha256Hex,
      });
      return {
        service,
        crashed: () =>
          storeProcess.crashed() || ledgerProcess.crashed() || environmentProcess.crashed(),
      };
    };
    const sessionRequest = (executionId: string): ComputerUseSessionRequest => ({
      applicationId: world.applicationId,
      executionId,
      actor: { actorId: world.actorId, tenantId: world.tenantId },
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
    });
    const uncertainRequest = (executionId: string): ComputerUseSessionRequest => ({
      ...sessionRequest(executionId),
      candidates: {
        deterministic: ["computer-use-api-det-estimated"],
        browser: "computer-use-browser-isolated",
        desktop: "computer-use-desktop-isolated",
      },
    });
    const apiCall = (target = "api.example.com/v1/data"): ComputerUseActionRequest => ({
      actionType: "api-call",
      target,
      input: {},
    });
    const runningExecution = () => world.seedExecution();
    const admittedSession = async (key: string) => {
      const executionId = await world.seedExecution();
      const receipt = await world.service.createSession(sessionRequest(executionId), key);
      return receipt.sessionId;
    };
    return {
      world,
      boot,
      sessionRequest,
      uncertainRequest,
      apiCall,
      runningExecution,
      admittedSession,
    };
  };

  const diesDuring = async (run: () => Promise<unknown>, crashed: () => boolean) => {
    await run().then(
      () => undefined,
      () => undefined,
    );
    expect(crashed()).toBe(true);
  };

  const nonReplayed = (entries: readonly { readonly replayed: boolean }[]) =>
    entries.filter((entry) => !entry.replayed);

  const replayed = (entries: readonly { readonly replayed: boolean }[]) =>
    entries.filter((entry) => entry.replayed);

  it("C1: session-create crash AFTER the durable operation claim → restart converges (one session, one open)", async () => {
    const s = await scenario();
    const executionId = await s.runningExecution();
    const dying = s.boot({ target: "store", method: "beginComputerUseOperation", when: "after" });
    await diesDuring(
      () => dying.service.createSession(s.sessionRequest(executionId), "c1-key"),
      dying.crashed,
    );
    // The claim survived; nothing else did (no session row yet).
    expect(await s.world.store.findSessionByKey(s.world.applicationId, "c1-key")).toBeNull();
    const live = s.boot();
    const receipt = await live.service.createSession(s.sessionRequest(executionId), "c1-key");
    expect(receipt.replayed).toBe(false);
    expect(receipt.status).toBe("active");
    expect(
      await s.world.store.listSessionsByExecution(s.world.applicationId, executionId),
    ).toHaveLength(1);
    // ONE external environment open effect.
    expect(
      nonReplayed(s.world.environment.activity().filter((e) => e.operation === "open")),
    ).toHaveLength(1);
  });

  it("C2: session-create crash AFTER the session insert → restart converges onto the SAME row", async () => {
    const s = await scenario();
    const executionId = await s.runningExecution();
    const dying = s.boot({ target: "store", method: "insertSession", when: "after" });
    await diesDuring(
      () => dying.service.createSession(s.sessionRequest(executionId), "c2-key"),
      dying.crashed,
    );
    const persisted = await s.world.store.findSessionByKey(s.world.applicationId, "c2-key");
    expect(persisted).not.toBeNull();
    const live = s.boot();
    const receipt = await live.service.createSession(s.sessionRequest(executionId), "c2-key");
    expect(receipt.sessionId).toBe(persisted?.id);
    expect(receipt.status).toBe("active");
    expect(
      await s.world.store.listSessionsByExecution(s.world.applicationId, executionId),
    ).toHaveLength(1);
  });

  it("C3: session-create crash AFTER the external environment open → the env-open key converges", async () => {
    const s = await scenario();
    const executionId = await s.runningExecution();
    const dying = s.boot({ target: "environment", method: "open", when: "after" });
    await diesDuring(
      () => dying.service.createSession(s.sessionRequest(executionId), "c3-key"),
      dying.crashed,
    );
    const live = s.boot();
    const receipt = await live.service.createSession(s.sessionRequest(executionId), "c3-key");
    expect(receipt.status).toBe("active");
    expect(receipt.environmentRef).not.toBeNull();
    expect(
      await s.world.store.listSessionsByExecution(s.world.applicationId, executionId),
    ).toHaveLength(1);
    const opens = s.world.environment.activity().filter((e) => e.operation === "open");
    expect(nonReplayed(opens)).toHaveLength(1);
    expect(replayed(opens)).toHaveLength(1);
  });

  it("C4: action-dispatch crash AFTER the action insert → restart converges onto the same action", async () => {
    const s = await scenario();
    const sessionId = await s.admittedSession("c4-session");
    const dying = s.boot({ target: "store", method: "insertAction", when: "after" });
    await diesDuring(
      () => dying.service.dispatchAction(s.world.applicationId, sessionId, s.apiCall(), "c4-key"),
      dying.crashed,
    );
    const persisted = await s.world.store.findActionByKey(
      s.world.applicationId,
      sessionId,
      "c4-key",
    );
    expect(persisted).not.toBeNull();
    expect(persisted?.status).toBe("dispatching");
    const live = s.boot();
    const result = await live.service.dispatchAction(
      s.world.applicationId,
      sessionId,
      s.apiCall(),
      "c4-key",
    );
    expect(result.status).toBe("succeeded");
    expect(result.actionId).toBe(persisted?.id);
    expect(await s.world.store.listActions(s.world.applicationId, sessionId)).toHaveLength(1);
    expect(
      nonReplayed(s.world.environment.activity().filter((e) => e.operation === "action")),
    ).toHaveLength(1);
  });

  it("C5: action-dispatch crash AFTER the external environment act → the journal's action entry is a REPLAY", async () => {
    const s = await scenario();
    const sessionId = await s.admittedSession("c5-session");
    // The durable-boundary death point past the external effect: the
    // first durable write the live process would make (the observation
    // insert). The action row stays `dispatching`; the effect already
    // happened; the retry must converge onto BOTH.
    const dying = s.boot({ target: "store", method: "insertObservation", when: "before" });
    await diesDuring(
      () => dying.service.dispatchAction(s.world.applicationId, sessionId, s.apiCall(), "c5-key"),
      dying.crashed,
    );
    const persisted = await s.world.store.findActionByKey(
      s.world.applicationId,
      sessionId,
      "c5-key",
    );
    expect(persisted?.status).toBe("dispatching");
    const live = s.boot();
    const result = await live.service.dispatchAction(
      s.world.applicationId,
      sessionId,
      s.apiCall(),
      "c5-key",
    );
    expect(result.status).toBe("succeeded");
    expect(await s.world.store.listActions(s.world.applicationId, sessionId)).toHaveLength(1);
    const acts = s.world.environment.activity().filter((e) => e.operation === "action");
    expect(nonReplayed(acts)).toHaveLength(1);
    expect(replayed(acts)).toHaveLength(1);
  });

  it("C6: action-ledger crash AFTER the canonical ledger intent commit → the retry converges onto the same action identity", async () => {
    const s = await scenario();
    const sessionId = await s.admittedSession("c6-session");
    const dying = s.boot({ target: "ledger", method: "recordStepEvent", when: "after" });
    await diesDuring(
      () => dying.service.dispatchAction(s.world.applicationId, sessionId, s.apiCall(), "c6-key"),
      dying.crashed,
    );
    const live = s.boot();
    const result = await live.service.dispatchAction(
      s.world.applicationId,
      sessionId,
      s.apiCall(),
      "c6-key",
    );
    expect(result.status).toBe("succeeded");
    // One action row; the frozen ledger deduplicated the retried intent
    // by its stable key (the binding is write-once).
    const actions = await s.world.store.listActions(s.world.applicationId, sessionId);
    expect(actions).toHaveLength(1);
    expect(actions[0]?.ledgerRequestedSequence).not.toBeNull();
    // The ledger intent event for THIS action exists exactly once.
    const trajectory = await live.service.getTrajectory(s.world.applicationId, sessionId);
    expect(trajectory).not.toBeNull();
    const ledgerActions = trajectory?.entries.filter(
      (entry) => entry.kind === "action" && entry.actionId === result.actionId,
    );
    expect(ledgerActions).toHaveLength(1);
  });

  it("C7: escalation crash AFTER the escalation insert → restart converges (one row, one mode move)", async () => {
    const s = await scenario();
    const executionId = await s.runningExecution();
    const live = s.boot();
    const receipt = await live.service.createSession(s.uncertainRequest(executionId), "c7-session");
    expect(receipt.mode).toBe("deterministic");
    s.world.environment.injectNextActionFailure();
    const failed = await live.service.dispatchAction(
      s.world.applicationId,
      receipt.sessionId,
      s.apiCall(),
      "c7-failed-action",
    );
    expect(failed.status).toBe("failed");
    const actions = await s.world.store.listActions(s.world.applicationId, receipt.sessionId);
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
    const insufficiency = {
      stage: "deterministic" as const,
      reasonCode: "action-failed",
      reasonDetail: "the deterministic API call failed in the environment",
      failedActionId: failed.actionId,
      evidenceDigest: digest,
    };
    const dying = s.boot({ target: "store", method: "insertEscalation", when: "after" });
    await diesDuring(
      () =>
        dying.service.escalate(
          s.world.applicationId,
          receipt.sessionId,
          { targetMode: "browser", insufficiency },
          "c7-esc",
        ),
      dying.crashed,
    );
    const restarted = s.boot();
    const escalated = await restarted.service.escalate(
      s.world.applicationId,
      receipt.sessionId,
      { targetMode: "browser", insufficiency },
      "c7-esc",
    );
    expect(escalated.replayed).toBe(true);
    expect(escalated.mode).toBe("browser");
    expect(
      await s.world.store.listEscalations(s.world.applicationId, receipt.sessionId),
    ).toHaveLength(1);
    const session = await restarted.service.getSession(s.world.applicationId, receipt.sessionId);
    expect(session?.currentMode).toBe("browser");
    expect(session?.escalationCount).toBe(1);
  });

  it("C8: termination crash AFTER the terminal session mutation → restart converges (idempotent)", async () => {
    const s = await scenario();
    const sessionId = await s.admittedSession("c8-session");
    const dying = s.boot({
      target: "store",
      method: "applyGuardedSessionMutation",
      when: "after",
    });
    await diesDuring(
      () => dying.service.terminate(s.world.applicationId, sessionId, "completed", "c8-term"),
      dying.crashed,
    );
    const persisted = await s.world.store.findSession(s.world.applicationId, sessionId);
    expect(persisted?.status).toBe("completed");
    const live = s.boot();
    const receipt = await live.service.terminate(
      s.world.applicationId,
      sessionId,
      "completed",
      "c8-term",
    );
    expect(receipt.replayed).toBe(true);
    expect(receipt.status).toBe("completed");
    expect(await s.world.store.findSession(s.world.applicationId, sessionId)).toMatchObject({
      status: "completed",
      terminalCause: "completed",
    });
  });

  it("C9: termination crash AFTER the durable operation completion → the retry settles EXACTLY ONCE per key", async () => {
    const s = await scenario();
    const sessionId = await s.admittedSession("c9-session");
    const live = s.boot();
    await live.service.dispatchAction(s.world.applicationId, sessionId, s.apiCall(), "c9-action");
    const dying = s.boot({ target: "store", method: "completeOperation", when: "after" });
    await diesDuring(
      () => dying.service.terminate(s.world.applicationId, sessionId, "completed", "c9-term"),
      dying.crashed,
    );
    const settledBefore = s.world.budgets.settleCalls.length;
    const restarted = s.boot();
    const receipt = await restarted.service.terminate(
      s.world.applicationId,
      sessionId,
      "completed",
      "c9-term",
    );
    expect(receipt.replayed).toBe(true);
    // The replayed terminal receipt settles NOTHING new: the settle is
    // exactly-once per stable key (the fake authority records every
    // reserve/settle call — the count is the proof).
    expect(s.world.budgets.settleCalls.length).toBe(settledBefore);
  });

  it("C10: a completed operation from a dead process replays its OUTCOME, never re-runs the effect", async () => {
    const s = await scenario();
    const executionId = await s.runningExecution();
    const first = s.boot();
    const receipt = await first.service.createSession(s.sessionRequest(executionId), "c10-key");
    expect(receipt.replayed).toBe(false);
    const opensAfterFirst = nonReplayed(
      s.world.environment.activity().filter((e) => e.operation === "open"),
    ).length;
    // A SECOND process (a restart after success) replays: same session,
    // same environment reference, ZERO new external effects.
    const second = s.boot();
    const replay = await second.service.createSession(s.sessionRequest(executionId), "c10-key");
    expect(replay.replayed).toBe(true);
    expect(replay.sessionId).toBe(receipt.sessionId);
    expect(
      nonReplayed(s.world.environment.activity().filter((e) => e.operation === "open")).length,
    ).toBe(opensAfterFirst);
  });
});

/** The estimated-confidence deterministic variant (escalation setups). */
function estimatedDeterministic(overrides: {
  readonly capabilityId: string;
  readonly qualityConfidence?: "estimated" | "verified";
}): ComputerUseCapabilityDeclaration {
  return {
    capabilityId: overrides.capabilityId,
    kind: "deterministic" as const,
    description: "deterministic API capability",
    capabilityAtom: "computer-use-deterministic",
    covers: ["atom-a", "atom-b"],
    deterministicQuality: 0.95,
    qualityConfidence: overrides.qualityConfidence ?? ("verified" as const),
    estimatedMicroUsd: "10",
    hosts: ["api.example.com"],
    secretRef: null,
    desktopEnvelope: null,
    terminalPolicy: null,
    browserProfile: null,
  };
}
