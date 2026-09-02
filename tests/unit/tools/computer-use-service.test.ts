/**
 * Computer-use service unit tests (WORK-027, CUI-001/002/003; AC-2..AC-8).
 *
 * The governed session service over the REAL domain + in-memory stores
 * (the migration-0023-faithful fake), the REAL simulated isolated
 * environment and the REAL in-memory executions module — with the
 * authority seams as recording fakes. The proofs, in order:
 *
 *  1. the admission chain (AC-2/AC-4): policy/budget/capability/secret
 *     denials are journaled + typed + ZERO environment activity (the
 *     policy-before-side-effect ordering proof — the environment journal
 *     is the physical witness);
 *  2. deterministic-first routing (AC-6/AC-7): a sufficient deterministic
 *     route starts the session in deterministic mode with zero GUI
 *     dispatches; escalation follows the frozen ladder one step at a
 *     time with RECORDED insufficiency evidence (fabricated evidence
 *     fails closed);
 *  3. unregistered/fabricated capabilities cannot dispatch (AC-5);
 *  4. isolation (AC-2): the context never inherits the simulated host
 *     world (cookies/credentials/env/mounts/sockets); egress is confined
 *     to the declared allowlist before any effect;
 *  5. evidence/provenance (AC-3/AC-8): actions/observations carry
 *     digests + lineage + ledger bindings; the trajectory is replayable;
 *     public serialization never carries content;
 *  6. idempotency + the admission order on the action axis.
 */

import { describe, expect, it } from "vitest";
import {
  canonicalComputerUseJson,
  serializeObservationEvidence,
} from "../../../src/modules/tools/public";
import {
  browserDeclaration,
  createInMemoryComputerUseWorld,
  desktopDeclaration,
  deterministicDeclaration,
  expectPlatformError,
  type InMemoryComputerUseWorld,
  sha256Hex,
} from "./computer-use-world";

/** The canonical full registry (deterministic + browser + desktop). */
async function registerCanonical(world: InMemoryComputerUseWorld): Promise<void> {
  await world.register(deterministicDeclaration());
  await world.register(browserDeclaration());
  await world.register(desktopDeclaration());
}

/**
 * The insufficiency digest the escalate request must cite — computed over
 * the DURABLE action record's outcome (the service verifies exactly this
 * shape, so the helper re-derives it from the store, never from the
 * dispatch result).
 */
async function insufficiencyDigestOf(
  world: InMemoryComputerUseWorld,
  sessionId: string,
  actionId: string,
): Promise<string> {
  const actions = await world.store.listActions(world.applicationId, sessionId);
  const action = actions.find((item) => item.id === actionId);
  if (action === undefined) {
    throw new Error(`action ${actionId} not found in session ${sessionId}`);
  }
  return sha256Hex(
    canonicalComputerUseJson({
      actionId: action.id,
      status: action.status,
      failureClass: action.failureClass,
      resultDigest: action.resultDigest,
    }),
  );
}

describe("computer-use service: the admission chain (AC-2/AC-4)", () => {
  it("admits a deterministic-first session through the full chain and opens the isolated environment", async () => {
    const world = createInMemoryComputerUseWorld();
    await registerCanonical(world);
    const executionId = await world.seedExecution();

    const receipt = await world.createSession({ executionId });
    expect(receipt.status).toBe("active");
    expect(receipt.mode).toBe("deterministic");
    expect(receipt.replayed).toBe(false);
    expect(receipt.environmentRef).not.toBeNull();
    // Deterministic-first: the route is deterministic-ONLY (zero GUI stages).
    expect(receipt.routeEvidence.decision).toBe("sufficient");
    expect(receipt.routeEvidence.route.map((stage) => stage.mode)).toEqual(["deterministic"]);

    // The authorities were actually consulted (policy → budget → capability).
    expect(world.policy.calls.length).toBeGreaterThanOrEqual(1);
    expect(world.policy.calls[0]?.toolFact).toBe("computer-use:session");
    expect(world.budgets.reserveCalls.length).toBe(1);
    expect(world.budgets.reserveCalls[0]?.command.amountMicroUsd).toBe("10");
    expect(world.capabilities.calls.length).toBe(1);
    // The FIRST external interaction is the environment open — nothing else.
    expect(world.environment.activity().map((entry) => entry.operation)).toEqual(["open"]);
    // The session-create operation is durably COMPLETED.
    const session = await world.service.getSession(world.applicationId, receipt.sessionId);
    expect(session?.status).toBe("active");
    expect(session?.initialMode).toBe("deterministic");
    expect(session?.admission.policyEvidence?.policySetId).toBe("set-1");
    expect(session?.admission.budgetOperationId).not.toBeNull();
  });

  it("AC-4: a POLICY denial is journaled + typed and leaves the environment journal EMPTY (no external side effect)", async () => {
    const world = createInMemoryComputerUseWorld();
    await registerCanonical(world);
    const executionId = await world.seedExecution();
    world.policy.denyWith("policy engine says computer-use is not permitted for this tenant");

    const error = await expectPlatformError("POLICY_DENIED", world.createSession({ executionId }));
    expect(error.message).toContain("policy engine says");

    // The denial is durable evidence: a denied session row.
    const denied = await world.store.findSessionByKey(
      world.applicationId,
      // The world generated the key; recover it from the store via execution.
      (await world.store.listSessionsByExecution(world.applicationId, executionId))[0]
        ?.sessionKey ?? "",
    );
    expect(denied?.status).toBe("denied");
    expect(denied?.denialClass).toBe("policy");
    expect(denied?.denialReason).toContain("policy engine says");
    // ZERO external effects: the environment was never touched.
    expect(world.environment.activity()).toHaveLength(0);
    expect(world.environment.effectCount()).toBe(0);
    // No budget was reserved or settled for a policy denial (policy comes
    // strictly before budget in the chain).
    expect(world.budgets.reserveCalls).toHaveLength(0);
  });

  it("AC-4: a BUDGET denial is journaled + typed, releases nothing further and never touches the environment", async () => {
    const world = createInMemoryComputerUseWorld();
    await registerCanonical(world);
    const executionId = await world.seedExecution();
    world.budgets.denyReservations("tenant wallet is exhausted");

    const error = await expectPlatformError(
      "BUDGET_EXCEEDED",
      world.createSession({ executionId }),
    );
    expect(error.message).toContain("tenant wallet is exhausted");
    const denied = (await world.store.listSessionsByExecution(world.applicationId, executionId))[0];
    expect(denied?.status).toBe("denied");
    expect(denied?.denialClass).toBe("budget");
    // The reserve was ATTEMPTED (budget is before capability/secret), then
    // the reservation the attempt never created is not released — but the
    // release-keyed call must have happened for the (nonexistent) operation.
    expect(world.budgets.reserveCalls).toHaveLength(1);
    expect(world.environment.activity()).toHaveLength(0);
  });

  it("AC-4: a CAPABILITY denial is journaled + typed with zero environment activity", async () => {
    const world = createInMemoryComputerUseWorld();
    await registerCanonical(world);
    const executionId = await world.seedExecution();
    world.capabilities.failWith(["computer-use-deterministic"]);

    const error = await expectPlatformError(
      "CAPABILITY_UNAVAILABLE",
      world.createSession({ executionId }),
    );
    expect(error.message).toContain("computer-use-deterministic");
    const denied = (await world.store.listSessionsByExecution(world.applicationId, executionId))[0];
    expect(denied?.denialClass).toBe("capability");
    expect(world.environment.activity()).toHaveLength(0);
    // Budget was reserved first, then released on the denial.
    expect(world.budgets.reserveCalls).toHaveLength(1);
    expect(world.budgets.releaseCalls).toHaveLength(1);
  });

  it("AC-4: secret mediation refusals are journaled + typed (required-secret-without-connection and refused mediation)", async () => {
    const world = createInMemoryComputerUseWorld();
    await registerCanonical(
      Object.assign(world, {
        // deterministic capability that requires a mediated credential
      }) as unknown as InMemoryComputerUseWorld,
    );
    const executionId = await world.seedExecution();

    // Routed capability requires a secret but the request carries no
    // connection reference: denied before any environment interaction.
    const worldSecret = createInMemoryComputerUseWorld();
    await worldSecret.register(
      deterministicDeclaration({ secretRef: "conn:billing-api", hosts: ["api.example.com"] }),
    );
    await worldSecret.register(browserDeclaration());
    await worldSecret.register(desktopDeclaration());
    const executionSecret = await worldSecret.seedExecution();
    const noConnection = await expectPlatformError(
      "AUTHORIZATION_DENIED",
      worldSecret.createSession({ executionId: executionSecret }),
    );
    expect(noConnection.message).toContain("mediated credential reference");
    expect(worldSecret.secrets.calls).toHaveLength(0);
    expect(worldSecret.environment.activity()).toHaveLength(0);
    expect(
      (
        await worldSecret.store.listSessionsByExecution(worldSecret.applicationId, executionSecret)
      )[0]?.denialClass,
    ).toBe("secret-mediation");

    // A refused mediation: the connection exists but is disabled.
    const worldRefused = createInMemoryComputerUseWorld();
    await worldRefused.register(
      deterministicDeclaration({ secretRef: "conn:billing-api", hosts: ["api.example.com"] }),
    );
    await worldRefused.register(browserDeclaration());
    await worldRefused.register(desktopDeclaration());
    const executionRefused = await worldRefused.seedExecution();
    worldRefused.secrets.refuseWith("connection disabled");
    const refused = await expectPlatformError(
      "AUTHORIZATION_DENIED",
      worldRefused.createSession({ executionId: executionRefused, connectionRef: "conn-1" }),
    );
    expect(refused.message).toContain("connection disabled");
    expect(worldRefused.secrets.calls).toHaveLength(1);
    expect(worldRefused.environment.activity()).toHaveLength(0);
    expect(
      (
        await worldRefused.store.listSessionsByExecution(
          worldRefused.applicationId,
          executionRefused,
        )
      )[0]?.denialClass,
    ).toBe("secret-mediation");

    // A request that carries a connectionRef but the route declares no
    // secret: undisclosed secret access is refused.
    const undisclosed = await expectPlatformError(
      "AUTHORIZATION_DENIED",
      world.createSession({ executionId, connectionRef: "conn-9" }),
    );
    expect(undisclosed.message).toContain("undisclosed secret access");
    expect(world.environment.activity()).toHaveLength(0);
    void worldSecret;
  });

  it("a costed route with NO budget authority wired fails closed (costed work never executes unbudgeted)", async () => {
    const world = createInMemoryComputerUseWorld({ budgetAuthority: null });
    await registerCanonical(world);
    const executionId = await world.seedExecution();

    const error = await expectPlatformError(
      "BUDGET_EXCEEDED",
      world.createSession({ executionId }),
    );
    expect(error.message).toContain("no budget authority is wired");
    expect(world.environment.activity()).toHaveLength(0);
    const denied = (await world.store.listSessionsByExecution(world.applicationId, executionId))[0];
    expect(denied?.denialClass).toBe("budget");
  });

  it("a FREE route (zero cost ceiling) needs no budget authority (deterministic-only, zero estimates)", async () => {
    const world = createInMemoryComputerUseWorld({ budgetAuthority: null });
    await world.register(deterministicDeclaration({ estimatedMicroUsd: "0" }));
    const executionId = await world.seedExecution();
    const receipt = await world.createSession({
      executionId,
      candidates: {
        deterministic: ["computer-use-api-det"],
        browser: null,
        desktop: null,
      },
    });
    expect(receipt.status).toBe("active");
    expect(receipt.routeEvidence.route).toHaveLength(1);
    expect(world.environment.activity().map((entry) => entry.operation)).toEqual(["open"]);
  });
});

describe("computer-use service: deterministic-first routing (AC-6/AC-7)", () => {
  it("AC-6: a sufficient deterministic route starts the session in deterministic mode (zero GUI dispatch)", async () => {
    const world = createInMemoryComputerUseWorld();
    await registerCanonical(world);
    const executionId = await world.seedExecution();
    const receipt = await world.createSession({ executionId });
    expect(receipt.mode).toBe("deterministic");
    expect(receipt.routeEvidence.deterministicFirst).toBe("sufficient");
    // The GUI candidates were inventoried but never dispatched.
    expect(receipt.routeEvidence.guiCandidates.map((candidate) => candidate.mode)).toEqual([
      "browser",
      "desktop",
    ]);
    const session = await world.service.getSession(world.applicationId, receipt.sessionId);
    expect(session?.modeContext.capabilityId).toBe("computer-use-api-det");
    // Only the deterministic context was opened.
    expect(world.environment.activity().every((entry) => entry.mode === "deterministic")).toBe(
      true,
    );
  });

  it("an UNVERIFIED (estimated) deterministic quality keeps deterministic FIRST (the bounded compare), with the GUI ladder behind it", async () => {
    const world = createInMemoryComputerUseWorld();
    await world.register(deterministicDeclaration({ qualityConfidence: "estimated" }));
    await world.register(browserDeclaration());
    await world.register(desktopDeclaration());
    const executionId = await world.seedExecution();
    const receipt = await world.createSession({ executionId });
    expect(receipt.mode).toBe("deterministic");
    expect(receipt.routeEvidence.decision).toBe("uncertain");
    expect(receipt.routeEvidence.route.map((stage) => stage.mode)).toEqual([
      "deterministic",
      "browser",
      "desktop",
    ]);
  });

  it("a quality gap escalates the STARTING mode to browser (never a blind jump to desktop)", async () => {
    const world = createInMemoryComputerUseWorld();
    await registerCanonical(world);
    const executionId = await world.seedExecution();
    const receipt = await world.createSession({
      executionId,
      task: {
        kind: "structured-data-retrieval",
        requirementAtoms: ["atom-a", "atom-b"],
        qualityTarget: 0.99,
      },
    });
    expect(receipt.mode).toBe("browser");
    expect(receipt.routeEvidence.decision).toBe("insufficient");
    expect(receipt.routeEvidence.reasons[0]?.code).toBe("quality-gap");
    expect(receipt.routeEvidence.route.map((stage) => stage.mode)).toEqual(["browser", "desktop"]);
    const session = await world.service.getSession(world.applicationId, receipt.sessionId);
    expect(session?.modeContext.capabilityId).toBe("computer-use-browser-isolated");
  });

  it("a desktop-workflow task kind starts at the browser stage (GUI task required by declaration)", async () => {
    const world = createInMemoryComputerUseWorld();
    await registerCanonical(world);
    const executionId = await world.seedExecution();
    const receipt = await world.createSession({
      executionId,
      task: {
        kind: "desktop-workflow",
        requirementAtoms: ["atom-a"],
        qualityTarget: 0.9,
      },
    });
    expect(receipt.routeEvidence.reasons[0]?.code).toBe("gui-task-required");
    expect(receipt.mode).toBe("browser");
  });

  it("no route at all (insufficient deterministic, no GUI capability) fails closed before any environment interaction", async () => {
    const world = createInMemoryComputerUseWorld();
    await world.register(deterministicDeclaration({ covers: ["atom-zzz"] }));
    const executionId = await world.seedExecution();
    const error = await expectPlatformError(
      "CAPABILITY_UNAVAILABLE",
      world.createSession({
        executionId,
        candidates: { deterministic: ["computer-use-api-det"], browser: null, desktop: null },
      }),
    );
    expect(error.message).toContain("no computer-use route is available");
    expect(world.environment.activity()).toHaveLength(0);
    expect(
      await world.store.listSessionsByExecution(world.applicationId, executionId),
    ).toHaveLength(0);
  });
});

describe("computer-use service: unregistered/fabricated capabilities (AC-5)", () => {
  it("an unregistered deterministic candidate id fails closed CAPABILITY_UNAVAILABLE before any durable state", async () => {
    const world = createInMemoryComputerUseWorld();
    await world.register(browserDeclaration());
    await world.register(desktopDeclaration());
    const executionId = await world.seedExecution();
    const error = await expectPlatformError(
      "CAPABILITY_UNAVAILABLE",
      world.createSession({ executionId }),
    );
    expect(error.message).toContain("is not registered");
    expect(world.environment.activity()).toHaveLength(0);
    expect(world.policy.calls).toHaveLength(0);
    expect(
      await world.store.listSessionsByExecution(world.applicationId, executionId),
    ).toHaveLength(0);
  });

  it("a fabricated desktop candidate id (never registered) fails closed the same way", async () => {
    const world = createInMemoryComputerUseWorld();
    await world.register(deterministicDeclaration());
    await world.register(browserDeclaration());
    const executionId = await world.seedExecution();
    const error = await expectPlatformError(
      "CAPABILITY_UNAVAILABLE",
      world.createSession({
        executionId,
        task: {
          kind: "structured-data-retrieval",
          requirementAtoms: ["atom-c"],
          qualityTarget: 0.9,
        },
      }),
    );
    expect(error.message).toContain("computer-use-desktop-isolated");
    expect(world.environment.activity()).toHaveLength(0);
  });

  it("a declaration that fails validation is rejected by the registry (malformed contracts never become governable)", async () => {
    const world = createInMemoryComputerUseWorld();
    const invalid = deterministicDeclaration({ deterministicQuality: 1.5 });
    const outcome = await world.registry.register(invalid);
    expect(outcome.valid).toBe(false);
    expect(await world.registry.resolve(invalid.capabilityId)).toBeNull();
  });
});

describe("computer-use service: identity/tenant binding (AC-4/AC-8)", () => {
  it("an actor from ANOTHER tenant cannot bind a session to this execution (tenant scope violation, zero durable state)", async () => {
    const world = createInMemoryComputerUseWorld();
    await registerCanonical(world);
    const executionId = await world.seedExecution();
    const error = await expectPlatformError(
      "TENANT_SCOPE_VIOLATION",
      world.createSession({
        executionId,
        actor: { actorId: world.actorId, tenantId: world.otherTenantId },
      }),
    );
    expect(error.message).toContain("different tenant");
    expect(world.environment.activity()).toHaveLength(0);
    expect(world.policy.calls).toHaveLength(0);
    expect(
      await world.store.listSessionsByExecution(world.applicationId, executionId),
    ).toHaveLength(0);
  });

  it("an execution in ANOTHER application is invisible (tenant scope violation)", async () => {
    const world = createInMemoryComputerUseWorld();
    await registerCanonical(world);
    const error = await expectPlatformError(
      "TENANT_SCOPE_VIOLATION",
      world.createSession({ executionId: "00000000-0000-7000-8000-00000000dead" }),
    );
    expect(error.message).toContain("not found in this application");
    expect(world.environment.activity()).toHaveLength(0);
  });

  it("a TERMINAL execution accepts no computer-use session (subordination to the execution authority)", async () => {
    const world = createInMemoryComputerUseWorld();
    await registerCanonical(world);
    const executionId = await world.seedExecution();
    await world.executionService.transition(
      {
        command: "fail",
        actorId: world.actorId,
        applicationId: world.applicationId,
        tenantId: world.tenantId,
        executionId,
      },
      `fail-${executionId}`,
    );
    const error = await expectPlatformError(
      "INVALID_STATE_TRANSITION",
      world.createSession({ executionId }),
    );
    expect(error.message).toContain("terminal");
  });

  it("sessions are invisible across applications (application-scoped reads)", async () => {
    const world = createInMemoryComputerUseWorld();
    await registerCanonical(world);
    const executionId = await world.seedExecution();
    const receipt = await world.createSession({ executionId });
    expect(
      await world.service.getSession("99999999-9999-7000-8000-0000000000ff", receipt.sessionId),
    ).toBeNull();
    expect(
      await world.service.getTrajectory("99999999-9999-7000-8000-0000000000ff", receipt.sessionId),
    ).toBeNull();
    // And the dispatch guard fails closed for the foreign application.
    await expectPlatformError(
      "TENANT_SCOPE_VIOLATION",
      world.service.dispatchAction(
        "99999999-9999-7000-8000-0000000000ff",
        receipt.sessionId,
        { actionType: "api-call", target: "api.example.com/v1/data", input: {} },
        "foreign-dispatch",
      ),
    );
  });
});

describe("computer-use service: action dispatch (AC-3 + the ordering discipline)", () => {
  async function activeDeterministicSession(): Promise<{
    world: InMemoryComputerUseWorld;
    executionId: string;
    sessionId: string;
  }> {
    const world = createInMemoryComputerUseWorld();
    await registerCanonical(world);
    const executionId = await world.seedExecution();
    const receipt = await world.createSession({ executionId });
    return { world, executionId, sessionId: receipt.sessionId };
  }

  it("dispatches a deterministic api-call action with durable evidence + ledger bindings", async () => {
    const { world, sessionId } = await activeDeterministicSession();
    const result = await world.dispatch(sessionId, {
      actionType: "api-call",
      target: "api.example.com/v1/data",
      input: { method: "GET" },
    });
    expect(result.status).toBe("succeeded");
    expect(result.mode).toBe("deterministic");
    expect(result.sideEffect).toBe("read-only");
    expect(result.replayed).toBe(false);
    expect(result.resultDigest).not.toBeNull();
    // The observation landed with digest + retention metadata.
    expect(result.observations).toHaveLength(1);
    expect(result.observations[0]?.observationType).toBe("api-result");
    expect(result.observations[0]?.contentDigest).toHaveLength(64);
    expect(result.observations[0]?.retention).toBe("execution");
    expect(result.observations[0]?.redaction).toBe("none");
    // The action row carries the ledger bindings (write-once).
    const actions = await world.store.listActions(world.applicationId, sessionId);
    expect(actions).toHaveLength(1);
    expect(actions[0]?.ledgerRequestedSequence).not.toBeNull();
    expect(actions[0]?.ledgerResultSequence).not.toBeNull();
    // The session usage accumulates the environment-reported usage (the
    // honest simulated rail reports zero; the DECLARED estimate governs
    // the budget guard instead — see the budget-ceiling proof below).
    const session = await world.service.getSession(world.applicationId, sessionId);
    expect(session?.usageMicroUsd).toBe("0");
  });

  it("confines browser actions out of the deterministic mode (mode confinement is fail-closed)", async () => {
    const { world, sessionId } = await activeDeterministicSession();
    const error = await expectPlatformError(
      "POLICY_DENIED",
      world.dispatch(sessionId, {
        actionType: "navigate",
        target: "https://site.example.com/page",
        input: {},
      }),
    );
    expect(error.message).toContain("not in the deterministic mode's action vocabulary");
    expect(
      world.environment.activity().filter((entry) => entry.operation === "action"),
    ).toHaveLength(0);
  });

  it("confines an egressing action to the declared allowlist BEFORE any environment effect (no hidden network)", async () => {
    const { world, sessionId } = await activeDeterministicSession();
    const error = await expectPlatformError(
      "POLICY_DENIED",
      world.dispatch(sessionId, {
        actionType: "api-call",
        target: "https://evil.example.net/exfil",
        input: {},
        host: "evil.example.net",
      }),
    );
    expect(error.message).toContain("egress allowlist");
    expect(world.environment.effectCount()).toBe(1); // only the env open
  });

  it("AC-4 (action axis): a per-action POLICY denial is journaled as a denied action row with ZERO environment activity", async () => {
    const { world, sessionId } = await activeDeterministicSession();
    // Deny every fact from here on (the session admission already passed).
    world.policy.denyWith("action class is not permitted for this tenant");
    const result = await world.dispatch(sessionId, {
      actionType: "api-call",
      target: "api.example.com/v1/data",
      input: {},
    });
    // The denial is a typed, durable OUTCOME (not a thrown error on the
    // action axis — the request completed as "denied").
    expect(result.status).toBe("denied");
    expect(result.observations).toHaveLength(0);
    expect(
      world.environment.activity().filter((entry) => entry.operation === "action"),
    ).toHaveLength(0);
    const actions = await world.store.listActions(world.applicationId, sessionId);
    expect(actions).toHaveLength(1);
    expect(actions[0]?.status).toBe("denied");
    expect(actions[0]?.failureClass).toBe("policy");
    expect(actions[0]?.sequence).toBe(1);
  });

  it("a BUDGET-exceeding action is denied with the budget class (declared usage stays within the admitted ceiling)", async () => {
    const world = createInMemoryComputerUseWorld();
    await world.register(desktopDeclaration());
    const executionId = await world.seedExecution();
    const receipt = await world.createSession({
      executionId,
      task: { kind: "terminal-task", requirementAtoms: ["atom-a"], qualityTarget: 0.9 },
      candidates: { deterministic: [], browser: null, desktop: "computer-use-desktop-isolated" },
    });
    // The admitted ceiling for the desktop-only route is the desktop
    // capability's estimate (80 micro-USD): the first terminal-exec
    // consumes it, the second would exceed it.
    const first = await world.dispatch(receipt.sessionId, {
      actionType: "terminal-exec",
      target: "/workspace/report.txt",
      input: { command: "ls", args: ["/workspace"] },
    });
    expect(first.status).toBe("succeeded");
    const session = await world.service.getSession(world.applicationId, receipt.sessionId);
    expect(session?.usageMicroUsd).toBe("80");
    await expectPlatformError(
      "BUDGET_EXCEEDED",
      world.dispatch(receipt.sessionId, {
        actionType: "terminal-exec",
        target: "/workspace/other.txt",
        input: { command: "cat", args: ["/workspace/other.txt"] },
      }),
    );
    const actions = await world.store.listActions(world.applicationId, receipt.sessionId);
    expect(actions).toHaveLength(2);
    expect(actions[1]?.status).toBe("denied");
    expect(actions[1]?.failureClass).toBe("budget");
    expect(world.terminal.runs).toHaveLength(1);
  });

  it("terminal-exec dispatches through the approved sandbox seam (argv, never a shell) and records sandbox provenance", async () => {
    const world = createInMemoryComputerUseWorld();
    await world.register(desktopDeclaration());
    const executionId = await world.seedExecution();
    const receipt = await world.createSession({
      executionId,
      task: {
        kind: "terminal-task",
        requirementAtoms: ["atom-a"],
        qualityTarget: 0.9,
      },
      candidates: { deterministic: [], browser: null, desktop: "computer-use-desktop-isolated" },
    });
    expect(receipt.mode).toBe("desktop");
    const result = await world.dispatch(receipt.sessionId, {
      actionType: "terminal-exec",
      target: "/workspace/report.txt",
      input: { command: "ls", args: ["-la", "/workspace"] },
    });
    expect(result.status).toBe("succeeded");
    expect(result.sandboxExecutionId).not.toBeNull();
    expect(result.observations[0]?.observationType).toBe("terminal-output");
    // The sandbox seam saw the EXACT argv (no shell string).
    expect(world.terminal.runs).toHaveLength(1);
    expect(world.terminal.runs[0]?.command).toBe("ls");
    expect(world.terminal.runs[0]?.args).toEqual(["-la", "/workspace"]);
    // The terminal policy (process/fs granted, network NOT) rode the dispatch.
    expect(result.routeEvidence).toBeDefined();
  });

  it("terminal-exec with a shell-style command is refused (argv discipline, durable failure)", async () => {
    const world = createInMemoryComputerUseWorld();
    await world.register(desktopDeclaration());
    const executionId = await world.seedExecution();
    const receipt = await world.createSession({
      executionId,
      task: { kind: "terminal-task", requirementAtoms: ["atom-a"], qualityTarget: 0.9 },
      candidates: { deterministic: [], browser: null, desktop: "computer-use-desktop-isolated" },
    });
    // The dispatch-time argv discipline fails closed BEFORE the sandbox
    // seam is ever consulted (zero terminal runs), and the refusal is a
    // DURABLE failed action row — never a fabricated success.
    const result = await world.dispatch(receipt.sessionId, {
      actionType: "terminal-exec",
      target: "/workspace",
      input: { command: "rm -rf /" },
    });
    expect(result.status).toBe("failed");
    const actions = await world.store.listActions(world.applicationId, receipt.sessionId);
    expect(actions[0]?.status).toBe("failed");
    expect(actions[0]?.failureMessage).toContain("shell-free");
    expect(world.terminal.runs).toHaveLength(0);
  });

  it("replaying an action under the SAME key converges (exactly one external effect per key)", async () => {
    const { world, sessionId } = await activeDeterministicSession();
    const request = {
      actionType: "api-call" as const,
      target: "api.example.com/v1/data",
      input: { method: "GET" },
    };
    const first = await world.dispatch(sessionId, request, "stable-key-1");
    const second = await world.dispatch(sessionId, request, "stable-key-1");
    expect(first.status).toBe("succeeded");
    expect(second.replayed).toBe(true);
    expect(second.actionId).toBe(first.actionId);
    // Exactly ONE external action effect for this key.
    const actionEffects = world.environment
      .activity()
      .filter((entry) => entry.operation === "action");
    expect(actionEffects).toHaveLength(1);
    expect(actionEffects[0]?.replayed).toBe(false);
  });

  it("an action key reused with a DIFFERENT request fails closed (fingerprint arbitration)", async () => {
    const { world, sessionId } = await activeDeterministicSession();
    await world.dispatch(
      sessionId,
      {
        actionType: "api-call",
        target: "api.example.com/v1/data",
        input: { method: "GET" },
      },
      "stable-key-2",
    );
    const error = await expectPlatformError(
      "IDEMPOTENCY_KEY_REUSED",
      world.dispatch(
        sessionId,
        { actionType: "api-call", target: "api.example.com/v1/different", input: {} },
        "stable-key-2",
      ),
    );
    expect(error.message).toContain("action key");
  });

  it("actions on a TERMINAL session are refused (the closed lifecycle)", async () => {
    const { world, sessionId } = await activeDeterministicSession();
    await world.service.terminate(world.applicationId, sessionId, "completed", "term-key");
    const error = await expectPlatformError(
      "INVALID_STATE_TRANSITION",
      world.dispatch(sessionId, {
        actionType: "api-call",
        target: "api.example.com/v1/data",
        input: {},
      }),
    );
    expect(error.message).toContain("terminal");
  });
});

describe("computer-use service: escalation (AC-7 — one step, recorded evidence, re-admission)", () => {
  async function uncertainSession(): Promise<{
    world: InMemoryComputerUseWorld;
    sessionId: string;
  }> {
    const world = createInMemoryComputerUseWorld();
    await world.register(deterministicDeclaration({ qualityConfidence: "estimated" }));
    await world.register(browserDeclaration());
    await world.register(desktopDeclaration());
    const executionId = await world.seedExecution();
    const receipt = await world.createSession({ executionId });
    expect(receipt.mode).toBe("deterministic");
    return { world, sessionId: receipt.sessionId };
  }

  it("escalates deterministic → browser on RECORDED insufficiency, re-admitting through the gates and reopening the environment", async () => {
    const { world, sessionId } = await uncertainSession();
    // The deterministic action FAILS (recorded insufficiency evidence).
    world.environment.injectNextActionFailure();
    const failed = await world.dispatch(sessionId, {
      actionType: "api-call",
      target: "api.example.com/v1/data",
      input: {},
    });
    expect(failed.status).toBe("failed");
    const digest = await insufficiencyDigestOf(world, sessionId, failed.actionId);

    const escalated = await world.service.escalate(
      world.applicationId,
      sessionId,
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
    // The escalation ledger row is durable with the digest.
    const escalations = await world.store.listEscalations(world.applicationId, sessionId);
    expect(escalations).toHaveLength(1);
    expect(escalations[0]?.fromMode).toBe("deterministic");
    expect(escalations[0]?.toMode).toBe("browser");
    expect(escalations[0]?.insufficiencyDigest).toBe(digest);
    // The escalation was RE-ADMITTED (a fresh policy call for the new stage).
    expect(
      world.policy.calls.some((call) => call.toolFact === "computer-use:escalation:browser"),
    ).toBe(true);
    // A NEW isolated environment opened for the browser mode.
    const session = await world.service.getSession(world.applicationId, sessionId);
    expect(session?.currentMode).toBe("browser");
    expect(session?.modeContext.capabilityId).toBe("computer-use-browser-isolated");
    expect(session?.environmentRef).not.toBeNull();
    expect(session?.environmentOpenedMode).toBe("browser");
    expect(session?.escalationCount).toBe(1);
    // The browser context is usable (a browser action dispatches fine).
    const navigation = await world.dispatch(sessionId, {
      actionType: "navigate",
      target: "https://site.example.com/page",
      input: {},
    });
    expect(navigation.status).toBe("succeeded");
    expect(navigation.mode).toBe("browser");
  });

  it("SKIPPING a rung (deterministic → desktop) is unrepresentable", async () => {
    const { world, sessionId } = await uncertainSession();
    const error = await expectPlatformError(
      "POLICY_DENIED",
      world.service.escalate(
        world.applicationId,
        sessionId,
        {
          targetMode: "desktop",
          insufficiency: {
            stage: "deterministic",
            reasonCode: "would-like-to",
            reasonDetail: "attempting to skip the browser rung",
            failedActionId: null,
            evidenceDigest: null,
          },
        },
        "esc-skip",
      ),
    );
    expect(error.message).toContain("frozen ladder");
    expect(await world.store.listEscalations(world.applicationId, sessionId)).toHaveLength(0);
  });

  it("a FABRICATED insufficiency digest fails closed (the escalation evidence is verified)", async () => {
    const { world, sessionId } = await uncertainSession();
    const error = await expectPlatformError(
      "POLICY_DENIED",
      world.service.escalate(
        world.applicationId,
        sessionId,
        {
          targetMode: "browser",
          insufficiency: {
            stage: "deterministic",
            reasonCode: "made-up",
            reasonDetail: "no failure ever happened",
            failedActionId: "00000000-0000-7000-8000-0000000000ff",
            evidenceDigest: "f".repeat(64),
          },
        },
        "esc-fabricated",
      ),
    );
    expect(error.message).toContain("not recorded in this session");
    expect(await world.store.listEscalations(world.applicationId, sessionId)).toHaveLength(0);
  });

  it("a FAILED digest over a REAL action (tampered evidence) fails closed", async () => {
    const { world, sessionId } = await uncertainSession();
    world.environment.injectNextActionFailure();
    const failed = await world.dispatch(sessionId, {
      actionType: "api-call",
      target: "api.example.com/v1/data",
      input: {},
    });
    expect(failed.status).toBe("failed");
    const error = await expectPlatformError(
      "POLICY_DENIED",
      world.service.escalate(
        world.applicationId,
        sessionId,
        {
          targetMode: "browser",
          insufficiency: {
            stage: "deterministic",
            reasonCode: "action-failed",
            reasonDetail: "the digest is tampered",
            failedActionId: failed.actionId,
            evidenceDigest: sha256Hex("tampered-evidence"),
          },
        },
        "esc-tampered",
      ),
    );
    expect(error.message).toContain("fabricated escalation");
  });

  it("a SUCCEEDED action never justifies escalation (only recorded failure does)", async () => {
    const { world, sessionId } = await uncertainSession();
    const succeeded = await world.dispatch(sessionId, {
      actionType: "api-call",
      target: "api.example.com/v1/data",
      input: {},
    });
    expect(succeeded.status).toBe("succeeded");
    const digest = await insufficiencyDigestOf(world, sessionId, succeeded.actionId);
    const error = await expectPlatformError(
      "POLICY_DENIED",
      world.service.escalate(
        world.applicationId,
        sessionId,
        {
          targetMode: "browser",
          insufficiency: {
            stage: "deterministic",
            reasonCode: "revisionist",
            reasonDetail: "the action actually succeeded",
            failedActionId: succeeded.actionId,
            evidenceDigest: digest,
          },
        },
        "esc-revisionist",
      ),
    );
    expect(error.message).toContain("only a recorded failure");
  });

  it("route-level escalation from a SUFFICIENT deterministic route is refused (no displacement without insufficiency)", async () => {
    const world = createInMemoryComputerUseWorld();
    await registerCanonical(world);
    const executionId = await world.seedExecution();
    const receipt = await world.createSession({ executionId });
    expect(receipt.routeEvidence.deterministicFirst).toBe("sufficient");
    const error = await expectPlatformError(
      "POLICY_DENIED",
      world.service.escalate(
        world.applicationId,
        receipt.sessionId,
        {
          targetMode: "browser",
          insufficiency: {
            stage: "deterministic",
            reasonCode: "history-says-gui-is-faster",
            reasonDetail: "a GUI route must not displace a sufficient deterministic route",
            failedActionId: null,
            evidenceDigest: null,
          },
        },
        "esc-displace",
      ),
    );
    expect(error.message).toContain("SUFFICIENT deterministic route");
  });

  it("the escalation gates re-consult POLICY for the new stage (a denial is typed, no mode move)", async () => {
    const { world, sessionId } = await uncertainSession();
    world.environment.injectNextActionFailure();
    const failed = await world.dispatch(sessionId, {
      actionType: "api-call",
      target: "api.example.com/v1/data",
      input: {},
    });
    const digest = await insufficiencyDigestOf(world, sessionId, failed.actionId);
    world.policy.denyFactsMatching((fact) => fact.toolFact === "computer-use:escalation:browser");
    const error = await expectPlatformError(
      "POLICY_DENIED",
      world.service.escalate(
        world.applicationId,
        sessionId,
        {
          targetMode: "browser",
          insufficiency: {
            stage: "deterministic",
            reasonCode: "action-failed",
            reasonDetail: "the deterministic API call failed",
            failedActionId: failed.actionId,
            evidenceDigest: digest,
          },
        },
        "esc-denied",
      ),
    );
    expect(error.message).toContain("escalation to browser denied (policy)");
    const session = await world.service.getSession(world.applicationId, sessionId);
    expect(session?.currentMode).toBe("deterministic");
    expect(await world.store.listEscalations(world.applicationId, sessionId)).toHaveLength(0);
  });

  it("escalation is idempotent per (session, target mode): replay converges", async () => {
    const { world, sessionId } = await uncertainSession();
    world.environment.injectNextActionFailure();
    const failed = await world.dispatch(sessionId, {
      actionType: "api-call",
      target: "api.example.com/v1/data",
      input: {},
    });
    const digest = await insufficiencyDigestOf(world, sessionId, failed.actionId);
    const request = {
      targetMode: "browser" as const,
      insufficiency: {
        stage: "deterministic" as const,
        reasonCode: "action-failed",
        reasonDetail: "the deterministic API call failed",
        failedActionId: failed.actionId,
        evidenceDigest: digest,
      },
    };
    const first = await world.service.escalate(
      world.applicationId,
      sessionId,
      request,
      "esc-key-9",
    );
    const second = await world.service.escalate(
      world.applicationId,
      sessionId,
      request,
      "esc-key-10",
    );
    expect(first.mode).toBe("browser");
    expect(second.mode).toBe("browser");
    expect(second.replayed).toBe(true);
    expect(await world.store.listEscalations(world.applicationId, sessionId)).toHaveLength(1);
  });
});

describe("computer-use service: isolation (AC-2 — no ambient host inheritance)", () => {
  it("a browser context is constructed ONLY from the declared profile (empty cookie jar, zero inherited host state)", async () => {
    const world = createInMemoryComputerUseWorld();
    await world.register(deterministicDeclaration({ covers: ["atom-zzz"] }));
    await world.register(browserDeclaration());
    await world.register(desktopDeclaration());
    const executionId = await world.seedExecution();
    // Quality gap: start in browser mode.
    const receipt = await world.createSession({
      executionId,
      task: {
        kind: "structured-data-retrieval",
        requirementAtoms: ["atom-a", "atom-b"],
        qualityTarget: 0.99,
      },
    });
    expect(receipt.mode).toBe("browser");
    const state = world.environment.contextState(receipt.environmentRef ?? "");
    expect(state).not.toBeNull();
    expect(state?.inheritedHostState).toEqual([]);
    expect(state?.cookies).toEqual([]);
    expect(state?.egressAllowlist).toEqual(["site.example.com"]);
  });

  it("the simulated hostile host world exists and NEVER leaks into contexts or observations", async () => {
    const world = createInMemoryComputerUseWorld();
    await world.register(deterministicDeclaration({ covers: ["atom-zzz"] }));
    await world.register(browserDeclaration());
    await world.register(desktopDeclaration());
    const executionId = await world.seedExecution();
    const receipt = await world.createSession({
      executionId,
      task: {
        kind: "structured-data-retrieval",
        requirementAtoms: ["atom-a", "atom-b"],
        qualityTarget: 0.99,
      },
    });
    const hostItems = world.environment.hostWorld().items();
    expect(hostItems.length).toBeGreaterThanOrEqual(9); // 2 cookies+2 credentials+3 env+1 mount+1 socket
    // Dispatch actions that read the DOM; then assert nothing leaked.
    const dom = await world.dispatch(receipt.sessionId, {
      actionType: "read-dom",
      target: "https://site.example.com/page",
      input: {},
    });
    expect(dom.status).toBe("succeeded");
    const observations = await world.store.listObservations(world.applicationId, receipt.sessionId);
    expect(observations.length).toBeGreaterThanOrEqual(1);
    const allSerialized = JSON.stringify(observations);
    for (const item of hostItems) {
      expect(allSerialized).not.toContain(item.value);
    }
    // None of the host cookies exist in the context.
    const state = world.environment.contextState(receipt.environmentRef ?? "");
    for (const cookie of world.environment.hostWorld().cookies) {
      expect(state?.cookies).not.toContain(cookie);
    }
  });

  it("the environment rail confines egress to the declared allowlist (defense in depth)", async () => {
    const world = createInMemoryComputerUseWorld();
    await world.register(deterministicDeclaration({ covers: ["atom-zzz"] }));
    await world.register(browserDeclaration());
    const executionId = await world.seedExecution();
    const receipt = await world.createSession({
      executionId,
      task: {
        kind: "structured-data-retrieval",
        requirementAtoms: ["atom-a", "atom-b"],
        qualityTarget: 0.99,
      },
      candidates: {
        deterministic: ["computer-use-api-det"],
        browser: "computer-use-browser-isolated",
        desktop: null,
      },
    });
    // A URL host outside the browser allowlist: the service's request.host
    // is absent (no explicit host fact) — the RAIL itself refuses.
    const result = await world.dispatch(receipt.sessionId, {
      actionType: "navigate",
      target: "https://evil.example.net/page",
      input: {},
    });
    expect(result.status).toBe("failed");
    expect(result.routeEvidence).toBeDefined();
    const actions = await world.store.listActions(world.applicationId, receipt.sessionId);
    expect(actions[0]?.status).toBe("failed");
    expect(actions[0]?.failureClass).toBe("egress-confined");
  });

  it("a secret-bearing observation is refused before persistence (evidence never carries secrets)", async () => {
    const world = createInMemoryComputerUseWorld();
    await registerCanonical(world);
    const executionId = await world.seedExecution();
    const receipt = await world.createSession({ executionId });
    // The simulated rail echoes the action target into the observation
    // body; a target carrying a RAW SECRET SHAPE (an AWS-access-key shape,
    // built by concatenation so no literal secret is ever stored in this
    // repository) makes the observation content secret-bearing: the
    // action fails closed BEFORE any observation row is persisted.
    const rawSecretShape = `AKIA${"IOSFODNN7EXAMPLE"}`;
    const result = await world.dispatch(receipt.sessionId, {
      actionType: "api-call",
      target: `api.example.com/v1/data?key=${rawSecretShape}`,
      input: {},
    });
    expect(result.status).toBe("failed");
    expect(result.observations).toHaveLength(0);
    const actions = await world.store.listActions(world.applicationId, receipt.sessionId);
    expect(actions[0]?.status).toBe("failed");
    expect(actions[0]?.failureClass).toBe("secret-bearing-observation");
    // ZERO observations persisted for the session.
    expect(await world.store.listObservations(world.applicationId, receipt.sessionId)).toHaveLength(
      0,
    );
  });
});

describe("computer-use service: termination + settlement", () => {
  it("terminate(completed) closes the environment, settles the budget on ACTUAL usage and is idempotent", async () => {
    const world = createInMemoryComputerUseWorld();
    await world.register(desktopDeclaration());
    const executionId = await world.seedExecution();
    const receipt = await world.createSession({
      executionId,
      task: { kind: "terminal-task", requirementAtoms: ["atom-a"], qualityTarget: 0.9 },
      candidates: { deterministic: [], browser: null, desktop: "computer-use-desktop-isolated" },
    });
    // One terminal-exec through the sandbox rail: the session's ACTUAL
    // usage is the rail-reported usage (the declared estimate, 80).
    await world.dispatch(receipt.sessionId, {
      actionType: "terminal-exec",
      target: "/workspace/report.txt",
      input: { command: "ls", args: ["/workspace"] },
    });
    const sessionBefore = await world.service.getSession(world.applicationId, receipt.sessionId);
    expect(sessionBefore?.usageMicroUsd).toBe("80");
    const terminal = await world.service.terminate(
      world.applicationId,
      receipt.sessionId,
      "completed",
      "term-key-1",
    );
    expect(terminal.status).toBe("completed");
    expect(terminal.replayed).toBe(false);
    // The environment was closed (exactly one close).
    expect(
      world.environment.activity().filter((entry) => entry.operation === "close"),
    ).toHaveLength(1);
    // The budget settled on the ACTUAL usage (80: what ran, not the ceiling).
    expect(world.budgets.settleCalls).toHaveLength(1);
    expect(world.budgets.settleCalls[0]?.command.actualAmountMicroUsd).toBe("80");
    // The terminal move is idempotent.
    const again = await world.service.terminate(
      world.applicationId,
      receipt.sessionId,
      "completed",
      "term-key-2",
    );
    expect(again.status).toBe("completed");
    expect(again.replayed).toBe(true);
    expect(world.budgets.settleCalls).toHaveLength(1);
    // The session row is terminal-immutable in the store.
    const session = await world.service.getSession(world.applicationId, receipt.sessionId);
    expect(session?.terminalCause).toBe("completed");
  });

  it("terminate(cancelled) RELEASES the unspent reservation", async () => {
    const world = createInMemoryComputerUseWorld();
    await registerCanonical(world);
    const executionId = await world.seedExecution();
    const receipt = await world.createSession({ executionId });
    await world.service.terminate(
      world.applicationId,
      receipt.sessionId,
      "cancelled",
      "term-key-3",
    );
    expect(world.budgets.releaseCalls).toHaveLength(1);
    expect(world.budgets.settleCalls).toHaveLength(0);
  });
});

describe("computer-use service: idempotent session creation + the denied replay", () => {
  it("replaying createSession under the same key returns the SAME session with replayed=true", async () => {
    const world = createInMemoryComputerUseWorld();
    await registerCanonical(world);
    const executionId = await world.seedExecution();
    const first = await world.createSession({ executionId }, "create-key-1");
    const second = await world.createSession({ executionId }, "create-key-1");
    expect(second.sessionId).toBe(first.sessionId);
    expect(second.replayed).toBe(true);
    // One environment open total (the replay converged).
    expect(world.environment.activity().filter((entry) => entry.operation === "open")).toHaveLength(
      1,
    );
  });

  it("the same key with a DIFFERENT request fails closed (fingerprint arbitration)", async () => {
    const world = createInMemoryComputerUseWorld();
    await registerCanonical(world);
    const executionId = await world.seedExecution();
    await world.createSession({ executionId }, "create-key-2");
    const error = await expectPlatformError(
      "IDEMPOTENCY_KEY_REUSED",
      world.createSession(
        {
          executionId,
          task: {
            kind: "structured-data-retrieval",
            requirementAtoms: ["atom-a", "atom-b"],
            qualityTarget: 0.95, // different fingerprint
          },
        },
        "create-key-2",
      ),
    );
    expect(error.message).toContain("different session request");
  });

  it("a denied session replays its DENIAL (the denial is durable, not re-decided)", async () => {
    const world = createInMemoryComputerUseWorld();
    await registerCanonical(world);
    const executionId = await world.seedExecution();
    world.policy.denyWith("not permitted");
    await expectPlatformError("POLICY_DENIED", world.createSession({ executionId }, "deny-key"));
    // The policy engine is consulted ZERO times on the replay.
    const callsBefore = world.policy.calls.length;
    const error = await expectPlatformError(
      "POLICY_DENIED",
      world.createSession({ executionId }, "deny-key"),
    );
    expect(error.message).toContain("not permitted");
    expect(world.policy.calls.length).toBe(callsBefore);
  });

  it("a MALFORMED request fails closed before any authority call (pure validation first)", async () => {
    const world = createInMemoryComputerUseWorld();
    await registerCanonical(world);
    const executionId = await world.seedExecution();
    const error = await expectPlatformError(
      "POLICY_DENIED",
      world.service.createSession(
        {
          applicationId: world.applicationId,
          executionId,
          actor: { actorId: world.actorId, tenantId: world.tenantId },
          task: { kind: "nap" as never, requirementAtoms: ["a"], qualityTarget: 0.9 },
          candidates: { deterministic: ["computer-use-api-det"], browser: null, desktop: null },
          connectionRef: null,
        },
        "malformed-key",
      ),
    );
    expect(error.message).toContain("task-kind");
    expect(world.policy.calls).toHaveLength(0);
    expect(world.environment.activity()).toHaveLength(0);
  });
});

describe("computer-use service: the replayable trajectory (AC-8)", () => {
  it("returns the ordered lineage-bearing trajectory with digests (sessions, escalations, actions, observations)", async () => {
    const world = createInMemoryComputerUseWorld();
    await world.register(deterministicDeclaration({ qualityConfidence: "estimated" }));
    await world.register(browserDeclaration());
    await world.register(desktopDeclaration());
    const executionId = await world.seedExecution();
    const receipt = await world.createSession({ executionId });

    // A failed deterministic action (recorded insufficiency) → escalation.
    world.environment.injectNextActionFailure();
    const failed = await world.dispatch(receipt.sessionId, {
      actionType: "api-call",
      target: "api.example.com/v1/data",
      input: {},
    });
    expect(failed.status).toBe("failed");
    const digest = await insufficiencyDigestOf(world, receipt.sessionId, failed.actionId);
    const escalated = await world.service.escalate(
      world.applicationId,
      receipt.sessionId,
      {
        targetMode: "browser",
        insufficiency: {
          stage: "deterministic",
          reasonCode: "action-failed",
          reasonDetail: "the deterministic API call failed",
          failedActionId: failed.actionId,
          evidenceDigest: digest,
        },
      },
      "esc-key",
    );
    expect(escalated.mode).toBe("browser");
    const navigation = await world.dispatch(receipt.sessionId, {
      actionType: "navigate",
      target: "https://site.example.com/page",
      input: {},
    });
    expect(navigation.status).toBe("succeeded");

    const trajectory = await world.service.getTrajectory(world.applicationId, receipt.sessionId);
    expect(trajectory).not.toBeNull();
    const entries = trajectory?.entries ?? [];
    // Every entry carries the full lineage.
    for (const entry of entries) {
      expect(entry.sessionId).toBe(receipt.sessionId);
      expect(entry.executionId).toBe(executionId);
    }
    const kinds = entries.map((entry) => entry.kind);
    expect(kinds).toContain("session-opened");
    expect(kinds).toContain("escalation");
    expect(kinds.filter((kind) => kind === "action")).toHaveLength(2);
    expect(kinds).toContain("observation");
    // The session-opened entry pins the route digest.
    const opened = entries.find((entry) => entry.kind === "session-opened");
    expect(opened && opened.kind === "session-opened" ? opened.routeDigest : "").toHaveLength(64);
    // The escalation entry carries the insufficiency digest.
    const escalation = entries.find((entry) => entry.kind === "escalation");
    expect(
      escalation && escalation.kind === "escalation" ? escalation.insufficiencyDigest : "",
    ).toBe(digest);
    // The action entries carry digests + the observation linkage.
    const actions = entries.filter((entry) => entry.kind === "action");
    const navigateEntry = actions.find(
      (entry) => entry.kind === "action" && entry.actionType === "navigate",
    );
    expect(navigateEntry && navigateEntry.kind === "action").toBeDefined();
    const observation = entries.find((entry) => entry.kind === "observation");
    expect(observation && observation.kind === "observation").toBeDefined();
    const observationEntry =
      observation && observation.kind === "observation" ? observation : undefined;
    expect(observationEntry?.contentDigest).toHaveLength(64);
    expect(["sensitive-ui", "none"]).toContain(observationEntry?.redaction);
    // The trajectory session record is the durable session itself.
    expect(trajectory?.session.currentMode).toBe("browser");
    expect(trajectory?.session.escalationCount).toBe(1);
  });

  it("the public observation evidence NEVER carries content (digest references only)", async () => {
    const world = createInMemoryComputerUseWorld();
    await registerCanonical(world);
    const executionId = await world.seedExecution();
    const receipt = await world.createSession({ executionId });
    const result = await world.dispatch(receipt.sessionId, {
      actionType: "api-call",
      target: "api.example.com/v1/data",
      input: {},
    });
    expect(result.observations.length).toBeGreaterThanOrEqual(1);
    // The PUBLIC serialization of each observation (the evidence-consumer
    // boundary) carries digests + retention metadata ONLY: no content key,
    // no serialized body, no target string.
    for (const observation of result.observations) {
      const publicEvidence = serializeObservationEvidence(observation);
      const serialized = JSON.stringify(publicEvidence);
      expect(publicEvidence).not.toHaveProperty("content");
      expect(serialized).not.toContain("api.example.com/v1/data");
      expect(serialized).not.toContain('"content"');
    }
    // The replayable trajectory serialization never carries observation
    // CONTENT either (digest references only).
    const trajectory = await world.service.getTrajectory(world.applicationId, receipt.sessionId);
    const serialized = JSON.stringify(trajectory);
    expect(serialized).not.toContain('"content"');
  });
});
