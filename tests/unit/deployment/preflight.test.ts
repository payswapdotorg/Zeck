/**
 * Unit tests — the PPR-002 preflight core (deploy/preflight.ts):
 * the account/credential preflight and the provider-tier fact
 * reconciliation, the first two steps of the PPR-002 provisioning
 * order.
 *
 * Proves:
 *  - URL HYGIENE: every present URL-typed contract variable is
 *    checked for URL-embedded credentials; a violation names the
 *    VARIABLE (never the value) and refuses; clean values pass;
 *    absent variables are not checked;
 *  - CREDENTIAL PREFLIGHT: the environment's provider resources map
 *    to the SHARED credential-variable mapping (one list with
 *    deploy/provision — never two); absent credentials are honest
 *    not-run rows with the Lead owner; present credentials mark the
 *    deterministic plan executable; local/self-hosted kinds carry no
 *    account-plane credential;
 *  - TIER RECONCILIATION: the refreshed ledger reconciles with zero
 *    problems (per-entry asOf/source/verification present, sources
 *    resolvable); synthetic mutations — a missing/malformed/future
 *    per-entry asOf, a missing/unresolvable source, an unknown
 *    verification status — are each rejected with the exact problem;
 *    the live re-verification is recorded NOT RUN with its owner;
 *  - THE ORDER CONTRACT: the PPR-002 provisioning order is pinned
 *    step by step, the first two steps owned by this tool, every
 *    step carrying a script path;
 *  - THE COMPOSED REPORT: a clean run passes; a URL-hygiene violation
 *    or a failed configuration gate refuses.
 */

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import {
  checkUrlHygiene,
  credentialPreflightOf,
  PROVISIONING_ORDER,
  reconcileProviderTiers,
  runPreflight,
} from "../../../deploy/preflight";
import { loadDeploymentManifest } from "../../../src/platform/deployment/manifest";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

function loadReal() {
  return loadDeploymentManifest((file) =>
    readFileSync(join(REPO_ROOT, "deploy", "manifests", file), "utf8"),
  );
}

function realLedgerSource(): string {
  return readFileSync(join(REPO_ROOT, "deploy", "manifests", "provider-tiers.json"), "utf8");
}

const RUN_DATE = new Date("2026-09-20T12:00:00.000Z");

/** Mutate a nested field of the raw ledger document. */
function mutateLedger(mutator: (document: Record<string, unknown>) => void): string {
  const document = JSON.parse(realLedgerSource()) as Record<string, unknown>;
  mutator(document);
  return JSON.stringify(document, null, 2);
}

function reconciliationProblemsOf(source: string): string[] {
  const reconciliation = reconcileProviderTiers(source, loadReal(), RUN_DATE, REPO_ROOT);
  return [...reconciliation.problems];
}

describe("URL hygiene over the variable contract (the B5 pattern class)", () => {
  test("clean present URL-typed variables pass and are reported as checked", () => {
    const hygiene = checkUrlHygiene(loadReal(), {
      ZECK_PG_ADMIN_URL: "postgres://postgres@127.0.0.1:54329/postgres",
      ZECK_API_URL: "http://127.0.0.1:8787",
    });
    expect(hygiene.violations).toEqual([]);
    expect(hygiene.checkedVariables).toContain("ZECK_PG_ADMIN_URL");
    expect(hygiene.checkedVariables).toContain("ZECK_API_URL");
  });

  test("a credential-carrying PostgreSQL URL refuses, naming the variable only", () => {
    const hygiene = checkUrlHygiene(loadReal(), {
      ZECK_PG_ADMIN_URL: "postgres://postgres:secret-password@127.0.0.1:54329/postgres",
    });
    expect(hygiene.violations).toHaveLength(1);
    expect(hygiene.violations[0]).toContain("ZECK_PG_ADMIN_URL");
    expect(hygiene.violations[0]).toContain("URL-embedded credentials");
    // The value NEVER appears in the violation.
    expect(hygiene.violations[0]).not.toContain("secret-password");
  });

  test("a credential-carrying http-url variable refuses too", () => {
    const hygiene = checkUrlHygiene(loadReal(), {
      ZECK_OBJECT_STORE_ENDPOINT: "https://key:pass@example.r2.cloudflarestorage.com",
    });
    expect(hygiene.violations).toHaveLength(1);
    expect(hygiene.violations[0]).toContain("ZECK_OBJECT_STORE_ENDPOINT");
  });

  test("absent URL-typed variables are not checked", () => {
    const hygiene = checkUrlHygiene(loadReal(), {});
    expect(hygiene.violations).toEqual([]);
    expect(hygiene.checkedVariables).toEqual([]);
  });

  test("non-URL-typed variables are out of scope even when credential-shaped values are present", () => {
    const hygiene = checkUrlHygiene(loadReal(), {
      ZECK_QUEUE_API_TOKEN: "definitely-a-token-value",
    });
    expect(hygiene.violations).toEqual([]);
    expect(hygiene.checkedVariables).toEqual([]);
  });
});

describe("the account/credential preflight (presence-gated, never values)", () => {
  test("preview with zero credentials: every provider step is an honest not-run row with the Lead owner", () => {
    const preflight = credentialPreflightOf(loadReal(), "preview", {});
    const notRun = preflight.rows.filter((row) => row.status === "not-run");
    expect(notRun.map((row) => row.kind).sort()).toEqual([
      "cf-queue",
      "cf-workflow",
      "neon-branch",
      "r2-bucket",
      "upstash-redis",
      "vercel-project",
    ]);
    for (const row of notRun) {
      expect(row.credentialsPresent).toBe(false);
      expect(row.owner).toContain("Lead");
    }
    // The governed runner is the self-hosted execution substrate: no
    // account-plane credential.
    const runner = preflight.rows.filter((row) => row.status === "local-self-hosted");
    expect(runner.map((row) => row.kind)).toEqual(["container-runner"]);
    expect(preflight.executable).toBe(0);
    expect(preflight.notRun).toBe(6);
    expect(preflight.localSelfHosted).toBe(1);
  });

  test("present credentials mark exactly those rows executable (names only, never values)", () => {
    const preflight = credentialPreflightOf(loadReal(), "preview", {
      NEON_API_KEY: "present",
      CLOUDFLARE_API_TOKEN: "present",
    });
    const executable = preflight.rows.filter((row) => row.status === "executable-plan");
    expect(executable.map((row) => row.kind).sort()).toEqual([
      "cf-queue",
      "cf-workflow",
      "neon-branch",
      "r2-bucket",
    ]);
    for (const row of executable) {
      expect(row.owner).toBeNull();
    }
    expect(preflight.notRun).toBe(2);
  });

  test("the local environment is fully local/self-hosted (no account-plane credentials)", () => {
    const preflight = credentialPreflightOf(loadReal(), "local", {});
    expect(preflight.rows.map((row) => row.kind).sort()).toEqual([
      "local-container-runner",
      "local-object-store",
      "local-redis",
      "pg-database",
    ]);
    expect(preflight.executable).toBe(0);
    expect(preflight.notRun).toBe(0);
    expect(preflight.localSelfHosted).toBe(4);
  });

  test("the credential mapping is the ONE list shared with deploy/provision (no drift)", () => {
    const preflight = credentialPreflightOf(loadReal(), "staging", {});
    const withCredentials = preflight.rows.filter((row) => row.credentialVariable !== null);
    // staging carries neon-project + neon-branch (both NEON_API_KEY).
    expect(withCredentials.length).toBe(7);
    const mapping = new Map(withCredentials.map((row) => [row.kind, row.credentialVariable]));
    expect(mapping.get("neon-project")).toBe("NEON_API_KEY");
    expect(mapping.get("r2-bucket")).toBe("CLOUDFLARE_API_TOKEN");
    expect(mapping.get("vercel-project")).toBe("VERCEL_TOKEN");
    expect(mapping.get("upstash-redis")).toBe("UPSTASH_API_KEY");
  });
});

describe("the provider-tier fact reconciliation (PPR-002 required fact reconciliation)", () => {
  test("the refreshed ledger reconciles with zero problems", () => {
    const reconciliation = reconcileProviderTiers(
      realLedgerSource(),
      loadReal(),
      RUN_DATE,
      REPO_ROOT,
    );
    expect(reconciliation.problems).toEqual([]);
    expect(reconciliation.ledgerAsOf).toBe("2026-09-20");
    expect(reconciliation.entries).toHaveLength(8);
    expect(reconciliation.recordedNotLiveVerified).toBe(8);
    expect(reconciliation.liveVerified).toBe(0);
    expect(reconciliation.liveReverification.status).toBe("not-run");
    expect(reconciliation.liveReverification.owner).toContain("Lead");
  });

  test("every entry reports its source kind and a same-day ledger age", () => {
    const reconciliation = reconcileProviderTiers(
      realLedgerSource(),
      loadReal(),
      RUN_DATE,
      REPO_ROOT,
    );
    for (const entry of reconciliation.entries) {
      expect(entry.daysSinceAsOf).toBe(0);
      if (entry.provider === "zeck-container-runner" || entry.provider === "otel-export") {
        expect(entry.sourceKind).toBe("repository-contract");
      } else {
        expect(entry.sourceKind).toBe("provider-documentation");
        expect(entry.source).toMatch(/^https?:\/\//);
      }
    }
  });

  test("a missing per-entry asOf is rejected with the exact problem", () => {
    const problems = reconciliationProblemsOf(
      mutateLedger((document) => {
        const tiers = document.tiers as Record<string, unknown>[];
        delete tiers[0]?.asOf;
      }),
    );
    expect(problems.join("\n")).toContain("the per-entry asOf is required");
  });

  test("a malformed per-entry asOf is rejected", () => {
    const problems = reconciliationProblemsOf(
      mutateLedger((document) => {
        const tiers = document.tiers as { asOf: string }[];
        const first = tiers[0];
        if (first === undefined) {
          throw new Error("test fixture: the ledger has no entries");
        }
        first.asOf = "yesterday";
      }),
    );
    expect(problems.join("\n")).toContain("must be an ISO calendar date");
  });

  test("a future per-entry asOf is rejected (a fact cannot be recorded before it is taken)", () => {
    const problems = reconciliationProblemsOf(
      mutateLedger((document) => {
        const tiers = document.tiers as { asOf: string }[];
        const first = tiers[0];
        if (first === undefined) {
          throw new Error("test fixture: the ledger has no entries");
        }
        first.asOf = "2026-09-21";
      }),
    );
    expect(problems.join("\n")).toContain("is in the future");
  });

  test("a missing per-entry source is rejected", () => {
    const problems = reconciliationProblemsOf(
      mutateLedger((document) => {
        const tiers = document.tiers as Record<string, unknown>[];
        delete tiers[0]?.source;
      }),
    );
    expect(problems.join("\n")).toContain("the per-entry source is required");
  });

  test("a source that is neither an http(s) URL nor an existing repository path is rejected", () => {
    const problems = reconciliationProblemsOf(
      mutateLedger((document) => {
        const tiers = document.tiers as { source: string }[];
        const first = tiers[0];
        if (first === undefined) {
          throw new Error("test fixture: the ledger has no entries");
        }
        first.source = "not-a-url-and-not-a-path";
      }),
    );
    expect(problems.join("\n")).toContain(
      "is neither an http(s) documentation URL nor an existing repository contract path",
    );
  });

  test("an unknown per-entry verification status is rejected", () => {
    const problems = reconciliationProblemsOf(
      mutateLedger((document) => {
        const tiers = document.tiers as { verification: string }[];
        const first = tiers[0];
        if (first === undefined) {
          throw new Error("test fixture: the ledger has no entries");
        }
        first.verification = "trust-me";
      }),
    );
    expect(problems.join("\n")).toContain("the per-entry verification status must be one of");
  });

  test("an older per-entry asOf reports its informational ledger age without refusing", () => {
    const reconciliation = reconcileProviderTiers(
      mutateLedger((document) => {
        const tiers = document.tiers as { asOf: string }[];
        const first = tiers[0];
        if (first === undefined) {
          throw new Error("test fixture: the ledger has no entries");
        }
        first.asOf = "2026-09-13";
      }),
      loadReal(),
      RUN_DATE,
      REPO_ROOT,
    );
    expect(reconciliation.problems).toEqual([]);
    expect(reconciliation.entries[0]?.daysSinceAsOf).toBe(7);
  });
});

describe("the PPR-002 provisioning order contract", () => {
  test("is pinned step by step, preflight owning the first two", () => {
    expect(PROVISIONING_ORDER.map((step) => step.step)).toEqual([
      "account/credential preflight",
      "provider-tier fact reconciliation",
      "Neon + migrations",
      "R2",
      "Queues / Workflows",
      "Upstash",
      "governed runner",
      "Vercel delivery",
      "identity",
      "health",
      "public smoke",
      "sandbox first-run",
      "validation rerun",
      "browser acceptance",
    ]);
    expect(PROVISIONING_ORDER[0]?.ownedByThisTool).toBe(true);
    expect(PROVISIONING_ORDER[1]?.ownedByThisTool).toBe(true);
    expect(PROVISIONING_ORDER.slice(2).every((step) => !step.ownedByThisTool)).toBe(true);
    for (const step of PROVISIONING_ORDER) {
      expect(step.script.length).toBeGreaterThan(0);
    }
  });
});

describe("the composed preflight report", () => {
  test("a clean run over the real repository passes with the honest not-run rows", () => {
    const report = runPreflight({
      environment: "preview",
      manifest: loadReal(),
      ledgerSource: realLedgerSource(),
      env: {},
      runDate: RUN_DATE,
      gitRevision: "0".repeat(40),
      repositoryRoot: REPO_ROOT,
      configurationGate: { passed: true, problems: [] },
    });
    expect(report.passed).toBe(true);
    expect(report.problems).toEqual([]);
    expect(report.environmentClass).toBe("disposable");
    expect(report.credentialPreflight.notRun).toBe(6);
    expect(report.tierReconciliation.problems).toEqual([]);
    expect(report.commercialBoundary.providerMapCommercialUse).toContain("non-commercial");
    expect(report.notRun.length).toBeGreaterThanOrEqual(2);
    for (const boundary of report.notRun) {
      expect(boundary.owner).toContain("Lead");
    }
  });

  test("a URL-hygiene violation refuses the preflight", () => {
    const report = runPreflight({
      environment: "local",
      manifest: loadReal(),
      ledgerSource: realLedgerSource(),
      env: {
        ZECK_PG_ADMIN_URL: "postgres://postgres:hunter2@127.0.0.1:54329/postgres",
      },
      runDate: RUN_DATE,
      gitRevision: "0".repeat(40),
      repositoryRoot: REPO_ROOT,
      configurationGate: { passed: true, problems: [] },
    });
    expect(report.passed).toBe(false);
    expect(report.problems.join("\n")).toContain("ZECK_PG_ADMIN_URL");
    expect(report.problems.join("\n")).not.toContain("hunter2");
  });

  test("a failed configuration gate refuses the preflight", () => {
    const report = runPreflight({
      environment: "local",
      manifest: loadReal(),
      ledgerSource: realLedgerSource(),
      env: {},
      runDate: RUN_DATE,
      gitRevision: "0".repeat(40),
      repositoryRoot: REPO_ROOT,
      configurationGate: { passed: false, problems: ["environments.json: synthetic failure"] },
    });
    expect(report.passed).toBe(false);
    expect(report.problems.join("\n")).toContain("configuration gate failed");
  });

  test("a ledger missing its PPR-002 reconciliation fields refuses the preflight", () => {
    const report = runPreflight({
      environment: "local",
      manifest: loadReal(),
      ledgerSource: mutateLedger((document) => {
        const tiers = document.tiers as Record<string, unknown>[];
        delete tiers[0]?.source;
      }),
      env: {},
      runDate: RUN_DATE,
      gitRevision: "0".repeat(40),
      repositoryRoot: REPO_ROOT,
      configurationGate: { passed: true, problems: [] },
    });
    expect(report.passed).toBe(false);
    expect(report.problems.join("\n")).toContain("the per-entry source is required");
  });
});
