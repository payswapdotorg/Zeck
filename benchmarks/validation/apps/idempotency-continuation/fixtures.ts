/**
 * The idempotency-and-continuation application's deterministic fixtures
 * (VAL-021, AC2).
 *
 * The controlled effect world the platform driver executes against:
 * a settlement/notification ledger whose counters are the
 * exactly-once multiplicity oracle (the world itself is deliberately
 * NOT idempotent — a double settlement double-counts, so any replay
 * that re-applied an effect is mechanically visible), a deterministic
 * external-continuation input (the wait-user park's arriving answer),
 * and a scripted escalation authority that RECEIVES routed escalations
 * (the exactly-once routing oracle — a re-routed escalation
 * double-counts).
 *
 * The fault-injected dispatch replays the transient transport-failure
 * shapes the retry rows inject (the bounded-retry storm), recording
 * every dispatch call's request digest (reproducibility — identical
 * requests digest identically).
 *
 * Zero network, zero credentials: every offline corpus row is
 * reproducible through these fixtures alone.
 */

import type {
  ContinuationDispatch,
  ContinuationEffectSpec,
  ContinuationEffectWorld,
  EffectJournalRecord,
  EscalationDecision,
  EscalationDecisionSource,
} from "../../platform/idempotency-continuation";

// ---------------------------------------------------------------------------
// The settlement effect world (the exactly-once multiplicity oracle)
// ---------------------------------------------------------------------------

/** The settlement world's own observable state (the fixture counters). */
export interface SettlementWorldState {
  /** invoiceId → the number of times it was settled (the double-settlement detector). */
  readonly settlements: Readonly<Record<string, number>>;
  /** invoiceId → the number of notifications sent. */
  readonly notifications: Readonly<Record<string, number>>;
  /** The journal records the world observed (the sequence-continuity oracle). */
  readonly journal: readonly EffectJournalRecord[];
}

export interface SettlementEffectWorld extends ContinuationEffectWorld {
  readonly state: SettlementWorldState;
}

/**
 * Create the settlement effect world. The world is deliberately
 * NON-idempotent: `settle` increments a per-invoice counter every
 * time it is called — the PLATFORM's idempotency machinery is what
 * must prevent the double settlement, and a violation is mechanically
 * visible in these counters.
 */
export function createSettlementWorld(): SettlementEffectWorld {
  const settlements: Record<string, number> = {};
  const notifications: Record<string, number> = {};
  const journal: EffectJournalRecord[] = [];
  const observedCounts: Record<string, number> = {};

  const world: SettlementEffectWorld = {
    state: {
      get settlements() {
        return { ...settlements };
      },
      get notifications() {
        return { ...notifications };
      },
      get journal() {
        return [...journal];
      },
    },
    observedCounts,
    apply(effect) {
      if (effect.kind === "settle") {
        settlements[effect.key] = (settlements[effect.key] ?? 0) + 1;
        observedCounts[effect.effect] = (observedCounts[effect.effect] ?? 0) + 1;
        return { ok: true, value: `settled ${effect.key} for ${effect.amountMicro} micro-USD` };
      }
      if (effect.kind === "notify") {
        notifications[effect.key] = (notifications[effect.key] ?? 0) + 1;
        observedCounts[effect.effect] = (observedCounts[effect.effect] ?? 0) + 1;
        return { ok: true, value: `notified ${effect.key}` };
      }
      return { ok: false, value: `unknown effect kind ${String(effect.kind)}` };
    },
    continuationInput(atSegment) {
      // The deterministic external-continuation table: every park's
      // arriving answer is recorded here (a rejected continuation is
      // the honest FAILED boundary — none in the pinned corpus).
      if (atSegment === 1) {
        return { ok: true, value: "approved: proceed with the settlement batch" };
      }
      return { ok: true, value: "approved: proceed with the final settlement" };
    },
    journalHook(record) {
      journal.push(record);
    },
  };
  return world;
}

// ---------------------------------------------------------------------------
// The escalation authority fixture (the exactly-once routing oracle)
// ---------------------------------------------------------------------------

/** One escalation the scripted authority RECEIVED. */
export interface AuthorityReceipt {
  readonly gateId: string;
  readonly authority: string;
  readonly causalChain: readonly { readonly cause: string; readonly digest: string }[];
  readonly receivedAt: number;
}

export interface EscalationAuthorityFixture extends EscalationDecisionSource {
  /** The declared authority identity (the corpus row's declared destination). */
  readonly authority: string;
  /** The escalations the authority actually RECEIVED (a re-route double-counts). */
  readonly received: readonly AuthorityReceipt[];
}

/**
 * Create the scripted escalation authority: decisions come from a
 * RECORDED fixture table (deterministic provenance — never a
 * fabricated live operator); `receive` records every ROUTED escalation
 * (the lifecycle binding calls it on actual routing only — a replayed
 * escalation never reaches it, which is exactly the exactly-once
 * routing oracle).
 */
export function createScriptedEscalationAuthority(options: {
  readonly authority: string;
  /** depth → decision (default: "escalate" once). */
  readonly decisions?: Readonly<Record<number, EscalationDecision>>;
}): EscalationAuthorityFixture {
  const received: AuthorityReceipt[] = [];
  return {
    authority: options.authority,
    received,
    decide({ depth }) {
      return options.decisions?.[depth] ?? "escalate";
    },
  };
}

/** Record one ROUTED escalation with the scripted authority (the binding calls this). */
export function receiveEscalation(
  fixture: EscalationAuthorityFixture,
  input: {
    readonly gateId: string;
    readonly authority: string;
    readonly causalChain: readonly { readonly cause: string; readonly digest: string }[];
  },
): void {
  (fixture.received as AuthorityReceipt[]).push({
    gateId: input.gateId,
    authority: input.authority,
    causalChain: [...input.causalChain],
    receivedAt: fixture.received.length + 1,
  });
}

// ---------------------------------------------------------------------------
// The fault-injected dispatch (the bounded-retry storm)
// ---------------------------------------------------------------------------

/** The retry-storm scenarios the fault-injected dispatch understands. */
export type DispatchFaultScenario =
  // attempts 1..2 fail with transport-failure, attempt 3 succeeds
  | "transport-fail-twice-then-success"
  // every attempt fails with transport-failure (the exhausted budget)
  | "transport-fail-always";

export interface FaultedDispatch {
  readonly dispatch: ContinuationDispatch;
  /** Every call's request digest (reproducibility). */
  readonly calls: readonly string[];
}

/**
 * Build the deterministic fault-injected dispatch for one retry-storm
 * scenario: replays the scripted failure/success sequence, recording
 * every call's request digest (identical requests digest
 * identically — every retry addresses the same logical request).
 */
export function createFaultedDispatch(options: {
  readonly scenario: DispatchFaultScenario;
}): FaultedDispatch {
  const calls: string[] = [];
  const dispatch: ContinuationDispatch = async (input) => {
    // The request digest is over the LOGICAL request (execution +
    // segment) — the attempt number is journal metadata, NOT part of
    // the request: every retry of the same logical request carries
    // the SAME digest (the reproducibility contract).
    const requestDigest = digestOfRequest({
      executionId: input.executionId,
      segment: input.segment,
    });
    calls.push(requestDigest);
    const latencyMs = 5;
    if (options.scenario === "transport-fail-always") {
      return {
        kind: "failure",
        category: "transport-failure",
        message: "fetch failed: ECONNREFUSED (injected transport fault)",
        latencyMs,
        requestDigest,
      };
    }
    // transport-fail-twice-then-success: the first TWO attempts fail.
    if (calls.length <= 2) {
      return {
        kind: "failure",
        category: "transport-failure",
        message: `fetch failed: ETIMEDOUT (injected transient transport fault, attempt ${calls.length})`,
        latencyMs,
        requestDigest,
      };
    }
    return {
      kind: "success",
      content: "continue",
      usage: { inputTokens: 24, outputTokens: 1, costUsd: 0.000021 },
      latencyMs,
      requestDigest,
    };
  };
  return { dispatch, calls };
}

function digestOfRequest(value: unknown): string {
  const text = JSON.stringify(value) ?? "null";
  let hash = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

// ---------------------------------------------------------------------------
// The settlement effect spec builders (the corpus's declared work)
// ---------------------------------------------------------------------------

export function settle(invoiceId: string, amountMicro: number): ContinuationEffectSpec {
  return { effect: `settle:${invoiceId}`, kind: "settle", key: invoiceId, amountMicro };
}

export function notify(invoiceId: string): ContinuationEffectSpec {
  return { effect: `notify:${invoiceId}`, kind: "notify", key: invoiceId, amountMicro: 0 };
}
