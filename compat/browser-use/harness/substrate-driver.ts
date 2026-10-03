/**
 * The PPR-024 Zeck-side substrate-driver manager — spawns and supervises
 * the Python substrate driver (substrate/driver.py) that hosts the
 * pinned runtime's own BrowserSession/Tools over the real Chromium, and
 * exposes its loopback RPC surface to the execution driver (worker.ts).
 *
 * The driver process is ZECK-SIDE platform infrastructure (the same class
 * as the model rail's supply dispatch): its environment is scrubbed
 * (allowlist-only — no provider credential name can exist in it), its
 * only HTTP destination is the local Zeck adapter (the extraction LLM's
 * delegated seam), and the browser it hosts is launched with the proof
 * environment's deny proxy as its --proxy-server (bypassing loopback
 * only) so even the SUBSTRATE browser's own egress is default-denied
 * and recorded.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** The harness root (this file's directory). */
const HARNESS_ROOT = dirname(fileURLToPath(import.meta.url));

/** The Python substrate driver entry (Zeck side). */
export const SUBSTRATE_DRIVER_SCRIPT = join(HARNESS_ROOT, "..", "substrate", "driver.py");

/** The pinned-runtime venv's Python (the exact editable checkout). */
export const SUBSTRATE_PYTHON = "/home/z/ppr-024-venv/bin/python";

/** The sandbox's Chromium (the substrate's browser binary). */
export const SUBSTRATE_CHROME =
  "/home/z/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome";

/** Where substrate work roots live. */
export const SUBSTRATE_WORK_ROOT = process.env.PPR_024_WORK_ROOT ?? join(tmpdir(), "ppr-024-battery");

export interface SubstrateDriver {
  readonly port: number;
  readonly url: string;
  /** The spawned child's pid (the substrate host process). */
  readonly pid: number | undefined;
  /** Whether the driver is alive (best-effort). */
  readonly alive: boolean;
  stop(): Promise<void>;
}

export interface SubstrateDriverOptions {
  /** Where the driver's stderr/stdout logs are appended. */
  readonly logFile?: string;
}

/** Spawn the substrate driver on a loopback port and wait for /health. */
export async function startSubstrateDriver(
  options: SubstrateDriverOptions = {},
): Promise<SubstrateDriver> {
  if (!existsSync(SUBSTRATE_DRIVER_SCRIPT)) {
    throw new Error(`the substrate driver script is absent at ${SUBSTRATE_DRIVER_SCRIPT}`);
  }
  if (!existsSync(SUBSTRATE_PYTHON)) {
    throw new Error(
      `the pinned-runtime venv python is absent at ${SUBSTRATE_PYTHON} — install the pinned Browser Use checkout per the demo entry's reproducibility instructions`,
    );
  }
  mkdirSync(join(SUBSTRATE_WORK_ROOT, "substrate"), { recursive: true });
  const port = 24100 + (Math.floor(Math.random() * 400) % 400);
  const logFile = options.logFile ?? join(SUBSTRATE_WORK_ROOT, "substrate", "driver.log");
  const { appendFileSync } = await import("node:fs");
  const child: ChildProcess = spawn(SUBSTRATE_PYTHON, [SUBSTRATE_DRIVER_SCRIPT, "--port", String(port)], {
    cwd: SUBSTRATE_WORK_ROOT,
    env: {
      PATH: `${dirname(SUBSTRATE_PYTHON)}:/usr/local/bin:/usr/bin:/bin`,
      HOME: join(SUBSTRATE_WORK_ROOT, "substrate"),
      TMPDIR: join(SUBSTRATE_WORK_ROOT, "substrate"),
      NO_PROXY: "127.0.0.1,localhost",
      no_proxy: "127.0.0.1,localhost",
      LC_ALL: "C.UTF-8",
      LANG: "C.UTF-8",
      TERM: "dumb",
      PYTHONUNBUFFERED: "1",
      // The pinned runtime's own documented off switches (non-AI endpoints):
      ANONYMIZED_TELEMETRY: "False",
      BROWSER_USE_CLOUD_SYNC: "False",
      DO_NOT_TRACK: "1",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout?.on("data", (chunk: Buffer) => {
    try {
      appendFileSync(logFile, chunk);
    } catch {
      /* logging is best-effort */
    }
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    try {
      appendFileSync(logFile, chunk);
    } catch {
      /* logging is best-effort */
    }
  });
  const baseUrl = `http://127.0.0.1:${port}`;
  const startedAt = Date.now();
  for (;;) {
    if (child.exitCode !== null) {
      throw new Error(`the substrate driver exited during startup (code ${child.exitCode}) — see ${logFile}`);
    }
    try {
      const response = await fetch(`${baseUrl}/health`, { signal: AbortSignal.timeout(2000) });
      if (response.ok) {
        break;
      }
    } catch {
      /* not up yet */
    }
    if (Date.now() - startedAt > 30_000) {
      child.kill("SIGKILL");
      throw new Error(`the substrate driver did not become healthy within 30s — see ${logFile}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return {
    port,
    url: baseUrl,
    get pid() {
      return child.pid;
    },
    get alive() {
      return child.exitCode === null;
    },
    async stop() {
      try {
        await fetch(`${baseUrl}/shutdown`, {
          method: "POST",
          signal: AbortSignal.timeout(3000),
        });
      } catch {
        /* best-effort graceful exit */
      }
      const deadline = Date.now() + 5000;
      while (child.exitCode === null && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 200));
      }
      if (child.exitCode === null) {
        child.kill("SIGKILL");
      }
    },
  };
}

/** One substrate RPC result (the driver's JSON body). */
export interface SubstrateRpcResult {
  readonly status: number;
  readonly body: Readonly<Record<string, unknown>>;
}

/** Call one substrate driver RPC endpoint. */
export async function substrateRpc(
  driver: SubstrateDriver,
  path: string,
  body: Readonly<Record<string, unknown>>,
  timeoutMs = 240_000,
): Promise<SubstrateRpcResult> {
  const response = await fetch(`${driver.url}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  let parsed: Record<string, unknown>;
  try {
    parsed = (await response.json()) as Record<string, unknown>;
  } catch {
    parsed = { error: `non-JSON substrate response (HTTP ${response.status})` };
  }
  return { status: response.status, body: parsed };
}

/** A deterministic digest of one substrate payload (for logs/evidence). */
export function substrateDigestOf(payload: unknown): string {
  return createHash("sha256").update(JSON.stringify(payload), "utf8").digest("hex").slice(0, 16);
}
