/**
 * The reusable credential-erasure tooling (PPR-018A scope item 2;
 * ACR-007 §5) — the PROOF-ENVIRONMENT configuration + compose helpers
 * over the compatibility layer's domain check.
 *
 * The provider-credential env-var NAMES below are proof-environment
 * configuration (the same discipline the egress harness applies to
 * host patterns): the domain check stays provider-neutral, and this
 * file is where the reusable proof environment declares which env-var
 * names count as application-owned provider credentials. Names only —
 * a value never enters any fact, log or record.
 *
 * The scrubbed-environment builder is the erasure MECHANISM: the
 * certified application runtime's environment is built FROM AN
 * ALLOWLIST, so no provider credential can leak in by construction —
 * and `auditCredentialErasure` is the AUDIT that proves it worked
 * (both are used together: build scrubbed, then audit the runtime).
 */

import {
  checkProviderCredentialErasure,
  type CredentialErasureResult,
  type CredentialPresenceSource,
  scrubbedEnvironmentOf,
} from "../../src/integrations/compatibility/public";

/**
 * The provider-credential env-var NAMES the proof environment audits
 * (the well-known application-side provider credential names; the
 * work order may extend this list for its application's own names).
 */
export const PROVIDER_CREDENTIAL_ENV_VAR_NAMES: readonly string[] = [
  "OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "OPENROUTER_API_KEY",
  "GEMINI_API_KEY",
  "GOOGLE_API_KEY",
  "GROQ_API_KEY",
  "MISTRAL_API_KEY",
  "DEEPSEEK_API_KEY",
  "TOGETHER_API_KEY",
  "COHERE_API_KEY",
  "XAI_API_KEY",
  "AZURE_OPENAI_API_KEY",
  "GITHUB_COPILOT_TOKEN",
  "HF_TOKEN",
  "REPLICATE_API_TOKEN",
];

/**
 * The base allowlist of env-var NAMES a certified application runtime
 * may see (the scrub allowlist). Paths, locale, terminal behavior and
 * the loopback proxy/adapter plumbing — plus the application extras
 * the work order declares (its own non-credential configuration).
 * Provider credential names are NOT on this list and can never be
 * added by accident: `auditCredentialErasure` fails the runtime that
 * carries any of them.
 */
export function runtimeEnvironmentAllowlist(
  applicationExtras: readonly string[] = [],
): readonly string[] {
  return [
    "PATH",
    "HOME",
    "TMPDIR",
    "LANG",
    "LC_ALL",
    "TZ",
    "TERM",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "http_proxy",
    "https_proxy",
    "NO_PROXY",
    "no_proxy",
    "GIT_TERMINAL_PROMPT",
    "PYTHONUNBUFFERED",
    ...applicationExtras,
  ];
}

export interface ScrubbedRuntimeEnvironmentOptions {
  /** The application's own non-credential env-var names (validated against the credential list). */
  readonly applicationExtras?: readonly string[];
  /** The source environment to scrub (e.g. process.env — injected, never read here). */
  readonly source: Readonly<Record<string, string | undefined>>;
  /** Explicit value overrides the composed environment must carry (the adapter endpoint, the proxy). */
  readonly overrides?: Readonly<Record<string, string>>;
}

/**
 * Build the scrubbed certified-runtime environment: allowlist only,
 * with explicit overrides applied verbatim. The builder REFUSES an
 * override or extra whose name is a known provider credential name —
 * the certified runtime cannot be handed a credential "by accident".
 */
export function buildScrubbedRuntimeEnvironment(
  options: ScrubbedRuntimeEnvironmentOptions,
): Readonly<Record<string, string>> {
  const extras = options.applicationExtras ?? [];
  const credentialNames = new Set(PROVIDER_CREDENTIAL_ENV_VAR_NAMES);
  for (const name of [...extras, ...Object.keys(options.overrides ?? {})]) {
    if (credentialNames.has(name)) {
      throw new Error(
        `refusing to place provider credential env var ${name} into a certified runtime environment (ACR-007 §5 provider-erasure criterion) — the certified runtime must not own provider credentials`,
      );
    }
  }
  const allow = runtimeEnvironmentAllowlist(extras);
  const scrubbed: Record<string, string> = {
    ...scrubbedEnvironmentOf(allow, options.source),
    ...(options.overrides ?? {}),
  };
  return scrubbed;
}

/**
 * The erasure AUDIT: check a runtime environment (or any presence
 * source) for the provider credential names. Present credentials are
 * named (NAME only) — the certified runtime is ineligible until they
 * are absent.
 */
export function auditCredentialErasure(
  presence: CredentialPresenceSource | Readonly<Record<string, string | undefined>>,
  credentialEnvVarNames: readonly string[] = PROVIDER_CREDENTIAL_ENV_VAR_NAMES,
): CredentialErasureResult {
  const source: CredentialPresenceSource =
    typeof (presence as CredentialPresenceSource).has === "function"
      ? (presence as CredentialPresenceSource)
      : {
          has: (name) =>
            (presence as Readonly<Record<string, string | undefined>>)[name] !== undefined,
        };
  return checkProviderCredentialErasure(credentialEnvVarNames, source);
}
