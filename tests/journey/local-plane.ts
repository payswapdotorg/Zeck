/**
 * PPR-003 — the local Zeck plane (the deploy chain's local mode).
 *
 * Boots the REAL bootstrap host (deploy/api.ts) as a subprocess on an
 * ephemeral port and waits for its BOOT DOCUMENT on stdout — the
 * repository's own plane-boot race discipline (reused from the DEP-040
 * driver's exported bootDocumentOf detector: never proceed on a bare
 * /health 200; the boot document is the later, authoritative barrier).
 *
 * The no-PG degradation (the work order's pre-authorized fallback when
 * the sandbox carries no PostgreSQL): the plane boots fine without
 * ZECK_PG_ADMIN_URL — /health then answers the honest fail-closed 503
 * down with controlPlane ready, exactly the degradation the deploy
 * chain's own smoke supports with --allow-degraded.
 */

import { spawn } from "node:child_process";
import { join } from "node:path";
import { bootDocumentOf, type PlaneBootDocument } from "../../deploy/e2e-validate";
import { REPOSITORY_ROOT } from "../../deploy/lib";

/** Reserve an ephemeral port then close the listener (a real free port). */
export async function reservePort(): Promise<number> {
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

/** A booted local plane handle. */
export interface LocalPlane {
  readonly baseUrl: string;
  readonly boot: PlaneBootDocument;
  readonly stop: () => Promise<void>;
}

/**
 * Boot the REAL local plane. The revision override exists for the
 * wrong-revision hostile negative (a plane attesting a WRONG revision
 * must be refused by the harness's identity gate).
 */
export async function bootLocalPlane(options: {
  readonly revisionOverride?: string;
  readonly label?: string;
}): Promise<LocalPlane> {
  let lastError = "unknown";
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const port = await reservePort();
    const host = "127.0.0.1";
    const baseUrl = `http://${host}:${port}`;
    const child = spawn(
      "bun",
      [join("deploy", "api.ts"), "--environment", "local", "--host", host, "--port", String(port)],
      {
        cwd: REPOSITORY_ROOT,
        env: {
          ...process.env,
          ZECK_ENVIRONMENT: "local",
          ...(options.revisionOverride === undefined
            ? {}
            : { ZECK_DEPLOY_GIT_REVISION: options.revisionOverride }),
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
    // THE BOOT-DOCUMENT WAIT (bounded 30s — the race discipline).
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
          `plane ${options.label ?? "local"} did not drain gracefully on SIGTERM (exit ${code})`,
        );
      }
    };
    return { baseUrl, boot, stop };
  }
  throw new Error(`could not boot the local plane: ${lastError}`);
}
