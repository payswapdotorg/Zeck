/**
 * HA topology declaration for the authoritative state (WORK-057 /
 * D-08, AVA-002: "high-availability authoritative state").
 *
 * PostgreSQL remains the SOLE durable authority — the HA extension
 * extends the deployment TOPOLOGY (primary + standby replica), never
 * the authority itself. Failover RESTORES authority from the standby's
 * replicated state; it never reconstructs it from providers.
 *
 * Repository truth: the `ha` extension of
 * `deploy/manifests/recovery-targets.json` (per environment class).
 * The extension is ADDITIVE — the D-07 core fields
 * (rtoTargetMs/rpoTargetMs/scope/measurement) stay owned by
 * `src/platform/recovery/rto-rpo.ts`, which ignores unknown fields;
 * this module is the single validator of the `ha` block and nothing
 * else. Provider dashboards, chat or incident notes cannot redefine a
 * topology target.
 *
 * Everything here fails closed: an environment without a well-formed
 * `ha` block, a non-numeric or unbounded target, an unknown replication
 * mode or an endpoint pair that does not parse through the repository
 * connection contract is a configuration error, never a default.
 */

import { parseConnectionConfig } from "../connection";
import { type EnvironmentRecoveryTarget, RecoveryTargetError } from "../../recovery/rto-rpo";

/** The replication modes the HA topology declares (AVA-002). */
export type HaReplicationMode = "asynchronous" | "synchronous";

/** Fail-closed HA topology configuration error. */
export class HaTopologyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HaTopologyError";
  }
}

/** The failover objectives of one environment's HA topology. */
export interface HaFailoverTargets {
  /** Maximum authority-failover RTO, milliseconds (positive, bounded). */
  readonly rtoTargetMs: number;
  /** Bounded description of the failover class the target covers. */
  readonly scope: string;
  /** How the numbers are measured (the repository-defined drill). */
  readonly measurement: string;
}

/** The RPO profile per replication path (AVA-002: async ≤ 60s, sync 0). */
export interface HaReplicationTargets {
  /** The asynchronous-replication path's RPO target, milliseconds. */
  readonly asynchronous: { readonly rpoTargetMs: number };
  /** The synchronous-replication path's RPO target, milliseconds. */
  readonly synchronous: { readonly rpoTargetMs: number };
}

/** One environment's HA topology declaration (repository truth). */
export interface HaTopologyTargets {
  /** The declared topology shape (primary + standby replica). */
  readonly topology: "primary-standby";
  readonly replication: HaReplicationTargets;
  readonly failover: HaFailoverTargets;
}

const MAX_TARGET_MS = 1000 * 60 * 60 * 24 * 7; // one week — a bound, not a default
const MAX_TEXT_LENGTH = 500;
const TOPOLOGY_SHAPES = ["primary-standby"] as const;
const REPLICATION_MODES = ["asynchronous", "synchronous"] as const;

function requireRecord(raw: unknown, what: string): Record<string, unknown> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new HaTopologyError(`${what} must be an object`);
  }
  return raw as Record<string, unknown>;
}

function requireBoundedTargetMs(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new HaTopologyError(`target field ${key} must be a non-negative integer`);
  }
  if (value > MAX_TARGET_MS) {
    throw new HaTopologyError(`target field ${key} exceeds the ${MAX_TARGET_MS}ms bound`);
  }
  return value;
}

function requireBoundedText(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_TEXT_LENGTH) {
    throw new HaTopologyError(
      `target field ${key} must be a non-empty string of at most ${MAX_TEXT_LENGTH} characters`,
    );
  }
  return value;
}

function parseReplicationTargets(raw: unknown): HaReplicationTargets {
  const record = requireRecord(raw, "ha.replication");
  const asynchronous = requireRecord(record.asynchronous, "ha.replication.asynchronous");
  const synchronous = requireRecord(record.synchronous, "ha.replication.synchronous");
  return Object.freeze({
    asynchronous: Object.freeze({
      rpoTargetMs: requireBoundedTargetMs(asynchronous, "rpoTargetMs"),
    }),
    synchronous: Object.freeze({
      rpoTargetMs: requireBoundedTargetMs(synchronous, "rpoTargetMs"),
    }),
  });
}

function parseFailoverTargets(raw: unknown): HaFailoverTargets {
  const record = requireRecord(raw, "ha.failover");
  const rtoTargetMs = requireBoundedTargetMs(record, "rtoTargetMs");
  return Object.freeze({
    rtoTargetMs,
    scope: requireBoundedText(record, "scope"),
    measurement: requireBoundedText(record, "measurement"),
  });
}

/**
 * Parse and validate the `ha` extension of ONE environment's raw
 * recovery-target record (fail closed on every drift: missing block,
 * unknown topology shape, non-numeric or unbounded targets, unbounded
 * prose, absent replication paths).
 */
export function parseHaTopologyTargets(rawEnvironmentTarget: unknown): HaTopologyTargets {
  const environmentRecord = requireRecord(rawEnvironmentTarget, "the environment target");
  const raw = environmentRecord.ha;
  if (raw === undefined) {
    throw new HaTopologyError(
      "the environment target carries no ha block (every environment class declares its HA topology)",
    );
  }
  const record = requireRecord(raw, "ha");
  const topology = record.topology;
  if (
    typeof topology !== "string" ||
    !TOPOLOGY_SHAPES.includes(topology as (typeof TOPOLOGY_SHAPES)[number])
  ) {
    throw new HaTopologyError(
      `ha.topology must be one of ${TOPOLOGY_SHAPES.join(", ")} (an unknown topology shape is a configuration error, never a default)`,
    );
  }
  return Object.freeze({
    topology: topology as (typeof TOPOLOGY_SHAPES)[number],
    replication: parseReplicationTargets(record.replication),
    failover: parseFailoverTargets(record.failover),
  });
}

/**
 * Load the HA topology declaration of every environment from the raw
 * recovery-targets document (the raw JSON — `parseRecoveryTargets`
 * freezes the four D-07 core fields and ignores the `ha` extension by
 * design; this reader owns exactly that extension and nothing else).
 */
export function parseHaTopologyDocument(
  rawRecoveryTargetsDocument: unknown,
): Readonly<Record<string, HaTopologyTargets>> {
  const document = requireRecord(rawRecoveryTargetsDocument, "recovery-targets.json");
  const targets = requireRecord(document.targets, "recovery-targets.json targets");
  const parsed: Record<string, HaTopologyTargets> = {};
  for (const [environment, raw] of Object.entries(targets)) {
    parsed[environment] = parseHaTopologyTargets(raw);
  }
  return Object.freeze(parsed);
}

/**
 * The effective recovery target for a failover drill under one
 * replication mode: the D-07 evaluator (`evaluateDrillAgainstTarget`)
 * stays the ONE objective-evaluation authority — this projection
 * composes the failover RTO with the replication-path RPO into the
 * evaluator's input shape. Never a second evaluation implementation.
 */
export function failoverTargetForMode(
  ha: HaTopologyTargets,
  mode: HaReplicationMode,
): EnvironmentRecoveryTarget {
  const rpoTargetMs = ha.replication[mode].rpoTargetMs;
  return Object.freeze({
    rtoTargetMs: ha.failover.rtoTargetMs,
    rpoTargetMs,
    scope: ha.failover.scope,
    measurement: ha.failover.measurement,
  });
}

/** Validate a replication mode string (fail closed on drift). */
export function parseHaReplicationMode(value: string): HaReplicationMode {
  if (!REPLICATION_MODES.includes(value as (typeof REPLICATION_MODES)[number])) {
    throw new HaTopologyError(
      `replication mode must be one of ${REPLICATION_MODES.join(", ")} (got "${value}")`,
    );
  }
  return value as HaReplicationMode;
}

/** The operative HA endpoints for one environment (materialized env-only). */
export interface HaTopologyEndpoints {
  readonly primaryUrl: string;
  readonly standbyUrl: string;
  readonly mode: HaReplicationMode;
}

/**
 * Resolve the operative HA endpoints from the environment (the
 * provider-environment form of the drill; the local form builds a
 * disposable topology instead). Both URLs parse through the repository
 * connection contract (fail closed — including the sslmode rules); the
 * same endpoint twice is a misconfiguration (a topology needs two
 * DISTINCT PostgreSQL instances).
 */
export function haEndpointsFromEnvironment(
  env: Record<string, string | undefined>,
): HaTopologyEndpoints {
  const primaryUrl = env.ZECK_HA_PRIMARY_URL ?? "";
  const standbyUrl = env.ZECK_HA_STANDBY_URL ?? "";
  const missing: string[] = [];
  if (primaryUrl.length === 0) {
    missing.push("ZECK_HA_PRIMARY_URL");
  }
  if (standbyUrl.length === 0) {
    missing.push("ZECK_HA_STANDBY_URL");
  }
  if (missing.length > 0) {
    throw new HaTopologyError(
      `the HA topology requires the materialized endpoints; missing: ${missing.join(", ")} (environment-only; the drill reports NOT RUN without them — never a PASS)`,
    );
  }
  try {
    parseConnectionConfig(primaryUrl);
    parseConnectionConfig(standbyUrl);
  } catch (error) {
    if (error instanceof RecoveryTargetError) {
      throw error;
    }
    throw new HaTopologyError(`an HA endpoint is invalid: ${(error as Error).message}`);
  }
  if (primaryUrl === standbyUrl) {
    throw new HaTopologyError(
      "the primary and standby endpoints are identical (an HA topology requires two distinct PostgreSQL instances)",
    );
  }
  const mode = parseHaReplicationMode(env.ZECK_HA_REPLICATION_MODE ?? "asynchronous");
  return Object.freeze({ primaryUrl, standbyUrl, mode });
}
