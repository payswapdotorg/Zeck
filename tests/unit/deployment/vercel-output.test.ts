/**
 * PPR-007 unit tests — the build tool's two-function graph correction
 * (deploy/vercel-output.ts), proven against a SYNTHETIC `.vercel/output`
 * fixture.
 *
 * THE HONEST BOUNDARY: the worker pod holds NO Vercel credentials, so
 * `vercel build` itself cannot run here — the platform build that
 * produces the real output is the Lead's credentialed run (recorded
 * NOT RUN with its owner in deploy/evidence/ppr-007.json). What this
 * proof establishes is the CORRECTION the tool applies once the
 * platform's own build has produced its output:
 *
 *  - THE TWO-FUNCTION COMPOSITION: the fixture carries BOTH function
 *    graphs (index.func — the framework entry; api/experience.func —
 *    the experience Serverless Function), and the correction applies
 *    to EVERY graph: the extensionless relative FILE imports gain
 *    `.js`, the extensionless relative DIRECTORY imports gain
 *    `/index.js` (Node ESM has no directory-index resolution), and
 *    already-resolved specifiers (`.json`, packages, `node:*`) are
 *    untouched;
 *  - THE MARKER: every function root's package.json becomes the
 *    minimal `{"type": "module"}` ESM marker;
 *  - FAIL-CLOSED VERIFICATION: a graph with a remaining extensionless
 *    relative specifier is counted and the correction reports it (the
 *    orchestration refuses the build on it);
 *  - THE REQUIRED FUNCTION SET: an output missing a required function
 *    graph (the routing contract requires BOTH) is REFUSED;
 *  - THE UNRESOLVABLE SPECIFIER: a specifier that resolves to neither
 *    a source file nor a directory with index.ts fails closed (the
 *    emit graph and the source tree have diverged);
 *  - node_modules is EXCLUDED (traced packages keep their own module
 *    systems — a CJS package's extensionless requires/specifiers are
 *    never rewritten).
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import {
  correctVercelOutput,
  REQUIRED_FUNCTIONS,
  RUNTIME_DATA_CARRY_FUNCTION,
  RUNTIME_DATA_ROOTS,
  rewriteSpecifier,
  verifyGraph,
} from "../../../deploy/vercel-output";

const TEMP_DIRS: string[] = [];

afterAll(() => {
  for (const dir of TEMP_DIRS) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** Materialize a file (creating directories on demand). */
function write(root: string, relative: string, content: string): void {
  const path = join(root, relative);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

/** Build the synthetic two-function fixture: a repository tree + its `.vercel/output` mirror. */
function buildFixture(): { readonly repoRoot: string; readonly outputRoot: string } {
  const base = mkdtempSync(join(tmpdir(), "zeck-vercel-output-"));
  TEMP_DIRS.push(base);
  const repoRoot = join(base, "repo");
  const outputRoot = join(base, "output");

  // --- the repository tree (what rewriteSpecifier resolves against) ---
  write(repoRoot, "server.ts", "export const entry = 1;\n");
  write(repoRoot, "lib.ts", "export const lib = 1;\n");
  write(repoRoot, "src/api/index.ts", "export const api = 1;\n");
  write(repoRoot, "api/experience.ts", "export const experience = 1;\n");
  write(repoRoot, "deploy/experience.ts", "export const adapter = 1;\n");
  write(repoRoot, "deploy/manifests/variables.json", "{}\n");
  write(repoRoot, "apps/dashboard/index.ts", "export const dashboard = 1;\n");
  write(repoRoot, "apps/dashboard/http.ts", "export const http = 1;\n");
  write(repoRoot, "sdk/index.ts", "export const sdk = 1;\n");
  // The runtime-read data roots exist in every repository (the carry's
  // fail-closed contract) — empty here; the carry tests populate them.
  for (const root of RUNTIME_DATA_ROOTS) {
    mkdirSync(join(repoRoot, root), { recursive: true });
  }

  // --- the emitted output mirror: the framework function graph ---
  const indexFunc = join(outputRoot, "functions", "index.func");
  write(
    indexFunc,
    "server.js",
    [
      'import { lib } from "./lib";',
      'import { api } from "./src/api";',
      'import { adapter } from "./deploy/experience";',
      'import { readFileSync } from "node:fs";',
      "export const ready = true;",
    ].join("\n"),
  );
  write(indexFunc, "lib.js", "export const lib = 1;\n");
  write(indexFunc, "src/api/index.js", "export const api = 1;\n");
  write(
    indexFunc,
    "deploy/experience.js",
    'import { manifest } from "./manifests/variables.json";\nexport const adapter = manifest;\n',
  );
  write(indexFunc, "deploy/manifests/variables.json", "{}\n");

  // --- the emitted output mirror: the experience function graph ---
  const experienceFunc = join(outputRoot, "functions", "api", "experience.func");
  write(
    experienceFunc,
    "api/experience.js",
    'import { adapter } from "../deploy/experience";\nexport default adapter;\n',
  );
  write(
    experienceFunc,
    "deploy/experience.js",
    'import { dashboard } from "../apps/dashboard/index";\nexport const adapter = dashboard;\n',
  );
  write(
    experienceFunc,
    "apps/dashboard/index.js",
    'import { http } from "./http";\nimport { sdk } from "../../sdk";\nexport const dashboard = http + sdk;\n',
  );
  write(experienceFunc, "apps/dashboard/http.js", "export const http = 1;\n");
  write(experienceFunc, "sdk/index.js", "export const sdk = 1;\n");

  // --- a traced node_modules package: EXCLUDED from the correction ---
  write(
    experienceFunc,
    "node_modules/some-pkg/index.js",
    'const { x } = require("./extensionless");\nmodule.exports = { x };\n',
  );

  return { repoRoot, outputRoot };
}

describe("PPR-007: the build tool's two-function graph correction (synthetic-fixture proof)", () => {
  test("the required function set is the two-function composition", () => {
    expect(REQUIRED_FUNCTIONS).toEqual(["index", "api/experience"]);
  });

  test("the correction rewrites BOTH function graphs' specifiers and writes BOTH markers", () => {
    const { repoRoot, outputRoot } = buildFixture();
    const correction = correctVercelOutput(outputRoot, repoRoot);

    // every function graph present is corrected (the two of the composition)
    expect(correction.functions.map((outcome) => outcome.functionDir).sort()).toEqual([
      "api/experience",
      "index",
    ]);

    // the framework graph: ./lib → ./lib.js, ./src/api → ./src/api/index.js,
    // ./deploy/experience → ./deploy/experience.js; the .json and node:*
    // specifiers are untouched.
    const server = readFileSync(join(outputRoot, "functions", "index.func", "server.js"), "utf8");
    expect(server).toContain('from "./lib.js"');
    expect(server).toContain('from "./src/api/index.js"');
    expect(server).toContain('from "./deploy/experience.js"');
    expect(server).not.toContain('from "./lib"');
    expect(server).toContain('from "node:fs"');
    const experienceAdapter = readFileSync(
      join(outputRoot, "functions", "index.func", "deploy", "experience.js"),
      "utf8",
    );
    expect(experienceAdapter).toContain('from "./manifests/variables.json"');

    // the experience graph: ../deploy/experience → ../deploy/experience.js,
    // ../apps/dashboard/index → ../apps/dashboard/index.js, ./http →
    // ./http.js, ../../sdk → ../../sdk/index.js (the directory import).
    const entry = readFileSync(
      join(outputRoot, "functions", "api", "experience.func", "api", "experience.js"),
      "utf8",
    );
    expect(entry).toContain('from "../deploy/experience.js"');
    const deployAdapter = readFileSync(
      join(outputRoot, "functions", "api", "experience.func", "deploy", "experience.js"),
      "utf8",
    );
    expect(deployAdapter).toContain('from "../apps/dashboard/index.js"');
    const dashboardIndex = readFileSync(
      join(outputRoot, "functions", "api", "experience.func", "apps", "dashboard", "index.js"),
      "utf8",
    );
    expect(dashboardIndex).toContain('from "./http.js"');
    expect(dashboardIndex).toContain('from "../../sdk/index.js"');

    // node_modules is excluded: the traced package is byte-identical.
    const traced = readFileSync(
      join(
        outputRoot,
        "functions",
        "api",
        "experience.func",
        "node_modules",
        "some-pkg",
        "index.js",
      ),
      "utf8",
    );
    expect(traced).toContain('require("./extensionless")');

    // BOTH function roots carry the ESM marker.
    for (const functionDir of ["index", "api/experience"]) {
      const marker = JSON.parse(
        readFileSync(join(outputRoot, "functions", `${functionDir}.func`, "package.json"), "utf8"),
      ) as Record<string, unknown>;
      expect(marker.type).toBe("module");
      expect(marker.private).toBe(true);
    }

    // the fail-closed verification passes on every graph.
    for (const outcome of correction.functions) {
      expect(outcome.remainingUnresolved).toBe(0);
    }
    expect(correction.functions.reduce((sum, o) => sum + o.specifierRewrites, 0)).toBeGreaterThan(
      0,
    );
  });

  test("code-as-data is never misread as an import edge (the DEP-025 playground snippet lesson)", () => {
    // The emitted graph legitimately contains code-as-data: a template
    // literal whose served text includes an import statement shape
    // (apps/dashboard/validation-lab.ts's playground snippet embeds
    // `import { createZeckClient } from "./sdk";`). A raw-text regex
    // misread that string as a module edge and refused an honest build
    // ("unresolvable relative import"); the ESM lexer is the oracle.
    const { repoRoot, outputRoot } = buildFixture();
    const experienceFunc = join(outputRoot, "functions", "api", "experience.func");
    write(
      experienceFunc,
      "apps/dashboard/validation-lab.js",
      [
        'const snippet = `import { createZeckClient } from "./sdk";`;',
        'import { http } from "./http";',
        "export const lab = http + snippet.length;",
      ].join("\n"),
    );
    const before = readFileSync(
      join(experienceFunc, "apps", "dashboard", "validation-lab.js"),
      "utf8",
    );
    expect(before).toContain('from "./sdk"'); // the data is present

    const correction = correctVercelOutput(outputRoot, repoRoot);
    const after = readFileSync(
      join(experienceFunc, "apps", "dashboard", "validation-lab.js"),
      "utf8",
    );

    // the REAL edge is rewritten; the string-embedded one is untouched
    expect(after).toContain('from "./http.js"');
    expect(after).toContain('from "./sdk"'); // still data, byte-identical
    expect(after).not.toContain("./sdk.js"); // no extension injected into the data
    for (const outcome of correction.functions) {
      expect(outcome.remainingUnresolved).toBe(0);
    }
  });

  test("the data carry: the runtime-read roots are carried verbatim into the experience function, and only it", () => {
    // The 2026-09-23 artifact-proof lesson: the composition's
    // dynamically constructed reads (app READMEs, work-order specs,
    // developer docs, example sources) are invisible to file tracing —
    // the bundle shipped without them and the isolate failed closed
    // (ENOENT at cold start). The correction carries the four roots
    // into exactly the one function that reads them.
    const { repoRoot, outputRoot } = buildFixture();
    write(repoRoot, "benchmarks/validation/apps/demo/README.md", "# demo app\n");
    write(repoRoot, "docs/developer/GUIDE.md", "# guide\n");
    write(repoRoot, "examples/sample.ts", "export const sample = 1;\n");
    write(repoRoot, "spec/validation-work-orders/VAL-001.md", "# VAL-001\n");
    const experienceFunc = join(outputRoot, "functions", "api", "experience.func");
    const indexFunc = join(outputRoot, "functions", "index.func");

    const correction = correctVercelOutput(outputRoot, repoRoot);

    // carried verbatim (byte-identical source truth)
    expect(
      readFileSync(join(experienceFunc, "benchmarks/validation/apps/demo/README.md"), "utf8"),
    ).toBe("# demo app\n");
    expect(readFileSync(join(experienceFunc, "docs/developer/GUIDE.md"), "utf8")).toBe("# guide\n");
    expect(readFileSync(join(experienceFunc, "examples/sample.ts"), "utf8")).toBe(
      "export const sample = 1;\n",
    );
    expect(
      readFileSync(join(experienceFunc, "spec/validation-work-orders/VAL-001.md"), "utf8"),
    ).toBe("# VAL-001\n");
    // scoped: the API plane's function receives NOTHING (its own
    // 26-route smoke proves it needs none of the carried roots)
    expect(existsSync(join(indexFunc, "benchmarks"))).toBe(false);
    expect(existsSync(join(indexFunc, "docs"))).toBe(false);
    // the outcome reports the carry honestly
    const experience = correction.functions.find((f) => f.functionDir === "api/experience");
    const index = correction.functions.find((f) => f.functionDir === "index");
    expect(experience?.dataFilesCarried).toBe(4);
    expect(index?.dataFilesCarried).toBe(0);
    // the contract is pinned: the roots and the one carrying function
    expect(RUNTIME_DATA_ROOTS).toEqual(["benchmarks", "docs", "examples", "spec"]);
    expect(RUNTIME_DATA_CARRY_FUNCTION).toBe("api/experience");
  });

  test("the data carry refuses a drifted root (never a silent narrowing of the carry)", () => {
    const { repoRoot, outputRoot } = buildFixture();
    write(repoRoot, "benchmarks/validation/apps/demo/README.md", "# demo app\n");
    write(repoRoot, "docs/developer/GUIDE.md", "# guide\n");
    write(repoRoot, "examples/sample.ts", "export const sample = 1;\n");
    write(repoRoot, "spec/validation-work-orders/VAL-001.md", "# VAL-001\n");
    rmSync(join(repoRoot, "docs"), { recursive: true, force: true });
    expect(() => correctVercelOutput(outputRoot, repoRoot)).toThrow(
      /runtime data root "docs" does not exist/,
    );
  });

  test("the correction refuses an output missing a required function graph (the routing contract)", () => {
    const { repoRoot, outputRoot } = buildFixture();
    rmSync(join(outputRoot, "functions", "api"), { recursive: true, force: true });
    expect(() => correctVercelOutput(outputRoot, repoRoot)).toThrow(/api\/experience/);
  });

  test("the fail-closed verification counts a remaining extensionless specifier", () => {
    // A graph the rewrite pass never touched (the belt-and-braces final
    // pass): verifyGraph counts the extensionless specifier and the
    // orchestration refuses the build on it.
    const base = mkdtempSync(join(tmpdir(), "zeck-vercel-verify-"));
    TEMP_DIRS.push(base);
    const functionRoot = join(base, "index.func");
    write(functionRoot, "server.js", 'import { lib } from "./lib";\nexport const ready = true;\n');
    write(functionRoot, "lib.js", "export const lib = 1;\n");
    expect(verifyGraph(functionRoot)).toBe(1);
    // the same graph after the rewrite pass verifies clean
    const { repoRoot, outputRoot } = buildFixture();
    const correction = correctVercelOutput(outputRoot, repoRoot);
    for (const outcome of correction.functions) {
      const root = join(outputRoot, "functions", `${outcome.functionDir}.func`);
      expect(verifyGraph(root)).toBe(0);
    }
  });

  test("an unresolvable specifier fails the build closed (emit/source divergence)", () => {
    const { repoRoot, outputRoot } = buildFixture();
    const unresolvable = join(outputRoot, "functions", "index.func", "stray.js");
    writeFileSync(
      unresolvable,
      'import { nothing } from "./does-not-exist-anywhere";\nexport const stray = 1;\n',
    );
    expect(() => correctVercelOutput(outputRoot, repoRoot)).toThrow(
      /unresolvable relative import "\.\/does-not-exist-anywhere"/,
    );
  });

  test("rewriteSpecifier resolves file and directory targets exactly", () => {
    const { repoRoot, outputRoot } = buildFixture();
    const indexFunc = join(outputRoot, "functions", "index.func");
    // a file target gains .js
    expect(rewriteSpecifier(repoRoot, indexFunc, join(indexFunc, "server.js"), "./lib")).toBe(
      "./lib.js",
    );
    // a directory target gains /index.js
    expect(rewriteSpecifier(repoRoot, indexFunc, join(indexFunc, "server.js"), "./src/api")).toBe(
      "./src/api/index.js",
    );
    // nothing else resolves — fail closed
    expect(() =>
      rewriteSpecifier(repoRoot, indexFunc, join(indexFunc, "server.js"), "./no-such-target"),
    ).toThrow(/unresolvable relative import/);
    // the experience graph resolves against the SAME repository tree
    const experienceFunc = join(outputRoot, "functions", "api", "experience.func");
    expect(
      rewriteSpecifier(
        repoRoot,
        experienceFunc,
        join(experienceFunc, "api", "experience.js"),
        "../deploy/experience",
      ),
    ).toBe("../deploy/experience.js");
  });
});
