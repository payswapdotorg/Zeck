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
 * PPR-014 — THE GAP-006 SEAM BINDINGS (the SAME materialization gate, zero
 * new environment variables): when the authority set materializes, the
 * composition additionally binds the two remaining domain seams over the
 * SAME relational DatabasePort —
 *   - the ECONOMICS authority: `createEconomicActionService` over
 *     `createSqlEconomicsModule` (migration 0014; idempotency arbitration on
 *     `platform.idempotency_records`) with EVERY dependency REAL — policy
 *     admission through `createPolicyEconomicAdmission` wrapping the SAME
 *     policy authority the executions authorize seam uses; capability
 *     admission through `createCapabilityEconomicAdmission` wrapping the
 *     REAL capabilities registry (the module's code-resident seed catalog,
 *     arbitrated through the registry's identical publish path — the
 *     registry constructor is async, so the admission port awaits its
 *     construction; every call still flows through the REAL adapter); the
 *     budgets authority (`SqlBudgetStore` + `SqlBudgetsIdempotency` +
 *     `createBudgetService` — the budgets-world wiring; the budgets barrel
 *     does not export the SQL adapters either, mirroring the recorded
 *     constraint above); the executions ledger seam (the already-bound
 *     execution service's `recordStepEvent`); and the payment rail = the
 *     in-repo `createSimulatedPaymentRail` (rail id
 *     `preview-simulated-rail`; honestly disclosed — the settlement
 *     observations it produces carry `evidence.simulated: true` by the
 *     rail's own contract; the preview NEVER touches an external payment
 *     provider). NO MODEL is behind this authority: the bounded
 *     authorization is the governed WORK-032 boundary (ADR-0018: intent
 *     != authorization != transaction != settlement != verification).
 *   - the CODEBASE-ANALYSIS authority: `createOpportunityAnalyzer` over
 *     `SqlOpportunityStore` (migration 0016) + the learning module's node
 *     digest + the shared uuidv7 generator + the clock — DETERMINISTIC by
 *     construction, no model behind it. The analyzer is the ADVISORY
 *     analysis service (learning non-authority); the route's mandatory
 *     executionId flows through the ALREADY-BOUND executions authority (the
 *     route composes the authorities — no second admission path, M2/M26).
 *   - THE WALLET SEEDING (runtime-idempotent, the same law as the durable
 *     seed): the preview application's funded developer wallet is
 *     create-if-absent on every cold start through the REAL budgets
 *     authority — `configureFundingMode(developer)` + `grantCredits` under
 *     DETERMINISTIC idempotency keys (pure functions of the application
 *     id), so run-twice converges on the same rows with NO double credit
 *     and concurrent isolates arbitrate through the idempotency ledger. The
 *     grant amount is `PREVIEW_WALLET_GRANT_MICRO_USD` (recorded honestly in
 *     deploy/evidence/ppr-014.json). The capability catalog is the module's
 *     own code-resident seed catalog rebuilt at composition (its designed
 *     storage surface — the arbitrated catalog converges by construction).
 *     Both seedings run inside the SAME cold-start ready gate (a failure
 *     fails closed exactly like the durable seed; the retry law applies).
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
 * state. A FAILED seeding attempt is never a permanent isolate sentence
 * (the live plane's finding): the gate retries on the next `awaitReady()`
 * call — runtime-idempotent seeding + converging republish make every
 * retry safe — and keeps failing closed while the dependency is down.
 */

import { createHash, timingSafeEqual } from "node:crypto";
import { type Authenticate, createBearerTokenAuthenticator } from "../src/api";
import { createSimulatedPaymentRail } from "../src/integrations/payment-rails/public";
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
  SqlBudgetStore,
  SqlBudgetsIdempotency,
} from "../src/modules/budgets/adapters/sql-budget-store";
import { createBudgetService } from "../src/modules/budgets/public";
import {
  createCapabilityRegistry,
  createInMemoryCatalogStore,
  SEED_CAPABILITY_FACTS,
} from "../src/modules/capabilities/public";
import {
  createCapabilityEconomicAdmission,
  createEconomicActionService,
  createPolicyEconomicAdmission,
  createSqlEconomicsModule,
  type EconomicActionService,
  type EconomicCapabilityAdmissionInput,
  type EconomicCapabilityAdmissionPort,
} from "../src/modules/economics/public";
import {
  SqlExecutionStore,
  SqlExecutionsIdempotency,
} from "../src/modules/executions/adapters/sql-execution-store";
import type { ExecutionService } from "../src/modules/executions/public";
import { createExecutionService } from "../src/modules/executions/public";
import {
  createNodeDigest,
  createOpportunityAnalyzer,
  type OpportunityAnalyzer,
  SqlOpportunityStore,
} from "../src/modules/learning/public";
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

// ---------------------------------------------------------------------------
// PPR-014 — the GAP-006 seam constants (the economics + analyzer bindings)
// ---------------------------------------------------------------------------

/**
 * The honest rail id of the preview's payment rail: the IN-REPO simulated
 * rail (`createSimulatedPaymentRail`) — no network, no real payment system,
 * no credentials. The settlement observations it produces carry
 * `evidence.simulated: true` by the rail adapter's own contract, and this id
 * names it on every rail-transaction reference (`sim:<id>:<n>`).
 */
export const PREVIEW_PAYMENT_RAIL_ID = "preview-simulated-rail";

/**
 * The preview developer wallet's cold-start grant, in micro-USD ($10). An
 * honest, recorded amount — the wallets ledger is the REAL budgets ledger
 * (migration 0003); the "money" is seeded credits the plane's economic
 * actions reserve against, never real funds (the rail is simulated and no
 * external payment provider is ever touched).
 */
export const PREVIEW_WALLET_GRANT_MICRO_USD = "10000000";

/**
 * The deterministic funding-mode idempotency key (a pure function of the
 * preview application id — every cold start replays, never re-configures).
 */
export function previewWalletFundingKey(applicationId: string): string {
  return `preview-wallet-funding:${applicationId}`;
}

/**
 * The deterministic wallet-grant idempotency key (a pure function of the
 * preview application id — every cold start replays, NEVER re-credits).
 */
export function previewWalletGrantKey(applicationId: string): string {
  return `preview-wallet-grant:${applicationId}`;
}

// ---------------------------------------------------------------------------
// PPR-014 — the analysis-aware executions seam (the two-runtimes dispatch)
// ---------------------------------------------------------------------------

/**
 * The task kind of an analysis execution — the FROZEN route's own pinned
 * vocabulary (`src/api/routes/codebase-analysis.ts` creates every analysis
 * execution with `task: { kind: "codebase-analysis", repository, revision }`).
 * The seam's dispatch follows the route's frozen vocabulary by necessity:
 * it is the only composition-visible signal of "the analysis route composes
 * THIS execution's runtime".
 */
export const ANALYSIS_TASK_KIND = "codebase-analysis";

export interface AnalysisAwareExecutionsDeps {
  /**
   * The substrate-driven seam (PPR-008's binding): sandbox executions are
   * driven to an honest terminal receipt inline by the deterministic
   * substrate — the plane's ONLY runtime for ordinary sandbox tasks.
   */
  readonly sandbox: ExecutionService;
  /**
   * The REAL execution service (unwrapped): the write path the analysis
   * route composes its OWN lifecycle over (create -> authorize [POLICY
   * ADMISSION through the executions authority] -> plan -> queue -> start
   * -> the deterministic analysis -> verify -> pass).
   */
  readonly analysis: ExecutionService;
}

/**
 * The executions seam the preview API composition binds — TWO RUNTIMES,
 * one seam, dispatched without overlap (the composition-level resolution of
 * the substrate-drive/route-lifecycle collision this order discovered on
 * the materialized plane, documented with its trade-offs in
 * deploy/evidence/ppr-014.json):
 *
 *  - ordinary sandbox tasks → the substrate-wrapped service (PPR-008's
 *    pinned behavior UNCHANGED: a credentialed create is driven to an
 *    honest terminal receipt inline; the create response IS the receipt);
 *  - `codebase-analysis` tasks → the REAL service with NO inline drive:
 *    "Analysis is an Execution" whose RUNTIME is the analysis route's own
 *    composition (M2/M26 — the policy admission happens through the
 *    executions authority's authorize transition BEFORE the analyzer runs,
 *    and the completion rule binds the analysis digest as the durable
 *    verification evidence).
 *
 * Every other method delegates to the substrate-wrapped service, which
 * itself delegates unchanged to the REAL service — the single write path
 * (the state machine, the idempotency arbitration, the append-only ledger)
 * is shared by both runtimes and bypassed by NEITHER.
 *
 * HONEST CONSEQUENCE (recorded): a `codebase-analysis` task posted
 * DIRECTLY to POST /executions (not through the analysis route) is created
 * WITHOUT the substrate's drive and stays CREATED — the substrate never
 * masquerades as an analysis runtime it did not run, and no other runtime
 * exists for it on this plane. Never a fabricated terminal receipt.
 */
export function createAnalysisAwareExecutions(deps: AnalysisAwareExecutionsDeps): ExecutionService {
  const { sandbox, analysis } = deps;
  return {
    async createExecution(input, idempotencyKey, actor) {
      if (input.task.kind === ANALYSIS_TASK_KIND) {
        return analysis.createExecution(input, idempotencyKey, actor);
      }
      return sandbox.createExecution(input, idempotencyKey, actor);
    },
    async transition(command, idempotencyKey) {
      return sandbox.transition(command, idempotencyKey);
    },
    async recordPlanningDecision(input, idempotencyKey) {
      return sandbox.recordPlanningDecision(input, idempotencyKey);
    },
    async recordStepEvent(input, idempotencyKey) {
      return sandbox.recordStepEvent(input, idempotencyKey);
    },
    async getExecution(applicationId, executionId) {
      return sandbox.getExecution(applicationId, executionId);
    },
    async listEvents(applicationId, executionId) {
      return sandbox.listEvents(applicationId, executionId);
    },
    async listVerificationResults(applicationId, executionId) {
      return sandbox.listVerificationResults(applicationId, executionId);
    },
  };
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
// PPR-014 — the economic-authority seeding (runtime-idempotent)
// ---------------------------------------------------------------------------

/**
 * Seed the preview application's funded developer wallet through the REAL
 * budgets authority: `configureFundingMode(developer)` + `grantCredits`
 * under DETERMINISTIC idempotency keys (pure functions of the application
 * id). Create-if-absent on every cold start: a re-run REPLAYS the same
 * durable outcome (the idempotency ledger arbitrates — no second credit, no
 * second funding-settings row), and concurrent isolates cold-starting
 * simultaneously converge on ONE wallet through the same arbitration (the
 * budgets-concurrency discipline). The substrate worker principal is the
 * seeding actor (the composition's own provenance actor — the same actor
 * that drives the deterministic substrate's ledger envelopes).
 */
export async function seedPreviewEconomicAuthorities(
  budget: Pick<ReturnType<typeof createBudgetService>, "configureFundingMode" | "grantCredits">,
  plan: PreviewSeedPlan,
): Promise<void> {
  const scope = {
    actorId: plan.substrateActorId,
    applicationId: plan.applicationId,
    tenantId: plan.tenantId,
  };
  await budget.configureFundingMode(
    { ...scope, fundingMode: "developer" },
    previewWalletFundingKey(plan.applicationId),
  );
  await budget.grantCredits(
    { ...scope, ownerKind: "developer", amountMicroUsd: PREVIEW_WALLET_GRANT_MICRO_USD },
    previewWalletGrantKey(plan.applicationId),
  );
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
  /**
   * PPR-014: the REAL economic-action service over the SQL fabric
   * (migration 0014) — every dependency REAL (the policy/capability
   * admission adapters, the budgets authority, the executions ledger seam).
   */
  readonly economics: EconomicActionService;
  /**
   * PPR-014: the composition's payment rail — the IN-REPO simulated rail,
   * honestly disclosed (`railId` names it; every settlement observation
   * carries `evidence.simulated: true`). The preview NEVER touches an
   * external payment provider. The `charges` surface is the rail adapter's
   * own read-only observation of what it was asked to charge.
   */
  readonly paymentRail: ReturnType<typeof createSimulatedPaymentRail>;
  /**
   * PPR-014: the DETERMINISTIC codebase-analysis authority (the advisory
   * opportunity analyzer over `SqlOpportunityStore`; no model behind it —
   * the route composes it WITH the already-bound executions authority).
   */
  readonly codebaseAnalyzer: OpportunityAnalyzer;
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

  // PPR-014 — THE ECONOMICS AUTHORITY: every dependency REAL over the same
  // relational DatabasePort. The budgets seam is the REAL budgets SQL
  // authority (SqlBudgetStore + SqlBudgetsIdempotency + createBudgetService —
  // the budgets-world wiring; the budgets barrel does not export the SQL
  // adapters, mirroring the recorded wiring constraint). The economics store
  // + idempotency ride migration 0014 over `platform.idempotency_records`.
  const budgets = createBudgetService({
    store: new SqlBudgetStore(db),
    idempotency: new SqlBudgetsIdempotency(db, (tx) => new SqlBudgetStore(tx), generateId),
    generateId,
    now,
  });
  const economicModule = createSqlEconomicsModule(db, generateId);
  // Policy admission: the REAL adapter wrapping the SAME policy authority
  // the executions authorize seam uses (the baseline unrestricted set is
  // republished at every cold start below — an economic action's admission
  // evaluates against the published set, exactly like an execution's).
  const economicPolicyAdmission = createPolicyEconomicAdmission(policyAuthority);
  // Capability admission: the REAL adapter wrapping the REAL capabilities
  // registry. The registry constructor is ASYNC (its seed arbitration runs
  // the code-resident catalog through the identical publish path), so the
  // port awaits the adapter's construction — every call then flows through
  // the REAL adapter unchanged. The construction is awaited inside the
  // cold-start ready gate too (a rejected seed fact would fail the gate —
  // fail closed, never a silently empty catalog).
  const capabilityAdmission = createCapabilityRegistry({
    store: createInMemoryCatalogStore(),
    seed: SEED_CAPABILITY_FACTS,
  }).then((registry) => createCapabilityEconomicAdmission(registry));
  const economicCapabilityAdmission: EconomicCapabilityAdmissionPort = {
    async resolve(input: EconomicCapabilityAdmissionInput) {
      return (await capabilityAdmission).resolve(input);
    },
  };
  const economics = createEconomicActionService({
    store: economicModule.store,
    idempotency: economicModule.idempotency,
    policy: economicPolicyAdmission,
    capabilities: economicCapabilityAdmission,
    budget: budgets,
    // The executions ledger seam: the already-bound execution service's
    // recordStepEvent (the single write path economic evidence rides).
    executions,
    generateId,
    now,
  });
  // The composition's payment rail: the IN-REPO simulated rail, honestly
  // disclosed (railId + evidence.simulated on every settlement observation).
  // The preview NEVER touches an external payment provider.
  const paymentRail = createSimulatedPaymentRail({ railId: PREVIEW_PAYMENT_RAIL_ID });

  // PPR-014 — THE CODEBASE-ANALYSIS AUTHORITY: the deterministic advisory
  // opportunity analyzer over the SQL opportunity store (migration 0016) +
  // the learning module's node digest + the shared id generator + the clock.
  // No model behind it; the route composes it with the executions authority
  // (the mandatory executionId admission flows through THAT authority).
  const codebaseAnalyzer = createOpportunityAnalyzer({
    store: new SqlOpportunityStore(db),
    digest: createNodeDigest(),
    generateId,
    now,
  });

  // The cold-start seeding gate: the durable seed + the baseline policy set.
  // RETRY-ON-FAILURE (the live plane's §13.6 finding, 2026-09-23): a
  // TRANSIENT relational failure at cold start — the free-tier endpoint's
  // autosuspend wake-up racing the isolate's first connect ("Connection
  // terminated due to connection timeout") — must not permanently degrade
  // the isolate: the original single-shot gate cached its failure for the
  // isolate's whole lifetime while GET /health (which probes independently)
  // reported the dependency reachable again. The gate now REPLACES every
  // failed attempt with exactly one new attempt, started by the first
  // awaitReady() caller that observes the failure (concurrent callers share
  // the SAME in-flight replacement — no stacked retries). The retry is safe
  // by the seeding's own design: runtime-idempotent guarded inserts (ON
  // CONFLICT DO NOTHING) and the identical policy republish converges — a
  // retry either converges on the SAME rows or fails closed again with the
  // honest PROVIDER_ERROR (a revoked transport credential is still never
  // resurrected: the conflicting insert is skipped and the authenticator
  // reports the durable row's status).
  const startReadyAttempt = (): Promise<PreviewAuthorityReadyState> =>
    (async () => {
      try {
        await seedPreviewAuthorities(db, plan);
        await policyAuthority.publish({
          id: "preview-baseline",
          version: 1,
          documents: [{ scope: "platform", selector: {}, restrictions: {} }],
        });
        // PPR-014: the capability registry's seed arbitration (fail-closed —
        // a rejected seed fact fails the gate) + the funded developer wallet
        // (runtime-idempotent through the deterministic idempotency keys —
        // a retry converges on the SAME rows or fails closed honestly).
        await capabilityAdmission;
        await seedPreviewEconomicAuthorities(budgets, plan);
        return { ok: true, failure: null };
      } catch (error) {
        // Credential-shaped values never enter the recorded failure.
        return { ok: false, failure: redactConnectionString((error as Error).message) };
      }
    })();
  let closed = false;
  let ready: Promise<PreviewAuthorityReadyState> = startReadyAttempt();
  const awaitReady = async (): Promise<void> => {
    let attempt = ready;
    let state = await attempt;
    if (!state.ok && !closed) {
      // The failed attempt is replaced EXACTLY ONCE: the first caller to
      // observe the failure of the CURRENT gate starts the replacement;
      // callers observing an already-replaced gate join it instead.
      if (ready === attempt) {
        ready = startReadyAttempt();
      }
      attempt = ready;
      state = await attempt;
    }
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

  return {
    applicationId: plan.applicationId,
    tenantId: plan.tenantId,
    seed: plan,
    db,
    executions,
    agents,
    listAgentIdsOfApplication,
    credentials,
    economics,
    paymentRail,
    codebaseAnalyzer,
    scopeResolver: resolver,
    authenticate,
    substrateActor: { actorId: plan.substrateActorId, tenantId: plan.tenantId },
    generateId,
    now,
    // The LIVE gate (a getter, not a captured promise): the current
    // attempt's resolved state — after a failed attempt + a successful
    // retry this resolves ok (the retry's whole purpose).
    get ready(): Promise<PreviewAuthorityReadyState> {
      return ready;
    },
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
