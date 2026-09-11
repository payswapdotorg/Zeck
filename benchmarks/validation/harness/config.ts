/**
 * Validation harness application configuration (VAL-002, acceptance
 * criterion 3).
 *
 * App configurations are ISOLATED FROM SECRETS and reproducible from
 * repository files plus environment secrets: the config names the env
 * var that carries the transport credential (tokenEnvVar) — the secret
 * itself never appears in any repository file, log or report. The
 * validator below mechanically rejects secret-shaped config values, so
 * a leaked credential in a config file is unrepresentable.
 */

/** Secret-shaped patterns that must never appear in a config value. */
const SECRET_SHAPED = [
  /sk-or-v1-[A-Za-z0-9]{16,}/,
  /sk-proj-[A-Za-z0-9_-]{16,}/,
  /sk-ws-[A-Za-z0-9._-]{16,}/,
  /ghp_[A-Za-z0-9]{20,}/,
  /gho_[A-Za-z0-9]{20,}/,
  /apikey-[A-Za-z0-9]{12,}/,
  /ak_[A-Za-z0-9]{10,}/,
  /ck_[A-Za-z0-9]{10,}/,
  /Bearer\s+[A-Za-z0-9._-]{16,}/i,
];

/** The environment-variable name shape (uppercase snake case). */
const ENV_VAR_NAME = /^[A-Z][A-Z0-9_]*$/;

/** A URL shape (http or https, host required — the Zeck API base). */
const URL_SHAPE = /^https?:\/\/[^\s]+$/;

/** The reproducible harness configuration. */
export interface AppHarnessConfig {
  /** The application identity (Zeck applicationId scope). */
  readonly applicationId: string;
  /** Base URL of the Zeck API the app integrates with. */
  readonly baseUrl: string;
  /**
   * NAME of the environment variable carrying the transport credential.
   * The value is resolved at run time from the environment — never
   * stored here.
   */
  readonly tokenEnvVar: string;
  /** Revision of this application (recorded in run identity/evidence). */
  readonly applicationRevision: string;
  /** Revision of the corpus the app consumes (recorded likewise). */
  readonly corpusRevision: string;
  /** The customer integration surface (e.g. "sdk"). */
  readonly integrationSurface: string;
  /** Completion polling interval in milliseconds. */
  readonly pollIntervalMs: number;
  /** Maximum time to await a terminal status in milliseconds. */
  readonly completionTimeoutMs: number;
}

/** One configuration rejection finding. */
export interface ConfigViolation {
  readonly path: string;
  readonly reason: string;
}

/**
 * Validate an app harness configuration: every field present and
 * well-shaped, the token referenced by env-var NAME only, and no
 * secret-shaped value anywhere in the configuration.
 */
export function validateAppConfig(config: AppHarnessConfig): readonly ConfigViolation[] {
  const violations: ConfigViolation[] = [];
  const requireText = (path: string, value: unknown): void => {
    if (typeof value !== "string" || value.length === 0) {
      violations.push({ path, reason: "must be a non-empty string" });
    }
  };

  requireText("applicationId", config?.applicationId);
  requireText("applicationRevision", config?.applicationRevision);
  requireText("corpusRevision", config?.corpusRevision);
  requireText("integrationSurface", config?.integrationSurface);
  requireText("tokenEnvVar", config?.tokenEnvVar);
  if (typeof config?.baseUrl !== "string" || !URL_SHAPE.test(config.baseUrl)) {
    violations.push({ path: "baseUrl", reason: "must be an http(s) URL" });
  }
  if (typeof config?.tokenEnvVar === "string" && !ENV_VAR_NAME.test(config.tokenEnvVar)) {
    violations.push({
      path: "tokenEnvVar",
      reason: "must name an environment variable (UPPER_SNAKE_CASE), never carry the secret",
    });
  }
  if (
    typeof config?.pollIntervalMs !== "number" ||
    !Number.isInteger(config.pollIntervalMs) ||
    config.pollIntervalMs <= 0
  ) {
    violations.push({ path: "pollIntervalMs", reason: "must be a positive integer" });
  }
  if (
    typeof config?.completionTimeoutMs !== "number" ||
    !Number.isInteger(config.completionTimeoutMs) ||
    config.completionTimeoutMs <= 0
  ) {
    violations.push({ path: "completionTimeoutMs", reason: "must be a positive integer" });
  }

  const values: readonly unknown[] = config ? Object.values(config) : [];
  for (const value of values) {
    if (typeof value !== "string") {
      continue;
    }
    for (const pattern of SECRET_SHAPED) {
      if (pattern.test(value)) {
        violations.push({
          path: "config",
          reason: "secret-shaped value in configuration (secrets live only in the environment)",
        });
        break;
      }
    }
  }
  return violations;
}

/**
 * Resolve the transport credential from the environment at run time.
 * The error names the exact variable so an operator can fix the
 * environment without reading any source.
 */
export function resolveTransportToken(
  config: AppHarnessConfig,
  env: Readonly<Record<string, string | undefined>>,
): string {
  const token = env[config.tokenEnvVar];
  if (typeof token !== "string" || token.length === 0) {
    throw new Error(
      `transport credential not found: set the ${config.tokenEnvVar} environment variable`,
    );
  }
  return token;
}
