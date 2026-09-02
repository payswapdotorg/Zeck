/**
 * Realtime voice session domain (deployments module domain; WORK-024,
 * MOD-005/MOD-006/MOD-007, ADR-0014 specialization).
 *
 * The provider-neutral REALTIME SESSION/CALL contract for web and
 * telephony-style channels. A realtime session is the channel-side twin
 * of a governed Execution: it is BOUND to (tenant, application,
 * deployment, PINNED deployment plan version, execution identity) —
 * MOD-006 — and every turn, interruption, transfer, failure and
 * significant action is preserved as EXECUTION provenance through the
 * executions authority (the deployments module's realtime ledger port →
 * the executions public step-event seam), never a second event
 * authority.
 *
 * Provider neutrality is structural (MOD-005/ADR-0014 invariant):
 *   - the channel vocabulary reuses the deployment fabric's neutral
 *     channel kinds (web / in-app / telephony — telephony-STYLE, never
 *     a vendor);
 *   - `channelSessionRef` is the upstream rail's OPAQUE session
 *     reference — vendor identifiers never cross this contract;
 *   - raw media is never domain state: turns carry bounded previews and
 *     ARTIFACT REFERENCES only (`payloadRef` lineage — the work order's
 *     "raw media outside the execution ledger" requirement).
 *
 * Turn routing (MOD-007): a realtime subtask may be DETERMINISTIC-only
 * (planner decision establishes generative inference is unnecessary) or
 * HYBRID/GENERATIVE (paid inference admissible) — the route class comes
 * from the planning module's deterministic-sufficiency decision through
 * the router port; this domain owns only the neutral vocabulary.
 *
 * This file is pure: no stores, no authorities, no I/O. It is NOT an
 * authority: no policy, capability, budget, secret or execution-state
 * decision lives here.
 */

import type { DeploymentChannelKind } from "./profile";

/** The realtime-capable subset of the neutral channel vocabulary. */
export const REALTIME_CHANNEL_KINDS: readonly DeploymentChannelKind[] = [
  "web",
  "in-app",
  "telephony",
];
export type RealtimeChannelKind = (typeof REALTIME_CHANNEL_KINDS)[number];

export function isRealtimeChannelKind(value: string): value is RealtimeChannelKind {
  return (REALTIME_CHANNEL_KINDS as readonly string[]).includes(value);
}

/**
 * The realtime session status machine. Small and subordinate (the
 * EXECUTION state machine is the runs authority — this one governs the
 * CHANNEL session only): `live → reconnecting → live` models reconnect
 * without a second session/execution; `closed/failed/transferred` are
 * terminal-immutable.
 */
export const REALTIME_SESSION_STATUSES = [
  "live",
  "reconnecting",
  "closed",
  "failed",
  "transferred",
] as const;
export type RealtimeSessionStatus = (typeof REALTIME_SESSION_STATUSES)[number];

export function isRealtimeSessionStatus(value: string): value is RealtimeSessionStatus {
  return (REALTIME_SESSION_STATUSES as readonly string[]).includes(value);
}

export const REALTIME_SESSION_TRANSITIONS: Readonly<
  Record<RealtimeSessionStatus, readonly RealtimeSessionStatus[]>
> = {
  live: ["live", "reconnecting", "closed", "failed", "transferred"],
  reconnecting: ["reconnecting", "live", "closed", "failed"],
  closed: [],
  failed: [],
  transferred: [],
};

export function canTransitionRealtimeSession(
  from: RealtimeSessionStatus,
  to: RealtimeSessionStatus,
): boolean {
  return REALTIME_SESSION_TRANSITIONS[from].includes(to);
}

export function isTerminalRealtimeSessionStatus(status: RealtimeSessionStatus): boolean {
  return status === "closed" || status === "failed" || status === "transferred";
}

/**
 * The realtime channel-journal event vocabulary. This journal records
 * CHANNEL/session state + inbound idempotency + the linkage to the
 * canonical execution-ledger envelopes (`ledgerSequence`); the canonical
 * provenance for turns/interruptions/transfers/failures rides the
 * EXECUTIONS ledger (the module's realtime ledger port) — this is not a
 * second event authority.
 */
export const REALTIME_EVENT_KINDS = [
  "session-started",
  "session-reattached",
  "session-completed",
  "session-failed",
  "turn-recorded",
  "interruption-recorded",
  "transfer-recorded",
  "failure-recorded",
] as const;
export type RealtimeEventKind = (typeof REALTIME_EVENT_KINDS)[number];

export function isRealtimeEventKind(value: string): value is RealtimeEventKind {
  return (REALTIME_EVENT_KINDS as readonly string[]).includes(value);
}

export const REALTIME_EVENT_DIRECTIONS = ["inbound", "outbound", "internal"] as const;
export type RealtimeEventDirection = (typeof REALTIME_EVENT_DIRECTIONS)[number];

/**
 * The turn route classes (MOD-007). `deterministic` = the planner
 * decision established deterministic sufficiency (no generative
 * inference, no paid dispatch); `hybrid` = deterministic-first with a
 * bounded evaluation/generative remainder; `generative` = generative
 * inference required (paid dispatch, full admission chain).
 */
export const REALTIME_ROUTE_CLASSES = ["deterministic", "hybrid", "generative"] as const;
export type RealtimeRouteClass = (typeof REALTIME_ROUTE_CLASSES)[number];

export function isRealtimeRouteClass(value: string): value is RealtimeRouteClass {
  return (REALTIME_ROUTE_CLASSES as readonly string[]).includes(value);
}

/** The inbound event kinds a rail can deliver into a session. */
export const REALTIME_INBOUND_KINDS = ["user-turn", "interruption", "caller-hangup"] as const;
export type RealtimeInboundKind = (typeof REALTIME_INBOUND_KINDS)[number];

export function isRealtimeInboundKind(value: string): value is RealtimeInboundKind {
  return (REALTIME_INBOUND_KINDS as readonly string[]).includes(value);
}

/** The immutable durable realtime session record. */
export interface RealtimeSessionRecord {
  readonly id: string;
  readonly applicationId: string;
  readonly tenantId: string;
  readonly deploymentId: string;
  /** MOD-007/AC7: the PINNED deployment plan version (immutable for the session lifetime). */
  readonly pinnedPlanId: string;
  readonly pinnedPlanVersion: number;
  /** MOD-006: the governed Execution this session maps to (reference only). */
  readonly executionId: string;
  readonly channelKind: RealtimeChannelKind;
  /** The upstream rail's OPAQUE session reference (never a vendor identifier). */
  readonly channelSessionRef: string;
  /** Reconnect discriminator: monotonic; reattach advances it. */
  readonly channelEpoch: number;
  /** Neutral caller identity supplied by the rail (bounded, never a secret). */
  readonly callerRef: string | null;
  readonly status: RealtimeSessionStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly closedAt: string | null;
}

/** The append-only realtime channel-journal record. */
export interface RealtimeEventRecord {
  readonly id: string;
  readonly applicationId: string;
  readonly tenantId: string;
  readonly sessionId: string;
  readonly deploymentId: string;
  readonly kind: RealtimeEventKind;
  readonly direction: RealtimeEventDirection;
  /**
   * The idempotency discriminator: the upstream-supplied event id when
   * the rail provides one, or the DETERMINISTIC SUBSTITUTE derived from
   * the session coordinates + occurrence ordinal otherwise (the work
   * order's implementation requirement).
   */
  readonly eventKey: string;
  readonly channelSessionRef: string;
  readonly channelEpoch: number;
  /** Provenance linkage: the execution envelope sequence, when the event has one. */
  readonly executionId: string | null;
  readonly ledgerSequence: number | null;
  /** Turn route class (turn events only). */
  readonly routeClass: RealtimeRouteClass | null;
  readonly cause: string | null;
  /** ARTIFACT REFERENCE for raw media (never the media itself). */
  readonly payloadRef: string | null;
  /** Bounded human-readable summary (never raw media, never secrets). */
  readonly payloadPreview: string | null;
  readonly actorId: string;
  readonly eventSeq: number;
  readonly bodyDigest: string;
  readonly createdAt: string;
}

/** Input of `startRealtimeSession` (validated fail-closed). */
export interface StartRealtimeSessionInput {
  readonly deploymentId: string;
  readonly channelKind: RealtimeChannelKind;
  /** The upstream rail's opaque session reference (web socket id, call id…). */
  readonly channelSessionRef: string;
  readonly callerRef?: string;
  /** The turn-transcript seed / initial utterance artifact reference, when present. */
  readonly initialPayloadRef?: string;
}

/** One inbound realtime event delivered by the rail (validated fail-closed). */
export interface RealtimeInboundEventInput {
  readonly sessionId: string;
  readonly channelSessionRef: string;
  readonly channelEpoch: number;
  readonly kind: RealtimeInboundKind;
  /**
   * The upstream-supplied idempotency identifier when the rail provides
   * one; omitted (undefined) when the adapter contract requires a
   * deterministic substitute.
   */
  readonly eventKey?: string;
  /** ARTIFACT REFERENCE of the raw media (never the media itself). */
  readonly payloadRef?: string;
  /** Bounded text transcript/preview of the inbound media. */
  readonly payloadPreview?: string;
  /** Rail-supplied occurrence ordinal (the deterministic-substitute input). */
  readonly occurrenceOrdinal?: number;
  /**
   * The turn's neutral subtask classification (the planner task kind —
   * deterministic-eligible kinds like data-retrieval/transformation vs
   * semantic kinds). Validated by the planner surface (fail closed);
   * defaults to a semantic route when omitted.
   */
  readonly subtaskKind?: string;
}

export type RealtimeValidation =
  | { readonly valid: true }
  | { readonly valid: false; readonly reason: string };

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const REF_PATTERN = /^[\x21-\x7e]{1,200}$/;
const PREVIEW_MAX = 512;
const PAYLOAD_REF_MAX = 512;
const KEY_MAX = 200;

/** Raw-secret VALUE patterns (the WORK-011 nine-pattern discipline). */
const RAW_SECRET_VALUE_PATTERNS: readonly RegExp[] = [
  /sk-[A-Za-z0-9]{16,}/,
  /AKIA[0-9A-Z]{16}/,
  /ghp_[A-Za-z0-9]{20,}/,
  /github_pat_[A-Za-z0-9_]{20,}/,
  /xox[baprs]-[A-Za-z0-9-]+/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./,
  /bearer\s+[A-Za-z0-9._-]{16,}/i,
  /(api[_-]?key|apikey|secret|password|passwd|token)\s*[:=]\s*["']?[^\s"']{8,}/i,
];

/** Whether a free-text value looks like a raw long-lived secret. */
export function realtimeContainsRawSecretValue(value: string): boolean {
  return RAW_SECRET_VALUE_PATTERNS.some((pattern) => pattern.test(value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Fail-closed validation of the session-start input. */
export function validateStartRealtimeSessionInput(input: unknown): RealtimeValidation {
  if (!isRecord(input)) {
    return { valid: false, reason: "realtime session input must be an object" };
  }
  const c = input as unknown as StartRealtimeSessionInput;
  if (typeof c.deploymentId !== "string" || !UUID_PATTERN.test(c.deploymentId)) {
    return { valid: false, reason: "deploymentId must be a UUID (the deployment fabric identity)" };
  }
  if (typeof c.channelKind !== "string" || !isRealtimeChannelKind(c.channelKind)) {
    return {
      valid: false,
      reason: `channelKind must be one of ${REALTIME_CHANNEL_KINDS.join("|")} (provider-neutral)`,
    };
  }
  if (typeof c.channelSessionRef !== "string" || !REF_PATTERN.test(c.channelSessionRef)) {
    return {
      valid: false,
      reason: "channelSessionRef must be the rail's printable opaque reference (1..200 chars)",
    };
  }
  if (
    c.callerRef !== undefined &&
    (typeof c.callerRef !== "string" || c.callerRef.length < 1 || c.callerRef.length > 200)
  ) {
    return { valid: false, reason: "callerRef must be 1..200 characters when present" };
  }
  for (const [field, value] of [
    ["callerRef", c.callerRef],
    ["initialPayloadRef", c.initialPayloadRef],
    ["channelSessionRef", c.channelSessionRef],
  ] as const) {
    if (value !== undefined && typeof value === "string" && realtimeContainsRawSecretValue(value)) {
      return { valid: false, reason: `${field} looks like it embeds a raw secret value` };
    }
  }
  if (
    c.initialPayloadRef !== undefined &&
    (typeof c.initialPayloadRef !== "string" || c.initialPayloadRef.length > PAYLOAD_REF_MAX)
  ) {
    return { valid: false, reason: "initialPayloadRef must be at most 512 characters" };
  }
  return { valid: true };
}

/** Fail-closed validation of one inbound realtime event. */
export function validateRealtimeInboundEvent(input: unknown): RealtimeValidation {
  if (!isRecord(input)) {
    return { valid: false, reason: "realtime inbound event must be an object" };
  }
  const e = input as unknown as RealtimeInboundEventInput;
  if (typeof e.sessionId !== "string" || !UUID_PATTERN.test(e.sessionId)) {
    return { valid: false, reason: "sessionId must be a UUID" };
  }
  if (typeof e.channelSessionRef !== "string" || !REF_PATTERN.test(e.channelSessionRef)) {
    return {
      valid: false,
      reason: "channelSessionRef must be a printable reference (1..200 chars)",
    };
  }
  if (
    typeof e.channelEpoch !== "number" ||
    !Number.isInteger(e.channelEpoch) ||
    e.channelEpoch < 1
  ) {
    return {
      valid: false,
      reason: "channelEpoch must be a positive integer (reconnect discriminator)",
    };
  }
  if (typeof e.kind !== "string" || !isRealtimeInboundKind(e.kind)) {
    return {
      valid: false,
      reason: `kind must be one of ${REALTIME_INBOUND_KINDS.join("|")}`,
    };
  }
  if (
    e.eventKey !== undefined &&
    (typeof e.eventKey !== "string" || e.eventKey.length < 1 || e.eventKey.length > KEY_MAX)
  ) {
    return { valid: false, reason: "eventKey must be 1..200 characters when supplied by the rail" };
  }
  if (
    e.occurrenceOrdinal !== undefined &&
    (!Number.isInteger(e.occurrenceOrdinal) || e.occurrenceOrdinal < 1)
  ) {
    return {
      valid: false,
      reason: "occurrenceOrdinal must be a positive integer (the deterministic-substitute input)",
    };
  }
  if (
    e.subtaskKind !== undefined &&
    (typeof e.subtaskKind !== "string" ||
      e.subtaskKind.length < 1 ||
      e.subtaskKind.length > 64 ||
      !/^[a-z][a-z0-9-]*$/.test(e.subtaskKind))
  ) {
    return {
      valid: false,
      reason: "subtaskKind must be a neutral task-kind slug (1..64 chars) when present",
    };
  }
  if (
    e.payloadRef !== undefined &&
    (typeof e.payloadRef !== "string" || e.payloadRef.length > PAYLOAD_REF_MAX)
  ) {
    return {
      valid: false,
      reason: "payloadRef must be an artifact reference of at most 512 characters",
    };
  }
  if (
    e.payloadPreview !== undefined &&
    (typeof e.payloadPreview !== "string" || e.payloadPreview.length > PREVIEW_MAX)
  ) {
    return { valid: false, reason: `payloadPreview must be at most ${PREVIEW_MAX} characters` };
  }
  for (const [field, value] of [
    ["payloadPreview", e.payloadPreview],
    ["payloadRef", e.payloadRef],
    ["eventKey", e.eventKey],
  ] as const) {
    if (value !== undefined && typeof value === "string" && realtimeContainsRawSecretValue(value)) {
      return { valid: false, reason: `${field} looks like it embeds a raw secret value` };
    }
  }
  return { valid: true };
}

/**
 * The DETERMINISTIC SUBSTITUTE idempotency key for rails that do not
 * supply event ids (the work order's implementation requirement):
 * session coordinates + kind + occurrence ordinal, digest-stable.
 */
export function deterministicRealtimeEventKey(input: {
  readonly sessionId: string;
  readonly channelEpoch: number;
  readonly kind: RealtimeInboundKind;
  readonly occurrenceOrdinal: number;
}): string {
  return `rt-${input.sessionId}-${input.channelEpoch}-${input.kind}-${input.occurrenceOrdinal}`;
}

/**
 * Deterministic session-creation fingerprint (the idempotency
 * discriminator): the same logical session start under the same key
 * replays; a different start under a reused key fails
 * `IDEMPOTENCY_KEY_REUSED`.
 */
export function realtimeSessionCreationFingerprint(
  applicationId: string,
  input: StartRealtimeSessionInput,
  executionId: string,
): string {
  return JSON.stringify([
    "deployments.realtime.session",
    applicationId,
    input.deploymentId,
    input.channelKind,
    input.channelSessionRef,
    input.callerRef ?? null,
    input.initialPayloadRef ?? null,
    executionId,
  ]);
}

/** Bounded event-body digest base (the dedupe discriminator). */
export function realtimeEventBodyDigestBase(input: {
  readonly sessionId: string;
  readonly kind: RealtimeEventKind;
  readonly direction: RealtimeEventDirection;
  readonly eventKey: string;
  readonly payloadRef: string | null;
  readonly payloadPreview: string | null;
}): string {
  return JSON.stringify([
    "deployments.realtime.event",
    input.sessionId,
    input.kind,
    input.direction,
    input.eventKey,
    input.payloadRef,
    input.payloadPreview,
  ]);
}
