/**
 * Architecture gate: the sandbox boundary (WORK-012; checkpoint contracts
 * DEPENDENCY-DIRECTION, TENANT-ISOLATION, POLICY-BEFORE-DISPATCH,
 * BUDGET-INTEGRITY, SANDBOX-BOUNDARY, EXECUTION-PROVENANCE — proof class
 * "static").
 *
 * Runs the SHARED scanner over the REAL src tree — one definition of the
 * protections (tests/discrimination/lib/sandbox.ts), two uses: this gate
 * over the real tree, the discrimination proofs over synthetic mutations.
 * A weakened protection is provably rejected.
 *
 * The dynamic halves live in tests/unit/sandbox and
 * tests/integration/postgres/sandbox-*; the mutation (discrimination)
 * proofs live in tests/discrimination/sandbox.discrimination.test.ts.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import {
  hasCanonicalSandboxFabric,
  type SandboxFabricFile,
  sandboxFabricViolations,
} from "../discrimination/lib/sandbox";

function loadSourceFiles(root: string, dir: string): SandboxFabricFile[] {
  const files: SandboxFabricFile[] = [];
  for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
    const relative = `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      files.push(...loadSourceFiles(root, relative));
    } else if (entry.name.endsWith(".ts")) {
      files.push({ path: relative, content: readFileSync(join(root, relative), "utf-8") });
    }
  }
  return files;
}

test("the sandbox fabric keeps every named boundary (M1..M18 static protections)", () => {
  const files = loadSourceFiles(process.cwd(), "src");
  expect(hasCanonicalSandboxFabric(files)).toBe(true);
  expect(sandboxFabricViolations(files)).toEqual([]);
});

test("the sandbox module's cross-module imports target public barrels only", () => {
  const files = loadSourceFiles(process.cwd(), "src/modules/sandbox");
  for (const file of files) {
    const imports = [...file.content.matchAll(/from ["'](\.[^"']+)["']/g)].map((m) => m[1] ?? "");
    for (const specifier of imports) {
      for (const authority of [
        "executions",
        "policies",
        "capabilities",
        "budgets",
        "tools",
        "agents",
      ]) {
        if (specifier.includes(`/${authority}/`)) {
          expect(
            specifier.endsWith("/public") || specifier.endsWith("/public.ts"),
            `${file.path} imports ${specifier} — must target the public barrel`,
          ).toBe(true);
        }
      }
    }
  }
});

test("the executions module remains the sole owner of the sandbox step-event vocabulary", () => {
  const executionsEvent = readFileSync(
    join(process.cwd(), "src/modules/executions/domain/event.ts"),
    "utf-8",
  );
  expect(executionsEvent).toContain('"sandbox-admitted"');
  expect(executionsEvent).toContain('"sandbox-denied"');
  expect(executionsEvent).toContain('"sandbox-completed"');
  // The vocabulary constant exists exactly once in src/.
  const files = loadSourceFiles(process.cwd(), "src");
  const definers = files.filter((f) => /STEP_EVENT_COMMANDS\s*=\s*\[/.test(f.content));
  expect(definers.map((f) => f.path)).toEqual(["src/modules/executions/domain/event.ts"]);
});

test("no provider/container SDK vocabulary leaks into the sandbox module contracts", () => {
  const barrel = readFileSync(join(process.cwd(), "src/modules/sandbox/public.ts"), "utf-8");
  const domain = readFileSync(
    join(process.cwd(), "src/modules/sandbox/domain/environment.ts"),
    "utf-8",
  );
  const sandboxDomain = readFileSync(
    join(process.cwd(), "src/modules/sandbox/domain/sandbox.ts"),
    "utf-8",
  );
  const providerPort = readFileSync(
    join(process.cwd(), "src/modules/sandbox/ports/sandbox-provider.ts"),
    "utf-8",
  );
  for (const [name, content] of [
    ["public.ts", barrel],
    ["domain/environment.ts", domain],
    ["domain/sandbox.ts", sandboxDomain],
    ["ports/sandbox-provider.ts", providerPort],
  ] as const) {
    expect(
      /docker|kubernetes|k8s|podman|containerd|oci|dockerode/i.test(
        content.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, ""),
      ),
      `${name} leaks a provider/container runtime vocabulary into a provider-neutral contract`,
    ).toBe(false);
  }
});

test("the platform sandbox seam imports no module and no provider SDK", () => {
  const files = loadSourceFiles(process.cwd(), "src/platform/sandbox");
  expect(files.length).toBeGreaterThan(0);
  for (const file of files) {
    expect(
      /from ["']\.\.\/\.\.\/modules\//.test(file.content),
      `${file.path}: platform must not import modules (platform-isolation)`,
    ).toBe(false);
    for (const specifier of [...file.content.matchAll(/from ["']([^"']+)["']/g)].map(
      (m) => m[1] ?? "",
    )) {
      if (specifier.startsWith(".") || specifier.startsWith("node:")) {
        continue;
      }
      expect(
        /docker|kubernetes|k8s|podman|containerd|oci/i.test(specifier),
        `${file.path} imports a container provider SDK (${specifier}) — no SDK is declared`,
      ).toBe(false);
    }
  }
});
