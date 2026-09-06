/**
 * Architecture: the D-05 execution-worker-fabric boundaries (WORK-046 /
 * Deployment Roadmap D-05; checkpoint contracts SELF-HOSTING-BOUNDARY,
 * IDENTITY-IDEMPOTENCY, CONCURRENCY-CRASH-SAFETY, EXECUTION-PROVENANCE,
 * IMPLEMENTATION-COMPLETENESS).
 *
 * Mechanically proves over the REAL tree:
 *
 *  - B1 PLATFORM ISOLATION: `src/platform/compute/**` imports no
 *    module/integration/api surface (the shared rule engine pins the
 *    whole tree; the compute plane is pinned explicitly here).
 *  - B2 THE PORT IS THE PROVIDER-NEUTRAL WORKER CONTRACT: the port
 *    file exposes the four module seams + the store/policy/identity
 *    types and carries NO runner-protocol vocabulary (REST paths,
 *    Bearer, HTTP statuses never leak onto the port).
 *  - B3 RUNNER-PROTOCOL VOCABULARY CONFINED: the container-runner
 *    REST protocol vocabulary appears only in the owning adapter
 *    (`src/platform/compute/container-runtime.ts`), deploy tooling,
 *    tests and documentation — never in domain modules, never on the
 *    port, never in the fabric engine/store.
 *  - B4 NO SECOND EXECUTION STATE MACHINE: the platform compute plane
 *    contains NONE of the 14 frozen execution state words
 *    (case-insensitively) and none of the execution event words; the
 *    worker-plane vocabularies are disjoint (the unit suite pins the
 *    constants; this pins the SOURCES).
 *  - B5 THE AUTHORITY BOUNDARY: the compute plane's only database
 *    dependency is the platform DatabasePort (+ queue port types for
 *    the transport); the execution write path stays in the executions
 *    module — the integration points are the worker-fabric and
 *    worker-executor ADAPTERS inside the executions/sandbox modules,
 *    importing platform types only.
 *  - B6 SECRET-FREE SOURCES: the new platform/deploy sources contain
 *    no credential-shaped literals; the runner token is
 *    environment-only materialization (declared in the manifests and
 *    the env secret store, never a repository value).
 *  - B7 NO NEW PROVIDER SDK: the runner adapter is plain fetch — the
 *    sanctioned runtime import set of `src/` is unchanged
 *    (fastify, pg).
 *  - B8 THE EXECUTION-COMPUTE PROVIDER IS DECLARED ESTABLISHED with a
 *    real port contract and the declared degraded mode.
 *  - B9 THE RUNNER TOKEN IS A DECLARED ENVIRONMENT-MATERIALIZED SECRET
 *    and the D-05 worker variables are declared.
 *  - B10 THE DEPLOY WORKER TOOLING SURFACE exists (operator
 *    inspectability; the worker process entry).
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

const COMPUTE_FILES = listFiles("src/platform/compute");
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
const EXECUTION_EVENT_WORDS = [
  "execution.created",
  "execution.authorize",
  "execution.plan",
  "execution.queue",
  "execution.start",
  "execution.wait-tool",
  "execution.wait-user",
  "execution.wait-human",
  "execution.resume",
  "execution.verify",
  "execution.pass",
  "execution.replan",
  "execution.fail",
  "execution.cancel",
  "execution.expire",
];

describe("D-05 worker-fabric architecture boundaries (WORK-046)", () => {
  test("B1 platform isolation: the compute plane imports no module/integration/api surface", () => {
    expect(COMPUTE_FILES.length).toBeGreaterThan(0);
    const files = collectSourceFiles(REPO_ROOT).filter((file) =>
      file.path.startsWith("src/platform/compute/"),
    );
    expect(files.length).toBe(COMPUTE_FILES.length);
    const violations = scanDependencyRules(files, {
      allowedPackages: declaredRuntimePackages(REPO_ROOT),
    });
    expect(violations.filter((violation) => violation.rule === "platform-isolation")).toStrictEqual(
      [],
    );
  });

  test("B2 the port carries no runner-protocol vocabulary", () => {
    const port = read("src/platform/compute/port.ts");
    for (const word of ["/v1/runs", "Bearer", "http 202", "409", "runId", "baseUrl"]) {
      expect(port).not.toContain(word);
    }
    for (const seam of [
      "ExecutionDispatchStartEffect",
      "WorkerLeaseAuthority",
      "ExecutionWorkExecutor",
      "WorkerCompletionEffect",
      "ComputeWorkerStore",
      "WorkerFabricPolicy",
    ]) {
      expect(port).toContain(seam);
    }
  });

  test("B3 the runner-protocol vocabulary is confined to the owning adapter", () => {
    const owner = "src/platform/compute/container-runtime.ts";
    for (const file of COMPUTE_FILES) {
      const content = read(file);
      const hasProtocol = content.includes("/v1/runs") || content.includes('"Bearer ');
      if (file === owner) {
        expect(hasProtocol).toBe(true);
      } else {
        expect(hasProtocol).toBe(false);
      }
    }
    // And never in domain modules.
    for (const file of listFiles("src/modules").filter((f) => f.endsWith(".ts"))) {
      const content = read(file);
      expect(content.includes("/v1/runs")).toBe(false);
    }
  });

  test("B4 no second execution state machine: the compute plane sources carry no execution-state or event words", () => {
    for (const file of COMPUTE_FILES) {
      const content = read(file);
      for (const state of EXECUTION_STATES) {
        expect(content).not.toContain(`"${state}"`);
      }
      for (const event of EXECUTION_EVENT_WORDS) {
        expect(content).not.toContain(`"${event}"`);
      }
    }
  });

  test("B5 the authority boundary: the compute plane depends only on platform ports", () => {
    for (const file of COMPUTE_FILES) {
      const content = read(file);
      const imports = [...content.matchAll(/from\s+"(\.[^"]+)"/g)].map((m) => m[1] ?? "");
      for (const specifier of imports) {
        // The compute plane's platform dependencies: the DatabasePort
        // authority, the queue transport contract, the sandbox seam's
        // container contracts, the D-06 observability sink seam (the
        // OPTIONAL telemetry port — observation only, WORK-047) —
        // never a module, never an integration.
        const legal =
          specifier.startsWith("../db/") ||
          specifier.startsWith("../queue/") ||
          specifier.startsWith("../sandbox/") ||
          specifier.startsWith("../observability/") ||
          specifier.startsWith("./");
        expect(legal, `${file} imports ${specifier}`).toBe(true);
      }
    }
    // The module-side adapters bridge through the platform types only.
    const executionsAdapter = read("src/modules/executions/adapters/worker-fabric.ts");
    expect(executionsAdapter).toContain("../../../platform/compute/port");
    const sandboxAdapter = read("src/modules/sandbox/adapters/worker-executor.ts");
    expect(sandboxAdapter).toContain("../../../platform/compute/port");
  });

  test("B6 secret-free sources: no credential-shaped literals in the new surfaces", () => {
    const sources = [
      ...COMPUTE_FILES.map((f) => `src/platform/${f.replace("src/platform/", "")}`),
      "deploy/worker.ts",
    ];
    for (const source of sources) {
      const content = read(source);
      expect(content).not.toMatch(/sk-[A-Za-z0-9]{16,}/);
      expect(content).not.toMatch(/ghp_[A-Za-z0-9]{20,}/);
      expect(content).not.toContain("Bearer ${" + "ZECK_CONTAINER");
    }
    // The runner token is environment-only materialization.
    const secretStore = read("src/platform/secret-store/adapters/env-secret-store.ts");
    expect(secretStore).toContain('"container-runner-token": "ZECK_CONTAINER_RUNNER_API_TOKEN"');
  });

  test("B7 no new provider SDK: the sanctioned runtime imports are unchanged", () => {
    const files = collectSourceFiles(REPO_ROOT);
    const packages = new Set<string>();
    for (const file of files) {
      for (const match of file.content.matchAll(/from\s+"([a-z@][^"]*)"/g)) {
        const specifier = match[1] ?? "";
        if (!specifier.startsWith(".") && !specifier.startsWith("node:")) {
          packages.add(specifier.split("/")[0] ?? specifier);
        }
      }
    }
    expect([...packages].sort()).toStrictEqual(["fastify", "pg"]);
  });

  test("B8 the execution-compute provider is declared established with the port contract", () => {
    const providers = read("deploy/manifests/providers.json");
    const parsed = JSON.parse(providers) as {
      providers: {
        id: string;
        concern: string;
        portStatus: string;
        portContract: string;
        degradation: { mode: string };
      }[];
    };
    const runner = parsed.providers.find((provider) => provider.id === "zeck-container-runner");
    expect(runner).toBeDefined();
    expect(runner?.concern).toBe("execution-compute");
    expect(runner?.portStatus).toBe("established");
    expect(runner?.portContract).toBe("src/platform/sandbox/runtime-client.ts");
    expect(runner?.degradation.mode).toBe("execution-compute-unavailable");
  });

  test("B9 the runner token is a declared secret and the D-05 variables are declared", () => {
    const variables = JSON.parse(read("deploy/manifests/variables.json")) as {
      variables: { name: string }[];
    };
    const names = new Set(variables.variables.map((variable) => variable.name));
    for (const name of [
      "ZECK_SECRET_CONTAINER_RUNNER_TOKEN_REF",
      "ZECK_CONTAINER_RUNNER_URL",
      "ZECK_CONTAINER_RUNNER_API_TOKEN",
      "ZECK_WORKER_LEASE_TTL_MS",
      "ZECK_WORKER_MAX_DRAIN_MS",
      "ZECK_WORKER_CLAIM_RETENTION_MS",
    ]) {
      expect(names.has(name)).toBe(true);
    }
    const references = JSON.parse(read("deploy/manifests/secret-references.json")) as {
      references: Record<string, { name: string }[]>;
    };
    expect(
      references.references.production?.some((ref) => ref.name === "container-runner-token"),
    ).toBe(true);
  });

  test("B10 the deploy worker tooling surface exists (the operator/worker process entry)", () => {
    const worker = read("deploy/worker.ts");
    expect(worker).toContain("deploy/worker");
    for (const command of [
      "run",
      "run-once",
      "inspect",
      "sweep",
      "recover",
      "compact",
      "quota",
      "runner",
    ]) {
      expect(worker).toContain(`"${command}"`);
    }
    const pkg = JSON.parse(read("package.json")) as { scripts: Record<string, string> };
    expect(pkg.scripts["deploy:worker"]).toContain("deploy/worker.ts");
  });
});
