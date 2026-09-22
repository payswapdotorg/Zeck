/**
 * deploy/build-vercel-output — the Vercel output build with the
 * module-loading correction (PPR-006's discovery; PPR-007 extends it
 * to BOTH function graphs of the two-function composition).
 *
 * THE COMPOSITION (PPR-007): the deployment serves TWO functions —
 *  - `index` (the ROOT framework entry, PPR-006's Fastify function
 *    serving the API plane at every non-experience path), and
 *  - `api/experience` (the experience Serverless Function — the console
 *    composition, routed at /console/*, /trust/*, /admin/*, the root /
 *    and the composition's own /assets/client.js asset by vercel.json
 *    `rewrites`).
 * The correction core (deploy/vercel-output.ts) applies the ESM
 * specifier resolution + `type: module` marker + fail-closed
 * verification to EVERY function graph of the emitted output, and the
 * tool REFUSES a build whose required function set is missing (the
 * routing contract requires both functions).
 *
 * THE CORRECTION (the smallest valid delta on the platform's OWN build
 * output — no bundler, no second build system, byte-for-byte the
 * platform's transpilation and file tracing):
 *
 *  1. `vercel build --prod` runs UNCHANGED (the framework detection,
 *     the tsc transpilation, the nft file tracing — node_modules,
 *     deploy/manifests, docs — all the platform's own work);
 *  2. the emitted `.js` graphs (outside node_modules) get their
 *     RELATIVE IMPORT SPECIFIERS made Node-ESM-resolvable: a specifier
 *     resolving to a source FILE gains `.js` (`./lib` → `./lib.js`);
 *     a specifier resolving to a source DIRECTORY gains `/index.js`
 *     (`../src/api` → `../src/api/index.js` — Node ESM has no
 *     directory-index resolution). Absolute/bare specifiers
 *     (`node:*`, packages) are untouched;
 *  3. each function root's package.json becomes the minimal
 *     `{"type": "module"}` marker (scopes ONLY the emitted graph —
 *     every traced node_modules package keeps its own nearest
 *     package.json, so CJS packages stay CJS);
 *  4. a fail-closed verification pass: zero extensionless relative
 *     specifiers may remain, or the build refuses.
 *
 * THE DEPLOYMENT MECHANISM this enables: the corrected output is
 * deployed with `vercel deploy --prebuilt --prod` — the artifact is
 * verified locally BEFORE it ships (the exact shipped bytes boot
 * under `node server.js` and answer `deploy:public-smoke --url`;
 * the experience function boots under `node api/experience.js`
 * against the same plane), which is a STRONGER guarantee than the
 * opaque on-platform build. The .vc-config.json, config.json routes
 * and the traced bundle are the platform's own (this tool never
 * touches them).
 *
 * THE HONEST BOUNDARY: this tool runs the platform's own
 * `vercel build --prod`, which requires Vercel credentials — the
 * worker pod holds NONE (the Lead owns the credentialed deployment
 * run). The correction core itself is proven against a synthetic
 * `.vercel/output` fixture by tests/unit/deployment/vercel-output.test.ts
 * (the two-function graph: extensionless relative file imports and
 * directory imports, both corrected; the marker written; the
 * fail-closed verification).
 *
 * Usage (the Lead's credentialed run — VERCEL_TOKEN in env):
 *   bun run deploy:build-vercel-output
 *   # then the local artifact proof (BOTH functions), then:
 *   vercel deploy --prebuilt --prod
 */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { correctVercelOutput } from "./vercel-output";

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUTPUT_ROOT = join(REPOSITORY_ROOT, ".vercel", "output");
const FUNCTIONS_ROOT = join(OUTPUT_ROOT, "functions");

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
  if (!existsSync(FUNCTIONS_ROOT)) {
    throw new Error(`the platform build produced no functions root at ${FUNCTIONS_ROOT}`);
  }
}

function main(): number {
  runPlatformBuild();
  console.log(
    "▸ rewriting relative import specifiers (Node ESM resolution — BOTH function graphs)",
  );
  const correction = correctVercelOutput(OUTPUT_ROOT, REPOSITORY_ROOT);
  for (const outcome of correction.functions) {
    console.log(
      `  ${outcome.functionDir}.func: ${outcome.filesRewritten} files, ${outcome.specifierRewrites} specifiers rewritten`,
    );
  }
  console.log("▸ writing the ESM module markers (per-function-root package.json)");
  console.log("▸ verifying the emitted graphs");
  const remaining = correction.functions.reduce(
    (sum, outcome) => sum + outcome.remainingUnresolved,
    0,
  );
  if (remaining > 0) {
    console.error(`✗ ${remaining} extensionless relative specifiers remain — build refused`);
    return 1;
  }
  console.log("✓ the corrected output is ready for the local artifact proof, then:");
  console.log(
    "    cd .vercel/output/functions/index.func && ZECK_ENVIRONMENT=preview ... node server.js",
  );
  console.log(
    "    cd .vercel/output/functions/api/experience.func && ZECK_EXPERIENCE_API_URL=<plane> ZECK_EXPERIENCE_APPLICATION_ID=<scope> node api/experience.js",
  );
  console.log("    vercel deploy --prebuilt --prod");
  return 0;
}

process.exit(main());
