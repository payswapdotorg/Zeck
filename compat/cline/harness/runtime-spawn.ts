/**
 * The PPR-019 Cline runtime spawner — runs the PINNED, UNMODIFIED Cline
 * CLI (from the exact upstream clone revision) inside the proof
 * environment:
 *
 *  - the egress-deny preload (egress-preload.ts) is injected BEFORE the
 *    CLI entry (bun preload), so the runtime's global fetch is the
 *    default-deny proof transport;
 *  - every AI-provider credential env var is SCRUBBED from the child
 *    environment (presence/absence recorded as ProviderCredentialFacts —
 *    names only, never values);
 *  - the config/data directories are isolated per run (--config /
 *    --data-dir), seeded with the openai-compatible provider pointed at
 *    the local Zeck adapter (cline-config.ts);
 *  - stdout/stderr and the exit code are captured for the corpus
 *    runner's verification and the evidence record's observations.
 */

import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import type { ProviderCredentialFact } from "../../../src/integrations/compatibility/public";
import { SCRUBBED_CREDENTIAL_ENV_VARS } from "./egress-policy";
import { seedClineRuntimeConfig, type ClineRuntimeConfig } from "./cline-config";

/** The harness root (this file's directory — the Zeck repo side). */
export const HARNESS_ROOT = dirname(new URL(import.meta.url).pathname);

export interface ClineSpawnOptions {
  /** The pinned Cline upstream clone root (the application under proof). */
  readonly clineRoot: string;
  /** The proof config (config/data dirs + adapter URL + model). */
  readonly config: ClineRuntimeConfig;
  /**
   * Skip the adapter-config seeding (the caller pre-seeded the config —
   * the direct-baseline arm writes its own provider settings with the
   * real supply credential, by definition of a direct baseline).
   */
  readonly skipConfigSeed?: boolean;
  /** The CLI args (e.g. ["--json", "--auto-approve", "true", "…prompt…"]). */
  readonly args: readonly string[];
  /** The working directory of the run (the task's fresh workspace). */
  readonly cwd: string;
  /** Wall-clock timeout for the run (ms). */
  readonly timeoutMs: number;
  /** The egress-log file path for this run. */
  readonly egressLogPath: string;
  /** Extra env (never credential material). */
  readonly extraEnv?: Readonly<Record<string, string>>;
}

export interface ClineRunResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly timedOut: boolean;
  readonly durationMs: number;
  /** Provider credential presence facts observed BEFORE scrubbing (names only). */
  readonly credentialFacts: readonly ProviderCredentialFact[];
}

/**
 * Observe provider credential presence in the CURRENT environment
 * (names only, never values) — the honest basis of the scrub step.
 */
export function observeCredentialFacts(): readonly ProviderCredentialFact[] {
  return SCRUBBED_CREDENTIAL_ENV_VARS.map((name) => ({
    envVarName: name,
    present: typeof process.env[name] === "string" && (process.env[name] ?? "").length > 0,
  }));
}

/** The scrubbed child environment (credential-free; loopback-only proof env). */
export function scrubbedChildEnv(
  config: ClineRuntimeConfig,
  egressLogPath: string,
  extraEnv?: Readonly<Record<string, string>>,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value !== "string") {
      continue;
    }
    env[key] = value;
  }
  for (const name of SCRUBBED_CREDENTIAL_ENV_VARS) {
    delete env[name];
  }
  env.CLINE_DIR = config.configDir;
  env.PPR_019_EGRESS_LOG = egressLogPath;
  env.NO_COLOR = "1";
  for (const [key, value] of Object.entries(extraEnv ?? {})) {
    env[key] = value;
  }
  return env;
}

/** Run one pinned Cline CLI invocation inside the proof environment. */
export async function runCline(options: ClineSpawnOptions): Promise<ClineRunResult> {
  if (options.skipConfigSeed !== true) {
    seedClineRuntimeConfig(options.config);
  }
  const preload = resolve(HARNESS_ROOT, "egress-preload.ts");
  const cliEntry = resolve(options.clineRoot, "apps/cli/src/index.ts");
  const credentialFacts = observeCredentialFacts();
  const env = scrubbedChildEnv(options.config, options.egressLogPath, options.extraEnv);
  // PPR_019_CLINE_ENTRY must point at the pinned CLI entry.
  env.PPR_019_CLINE_ENTRY = cliEntry;

  const startedAt = Date.now();
  return await new Promise<ClineRunResult>((resolveRun) => {
    const child = spawn(
      process.execPath,
      [preload, "--", ...options.args],
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
      // A hard safety valve: never buffer more than 20 MiB of output.
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
      });
    });
  });
}
