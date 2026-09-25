/**
 * PPR-007 integration — the experience entry's local-rail proof: the
 * composed two-plane shape, exactly as the preview deployment serves
 * it (the API function next to the experience function).
 *
 * THE PROOF (all real processes, real HTTP — no mocks):
 *  - the API plane boots through the ROOT entry (bun server.ts, the
 *    Fastify framework entry PPR-006 ships — UNCHANGED) and serves
 *    its own route table (/health, /identity) next to the experience
 *    entry;
 *  - the experience entry boots through the function's local-rail
 *    affordance (bun api/experience.ts) with an UNBOUND token (the
 *    honest unbound mode) over that API plane;
 *  - the composed shape answers: the console home page, a
 *    representative 22-family playground disclosure route, the machine
 *    JSON views, the trust surface and the root landing — with the
 *    API plane's honest 401 rendering the designed permission states
 *    on the reading pages, never a fabricated projection;
 *  - THE ROUTING CARRY (the platform's documented capture-to-query
 *    rewrite conversion, reversed over the real rail): a request to
 *    the function's own path with `path=/console/playground/text`
 *    serves the SAME body the original path serves;
 *  - COMPOSED-SHAPE PARITY: the direct-execution dashboard (bun
 *    apps/dashboard/index.ts — the entry whose behavior is unchanged)
 *    answers identically over the same API plane;
 *  - the cold-start boot record: the deploy/experience `booted` JSON
 *    with tokenBound=false (the honest unbound mode's visibility);
 *  - SHUTDOWN: SIGTERM drains both entries gracefully.
 *
 * This file needs no database and no credentials: the API plane's
 * bootstrap composition serves its honest unbound boundary semantics
 * (the no-PG degraded path is the pre-authorized local fallback).
 */

import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, test } from "vitest";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const HAS_GIT = existsSync(join(REPO_ROOT, ".git"));

/** Reserve an ephemeral port then close the listener (a real free port). */
async function reservePort(): Promise<number> {
  return new Promise((resolvePromise, reject) => {
    const server = createServer();
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

interface EntryHandle {
  readonly baseUrl: string;
  readonly readStdout: () => string;
  readonly stop: () => Promise<number>;
}

/**
 * Boot one entry (a real child process) and wait for its listener.
 * `ready` probes the entry until it answers. The child binds the
 * RESERVED port through its own port variable (`PORT` for the API plane
 * and the experience entry, `DASHBOARD_PORT` for the direct-execution
 * dashboard).
 */
async function bootEntry(options: {
  readonly script: string;
  readonly env: Record<string, string>;
  readonly readyPath: string;
  readonly portVariable?: string;
}): Promise<EntryHandle> {
  let lastError = "unknown";
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const port = await reservePort();
    const baseUrl = `http://127.0.0.1:${port}`;
    const child = spawn("bun", [options.script], {
      cwd: REPO_ROOT,
      env: {
        ...options.env,
        [options.portVariable ?? "PORT"]: String(port),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    let transportOk = false;
    for (let probe = 0; probe < 160; probe += 1) {
      if (child.exitCode !== null) {
        break;
      }
      try {
        const response = await fetch(`${baseUrl}${options.readyPath}`);
        void response.body?.cancel();
        transportOk = true;
        break;
      } catch {
        await new Promise((resolvePromise) => setTimeout(resolvePromise, 250));
      }
    }
    if (!transportOk) {
      lastError = `the entry did not become reachable (exit ${child.exitCode}; stderr: ${stderr.slice(0, 300)})`;
      child.kill("SIGKILL");
      continue;
    }
    let stopped = false;
    const stop = async (): Promise<number> => {
      if (stopped) {
        return 0;
      }
      stopped = true;
      return await stopChild(child);
    };
    return { baseUrl, readStdout: () => stdout, stop };
  }
  throw new Error(`could not boot ${options.script}: ${lastError}`);
}

/** SIGTERM a child and await its exit (SIGKILL after a 10s bound). */
function stopChild(child: ChildProcess): Promise<number> {
  const exited = new Promise<number>((resolvePromise) => {
    child.once("exit", (code) => resolvePromise(code ?? 0));
  });
  child.kill("SIGTERM");
  return Promise.race([
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
}

interface ServedSurface {
  readonly status: number;
  readonly contentType: string | null;
  readonly body: string;
  readonly location?: string;
}

async function get(baseUrl: string, path: string): Promise<ServedSurface> {
  const response = await fetch(`${baseUrl}${path}`, { redirect: "manual" });
  const location = response.headers.get("location");
  return {
    status: response.status,
    contentType: response.headers.get("content-type"),
    body: await response.text(),
    ...(location === null ? {} : { location }),
  };
}

/**
 * Normalize the per-request randomness the pages embed by design (the
 * CSRF-shaped idempotency keys every form carries: `dash-<uuid>`) so
 * parity comparisons see the deterministic composition only.
 */
function normalized(body: string): string {
  return body.replace(
    /dash-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g,
    "dash-<uuid>",
  );
}

const APPLICATION_ID = "00000000-0000-7000-8000-000000000007";

const liveEntries: EntryHandle[] = [];

afterAll(async () => {
  for (const entry of liveEntries) {
    await entry.stop().catch(() => undefined);
  }
});

function childEnv(overrides: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) {
      env[key] = value;
    }
  }
  return { ...env, ...overrides };
}

describe.skipIf(!HAS_GIT)(
  "PPR-007: the experience entry on the local rail (the composed two-plane shape)",
  () => {
    test("the API plane and the experience entry compose; the composed shape serves the console surface honestly", {
      timeout: 240_000,
    }, async () => {
      // 1. THE API PLANE — the ROOT entry, unchanged (PPR-006's function).
      const apiPlane = await bootEntry({
        script: "server.ts",
        env: childEnv({ ZECK_ENVIRONMENT: "local" }),
        readyPath: "/health",
      });
      liveEntries.push(apiPlane);

      // The API plane serves its own route table (the split's other side).
      // /health answers its honest readiness document: 200 when every
      // dependency is ready, or the honest fail-closed 503 "down" JSON when
      // an authoritative dependency is unbound (this pod carries no
      // PostgreSQL — the pre-authorized degraded path; the composition's
      // answer is ALWAYS the health document, never a crash).
      const health = await get(apiPlane.baseUrl, "/health");
      expect(health.status === 200 || health.status === 503).toBe(true);
      expect(health.contentType).toContain("application/json");
      const healthDocument = JSON.parse(health.body) as { status: string };
      expect(["ready", "degraded", "down"]).toContain(healthDocument.status);
      const identity = await get(apiPlane.baseUrl, "/identity");
      expect(identity.status).toBe(200);
      expect(JSON.parse(identity.body).identity.gitRevision).toMatch(/^[0-9a-f]{40}$/);

      // 2. THE EXPERIENCE ENTRY — the function's local-rail boot, with an
      //    UNBOUND token (the honest unbound mode: ZECK_EXPERIENCE_TOKEN
      //    is deliberately absent).
      const experience = await bootEntry({
        script: "api/experience.ts",
        env: childEnv({
          ZECK_EXPERIENCE_API_URL: apiPlane.baseUrl,
          ZECK_EXPERIENCE_APPLICATION_ID: APPLICATION_ID,
        }),
        readyPath: "/console",
      });
      liveEntries.push(experience);

      // The cold-start boot record (the honest unbound mode's visibility).
      const bootStart = experience.readStdout().indexOf("{");
      expect(bootStart).toBeGreaterThanOrEqual(0);
      const boot = JSON.parse(
        experience.readStdout().slice(bootStart).split("\n", 1)[0] ?? "",
      ) as Record<string, unknown>;
      expect(boot.tool).toBe("deploy/experience");
      expect(boot.status).toBe("booted");
      expect(boot.tokenBound).toBe(false);
      expect(boot.applicationId).toBe(APPLICATION_ID);

      // 3. THE COMPOSED SHAPE — the console surface through the entry.
      const consoleHome = await get(experience.baseUrl, "/console");
      expect(consoleHome.status).toBe(200);
      expect(consoleHome.contentType).toContain("text/html");
      expect(consoleHome.body).toContain("Developer console");
      expect(consoleHome.body).toContain(APPLICATION_ID);

      // A representative 22-family playground disclosure route.
      const family = await get(experience.baseUrl, "/console/playground/text");
      expect(family.status).toBe(200);
      expect(family.contentType).toContain("text/html");
      const lowered = family.body.toLowerCase();
      expect(
        ["available", "runnable", "provider-gated", "requires access", "not run"].some((word) =>
          lowered.includes(word),
        ),
      ).toBe(true);

      // The machine JSON views.
      const facts = await get(experience.baseUrl, "/console/executions/facts.json");
      expect(facts.status).toBe(200);
      expect(facts.contentType).toContain("application/json");
      expect((JSON.parse(facts.body) as { readonly runs: readonly unknown[] }).runs).toEqual([]);
      const catalog = await get(experience.baseUrl, "/console/validation/api/catalog.json");
      expect(catalog.status).toBe(200);
      expect(catalog.contentType).toContain("application/json");
      expect(
        Object.keys(JSON.parse(catalog.body) as Record<string, unknown>).length,
      ).toBeGreaterThan(0);

      // The trust surface and the root landing (PPR-015: the bare / is a
      // BRIDGE on every rail — the canonical Home experience route is
      // /home; / redirects to it exactly like vercel.json's root
      // redirect does on the public plane).
      const trust = await get(experience.baseUrl, "/trust/evidence");
      expect(trust.status).toBe(200);
      expect(trust.contentType).toContain("text/html");
      const bridge = await get(experience.baseUrl, "/");
      expect(bridge.status).toBe(303);
      expect(bridge.location).toBe("/home");
      const landing = await get(experience.baseUrl, "/home");
      expect(landing.status).toBe(200);
      expect(landing.contentType).toContain("text/html");
      expect(landing.body).toMatch(/<title>Zeck[^<]*<\/title>/i);
      expect(landing.body).toContain("<title>Zeck — Home</title>");

      // The composition's own static asset.
      const asset = await get(experience.baseUrl, "/assets/client.js");
      expect(asset.status).toBe(200);
      expect(asset.contentType).toContain("application/javascript");

      // The honest unbound degradation: a reading page renders its designed
      // permission state over the API plane's honest 401 — never fabricated.
      const reading = await get(experience.baseUrl, "/agents");
      expect(reading.status).toBe(403);
      expect(reading.contentType).toContain("text/html");
      expect(reading.body).toContain("Not authorized");

      // 4. THE ROUTING CARRY — the platform's documented capture-to-query
      //    conversion reversed over the real rail: the function's own path
      //    with `path=<original>` serves EXACTLY the original path's surface.
      const carried = await get(
        experience.baseUrl,
        "/api/experience?path=/console/playground/text",
      );
      expect(carried.status).toBe(family.status);
      expect(carried.contentType).toBe(family.contentType);
      expect(normalized(carried.body)).toBe(normalized(family.body));

      // 5. COMPOSED-SHAPE PARITY — the direct-execution dashboard (the entry
      //    whose behavior is unchanged) answers identically over the same
      //    API plane.
      const direct = await bootEntry({
        script: "apps/dashboard/index.ts",
        env: childEnv({
          ZECK_API_URL: apiPlane.baseUrl,
          ZECK_TOKEN: "unbound-local-rail-projection",
          ZECK_APPLICATION_ID: APPLICATION_ID,
        }),
        readyPath: "/console",
        portVariable: "DASHBOARD_PORT",
      });
      liveEntries.push(direct);

      for (const path of [
        "/",
        "/console",
        "/console/playground/text",
        "/console/executions/facts.json",
        "/console/validation/api/catalog.json",
        "/trust/evidence",
        "/admin/policies",
      ]) {
        const throughEntry = await get(experience.baseUrl, path);
        const throughDirect = await get(direct.baseUrl, path);
        expect(throughEntry.status, path).toBe(throughDirect.status);
        expect(throughEntry.contentType, path).toBe(throughDirect.contentType);
        expect(normalized(throughEntry.body), path).toBe(normalized(throughDirect.body));
      }

      // 6. SHUTDOWN — SIGTERM drains both entries gracefully.
      expect(await experience.stop()).toBe(0);
      expect(await apiPlane.stop()).toBe(0);
    });
  },
);
