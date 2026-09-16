/**
 * Credentials console integration journey (DEP-011 acceptance criterion
 * 8 — the browser smoke of issue → reveal → list → rotate → revoke).
 *
 * The full local stack, no fakes at the transport boundary:
 *  - the REAL Fastify API server (createApiServer through seedApiWorld —
 *    real routes, real request identity, the REAL credential authority
 *    over the in-memory stores, real serialization) on an ephemeral port;
 *  - the REAL credential console transport (the module-local fetch client
 *    over the public credential routes) — NOT the frozen SDK client (its
 *    credential surface is the Lead's merge note);
 *  - the REAL dashboard route table (createDashboardRoutes) served over
 *    the REAL dashboard HTTP kernel (matchRoute/readFormBody/sendResult —
 *    the same machinery apps/dashboard/index.ts dispatches through).
 *
 * The journey, over real HTTP as a browser drives it:
 *   GET  /console/applications/keys           (the list + issue form)
 *   POST /console/applications/keys/issue      (the show-once reveal)
 *   POST .../issue (same idempotency key)      (the honest replay page)
 *   GET  /console/applications/keys?rotate=…   (the confirm-then-act card)
 *   POST .../rotate                            (the successor reveal)
 *   POST .../revoke                            (PRG back; status revoked)
 *   POST .../revoke (new key)                  (idempotent convergence)
 *
 * HONEST BOUNDARY: the in-memory world stands in for the platform
 * interior; no PostgreSQL and no external secret store are contacted
 * (the integration path — wire contract, scoping, idempotency,
 * serialization, rendering — is fully real).
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createCredentialConsoleTransport } from "../../../apps/dashboard/credentials";
import {
  FormTooLargeError,
  matchRoute,
  parseCookies,
  readFormBody,
  sendResult,
} from "../../../apps/dashboard/http";
import { createDashboardRoutes } from "../../../apps/dashboard/pages";
import { createZeckClient, type ZeckClient } from "../../../sdk";
import { type ApiWorld, seedApiWorld } from "../../unit/api/world";

let world: ApiWorld;
let apiBase = "";
let base = "";
let server: ReturnType<typeof createServer>;

beforeAll(async () => {
  world = await seedApiWorld();
  await world.server.app.listen({ port: 0, host: "127.0.0.1" });
  const address = world.server.app.server.address() as AddressInfo;
  apiBase = `http://127.0.0.1:${address.port}`;

  // The dashboard's own composition: the REAL SDK client (for the pages
  // that ride it) + the REAL credential transport (DEP-011) bound to the
  // same deployment facts, served through the dashboard's REAL kernel.
  const client: ZeckClient = createZeckClient({
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
  server = createServer((request, response) => {
    void dispatch(routes, request, response).catch(() => {
      response.destroy();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await world.server.app.close();
  });
});

/** The dashboard's dispatch (apps/dashboard/index.ts's own machinery). */
async function dispatch(
  routes: ReturnType<typeof createDashboardRoutes>,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
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

async function get(path: string): Promise<Response> {
  return fetch(`${base}${path}`, { redirect: "manual" });
}

async function getHtml(path: string): Promise<string> {
  const response = await get(path);
  expect(response.status, path).toBe(200);
  expect(response.headers.get("content-type")).toContain("text/html");
  return response.text();
}

async function postForm(path: string, form: Record<string, string>): Promise<Response> {
  return fetch(`${base}${path}`, {
    method: "POST",
    body: new URLSearchParams(form).toString(),
    headers: { "content-type": "application/x-www-form-urlencoded" },
    redirect: "manual",
  });
}

describe("DEP-011: issue → reveal → list → rotate → revoke through the REAL console", () => {
  let credentialId = "";
  let issuedSecret = "";
  let rotatedSecret = "";

  test("the keys page renders the live list surface and the guided issue form", async () => {
    const html = await getHtml("/console/applications/keys");
    // The DEP-011 sections: live list, issue flow, safe connections.
    expect(html).toContain("Credentials in this application");
    expect(html).toContain("No credentials are issued for this application scope");
    expect(html).toContain("Issue a credential");
    expect(html).toContain('action="/console/applications/keys/issue"');
    expect(html).toContain('name="idempotencyKey"');
    expect(html).toContain("Connections — bring your own keys");
    // The safe-credential vocabulary and the boundary rows.
    expect(html).toContain("shown exactly once at creation");
    expect(html).toContain("Last used");
    expect(html).toContain("no last-used fact");
    // a11y frame + one h1.
    expect((html.match(/<h1[^>]*>/g) ?? []).length).toBe(1);
  });

  test("issue: the governed POST reveals the secret exactly once", async () => {
    const page = await getHtml("/console/applications/keys");
    const key = /name="idempotencyKey" value="(dash-[^"]+)"/.exec(page)?.[1] ?? "";
    expect(key).toMatch(/^dash-/);
    const response = await postForm("/console/applications/keys/issue", {
      label: "ci integration",
      role: "member",
      idempotencyKey: key,
    });
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("This is the only time this secret is shown");
    expect(html).toContain("You will not see it again");
    const secret = /id="credential-secret"[^>]*value="(zeck-test-secret-[^"]+)"/.exec(html)?.[1];
    expect(secret).toMatch(/^zeck-test-secret-/);
    issuedSecret = secret ?? "";
    credentialId = /Credential identity<\/th><td>([^<]+)<\/td>/.exec(html)?.[1] ?? "";
    expect(credentialId).toMatch(/^[0-9a-f-]{36}$/);
    // The authority's record facts render from the projection.
    expect(html).toContain("ci integration");
    expect(html).toContain("member");
  });

  test("re-POSTing the same idempotency key renders the honest replay page (no secret)", async () => {
    const page = await getHtml("/console/applications/keys");
    // The form renders a fresh key each page load; re-POST with the FIRST
    // key to simulate a page refresh of the reveal response.
    const firstKey = /name="idempotencyKey" value="(dash-[^"]+)"/.exec(page)?.[1] ?? "";
    expect(firstKey).toMatch(/^dash-/);
    const replayKey = `replay-${firstKey}`;
    // Issue with replayKey first, then re-POST the same replayKey.
    await postForm("/console/applications/keys/issue", {
      label: "replay probe",
      role: "member",
      idempotencyKey: replayKey,
    });
    const response = await postForm("/console/applications/keys/issue", {
      label: "replay probe",
      role: "member",
      idempotencyKey: replayKey,
    });
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("The secret was shown only at the original creation");
    expect(html).not.toContain(issuedSecret);
  });

  test("list: the issued credential renders metadata-only with live facts", async () => {
    const html = await getHtml("/console/applications/keys");
    expect(html).toContain("ci integration");
    expect(html).toContain(credentialId);
    expect(html).toContain("never rotated");
    expect(html).toContain("credentials:read");
    // No secret material on the list.
    expect(html).not.toContain(issuedSecret);
    expect(html).not.toContain("zeck-test-secret");
    // The transport token never renders.
    expect(html).not.toContain(world.bearerToken);
  });

  test("rotate: confirm-then-act card, then the successor reveal retires the predecessor", async () => {
    const confirm = await getHtml(`/console/applications/keys?rotate=${credentialId}`);
    expect(confirm).toContain(`Rotate “ci integration”?`);
    expect(confirm).toContain("A successor secret is issued");
    expect(confirm).toContain("review the consequence before committing");
    const key = /name="idempotencyKey" value="(dash-[^"]+)"/.exec(confirm)?.[1] ?? "";
    expect(key).toMatch(/^dash-/);
    const response = await postForm(`/console/applications/keys/${credentialId}/rotate`, {
      idempotencyKey: key,
    });
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain("This is the only time this secret is shown");
    const secret = /id="credential-secret"[^>]*value="(zeck-test-secret-[^"]+)"/.exec(html)?.[1];
    expect(secret).toMatch(/^zeck-test-secret-/);
    expect(secret).not.toBe(issuedSecret);
    rotatedSecret = secret ?? "";

    // Both rotation outcomes are reflected in the list.
    const list = await getHtml("/console/applications/keys");
    expect(list).toContain("retired by rotation");
    expect(list).toContain(credentialId);
    expect(list).not.toContain(issuedSecret);
    expect(list).not.toContain(rotatedSecret);
  });

  test("revoke: the confirm card, then PRG back to a revoked list", async () => {
    const confirm = await getHtml(`/console/applications/keys?revoke=${credentialId}`);
    expect(confirm).toContain(`Revoke “ci integration”?`);
    expect(confirm).toContain("No — revoked is terminal");
    expect(confirm).toContain("immediate and idempotent");
    const key = /name="idempotencyKey" value="(dash-[^"]+)"/.exec(confirm)?.[1] ?? "";
    const response = await postForm(`/console/applications/keys/${credentialId}/revoke`, {
      idempotencyKey: key,
    });
    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/console/applications/keys");

    const list = await getHtml("/console/applications/keys");
    expect(list).toContain("revoked");
    expect(list).toContain("no actions — this record is terminal");
    expect(list).not.toContain(rotatedSecret);
  });

  test("revoking again with a fresh key converges (idempotent semantics over HTTP)", async () => {
    const response = await postForm(`/console/applications/keys/${credentialId}/revoke`, {
      idempotencyKey: `dash-revoke-again-${Date.now()}`,
    });
    expect(response.status).toBe(303);
    const list = await getHtml("/console/applications/keys");
    expect(list).toContain("revoked");
    expect(list).not.toContain(rotatedSecret);
  });

  test("THE SECRET PROOF: no secret material and no transport token on any page of the journey", async () => {
    for (const path of [
      "/console/applications/keys",
      `/console/applications/keys?rotate=${credentialId}`,
      `/console/applications/keys?revoke=${credentialId}`,
    ]) {
      const html = await getHtml(path);
      expect(html).not.toContain(issuedSecret);
      expect(html).not.toContain(rotatedSecret);
      expect(html).not.toContain(world.bearerToken);
    }
  });

  test("the console composes the authority's own status transitions (final list state)", async () => {
    const html = await getHtml("/console/applications/keys");
    // The rotated lineage: retired predecessor + revoked successor, one identity.
    expect(html).toContain("retired by rotation");
    expect(html).toContain("revoked");
    expect((html.match(new RegExp(credentialId, "g")) ?? []).length).toBeGreaterThanOrEqual(2);
  });
});
