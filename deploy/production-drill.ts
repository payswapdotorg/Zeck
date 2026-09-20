/**
 * deploy/production-drill — the DEP-043 production readiness, rollback
 * and provider-exit drill driver.
 *
 * ONE driver composes the four DEP-043 drills over the delivered
 * deployment-chain tools (deploy/PUBLIC-DEPLOYMENT.md §3.1 local rails
 * + §9 the production verification chain + §2 the provider exit
 * paths), recording each step's REAL exit status, timing and output
 * digest — structurally the DEP-040 driver (deploy/e2e-validate.ts)
 * pattern: real subprocesses, real plane processes over real HTTP,
 * boot-document waits, refusal-reason pinning. The URL-hygiene
 * preflight and the boot-document detector are REUSED from the
 * DEP-040 driver (one authority, not a fork).
 *
 * THE FOUR DRILLS:
 *
 *  1. PROMOTE→VERIFY→ROLLBACK — a promotion to a verified plane
 *     succeeds and journals; promotions to wrong-revision /
 *     unreachable / tampered planes REFUSE (fail-closed, re-proven in
 *     the drill context); the rollback re-attests the target revision
 *     after the pointer flip (pre-repoint refusal + post-repoint
 *     allow — both directions).
 *  2. BACKUP/RESTORE ROUND-TRIP — the authoritative store's backup
 *     restores to an equivalent state (per-table sha256 digests
 *     compared before/after; the restore's own self-verification);
 *     partial-failure behavior is fail-closed and tested (a
 *     wrong-format, a truncated and a data-tampered artifact each
 *     REFUSE at restore with the exact reason — never a partial
 *     restore).
 *  3. PROVIDER-EXIT — every provider class in the manifests walks its
 *     documented exit path against the local/available substrate (the
 *     logical backup/restore authority exit, the queue-recovery
 *     replay plan, the workflow compaction/recovery-scan re-arm, the
 *     delivery repoint with byte-identical identity documents, the
 *     disposable-coordination / runner-absent / logs-only postures),
 *     with the live-provider halves honestly NOT RUN with owners; the
 *     domain authority is proven untouched by the exit mechanics
 *     (digest fingerprint before/after the whole segment).
 *  4. TEARDOWN CLASSIFICATION GUARDS — persistent environments refuse
 *     (classification, not operator intent); an AMBIGUOUS
 *     classification (a class/teardown-policy contradiction) refuses
 *     at manifest load BEFORE any destruction; a reclassified
 *     persistent environment refuses at the guard; the local PG drop
 *     fails closed against a dead authority; the REAL local teardown
 *     removes exactly the computed resources (round-trip verified).
 *
 * CREDENTIAL HONESTY (the recorded boundary): live-provider rails
 * (Neon, Cloudflare R2/Queues/Workflows, Upstash, Vercel, a real
 * runner daemon, an OTLP collector) have no credentials in a worker
 * sandbox — every live half is recorded in the notRun registry with
 * its owner ("Lead credentialed re-run"), never fabricated or
 * assumed-pass. The LOCAL rails always run: the drill's own local
 * PostgreSQL server (ZECK_PG_ADMIN_URL, credential-less; the driver
 * REFUSES URL-embedded credentials — the same pattern the
 * architecture secret-scan pins over deploy/**). The durable-
 * orchestration steps run the AUTHORITY-side machinery with
 * SYNTHETIC provider configuration (recorded as such): on the empty
 * waits substrate the engine makes zero provider calls (every
 * provider interaction is per-row) — the live provider half is the
 * credentialed owner's boundary.
 *
 * FAIL-CLOSED SEMANTICS: any failure anywhere fails the drill (exit
 * 1) — never a warning. Every hostile negative is an EXPECTED
 * refusal: each must exit with its exact fail-closed reason or the
 * drill fails.
 *
 * Usage (the driver's own config — battery-separated from
 * ZECK_PG_TEST_URL; a DEDICATED instance: the drill's final teardown
 * segment DROPS the computed zeck_local database):
 *   ZECK_PG_ADMIN_URL=postgres://postgres@127.0.0.1:54333/postgres \
 *     bun deploy/production-drill.ts
 *
 * Output: one JSON report on stdout; exit 0 = all four drills green
 * (every positive step passed, every negative refused with its exact
 * reason); exit 1 = any step deviated (problems[] carries the exact
 * deviations); exit 2 = the driver's own preflight refused
 * (missing/invalid local rails configuration).
 */

import { execFileSync, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";
import type { LogicalBackup } from "../src/platform/db/backup";
import { parseProviderTiers } from "../src/platform/deployment/provider-tiers";
import { bootDocumentOf, checkPgAdminUrl } from "./e2e-validate";
import { loadManifest, REPOSITORY_ROOT } from "./lib";

// ---------------------------------------------------------------------------
// The four-drill plan — exported for the contract unit test.
// ---------------------------------------------------------------------------

export interface DrillPlanEntry {
  readonly drill: string;
  readonly title: string;
  readonly steps: readonly string[];
}

/** The four DEP-043 drills and their composed steps, in execution order. */
export const DRILL_PLAN: readonly DrillPlanEntry[] = Object.freeze([
  {
    drill: "rails",
    title: "Local rail bring-up (the same idempotent convergence machinery the operator runs)",
    steps: ["rails-validate", "rails-bootstrap", "rails-provision", "rails-migrate"],
  },
  {
    drill: "promote-verify-rollback",
    title:
      "Promote a revision through the governed release path, verify the deployed plane's identity, roll back with re-attestation — both directions",
    steps: [
      "d1-release-record",
      "d1-release-gate",
      "d1-promote-wrong-revision-refused",
      "d1-promote-unreachable-refused",
      "d1-promote-tampered-refused",
      "d1-promote-verified",
      "d1-release-record-base",
      "d1-release-gate-base",
      "d1-rollback-prerepoint-refused",
      "d1-repromote-head",
      "d1-rollback-postpoint-verified",
    ],
  },
  {
    drill: "backup-restore-roundtrip",
    title:
      "Back up the authoritative stores, restore to an equivalent state (digest-verified), refuse corrupt/truncated/tampered artifacts fail-closed",
    steps: [
      "d2-backup-initial",
      "d2-restore-roundtrip",
      "d2-backup-digest-stability",
      "d2-digest-comparison",
      "d2-restore-wrong-format-refused",
      "d2-restore-truncated-refused",
      "d2-restore-tampered-refused",
      "d2-retained-target-cleanup",
    ],
  },
  {
    drill: "provider-exit",
    title:
      "Walk every manifest provider class's documented exit path against the local substrate (live halves honestly NOT RUN); prove the domain authority untouched",
    steps: [
      "d3-queue-recovery",
      "d3-workflow-inspect",
      "d3-workflow-scan",
      "d3-workflow-recover",
      "d3-workflow-compact",
      "d3-artifact-exit-refused",
      "d3-delivery-repoint",
      "d3-exit-postures",
      "d3-authority-fingerprint-after",
      "d3-fingerprint-comparison",
    ],
  },
  {
    drill: "teardown-guards",
    title:
      "Classification governs destruction: persistent and ambiguous classifications refuse; the dead-authority drop fails closed; the real teardown removes exactly the computed resources",
    steps: [
      "d4-staging-refused",
      "d4-production-refused",
      "d4-ambiguous-classification-refused",
      "d4-reclassified-persistent-refused",
      "d4-dead-pg-refused",
      "d4-teardown-real",
      "d4-post-teardown-verify",
    ],
  },
] as const);

// ---------------------------------------------------------------------------
// The provider-exit coverage (derived from the REAL manifests at call
// time — the manifest is the only authority, never tool-local
// constants) — exported for the contract unit test.
// ---------------------------------------------------------------------------

export interface ProviderExitCoverage {
  readonly concern: string;
  readonly provider: string;
  readonly exitPath: string;
  readonly localExecution: string;
  readonly liveBoundary: string;
}

/** The per-class provider-exit coverage: local execution + live boundary. */
export function providerExitCoverage(): readonly ProviderExitCoverage[] {
  const manifest = loadManifest();
  const ledger = parseProviderTiers(
    readFileSync(join(REPOSITORY_ROOT, "deploy", "manifests", "provider-tiers.json"), "utf8"),
    manifest,
  );
  const localExecutionByConcern: Readonly<Record<string, string>> = {
    "relational-state":
      "drill 2's backup → restore round-trip over the real local PostgreSQL (the provider-neutral wire-protocol adapter; per-table sha256 digests verified before/after)",
    "artifact-bytes":
      "the fail-closed configuration refusal driven against the real deploy:drill artifact-exit tool (the local environment defines no operative S3-compatible endpoint — local artifacts are filesystem-scoped; the exit path never fabricates a PASS)",
    "async-transport":
      "deploy:drill queue-recovery executes the replay-plan classification against the real authority (every dispatch envelope classified; the replay plan is authority-side — broker substitution loses nothing); the republish half is the tool's own honest not-run registry",
    "durable-orchestration":
      "deploy:workflow inspect/scan/recover/compact execute the authority-side exit machinery over the real local PostgreSQL (the waits table is the authority; compaction + the recovery scan re-arm; empty substrate → zero provider calls, synthetic provider configuration recorded as such)",
    "ephemeral-coordination":
      "the local plane runs with NO Redis by default — /health attests the coordination concern degraded-but-alive with its declared coordination-degraded mode (the drop-it exit posture, live)",
    "experience-delivery":
      "two real planes on distinct local endpoints attest BYTE-IDENTICAL identity documents through the same PostgreSQL authority (the hosting-independent repoint proof; the document carries no host/port/URL fields)",
    "execution-compute":
      "/health attests the compute concern's honest degraded state with its declared execution-compute-unavailable mode on the runner-less local substrate (the exit posture: the runner is substitutable, the control plane stays alive)",
    "observability-export":
      "the plane boots and serves with ZERO observability configuration (logs-only is the declared operating state; the boot contract is satisfied without any OTLP variables — substitution is endpoint configuration only)",
  };
  const liveBoundaryByConcern: Readonly<Record<string, string>> = {
    "relational-state":
      "restore into a real replacement provider (Neon Launch / any managed PostgreSQL) over the public internet",
    "artifact-bytes":
      "the real R2 → alternate object-store byte migration (adopted artifacts, two real S3-compatible endpoints)",
    "async-transport":
      "the bounded republish through the real transport adapter against a live broker (Cloudflare Queues or the replacement)",
    "durable-orchestration":
      "terminating and re-arming real Cloudflare Workflows provider instances against a live engine",
    "ephemeral-coordination":
      "repointing at a real managed Redis-compatible replacement (Upstash or alternate) — configuration-only substitution by doctrine",
    "experience-delivery":
      "a live alternate delivery host over the public internet (the real Vercel exit / alternate web host)",
    "execution-compute": "a real alternate runner daemon implementing the documented REST protocol",
    "observability-export": "a live OTLP collector endpoint (configuration-only substitution)",
  };
  return ledger.tiers.map((tier) => ({
    concern: tier.concern,
    provider: tier.provider,
    exitPath: tier.upgradeExit,
    localExecution:
      localExecutionByConcern[tier.concern] ??
      "no local execution path recorded for this concern (a coverage gap — the drill must extend it)",
    liveBoundary:
      liveBoundaryByConcern[tier.concern] ??
      "the live-provider half of this exit path (no boundary recorded — a coverage gap)",
  }));
}

// ---------------------------------------------------------------------------
// The NOT RUN boundary registry (the credential-honesty doctrine) —
// exported for the contract unit test.
// ---------------------------------------------------------------------------

export interface NotRunBoundary {
  readonly check: string;
  readonly reason: string;
  readonly owner: string;
}

const LEAD_OWNER = "Lead credentialed re-run (deploy/PUBLIC-DEPLOYMENT.md §2 exit paths + §9)";

/** Every live rail this drill cannot run without operator credentials. */
export const NOT_RUN_BOUNDARIES: readonly NotRunBoundary[] = Object.freeze([
  {
    check:
      "Live-provider promotion/rollback rails: promote/rollback with --plane-url against a real hosted production plane (Vercel-hosted deploy/api.ts + Neon authority) over the public internet",
    reason:
      "No cloud credentials and no live hosted deployment exist in this environment. The promotion identity core and the rollback re-attestation are verified end to end against real local plane processes over real HTTP (both directions + the wrong-revision/unreachable/tampered refusals) over the REAL local release ledger; the live-hosted promotion is the credentialed owner's boundary.",
    owner: LEAD_OWNER,
  },
  {
    check:
      "Live relational-state exit: restore the authoritative backup into a real replacement provider (Neon Launch / any managed PostgreSQL) over the public internet",
    reason:
      "No replacement-provider credentials exist in this environment. The backup/restore round-trip ran FOR REAL against the local PostgreSQL server (the adapter is provider-neutral over the wire protocol — connection URLs only); the live replacement-restore is the credentialed owner's boundary.",
    owner: LEAD_OWNER,
  },
  {
    check:
      "Live artifact-bytes exit: the real R2 → alternate object-store byte migration (deploy:drill artifact-exit with adopted artifacts over two real S3-compatible endpoints)",
    reason:
      "No R2/alternate-store credentials and no adopted-artifact data exist in this environment; the local environment defines no operative S3-compatible endpoint BY DESIGN (local artifacts are filesystem-scoped). The tool's fail-closed configuration refusal was driven for real (never a fabricated PASS); the live migration is the credentialed owner's boundary.",
    owner: LEAD_OWNER,
  },
  {
    check:
      "Live async-transport exit: the bounded republish through the real transport adapter against a live broker (Cloudflare Queues or the replacement broker)",
    reason:
      "No queue transport credentials exist in this environment. The replay-plan classification (the authority-side half of the exit — every dispatch envelope classified, fail closed on drift) ran FOR REAL against the local authority; the tool's own not-run registry carries the republish half verbatim.",
    owner: LEAD_OWNER,
  },
  {
    check:
      "Live durable-orchestration exit: terminating and re-arming real Cloudflare Workflows provider instances against a live replacement engine",
    reason:
      "No Cloudflare Workflows credentials exist in this environment. The authority-side exit machinery (the waits table as the authority, compaction, the recovery scan re-arm) ran FOR REAL over the local PostgreSQL with SYNTHETIC provider configuration (empty waits substrate → zero provider calls); the live provider half is the credentialed owner's boundary.",
    owner: LEAD_OWNER,
  },
  {
    check:
      "Live ephemeral-coordination exit: repointing at a real managed Redis-compatible replacement (Upstash or alternate)",
    reason:
      "No Upstash/managed-Redis credentials exist in this environment. The drop-it exit posture is proven live on the local substrate (the plane operates with NO Redis — coordination degraded-but-alive, its declared first-class state); the replacement repoint is configuration-only by doctrine and is the credentialed owner's re-verification.",
    owner: LEAD_OWNER,
  },
  {
    check:
      "Live experience-delivery exit: a live alternate delivery host over the public internet (the real Vercel exit / alternate web host)",
    reason:
      "No live host and no transport credential for one exist in this environment. The repoint proof ran FOR REAL locally: two planes on distinct endpoints attest byte-identical identity documents through the same PostgreSQL authority (hosting-independence is by construction — the document carries no host fields); the live-hosted repoint is the credentialed owner's boundary.",
    owner: LEAD_OWNER,
  },
  {
    check:
      "Live execution-compute exit: a real alternate runner daemon implementing the documented REST protocol",
    reason:
      "No runner daemon exists in this environment. The exit posture is proven live on the local substrate (/health attests the compute concern's honest degraded state with its declared mode; the runner is substitutable and the control plane stays alive); the live alternate-runner execution is the credentialed owner's boundary.",
    owner: LEAD_OWNER,
  },
  {
    check: "Live observability-export exit: a live OTLP collector endpoint",
    reason:
      "No OTLP collector exists in this environment. The logs-only degraded mode is the declared operating state and is proven live (the plane boots and serves with zero observability configuration); the live endpoint substitution is configuration-only and is the credentialed owner's re-verification.",
    owner: LEAD_OWNER,
  },
  {
    check:
      "Live provider meters and receipts (Neon / Cloudflare / Upstash dashboards) for the drill's live halves",
    reason:
      "No cloud credentials in this environment. Zero live cost was consumed (no live-provider operation was executed); the credentialed re-run owns the live meter parity and the verbatim cost receipts.",
    owner: LEAD_OWNER,
  },
  {
    check: "CI execution of the full suite on the branch",
    reason: "Workers do not push and do not open PRs; CI runs on the Lead's merge.",
    owner: "Lead merge + CI (.github/workflows)",
  },
] as const);

// ---------------------------------------------------------------------------
// Backup-artifact helpers (pure, exported for the contract unit test).
// ---------------------------------------------------------------------------

export interface DigestComparison {
  readonly equal: boolean;
  readonly differences: readonly string[];
}

/**
 * Compare two backup artifacts' per-table digests (the store's own
 * content checksums + row counts). Any mismatch is a difference — the
 * caller refuses on mismatch (never a partial equivalence).
 */
export function compareTableDigests(before: LogicalBackup, after: LogicalBackup): DigestComparison {
  const digestOfTable = (table: LogicalBackup["tables"][number]): string =>
    `${table.schema}.${table.table}:${table.rowCount}:${table.contentChecksum}`;
  const beforeMap = new Map(
    before.tables.map((table) => [`${table.schema}.${table.table}`, digestOfTable(table)]),
  );
  const afterMap = new Map(
    after.tables.map((table) => [`${table.schema}.${table.table}`, digestOfTable(table)]),
  );
  const differences: string[] = [];
  for (const [key, digest] of beforeMap) {
    const other = afterMap.get(key);
    if (other === undefined) {
      differences.push(`table ${key} missing after (before: ${digest})`);
    } else if (other !== digest) {
      differences.push(`table ${key} digest drift (before: ${digest}, after: ${other})`);
    }
  }
  for (const key of afterMap.keys()) {
    if (!beforeMap.has(key)) {
      differences.push(`table ${key} appeared after (absent before)`);
    }
  }
  return { equal: differences.length === 0, differences };
}

/**
 * The data-tampered artifact (the corrupt-backup negative): drop ONE
 * row from the first non-empty table while KEEPING the original
 * rowCount and contentChecksum — type-safe on any column layout (no
 * insert can fail; the drift is caught by the restore's own
 * re-read + re-hash + row-count verification, the exact fail-closed
 * refusal).
 */
export function tamperArtifactRow(backup: LogicalBackup): LogicalBackup {
  const index = backup.tables.findIndex((table) => table.rows.length > 0);
  if (index < 0) {
    throw new Error("the backup carries no non-empty table to tamper (the drill needs real data)");
  }
  const tables = backup.tables.map((table, position) => {
    if (position !== index) {
      return table;
    }
    return {
      ...table,
      rows: table.rows.slice(1),
      // rowCount + contentChecksum deliberately UNCHANGED (the tamper is data-only).
    };
  });
  return { ...backup, tables };
}

/**
 * The truncated artifact (the corrupt-backup negative): cut the
 * serialized artifact at ~55% of its bytes — mid-JSON, never
 * parseable; the restore must refuse at parse (never a partial
 * restore, and never a disposable target created).
 */
export function truncateArtifactText(text: string): string {
  return text.slice(0, Math.floor(text.length * 0.55));
}

/**
 * The wrong-format artifact (the corrupt-backup negative): a
 * well-formed JSON document that is not a zeck-logical-backup v1
 * manifest.
 */
export function wrongFormatArtifact(): string {
  return `${JSON.stringify(
    {
      format: "not-zeck-logical-backup",
      version: 99,
      createdAt: new Date(0).toISOString(),
      migrationHistory: [],
      tables: [],
    },
    null,
    2,
  )}\n`;
}

// ---------------------------------------------------------------------------
// Step runner
// ---------------------------------------------------------------------------

class StepError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StepError";
  }
}

interface StepExpectation {
  /** The exact exit code the step must produce. */
  readonly exit: number;
  /** Substrings that must appear on stdout. */
  readonly stdoutIncludes?: readonly string[];
  readonly stderrIncludes?: readonly string[];
  /** Extract the report facts from the tool's JSON document (throws on malformed). */
  readonly facts?: (document: Record<string, unknown>) => Record<string, unknown>;
  /** Human assertion over the raw result (throws with the deviation). */
  readonly assert?: (result: ToolResult) => void | Promise<void>;
}

interface StepSpec {
  readonly id: string;
  readonly drill: string;
  readonly purpose: string;
  readonly script: string;
  readonly args: readonly string[];
  readonly cwd?: string;
  readonly cwdLabel?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
  readonly expectation: StepExpectation;
  /** A hostile negative: the expected REFUSAL (exit + reason) is the pass. */
  readonly negative?: boolean;
}

interface ToolResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly durationMs: number;
}

interface StepRecord {
  readonly id: string;
  readonly drill: string;
  readonly purpose: string;
  readonly command: readonly string[];
  readonly cwd: string;
  readonly kind: "positive" | "negative";
  readonly expectedExit: number;
  readonly exitCode: number;
  readonly durationMs: number;
  readonly outputDigest: string;
  readonly refusalReason?: string;
  readonly facts: Record<string, unknown>;
  readonly ok: boolean;
  readonly deviation?: string;
}

function sha256(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/** Parse the first JSON document in a tool's stdout (fail closed). */
function jsonDocumentOf(stdout: string): Record<string, unknown> {
  const start = stdout.indexOf("{");
  if (start < 0) {
    throw new Error("the tool printed no JSON document on stdout");
  }
  return JSON.parse(stdout.slice(start)) as Record<string, unknown>;
}

const steps: StepRecord[] = [];
const resultsById = new Map<string, ToolResult>();
const facts: Record<string, unknown> = {};

function resultOf(stepId: string): ToolResult {
  const captured = resultsById.get(stepId);
  if (captured === undefined) {
    throw new StepError(`no captured result for step ${stepId}`);
  }
  return captured;
}

async function runStep(spec: StepSpec): Promise<StepRecord> {
  const cwd = spec.cwd ?? REPOSITORY_ROOT;
  const result = await spawnTool(
    ["bun", join("deploy", spec.script), ...spec.args],
    cwd,
    spec.env,
    spec.timeoutMs ?? 180_000,
  );
  resultsById.set(spec.id, result);
  const record = await evaluateStep(spec, result, cwd);
  steps.push(record);
  const mark = record.ok ? (spec.negative === true ? "REFUSED-OK" : "PASS") : "FAIL";
  process.stderr.write(
    `[drill] ${record.id}: exit ${record.exitCode} (expected ${spec.expectation.exit}) ${mark} ${record.durationMs}ms\n`,
  );
  if (!record.ok) {
    // Any failure anywhere fails the drill — and the drill STOPS
    // (dependent steps would cascade meaningless failures).
    throw new StepError(record.deviation ?? `${spec.id} deviated`);
  }
  return record;
}

/** A driver-internal step (no subprocess): a real verification the driver itself executes. */
async function runInternalStep(spec: {
  readonly id: string;
  readonly drill: string;
  readonly purpose: string;
  readonly description: string;
  readonly action: () => Promise<Record<string, unknown>>;
}): Promise<StepRecord> {
  const startedAt = Date.now();
  let stepFacts: Record<string, unknown> = {};
  let ok = true;
  let deviation: string | undefined;
  try {
    stepFacts = await spec.action();
  } catch (error) {
    ok = false;
    deviation = (error as Error).message;
  }
  const record: StepRecord = {
    id: spec.id,
    drill: spec.drill,
    purpose: spec.purpose,
    command: ["(driver-internal)", spec.description],
    cwd: "<repo>",
    kind: "positive",
    expectedExit: 0,
    exitCode: ok ? 0 : 1,
    durationMs: Date.now() - startedAt,
    outputDigest: `sha256:${sha256(JSON.stringify(stepFacts))}`,
    facts: stepFacts,
    ok,
    ...(deviation === undefined ? {} : { deviation }),
  };
  steps.push(record);
  process.stderr.write(
    `[drill] ${record.id}: internal ${record.ok ? "PASS" : "FAIL"} ${record.durationMs}ms\n`,
  );
  if (!record.ok) {
    throw new StepError(record.deviation ?? `${spec.id} deviated`);
  }
  return record;
}

function spawnTool(
  command: readonly string[],
  cwd: string,
  env: Readonly<Record<string, string>> | undefined,
  timeoutMs: number,
): Promise<ToolResult> {
  return new Promise((resolvePromise) => {
    const startedAt = Date.now();
    const child = spawn(command[0] as string, command.slice(1), {
      cwd,
      env: { ...process.env, ...(env ?? {}) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      resolvePromise({
        code: code ?? (timedOut ? -2 : -1),
        stdout,
        stderr,
        timedOut,
        durationMs: Date.now() - startedAt,
      });
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      resolvePromise({
        code: -1,
        stdout,
        stderr: `${stderr}${(error as Error).message}`,
        timedOut,
        durationMs: Date.now() - startedAt,
      });
    });
  });
}

/** The exact fail-closed reason of a refused (negative) step. */
function refusalReasonOf(result: ToolResult): string {
  const stderrLine = result.stderr
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  if (stderrLine !== undefined) {
    return stderrLine;
  }
  try {
    const document = jsonDocumentOf(result.stdout) as { problems?: unknown };
    if (Array.isArray(document.problems) && document.problems.length > 0) {
      return String(document.problems[0]);
    }
  } catch {
    // fall through to the first stdout line
  }
  return result.stdout.split("\n")[0]?.trim() ?? "";
}

async function evaluateStep(spec: StepSpec, result: ToolResult, cwd: string): Promise<StepRecord> {
  const expectation = spec.expectation;
  let ok = result.code === expectation.exit && !result.timedOut;
  let deviation: string | undefined;
  const stepFacts: Record<string, unknown> = {};
  if (result.timedOut) {
    deviation = `the step timed out after ${spec.timeoutMs ?? 180_000}ms`;
  } else if (result.code !== expectation.exit) {
    deviation = `exit ${result.code} (expected ${expectation.exit}); stderr: ${result.stderr.slice(0, 300)}`;
  }
  if (ok && expectation.stdoutIncludes !== undefined) {
    for (const needle of expectation.stdoutIncludes) {
      if (!result.stdout.includes(needle)) {
        ok = false;
        deviation = `stdout does not carry the expected marker "${needle}"`;
        break;
      }
    }
  }
  if (ok && expectation.stderrIncludes !== undefined) {
    for (const needle of expectation.stderrIncludes) {
      if (!result.stderr.includes(needle)) {
        ok = false;
        deviation = `stderr does not carry the expected marker "${needle}"`;
        break;
      }
    }
  }
  if (ok && expectation.facts !== undefined) {
    try {
      Object.assign(stepFacts, expectation.facts(jsonDocumentOf(result.stdout)));
    } catch (error) {
      ok = false;
      deviation = `fact extraction failed: ${(error as Error).message}`;
    }
  }
  if (ok && expectation.assert !== undefined) {
    try {
      await expectation.assert(result);
    } catch (error) {
      ok = false;
      deviation = (error as Error).message;
    }
  }
  const refusalReason = spec.negative === true ? refusalReasonOf(result) : undefined;
  return {
    id: spec.id,
    drill: spec.drill,
    purpose: spec.purpose,
    command: ["bun", `deploy/${spec.script}`, ...spec.args],
    cwd: spec.cwdLabel ?? cwd.replace(REPOSITORY_ROOT, "<repo>"),
    kind: spec.negative === true ? "negative" : "positive",
    expectedExit: expectation.exit,
    exitCode: result.code,
    durationMs: result.durationMs,
    outputDigest: `sha256:${sha256(result.stdout + result.stderr)}`,
    ...(refusalReason === undefined ? {} : { refusalReason }),
    facts: stepFacts,
    ok,
    ...(deviation === undefined ? {} : { deviation }),
  };
}

// ---------------------------------------------------------------------------
// Plane runner (real deploy/api.ts subprocesses; boot-document wait —
// the SAME discipline as the DEP-040 driver, detector REUSED).
// ---------------------------------------------------------------------------

interface PlaneHandle {
  readonly baseUrl: string;
  readonly boot: ReturnType<typeof bootDocumentOf>;
  readonly stop: () => Promise<void>;
}

const planeStops: Array<() => Promise<void>> = [];

/** Reserve an ephemeral port then close the listener (a real free/dead port). */
async function reservePort(): Promise<number> {
  const net = await import("node:net");
  return new Promise((resolvePromise, reject) => {
    const server = net.createServer();
    server.unref();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("no port"));
        return;
      }
      const { port } = address;
      server.close(() => resolvePromise(port));
    });
  });
}

/**
 * Boot the REAL plane (deploy/api.ts) and wait for its BOOT DOCUMENT on
 * stdout — the plane-boot race discipline (never a bare /health 200).
 */
async function bootPlane(options: {
  readonly cwd?: string;
  readonly revisionOverride?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly label: string;
}): Promise<PlaneHandle> {
  let lastError = "unknown";
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const port = await reservePort();
    const host = "127.0.0.1";
    const baseUrl = `http://${host}:${port}`;
    const cwd = options.cwd ?? REPOSITORY_ROOT;
    const child = spawn(
      "bun",
      [join("deploy", "api.ts"), "--environment", "local", "--host", host, "--port", String(port)],
      {
        cwd,
        env: {
          ...process.env,
          ZECK_ENVIRONMENT: "local",
          ...(options.revisionOverride === undefined
            ? {}
            : { ZECK_DEPLOY_GIT_REVISION: options.revisionOverride }),
          ...(options.env ?? {}),
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    // THE BOOT-DOCUMENT WAIT (bounded 30s).
    const boot = await new Promise<ReturnType<typeof bootDocumentOf> | null>((resolvePromise) => {
      const deadline = Date.now() + 30_000;
      const poll = setInterval(() => {
        const document = bootDocumentOf(stdout);
        if (document !== null) {
          clearInterval(poll);
          resolvePromise(document);
          return;
        }
        if (Date.now() > deadline) {
          clearInterval(poll);
          resolvePromise(null);
        }
      }, 25);
      child.once("exit", () => {
        clearInterval(poll);
        resolvePromise(null);
      });
    });
    if (boot === null) {
      lastError = `the plane did not print its boot document (stderr: ${stderr.slice(0, 200)})`;
      child.kill("SIGKILL");
      continue;
    }
    // Transport confirmation after the boot barrier.
    let transportOk = false;
    for (let probe = 0; probe < 40; probe += 1) {
      try {
        const response = await fetch(`${baseUrl}/health`);
        void response.body?.cancel();
        transportOk = true;
        break;
      } catch {
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
      }
    }
    if (!transportOk) {
      lastError = "the plane booted (boot document) but /health never answered";
      child.kill("SIGKILL");
      continue;
    }
    let stopped = false;
    const stop = async (): Promise<void> => {
      if (stopped) {
        return;
      }
      stopped = true;
      const exited = new Promise<number>((resolvePromise) => {
        child.once("exit", (code) => resolvePromise(code ?? 0));
      });
      child.kill("SIGTERM");
      const code = await Promise.race([
        exited,
        new Promise<number>((resolvePromise) => {
          const killer = setTimeout(() => {
            child.kill("SIGKILL");
            resolvePromise(-1);
          }, 10_000);
          exited.then((exitCode) => {
            clearTimeout(killer);
            resolvePromise(exitCode);
          });
        }),
      ]);
      if (code !== 0) {
        throw new Error(
          `plane ${options.label} did not drain gracefully on SIGTERM (exit ${code})`,
        );
      }
    };
    planeStops.push(stop);
    process.stderr.write(
      `[drill] plane ${options.label} booted on ${baseUrl} (boot document seen)\n`,
    );
    return { baseUrl, boot, stop };
  }
  throw new StepError(`could not boot the plane ${options.label}: ${lastError}`);
}

async function stopPlanes(): Promise<string[]> {
  const drainProblems: string[] = [];
  for (const stop of planeStops.splice(0)) {
    try {
      await stop();
    } catch (error) {
      drainProblems.push((error as Error).message);
    }
  }
  return drainProblems;
}

// ---------------------------------------------------------------------------
// Scratch trees (git archive + ONE manifest mutation each)
// ---------------------------------------------------------------------------

function git(args: readonly string[], cwd: string = REPOSITORY_ROOT): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

/** A git-archive snapshot of the exact revision (no .git — a pure tree). */
function archiveTree(revision: string, label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `zeck-drill-${label}-`));
  const archive = `${dir}.tar`;
  execFileSync("git", ["archive", "--format=tar", revision, "-o", archive], {
    cwd: REPOSITORY_ROOT,
  });
  execFileSync("tar", ["-x", "-f", archive, "-C", dir]);
  rmSync(archive);
  // The tools import runtime packages (pg) — share the checkout's
  // node_modules (the archive carries no dependencies of its own).
  symlinkSync(join(REPOSITORY_ROOT, "node_modules"), join(dir, "node_modules"));
  return dir;
}

/** Insert ONE well-formed row into a manifest's JSON array field. */
function insertManifestRow(
  tree: string,
  manifestFile: string,
  arrayField: string,
  row: Record<string, unknown>,
): void {
  const path = join(tree, "deploy", "manifests", manifestFile);
  const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  (parsed[arrayField] as unknown[]).push(row);
  writeFileSync(path, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
}

/** Overwrite one environment record's classification fields (the teardown mutation). */
function mutateEnvironmentRecord(
  tree: string,
  environmentId: string,
  mutate: (record: Record<string, unknown>) => void,
): void {
  const path = join(tree, "deploy", "manifests", "environments.json");
  const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  const environments = parsed.environments as Record<string, Record<string, unknown>>;
  const record = environments[environmentId];
  if (record === undefined) {
    throw new StepError(`environments.json carries no record for ${environmentId}`);
  }
  mutate(record);
  writeFileSync(path, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
}

// ---------------------------------------------------------------------------
// The rollback target resolution (the revision pair whose identity
// documents differ ONLY by revision — byte-identical deploy/manifests).
// ---------------------------------------------------------------------------

function resolveRollbackTarget(revision: string): string | null {
  const candidates: string[] = [];
  try {
    const originMain = git(["rev-parse", "origin/main"]);
    if (originMain !== revision) {
      candidates.push(originMain);
    }
  } catch {
    // no origin/main (a detached harvest checkout, for example)
  }
  for (let depth = 1; depth <= 5; depth += 1) {
    try {
      const ancestor = git(["rev-parse", `HEAD~${depth}`]);
      if (ancestor !== revision) {
        candidates.push(ancestor);
      }
    } catch {
      break;
    }
  }
  for (const candidate of candidates) {
    if (candidate === revision) {
      continue;
    }
    try {
      // --quiet exits 1 when the trees DIFFER; execFileSync throws then.
      execFileSync("git", ["diff", "--quiet", candidate, revision, "--", "deploy/manifests"], {
        cwd: REPOSITORY_ROOT,
        encoding: "utf8",
      });
      return candidate;
    } catch {}
  }
  return null;
}

function prepareBaseWorktree(targetRevision: string, scratchRoot: string): string {
  const worktree = join(scratchRoot, "base-worktree");
  execFileSync("git", ["worktree", "add", "--detach", worktree, targetRevision], {
    cwd: REPOSITORY_ROOT,
  });
  symlinkSync(join(REPOSITORY_ROOT, "node_modules"), join(worktree, "node_modules"));
  return worktree;
}

// ---------------------------------------------------------------------------
// PostgreSQL helpers (the drill's own authority administration)
// ---------------------------------------------------------------------------

async function withAdminClient<T>(url: string, work: (client: Client) => Promise<T>): Promise<T> {
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    return await work(client);
  } finally {
    await client.end();
  }
}

async function restoreTargetNames(adminUrl: string): Promise<string[]> {
  return withAdminClient(adminUrl, async (client) => {
    const result = await client.query<{ datname: string }>({
      text: "SELECT datname FROM pg_database WHERE datname LIKE 'zeck_restore_%' OR datname LIKE 'zeck_drill_restore_%'",
    });
    return result.rows.map((row) => row.datname);
  });
}

async function dropDatabase(adminUrl: string, name: string): Promise<void> {
  await withAdminClient(adminUrl, async (client) => {
    await client.query(
      "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
      [name],
    );
    await client.query(`DROP DATABASE IF EXISTS ${name}`);
  });
}

// ---------------------------------------------------------------------------
// The driver
// ---------------------------------------------------------------------------

const WRONG_REVISION = "b".repeat(40);
const DRIVER_ACTOR = "dep-043-production-drill";

async function main(): Promise<void> {
  const startedAt = new Date();
  // --- preflight -----------------------------------------------------------
  const pgCheck = checkPgAdminUrl(process.env.ZECK_PG_ADMIN_URL);
  if (!pgCheck.ok) {
    console.error(`error: ${pgCheck.reason}`);
    process.exit(2);
  }
  const pgAdminUrl = process.env.ZECK_PG_ADMIN_URL as string;
  const pgEndpoint = pgCheck.endpoint ?? "";
  const pgBase = pgAdminUrl.replace(/\/[^/]*$/, "");
  const revision = git(["rev-parse", "HEAD"]);
  if (!/^[0-9a-f]{40}$/.test(revision)) {
    throw new Error(`HEAD is not an exact revision: ${revision}`);
  }
  const rollbackTarget = resolveRollbackTarget(revision);
  const dataRoot = mkdtempSync(join(tmpdir(), "zeck-drill-data-"));
  const scratchRoot = mkdtempSync(join(tmpdir(), "zeck-drill-scratch-"));

  const LOCAL_ENV = { ZECK_ENVIRONMENT: "local", ZECK_PG_ADMIN_URL: pgAdminUrl };
  const PROVISION_ENV = { ...LOCAL_ENV, ZECK_LOCAL_DATA_ROOT: dataRoot };
  // The durable-orchestration steps run the AUTHORITY-side machinery
  // with SYNTHETIC provider configuration (recorded honestly in the
  // report): on the empty waits substrate the engine makes zero
  // provider calls (every provider interaction is per-row). The token
  // and the account id are runtime-generated synthetic values (the
  // account id satisfies the tool's 32-hex shape check), never
  // printed, never real credentials.
  const syntheticWorkflowToken = `zeck-drill-${randomUUID().replaceAll("-", "")}`;
  const syntheticWorkflowAccountId = randomUUID().replaceAll("-", "");
  const WORKFLOW_ENV = {
    ...LOCAL_ENV,
    ZECK_DATABASE_URL: `${pgBase}/zeck_local`,
    ZECK_CLOUDFLARE_ACCOUNT_ID: syntheticWorkflowAccountId,
    ZECK_WORKFLOW_NAME: "zeck-drill-orchestration",
    ZECK_WORKFLOW_API_TOKEN: syntheticWorkflowToken,
  };

  const problems: string[] = [];
  let baseWorktree: string | null = null;
  let runError: string | null = null;
  let restoreTargetsBefore: string[] = [];

  try {
    // === RAIL BRING-UP (the same idempotent convergence machinery) =======
    await runStep({
      id: "rails-validate",
      drill: "rails",
      purpose:
        "the configuration gate runs FIRST (the full manifest validation — nothing may touch a malformed configuration)",
      script: "validate.ts",
      args: [],
      timeoutMs: 120_000,
      expectation: {
        exit: 0,
        facts: (doc) => ({ valid: doc.valid, migrations: doc.migrations }),
        assert: (result) => {
          if (jsonDocumentOf(result.stdout).valid !== true) {
            throw new Error("deploy:validate did not report valid=true");
          }
        },
      },
    });
    await runStep({
      id: "rails-bootstrap",
      drill: "rails",
      purpose: "converge the disposable local resource set (create-or-skip, idempotent)",
      script: "bootstrap.ts",
      args: ["--environment", "local"],
      env: LOCAL_ENV,
      timeoutMs: 120_000,
      expectation: {
        exit: 0,
        facts: (doc) => ({ operations: doc.operations }),
      },
    });
    await runStep({
      id: "rails-provision",
      drill: "rails",
      purpose:
        "converge the secret-reference scaffold + sandbox-account records under the drill's data root (the teardown drill removes exactly these)",
      script: "provision.ts",
      args: ["--environment", "local", "--json"],
      env: PROVISION_ENV,
      timeoutMs: 120_000,
      expectation: {
        exit: 0,
        facts: (doc) => ({
          converged: (doc.convergence as Record<string, unknown>)?.converged,
          alreadyConverged: (doc.convergence as Record<string, unknown>)?.alreadyConverged,
          created: (doc.convergence as Record<string, unknown>)?.created,
        }),
      },
    });
    await runStep({
      id: "rails-migrate",
      drill: "rails",
      purpose:
        "the deterministic startup/migration path against the drill's authoritative database",
      script: "migrate.ts",
      args: ["--environment", "local"],
      env: LOCAL_ENV,
      timeoutMs: 300_000,
      expectation: {
        exit: 0,
        facts: (doc) => ({ serverVersion: doc.serverVersion, migrations: doc.migrations }),
        assert: (result) => {
          const doc = jsonDocumentOf(result.stdout) as {
            migrations: { appliedCount: number; skipped: number; total: number };
          };
          if (
            doc.migrations.total < 28 ||
            doc.migrations.appliedCount + doc.migrations.skipped !== doc.migrations.total
          ) {
            throw new Error(
              `the migration report is inconsistent: ${JSON.stringify(doc.migrations)}`,
            );
          }
          facts.migrations = doc.migrations;
        },
      },
    });
    // The restore-target baseline (after the rails are proven up).
    restoreTargetsBefore = await restoreTargetNames(pgAdminUrl);

    // === DRILL 1 — PROMOTE→VERIFY→ROLLBACK ===============================
    await runStep({
      id: "d1-release-record",
      drill: "promote-verify-rollback",
      purpose:
        "record binds the exact checkout revision + the deterministic deployment identity into the real release ledger",
      script: "release.ts",
      args: ["record", "--environment", "local", "--actor", DRIVER_ACTOR],
      env: LOCAL_ENV,
      timeoutMs: 180_000,
      expectation: {
        exit: 0,
        facts: (doc) => ({
          releaseId: (doc.release as Record<string, unknown>)?.releaseId,
          identity: doc.identity,
        }),
        assert: (result) => {
          const doc = jsonDocumentOf(result.stdout) as {
            identity: { gitRevision: string };
          };
          if (doc.identity.gitRevision !== revision) {
            throw new Error("the recorded release does not bind the checkout revision");
          }
        },
      },
    });
    await runStep({
      id: "d1-release-gate",
      drill: "promote-verify-rollback",
      purpose: "real tool-run gate evidence (the local entry gate: validation)",
      script: "release.ts",
      args: [
        "gate",
        "run",
        "--kind",
        "validation",
        "--environment",
        "local",
        "--actor",
        DRIVER_ACTOR,
      ],
      env: LOCAL_ENV,
      timeoutMs: 180_000,
      expectation: {
        exit: 0,
        facts: (doc) => ({ result: doc.result }),
        assert: (result) => {
          const doc = jsonDocumentOf(result.stdout) as { result: { status: string } };
          if (doc.result.status !== "passed") {
            throw new Error(`the validation gate did not pass: ${JSON.stringify(doc.result)}`);
          }
        },
      },
    });

    // The tampered plane: a git archive of HEAD plus ONE well-formed
    // variables.json row (well-formed manifest, drifted identity).
    const tamperTree = archiveTree(revision, "tamper");
    insertManifestRow(tamperTree, "variables.json", "variables", {
      name: "ZECK_DRILL_TAMPER_PROBE",
      type: "string",
      required: false,
      credentialShaped: false,
      description:
        "DEP-043 tamper drill row: one well-formed extra variable row the exact-revision identity recompute must refuse (drift detection, never a crash).",
    });

    const wrongPlane = await bootPlane({
      label: "wrong-revision",
      revisionOverride: WRONG_REVISION,
    });
    try {
      await runStep({
        id: "d1-promote-wrong-revision-refused",
        drill: "promote-verify-rollback",
        purpose:
          "a promotion to an UNVERIFIED/wrong-revision plane REFUSES (fail-closed, re-proven in the drill context — regardless of gate evidence)",
        script: "release.ts",
        args: [
          "promote",
          "--to",
          "local",
          "--actor",
          DRIVER_ACTOR,
          "--plane-url",
          wrongPlane.baseUrl,
        ],
        env: LOCAL_ENV,
        timeoutMs: 180_000,
        negative: true,
        expectation: {
          exit: 1,
          stdoutIncludes: ['"allowed": false'],
          assert: (result) => {
            if (
              !result.stderr.includes("deployment identity verification failed before promotion")
            ) {
              throw new Error(
                `the wrong-revision refusal reason deviated: ${result.stderr.slice(0, 300)}`,
              );
            }
          },
        },
      });
    } finally {
      await wrongPlane.stop();
    }
    const deadPromotePort = await reservePort();
    await runStep({
      id: "d1-promote-unreachable-refused",
      drill: "promote-verify-rollback",
      purpose: "a promotion to an UNREACHABLE plane REFUSES (fail closed, never a warning)",
      script: "release.ts",
      args: [
        "promote",
        "--to",
        "local",
        "--actor",
        DRIVER_ACTOR,
        "--plane-url",
        `http://127.0.0.1:${deadPromotePort}`,
      ],
      env: LOCAL_ENV,
      timeoutMs: 180_000,
      negative: true,
      expectation: {
        exit: 1,
        stdoutIncludes: ['"allowed": false'],
        assert: (result) => {
          if (!result.stderr.includes("unreachable (fail closed)")) {
            throw new Error(
              `the unreachable refusal reason deviated: ${result.stderr.slice(0, 300)}`,
            );
          }
        },
      },
    });
    const tamperPlane = await bootPlane({
      label: "tampered",
      cwd: tamperTree,
      revisionOverride: revision,
      env: { ZECK_PG_ADMIN_URL: pgAdminUrl },
    });
    try {
      await runStep({
        id: "d1-promote-tampered-refused",
        drill: "promote-verify-rollback",
        purpose:
          "a promotion to a TAMPERED plane (well-formed manifest, drifted identity) REFUSES on identity-recompute mismatch — the tamper drill re-proven on the promotion path",
        script: "release.ts",
        args: [
          "promote",
          "--to",
          "local",
          "--actor",
          DRIVER_ACTOR,
          "--plane-url",
          tamperPlane.baseUrl,
        ],
        env: LOCAL_ENV,
        timeoutMs: 180_000,
        negative: true,
        expectation: {
          exit: 1,
          stdoutIncludes: ['"allowed": false'],
          assert: (result) => {
            if (
              !result.stderr.includes("deployment identity verification failed before promotion") ||
              !result.stderr.includes("does not recompute")
            ) {
              throw new Error(
                `the tampered-plane refusal reason deviated: ${result.stderr.slice(0, 300)}`,
              );
            }
          },
        },
      });
    } finally {
      await tamperPlane.stop();
    }

    // The verified plane: the promotion succeeds and journals.
    const headPlane = await bootPlane({ label: "head-revision" });
    try {
      await runStep({
        id: "d1-promote-verified",
        drill: "promote-verify-rollback",
        purpose:
          "a promotion to a VERIFIED plane SUCCEEDS and journals (the pre-promotion attestation recorded; the hosting pointer activates)",
        script: "release.ts",
        args: [
          "promote",
          "--to",
          "local",
          "--actor",
          DRIVER_ACTOR,
          "--plane-url",
          headPlane.baseUrl,
        ],
        env: LOCAL_ENV,
        timeoutMs: 180_000,
        expectation: {
          exit: 0,
          facts: (doc) => ({
            promoted: doc.promoted,
            releaseId: doc.releaseId,
            planeIdentity: doc.planeIdentity,
            activeDeployment: doc.activeDeployment,
          }),
          assert: (result) => {
            const doc = jsonDocumentOf(result.stdout) as {
              promoted: boolean;
              planeIdentity: {
                verified: boolean;
                attestedRevision: string;
                runtimeIdentityId: string;
              };
            };
            if (doc.promoted !== true || doc.planeIdentity.verified !== true) {
              throw new Error(
                "the verified-plane promotion did not succeed with the attestation recorded",
              );
            }
            if (doc.planeIdentity.attestedRevision !== revision) {
              throw new Error("the promotion attested a revision other than the candidate");
            }
            facts.promotedPlaneIdentity = doc.planeIdentity;
          },
        },
      });

      // --- rollback re-attestation, both directions ----------------------
      if (rollbackTarget !== null) {
        baseWorktree = prepareBaseWorktree(rollbackTarget, scratchRoot);
        const baseEnv = { ZECK_ENVIRONMENT: "local", ZECK_PG_ADMIN_URL: pgAdminUrl };
        await runStep({
          id: "d1-release-record-base",
          drill: "promote-verify-rollback",
          purpose:
            "record the ROLLBACK TARGET release (the previous releasable state — the manifest-identical ancestor) into the same local ledger",
          script: "release.ts",
          args: ["record", "--environment", "local", "--actor", DRIVER_ACTOR],
          cwd: baseWorktree,
          cwdLabel: "<base-worktree>",
          env: baseEnv,
          timeoutMs: 180_000,
          expectation: {
            exit: 0,
            facts: (doc) => ({
              releaseId: (doc.release as Record<string, unknown>)?.releaseId,
              gitRevision: (doc.release as Record<string, unknown>)?.gitRevision,
            }),
            assert: (result) => {
              const doc = jsonDocumentOf(result.stdout) as {
                release: { gitRevision: string; releaseId: string };
              };
              if (doc.release.gitRevision !== rollbackTarget) {
                throw new Error("the base worktree did not record the base revision");
              }
              facts.rollbackTargetReleaseId = doc.release.releaseId;
            },
          },
        });
        const baseReleaseId = facts.rollbackTargetReleaseId as string;
        await runStep({
          id: "d1-release-gate-base",
          drill: "promote-verify-rollback",
          purpose:
            "the rollback target must itself be gate-passed (rollback never activates unproven state)",
          script: "release.ts",
          args: [
            "gate",
            "run",
            "--kind",
            "validation",
            "--environment",
            "local",
            "--actor",
            DRIVER_ACTOR,
          ],
          cwd: baseWorktree,
          cwdLabel: "<base-worktree>",
          env: baseEnv,
          timeoutMs: 180_000,
          expectation: { exit: 0, facts: (doc) => ({ result: doc.result }) },
        });
        await runStep({
          id: "d1-rollback-prerepoint-refused",
          drill: "promote-verify-rollback",
          purpose:
            "rollback with the plane still serving the FROM revision: the pointer flip happens, then the re-attestation REFUSES with the exact repoint instruction",
          script: "release.ts",
          args: [
            "rollback",
            "--environment",
            "local",
            "--to",
            baseReleaseId,
            "--actor",
            DRIVER_ACTOR,
            "--plane-url",
            headPlane.baseUrl,
          ],
          env: LOCAL_ENV,
          timeoutMs: 180_000,
          negative: true,
          expectation: {
            exit: 1,
            assert: (result) => {
              const doc = jsonDocumentOf(result.stdout) as {
                toReleaseId: string;
                planeIdentity: { verified: boolean };
              };
              if (doc.toReleaseId !== baseReleaseId) {
                throw new Error("the rollback document does not name the target release");
              }
              if (doc.planeIdentity.verified !== false) {
                throw new Error("the pre-repoint re-attestation was not refused");
              }
              if (
                !result.stderr.includes("post-rollback re-attestation failed") ||
                !result.stderr.includes("repoint")
              ) {
                throw new Error(
                  `the pre-repoint refusal reason deviated: ${result.stderr.slice(0, 300)}`,
                );
              }
              facts.preRepointRefusal = result.stderr.split("\n")[0]?.trim();
            },
          },
        });
        await runStep({
          id: "d1-repromote-head",
          drill: "promote-verify-rollback",
          purpose:
            "re-activate the head release (the rollback drill needs a FROM deployment again)",
          script: "release.ts",
          args: [
            "promote",
            "--to",
            "local",
            "--actor",
            DRIVER_ACTOR,
            "--plane-url",
            headPlane.baseUrl,
          ],
          env: LOCAL_ENV,
          timeoutMs: 180_000,
          expectation: { exit: 0, facts: (doc) => ({ promoted: doc.promoted }) },
        });
        const basePlane = await bootPlane({ label: "base-revision", cwd: baseWorktree });
        try {
          await runStep({
            id: "d1-rollback-postpoint-verified",
            drill: "promote-verify-rollback",
            purpose:
              "rollback with the plane REPOINTED at the target revision: the governed pointer flip + the re-attestation of the TARGET revision SUCCEEDS (exit 0)",
            script: "release.ts",
            args: [
              "rollback",
              "--environment",
              "local",
              "--to",
              baseReleaseId,
              "--actor",
              DRIVER_ACTOR,
              "--plane-url",
              basePlane.baseUrl,
            ],
            env: LOCAL_ENV,
            timeoutMs: 180_000,
            expectation: {
              exit: 0,
              facts: (doc) => ({
                fromReleaseId: doc.fromReleaseId,
                toReleaseId: doc.toReleaseId,
                planeIdentity: doc.planeIdentity,
              }),
              assert: (result) => {
                const doc = jsonDocumentOf(result.stdout) as {
                  planeIdentity: { verified: boolean; attestedRevision?: string };
                };
                if (doc.planeIdentity.verified !== true) {
                  throw new Error("the post-repoint re-attestation did not verify");
                }
                if (doc.planeIdentity.attestedRevision !== rollbackTarget) {
                  throw new Error(
                    "the post-repoint re-attestation did not attest the target revision",
                  );
                }
                facts.postRepointAttestation = doc.planeIdentity;
              },
            },
          });
        } finally {
          await basePlane.stop();
        }
      } else {
        // Honest skip: the rollback both-directions drill needs a second
        // revision with byte-identical deploy manifests.
        steps.push({
          id: "d1-rollback-drills",
          drill: "promote-verify-rollback",
          purpose: "rollback re-attestation drills (both directions)",
          command: ["bun", "deploy/release.ts", "rollback", "--environment", "local"],
          cwd: "<repo>",
          kind: "positive",
          expectedExit: 0,
          exitCode: 0,
          durationMs: 0,
          outputDigest: `sha256:${sha256("skipped")}`,
          facts: {
            skipped: true,
            reason:
              "no ancestor revision with byte-identical deploy/manifests exists for the rollback target (the drill requires a revision pair whose identity documents differ only by revision)",
          },
          ok: true,
        });
      }
    } finally {
      await headPlane.stop();
    }

    // === DRILL 2 — BACKUP/RESTORE ROUND-TRIP =============================
    const backupOne = join(scratchRoot, "drill-backup-1.json");
    await runStep({
      id: "d2-backup-initial",
      drill: "backup-restore-roundtrip",
      purpose:
        "the logical backup of the authoritative store (port-based, per-table sha256 content checksums + the exact migration history)",
      script: "backup.ts",
      args: ["--environment", "local", "--out", backupOne],
      env: LOCAL_ENV,
      timeoutMs: 180_000,
      expectation: {
        exit: 0,
        facts: (doc) => ({ artifact: doc.artifact }),
        assert: (result) => {
          const doc = jsonDocumentOf(result.stdout) as {
            artifact: { tables: number; rows: number };
          };
          if (doc.artifact.tables < 1) {
            throw new Error("the backup artifact carries no tables (the authority is empty?)");
          }
        },
      },
    });
    const backupOneDocument = JSON.parse(readFileSync(backupOne, "utf8")) as LogicalBackup;
    await runStep({
      id: "d2-restore-roundtrip",
      drill: "backup-restore-roundtrip",
      purpose:
        "the restore drill executes: fresh disposable target → deterministic migrations → one-transaction data restore → SELF-VERIFICATION (re-read + re-hash + row counts)",
      script: "restore.ts",
      args: ["--environment", "local", "--from", backupOne, "--drop"],
      env: LOCAL_ENV,
      timeoutMs: 300_000,
      expectation: {
        exit: 0,
        facts: (doc) => ({
          source: doc.source,
          procedure: doc.procedure,
          verification: doc.verification,
        }),
        assert: (result) => {
          const doc = jsonDocumentOf(result.stdout) as {
            procedure: { tablesRestored: number; rowsRestored: number };
            verification: { allTablesVerified: boolean; tables: number; method: string };
          };
          if (doc.verification.allTablesVerified !== true) {
            throw new Error("the restore self-verification did not pass");
          }
          if (doc.procedure.tablesRestored !== backupOneDocument.tables.length) {
            throw new Error(
              `the restore covered ${doc.procedure.tablesRestored} tables (backup carries ${backupOneDocument.tables.length})`,
            );
          }
          const backupRows = backupOneDocument.tables.reduce((total, t) => total + t.rowCount, 0);
          if (doc.procedure.rowsRestored !== backupRows) {
            throw new Error(
              `the restore covered ${doc.procedure.rowsRestored} rows (backup carries ${backupRows})`,
            );
          }
          if (!doc.verification.method.includes("sha256")) {
            throw new Error("the restore verification method does not carry the digest discipline");
          }
          facts.roundTrip = {
            tables: doc.procedure.tablesRestored,
            rows: doc.procedure.rowsRestored,
            allTablesVerified: doc.verification.allTablesVerified,
            method: doc.verification.method,
          };
        },
      },
    });
    const backupTwo = join(scratchRoot, "drill-backup-2.json");
    await runStep({
      id: "d2-backup-digest-stability",
      drill: "backup-restore-roundtrip",
      purpose:
        "the digest-stability proof: a second backup of the same store carries the IDENTICAL per-table digests (equivalent state, byte-for-byte content checksums)",
      script: "backup.ts",
      args: ["--environment", "local", "--out", backupTwo],
      env: LOCAL_ENV,
      timeoutMs: 180_000,
      expectation: {
        exit: 0,
        facts: (doc) => ({ artifact: doc.artifact }),
      },
    });
    const backupTwoDocument = JSON.parse(readFileSync(backupTwo, "utf8")) as LogicalBackup;
    await runInternalStep({
      id: "d2-digest-comparison",
      drill: "backup-restore-roundtrip",
      purpose:
        "compare the store digests before/after the round trip (refuse on any mismatch — never a partial equivalence)",
      description: "compare per-table digests of backup-1 vs backup-2",
      action: async () => {
        const comparison = compareTableDigests(backupOneDocument, backupTwoDocument);
        if (!comparison.equal) {
          throw new Error(
            `the backup digests drifted across the round trip: ${comparison.differences.slice(0, 5).join("; ")}`,
          );
        }
        facts.authorityFingerprint = {
          tables: backupTwoDocument.tables.length,
          rows: backupTwoDocument.tables.reduce((total, t) => total + t.rowCount, 0),
          digestsStable: true,
        };
        return {
          equal: true,
          tables: backupTwoDocument.tables.length,
          rows: backupTwoDocument.tables.reduce((total, t) => total + t.rowCount, 0),
        };
      },
    });

    // The corrupt-backup negatives (each REFUSES at restore with the
    // exact reason — never a partial restore).
    const wrongFormatPath = join(scratchRoot, "drill-backup-wrong-format.json");
    writeFileSync(wrongFormatPath, wrongFormatArtifact(), "utf8");
    await runStep({
      id: "d2-restore-wrong-format-refused",
      drill: "backup-restore-roundtrip",
      purpose:
        "a wrong-format artifact (well-formed JSON, not a zeck-logical-backup v1 manifest) is REFUSED at restore (exit 2, the exact reason)",
      script: "restore.ts",
      args: ["--environment", "local", "--from", wrongFormatPath],
      env: LOCAL_ENV,
      timeoutMs: 120_000,
      negative: true,
      expectation: {
        exit: 2,
        stderrIncludes: [
          "the artifact is not a zeck-logical-backup v1 manifest (refusing to restore)",
        ],
      },
    });
    const truncatedPath = join(scratchRoot, "drill-backup-truncated.json");
    writeFileSync(truncatedPath, truncateArtifactText(readFileSync(backupOne, "utf8")), "utf8");
    await runStep({
      id: "d2-restore-truncated-refused",
      drill: "backup-restore-roundtrip",
      purpose:
        "a TRUNCATED artifact (cut mid-JSON) is REFUSED at restore (exit 1, the parse failure) — and NO disposable recovery target is created (never a partial restore)",
      script: "restore.ts",
      args: ["--environment", "local", "--from", truncatedPath],
      env: LOCAL_ENV,
      timeoutMs: 120_000,
      negative: true,
      expectation: {
        exit: 1,
        stderrIncludes: ["error:"],
        assert: async () => {
          const after = await restoreTargetNames(pgAdminUrl);
          const created = after.filter((name) => !restoreTargetsBefore.includes(name));
          if (created.length > 0) {
            throw new Error(
              `the truncated-artifact refusal left recovery targets behind: ${created.join(", ")}`,
            );
          }
        },
      },
    });
    const tamperedPath = join(scratchRoot, "drill-backup-tampered.json");
    writeFileSync(
      tamperedPath,
      `${JSON.stringify(tamperArtifactRow(backupOneDocument), null, 2)}\n`,
      "utf8",
    );
    await runStep({
      id: "d2-restore-tampered-refused",
      drill: "backup-restore-roundtrip",
      purpose:
        "a DATA-TAMPERED artifact (one row dropped, checksums left original) is REFUSED by the restore's own self-verification (exit 1, the exact table named; the target retained for diagnosis)",
      script: "restore.ts",
      args: ["--environment", "local", "--from", tamperedPath],
      env: LOCAL_ENV,
      timeoutMs: 300_000,
      negative: true,
      expectation: {
        exit: 1,
        stderrIncludes: ["error: restore verification failed"],
        assert: (result) => {
          if (!result.stderr.includes("row counts or content checksums do not match the backup")) {
            throw new Error(
              `the tampered-artifact refusal did not name the verification drift: ${result.stderr.slice(0, 300)}`,
            );
          }
          if (!result.stderr.includes("left in place for diagnosis")) {
            throw new Error("the tampered-artifact refusal did not disclose the retained target");
          }
        },
      },
    });
    await runInternalStep({
      id: "d2-retained-target-cleanup",
      drill: "backup-restore-roundtrip",
      purpose:
        "drop the disposable recovery target the tampered-artifact refusal retained (the drill cleans its own scratch — the live authority is never touched)",
      description: "drop the retained zeck_restore_* diagnosis target(s)",
      action: async () => {
        const match = /zeck_restore_[0-9a-f]+/.exec(resultOf("d2-restore-tampered-refused").stderr);
        if (match === null) {
          const after = await restoreTargetNames(pgAdminUrl);
          const created = after.filter((name) => !restoreTargetsBefore.includes(name));
          if (created.length > 0) {
            throw new Error(
              `recovery targets were left behind without a disclosed name: ${created.join(", ")}`,
            );
          }
          return { dropped: [], note: "no retained target to clean" };
        }
        const name = match[0];
        await dropDatabase(pgAdminUrl, name);
        const remaining = await restoreTargetNames(pgAdminUrl);
        if (remaining.includes(name)) {
          throw new Error(`the retained target ${name} was not dropped`);
        }
        return { dropped: [name] };
      },
    });

    // === DRILL 3 — PROVIDER-EXIT =========================================
    // The coverage map (manifest-derived) is part of the report.
    facts.providerExitCoverage = providerExitCoverage().map((entry) => ({
      concern: entry.concern,
      provider: entry.provider,
      exitPath: entry.exitPath,
      localExecution: entry.localExecution,
      liveBoundary: entry.liveBoundary,
      liveOwner: LEAD_OWNER,
    }));

    await runStep({
      id: "d3-queue-recovery",
      drill: "provider-exit",
      purpose:
        "async-transport + durable-orchestration exit machinery (authority half): the queue-recovery drill classifies every dispatch envelope from the REAL authority (replay convergence is authority-side; the republish half is the tool's own honest not-run registry)",
      script: "drill.ts",
      args: ["queue-recovery", "--environment", "local"],
      env: LOCAL_ENV,
      timeoutMs: 180_000,
      expectation: {
        exit: 0,
        facts: (doc) => ({
          transportPlan: doc.transportPlan,
          notRun: doc.notRun,
          recovered: (doc.drill as Record<string, unknown>)?.recovered,
          objectives: doc.objectives,
        }),
        assert: (result) => {
          const doc = jsonDocumentOf(result.stdout) as {
            drill: { recovered: boolean; rpoMs: number | null };
            transportPlan: { items: number; complete: boolean };
            objectives: {
              measured: boolean;
              evaluation: { rtoWithinTarget: boolean; rpoWithinTarget: boolean };
            };
            notRun: string[];
          };
          if (doc.drill.recovered !== true) {
            throw new Error("the queue-recovery drill did not verify its phases");
          }
          if (doc.transportPlan.complete !== true) {
            throw new Error("the transport recovery plan did not complete its classification");
          }
          // The DEFECT-C regression pin: the durability-anchored
          // scenario measures its objectives (RPO 0 by durability) and
          // exits 0 — never again the contradictory recovered:true +
          // exit 1 gate.
          if (
            doc.objectives.measured !== true ||
            doc.objectives.evaluation.rtoWithinTarget !== true ||
            doc.objectives.evaluation.rpoWithinTarget !== true
          ) {
            throw new Error(
              `the queue-recovery objectives were not met: ${JSON.stringify(doc.objectives)}`,
            );
          }
          if (
            !doc.notRun.some((entry) => entry.includes("transport republish half")) ||
            !doc.notRun.some((entry) => entry.includes("never claimed as PASS"))
          ) {
            throw new Error(
              `the queue-recovery not-run registry deviated: ${JSON.stringify(doc.notRun)}`,
            );
          }
          facts.queueRecovery = {
            items: doc.transportPlan.items,
            complete: doc.transportPlan.complete,
            recovered: doc.drill.recovered,
            rpoMs: doc.drill.rpoMs,
            notRun: doc.notRun,
          };
        },
      },
    });
    await runStep({
      id: "d3-workflow-inspect",
      drill: "provider-exit",
      purpose:
        "durable-orchestration exit (authority half): the orchestration snapshot proves the waits table in PostgreSQL IS the authority (durable wait BEFORE any provider instance); synthetic provider configuration — zero provider calls on the empty substrate",
      script: "workflow.ts",
      args: ["inspect", "--environment", "local"],
      env: WORKFLOW_ENV,
      timeoutMs: 120_000,
      expectation: {
        exit: 0,
        facts: (doc) => ({ snapshot: doc.snapshot, correlationModel: doc.correlationModel }),
        assert: (result) => {
          const doc = jsonDocumentOf(result.stdout) as {
            correlationModel: string;
            snapshot: { totalWaits?: number };
          };
          if (
            !doc.correlationModel.includes("durable PostgreSQL wait BEFORE any provider instance")
          ) {
            throw new Error(
              "the workflow snapshot does not carry the authority-side correlation model",
            );
          }
          if (doc.snapshot.totalWaits !== 0) {
            throw new Error(
              `the drill's authority carries ${doc.snapshot.totalWaits} waits (the drill requires the empty substrate so the synthetic provider configuration never drives a provider call)`,
            );
          }
        },
      },
    });
    await runStep({
      id: "d3-workflow-scan",
      drill: "provider-exit",
      purpose:
        "durable-orchestration exit (authority half): the recovery-scan arming step (the replacement engine is re-armed by the recovery scan — the documented exit path)",
      script: "workflow.ts",
      args: ["scan", "--environment", "local"],
      env: WORKFLOW_ENV,
      timeoutMs: 120_000,
      expectation: {
        exit: 0,
        facts: (doc) => ({ armed: doc.armed }),
      },
    });
    await runStep({
      id: "d3-workflow-recover",
      drill: "provider-exit",
      purpose:
        "durable-orchestration exit (authority half): the restart/outage recovery scan (re-drive deferred starts, re-apply pending effects, supersede stale waits, apply due deadlines)",
      script: "workflow.ts",
      args: ["recover", "--environment", "local"],
      env: WORKFLOW_ENV,
      timeoutMs: 120_000,
      expectation: {
        exit: 0,
        facts: (doc) => ({ recovery: doc.recovery }),
      },
    });
    await runStep({
      id: "d3-workflow-compact",
      drill: "provider-exit",
      purpose:
        "durable-orchestration exit (authority half): the bounded provider-state compaction (instances are terminated by compaction — the documented exit path)",
      script: "workflow.ts",
      args: ["compact", "--environment", "local"],
      env: WORKFLOW_ENV,
      timeoutMs: 120_000,
      expectation: {
        exit: 0,
        facts: (doc) => ({ compaction: doc.compaction }),
      },
    });
    facts.workflowSyntheticConfig = {
      note: "the durable-orchestration steps ran the AUTHORITY-side machinery with SYNTHETIC provider configuration (no Cloudflare credentials exist in this environment); on the empty waits substrate the engine makes zero provider calls (every provider interaction is per-row) — the live provider half is NOT RUN with its owner in the notRun registry",
      providerCallsMade: 0,
    };
    await runStep({
      id: "d3-artifact-exit-refused",
      drill: "provider-exit",
      purpose:
        "artifact-bytes exit: the documented exit path's own fail-closed configuration gate (deploy:drill artifact-exit) — the local environment defines no operative S3-compatible endpoint BY DESIGN; the exit path never fabricates a PASS",
      script: "drill.ts",
      args: ["artifact-exit", "--environment", "local"],
      env: LOCAL_ENV,
      timeoutMs: 120_000,
      negative: true,
      expectation: {
        exit: 2,
        stderrIncludes: [
          "artifact-exit requires the alternate object-store configuration",
          "NOT RUN without it — never claimed as PASS",
        ],
      },
    });

    // experience-delivery exit: the repoint proof (two real planes,
    // byte-identical identity documents, no hosting coordinates).
    const repointPlaneA = await bootPlane({ label: "delivery-repoint-a" });
    let repointPlaneB: PlaneHandle | null = null;
    try {
      const planeB = await bootPlane({ label: "delivery-repoint-b" });
      repointPlaneB = planeB;
      await runInternalStep({
        id: "d3-delivery-repoint",
        drill: "provider-exit",
        purpose:
          "experience-delivery exit: repoint delivery at another host running the same repository entry — the identity documents are BYTE-IDENTICAL and carry NO hosting coordinates; the domain authority is unchanged",
        description:
          "boot two planes on distinct endpoints and compare their /identity documents byte-for-byte",
        action: async () => {
          const [responseA, responseB] = await Promise.all([
            fetch(`${repointPlaneA.baseUrl}/identity`),
            fetch(`${planeB.baseUrl}/identity`),
          ]);
          if (responseA.status !== 200 || responseB.status !== 200) {
            throw new Error(
              `the planes did not answer /identity (A ${responseA.status}, B ${responseB.status})`,
            );
          }
          const textA = await responseA.text();
          const textB = await responseB.text();
          if (textA !== textB) {
            throw new Error(
              "the two planes' identity documents are NOT byte-identical (hosting-independence violated)",
            );
          }
          // No hosting coordinates anywhere in the document (raw text).
          for (const forbidden of [
            repointPlaneA.baseUrl,
            planeB.baseUrl,
            "127.0.0.1",
            "localhost",
          ]) {
            if (textA.includes(forbidden)) {
              throw new Error(
                `the identity document carries a hosting coordinate ("${forbidden}") — repoint would change what the plane attests`,
              );
            }
          }
          const parsed = JSON.parse(textA) as {
            identity: { gitRevision: string };
            runtimeIdentityId: string;
          };
          if (parsed.identity.gitRevision !== revision) {
            throw new Error("the repointed plane does not attest the checkout revision");
          }
          facts.deliveryRepoint = {
            planeA: repointPlaneA.baseUrl,
            planeB: planeB.baseUrl,
            identityByteIdentical: true,
            runtimeIdentityId: parsed.runtimeIdentityId,
            hostingCoordinatesInDocument: false,
          };
          return {
            identityByteIdentical: true,
            runtimeIdentityId: parsed.runtimeIdentityId,
          };
        },
      });
      await runInternalStep({
        id: "d3-exit-postures",
        drill: "provider-exit",
        purpose:
          "ephemeral-coordination + execution-compute + observability-export exit postures, live from the plane's /health: the disposable-coordination drop (degraded-but-alive, the declared mode), the runner-absent state (the declared mode, control plane alive), the logs-only operating state (zero observability configuration)",
        description: "capture and classify the plane's /health dependency postures",
        action: async () => {
          const response = await fetch(`${repointPlaneA.baseUrl}/health`);
          if (response.status !== 200) {
            throw new Error(
              `the plane answered /health ${response.status} (the non-authoritative exit postures must keep the plane ALIVE — degraded-but-alive, never down)`,
            );
          }
          const body = (await response.json()) as {
            status: string;
            controlPlane: string;
            dependencies: {
              name: string;
              authority: string;
              status: string;
              degradedMode?: string;
            }[];
          };
          if (body.controlPlane !== "ready") {
            throw new Error("the control plane is not ready under the exit postures");
          }
          const byConcern = new Map(body.dependencies.map((entry) => [entry.name, entry]));
          const coordination = byConcern.get("ephemeral-coordination");
          if (
            coordination === undefined ||
            coordination.status !== "degraded" ||
            coordination.degradedMode !== "coordination-degraded"
          ) {
            throw new Error(
              `the coordination exit posture deviated: ${JSON.stringify(coordination)}`,
            );
          }
          const compute = byConcern.get("execution-compute");
          if (
            compute === undefined ||
            compute.status !== "degraded" ||
            compute.degradedMode !== "execution-compute-unavailable"
          ) {
            throw new Error(`the compute exit posture deviated: ${JSON.stringify(compute)}`);
          }
          const relational = byConcern.get("relational-state");
          if (relational === undefined || relational.status !== "ready") {
            throw new Error(
              `the relational authority is not ready on the exit-posture plane: ${JSON.stringify(relational)}`,
            );
          }
          facts.exitPostures = {
            planeStatus: body.status,
            controlPlane: body.controlPlane,
            dependencies: body.dependencies.map((entry) => ({
              name: entry.name,
              authority: entry.authority,
              status: entry.status,
              ...(entry.degradedMode === undefined ? {} : { degradedMode: entry.degradedMode }),
            })),
          };
          return {
            planeStatus: body.status,
            coordinationDegraded: true,
            computeUnavailable: true,
            relationalReady: true,
          };
        },
      });
    } finally {
      await repointPlaneA.stop();
      if (repointPlaneB !== null) {
        await repointPlaneB.stop();
      }
    }
    const backupThree = join(scratchRoot, "drill-backup-3.json");
    await runStep({
      id: "d3-authority-fingerprint-after",
      drill: "provider-exit",
      purpose:
        "the domain-authority-untouched proof: after the WHOLE provider-exit segment, the authoritative store's per-table digests are IDENTICAL to the pre-segment fingerprint (the exit mechanics never touched the domain authority)",
      script: "backup.ts",
      args: ["--environment", "local", "--out", backupThree],
      env: LOCAL_ENV,
      timeoutMs: 180_000,
      expectation: {
        exit: 0,
        facts: (doc) => ({ artifact: doc.artifact }),
      },
    });
    await runInternalStep({
      id: "d3-fingerprint-comparison",
      drill: "provider-exit",
      purpose:
        "compare the authority fingerprint before/after the provider-exit segment (refuse on any mismatch)",
      description: "compare per-table digests of the pre/post-exit backups",
      action: async () => {
        const backupThreeDocument = JSON.parse(readFileSync(backupThree, "utf8")) as LogicalBackup;
        const comparison = compareTableDigests(backupTwoDocument, backupThreeDocument);
        if (!comparison.equal) {
          throw new Error(
            `the provider-exit mechanics touched the domain authority: ${comparison.differences.slice(0, 5).join("; ")}`,
          );
        }
        facts.authorityUntouched = true;
        return { equal: true };
      },
    });

    // === DRILL 4 — TEARDOWN CLASSIFICATION GUARDS ========================
    await runStep({
      id: "d4-staging-refused",
      drill: "teardown-guards",
      purpose:
        "the classification guard REFUSES teardown of a persistent environment (staging) — classification, not operator intent, governs removal",
      script: "teardown.ts",
      args: ["--environment", "staging"],
      env: LOCAL_ENV,
      timeoutMs: 120_000,
      negative: true,
      expectation: {
        exit: 3,
        stderrIncludes: ["teardown refused"],
        assert: (result) => {
          if (!result.stderr.includes("classification")) {
            throw new Error("the classification refusal did not name the classification guard");
          }
        },
      },
    });
    await runStep({
      id: "d4-production-refused",
      drill: "teardown-guards",
      purpose:
        "the classification guard REFUSES teardown of production (the second persistent class)",
      script: "teardown.ts",
      args: ["--environment", "production"],
      env: LOCAL_ENV,
      timeoutMs: 120_000,
      negative: true,
      expectation: {
        exit: 3,
        stderrIncludes: ["teardown refused"],
      },
    });
    // The AMBIGUOUS classification: a class/teardown-policy contradiction
    // (class disposable + teardownAllowed false) — the manifest LOADER
    // refuses it BEFORE any destruction.
    const ambiguousTree = archiveTree(revision, "teardown-ambiguous");
    mutateEnvironmentRecord(ambiguousTree, "local", (record) => {
      record.teardownAllowed = false;
    });
    await runStep({
      id: "d4-ambiguous-classification-refused",
      drill: "teardown-guards",
      purpose:
        'an AMBIGUOUS classification (class "disposable" contradicted by teardownAllowed=false) is REFUSED at manifest load, BEFORE any destruction — resources are classified before anything can be destroyed',
      script: "teardown.ts",
      args: ["--environment", "local"],
      cwd: ambiguousTree,
      cwdLabel: "<ambiguous-classification-tree>",
      env: LOCAL_ENV,
      timeoutMs: 120_000,
      negative: true,
      expectation: {
        exit: 1,
        stderrIncludes: ["error:"],
        assert: (result) => {
          if (!result.stderr.includes("must allow teardown")) {
            throw new Error(
              `the ambiguous-classification refusal did not name the classification incoherence: ${result.stderr.slice(0, 300)}`,
            );
          }
          if (/dropped|removed/i.test(result.stdout)) {
            throw new Error("the ambiguous-classification refusal destroyed something anyway");
          }
        },
      },
    });
    // The RECLASSIFIED environment: a coherent persistent classification
    // for local — the guard itself refuses (exit 3).
    const reclassifiedTree = archiveTree(revision, "teardown-reclassified");
    mutateEnvironmentRecord(reclassifiedTree, "local", (record) => {
      record.class = "persistent";
      record.teardownAllowed = false;
    });
    await runStep({
      id: "d4-reclassified-persistent-refused",
      drill: "teardown-guards",
      purpose:
        "an environment RECLASSIFIED persistent by the manifest (coherent classification) is REFUSED by the teardown guard itself — even the disposable-named environment refuses when its classification says persistent",
      script: "teardown.ts",
      args: ["--environment", "local"],
      cwd: reclassifiedTree,
      cwdLabel: "<reclassified-persistent-tree>",
      env: LOCAL_ENV,
      timeoutMs: 120_000,
      negative: true,
      expectation: {
        exit: 3,
        stderrIncludes: ["teardown refused"],
        assert: (result) => {
          if (!result.stderr.includes('class "persistent"')) {
            throw new Error(
              `the reclassified refusal did not name the persistent classification: ${result.stderr.slice(0, 300)}`,
            );
          }
        },
      },
    });
    const deadTeardownPort = await reservePort();
    await runStep({
      id: "d4-dead-pg-refused",
      drill: "teardown-guards",
      purpose:
        "the local teardown's PG drop fails CLOSED when the PostgreSQL authority is unreachable (the provisioned records are removed first — pure local artifacts — but the drop never pretends)",
      script: "teardown.ts",
      args: ["--environment", "local"],
      env: {
        ZECK_ENVIRONMENT: "local",
        ZECK_PG_ADMIN_URL: `postgres://postgres@127.0.0.1:${deadTeardownPort}/postgres`,
        ZECK_LOCAL_DATA_ROOT: join(scratchRoot, "teardown-dead-pg"),
      },
      timeoutMs: 120_000,
      negative: true,
      expectation: {
        exit: 1,
        stderrIncludes: ["error:"],
        assert: (result) => {
          if (/dropped/i.test(result.stdout)) {
            throw new Error("the teardown claimed a drop against a dead authority");
          }
        },
      },
    });
    await runStep({
      id: "d4-teardown-real",
      drill: "teardown-guards",
      purpose:
        "the REAL local teardown removes the provisioned records, drops the computed zeck_local database and removes the local object-store root",
      script: "teardown.ts",
      args: ["--environment", "local"],
      env: PROVISION_ENV,
      timeoutMs: 120_000,
      expectation: {
        exit: 0,
        facts: (doc) => ({ operations: doc.operations }),
        assert: (result) => {
          const doc = jsonDocumentOf(result.stdout) as { operations: string[] };
          if (
            !doc.operations.some((operation) =>
              operation.includes("dropped (if present): zeck_local"),
            )
          ) {
            throw new Error(
              `the real teardown did not drop zeck_local: ${JSON.stringify(doc.operations)}`,
            );
          }
          facts.teardownOperations = doc.operations;
        },
      },
    });
    await runInternalStep({
      id: "d4-post-teardown-verify",
      drill: "teardown-guards",
      purpose:
        "post-teardown round trip: the computed zeck_local database is verified GONE through the same authority the tools use (never assumed)",
      description: "pg round trip: pg_database must not carry zeck_local",
      action: async () => {
        const exists = await withAdminClient(pgAdminUrl, async (client) => {
          const result = await client.query<{ exists: boolean }>({
            text: "SELECT EXISTS (SELECT 1 FROM pg_database WHERE datname = 'zeck_local') AS exists",
          });
          return result.rows[0]?.exists === true;
        });
        if (exists) {
          throw new Error(
            "zeck_local still exists after the real teardown (the drop did not land)",
          );
        }
        facts.zeckLocalDropped = true;
        return { zeckLocalDropped: true };
      },
    });
  } catch (error) {
    runError =
      error instanceof StepError ? error.message : `driver error: ${(error as Error).message}`;
  } finally {
    const drainProblems = await stopPlanes();
    problems.push(...drainProblems.map((problem) => `plane drain: ${problem}`));
    if (baseWorktree !== null) {
      try {
        execFileSync("git", ["worktree", "remove", "--force", baseWorktree], {
          cwd: REPOSITORY_ROOT,
        });
        execFileSync("git", ["worktree", "prune"], { cwd: REPOSITORY_ROOT });
      } catch {
        rmSync(baseWorktree, { recursive: true, force: true });
      }
    }
    // Sweep any restore targets the drill created (the successful
    // restore drops its own; the retained diagnosis target is dropped
    // by its cleanup step — this is the safety net, recorded honestly).
    try {
      const restoreTargetsAfter = await restoreTargetNames(pgAdminUrl);
      const created = restoreTargetsAfter.filter((name) => !restoreTargetsBefore.includes(name));
      for (const name of created) {
        await dropDatabase(pgAdminUrl, name);
      }
      if (created.length > 0) {
        facts.cleanupSweptRestoreTargets = created;
      }
    } catch (error) {
      problems.push(`restore-target sweep failed: ${(error as Error).message}`);
    }
    rmSync(scratchRoot, { recursive: true, force: true });
    rmSync(dataRoot, { recursive: true, force: true });
  }

  // --- the report ----------------------------------------------------------
  const finishedAt = new Date();
  const positives = steps.filter((step) => step.kind === "positive");
  const negatives = steps.filter((step) => step.kind === "negative");
  const failed = steps.filter((step) => !step.ok);
  const stepProblems = failed.map((step) => `${step.id}: ${step.deviation ?? "deviated"}`);
  const allProblems = runError === null ? [...problems, ...stepProblems] : [...problems, runError];
  const report = {
    tool: "deploy/production-drill",
    workOrder: "DEP-043",
    mode: "local-rails",
    environment: "local",
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt.getTime() - startedAt.getTime(),
    revision,
    ...(rollbackTarget === null ? {} : { rollbackTargetRevision: rollbackTarget }),
    pgEndpoint,
    plan: DRILL_PLAN,
    steps,
    facts: {
      ...facts,
      liveCostConsumed:
        "zero (no live-provider operation was executed from this environment — the notRun registry is the recorded boundary)",
    },
    notRun: NOT_RUN_BOUNDARIES,
    totals: {
      stepsPlanned: steps.length,
      stepsPassed: steps.filter((step) => step.ok).length,
      stepsFailed: failed.length,
      positivesPlanned: positives.length,
      positivesPassed: positives.filter((step) => step.ok).length,
      negativesTotal: negatives.length,
      negativesRefused: negatives.filter((step) => step.ok).length,
      durationMs: finishedAt.getTime() - startedAt.getTime(),
    },
    problems: allProblems,
    valid: allProblems.length === 0,
  };
  console.log(JSON.stringify(report, null, 2));
  process.exit(report.valid ? 0 : 1);
}

// ---------------------------------------------------------------------------
// Entry
// ---------------------------------------------------------------------------

const IS_ENTRY =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));

if (IS_ENTRY) {
  main().catch((error: unknown) => {
    console.error(`error: ${(error as Error).message}`);
    process.exit(1);
  });
}
