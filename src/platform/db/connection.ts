/**
 * Repository-defined PostgreSQL connection contract (WORK-043 / D-02).
 *
 * The database URL is the materialized value of the environment's
 * `database-url` secret (`zeck-secret://<environment>/database-url`,
 * held by `ZECK_SECRET_DATABASE_URL_REF`); it arrives here already
 * resolved through the secret store immediately before the authorized
 * adapter call (`IMPLEMENTATION.md` §9, D1.0 §14). It is never a
 * repository-stored value, never logged and never echoed in
 * diagnostics — every operator-facing message passes through
 * `redactConnectionString` first.
 *
 * The connection contract is provider-neutral by construction: it
 * accepts any PostgreSQL 16+ wire-protocol endpoint, including managed
 * Neon (whose standard endpoints are plain PostgreSQL with TLS), and
 * it never inspects provider-specific host shapes. Pool bounds are
 * repository-defined constants; they may be overridden only downward
 * of the hard ceiling (fail closed on unbounded or non-positive
 * values — a pool is a bounded resource or it is a leak).
 */
import { createHash } from "node:crypto";

/** Hard ceiling for pool `max` — a connection pool is a bounded resource. */
export const MAX_POOL_CEILING = 32;
/** Repository default for pool `max`. */
export const DEFAULT_POOL_MAX = 10;
/** Repository default: how long a connect attempt may hang before failing closed (ms). */
export const DEFAULT_CONNECT_TIMEOUT_MS = 5000;
/** Repository default: how long an idle client may sit in the pool (ms). */
export const DEFAULT_IDLE_TIMEOUT_MS = 30_000;
/** Hard ceiling for any timeout value (ms). */
export const MAX_TIMEOUT_MS = 120_000;

export interface ConnectionPoolConfig {
  readonly max: number;
  readonly connectionTimeoutMillis: number;
  readonly idleTimeoutMillis: number;
}

/**
 * The validated, repository-owned connection configuration handed to
 * the pg adapter. `url` is the secret material in memory only; it is
 * never part of any error message or report.
 */
export interface DatabaseConnectionConfig {
  readonly url: string;
  readonly host: string;
  readonly port: number;
  readonly database: string;
  readonly sslRequired: boolean;
  readonly pool: ConnectionPoolConfig;
}

export class ConnectionConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConnectionConfigurationError";
  }
}

const POSTGRES_URL_PATTERN = /^postgres(ql)?:\/\/[^/]+\/[^/?]+(\?.*)?$/;

/**
 * Parse and validate a PostgreSQL connection URL into the
 * repository-owned connection configuration.
 *
 * Fail-closed rules:
 * - `postgres://` or `postgresql://` scheme only;
 * - host and database must be present;
 * - credentials in the URL are permitted (the URL IS the secret) but
 *   never surface in any diagnostic;
 * - `sslmode=disable` is rejected: authoritative state crosses the
 *   wire, and disabling TLS on the authority path is a configuration
 *   error, not a mode;
 * - pool overrides must be positive integers within the hard ceilings.
 */
export function parseConnectionConfig(
  url: string,
  poolOverrides: Partial<ConnectionPoolConfig> = {},
): DatabaseConnectionConfig {
  const problems: string[] = [];
  if (!POSTGRES_URL_PATTERN.test(url)) {
    throw new ConnectionConfigurationError(
      "database URL must be a postgres:// or postgresql:// URL with host and database",
    );
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new ConnectionConfigurationError("database URL is not parseable");
  }
  const host = parsed.hostname;
  const database = decodeURIComponent(parsed.pathname.replace(/^\//, ""));
  if (host.length === 0) {
    problems.push("host is required");
  }
  if (database.length === 0) {
    problems.push("database name is required");
  }
  const sslmode = parsed.searchParams.get("sslmode");
  if (sslmode === "disable") {
    problems.push("sslmode=disable is not permitted for the authoritative database connection");
  }
  const pool = validatePoolConfig(poolOverrides);
  if (problems.length > 0) {
    throw new ConnectionConfigurationError(
      `invalid database connection configuration: ${problems.join("; ")}`,
    );
  }
  const port = parsed.port === "" ? 5432 : Number.parseInt(parsed.port, 10);
  return {
    url,
    host,
    port,
    database,
    sslRequired: sslmode === "require" || sslmode === "verify-full" || sslmode === "verify-ca",
    pool,
  };
}

/**
 * Pool bounds with repository defaults, validated against hard
 * ceilings. Unbounded, non-positive or fractional values fail closed.
 */
export function validatePoolConfig(overrides: Partial<ConnectionPoolConfig>): ConnectionPoolConfig {
  const problems: string[] = [];
  const max = overrides.max ?? DEFAULT_POOL_MAX;
  const connectionTimeoutMillis = overrides.connectionTimeoutMillis ?? DEFAULT_CONNECT_TIMEOUT_MS;
  const idleTimeoutMillis = overrides.idleTimeoutMillis ?? DEFAULT_IDLE_TIMEOUT_MS;
  if (!Number.isInteger(max) || max < 1 || max > MAX_POOL_CEILING) {
    problems.push(`pool max must be an integer in [1, ${MAX_POOL_CEILING}]`);
  }
  if (
    !Number.isInteger(connectionTimeoutMillis) ||
    connectionTimeoutMillis < 1 ||
    connectionTimeoutMillis > MAX_TIMEOUT_MS
  ) {
    problems.push(`connection timeout must be an integer in [1, ${MAX_TIMEOUT_MS}] ms`);
  }
  if (
    !Number.isInteger(idleTimeoutMillis) ||
    idleTimeoutMillis < 1 ||
    idleTimeoutMillis > MAX_TIMEOUT_MS
  ) {
    problems.push(`idle timeout must be an integer in [1, ${MAX_TIMEOUT_MS}] ms`);
  }
  if (problems.length > 0) {
    throw new ConnectionConfigurationError(`invalid pool configuration: ${problems.join("; ")}`);
  }
  return { max, connectionTimeoutMillis, idleTimeoutMillis };
}

/**
 * Redact a connection URL (or any message containing one) for
 * diagnostics: embedded credentials are replaced, query parameters
 * that could carry credentials are dropped, and the result is
 * length-capped. Diagnostics may carry host/database/port — never
 * user, password or query secrets.
 */
export function redactConnectionString(value: string): string {
  let redacted = value.replace(
    /([a-z][a-z0-9+.-]*:\/\/)([^\s/@:]+):([^\s/@]+)@/gi,
    "$1[redacted]@",
  );
  try {
    const parsed = new URL(redacted);
    parsed.username = "";
    parsed.password = "";
    parsed.search = "";
    redacted = parsed.toString().replace(/:\/\/@/, "://");
  } catch {
    // Not a URL: the regex pass above already redacted credential shapes.
  }
  return redacted.slice(0, 200);
}

/** Non-secret operational identity of a connection (for reports). */
export function connectionEndpoint(config: DatabaseConnectionConfig): string {
  return `postgresql://${config.host}:${config.port}/${config.database}${
    config.sslRequired ? "?sslmode=require" : ""
  }`;
}

/** Content hash helper reused by the backup manifest (sha256 hex). */
export function sha256Hex(bytes: string | Uint8Array): string {
  const hash = createHash("sha256");
  if (typeof bytes === "string") {
    hash.update(bytes, "utf8");
  } else {
    hash.update(bytes);
  }
  return hash.digest("hex");
}
