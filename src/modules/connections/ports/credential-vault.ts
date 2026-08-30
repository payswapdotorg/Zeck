/**
 * Credential vault port (connections module outbound).
 *
 * Owns BYOK credential material (CON-002, `IMPLEMENTATION.md` §9):
 *   * `store` accepts plaintext material WRITE-ONLY and returns an opaque
 *     reference — the plaintext crosses this boundary exactly once, inward;
 *   * `materialize` returns plaintext ONLY for the authorized dispatch path
 *     (called by the models fabric after the dispatch gate returned an allow
 *     decision, immediately before the adapter call);
 *   * `destroy` removes the material durably (rotation/revocation).
 *
 * Adapters encrypt at rest; no durable row, log, journal or public record may
 * ever contain plaintext (architecture-lock invariant 9).
 */

export interface StoredCredential {
  readonly reference: string;
}

export interface VaultMaterialization {
  readonly reference: string;
  readonly plaintext: string;
}

export interface CredentialVault {
  store(material: string, options: { description?: string }): Promise<StoredCredential>;

  /**
   * `authorization` records WHY this materialization is admissible (the
   * dispatch attempt + connection it serves). Adapters may bind it into
   * auditing; callers must only invoke this post-admission, pre-dispatch.
   */
  materialize(
    reference: string,
    authorization: { readonly attemptId: string; readonly connectionId: string },
  ): Promise<VaultMaterialization>;

  /** Destroy stored material. Returns true when a row was destroyed. */
  destroy(reference: string): Promise<boolean>;
}
