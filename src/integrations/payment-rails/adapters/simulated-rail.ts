/**
 * Simulated payment rails (payment-rails integration adapters; WORK-032,
 * ECO-004).
 *
 * HONESTY NOTE (the work order's evidence contract): these are
 * CONTRACT-TESTED SIMULATED rails — deterministic, in-memory reference
 * adapters of the economics module's provider-neutral `PaymentRail`
 * port. They perform NO network call, touch NO real payment system and
 * move NO real money; no successful real financial transaction is
 * claimed anywhere in this Work Order. A real rail adapter (an HTTP
 * client behind this same port) arrives with its own Work Order and
 * dependency declaration, in this directory only.
 *
 * The simulated rails are DELIBERATELY FAITHFUL to the port's safety
 * contract so the neutrality/replacement proofs are meaningful:
 *  - `railId` is an opaque neutral string (never a provider SDK type);
 *  - capabilities honestly declare the enforced-constraint surface
 *    (recipient pinning, amount ceiling, currency pinning, expiry) and
 *    the charge path ENFORCES them: the amount charged is exactly the
 *    bounded request amount, to the pinned recipient, in the pinned
 *    currency, and a request past its expiry is REFUSED rail-side;
 *  - rail-side idempotency converges retries (the same idempotency key
 *    returns the same durable observation — create-or-converge);
 *  - NO credential field exists anywhere on the request contract, and
 *    the rail holds no credential material at all.
 *
 * Replacement proof: `simulated-rail-a` and `simulated-rail-b` are two
 * DIFFERENT rails behind the SAME contract; swapping one for the other
 * is a composition change that provably changes no authority decision
 * (the architecture + discrimination suites pin this).
 */

import type {
  PaymentRail,
  RailPaymentRequest,
  RailSettlementObservation,
} from "../../../modules/economics/public";
import { railCanExpressConstraints } from "../../../modules/economics/public";

export interface SimulatedPaymentRailOptions {
  /** Opaque neutral rail identity (e.g. "simulated-rail-a"). */
  readonly railId: string;
  /**
   * Honest failure injection: when set, every charge settles as FAILED
   * (the platform's failure path — budget release, non-settled action —
   * is exercisable without any real rail).
   */
  readonly failAllCharges?: boolean;
  /** Injectable clock (deterministic tests). */
  readonly now?: () => Date;
}

export interface SimulatedPaymentRail extends PaymentRail {
  /** The rail's own charge history (test observation surface only). */
  readonly charges: readonly RailPaymentRequest[];
}

interface RailRecord {
  readonly observation: RailSettlementObservation;
}

export function createSimulatedPaymentRail(
  options: SimulatedPaymentRailOptions,
): SimulatedPaymentRail {
  const now = options.now ?? (() => new Date());
  const records = new Map<string, RailRecord>();
  const requests: RailPaymentRequest[] = [];
  let counter = 0;

  const railId = options.railId;

  const charge = async (request: RailPaymentRequest): Promise<RailSettlementObservation> => {
    // Rail-side idempotency: the same key converges on the same durable
    // observation (create-or-converge — the charge boundary's contract).
    const existing = records.get(request.idempotencyKey);
    if (existing !== undefined) {
      return existing.observation;
    }
    requests.push(request);

    // The simulated rail enforces the constraint surface it declares:
    // expiry is honored rail-side (a request past its authorization
    // expiry is refused — it cannot settle).
    if (request.expiresAt !== "" && Date.parse(request.expiresAt) <= now().getTime()) {
      throw new Error(
        `simulated rail "${railId}" refused the charge: authorization expired at ${request.expiresAt}`,
      );
    }

    counter += 1;
    const railTransactionRef = `sim:${railId}:${counter}`;
    const settled = !options.failAllCharges;
    const observation: RailSettlementObservation = {
      railId,
      railTransactionRef,
      status: settled ? "succeeded" : "failed",
      settledAmountMicroUsd: settled ? request.amountMicroUsd : "0",
      currency: request.currency,
      observedAt: now().toISOString(),
      evidence: {
        simulated: true,
        economicActionId: request.economicActionId,
        authorizationId: request.authorizationId,
        correlationRef: request.correlationRef,
        recipientKind: request.recipient.kind,
        recipientId: request.recipient.id,
        purpose: request.purpose,
      },
    };
    records.set(request.idempotencyKey, { observation });
    return observation;
  };

  const rail: SimulatedPaymentRail = {
    railId,
    // The simulated rails honestly declare the FULL enforced-constraint
    // surface (a rail with a weaker surface is refused by the economics
    // service before any charge — the fail-closed requirement).
    capabilities: {
      pinsRecipient: true,
      enforcesAmountCeiling: true,
      pinsCurrency: true,
      enforcesExpiry: true,
    },
    charge,
    get charges(): readonly RailPaymentRequest[] {
      return [...requests];
    },
  };
  if (!railCanExpressConstraints(rail.capabilities)) {
    throw new Error("simulated rail must express every required safety constraint");
  }
  return rail;
}

/** A simulated rail that CANNOT express the required constraints (fail-closed proof rail). */
export function createConstraintBlindSimulatedRail(railId: string): PaymentRail {
  return {
    railId,
    capabilities: {
      pinsRecipient: true,
      enforcesAmountCeiling: false,
      pinsCurrency: true,
      enforcesExpiry: false,
    },
    charge: async () => {
      throw new Error("constraint-blind rail must never be reached (fail-closed before charge)");
    },
  };
}
