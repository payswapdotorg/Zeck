/**
 * Secret store port (`IMPLEMENTATION.md` §9 — Secrets/BYOK).
 *
 * BYOK credentials are represented by an opaque `SecretReference`, never by
 * ordinary domain fields. The `SecretStore` adapter owns
 * encryption/decryption and provider credential materialization. Resolution
 * happens after policy approval and immediately before the authorized
 * adapter call. Secret plaintext never crosses a public API surface, and
 * secret-bearing payloads are rejected from logs, artifacts and model/tool
 * context unless explicitly classified and authorized.
 */
declare const secretReferenceBrand: unique symbol;

/** Opaque handle to stored secret material. Not a domain value. */
export type SecretReference = string & {
  readonly [secretReferenceBrand]: never;
};

export type SecretClassification = "provider-credential" | "signing-key" | "internal";

export interface StoreSecretRequest {
  /** Plaintext material — write-only through this port. */
  readonly material: string;
  readonly classification: SecretClassification;
  readonly description?: string;
}

export interface ResolvedSecret {
  readonly reference: SecretReference;
  readonly classification: SecretClassification;
  /**
   * Plaintext material. Admissible only inside an authorized adapter scope,
   * after the dispatch gate returned an allow decision
   * (`IMPLEMENTATION.md` §7).
   */
  readonly plaintext: string;
}

export interface SecretStorePort {
  store(request: StoreSecretRequest): Promise<SecretReference>;

  resolve(reference: SecretReference): Promise<ResolvedSecret>;
}
