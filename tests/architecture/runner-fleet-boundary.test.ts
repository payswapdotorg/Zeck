/**
 * Architecture gate: the runner-fleet boundary (WORK-019; checkpoint
 * contracts IMPLEMENTATION-COMPLETENESS, IDENTITY-IDEMPOTENCY,
 * CONCURRENCY-CRASH-SAFETY, SELF-HOSTING-BOUNDARY — proof class "static").
 *
 * Runs the SHARED scanner over the REAL src tree — one definition of the
 * protections (tests/discrimination/lib/runners.ts), two uses: this gate
 * over the real tree, the discrimination proofs over synthetic mutations
 * (M1..M20). A weakened protection is provably rejected.
 *
 * The dynamic halves live in tests/unit/sandbox/runner-fleet-*.test.ts and
 * tests/integration/postgres/runner-fleet*.test.ts; the mutation
 * (discrimination) proofs live in
 * tests/discrimination/runner-fleet.discrimination.test.ts.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import {
  hasCanonicalRunnerFabric,
  type RunnerFleetFile,
  runnerFleetViolations,
} from "../discrimination/lib/runners";

function loadSourceFiles(root: string, dir: string): RunnerFleetFile[] {
  const files: RunnerFleetFile[] = [];
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

function loadRunnerFleetFiles(): RunnerFleetFile[] {
  const files = [
    ...loadSourceFiles(process.cwd(), "src/modules/sandbox"),
    ...loadSourceFiles(process.cwd(), "src/integrations/runners"),
  ];
  // The migration is the physical half of the boundary (partial unique
  // index, append-only evidence triggers, write-once identity cores).
  files.push({
    path: "src/platform/db/migrations/0015_runner_fleet.sql",
    content: readFileSync(
      join(process.cwd(), "src/platform/db/migrations/0015_runner_fleet.sql"),
      "utf-8",
    ),
  });
  return files;
}

test("the runner fleet keeps every named boundary (M1..M20 static protections)", () => {
  const files = loadRunnerFleetFiles();
  expect(hasCanonicalRunnerFabric(files)).toBe(true);
  expect(runnerFleetViolations(files)).toEqual([]);
});

test("runners are a SUBSTRATE: the fleet and the integration import no authority surface", () => {
  const files = [
    ...loadSourceFiles(process.cwd(), "src/modules/sandbox"),
    ...loadSourceFiles(process.cwd(), "src/integrations/runners"),
  ];
  for (const file of files) {
    // Relative imports of other modules must target public barrels only.
    for (const specifier of [...file.content.matchAll(/from ["'](\.[^"']+)["']/g)].map(
      (m) => m[1] ?? "",
    )) {
      for (const authority of [
        "executions",
        "policies",
        "capabilities",
        "budgets",
        "tools",
        "agents",
        "verification",
        "learning",
      ]) {
        if (specifier.includes(`/${authority}/`)) {
          expect(
            specifier.endsWith("/public") || specifier.endsWith("/public.ts"),
            `${file.path} imports ${specifier} — must target the public barrel`,
          ).toBe(true);
        }
      }
    }
    // The runner fleet surfaces never import a module authority at all
    // (the ONLY sanctioned cross-module edge for runners is the sandbox
    // module's own store/service types — internal to the sandbox module —
    // and the integration's sandbox public barrel import).
    if (
      file.path.startsWith("src/integrations/runners/") &&
      /from ["']\.\.\/\.\.\/modules\//.test(file.content)
    ) {
      expect(file.content).toContain("modules/sandbox/public");
    }
  }
});

test("no VM/microVM vendor vocabulary exists anywhere in the runner contracts", () => {
  const contractPaths = [
    "src/modules/sandbox/domain/runner.ts",
    "src/modules/sandbox/domain/environment.ts",
    "src/modules/sandbox/ports/runner-store.ts",
    "src/modules/sandbox/ports/runner-channel.ts",
    "src/modules/sandbox/ports/isolated-runtime.ts",
    "src/modules/sandbox/public.ts",
    "src/integrations/runners/public.ts",
    "src/integrations/runners/domain/submission.ts",
    "src/integrations/runners/ports/customer-runner-endpoint.ts",
  ];
  for (const relative of contractPaths) {
    const content = readFileSync(join(process.cwd(), relative), "utf-8");
    const code = content.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    expect(
      /\b(firecracker|qemu|kvm|vmware|virtualbox|xen|hyperv|hyper-v|aws|amazon|ec2|gcp|azure)/i.test(
        code,
      ),
      `${relative} leaks a VM/microVM vendor vocabulary into a provider-neutral contract (M14)`,
    ).toBe(false);
  }
});
