/**
 * Connection aggregate (connections module domain).
 *
 * A `ConnectionRecord` is the durable, provider-neutral registration of a
 * supply path for model capability, owned by an application inside a tenant
 * (`spec/requirements.md` CON-001: "Providers are represented through
 * provider-independent connection contracts").
 *
 * BYOK is first-class (CON-002): the credential of a connection is either
 *   * `byok` — customer-supplied key material, persisted ONLY as an opaque
 *     vault reference (`credentialRef`); plaintext never appears in any
 *     record, view, log or public surface, or
 *   * `platform` — platform-managed credentials (no per-connection
 *     material; materialization is a rail-adapter concern).
 *
 * The public record shape deliberately omits `credentialRef`: vault
 * references are need-to-know dispatch facts consumed through the connection
 * catalog inside the authorized dispatch path, never ordinary domain state
 * (architecture-lock invariant 9).
 */

import type { RailSlug } from "./rails";

export const CONNECTION_STATUSES = ["active", "disabled"] as const;
export type ConnectionStatus = (typeof CONNECTION_STATUSES)[number];

export type CredentialKind = "byok" | "platform";

/** The public view of a connection — carries no secret material of any kind. */
export interface ConnectionRecord {
  readonly id: string;
  readonly applicationId: string;
  readonly tenantId: string;
  readonly rail: RailSlug;
  readonly label: string;
  readonly endpointUrl: string | null;
  readonly credentialKind: CredentialKind;
  readonly status: ConnectionStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/**
 * Module-internal row shape: the public record plus the opaque vault
 * reference. NEVER crosses the public barrel — the store returns it to the
 * application service, which strips the reference before returning outcomes
 * (`toPublic` performs the one sanctioned strip).
 */
export interface StoredConnection extends ConnectionRecord {
  readonly credentialRef: string | null;
}

/** The one sanctioned strip from internal row to public view. */
export function toPublicConnection(row: StoredConnection): ConnectionRecord {
  const { credentialRef, ...record } = row;
  void credentialRef; // dropped by design — never returned, logged or journaled
  return record;
}

/**
 * Dispatch-time facts of a connection — consumed by the models module
 * fabric immediately before an authorized adapter call. `credentialRef` is
 * an opaque vault reference (not plaintext); it exists only so the
 * credential can be materialized inside the adapter scope after the dispatch
 * gate (`IMPLEMENTATION.md` §7, §9).
 */
export interface ConnectionDispatchFacts {
  readonly id: string;
  readonly tenantId: string;
  readonly applicationId: string;
  readonly rail: RailSlug;
  readonly endpointUrl: string | null;
  readonly credentialKind: CredentialKind;
  readonly credentialRef: string | null;
  readonly status: ConnectionStatus;
}

/** A registered BYOK credential as the caller sees it: reference + metadata only. */
export interface RegisteredCredential {
  readonly reference: string;
  readonly createdAt: string;
}
