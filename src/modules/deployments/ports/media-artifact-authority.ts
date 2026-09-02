/**
 * Media artifact-authority port (deployments module outbound; WORK-026,
 * MOD-012 — the canonical artifact authority is the ONLY media-bytes
 * plane).
 *
 * Generated media and derived variants are persisted as
 * lineage-preserving artifacts through THE canonical artifact
 * authority (the artifacts module's public service — content-addressed
 * digests, parent→child lineage edges, tenant-namespaced put-if-absent
 * immutability). The deployments module owns none of that: this port
 * is the REQUIRED consultee seam; an adapter implements it over the
 * artifacts PUBLIC barrel. The discipline:
 *
 *   - generated outputs are adopted with `parents` = the source-input
 *     artifact digest (when the job transforms one) and
 *     identity-bearing source refs recording the EXECUTION and
 *     DEPLOYMENT provenance (MOD-012: "generated media and derived
 *     variants preserve artifact lineage, execution provenance and
 *     deployment version");
 *   - derived variants are adopted with `parents` = the source
 *     artifact digest (the generated output) — the lineage chain
 *     source-input → generated-output → derived-variant is carried BY
 *     the artifact authority's identity-bearing lineage (a variant
 *     that dropped its lineage link is a DIFFERENT digest — the
 *     silent-lineage-loss defect is unrepresentable);
 *   - the payload is the DETERMINISTIC NORMALIZED DESCRIPTOR (bounded
 *     canonical JSON: contentDigest + neutral metadata) — never raw
 *     media bytes (bytes live in the content plane behind the
 *     contentDigest reference; this seam records and references, it
 *     never transports bulk media);
 *   - adoption is idempotent by content identity (put-if-absent:
 *     identical full inputs converge — true idempotency, exactly the
 *     crash-resume convergence the completion operation needs);
 *   - tenant isolation is the artifact authority's adoption boundary
 *     (a parent digest owned by another tenant namespace fails
 *     `TENANT_SCOPE_VIOLATION`; a dangling parent fails
 *     `POLICY_DENIED` — zero writes).
 */

export interface MediaArtifactAdoptionInput {
  readonly tenantId: string;
  readonly applicationId: string;
  /** The adoption role: generated output or derived variant. */
  readonly role: "generated-output" | "derived-variant";
  /** The deterministic normalized descriptor (bounded canonical JSON payload). */
  readonly descriptor: Readonly<Record<string, unknown>>;
  /** The lineage parent digests (source input for outputs; source artifact for variants). */
  readonly parents: readonly string[];
  /**
   * Identity-bearing provenance source refs (execution, deployment,
   * job coordinates — MOD-012's execution/deployment provenance on
   * the artifact identity).
   */
  readonly sourceRefs: readonly {
    readonly kind: "source" | "artifact";
    readonly id: string;
    readonly locator: string;
  }[];
}

export interface MediaArtifactAdoptionOutcome {
  /** The content-addressed artifact digest (the canonical identity). */
  readonly digest: string;
  readonly converged: boolean;
}

export interface MediaArtifactAuthority {
  /**
   * Adopt (or re-converge on) one media artifact: the canonical
   * artifact authority's put-if-absent with identity-bearing lineage
   * — identical full inputs converge, any lineage change is a
   * different digest, tenant boundaries are enforced by the
   * authority.
   */
  adoptArtifact(input: MediaArtifactAdoptionInput): Promise<MediaArtifactAdoptionOutcome>;
  /**
   * Tenant-scoped existence check (the lineage validation read — a
   * parent digest must exist in the CALLER's namespace before a
   * derived variant can link to it).
   */
  artifactExists(scope: { readonly tenantId: string }, digest: string): Promise<boolean>;
}
