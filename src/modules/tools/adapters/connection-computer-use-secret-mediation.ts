/**
 * Connection-backed computer-use secret mediation (tools module adapter;
 * WORK-027, CUI-002 — "credentials are injected through the existing
 * mediated secret path").
 *
 * Implements the tools module's REQUIRED `ComputerUseSecretMediation`
 * port against the REAL connections catalog (the WORK-003 dispatch-facts
 * surface): `mediate` resolves the caller's connection reference through
 * the tenant-guarded catalog read and returns an OPAQUE grant reference
 * (reference-only — raw secret values never cross this seam; the vault's
 * materialization surface stays behind the connections module).
 *
 * The grant reference is derived from the RESOLVED dispatch facts
 * (connection identity + credential reference + status) — never from
 * secret material. A missing connection, a cross-tenant connection or a
 * disabled connection fails closed as an unmediated outcome typed with
 * the catalog's reason.
 */

import type { ConnectionCatalog } from "../../connections/public";
import type {
  ComputerUseSecretMediation,
  ComputerUseSecretMediationOutcome,
  ComputerUseSecretMediationRequest,
} from "../ports/computer-use-admission";

export function createConnectionComputerUseSecretMediation(
  catalog: ConnectionCatalog,
): ComputerUseSecretMediation {
  return {
    async mediate(
      request: ComputerUseSecretMediationRequest,
    ): Promise<ComputerUseSecretMediationOutcome> {
      let facts: Awaited<ReturnType<typeof catalog.getConnectionForDispatch>>;
      try {
        facts = await catalog.getConnectionForDispatch(
          { tenantId: request.tenantId, applicationId: request.applicationId },
          request.connectionRef,
        );
      } catch (error) {
        return {
          mediated: false,
          reason:
            error instanceof Error
              ? error.message
              : "the connection reference could not be mediated",
        };
      }
      return {
        mediated: true,
        grantRef: `cu-grant:${facts.id}:${facts.credentialRef ?? "credential-none"}:${facts.status}`,
      };
    },
  };
}
