/**
 * The PPR-023 runtime loader hook — redirects the pinned OpenClaw source
 * runtime's native process-ownership modules to their compiled forms.
 *
 * WHY THIS EXISTS (recorded in the evidence record and the demo entry's
 * reproducibility instructions): the pinned revision's exec-tool
 * supervisor admits its Linux native process owner ONLY from compiled
 * modules — `src/process/supervisor/linux-child-subreaper.ts` rejects a
 * source-loader `import.meta.url` by design, and its anchor
 * (`service-child-group-anchor.ts`) refuses to adopt the process-owner
 * role while ANY child process exists (the tsx loader's esbuild service
 * is one, so every source-run anchor process is rejected). This sandbox
 * cannot build the full tsdown bundle (the app's own build script
 * measured the need at 4352MB heap against the machine's 2035MB and
 * refused — /tmp/openclaw-build.log), so the certified runtime runs the
 * exact pinned SOURCE through the repo's own tsx loader, and exactly the
 * process-ownership pair is served from compiled forms of the same
 * pinned files placed beside them:
 *
 *  1. the anchor ENTRY resolves to `service-child-group-anchor.compiled.mjs`
 *     — an esbuild bundle of the pinned anchor `.ts` and its import
 *     graph (externals: node builtins; koffi loads at runtime). The
 *     anchor process then runs WITHOUT tsx, so no esbuild-service child
 *     exists and the dedicated-owner admission succeeds (verified by
 *     the harness's own anchor-protocol probe: subreaper admitted,
 *     command executed, `descendantsReaped: true`, clean close);
 *  2. the process-owner MODULE resolves to `linux-child-subreaper.js`
 *     — a plain esbuild transform of the pinned `.ts` (verified
 *     byte-identical at proof time) — for any non-anchor importer.
 *
 * This hook performs those redirects at module-resolution time in every
 * pinned-runtime process (each subprocess inherits it through the
 * scrubbed environment's NODE_OPTIONS axis; the anchor's spawn argv
 * still names the pinned `.ts`, and the redirect applies to the
 * subprocess's own entry resolution). Every other module resolves
 * exactly as the app's own loaders resolve it.
 */
import { pathToFileURL } from "node:url";

/** The pinned OpenClaw checkout (the same documented path corpus-runner pins). */
const OPENCLAW_CHECKOUT =
  process.env.PPR_023_OPENCLAW_CHECKOUT ?? "/home/z/openclaw-upstream";

const SUPERVISOR_DIR = `${OPENCLAW_CHECKOUT}/src/process/supervisor`;

const ANCHOR_SOURCE_URL = pathToFileURL(
  `${SUPERVISOR_DIR}/service-child-group-anchor.ts`,
).href;
const ANCHOR_COMPILED_URL = pathToFileURL(
  `${SUPERVISOR_DIR}/service-child-group-anchor.compiled.mjs`,
).href;

const SUBREAPER_SOURCE_URL = pathToFileURL(
  `${SUPERVISOR_DIR}/linux-child-subreaper.ts`,
).href;
const SUBREAPER_COMPILED_URL = pathToFileURL(`${SUPERVISOR_DIR}/linux-child-subreaper.js`).href;

/** Redirect the resolved process-ownership module URLs to their compiled forms. */
export async function resolve(specifier, context, nextResolve) {
  try {
    const result = await nextResolve(specifier, context);
    if (result.url === ANCHOR_SOURCE_URL) {
      return { url: ANCHOR_COMPILED_URL, format: "module", shortCircuit: true };
    }
    if (result.url === SUBREAPER_SOURCE_URL) {
      return { url: SUBREAPER_COMPILED_URL, format: "module", shortCircuit: true };
    }
    return result;
  } catch (error) {
    // Belt and braces for a non-tsx parent: a bare `.js` specifier for the
    // process owner that cannot resolve (no on-disk target from a plain
    // node resolution) still reaches the compiled transform.
    if (typeof specifier === "string" && specifier.endsWith("linux-child-subreaper.js")) {
      return { url: SUBREAPER_COMPILED_URL, format: "module", shortCircuit: true };
    }
    throw error;
  }
}
