/**
 * Public contract barrel of the `connections` module.
 *
 * This file is the ONLY supported import surface for other modules and for
 * the API layer (`IMPLEMENTATION.md` §2, `spec/contracts.md` "Public
 * module rule"). Everything else under `src/modules/connections/` is private
 * to this module.
 *
 * WORK-003 introduces the provider-neutral connection contracts (CON-001),
 * first-class BYOK secret references (CON-002) and the dispatch-facts
 * catalog the models fabric consumes after its admission gate. The barrel
 * stays provider-neutral: rails appear only as slugs from the
 * `PROVIDER_RAILS` vocabulary; no provider SDK type crosses this surface.
 */

import type { ModuleDescriptor } from "../../shared/module";
import {
  type ConnectionService,
  createConnectionService,
  type MaterialDigester,
  type RegisterConnectionCommand,
  type RemoveConnectionCommand,
  type RotateCredentialCommand,
  type UpdateConnectionStatusCommand,
} from "./application/connection-service";
import type {
  ConnectionDispatchFacts,
  ConnectionRecord,
  ConnectionStatus,
  CredentialKind,
} from "./domain/connection";
import {
  isProviderRail,
  isValidConnectionLabel,
  PROVIDER_RAILS,
  type RailSlug,
} from "./domain/rails";
import type { ConnectionStore } from "./ports/connection-store";
import type { CredentialVault } from "./ports/credential-vault";
import type { ConnectionsIdempotencyPort } from "./ports/idempotency";

export const moduleDescriptor: ModuleDescriptor = { id: "connections" };

// Records carry no secret material of any kind (CON-002).
// Module ports (provider-neutral; implemented by adapters).
export type {
  ConnectionDispatchFacts,
  ConnectionRecord,
  ConnectionStatus,
  ConnectionStore,
  ConnectionsIdempotencyPort,
  CredentialKind,
  CredentialVault,
  RailSlug,
};
// Domain vocabulary (CON-001: provider-independent connection contracts).
export { isProviderRail, isValidConnectionLabel, PROVIDER_RAILS };
/**
 * The dispatch-facts surface other modules consume (the models fabric).
 * Structural picks keep the dependency minimal: facts reading only.
 */
export type ConnectionCatalog = Pick<ConnectionService, "getConnectionForDispatch">;
/** Scope input of the catalog read — always server-derived, never caller-asserted. */
export type ConnectionCatalogScope = Parameters<ConnectionCatalog["getConnectionForDispatch"]>[0];
/** The credential-materialization surface (post-admission, pre-dispatch only). */
export type CredentialMaterializer = Pick<CredentialVault, "materialize">;
// Application services.
export type {
  ConnectionService,
  MaterialDigester,
  RegisterConnectionCommand,
  RemoveConnectionCommand,
  RotateCredentialCommand,
  UpdateConnectionStatusCommand,
};
export { createConnectionService };
