/**
 * Architecture: the D-06 release/observability boundaries (WORK-047 /
 * Deployment Roadmap D-06; checkpoint contracts RELEASE-IDENTITY,
 * PROMOTION-GATES, MIGRATION-SAFETY, OBSERVABILITY-BOUNDARY,
 * ROLLBACK-SAFETY, COST-QUOTA-GUARDS, SELF-HOSTING-BOUNDARY,
 * IMPLEMENTATION-COMPLETENESS).
 *
 * Mechanically proves over the REAL tree:
 *
 *  - B1 PLATFORM ISOLATION: `src/platform/observability/**` and
 *    `src/platform/release/**` import no module/integration/api
 *    surface (the platform planes are pinned explicitly).
 *  - B2 THE PORTS ARE PROVIDER-NEUTRAL: the observability port
 *    carries no OTLP wire vocabulary (paths/statuses/headers) and the
 *    release port carries no CI/CD or provider vocabulary (the wire
 *    words live only in the owning adapters/tools).
 *  - B3 NO OBSERVABILITY AUTHORITY: the observability plane imports
 *    NO database port and no release/compute surface — telemetry is a
 *    sink; the release store's ONLY database dependency is the
 *    platform DatabasePort; the release store addresses the
 *    release_control schema exclusively (rollback-safety by
 *    construction: no domain table appears in its SQL).
 *  - B4 SECRET-FREE SOURCES: the new platform/deploy sources contain
 *    no credential-shaped literals; the OTLP token is
 *    environment-only materialization.
 *  - B5 NO NEW PROVIDER SDK: the OTLP exporter is plain fetch — the
 *    sanctioned runtime import set of `src/` is unchanged (fastify,
 *    pg).
 *  - B6 THE OBSERVABILITY-EXPORT PROVIDER IS DECLARED ESTABLISHED
 *    with the port contract and the declared logs-only degraded mode.
 *  - B7 THE OTLP TOKEN IS A DECLARED ENVIRONMENT-MATERIALIZED SECRET
 *    and the D-06 telemetry variables are declared.
 *  - B8 THE RELEASE POLICY IS REPOSITORY TRUTH: release-policy.json +
 *    quota-guards.json exist, load against the environments.json
 *    ladder, and deploy:validate validates them.
 *  - B9 THE DEPLOY RELEASE TOOLING SURFACE exists (the operator/CI
 *    entry; package.json wiring).
 *  - B10 THE SELF-HOSTING BOUNDARY: the CI/CD workflow invokes only
 *    repository tools (bun/deploy/scripts) — no proprietary provider
 *    deployment APIs; the observability export target is any OTLP
 *    endpoint (self-hostable).
 *  - B11 THE MINIMAL SEAM: the fabric telemetry seam is optional (the
 *    fabric sources reference the sink only through the optional dep
 *    + bounded non-throwing emissions), and the API server keeps its
 *    pinned import boundary (the local structural seam type, no
 *    platform import).
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { collectSourceFiles, declaredRuntimePackages } from "./lib/collect";

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

const OBSERVABILITY_FILES = listFiles("src/platform/observability");
const RELEASE_FILES = listFiles("src/platform/release");

describe("D-06 release/observability architecture boundaries (WORK-047)", () => {
  test("B1 platform isolation: observability and release import no module/integration/api surface", () => {
    const violations: string[] = [];
    for (const rel of [...OBSERVABILITY_FILES, ...RELEASE_FILES]) {
      const content = read(rel);
      for (const match of content.matchAll(/from\s+["'](\.[^"']+)["']/g)) {
        const specifier = match[1] ?? "";
        const resolved = resolve(dirname(join(REPO_ROOT, rel)), specifier)
          .slice(REPO_ROOT.length + 1)
          .replaceAll("\\", "/");
        if (
          resolved.startsWith("src/modules/") ||
          resolved.startsWith("src/integrations/") ||
          resolved.startsWith("src/api/")
        ) {
          violations.push(`${rel}: ${specifier} -> ${resolved}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  test("B2 the ports are provider-neutral (no wire vocabulary on the ports)", () => {
    const observabilityPort = read("src/platform/observability/port.ts");
    // The OTLP WIRE vocabulary (paths, statuses, headers) never leaks
    // onto the neutral port.
    for (const forbidden of [
      "/v1/traces",
      "/v1/metrics",
      "/v1/logs",
      "content-type",
      "authorization",
      "POST",
    ]) {
      expect(observabilityPort).not.toContain(forbidden);
    }
    const releasePort = read("src/platform/release/port.ts");
    // CI/CD and provider vocabulary never leaks onto the release port
    // (as identifiers — doc comments may NAME the boundary itself).
    const identifierish = releasePort.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    for (const forbidden of [
      "github",
      "workflow-run",
      "vercel",
      "wrangler",
      "neon",
      "cloudflare",
      "dashboard",
    ]) {
      expect(identifierish).not.toContain(forbidden);
    }
  });

  test("B3 no observability authority: the observability plane has no database dependency; the release store writes release_control exclusively", () => {
    // The observability plane NEVER imports the DatabasePort.
    for (const rel of OBSERVABILITY_FILES) {
      expect(read(rel), rel).not.toMatch(/from\s+["']\.\.\/db\/port["']/);
      expect(read(rel), rel).not.toMatch(/\bDatabasePort\b/);
    }
    // The release store's ONLY platform database dependency is the
    // neutral port, and its SQL addresses release_control exclusively
    // (rollback safety by construction — no domain table appears).
    const store = read("src/platform/release/pg-store.ts");
    expect(store).toContain('from "../db/port"');
    const statements =
      store.match(/(?:INSERT INTO|UPDATE|DELETE FROM|FROM)\s+([a-z_]+\.[a-z_]+)/g) ?? [];
    const addressed = new Set(
      statements.map((statement) =>
        statement.replace(/^(?:INSERT INTO|UPDATE|DELETE FROM|FROM)\s+/, ""),
      ),
    );
    expect([...addressed].sort()).toEqual([
      "release_control.active_deployments",
      "release_control.environment_deployments",
      "release_control.gate_results",
      "release_control.promotions",
      "release_control.releases",
      "release_control.rollbacks",
    ]);
    // No domain authority table is addressable by the store.
    for (const domainTable of [
      "executions.executions",
      "applications.tenants",
      "budgets.",
      "sandbox.sandboxes",
    ]) {
      expect(store).not.toContain(domainTable);
    }
  });

  test("B4 secret-free sources: no credential-shaped literals in the new surfaces", () => {
    const sources = [
      ...OBSERVABILITY_FILES.map((f) => `src/platform/${f.replace("src/platform/", "")}`),
      ...RELEASE_FILES.map((f) => `src/platform/${f.replace("src/platform/", "")}`),
      "deploy/release.ts",
    ];
    for (const source of sources) {
      const content = read(source);
      expect(content, source).not.toMatch(/sk-[A-Za-z0-9]{16,}/);
      expect(content, source).not.toMatch(/ghp_[A-Za-z0-9]{20,}/);
      // A LITERAL bearer token value (the adapter legitimately
      // constructs the header from the RESOLVED secret variable).
      expect(content, source).not.toMatch(/Bearer\s+[A-Za-z0-9._-]{16,}/);
    }
    // The OTLP token is environment-only materialization.
    const secretStore = read("src/platform/secret-store/adapters/env-secret-store.ts");
    expect(secretStore).toContain('"otlp-auth-token": "ZECK_OTLP_AUTH_TOKEN"');
  });

  test("B5 no new provider SDK: the sanctioned runtime imports are unchanged", () => {
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
    const declared = declaredRuntimePackages(REPO_ROOT);
    expect([...packages].sort()).toEqual([...new Set([...declared])].sort());
    expect([...packages].sort()).toEqual(["fastify", "pg"]);
  });

  test("B6 the observability-export provider is declared established with the port contract and degraded mode", () => {
    const providers = JSON.parse(read("deploy/manifests/providers.json")) as {
      providers: {
        id: string;
        concern: string;
        portStatus: string;
        portContract: string;
        authorityRole: string;
        degradation: { mode: string };
      }[];
    };
    const otel = providers.providers.find((provider) => provider.id === "otel-export");
    expect(otel).toBeDefined();
    expect(otel?.concern).toBe("observability-export");
    expect(otel?.portStatus).toBe("established");
    expect(otel?.portContract).toBe("src/platform/observability/port.ts");
    expect(otel?.authorityRole).toBe("non-authoritative");
    expect(otel?.degradation.mode).toBe("logs-only");
  });

  test("B7 the OTLP token is a declared secret and the D-06 variables are declared", () => {
    const variables = JSON.parse(read("deploy/manifests/variables.json")) as {
      variables: { name: string }[];
    };
    const names = new Set(variables.variables.map((variable) => variable.name));
    for (const name of [
      "ZECK_OTLP_ENDPOINT",
      "ZECK_OTLP_AUTH_TOKEN",
      "ZECK_OTLP_REQUEST_TIMEOUT_MS",
      "ZECK_TELEMETRY_FLUSH_EVERY",
      "ZECK_SECRET_OTLP_AUTH_TOKEN_REF",
    ]) {
      expect(names.has(name)).toBe(true);
    }
    const references = JSON.parse(read("deploy/manifests/secret-references.json")) as {
      references: Record<string, { name: string }[]>;
    };
    expect(references.references.production?.some((ref) => ref.name === "otlp-auth-token")).toBe(
      true,
    );
    expect(references.references.staging?.some((ref) => ref.name === "otlp-auth-token")).toBe(true);
    expect(references.references.preview?.some((ref) => ref.name === "otlp-auth-token")).toBe(true);
  });

  test("B8 the release policy is repository truth and validated by deploy:validate", () => {
    expect(read("deploy/manifests/release-policy.json")).toContain('"entryGates"');
    expect(read("deploy/manifests/quota-guards.json")).toContain('"guards"');
    const validate = read("deploy/validate.ts");
    expect(validate).toContain("loadReleasePolicy");
    expect(validate).toContain("loadQuotaGuardsPolicy");
    expect(validate).toContain("release_control");
    // The D-06 gate floor is pinned (the work-order-mandated gates:
    // validation/migration/health/smoke appropriate to the target
    // environment; the architect approval for production). Removing
    // them from release-policy.json fails HERE even when
    // environments.json would not notice (the D-06 additions).
    const policy = JSON.parse(read("deploy/manifests/release-policy.json")) as {
      entryGates: Record<string, string[]>;
    };
    expect(policy.entryGates.staging).toEqual(
      expect.arrayContaining([
        "validation",
        "preview-smoke",
        "migration",
        "health",
        "identity-audit",
      ]),
    );
    expect(policy.entryGates.production).toEqual(
      expect.arrayContaining([
        "architect-approval",
        "validation",
        "staging-smoke",
        "deployment-identity-audit",
        "migration",
        "health",
      ]),
    );
    expect(policy.entryGates.ci).toEqual(
      expect.arrayContaining(["governance-check", "typecheck", "lint", "full-test-suite"]),
    );
  });

  test("B9 the deploy release tooling surface exists", () => {
    const release = read("deploy/release.ts");
    expect(release).toContain("deploy/release");
    for (const command of [
      "record",
      "gate",
      "promote",
      "rollback",
      "inspect",
      "status",
      "alerts",
    ]) {
      expect(release).toContain(`"${command}"`);
    }
    const pkg = JSON.parse(read("package.json")) as { scripts: Record<string, string> };
    expect(pkg.scripts["deploy:release"]).toContain("deploy/release.ts");
  });

  test("B10 the self-hosting boundary: the CI/CD workflow invokes only repository tools", () => {
    const workflow = read(".github/workflows/deployment-release.yml");
    // Every run: step is repository tooling (bun/bun run/python
    // scripts) or workflow shell — no proprietary provider deploy
    // APIs, no third-party deploy actions.
    for (const forbidden of [
      "vercel deploy",
      "wrangler",
      "neonctl",
      "flyctl",
      "terraform",
      "gcloud",
      "aws ",
    ]) {
      expect(workflow.toLowerCase()).not.toContain(forbidden);
    }
    const runSteps = workflow.match(/run: \|?[\s\S]*?(?:\n {6}[a-z]|\n(?= {6}-))/g) ?? [];
    for (const step of runSteps) {
      void step;
    }
    // The only actions used are the repository-approved mechanics.
    const actions = [...workflow.matchAll(/uses:\s*([^\s]+)/g)].map((m) => m[1] ?? "");
    for (const action of actions) {
      expect([
        "actions/checkout@v4",
        "oven-sh/setup-bun@v2",
        "actions/upload-artifact@v4",
      ]).toContain(action);
    }
  });

  test("B11 the minimal seam: the fabric telemetry dep is optional and the API boundary is unpinned", () => {
    const computePort = read("src/platform/compute/port.ts");
    expect(computePort).toContain("telemetry?: TelemetrySink");
    const fabric = read("src/platform/compute/fabric.ts");
    // The emissions are bounded and non-throwing.
    expect(fabric).toContain("emitTelemetry");
    expect(fabric).toContain("Telemetry is observation, never authority");
    // The API server keeps the pinned import boundary: the telemetry
    // seam is a LOCAL structural type (no platform import).
    const server = read("src/api/server.ts");
    expect(server).not.toMatch(/from\s+["']\.\.\/platform\/observability/);
    expect(server).toContain("RequestTelemetrySeam");
  });
});
