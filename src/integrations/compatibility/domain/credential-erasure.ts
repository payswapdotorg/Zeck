/**
 * Provider-credential erasure checks (PPR-018A scope item 2; ACR-007
 * §5 "Provider-erasure criterion") — the DOMAIN half.
 *
 * For a certified application proof, application-owned provider
 * credentials must be ABSENT from the certified runtime where the
 * delegated edge is Zeck-owned. A reverse proxy alone is NOT
 * sufficient when the application still owns provider credentials:
 * the erasure check therefore audits the runtime's environment for
 * provider credential presence, by NAME only — never values (the
 * platform's M5/M7 secret-safety discipline; the fact records env-var
 * NAMES and a presence boolean, exactly like the evidence record's
 * `ProviderCredentialFact`).
 *
 * PROVIDER NEUTRALITY: which env-var names count as provider
 * credentials is PROOF-ENVIRONMENT CONFIGURATION, injected by the
 * caller (the reusable default list lives in the harness, not here —
 * the same discipline the egress harness applies to host patterns).
 * This module only performs the check and derives the honest result:
 *
 *  - `erased` is true ONLY when every named credential is absent;
 *  - a present credential is a NAMED fact with its env-var name —
 *    present credentials make the certified runtime ineligible
 *    (the caller records the facts; admission rule 2/5 machinery
 *    and the demo-run authorization read them).
 *
 * Pure and total: no environment reads, no clock, no I/O — the
 * environment's PRESENCE function is injected.
 */

import type { ProviderCredentialFact } from "./evidence";

/** How a proof environment exposes whether an env var is set (injected). */
export interface CredentialPresenceSource {
  /** Does the environment carry a value for this env-var NAME? (names only, never values) */
  readonly has: (envVarName: string) => boolean;
}

/** The erasure check's honest result. */
export interface CredentialErasureResult {
  /** Every named credential fact (env-var names + presence booleans). */
  readonly facts: readonly ProviderCredentialFact[];
  /** True ONLY when every named provider credential is absent. */
  readonly erased: boolean;
  /** The env-var NAMES found present (never values). */
  readonly presentNames: readonly string[];
}

/**
 * The erasure check: audit the runtime environment for the injected
 * provider-credential env-var names. Pure over the injected presence
 * source; fail-closed in the honest direction (present ⇒ not erased,
 * with the name recorded).
 */
export function checkProviderCredentialErasure(
  credentialEnvVarNames: readonly string[],
  source: CredentialPresenceSource,
): CredentialErasureResult {
  const facts: ProviderCredentialFact[] = [];
  const presentNames: string[] = [];
  for (const envVarName of credentialEnvVarNames) {
    const present = source.has(envVarName);
    facts.push({ envVarName, present });
    if (present) {
      presentNames.push(envVarName);
    }
  }
  return { facts, erased: presentNames.length === 0, presentNames };
}

/**
 * The scrubbed-environment builder (the ACR-007 §5 erasure MECHANISM):
 * build the certified runtime's environment FROM AN ALLOWLIST — no
 * provider credential can leak in by construction. Pure over its
 * inputs; the caller owns reading the source environment and applying
 * the result.
 *
 *  - `allow` is the complete allowlist of env-var NAMES the certified
 *    runtime may see (adapter endpoint, proxy, locale, paths…);
 *  - every allowlisted name present in `source` is copied VERBATIM;
 *  - nothing else crosses — a name absent from the allowlist is
 *    dropped silently ON PURPOSE (the scrub is the mechanism), and the
 *    erasure check above is the AUDIT that proves it worked.
 */
export function scrubbedEnvironmentOf(
  allow: readonly string[],
  source: Readonly<Record<string, string | undefined>>,
): Readonly<Record<string, string>> {
  const scrubbed: Record<string, string> = {};
  for (const name of allow) {
    const value = source[name];
    if (value !== undefined) {
      scrubbed[name] = value;
    }
  }
  return scrubbed;
}
