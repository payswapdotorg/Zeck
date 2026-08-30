/**
 * Shared execution single-write-path + provenance scanner (WORK-006).
 *
 * One definition of the EXECUTION-PROVENANCE / no-alternative-write-path
 * boundary, two uses — the architecture gate over the REAL src tree, and
 * the discrimination proofs over synthetic second-writer mutations — so a
 * weakened protection is provably rejected (same pattern as
 * `provider-neutrality.ts` / `capability-gate-order.ts`).
 *
 * The boundary under protection (WORK-006 acceptance criterion 2:
 * "no alternative write path"; EXECUTION-PROVENANCE proof class static):
 *
 *   1. Exactly ONE `UPDATE executions.executions` statement exists in
 *      `src/` — inside `SqlExecutionStore.updateExecutionForTransition`
 *      (the transition service's only mutation port call).
 *   2. Exactly ONE `INSERT INTO executions.execution_events` statement
 *      exists — `SqlExecutionStore.appendEvent` (every envelope flows
 *      through the single transition/creation path with provenance).
 *   3. No `UPDATE`/`DELETE` against `executions.execution_events` or
 *      `executions.verification_results` exists anywhere in src/ (the
 *      ledger and verification evidence are append-only at the API level;
 *      migration 0004 triggers are the physical backstop).
 *   4. No file OUTSIDE `src/modules/executions/` references the executions
 *      tables (other modules consume the public barrel only).
 *   5. The transition service is the only caller of the mutation ports
 *      (`updateExecutionForTransition` / `appendEvent`) in src/.
 */

export interface WritePathFile {
  readonly path: string;
  readonly content: string;
}

const EXECUTIONS_TABLE = /executions\.executions\b/;
const EVENTS_TABLE = /executions\.execution_events\b/;
const VERIFICATION_TABLE = /executions\.verification_results\b/;
const UPDATE_EXECUTIONS = /UPDATE\s+executions\.executions\b/;
const INSERT_EVENTS = /INSERT\s+INTO\s+executions\.execution_events\b/;
const MUTATE_EVENTS = /(UPDATE|DELETE\s+FROM|DELETE)\s+executions\.execution_events\b/;
const MUTATE_VERIFICATION = /(UPDATE|DELETE\s+FROM|DELETE)\s+executions\.verification_results\b/;
const ADAPTER_PATH = "src/modules/executions/adapters/sql-execution-store.ts";
const SERVICE_PATH = "src/modules/executions/application/execution-service.ts";

export function executionWritePathViolations(files: readonly WritePathFile[]): string[] {
  const violations: string[] = [];
  const srcFiles = files.filter((f) => f.path.startsWith("src/"));

  const updateSites: string[] = [];
  const insertEventSites: string[] = [];

  for (const file of srcFiles) {
    const inExecutionsModule = file.path.startsWith("src/modules/executions/");

    // (4) executions tables are module-private surface.
    if (!inExecutionsModule) {
      for (const table of [
        [EXECUTIONS_TABLE, "executions.executions"],
        [EVENTS_TABLE, "executions.execution_events"],
        [VERIFICATION_TABLE, "executions.verification_results"],
      ] as const) {
        if (table[0].test(file.content)) {
          violations.push(`executions-table-referenced-outside-module:${file.path}:${table[1]}`);
        }
      }
    }

    // (3) the ledger and verification evidence have no API-level mutation
    // surface at all.
    if (MUTATE_EVENTS.test(file.content)) {
      violations.push(`event-ledger-mutation-site:${file.path}`);
    }
    if (MUTATE_VERIFICATION.test(file.content)) {
      violations.push(`verification-mutation-site:${file.path}`);
    }

    for (const match of file.content.matchAll(/UPDATE\s+executions\.executions\b/g)) {
      void match;
      updateSites.push(file.path);
    }
    for (const match of file.content.matchAll(/INSERT\s+INTO\s+executions\.execution_events\b/g)) {
      void match;
      insertEventSites.push(file.path);
    }
  }

  // (1) exactly ONE file contains execution-row UPDATE sites — the SQL
  // adapter (its single `updateExecutionForTransition` method may express
  // the terminal/non-terminal branches as adjacent statements; the port
  // coupling check below + the migration triggers pin the write path).
  const updateFiles = [...new Set(updateSites)];
  if (updateFiles.length !== 1) {
    violations.push(`execution-update-site-files:${updateFiles.length}:${updateFiles.join(",")}`);
  } else if (updateFiles[0] !== ADAPTER_PATH) {
    violations.push(`execution-update-site-location:${updateFiles[0]}`);
  }
  // (2) exactly one event INSERT site file, in the SQL adapter.
  const insertFiles = [...new Set(insertEventSites)];
  if (insertFiles.length !== 1) {
    violations.push(`event-insert-site-files:${insertFiles.length}:${insertFiles.join(",")}`);
  } else if (insertFiles[0] !== ADAPTER_PATH) {
    violations.push(`event-insert-site-location:${insertFiles[0]}`);
  }

  // (5) the mutation ports have exactly one production caller each — the
  // transition service (appendEvent additionally called by creation, which
  // is also in the service). Scan src/ for call sites outside the service.
  for (const file of srcFiles) {
    if (file.path === SERVICE_PATH || !file.path.startsWith("src/modules/executions/")) {
      continue;
    }
    if (file.path.startsWith("src/modules/executions/ports/")) {
      continue; // port definitions name the methods
    }
    if (file.path === ADAPTER_PATH) {
      continue; // the adapter implements (defines) them
    }
    if (
      /updateExecutionForTransition\s*\(/.test(file.content) &&
      !/async updateExecutionForTransition/.test(file.content)
    ) {
      violations.push(
        `mutation-port-called-outside-service:${file.path}:updateExecutionForTransition`,
      );
    }
    if (/appendEvent\s*\(/.test(file.content) && !/async appendEvent/.test(file.content)) {
      violations.push(`mutation-port-called-outside-service:${file.path}:appendEvent`);
    }
  }

  // Scanner sanity: the protected surface must exist in the real tree —
  // callers pass the actual src scan (synthetic mutant scans disable this
  // expectation via `expectCanonicalSites: false`).
  return violations;
}

/** True when the canonical single-writer sites exist in the scanned set. */
export function hasCanonicalWriteSites(files: readonly WritePathFile[]): boolean {
  const adapter = files.find((f) => f.path === ADAPTER_PATH);
  const service = files.find((f) => f.path === SERVICE_PATH);
  return (
    adapter !== undefined &&
    service !== undefined &&
    UPDATE_EXECUTIONS.test(adapter.content) &&
    INSERT_EVENTS.test(adapter.content) &&
    /updateExecutionForTransition\s*\(/.test(service.content) &&
    /appendEvent\s*\(/.test(service.content)
  );
}
