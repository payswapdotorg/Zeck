/**
 * `connections` ports layer — outbound/inbound interfaces owned by this module.

Ports are provider-neutral: no infrastructure clients, no provider SDKs.
Adapters (in `adapters/`) implement them (`IMPLEMENTATION.md` §2–§3).
 */
export type { ConnectionStore, InsertConnectionInput } from "./connection-store";
export type { CredentialVault, StoredCredential, VaultMaterialization } from "./credential-vault";
export type {
  ConnectionsIdempotencyPort,
  ConnectionTx,
  IdempotencyArbitration,
  IdempotencyScope,
} from "./idempotency";
