/**
 * Content-addressed artifact store port (artifacts module; WORK-008).
 *
 * The ENTIRE mutation surface is `put` — put-if-absent keyed by
 * `(tenantId, digest)`. There is NO update and NO delete method on this
 * port by design: immutability is by construction, not by convention
 * (statically gated in `tests/architecture/artifact-store-surface.test.ts`
 * and type-asserted in the unit suites).
 *
 * `ownerOf` supports the cross-tenant adoption boundary: it answers "which
 * tenant(s) own this digest" WITHOUT granting reads, so the service can
 * reject a foreign-digest reference with the canonical
 * `TENANT_SCOPE_VIOLATION` instead of an ambiguous not-found.
 */

import type {
  ArtifactDigest,
  ArtifactPutInput,
  ArtifactPutOutcome,
  ArtifactRecord,
} from "../domain/artifact";

/** Tenant scope every operation is executed under. */
export interface ArtifactScope {
  readonly tenantId: string;
}

export interface ArtifactStore {
  /** Put-if-absent: exactly one durable record ever exists per `(tenantId, digest)`. */
  put(input: ArtifactPutInput): Promise<ArtifactPutOutcome>;

  /** Tenant-scoped read; `null` when absent in the caller's namespace. */
  get(scope: ArtifactScope, digest: ArtifactDigest): Promise<ArtifactRecord | null>;

  /** All records in the caller's namespace, digest-ordered (deterministic). */
  list(scope: ArtifactScope): Promise<readonly ArtifactRecord[]>;

  /**
   * Ownership probe (adoption boundary): every tenant namespace that holds
   * `digest`, digest-irrelevant order made deterministic by sorting. NEVER
   * returns content — only tenant ids.
   */
  ownerOf(digest: ArtifactDigest): Promise<readonly string[]>;
}

/**
 * Compile-time proof that no mutation method ever appears on the store
 * surface. If someone adds `update`/`delete`/`remove`/`patch`/`mutate` to
 * `ArtifactStore`, this type stops compiling.
 */
export type StoreMutationMethod =
  | "update"
  | "delete"
  | "remove"
  | "patch"
  | "mutate"
  | "replace"
  | "overwrite";

type NoMutationMethodsOnStore =
  Extract<keyof ArtifactStore, StoreMutationMethod> extends never ? true : never;

// eslint-disable-next-line @typescript-eslint/no-unused-expressions
export const STORE_HAS_NO_MUTATION_METHODS: NoMutationMethodsOnStore = true;
