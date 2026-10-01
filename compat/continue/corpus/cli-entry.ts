/**
 * The PPR-021 CLI entry wrapper — the module the egress preload
 * imports. The pinned Continue CLI's `src/index.ts` EXPORTS `runCli()`
 * but never calls it at module level (its own build step emits
 * dist/cn.js as `import { runCli } from "./index.js"; await runCli();`
 * — extensions/cli/build.mjs:94 records: "We must call runCli(); a
 * plain dynamic import will not execute the CLI").
 *
 * This wrapper reproduces the app's own dist/cn.js entry shape over the
 * source tree (the pinned revision runs 100% unmodified — the wrapper
 * only invokes the app's own exported entrypoint).
 */

const cliEntry = process.env.PPR_021_CONTINUE_CLI_ENTRY ?? "";
if (cliEntry.length === 0) {
  console.error("[ppr-021 cli-entry] PPR_021_CONTINUE_CLI_ENTRY is not set");
  process.exit(2);
}
const { runCli } = await import(cliEntry);
await runCli();

export {};
