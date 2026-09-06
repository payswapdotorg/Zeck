/**
 * Telemetry configuration (platform observability plane; WORK-047,
 * D-06).
 *
 * The bounded fail-closed loader — the queue/workflow/compute config
 * discipline: every variable is optional with a repository default
 * and hard bounds; garbage refuses with the exact variable name. The
 * exporter token is CREDENTIAL-SHAPED: it is read from the
 * environment materialization (ZECK_OTLP_AUTH_TOKEN) or resolved
 * immediately before the authorized export call through the secret
 * store — never logged, never copied into diagnostics.
 *
 * UNCONFIGURED = LOGS-ONLY: a missing endpoint is not an error; the
 * composition runs with the noop exporter and bounded structured
 * logs (the declared degraded mode of the observability-export
 * provider). This is the self-hosting default.
 *
 * Variables (all optional; all bounded):
 *
 *   ZECK_OTLP_ENDPOINT              http/https URL (required for export)
 *   ZECK_OTLP_AUTH_TOKEN            credential-shaped materialization
 *   ZECK_OTLP_REQUEST_TIMEOUT_MS    default 5_000   [100, 120_000]
 *   ZECK_TELEMETRY_FLUSH_EVERY      default 50 records [8, 512]
 */

export interface TelemetryConfig {
  /** The OTLP collector base URL, or null in logs-only mode. */
  readonly endpoint: string | null;
  readonly requestTimeoutMs: number;
  /** Flush the sink after this many buffered records. */
  readonly flushEvery: number;
}

export class TelemetryConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TelemetryConfigError";
  }
}

const HTTP_URL_PATTERN = /^https?:\/\/[^\s]+$/;

function parseBoundedInteger(
  value: string | undefined,
  variable: string,
  min: number,
  max: number,
  fallback: number,
): number {
  if (value === undefined || value.trim() === "") {
    return fallback;
  }
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed) || parsed < min || parsed > max) {
    throw new TelemetryConfigError(
      `${variable} must be an integer in [${min}, ${max}] (got: "${value}")`,
    );
  }
  return parsed;
}

/**
 * Load the telemetry configuration from a process environment
 * (fail-closed; the token is NOT part of this structure — it is
 * resolved at the export seam).
 */
export function loadTelemetryConfig(
  env: Readonly<Record<string, string | undefined>>,
): TelemetryConfig {
  const endpoint = env.ZECK_OTLP_ENDPOINT;
  if (endpoint !== undefined && endpoint.trim() !== "") {
    if (!HTTP_URL_PATTERN.test(endpoint.trim())) {
      throw new TelemetryConfigError(
        `ZECK_OTLP_ENDPOINT must be an http(s) URL (got: "${endpoint.slice(0, 60)}")`,
      );
    }
  }
  return {
    endpoint: endpoint !== undefined && endpoint.trim() !== "" ? endpoint.trim() : null,
    requestTimeoutMs: parseBoundedInteger(
      env.ZECK_OTLP_REQUEST_TIMEOUT_MS,
      "ZECK_OTLP_REQUEST_TIMEOUT_MS",
      100,
      120_000,
      5_000,
    ),
    flushEvery: parseBoundedInteger(
      env.ZECK_TELEMETRY_FLUSH_EVERY,
      "ZECK_TELEMETRY_FLUSH_EVERY",
      8,
      512,
      50,
    ),
  };
}
