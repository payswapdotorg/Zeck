/**
 * Architecture: the declarative tail-pacing configuration plane
 * boundaries (executions module domain + the wired seam; ACR-010 §3–§4;
 * work order PCL-002).
 *
 * Mechanically proves over the REAL tree:
 *
 *  - T1 NO NEW DURABLE SURFACE: the tail-pacing plane holds no SQL, no
 *    store, no state machine, no lifecycle; the platform migration
 *    census is unchanged (33 migrations — the pacing plane is
 *    configuration DATA, never an engine).
 *  - T2 THE ENFORCED LAYERING: the domain artifact imports SAME-MODULE
 *    domain files only (`./outcome-latency-facts` — the PCL-01 artifact
 *    consumed read-only); the adapter imports same-module domain and
 *    src/shared only — never a platform plane, never a cross-module
 *    surface, never a runtime package (AGENTS.md domain layering).
 *  - T3 NO AMBIENT CONFIGURATION: neither file reads the environment,
 *    the clock, the randomness or the network (ACR-010 §6 — the pacing
 *    configuration is declared and versioned, never environment-
 *    scattered flags; the jitter draw is INJECTED at the seam).
 *  - T4 THE CLOSED VOCABULARIES AND MIRRORED BOUNDS: every vocabulary
 *    is pinned exactly (the backoff shapes, the re-entry modes, the
 *    progress preferences, the frozen terminal classes, the version)
 *    and every mirrored platform bound is pinned by value — widening
 *    is a reviewed change, never silent.
 *  - T5 THE CONFINEMENT: the tail-pacing vocabulary is confined to the
 *    executions module and the tests (the ACR-009/PCL-001 discipline —
 *    no other code surface references the plane).
 *  - T6 NO SECOND ENGINE: the plane declares no router, no planner, no
 *    executor, no verification surface, no retry loop, no cooldown
 *    timer, no poll loop — the adapter exports exactly the resolver
 *    seam (the E1.1 non-redundancy invariant made structural).
 */

import { execSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import {
  COOLDOWN_REENTRY_MODES,
  MAX_BACKOFF_BASE_MS,
  MAX_BACKOFF_CEILING_MS,
  MAX_COOLDOWN_MS,
  MAX_JITTER_FRACTION,
  MAX_PACING_RETRIES,
  MAX_POLLING_INTERVAL_MS,
  MAX_TIMEOUT_CONTRACT_MS,
  MIN_POLLING_INTERVAL_MS,
  MIN_PROBE_FRACTION,
  PROGRESS_PREFERENCES,
  RETRY_BACKOFF_SHAPES,
  TAIL_PACING_CONFIGURATION_VERSION,
  TERMINAL_PACING_FAILURE_CLASSES,
} from "../../src/modules/executions/domain/tail-pacing-configuration";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const DOMAIN_PATH = "src/modules/executions/domain/tail-pacing-configuration.ts";
const ADAPTER_PATH = "src/modules/executions/adapters/tail-pacing.ts";

function read(rel: string): string {
  return readFileSync(join(REPO_ROOT, rel), "utf8");
}

function listFiles(dir: string): string[] {
  const base = join(REPO_ROOT, dir);
  const walk = (current: string, prefix: string, out: string[]): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) {
        walk(join(current, entry.name), rel, out);
      } else if (entry.name.endsWith(".ts")) {
        out.push(rel);
      }
    }
  };
  const out: string[] = [];
  walk(base, dir, out);
  return out.sort();
}

const DOMAIN_MODULE = read(DOMAIN_PATH);
const ADAPTER_MODULE = read(ADAPTER_PATH);

describe("architecture: the declarative tail-pacing configuration plane (PCL-002)", () => {
  test("T1 no new durable surface: no SQL, no store, no state machine; the migration census is unchanged", () => {
    for (const source of [DOMAIN_MODULE, ADAPTER_MODULE]) {
      expect(source).not.toMatch(
        /\b(INSERT\s+INTO|UPDATE\s+\w+\s+SET|DELETE\s+FROM|CREATE\s+TABLE|ALTER\s+TABLE)\b/i,
      );
      expect(source).not.toContain("DatabasePort");
      expect(source).not.toContain("transitionTable");
      expect(source).not.toContain("createTable");
    }
    // The platform migration census at the PCL-002 base is 33 SQL
    // files — the pacing plane added none (no durable surface).
    const migrations = readdirSync(join(REPO_ROOT, "src/platform/db/migrations"))
      .filter((name) => name.endsWith(".sql"))
      .sort();
    expect(migrations).toHaveLength(33);
    expect(migrations.at(-1)).toBe("0034_sandbox_governance.sql");
  });

  test("T2 the enforced layering: domain imports same-module domain only; the adapter adds nothing beyond domain + shared", () => {
    // The domain artifact's ONLY import is the PCL-01 artifact
    // (same-module domain, read-only consumption — the type and the
    // value import both address exactly that one module).
    const domainImports = [
      ...new Set(
        [...DOMAIN_MODULE.matchAll(/from\s+"([^"]+)"/g)]
          .map((m) => m[1])
          .filter((spec): spec is string => spec !== undefined),
      ),
    ];
    expect(domainImports).toEqual(["./outcome-latency-facts"]);
    // The adapter imports same-module domain only.
    const adapterImports = [
      ...new Set(
        [...ADAPTER_MODULE.matchAll(/from\s+"([^"]+)"/g)]
          .map((m) => m[1])
          .filter((spec): spec is string => spec !== undefined),
      ),
    ];
    expect(adapterImports.every((spec) => spec.startsWith("../domain/"))).toBe(true);
    expect(adapterImports).toContain("../domain/tail-pacing-configuration");
    expect(adapterImports).toContain("../domain/outcome-latency-facts");
    // Neither file imports a platform plane, a cross-module surface or
    // a runtime package (the mechanical layering law).
    for (const source of [DOMAIN_MODULE, ADAPTER_MODULE]) {
      expect(source).not.toMatch(/from\s+"(\.\.\/){2,}(platform|modules)\//);
      expect(source).not.toMatch(/from\s+"(pg|fastify|socket\.io|zod|vitest)/);
    }
  });

  test("T3 no ambient configuration: no environment read, no clock, no randomness, no network", () => {
    for (const source of [DOMAIN_MODULE, ADAPTER_MODULE]) {
      expect(source).not.toContain("process.env");
      expect(source).not.toContain("Date.now");
      expect(source).not.toMatch(/new\s+Date\(/);
      expect(source).not.toContain("Math.random");
      expect(source).not.toMatch(/\bfetch\s*\(/);
      expect(source).not.toContain("localeCompare");
      expect(source).not.toContain("setTimeout");
    }
  });

  test("T4 the closed vocabularies and mirrored bounds are pinned exactly (widening is a reviewed change)", () => {
    expect([...RETRY_BACKOFF_SHAPES]).toEqual(["linear", "exponential"]);
    expect([...COOLDOWN_REENTRY_MODES]).toEqual(["expiry", "early-probe"]);
    expect([...PROGRESS_PREFERENCES]).toEqual(["event-stream-else-polled", "polled-only"]);
    // THE FROZEN TERMINAL CLASSES (the preservation gate's own set).
    expect([...TERMINAL_PACING_FAILURE_CLASSES]).toEqual(["budget-exhausted", "policy-denied"]);
    // The versioned surface: exactly 1.
    expect(TAIL_PACING_CONFIGURATION_VERSION).toBe(1);
    // The mirrored platform bounds (alignment by value, never import).
    expect(MAX_PACING_RETRIES).toBe(10);
    expect(MAX_BACKOFF_BASE_MS).toBe(60_000);
    expect(MAX_BACKOFF_CEILING_MS).toBe(600_000);
    expect(MAX_JITTER_FRACTION).toBe(0.5);
    expect(MAX_COOLDOWN_MS).toBe(3_600_000);
    expect(MIN_POLLING_INTERVAL_MS).toBe(50);
    expect(MAX_POLLING_INTERVAL_MS).toBe(5_000);
    expect(MAX_TIMEOUT_CONTRACT_MS).toBe(3_600_000);
    expect(MIN_PROBE_FRACTION).toBe(0.05);
  });

  test("T5 the confinement: the tail-pacing vocabulary lives only in the executions module and the tests", () => {
    const vocabularyPattern = /tail[-_]?pacing|tailPacing/i;
    const offenders: string[] = [];
    const scan = (relPath: string): void => {
      const full = join(REPO_ROOT, relPath);
      if (!existsSync(full)) {
        return;
      }
      let entries: { name: string; isDirectory(): boolean }[];
      try {
        entries = readdirSync(full, { withFileTypes: true }) as never;
      } catch {
        if (relPath.endsWith(".ts") && vocabularyPattern.test(read(relPath))) {
          offenders.push(relPath);
        }
        return;
      }
      for (const entry of entries) {
        const rel = `${relPath}/${entry.name}`;
        if (entry.isDirectory()) {
          scan(rel);
        } else if (entry.name.endsWith(".ts") && vocabularyPattern.test(read(rel))) {
          offenders.push(rel);
        }
      }
    };
    const siblingModules = readdirSync(join(REPO_ROOT, "src/modules"), { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && entry.name !== "executions")
      .map((entry) => `src/modules/${entry.name}`);
    for (const surface of [
      ...siblingModules,
      "src/api",
      "src/platform",
      "src/shared",
      "src/integrations",
      "api",
      "apps",
      "benchmarks",
      "compat",
      "examples",
      "experiments",
      "sdk",
      "cli",
      "deploy",
      "server.ts",
    ]) {
      scan(surface);
    }
    expect(offenders).toEqual([]);
    // Inside the executions module the vocabulary appears in exactly
    // the two declared PCL-002 artifacts.
    const homeOffenders = listFiles("src/modules/executions").filter((file) =>
      vocabularyPattern.test(read(file)),
    );
    expect(homeOffenders).toEqual([ADAPTER_PATH, DOMAIN_PATH]);
  });

  test("T6 no second engine: the plane is data-resolution only; the adapter exports exactly the resolver seam", () => {
    for (const source of [DOMAIN_MODULE, ADAPTER_MODULE]) {
      // No retry loop, no cooldown timer, no poll loop, no route or
      // plan decision anywhere in the plane (data, never an engine).
      expect(source).not.toMatch(/\bwhile\s*\(/);
      expect(source).not.toMatch(/\bfor\s+await\b/);
      expect(source).not.toMatch(/setInterval/);
      expect(source).not.toContain("selectRoute");
      expect(source).not.toContain("composePlan");
      expect(source).not.toContain("verifyOutcome");
      // No new authority: the plane never authorizes or transitions
      // anything. (The cooldown RE-ENTRY ADMISSION is the plane's own
      // honest data verdict — `admissible: boolean` over a declared
      // rule — not a policy admission surface; the layering check T2
      // already proves no admission/authority module is imported.)
      expect(source).not.toContain("authorize");
      expect(source).not.toContain("transition");
    }
    // The adapter's exported surface is exactly the resolver seam (the
    // single pacing-reading point — no second router/planner/executor).
    const adapterExports = [
      ...ADAPTER_MODULE.matchAll(/export\s+(?:interface|function|class|const|type)\s+(\w+)/g),
    ].map((m) => m[1]);
    expect(adapterExports.sort()).toEqual([
      "TailPacingResolver",
      "TailPacingResolverDeps",
      "createTailPacingResolver",
    ]);
    // The domain's exported surface is the configuration data plane +
    // the pure resolutions (pinned: widening the surface is reviewed).
    const domainExports = [
      ...DOMAIN_MODULE.matchAll(/export\s+(?:interface|function|class|const|type)\s+(\w+)/g),
    ]
      .map((m) => m[1])
      .sort();
    expect(domainExports).toEqual([
      "COOLDOWN_REENTRY_MODES",
      "CooldownDisciplineConfiguration",
      "CooldownReentryAdmission",
      "CooldownReentryMode",
      "CooldownRule",
      "MAX_BACKOFF_BASE_MS",
      "MAX_BACKOFF_CEILING_MS",
      "MAX_COOLDOWN_MS",
      "MAX_JITTER_FRACTION",
      "MAX_PACING_RETRIES",
      "MAX_POLLING_INTERVAL_MS",
      "MAX_TIMEOUT_CONTRACT_MS",
      "MIN_POLLING_INTERVAL_MS",
      "MIN_PROBE_FRACTION",
      "PROGRESS_PREFERENCES",
      "PacingValidation",
      "ProgressDeliveryConfiguration",
      "ProgressPreference",
      "RETRY_BACKOFF_SHAPES",
      "ResolvedProgressDelivery",
      "RetryBackoffShape",
      "RetryPacingConfiguration",
      "TAIL_PACING_CONFIGURATION_VERSION",
      "TERMINAL_PACING_FAILURE_CLASSES",
      "TailPacingConfiguration",
      "TailPacingConfigurationError",
      "TailPacingConfigurationVersion",
      "TimeoutContract",
      "TransportProgressCapabilities",
      "cooldownReentryAdmission",
      "cooldownRuleFor",
      "cooldownStateAtDispatch",
      "progressDeliveryFactsOf",
      "resolveProgressDelivery",
      "resolveTailPacing",
      "retryBackoffDelayMs",
      "validateTailPacingConfiguration",
    ]);
  });

  test("T7 the drift-immune ownership pin: this branch touches nothing outside the executions module and the tests", () => {
    // The e11 C9 / PCL-001 A7 pattern (the records channel docs/ +
    // spec/ is Lead-owned governance surface, excluded; the empty diff
    // post-merge passes trivially).
    const mainRef = ["main", "origin/main"].find((candidate) => {
      try {
        execSync(`git rev-parse --verify --quiet ${candidate}`, {
          cwd: REPO_ROOT,
          encoding: "utf8",
        });
        return true;
      } catch {
        return false;
      }
    });
    expect(mainRef, "a main ref must exist for the ownership pin").toBeDefined();
    const mergeBase = execSync(`git merge-base HEAD ${mainRef}`, {
      cwd: REPO_ROOT,
      encoding: "utf8",
    }).trim();
    expect(mergeBase).toMatch(/^[0-9a-f]{40}$/);
    const changed = execSync(`git diff --name-only ${mergeBase}..HEAD`, {
      cwd: REPO_ROOT,
      encoding: "utf8",
    })
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    const recordsChannel = (file: string) => file.startsWith("docs/") || file.startsWith("spec/");
    const substantiveSurface = (file: string) => file.startsWith("src/modules/executions/");
    const touchesThisWorkOrder = changed.some(
      (file) => !recordsChannel(file) && substantiveSurface(file),
    );
    if (touchesThisWorkOrder) {
      const outsideOwnership = changed
        .filter((file) => !recordsChannel(file))
        .filter(
          (file) => !file.startsWith("src/modules/executions/") && !file.startsWith("tests/"),
        );
      expect(outsideOwnership).toEqual([]);
    }
  });
});
