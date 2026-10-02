/**
 * The PPR-023 compiled-runtime builder — produces the compiled form of the
 * pinned OpenClaw source tree that the certified runtime executes.
 *
 * WHY (measured, disclosed): the pinned revision's source-run path
 * (`node --import scripts/tsx.mjs src/entry.ts`) transpiles the full app
 * graph in EVERY runtime process — the respawned CLI child AND every
 * Worker thread the runtime spawns (the pinned revision's
 * resolveRuntimeWorkerThreadExecArgv loads `tsx/esm` into each worker for
 * .ts worker URLs). Worker isolates do NOT inherit NODE_OPTIONS heap
 * caps, so a --max-old-space-size ceiling cannot contain them: measured
 * live, the respawned CLI child carrying the cap still accumulated
 * 30–44 threads, up to 8 esbuild services and a 2.7GB+ RSS until the
 * 4GB pod's kernel OOM-killer SIGKILLed it (dmesg: five consecutive
 * kills at anon-rss 2.7–2.9GB; /tmp/openclaw ENOSPC collateral from the
 * plugin-capture tree filled the disk in parallel). The app's own
 * tsdown bundle build also refuses on this machine (its own preflight
 * measured 4352MB needed vs 2035MB available).
 *
 * WHAT this builder does (all inside the pinned checkout, untracked
 * build state beside the pinned sources — the identical enablement
 * class the anchor pair already established, now comprehensive):
 *  1. transforms every .ts under src/ and packages/*/src/ to an
 *     in-place .js sibling (esbuild transform — the SAME engine the
 *     repo's own tsx loader uses per-file, honoring the checkout's
 *     tsconfig compilerOptions incl. useDefineForClassFields:false);
 *     every relative `./x.js` import (the repo's NodeNext convention)
 *     then resolves to its compiled sibling, and every runtime worker
 *     / process entrypoint the pinned revision resolves as a
 *     source-sibling automatically picks its compiled form — its own
 *     runtimeNeedsTypeScriptLoader() extension test then selects plain
 *     node with NO TypeScript loader, exactly like the app's deploy
 *     builds (the pinned service-child-relay.ts does precisely this for
 *     its WORKER_DEPLOY_BUILD anchor .mjs);
 *  2. mirrors each package's compiled src to dist/**.mjs (the exact
 *     paths the pinned packages' package.json exports maps name) with
 *     a deterministic relative-import `.js` → `.mjs` rewrite;
 *  3. adds the root node_modules/@openclaw/<pkg> workspace symlinks the
 *     source-run received from tsconfig paths (the root package.json
 *     only declares five of them; src/'s bare @openclaw/* imports
 *     resolve through these links to the packages' dist outputs);
 *  4. writes a digest manifest (sha256 of every produced file + the
 *     esbuild version + the pinned tsconfig digest) so the battery can
 *     re-verify byte-identity of the compiled tree it runs.
 *
 * Run: bun run compat/openclaw/harness/build-compiled-runtime.ts [verify]
 *      (verify = rebuild into a temp mirror and prove byte-identity)
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { OPENCLAW_CHECKOUT_DIR } from "./corpus-runner";

type EsbuildModule = typeof import("esbuild");

const MANIFEST_PATH = join(OPENCLAW_CHECKOUT_DIR, "compiled-runtime.manifest.json");
const VERIFY_DIR = "/tmp/ppr-023-compiled-verify";

/** The compiled entry the certified runtime executes. */
export const OPENCLAW_COMPILED_ENTRY = join(OPENCLAW_CHECKOUT_DIR, "src", "entry.js");

function sha256Of(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}

function sha256File(path: string): string {
  return sha256Of(readFileSync(path));
}

/** Recursively list files under a directory (relative paths). */
function listFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile()) {
        out.push(relative(root, full));
      }
    }
  };
  walk(root);
  return out.sort();
}

/** Collect the .ts sources of the runtime surface (src/ + packages/*/src/). */
function collectSources(): { source: string; abs: string }[] {
  const sources: { source: string; abs: string }[] = [];
  for (const file of listFiles(join(OPENCLAW_CHECKOUT_DIR, "src"))) {
    if (file.endsWith(".ts")) {
      sources.push({ source: `src/${file}`, abs: join(OPENCLAW_CHECKOUT_DIR, "src", file) });
    }
  }
  const packagesRoot = join(OPENCLAW_CHECKOUT_DIR, "packages");
  for (const pkg of readdirSync(packagesRoot, { withFileTypes: true })) {
    if (!pkg.isDirectory()) {
      continue;
    }
    const srcRoot = join(packagesRoot, pkg.name, "src");
    if (!existsSync(srcRoot)) {
      continue;
    }
    for (const file of listFiles(srcRoot)) {
      if (file.endsWith(".ts")) {
        sources.push({
          source: `packages/${pkg.name}/src/${file}`,
          abs: join(srcRoot, file),
        });
      }
    }
  }
  return sources;
}

/**
 * The deterministic .js → .mjs import rewrite for a package's dist
 * mirror: every RELATIVE specifier ending in .js (the repo's NodeNext
 * convention pointing at a .ts sibling) becomes .mjs. Bare specifiers,
 * .json / .node / .wasm assets and absolute paths are untouched.
 */
function rewriteImportsToMjs(code: string): string {
  return code
    .replace(/(from\s+")(\.\.?\/[^"']*?)\.js(")/g, "$1$2.mjs$3")
    .replace(/(import\(\s*")(\.\.?\/[^"']*?)\.js(")/g, "$1$2.mjs$3")
    .replace(/(import\(\s*`)(\.\.?\/[^`]*?)\.js(`)/g, "$1$2.mjs$3");
}

interface BuildResult {
  readonly outputs: readonly { path: string; digest: string }[];
  readonly esbuildVersion: string;
}

async function runBuild(outRoot: string): Promise<BuildResult> {
  const esbuild: EsbuildModule = await import(
    pathToFileURL(join(OPENCLAW_CHECKOUT_DIR, "node_modules", "esbuild")).href
  );
  const sources = collectSources();
  console.log(`[build] ${sources.length} TypeScript source files (src/ + packages/*/src/)`);

  const inPlaceOutExtension = outRoot === OPENCLAW_CHECKOUT_DIR;
  // Transform every source to an in-place .js sibling (or a mirrored
  // copy under the verify root, preserving the same relative paths).
  // CHUNKED: one esbuild.build() call per batch — a single call over
  // the whole tree OOM-killed the esbuild service itself on this 4GB
  // pod (measured: killed at 3.1GB anon-rss with 13k entry points).
  const BATCH_SIZE = 300;
  for (let offset = 0; offset < sources.length; offset += BATCH_SIZE) {
    const batch = sources.slice(offset, offset + BATCH_SIZE);
    await esbuild.build({
      entryPoints: batch.map((entry) => entry.abs),
      outbase: OPENCLAW_CHECKOUT_DIR,
      outdir: inPlaceOutExtension ? OPENCLAW_CHECKOUT_DIR : outRoot,
      outExtension: { ".js": ".js" },
      bundle: false,
      format: "esm",
      platform: "node",
      target: "es2023",
      tsconfig: join(OPENCLAW_CHECKOUT_DIR, "tsconfig.json"),
      logLevel: "warning",
      sourcemap: false,
    });
  }
  const outputs: { path: string; digest: string }[] = [];
  const baseFor = (source: string) =>
    inPlaceOutExtension ? join(OPENCLAW_CHECKOUT_DIR, source) : join(outRoot, source);
  for (const source of sources) {
    const jsPath = baseFor(source.source.replace(/\.ts$/, ".js"));
    if (!existsSync(jsPath)) {
      throw new Error(`esbuild produced no output for ${source.source}`);
    }
    outputs.push({ path: source.source.replace(/\.ts$/, ".js"), digest: sha256File(jsPath) });
  }
  void result;

  // dist/*.mjs mirrors for every package (the export-map shape the
  // pinned package.json files name: ./dist/<subpath>.mjs).
  const packagesRoot = join(OPENCLAW_CHECKOUT_DIR, "packages");
  for (const pkg of readdirSync(packagesRoot, { withFileTypes: true })) {
    if (!pkg.isDirectory()) {
      continue;
    }
    const pkgName = JSON.parse(
      readFileSync(join(packagesRoot, pkg.name, "package.json"), "utf8"),
    ).name as string;
    const srcRoot = join(packagesRoot, pkg.name, "src");
    if (!existsSync(srcRoot)) {
      continue;
    }
    for (const file of listFiles(srcRoot)) {
      if (!file.endsWith(".js")) {
        continue;
      }
      const code = readFileSync(join(srcRoot, file), "utf8");
      const mirrored = rewriteImportsToMjs(code);
      const distPath = inPlaceOutExtension
        ? join(packagesRoot, pkg.name, "dist", file.replace(/\.js$/, ".mjs"))
        : join(outRoot, "packages", pkg.name, "dist", file.replace(/\.js$/, ".mjs"));
      mkdirSync(dirname(distPath), { recursive: true });
      writeFileSync(distPath, mirrored);
      outputs.push({
        path: `packages/${pkg.name}/dist/${file.replace(/\.js$/, ".mjs")}`,
        digest: sha256File(distPath),
      });
    }
    void pkgName;
  }

  // Root node_modules/@openclaw workspace symlinks for the packages the
  // root package.json does not declare (src/'s bare @openclaw/* imports
  // resolve through them). Only created in the real build (the verify
  // mirror compares file digests, not the link farm).
  if (inPlaceOutExtension) {
    const linkRoot = join(OPENCLAW_CHECKOUT_DIR, "node_modules", "@openclaw");
    mkdirSync(linkRoot, { recursive: true });
    for (const pkg of readdirSync(packagesRoot, { withFileTypes: true })) {
      if (!pkg.isDirectory()) {
        continue;
      }
      const manifest = JSON.parse(
        readFileSync(join(packagesRoot, pkg.name, "package.json"), "utf8"),
      ) as { name?: string };
      if (typeof manifest.name !== "string" || !manifest.name.startsWith("@openclaw/")) {
        continue;
      }
      const shortName = manifest.name.slice("@openclaw/".length);
      const linkPath = join(linkRoot, shortName);
      if (!existsSync(linkPath)) {
        symlinkSync(join("..", "..", "packages", pkg.name), linkPath);
      }
    }
  }

  return { outputs, esbuildVersion: esbuild.version };
}

async function main(): Promise<void> {
  const mode = process.argv[2] === "verify" ? "verify" : "build";
  if (mode === "build") {
    const started = Date.now();
    const { outputs, esbuildVersion } = await runBuild(OPENCLAW_CHECKOUT_DIR);
    const manifest = {
      builtBy: "compat/openclaw/harness/build-compiled-runtime.ts",
      esbuildVersion,
      tsconfigDigest: sha256File(join(OPENCLAW_CHECKOUT_DIR, "tsconfig.json")),
      upstreamRevision: "f6883b3771c0a40d7bd62fcb99815dcbbb2e24f3",
      outputCount: outputs.length,
      outputs,
    };
    writeFileSync(MANIFEST_PATH, `${JSON.stringify(manifest, null, 2)}\n`);
    console.log(
      `[build] ${outputs.length} outputs + manifest in ${((Date.now() - started) / 1000).toFixed(1)}s (esbuild ${esbuildVersion})`,
    );
    console.log(`[build] compiled entry: ${OPENCLAW_COMPILED_ENTRY}`);
    return;
  }

  // verify mode: rebuild into a temp mirror and prove byte-identity.
  const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8")) as {
    outputs: readonly { path: string; digest: string }[];
    esbuildVersion: string;
  };
  rmSync(VERIFY_DIR, { recursive: true, force: true });
  mkdirSync(VERIFY_DIR, { recursive: true });
  const { outputs, esbuildVersion } = await runBuild(VERIFY_DIR);
  let mismatches = 0;
  const expected = new Map(manifest.outputs.map((entry) => [entry.path, entry.digest]));
  for (const output of outputs) {
    const digest = expected.get(output.path);
    if (digest === undefined) {
      console.error(`[verify] UNEXPECTED output ${output.path}`);
      mismatches += 1;
    } else if (digest !== output.digest) {
      console.error(`[verify] DIGEST MISMATCH ${output.path}`);
      mismatches += 1;
    }
  }
  for (const [path] of expected) {
    if (!outputs.some((entry) => entry.path === path)) {
      console.error(`[verify] MISSING output ${path}`);
      mismatches += 1;
    }
  }
  if (esbuildVersion !== manifest.esbuildVersion) {
    console.error(`[verify] esbuild version drift: ${esbuildVersion} vs ${manifest.esbuildVersion}`);
    mismatches += 1;
  }
  rmSync(VERIFY_DIR, { recursive: true, force: true });
  if (mismatches > 0) {
    throw new Error(`compiled-runtime verification FAILED: ${mismatches} mismatch(es)`);
  }
  console.log(`[verify] ${outputs.length} outputs byte-identical to the manifest — OK`);
}

main().catch((error) => {
  console.error("[build-compiled-runtime] FAILED:", error);
  process.exit(1);
});

void fileURLToPath;
