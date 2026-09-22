/**
 * deploy/preview-authorities — PPR-008: the preview authority
 * materialization module.
 *
 * THE MATERIALIZATION GATE (the work order's Requirement 1): the bootstrap
 * composition binds the REAL domain seams ONLY when the environment
 * materializes the preview authority set —
 *   - the relational URL: `ZECK_DATABASE_URL` (exactly the value /health's
 *     relational-state probe already consumes — `ZECK_PG_ADMIN_URL` on the
 *     local environment, mirroring deploy/api.ts's probe),
 *   - the transport token: `ZECK_TRANSPORT_TOKEN` (the materialized value of
 *     `ZECK_SECRET_TRANSPORT_TOKEN_REF` — the Lead's directly-materialized
 *     journey token; the reference binding is the manifest contract),
 *   - the preview application id: `ZECK_PREVIEW_APPLICATION_ID`.
 * ANY missing piece leaves the bootstrap composition EXACTLY today's honest
 * unbound shape (deploy/api.ts decides; both shapes are pinned by tests).
 *
 * THE BOUND AUTHORITY SET (Requirement 1, the canonical wiring references):
 *   - bearer authentication: `createBearerTokenAuthenticator` over the
 *     materialized token → the SEEDED transport principal (the durable
 *     credential row governs the token's validity — revoking the seeded
 *     credential genuinely disables the token);
 *   - SQL scope resolution: `createScopeResolver` over `createSqlAuthModule`
 *     (the durable membership/ownership rows are the ONLY scope producer);
 *   - the credential lifecycle service: `createCredentialService` over
 *     `createSqlCredentialModule` (issue/list/rotate/revoke semantics; the
 *     preview composes the read-only environment-materialization secret
 *     store, so the DEP-011 issuance gate is honestly CLOSED —
 *     `issuanceEnabled: false` — list and revoke are live over SQL, and the
 *     Lead's directly-materialized token is the sanctioned binding path);
 *   - the execution service: `createExecutionService` over
 *     `SqlExecutionStore` + `SqlExecutionsIdempotency` with the REAL policy
 *     admission authority (`createExecutionAuthorization` over
 *     `createPolicyAuthority` + a published baseline unrestricted set — the
 *     agents-world production composition pattern);
 *   - the agents inventory: the SQL registry (`createAgentRegistry` over
 *     `SqlAgentStore`) + the enumeration seam.
 *
 *     WIRING CONSTRAINT (recorded): the executions/agents/auth public
 *     barrels do not export their SQL adapters (`createSqlAuthModule`,
 *     `SqlExecutionStore`, `SqlExecutionsIdempotency`, `SqlAgentStore`);
 *     the canonical wiring reference
 *     (`tests/integration/postgres/executions-world.ts` /
 *     `agents-world.ts` / `credentials.test.ts`) imports the adapter files
 *     directly — this module mirrors that reference exactly (src/ is never
 *     modified).
 *
 * IDEMPOTENT PREVIEW SEEDING (Requirement 1): create-if-absent on EVERY cold
 * start, never duplicate, safe under concurrent isolates — every insert is
 * guarded (`ON CONFLICT DO NOTHING` over the schema's unique constraints:
 * the tenant/application ids, the actors' external subjects, the
 * memberships' (actor, application) pair, and the credential's
 * one-ACTIVE-per-identity partial unique index). All seeded identities are
 * DETERMINISTIC functions of the preview application id, so re-running the
 * seed converges on the SAME rows (pinned by the real-rail test: run twice →
 * same rows). Revocation of the transport credential is TERMINAL — a cold
 * start never resurrects a revoked credential row.
 *
 * The async reality: `buildBootstrapApp` is synchronous (the hosting
 * adapters compose it synchronously), so the authorities are CONSTRUCTED
 * synchronously (the pg pool is lazy) and the seeding runs as the cold-start
 * `ready` promise; the bound seams await the ready gate first and fail
 * closed (PROVIDER_ERROR, never a fabricated success) if the seeding failed.
 * GET /health independently reports the relational dependency's honest
 * state.
 */

import { createHash, timingSafeEqual } from "node:crypto";
import { type Authenticate, createBearerTokenAuthenticator } from "../src/api";
import type { AgentRegistry } from "../src/modules/agents/public";
import { createAgentRegistry, SqlAgentStore } from "../src/modules/agents/public";
import { createSqlAuthModule } from "../src/modules/auth/adapters/sql-identity-store";
import {
  type CredentialSecretStore,
  type CredentialService,
  createCredentialService,
  createPlatformCredentialSecretStore,
  createScopeResolver,
  createSqlCredentialModule,
  randomCredentialSecret,
  type ScopeResolver,
} from "../src/modules/auth/public";
import {
  SqlExecutionStore,
  SqlExecutionsIdempotency,
} from "../src/modules/executions/adapters/sql-execution-store";
import type { ExecutionService } from "../src/modules/executions/public";
import { createExecutionService } from "../src/modules/executions/public";
import {
  createExecutionAuthorization,
  createPolicyAuthority,
  InMemoryPolicyStore,
  nodePolicyHasher,
} from "../src/modules/policies/public";
import { parseConnectionConfig, redactConnectionString } from "../src/platform/db/connection";
import { createPgDatabasePort, type PgDatabasePort } from "../src/platform/db/pg-database-port";
import type { DatabasePort } from "../src/platform/db/port";
import type { EnvironmentId } from "../src/platform/deployment/naming";
import { createEnvSecretStore } from "../src/platform/secret-store/adapters/env-secret-store";
import { PlatformError } from "../src/shared/errors";
import { isUuid, uuidv7 } from "../src/shared/ids";

// ---------------------------------------------------------------------------
// The materialization gate
// ---------------------------------------------------------------------------

/** The secret NAME of the transport token (the reference URI segment). */
export const PREVIEW_TRANSPORT_TOKEN_SECRET_NAME = "transport-token";

/** The reference URI of the preview transport token's secret (name only). */
export function previewTransportTokenReference(environment: string): string {
  return `zeck-secret://${environment}/${PREVIEW_TRANSPORT_TOKEN_SECRET_NAME}`;
}

/** The relational URL variable of an environment (mirrors /health's probe). */
export function relationalUrlVariableOf(environment: EnvironmentId): string {
  return environment === "local" ? "ZECK_PG_ADMIN_URL" : "ZECK_DATABASE_URL";
}

/** What the environment materialized for the preview authority set. */
export type PreviewAuthorityMaterialization =
  | {
      readonly materialized: false;
      /** The missing variable NAMES (never values), in contract order. */
      readonly missing: readonly string[];
    }
  | {
      readonly materialized: true;
      readonly databaseUrl: string;
      readonly transportToken: string;
      readonly applicationId: string;
    };

/**
 * Read the preview authority materialization from an environment view.
 * Pure: no database contact, no value echo — failures report the missing
 * variable NAMES only (credential-shaped values never enter diagnostics).
 */
export function readPreviewAuthorityMaterialization(
  env: Readonly<Record<string, string | undefined>>,
  environment: EnvironmentId,
): PreviewAuthorityMaterialization {
  const missing: string[] = [];
  const databaseUrlVariable = relationalUrlVariableOf(environment);
  const databaseUrl = env[databaseUrlVariable]?.trim();
  if (databaseUrl === undefined || databaseUrl.length === 0) {
    missing.push(databaseUrlVariable);
  }
  const transportToken = env.ZECK_TRANSPORT_TOKEN?.trim();
  if (transportToken === undefined || transportToken.length === 0) {
    missing.push("ZECK_TRANSPORT_TOKEN");
  }
  const applicationIdRaw = env.ZECK_PREVIEW_APPLICATION_ID?.trim();
  if (applicationIdRaw === undefined || applicationIdRaw.length === 0) {
    missing.push("ZECK_PREVIEW_APPLICATION_ID");
  } else if (!isUuid(applicationIdRaw)) {
    // Fail closed on a malformed application identity (never a partial bind).
    missing.push("ZECK_PREVIEW_APPLICATION_ID (must be a UUID)");
  }
  if (missing.length > 0) {
    return { materialized: false, missing };
  }
  return {
    materialized: true,
    databaseUrl: databaseUrl as string,
    transportToken: transportToken as string,
    applicationId: applicationIdRaw as string,
  };
}

// ---------------------------------------------------------------------------
// Deterministic seed identities
// ---------------------------------------------------------------------------

/**
 * A deterministic UUID (sha256-derived, RFC 9562 string form) of the given
 * namespace + parts: the SAME inputs always yield the SAME id, so every
 * cold start's seeding converges on the same rows. No secret material ever
 * enters the derivation — the seeded identities are functions of the preview
 * application id only.
 */
export function deterministicPreviewUuid(namespace: string, ...parts: readonly string[]): string {
  const hex = createHash("sha256")
    .update(`${namespace}:${parts.join(":")}`, "utf8")
    .digest("hex");
  // Normalize the version/variant nibbles to a random-form UUID shape (the
  // durable columns accept any UUID; this keeps the ids well-formed).
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** The deterministic durable identities + labels of the preview seed. */
export interface PreviewSeedPlan {
  readonly applicationId: string;
  readonly tenantId: string;
  readonly tenantSlug: string;
  readonly applicationSlug: string;
  readonly transportActorId: string;
  readonly transportActorSubject: string;
  readonly transportMembershipId: string;
  readonly transportCredentialId: string;
  readonly credentialLabel: string;
  readonly substrateActorId: string;
  readonly substrateActorSubject: string;
  readonly substrateMembershipId: string;
  readonly secretReference: string;
}

/**
 * Derive the full seed plan from the preview application id (+ the
 * environment, for the secret reference's environment scope).
 */
export function previewSeedPlanOf(
  applicationId: string,
  environment: EnvironmentId,
): PreviewSeedPlan {
  const appSuffix = applicationId.replaceAll("-", "").slice(-10);
  return {
    applicationId,
    tenantId: deterministicPreviewUuid("zeck-preview-authority", "tenant", applicationId),
    tenantSlug: `preview-${appSuffix}`,
    applicationSlug: `preview-app-${appSuffix}`,
    transportActorId: deterministicPreviewUuid(
      "zeck-preview-authority",
      "transport-principal",
      applicationId,
    ),
    transportActorSubject: `zeck-preview-transport:${applicationId}`,
    transportMembershipId: deterministicPreviewUuid(
      "zeck-preview-authority",
      "transport-membership",
      applicationId,
    ),
    transportCredentialId: deterministicPreviewUuid(
      "zeck-preview-authority",
      "transport-credential",
      applicationId,
    ),
    credentialLabel: "Preview transport credential",
    substrateActorId: deterministicPreviewUuid(
      "zeck-preview-authority",
      "substrate-worker",
      applicationId,
    ),
    substrateActorSubject: `zeck-preview-substrate:${applicationId}`,
    substrateMembershipId: deterministicPreviewUuid(
      "zeck-preview-authority",
      "substrate-membership",
      applicationId,
    ),
    secretReference: previewTransportTokenReference(environment),
  };
}

// ---------------------------------------------------------------------------
// The seeding (runtime-idempotent, create-if-absent, concurrency-safe)
// ---------------------------------------------------------------------------

/**
 * Seed the durable preview rows: the tenant, the preview application (the
 * env's id), the transport principal + its OWNER membership, the substrate
 * worker principal + its membership, and the transport credential row
 * (active, referencing the environment's transport-token secret — the
 * material lives ONLY in the deployment environment, never in the record).
 *
 * Every statement is a guarded insert (`ON CONFLICT DO NOTHING`), so
 * concurrent isolates cold-starting simultaneously converge on one row set
 * (the schema's unique constraints are the arbitration), and a revoked
 * transport credential is never resurrected (the conflicting insert is
 * skipped; the authenticator honestly reports the revoked status).
 */
export async function seedPreviewAuthorities(
  db: DatabasePort,
  plan: PreviewSeedPlan,
): Promise<void> {
  await db.execute({
    sql: `INSERT INTO applications.tenants (id, slug, name)
          VALUES ($1, $2, $3)
          ON CONFLICT DO NOTHING`,
    parameters: [plan.tenantId, plan.tenantSlug, "Preview authority tenant"],
  });
  await db.execute({
    sql: `INSERT INTO applications.applications (id, tenant_id, slug, name)
          VALUES ($1, $2, $3, $4)
          ON CONFLICT DO NOTHING`,
    parameters: [plan.applicationId, plan.tenantId, plan.applicationSlug, "Preview application"],
  });
  // Coherence (fail closed): the application id must resolve to the preview
  // authority tenant — a foreign owner means the env's application id is
  // already bound elsewhere and the materialization refuses to mis-scope.
  const application = await db.execute<{ tenant_id: string }>({
    sql: "SELECT tenant_id FROM applications.applications WHERE id = $1",
    parameters: [plan.applicationId],
  });
  const owner = application.rows[0]?.tenant_id;
  if (owner !== plan.tenantId) {
    throw new Error(
      "the preview application id is owned by a different tenant than the preview authority tenant — the materialization refuses to mis-scope (bind a fresh ZECK_PREVIEW_APPLICATION_ID)",
    );
  }

  await db.execute({
    sql: `INSERT INTO identity.actors (id, external_subject, display_name)
          VALUES ($1, $2, $3)
          ON CONFLICT DO NOTHING`,
    parameters: [plan.transportActorId, plan.transportActorSubject, "Preview transport principal"],
  });
  await db.execute({
    sql: `INSERT INTO identity.actors (id, external_subject, display_name)
          VALUES ($1, $2, $3)
          ON CONFLICT DO NOTHING`,
    parameters: [
      plan.substrateActorId,
      plan.substrateActorSubject,
      "Preview deterministic substrate",
    ],
  });
  await db.execute({
    sql: `INSERT INTO identity.memberships (id, actor_id, application_id, tenant_id, role)
          VALUES ($1, $2, $3, $4, 'owner')
          ON CONFLICT DO NOTHING`,
    parameters: [
      plan.transportMembershipId,
      plan.transportActorId,
      plan.applicationId,
      plan.tenantId,
    ],
  });
  await db.execute({
    sql: `INSERT INTO identity.memberships (id, actor_id, application_id, tenant_id, role)
          VALUES ($1, $2, $3, $4, 'member')
          ON CONFLICT DO NOTHING`,
    parameters: [
      plan.substrateMembershipId,
      plan.substrateActorId,
      plan.applicationId,
      plan.tenantId,
    ],
  });
  await db.execute({
    sql: `INSERT INTO identity.application_credentials
            (id, credential_id, application_id, tenant_id, label, role, status, secret_reference)
          VALUES ($1, $2, $3, $4, $5, 'owner', 'active', $6)
          ON CONFLICT DO NOTHING`,
    parameters: [
      plan.transportCredentialId,
      plan.transportCredentialId,
      plan.applicationId,
      plan.tenantId,
      plan.credentialLabel,
      plan.secretReference,
    ],
  });
}

// ---------------------------------------------------------------------------
// The bound authority set
// ---------------------------------------------------------------------------

/** The seeding gate's terminal state (success, or the recorded failure). */
export interface PreviewAuthorityReadyState {
  readonly ok: boolean;
  readonly failure: string | null;
}

export interface PreviewAuthorities {
  readonly applicationId: string;
  readonly tenantId: string;
  readonly seed: PreviewSeedPlan;
  /** The relational DatabasePort the whole authority set is bound over. */
  readonly db: PgDatabasePort;
  /** The REAL execution service over the SQL fabric. */
  readonly executions: ExecutionService;
  /** The REAL agents registry over the SQL store. */
  readonly agents: AgentRegistry;
  /** The agents inventory enumeration seam (read-only SQL registry query). */
  readonly listAgentIdsOfApplication: (applicationId: string) => Promise<readonly string[]>;
  /** The credential lifecycle authority (issuance gate honestly closed). */
  readonly credentials: CredentialService;
  readonly scopeResolver: ScopeResolver;
  readonly authenticate: Authenticate;
  /** The substrate worker principal (the deterministic drive's provenance actor). */
  readonly substrateActor: { readonly actorId: string; readonly tenantId: string };
  readonly generateId: () => string;
  readonly now: () => Date;
  /** The cold-start seeding gate (resolved state, never a rejected promise). */
  readonly ready: Promise<PreviewAuthorityReadyState>;
  /** Fail-closed await of the seeding gate (the bound seams call this first). */
  awaitReady(): Promise<void>;
  /** Drain the relational pool (the CLI host's shutdown; isolates recycle). */
  close(): Promise<void>;
}

export interface PreviewAuthorityInputs {
  readonly environment: EnvironmentId;
  readonly databaseUrl: string;
  readonly transportToken: string;
  readonly applicationId: string;
  /**
   * The credential secret store the composition binds (OPTIONAL override:
   * the default is the platform's environment-materialization adapter —
   * read-only, so the issuance gate is honestly closed). A composition
   * whose secret store CAN hold issued material (a future Work Order's
   * durable secret adapter; the integration proof's issuance-capable
   * store) binds the gate open through `issuanceEnabled`.
   */
  readonly credentialSecretStore?: CredentialSecretStore;
  /** The issuance gate (defaults closed: the env materialization is read-only). */
  readonly issuanceEnabled?: boolean;
}

/** Constant-time bearer comparison (never a data-leaking early exit). */
function tokensMatch(presented: string, expected: string): boolean {
  const a = Buffer.from(presented, "utf8");
  const b = Buffer.from(expected, "utf8");
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Build the materialized preview authority set over the real relational
 * DatabasePort. Synchronous (the pg pool connects lazily); the durable
 * seeding + the baseline policy publication run as the cold-start `ready`
 * promise every bound seam awaits first.
 */
export function buildPreviewAuthorities(inputs: PreviewAuthorityInputs): PreviewAuthorities {
  const config = parseConnectionConfig(inputs.databaseUrl);
  const db = createPgDatabasePort(config);
  const plan = previewSeedPlanOf(inputs.applicationId, inputs.environment);

  const generateId = uuidv7;
  const now = (): Date => new Date();

  // The auth module (identity store + the credential SQL module over the port).
  const auth = createSqlAuthModule(db, generateId);
  const credentialsModule = createSqlCredentialModule(db, generateId);

  // The honest secret-store capability of this composition: the DEFAULT is
  // the environment materialization (READ-ONLY — values are materialized by
  // the external provisioning plane), so the credential service's issuance
  // gate is closed; an injected capable store binds the gate open (the
  // integration proof's issuance-capable composition).
  const secretStore: CredentialSecretStore =
    inputs.credentialSecretStore ??
    createPlatformCredentialSecretStore(
      createEnvSecretStore({ environment: inputs.environment, env: process.env }),
    );
  const issuanceEnabled = inputs.issuanceEnabled ?? false;
  const resolver = createScopeResolver(auth.store);

  const credentials = createCredentialService({
    identityStore: auth.store,
    credentialStore: credentialsModule.store,
    idempotency: credentialsModule.idempotency,
    resolver,
    generateId,
    generateSecret: randomCredentialSecret,
    now,
    secretStore,
    issuanceEnabled,
  });

  // The executions authority: the REAL policy admission behind the
  // authorize seam (a baseline unrestricted set is published at cold start —
  // the agents-world production composition pattern; without a published set
  // the authority denies by default, which would strand every preview
  // execution in CREATED).
  const policyStore = new InMemoryPolicyStore();
  const policyAuthority = createPolicyAuthority({ store: policyStore, hasher: nodePolicyHasher });
  const authorization = createExecutionAuthorization(policyAuthority);
  const executions = createExecutionService({
    store: new SqlExecutionStore(db),
    idempotency: new SqlExecutionsIdempotency(db, (tx) => new SqlExecutionStore(tx), generateId),
    authorization,
    generateId,
    now,
  });

  // The agents authority: the SQL registry + the read-only inventory seam.
  const agents = createAgentRegistry({
    store: new SqlAgentStore(db),
    generateId,
    now,
    hashDefinition: (canonicalJson: string) =>
      createHash("sha256").update(canonicalJson, "utf8").digest("hex"),
  });
  const listAgentIdsOfApplication = async (applicationId: string): Promise<readonly string[]> => {
    const found = await db.execute<{ id: string }>({
      sql: `SELECT id FROM agents.agents WHERE application_id = $1 ORDER BY created_at ASC, id ASC`,
      parameters: [applicationId],
    });
    return found.rows.map((row) => row.id);
  };

  // The cold-start seeding gate: the durable seed + the baseline policy set.
  const ready: Promise<PreviewAuthorityReadyState> = (async () => {
    try {
      await seedPreviewAuthorities(db, plan);
      await policyAuthority.publish({
        id: "preview-baseline",
        version: 1,
        documents: [{ scope: "platform", selector: {}, restrictions: {} }],
      });
      return { ok: true, failure: null };
    } catch (error) {
      // Credential-shaped values never enter the recorded failure.
      return { ok: false, failure: redactConnectionString((error as Error).message) };
    }
  })();
  const awaitReady = async (): Promise<void> => {
    const state = await ready;
    if (!state.ok) {
      throw new PlatformError({
        code: "PROVIDER_ERROR",
        message: `the preview authorities are unavailable: the cold-start seeding did not complete (${state.failure}); see GET /health for the relational dependency state`,
      });
    }
  };

  // Bearer authentication over the materialized transport token: the token
  // resolves to the SEEDED principal iff it matches the materialized value
  // AND the durable credential row is ACTIVE — revoking the transport
  // credential genuinely disables the token (the real lifecycle effect).
  const authenticate: Authenticate = createBearerTokenAuthenticator(async (token) => {
    await awaitReady();
    if (!tokensMatch(token, inputs.transportToken)) {
      return null;
    }
    const current = await credentialsModule.store.findCurrentByCredentialId(
      plan.transportCredentialId,
    );
    if (current === null || current.status !== "active") {
      return null;
    }
    return { actorId: plan.transportActorId };
  });

  let closed = false;
  return {
    applicationId: plan.applicationId,
    tenantId: plan.tenantId,
    seed: plan,
    db,
    executions,
    agents,
    listAgentIdsOfApplication,
    credentials,
    scopeResolver: resolver,
    authenticate,
    substrateActor: { actorId: plan.substrateActorId, tenantId: plan.tenantId },
    generateId,
    now,
    ready,
    awaitReady,
    async close(): Promise<void> {
      if (closed) {
        return;
      }
      closed = true;
      await db.close();
    },
  };
}
