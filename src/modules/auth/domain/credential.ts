/**
 * Application credential contracts (auth module domain; DEP-011).
 *
 * A credential is the durable record of one scannable application
 * transport credential: stable identity, label, application/tenant scope,
 * role-derived permission scope, creation/rotation timestamps and status.
 *
 * SECRET MATERIAL IS NEVER PART OF THIS RECORD (DEP-011 authority rule):
 * the issued secret lives only as an opaque `SecretReference` held by the
 * platform secret store, carried by the STORE row (see
 * `ports/credential-store.ts`) and never by the domain record, a wire shape
 * or a log line. The record is therefore the metadata-only projection the
 * API and the console render; the secret crosses a process boundary exactly
 * once — as the immediate response to the mutation that created it.
 *
 * LINEAGE MODEL: a credential identity (`credentialId`) is stable across
 * rotations. The first issuance creates a record whose `id` equals its
 * `credentialId`. Rotation issues a SUCCESSOR record (new `id`, same
 * `credentialId`, a fresh secret reference) and RETIRES the predecessor
 * (`status` "retired", `rotatedAt` set, `supersededBy` naming the
 * successor). Revocation is immediate and idempotent: the identity's
 * current record transitions to `status` "revoked" and stays there.
 */

import type { ApplicationRole } from "./roles";

/** The credential lifecycle statuses (DEP-011's closed vocabulary). */
export const CREDENTIAL_STATUSES = ["active", "retired", "revoked"] as const;
export type CredentialStatus = (typeof CREDENTIAL_STATUSES)[number];

/**
 * The metadata-only credential record. No field of this type carries secret
 * material — by construction (there is no field where a secret could
 * appear), pinned by the secret-safety probes over every route response and
 * console render path that projects it.
 */
export interface CredentialRecord {
  /** Row id of this record (one per issued secret binding). */
  readonly id: string;
  /** The STABLE credential identity — shared across rotations. */
  readonly credentialId: string;
  readonly applicationId: string;
  readonly tenantId: string;
  /** Operator-facing label (validated shape; never secret material). */
  readonly label: string;
  /** The role whose permission set scopes this credential (house vocabulary). */
  readonly role: ApplicationRole;
  readonly status: CredentialStatus;
  readonly createdAt: string;
  /** Set on the predecessor record when its rotation successor was issued. */
  readonly rotatedAt: string | null;
  /** The successor record id after rotation (lineage fact). */
  readonly supersededBy: string | null;
}

/** The label shape a credential may carry (fail-closed elsewhere). */
export const CREDENTIAL_LABEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 ._-]{0,63}$/;

/** Validate a credential label against the recorded shape. */
export function isValidCredentialLabel(label: string): boolean {
  return CREDENTIAL_LABEL_PATTERN.test(label);
}

/** Validate that a status string is the closed lifecycle vocabulary. */
export function isCredentialStatus(value: string): value is CredentialStatus {
  return (CREDENTIAL_STATUSES as readonly string[]).includes(value);
}
