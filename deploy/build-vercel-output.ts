/**
 * deploy/build-vercel-output — the Vercel output build with the
 * module-loading correction (the Lead's deployment-run discovery,
 * 2026-09-21, the fifth live platform fact).
 *
 * THE PLATFORM FACT (proved by the credentialed live run at
 * zeck-preview-main.vercel.app): the Fastify framework build's tsc
 * transpilation emits ES-module syntax (`import`/`export`,
 * `import.meta.url` in deploy/lib.ts — the graph is ESM-required),
 * but the runtime loads the traced handler `/var/task/server.js` as
 * COMMONJS, because the file-traced repository package.json carries
 * no `"type"` field — the isolate dies at cold start with
 * `SyntaxError: Cannot use import statement outside a module`
 * (FUNCTION_INVOCATION_FAILED on every route).
 *
 * THE CORRECTION (the smallest valid delta on the platform's OWN
 * build output — no bundler, no second build system, byte-for-byte
 * the platform's transpilation and file tracing):
 *
 *  1. `vercel build --prod` runs UNCHANGED (the framework
 *     detection, the tsc transpilation, the nft file tracing —
 *     node_modules, deploy/manifests, docs — all the platform's
 *     own work);
 *  2. the emitted `.js` graph (outside node_modules) gets its
 *     RELATIVE IMPORT SPECIFIERS made Node-ESM-resolvable: a
 *     specifier resolving to a source FILE gains `.js`
 *     (`./lib` → `./lib.js`); a specifier resolving to a source
 *     DIRECTORY gains `/index.js` (`../src/api` →
 *     `../src/api/index.js` — Node ESM has no directory-index
 *     resolution; 38 directory imports and 3198 file imports in
 *     the server graph). Absolute/bare specifiers (`node:*`,
 *     packages) are untouched;
 *  3. the function root's package.json becomes the minimal
 *     `{"type": "module"}` marker (scopes ONLY the emitted graph —
 *     every traced node_modules package keeps its own nearest
 *     package.json, so CJS packages stay CJS);
 *  4. a fail-closed verification pass: zero extensionless relative
 *     specifiers may remain, or the build refuses.
 *
 * THE DEPLOYMENT MECHANISM this enables: the corrected output is
 * deployed with `vercel deploy --prebuilt --prod` — the artifact is
 * verified locally BEFORE it ships (the exact shipped bytes boot
 * under `node server.js` and answer `deploy:public-smoke --url`),
 * which is a STRONGER guarantee than the opaque on-platform build.
 * The .vc-config.json, config.json routes and the traced bundle are
 * the platform's own (this tool never touches them).
 *
 * Usage (the Lead's credentialed run — VERCEL_TOKEN in env):
 *   bun run deploy:build-vercel-output
 *   # then the local artifact proof, then:
 *   vercel deploy --prebuilt --prod
 */

import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUTPUT_ROOT = join(REPOSITORY_ROOT, ".vercel", "output");
const FUNCTION_ROOT = join(OUTPUT_ROOT, "functions", "index.func");

/** The `from "<specifier>"` shapes tsc emits (no dynamic/side-effect relative imports exist in the graph). */
const FROM_SPECIFIER = /(from\s+["'])(\.\.?\/[^"']+)(["'])/g;

/** A specifier suffix that already carries a resolvable extension — never rewritten. */
const RESOLVED_SUFFIXES = [".js", ".json", ".mjs", ".cjs", ".wasm", ".node"] as const;

interface RewriteOutcome {
  readonly file: string;
  readonly rewrites: number;
}

/** Run the platform's own framework build (unchanged). */
function runPlatformBuild(): void {
  console.log("▸ vercel build --prod (the platform's own framework build)");
  const result = spawnSync("npx", ["-y", "vercel@latest", "build", "--prod", "--yes"], {
    cwd: REPOSITORY_ROOT,
    stdio: "inherit",
    env: process.env,
  });
  if (result.status !== 0) {
    throw new Error(`the platform build failed (exit ${result.status})`);
  }
  if (!existsSync(FUNCTION_ROOT)) {
    throw new Error(`the platform build produced no function at ${FUNCTION_ROOT}`);
  }
}

/** Walk the emitted graph (node_modules excluded — traced packages keep their own module systems). */
function* emittedJavaScriptFiles(): Generator<string> {
  const stack: string[] = [FUNCTION_ROOT];
  while (stack.length > 0) {
    const dir = stack.pop() as string;
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      const stats = statSync(path);
      if (stats.isDirectory()) {
        if (entry === "node_modules") {
          continue;
        }
        stack.push(path);
      } else if (entry.endsWith(".js")) {
        yield path;
      }
    }
  }
}

/**
 * Rewrite one specifier against the repository source tree (the emit
 * mirrors the source layout, so repository resolution IS emit
 * resolution): a directory target gains `/index.js`; a file target
 * gains `.js`; anything else fails the build closed.
 */
function rewriteSpecifier(emittedFile: string, specifier: string): string {
  const emitRelative = relative(FUNCTION_ROOT, emittedFile);
  const sourceDir = dirname(join(REPOSITORY_ROOT, emitRelative));
  const target = resolve(sourceDir, specifier);
  if (existsSync(join(target, "index.ts"))) {
    return `${specifier}/index.js`;
  }
  if (existsSync(`${target}.ts`)) {
    return `${specifier}.js`;
  }
  throw new Error(
    `unresolvable relative import "${specifier}" in ${emitRelative}: neither a source file nor a directory with index.ts — the emit graph and the source tree have diverged`,
  );
}

/** Apply the correction to the emitted graph. */
function rewriteEmittedGraph(): RewriteOutcome[] {
  const outcomes: RewriteOutcome[] = [];
  for (const file of emittedJavaScriptFiles()) {
    const source = readFileSync(file, "utf8");
    let rewrites = 0;
    const corrected = source.replace(
      FROM_SPECIFIER,
      (match, lead: string, specifier: string, trail: string) => {
        if (RESOLVED_SUFFIXES.some((suffix) => specifier.endsWith(suffix))) {
          return match;
        }
        rewrites += 1;
        return `${lead}${rewriteSpecifier(file, specifier)}${trail}`;
      },
    );
    if (rewrites > 0) {
      writeFileSync(file, corrected);
      outcomes.push({ file: relative(FUNCTION_ROOT, file), rewrites });
    }
  }
  return outcomes;
}

/** Write the minimal ESM marker package.json (scopes only the emitted graph). */
function writeModuleMarker(): void {
  writeFileSync(
    join(FUNCTION_ROOT, "package.json"),
    `${JSON.stringify({ name: "@pectoraux/ai-execution-os", type: "module", private: true }, null, 2)}\n`,
  );
}

/** Fail-closed verification: no extensionless relative specifier may remain. */
function verifyGraph(): number {
  let remaining = 0;
  for (const file of emittedJavaScriptFiles()) {
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(FROM_SPECIFIER)) {
      const specifier = match[2];
      if (specifier === undefined) {
        continue;
      }
      if (!RESOLVED_SUFFIXES.some((suffix) => specifier.endsWith(suffix))) {
        console.error(`  ✗ ${relative(FUNCTION_ROOT, file)}: "${specifier}" left extensionless`);
        remaining += 1;
      }
    }
  }
  return remaining;
}

function main(): number {
  runPlatformBuild();
  console.log("▸ rewriting relative import specifiers (Node ESM resolution)");
  const outcomes = rewriteEmittedGraph();
  const totalRewrites = outcomes.reduce((sum, outcome) => sum + outcome.rewrites, 0);
  console.log(`  ${outcomes.length} files, ${totalRewrites} specifiers rewritten`);
  console.log("▸ writing the ESM module marker (function-root package.json)");
  writeModuleMarker();
  console.log("▸ verifying the emitted graph");
  const remaining = verifyGraph();
  if (remaining > 0) {
    console.error(`✗ ${remaining} extensionless relative specifiers remain — build refused`);
    return 1;
  }
  console.log("✓ the corrected output is ready for the local artifact proof, then:");
  console.log(
    "    cd .vercel/output/functions/index.func && ZECK_ENVIRONMENT=preview ... node server.js",
  );
  console.log("    vercel deploy --prebuilt --prod");
  return 0;
}

process.exit(main());
