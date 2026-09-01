/**
 * In-memory world for the economics unit suites (WORK-032).
 *
 * Wires the REAL economic-action service over the REAL in-memory store +
 * idempotency arbitration and the REAL in-memory executions ledger seam
 * (`tests/unit/executions/fakes.ts` — `recordStepEvent` is the canonical
 * executions evidence surface economics journals to), with RECORDING fakes
 * for the three admission authorities (policy, capability, budget) whose
 * call ORDER is the ECO-003 ordering proof substrate:
 *
 *   policy -> capability -> budget.reserve -> authorization issuance
 *   -> rail.charge (external side effect) -> budget.settle/release
 *
 * The journal records every authority/store/rail touch in order; the
 * simulated payment rails (the REAL contract-tested reference adapters
 * from `src/integrations/payment-rails/`) are wrapped so `rail.charge`
 * journals too. Concurrency/locking proofs live in the real-PostgreSQL
 * suites (the in-memory store is single-threaded by construction).
 */

import type { PaymentRail } from "../../../src/integrations/payment-rails/public";
import { createSimulatedPaymentRail } from "../../../src/integrations/payment-rails/public";
import type {
  BudgetAuthority,
  ReleaseCommand,
  ReleaseOutcome,
  ReservationRecord,
  ReserveCommand,
  ReserveOutcome,
  SettleCommand,
  SettleOutcome,
} from "../../../src/modules/budgets/public";
import type {
  EconomicActionService,
  EconomicCapabilityAdmissionDecision,
  EconomicCapabilityAdmissionInput,
  EconomicCapabilityAdmissionPort,
  EconomicPolicyAdmissionDecision,
  EconomicPolicyAdmissionInput,
  EconomicPolicyAdmissionPort,
} from "../../../src/modules/economics/public";
import {
  createEconomicActionService,
  InMemoryEconomicStore,
  InMemoryEconomicsIdempotency,
} from "../../../src/modules/economics/public";
import type { ExecutionService } from "../../../src/modules/executions/application/execution-service";
import { PlatformError } from "../../../src/shared/errors";
import { ACTOR, baseCreateInput, createInMemoryExecutions } from "../executions/fakes";

export { ACTOR };

/** A shared mutable clock (deterministic expiry tests). */
export class MutableClock {
  private current = new Date("2026-09-15T12:00:00.000Z");
  now(): Date {
    return new Date(this.current.getTime());
  }
  advance(ms: number): void {
    this.current = new Date(this.current.getTime() + ms);
  }
  set(date: Date): void {
    this.current = date;
  }
}

/** Recording policy admission (the hard authorization boundary seam). */
export class RecordingPolicyAdmission implements EconomicPolicyAdmissionPort {
  readonly calls: EconomicPolicyAdmissionInput[] = [];
  decision: EconomicPolicyAdmissionDecision = {
    allowed: true,
    evidence: {
      policySetId: "ps-1",
      policySetVersion: 1,
      policyContentHash: "hash-1",
      restrictionSetDigest: "digest-1",
    },
  };

  constructor(private readonly journal: readonly string[] = []) {}

  async evaluate(input: EconomicPolicyAdmissionInput): Promise<EconomicPolicyAdmissionDecision> {
    this.calls.push(input);
    (this.journal as string[]).push("policy.evaluate");
    return this.decision;
  }
}

/** Recording capability admission (the capabilities authority seam). */
export class RecordingCapabilityAdmission implements EconomicCapabilityAdmissionPort {
  readonly calls: EconomicCapabilityAdmissionInput[] = [];
  decision: EconomicCapabilityAdmissionDecision = { satisfied: true, unmet: [] };

  constructor(private readonly journal: readonly string[] = []) {}

  async resolve(
    input: EconomicCapabilityAdmissionInput,
  ): Promise<EconomicCapabilityAdmissionDecision> {
    this.calls.push(input);
    (this.journal as string[]).push("capabilities.resolve");
    return this.decision;
  }
}

/**
 * Recording budget authority — SETTLE-CAPABLE (unlike the executions
 * unit FakeBudgetAuthority, which is reserve-only): reserve/settle/
 * release all record and succeed unless configured to deny (the
 * BUDGET_EXCEEDED branch the service must fail closed on).
 */
export class RecordingBudgetAuthority {
  readonly reserveCalls: ReserveCommand[] = [];
  readonly settleCalls: SettleCommand[] = [];
  readonly releaseCalls: ReleaseCommand[] = [];
  failReserve = false;
  failSettle = false;

  constructor(private readonly journal: readonly string[] = []) {}

  private reservation(command: ReserveCommand | SettleCommand | ReleaseCommand): ReservationRecord {
    return {
      id: `res-${this.reserveCalls.length + this.settleCalls.length + this.releaseCalls.length}`,
      applicationId: command.applicationId,
      tenantId: command.tenantId,
      executionId: "executionId" in command ? command.executionId : "",
      operationId: command.operationId,
      userId: "",
      fundingMode: "developer",
      sourceKind: "developer",
      walletId: null,
      amountMicroUsd: "125000",
      status: "active",
      settledAmountMicroUsd: null,
      monthKey: "2026-09",
      createdAt: "2026-09-15T12:00:00.000Z",
      finalizedAt: null,
    };
  }

  readonly impl: BudgetAuthority = {
    reserve: async (command: ReserveCommand, _key: string): Promise<ReserveOutcome> => {
      (this.journal as string[]).push("budget.reserve");
      if (this.failReserve) {
        throw new PlatformError({
          code: "BUDGET_EXCEEDED",
          message: "budget authority denied the reservation (insufficient funds)",
        });
      }
      this.reserveCalls.push(command);
      return {
        reservation: this.reservation(command),
        converged: false,
        replayed: false,
      };
    },
    settle: async (command: SettleCommand, _key: string): Promise<SettleOutcome> => {
      (this.journal as string[]).push("budget.settle");
      if (this.failSettle) {
        throw new PlatformError({ code: "BUDGET_EXCEEDED", message: "settle denied" });
      }
      this.settleCalls.push(command);
      return {
        reservation: {
          ...this.reservation(command),
          status: "settled",
          settledAmountMicroUsd: command.actualAmountMicroUsd,
        },
        converged: false,
        replayed: false,
      };
    },
    release: async (command: ReleaseCommand, _key: string): Promise<ReleaseOutcome> => {
      (this.journal as string[]).push("budget.release");
      this.releaseCalls.push(command);
      return {
        reservation: {
          ...this.reservation(command),
          status: "released",
          finalizedAt: "2026-09-15T12:00:00.000Z",
        },
        converged: false,
        replayed: false,
      };
    },
  };
}

/** Journaling store: records the durable-write order on top of the real fake. */
export class JournalingEconomicStore extends InMemoryEconomicStore {
  constructor(private readonly journal: readonly string[]) {
    super();
  }

  override async insertEconomicAction(
    input: Parameters<InMemoryEconomicStore["insertEconomicAction"]>[0],
  ) {
    const record = await super.insertEconomicAction(input);
    (this.journal as string[]).push("store.insertEconomicAction");
    return record;
  }

  override async insertAuthorization(
    input: Parameters<InMemoryEconomicStore["insertAuthorization"]>[0],
  ) {
    const record = await super.insertAuthorization(input);
    (this.journal as string[]).push("store.insertAuthorization");
    return record;
  }

  override async transitionEconomicAction(
    ...args: Parameters<InMemoryEconomicStore["transitionEconomicAction"]>
  ) {
    const record = await super.transitionEconomicAction(...args);
    (this.journal as string[]).push(`store.transitionEconomicAction:${String(args[3])}`);
    return record;
  }

  override async insertSettlement(...args: Parameters<InMemoryEconomicStore["insertSettlement"]>) {
    const record = await super.insertSettlement(...args);
    (this.journal as string[]).push("store.insertSettlement");
    return record;
  }

  override async insertDelivery(...args: Parameters<InMemoryEconomicStore["insertDelivery"]>) {
    const record = await super.insertDelivery(...args);
    (this.journal as string[]).push("store.insertDelivery");
    return record;
  }
}

/** Wrap a rail so `charge` journals (the external-side-effect touchpoint). */
export function journalingRail(rail: PaymentRail, journal: readonly string[]): PaymentRail {
  return {
    railId: rail.railId,
    capabilities: rail.capabilities,
    charge: async (request) => {
      (journal as string[]).push(`rail.charge:${rail.railId}`);
      return rail.charge(request);
    },
  };
}

export interface EconomicsWorldOptions {
  /** Simulated rail id (defaults to simulated-rail-a). */
  readonly railId?: string;
  /** Honest failure injection for the simulated rail. */
  readonly railFailsAllCharges?: boolean;
  /** The default expiry window for seeded intents (ISO instant). */
  readonly expiresAt?: string;
}

export interface EconomicsWorld {
  readonly journal: string[];
  readonly clock: MutableClock;
  readonly store: JournalingEconomicStore;
  readonly policy: RecordingPolicyAdmission;
  readonly capability: RecordingCapabilityAdmission;
  readonly budget: RecordingBudgetAuthority;
  readonly economics: EconomicActionService;
  readonly executions: ExecutionService;
  readonly applicationId: string;
  readonly tenantId: string;
  readonly actorId: string;
  readonly executionId: string;
  readonly rail: PaymentRail;
  readonly expiresAt: string;
  /** The wrapped rail handed to charge (journals the side effect). */
  readonly journaledRail: PaymentRail;
}

let worldCounter = 0;

export async function createEconomicsUnitWorld(
  options: EconomicsWorldOptions = {},
): Promise<EconomicsWorld> {
  worldCounter += 1;
  const applicationId = `00000000-0000-7000-8000-10000000${String(worldCounter).padStart(4, "0")}`;
  const executionsWorld = createInMemoryExecutions();
  executionsWorld.store.seedApplication(applicationId, ACTOR.tenantId);
  const receipt = await executionsWorld.service.createExecution(
    baseCreateInput(applicationId),
    `econ-exec-${worldCounter}`,
    ACTOR,
  );

  const journal: string[] = [];
  const clock = new MutableClock();
  const store = new JournalingEconomicStore(journal);
  const policy = new RecordingPolicyAdmission(journal);
  const capability = new RecordingCapabilityAdmission(journal);
  const budget = new RecordingBudgetAuthority(journal);
  const economics = createEconomicActionService({
    store,
    idempotency: new InMemoryEconomicsIdempotency(store),
    policy,
    capabilities: capability,
    budget: budget.impl,
    executions: executionsWorld.service,
    generateId: executionsWorld.generateId,
    now: () => clock.now(),
  });
  const rail = createSimulatedPaymentRail({
    railId: options.railId ?? "simulated-rail-a",
    ...(options.railFailsAllCharges ? { failAllCharges: true } : {}),
    now: () => clock.now(),
  });

  return {
    journal,
    clock,
    store,
    policy,
    capability,
    budget,
    economics,
    executions: executionsWorld.service,
    applicationId,
    tenantId: ACTOR.tenantId,
    actorId: ACTOR.actorId,
    executionId: receipt.executionId,
    rail,
    journaledRail: journalingRail(rail, journal),
    expiresAt: options.expiresAt ?? new Date(clock.now().getTime() + 60 * 60 * 1000).toISOString(),
  };
}

/** A valid create command for the world (overridable per test). */
export function createCommand(
  world: EconomicsWorld,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    applicationId: world.applicationId,
    tenantId: world.tenantId,
    actorId: world.actorId,
    executionId: world.executionId,
    purpose: "purchase",
    recipient: { kind: "merchant", id: "merchant-42" },
    amount: { kind: "exact", microUsd: "125000" },
    currency: "usd",
    expiresAt: world.expiresAt,
    requiredCapabilities: [{ kind: "tool", name: "payment-processor" }],
    ...overrides,
  };
}

/** Propose + authorize in one step (the happy admission chain). */
export async function authorizedAction(
  world: EconomicsWorld,
  overrides: Record<string, unknown> = {},
  key = "key-authorize",
): Promise<{ actionId: string; authorizationId: string }> {
  const created = await world.economics.createEconomicAction(
    createCommand(world, overrides) as never,
    `${key}:create`,
  );
  const outcome = await world.economics.authorizeEconomicAction(
    {
      applicationId: world.applicationId,
      tenantId: world.tenantId,
      actorId: world.actorId,
      economicActionId: created.action.id,
    },
    key,
  );
  return { actionId: created.action.id, authorizationId: outcome.authorization?.id ?? "" };
}
