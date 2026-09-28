/**
 * PPR-018A — the provider-credential erasure tests (scope item 2;
 * ACR-007 §5 "Provider-erasure criterion").
 *
 * Pins:
 *  - the audit derives honest facts (env-var NAMES + presence booleans
 *    — a VALUE is never recorded anywhere);
 *  - a present provider credential ⇒ erased=false, named;
 *  - the scrubbed-environment builder is allowlist-only and REFUSES to
 *    place a credential name (an override or an application extra) —
 * the certified runtime cannot be handed a credential "by accident";
 *  - a runtime that still OWNS a provider credential cannot present
 *    itself as certified (the reverse-proxy-alone-is-not-sufficient
 *    law's runtime half).
 */

import { describe, expect, test } from "vitest";
import {
  auditCredentialErasure,
  buildScrubbedRuntimeEnvironment,
  PROVIDER_CREDENTIAL_ENV_VAR_NAMES,
  runtimeEnvironmentAllowlist,
} from "../../../compat/harness/credential-erasure";
import {
  checkProviderCredentialErasure,
  scrubbedEnvironmentOf,
} from "../../../src/integrations/compatibility/public";

describe("the credential erasure audit (names only, never values)", () => {
  test("an environment without provider credentials derives erased=true with a fact per name", () => {
    const result = checkProviderCredentialErasure(["OPENAI_API_KEY", "ANTHROPIC_API_KEY"], {
      has: () => false,
    });
    expect(result.erased).toBe(true);
    expect(result.presentNames).toEqual([]);
    expect(result.facts).toEqual([
      { envVarName: "OPENAI_API_KEY", present: false },
      { envVarName: "ANTHROPIC_API_KEY", present: false },
    ]);
  });

  test("a present provider credential is named (NAME only) and forbids erasure", () => {
    const result = checkProviderCredentialErasure(["OPENAI_API_KEY", "ANTHROPIC_API_KEY"], {
      has: (name) => name === "ANTHROPIC_API_KEY",
    });
    expect(result.erased).toBe(false);
    expect(result.presentNames).toEqual(["ANTHROPIC_API_KEY"]);
    // The fact carries the NAME and the boolean — there is no field
    // where a VALUE could even appear.
    expect(JSON.stringify(result.facts)).not.toContain("sk-");
  });

  test("the harness's reusable name list covers the well-known provider credentials", () => {
    expect(PROVIDER_CREDENTIAL_ENV_VAR_NAMES).toContain("OPENAI_API_KEY");
    expect(PROVIDER_CREDENTIAL_ENV_VAR_NAMES).toContain("ANTHROPIC_API_KEY");
    expect(PROVIDER_CREDENTIAL_ENV_VAR_NAMES.length).toBeGreaterThanOrEqual(15);
    // The audit composes over the domain check with the list.
    const result = auditCredentialErasure({ OPENAI_API_KEY: "secret-value-not-recorded" });
    expect(result.erased).toBe(false);
    expect(result.presentNames).toEqual(["OPENAI_API_KEY"]);
    // The audit result never carries the VALUE.
    expect(JSON.stringify(result)).not.toContain("secret-value-not-recorded");
  });
});

describe("the scrubbed runtime environment (allowlist-only by construction)", () => {
  test("only allowlisted names cross; everything else is dropped on purpose", () => {
    const scrubbed = scrubbedEnvironmentOf(["PATH", "HOME"], {
      PATH: "/bin",
      HOME: "/home/app",
      OPENAI_API_KEY: "should-not-cross",
      AWS_SECRET: "also-not-crossing",
    });
    expect(scrubbed).toEqual({ PATH: "/bin", HOME: "/home/app" });
  });

  test("the base allowlist carries no provider credential name", () => {
    const allow = runtimeEnvironmentAllowlist(["MY_APP_CONFIG"]);
    for (const credential of PROVIDER_CREDENTIAL_ENV_VAR_NAMES) {
      expect(allow, credential).not.toContain(credential);
    }
    expect(allow).toContain("MY_APP_CONFIG");
  });

  test("IMPOSSIBILITY (hidden credential): the builder REFUSES a credential-named override or extra", () => {
    expect(() =>
      buildScrubbedRuntimeEnvironment({
        source: {},
        overrides: { OPENAI_API_KEY: "sk-anything" },
      }),
    ).toThrow(/provider-erasure criterion/);
    expect(() =>
      buildScrubbedRuntimeEnvironment({
        source: {},
        applicationExtras: ["ANTHROPIC_API_KEY"],
      }),
    ).toThrow(/provider-erasure criterion/);
  });

  test("a clean composed environment audits as erased", () => {
    const environment = buildScrubbedRuntimeEnvironment({
      source: {
        PATH: "/venv/bin:/usr/bin:/bin",
        HOME: "/home/app",
        OPENAI_API_KEY: "present-in-the-parent-environment",
      },
      overrides: { ZECK_ADAPTER_URL: "http://127.0.0.1:8787/v1" },
    });
    expect(environment).toEqual({
      PATH: "/venv/bin:/usr/bin:/bin",
      HOME: "/home/app",
      ZECK_ADAPTER_URL: "http://127.0.0.1:8787/v1",
    });
    expect(auditCredentialErasure(environment).erased).toBe(true);
  });
});
