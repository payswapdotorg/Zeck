/**
 * Credential-grant domain (agents module domain; WORK-011, AGT-005/ACP-003).
 *
 * THE critical boundary of the agent fabric: the runtime receives
 * REFERENCES and scoped capabilities — never raw long-lived platform
 * secrets. The mediation ladder:
 *
 *   secret authority (connections/BYOK — platform-side, untouched here)
 *           ↓
 *   scoped credential GRANT (this file: a durable, revocable,
 *   runtime-specific capability record)
 *           ↓
 *   runtime capability (the grant REFERENCE crosses the runtime contract)
 *           ↓
 *   agent action (dispatch re-validates the grant is active)
 *
 * A grant row carries a scope KIND + opaque REFERENCE only. There is no
 * field anywhere in this module's runtime contracts that could carry a
 * secret VALUE — materialization of actual credential material remains
 * behind the connections vault seam at adapter-dispatch time (the
 * WORK-003 model this Work Order must not weaken).
 *
 * Grants are: scoped (one kind+ref each), revocable (status → revoked),
 * auditable (issuedAt/revokedAt durable), runtime-specific (bound to one
 * session). Revocation is monotonic: a revoked grant never returns to
 * active.
 */

import type { CredentialScopeKind } from "./agent-version";
import { CREDENTIAL_SCOPE_KINDS } from "./agent-version";

export const CREDENTIAL_GRANT_STATUSES = ["active", "revoked", "expired"] as const;
export type CredentialGrantStatus = (typeof CREDENTIAL_GRANT_STATUSES)[number];

export function isCredentialGrantStatus(value: string): value is CredentialGrantStatus {
  return (CREDENTIAL_GRANT_STATUSES as readonly string[]).includes(value);
}

/** The grant statuses that authorize runtime use at dispatch time. */
export function grantIsUsable(
  status: CredentialGrantStatus,
  expiresAt: string | null,
  now: string,
): boolean {
  if (status !== "active") {
    return false;
  }
  if (expiresAt !== null && Date.parse(expiresAt) <= Date.parse(now)) {
    return false;
  }
  return true;
}

/** One scoped, revocable, auditable, runtime-specific capability. */
export interface CredentialGrantRecord {
  /** Durable grant identity (UUIDv7). */
  readonly id: string;
  readonly applicationId: string;
  readonly tenantId: string;
  /** The session this grant is bound to (runtime-specific). */
  readonly sessionId: string;
  readonly scopeKind: CredentialScopeKind;
  /** Opaque REFERENCE (never a value). */
  readonly scopeRef: string;
  readonly status: CredentialGrantStatus;
  readonly issuedAt: string;
  readonly expiresAt: string | null;
  readonly revokedAt: string | null;
}

/** A grant reference as it crosses the runtime contract (id + scope only). */
export interface CredentialGrantReference {
  readonly grantId: string;
  readonly scopeKind: CredentialScopeKind;
  readonly scopeRef: string;
}

export function toGrantReference(grant: Readonly<CredentialGrantRecord>): CredentialGrantReference {
  return { grantId: grant.id, scopeKind: grant.scopeKind, scopeRef: grant.scopeRef };
}

export function isCredentialScopeKind(value: string): value is CredentialScopeKind {
  return (CREDENTIAL_SCOPE_KINDS as readonly string[]).includes(value);
}
