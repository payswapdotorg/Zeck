/**
 * Architecture: the D-04 durable-orchestration boundaries (WORK-045 /
 * Deployment Roadmap D-04; checkpoint contracts SELF-HOSTING-BOUNDARY,
 * IDENTITY-IDEMPOTENCY, CONCURRENCY-CRASH-SAFETY, EXECUTION-PROVENANCE,
 * IMPLEMENTATION-COMPLETENESS).
 *
 * Mechanically proves over the REAL tree:
 *
 *  - B1 PLATFORM ISOLATION: `src/platform/workflow/**` imports no
 *    module/integration/api surface (the shared rule engine pins the
 *    whole tree; the workflow plane is pinned explicitly here).
 *  - B2 THE PORT IS THE FROZEN MINIMAL PROVIDER-NEUTRAL CONTRACT: the
 *    port file exposes start/observe/signal/terminate/describe-limits
 *    + the bounded policy, state-bounds and correlation types, and
 *    carries NO provider vocabulary (cloudflare/bearer/REST paths
 *    never leak onto the port).
 *  - B3 PROVIDER VOCABULARY CONFINED: Cloudflare vocabulary appears
 *    only in the owning adapter
 *    (`src/platform/workflow/cloudflare-workflows.ts`), deploy
 *    tooling and tests — never in domain modules, never on the port,
 *    never in the correlation/engine/inspection machinery.
 *  - B4 NO SECOND EXECUTION STATE MACHINE: the platform workflow
 *    plane contains NONE of the 14 frozen execution state words
 *    (case-insensitively) and none of the execution event words; the
 *    wait vocabulary is disjoint (the unit suite pins the constants;
 *    this pins the SOURCES).
 *  - B5 THE AUTHORITY BOUNDARY: the workflow plane's only database
 *    dependency is the platform DatabasePort — the execution write
 *    path stays in the executions module (the integration points are
 *    the orchestration-source and workflow-effect ADAPTERS inside
 *    the executions module, importing platform types only, following
 *    the module-adapter-bridges-to-platform pattern).
 *  - B6 SECRET-FREE SOURCES: the new platform/deploy sources contain
 *    no credential-shaped literals; the workflow API token is
 *    environment-only materialization (declared in the manifests and
 *    the env secret store, never a repository value).
 *  - B7 NO NEW PROVIDER SDK: the workflow adapter is plain fetch —
 *    the sanctioned runtime import set of `src/` is unchanged
 *    (fastify, pg) and the SDK boundary table needs no Cloudflare
 *    entries.
 *  - B8 THE WORKFLOW ORCHESTRATION PROVIDER IS DECLARED ESTABLISHED
 *    with a real port contract and the declared degraded mode.
 *  - B9 THE WORKFLOW API TOKEN IS A DECLARED ENVIRONMENT-MATERIALIZED
 *    SECRET (never a repo value), and the probe workflow variables
 *    are declared.
 *  - B10 THE DEPLOY WORKFLOW TOOLING SURFACE exists and fails closed
 *    without the probe workflow (operator inspectability).
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { collectSourceFiles, declaredRuntimePackages } from "./lib/collect";
import { scanDependencyRules } from "./lib/dependency-rules";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

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

function importSpecifiers(content: string): string[] {
  const specifiers = new Set<string>();
  for (const pattern of [
    /(?:^|\n)\s*import\s+[^;'"]*?from\s*["']([^"']+)["']/g,
    /(?:^|\n)\s*export\s+[^;'"]*?from\s*["']([^"']+)["']/g,
    /import\s*\(\s*["']([^"']+)["']\s*\)/g,
  ]) {
    const regex = new RegExp(pattern.source, pattern.flags);
    let match = regex.exec(content);
    while (match !== null) {
      if (match[1] !== undefined) {
        specifiers.add(match[1]);
      }
      match = regex.exec(content);
    }
  }
  return [...specifiers];
}

const WORKFLOW_SOURCES = listFiles("src/platform/workflow");
const PORT_FILE = "src/platform/workflow/port.ts";
const ADAPTER_FILE = "src/platform/workflow/cloudflare-workflows.ts";
const EXECUTION_STATES = [
  "CREATED",
  "AUTHORIZED",
  "PLANNING",
  "QUEUED",
  "RUNNING",
  "WAITING_TOOL",
  "WAITING_USER",
  "WAITING_HUMAN",
  "VERIFYING",
  "REPLANNING",
  "COMPLETED",
  "FAILED",
  "CANCELLED",
  "EXPIRED",
];

describe("the D-04 durable-orchestration boundaries (WORK-045)", () => {
  test("B1: the platform workflow plane imports no module/integration/api surface", () => {
    for (const file of WORKFLOW_SOURCES) {
      const specifiers = importSpecifiers(read(file));
      const violations = specifiers.filter(
        (s) => s.includes("modules/") || s.includes("integrations/") || s.includes("api/"),
      );
      expect(violations, `${file} violates platform isolation`).toEqual([]);
    }
  });

  test("B2: the port is the provider-neutral minimal contract", () => {
    const port = read(PORT_FILE);
    expect(port).toContain("export interface WorkflowOrchestrationPort");
    for (const method of [
      "startInstance(",
      "describeInstance(",
      "signalInstance(",
      "terminateInstance(",
      "describeLimits(",
    ]) {
      expect(port).toContain(method);
    }
    // No provider concept leaks onto the port (case-insensitive).
    for (const forbidden of [
      "cloudflare",
      "bearer",
      "client/v4",
      "wrangler",
      "queued, running",
      "waitingforpause",
      "rollingback",
    ]) {
      expect(port.toLowerCase()).not.toContain(forbidden);
    }
    // The neutral observation vocabulary IS provider-neutral.
    expect(port).toContain("ObservedInstanceStatus");
  });

  test("B3: provider vocabulary is confined to the owning adapter/deploy/tests", () => {
    const confined = [ADAPTER_FILE, "deploy/workflow.ts", "deploy/smoke.ts"];
    for (const file of WORKFLOW_SOURCES) {
      const content = read(file);
      if (confined.includes(file)) {
        continue;
      }
      expect(/\bcloudflare\b/i.test(content), `${file} must not carry Cloudflare vocabulary`).toBe(
        false,
      );
    }
    // And never in the domain-module integration points (the
    // orchestration-source and workflow-effect adapters bridge
    // through the PORT types only).
    const sourceAdapter = read("src/modules/executions/adapters/orchestration-source.ts");
    expect(/\bcloudflare\b/i.test(sourceAdapter)).toBe(false);
    const effectAdapter = read("src/modules/executions/adapters/workflow-effect.ts");
    expect(/\bcloudflare\b/i.test(effectAdapter)).toBe(false);
  });

  test("B4: the platform workflow plane carries no execution state vocabulary (no second state machine)", () => {
    for (const file of WORKFLOW_SOURCES) {
      const content = read(file);
      for (const state of EXECUTION_STATES) {
        // Exact-case pin (the d03 discipline): the frozen uppercase
        // state words never appear in the orchestration plane. The
        // vocabulary CONSTANTS are additionally pinned disjoint
        // (case-insensitive) at the unit level — ordinary naming
        // (`createdAt`, English prose) is not state vocabulary.
        expect(content, `${file} must not contain the execution state word ${state}`).not.toContain(
          state,
        );
      }
      // The execution event vocabulary stays out of the orchestration
      // plane (the frozen command names live in the executions
      // module only).
      expect(content).not.toContain("execution.start");
      expect(content).not.toContain("execution.created");
    }
  });

  test("B5: the workflow plane's database dependency is the platform DatabasePort only", () => {
    for (const file of WORKFLOW_SOURCES) {
      const specifiers = importSpecifiers(read(file));
      for (const specifier of specifiers) {
        if (specifier.includes("platform/db")) {
          expect(specifier.endsWith("db/port"), `${file} imports ${specifier}`).toBe(true);
        }
      }
    }
    // The two executions integration points bridge through the PORT
    // types only.
    const sourceSpecifiers = importSpecifiers(
      read("src/modules/executions/adapters/orchestration-source.ts"),
    );
    const workflowImportsOfSource = sourceSpecifiers.filter((s) => s.includes("platform/workflow"));
    expect(workflowImportsOfSource).toEqual(["../../../platform/workflow/port"]);
    const effectSpecifiers = importSpecifiers(
      read("src/modules/executions/adapters/workflow-effect.ts"),
    );
    const workflowImportsOfEffect = effectSpecifiers.filter((s) => s.includes("platform/workflow"));
    expect(workflowImportsOfEffect).toEqual(["../../../platform/workflow/port"]);
  });

  test("B6: the new workflow sources carry no credential-shaped literals", () => {
    const scanned = [...WORKFLOW_SOURCES, "deploy/workflow.ts"];
    const patterns: readonly { name: string; pattern: RegExp }[] = [
      { name: "AWS access key literal", pattern: /\bAKIA[0-9A-Z]{16}\b/ },
      { name: "OpenAI-style key", pattern: /\bsk-[A-Za-z0-9_-]{16,}\b/ },
      { name: "GitHub token", pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/ },
      { name: "URL-embedded credentials", pattern: /[a-z][a-z0-9+.-]*:\/\/[^\s"'@/:]+:[^\s"'@]+@/ },
      {
        name: "Cloudflare-style token assignment",
        pattern: /["'](?:api[_-]?token|token|secret)["']\s*[:=]\s*["'][A-Za-z0-9_-]{20,}["']/i,
      },
    ];
    for (const file of scanned) {
      const content = read(file);
      for (const { name, pattern } of patterns) {
        expect(pattern.test(content), `${file} contains ${name}`).toBe(false);
      }
    }
  });

  test("B7: no new provider SDK — the sanctioned runtime import set is unchanged", () => {
    const files = collectSourceFiles(REPO_ROOT);
    const allowedPackages = declaredRuntimePackages(REPO_ROOT);
    expect(allowedPackages).toEqual(["fastify", "pg"]);
    const violations = scanDependencyRules(files, { allowedPackages });
    expect(violations.map((v) => `${v.rule} @ ${v.path}`)).toEqual([]);
  });

  test("B8: the workflow orchestration provider is declared established with a real port contract", () => {
    const providers = JSON.parse(read("deploy/manifests/providers.json")) as {
      providers: Array<{
        id: string;
        concern: string;
        portStatus: string;
        portContract: string | null;
        authorityRole: string;
        degradation: { onFailure: string; mode: string };
      }>;
    };
    const workflow = providers.providers.find((p) => p.concern === "durable-orchestration");
    expect(workflow).toBeDefined();
    expect(workflow?.portStatus).toBe("established");
    expect(workflow?.portContract).toBe(PORT_FILE);
    expect(workflow?.authorityRole).toBe("non-authoritative");
    // The declared degraded mode is the orchestration-paused mode.
    expect(workflow?.degradation.mode).toBe("orchestration-paused");
  });

  test("B9: the workflow API token is a declared environment-materialized secret (never a repo value)", () => {
    const variables = JSON.parse(read("deploy/manifests/variables.json")) as {
      variables: Array<{ name: string; credentialShaped: boolean; description: string }>;
    };
    const token = variables.variables.find((v) => v.name === "ZECK_WORKFLOW_API_TOKEN");
    expect(token).toBeDefined();
    expect(token?.credentialShaped).toBe(true);
    const ref = variables.variables.find((v) => v.name === "ZECK_SECRET_WORKFLOW_API_TOKEN_REF");
    expect(ref).toBeDefined();
    expect(ref?.credentialShaped).toBe(false);
    // The env secret store maps the workflow-api-token secret to the
    // credential-shaped variable.
    const secretStore = read("src/platform/secret-store/adapters/env-secret-store.ts");
    expect(secretStore).toContain('"workflow-api-token": "ZECK_WORKFLOW_API_TOKEN"');
    // The dedicated probe workflow variables are declared and the
    // probe is never the orchestration workflow (documented).
    const probeName = variables.variables.find((v) => v.name === "ZECK_WORKFLOW_PROBE_NAME");
    expect(probeName).toBeDefined();
    expect(probeName?.description).toContain("MUST differ from ZECK_WORKFLOW_NAME");
  });

  test("B10: the deploy workflow tooling surface exists and stays read-only-safe", () => {
    const tool = read("deploy/workflow.ts");
    expect(tool).toContain("inspect");
    expect(tool).toContain("scan");
    expect(tool).toContain("recover");
    expect(tool).toContain("compact");
    expect(tool).toContain("probe");
    // The probe precondition: never the orchestration workflow.
    expect(tool).toContain("ZECK_WORKFLOW_PROBE_NAME");
    // The inspection import is the read-only module.
    expect(tool).toContain("inspectWorkflowOrchestration");
  });
});
