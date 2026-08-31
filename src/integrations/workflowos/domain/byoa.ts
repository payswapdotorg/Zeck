/**
 * BYOA (bring-your-own-agent) interoperability domain (WORK-016 /
 * AGT-007, ACP-005).
 *
 * THE provider-neutral BYOA adapter contract — the disciplined answer
 * to "external agent frameworks remain implementation details behind
 * provider-neutral adapters" (no framework is ever NAMED here):
 *
 * ```text
 * External Agent (any framework — the contract never says which)
 *         ↓ implements the NEUTRAL external runner contract
 * BYOA adapter (this integration surface)
 *         ↓ implements the agents module's public `AgentProvider` port
 * governed Zeck agent-session execution
 *         (policy → capability → budget → execution → verification —
 *          the authorities own every gate; the adapter owns none)
 * ```
 *
 * WHAT THE EXTERNAL SIDE RECEIVES (and nothing more):
 *  - the already-governed runtime identity (scoped effective
 *    permissions, credential-grant REFERENCES — never secret values,
 *    the workspace/session binding);
 *  - the neutral session task (instructions, input digest, artifact
 *    references, wall-clock ceiling).
 *
 * WHAT THE EXTERNAL SIDE RETURNS: a neutral observation (success class,
 * output digest/structured output, bounded failure reason). Framework
 * types, stack traces and provider internals never cross back — the
 * adapter sanitizes everything (M20: framework types remain
 * adapter-local; a leaked framework type is unrepresentable in these
 * contracts).
 *
 * WHAT THE BYOA CONTRACT NEVER DOES:
 *  - it is NOT an agent registry (WORK-11's registry is THE authority —
 *    `registerByoaAgent` CONSUMES it; discrimination M19);
 *  - it is NOT an execution/policy/capability/budget/verification
 *    authority (every session runs through the agents session service's
 *    admission chain — M14–M17/M21);
 *  - it never receives raw secrets (grant references only — M23/M24);
 *  - it cannot mutate execution state (no execution surface at all —
 *    M21).
 */

import type {
  AgentProvider,
  AgentRuntimeIdentity,
  AgentSessionObservation,
  AgentSessionTask,
} from "../../../modules/agents/public";

/**
 * The neutral runtime kind for externally-built agent adapters. A
 * neutral string by contract (the agents module's runtime vocabulary is
 * open: "local" | "customer-hosted" | "hosted" | future) — no framework
 * name ever appears here (M20/M10-class leaks).
 */
export const BYOA_RUNTIME_KIND = "external-byoa" as const;

/** Neutral provenance of an external agent (never a framework type). */
export interface ByoaExternalDescriptor {
  /** Neutral label the external side chooses (free text, bounded). */
  readonly name: string;
  /** Neutral version string of the external implementation. */
  readonly version: string;
  /**
   * Opaque structured descriptor the external framework supplies
   * (shape-free; never interpreted, never a public type, never a
   * secret — it is provenance for evidence only).
   */
  readonly frameworkNote?: Readonly<Record<string, unknown>>;
}

/**
 * THE neutral external runner contract: what an externally-built agent
 * framework implements to become a governed Zeck execution participant.
 * Structurally aligned with the agents module's public `AgentProvider`
 * shapes (the port is the seam) — the adapter adds ONLY the
 * sanitization boundary and provenance, never new authority.
 */
export interface ByoaExternalAgent {
  /** Neutral descriptor echoed into observations for provenance. */
  readonly descriptor: ByoaExternalDescriptor;
  /** One governed session run (neutral task → neutral outcome). */
  executeSession(
    identity: Readonly<AgentRuntimeIdentity>,
    task: Readonly<AgentSessionTask>,
  ): Promise<AgentSessionObservation>;
}

/** Bounded failure-reason sanitization (never a stack trace, never internals). */
const MAX_FAILURE_REASON_LENGTH = 300;

/**
 * Sanitize an observation's failure reason: bounded, single-line,
 * disclosure-free. A framework stack trace or provider detail crossing
 * this boundary is truncated and flagged — never propagated (the
 * canonical error-model discipline applied to the BYOA seam).
 */
export function sanitizeFailureReason(reason: string | null): string | null {
  if (reason === null) {
    return null;
  }
  const flattened = reason.replaceAll(/[\r\n]+/g, " ").trim();
  if (flattened.length === 0) {
    return "external agent reported a failure without a reason";
  }
  if (flattened.length <= MAX_FAILURE_REASON_LENGTH) {
    return flattened;
  }
  return `${flattened.slice(0, MAX_FAILURE_REASON_LENGTH)}…[truncated]`;
}

/** Validate a neutral external descriptor (fail-closed, bounded). */
export function validateByoaDescriptor(
  descriptor: unknown,
):
  | { readonly valid: true; readonly value: ByoaExternalDescriptor }
  | { readonly valid: false; readonly reason: string } {
  if (descriptor === null || typeof descriptor !== "object" || Array.isArray(descriptor)) {
    return { valid: false, reason: "BYOA descriptor must be an object" };
  }
  const raw = descriptor as Record<string, unknown>;
  if (typeof raw.name !== "string" || raw.name.length === 0 || raw.name.length > 100) {
    return { valid: false, reason: "BYOA descriptor name must be a string (1..100 chars)" };
  }
  if (typeof raw.version !== "string" || raw.version.length === 0 || raw.version.length > 50) {
    return { valid: false, reason: "BYOA descriptor version must be a string (1..50 chars)" };
  }
  if (raw.frameworkNote !== undefined) {
    const note = raw.frameworkNote;
    if (note === null || typeof note !== "object" || Array.isArray(note)) {
      return { valid: false, reason: "BYOA frameworkNote must be an object when present" };
    }
  }
  return {
    valid: true,
    value: {
      name: raw.name,
      version: raw.version,
      ...(raw.frameworkNote === undefined
        ? {}
        : { frameworkNote: raw.frameworkNote as Readonly<Record<string, unknown>> }),
    },
  };
}

/**
 * The typed contract the BYOA adapter exports for the agents-module
 * composition: an ordinary `AgentProvider` (the public port) with the
 * BYOA runtime kind — the session service's admission chain stays
 * upstream of every dispatch.
 */
export type ByoaAgentProvider = AgentProvider;

/** Re-exported port shapes the external side implements (the seam alignment). */
export type { AgentProvider, AgentRuntimeIdentity, AgentSessionObservation, AgentSessionTask };
