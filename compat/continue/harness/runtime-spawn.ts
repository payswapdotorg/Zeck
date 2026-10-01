/**
 * The PPR-021 Continue runtime spawner — runs the PINNED, UNMODIFIED
 * Continue runtime (from the exact upstream clone revision) inside the
 * proof environment:
 *
 *  - the egress-deny preload (egress-preload.ts) is injected BEFORE the
 *    entry (the global-fetch deny control), AND the runtime's proxy env
 *    (HTTP_PROXY/HTTPS_PROXY/NO_PROXY) points at the harness deny proxy
 *    — the belt-and-braces pair covering BOTH Continue fetch paths
 *    (the bundled node-fetch of packages/fetch, which honors the proxy
 *    env vars, and every global-fetch straggler);
 *  - every AI-provider credential env var is SCRUBBED from the child
 *    environment (presence/absence recorded as ProviderCredentialFacts —
 *    names only, never values);
 *  - the CONTINUE_GLOBAL_DIR is isolated per run and seeded with the
 *    role-model config.yaml (config.ts — the app's own configuration
 *    surface);
 *  - stdout/stderr and the exit code are captured for the corpus
 *    runner's verification and the evidence record's observations.
 */

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { EgressViolation, ProviderCredentialFact } from "../../../src/integrations/compatibility/public";
import { SCRUBBED_CREDENTIAL_ENV_VARS } from "./egress-policy";
import { seedContinueRuntimeConfig } from "../corpus/config";

/** The harness root (this file's directory — the Zeck repo side). */
export const HARNESS_ROOT = dirname(fileURLToPath(import.meta.url));

/** The pinned Continue upstream clone root (the application under proof). */
export const CONTINUE_ROOT = process.env.PPR_021_CONTINUE_ROOT ?? "/home/z/my-project/continue";

/** The provider-credential env-var NAMES the battery records facts for. */
export const PROVIDER_CREDENTIAL_ENV_NAMES: readonly string[] = SCRUBBED_CREDENTIAL_ENV_VARS;

/**
 * Pick a free loopback port for a serve-mode run (bind :0, read the
 * ephemeral port, release it immediately — the tiny race is irrelevant
 * in the proof sandbox's single-user environment).
 */
export function pickFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

export interface ContinueSpawnOptions {
  /** The run kind: the CLI agent (cli-entry) or the core role driver. */
  readonly driver: "cli" | "role";
  /** The task's fresh workspace (the child's cwd). */
  readonly cwd: string;
  /** The isolated CONTINUE_GLOBAL_DIR (seeded with the config.yaml). */
  readonly homeDir: string;
  /** The Zeck adapter base URL (http://127.0.0.1:<port>/v1). */
  readonly adapterBaseUrl: string;
  /** The egress proxy's URL (the HTTP(S)_PROXY target). */
  readonly proxyUrl: string;
  /** The egress-log file path for this run (the preload's JSONL). */
  readonly egressLogPath: string;
  /** CLI: the instruction + flags. Role: the spec file path. */
  readonly cliInstruction?: string;
  readonly cliFlags?: readonly string[];
  /**
   * CLI: which of the CLI's OWN headless surfaces drives the run.
   * "print" (default) — the `cn -p` one-shot mode. "serve" — the CLI's
   * own `cn serve` HTTP surface (the one-shot -p mode never aligns the
   * ChatHistoryService session at the pinned revision, so the CLI's
   * Subagent tool — which requires an active session — only works on
   * the serve surface; observed live: "Error executing tool Subagent:
   * No active session found"). The serve run passes --port (a free
   * loopback port) + --timeout (the CLI's own inactivity shutdown) and
   * exits by itself when the agent goes idle.
   */
  readonly cliMode?: "print" | "serve";
  readonly roleSpecPath?: string;
  /** Wall-clock timeout for the run (ms). */
  readonly timeoutMs: number;
  /** Extra env (never credential material). */
  readonly extraEnv?: Readonly<Record<string, string>>;
  /**
   * The DIRECT-BASELINE arm's credential materialization (the app's own
   * config axes carry the real supply credential for that arm — by
   * definition of a direct baseline; the certified Zeck arm never sets
   * this).
   */
  readonly directArm?: {
    readonly apiKey: string;
    readonly headers: Readonly<Record<string, string>>;
  };
}

export interface ContinueRunResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly durationMs: number;
  /** Provider credential presence facts observed BEFORE scrubbing (names only). */
  readonly credentialFacts: readonly ProviderCredentialFact[];
  /** The egress violations the PRELOAD recorded (JSONL, framework shapes). */
  readonly preloadViolations: readonly EgressViolation[];
  /** The config.yaml path the runtime was seeded with. */
  readonly configPath: string;
}

/** Observe provider credential presence in the CURRENT environment (names only). */
export function observeCredentialFacts(): readonly ProviderCredentialFact[] {
  return PROVIDER_CREDENTIAL_ENV_NAMES.map((name) => ({
    envVarName: name,
    present: typeof process.env[name] === "string" && (process.env[name] ?? "").length > 0,
  }));
}

/** The scrubbed child environment (credential-free; proxy + proof env). */
export function scrubbedChildEnv(options: {
  readonly homeDir: string;
  readonly proxyUrl: string;
  readonly egressLogPath: string;
  readonly extraEnv?: Readonly<Record<string, string>>;
}): NodeJS.ProcessEnv {
  // Built FROM AN ALLOWLIST (the PPR-018 discipline): no provider
  // credential can leak in by construction.
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
    HOME: options.homeDir,
    TMPDIR: process.env.TMPDIR ?? "/tmp",
    LANG: "C.UTF-8",
    LC_ALL: "C.UTF-8",
    TERM: "dumb",
    NO_COLOR: "1",
    GIT_TERMINAL_PROMPT: "0",
    // The egress controls: every model-path fetch (packages/fetch honors
    // proxy env vars) goes through the deny proxy; loopback (the adapter)
    // bypasses it. The preload covers global-fetch stragglers.
    HTTP_PROXY: options.proxyUrl,
    HTTPS_PROXY: options.proxyUrl,
    http_proxy: options.proxyUrl,
    https_proxy: options.proxyUrl,
    NO_PROXY: "127.0.0.1,localhost",
    no_proxy: "127.0.0.1,localhost",
    // The app's own home isolation.
    CONTINUE_GLOBAL_DIR: options.homeDir,
    // The preload's proof log + entry wiring.
    PPR_021_EGRESS_LOG: options.egressLogPath,
    ...options.extraEnv,
  };
  for (const name of PROVIDER_CREDENTIAL_ENV_NAMES) {
    delete env[name];
  }
  return env;
}

/** Read the preload's recorded violations (JSONL → framework shapes). */
function readPreloadViolations(path: string): EgressViolation[] {
  if (!existsSync(path)) {
    return [];
  }
  const violations: EgressViolation[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
      continue;
    }
    try {
      violations.push(JSON.parse(trimmed) as EgressViolation);
    } catch {
      // An unparseable line is an honest observation gap, never fabricated.
    }
  }
  return violations;
}

/** Run one pinned Continue runtime invocation inside the proof environment. */
export async function runContinue(options: ContinueSpawnOptions): Promise<ContinueRunResult> {
  mkdirSync(options.homeDir, { recursive: true });
  const configPath = seedContinueRuntimeConfig({
    homeDir: options.homeDir,
    adapterBaseUrl: options.adapterBaseUrl,
    ...(options.directArm === undefined ? {} : { directArm: options.directArm }),
  });
  const preload = join(HARNESS_ROOT, "egress-preload.ts");
  const cliEntry = join(HARNESS_ROOT, "..", "corpus", "cli-entry.ts");
  const roleDriver = join(HARNESS_ROOT, "..", "corpus", "role-driver.ts");
  const credentialFacts = observeCredentialFacts();

  const env = scrubbedChildEnv({
    homeDir: options.homeDir,
    proxyUrl: options.proxyUrl,
    egressLogPath: options.egressLogPath,
    extraEnv: options.extraEnv,
  });
  env.PPR_021_CONTINUE_ENTRY =
    options.driver === "cli" ? cliEntry : roleDriver;
  if (options.driver === "cli") {
    env.PPR_021_CONTINUE_CLI_ENTRY = join(CONTINUE_ROOT, "extensions", "cli", "src", "index.ts");
  } else {
    env.PPR_021_CONTINUE_ROOT = CONTINUE_ROOT;
  }

  const args: string[] = [];
  if (options.driver === "cli") {
    if (options.cliMode === "serve") {
      // The CLI's own serve surface: the session-aware headless mode (the
      // Subagent tool's requirement). The prompt is the serve command's
      // positional argument; --timeout is the CLI's OWN inactivity
      // shutdown (the process exits by itself once the agent goes idle).
      const servePort = await pickFreePort();
      args.push("serve", options.cliInstruction ?? "");
      args.push("--config", configPath);
      args.push("--port", String(servePort));
      args.push("--timeout", "20");
      for (const flag of options.cliFlags ?? []) {
        args.push(flag);
      }
    } else {
      args.push("-p", options.cliInstruction ?? "");
      args.push("--config", configPath);
      args.push("--format", "json");
      for (const flag of options.cliFlags ?? []) {
        args.push(flag);
      }
    }
  } else {
    args.push(options.roleSpecPath ?? "");
  }

  const startedAt = Date.now();
  return await new Promise<ContinueRunResult>((resolveRun) => {
    const child = spawn(
      process.execPath,
      [preload, "--", ...args],
      { cwd: options.cwd, env, stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, options.timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      if (stdout.length > 20 * 1024 * 1024) {
        stdout = stdout.slice(0, 20 * 1024 * 1024);
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
      if (stderr.length > 5 * 1024 * 1024) {
        stderr = stderr.slice(0, 5 * 1024 * 1024);
      }
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolveRun({
        exitCode: -1,
        stdout,
        stderr: `${stderr}\n${String(error)}`,
        timedOut,
        durationMs: Date.now() - startedAt,
        credentialFacts,
        preloadViolations: readPreloadViolations(options.egressLogPath),
        configPath,
      });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolveRun({
        exitCode: code ?? -1,
        stdout,
        stderr,
        timedOut,
        durationMs: Date.now() - startedAt,
        credentialFacts,
        preloadViolations: readPreloadViolations(options.egressLogPath),
        configPath,
      });
    });
  });
}
