/**
 * Environment catalog service (sandbox module application; WORK-012, ENV-001).
 *
 * The governed catalog of provider-neutral compute environments: stable
 * per-application identity (slug-unique), content-addressed WRITE-ONCE
 * specifications (digest convergence — an identical re-registration
 * converges on the durable record; a different specification under the
 * same slug is an identity conflict, never a silent overwrite), and a
 * small explicit lifecycle (`available ⇄ suspended → retired`) that
 * admission consults — suspended/retired environments admit nothing.
 *
 * Authority posture: the catalog owns environment IDENTITY only. What an
 * environment may DO is decided at sandbox admission by the policy,
 * capability and budget authorities through the sandbox service's REQUIRED
 * seams — a specification DECLARES capabilities; it can never self-authorize
 * (`spec/architecture.md` §16: policies may tighten, never be weakened by
 * declarations).
 */

import { PlatformError } from "../../../shared/errors";
import {
  type ComputeEnvironmentRecord,
  type ComputeEnvironmentRegistrationInput,
  type ComputeEnvironmentSpec,
  canonicalEnvironmentJson,
  canTransitionEnvironment,
  type EnvironmentLifecycleStatus,
  validateEnvironmentRegistration,
} from "../domain/environment";
import type { SandboxStore } from "../ports/sandbox-store";

export interface EnvironmentCatalogDeps {
  readonly store: SandboxStore;
  readonly generateId: () => string;
  readonly now: () => Date;
  /** One-way digest of the canonical specification (content addressing). */
  readonly hashSpec: (canonical: string) => string;
}

export interface EnvironmentCatalog {
  register(
    input: ComputeEnvironmentRegistrationInput,
    idempotencyKey: string,
    actor: { readonly actorId: string; readonly applicationId: string; readonly tenantId: string },
  ): Promise<ComputeEnvironmentRecord>;
  get(applicationId: string, environmentId: string): Promise<ComputeEnvironmentRecord | null>;
  getBySlug(applicationId: string, slug: string): Promise<ComputeEnvironmentRecord | null>;
  list(applicationId: string): Promise<readonly ComputeEnvironmentRecord[]>;
  suspend(
    applicationId: string,
    environmentId: string,
    idempotencyKey: string,
    actor: { readonly actorId: string; readonly applicationId: string; readonly tenantId: string },
  ): Promise<ComputeEnvironmentRecord>;
  resume(
    applicationId: string,
    environmentId: string,
    idempotencyKey: string,
    actor: { readonly actorId: string; readonly applicationId: string; readonly tenantId: string },
  ): Promise<ComputeEnvironmentRecord>;
  retire(
    applicationId: string,
    environmentId: string,
    idempotencyKey: string,
    actor: { readonly actorId: string; readonly applicationId: string; readonly tenantId: string },
  ): Promise<ComputeEnvironmentRecord>;
}

export function createEnvironmentCatalog(deps: EnvironmentCatalogDeps): EnvironmentCatalog {
  const { store, generateId, now, hashSpec } = deps;
  const iso = () => now().toISOString();

  /** Registration is idempotent by its own durable identity anchor. */
  void undefined;

  const register = async (
    input: ComputeEnvironmentRegistrationInput,
    idempotencyKey: string,
    actor: { readonly actorId: string; readonly applicationId: string; readonly tenantId: string },
  ): Promise<ComputeEnvironmentRecord> => {
    void idempotencyKey;
    const check = validateEnvironmentRegistration(input);
    if (!check.valid) {
      throw new PlatformError({
        code: "SANDBOX_ERROR",
        message: `invalid compute environment specification: ${check.issues
          .map((issue) => `${issue.field}: ${issue.reason}`)
          .join("; ")}`,
        details: { issues: check.issues },
      });
    }
    if (input.applicationId !== actor.applicationId || input.tenantId !== actor.tenantId) {
      throw new PlatformError({
        code: "TENANT_SCOPE_VIOLATION",
        message: "environment registration scope must match the acting principal",
      });
    }
    const digest = hashSpec(canonicalEnvironmentJson(input.spec));
    const existing = await store.findEnvironmentBySlug(actor.applicationId, input.slug);
    if (existing !== null) {
      if (existing.tenantId !== actor.tenantId) {
        throw new PlatformError({
          code: "TENANT_SCOPE_VIOLATION",
          message: "environment slug already registered to another tenant",
          details: { slug: input.slug },
        });
      }
      // Content-addressed convergence: the identical specification converges
      // on the durable record; a DIFFERENT specification under the same slug
      // is an identity conflict — specifications are write-once.
      if (existing.specDigest !== digest) {
        throw new PlatformError({
          code: "SANDBOX_ERROR",
          message:
            "environment slug is already registered with a different specification; environment specifications are immutable (register a new slug)",
          details: { slug: input.slug, existingDigest: existing.specDigest, digest },
        });
      }
      return existing;
    }
    const claim = await store.insertEnvironment({
      id: generateId(),
      applicationId: actor.applicationId,
      tenantId: actor.tenantId,
      slug: input.slug,
      name: input.name,
      description: input.description ?? null,
      kind: input.spec.kind,
      spec: input.spec as unknown as Readonly<Record<string, unknown>>,
      specDigest: digest,
      createdAt: iso(),
    });
    return claim.record;
  };

  const transition = async (
    applicationId: string,
    environmentId: string,
    to: EnvironmentLifecycleStatus,
    idempotencyKey: string,
    actor: { readonly actorId: string; readonly applicationId: string; readonly tenantId: string },
  ): Promise<ComputeEnvironmentRecord> => {
    void idempotencyKey;
    const environment = await store.findEnvironment(applicationId, environmentId);
    if (environment === null) {
      throw new PlatformError({
        code: "TENANT_SCOPE_VIOLATION",
        message: "environment not found in this application",
        details: { environmentId },
      });
    }
    if (environment.tenantId !== actor.tenantId) {
      throw new PlatformError({
        code: "TENANT_SCOPE_VIOLATION",
        message: "environment belongs to a different tenant",
        details: { environmentId },
      });
    }
    if (environment.status === to) {
      // Idempotent convergence on the already-transitioned record.
      return environment;
    }
    if (!canTransitionEnvironment(environment.status, to)) {
      throw new PlatformError({
        code: "INVALID_STATE_TRANSITION",
        message: `compute environment cannot move from ${environment.status} to ${to}`,
        details: { environmentId, from: environment.status, to },
      });
    }
    const outcome = await store.updateEnvironmentStatus({
      applicationId,
      environmentId,
      from: environment.status,
      to,
      updatedAt: iso(),
    });
    return outcome.record;
  };

  return {
    register,
    async get(applicationId, environmentId) {
      return store.findEnvironment(applicationId, environmentId);
    },
    async getBySlug(applicationId, slug) {
      return store.findEnvironmentBySlug(applicationId, slug);
    },
    async list(applicationId) {
      return store.listEnvironments(applicationId);
    },
    suspend: (applicationId, environmentId, key, actor) =>
      transition(applicationId, environmentId, "suspended", key, actor),
    resume: (applicationId, environmentId, key, actor) =>
      transition(applicationId, environmentId, "available", key, actor),
    retire: (applicationId, environmentId, key, actor) =>
      transition(applicationId, environmentId, "retired", key, actor),
  };
}

/** Re-exported shape helpers for composition roots. */
export type { ComputeEnvironmentSpec };
