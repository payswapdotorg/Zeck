/**
 * Edge execution governance domain (edge integration; WORK-029,
 * EDGE-001/002/003).
 *
 * THE governed edge/real-time/embodied model — Zeck is the
 * GOVERNANCE/ORCHESTRATION plane, NEVER the safety-critical control
 * loop:
 *
 *   - a DEVICE (robot, industrial cell, vehicle controller, medical
 *     device …) is a tenant-scoped, REVOCABLE execution target with
 *     provider-neutral capability evidence and health metadata. Device
 *     identity never crosses vendor specifics: `controllerRef` is an
 *     OPAQUE reference to the replaceable controller adapter;
 *   - a SAFETY ENVELOPE is the pre-authorized bound under which edge
 *     execution may continue while disconnected from Zeck: the neutral
 *     actuator channels, per-channel magnitude and rate bounds, the
 *     command window, the authorized command budget and the
 *     disconnected-continuation policy. An envelope is admitted only
 *     through the full authority chain (policy + capability + budget +
 *     HUMAN approval) and is IMMUTABLE once admitted — the content
 *     digest is pinned at admission; the only stored moves are an
 *     authorized SUPERSEDE (a NEW envelope admission that references
 *     and replaces it) and an authorized REVOCATION (fail-safe
 *     termination only — revocation tightens, never loosens);
 *   - a COMMAND is a governed submission to the external controller:
 *     it carries the staleness window (notBefore/notAfter) and is
 *     dispatched to the actuator path ONLY after the full admission
 *     chain AND the envelope coverage check AND (for physical side
 *     effects) a bound, approved, unexpired HUMAN approval record;
 *     stale, replayed or unauthorized commands NEVER reach the actuator
 *     path (typed rejection, zero actuator activity);
 *   - the AUTHORITATIVE command stream per device is a gapless
 *     sequence INCLUDING denied requests; dispatched commands strictly
 *     ASCEND the sequence (no out-of-order authoritative commands);
 *   - RECONCILIATION after reconnect is deterministic and
 *     conflict-safe: the controller reports its executed journal;
 *     commanded actuations match authorized+dispatched commands by
 *     (key, digest, sequence) and settle EXACTLY ONCE; autonomous
 *     actuations within the envelope bounds are confirmed with
 *     provenance; out-of-envelope, unauthorized, stale or
 *     out-of-order executions are durable VIOLATIONS and fail the
 *     reconciliation closed (no further authoritative commands are
 *     dispatched to a conflicted device);
 *   - sensor observations, commands and actuation events are
 *     PROVENANCE: every durable row keys on the Zeck execution
 *     identity and the canonical evidence rides the executions
 *     EventEnvelope ledger through the frozen recordStepEvent seam
 *     (the tools producer vocabulary `tool-requested` /
 *     `tool-result` / `tool-denied` — the WORK-027 discipline; this
 *     integration owns NO ledger vocabulary and never writes execution
 *     status);
 *   - the LOCAL controller owns hard real time: envelope enforcement
 *     while disconnected, sequence discipline and the actuation
 *     journal happen on the device side. Zeck's request/response path
 *     is governance (admission, envelopes, commands, reconciliation) —
 *     there is no synchronous actuation loop through this service.
 *
 * Security model at this layer (fail-closed, pure, total):
 *   - every public input shape is VALIDATED before any durable state
 *     (malformed declarations never become governable state);
 *   - approvals are re-validated at dispatch over the FULL binding
 *     chain (subject fingerprint + device + execution + status +
 *     expiry) — an approval for one command never authorizes another
 *     (the WORK-011 agent-approval discipline, reused);
 *   - envelope coverage is a PURE function checked before the external
 *     dispatch and re-checked by the local controller (defense in
 *     depth: the actuator path is behind TWO bound checks);
 *   - content digests are computed over the canonical key-sorted JSON
 *     form (jsonb does not preserve key order — the WORK-026 lesson).
 */

// ---------------------------------------------------------------------------
// The canonical JSON + digest discipline (the shared house shape)
// ---------------------------------------------------------------------------

/** Canonical JSON: sorted keys, no whitespace (digest-stable). */
export function canonicalEdgeJson(value: unknown): string {
  const canon = (input: unknown): unknown => {
    if (input === null || typeof input !== "object") {
      return input === undefined ? null : input;
    }
    if (Array.isArray(input)) {
      return input.map(canon);
    }
    const entries = Object.entries(input as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    const out: Record<string, unknown> = {};
    for (const [key, val] of entries) {
      out[key] = canon(val);
    }
    return out;
  };
  return JSON.stringify(canon(value));
}

/** The bounded idempotency-key shape (the house rule). */
export const EDGE_KEY_PATTERN = /^[\x21-\x7e]{1,200}$/;

// ---------------------------------------------------------------------------
// Devices: tenant-scoped, revocable identities with health metadata
// ---------------------------------------------------------------------------

export const EDGE_DEVICE_STATUSES = ["registered", "revoked"] as const;
export type EdgeDeviceStatus = (typeof EDGE_DEVICE_STATUSES)[number];

export function isEdgeDeviceStatus(value: string): value is EdgeDeviceStatus {
  return (EDGE_DEVICE_STATUSES as readonly string[]).includes(value);
}

/** Terminal device statuses (revocation is terminal — identities are never resurrected). */
export const TERMINAL_EDGE_DEVICE_STATUSES: readonly EdgeDeviceStatus[] = ["revoked"];

export function isTerminalEdgeDeviceStatus(status: EdgeDeviceStatus): boolean {
  return TERMINAL_EDGE_DEVICE_STATUSES.includes(status);
}

/**
 * Neutral workload classes an edge/embodied target serves — the frozen
 * CSX-002 vocabulary subset relevant at the edge boundary (mirrored BY
 * VALUE from the capabilities module's `WORKLOAD_CLASSES`, exactly the
 * way the substrate domain mirrors the isolation ladder; pinned by the
 * architecture gate).
 */
export const EDGE_WORKLOAD_CLASSES = [
  "interactive",
  "realtime",
  "asynchronous",
  "edge",
  "embodied",
] as const;
export type EdgeWorkloadClass = (typeof EDGE_WORKLOAD_CLASSES)[number];

export function isEdgeWorkloadClass(value: string): value is EdgeWorkloadClass {
  return (EDGE_WORKLOAD_CLASSES as readonly string[]).includes(value);
}

/** Provider-neutral device health statuses (the health metadata vocabulary). */
export const EDGE_HEALTH_STATUSES = ["healthy", "degraded", "unreachable"] as const;
export type EdgeHealthStatus = (typeof EDGE_HEALTH_STATUSES)[number];

export function isEdgeHealthStatus(value: string): value is EdgeHealthStatus {
  return (EDGE_HEALTH_STATUSES as readonly string[]).includes(value);
}

/** One health report (append-only evidence; the device row carries the latest). */
export interface EdgeHealthReport {
  readonly status: EdgeHealthStatus;
  /** Neutral metric facts (bounded; never vendor telemetry). */
  readonly metrics: Readonly<Record<string, number>>;
  readonly reportedAt: string;
  /** Free-form operator note (bounded, never a secret). */
  readonly note?: string;
}

export interface EdgeDeviceRegistrationRequest {
  readonly applicationId: string;
  readonly actor: { readonly actorId: string; readonly tenantId: string };
  /** Operator label for the target (bounded; never a vendor name). */
  readonly label: string;
  /** The workload classes the target serves (>= 1). */
  readonly workloadClasses: readonly EdgeWorkloadClass[];
  /**
   * Neutral capability atoms the target DECLARES it can do — evidence
   * for the capability authority, never authority itself.
   */
  readonly capabilityAtoms: readonly string[];
  /**
   * OPAQUE reference to the controller adapter that mediates this
   * device (the replaceable-adapter seam; vendor specifics never cross).
   */
  readonly controllerRef: string;
}

export interface EdgeDeviceRecord {
  readonly id: string;
  readonly applicationId: string;
  readonly tenantId: string;
  /** Caller idempotency key (unique per application). */
  readonly deviceKey: string;
  readonly requestFingerprint: string;
  readonly label: string;
  readonly workloadClasses: readonly EdgeWorkloadClass[];
  readonly capabilityAtoms: readonly string[];
  readonly controllerRef: string;
  readonly status: EdgeDeviceStatus;
  /** The latest health metadata (denormalized from the append-only reports). */
  readonly health: EdgeHealthReport | null;
  /** The last authorized command sequence allocated to this device (gapless, includes denied). */
  readonly lastCommandSequence: number;
  /** The last DISPATCHED command sequence (strictly ascending dispatch order). */
  readonly lastDispatchedSequence: number;
  readonly createdAt: string;
  readonly revokedAt: string | null;
  readonly revocationReason: string | null;
}

// ---------------------------------------------------------------------------
// Human approvals (the WORK-011 approval discipline, reused for edge)
// ---------------------------------------------------------------------------

export const EDGE_APPROVAL_STATUSES = ["pending", "approved", "denied", "expired"] as const;
export type EdgeApprovalStatus = (typeof EDGE_APPROVAL_STATUSES)[number];

export function isEdgeApprovalStatus(value: string): value is EdgeApprovalStatus {
  return (EDGE_APPROVAL_STATUSES as readonly string[]).includes(value);
}

/** Terminal approval statuses (the record is immutable from there on). */
export const TERMINAL_EDGE_APPROVAL_STATUSES: readonly EdgeApprovalStatus[] = [
  "approved",
  "denied",
  "expired",
];

export function isTerminalEdgeApprovalStatus(status: EdgeApprovalStatus): boolean {
  return TERMINAL_EDGE_APPROVAL_STATUSES.includes(status);
}

/** The governed subjects a human approval can gate. */
export const EDGE_APPROVAL_SUBJECT_KINDS = ["envelope", "command"] as const;
export type EdgeApprovalSubjectKind = (typeof EDGE_APPROVAL_SUBJECT_KINDS)[number];

export function isEdgeApprovalSubjectKind(value: string): value is EdgeApprovalSubjectKind {
  return (EDGE_APPROVAL_SUBJECT_KINDS as readonly string[]).includes(value);
}

export interface EdgeApprovalRequestInput {
  readonly applicationId: string;
  readonly actor: { readonly actorId: string; readonly tenantId: string };
  readonly executionId: string;
  readonly deviceId: string;
  readonly subjectKind: EdgeApprovalSubjectKind;
  /**
   * The request FINGERPRINT of the subject being approved (an approval
   * authorizes exactly one subject shape — re-validated at dispatch).
   */
  readonly subjectFingerprint: string;
  /** The policy basis recorded at gate engagement (the "why"). */
  readonly policyBasis: string;
  readonly expiresAt: string | null;
}

export interface EdgeApprovalDecisionInput {
  readonly applicationId: string;
  readonly actor: { readonly actorId: string; readonly tenantId: string };
  readonly approvalId: string;
  /** WHO decided (attributable human identity — mandatory). */
  readonly approverId: string;
  readonly decision: "approved" | "denied";
  /** Why the decision was reached (mandatory provenance). */
  readonly rationale: string;
}

export interface EdgeApprovalRecord {
  readonly id: string;
  readonly applicationId: string;
  readonly tenantId: string;
  readonly executionId: string;
  readonly deviceId: string;
  readonly subjectKind: EdgeApprovalSubjectKind;
  readonly subjectFingerprint: string;
  readonly policyBasis: string;
  readonly status: EdgeApprovalStatus;
  readonly approvalKey: string;
  readonly requestedAt: string;
  readonly decidedAt: string | null;
  readonly approverId: string | null;
  readonly decision: "approved" | "denied" | null;
  readonly expiresAt: string | null;
  /** Ledger sequence of the wait-human transition envelope. */
  readonly ledgerWaitSequence: number | null;
  /** Ledger sequence of the resume transition envelope. */
  readonly ledgerResumeSequence: number | null;
}

/**
 * Does this approval authorize its subject NOW? The full binding chain
 * re-validation (status + expiry) — the dispatch-time half; the subject
 * fingerprint, device and execution bindings are checked by the caller
 * against the live request (an approval for one subject never
 * authorizes another).
 */
export function edgeApprovalAuthorizes(
  approval: { readonly status: EdgeApprovalStatus; readonly expiresAt: string | null },
  now: string,
): boolean {
  if (approval.status !== "approved") {
    return false;
  }
  if (approval.expiresAt !== null && Date.parse(approval.expiresAt) <= Date.parse(now)) {
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Safety envelopes: the pre-authorized disconnected-continuation bounds
// ---------------------------------------------------------------------------

export const EDGE_ENVELOPE_STATUSES = ["admitted", "superseded", "revoked"] as const;
export type EdgeEnvelopeStatus = (typeof EDGE_ENVELOPE_STATUSES)[number];

export function isEdgeEnvelopeStatus(value: string): value is EdgeEnvelopeStatus {
  return (EDGE_ENVELOPE_STATUSES as readonly string[]).includes(value);
}

export const TERMINAL_EDGE_ENVELOPE_STATUSES: readonly EdgeEnvelopeStatus[] = [
  "superseded",
  "revoked",
];

export function isTerminalEdgeEnvelopeStatus(status: EdgeEnvelopeStatus): boolean {
  return TERMINAL_EDGE_ENVELOPE_STATUSES.includes(status);
}

/**
 * The neutral actuator channel vocabulary (provider-neutral atoms; a
 * real fleet maps its hardware to these — vendor specifics never cross).
 */
export const EDGE_ACTUATOR_CHANNELS = [
  "locomotion",
  "manipulation",
  "process-control",
  "signal",
  "display",
] as const;
export type EdgeActuatorChannel = (typeof EDGE_ACTUATOR_CHANNELS)[number];

export function isEdgeActuatorChannel(value: string): value is EdgeActuatorChannel {
  return (EDGE_ACTUATOR_CHANNELS as readonly string[]).includes(value);
}

/**
 * The capability atom a commanded actuator channel resolves through the
 * capability registry (the REAL authority): a device governable on a
 * channel declares this atom in its capability evidence.
 */
export const EDGE_CHANNEL_ATOM_PREFIX = "edge-channel:";

export function edgeChannelAtom(channel: EdgeActuatorChannel): string {
  return `${EDGE_CHANNEL_ATOM_PREFIX}${channel}`;
}

/** The normalized magnitude scale (a neutral signed scale, never vendor units). */
export const EDGE_MAGNITUDE_MIN = -1000;
export const EDGE_MAGNITUDE_MAX = 1000;

export const EDGE_DISCONNECTED_POLICIES = ["hold", "continue-within-envelope"] as const;
export type EdgeDisconnectedPolicy = (typeof EDGE_DISCONNECTED_POLICIES)[number];

export function isEdgeDisconnectedPolicy(value: string): value is EdgeDisconnectedPolicy {
  return (EDGE_DISCONNECTED_POLICIES as readonly string[]).includes(value);
}

/**
 * THE safety envelope content — the bounds edge execution must respect
 * while disconnected (and that the LOCAL controller enforces on the
 * actuator path). IMMUTABLE once admitted: the digest is pinned at
 * admission; a changed bound is a NEW envelope that supersedes this one
 * through its own full admission.
 */
export interface EdgeSafetyEnvelopeContent {
  /** The actuator channels the envelope authorizes (>= 1). */
  readonly channels: readonly EdgeActuatorChannel[];
  /** Per-channel signed magnitude bounds on the normalized scale. */
  readonly magnitudeBounds: Readonly<Record<EdgeActuatorChannel, [number, number]>>;
  /** Per-channel actuation rate bound (actuations per minute). */
  readonly rateBoundsPerMinute: Readonly<Record<EdgeActuatorChannel, number>>;
  /** The window in which commands under this envelope are valid. */
  readonly notBefore: string;
  readonly notAfter: string;
  /** The maximum number of authorized commands under this envelope. */
  readonly maxCommands: number;
  /**
   * The disconnected-continuation policy: "hold" (pause authorized work
   * on disconnect) or "continue-within-envelope" (the explicit
   * pre-authorization for disconnected execution).
   */
  readonly disconnectedPolicy: EdgeDisconnectedPolicy;
}

export interface EdgeEnvelopeAdmissionRequest {
  readonly applicationId: string;
  readonly actor: { readonly actorId: string; readonly tenantId: string };
  readonly executionId: string;
  readonly deviceId: string;
  readonly content: EdgeSafetyEnvelopeContent;
  /**
   * The envelope-scoped cost ceiling (integer micro-USD string, "0" =
   * uncosted): the accumulated command estimates under this envelope
   * may never exceed it (checked at EVERY command admission — the
   * envelope is the budget scope; the wallet reservation is per
   * command, the spender).
   */
  readonly costCeilingMicroUsd: string;
  /**
   * The APPROVED human approval bound to THIS admission's fingerprint
   * (envelope admission is the safety-critical pre-authorization — a
   * human signs off on it; re-validated before admission).
   */
  readonly approvalId: string;
  /** Supersede an existing admitted envelope (a NEW authorized admission). */
  readonly supersedesEnvelopeId: string | null;
}

export interface EdgeEnvelopeRecord {
  readonly id: string;
  readonly applicationId: string;
  readonly tenantId: string;
  readonly executionId: string;
  readonly deviceId: string;
  readonly envelopeKey: string;
  readonly requestFingerprint: string;
  readonly contentDigest: string;
  readonly content: EdgeSafetyEnvelopeContent;
  readonly status: EdgeEnvelopeStatus;
  /** The admission bundle (policy evidence + capability + budget + approval). */
  readonly admission: EdgeEnvelopeAdmission;
  readonly supersedesEnvelopeId: string | null;
  readonly supersededByEnvelopeId: string | null;
  readonly commandCount: number;
  readonly createdAt: string;
  readonly supersededAt: string | null;
  readonly revokedAt: string | null;
  readonly revocationReason: string | null;
}

export interface EdgeEnvelopeAdmission {
  readonly policyEvidence: EdgePolicyEvidence | null;
  readonly capabilitySatisfaction: string | null;
  readonly budgetOperationId: string | null;
  readonly costCeilingMicroUsd: string;
  readonly approvalId: string;
}

export interface EdgePolicyEvidence {
  readonly policySetId: string;
  readonly policySetVersion: number;
  readonly policyContentHash: string;
  readonly restrictionSetDigest: string;
}

// ---------------------------------------------------------------------------
// Commands: governed submission to external controllers
// ---------------------------------------------------------------------------

export const EDGE_COMMAND_KINDS = ["actuate", "configure", "halt", "poll"] as const;
export type EdgeCommandKind = (typeof EDGE_COMMAND_KINDS)[number];

export function isEdgeCommandKind(value: string): value is EdgeCommandKind {
  return (EDGE_COMMAND_KINDS as readonly string[]).includes(value);
}

/**
 * The effect classes (the side-effect classification — the human-approval
 * discriminator: PHYSICAL-WRITE commands require a bound approved human
 * approval; the others still require the full policy/capability chain).
 */
export const EDGE_COMMAND_EFFECT_CLASSES = [
  "physical-write",
  "device-config",
  "telemetry-read",
] as const;
export type EdgeCommandEffectClass = (typeof EDGE_COMMAND_EFFECT_CLASSES)[number];

export const EDGE_COMMAND_EFFECT_CLASS_BY_KIND: Readonly<
  Record<EdgeCommandKind, EdgeCommandEffectClass>
> = {
  actuate: "physical-write",
  configure: "device-config",
  halt: "device-config",
  poll: "telemetry-read",
};

export const EDGE_COMMAND_STATUSES = [
  "denied",
  "authorized",
  "dispatched",
  "settled",
  "failed",
  "invalidated",
  "conflicted",
] as const;
export type EdgeCommandStatus = (typeof EDGE_COMMAND_STATUSES)[number];

export function isEdgeCommandStatus(value: string): value is EdgeCommandStatus {
  return (EDGE_COMMAND_STATUSES as readonly string[]).includes(value);
}

export const TERMINAL_EDGE_COMMAND_STATUSES: readonly EdgeCommandStatus[] = [
  "denied",
  "settled",
  "failed",
  "invalidated",
  "conflicted",
];

export function isTerminalEdgeCommandStatus(status: EdgeCommandStatus): boolean {
  return TERMINAL_EDGE_COMMAND_STATUSES.includes(status);
}

export interface EdgeCommandRequest {
  readonly applicationId: string;
  readonly actor: { readonly actorId: string; readonly tenantId: string };
  readonly executionId: string;
  readonly deviceId: string;
  readonly envelopeId: string;
  readonly commandKind: EdgeCommandKind;
  /** The actuator channel the command targets. */
  readonly channel: EdgeActuatorChannel;
  /** The commanded magnitude on the normalized scale. */
  readonly magnitude: number;
  /** The command body (bounded structured payload; digested, never raw secrets). */
  readonly payload: Readonly<Record<string, unknown>>;
  /** The staleness window — the command is invalid outside it. */
  readonly notBefore: string;
  readonly notAfter: string;
  /** The estimated cost of the physical action, integer micro-USD ("0" = uncosted). */
  readonly estimatedMicroUsd: string;
  /**
   * The APPROVED human approval bound to THIS command's fingerprint
   * (required for physical-write kinds — the governed physical side
   * effect; rejected otherwise, fail-closed).
   */
  readonly approvalId: string | null;
}

export interface EdgeCommandRecord {
  readonly id: string;
  readonly applicationId: string;
  readonly tenantId: string;
  readonly executionId: string;
  readonly deviceId: string;
  readonly envelopeId: string;
  readonly commandKey: string;
  readonly requestFingerprint: string;
  readonly sequence: number;
  readonly commandKind: EdgeCommandKind;
  readonly effectClass: EdgeCommandEffectClass;
  readonly channel: EdgeActuatorChannel;
  readonly magnitude: number;
  readonly payloadDigest: string;
  /** The declared spend estimate (integer micro-USD string; "0" = uncosted). */
  readonly estimatedMicroUsd: string;
  readonly notBefore: string;
  readonly notAfter: string;
  readonly status: EdgeCommandStatus;
  readonly denialClass: string | null;
  readonly denialReason: string | null;
  readonly approvalId: string | null;
  readonly failureClass: string | null;
  readonly failureMessage: string | null;
  /** The ACTUATION DIGEST the local controller acknowledged at dispatch (the reconciliation binding). */
  readonly dispatchDigest: string | null;
  readonly usageMicroUsd: string | null;
  readonly dispatchedAt: string | null;
  readonly settledAt: string | null;
  readonly reconciledAt: string | null;
  readonly createdAt: string;
  readonly ledgerRequestedSequence: number | null;
  readonly ledgerResultSequence: number | null;
}

// ---------------------------------------------------------------------------
// Provenance: sensors, actuations, reconciliations
// ---------------------------------------------------------------------------

/** Neutral sensor observation types (the provenance vocabulary). */
export const EDGE_SENSOR_OBSERVATION_TYPES = ["telemetry", "state", "event", "anomaly"] as const;
export type EdgeSensorObservationType = (typeof EDGE_SENSOR_OBSERVATION_TYPES)[number];

export function isEdgeSensorObservationType(value: string): value is EdgeSensorObservationType {
  return (EDGE_SENSOR_OBSERVATION_TYPES as readonly string[]).includes(value);
}

/** Retention classes (ephemeral observations carry NO content, digest only). */
export const EDGE_SENSOR_RETENTIONS = ["retained", "ephemeral"] as const;
export type EdgeSensorRetention = (typeof EDGE_SENSOR_RETENTIONS)[number];

export function isEdgeSensorRetention(value: string): value is EdgeSensorRetention {
  return (EDGE_SENSOR_RETENTIONS as readonly string[]).includes(value);
}

export interface EdgeSensorObservationInput {
  readonly applicationId: string;
  readonly actor: { readonly actorId: string; readonly tenantId: string };
  readonly executionId: string;
  readonly deviceId: string;
  readonly observationType: EdgeSensorObservationType;
  readonly retention: EdgeSensorRetention;
  /** Digest is computed by the service; content is stored only when retained. */
  readonly content: string | null;
  readonly observedAt: string;
}

export interface EdgeSensorObservationRecord {
  readonly id: string;
  readonly applicationId: string;
  readonly tenantId: string;
  readonly executionId: string;
  readonly deviceId: string;
  readonly sequence: number;
  readonly observationKey: string;
  readonly observationType: EdgeSensorObservationType;
  readonly retention: EdgeSensorRetention;
  readonly contentDigest: string;
  readonly content: string | null;
  readonly observedAt: string;
  readonly ledgerSequence: number | null;
}

/**
 * The actuation classes: a COMMANDED actuation executes an authorized
 * command; an ENVELOPE-AUTONOMOUS actuation happened within the
 * pre-authorized envelope bounds without a command (the disconnected
 * continuation); a VIOLATION is anything outside the authorization.
 */
export const EDGE_ACTUATION_CLASSES = ["commanded", "envelope-autonomous", "violation"] as const;
export type EdgeActuationClass = (typeof EDGE_ACTUATION_CLASSES)[number];

export function isEdgeActuationClass(value: string): value is EdgeActuationClass {
  return (EDGE_ACTUATION_CLASSES as readonly string[]).includes(value);
}

export const EDGE_VIOLATION_KINDS = [
  "out-of-envelope",
  "unauthorized-command",
  "stale-execution",
  "out-of-order",
  "digest-mismatch",
] as const;
export type EdgeViolationKind = (typeof EDGE_VIOLATION_KINDS)[number];

export interface EdgeActuationEventRecord {
  readonly id: string;
  readonly applicationId: string;
  readonly tenantId: string;
  readonly executionId: string | null;
  readonly deviceId: string;
  /** The matched command (commanded class only). */
  readonly commandId: string | null;
  readonly commandKey: string | null;
  readonly sequence: number | null;
  readonly actuationClass: EdgeActuationClass;
  /** The violation kind (violation class only). */
  readonly violationKind: string | null;
  readonly channel: EdgeActuatorChannel | null;
  readonly magnitude: number | null;
  readonly actuationDigest: string;
  readonly occurredAt: string;
  readonly reconciledAt: string;
  readonly reconciliationId: string | null;
}

export interface EdgeReconciliationRecord {
  readonly id: string;
  readonly applicationId: string;
  readonly tenantId: string;
  readonly deviceId: string;
  readonly reportDigest: string;
  readonly status: "converged" | "conflict";
  readonly confirmedCount: number;
  readonly autonomousCount: number;
  readonly violationCount: number;
  readonly settledCount: number;
  readonly reconciledAt: string;
}

// ---------------------------------------------------------------------------
// The reconciliation report contract (the local controller's report)
// ---------------------------------------------------------------------------

/** One executed actuation entry the local controller reports. */
export interface EdgeReportedActuation {
  /** The command key (commanded entries; null for autonomous/violations). */
  readonly commandKey: string | null;
  /** The command's authoritative sequence (commanded entries). */
  readonly sequence: number | null;
  readonly channel: EdgeActuatorChannel;
  readonly magnitude: number;
  readonly actuationDigest: string;
  readonly occurredAt: string;
}

export interface EdgeReconciliationReport {
  readonly deviceId: string;
  readonly executed: readonly EdgeReportedActuation[];
  /**
   * Entries the local controller REFUSED (stale or out-of-order
   * commands that never reached the actuator path — the local
   * fail-safe evidence).
   */
  readonly refused: readonly {
    readonly commandKey: string;
    readonly sequence: number | null;
    readonly reason: string;
  }[];
  readonly reportedAt: string;
}

// ---------------------------------------------------------------------------
// Pure validation (fail-closed, total)
// ---------------------------------------------------------------------------

const fingerprintOf = (value: unknown): string => canonicalEdgeJson(value);

export { fingerprintOf as edgeFingerprintOf };

/** The maximum number of neutral metric facts on one health report. */
export const EDGE_HEALTH_METRIC_MAX = 32;

export function validateEdgeHealthReport(
  input: unknown,
): { readonly valid: true } | { readonly valid: false; readonly reason: string } {
  if (typeof input !== "object" || input === null) {
    return { valid: false, reason: "health report must be an object" };
  }
  const report = input as Record<string, unknown>;
  if (typeof report.status !== "string" || !isEdgeHealthStatus(report.status)) {
    return {
      valid: false,
      reason: `health status "${String(report.status)}" is not in the health vocabulary`,
    };
  }
  const metrics = report.metrics;
  if (typeof metrics !== "object" || metrics === null || Array.isArray(metrics)) {
    return { valid: false, reason: "metrics must be an object of neutral numeric facts" };
  }
  const entries = Object.entries(metrics as Record<string, unknown>);
  if (entries.length > EDGE_HEALTH_METRIC_MAX) {
    return {
      valid: false,
      reason: `metrics must carry at most ${EDGE_HEALTH_METRIC_MAX} facts`,
    };
  }
  for (const [key, value] of entries) {
    if (key.length === 0 || key.length > 120) {
      return { valid: false, reason: "metric names must be bounded (max 120)" };
    }
    if (typeof value !== "number" || !Number.isFinite(value)) {
      return {
        valid: false,
        reason: `metric "${key}" must be a finite number (never a secret or a string)`,
      };
    }
  }
  if (
    report.note !== undefined &&
    report.note !== null &&
    (typeof report.note !== "string" || report.note.length > 2000)
  ) {
    return { valid: false, reason: "note must be a bounded string when present" };
  }
  if (typeof report.reportedAt !== "string" || Number.isNaN(Date.parse(report.reportedAt))) {
    return { valid: false, reason: "reportedAt must be an ISO-8601 timestamp" };
  }
  return { valid: true };
}

const boundedString = (value: unknown, max: number): value is string =>
  typeof value === "string" && value.length > 0 && value.length <= max;

export function validateEdgeDeviceRegistration(
  input: unknown,
): { readonly valid: true } | { readonly valid: false; readonly reason: string } {
  if (typeof input !== "object" || input === null) {
    return { valid: false, reason: "device registration must be an object" };
  }
  const request = input as Record<string, unknown>;
  if (!boundedString(request.applicationId, 200)) {
    return { valid: false, reason: "applicationId must be a non-empty string" };
  }
  const actor = request.actor as Record<string, unknown> | undefined;
  if (
    typeof actor !== "object" ||
    actor === null ||
    !boundedString(actor.actorId, 200) ||
    !boundedString(actor.tenantId, 200)
  ) {
    return { valid: false, reason: "actor.actorId and actor.tenantId must be non-empty strings" };
  }
  if (!boundedString(request.label, 200)) {
    return { valid: false, reason: "label must be a non-empty string (max 200)" };
  }
  if (!Array.isArray(request.workloadClasses) || request.workloadClasses.length === 0) {
    return { valid: false, reason: "workloadClasses must be a non-empty array" };
  }
  for (const item of request.workloadClasses) {
    if (typeof item !== "string" || !isEdgeWorkloadClass(item)) {
      return {
        valid: false,
        reason: `workloadClass "${String(item)}" is not in the edge workload vocabulary`,
      };
    }
  }
  if (new Set(request.workloadClasses as string[]).size !== request.workloadClasses.length) {
    return { valid: false, reason: "workloadClasses must not repeat" };
  }
  if (!Array.isArray(request.capabilityAtoms) || request.capabilityAtoms.length === 0) {
    return { valid: false, reason: "capabilityAtoms must be a non-empty array" };
  }
  for (const item of request.capabilityAtoms) {
    if (typeof item !== "string" || item.length === 0 || item.length > 200) {
      return { valid: false, reason: "each capability atom must be a bounded string" };
    }
  }
  if (!boundedString(request.controllerRef, 200)) {
    return {
      valid: false,
      reason: "controllerRef must be a non-empty opaque reference string (max 200)",
    };
  }
  return { valid: true };
}

export function validateEdgeEnvelopeRequest(
  input: unknown,
): { readonly valid: true } | { readonly valid: false; readonly reason: string } {
  if (typeof input !== "object" || input === null) {
    return { valid: false, reason: "envelope admission must be an object" };
  }
  const request = input as Record<string, unknown>;
  if (!boundedString(request.applicationId, 200)) {
    return { valid: false, reason: "applicationId must be a non-empty string" };
  }
  const actor = request.actor as Record<string, unknown> | undefined;
  if (
    typeof actor !== "object" ||
    actor === null ||
    !boundedString(actor.actorId, 200) ||
    !boundedString(actor.tenantId, 200)
  ) {
    return { valid: false, reason: "actor.actorId and actor.tenantId must be non-empty strings" };
  }
  if (!boundedString(request.executionId, 200) || !boundedString(request.deviceId, 200)) {
    return { valid: false, reason: "executionId and deviceId must be non-empty strings" };
  }
  if (!boundedString(request.approvalId, 200)) {
    return {
      valid: false,
      reason: "approvalId must be a non-empty string (human pre-authorization)",
    };
  }
  if (
    request.supersedesEnvelopeId !== undefined &&
    request.supersedesEnvelopeId !== null &&
    !boundedString(request.supersedesEnvelopeId, 200)
  ) {
    return { valid: false, reason: "supersedesEnvelopeId must be a bounded string when present" };
  }
  if (
    typeof request.costCeilingMicroUsd !== "string" ||
    !/^\d{1,16}$/.test(request.costCeilingMicroUsd)
  ) {
    return {
      valid: false,
      reason:
        "costCeilingMicroUsd must be a non-negative integer micro-USD string (max 16 digits; 0 = uncosted)",
    };
  }
  const content = request.content as Record<string, unknown> | undefined;
  if (typeof content !== "object" || content === null) {
    return { valid: false, reason: "content (the safety envelope) must be an object" };
  }
  if (!Array.isArray(content.channels) || content.channels.length === 0) {
    return { valid: false, reason: "envelope channels must be a non-empty array" };
  }
  for (const channel of content.channels) {
    if (typeof channel !== "string" || !isEdgeActuatorChannel(channel)) {
      return {
        valid: false,
        reason: `actuator channel "${String(channel)}" is not in the neutral vocabulary`,
      };
    }
  }
  if (new Set(content.channels as string[]).size !== content.channels.length) {
    return { valid: false, reason: "envelope channels must not repeat" };
  }
  const magnitudeBounds = content.magnitudeBounds as Record<string, unknown> | undefined;
  if (typeof magnitudeBounds !== "object" || magnitudeBounds === null) {
    return { valid: false, reason: "magnitudeBounds must be an object" };
  }
  const rateBounds = content.rateBoundsPerMinute as Record<string, unknown> | undefined;
  if (typeof rateBounds !== "object" || rateBounds === null) {
    return { valid: false, reason: "rateBoundsPerMinute must be an object" };
  }
  for (const channel of content.channels as string[]) {
    const bound = magnitudeBounds[channel];
    if (
      !Array.isArray(bound) ||
      bound.length !== 2 ||
      typeof bound[0] !== "number" ||
      typeof bound[1] !== "number" ||
      !Number.isInteger(bound[0]) ||
      !Number.isInteger(bound[1]) ||
      bound[0] > bound[1] ||
      bound[0] < EDGE_MAGNITUDE_MIN ||
      bound[1] > EDGE_MAGNITUDE_MAX
    ) {
      return {
        valid: false,
        reason: `magnitude bound for channel "${channel}" must be an integer pair [min,max] within the normalized scale with min <= max`,
      };
    }
    const rate = rateBounds[channel];
    if (typeof rate !== "number" || !Number.isInteger(rate) || rate < 1 || rate > 100000) {
      return {
        valid: false,
        reason: `rate bound for channel "${channel}" must be an integer in [1,100000] actuations/minute`,
      };
    }
  }
  const notBefore = content.notBefore;
  const notAfter = content.notAfter;
  if (typeof notBefore !== "string" || Number.isNaN(Date.parse(notBefore))) {
    return { valid: false, reason: "content.notBefore must be an ISO-8601 timestamp" };
  }
  if (typeof notAfter !== "string" || Number.isNaN(Date.parse(notAfter))) {
    return { valid: false, reason: "content.notAfter must be an ISO-8601 timestamp" };
  }
  if (Date.parse(notAfter) <= Date.parse(notBefore)) {
    return { valid: false, reason: "envelope window must have notBefore < notAfter" };
  }
  const maxCommands = content.maxCommands;
  if (
    typeof maxCommands !== "number" ||
    !Number.isInteger(maxCommands) ||
    maxCommands < 1 ||
    maxCommands > 100000
  ) {
    return { valid: false, reason: "maxCommands must be an integer in [1,100000]" };
  }
  const disconnectedPolicy = content.disconnectedPolicy;
  if (typeof disconnectedPolicy !== "string" || !isEdgeDisconnectedPolicy(disconnectedPolicy)) {
    return {
      valid: false,
      reason: `disconnectedPolicy must be one of ${EDGE_DISCONNECTED_POLICIES.join("|")}`,
    };
  }
  return { valid: true };
}

export function validateEdgeCommandRequest(
  input: unknown,
): { readonly valid: true } | { readonly valid: false; readonly reason: string } {
  if (typeof input !== "object" || input === null) {
    return { valid: false, reason: "command request must be an object" };
  }
  const request = input as Record<string, unknown>;
  if (!boundedString(request.applicationId, 200)) {
    return { valid: false, reason: "applicationId must be a non-empty string" };
  }
  const actor = request.actor as Record<string, unknown> | undefined;
  if (
    typeof actor !== "object" ||
    actor === null ||
    !boundedString(actor.actorId, 200) ||
    !boundedString(actor.tenantId, 200)
  ) {
    return { valid: false, reason: "actor.actorId and actor.tenantId must be non-empty strings" };
  }
  if (
    !boundedString(request.executionId, 200) ||
    !boundedString(request.deviceId, 200) ||
    !boundedString(request.envelopeId, 200)
  ) {
    return {
      valid: false,
      reason: "executionId, deviceId and envelopeId must be non-empty strings",
    };
  }
  if (typeof request.commandKind !== "string" || !isEdgeCommandKind(request.commandKind)) {
    return {
      valid: false,
      reason: `commandKind "${String(request.commandKind)}" is not in the neutral vocabulary`,
    };
  }
  if (typeof request.channel !== "string" || !isEdgeActuatorChannel(request.channel)) {
    return {
      valid: false,
      reason: `channel "${String(request.channel)}" is not in the neutral actuator vocabulary`,
    };
  }
  if (
    typeof request.magnitude !== "number" ||
    !Number.isInteger(request.magnitude) ||
    request.magnitude < EDGE_MAGNITUDE_MIN ||
    request.magnitude > EDGE_MAGNITUDE_MAX
  ) {
    return {
      valid: false,
      reason: `magnitude must be an integer within [${EDGE_MAGNITUDE_MIN},${EDGE_MAGNITUDE_MAX}]`,
    };
  }
  if (
    typeof request.payload !== "object" ||
    request.payload === null ||
    Array.isArray(request.payload)
  ) {
    return { valid: false, reason: "payload must be an object" };
  }
  const payloadText = canonicalEdgeJson(request.payload);
  if (payloadText.length > 8192) {
    return { valid: false, reason: "payload must be bounded (canonical form max 8192 chars)" };
  }
  if (typeof request.notBefore !== "string" || Number.isNaN(Date.parse(request.notBefore))) {
    return { valid: false, reason: "notBefore must be an ISO-8601 timestamp" };
  }
  if (typeof request.notAfter !== "string" || Number.isNaN(Date.parse(request.notAfter))) {
    return { valid: false, reason: "notAfter must be an ISO-8601 timestamp" };
  }
  if (Date.parse(request.notAfter) <= Date.parse(request.notBefore)) {
    return { valid: false, reason: "command window must have notBefore < notAfter" };
  }
  if (
    typeof request.estimatedMicroUsd !== "string" ||
    !/^\d{1,16}$/.test(request.estimatedMicroUsd)
  ) {
    return {
      valid: false,
      reason: "estimatedMicroUsd must be a non-negative integer micro-USD string (max 16 digits)",
    };
  }
  if (
    request.approvalId !== undefined &&
    request.approvalId !== null &&
    !boundedString(request.approvalId, 200)
  ) {
    return { valid: false, reason: "approvalId must be a bounded string when present" };
  }
  return { valid: true };
}

export function validateEdgeApprovalRequest(
  input: unknown,
): { readonly valid: true } | { readonly valid: false; readonly reason: string } {
  if (typeof input !== "object" || input === null) {
    return { valid: false, reason: "approval request must be an object" };
  }
  const request = input as Record<string, unknown>;
  if (!boundedString(request.applicationId, 200)) {
    return { valid: false, reason: "applicationId must be a non-empty string" };
  }
  const actor = request.actor as Record<string, unknown> | undefined;
  if (
    typeof actor !== "object" ||
    actor === null ||
    !boundedString(actor.actorId, 200) ||
    !boundedString(actor.tenantId, 200)
  ) {
    return { valid: false, reason: "actor.actorId and actor.tenantId must be non-empty strings" };
  }
  if (
    !boundedString(request.executionId, 200) ||
    !boundedString(request.deviceId, 200) ||
    !boundedString(request.subjectFingerprint, 8192)
  ) {
    return {
      valid: false,
      reason: "executionId, deviceId and subjectFingerprint must be bounded strings",
    };
  }
  if (typeof request.subjectKind !== "string" || !isEdgeApprovalSubjectKind(request.subjectKind)) {
    return { valid: false, reason: "subjectKind must be envelope|command" };
  }
  if (!boundedString(request.policyBasis, 500)) {
    return { valid: false, reason: "policyBasis must be a bounded string (the why)" };
  }
  if (
    request.expiresAt !== undefined &&
    request.expiresAt !== null &&
    (typeof request.expiresAt !== "string" || Number.isNaN(Date.parse(request.expiresAt)))
  ) {
    return { valid: false, reason: "expiresAt must be an ISO-8601 timestamp when present" };
  }
  return { valid: true };
}

export function validateEdgeApprovalDecision(
  input: unknown,
): { readonly valid: true } | { readonly valid: false; readonly reason: string } {
  if (typeof input !== "object" || input === null) {
    return { valid: false, reason: "approval decision must be an object" };
  }
  const request = input as Record<string, unknown>;
  if (!boundedString(request.applicationId, 200)) {
    return { valid: false, reason: "applicationId must be a non-empty string" };
  }
  const actor = request.actor as Record<string, unknown> | undefined;
  if (
    typeof actor !== "object" ||
    actor === null ||
    !boundedString(actor.actorId, 200) ||
    !boundedString(actor.tenantId, 200)
  ) {
    return { valid: false, reason: "actor.actorId and actor.tenantId must be non-empty strings" };
  }
  if (!boundedString(request.approvalId, 200)) {
    return { valid: false, reason: "approvalId must be a non-empty string" };
  }
  if (!boundedString(request.approverId, 200)) {
    return {
      valid: false,
      reason: "approverId must be a non-empty string (attributable human identity)",
    };
  }
  if (request.decision !== "approved" && request.decision !== "denied") {
    return { valid: false, reason: "decision must be approved|denied" };
  }
  if (!boundedString(request.rationale, 2000)) {
    return {
      valid: false,
      reason: "rationale must be a non-empty string (why the decision was reached)",
    };
  }
  return { valid: true };
}

export function validateEdgeSensorObservation(
  input: unknown,
): { readonly valid: true } | { readonly valid: false; readonly reason: string } {
  if (typeof input !== "object" || input === null) {
    return { valid: false, reason: "sensor observation must be an object" };
  }
  const request = input as Record<string, unknown>;
  if (!boundedString(request.applicationId, 200)) {
    return { valid: false, reason: "applicationId must be a non-empty string" };
  }
  const actor = request.actor as Record<string, unknown> | undefined;
  if (
    typeof actor !== "object" ||
    actor === null ||
    !boundedString(actor.actorId, 200) ||
    !boundedString(actor.tenantId, 200)
  ) {
    return { valid: false, reason: "actor.actorId and actor.tenantId must be non-empty strings" };
  }
  if (!boundedString(request.executionId, 200) || !boundedString(request.deviceId, 200)) {
    return { valid: false, reason: "executionId and deviceId must be non-empty strings" };
  }
  if (
    typeof request.observationType !== "string" ||
    !isEdgeSensorObservationType(request.observationType)
  ) {
    return {
      valid: false,
      reason: `observationType "${String(request.observationType)}" is not in the vocabulary`,
    };
  }
  if (typeof request.retention !== "string" || !isEdgeSensorRetention(request.retention)) {
    return { valid: false, reason: "retention must be retained|ephemeral" };
  }
  if (request.content !== undefined && request.content !== null) {
    if (typeof request.content !== "string" || request.content.length > 16384) {
      return { valid: false, reason: "content must be a bounded string (max 16384) when present" };
    }
    if (request.retention === "ephemeral") {
      return {
        valid: false,
        reason: "ephemeral observations carry NO content (digest-only, fail-closed)",
      };
    }
  }
  if (
    request.retention === "retained" &&
    (request.content === null || request.content === undefined)
  ) {
    return {
      valid: false,
      reason: "retained observations carry their content (ephemeral is the digest-only class)",
    };
  }
  if (typeof request.observedAt !== "string" || Number.isNaN(Date.parse(request.observedAt))) {
    return { valid: false, reason: "observedAt must be an ISO-8601 timestamp" };
  }
  return { valid: true };
}

// ---------------------------------------------------------------------------
// Pure checks: envelope coverage + command staleness (the safety core)
// ---------------------------------------------------------------------------

/**
 * Does the envelope cover this command NOW? The PURE coverage check —
 * evaluated by the service BEFORE the external dispatch and re-enforced
 * by the LOCAL controller on the actuator path (defense in depth).
 * Fail-closed on every dimension.
 */
export function edgeEnvelopeCoversCommand(
  envelope: {
    readonly status: EdgeEnvelopeStatus;
    readonly content: EdgeSafetyEnvelopeContent;
    readonly commandCount: number;
  },
  command: {
    readonly channel: EdgeActuatorChannel;
    readonly magnitude: number;
    readonly notBefore: string;
    readonly notAfter: string;
  },
  now: string,
): { readonly covered: true } | { readonly covered: false; readonly reason: string } {
  if (envelope.status !== "admitted") {
    return {
      covered: false,
      reason: `the safety envelope is ${envelope.status} (not admitted)`,
    };
  }
  const content = envelope.content;
  if (!content.channels.includes(command.channel)) {
    return {
      covered: false,
      reason: `actuator channel "${command.channel}" is not within the envelope's authorized channels`,
    };
  }
  const bound = content.magnitudeBounds[command.channel];
  if (bound === undefined || command.magnitude < bound[0] || command.magnitude > bound[1]) {
    return {
      covered: false,
      reason: `command magnitude ${command.magnitude} is outside the envelope bound for channel "${command.channel}"`,
    };
  }
  if (Date.parse(now) < Date.parse(content.notBefore)) {
    return {
      covered: false,
      reason: "the envelope window has not opened yet",
    };
  }
  if (Date.parse(now) >= Date.parse(content.notAfter)) {
    return { covered: false, reason: "the envelope window has expired" };
  }
  if (Date.parse(command.notBefore) < Date.parse(content.notBefore)) {
    return {
      covered: false,
      reason: "the command window opens before the envelope window (not covered)",
    };
  }
  if (Date.parse(command.notAfter) > Date.parse(content.notAfter)) {
    return {
      covered: false,
      reason: "the command window extends beyond the envelope window (not covered)",
    };
  }
  if (envelope.commandCount >= content.maxCommands) {
    return {
      covered: false,
      reason: `the envelope's authorized command budget (${content.maxCommands}) is exhausted`,
    };
  }
  return { covered: true };
}

/** The staleness evaluation: fresh | too-early | stale (fail-closed). */
export function edgeCommandFreshness(
  command: { readonly notBefore: string; readonly notAfter: string },
  now: string,
): "fresh" | "too-early" | "stale" {
  if (Date.parse(now) < Date.parse(command.notBefore)) {
    return "too-early";
  }
  if (Date.parse(now) >= Date.parse(command.notAfter)) {
    return "stale";
  }
  return "fresh";
}

// ---------------------------------------------------------------------------
// The closed operation/tool vocabularies (the governed surface)
// ---------------------------------------------------------------------------

/**
 * The closed set of governed edge side-effecting operations — every one
 * of them flows through the durable, recoverable operation state (the
 * WORK-024 standard; pinned by the architecture gate).
 */
export const EDGE_OPERATION_KINDS = [
  "device-register",
  "device-revoke",
  "health-report",
  "envelope-admit",
  "envelope-revoke",
  "command-submit",
  "approval-request",
  "approval-decide",
  "sensor-ingest",
  "reconcile",
] as const;
export type EdgeOperationKind = (typeof EDGE_OPERATION_KINDS)[number];

export function isEdgeOperationKind(value: string): value is EdgeOperationKind {
  return (EDGE_OPERATION_KINDS as readonly string[]).includes(value);
}

/**
 * The closed tool-fact vocabulary the policy authority evaluates for
 * every governed edge operation (one policy dimension per fact — the
 * same evaluation every other tool seam uses).
 */
export const EDGE_TOOL_FACTS = {
  deviceRegister: "edge:device-register",
  deviceRevoke: "edge:device-revoke",
  envelopeAdmit: "edge:envelope-admit",
  envelopeRevoke: "edge:envelope-revoke",
  commandSubmit: "edge:command-submit",
  sensorIngest: "edge:sensor-ingest",
  reconcile: "edge:reconcile",
} as const;

// ---------------------------------------------------------------------------
// Stable key families (idempotency keys — one external effect per key)
// ---------------------------------------------------------------------------

export const EDGE_KEY_PREFIXES = {
  ledgerEvent: "edge-ledger",
  deviceRegisterOperation: "edge-op-device-register",
  deviceRevokeOperation: "edge-op-device-revoke",
  envelopeAdmitOperation: "edge-op-envelope-admit",
  envelopeRevokeOperation: "edge-op-envelope-revoke",
  commandSubmitOperation: "edge-op-command-submit",
  approvalRequestOperation: "edge-op-approval-request",
  approvalDecideOperation: "edge-op-approval-decide",
  sensorIngestOperation: "edge-op-sensor-ingest",
  reconcileOperation: "edge-op-reconcile",
  envelopeProjectExternal: "edge-external-envelope",
  commandDispatchExternal: "edge-external-command-dispatch",
  budgetReserve: "edge-budget-reserve",
  budgetSettle: "edge-budget-settle",
  budgetRelease: "edge-budget-release",
} as const;

export function edgeDeviceRegisterOperationKey(idempotencyKey: string): string {
  return `${EDGE_KEY_PREFIXES.deviceRegisterOperation}:${idempotencyKey}`;
}

export function edgeDeviceRevokeOperationKey(idempotencyKey: string): string {
  return `${EDGE_KEY_PREFIXES.deviceRevokeOperation}:${idempotencyKey}`;
}

export function edgeEnvelopeAdmitOperationKey(idempotencyKey: string): string {
  return `${EDGE_KEY_PREFIXES.envelopeAdmitOperation}:${idempotencyKey}`;
}

export function edgeEnvelopeRevokeOperationKey(idempotencyKey: string): string {
  return `${EDGE_KEY_PREFIXES.envelopeRevokeOperation}:${idempotencyKey}`;
}

export function edgeCommandSubmitOperationKey(idempotencyKey: string): string {
  return `${EDGE_KEY_PREFIXES.commandSubmitOperation}:${idempotencyKey}`;
}

export function edgeApprovalRequestOperationKey(idempotencyKey: string): string {
  return `${EDGE_KEY_PREFIXES.approvalRequestOperation}:${idempotencyKey}`;
}

export function edgeApprovalDecideOperationKey(idempotencyKey: string): string {
  return `${EDGE_KEY_PREFIXES.approvalDecideOperation}:${idempotencyKey}`;
}

export function edgeSensorIngestOperationKey(idempotencyKey: string): string {
  return `${EDGE_KEY_PREFIXES.sensorIngestOperation}:${idempotencyKey}`;
}

export function edgeReconcileOperationKey(idempotencyKey: string): string {
  return `${EDGE_KEY_PREFIXES.reconcileOperation}:${idempotencyKey}`;
}

export function edgeEnvelopeProjectExternalKey(envelopeId: string, status: string): string {
  return `${EDGE_KEY_PREFIXES.envelopeProjectExternal}:${envelopeId}:${status}`;
}

export function edgeCommandDispatchExternalKey(commandId: string): string {
  return `${EDGE_KEY_PREFIXES.commandDispatchExternal}:${commandId}`;
}

export function edgeBudgetReserveKey(commandId: string): string {
  return `${EDGE_KEY_PREFIXES.budgetReserve}:${commandId}`;
}

/** The wallet operation id of one command's reservation (derived, stable). */
export function edgeBudgetOperationId(commandId: string): string {
  return `edge-budget:${commandId}`;
}

export function edgeBudgetSettleKey(commandId: string): string {
  return `${EDGE_KEY_PREFIXES.budgetSettle}:${commandId}`;
}

export function edgeBudgetReleaseKey(commandId: string): string {
  return `${EDGE_KEY_PREFIXES.budgetRelease}:${commandId}`;
}

export function edgeLedgerEventKey(scope: string, phase: string): string {
  return `${EDGE_KEY_PREFIXES.ledgerEvent}:${scope}:${phase}`;
}

// ---------------------------------------------------------------------------
// Fingerprint helpers (the request arbitration digests)
// ---------------------------------------------------------------------------

export function edgeDeviceFingerprint(request: EdgeDeviceRegistrationRequest): string {
  return fingerprintOf({
    label: request.label,
    workloadClasses: [...request.workloadClasses].sort(),
    capabilityAtoms: [...request.capabilityAtoms].sort(),
    controllerRef: request.controllerRef,
  });
}

export function edgeEnvelopeFingerprint(request: EdgeEnvelopeAdmissionRequest): string {
  return fingerprintOf({
    executionId: request.executionId,
    deviceId: request.deviceId,
    content: request.content,
    costCeilingMicroUsd: request.costCeilingMicroUsd,
    approvalId: request.approvalId,
    supersedesEnvelopeId: request.supersedesEnvelopeId,
  });
}

export function edgeCommandFingerprint(request: EdgeCommandRequest): string {
  return fingerprintOf({
    executionId: request.executionId,
    deviceId: request.deviceId,
    envelopeId: request.envelopeId,
    commandKind: request.commandKind,
    channel: request.channel,
    magnitude: request.magnitude,
    payload: request.payload,
    notBefore: request.notBefore,
    notAfter: request.notAfter,
    estimatedMicroUsd: request.estimatedMicroUsd,
    approvalId: request.approvalId,
  });
}

export function edgeApprovalSubjectFingerprintOf(request: EdgeApprovalRequestInput): string {
  return fingerprintOf({
    executionId: request.executionId,
    deviceId: request.deviceId,
    subjectKind: request.subjectKind,
    subjectFingerprint: request.subjectFingerprint,
  });
}

export function edgeSensorObservationFingerprint(input: EdgeSensorObservationInput): string {
  return fingerprintOf({
    executionId: input.executionId,
    deviceId: input.deviceId,
    observationType: input.observationType,
    retention: input.retention,
    content: input.content,
    observedAt: input.observedAt,
  });
}

export function edgeReconciliationReportDigest(report: EdgeReconciliationReport): string {
  return fingerprintOf({
    deviceId: report.deviceId,
    executed: report.executed,
    refused: report.refused,
    reportedAt: report.reportedAt,
  });
}
