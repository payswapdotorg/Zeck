/**
 * The example entry-point guard (DEP-020).
 *
 * An example is BOTH a copy/paste integration sample (import `main`
 * into your own code) AND a directly runnable script
 * (`bun run examples/<name>.ts` from the repository root). The guard
 * invokes `main` only when the module IS the process entry point:
 * under the documentation battery's test imports the entry is the test
 * runner binary, so examples NEVER auto-execute (no network side
 * effects from importing example code).
 */

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Invoke `main` only when this module is the process entry point. */
export function runWhenInvoked(moduleUrl: string, main: () => Promise<void>): void {
  const entry = process.argv[1] === undefined ? null : resolve(process.argv[1]);
  if (entry !== null && entry === resolve(fileURLToPath(moduleUrl))) {
    void main().catch((error: unknown) => {
      console.error(`example failed: ${error instanceof Error ? error.message : String(error)}`);
      process.exitCode = 1;
    });
  }
}
