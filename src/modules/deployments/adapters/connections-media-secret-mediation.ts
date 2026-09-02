/**
 * Connections media secret-mediation adapter (deployments module;
 * WORK-026).
 *
 * Implements the deployments module's REQUIRED `MediaSecretMediation`
 * port against the REAL connections module catalog (the WORK-003
 * authority that owns BYOK credential references). Mediation here
 * means ACCESS ARBITRATION + REFERENCE-ONLY outcomes: the media
 * generation service learns ONLY whether the media rail channel's
 * credential reference is resolvable and active, and receives an
 * OPAQUE grant reference — raw secret values NEVER cross into the
 * deployments module. A real media rail adapter materializes
 * plaintext inside its own scope through the connections vault (the
 * models-gateway "secrets last" discipline); that materialization is
 * the ADAPTER's concern and is explicitly UNVERIFIED in this
 * environment (no media-provider credentials exist — see
 * docs/work-items/WORK-026.md).
 *
 * The policy admission carries the secret REFERENCE in its facts (the
 * policies authority owns the secrets dimension); this seam verifies
 * availability through the connections facts read — a missing/inactive
 * credential fails closed before any paid rail dispatch.
 *
 * Type + runtime coupling is to the connections PUBLIC barrel only.
 */

import { PlatformError } from "../../../shared/errors";
import type { ConnectionCatalog } from "../../connections/public";
import type {
  MediaSecretMediation,
  MediaSecretMediationOutcome,
  MediaSecretMediationRequest,
} from "../ports/media-admission";

export function createConnectionsMediaSecretMediation(
  catalog: ConnectionCatalog,
): MediaSecretMediation {
  return {
    async mediate(request: MediaSecretMediationRequest): Promise<MediaSecretMediationOutcome> {
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
              ? `media rail channel credential mediation failed: ${error.message}`
              : "media rail channel credential mediation failed",
        };
      }
      if (facts.tenantId !== request.tenantId || facts.applicationId !== request.applicationId) {
        return {
          mediated: false,
          reason: "the media rail connection belongs to another tenant/application scope",
        };
      }
      if (facts.status !== "active") {
        return {
          mediated: false,
          reason: `the media rail connection is ${facts.status}; mediated access requires an active connection`,
        };
      }
      if (facts.credentialRef === null) {
        return {
          mediated: false,
          reason: "the media rail connection carries no credential reference to mediate",
        };
      }
      // REFERENCE-ONLY grant: the grant ref binds the mediated access to
      // the connection identity without exposing or copying any
      // credential material (the raw value stays in the connections
      // vault; a real media rail adapter redeems it in its own scope).
      return {
        mediated: true,
        grantRef: `mediated:${facts.id}:${facts.credentialRef.slice(0, 16)}`,
      };
    },
  };
}
