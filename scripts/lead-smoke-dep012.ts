/**
 * Lead smoke (DEP-012 review): boot the REAL dashboard over a wire-exact
 * fake API and verify the explorer surfaces render in a REAL process.
 */
import { createDashboard } from "../apps/dashboard/index";

const APP_ID = "00000000-0000-7000-8000-0000000000f2";
const RUN_ID = "00000000-0000-7000-8000-0000000000e9";

const execution = {
  id: RUN_ID,
  applicationId: APP_ID,
  environmentId: null,
  status: "COMPLETED",
  task: { kind: "summarize", doc: "postmortem-01", maxWords: 45 },
  constraints: { maxCostMicroUsd: "1250000", maxLatencyMs: 120000 },
  metadata: { origin: "zeck-console-playground", family: "text", sandbox: "disposable" },
  createdAt: "2026-09-16T09:00:00Z",
  updatedAt: "2026-09-16T09:00:02Z",
  terminalAt: "2026-09-16T09:00:02Z",
};

const result = {
  executionId: RUN_ID,
  status: "COMPLETED",
  route: { provider: "openrouter", model: "qwen/qwen3-14b", strategyClass: "hybrid", modelCalls: 1 },
  cost: { totalMicroUsd: "41250", currency: "usd" },
  usage: { inputTokens: 2100, outputTokens: 340 },
  outputArtifacts: [{ id: "art-0001", digest: "sha256:abcdef", createdAt: "2026-09-16T09:00:02Z" }],
  verification: [],
  warnings: [],
  terminalAt: "2026-09-16T09:00:02Z",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const path = new URL(String(input)).pathname;
  const method = (init?.method ?? "GET").toUpperCase();
  if (path === "/agents") return json([]);
  const match = /^\/executions\/([^/]+)$/.exec(path);
  if (match !== null && method === "GET") {
    return match[1] === RUN_ID ? json(execution) : json({ code: "X", message: "nf" }, 404);
  }
  const sub = /^\/executions\/([^/]+)\/(results|events|verification)$/.exec(path);
  if (sub !== null && sub[1] === RUN_ID) {
    if (sub[2] === "results") return json(result);
    if (sub[2] === "events") {
      return json([
        { eventId: "e1", executionId: RUN_ID, type: "execution.created", sequence: 1, occurredAt: "2026-09-16T09:00:00Z", payload: {} },
      ]);
    }
    return json([]);
  }
  return json({ code: "X", message: `unexpected ${path}` }, 500);
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
const cookie = `zeck_recent_executions=${RUN_ID}`;

const checks: Array<[string, string, number, string]> = [
  ["/console/executions", "Workload family", 200, "html"],
  ["/console/executions", "GET /executions (listing)", 200, "html"],
  [`/console/executions/${RUN_ID}`, "Route &amp; substrate", 200, "html"],
  [`/console/executions/${RUN_ID}?tab=costs`, "Per-step and per-model cost breakdown", 200, "html"],
  [`/console/executions/${RUN_ID}?tab=provenance`, "Request identity and idempotency key", 200, "html"],
  [`/console/executions/${RUN_ID}/facts.json`, '"executionId"', 200, "json"],
  ["/console/executions/facts.json", "no application-scoped execution listing route", 200, "json"],
];

let failed = 0;
for (const [path, needle, wantStatus, kind] of checks) {
  const res = await fetch(base + path, { headers: { cookie } });
  const body = await res.text();
  const ok = res.status === wantStatus && body.includes(needle);
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"} ${path} -> ${res.status} (want ${wantStatus}), contains ${JSON.stringify(needle)}: ${body.includes(needle)}, bytes: ${body.length}`);
  if (kind === "json") {
    try {
      JSON.parse(body);
    } catch {
      failed++;
      console.log(`FAIL ${path} is not valid JSON`);
    }
  }
}

await new Promise<void>((resolve) => server.close(() => resolve()));
console.log(failed === 0 ? "SMOKE OK" : `SMOKE FAILED (${failed})`);
process.exit(failed === 0 ? 0 : 1);
