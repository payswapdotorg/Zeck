/**
 * Lead smoke (DEP-011 review): boot the REAL API server (in-memory world)
 * plus the REAL dashboard route table with the REAL credential transport,
 * and drive the full credential journey over HTTP in a REAL process:
 * issue → reveal (show-once) → list → rotate → revoke, plus the honest
 * replay boundary (the same idempotency key never re-shows the secret).
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createDashboardRoutes } from "../apps/dashboard/pages";
import { createCredentialConsoleTransport } from "../apps/dashboard/credentials";
import {
  FormTooLargeError,
  matchRoute,
  parseCookies,
  readFormBody,
  sendResult,
} from "../apps/dashboard/http";
import { createZeckClient } from "../sdk";
import { seedApiWorld } from "../tests/unit/api/world";

const world = await seedApiWorld();
await world.server.app.listen({ port: 0, host: "127.0.0.1" });
const apiAddress = world.server.app.server.address() as { port: number };
const apiBase = `http://127.0.0.1:${apiAddress.port}`;

const client = createZeckClient({
  baseUrl: apiBase,
  token: world.bearerToken,
  applicationId: world.applicationId,
});
const credentials = createCredentialConsoleTransport({
  baseUrl: apiBase,
  token: world.bearerToken,
  applicationId: world.applicationId,
});
const routes = createDashboardRoutes(client, {
  applicationId: world.applicationId,
  credentials,
});

const server = createServer((request, response) => {
  void dispatch(request, response).catch(() => {
    response.destroy();
  });
});

async function dispatch(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const url = new URL(request.url ?? "/", "http://dashboard.local");
  const method = request.method === "POST" ? "POST" : "GET";
  const match = matchRoute(routes, method, url.pathname);
  const cookies = parseCookies(request.headers.cookie);
  if (match === null) {
    response.writeHead(404, { "content-type": "text/html; charset=utf-8" });
    response.end("not found");
    return;
  }
  let form: Record<string, string> = {};
  if (method === "POST") {
    try {
      form = await readFormBody(request);
    } catch (error) {
      if (error instanceof FormTooLargeError) {
        response.writeHead(413, { "content-type": "text/html; charset=utf-8" });
        response.end("too large");
        return;
      }
      throw error;
    }
  }
  const result = await match.route.handler({
    method,
    path: url.pathname,
    params: match.params,
    query: url.searchParams,
    cookies,
    form,
  });
  sendResult(response, result);
}

await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const addr = server.address() as { port: number };
const base = `http://127.0.0.1:${addr.port}`;

async function get(path: string): Promise<Response> {
  return fetch(`${base}${path}`, { redirect: "manual" });
}

async function postForm(path: string, form: Record<string, string>): Promise<Response> {
  return fetch(`${base}${path}`, {
    method: "POST",
    body: new URLSearchParams(form).toString(),
    headers: { "content-type": "application/x-www-form-urlencoded" },
    redirect: "manual",
  });
}

let failed = 0;
function check(name: string, ok: boolean, detail = ""): void {
  if (!ok) failed++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail.length > 0 ? ` — ${detail}` : ""}`);
}

// 1. The keys page renders the live surface.
const page = await (await get("/console/applications/keys")).text();
check("keys page renders the credential surface", page.includes("Credentials in this application"));
check("keys page carries the issue form", page.includes('action="/console/applications/keys/issue"'));

// 2. Issue → the show-once reveal.
const issueKey = `dash-smoke-${Date.now()}`;
const issueResponse = await postForm("/console/applications/keys/issue", {
  label: "smoke credential",
  role: "member",
  idempotencyKey: issueKey,
});
const reveal = await issueResponse.text();
const secret = /id="credential-secret"[^>]*value="(zeck-test-secret-[^"]+)"/.exec(reveal)?.[1] ?? "";
check("issue reveals the secret exactly once", issueResponse.status === 200 && secret.length > 0, secret.slice(0, 12));
const credentialId =
  /Credential identity<\/th><td>([^<]+)<\/td>/.exec(reveal)?.[1] ?? "";
check("the reveal names the credential identity", /^[0-9a-f-]{36}$/.test(credentialId), credentialId);

// 3. The honest replay: the SAME idempotency key never re-shows the secret.
const replayResponse = await postForm("/console/applications/keys/issue", {
  label: "smoke credential",
  role: "member",
  idempotencyKey: issueKey,
});
const replay = await replayResponse.text();
check(
  "the replay page states the boundary and carries no secret",
  replayResponse.status === 200 &&
    replay.includes("The secret was shown only at the original creation") &&
    !replay.includes(secret),
);

// 4. List: metadata only.
const list = await (await get("/console/applications/keys")).text();
check(
  "the list renders metadata only",
  list.includes("smoke credential") && !list.includes(secret) && !list.includes("zeck-test-secret"),
);

// 5. Rotate: confirm → successor reveal; the predecessor retires.
const confirmRotate = await (await get(`/console/applications/keys?rotate=${credentialId}`)).text();
check("the rotate confirmation renders", confirmRotate.includes("review the consequence before committing"));
const rotateResponse = await postForm(`/console/applications/keys/${credentialId}/rotate`, {
  idempotencyKey: `dash-rotate-${Date.now()}`,
});
const rotated = await rotateResponse.text();
const successorSecret =
  /id="credential-secret"[^>]*value="(zeck-test-secret-[^"]+)"/.exec(rotated)?.[1] ?? "";
check(
  "rotation reveals the successor secret",
  rotateResponse.status === 200 && successorSecret.length > 0 && successorSecret !== secret,
);
const listAfterRotate = await (await get("/console/applications/keys")).text();
check(
  "the list reflects the rotation (retired predecessor)",
  listAfterRotate.includes("retired by rotation") &&
    !listAfterRotate.includes(secret) &&
    !listAfterRotate.includes(successorSecret),
);

// 6. Revoke: confirm → PRG; the list shows revoked.
const confirmRevoke = await (await get(`/console/applications/keys?revoke=${credentialId}`)).text();
check("the revoke confirmation renders", confirmRevoke.includes("No — revoked is terminal"));
const revokeResponse = await postForm(`/console/applications/keys/${credentialId}/revoke`, {
  idempotencyKey: `dash-revoke-${Date.now()}`,
});
check("revoke PRGs back to the list", revokeResponse.status === 303);
const listAfterRevoke = await (await get("/console/applications/keys")).text();
check(
  "the list renders the authority's revoked status",
  listAfterRevoke.includes("revoked") && !listAfterRevoke.includes(successorSecret),
);

// 7. The transport token never renders anywhere.
check(
  "the transport token never renders",
  ![page, reveal, replay, list, confirmRotate, rotated, listAfterRotate, confirmRevoke, listAfterRevoke].some(
    (html) => html.includes(world.bearerToken),
  ),
);

await new Promise<void>((resolve) => server.close(() => resolve()));
await world.server.app.close();
console.log(failed === 0 ? "SMOKE OK" : `SMOKE FAILED (${failed})`);
process.exit(failed === 0 ? 0 : 1);
