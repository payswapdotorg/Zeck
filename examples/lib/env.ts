/**
 * The shared example environment contract (DEP-020).
 *
 * Every Zeck integration example reads its connection identity from
 * environment variables — NEVER from command-line flags (shell history
 * is a leak surface) and NEVER from a hard-coded value (examples must
 * be copy/paste safe with zero embedded secrets).
 *
 * The three REQUIRED variables:
 *   ZECK_API_URL         the base URL of the Zeck public API
 *   ZECK_TOKEN           the bearer credential for the Zeck transport
 *                        (a Zeck credential — NEVER a provider API key)
 *   ZECK_APPLICATION_ID  the application whose scope authorizes the
 *                        scoped reads and governed commands
 *
 * The OPTIONAL variable:
 *   ZECK_ENVIRONMENT_ID  the environment (e.g. a disposable sandbox)
 *                        executions are created in
 *
 * See docs/developer/AUTH.md for where these values come from, and
 * docs/developer/machine/env-vars.json for the machine-readable
 * contract this loader implements.
 */

/** The developer-side environment variable contract (names only, never values). */
export const ZECK_ENV_VAR_NAMES = [
  "ZECK_API_URL",
  "ZECK_TOKEN",
  "ZECK_APPLICATION_ID",
  "ZECK_ENVIRONMENT_ID",
] as const;

export interface ZeckEnv {
  /** Base URL of the Zeck public API (no trailing slash). */
  readonly apiBaseUrl: string;
  /** The Zeck transport bearer credential (never a provider key). */
  readonly token: string;
  /** The application whose scope authorizes scoped operations. */
  readonly applicationId: string;
  /** Optional environment selector (e.g. a disposable sandbox environment). */
  readonly environmentId?: string;
}

/** Read one variable or fail with an actionable, secret-free message. */
function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim().length === 0) {
    throw new Error(
      `missing environment variable ${name} — see docs/developer/AUTH.md ` +
        "(the example reads connection identity from the environment; " +
        "no credential is ever embedded in example code)",
    );
  }
  return value.trim();
}

/**
 * Load the example connection identity from the environment.
 * Values are trimmed; the base URL loses any trailing slash so path
 * concatenation in the SDK is always well-formed.
 */
export function loadZeckEnv(): ZeckEnv {
  const env: ZeckEnv = {
    apiBaseUrl: requireEnv("ZECK_API_URL").replace(/\/+$/, ""),
    token: requireEnv("ZECK_TOKEN"),
    applicationId: requireEnv("ZECK_APPLICATION_ID"),
    ...(process.env.ZECK_ENVIRONMENT_ID === undefined ||
    process.env.ZECK_ENVIRONMENT_ID.trim().length === 0
      ? {}
      : { environmentId: process.env.ZECK_ENVIRONMENT_ID.trim() }),
  };
  return env;
}

// ---------------------------------------------------------------------------
// The example classification vocabulary (availability honesty)
// ---------------------------------------------------------------------------

/**
 * How an example relates to live provider availability — the honest
 * classification vocabulary of docs/developer/AVAILABILITY.md:
 *
 *  - "runnable": the example's full code path (submit → lifecycle →
 *    result/evidence/cost retrieval) runs against any Zeck deployment
 *    exposing the public API, and the workload family's task shape is
 *    exercised by the executed validation program.
 *
 *  - "provider-gated": the code path is identical, but the workload's
 *    COMPLETION requires provider capabilities whose access is gated
 *    (credentials, region, quota) or absent from the authorized set.
 *    `gatedBy` names the credential env var NAME (never a value) or
 *    the missing capability; `note` states the recorded boundary.
 */
export type ExampleClassification =
  | { readonly kind: "runnable" }
  | {
      readonly kind: "provider-gated";
      /** The credential env var NAME gating completion (never a value). */
      readonly gatedBy?: string;
      /** The recorded availability boundary (mirrors the validation report). */
      readonly note: string;
    };

/** The machine-readable example descriptor every example exports. */
export interface ExampleMeta {
  /** Kebab-case example identity (matches examples-manifest.json). */
  readonly name: string;
  /** The workload family (the corpus vocabulary of 22 families). */
  readonly family: string;
  /** Human-readable title. */
  readonly title: string;
  readonly classification: ExampleClassification;
  /** The env vars this example reads (names only). */
  readonly envVars: readonly string[];
}

/** The default env-var set every connection-using example declares. */
export function coreEnvVars(extra: readonly string[] = []): readonly string[] {
  return [...ZECK_ENV_VAR_NAMES.slice(0, 3), ...extra];
}

/**
 * The honest provider-gated banner: prints the recorded boundary of a
 * provider-gated example (narrowing the classification union safely).
 */
export function gatedBanner(example: ExampleMeta): string {
  if (example.classification.kind === "provider-gated") {
    const gate =
      example.classification.gatedBy === undefined
        ? ""
        : ` completion requires ${example.classification.gatedBy} rails —`;
    return `provider-gated workload:${gate} ${example.classification.note}`;
  }
  return `runnable workload: ${example.title}`;
}
