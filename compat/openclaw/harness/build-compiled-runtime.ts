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
 *  1. transforms every .ts under src/ and packages/<pkg>/src/ to an
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
 *  1a. rewrites every RELATIVE specifier that still LITERALLY names a
 *     `.ts` target (from-clauses, side-effect imports, dynamic
 *     import()/require() with static strings or static template
 *     literals, incl. `?query` forms) to the compiled `.js` sibling —
 *     measured on the pinned tree, 178 compiled outputs carried 290
 *     such specifiers (241 from-clauses incl. 88 in non-test runtime
 *     files, 33 dynamic imports, 12 side-effect imports, 4 ?query
 *     forms); without this rewrite they resolve to the SOURCE .ts
 *     files, which the compiled execution path (plain node, no TS
 *     loader) refuses to load. `.d.ts` references, bare/absolute
 *     specifiers and interpolated template literals are untouched
 *     (the interpolation and `new URL(...)`/`import.meta.resolve` forms
 *     occur only in the repo's vitest-only test files — surveyed, and
 *     vitest transforms the SOURCES itself, so the compiled test
 *     outputs are inert there; the rewrite is uniform and harmless);
 *  1b. re-injects the `with { type: "json" }` import attribute on
 *     every STATIC import/export-from statement whose specifier ends
 *     in `.json` and whose statement ends immediately after the
 *     specifier (semicolon or newline — an existing attribute, or a
 *     template interpolation in the way, leaves it untouched) —
 *     measured on the pinned tree, esbuild's transform DROPS the
 *     attribute from some outputs (scripts/*.mjs outputs and several
 *     src/plugins/*.js outputs lost what their .ts/.mts sources
 *     carry, while src/infra/host-env-security-policy.js kept it —
 *     inconsistent, so the fix is this deterministic post-pass, not
 *     an esbuild option). Plain-node ESM refuses attribute-less
 *     .json imports (ERR_IMPORT_ATTRIBUTE_MISSING), and the runtime
 *     surface DOES import .json at module scope (surveyed: e.g.
 *     src/plugins/native-session-catalog-config.js imports
 *     scripts/lib/native-session-catalogs.json). Side-effect and
 *     dynamic forms are handled too although the pinned tree's
 *     runtime surface carries none (surveyed: zero in src/, in
 *     scripts/ and across the packages' src trees);
 *  2. mirrors each package's compiled src to dist/**.mjs (the exact
 *     paths the pinned packages' package.json exports maps name) with
 *     a deterministic relative-import `.js` → `.mjs` rewrite;
 *  3. adds the root node_modules/@openclaw/<pkg> workspace symlinks the
 *     source-run received from tsconfig paths (the root package.json
 *     only declares five of them; src/'s bare @openclaw/* imports
 *     resolve through these links to the packages' dist outputs);
 *     packages whose export maps name SOURCE .ts files get their link
 *     repointed at a generated shim package instead (step 2b);
 *  2b. closes every package's export map against the compiled tree:
 *     dist targets the identity mirror missed (tsdown's utils→top-level
 *     flattening: @openclaw/ai's ./diagnostics, ./event-stream) become
 *     dist-internal symlinks; source-.ts export targets (ALL of
 *     @openclaw/session-url-contract, all subpaths of
 *     @openclaw/plugin-sdk) become a generated shim package under
 *     .zeck-build/shims/<pkg>/ whose package.json maps each subpath to
 *     a symlink of the compiled sibling, with the root
 *     node_modules/@openclaw/<pkg> link repointed at the shim;
 *  0. never writes onto a git-TRACKED path (measured: the pinned tree
 *     checks in 42 scripts/*.mjs tsx-cli shims + scripts/ui.js beside
 *     their sources, plus a couple of src/*.js deploy artifacts) —
 *     sources whose compiled output path is tracked are skipped (the
 *     tracked file is the exact surface the source-run resolved);
 *  4. writes a digest manifest (sha256 of every produced file + the
 *     esbuild version + the pinned tsconfig digest) so the battery can
 *     re-verify byte-identity of the compiled tree it runs.
 *
 * Run: bun run compat/openclaw/harness/build-compiled-runtime.ts [verify]
 *      (verify = rebuild into a temp mirror and prove byte-identity)
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { OPENCLAW_CHECKOUT_DIR } from "./corpus-runner";

/**
 * The esbuild module shape this builder uses (dynamically imported from
 * the PINNED CHECKOUT'S OWN node_modules — esbuild is the checkout's own
 * transpile engine, not a dependency of this repository; the local shape
 * keeps the builder typecheck-clean against this repo's tsconfig).
 */
interface EsbuildModule {
  readonly version: string;
  build(options: {
    entryPoints: readonly string[];
    outbase: string;
    outdir: string;
    outExtension?: { readonly ".js": string };
    bundle: boolean;
    format: string;
    platform: string;
    target: string;
    tsconfig: string;
    logLevel: string;
    sourcemap: boolean;
  }): Promise<unknown>;
}

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

/**
 * Collect the TypeScript sources of the runtime surface: `.ts` and
 * `.mts` (declaration `.d.*` files excluded) under src/,
 * packages/<pkg>/src/ AND scripts/ — the repo's runtime modules
 * import from scripts/lib (e.g. gateway worker-environments imports
 * scripts/lib/package-bundled-mcp.mjs — which has ONLY a .mts source:
 * the repo's own deploy build compiles it; the source-run path let
 * tsx map the specifier; plain node finds NO file there, so the
 * compiled tree must carry the compiled sibling).
 */
interface SourceFile {
  readonly source: string;
  readonly abs: string;
}

function isDeclaration(file: string): boolean {
  return /\.d\.(ts|mts|cts)$/.test(file);
}

/** Recursively list files under a directory (relative paths), pruning the named subdirectories. */
function listFilesPruned(root: string, prune: readonly string[]): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (prune.includes(entry.name)) {
          continue;
        }
        walk(full);
      } else if (entry.isFile()) {
        out.push(relative(root, full));
      }
    }
  };
  walk(root);
  return out.sort();
}

/**
 * Tracked paths of the pinned checkout (`git ls-files`). Sources whose
 * compiled output would land on a TRACKED path are SKIPPED: the pinned
 * tree checks in its own resolution surface at some of those paths —
 * measured: 42 scripts/*.mjs tsx-cli shims + scripts/ui.js, each
 * delegating to its .mts/.ts source through the repo's own tsx loader,
 * plus a couple of src/*.js deploy artifacts — and overwriting tracked
 * files would modify the pinned revision. The consumers of those
 * tracked shims are the repo's CI entrypoints (never imported by the
 * runtime surface); scripts/lib/package-bundled-mcp.mts — the one
 * .mts the runtime DOES import by its literal .mjs path — has NO
 * tracked sibling (verified: untracked), so it still compiles.
 */
function trackedCheckoutPaths(): Set<string> {
  const result = spawnSync("git", ["-C", OPENCLAW_CHECKOUT_DIR, "ls-files"], {
    encoding: "utf8",
    maxBuffer: 128 * 1024 * 1024,
  });
  if (result.status !== 0 || typeof result.stdout !== "string") {
    throw new Error(
      `git ls-files failed in the pinned checkout (status ${String(result.status)}): ${String(result.stderr)}`,
    );
  }
  return new Set(result.stdout.split("\n").filter((line) => line.length > 0));
}

/** The compiled output path of a source: .ts → .js sibling, .mts → .mjs. */
function compiledPathOf(source: string): string {
  return source.endsWith(".mts") ? source.replace(/\.mts$/, ".mjs") : source.replace(/\.ts$/, ".js");
}

function collectAllSources(): {
  tsSources: SourceFile[];
  mtsSources: SourceFile[];
  skippedTrackedOutputs: string[];
} {
  const tsSources: SourceFile[] = [];
  const mtsSources: SourceFile[] = [];
  const skippedTrackedOutputs: string[] = [];
  const tracked = trackedCheckoutPaths();
  const roots: { root: string; prefix: string }[] = [
    { root: join(OPENCLAW_CHECKOUT_DIR, "src"), prefix: "src" },
    { root: join(OPENCLAW_CHECKOUT_DIR, "scripts"), prefix: "scripts" },
  ];
  const packagesRoot = join(OPENCLAW_CHECKOUT_DIR, "packages");
  for (const pkg of readdirSync(packagesRoot, { withFileTypes: true })) {
    if (pkg.isDirectory()) {
      const srcRoot = join(packagesRoot, pkg.name, "src");
      if (existsSync(srcRoot)) {
        roots.push({ root: srcRoot, prefix: `packages/${pkg.name}/src` });
      }
    }
  }
  for (const { root, prefix } of roots) {
    for (const file of listFiles(root)) {
      if (isDeclaration(file)) {
        continue;
      }
      if (file.endsWith(".ts") || file.endsWith(".mts")) {
        const source = `${prefix}/${file}`;
        if (tracked.has(compiledPathOf(source))) {
          skippedTrackedOutputs.push(compiledPathOf(source));
          continue;
        }
        if (file.endsWith(".ts")) {
          tsSources.push({ source, abs: join(root, file) });
        } else {
          mtsSources.push({ source, abs: join(root, file) });
        }
      }
    }
  }
  return { tsSources, mtsSources, skippedTrackedOutputs };
}

/**
 * The literal-`.ts`/`.mts` specifier rewrite (build step 1a): the
 * repo's NodeNext convention writes `./x.js` for a `./x.ts` sibling,
 * but 178 compiled outputs of the pinned tree still carry specifiers
 * that LITERALLY name the `.ts` file (and runtime modules import
 * scripts/lib helpers by their literal `.mts` path). Each pattern
 * family matches exactly one relative specifier span in a syntactic
 * import/export/require position (never object keys — a `from:` colon
 * breaks the match — and never bare/absolute paths); the replacer
 * swaps only the trailing extension (preserving any `?query`),
 * leaving `.d.ts`/`.d.mts` references (lookbehind) untouched. Forms:
 * from-clauses (single/double/backtick quote), side-effect
 * import/export, dynamic import()/require() with static strings, and
 * static template literals (no `${` interpolation — surveyed: none
 * in the runtime surface).
 */
function literalSpecifierPatterns(fromExt: ".ts" | ".mts"): readonly RegExp[] {
  const toExt = fromExt === ".ts" ? ".js" : ".mjs";
  return [
    // import x from "./a.<ext>" / export ... from "./a.<ext>" (incl. ?query)
    new RegExp(`([\\s;}\\n]|^)from(\\s*)(["'])(\\.\\.?\\/[^"']*?)(?<!\\.d)\\${fromExt}(\\?[^"']*)?\\3`, "gm"),
    // side-effect import "./a.<ext>" / export "./a.<ext>" (incl. ?query)
    new RegExp(`([\\s;}\\n]|^)(import|export)(\\s*)(["'])(\\.\\.?\\/[^"']*?)(?<!\\.d)\\${fromExt}(\\?[^"']*)?\\4`, "gm"),
    // dynamic import("./a.<ext>") / require("./a.<ext>") (incl. ?query)
    new RegExp(`(\\b(?:import|require)\\s*\\(\\s*)(["'])(\\.\\.?\\/[^"']*?)(?<!\\.d)\\${fromExt}(\\?[^"']*)?\\2(\\s*\\))`, "g"),
    // dynamic import(`./a.<ext>`) with a static template literal
    new RegExp(`(\\b(?:import|require)\\s*\\(\\s*)(\`)(\\.\\.?\\/[^\`]*?)(?<!\\.d)\\${fromExt}(\\?[^\`]*)?\\2(\\s*\\))`, "g"),
    // from `./a.<ext>` (rare backticked from-clause)
    new RegExp(`([\\s;}\\n]|^)from(\\s*)(\`)(\\.\\.?\\/[^\`]*?)(?<!\\.d)\\${fromExt}(\\?[^\`]*)?\\3`, "gm"),
  ].map((pattern) => {
    // The swap target rides along on the pattern object so the
    // replacer knows the output extension without re-deriving it.
    return Object.assign(pattern, { zeckRewriteTo: toExt });
  }) as unknown as readonly RegExp[];
}

interface RewritePattern extends RegExp {
  readonly zeckRewriteTo: string;
}

const LITERAL_TS_SPECIFIER_PATTERNS: readonly RewritePattern[] = [
  ...literalSpecifierPatterns(".ts"),
  ...literalSpecifierPatterns(".mts"),
] as unknown as readonly RewritePattern[];

/**
 * Applies the literal-`.ts`/`.mts` rewrite to one compiled output.
 * Returns the rewritten code and the number of specifier rewrites
 * applied, split by source extension for the manifest record.
 */
function rewriteLiteralTsSpecifiers(code: string): {
  code: string;
  rewrites: number;
  mtsRewrites: number;
} {
  let rewrites = 0;
  let mtsRewrites = 0;
  let out = code;
  for (const pattern of LITERAL_TS_SPECIFIER_PATTERNS) {
    out = out.replace(pattern, (match) => {
      rewrites += 1;
      if (pattern.zeckRewriteTo === ".mjs") {
        mtsRewrites += 1;
      }
      // The span contains exactly one relative TypeScript specifier;
      // swap only its trailing extension (right before the `?query` or
      // the closing quote) so original spacing and quoting survive.
      const fromExt = pattern.zeckRewriteTo === ".mjs" ? ".mts" : ".ts";
      return match.replace(
        new RegExp(`(?<!\\.d)\\${fromExt}(?=[?"'\`]|$)`),
        pattern.zeckRewriteTo,
      );
    });
  }
  return { code: out, rewrites, mtsRewrites };
}

/**
 * The deterministic .js → .mjs import rewrite for a package's dist
 * mirror: every RELATIVE specifier ending in .js (the repo's NodeNext
 * convention pointing at a .ts sibling) becomes .mjs — but ONLY when
 * the specifier resolves INSIDE the package's dist root. Cross-package
 * relative imports (measured: e.g. packages/model-catalog-core's
 * model-catalog-types.ts imports ../../llm-core/src/model-data.js) —
 * which necessarily escape the dist root — point into the OTHER
 * package's compiled src surface (a .js sibling), so they keep their
 * .js extension. Bare specifiers, .json / .node / .wasm assets and
 * absolute paths are untouched.
 */
function rewriteImportsToMjs(code: string, distDir: string, pkgDistRoot: string): string {
  // NOTE: the regexes below CONSUME the trailing `.js` — the captured
  // specifier arrives WITHOUT its extension, so the replacer re-appends
  // the correct one (.mjs in-package, .js cross-package).
  const mjsFor = (specifierBase: string): string => {
    const resolvedFromDist = resolve(distDir, `${specifierBase}.js`);
    const rel = relative(pkgDistRoot, resolvedFromDist);
    if (rel.startsWith("..") || isAbsolute(rel)) {
      return `${specifierBase}.js`;
    }
    return `${specifierBase}.mjs`;
  };
  return code
    .replace(/(from\s+")(\.\.?\/[^"']*?)\.js(")/g, (_match, pre: string, spec: string, post: string) => `${pre}${mjsFor(spec)}${post}`)
    .replace(/(from\s+')(\.\.?\/[^']*?)\.js(')/g, (_match, pre: string, spec: string, post: string) => `${pre}${mjsFor(spec)}${post}`)
    .replace(/(import\(\s*")(\.\.?\/[^"']*?)\.js(")/g, (_match, pre: string, spec: string, post: string) => `${pre}${mjsFor(spec)}${post}`)
    .replace(/(import\(\s*')(\.\.?\/[^']*?)\.js(')/g, (_match, pre: string, spec: string, post: string) => `${pre}${mjsFor(spec)}${post}`)
    .replace(/(import\(\s*`)(\.\.?\/[^`]*?)\.js(`)/g, (_match, pre: string, spec: string, post: string) => `${pre}${mjsFor(spec)}${post}`);
}

/**
 * Build step 1b: JSON import-attribute injection. The statement-end
 * lookahead (`;` or newline immediately after the specifier's closing
 * quote) is the safety property: an existing attribute (`with`/`assert`
 * follows) and a template interpolation (the vitest codegen templates
 * whose `./data.json` specifiers are followed by `${`) both fail it,
 * so only genuinely attribute-less statements are touched. Relative
 * AND bare specifiers are covered (plain node requires the attribute
 * for both); `.json.js`-style endings cannot match (the quote must
 * directly follow `.json`).
 */
function injectJsonImportAttributes(code: string): { code: string; injections: number } {
  let injections = 0;
  let out = code;
  const forms: RegExp[] = [
    // import <clause> from "./a.json" / export <clause> from "./a.json"
    // (default, named, namespace, re-export — all carry the `from` token)
    /(from\s*)(["'])([^"']*\.json)\2(?=\s*[;\n])/g,
    // side-effect import "./a.json" (the `(` of a dynamic import
    // cannot follow `import\s*` here, so this form is static-only)
    /(\bimport\s*)(["'])([^"']*\.json)\2(?=\s*[;\n])/g,
  ];
  for (const form of forms) {
    out = out.replace(form, (match, prefix: string, quote: string, specifier: string) => {
      if (!specifier.endsWith(".json")) {
        return match;
      }
      injections += 1;
      return `${prefix}${quote}${specifier}${quote} with { type: "json" }`;
    });
  }
  return { code: out, injections };
}

interface BuildResult {
  readonly outputs: readonly { path: string; digest: string }[];
  readonly esbuildVersion: string;
  readonly literalTsRewrites: number;
  readonly literalMtsRewrites: number;
  readonly literalTsFilesRewritten: number;
  readonly jsonAttributeInjections: number;
  readonly jsonAttributeFiles: number;
  readonly skippedTrackedOutputs: string[];
  readonly exportDistLinks: string[];
  readonly exportShims: readonly {
    readonly pkg: string;
    readonly entries: readonly { readonly subpath: string; readonly file: string; readonly source: string }[];
  }[];
}

/**
 * The runtime-relevant target of one exports entry (node's condition
 * order for a plain import: "import" then "default"; nested "node"
 * objects and bare strings included; "types" never selected).
 */
function runtimeExportTarget(entry: unknown): string | undefined {
  if (typeof entry === "string") {
    return entry;
  }
  if (entry === null || typeof entry !== "object") {
    return undefined;
  }
  const conditions = entry as Record<string, unknown>;
  for (const key of ["import", "default", "node", "require"]) {
    const value = conditions[key];
    if (typeof value === "string") {
      return value;
    }
    if (typeof value === "object" && value !== null) {
      const nested = runtimeExportTarget(value);
      if (nested !== undefined) {
        return nested;
      }
    }
  }
  return undefined;
}

async function runBuild(outRoot: string): Promise<BuildResult> {
  const esbuild: EsbuildModule = await import(
    pathToFileURL(join(OPENCLAW_CHECKOUT_DIR, "node_modules", "esbuild")).href
  );
  const { tsSources, mtsSources, skippedTrackedOutputs } = collectAllSources();
  console.log(
    `[build] ${tsSources.length} .ts + ${mtsSources.length} .mts source files (src/ + packages/*/src/ + scripts/) — ${skippedTrackedOutputs.length} source(s) skipped: their compiled output path is a TRACKED file (the pinned tree's own shims/artifacts)`,
  );

  const inPlaceOutExtension = outRoot === OPENCLAW_CHECKOUT_DIR;
  // Transform every .ts source to an in-place .js sibling (or a mirrored
  // copy under the verify root, preserving the same relative paths) and
  // every .mts source to its .mjs sibling (esbuild's default .mts → .mjs
  // output mapping — no outExtension override on that pass, which would
  // force .js and break the importers' literal .mjs specifiers).
  // CHUNKED: one esbuild.build() call per batch — a single call over
  // the whole tree OOM-killed the esbuild service itself on this 4GB
  // pod (measured: killed at 3.1GB anon-rss with 13k entry points).
  const BATCH_SIZE = 300;
  for (let offset = 0; offset < tsSources.length; offset += BATCH_SIZE) {
    const batch = tsSources.slice(offset, offset + BATCH_SIZE);
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
  for (let offset = 0; offset < mtsSources.length; offset += BATCH_SIZE) {
    const batch = mtsSources.slice(offset, offset + BATCH_SIZE);
    await esbuild.build({
      entryPoints: batch.map((entry) => entry.abs),
      outbase: OPENCLAW_CHECKOUT_DIR,
      outdir: inPlaceOutExtension ? OPENCLAW_CHECKOUT_DIR : outRoot,
      // NOTE: esbuild 0.28.2 in entry-points mode maps .mts inputs to
      // .js outputs (verified live); the importers' literal specifiers
      // say .mjs, so the extension is forced here (verified live:
      // package-bundled-mcp.mts -> package-bundled-mcp.mjs).
      outExtension: { ".js": ".mjs" },
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
  // The compiled output path of a source: .ts → .js sibling, .mts → .mjs.
  const outputPathOf = (source: string) => compiledPathOf(source);
  const allSources = [...tsSources, ...mtsSources];

  // Build step 1a: rewrite every literal `.ts`/`.mts` specifier in the
  // freshly compiled outputs to its `.js`/`.mjs` form — BEFORE digest
  // collection (so the manifest covers final bytes) and before the dist
  // mirrors (so they inherit the fix through their own .js → .mjs
  // pass). Only files that actually change are written back.
  let literalTsRewrites = 0;
  let literalMtsRewrites = 0;
  let literalTsFilesRewritten = 0;
  for (const source of allSources) {
    const jsPath = baseFor(outputPathOf(source.source));
    if (!existsSync(jsPath)) {
      throw new Error(`esbuild produced no output for ${source.source}`);
    }
    const original = readFileSync(jsPath, "utf8");
    const { code, rewrites, mtsRewrites } = rewriteLiteralTsSpecifiers(original);
    if (rewrites > 0) {
      writeFileSync(jsPath, code);
      literalTsRewrites += rewrites;
      literalMtsRewrites += mtsRewrites;
      literalTsFilesRewritten += 1;
    }
  }
  console.log(
    `[build] literal .ts/.mts specifier rewrite: ${literalTsRewrites} specifier(s) (${literalMtsRewrites} .mts) across ${literalTsFilesRewritten} output file(s)`,
  );

  // Build step 1b: JSON import-attribute injection (see the header's
  // step 1b note). Applied AFTER the literal-.ts rewrite and BEFORE
  // digest collection, over the same output set; only files that
  // actually change are written back.
  let jsonAttributeInjections = 0;
  let jsonAttributeFiles = 0;
  for (const source of allSources) {
    const jsPath = baseFor(outputPathOf(source.source));
    const original = readFileSync(jsPath, "utf8");
    const { code, injections } = injectJsonImportAttributes(original);
    if (injections > 0) {
      writeFileSync(jsPath, code);
      jsonAttributeInjections += injections;
      jsonAttributeFiles += 1;
    }
  }
  console.log(
    `[build] JSON import-attribute injection: ${jsonAttributeInjections} statement(s) across ${jsonAttributeFiles} output file(s)`,
  );

  for (const source of allSources) {
    const jsPath = baseFor(outputPathOf(source.source));
    if (!existsSync(jsPath)) {
      throw new Error(`esbuild produced no output for ${source.source}`);
    }
    outputs.push({ path: outputPathOf(source.source), digest: sha256File(jsPath) });
  }

  // dist/*.mjs mirrors for every package (the export-map shape the
  // pinned package.json files name: ./dist/<subpath>.mjs).
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
      if (!file.endsWith(".js")) {
        continue;
      }
      const code = readFileSync(join(srcRoot, file), "utf8");
      const distPath = inPlaceOutExtension
        ? join(packagesRoot, pkg.name, "dist", file.replace(/\.js$/, ".mjs"))
        : join(outRoot, "packages", pkg.name, "dist", file.replace(/\.js$/, ".mjs"));
      const pkgDistRoot = inPlaceOutExtension
        ? join(packagesRoot, pkg.name, "dist")
        : join(outRoot, "packages", pkg.name, "dist");
      const mirrored = rewriteImportsToMjs(code, dirname(distPath), pkgDistRoot);
      mkdirSync(dirname(distPath), { recursive: true });
      writeFileSync(distPath, mirrored);
      outputs.push({
        path: `packages/${pkg.name}/dist/${file.replace(/\.js$/, ".mjs")}`,
        digest: sha256File(distPath),
      });
    }
  }

  // Build step 2b: close every package's export map against the compiled
  // tree. Two gap classes (both measured on the pinned tree):
  //  (a) exports naming ./dist/<name>.mjs where the identity mirror
  //      produced ./dist/<dir>/<name>.mjs (the repo's own tsdown build
  //      flattens some utils/ sources to top-level entries —
  //      @openclaw/ai's ./diagnostics and ./event-stream, per
  //      tsdown.ai.config.ts): closed with a dist-internal symlink at
  //      the exports-named path pointing at the identity-mirrored file
  //      (digest recorded through the link);
  //  (b) exports pointing at SOURCE .ts files (the workspace-dev form —
  //      ALL of @openclaw/session-url-contract and all ~50 subpaths of
  //      @openclaw/plugin-sdk): plain node cannot load them without the
  //      repo's tsx loader. Closed with a generated SHIM package
  //      (untracked, under .zeck-build/shims/<pkg>/) whose package.json
  //      maps every subpath to a symlink of the compiled sibling, and
  //      the root node_modules/@openclaw/<pkg> link is repointed at the
  //      shim. Load-bearing, not hypothetical: packages/sdk imports
  //      @openclaw/session-url-contract/session-key-normalization
  //      (packages/sdk/src/replay-scope.ts), and packages/sdk is
  //      runtime-reachable through @openclaw/sdk's dist mirror.
  const exportDistLinks: string[] = [];
  const exportShims: { pkg: string; entries: { subpath: string; file: string; source: string }[] }[] = [];
  for (const pkg of readdirSync(packagesRoot, { withFileTypes: true })) {
    if (!pkg.isDirectory()) {
      continue;
    }
    const pkgDir = inPlaceOutExtension
      ? join(packagesRoot, pkg.name)
      : join(outRoot, "packages", pkg.name);
    // The package.json is read from the CHECKOUT (source of truth): the
    // verify mirror carries only compiled outputs, no manifests.
    const pkgJsonPath = join(packagesRoot, pkg.name, "package.json");
    if (!existsSync(join(pkgDir, "src")) || !existsSync(pkgJsonPath)) {
      continue;
    }
    const pkgJson = JSON.parse(readFileSync(pkgJsonPath, "utf8")) as {
      name?: string;
      exports?: unknown;
    };
    if (pkgJson.exports === undefined || typeof pkgJson.name !== "string") {
      continue;
    }
    const exportEntries: [string, unknown][] =
      typeof pkgJson.exports === "string"
        ? [[".", pkgJson.exports]]
        : Array.isArray(pkgJson.exports)
          ? [[".", pkgJson.exports]]
          : Object.entries(pkgJson.exports as Record<string, unknown>);
    const shimEntries: { subpath: string; file: string; source: string }[] = [];
    for (const [subpath, entry] of exportEntries) {
      const target = runtimeExportTarget(entry);
      if (target === undefined || !target.startsWith("./")) {
        continue;
      }
      if (/\.(ts|mts)$/.test(target)) {
        // Gap class (b): the export names a SOURCE file — the shim maps
        // the subpath to the compiled sibling (fail-closed: the compiled
        // sibling must exist and must NOT be a tracked file, which the
        // skip policy would have left as the upstream's own surface).
        const sourceRel = target.replace(/^\.\//, "");
        const compiledRel = compiledPathOf(sourceRel);
        const compiledAbs = join(pkgDir, compiledRel);
        if (!existsSync(compiledAbs)) {
          throw new Error(
            `cannot close ${pkgJson.name}${subpath === "." ? "" : subpath}: compiled sibling ${compiledRel} is missing`,
          );
        }
        const shimName =
          (subpath === "." ? "index" : subpath.replace(/^\.\//, "")).replace(/\//g, "__");
        shimEntries.push({
          subpath,
          file: `${shimName}.mjs`,
          source: `packages/${pkg.name}/${compiledRel}`,
        });
      } else if (target.startsWith("./dist/") && target.endsWith(".mjs")) {
        // Gap class (a): the export names a dist path — the identity
        // mirror may hold it under a different directory (tsdown's
        // flattening). Fail-closed on ambiguity: exactly one compiled
        // source with that basename must exist. A REAL file at the
        // export path (identity mirror) already closes the export; a
        // SYMLINK there is this build's own previous output — recreate
        // and re-record it (idempotent rebuilds keep the manifest
        // entry).
        const distAbs = join(pkgDir, target.replace(/^\.\//, ""));
        if (existsSync(distAbs) && !lstatSync(distAbs).isSymbolicLink()) {
          continue;
        }
        const wanted = basename(target, ".mjs");
        const srcRoot = join(pkgDir, "src");
        const candidates = listFiles(srcRoot).filter(
          (file) => basename(file, ".js") === wanted && !file.endsWith(".test.js"),
        );
        if (candidates.length !== 1) {
          throw new Error(
            `cannot close ${pkgJson.name}${subpath}: ${candidates.length} candidate source(s) named ${wanted}.ts under src/`,
          );
        }
        const candidate = candidates[0];
        if (candidate === undefined) {
          throw new Error(
            `cannot close ${pkgJson.name}${subpath}: no candidate source named ${wanted}.ts under src/`,
          );
        }
        const mirrorRel = candidate.replace(/\.js$/, ".mjs");
        const mirrorAbs = join(pkgDir, "dist", mirrorRel);
        if (!existsSync(mirrorAbs)) {
          throw new Error(
            `cannot close ${pkgJson.name}${subpath}: identity mirror ${mirrorRel} is missing`,
          );
        }
        rmSync(distAbs, { force: true });
        symlinkSync(relative(dirname(distAbs), mirrorAbs), distAbs);
        exportDistLinks.push(`packages/${pkg.name}/${target.replace(/^\.\//, "")}`);
        outputs.push({
          path: `packages/${pkg.name}/${target.replace(/^\.\//, "")}`,
          digest: sha256File(distAbs),
        });
      }
    }
    if (shimEntries.length > 0) {
      // Both the real build and the verify mirror materialize the shim
      // (the mirror's shims point at the mirror's compiled siblings; the
      // digest of the shim package.json is recorded so verify re-proves
      // it); only the real build repoints node_modules.
      const shimRoot = inPlaceOutExtension ? OPENCLAW_CHECKOUT_DIR : outRoot;
      const shimDir = join(shimRoot, ".zeck-build", "shims", pkg.name);
      rmSync(shimDir, { recursive: true, force: true });
      mkdirSync(shimDir, { recursive: true });
      const shimExports: Record<string, string> = {};
      for (const shimEntry of shimEntries) {
        const targetAbs = join(
          inPlaceOutExtension ? OPENCLAW_CHECKOUT_DIR : outRoot,
          shimEntry.source,
        );
        symlinkSync(relative(shimDir, targetAbs), join(shimDir, shimEntry.file));
        shimExports[shimEntry.subpath] = `./${shimEntry.file}`;
      }
      const shimJson = `${JSON.stringify(
        { name: pkgJson.name, type: "module", exports: shimExports },
        null,
        2,
      )}\n`;
      writeFileSync(join(shimDir, "package.json"), shimJson);
      exportShims.push({ pkg: pkg.name, entries: shimEntries });
      outputs.push({
        path: `.zeck-build/shims/${pkg.name}/package.json`,
        digest: sha256Of(shimJson),
      });
      if (inPlaceOutExtension) {
        // Repoint the root node_modules/@openclaw/<pkg> link at the shim
        // (overriding pnpm's workspace link for root-declared packages
        // too — node_modules is untracked build state either way).
        const shortName = pkgJson.name.slice("@openclaw/".length);
        const linkPath = join(OPENCLAW_CHECKOUT_DIR, "node_modules", "@openclaw", shortName);
        rmSync(linkPath, { recursive: true, force: true });
        symlinkSync(shimDir, linkPath);
      }
    }
  }
  console.log(
    `[build] export-map closure: ${exportDistLinks.length} dist link(s), ${exportShims.length} shim package(s) (${exportShims.reduce((sum, shim) => sum + shim.entries.length, 0)} subpath entries)`,
  );

  // ------------------------------------------------------------------
  // Build step 2c: the ROOT deploy surface. Two facts force this:
  //  (a) src/ SELF-REFERENCES the root package by name (`import ...
  //      from "openclaw/plugin-sdk/reply-payload"` — measured live: the
  //      corpus's very first canary and agent-exec run died with
  //      "Cannot find module .../dist/plugin-sdk/reply-payload.js
  //      imported from .../src/auto-reply/reply/streaming-directives.js";
  //      the root package.json exports map routes ./plugin-sdk/* (347
  //      entries) and ./ + ./cli-entry at ./dist/*.js — a root dist tree
  //      the source checkout does not carry);
  //  (b) the corpus's media/TTS/image provider and the browser tool ARE
  //      bundled extensions (extensions/openai, extensions/browser —
  //      measured: with bundled plugins disabled, infer tts convert
  //      fails "openai: no provider registered"; and with the STOCK
  //      source-checkout discovery, the legacy extensions/ scan loads
  //      all 159 source plugins and the agent run dies "Plugin
  //      amazon-bedrock is retiring").
  //
  // Produced here:
  //  - dist/*.js SYMLINKS of the compiled src siblings for every root
  //    export entry (./ → dist/index.js, ./cli-entry, all 347
  //    ./plugin-sdk/*) — all untracked (dist/ is .gitignore'd);
  //  - extensions/.zeck-bundled/<name>/ STAGED BUILT EXTENSIONS for the
  //    corpus surface's needs (openai: the media/TTS providers; browser:
  //    the browser tool) — compiled from extensions/<name>/ with the
  //    SAME rewrites (1a/1b), manifests as real files (the plugin path
  //    guard rejects symlinked manifests), package.json gaining
  //    openclaw.runtimeExtensions ("./index.js"), node_modules
  //    symlinked to the source extension's own pnpm install. The
  //    certified runtime selects this tree through the app's OWN
  //    documented env axis OPENCLAW_BUNDLED_PLUGINS_DIR (the corpus
  //    env): the override is trusted (realpath inside the extensions
  //    bundled root, usable tree) and — because the path carries no
  //    dist/extensions marker — resolveBundledSourceCheckoutExtensionsDir
  //    finds NO legacy source root, so the 159-plugin source scan never
  //    runs: ONLY the two staged built plugins load, as compiled
  //    JavaScript (no source capture, no tsx loader);
  //  - extensions/.zeck-bundled/node_modules/openclaw/ — the ALIAS
  //    PACKAGE the repo's own stage-bundled-plugin-runtime.mts stages:
  //    wrapper modules over dist/plugin-sdk/*.js, so the staged
  //    extensions' `openclaw/plugin-sdk/*` imports resolve (discovery
  //    skips node_modules dirs — SCANNED_DIRECTORY_IGNORE_NAMES — so
  //    the alias is never itself discovered as a plugin).
  // ------------------------------------------------------------------
  const outBase = inPlaceOutExtension ? OPENCLAW_CHECKOUT_DIR : outRoot;
  const rootPkgJson = JSON.parse(
    readFileSync(join(OPENCLAW_CHECKOUT_DIR, "package.json"), "utf8"),
  ) as { exports?: unknown };
  const rootExportEntries: [string, unknown][] =
    typeof rootPkgJson.exports === "object" &&
    rootPkgJson.exports !== null &&
    !Array.isArray(rootPkgJson.exports)
      ? Object.entries(rootPkgJson.exports as Record<string, unknown>)
      : [];
  const rootPluginSdkNames: string[] = [];
  for (const [subpath, entry] of rootExportEntries) {
    const target = runtimeExportTarget(entry);
    if (target === undefined || !target.startsWith("./dist/") || !target.endsWith(".js")) {
      continue;
    }
    const distAbs = join(outBase, target.slice(2));
    const srcRel = `src/${target.slice("./dist/".length).replace(/\.js$/, ".ts")}`;
    const srcAbs = join(outBase, srcRel);
    if (!existsSync(srcAbs)) {
      // Some exports may name a source that does not exist in this
      // checkout (generated at publish time) — skip honestly rather
      // than guess; the runtime surfaces that need them fail loudly.
      console.log(`[build] root export ${subpath} has no src sibling (${srcRel}) — skipped`);
      continue;
    }
    mkdirSync(dirname(distAbs), { recursive: true });
    rmSync(distAbs, { force: true });
    symlinkSync(relative(dirname(distAbs), srcAbs), distAbs);
    outputs.push({ path: target.slice(2), digest: sha256File(distAbs) });
    if (subpath.startsWith("./plugin-sdk/")) {
      rootPluginSdkNames.push(subpath.slice("./plugin-sdk/".length));
    }
  }

  // The staged built extensions (compiled with the same engine + the
  // same post-passes as the main tree).
  const STAGED_EXTENSIONS: readonly { name: string; reason: string }[] = [
    { name: "openai", reason: "media-understanding/TTS/image providers (infer surfaces)" },
    { name: "browser", reason: "the browser tool (the corpus's browser rail)" },
  ];
  const stagedExtensionFiles: string[] = [];
  for (const staged of STAGED_EXTENSIONS) {
    const srcExtRoot = join(OPENCLAW_CHECKOUT_DIR, "extensions", staged.name);
    if (!existsSync(srcExtRoot)) {
      throw new Error(`cannot stage extension ${staged.name}: ${srcExtRoot} is missing`);
    }
    const stagedExtDir = join(outBase, "extensions", ".zeck-bundled", staged.name);
    rmSync(stagedExtDir, { recursive: true, force: true });
    mkdirSync(stagedExtDir, { recursive: true });

    // Compile every .ts/.mts under the extension (pruning node_modules),
    // outbase = the extension root so relative structure is preserved.
    const extTs: string[] = [];
    const extMts: string[] = [];
    for (const file of listFilesPruned(srcExtRoot, ["node_modules"])) {
      if (isDeclaration(file)) {
        continue;
      }
      if (file.endsWith(".ts")) {
        extTs.push(file);
      } else if (file.endsWith(".mts")) {
        extMts.push(file);
      }
    }
    for (const [sources, ext] of [
      [extTs, ".js"],
      [extMts, ".mjs"],
    ] as const) {
      for (let offset = 0; offset < sources.length; offset += BATCH_SIZE) {
        const batch = sources.slice(offset, offset + BATCH_SIZE);
        await esbuild.build({
          entryPoints: batch.map((file) => join(srcExtRoot, file)),
          outbase: srcExtRoot,
          outdir: stagedExtDir,
          outExtension: { ".js": ext },
          bundle: false,
          format: "esm",
          platform: "node",
          target: "es2023",
          tsconfig: join(OPENCLAW_CHECKOUT_DIR, "tsconfig.json"),
          logLevel: "warning",
          sourcemap: false,
        });
      }
    }
    // Post-passes 1a/1b over the staged outputs (same fixes as the
    // main tree) + digest collection.
    for (const file of [...extTs, ...extMts]) {
      const compiledRel = file.replace(/\.mts$/, ".mjs").replace(/\.ts$/, ".js");
      const compiledAbs = join(stagedExtDir, compiledRel);
      if (!existsSync(compiledAbs)) {
        throw new Error(`esbuild produced no output for extensions/${staged.name}/${file}`);
      }
      let code = readFileSync(compiledAbs, "utf8");
      const literal = rewriteLiteralTsSpecifiers(code);
      code = literal.code;
      const json = injectJsonImportAttributes(code);
      code = json.code;
      if (literal.rewrites > 0 || json.injections > 0) {
        writeFileSync(compiledAbs, code);
      }
      stagedExtensionFiles.push(`extensions/.zeck-bundled/${staged.name}/${compiledRel}`);
      outputs.push({
        path: `extensions/.zeck-bundled/${staged.name}/${compiledRel}`,
        digest: sha256File(compiledAbs),
      });
    }
    // Copy every non-TS file (pruning node_modules + declaration files)
    // as REAL files — openclaw.plugin.json and the other manifests are
    // path-guarded at load time (the manifest's realpath must stay
    // inside the plugin dir; a symlink back into extensions/ reads as
    // an unsafe manifest path — measured live: "unsafe plugin manifest
    // path: .../dist/extensions/openai/openclaw.plugin.json").
    for (const file of listFilesPruned(srcExtRoot, ["node_modules"])) {
      if (/\.(ts|mts)$/.test(file) || file === "package.json") {
        continue;
      }
      const target = join(stagedExtDir, file);
      mkdirSync(dirname(target), { recursive: true });
      rmSync(target, { force: true });
      copyFileSync(join(srcExtRoot, file), target);
      stagedExtensionFiles.push(`extensions/.zeck-bundled/${staged.name}/${file}`);
      outputs.push({ path: `extensions/.zeck-bundled/${staged.name}/${file}`, digest: sha256File(target) });
    }
    // The staged package.json: the source extension's manifest with
    // openclaw.runtimeExtensions naming the COMPILED entries (the
    // built-plugin contract: dist-form packages carry compiled runtime
    // entries; TypeScript source fallback only applies to source
    // checkouts).
    const extPkgJson = JSON.parse(
      readFileSync(join(srcExtRoot, "package.json"), "utf8"),
    ) as { openclaw?: { extensions?: unknown } };
    const extEntries = Array.isArray(extPkgJson.openclaw?.extensions)
      ? (extPkgJson.openclaw?.extensions as unknown[])
      : [];
    const runtimeExtensions = extEntries
      .filter((entry): entry is string => typeof entry === "string")
      .map((entry) => entry.replace(/\.mts$/, ".mjs").replace(/\.ts$/, ".js"));
    const stagedPkgJson = {
      ...extPkgJson,
      openclaw: {
        ...(extPkgJson.openclaw ?? {}),
        ...(runtimeExtensions.length > 0 ? { runtimeExtensions } : {}),
      },
    };
    const stagedPkgJsonPath = join(stagedExtDir, "package.json");
    rmSync(stagedPkgJsonPath, { force: true });
    const stagedPkgJsonText = `${JSON.stringify(stagedPkgJson, null, 2)}\n`;
    writeFileSync(stagedPkgJsonPath, stagedPkgJsonText);
    outputs.push({
      path: `extensions/.zeck-bundled/${staged.name}/package.json`,
      digest: sha256Of(stagedPkgJsonText),
    });
    // The extension's own dependency install: symlink the source
    // extension's node_modules (pnpm workspace member) so jose/ws/
    // playwright-core resolve from the staged tree. Real build only —
    // the verify mirror compares file digests, not link farms.
    if (inPlaceOutExtension) {
      const extNodeModules = join(stagedExtDir, "node_modules");
      rmSync(extNodeModules, { force: true });
      symlinkSync(
        relative(dirname(extNodeModules), join(srcExtRoot, "node_modules")),
        extNodeModules,
        "dir",
      );
    }
  }

  // The openclaw alias package at dist/extensions/node_modules/openclaw:
  // wrapper modules over dist/plugin-sdk/*.js — the exact shape the
  // repo's own stage-bundled-plugin-runtime.mts stages
  // (ensureOpenClawExtensionAlias + writeRuntimeModuleWrapper).
  const aliasPkgDir = join(outBase, "extensions", ".zeck-bundled", "node_modules", "openclaw");
  rmSync(join(aliasPkgDir, "plugin-sdk"), { recursive: true, force: true });
  mkdirSync(join(aliasPkgDir, "plugin-sdk"), { recursive: true });
  const aliasExports: Record<string, string> = {};
  for (const name of rootPluginSdkNames) {
    const wrapperPath = join(aliasPkgDir, "plugin-sdk", `${name}.js`);
    const specifier = relative(
      dirname(wrapperPath),
      join(outBase, "dist", "plugin-sdk", `${name}.js`),
    );
    const normalizedSpecifier = specifier.startsWith(".") ? specifier : `./${specifier}`;
    const wrapper = [
      `export * from ${JSON.stringify(normalizedSpecifier)};`,
      `import * as module from ${JSON.stringify(normalizedSpecifier)};`,
      `let defaultExport = "default" in module ? module.default : module;`,
      `for (let index = 0; index < 4 && defaultExport && typeof defaultExport === "object" && "default" in defaultExport; index += 1) {`,
      `  defaultExport = defaultExport.default;`,
      `}`,
      `export { defaultExport as default };`,
      ``,
    ].join("\n");
    writeFileSync(wrapperPath, wrapper);
    aliasExports[`./plugin-sdk/${name}`] = `./plugin-sdk/${name}.js`;
    outputs.push({
      path: `extensions/.zeck-bundled/node_modules/openclaw/plugin-sdk/${name}.js`,
      digest: sha256File(wrapperPath),
    });
  }
  const aliasPkgJsonText = `${JSON.stringify(
    { name: "openclaw", type: "module", exports: aliasExports },
    null,
    2,
  )}\n`;
  writeFileSync(join(aliasPkgDir, "package.json"), aliasPkgJsonText);
  outputs.push({
    path: "extensions/.zeck-bundled/node_modules/openclaw/package.json",
    digest: sha256Of(aliasPkgJsonText),
  });
  console.log(
    `[build] root deploy surface: ${rootPluginSdkNames.length} root plugin-sdk dist link(s) + ${stagedExtensionFiles.length} staged extension file(s) (${STAGED_EXTENSIONS.map((e) => e.name).join(", ")}) + ${Object.keys(aliasExports).length} alias wrapper(s)`,
  );

  // Root node_modules/@openclaw workspace symlinks for the packages the
  // root package.json does not declare (src/'s bare @openclaw/* imports
  // resolve through them). Runs AFTER the closure so shim packages keep
  // their shim links (the closure already repointed them). Only created
  // in the real build (the verify mirror compares file digests, not the
  // link farm).
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

  return {
    outputs,
    esbuildVersion: esbuild.version,
    literalTsRewrites,
    literalMtsRewrites,
    literalTsFilesRewritten,
    jsonAttributeInjections,
    jsonAttributeFiles,
    skippedTrackedOutputs,
    exportDistLinks,
    exportShims,
  };
}

async function main(): Promise<void> {
  const mode = process.argv[2] === "verify" ? "verify" : "build";
  if (mode === "build") {
    const started = Date.now();
    const {
      outputs,
      esbuildVersion,
      literalTsRewrites,
      literalMtsRewrites,
      literalTsFilesRewritten,
      jsonAttributeInjections,
      jsonAttributeFiles,
      skippedTrackedOutputs,
      exportDistLinks,
      exportShims,
    } = await runBuild(OPENCLAW_CHECKOUT_DIR);
    const manifest = {
      builtBy: "compat/openclaw/harness/build-compiled-runtime.ts",
      esbuildVersion,
      tsconfigDigest: sha256File(join(OPENCLAW_CHECKOUT_DIR, "tsconfig.json")),
      upstreamRevision: "f6883b3771c0a40d7bd62fcb99815dcbbb2e24f3",
      literalTsSpecifierRewrites: {
        specifiers: literalTsRewrites,
        mtsSpecifiers: literalMtsRewrites,
        files: literalTsFilesRewritten,
      },
      jsonAttributeInjections: { statements: jsonAttributeInjections, files: jsonAttributeFiles },
      skippedTrackedOutputs: { files: skippedTrackedOutputs },
      exportMapClosures: { distLinks: exportDistLinks, shims: exportShims },
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
