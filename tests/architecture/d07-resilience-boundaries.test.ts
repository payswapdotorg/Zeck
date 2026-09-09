/**
 * Architecture: the D-07 resilience/recovery boundaries (WORK-048 /
 * Deployment Roadmap D-07; checkpoint contracts AUTH-PRESERVATION,
 * IDENTITY-IDEMPOTENCY, CONCURRENCY-CRASH-SAFETY,
 * EXTERNAL-SIDE-EFFECTS, EXECUTION-PROVENANCE,
 * SELF-HOSTING-BOUNDARY, IMPLEMENTATION-COMPLETENESS).
 *
 * Mechanically proves over the REAL tree:
 *
 *  - B1 PLATFORM ISOLATION: `src/platform/recovery/**` imports no
 *    module/integration/api surface (the recovery plane is pinned
 *    platform).
 *  - B2 PROVIDER NEUTRALITY: the recovery plane carries no vendor
 *    vocabulary of its own — no vendor SDKs, no vendor names in its
 *    contracts (substitution is configuration at the OWNING
 *    adapters; the plane speaks ports only).
 *  - B3 THE AUTHORITY BOUNDARY: the recovery plane depends only on
 *    platform ports (db/object-store/queue/compute types); it never
 *    imports a domain module, and the ONLY module-side new surface is
 *    the declared minimal seam (evacuation-seam) that implements the
 *    platform seam type inside the executions module's own adapter
 *    layer.
 *  - B4 NO SECOND STATE MACHINE: the recovery plane contains no
 *    execution-state literals and no execution-event vocabulary —
 *    classification vocabularies are injected or read-only queries
 *    over the owning schemas.
 *  - B5 NO AUTHORITY MOVE: the recovery plane performs NO domain
 *    writes — its SQL is read-only classification over the durable
 *    tables (the evacuation controller writes through the OWNING
 *    platform store ports, never raw domain SQL).
 *  - B6 SECRET-FREE SOURCES: the new platform/deploy sources carry no
 *    credential-shaped literals; drill credentials are
 *    environment-only materialization.
 *  - B7 NO NEW PROVIDER SDK: the recovery plane imports only
 *    repository-relative modules (the sanctioned import set is
 *    unchanged).
 *  - B8 REPOSITORY TRUTH: recovery-targets.json exists, loads
 *    fail-closed, and covers EVERY environment of the environments
 *    matrix; deploy:validate enforces the D-07 rule.
 *  - B9 THE DEPLOY DRILL TOOLING SURFACE exists (the operator CLI,
 *    the five commands, the package wiring, and the honest NOT RUN
 *    vocabulary).
 *  - B10 ENVIRONMENT-ISOLATED RECOVERY CREDENTIALS: the drill
 *    variables are declared in the manifest with the correct
 *    credentialShaped flags (keys marked; endpoints/buckets/regions
 *    not) and no credential values are committed.
 *  - B11 THE SELF-HOSTING RUNBOOKS exist for every drill scenario
 *    (repeatable by a self-hosted operator).
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { parseRecoveryTargets, recoveryTargetFor } from "../../src/platform/recovery/rto-rpo";
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

const RECOVERY_FILES = listFiles("src/platform/recovery");

/** The vendor vocabulary the recovery plane must never carry. */
const VENDOR_WORDS = [
  "cloudflare",
  "vercel",
  "neon",
  "aws-sdk",
  "@aws-sdk",
  "aws4",
  "sigv4",
  "presign",
  "docker",
  "dockerode",
  "fly-io",
  "render.com",
];

describe("D-07 resilience/recovery architecture boundaries (WORK-048)", () => {
  test("B1 platform isolation: the recovery plane imports no module/integration/api surface", () => {
    expect(RECOVERY_FILES.length).toBeGreaterThanOrEqual(7);
    const files = collectSourceFiles(REPO_ROOT).filter((file) =>
      file.path.startsWith("src/platform/recovery/"),
    );
    expect(files.length).toBe(RECOVERY_FILES.length);
    const violations = scanDependencyRules(files, {
      allowedPackages: declaredRuntimePackages(REPO_ROOT),
    });
    expect(violations.filter((violation) => violation.rule === "platform-isolation")).toStrictEqual(
      [],
    );
  });

  test("B2 provider neutrality: no vendor SDK and no vendor vocabulary in the recovery plane", () => {
    for (const file of RECOVERY_FILES) {
      const content = read(file);
      // No vendor SDK imports and no vendor package specifiers.
      for (const word of VENDOR_WORDS) {
        expect(content, `${file} must not carry "${word}"`).not.toContain(`"${word}`);
        expect(content, `${file} must not import "${word}"`).not.toMatch(
          new RegExp(`from\\s+["'][^"']*${word}`),
        );
      }
    }
    // The S3-compatible object-store adapter (the OWNING adapter, not
    // the recovery plane) is where provider endpoints enter — the
    // recovery plane speaks ObjectStorePort only.
    for (const file of RECOVERY_FILES) {
      expect(read(file)).not.toContain("createS3ObjectStore");
    }
  });

  test("B3 the authority boundary: the recovery plane depends only on platform ports; the module seam is exactly one declared file", () => {
    for (const file of RECOVERY_FILES) {
      const content = read(file);
      const imports = [...content.matchAll(/from\s+"(\.[^"]+)"/g)].map((m) => m[1] ?? "");
      for (const specifier of imports) {
        const legal =
          specifier.startsWith("../db/") ||
          specifier.startsWith("../object-store/") ||
          specifier.startsWith("../queue/") ||
          specifier.startsWith("../compute/") ||
          specifier.startsWith("../observability/") ||
          specifier.startsWith("./");
        expect(legal, `${file} imports ${specifier}`).toBe(true);
      }
    }
    // The module-side surface: exactly ONE new executions adapter
    // implementing the platform seam type; no other module file
    // references the recovery plane.
    const seam = read("src/modules/executions/adapters/evacuation-seam.ts");
    expect(seam).toContain("../../../platform/recovery/evacuation");
    for (const file of listFiles("src/modules")) {
      const content = read(file);
      if (file === "src/modules/executions/adapters/evacuation-seam.ts") {
        continue;
      }
      expect(content, `${file} must not reference the recovery plane`).not.toContain(
        "platform/recovery/",
      );
    }
  });

  test("B4 no second state machine: the recovery plane carries no execution-state or event vocabulary", () => {
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
    for (const file of RECOVERY_FILES) {
      const content = read(file);
      for (const state of EXECUTION_STATES) {
        expect(content, `${file} must not carry the execution state "${state}"`).not.toContain(
          `"${state}"`,
        );
      }
      // The frozen vocabulary is INJECTED by the composition root
      // (authority-verification), never hard-coded in the platform.
      if (file === "src/platform/recovery/authority-verification.ts") {
        expect(content).toContain("executionStatusVocabulary");
      }
    }
  });

  test("B5 no authority move: the recovery plane's own SQL is read-only classification", () => {
    const WRITE_PATTERNS = [
      /INSERT\s+INTO/i,
      /UPDATE\s+[a-z]/i,
      /DELETE\s+FROM/i,
      /ALTER\s+TABLE/i,
    ];
    for (const file of RECOVERY_FILES) {
      const content = read(file);
      const sqlBlocks = [...content.matchAll(/sql:\s*`([^`]+)`/gs)].map((m) => m[1] ?? "");
      for (const sql of sqlBlocks) {
        for (const pattern of WRITE_PATTERNS) {
          expect(pattern.test(sql), `${file} carries write SQL: ${sql.slice(0, 80)}`).toBe(false);
        }
      }
    }
    // The evacuation controller writes ONLY through the owning
    // platform store ports (ComputeWorkerStore + the lease seam).
    const evacuation = read("src/platform/recovery/evacuation.ts");
    expect(evacuation).toContain("store.abandonClaim");
    expect(evacuation).toContain("lease.forceRelease");
    expect(evacuation).not.toMatch(/sql:\s*["`]/);
  });

  test("B6 secret-free sources: no credential-shaped literals in the D-07 surfaces", () => {
    const surfaces = [
      ...RECOVERY_FILES,
      "src/modules/executions/adapters/evacuation-seam.ts",
      "deploy/drill.ts",
    ];
    for (const file of surfaces) {
      const content = read(file);
      expect(content, `${file} must not carry access-key literals`).not.toMatch(/AKIA[0-9A-Z]{16}/);
      expect(content, `${file} must not carry secret assignments`).not.toMatch(
        /(secretAccessKey|apiToken|password)\s*[:=]\s*"[^"${}]+"/,
      );
    }
  });

  test("B7 no new provider SDK: the recovery plane imports only repository-relative modules", () => {
    for (const file of RECOVERY_FILES) {
      const content = read(file);
      const externalImports = [...content.matchAll(/from\s+"([^."][^"]*)"/g)].map(
        (m) => m[1] ?? "",
      );
      // Only node builtins are external in the recovery plane.
      for (const specifier of externalImports) {
        expect(specifier.startsWith("node:")).toBe(true);
      }
    }
  });

  test("B8 repository truth: recovery-targets.json covers every environment of the matrix and validate enforces it", () => {
    const targets = parseRecoveryTargets(read("deploy/manifests/recovery-targets.json"));
    const manifest = JSON.parse(read("deploy/manifests/environments.json")) as {
      environments: Record<string, unknown>;
    };
    for (const environment of Object.keys(manifest.environments)) {
      expect(() => recoveryTargetFor(targets, environment), environment).not.toThrow();
    }
    // deploy:validate owns the D-07 rule (rule 9).
    const validate = read("deploy/validate.ts");
    expect(validate).toContain("parseRecoveryTargets");
    expect(validate).toContain("recovery-targets.json");
  });

  test("B9 the deploy drill tooling surface exists with the honest NOT RUN vocabulary", () => {
    const packageJson = read("package.json");
    expect(packageJson).toContain('"deploy:drill": "bun deploy/drill.ts"');
    const drill = read("deploy/drill.ts");
    for (const command of [
      "authority-loss",
      "artifact-exit",
      "queue-recovery",
      "worker-evacuation",
      "outage-readiness",
    ]) {
      expect(drill).toContain(`"${command}"`);
    }
    // The honesty vocabulary: NOT RUN is a first-class outcome.
    expect(drill).toContain("NOT RUN");
    expect(drill).toContain("notRun");
  });

  test("B10 environment-isolated recovery credentials: drill variables declared with correct credential flags", () => {
    const variables = JSON.parse(read("deploy/manifests/variables.json")) as {
      variables: readonly {
        name: string;
        credentialShaped: boolean;
        required: boolean;
      }[];
    };
    const find = (name: string) => variables.variables.find((v) => v.name === name);
    const credentialShaped = [
      "ZECK_DRILL_ALTERNATE_OBJECT_STORE_ACCESS_KEY_ID",
      "ZECK_DRILL_ALTERNATE_OBJECT_STORE_SECRET_ACCESS_KEY",
    ];
    const plain = [
      "ZECK_DRILL_ALTERNATE_OBJECT_STORE_ENDPOINT",
      "ZECK_DRILL_ALTERNATE_OBJECT_STORE_BUCKET",
      "ZECK_DRILL_ALTERNATE_OBJECT_STORE_REGION",
    ];
    for (const name of credentialShaped) {
      const variable = find(name);
      expect(variable, `${name} must be declared`).toBeDefined();
      expect(variable?.credentialShaped, `${name} must be credentialShaped`).toBe(true);
      expect(variable?.required).toBe(false); // drills stay optional (honest NOT RUN)
    }
    for (const name of plain) {
      const variable = find(name);
      expect(variable, `${name} must be declared`).toBeDefined();
      expect(variable?.credentialShaped, `${name} must not be credentialShaped`).toBe(false);
    }
    // No credential VALUES are committed anywhere in the manifests.
    for (const manifestName of readdirSync(join(REPO_ROOT, "deploy/manifests"))) {
      const content = read(`deploy/manifests/${manifestName}`);
      expect(content).not.toMatch(/AKIA[0-9A-Z]{16}/);
    }
  });

  test("B11 the self-hosting runbooks exist for every drill scenario", () => {
    expect(read("docs/runbooks/README.md")).toContain("D-07 operator runbooks");
    for (const runbook of [
      "d07-authority-loss.md",
      "d07-artifact-exit.md",
      "d07-queue-recovery.md",
      "d07-worker-evacuation.md",
      "d07-outage-readiness.md",
    ]) {
      const content = read(`docs/runbooks/${runbook}`);
      expect(content).toContain("deploy:drill");
    }
    // The honesty vocabulary lives where provider boundaries exist
    // (authority loss's provider environments, the artifact exit,
    // the queue transport, and the readiness gate's honest
    // no-objectives note); the worker-evacuation drill is a pure
    // authority-plane procedure (no live-provider boundary).
    for (const runbook of [
      "README.md",
      "d07-authority-loss.md",
      "d07-artifact-exit.md",
      "d07-queue-recovery.md",
      "d07-outage-readiness.md",
    ]) {
      expect(read(`docs/runbooks/${runbook}`)).toContain("NOT RUN");
    }
  });
});
