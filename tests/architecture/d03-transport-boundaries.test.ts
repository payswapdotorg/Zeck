/**
 * Architecture: the D-03 transport boundaries (WORK-044 /
 * Deployment Roadmap D-03; checkpoint contracts SELF-HOSTING-BOUNDARY,
 * IDENTITY-IDEMPOTENCY, CONCURRENCY-CRASH-SAFETY, EXECUTION-PROVENANCE,
 * IMPLEMENTATION-COMPLETENESS).
 *
 * Mechanically proves over the REAL tree:
 *
 *  - B1 PLATFORM ISOLATION: `src/platform/queue/**` imports no
 *    module/integration/api surface (the shared rule engine pins the
 *    whole tree; the queue plane is pinned explicitly here).
 *  - B2 THE PORT IS THE FROZEN MINIMAL PROVIDER-NEUTRAL CONTRACT: the
 *    port file exposes publish/pull/settle + the bounded policy and
 *    correlation types, and carries NO provider vocabulary
 *    (cloudflare/bearer/REST paths never leak onto the port).
 *  - B3 PROVIDER VOCABULARY CONFINED: Cloudflare vocabulary appears
 *    only in the owning adapter (`src/platform/queue/cloudflare-queues.ts`),
 *    deploy tooling and tests — never in domain modules, never on the
 *    port, never in the correlation/dispatcher/consumer machinery.
 *  - B4 NO SECOND EXECUTION STATE MACHINE: the platform queue plane
 *    contains NONE of the 14 frozen execution state words and none of
 *    the execution event words; the transport vocabulary is disjoint
 *    (the unit suite pins the constants; this pins the SOURCES).
 *  - B5 THE AUTHORITY BOUNDARY: the queue plane's only database
 *    dependency is the platform DatabasePort — the execution write
 *    path stays in the executions module (the single integration
 *    point is the transport-effect ADAPTER inside the executions
 *    module, importing platform types only, following the
 *    module-adapter-bridges-to-platform pattern).
 *  - B6 SECRET-FREE SOURCES: the new platform/deploy sources contain
 *    no credential-shaped literals; the queue API token is
 *    environment-only materialization (declared in the manifests and
 *    the env secret store, never a repository value).
 *  - B7 NO NEW PROVIDER SDK: the queue adapter is plain fetch — the
 *    sanctioned runtime import set of `src/` is unchanged (fastify,
 *    pg) and the SDK boundary table needs no Cloudflare entries.
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

const QUEUE_SOURCES = listFiles("src/platform/queue");
const PORT_FILE = "src/platform/queue/port.ts";
const ADAPTER_FILE = "src/platform/queue/cloudflare-queues.ts";
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

describe("the D-03 transport boundaries (WORK-044)", () => {
  test("B1: the platform queue plane imports no module/integration/api surface", () => {
    for (const file of QUEUE_SOURCES) {
      const specifiers = importSpecifiers(read(file));
      const violations = specifiers.filter(
        (s) => s.includes("modules/") || s.includes("integrations/") || s.includes("api/"),
      );
      expect(violations, `${file} violates platform isolation`).toEqual([]);
    }
  });

  test("B2: the port is the provider-neutral minimal contract", () => {
    const port = read(PORT_FILE);
    expect(port).toContain("export interface QueueTransportPort");
    for (const method of ["publish(", "pull(", "settle("]) {
      expect(port).toContain(method);
    }
    // No provider concept leaks onto the port (case-insensitive).
    for (const forbidden of ["cloudflare", "bearer", "client/v4", "lease_ttl", "wrangler"]) {
      expect(port.toLowerCase()).not.toContain(forbidden);
    }
    // Lease ids ARE provider-neutral queue vocabulary (opaque handles).
    expect(port).toContain("leaseId");
  });

  test("B3: provider vocabulary is confined to the owning adapter/deploy/tests", () => {
    const confined = [ADAPTER_FILE, "deploy/queue.ts", "deploy/smoke.ts"];
    for (const file of QUEUE_SOURCES) {
      const content = read(file);
      if (confined.includes(file)) {
        continue;
      }
      expect(/\bcloudflare\b/i.test(content), `${file} must not carry Cloudflare vocabulary`).toBe(
        false,
      );
    }
    // And never in domain modules (the d02 suite pins the domain side;
    // here the new executions integration point is pinned explicitly).
    const effectAdapter = read("src/modules/executions/adapters/transport-effect.ts");
    expect(/\bcloudflare\b/i.test(effectAdapter)).toBe(false);
  });

  test("B4: the platform queue plane carries no execution state vocabulary (no second state machine)", () => {
    for (const file of QUEUE_SOURCES) {
      const content = read(file);
      for (const state of EXECUTION_STATES) {
        expect(content, `${file} must not contain the execution state word ${state}`).not.toContain(
          state,
        );
      }
      // The execution event vocabulary stays out of the transport plane.
      expect(content).not.toContain("execution.start");
      expect(content).not.toContain("execution.created");
    }
  });

  test("B5: the queue plane's database dependency is the platform DatabasePort only", () => {
    for (const file of QUEUE_SOURCES) {
      const specifiers = importSpecifiers(read(file));
      for (const specifier of specifiers) {
        if (specifier.includes("platform/db")) {
          // Only the provider-neutral port may be imported.
          expect(specifier.endsWith("db/port"), `${file} imports ${specifier}`).toBe(true);
        }
      }
    }
    // The single executions integration point is the transport-effect
    // adapter, and it bridges through the PORT types only.
    const effectSpecifiers = importSpecifiers(
      read("src/modules/executions/adapters/transport-effect.ts"),
    );
    const queueImports = effectSpecifiers.filter((s) => s.includes("platform/queue"));
    expect(queueImports).toEqual(["../../../platform/queue/port"]);
  });

  test("B6: the new queue sources carry no credential-shaped literals", () => {
    const scanned = [...QUEUE_SOURCES, "deploy/queue.ts"];
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

  test("B8: the queue transport provider is declared established with a real port contract", () => {
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
    const queue = providers.providers.find((p) => p.concern === "async-transport");
    expect(queue).toBeDefined();
    expect(queue?.portStatus).toBe("established");
    expect(queue?.portContract).toBe(PORT_FILE);
    expect(queue?.authorityRole).toBe("non-authoritative");
    // The declared degraded mode is the dispatch-backlog mode.
    expect(queue?.degradation.mode).toBe("dispatch-backlogged");
  });

  test("B9: the queue API token is a declared environment-materialized secret (never a repo value)", () => {
    const variables = JSON.parse(read("deploy/manifests/variables.json")) as {
      variables: Array<{ name: string; credentialShaped: boolean; description: string }>;
    };
    const token = variables.variables.find((v) => v.name === "ZECK_QUEUE_API_TOKEN");
    expect(token).toBeDefined();
    expect(token?.credentialShaped).toBe(true);
    const ref = variables.variables.find((v) => v.name === "ZECK_SECRET_QUEUE_API_TOKEN_REF");
    expect(ref).toBeDefined();
    expect(ref?.credentialShaped).toBe(false);
    // The env secret store maps the queue-api-token secret to the
    // credential-shaped variable.
    const secretStore = read("src/platform/secret-store/adapters/env-secret-store.ts");
    expect(secretStore).toContain('"queue-api-token": "ZECK_QUEUE_API_TOKEN"');
  });
});
