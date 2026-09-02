/**
 * Connections messaging secret-mediation adapter (deployments module;
 * WORK-025).
 *
 * Implements the deployments module's REQUIRED
 * `MessagingSecretMediation` port against the REAL connections module
 * catalog (the WORK-003 authority that owns BYOK credential
 * references). Mediation here means ACCESS ARBITRATION +
 * REFERENCE-ONLY outcomes: the messaging conversation service learns
 * ONLY whether the rail channel's credential reference is resolvable
 * and active, and receives an OPAQUE grant reference — raw secret
 * values NEVER cross into the deployments module. A real rail adapter
 * materializes plaintext inside its own scope through the connections
 * vault (the models-gateway "secrets last" discipline); that
 * materialization is the ADAPTER's concern and is explicitly
 * UNVERIFIED in this environment (no provider credentials exist — see
 * docs/work-items/WORK-025.md).
 *
 * The policy admission carries the secret REFERENCE in its facts (the
 * policies authority owns the secrets dimension); this seam verifies
 * availability through the connections facts read — a missing/inactive
 * credential fails closed before any rail send.
 *
 * Type + runtime coupling is to the connections PUBLIC barrel only.
 */

import { PlatformError } from "../../../shared/errors";
import type { ConnectionCatalog } from "../../connections/public";
import type {
  MessagingSecretMediation,
  MessagingSecretMediationOutcome,
  MessagingSecretMediationRequest,
} from "../ports/messaging-admission";

export function createConnectionsMessagingSecretMediation(
  catalog: ConnectionCatalog,
): MessagingSecretMediation {
  return {
    async mediate(
      request: MessagingSecretMediationRequest,
    ): Promise<MessagingSecretMediationOutcome> {
      let facts: Awaited<ReturnType<ConnectionCatalog["getConnectionForDispatch"]>>;
      try {
        facts = await catalog.getConnectionForDispatch(
          {
            tenantId: request.tenantId,
            applicationId: request.applicationId,
          },
          request.connectionRef,
        );
      } catch (error) {
        return {
          mediated: false,
          reason:
            error instanceof PlatformError
              ? `rail channel credential mediation failed: ${error.message}`
              : "rail channel credential mediation failed",
        };
      }
      if (facts.tenantId !== request.tenantId || facts.applicationId !== request.applicationId) {
        return {
          mediated: false,
          reason: "the rail channel connection belongs to another tenant/application scope",
        };
      }
      if (facts.status !== "active") {
        return {
          mediated: false,
          reason: `the rail channel connection is ${facts.status}; mediated access requires an active connection`,
        };
      }
      if (facts.credentialRef === null) {
        return {
          mediated: false,
          reason: "the rail channel connection carries no credential reference to mediate",
        };
      }
      // REFERENCE-ONLY grant: the grant ref binds the mediated access to
      // the connection identity without exposing or copying any
      // credential material (the raw value stays in the connections
      // vault; a real rail adapter redeems it in its own scope).
      return {
        mediated: true,
        grantRef: `mediated:${facts.id}:${facts.credentialRef.slice(0, 16)}`,
      };
    },
  };
}
