/**
 * Deployment identity route (DEP-001 AC2: "Exact deployment revision
 * is discoverable and smoke-tested").
 *
 * THE RUNTIME ATTEST SURFACE: `GET /identity` lets any deployed
 * instance prove what it is — the exact Git revision, the deployment
 * identity id, the manifest digest, the resource digest and the
 * provider topology projection (concern → provider, authority role,
 * substitution target, free-tier-first tier class). The document
 * carries NO host/port/URL: it is hosting-independent, so repointing
 * or rolling back delivery cannot change it (DEP-001 AC6).
 *
 * TRANSPORT ONLY: the identity is computed by the composition (the
 * platform runtime-identity module over the checkout + manifests);
 * this route only reports what the injected seam returns. When the
 * seam is NOT bound by the composition, the instance cannot prove
 * what it is — the honest answer is the fail-closed `unbound` state
 * (503), mirroring the /health unattestable semantics. Never a
 * fabricated identity.
 *
 * SECRET-FREE: the document is derived from repository manifests and
 * the Git revision; the response is additionally scrubbed like /health
 * (secret-shaped keys, credential-shaped substrings).
 */

import type { FastifyInstance } from "fastify";
import { scrubSecretShapedKeys } from "../serialization";

export interface ProviderTopologyWire {
  readonly concern: string;
  readonly provider: string;
  readonly authorityRole: string;
  readonly substitutionTarget: string;
  readonly tierClass: string;
  readonly tierName: string;
}

/** The runtime identity the composition seam returns (transport view). */
export interface RuntimeIdentityWire {
  readonly schemaVersion: number;
  readonly runtimeIdentityId: string;
  readonly identity: {
    readonly schemaVersion: number;
    readonly identityId: string;
    readonly gitRevision: string;
    readonly environment: string;
    readonly manifestDigest: string;
    readonly resourceDigest: string;
  };
  readonly topologyDigest: string;
  readonly providerTopology: readonly ProviderTopologyWire[];
}

export interface IdentityRoutesDeps {
  /**
   * The injected runtime deployment identity seam (composition-owned;
   * see src/platform/deployment/runtime-identity.ts). Absent ⇒ the
   * honest unbound state — the route table stays identical across
   * compositions.
   */
  readonly deploymentIdentity?: () => Promise<RuntimeIdentityWire | null>;
}

export function registerIdentityRoutes(app: FastifyInstance, deps: IdentityRoutesDeps): void {
  app.get("/identity", async (_request, reply) => {
    const seam = deps.deploymentIdentity;
    if (seam === undefined) {
      return await reply.code(503).send(
        scrubSecretShapedKeys({
          status: "unbound",
          reason:
            "the deployment identity seam is not bound by this composition (the instance cannot prove what it is)",
        }) as Record<string, unknown>,
      );
    }
    let document: RuntimeIdentityWire | null;
    try {
      document = await seam();
    } catch {
      // The seam itself failed: identity is UNATTESTABLE — fail closed,
      // no internals leaked.
      return await reply.code(503).send(
        scrubSecretShapedKeys({
          status: "unattestable",
          reason: "the deployment identity seam failed (identity cannot be attested)",
        }) as Record<string, unknown>,
      );
    }
    if (document === null) {
      return await reply.code(503).send(
        scrubSecretShapedKeys({
          status: "unbound",
          reason: "the deployment identity seam returned no document (composition not bound)",
        }) as Record<string, unknown>,
      );
    }
    return await reply.code(200).send(
      scrubSecretShapedKeys({
        status: "bound",
        ...document,
      }) as Record<string, unknown>,
    );
  });
}
