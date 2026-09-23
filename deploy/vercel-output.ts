/**
 * deploy/vercel-output — the emitted-graph correction core (PPR-006's
 * module-loading discovery, extracted; PPR-007 extends it to EVERY
 * function graph of the build output).
 *
 * THE PLATFORM FACT (proved by the credentialed live run at
 * zeck-preview-main.vercel.app, PPR-006): the framework build's tsc
 * transpilation emits ES-module syntax (`import`/`export`,
 * `import.meta.url` in deploy/lib.ts — the graph is ESM-required), but
 * the runtime loads the traced handler `/var/task/server.js` as
 * COMMONJS, because the file-traced repository package.json carries no
 * `"type"` field — the isolate dies at cold start with
 * `SyntaxError: Cannot use import statement outside a module`
 * (FUNCTION_INVOCATION_FAILED on every route). The SAME fact holds for
 * EVERY emitted function graph — an `api/` directory Serverless
 * Function (PPR-007's experience entry) is transpiled by the same
 * build and loaded by the same runtime convention, so the correction
 * must apply to BOTH function graphs (and any further function the
 * deployment ever carries).
 *
 * THE CORRECTION (the smallest valid delta on the platform's OWN build
 * output — no bundler, no second build system, byte-for-byte the
 * platform's transpilation and file tracing), applied PER FUNCTION
 * GRAPH:
 *
 *  1. `vercel build --prod` runs UNCHANGED (the framework detection,
 *     the tsc transpilation, the nft file tracing — node_modules,
 *     deploy/manifests, docs — all the platform's own work);
 *  2. the emitted `.js` graph (outside node_modules) gets its RELATIVE
 *     IMPORT SPECIFIERS made Node-ESM-resolvable: a specifier resolving
 *     to a source FILE gains `.js` (`./lib` → `./lib.js`); a specifier
 *     resolving to a source DIRECTORY gains `/index.js` (`../src/api`
 *     → `../src/api/index.js` — Node ESM has no directory-index
 *     resolution). Absolute/bare specifiers (`node:*`, packages) are
 *     untouched; and only REAL module edges are rewritten — the edges
 *     come from an ESM lexer, so code-as-data (a template-literal
 *     snippet containing `from "..."`) is never misread as an import;
 *  3. the function root's package.json becomes the minimal
 *     `{"type": "module"}` marker (scopes ONLY the emitted graph — every
 *     traced node_modules package keeps its own nearest package.json,
 *     so CJS packages stay CJS);
 *  4. a fail-closed verification pass: zero extensionless relative
 *     specifiers may remain, or the build refuses;
 *  5. the DATA CARRY (the 2026-09-23 two-function artifact-proof
 *     finding): the experience composition reads repository DATA at
 *     runtime through dynamically constructed paths (app READMEs under
 *     benchmarks/validation/apps/*, governed work-order specs under
 *     spec/validation-work-orders/*, evidence + developer docs under
 *     docs/**, playground example sources under examples/*). Static
 *     `new URL(..., import.meta.url)` literals are file-traced; dynamic
 *     constructions are NOT — the traced bundle shipped no README and
 *     the isolate failed closed at cold start (ENOENT — the honest
 *     refusal, never a fabricated catalog). The carry copies the four
 *     runtime-read roots into the experience function root verbatim
 *     (source files as data; the roots carry no .js, so the module
 *     surgery and the fail-closed verification are untouched). The
 *     platform's own includeFiles mechanism cannot express this: the
 *     config schema accepts a single glob string and a brace-union
 *     matches nothing (both empirically proved 2026-09-23).
 *
 * This module is the TESTABLE core (the worker holds NO Vercel
 * credentials — `vercel build` cannot run in the worker pod — so the
 * transformation is proven against a SYNTHETIC `.vercel/output`
 * fixture by tests/unit/deployment/vercel-output.test.ts; the live
 * build/deploy proof is the Lead's credentialed run, honestly recorded
 * as NOT RUN in deploy/evidence/ppr-007.json). The orchestration
 * script that runs the platform build first is
 * deploy/build-vercel-output.ts.
 */

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { initSync as initModuleLexer, parse as parseModuleSpecifiers } from "es-module-lexer";

// The real-ESM lexer (synchronous WASM — works under both bun, the build
// runtime, and node, the test runtime). Initialized once at module load.
initModuleLexer();

/** A real static import edge of an emitted file: the module name plus its
 * unquoted text range in the source. Code-as-data — a template-literal
 * snippet containing `from "..."` — is NOT an edge: the lexer is the
 * oracle, a raw text regex is not (the DEP-025 playground snippet embedded
 * in apps/dashboard/validation-lab.ts made a regex misread a served string
 * as a module edge and refuse an honest build). */
interface ModuleEdge {
  /** The module name (unquoted — e.g. "./lib", "../src/api"). */
  readonly name: string;
  /** The specifier's start offset in the source (between the quotes). */
  readonly start: number;
  /** The specifier's end offset in the source (between the quotes). */
  readonly end: number;
}

/** Enumerate an emitted file's REAL relative static import edges. */
function staticModuleEdges(source: string): ModuleEdge[] {
  const [imports] = parseModuleSpecifiers(source);
  const edges: ModuleEdge[] = [];
  for (const imported of imports) {
    // 1 = ImportType.Static (import/export-from statements — the shapes tsc emits).
    if (imported.t !== 1 || typeof imported.n !== "string" || !imported.n.startsWith(".")) {
      continue;
    }
    edges.push({ name: imported.n, start: imported.s, end: imported.e });
  }
  return edges;
}

/** A specifier suffix that already carries a resolvable extension — never rewritten. */
export const RESOLVED_SUFFIXES = [".js", ".json", ".mjs", ".cjs", ".wasm", ".node"] as const;

/** One function graph's correction outcome. */
export interface FunctionGraphOutcome {
  /** The function directory relative to the output's functions root (e.g. "index", "api/experience"). */
  readonly functionDir: string;
  readonly filesRewritten: number;
  readonly specifierRewrites: number;
  /** The fail-closed verification: extensionless relative specifiers remaining (0 = pass). */
  readonly remainingUnresolved: number;
  /** Runtime-read data files carried into this function root (the experience composition's read roots; 0 elsewhere). */
  readonly dataFilesCarried: number;
}

/** The whole output correction's outcome. */
export interface OutputCorrection {
  readonly functions: readonly FunctionGraphOutcome[];
  /** The required function graphs the correction refused to run without. */
  readonly requiredFunctions: readonly string[];
}

/** Walk one function graph's emitted `.js` files (node_modules excluded — traced packages keep their own module systems). */
export function* emittedJavaScriptFiles(functionRoot: string): Generator<string> {
  const stack: string[] = [functionRoot];
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
export function rewriteSpecifier(
  repositoryRoot: string,
  functionRoot: string,
  emittedFile: string,
  specifier: string,
): string {
  const emitRelative = relative(functionRoot, emittedFile);
  const sourceDir = dirname(join(repositoryRoot, emitRelative));
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

/**
 * Apply the specifier correction to one function graph's emitted
 * `.js` files (in place — the platform's own output, minimally
 * corrected).
 */
export function rewriteEmittedGraph(
  repositoryRoot: string,
  functionRoot: string,
): { files: number; rewrites: number } {
  let files = 0;
  let rewrites = 0;
  for (const file of emittedJavaScriptFiles(functionRoot)) {
    const source = readFileSync(file, "utf8");
    const unresolved = staticModuleEdges(source).filter(
      (edge) => !RESOLVED_SUFFIXES.some((suffix) => edge.name.endsWith(suffix)),
    );
    if (unresolved.length === 0) {
      continue;
    }
    // Right-to-left offset surgery: earlier offsets stay valid as later
    // (higher) specifiers are replaced first.
    let corrected = source;
    for (let i = unresolved.length - 1; i >= 0; i -= 1) {
      const edge = unresolved[i] as ModuleEdge;
      const replacement = rewriteSpecifier(repositoryRoot, functionRoot, file, edge.name);
      corrected = corrected.slice(0, edge.start) + replacement + corrected.slice(edge.end);
    }
    writeFileSync(file, corrected);
    files += 1;
    rewrites += unresolved.length;
  }
  return { files, rewrites };
}

/** Write the minimal ESM marker package.json (scopes only the emitted graph). */
export function writeModuleMarker(functionRoot: string): void {
  writeFileSync(
    join(functionRoot, "package.json"),
    `${JSON.stringify({ name: "@pectoraux/ai-execution-os", type: "module", private: true }, null, 2)}\n`,
  );
}

/** Fail-closed verification: no extensionless relative specifier may remain. */
export function verifyGraph(functionRoot: string): number {
  let remaining = 0;
  for (const file of emittedJavaScriptFiles(functionRoot)) {
    const source = readFileSync(file, "utf8");
    for (const edge of staticModuleEdges(source)) {
      if (RESOLVED_SUFFIXES.some((suffix) => edge.name.endsWith(suffix))) {
        continue;
      }
      console.error(`  ✗ ${relative(functionRoot, file)}: "${edge.name}" left extensionless`);
      remaining += 1;
    }
  }
  return remaining;
}

/** Enumerate the build output's function directories (every `*.func`, at any depth — e.g. `index`, `api/experience`). */
export function* functionDirectories(functionsRoot: string): Generator<string> {
  if (!existsSync(functionsRoot)) {
    return;
  }
  const stack: string[] = [functionsRoot];
  while (stack.length > 0) {
    const dir = stack.pop() as string;
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (!statSync(path).isDirectory()) {
        continue;
      }
      if (entry.endsWith(".func")) {
        yield relative(functionsRoot, path).replaceAll("\\", "/").slice(0, -".func".length);
        continue;
      }
      stack.push(path);
    }
  }
}

/**
 * The build output's expected function set (PPR-007's two-function
 * composition): the ROOT framework entry (index — the Fastify function
 * PPR-006 ships) and the experience Serverless Function (api/experience
 * — this work order's addition).
 */
export const REQUIRED_FUNCTIONS: readonly string[] = ["index", "api/experience"];

/**
 * The ONE function whose composition reads repository DATA at runtime
 * (the console composition's dynamically constructed read paths). The
 * API plane's own 26-route smoke proves it needs none of the carried
 * roots — the carry is scoped to exactly this function.
 */
export const RUNTIME_DATA_CARRY_FUNCTION = "api/experience";

/**
 * The repository data roots the experience composition reads at
 * runtime (apps' READMEs/configs/evidence, governed work-order specs,
 * evidence + developer docs, playground example sources). Alphabetical;
 * every root MUST exist in the repository (a missing root is a drifted
 * contract — the correction refuses rather than silently narrowing the
 * carry). The roots carry no .js files (pinned by the unit proof), so
 * the carry never disturbs the module surgery or its verification.
 */
export const RUNTIME_DATA_ROOTS: readonly string[] = ["benchmarks", "docs", "examples", "spec"];

/**
 * Copy one repository root into a function root verbatim (data as
 * data — no transpilation, no module surgery), creating directories on
 * demand and overwriting any traced same-path file with the source
 * truth. Returns the number of files carried.
 */
export function carryRuntimeDataRoot(
  repositoryRoot: string,
  functionRoot: string,
  root: string,
): number {
  const sourceRoot = join(repositoryRoot, root);
  if (!existsSync(sourceRoot)) {
    throw new Error(
      `runtime data root "${root}" does not exist in the repository — the carry contract drifted`,
    );
  }
  let carried = 0;
  const stack: string[] = [sourceRoot];
  while (stack.length > 0) {
    const dir = stack.pop() as string;
    for (const entry of readdirSync(dir)) {
      const source = join(dir, entry);
      const stats = statSync(source);
      if (stats.isDirectory()) {
        stack.push(source);
        continue;
      }
      const target = join(functionRoot, relative(repositoryRoot, source));
      mkdirSync(dirname(target), { recursive: true });
      copyFileSync(source, target);
      carried += 1;
    }
  }
  return carried;
}

/**
 * Apply the correction to EVERY function graph of a Vercel build output
 * (fail-closed on the required function set): each function directory
 * gets its relative import specifiers made Node-ESM-resolvable, its
 * ESM marker package.json, and its fail-closed verification pass. The
 * orchestration (the platform build that produces the output first)
 * lives in deploy/build-vercel-output.ts; this core is what the
 * synthetic-fixture proof exercises.
 */
export function correctVercelOutput(
  outputRoot: string,
  repositoryRoot: string,
  options: { readonly requiredFunctions?: readonly string[] } = {},
): OutputCorrection {
  const functionsRoot = join(outputRoot, "functions");
  const required = options.requiredFunctions ?? REQUIRED_FUNCTIONS;
  const present = new Set(functionDirectories(functionsRoot));
  const missing = required.filter((name) => !present.has(name));
  if (missing.length > 0) {
    throw new Error(
      `the platform build produced no function graph for: ${missing.join(", ")} (present: ${[...present].sort().join(", ") || "none"}) — the routing contract requires every function of the composition`,
    );
  }
  const outcomes: FunctionGraphOutcome[] = [];
  for (const name of [...present].sort()) {
    const functionRoot = join(functionsRoot, `${name}.func`);
    const { files, rewrites } = rewriteEmittedGraph(repositoryRoot, functionRoot);
    // The data carry: the experience composition's runtime-read roots,
    // carried verbatim into exactly the one function that reads them.
    let carried = 0;
    if (name === RUNTIME_DATA_CARRY_FUNCTION) {
      for (const root of RUNTIME_DATA_ROOTS) {
        carried += carryRuntimeDataRoot(repositoryRoot, functionRoot, root);
      }
    }
    writeModuleMarker(functionRoot);
    outcomes.push({
      functionDir: name,
      filesRewritten: files,
      specifierRewrites: rewrites,
      remainingUnresolved: verifyGraph(functionRoot),
      dataFilesCarried: carried,
    });
  }
  return { functions: outcomes, requiredFunctions: required };
}
