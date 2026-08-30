/**
 * SQL adapter for the applications module (WORK-002).
 *
 * Bridges `ApplicationStore` and this module's `IdempotencyPort` to the
 * provider-neutral platform `DatabasePort`. Cross-schema writes
 * (`insertTenantWithOwner`, `insertApplicationWithOwner` also insert the
 * auth-owned membership row) are confined to this adapter and guarded by the
 * migration's composite foreign keys — no TypeScript-level cross-module
 * import exists beyond `auth`'s public barrel in the application layer.
 */

import type { DatabasePort, Transaction } from "../../../platform/db/port";
import { PlatformError } from "../../../shared/errors";
import type { Application, Environment, EnvironmentKind, Tenant } from "../domain/ownership";
import type {
  ApplicationStore,
  CreateApplicationInput,
  CreateEnvironmentInput,
  CreateTenantInput,
} from "../ports/application-store";
import type {
  IdempotencyArbitration,
  IdempotencyPort,
  IdempotencyScope,
} from "../ports/idempotency";

/** Either a full port (owns transactions) or an existing transaction (execute-only). */
type Executor = DatabasePort | Transaction;

const isFullPort = (executor: Executor): executor is DatabasePort =>
  typeof (executor as DatabasePort).transaction === "function";

/** First row or undefined (noUncheckedIndexedAccess-safe). */
function first<T>(rows: readonly T[]): T | undefined {
  return rows.length > 0 ? rows[0] : undefined;
}

interface TenantRow {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly created_at: Date | string;
}

interface ApplicationRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly slug: string;
  readonly name: string;
  readonly created_at: Date | string;
}

interface EnvironmentRow {
  readonly id: string;
  readonly application_id: string;
  readonly tenant_id: string;
  readonly kind: EnvironmentKind;
  readonly name: string;
  readonly created_at: Date | string;
}

interface LedgerRow {
  readonly durable_outcome: unknown;
}

const iso = (value: Date | string): string =>
  value instanceof Date ? value.toISOString() : String(value);

const toTenant = (row: TenantRow): Tenant => ({
  id: row.id,
  slug: row.slug,
  name: row.name,
  createdAt: iso(row.created_at),
});

const toApplication = (row: ApplicationRow): Application => ({
  id: row.id,
  tenantId: row.tenant_id,
  slug: row.slug,
  name: row.name,
  createdAt: iso(row.created_at),
});

const toEnvironment = (row: EnvironmentRow): Environment => ({
  id: row.id,
  applicationId: row.application_id,
  tenantId: row.tenant_id,
  kind: row.kind,
  name: row.name,
  createdAt: iso(row.created_at),
});

class SqlApplicationStore implements ApplicationStore {
  constructor(private readonly exec: Executor) {}
  async insertTenantWithOwner(input: CreateTenantInput & { ownerId: string }): Promise<Tenant> {
    // Guarded by a dedicated method-level transaction: tenant + tenant-scope
    // owner membership commit atomically (a tenant never exists unowned).
    return this.wrap(async (tx) => {
      const inserted = await tx.execute<TenantRow>({
        sql: `INSERT INTO applications.tenants (id, slug, name)
              VALUES ($1, $2, $3)
              ON CONFLICT (slug) DO UPDATE SET slug = EXCLUDED.slug
              RETURNING id, slug, name, created_at`,
        parameters: [input.id, input.slug, input.name],
      });
      const tenantRow = first(inserted.rows);
      if (tenantRow === undefined) {
        throw new PlatformError({
          code: "PROVIDER_ERROR",
          message: "tenant insert returned no row",
        });
      }
      await tx.execute({
        sql: `INSERT INTO identity.memberships (id, actor_id, application_id, tenant_id, role)
              VALUES ($1, $2, NULL, $3, 'owner')
              ON CONFLICT (actor_id, tenant_id) WHERE application_id IS NULL DO NOTHING`,
        parameters: [input.id, input.ownerId, tenantRow.id],
      });
      return toTenant(tenantRow);
    });
  }

  async findTenantBySlug(slug: string): Promise<Tenant | null> {
    const found = await this.exec.execute<TenantRow>({
      sql: "SELECT id, slug, name, created_at FROM applications.tenants WHERE slug = $1",
      parameters: [slug],
    });
    const row = first(found.rows);
    return row === undefined ? null : toTenant(row);
  }

  async findTenant(id: string): Promise<Tenant | null> {
    const found = await this.exec.execute<TenantRow>({
      sql: "SELECT id, slug, name, created_at FROM applications.tenants WHERE id = $1",
      parameters: [id],
    });
    const row = first(found.rows);
    return row === undefined ? null : toTenant(row);
  }

  async insertApplicationWithOwner(
    input: CreateApplicationInput & { ownerId: string },
  ): Promise<Application | null> {
    return this.wrap(async (tx) => {
      const inserted = await tx.execute<ApplicationRow>({
        sql: `INSERT INTO applications.applications (id, tenant_id, slug, name)
              VALUES ($1, $2, $3, $4)
              ON CONFLICT (tenant_id, slug) DO NOTHING
              RETURNING id, tenant_id, slug, name, created_at`,
        parameters: [input.id, input.tenantId, input.slug, input.name],
      });
      const applicationRow = first(inserted.rows);
      if (applicationRow === undefined) {
        return null;
      }
      const application = toApplication(applicationRow);
      await tx.execute({
        sql: `INSERT INTO identity.memberships (id, actor_id, application_id, tenant_id, role)
              VALUES ($1, $2, $3, $4, 'owner')
              ON CONFLICT (actor_id, application_id) DO NOTHING`,
        parameters: [input.id, input.ownerId, application.id, application.tenantId],
      });
      return application;
    });
  }

  async findApplication(id: string): Promise<Application | null> {
    const found = await this.exec.execute<ApplicationRow>({
      sql: "SELECT id, tenant_id, slug, name, created_at FROM applications.applications WHERE id = $1",
      parameters: [id],
    });
    const row = first(found.rows);
    return row === undefined ? null : toApplication(row);
  }

  async findApplicationByTenantSlug(tenantId: string, slug: string): Promise<Application | null> {
    const found = await this.exec.execute<ApplicationRow>({
      sql: "SELECT id, tenant_id, slug, name, created_at FROM applications.applications WHERE tenant_id = $1 AND slug = $2",
      parameters: [tenantId, slug],
    });
    const row = first(found.rows);
    return row === undefined ? null : toApplication(row);
  }

  async insertEnvironment(input: CreateEnvironmentInput): Promise<Environment | null> {
    const inserted = await this.exec.execute<EnvironmentRow>({
      sql: `INSERT INTO applications.environments (id, application_id, tenant_id, kind, name)
            VALUES ($1, $2, $3, $4, $5)
            ON CONFLICT (application_id, name) DO NOTHING
            RETURNING id, application_id, tenant_id, kind, name, created_at`,
      parameters: [input.id, input.applicationId, input.tenantId, input.kind, input.name],
    });
    const row = first(inserted.rows);
    return row === undefined ? null : toEnvironment(row);
  }

  async listEnvironments(applicationId: string): Promise<readonly Environment[]> {
    const found = await this.exec.execute<EnvironmentRow>({
      sql: `SELECT id, application_id, tenant_id, kind, name, created_at
            FROM applications.environments WHERE application_id = $1 ORDER BY created_at, id`,
      parameters: [applicationId],
    });
    return found.rows.map(toEnvironment);
  }

  async findEnvironment(id: string): Promise<Environment | null> {
    const found = await this.exec.execute<EnvironmentRow>({
      sql: `SELECT id, application_id, tenant_id, kind, name, created_at
            FROM applications.environments WHERE id = $1`,
      parameters: [id],
    });
    const row = first(found.rows);
    return row === undefined ? null : toEnvironment(row);
  }

  /** Run `work` in a transaction: the ambient one when tx-bound, else a new one on the port. */
  private wrap<T>(work: (tx: Transaction) => Promise<T>): Promise<T> {
    if (isFullPort(this.exec)) {
      return this.exec.transaction(work);
    }
    return work(this.exec);
  }
}

class SqlIdempotency implements IdempotencyPort {
  constructor(
    private readonly db: DatabasePort,
    private readonly generateId: () => string,
  ) {}

  async arbitrate<T>(
    scope: IdempotencyScope,
    operationName: string,
    idempotencyKey: string,
    requestFingerprint: string,
    work: (txStore: ApplicationStore) => Promise<T>,
  ): Promise<IdempotencyArbitration<T>> {
    return this.db.transaction(async (tx) => {
      const applicationScoped = scope.applicationId !== null;
      const insertSql = applicationScoped
        ? `INSERT INTO platform.idempotency_records
             (id, actor_id, application_id, operation_name, idempotency_key, request_fingerprint, durable_outcome)
           VALUES ($1, $2, $3, $4, $5, $6, '"pending"'::jsonb)
           ON CONFLICT (application_id, operation_name, idempotency_key) WHERE application_id IS NOT NULL
           DO NOTHING
           RETURNING id, request_fingerprint`
        : `INSERT INTO platform.idempotency_records
             (id, actor_id, application_id, operation_name, idempotency_key, request_fingerprint, durable_outcome)
           VALUES ($1, $2, NULL, $3, $4, $5, '"pending"'::jsonb)
           ON CONFLICT (actor_id, operation_name, idempotency_key) WHERE application_id IS NULL
           DO NOTHING
           RETURNING id, request_fingerprint`;
      const parameters = applicationScoped
        ? [
            this.generateId(),
            scope.actorId,
            scope.applicationId,
            operationName,
            idempotencyKey,
            requestFingerprint,
          ]
        : [this.generateId(), scope.actorId, operationName, idempotencyKey, requestFingerprint];

      const inserted = await tx.execute<{ id: string; request_fingerprint: string }>({
        sql: insertSql,
        parameters,
      });

      if (inserted.rows.length === 0) {
        const selectSql = applicationScoped
          ? `SELECT request_fingerprint, durable_outcome FROM platform.idempotency_records
             WHERE application_id = $1 AND operation_name = $2 AND idempotency_key = $3`
          : `SELECT request_fingerprint, durable_outcome FROM platform.idempotency_records
             WHERE actor_id = $1 AND application_id IS NULL AND operation_name = $2 AND idempotency_key = $3`;
        const selectParams = applicationScoped
          ? [scope.applicationId, operationName, idempotencyKey]
          : [scope.actorId, operationName, idempotencyKey];
        const existing = await tx.execute<LedgerRow & { request_fingerprint: string }>({
          sql: selectSql,
          parameters: selectParams,
        });
        const row = first(existing.rows);
        if (row === undefined) {
          throw new PlatformError({
            code: "PROVIDER_ERROR",
            message: "idempotency key conflict disappeared during arbitration",
          });
        }
        if (row.request_fingerprint !== requestFingerprint) {
          throw new PlatformError({
            code: "IDEMPOTENCY_KEY_REUSED",
            message: "idempotency key was already used with a different request fingerprint",
            details: { operationName },
          });
        }
        return { outcome: row.durable_outcome as T, replayed: true };
      }

      const ledgerRow = first(inserted.rows);
      if (ledgerRow === undefined) {
        throw new PlatformError({
          code: "PROVIDER_ERROR",
          message: "ledger insert returned no row",
        });
      }
      const ledgerId = ledgerRow.id;
      const outcome = await work(new SqlApplicationStore(tx));
      await tx.execute({
        sql: "UPDATE platform.idempotency_records SET durable_outcome = $1 WHERE id = $2",
        parameters: [JSON.stringify(outcome), ledgerId],
      });
      return { outcome, replayed: false };
    });
  }
}

export interface SqlApplicationsModule {
  readonly store: ApplicationStore;
  readonly idempotency: IdempotencyPort;
}

/** Compose the SQL-backed applications module over a platform `DatabasePort`. */
export function createSqlApplicationsModule(
  db: DatabasePort,
  generateId: () => string,
): SqlApplicationsModule {
  return {
    store: new SqlApplicationStore(db),
    idempotency: new SqlIdempotency(db, generateId),
  };
}
