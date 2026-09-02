/**
 * Shared real-PostgreSQL fixture for the realtime voice-session suite
 * (WORK-024).
 *
 * Extends the WORK-023 deployment-fabric world with the WORK-024 realtime
 * fabric over the provider-neutral DatabasePort:
 *
 *   * sessions/journal: SqlRealtimeStore (migration 0018);
 *   * provenance: the REAL realtime execution-ledger adapter over the
 *     REAL executions service (session-mapped executions are created and
 *     lifecycle-walked through the executions PUBLIC surface, and every
 *     turn/interruption/transfer/failure rides the real EventEnvelope
 *     ledger);
 *   * policy admission: the REAL policies engine (WORK-007) through the
 *     deployments module's policy-realtime adapter, with a default
 *     platform-allow document;
 *   * the upstream rail: the in-process simulated realtime rail (the
 *     provider-honesty stance — no external provider credentials exist
 *     in this environment; external behavior is UNVERIFIED and recorded
 *     as such in docs/work-items/WORK-024.md);
 *   * capability/budget/secret/router/responder seams: recording fakes
 *     (their PG behavior is owned by their own modules' suites; the
 *     durable-state proofs here need only deterministic toggles).
 */

import { createHash } from "node:crypto";
import type {
  RealtimeActor,
  RealtimeBudgetReserveCommand,
  RealtimeCapabilityAdmissionRequest,
  RealtimePolicyAdmissionRequest,
  RealtimeRouteClass,
  RealtimeSecretMediationRequest,
  RealtimeSessionService,
  RealtimeTurnResponderRequest,
  RealtimeTurnRouteRequest,
} from "../../../src/modules/deployments/public";
import {
  createInProcessRealtimeRail,
  createPolicyRealtimeAdmission,
  createRealtimeExecutionLedgerAdapter,
  createRealtimeSessionService,
  SqlRealtimeStore,
} from "../../../src/modules/deployments/public";
import {
  createPolicyAuthority,
  InMemoryPolicyStore,
  nodePolicyHasher,
} from "../../../src/modules/policies/public";
import type { DatabasePort } from "../../../src/platform/db/port";
import { createUuidv7Generator } from "../../../src/shared/ids";
import {
  type DeploymentPgWorld,
  PROFILE_BODY,
  planBody,
  seedDeploymentWorld,
} from "./deployments-world";

const sha256Hex = (input: string): string => createHash("sha256").update(input).digest("hex");

/** Recording fakes for the four admission seams + router + responder. */
class RealtimeAdmissions {
  readonly policyCalls: RealtimePolicyAdmissionRequest[] = [];
  readonly capabilityCalls: RealtimeCapabilityAdmissionRequest[] = [];
  readonly reserves: RealtimeBudgetReserveCommand[] = [];
  readonly releases: RealtimeBudgetReserveCommand[] = [];
  readonly mediationCalls: RealtimeSecretMediationRequest[] = [];
  readonly routerCalls: RealtimeTurnRouteRequest[] = [];
  readonly responderCalls: RealtimeTurnResponderRequest[] = [];
  unmetCapabilities: string[] = [];
  denyPolicy = false;
  failBudget = false;
  refuseMediation = false;
  routeClass: RealtimeRouteClass = "generative";

  readonly policy = {
    admit: async (request: RealtimePolicyAdmissionRequest) => {
      this.policyCalls.push(request);
      return this.denyPolicy
        ? { allowed: false as const, reason: "fixture denial" }
        : { allowed: true as const };
    },
  };

  readonly capabilities = {
    resolve: async (request: RealtimeCapabilityAdmissionRequest) => {
      this.capabilityCalls.push(request);
      return { satisfied: this.unmetCapabilities.length === 0, unmet: this.unmetCapabilities };
    },
  };

  readonly budget = {
    reserve: async (command: RealtimeBudgetReserveCommand) => {
      this.reserves.push(command);
      if (this.failBudget) {
        throw new Error("fixture: budget exhausted (mapped by the adapter contract)");
      }
      // Key-convergent reservation (the REAL budgets module treats
      // operationId as the idempotency discriminator: a retried or
      // concurrent duplicate converges on the SAME reservation — the
      // crash-recovery proofs depend on that convergence).
      const existing = this.reservationsByOperation.get(command.operationId);
      if (existing !== undefined) {
        return { reservationId: existing, amountMicroUsd: "10000", converged: true };
      }
      const reservationId = `resv-${this.reserves.length}`;
      this.reservationsByOperation.set(command.operationId, reservationId);
      return {
        reservationId,
        amountMicroUsd: "10000",
        converged: false,
      };
    },
    settle: async () => ({ reservationId: "resv-x", settled: true }),
    release: async (command: RealtimeBudgetReserveCommand) => {
      this.releases.push(command);
      return { reservationId: "resv-x", released: true };
    },
  };

  private readonly reservationsByOperation = new Map<string, string>();

  readonly secrets = {
    mediate: async (request: RealtimeSecretMediationRequest) => {
      this.mediationCalls.push(request);
      return this.refuseMediation
        ? { mediated: false as const, reason: "fixture connection inactive" }
        : { mediated: true as const, grantRef: "mediated:conn-1" };
    },
  };

  readonly router = {
    routeTurn: async (request: RealtimeTurnRouteRequest) => {
      this.routerCalls.push(request);
      return {
        routeClass: this.routeClass,
        decisionOutcome:
          this.routeClass === "deterministic"
            ? ("sufficient" as const)
            : this.routeClass === "hybrid"
              ? ("uncertain" as const)
              : ("insufficient" as const),
        reasonCodes: ["fixture"],
        rationale: "fixture planner decision",
        estimatedCostMicroUsd: this.routeClass === "deterministic" ? null : "10000",
      };
    },
  };

  readonly responder = {
    respond: async (request: RealtimeTurnResponderRequest) => {
      this.responderCalls.push(request);
      return {
        responseRef: "artifact:responses/1",
        responsePreview: "fixture answer",
        actualCostMicroUsd: "0",
      };
    },
  };
}

export interface RealtimePgWorld {
  readonly db: DatabasePort;
  readonly base: DeploymentPgWorld;
  readonly tenantId: string;
  readonly applicationId: string;
  readonly environmentId: string;
  readonly deploymentId: string;
  readonly realtimeStore: SqlRealtimeStore;
  readonly service: RealtimeSessionService;
  readonly rail: ReturnType<typeof createInProcessRealtimeRail>;
  readonly admissions: RealtimeAdmissions;
  readonly actor: () => RealtimeActor;
  /**
   * Boot (or re-boot) the realtime session service over the SURVIVING
   * world — the process-restart primitive for the crash-injection
   * proofs: the PG store, the executions ledger (PG), the upstream rail
   * (the external provider's idempotency-key ledger) and the admission
   * seams persist across a Zeck process death; a `point` arms ONE
   * durable-boundary crash (a method on store/rail/ledger, before/after
   * its durable commit) that kills the booted process mid-flight.
   */
  readonly boot: (point?: CrashInjectionPoint | null) => {
    readonly service: RealtimeSessionService;
    readonly crashed: () => boolean;
  };
}

/** The simulated process death (never a typed service error). */
export class ProcessCrashError extends Error {
  constructor(point: string) {
    super(`simulated process crash at ${point}`);
    this.name = "ProcessCrashError";
  }
}

/** One armed durable-boundary crash point (per booted process). */
export interface CrashInjectionPoint {
  readonly target: "store" | "rail" | "ledger";
  readonly method: string;
  readonly when: "before" | "after";
  /** Fire on the Nth invocation within THIS process (default 1). */
  readonly occurrence?: number;
}

/**
 * Wrap one durable/external seam so the booted process dies at the
 * planned point (`before` = the durable commit did not happen; `after`
 * = the commit / external side effect did). The wrapper records the
 * firing so a vacuous proof (a point the service never reaches) fails
 * its `crashed()` assertion.
 */
function crashableSeam<T extends object>(
  target: T,
  label: string,
  point: CrashInjectionPoint | null,
) {
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

export async function seedRealtimeWorld(db: DatabasePort): Promise<RealtimePgWorld> {
  const base = await seedDeploymentWorld(db);
  const actor = base.actor();

  // Profile + plan v1/v2 + the deployment (active, pinned at v1).
  await base.deploymentService.publishProfile({ ...PROFILE_BODY }, { version: 1 }, actor);
  await base.deploymentService.publishPlan(planBody(base), { version: 1 }, actor);
  await base.deploymentService.publishPlan(
    {
      ...planBody(base),
      sessionPolicy: { maxSessionDurationMs: 300_000, maxConcurrentSessions: 16 },
    },
    { version: 2 },
    actor,
  );
  const created = await base.deploymentService.createDeployment(
    {
      slug: "support-voice-prod",
      name: "Support voice (production)",
      environmentId: base.environmentId,
      agentId: base.agentId,
      agentVersion: base.agentVersion,
      agentKind: "zeck",
      planId: "support-voice-plan",
    },
    "realtime-create-deployment",
    actor,
  );

  // The REAL policies engine for the realtime admission seam.
  const authority = createPolicyAuthority({
    store: new InMemoryPolicyStore(),
    hasher: nodePolicyHasher,
  });
  await authority.publish({
    id: "default",
    version: 1,
    documents: [{ scope: "platform", selector: {}, restrictions: {} }],
  });

  const admissions = new RealtimeAdmissions();
  const rail = createInProcessRealtimeRail(["web", "in-app", "telephony"]);
  const realtimeStore = new SqlRealtimeStore(db);
  const ledger = createRealtimeExecutionLedgerAdapter(base.executionService);
  const railConnectionRef = "connections:simulated-realtime-rail";
  const sha = sha256Hex;
  const newId = createUuidv7Generator();
  const now = () => new Date();
  const boot = (point: CrashInjectionPoint | null = null) => {
    const storeProcess = crashableSeam(realtimeStore, "store", point);
    const railProcess = crashableSeam(rail, "rail", point);
    const ledgerProcess = crashableSeam(ledger, "ledger", point);
    const service = createRealtimeSessionService({
      store: storeProcess.proxy,
      deployments: base.deploymentStore,
      rail: railProcess.proxy,
      policy: createPolicyRealtimeAdmission(authority),
      capabilities: admissions.capabilities,
      budget: admissions.budget,
      secrets: admissions.secrets,
      router: admissions.router,
      responder: admissions.responder,
      ledger: ledgerProcess.proxy,
      railConnectionRef,
      digest: sha,
      generateId: newId,
      now,
    });
    return {
      service,
      crashed: () => storeProcess.crashed() || railProcess.crashed() || ledgerProcess.crashed(),
    };
  };

  return {
    db,
    base,
    tenantId: base.tenantId,
    applicationId: base.applicationId,
    environmentId: base.environmentId,
    deploymentId: created.deploymentId,
    realtimeStore,
    service: boot().service,
    rail,
    admissions,
    actor: () => ({
      actorId: base.actor().actorId,
      applicationId: base.applicationId,
      tenantId: base.tenantId,
    }),
    boot,
  };
}

/** Start one realtime session on the world's deployment (v1 pin). */
export async function startRealtimeSession(
  world: RealtimePgWorld,
  suffix: string,
  overrides: {
    readonly channelSessionRef?: string;
    readonly channelKind?: "web" | "telephony";
  } = {},
): Promise<ReturnType<RealtimeSessionService["startSession"]>> {
  return world.service.startSession(
    {
      deploymentId: world.deploymentId,
      channelKind: overrides.channelKind ?? "web",
      channelSessionRef: overrides.channelSessionRef ?? `call-${suffix}`,
      callerRef: `caller-${suffix}`,
    },
    `start-${suffix}`,
    world.actor(),
  );
}

/** One inbound user-turn event on the session's CURRENT coordinates. */
export function userTurn(
  session: {
    readonly sessionId: string;
    readonly channelSessionRef: string;
    readonly channelEpoch: number;
  },
  eventKey: string,
): {
  readonly sessionId: string;
  readonly channelSessionRef: string;
  readonly channelEpoch: number;
  readonly kind: "user-turn";
  readonly eventKey: string;
  readonly payloadRef: string;
  readonly payloadPreview: string;
} {
  return {
    sessionId: session.sessionId,
    channelSessionRef: session.channelSessionRef,
    channelEpoch: session.channelEpoch,
    kind: "user-turn",
    eventKey,
    payloadRef: "artifact:turns/1",
    payloadPreview: "customer question",
  };
}
