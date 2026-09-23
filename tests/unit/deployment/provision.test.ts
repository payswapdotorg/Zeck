/**
 * Unit tests — deploy/provision (DEP-002): environment, secret and
 * sandbox-account provisioning automation.
 *
 * Proves over the REAL manifest set:
 *
 * - AC1: plan mode runs end to end with ZERO credentials (no
 *   ZECK_ENVIRONMENT, no reference variables, no provider tokens) and
 *   writes nothing;
 * - AC2: secret handling is EXTERNAL-ONLY — reference variables
 *   holding plaintext or cross-environment material abort fail-closed
 *   in BOTH modes, the refusal never echoes the plaintext, and planted
 *   credential values never reach the report, the artifacts or the
 *   real-process CLI output (the hostile probe);
 * - AC3: convergence is idempotent (a second run reports
 *   already-converged with zero changes), drifted state re-converges
 *   (corrupted/deleted/orphaned artifacts), and the teardown
 *   classification guards remove exactly the computed provisioned
 *   record directory (persistent classes are refused);
 * - AC4: sandbox-account records are a PURE manifest projection —
 *   synthetic-data policy, quota envelope (with guard thresholds
 *   RESOLVED from quota-guards.json) and expiry facts trace to the
 *   manifest rows, and two renders are byte-identical;
 * - fail-closed validation: malformed sandbox-accounts rows abort the
 *   parser (and therefore deploy:validate / deploy:provision) BEFORE
 *   any provider call or artifact write.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import {
  type ProvisionEnvironmentInput,
  ProvisionError,
  provisionEnvironment,
  provisionedArtifactsDirectory,
  teardownProvisionedRecords,
} from "../../../deploy/provision";
import {
  parseSandboxAccounts,
  renderSandboxAccountDocument,
  SANDBOX_ACCOUNTS_MANIFEST_FILE,
  SandboxAccountsError,
  sandboxAccountsOf,
} from "../../../deploy/sandbox-accounts";
import { validateDeploymentConfiguration } from "../../../deploy/validate";
import {
  SANDBOX_IDENTITY_DEFAULT_TTL_MS,
  SYNTHETIC_DATA_POLICY,
} from "../../../src/modules/sandbox/public";
import { loadDeploymentManifest } from "../../../src/platform/deployment/manifest";
import { loadQuotaGuardsPolicy } from "../../../src/platform/observability/alerts";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const FIXED_NOW = "2026-09-17T00:00:00.000Z";
const FIXED_REVISION = "0123456789abcdef0123456789abcdef01234567";

function loadRealManifest() {
  return loadDeploymentManifest((file) =>
    readFileSync(join(REPO_ROOT, "deploy", "manifests", file), "utf8"),
  );
}

function loadRealSandboxAccounts() {
  const manifest = loadRealManifest();
  const quotaGuards = loadQuotaGuardsPolicy(
    readFileSync(join(REPO_ROOT, "deploy", "manifests", "quota-guards.json"), "utf8"),
  );
  return parseSandboxAccounts(
    readFileSync(join(REPO_ROOT, "deploy", "manifests", SANDBOX_ACCOUNTS_MANIFEST_FILE), "utf8"),
    manifest,
    quotaGuards,
  );
}

function tempDataRoot(): string {
  return mkdtempSync(join(tmpdir(), "zeck-provision-test-"));
}

function input(
  overrides: Partial<ProvisionEnvironmentInput> & { readonly dataRoot: string },
): ProvisionEnvironmentInput {
  const { dataRoot, ...rest } = overrides;
  return {
    environment: "local",
    plan: false,
    manifest: loadRealManifest(),
    sandboxAccounts: loadRealSandboxAccounts(),
    env: { ZECK_ENVIRONMENT: "local" },
    gitRevision: FIXED_REVISION,
    now: () => FIXED_NOW,
    ...rest,
    dataRoot,
  };
}

/** The first item of a fixture-guaranteed list. */
function firstOf<T>(items: readonly T[], what: string): T {
  const head = items[0];
  if (head === undefined) {
    throw new Error(`test fixture: no ${what}`);
  }
  return head;
}

/** The environment record of one class (fixture-guaranteed). */
function environmentRecordOf(
  manifest: ReturnType<typeof loadRealManifest>,
  environment: "local" | "staging" | "production",
) {
  const record = manifest.environments.find((e) => e.id === environment);
  if (record === undefined) {
    throw new Error(`test fixture: no ${environment} environment record`);
  }
  return record;
}

/** Mutate the FIRST local account row of the real manifest and re-serialize. */
function mutateLocalAccount(mutate: (account: Record<string, unknown>) => void): string {
  return mutatedSandboxAccountsSource((document) => {
    const accounts = document.accounts as Record<string, Record<string, unknown>[]>;
    const local = accounts.local ?? [];
    if (local[0] === undefined) {
      throw new Error("test fixture: the real manifest has no local account row");
    }
    mutate(local[0]);
  });
}

/** The first account of one environment class (fixture-guaranteed). */
function firstAccount(
  ledger: ReturnType<typeof loadRealSandboxAccounts>,
  environment: "local" | "staging",
) {
  const account = sandboxAccountsOf(ledger, environment)[0];
  if (account === undefined) {
    throw new Error(`test fixture: no ${environment} account in the real manifest`);
  }
  return account;
}

/** Mutate the real sandbox-accounts manifest and re-serialize it. */
function mutatedSandboxAccountsSource(mutate: (document: Record<string, unknown>) => void): string {
  const document = JSON.parse(
    readFileSync(join(REPO_ROOT, "deploy", "manifests", SANDBOX_ACCOUNTS_MANIFEST_FILE), "utf8"),
  ) as Record<string, unknown>;
  mutate(document);
  return `${JSON.stringify(document, null, 2)}\n`;
}

function expectSandboxAccountsFailure(source: string, expectedProblem: string): void {
  const manifest = loadRealManifest();
  const quotaGuards = loadQuotaGuardsPolicy(
    readFileSync(join(REPO_ROOT, "deploy", "manifests", "quota-guards.json"), "utf8"),
  );
  let failure: SandboxAccountsError | null = null;
  try {
    parseSandboxAccounts(source, manifest, quotaGuards);
  } catch (error) {
    if (error instanceof SandboxAccountsError) {
      failure = error;
    } else {
      throw error;
    }
  }
  expect(failure, `expected SandboxAccountsError containing "${expectedProblem}"`).not.toBeNull();
  expect(failure?.problems.join("\n")).toContain(expectedProblem);
}

// ---------------------------------------------------------------------------
// AC1 — plan mode with zero credentials
// ---------------------------------------------------------------------------

describe("plan mode requires no credentials at all (AC1)", () => {
  test("local plan runs with an entirely empty environment and writes nothing", () => {
    const dataRoot = tempDataRoot();
    const report = provisionEnvironment(input({ dataRoot, plan: true, env: {} }));
    expect(report.mode).toBe("plan");
    expect(report.steps.manifestValidation.passed).toBe(true);
    expect(report.steps.manifestValidation.ruleFamilies).toBe(15);
    // The resource plan is the DEP-001 bootstrap seam (computed names).
    expect(report.steps.resourcePlan.resources.map((r) => r.name)).toEqual([
      "zeck_local",
      "zeck-local-artifacts",
      "zeck-local-redis",
      "zeck-local-runner",
    ]);
    // PPR-008 appended the transport-token reference and PPR-007 appended
    // the experience-token reference; PPR-009 appended the livekit keypair
    // references (additive manifests, all preserved).
    expect(report.steps.secretReferenceScaffold.references).toBe(6);
    expect(report.steps.secretReferenceScaffold.externalOnly).toBe(true);
    expect(report.steps.sandboxAccountRecords.records).toEqual([
      {
        accountId: "local-developer",
        file: "sandbox-accounts/local-developer.sandbox-account.json",
      },
    ]);
    // The environment contract problems (missing ZECK_ENVIRONMENT) are
    // TOLERATED in plan mode — plan requires no credentials at all.
    expect(report.environmentContract.satisfied).toBe(false);
    expect(report.environmentContract.problems.join("\n")).toContain("ZECK_ENVIRONMENT");
    // Nothing was written.
    const projected = report.convergence.wouldWrite ?? [];
    expect(projected).toHaveLength(3);
    expect(projected.every((artifact) => artifact.state === "absent")).toBe(true);
    expect(existsSync(join(dataRoot, "provisioned"))).toBe(false);
  });

  test("staging plan records every live-provider step NOT RUN with its credential variable and owner", () => {
    const report = provisionEnvironment(
      input({ dataRoot: tempDataRoot(), plan: true, environment: "staging", env: {} }),
    );
    const steps = report.liveProviderSteps;
    expect(steps.length).toBe(7); // vercel/neon-project/neon-branch/r2/queue/workflow/upstash
    expect(steps.every((step) => step.status === "not-run")).toBe(true);
    expect(steps.every((step) => step.credentialsPresent === false)).toBe(true);
    expect(steps.every((step) => step.owner !== null)).toBe(true);
    const credentialVariables = steps.map((step) => step.credentialVariable).sort();
    expect(credentialVariables).toEqual([
      "CLOUDFLARE_API_TOKEN",
      "CLOUDFLARE_API_TOKEN",
      "CLOUDFLARE_API_TOKEN",
      "NEON_API_KEY",
      "NEON_API_KEY",
      "UPSTASH_API_KEY",
      "VERCEL_TOKEN",
    ]);
    // The self-hosted execution-runner row is delegated to bootstrap, not a provider step.
    expect(
      report.steps.resourcePlan.resources.some(
        (row) => row.kind === "container-runner" && row.action.startsWith("delegated:"),
      ),
    ).toBe(true);
  });

  test("credential PRESENCE (never values) upgrades a step to an executable plan", () => {
    const report = provisionEnvironment(
      input({
        dataRoot: tempDataRoot(),
        plan: true,
        environment: "staging",
        env: { NEON_API_KEY: "neon-not-a-real-value-just-presence" },
      }),
    );
    const neon = report.liveProviderSteps.filter(
      (step) => step.credentialVariable === "NEON_API_KEY",
    );
    expect(neon).toHaveLength(2);
    expect(neon.every((step) => step.status === "executable-plan")).toBe(true);
    expect(neon.every((step) => step.owner === null)).toBe(true);
    // Presence-only: the value itself never appears anywhere in the report.
    expect(JSON.stringify(report)).not.toContain("neon-not-a-real-value-just-presence");
    const others = report.liveProviderSteps.filter(
      (step) => step.credentialVariable !== "NEON_API_KEY",
    );
    expect(others.every((step) => step.status === "not-run")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// AC3 — idempotent convergence, drift re-convergence, teardown guards
// ---------------------------------------------------------------------------

describe("convergence is idempotent and drift re-converges (AC3)", () => {
  test("first run creates the projection; second run reports already-converged with no changes", () => {
    const dataRoot = tempDataRoot();
    const first = provisionEnvironment(input({ dataRoot }));
    expect(first.mode).toBe("converge");
    expect(first.convergence.converged).toBe(true);
    expect(first.convergence.alreadyConverged).toBe(false);
    expect([...first.convergence.created].sort()).toEqual([
      "sandbox-accounts/local-developer.sandbox-account.json",
      "secrets/ci-variables.json",
      "secrets/secrets.reference.env",
    ]);
    expect(first.steps.postConvergenceValidation.passed).toBe(true);

    const second = provisionEnvironment(input({ dataRoot }));
    expect(second.convergence.alreadyConverged).toBe(true);
    expect(second.convergence.converged).toBe(true);
    expect(second.convergence.created).toEqual([]);
    expect(second.convergence.repaired).toEqual([]);
    expect(second.convergence.pruned).toEqual([]);
    expect(second.convergence.unchanged).toBe(3);
  });

  test("drifted state re-converges: corrupted and deleted artifacts are repaired/created, orphans pruned", () => {
    const dataRoot = tempDataRoot();
    provisionEnvironment(input({ dataRoot }));
    const outputRoot = provisionedArtifactsDirectory(dataRoot, "local");
    // Corrupt one artifact, delete another, plant an orphan (nested).
    writeFileSync(join(outputRoot, "secrets", "ci-variables.json"), "corrupted\n", "utf8");
    rmSync(join(outputRoot, "sandbox-accounts", "local-developer.sandbox-account.json"));
    mkdirSync(join(outputRoot, "orphan", "nested"), { recursive: true });
    writeFileSync(join(outputRoot, "orphan", "nested", "stale.json"), "{}\n", "utf8");

    const reconverged = provisionEnvironment(input({ dataRoot }));
    expect(reconverged.convergence.converged).toBe(true);
    expect(reconverged.convergence.alreadyConverged).toBe(false);
    expect(reconverged.convergence.repaired).toEqual(["secrets/ci-variables.json"]);
    expect(reconverged.convergence.created).toEqual([
      "sandbox-accounts/local-developer.sandbox-account.json",
    ]);
    expect(reconverged.convergence.pruned).toEqual(["orphan/nested/stale.json"]);
    expect(reconverged.steps.postConvergenceValidation.passed).toBe(true);
    // The converged state is EXACTLY the manifest projection — the
    // orphan directory tree is gone entirely.
    expect(existsSync(join(outputRoot, "orphan"))).toBe(false);
  });

  test("preview convergence is namespaced by the branch slug", () => {
    const dataRoot = tempDataRoot();
    const report = provisionEnvironment(
      input({
        dataRoot,
        environment: "preview",
        branch: "work/DEP-002-provisioning-automation",
        env: { ZECK_ENVIRONMENT: "preview" },
      }),
    );
    // The slug is the deterministic previewBranchSlug projection
    // (collapsed, lowercased, truncated to the convention's max length).
    expect(report.previewSlug).toBe("work-dep-002-provisionin");
    expect(report.outputRoot).toBe(
      join(dataRoot, "provisioned", "preview", report.previewSlug ?? ""),
    );
    expect(report.steps.sandboxAccountRecords.records.map((r) => r.accountId)).toEqual([
      "preview-disposable",
    ]);
    // A different branch converges into a different directory (isolation).
    const other = provisionEnvironment(
      input({
        dataRoot,
        environment: "preview",
        branch: "work/DEP-030-usage-dashboard",
        env: { ZECK_ENVIRONMENT: "preview" },
      }),
    );
    expect(other.outputRoot).not.toBe(report.outputRoot);
  });
});

describe("teardown classification guards extend to the provisioned records (AC3)", () => {
  test("local teardown removes exactly the computed provisioned directory, once", () => {
    const dataRoot = tempDataRoot();
    provisionEnvironment(input({ dataRoot }));
    const environmentRecord = environmentRecordOf(loadRealManifest(), "local");
    expect(environmentRecord.teardownAllowed).toBe(true);
    const removed = teardownProvisionedRecords({
      dataRoot,
      environment: "local",
      environmentRecord,
    });
    expect(removed.removed).toBe(true);
    expect(removed.directory).toBe(join(dataRoot, "provisioned", "local"));
    expect(existsSync(removed.directory)).toBe(false);
    // Other environments' records are untouched.
    provisionEnvironment(
      input({ dataRoot, environment: "staging", env: { ZECK_ENVIRONMENT: "staging" } }),
    );
    teardownProvisionedRecords({
      dataRoot,
      environment: "local",
      environmentRecord,
    });
    expect(existsSync(join(dataRoot, "provisioned", "staging"))).toBe(true);
    // Already-absent is reported honestly on a second teardown.
    const again = teardownProvisionedRecords({
      dataRoot,
      environment: "local",
      environmentRecord,
    });
    expect(again.removed).toBe(false);
    expect(again.alreadyAbsent).toBe(true);
  });

  test("persistent environments are refused even if a caller bypasses deploy/teardown's own guard", () => {
    const dataRoot = tempDataRoot();
    const manifest = loadRealManifest();
    for (const environment of ["staging", "production"] as const) {
      const environmentRecord = environmentRecordOf(manifest, environment);
      expect(environmentRecord.teardownAllowed).toBe(false);
      expect(() =>
        teardownProvisionedRecords({
          dataRoot,
          environment,
          environmentRecord,
        }),
      ).toThrow(/refusing to remove provisioned records/);
      expect(() =>
        teardownProvisionedRecords({
          dataRoot,
          environment,
          environmentRecord,
        }),
      ).toThrow(/persistent; classification, not operator intent/);
    }
  });
});

// ---------------------------------------------------------------------------
// AC2 — secret handling is external-only (hostile probes)
// ---------------------------------------------------------------------------

describe("secret handling is external-only — hostile probes (AC2)", () => {
  const PLAINTEXT = "postgres://operator:supersecret-hunter2@db.example.com/zeck";

  test("plaintext in a reference variable aborts fail-closed in BOTH modes and is never echoed", () => {
    for (const plan of [true, false]) {
      let failure: ProvisionError | null = null;
      try {
        provisionEnvironment(
          input({
            dataRoot: tempDataRoot(),
            plan,
            env: {
              ZECK_ENVIRONMENT: "local",
              ZECK_SECRET_DATABASE_URL_REF: PLAINTEXT,
            },
          }),
        );
      } catch (error) {
        if (error instanceof ProvisionError) {
          failure = error;
        } else {
          throw error;
        }
      }
      expect(failure, `plan=${plan}: expected a fail-closed refusal`).not.toBeNull();
      expect(failure?.problems.join("\n")).toContain(
        "a non-reference value (plaintext credential material) is rejected fail closed",
      );
      // The refusal names the VARIABLE, never the plaintext.
      expect(failure?.message).not.toContain("supersecret-hunter2");
    }
  });

  test("cross-environment references are refused (production material is not addressable from local)", () => {
    let failure: ProvisionError | null = null;
    try {
      provisionEnvironment(
        input({
          dataRoot: tempDataRoot(),
          env: {
            ZECK_ENVIRONMENT: "local",
            ZECK_SECRET_DATABASE_URL_REF: "zeck-secret://production/database-url",
          },
        }),
      );
    } catch (error) {
      if (error instanceof ProvisionError) {
        failure = error;
      } else {
        throw error;
      }
    }
    expect(failure).not.toBeNull();
    expect(failure?.problems.join("\n")).toContain("environment isolation");
  });

  test("the converged scaffold artifacts carry references only — never values", () => {
    const dataRoot = tempDataRoot();
    provisionEnvironment(
      input({
        dataRoot,
        env: {
          ZECK_ENVIRONMENT: "local",
          // A fully materialized, VALID reference environment: the tool
          // still never touches the VALUE (which lives externally).
          ZECK_SECRET_DATABASE_URL_REF: "zeck-secret://local/database-url",
          ZECK_SECRET_REDIS_URL_REF: "zeck-secret://local/redis-url",
        },
      }),
    );
    const envScaffold = readFileSync(
      join(dataRoot, "provisioned", "local", "secrets", "secrets.reference.env"),
      "utf8",
    );
    // Every non-comment line is VARIABLE=zeck-secret://local/<name>.
    for (const line of envScaffold.split("\n")) {
      if (line.length === 0 || line.startsWith("#")) {
        continue;
      }
      expect(line).toMatch(/^ZECK_SECRET_[A-Z0-9_]+_REF=zeck-secret:\/\/local\/[a-z0-9-]+$/);
    }
    expect(envScaffold).toContain("ZECK_SECRET_DATABASE_URL_REF=zeck-secret://local/database-url");
    const ciSkeleton = JSON.parse(
      readFileSync(join(dataRoot, "provisioned", "local", "secrets", "ci-variables.json"), "utf8"),
    ) as {
      doctrine: string;
      secretReferenceVariables: Array<{ reference: string; injectionPoint: string }>;
    };
    // PPR-008's transport-token + PPR-007's experience-token + PPR-009's
    // livekit keypair (additive, all preserved).
    expect(ciSkeleton.secretReferenceVariables).toHaveLength(6);
    for (const entry of ciSkeleton.secretReferenceVariables) {
      expect(entry.reference).toMatch(/^zeck-secret:\/\/local\/[a-z0-9-]+$/);
      expect(entry.injectionPoint).toContain("external secret manager");
    }
    // The artifact set contains no credential-shaped material at all.
    for (const content of [envScaffold, JSON.stringify(ciSkeleton)]) {
      expect(content).not.toMatch(/[a-z][a-z0-9+.-]*:\/\/[^\s"'@/:]+:[^\s"'@]+@/i);
      expect(content).not.toMatch(/\bsk-[A-Za-z0-9_-]{16,}\b/);
      expect(content).not.toMatch(/\bgh[pousr]_[A-Za-z0-9]{20,}\b/);
      expect(content).not.toMatch(/\bAKIA[0-9A-Z]{16}\b/);
    }
  });

  test("planted credential values never reach the report or the artifacts (the render probe)", () => {
    const dataRoot = tempDataRoot();
    const report = provisionEnvironment(
      input({
        dataRoot,
        plan: true,
        environment: "staging",
        env: {
          NEON_API_KEY: "sk-planted-neon-value-abcdef123456",
          CLOUDFLARE_API_TOKEN: "ghp_plantedCloudflareTokenValue12345",
          UPSTASH_API_KEY: "AKIA_plantedUPSTASH12345",
          VERCEL_TOKEN: "xoxb-planted-vercel-token-12345",
          ZECK_PG_ADMIN_URL: "postgres://root:planted-pg-password@127.0.0.1:5432/postgres",
        },
      }),
    );
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain("sk-planted-neon-value");
    expect(serialized).not.toContain("ghp_plantedCloudflareTokenValue12345");
    expect(serialized).not.toContain("AKIA_plantedUPSTASH12345");
    expect(serialized).not.toContain("xoxb-planted-vercel-token");
    expect(serialized).not.toContain("planted-pg-password");
  });

  test("REAL-PROCESS probe: the CLI never accepts, stores, logs or renders planted plaintext", () => {
    const dataRoot = tempDataRoot();
    const planted = {
      ...process.env,
      ZECK_ENVIRONMENT: "local",
      ZECK_LOCAL_DATA_ROOT: dataRoot,
      NEON_API_KEY: "sk-planted-neon-cli-abcdef123456",
      ZECK_PG_ADMIN_URL: "postgres://root:planted-cli-pg-password@127.0.0.1:5432/postgres",
    };
    // Converge for real through the CLI entry point.
    const converge = execFileSync(
      "bun",
      ["deploy/provision.ts", "--environment", "local", "--json"],
      { cwd: REPO_ROOT, env: planted, encoding: "utf8" },
    );
    expect(converge).not.toContain("sk-planted-neon-cli");
    expect(converge).not.toContain("planted-cli-pg-password");
    // And the plan render (the human output path).
    const plan = execFileSync("bun", ["deploy/provision.ts", "--environment", "local", "--plan"], {
      cwd: REPO_ROOT,
      env: planted,
      encoding: "utf8",
    });
    expect(plan).not.toContain("sk-planted-neon-cli");
    expect(plan).not.toContain("planted-cli-pg-password");
    // Nothing leaked onto disk either.
    const artifacts = [
      readFileSync(
        join(dataRoot, "provisioned", "local", "secrets", "secrets.reference.env"),
        "utf8",
      ),
      readFileSync(join(dataRoot, "provisioned", "local", "secrets", "ci-variables.json"), "utf8"),
      readFileSync(
        join(
          dataRoot,
          "provisioned",
          "local",
          "sandbox-accounts",
          "local-developer.sandbox-account.json",
        ),
        "utf8",
      ),
    ];
    for (const artifact of artifacts) {
      expect(artifact).not.toContain("sk-planted-neon-cli");
      expect(artifact).not.toContain("planted-cli-pg-password");
    }
    // The hostile acceptance probe: plaintext offered through a
    // reference variable makes the REAL CLI refuse (exit 1) without
    // echoing it.
    let refusal = "";
    let refusalCode = 0;
    try {
      execFileSync("bun", ["deploy/provision.ts", "--environment", "local", "--plan"], {
        cwd: REPO_ROOT,
        env: {
          ...planted,
          ZECK_SECRET_DATABASE_URL_REF: "plaintext-offered-through-a-reference-variable",
        },
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      refusalCode = (error as { status?: number }).status ?? 0;
      refusal = String((error as { stderr?: string }).stderr ?? "");
    }
    expect(refusalCode).toBe(1);
    expect(refusal).toContain("plaintext credential material");
    expect(refusal).not.toContain("plaintext-offered-through-a-reference-variable");
  });
});

// ---------------------------------------------------------------------------
// Fail-closed manifest validation on malformed rows
// ---------------------------------------------------------------------------

describe("sandbox-account manifest validation fails closed on malformed rows", () => {
  test("the real repository manifest parses clean with the expected per-class sets", () => {
    const ledger = loadRealSandboxAccounts();
    expect(sandboxAccountsOf(ledger, "local").map((a) => a.id)).toEqual(["local-developer"]);
    expect(sandboxAccountsOf(ledger, "preview").map((a) => a.id)).toEqual(["preview-disposable"]);
    expect(sandboxAccountsOf(ledger, "staging").map((a) => a.id)).toEqual(["staging-validation"]);
    expect(sandboxAccountsOf(ledger, "production")).toEqual([]);
  });

  test("deploy:validate (rule 15) counts the real manifest surface", () => {
    const report = validateDeploymentConfiguration();
    expect(report.valid).toBe(true);
    expect(report.sandboxAccountEnvironments).toBe(3);
    expect(report.sandboxAccounts).toBe(3);
  });

  test("invalid JSON aborts", () => {
    expectSandboxAccountsFailure("{ not json", "is not valid JSON");
  });

  test("an unsupported schemaVersion aborts", () => {
    expectSandboxAccountsFailure(
      mutatedSandboxAccountsSource((d) => {
        d.schemaVersion = 2;
      }),
      "unsupported schemaVersion",
    );
  });

  test("an unknown environment key aborts", () => {
    expectSandboxAccountsFailure(
      mutatedSandboxAccountsSource((d) => {
        (d.accounts as Record<string, unknown>).ci = [];
      }),
      '"ci" is not a known environment class',
    );
  });

  test("a missing environment entry aborts (coverage is mandatory, not defaulted)", () => {
    expectSandboxAccountsFailure(
      mutatedSandboxAccountsSource((d) => {
        delete (d.accounts as Record<string, unknown>).preview;
      }),
      'no accounts entry for environment "preview"',
    );
  });

  test("an authoritative-data environment declaring accounts aborts", () => {
    expectSandboxAccountsFailure(
      mutatedSandboxAccountsSource((d) => {
        const accounts = d.accounts as Record<string, Record<string, unknown>[]>;
        const local = accounts.local ?? [];
        if (local[0] === undefined) {
          throw new Error("test fixture: the real manifest has no local account row");
        }
        accounts.production = [local[0]];
      }),
      'dataPolicy "authoritative"',
    );
  });

  test("a disposable environment class declaring no accounts aborts", () => {
    expectSandboxAccountsFailure(
      mutatedSandboxAccountsSource((d) => {
        (d.accounts as Record<string, unknown[]>).preview = [];
      }),
      "every disposable environment class needs its disposable identity set",
    );
  });

  test("a synthetic-data class list that drifts from the frozen platform artifact aborts", () => {
    expectSandboxAccountsFailure(
      mutateLocalAccount((account) => {
        const policy = account.syntheticDataPolicy as { permittedClasses: string[] };
        policy.permittedClasses = ["synthetic-text", "synthetic-fixture-reference"];
      }),
      "must equal the platform artifact's permitted set",
    );
  });

  test("an unknown quota dimension / non-integer limit / unknown window abort", () => {
    expectSandboxAccountsFailure(
      mutateLocalAccount((account) => {
        const dimensions = (account.quotaEnvelope as { dimensions: { dimension: string }[] })
          .dimensions;
        firstOf(dimensions, "quota dimension").dimension = "spend-dollars";
      }),
      "must be one of spend-micro-usd|wall-clock-ms|concurrent-runs|artifact-count|artifact-bytes",
    );
    expectSandboxAccountsFailure(
      mutateLocalAccount((account) => {
        const dimensions = (account.quotaEnvelope as { dimensions: { limit: string }[] })
          .dimensions;
        firstOf(dimensions, "quota dimension").limit = "12.5";
      }),
      "must be a positive integer decimal string",
    );
    expectSandboxAccountsFailure(
      mutateLocalAccount((account) => {
        const dimensions = (account.quotaEnvelope as { dimensions: { window: string }[] })
          .dimensions;
        firstOf(dimensions, "quota dimension").window = "per-second";
      }),
      "must be one of calendar-month|per-identity",
    );
  });

  test("an unknown quota-guard wiring aborts", () => {
    expectSandboxAccountsFailure(
      mutateLocalAccount((account) => {
        const envelope = account.quotaEnvelope as { guards: string[] };
        envelope.guards = ["compute-claims", "not-a-declared-guard"];
      }),
      'guard "not-a-declared-guard" is not declared in quota-guards.json',
    );
  });

  test("a platform-default TTL that contradicts the DEP-014 default aborts", () => {
    expectSandboxAccountsFailure(
      mutateLocalAccount((account) => {
        (account.expiry as { ttlMs: number }).ttlMs = SANDBOX_IDENTITY_DEFAULT_TTL_MS + 1;
      }),
      `requires ttlMs to equal the platform default (${SANDBOX_IDENTITY_DEFAULT_TTL_MS} ms`,
    );
  });

  test("a non-DEP-014 reset or post-expiry read mode aborts", () => {
    expectSandboxAccountsFailure(
      mutateLocalAccount((account) => {
        (account.expiry as { reset: string }).reset = "state-carrying";
      }),
      'expiry.reset must be "state-non-carrying"',
    );
    expectSandboxAccountsFailure(
      mutateLocalAccount((account) => {
        (account.expiry as { postExpiryReads: string }).postExpiryReads = "silent-delete";
      }),
      'expiry.postExpiryReads must be "honest-expired-state"',
    );
  });

  test("malformed account ids and duplicate rows abort", () => {
    expectSandboxAccountsFailure(
      mutateLocalAccount((account) => {
        account.id = "Bad_ID";
      }),
      "must be kebab-case",
    );
    expectSandboxAccountsFailure(
      mutatedSandboxAccountsSource((d) => {
        const accounts = d.accounts as Record<string, Record<string, unknown>[]>;
        const local = accounts.local ?? [];
        if (local[0] === undefined) {
          throw new Error("test fixture: the real manifest has no local account row");
        }
        accounts.local = [local[0], local[0]];
      }),
      "appears more than once",
    );
  });
});

// ---------------------------------------------------------------------------
// AC4 — sandbox-account policy facts projected from the manifests
// ---------------------------------------------------------------------------

describe("sandbox-account records render their policy facts from the manifests (AC4)", () => {
  test("every policy fact traces to a manifest row or a platform authority — never tool-local state", () => {
    const manifest = loadRealManifest();
    const ledger = loadRealSandboxAccounts();
    const environmentRecord = environmentRecordOf(manifest, "local");
    const account = firstAccount(ledger, "local");
    const document = renderSandboxAccountDocument(environmentRecord, account, "provisioned");

    // Environment facts come from environments.json.
    expect(document.environmentClass).toBe("disposable");
    expect(document.dataPolicy).toBe("synthetic-only");
    expect(document.credentialScope).toBe("developer-local");
    // The synthetic-data policy EQUALS the frozen platform artifact.
    expect(document.syntheticDataPolicy).toEqual({
      artifact: SYNTHETIC_DATA_POLICY.artifact,
      version: SYNTHETIC_DATA_POLICY.version,
      permittedClasses: [...SYNTHETIC_DATA_POLICY.permittedClasses],
      prohibitedClasses: [...SYNTHETIC_DATA_POLICY.prohibitedClasses],
    });
    // The quota envelope: declared dimensions + guards RESOLVED from
    // quota-guards.json (thresholds are wired, never restated).
    const envelope = document.quotaEnvelope as {
      dimensions: Array<{ dimension: string; limit: string; window: string }>;
      guards: Array<{ guard: string; warnAtPct: number; criticalAtPct: number }>;
    };
    expect(envelope.dimensions).toContainEqual({
      dimension: "spend-micro-usd",
      limit: "10000000",
      window: "per-identity",
    });
    expect(envelope.guards).toEqual([
      { guard: "compute-claims", warnAtPct: 80, criticalAtPct: 95 },
      { guard: "queue-backlog", warnAtPct: 80, criticalAtPct: 95 },
      { guard: "database-size", warnAtPct: 80, criticalAtPct: 95 },
    ]);
    // Expiry: the DEP-014 disposable-identity discipline.
    expect(document.expiry).toEqual({
      ttlSource: "platform-default",
      ttlMs: SANDBOX_IDENTITY_DEFAULT_TTL_MS,
      reset: "state-non-carrying",
      postExpiryReads: "honest-expired-state",
    });
    expect(document.projectedFrom).toBe(
      `deploy/manifests/${SANDBOX_ACCOUNTS_MANIFEST_FILE} (policy facts; never tool-local state)`,
    );
    expect(document.status).toBe("provisioned");
  });

  test("the projection is deterministic (byte-identical renders) and status-variant", () => {
    const manifest = loadRealManifest();
    const ledger = loadRealSandboxAccounts();
    const environmentRecord = environmentRecordOf(manifest, "staging");
    const account = firstAccount(ledger, "staging");
    const first = JSON.stringify(
      renderSandboxAccountDocument(environmentRecord, account, "provisioned"),
    );
    const second = JSON.stringify(
      renderSandboxAccountDocument(environmentRecord, account, "provisioned"),
    );
    expect(first).toBe(second);
    const planned = JSON.stringify(
      renderSandboxAccountDocument(environmentRecord, account, "planned"),
    );
    expect(planned).not.toBe(first);
    expect(JSON.parse(planned).status).toBe("planned");
  });

  test("an edited manifest row flows through the projection (never a tool-local registry)", () => {
    const manifest = loadRealManifest();
    const quotaGuards = loadQuotaGuardsPolicy(
      readFileSync(join(REPO_ROOT, "deploy", "manifests", "quota-guards.json"), "utf8"),
    );
    const source = mutateLocalAccount((account) => {
      const dimensions = (account.quotaEnvelope as { dimensions: { limit: string }[] }).dimensions;
      firstOf(dimensions, "quota dimension").limit = "20000000";
    });
    const edited = parseSandboxAccounts(source, manifest, quotaGuards);
    const environmentRecord = environmentRecordOf(manifest, "local");
    const document = renderSandboxAccountDocument(
      environmentRecord,
      firstAccount(edited, "local"),
      "provisioned",
    );
    const envelope = document.quotaEnvelope as {
      dimensions: Array<{ dimension: string; limit: string }>;
    };
    expect(envelope.dimensions.find((d) => d.dimension === "spend-micro-usd")?.limit).toBe(
      "20000000",
    );
  });

  test("the converged on-disk record equals the pure projection", () => {
    const dataRoot = tempDataRoot();
    provisionEnvironment(input({ dataRoot }));
    const manifest = loadRealManifest();
    const ledger = loadRealSandboxAccounts();
    const environmentRecord = environmentRecordOf(manifest, "local");
    const onDisk = readFileSync(
      join(
        dataRoot,
        "provisioned",
        "local",
        "sandbox-accounts",
        "local-developer.sandbox-account.json",
      ),
      "utf8",
    );
    expect(onDisk).toBe(
      `${JSON.stringify(
        renderSandboxAccountDocument(
          environmentRecord,
          firstAccount(ledger, "local"),
          "provisioned",
        ),
        null,
        2,
      )}\n`,
    );
  });
});
