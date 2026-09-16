/**
 * Credentials console module tests (DEP-011 — the projection side).
 *
 * Boots NO server: these exercise the module's pure rendering + transport
 * helpers directly, the same discipline as the state/presentation suites.
 * The full-stack browser smoke lives in
 * tests/integration/dashboard/credentials-journeys.test.ts.
 *
 * Required-test mapping:
 *  - the transport carries the house headers (Bearer authorization,
 *    X-Zeck-Application, Idempotency-Key on POSTs) and maps failures to
 *    the public error shape;
 *  - the environment-derived transport is null unless the deployment
 *    contract is bound (no fabricated transport);
 *  - form validation is the authority's contract, client-side;
 *  - the list section renders METADATA ONLY (no secret field exists),
 *    the honest boundary rows naming the facts the public contract does
 *    not carry, and the safe-connection vocabulary (provider rails,
 *    env-var NAMES only);
 *  - hostile values never render (the hostile token, a hostile label);
 *  - the reveal content shows the secret exactly once with the copy
 *    affordance and the "you will not see this again" contract; the
 *    replay content states the honest boundary instead;
 *  - confirm-then-act cards state consequence/authorization/undoability
 *    and POST to the governed console routes.
 */

import { describe, expect, test } from "vitest";
import {
  CREDENTIAL_FORM_KEYS,
  CREDENTIAL_ROLE_CHOICES,
  type CredentialConsoleTransport,
  type CredentialIssueView,
  type CredentialListView,
  createCredentialConsoleTransport,
  credentialMutationUnavailableContent,
  credentialReplayContent,
  credentialRevealContent,
  credentialsSections,
  credentialTransportFromEnvironment,
  validateCredentialIssueForm,
} from "../../../apps/dashboard/credentials";
import { ZeckApiError } from "../../../sdk";

const HOSTILE_TOKEN = "sk-live-hostile-3f9c7bd1e8d4a2";
const BASE = "http://api.test.local";
const APP = "00000000-0000-7000-8000-0000000000a1";

function recordView(over: Partial<CredentialListView> = {}): CredentialListView {
  return {
    credentials: [
      {
        id: "00000000-0000-7000-8000-0000000000c1",
        credentialId: "00000000-0000-7000-8000-0000000000c1",
        applicationId: APP,
        label: "ci integration",
        role: "member",
        status: "active",
        createdAt: "2026-09-15T12:00:00Z",
        rotatedAt: null,
        supersededBy: null,
        permissions: [
          "applications:read",
          "credentials:read",
          "environments:read",
          "memberships:read",
        ],
      },
    ],
    issuance: { enabled: true },
    ...over,
  };
}

function fakeTransport(
  view: CredentialListView,
  calls: { issue: CredentialIssueView[]; rotate: CredentialIssueView[] },
): CredentialConsoleTransport & { readonly issueCalls: string[] } {
  const issueCalls: string[] = [];
  return {
    issueCalls,
    async listCredentials() {
      return view;
    },
    async issueCredential(input, _key) {
      issueCalls.push(JSON.stringify(input));
      return (
        calls.issue[0] ?? {
          credential: view.credentials[0] ?? ({} as never),
          secret: "zeck-1",
          replayed: false,
        }
      );
    },
    async rotateCredential() {
      return (
        calls.rotate[0] ?? {
          credential: view.credentials[0] ?? ({} as never),
          secret: null,
          replayed: true,
        }
      );
    },
    async revokeCredential() {
      return { credential: view.credentials[0] ?? ({} as never), replayed: false };
    },
  };
}

describe("the transport (module-local, over the public routes)", () => {
  test("carries the house headers on every call (Bearer, X-Zeck-Application, Idempotency-Key on POSTs)", async () => {
    const seen: { method: string; url: string; headers: Record<string, string>; body?: unknown }[] =
      [];
    const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      seen.push({
        method: (init?.method ?? "GET").toUpperCase(),
        url: url.pathname,
        headers: (init?.headers ?? {}) as Record<string, string>,
        body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
      });
      return new Response(JSON.stringify(recordView()), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as unknown as typeof fetch;
    const transport = createCredentialConsoleTransport({
      baseUrl: BASE,
      token: HOSTILE_TOKEN,
      applicationId: APP,
      fetchImpl,
    });
    await transport.listCredentials();
    await transport.issueCredential({ label: "ci", role: "member" }, "dash-key");
    await transport.rotateCredential("cred-1", "dash-key-2");
    await transport.revokeCredential("cred-1", "dash-key-3");

    expect(seen.map((call) => `${call.method} ${call.url}`)).toEqual([
      "GET /credentials",
      "POST /credentials",
      "POST /credentials/cred-1/rotate",
      "POST /credentials/cred-1/revoke",
    ]);
    for (const call of seen) {
      expect(call.headers.authorization).toBe(`Bearer ${HOSTILE_TOKEN}`);
      expect(call.headers["x-zeck-application"]).toBe(APP);
    }
    expect(seen[1]?.headers["idempotency-key"]).toBe("dash-key");
    expect(seen[1]?.body).toEqual({ applicationId: APP, label: "ci", role: "member" });
    expect(seen[2]?.headers["idempotency-key"]).toBe("dash-key-2");
    expect(seen[3]?.headers["idempotency-key"]).toBe("dash-key-3");
  });

  test("maps non-2xx responses to the public error shape (ZeckApiError)", async () => {
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({
          code: "TENANT_SCOPE_VIOLATION",
          message: "cross-tenant credential access denied",
          retryable: false,
        }),
        { status: 403, headers: { "content-type": "application/json" } },
      )) as unknown as typeof fetch;
    const transport = createCredentialConsoleTransport({
      baseUrl: BASE,
      token: "t",
      applicationId: APP,
      fetchImpl,
    });
    await expect(transport.listCredentials()).rejects.toBeInstanceOf(ZeckApiError);
    await expect(transport.listCredentials()).rejects.toMatchObject({
      status: 403,
      body: { code: "TENANT_SCOPE_VIOLATION" },
    });
  });
});

describe("credentialTransportFromEnvironment (no fabricated transport)", () => {
  test("null when the deployment contract is unbound", () => {
    expect(credentialTransportFromEnvironment({})).toBeNull();
    expect(credentialTransportFromEnvironment({ ZECK_API_URL: BASE })).toBeNull();
    expect(credentialTransportFromEnvironment({ ZECK_API_URL: BASE, ZECK_TOKEN: "t" })).toBeNull();
    expect(
      credentialTransportFromEnvironment({ ZECK_TOKEN: "t", ZECK_APPLICATION_ID: APP }),
    ).toBeNull();
  });

  test("constructed when all three bindings exist", () => {
    const transport = credentialTransportFromEnvironment({
      ZECK_API_URL: BASE,
      ZECK_TOKEN: "t",
      ZECK_APPLICATION_ID: APP,
    });
    expect(transport).not.toBeNull();
  });
});

describe("the issue form (closed vocabulary)", () => {
  test("validates label, role and idempotency key against the authority's contract", () => {
    expect(
      validateCredentialIssueForm({ label: "ci integration", role: "member", idempotencyKey: "k" })
        .values,
    ).toEqual({ label: "ci integration", role: "member", idempotencyKey: "k" });
    expect(
      validateCredentialIssueForm({ label: "", role: "member", idempotencyKey: "k" }).values,
    ).toBeNull();
    expect(
      validateCredentialIssueForm({ label: "bad!", role: "member", idempotencyKey: "k" }).errors
        .label,
    ).toBeTruthy();
    expect(
      validateCredentialIssueForm({ label: "ok", role: "superuser", idempotencyKey: "k" }).errors
        .role,
    ).toBeTruthy();
    expect(
      validateCredentialIssueForm({ label: "ok", role: "member", idempotencyKey: "" }).errors
        .idempotencyKey,
    ).toBeTruthy();
  });

  test("the form vocabulary is closed and the roles are the house choices", () => {
    expect(CREDENTIAL_FORM_KEYS).toEqual(["label", "role", "idempotencyKey"]);
    expect([...CREDENTIAL_ROLE_CHOICES].sort()).toEqual(["admin", "member", "owner"]);
  });
});

describe("the keys-page sections (the projection)", () => {
  test("with a transport: metadata-only list, boundary rows, issue form, connections", async () => {
    const transport = fakeTransport(recordView(), { issue: [], rotate: [] });
    const html = await credentialsSections(transport, {}, new URLSearchParams());
    // The list: label, identity, role + permission scope, status, timestamps.
    expect(html).toContain("ci integration");
    expect(html).toContain("00000000-0000-7000-8000-0000000000c1");
    expect(html).toContain("credentials:read");
    expect(html).toContain("never rotated");
    // The explicit boundary row naming the facts the public API does not carry.
    expect(html).toContain("Facts the public contract does not carry");
    expect(html).toContain("Last used");
    expect(html).toContain("no last-used fact");
    expect(html).toContain("Usage and cost attribution");
    // The issue flow.
    expect(html).toContain("Issue a credential");
    expect(html).toContain('name="idempotencyKey"');
    // The safe-connection facts: provider rails + credential env-var NAMES.
    expect(html).toContain("Connections — bring your own keys");
    expect(html).toContain("OPENROUTER_API_KEY");
    expect(html).toContain("Zero secret values on this surface");
    // No secret material, no transport token.
    expect(html).not.toContain("zeck-1");
    expect(html).not.toContain(HOSTILE_TOKEN);
  });

  test("with issuance disabled: the honest gate renders, no form", async () => {
    const transport = fakeTransport(recordView({ issuance: { enabled: false } }), {
      issue: [],
      rotate: [],
    });
    const html = await credentialsSections(transport, {}, new URLSearchParams());
    expect(html).toContain("Credential issuance is not enabled for this deployment");
    expect(html).not.toContain('name="label"');
  });

  test("without a transport: the honest not-reachable state (never a missing-API claim)", async () => {
    const html = await credentialsSections(null, {}, new URLSearchParams());
    expect(html).toContain("not reachable from this console deployment");
    expect(html).toContain("ZECK_API_URL");
    // The wording must not claim the API lacks the surface — the routes ship.
    expect(html).not.toContain("not yet exposed by the public API");
  });

  test("a failed live read renders the honest error state inline", async () => {
    const transport: CredentialConsoleTransport = {
      async listCredentials() {
        throw new ZeckApiError(502, {
          code: "PROVIDER_ERROR",
          message: "upstream",
          retryable: true,
        });
      },
      async issueCredential() {
        throw new Error("unreachable");
      },
      async rotateCredential() {
        throw new Error("unreachable");
      },
      async revokeCredential() {
        throw new Error("unreachable");
      },
    };
    const html = await credentialsSections(transport, {}, new URLSearchParams());
    expect(html).toContain("The credential list could not be read");
    expect(html).toContain("PROVIDER_ERROR — upstream");
  });

  test("the rotate confirmation renders from the authority's list (?rotate=)", async () => {
    const transport = fakeTransport(recordView(), { issue: [], rotate: [] });
    const html = await credentialsSections(
      transport,
      {},
      new URLSearchParams("?rotate=00000000-0000-7000-8000-0000000000c1"),
    );
    expect(html).toContain("Rotate “ci integration”?");
    expect(html).toContain("A successor secret is issued");
    expect(html).toContain("review the consequence before committing");
    expect(html).toContain(
      'action="/console/applications/keys/00000000-0000-7000-8000-0000000000c1/rotate"',
    );
  });

  test("the revoke confirmation renders from the authority's list (?revoke=)", async () => {
    const transport = fakeTransport(recordView(), { issue: [], rotate: [] });
    const html = await credentialsSections(
      transport,
      {},
      new URLSearchParams("?revoke=00000000-0000-7000-8000-0000000000c1"),
    );
    expect(html).toContain("Revoke “ci integration”?");
    expect(html).toContain("immediate and idempotent");
    expect(html).toContain(
      'action="/console/applications/keys/00000000-0000-7000-8000-0000000000c1/revoke"',
    );
  });

  test("hostile values never render (label injection, transport token)", async () => {
    const base = recordView();
    const first = base.credentials[0];
    if (first === undefined) {
      throw new Error("fixture record missing");
    }
    const hostile: CredentialListView = {
      ...base,
      credentials: [{ ...first, label: '<script>alert("x")</script>' }],
    };
    const transport = fakeTransport(hostile, { issue: [], rotate: [] });
    const html = await credentialsSections(transport, {}, new URLSearchParams());
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });
});

describe("the reveal (show-once) and the honest replay", () => {
  const view: CredentialIssueView = {
    credential: {
      id: "c1",
      credentialId: "c1",
      applicationId: APP,
      label: "ci integration",
      role: "member",
      status: "active",
      createdAt: "2026-09-15T12:00:00Z",
      rotatedAt: null,
      supersededBy: null,
      permissions: ["applications:read"],
    },
    secret: "zeck-show-once-abc123",
    replayed: false,
  };

  test("the reveal shows the secret once with the copy affordance and the contract", () => {
    const html = credentialRevealContent({ action: "issued", view });
    expect(html).toContain("This is the only time this secret is shown");
    expect(html).toContain("You will not see it again");
    expect(html).toContain('id="credential-secret"');
    expect(html).toContain('value="zeck-show-once-abc123"');
    expect(html).toContain("Ctrl/Cmd+A");
    expect(html).toContain("Authorization: Bearer");
  });

  test("the replay page states the honest boundary and never a secret", () => {
    const html = credentialReplayContent({
      action: "rotated",
      view: { ...view, secret: null, replayed: true },
    });
    expect(html).toContain("The secret was shown only at the original creation");
    expect(html).toContain("rotate the credential to obtain a successor");
    expect(html).not.toContain("zeck-show-once-abc123");
  });

  test("the mutation-unavailable content names the missing transport binding", () => {
    for (const kind of ["issue", "rotate", "revoke"] as const) {
      const html = credentialMutationUnavailableContent(kind);
      expect(html).toContain("not reachable from this console deployment");
      expect(html).toContain("Back to credentials");
    }
  });
});
