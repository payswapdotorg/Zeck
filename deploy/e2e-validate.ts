/**
 * deploy/e2e-validate — the DEP-040 end-to-end public deployment
 * validation driver.
 *
 * ONE driver composes the delivered deployment-chain tools in the
 * operator's order of deploy/PUBLIC-DEPLOYMENT.md (§3.1 local rails +
 * the DEP-002 provisioning path + the DEP-003 production verification
 * chain §9), recording each step's REAL exit status, timing and output
 * digest:
 *
 *   validate → bootstrap → provision → migrate → identity →
 *   public-smoke → guardrails (via deploy:release alerts) →
 *   release (record → gate → promote/rollback with plane attestation) →
 *   teardown
 *
 * Every chain step runs as a REAL subprocess (bun deploy/<tool>.ts) and
 * every plane is a REAL deploy/api.ts process probed over real HTTP —
 * never a mock of a tool, never a mocked transport. The driver adds NO
 * authority and redesigns nothing: it verifies the chain, it does not
 * extend it (a defect is reported, not worked around).
 *
 * CREDENTIAL HONESTY (the recorded boundary): the live-provider rails
 * (Neon, Cloudflare, Upstash, Vercel) need operator credentials that do
 * not exist in a worker sandbox — every such rail is recorded in the
 * report's notRun registry with its owner ("Lead credentialed re-run"),
 * never fabricated or assumed-pass. The PG-backed rails (bootstrap,
 * migrate, the release ledger, the strict-200 ready-authority smoke)
 * run FOR REAL against the local PostgreSQL server configured through
 * ZECK_PG_ADMIN_URL (credential-less by the URL-hygiene doctrine: the
 * driver REFUSES a URL with userinfo credentials — the same pattern the
 * architecture secret-scan pins over deploy/**).
 *
 * FAIL-CLOSED SEMANTICS: any failure anywhere in the chain fails the
 * validation (exit 1) — never a warning. Hostile negatives (wrong
 * revision, unreachable plane, tampered identity, malformed guardrail
 * override, at-limit spend fence, mutated manifest limit,
 * classification-guarded teardown) are EXPECTED refusals: each must
 * exit with its exact fail-closed reason or the driver fails.
 *
 * PLANE-BOOT DISCIPLINE (the known race class): the driver never
 * proceeds on a bare /health 200 — it waits for the plane's BOOT
 * DOCUMENT on stdout (the JSON document deploy/api.ts prints once the
 * listener is bound) before probing anything. A /health probe can win
 * against the boot document by a tick; the boot document is the later,
 * authoritative barrier.
 *
 * Usage (the driver's own config — battery-separated from
 * ZECK_PG_TEST_URL):
 *   ZECK_PG_ADMIN_URL=postgres://postgres@127.0.0.1:54329/postgres \
 *     bun deploy/e2e-validate.ts
 *
 * Output: one JSON report on stdout; exit 0 = the whole chain validated
 * (every positive step passed, every hostile negative refused with its
 * exact reason); exit 1 = any step deviated (problems[] carries the
 * exact deviations); exit 2 = the driver's own preflight refused
 * (missing/invalid local rails configuration).
 */

import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
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
import type { QuotaGuardsPolicy } from "../src/platform/observability/alerts";
import { loadQuotaGuardsPolicy } from "../src/platform/observability/alerts";
import { resolveGuardLimit } from "./guardrails";
import { REPOSITORY_ROOT } from "./lib";

// ---------------------------------------------------------------------------
// The operator-order chain plan (PUBLIC-DEPLOYMENT.md) — exported for the
// contract unit test.
// ---------------------------------------------------------------------------

export interface ChainPlanStep {
  readonly id: string;
  readonly tool: string;
  readonly purpose: string;
}

/** The chain this driver composes, in the operator's order. */
export const CHAIN_PLAN: readonly ChainPlanStep[] = Object.freeze([
  {
    id: "validate",
    tool: "deploy/validate.ts",
    purpose:
      "the configuration gate runs FIRST (the full manifest validation — the same gate deploy:provision runs before any write)",
  },
  {
    id: "bootstrap",
    tool: "deploy/bootstrap.ts",
    purpose: "converge the disposable local resource set (create-or-skip, idempotent)",
  },
  {
    id: "provision",
    tool: "deploy/provision.ts",
    purpose:
      "converge the secret-reference scaffold + sandbox-account records (pure manifest projection, idempotent; live-provider steps honestly not-run)",
  },
  {
    id: "migrate",
    tool: "deploy/migrate.ts",
    purpose: "the deterministic startup/migration path against the authoritative database",
  },
  {
    id: "identity",
    tool: "deploy/identity.ts",
    purpose: "emit the deterministic exact-revision deployment identity document",
  },
  {
    id: "public-smoke",
    tool: "deploy/public-smoke.ts",
    purpose:
      "the full public-route production smoke at the exact revision over a real plane (strict ready-authority pass with PostgreSQL + the hostile refusals)",
  },
  {
    id: "guardrails",
    tool: "deploy/release.ts (alerts)",
    purpose:
      "the composed spend/quota guardrail evaluation (manifest-carried thresholds; at-limit DENY, malformed-override abort, mutated-manifest sensitivity)",
  },
  {
    id: "release",
    tool: "deploy/release.ts (record/gate/promote/rollback)",
    purpose:
      "the release ladder over the real PostgreSQL ledger: record → gate evidence → promote with pre-promotion plane attestation (both directions) → rollback re-attestation (pre/post repoint)",
  },
  {
    id: "teardown",
    tool: "deploy/teardown.ts",
    purpose:
      "the classification-guarded disposable-resource removal (persistent classes refuse; the PG drop fails closed when the authority is unreachable)",
  },
] as const);

// ---------------------------------------------------------------------------
// The NOT RUN boundary registry (the credential-honesty doctrine) —
// exported for the contract unit test.
// ---------------------------------------------------------------------------

export interface NotRunBoundary {
  readonly check: string;
  readonly reason: string;
  readonly owner: string;
}

const LEAD_OWNER = "Lead credentialed re-run (deploy/PUBLIC-DEPLOYMENT.md §3.2 + §9)";

/** Every rail this driver cannot run without operator credentials. */
export const NOT_RUN_BOUNDARIES: readonly NotRunBoundary[] = Object.freeze([
  {
    check:
      "Live-provider promotion rails: promote/rollback with --plane-url against a real hosted production plane (Vercel-hosted deploy/api.ts + Neon authority) over the public internet",
    reason:
      "No cloud credentials and no live hosted deployment exist in this environment. The promotion identity core is verified end to end against real local plane processes over real HTTP (both directions, negatives included); the live-hosted application is the credentialed owner's boundary.",
    owner: LEAD_OWNER,
  },
  {
    check:
      "Production/preview-class public smoke over the public internet (deploy:public-smoke --environment production --url https://<live-plane>)",
    reason:
      "No live deployed plane and no transport credential for one in this environment. The --url mode itself is driven end to end against real local planes (verified pass + wrong-revision, unreachable, tampered and dead-authority refusals); the mode is hosting-independent by construction.",
    owner: LEAD_OWNER,
  },
  {
    check:
      "Live-provider resource creation (Neon project/branch, R2 bucket, Cloudflare Queues/Workflows, Upstash, Vercel) from deploy:provision",
    reason:
      "Account-plane work gated on credential PRESENCE (never values): each provider step records honest not-run with its owner in the provision report itself (the driver collects the tool's own liveProviderSteps facts verbatim).",
    owner: LEAD_OWNER,
  },
  {
    check:
      "Live provider spend/quota meters (Neon / Cloudflare / Upstash dashboards and metering APIs) as quota-fence input parity",
    reason:
      "No cloud credentials in this environment. The fence evaluates the AUTHORITATIVE STORES (pg_database_size, dispatch-envelope counts) — live provider-meter parity is the credentialed operator's re-verification.",
    owner: LEAD_OWNER,
  },
  {
    check:
      "artifact-bytes guardrail utilization measurement (the object store's own meter is credential-gated)",
    reason:
      "Not measurable from the local authoritative stores by construction; the guardrail evaluation invents nothing for it (the projection test pins the absence — never a fabricated snapshot).",
    owner: "Lead credentialed re-run (R2 meter parity when the artifact store is live)",
  },
  {
    check: "CI execution of the full suite on the branch",
    reason: "Workers do not push and do not open PRs; CI runs on the Lead's merge.",
    owner: "Lead merge + CI (.github/workflows)",
  },
] as const);

// ---------------------------------------------------------------------------
// URL hygiene (the B5 pattern class): local/dead-port URLs are
// credential-less by construction — exported for the contract unit test.
// ---------------------------------------------------------------------------

export interface PgAdminUrlCheck {
  readonly ok: boolean;
  readonly endpoint?: string;
  readonly reason?: string;
}

/**
 * Validate a local PostgreSQL admin URL: parseable, and CARRYING NO
 * USERINFO CREDENTIALS (the pattern scheme://user:password@host is
 * exactly what the architecture secret-scan pins over deploy/** — a
 * driver that constructed such a URL would trip its own repo's pin, and
 * one that accepted it would carry credentials it must never see).
 */
export function checkPgAdminUrl(raw: string | undefined): PgAdminUrlCheck {
  if (raw === undefined || raw.trim() === "") {
    return {
      ok: false,
      reason:
        "ZECK_PG_ADMIN_URL is required (the driver's local rails run against a real local PostgreSQL server; credential-less, e.g. postgres://postgres@127.0.0.1:54329/postgres)",
    };
  }
  if (/[a-z][a-z0-9+.-]*:\/\/[^\s"'@/:]+:[^\s"'@]+@/i.test(raw)) {
    return {
      ok: false,
      reason:
        "ZECK_PG_ADMIN_URL carries URL-embedded credentials (scheme://user:password@host) — refusing: local rails are configured credential-less (the same pattern the repository secret-scan pins over deploy/**)",
    };
  }
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "postgres:" && parsed.protocol !== "postgresql:") {
      return {
        ok: false,
        reason: `ZECK_PG_ADMIN_URL must be a postgres:// URL (got ${parsed.protocol})`,
      };
    }
    return { ok: true, endpoint: `${parsed.hostname}:${parsed.port || "5432"}` };
  } catch (error) {
    return {
      ok: false,
      reason: `ZECK_PG_ADMIN_URL is not a parseable URL: ${(error as Error).message}`,
    };
  }
}

// ---------------------------------------------------------------------------
// The boot-document detector (the plane-boot race discipline) — exported
// for the contract unit test.
// ---------------------------------------------------------------------------

export interface PlaneBootDocument {
  readonly tool: string;
  readonly status: string;
  readonly environment: string;
  readonly host: string;
  readonly port: number;
  readonly routes: number;
}

/**
 * Detect the plane's BOOT DOCUMENT in accumulated stdout: the JSON
 * document deploy/api.ts prints once its listener is bound (status
 * "listening"). The driver waits for THIS — never a bare /health 200
 * (a health probe can win against the boot document by a tick).
 */
export function bootDocumentOf(stdout: string): PlaneBootDocument | null {
  const start = stdout.indexOf("{");
  if (start < 0) {
    return null;
  }
  const candidate = stdout.slice(start);
  // The boot document is the first complete JSON object on stdout.
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = 0; index < candidate.length; index += 1) {
    const char = candidate[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
    } else if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        try {
          const parsed = JSON.parse(candidate.slice(0, index + 1)) as Record<string, unknown>;
          if (
            parsed.tool === "deploy/api" &&
            parsed.status === "listening" &&
            typeof parsed.port === "number"
          ) {
            return {
              tool: String(parsed.tool),
              status: String(parsed.status),
              environment: String(parsed.environment ?? ""),
              host: String(parsed.host ?? ""),
              port: parsed.port,
              routes: typeof parsed.routes === "number" ? parsed.routes : 0,
            };
          }
          return null;
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Guardrail expectations (manifest-cross-checked, never tool-local
// constants) — exported for the contract unit test.
// ---------------------------------------------------------------------------

export interface GuardrailLimitExpectation {
  readonly guard: string;
  readonly limit: number | null;
  readonly source: string;
}

/**
 * The driver's expected BASELINE guardrail limit resolutions, derived
 * from the loaded quota-guards policy at runtime (the manifest is the
 * only limit carrier — if the manifest row moves, the expectation and
 * the fence move with it).
 */
export function baselineGuardrailExpectations(
  policy: QuotaGuardsPolicy,
  env: Readonly<Record<string, string | undefined>> = {},
): readonly GuardrailLimitExpectation[] {
  return [
    resolveGuardLimit("queue-backlog", policy, env.ZECK_QUEUE_BACKLOG_BOUND),
    resolveGuardLimit("database-size", policy, env.ZECK_DB_SIZE_LIMIT_BYTES),
  ];
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
  readonly assert?: (result: ToolResult) => void;
}

interface StepSpec {
  readonly id: string;
  readonly chainStep: string;
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
  readonly chainStep: string;
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
const stdoutById = new Map<string, string>();
const facts: Record<string, unknown> = {};

function stdoutOf(stepId: string): string {
  const captured = stdoutById.get(stepId);
  if (captured === undefined) {
    throw new StepError(`no captured stdout for step ${stepId}`);
  }
  return captured;
}

async function runStep(spec: StepSpec): Promise<StepRecord> {
  const cwd = spec.cwd ?? REPOSITORY_ROOT;
  const result = await spawnTool(
    ["bun", join("deploy", spec.script), ...spec.args],
    cwd,
    spec.env,
    spec.timeoutMs ?? 120_000,
  );
  stdoutById.set(spec.id, result.stdout);
  const record = evaluateStep(spec, result, cwd);
  steps.push(record);
  const mark = record.ok ? (spec.negative === true ? "REFUSED-OK" : "PASS") : "FAIL";
  process.stderr.write(
    `[e2e] ${record.id}: exit ${record.exitCode} (expected ${spec.expectation.exit}) ${mark} ${record.durationMs}ms\n`,
  );
  if (!record.ok) {
    // Any failure anywhere in the chain fails the validation — and the
    // chain STOPS (dependent steps would cascade meaningless failures).
    throw new StepError(record.deviation ?? `${record.id} deviated`);
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

function evaluateStep(spec: StepSpec, result: ToolResult, cwd: string): StepRecord {
  const expectation = spec.expectation;
  let ok = result.code === expectation.exit && !result.timedOut;
  let deviation: string | undefined;
  const stepFacts: Record<string, unknown> = {};
  if (result.timedOut) {
    deviation = `the step timed out after ${spec.timeoutMs ?? 120_000}ms`;
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
      expectation.assert(result);
    } catch (error) {
      ok = false;
      deviation = (error as Error).message;
    }
  }
  const refusalReason = spec.negative === true ? refusalReasonOf(result) : undefined;
  return {
    id: spec.id,
    chainStep: spec.chainStep,
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
// Plane runner (real deploy/api.ts subprocesses; boot-document wait)
// ---------------------------------------------------------------------------

interface PlaneHandle {
  readonly baseUrl: string;
  readonly boot: PlaneBootDocument;
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
 * stdout — the plane-boot race discipline: never proceed on a bare
 * /health 200 (the health probe can win against the boot document by a
 * tick; the boot document is the later, authoritative barrier). After
 * the boot document, the transport is confirmed with one /health probe.
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
    const boot = await new Promise<PlaneBootDocument | null>((resolvePromise) => {
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
      `[e2e] plane ${options.label} booted on ${baseUrl} (boot document seen)\n`,
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
// Scratch trees (git archive + ONE manifest row mutation each) — the
// tamper and guardrail-sensitivity drills
// ---------------------------------------------------------------------------

function git(args: readonly string[], cwd: string = REPOSITORY_ROOT): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

/** A git-archive snapshot of the exact revision (no .git — a pure tree). */
function archiveTree(revision: string, label: string): string {
  const dir = mkdtempSync(join(tmpdir(), `zeck-e2e-${label}-`));
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

/** Overwrite one nested manifest value (the mutated-limit drill). */
function mutateManifestValue(
  tree: string,
  manifestFile: string,
  mutate: (document: Record<string, unknown>) => void,
): void {
  const path = join(tree, "deploy", "manifests", manifestFile);
  const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
  mutate(parsed);
  writeFileSync(path, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
}

// ---------------------------------------------------------------------------
// The rollback target resolution
// ---------------------------------------------------------------------------

/**
 * The rollback drill's target revision: the nearest ancestor (preferring
 * origin/main — the branch base) whose deploy/manifests tree is
 * byte-identical to HEAD's. The rollback re-attestation verifies the
 * plane against the CURRENT manifest set, so a target with drifted
 * manifests would refuse for the wrong reason; the drill needs a
 * revision pair whose identities differ ONLY by revision.
 */
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
// Identity helpers (the exact-revision document, before and after)
// ---------------------------------------------------------------------------

let identityBefore: { identityId: string; manifestDigest: string; outputDigest: string } | null =
  null;
let runtimeIdentityIdBefore = "";

async function runtimeIdentityIdOf(revision: string): Promise<string> {
  const { parseProviderTiers } = await import("../src/platform/deployment/provider-tiers");
  const { runtimeDeploymentIdentity } = await import("../src/platform/deployment/runtime-identity");
  const { loadManifest } = await import("./lib");
  const manifest = loadManifest();
  const ledger = parseProviderTiers(
    readFileSync(join(REPOSITORY_ROOT, "deploy", "manifests", "provider-tiers.json"), "utf8"),
    manifest,
  );
  return runtimeDeploymentIdentity(manifest, ledger, revision, "local", undefined)
    .runtimeIdentityId;
}

async function emitIdentity(
  id: string,
  purpose: string,
  revision: string,
): Promise<{ identityId: string; manifestDigest: string; outputDigest: string }> {
  const record = await runStep({
    id,
    chainStep: "identity",
    purpose,
    script: "identity.ts",
    args: ["--environment", "local"],
    env: { ZECK_ENVIRONMENT: "local" },
    timeoutMs: 60_000,
    expectation: {
      exit: 0,
      facts: (doc) => ({
        identityId: doc.identityId,
        gitRevision: doc.gitRevision,
        manifestDigest: doc.manifestDigest,
        resourceDigest: doc.resourceDigest,
      }),
      assert: (result) => {
        const doc = jsonDocumentOf(result.stdout) as { gitRevision: string };
        if (doc.gitRevision !== revision) {
          throw new Error("the emitted identity does not bind the checkout revision");
        }
      },
    },
  });
  const doc = jsonDocumentOf(stdoutOf(id)) as { identityId: string; manifestDigest: string };
  const emission = {
    identityId: doc.identityId,
    manifestDigest: doc.manifestDigest,
    outputDigest: record.outputDigest,
  };
  if (identityBefore === null) {
    identityBefore = emission;
  }
  return emission;
}

// ---------------------------------------------------------------------------
// The driver
// ---------------------------------------------------------------------------

const WRONG_REVISION = "b".repeat(40);
const DRIVER_ACTOR = "dep-040-e2e-driver";

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
  const revision = git(["rev-parse", "HEAD"]);
  if (!/^[0-9a-f]{40}$/.test(revision)) {
    throw new Error(`HEAD is not an exact revision: ${revision}`);
  }
  const rollbackTarget = resolveRollbackTarget(revision);
  const dataRoot = mkdtempSync(join(tmpdir(), "zeck-e2e-data-"));
  const scratchRoot = mkdtempSync(join(tmpdir(), "zeck-e2e-scratch-"));

  const LOCAL_ENV = { ZECK_ENVIRONMENT: "local", ZECK_PG_ADMIN_URL: pgAdminUrl };
  const PROVISION_ENV = { ...LOCAL_ENV, ZECK_LOCAL_DATA_ROOT: dataRoot };

  const problems: string[] = [];
  let baseWorktree: string | null = null;
  let runError: string | null = null;

  try {
    // --- chain step: validate (the configuration gate runs FIRST) ---------
    await runStep({
      id: "validate",
      chainStep: "validate",
      purpose: CHAIN_PLAN[0]?.purpose ?? "",
      script: "validate.ts",
      args: [],
      timeoutMs: 120_000,
      expectation: {
        exit: 0,
        facts: (doc) => ({
          valid: doc.valid,
          environments: doc.environments,
          providers: doc.providers,
          migrations: doc.migrations,
          quotaGuards: doc.quotaGuards,
          sandboxAccounts: doc.sandboxAccounts,
        }),
        assert: (result) => {
          if (jsonDocumentOf(result.stdout).valid !== true) {
            throw new Error("deploy:validate did not report valid=true");
          }
        },
      },
    });

    // --- chain step: bootstrap (idempotent convergence) -------------------
    await runStep({
      id: "bootstrap",
      chainStep: "bootstrap",
      purpose: CHAIN_PLAN[1]?.purpose ?? "",
      script: "bootstrap.ts",
      args: ["--environment", "local"],
      env: LOCAL_ENV,
      timeoutMs: 120_000,
      expectation: {
        exit: 0,
        facts: (doc) => ({
          operations: doc.operations,
          environmentContract: doc.environmentContract,
        }),
      },
    });
    await runStep({
      id: "bootstrap-idempotent",
      chainStep: "bootstrap",
      purpose:
        "the second bootstrap converges to the same state (create-or-skip, never duplicated)",
      script: "bootstrap.ts",
      args: ["--environment", "local"],
      env: LOCAL_ENV,
      timeoutMs: 120_000,
      expectation: {
        exit: 0,
        facts: (doc) => ({ operations: doc.operations }),
        assert: (result) => {
          const doc = jsonDocumentOf(result.stdout) as {
            operations: { kind?: string; action?: string }[];
          };
          const pg = doc.operations.find((operation) => operation.kind === "pg-database");
          if (pg?.action !== "already-present (converged)") {
            throw new Error(
              `the second bootstrap did not report the database already converged (got: ${pg?.action})`,
            );
          }
        },
      },
    });

    // --- chain step: provision (plan → converge → idempotent) -------------
    await runStep({
      id: "provision-plan",
      chainStep: "provision",
      purpose:
        "the dry-run plan mode requires zero credentials (the full convergence plan, no writes)",
      script: "provision.ts",
      args: ["--environment", "local", "--plan", "--json"],
      env: PROVISION_ENV,
      timeoutMs: 120_000,
      expectation: {
        exit: 0,
        facts: (doc) => ({ mode: doc.mode }),
      },
    });
    await runStep({
      id: "provision-preview-plan-live-steps-notrun",
      chainStep: "provision",
      purpose:
        "the preview-class plan (zero credentials, plan-only, no writes) carries the tool's OWN honest live-provider not-run registry: every provider step not-run with the recorded owner",
      script: "provision.ts",
      args: [
        "--environment",
        "preview",
        "--branch",
        "work/DEP-040-deployment-validation",
        "--plan",
        "--json",
      ],
      env: { ZECK_ENVIRONMENT: "preview", ZECK_LOCAL_DATA_ROOT: dataRoot },
      timeoutMs: 120_000,
      expectation: {
        exit: 0,
        facts: (doc) => ({ mode: doc.mode, liveProviderSteps: doc.liveProviderSteps }),
        assert: (result) => {
          const doc = jsonDocumentOf(result.stdout) as {
            liveProviderSteps: {
              status: string;
              credentialsPresent: boolean;
              owner: string | null;
            }[];
          };
          if (doc.liveProviderSteps.length === 0) {
            throw new Error("the preview plan carried no live-provider steps to record honestly");
          }
          for (const step of doc.liveProviderSteps) {
            if (
              step.status !== "not-run" ||
              step.credentialsPresent !== false ||
              step.owner === null
            ) {
              throw new Error(
                `a live-provider step was not honestly not-run: ${JSON.stringify(step)}`,
              );
            }
          }
          // The tool's own honest not-run registry, collected verbatim.
          facts.provisionLiveProviderSteps = doc.liveProviderSteps;
        },
      },
    });
    await runStep({
      id: "provision-converge",
      chainStep: "provision",
      purpose: CHAIN_PLAN[2]?.purpose ?? "",
      script: "provision.ts",
      args: ["--environment", "local", "--json"],
      env: PROVISION_ENV,
      timeoutMs: 120_000,
      expectation: {
        exit: 0,
        facts: (doc) => ({
          converged: (doc.convergence as Record<string, unknown>)?.converged,
          created: (doc.convergence as Record<string, unknown>)?.created,
          liveProviderSteps: doc.liveProviderSteps,
        }),
        assert: (result) => {
          const doc = jsonDocumentOf(result.stdout) as {
            convergence: { converged: boolean; created: unknown[] };
          };
          if (!doc.convergence.converged || doc.convergence.created.length === 0) {
            throw new Error("the first provision run did not create the artifact set");
          }
        },
      },
    });
    await runStep({
      id: "provision-idempotent",
      chainStep: "provision",
      purpose: "the second provision run reports already-converged (the deterministic projection)",
      script: "provision.ts",
      args: ["--environment", "local", "--json"],
      env: PROVISION_ENV,
      timeoutMs: 120_000,
      expectation: {
        exit: 0,
        facts: (doc) => ({
          alreadyConverged: (doc.convergence as Record<string, unknown>)?.alreadyConverged,
          created: (doc.convergence as Record<string, unknown>)?.created,
          unchanged: (doc.convergence as Record<string, unknown>)?.unchanged,
        }),
        assert: (result) => {
          const doc = jsonDocumentOf(result.stdout) as {
            convergence: { alreadyConverged: boolean; created: unknown[] };
          };
          if (!doc.convergence.alreadyConverged || doc.convergence.created.length > 0) {
            throw new Error("the second provision run did not report already-converged");
          }
        },
      },
    });

    // --- chain step: migrate (deterministic, idempotent) ------------------
    await runStep({
      id: "migrate",
      chainStep: "migrate",
      purpose: CHAIN_PLAN[3]?.purpose ?? "",
      script: "migrate.ts",
      args: ["--environment", "local"],
      env: LOCAL_ENV,
      timeoutMs: 300_000,
      expectation: {
        exit: 0,
        facts: (doc) => ({
          serverVersion: doc.serverVersion,
          migrations: doc.migrations,
          schemaConverged: doc.schemaConverged,
        }),
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
    await runStep({
      id: "migrate-idempotent",
      chainStep: "migrate",
      purpose: "the second migrate run applies nothing (exactly-once, forward-only)",
      script: "migrate.ts",
      args: ["--environment", "local"],
      env: LOCAL_ENV,
      timeoutMs: 300_000,
      expectation: {
        exit: 0,
        facts: (doc) => ({ migrations: doc.migrations }),
        assert: (result) => {
          const doc = jsonDocumentOf(result.stdout) as { migrations: { appliedCount: number } };
          if (doc.migrations.appliedCount !== 0) {
            throw new Error(
              `the second migrate run applied ${doc.migrations.appliedCount} migration(s) (expected 0)`,
            );
          }
        },
      },
    });

    // --- chain step: identity (the exact-revision document, BEFORE) -------
    await emitIdentity(
      "identity-before",
      "the deterministic exact-revision identity document (emitted BEFORE the verification chain)",
      revision,
    );
    runtimeIdentityIdBefore = await runtimeIdentityIdOf(revision);

    // --- chain step: public-smoke (strict, ready authority) ---------------
    await runStep({
      id: "public-smoke-strict",
      chainStep: "public-smoke",
      purpose:
        "the full public-route production smoke at the exact revision, STRICT (the reachable PostgreSQL authority answers /health 200 ready)",
      script: "public-smoke.ts",
      args: ["--environment", "local"],
      env: LOCAL_ENV,
      timeoutMs: 180_000,
      expectation: {
        exit: 0,
        facts: (doc) => ({
          mode: doc.mode,
          expectedRevision: doc.expectedRevision,
          attestation: doc.attestation,
          routeCoverage: doc.routeCoverage,
          runtimeIdentityId: doc.runtimeIdentityId,
          host: doc.host,
        }),
        assert: (result) => {
          const doc = jsonDocumentOf(result.stdout) as {
            expectedRevision: string;
            attestation: Record<string, unknown>;
            routeCoverage: Record<string, unknown>;
            runtimeIdentityId: string;
          };
          if (doc.expectedRevision !== revision) {
            throw new Error("the smoke did not attest the checkout revision");
          }
          if (
            doc.attestation.identityVerified !== true ||
            doc.attestation.transportReachable !== true
          ) {
            throw new Error("the strict smoke did not verify the plane identity");
          }
          // The strict ready-AUTHORITY proof: the authoritative relational
          // dependency is attested (200 — a fail-closed authority would
          // answer 503 down). The bootstrap composition honestly reports
          // healthCheck "degraded" when its non-authoritative dependencies
          // are not probed (deploy:smoke owns the full probe set) — the
          // 200-vs-503 distinction is the strict boundary here.
          if (doc.attestation.healthStatus !== 200) {
            throw new Error(
              `the strict smoke did not see the ready authority (healthStatus ${String(
                doc.attestation.healthStatus,
              )}, healthCheck ${String(doc.attestation.healthCheck)})`,
            );
          }
          if (
            doc.attestation.healthCheck !== "ready" &&
            doc.attestation.healthCheck !== "degraded"
          ) {
            throw new Error(
              `the strict smoke's health classification is not the honest vocabulary: ${String(
                doc.attestation.healthCheck,
              )}`,
            );
          }
          const coverage = doc.routeCoverage;
          if (
            coverage.probed !== 26 ||
            coverage.authBoundaryEnforced !== 18 ||
            coverage.capabilityUnboundHonest !== 7 ||
            coverage.publicArtifactBound !== 1
          ) {
            throw new Error(
              `the route coverage counts deviated from the public route table: ${JSON.stringify(coverage)}`,
            );
          }
          if (doc.runtimeIdentityId !== runtimeIdentityIdBefore) {
            throw new Error(
              "the smoke's runtime identity does not equal the recomputed runtime identity (attestation drift)",
            );
          }
          facts.routeCoverage = coverage;
          facts.strictSmokeAttestation = doc.attestation;
        },
      },
    });

    // --- the wrong-revision / unreachable smoke negatives ------------------
    const wrongPlane = await bootPlane({
      label: "wrong-revision",
      revisionOverride: WRONG_REVISION,
    });
    try {
      await runStep({
        id: "public-smoke-wrong-revision-refused",
        chainStep: "public-smoke",
        purpose:
          "a plane attesting the WRONG revision FAILS the smoke (never a warning — even with --allow-degraded)",
        script: "public-smoke.ts",
        args: ["--environment", "local", "--url", wrongPlane.baseUrl, "--allow-degraded"],
        env: LOCAL_ENV,
        timeoutMs: 180_000,
        negative: true,
        expectation: {
          exit: 1,
          assert: (result) => {
            const doc = jsonDocumentOf(result.stdout) as {
              attestation: { identityVerified: boolean };
              problems: string[];
            };
            if (doc.attestation.identityVerified !== false) {
              throw new Error("the wrong-revision smoke did not fail the identity verification");
            }
            if (
              !doc.problems.some((problem) => problem.includes("exact-revision identity attest"))
            ) {
              throw new Error("the wrong-revision refusal did not name the exact-revision attest");
            }
          },
        },
      });
    } finally {
      await wrongPlane.stop();
    }
    const deadSmokePort = await reservePort();
    await runStep({
      id: "public-smoke-unreachable-refused",
      chainStep: "public-smoke",
      purpose:
        "an UNREACHABLE plane FAILS the smoke (transportReachable false — never a partial pass)",
      script: "public-smoke.ts",
      args: [
        "--environment",
        "local",
        "--url",
        `http://127.0.0.1:${deadSmokePort}`,
        "--allow-degraded",
      ],
      env: LOCAL_ENV,
      timeoutMs: 180_000,
      negative: true,
      expectation: {
        exit: 1,
        assert: (result) => {
          const doc = jsonDocumentOf(result.stdout) as {
            attestation: { transportReachable: boolean; identityVerified: boolean };
            problems: string[];
          };
          if (
            doc.attestation.transportReachable !== false ||
            doc.attestation.identityVerified !== false
          ) {
            throw new Error("the unreachable smoke did not fail closed on transport");
          }
          if (!doc.problems.some((problem) => problem.includes("did not become reachable"))) {
            throw new Error("the unreachable refusal did not name the transport failure");
          }
        },
      },
    });

    // --- the dead-authority health boundary (a real refused TCP connect) --
    const deadPgPort = await reservePort();
    const deadPlane = await bootPlane({
      label: "dead-authority",
      env: { ZECK_PG_ADMIN_URL: `postgres://postgres@127.0.0.1:${deadPgPort}/postgres` },
    });
    try {
      const health = await fetch(`${deadPlane.baseUrl}/health`);
      const healthBody = (await health.json()) as { status?: string; controlPlane?: string };
      if (
        health.status !== 503 ||
        healthBody.status !== "down" ||
        healthBody.controlPlane !== "ready"
      ) {
        problems.push(
          `the dead-authority plane answered /health ${health.status} ${JSON.stringify(
            healthBody.status,
          )} (expected 503 down with controlPlane ready)`,
        );
      } else {
        facts.deadAuthorityHealth = { status: health.status, body: healthBody };
      }
      await runStep({
        id: "public-smoke-dead-authority-strict-refused",
        chainStep: "public-smoke",
        purpose:
          "the strict smoke REFUSES a plane whose authoritative dependency is genuinely unreachable (a real refused TCP connect — never a warning)",
        script: "public-smoke.ts",
        args: ["--environment", "local", "--url", deadPlane.baseUrl],
        env: LOCAL_ENV,
        timeoutMs: 180_000,
        negative: true,
        expectation: {
          exit: 1,
          assert: (result) => {
            const doc = jsonDocumentOf(result.stdout) as { problems: string[] };
            if (!doc.problems.some((problem) => problem.includes("GET /health answered 503"))) {
              throw new Error("the strict refusal did not name the 503 authority problem");
            }
          },
        },
      });
      await runStep({
        id: "public-smoke-dead-authority-degraded-allowed",
        chainStep: "public-smoke",
        purpose:
          "--allow-degraded records the EXPLICIT degraded boundary (the flag records the boundary; it never widens it)",
        script: "public-smoke.ts",
        args: ["--environment", "local", "--url", deadPlane.baseUrl, "--allow-degraded"],
        env: LOCAL_ENV,
        timeoutMs: 180_000,
        expectation: {
          exit: 0,
          facts: (doc) => ({
            healthCheck: (doc.attestation as Record<string, unknown>)?.healthCheck,
          }),
          assert: (result) => {
            const doc = jsonDocumentOf(result.stdout) as {
              attestation: { healthCheck: string };
              problems: string[];
            };
            if (!doc.attestation.healthCheck.includes("down-allowed-degraded")) {
              throw new Error(
                `the degraded pass did not record the explicit marker (got: ${doc.attestation.healthCheck})`,
              );
            }
            if (doc.problems.length !== 0) {
              throw new Error("the degraded pass carries problems");
            }
          },
        },
      });
    } finally {
      await deadPlane.stop();
    }

    // --- the tampered-identity drill (git archive + ONE manifest row) -----
    const tamperTree = archiveTree(revision, "tamper");
    insertManifestRow(tamperTree, "variables.json", "variables", {
      name: "ZECK_E2E_TAMPER_PROBE",
      type: "string",
      required: false,
      credentialShaped: false,
      description:
        "DEP-040 tamper drill row: one well-formed extra variable row the exact-revision identity recompute must refuse (drift detection, never a crash).",
    });
    // The row is WELL-FORMED: the tampered tree's own configuration gate
    // still passes — the refusal below is the IDENTITY mismatch, not a
    // malformed manifest.
    await runStep({
      id: "tamper-tree-validate-passes",
      chainStep: "public-smoke",
      purpose:
        "the tampered tree (git archive + one well-formed variables.json row) still passes deploy:validate — the manifest is well-formed; only the identity drifted",
      script: "validate.ts",
      args: [],
      cwd: tamperTree,
      cwdLabel: "<tamper-tree>",
      timeoutMs: 120_000,
      expectation: {
        exit: 0,
        facts: (doc) => ({ valid: doc.valid }),
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
        id: "public-smoke-tampered-refused",
        chainStep: "public-smoke",
        purpose:
          "a plane serving a TAMPERED manifest set at the claimed revision is REFUSED on identity-recompute mismatch — not a crash, the exact reason",
        script: "public-smoke.ts",
        args: ["--environment", "local", "--url", tamperPlane.baseUrl, "--allow-degraded"],
        env: LOCAL_ENV,
        timeoutMs: 180_000,
        negative: true,
        expectation: {
          exit: 1,
          assert: (result) => {
            const doc = jsonDocumentOf(result.stdout) as { problems: string[] };
            const identityProblem = doc.problems.find(
              (problem) =>
                problem.includes("exact-revision identity attest") &&
                problem.includes("does not recompute"),
            );
            if (identityProblem === undefined) {
              throw new Error(
                `the tampered plane was not refused with the identity-recompute reason: ${JSON.stringify(
                  doc.problems,
                )}`,
              );
            }
            facts.tamperRefusalReason = identityProblem;
          },
        },
      });
    } finally {
      await tamperPlane.stop();
    }

    // --- chain step: guardrails (the composed evaluation) ------------------
    const baselineLimits = baselineGuardrailExpectations(
      loadQuotaGuardsPolicy(
        readFileSync(join(REPOSITORY_ROOT, "deploy", "manifests", "quota-guards.json"), "utf8"),
      ),
      process.env,
    );
    facts.baselineLimitResolutions = baselineLimits;
    await runStep({
      id: "guardrails-baseline-under-threshold",
      chainStep: "guardrails",
      purpose:
        "the composed guardrail evaluation with the manifest-carried limits: under-threshold allow (no critical alert, promotion not blocked)",
      script: "release.ts",
      args: ["alerts", "--environment", "local"],
      env: LOCAL_ENV,
      timeoutMs: 180_000,
      expectation: {
        exit: 0,
        facts: (doc) => ({
          critical: doc.critical,
          limitResolutions: (doc.guardrails as Record<string, unknown>)?.limitResolutions,
          thresholdsApplied: (doc.guardrails as Record<string, unknown>)?.thresholdsApplied,
          promotionBlocked: (doc.guardrails as Record<string, unknown>)?.promotionBlocked,
        }),
        assert: (result) => {
          const doc = jsonDocumentOf(result.stdout) as {
            critical: boolean;
            guardrails: { limitResolutions: { guard: string; limit: number; source: string }[] };
          };
          if (doc.critical !== false) {
            throw new Error(
              "the baseline guardrail evaluation reported a critical alert on a fresh ledger",
            );
          }
          const resolutions = doc.guardrails.limitResolutions;
          for (const expected of baselineLimits) {
            const actual = resolutions.find((entry) => entry.guard === expected.guard);
            if (
              actual === undefined ||
              actual.limit !== expected.limit ||
              actual.source !== expected.source
            ) {
              throw new Error(
                `guard ${expected.guard} resolved ${JSON.stringify(actual)} but the manifest declares ${JSON.stringify(
                  expected,
                )}`,
              );
            }
          }
        },
      },
    });
    await runStep({
      id: "guardrails-at-limit-deny",
      chainStep: "guardrails",
      purpose:
        "at-limit DENY: a provider-concern usage snapshot at/over its declared limit refuses with the provider's declared degradation mode (CRITICAL blocks promotion)",
      script: "release.ts",
      args: ["alerts", "--environment", "local"],
      env: { ...LOCAL_ENV, ZECK_DB_SIZE_LIMIT_BYTES: "1" },
      timeoutMs: 180_000,
      negative: true,
      expectation: {
        exit: 1,
        assert: (result) => {
          const doc = jsonDocumentOf(result.stdout) as {
            critical: boolean;
            guardrails: {
              fenceDecisions: {
                concern: string;
                decision: string;
                denyReason?: string;
                degradedMode?: string;
              }[];
              limitResolutions: { guard: string; limit: number; source: string }[];
            };
          };
          if (doc.critical !== true) {
            throw new Error("the at-limit evaluation did not report the critical alert");
          }
          const fence = doc.guardrails.fenceDecisions.find(
            (entry) => entry.concern === "relational-state",
          );
          if (
            fence === undefined ||
            fence.decision !== "deny" ||
            fence.denyReason !== "quota-exhausted" ||
            fence.degradedMode !== "authority-unavailable"
          ) {
            throw new Error(
              `the at-limit fence did not deny with the declared degradation mode: ${JSON.stringify(fence)}`,
            );
          }
          const resolution = doc.guardrails.limitResolutions.find(
            (entry) => entry.guard === "database-size",
          );
          if (resolution?.limit !== 1 || resolution.source !== "operator-override") {
            throw new Error(
              `the at-limit resolution was not the operator override: ${JSON.stringify(resolution)}`,
            );
          }
          facts.atLimitFence = fence;
        },
      },
    });
    await runStep({
      id: "guardrails-malformed-override-aborts",
      chainStep: "guardrails",
      purpose:
        "a MALFORMED operator limit override ABORTS the evaluation fail-closed (never a silent substitution of the manifest default)",
      script: "release.ts",
      args: ["alerts", "--environment", "local"],
      env: { ...LOCAL_ENV, ZECK_DB_SIZE_LIMIT_BYTES: "12abc" },
      timeoutMs: 180_000,
      negative: true,
      expectation: {
        exit: 1,
        stderrIncludes: ["malformed limit"],
        assert: (result) => {
          if (!result.stderr.includes("fail closed")) {
            throw new Error("the malformed-override abort did not carry the fail-closed reason");
          }
          if (result.stderr.includes("5368709120")) {
            throw new Error("the abort leaked a silent manifest substitution");
          }
        },
      },
    });
    const guardrailMutantTree = archiveTree(revision, "guardrail-mutant");
    mutateManifestValue(guardrailMutantTree, "quota-guards.json", (document) => {
      const guards = document.guards as Record<string, Record<string, unknown>>;
      const row = guards["database-size"];
      if (row === undefined) {
        throw new StepError("quota-guards.json carries no database-size row to mutate");
      }
      row.defaultLimitBytes = 1;
    });
    await runStep({
      id: "guardrails-mutated-manifest-limit-moves-the-fence",
      chainStep: "guardrails",
      purpose:
        "mutated-threshold sensitivity: change the manifest limit row → the fence moves (thresholds and limits are never tool-local constants)",
      script: "release.ts",
      args: ["alerts", "--environment", "local"],
      cwd: guardrailMutantTree,
      cwdLabel: "<guardrail-mutant-tree>",
      env: LOCAL_ENV,
      timeoutMs: 180_000,
      negative: true,
      expectation: {
        exit: 1,
        assert: (result) => {
          const doc = jsonDocumentOf(result.stdout) as {
            critical: boolean;
            guardrails: {
              fenceDecisions: { concern: string; decision: string; denyReason?: string }[];
              limitResolutions: { guard: string; limit: number; source: string }[];
            };
          };
          const resolution = doc.guardrails.limitResolutions.find(
            (entry) => entry.guard === "database-size",
          );
          if (resolution?.limit !== 1 || resolution.source !== "manifest") {
            throw new Error(
              `the mutated manifest row did not move the fence resolution: ${JSON.stringify(resolution)}`,
            );
          }
          const fence = doc.guardrails.fenceDecisions.find(
            (entry) => entry.concern === "relational-state",
          );
          if (fence?.decision !== "deny" || fence.denyReason !== "quota-exhausted") {
            throw new Error(
              `the mutated manifest row did not move the fence decision: ${JSON.stringify(fence)}`,
            );
          }
          facts.mutatedLimitFence = fence;
        },
      },
    });

    // --- chain step: release (the promotion chain over the real ledger) ---
    await runStep({
      id: "release-record",
      chainStep: "release",
      purpose:
        "record binds the exact checkout revision + the deterministic deployment identity (idempotent)",
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
            identity: { gitRevision: string; identityId: string };
          };
          if (doc.identity.gitRevision !== revision) {
            throw new Error("the recorded release does not bind the checkout revision");
          }
          if (identityBefore !== null && doc.identity.identityId !== identityBefore.identityId) {
            throw new Error(
              "the recorded deployment identity does not equal the emitted identity (drift)",
            );
          }
        },
      },
    });
    await runStep({
      id: "release-gate-validation",
      chainStep: "release",
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
          const doc = jsonDocumentOf(result.stdout) as {
            result: { status: string; gateKind: string };
          };
          if (doc.result.status !== "passed" || doc.result.gateKind !== "validation") {
            throw new Error(`the validation gate did not pass: ${JSON.stringify(doc.result)}`);
          }
        },
      },
    });

    // The wrong-revision plane: refuses the promotion BEFORE gate evidence.
    const wrongPlaneForPromote = await bootPlane({
      label: "wrong-revision-promote",
      revisionOverride: WRONG_REVISION,
    });
    try {
      await runStep({
        id: "release-promote-refused-wrong-revision",
        chainStep: "release",
        purpose:
          "the promote path REFUSES an unverified/wrong-revision plane (the pre-gate refusal — regardless of gate evidence)",
        script: "release.ts",
        args: [
          "promote",
          "--to",
          "local",
          "--actor",
          DRIVER_ACTOR,
          "--plane-url",
          wrongPlaneForPromote.baseUrl,
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
      await wrongPlaneForPromote.stop();
    }

    // The unreachable plane: refuses the promotion.
    const deadPromotePort = await reservePort();
    await runStep({
      id: "release-promote-refused-unreachable",
      chainStep: "release",
      purpose: "the promote path REFUSES an unreachable plane (fail closed, never a warning)",
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

    // The tampered plane: refuses the promotion on identity recompute.
    const tamperPlaneForPromote = await bootPlane({
      label: "tampered-promote",
      cwd: tamperTree,
      revisionOverride: revision,
      env: { ZECK_PG_ADMIN_URL: pgAdminUrl },
    });
    try {
      await runStep({
        id: "release-promote-refused-tampered",
        chainStep: "release",
        purpose:
          "the promote path REFUSES a tampered plane (identity-recompute mismatch at the claimed revision — the tamper drill re-proven on the promotion path)",
        script: "release.ts",
        args: [
          "promote",
          "--to",
          "local",
          "--actor",
          DRIVER_ACTOR,
          "--plane-url",
          tamperPlaneForPromote.baseUrl,
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
      await tamperPlaneForPromote.stop();
    }

    // The verified plane: the promotion succeeds (the positive direction).
    const headPlane = await bootPlane({ label: "head-revision" });
    try {
      await runStep({
        id: "release-promote-verified",
        chainStep: "release",
        purpose:
          "the promote path SUCCEEDS on a verified plane (the pre-promotion attestation recorded in the journal; the hosting pointer activates)",
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
            if (doc.planeIdentity.runtimeIdentityId !== runtimeIdentityIdBefore) {
              throw new Error(
                "the promoted plane's runtime identity does not equal the recomputed one",
              );
            }
            facts.promotedPlaneIdentity = doc.planeIdentity;
          },
        },
      });

      // --- rollback re-attestation, both directions ------------------------
      if (rollbackTarget !== null) {
        baseWorktree = prepareBaseWorktree(rollbackTarget, scratchRoot);
        const baseEnv = { ZECK_ENVIRONMENT: "local", ZECK_PG_ADMIN_URL: pgAdminUrl };
        await runStep({
          id: "release-record-base",
          chainStep: "release",
          purpose:
            "record the ROLLBACK TARGET release (the previous releasable state — the branch base) into the same local ledger",
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
          id: "release-gate-validation-base",
          chainStep: "release",
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
          id: "release-rollback-prerepoint-refused",
          chainStep: "release",
          purpose:
            "rollback with a plane still serving the FROM revision: the pointer flip happens, then the re-attestation REFUSES with the exact repoint instruction",
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
                planeIdentity: { verified: boolean; reason?: string };
              };
              if (doc.toReleaseId !== baseReleaseId) {
                throw new Error("the rollback document does not name the target release");
              }
              if (doc.planeIdentity.verified !== false) {
                throw new Error("the pre-repoint re-attestation was not refused");
              }
              // The exact honest instruction: the plane still attests the
              // FROM revision — the re-attestation failed, the repoint is
              // the operator's remaining step (both guard branches carry it).
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
        // Re-activate the head release, then roll back with the plane
        // REPOINTED at the target (booted from the base worktree).
        await runStep({
          id: "release-promote-verified-again",
          chainStep: "release",
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
            id: "release-rollback-postpoint-verified",
            chainStep: "release",
            purpose:
              "rollback with the plane REPOINTED at the target revision: the governed pointer flip + the re-attestation SUCCEEDS (exit 0)",
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
          id: "release-rollback-drills",
          chainStep: "release",
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

    // --- identity AFTER (attestation stability across the whole chain) ----
    const identityAfter = await emitIdentity(
      "identity-after",
      "the identity document re-emitted AFTER the verification chain (attestation stability: byte-identical)",
      revision,
    );
    let identityStable = true;
    if (identityBefore !== null) {
      if (
        identityAfter.identityId !== identityBefore.identityId ||
        identityAfter.manifestDigest !== identityBefore.manifestDigest ||
        identityAfter.outputDigest !== identityBefore.outputDigest
      ) {
        identityStable = false;
        problems.push(
          "the deployment identity drifted across the chain run (before/after documents differ — tamper or drift)",
        );
      }
    }
    facts.identityStability = {
      identityId: identityBefore?.identityId ?? "",
      manifestDigest: identityBefore?.manifestDigest ?? "",
      runtimeIdentityId: runtimeIdentityIdBefore,
      stableAcrossChain: identityStable,
    };

    // --- chain step: teardown (classification-guarded removal) ------------
    await runStep({
      id: "teardown-classification-refused",
      chainStep: "teardown",
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
    const deadTeardownPort = await reservePort();
    await runStep({
      id: "teardown-pgdrop-refused",
      chainStep: "teardown",
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
      id: "teardown-real",
      chainStep: "teardown",
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
    // Post-teardown verification: the database is really gone (the same
    // authority the tools use — a real round trip, never assumed).
    const { Client } = await import("pg");
    const verifyClient = new Client({ connectionString: pgAdminUrl });
    await verifyClient.connect();
    try {
      const exists = await verifyClient.query<{ exists: boolean }>({
        text: "SELECT EXISTS (SELECT 1 FROM pg_database WHERE datname = 'zeck_local') AS exists",
      });
      if (exists.rows[0]?.exists === true) {
        problems.push("zeck_local still exists after the real teardown (the drop did not land)");
      }
      facts.zeckLocalDropped = exists.rows[0]?.exists !== true;
    } finally {
      await verifyClient.end();
    }
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
    tool: "deploy/e2e-validate",
    mode: "local-rails",
    environment: "local",
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    durationMs: finishedAt.getTime() - startedAt.getTime(),
    revision,
    ...(rollbackTarget === null ? {} : { rollbackTargetRevision: rollbackTarget }),
    pgEndpoint,
    plan: CHAIN_PLAN,
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
