/**
 * PPR-027 — the injected synthetic supply transport (the experiment's
 * provider-side world; NO live network, NO live provider).
 *
 * DETERMINISM LAW: every fault and latency draw is a pure function of
 * (streamKey, attempt, providerId, surface) via a SHA-256 hash — the
 * sweep is reproducible and resumable by construction, and the transport
 * is arm-agnostic (it cannot know or favor which arm is calling). The
 * draws are per-EXPOSURE, not per-logical-request: a re-issued request
 * (a fresh attempt or a fresh physical dispatch) draws fresh provider
 * behavior, exactly as a real provider would behave.
 *
 * FAIRNESS LAW: the transport is arm-agnostic — it knows request
 * attributes, never which arm is calling. Rate-limit/unavailable faults
 * consume no tokens; timeout faults consume the request's input tokens
 * (the declared partial-cost model — server-side processing happened).
 *
 * LABELING LAW: every cost figure this transport reports is derived from
 * the declared synthetic price schedule (config.ts) — never a provider
 * invoice.
 */

import { createHash } from "node:crypto";
import {
  PRICE_SCHEDULE,
  requestCostNanoUsd,
  SUPPLY_PROFILES,
  type SubjectEdge,
  type SupplyProfile,
  type WorkloadRequest,
} from "./config";

/** The fault classes the synthetic supply injects (declared, seeded). */
export type SupplyFaultCategory = "rate-limit" | "timeout" | "provider-unavailable";

export interface SupplyDispatchRequest {
  /** The synthetic provider endpoint addressed (supply-a/b/c). */
  readonly providerId: string;
  /** The subject edge the request belongs to (surface + modality class). */
  readonly edge: SubjectEdge;
  /** The workload request (declared token volumes). */
  readonly request: WorkloadRequest;
  /**
   * The stable stream key of this logical request (cell:task:index) —
   * identical across arms and repetitions, so draws are stable.
   */
  readonly streamKey: string;
  /** The attempt number (1 = first dispatch; retries increment). */
  readonly attempt: number;
}

export type SupplyDispatchOutcome =
  | {
      readonly ok: true;
      readonly latencyMs: number;
      readonly usage: { readonly inputTokens: number; readonly outputTokens: number };
      readonly costNanoUsd: number;
    }
  | {
      readonly ok: false;
      readonly category: SupplyFaultCategory;
      readonly retryable: boolean;
      readonly latencyMs: number;
      /** Timeout faults charge the input tokens (the declared partial-cost model). */
      readonly costNanoUsd: number;
      readonly usage: { readonly inputTokens: number; readonly outputTokens: number };
    };

/** Deterministic draw value in [0, 10000) for (streamKey, attempt, providerId, salt). */
function drawPermyriad(
  streamKey: string,
  attempt: number,
  providerId: string,
  salt: string,
): number {
  const digest = createHash("sha256")
    .update(`${streamKey}:${attempt}:${providerId}:${salt}`)
    .digest();
  // First 4 bytes as a big-endian UNSIGNED uint32 (multiplication, never
  // 32-bit bitwise ops — a signed overflow would skew the draw space),
  // mapped to [0, 10000).
  const value =
    (digest[0] ?? 0) * 0x1_0000_00 +
    (digest[1] ?? 0) * 0x1_0000 +
    (digest[2] ?? 0) * 0x100 +
    (digest[3] ?? 0);
  return Math.floor((value / 0x1_0000_0000) * 10_000);
}

function profileOf(providerId: string): SupplyProfile {
  const profile = SUPPLY_PROFILES.find((candidate) => candidate.providerId === providerId);
  if (profile === undefined) {
    throw new Error(`unknown synthetic supply profile ${providerId}`);
  }
  return profile;
}

/** The deterministic latency of one dispatch attempt (before real sleeping). */
export function drawnLatencyMs(dispatch: SupplyDispatchRequest): number {
  const profile = profileOf(dispatch.providerId);
  const surfaceMultiplier =
    profile.surfaceLatencyMultiplier[
      dispatch.edge.modalityClass as keyof SupplyProfile["surfaceLatencyMultiplier"]
    ] ?? 1;
  const jitter = drawPermyriad(
    dispatch.streamKey,
    dispatch.attempt,
    dispatch.providerId,
    "latency-jitter",
  );
  return (
    (profile.baseLatencyMs + Math.round((jitter / 10_000) * profile.latencyJitterMs)) *
    surfaceMultiplier
  );
}

/** The deterministic fault (if any) of one dispatch attempt. */
export function drawnFault(
  dispatch: SupplyDispatchRequest,
): { readonly category: SupplyFaultCategory; readonly retryable: boolean } | null {
  const profile = profileOf(dispatch.providerId);
  const draw = drawPermyriad(dispatch.streamKey, dispatch.attempt, dispatch.providerId, "fault");
  if (draw < profile.rateLimitFaultPermyriad) {
    return { category: "rate-limit", retryable: true };
  }
  if (draw < profile.rateLimitFaultPermyriad + profile.timeoutFaultPermyriad) {
    return { category: "timeout", retryable: true };
  }
  if (
    draw <
    profile.rateLimitFaultPermyriad +
      profile.timeoutFaultPermyriad +
      profile.unavailableFaultPermyriad
  ) {
    return { category: "provider-unavailable", retryable: false };
  }
  return null;
}

/** The full outcome of one dispatch attempt (pure — no sleeping). */
export function outcomeOf(dispatch: SupplyDispatchRequest): SupplyDispatchOutcome {
  const latencyMs = drawnLatencyMs(dispatch);
  const fault = drawnFault(dispatch);
  const fullCost = requestCostNanoUsd(dispatch.request, dispatch.edge);
  if (fault === null) {
    return {
      ok: true,
      latencyMs,
      usage: {
        inputTokens: dispatch.request.inputTokens,
        outputTokens: dispatch.request.outputTokens,
      },
      costNanoUsd: fullCost,
    };
  }
  const perToken =
    PRICE_SCHEDULE.perTokenNanoUsd[
      dispatch.edge.modalityClass as keyof typeof PRICE_SCHEDULE.perTokenNanoUsd
    ];
  const timeoutPartialCost =
    fault.category === "timeout"
      ? Math.round(dispatch.request.inputTokens * (perToken?.input ?? 0))
      : 0;
  return {
    ok: false,
    category: fault.category,
    retryable: fault.retryable,
    latencyMs,
    costNanoUsd: timeoutPartialCost,
    usage: {
      inputTokens: fault.category === "timeout" ? dispatch.request.inputTokens : 0,
      outputTokens: 0,
    },
  };
}

export interface SyntheticSupplyTransport {
  /** Dispatch one attempt (sleeps the drawn latency — injectable for tests). */
  dispatch(dispatch: SupplyDispatchRequest): Promise<SupplyDispatchOutcome>;
  /** The transport's accounting facts (for the cell result). */
  readonly facts: () => {
    readonly dispatches: number;
    readonly nanoCharged: number;
    readonly faults: { readonly category: SupplyFaultCategory; readonly providerId: string }[];
  };
}

export interface SyntheticSupplyOptions {
  /** The sleeper (defaults to real setTimeout; injectable for hermetic tests). */
  readonly sleeper?: (ms: number) => Promise<void>;
}

/** Create the synthetic supply transport (one per ARM per cell — fresh
 * accounting; the fault/latency draws are pure hash functions, so separate
 * per-arm instances see IDENTICAL provider behavior for the same logical
 * request stream). */
export function createSyntheticSupply(
  options: SyntheticSupplyOptions = {},
): SyntheticSupplyTransport {
  const sleep =
    options.sleeper ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let dispatches = 0;
  let nanoCharged = 0;
  const faults: { category: SupplyFaultCategory; providerId: string }[] = [];
  return {
    async dispatch(dispatch) {
      dispatches += 1;
      const outcome = outcomeOf(dispatch);
      await sleep(outcome.latencyMs);
      nanoCharged += outcome.costNanoUsd;
      if (!outcome.ok) {
        faults.push({ category: outcome.category, providerId: dispatch.providerId });
      }
      return outcome;
    },
    facts: () => ({ dispatches, nanoCharged, faults: [...faults] }),
  };
}
