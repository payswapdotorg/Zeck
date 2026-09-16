/**
 * Lead smoke (DEP-013 review): boot the REAL dashboard module over a
 * wire-exact fake API (same pattern as tests/unit/dashboard/
 * playground-interactive.test.ts) and verify the four key console pages
 * render in a REAL process: catalog, composer, honest NOT RUN, example.
 */
import { createDashboard } from "../apps/dashboard/index";

const APP_ID = "00000000-0000-7000-8000-0000000000f1";
const executions = new Map<string, Record<string, unknown>>();

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const url = new URL(typeof input === "string" ? input : String(input));
  const path = url.pathname;
  const method = (init?.method ?? "GET").toUpperCase();
  if (path === "/executions" && method === "POST") {
    const body = JSON.parse(String(init?.body ?? "{}"));
    const id = "00000000-0000-7000-8000-0000000000e1";
    executions.set(id, { ...body, executionId: id, status: "COMPLETED" });
    return json({ executionId: id, status: "COMPLETED", ...body }, 201);
  }
  const match = /^\/executions\/([^/]+)$/.exec(path);
  if (match !== null && executions.get(match[1] ?? "") !== undefined) {
    return json(executions.get(match[1] ?? ""));
  }
  if (/^\/executions\/([^/]+)\/(results|events|verification)$/.test(path)) {
    return json([]);
  }
  if (path === "/agents") {
    return json([]);
  }
  return json({ code: "PROVIDER_ERROR", message: `unexpected ${path}` }, 500);
}) as unknown as typeof fetch;

const { server } = createDashboard({
  apiUrl: "http://fake.local",
  token: "token",
  applicationId: APP_ID,
  port: 0,
  fetchImpl,
});

await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const addr = server.address() as { port: number };
const base = `http://127.0.0.1:${addr.port}`;

const checks: Array<[string, string, number]> = [
  ["/console/playground", "workload", 200],
  ["/console/playground/text", "Compose", 200],
  ["/console/playground/three-d", "NOT RUN", 200],
  ["/console/playground/text/example", "summarize", 200],
];

let failed = 0;
for (const [path, needle, wantStatus] of checks) {
  const res = await fetch(base + path);
  const body = await res.text();
  const ok = res.status === wantStatus && body.includes(needle);
  if (!ok) failed++;
  console.log(
    `${ok ? "PASS" : "FAIL"} ${path} -> ${res.status} (want ${wantStatus}), ` +
      `contains "${needle}": ${body.includes(needle)}, bytes: ${body.length}`,
  );
}

await new Promise<void>((resolve) => server.close(() => resolve()));
console.log(failed === 0 ? "SMOKE OK" : `SMOKE FAILED (${failed})`);
process.exit(failed === 0 ? 0 : 1);
