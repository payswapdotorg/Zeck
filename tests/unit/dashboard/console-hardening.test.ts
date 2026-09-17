/**
 * DEP-033 — console hardening regression suite (fail-before/pass-after
 * house style: every test names the PRE-FIX failure mode it pins).
 *
 * Boots the REAL dashboard route table (`createDashboardRoutes`) over the
 * REAL dashboard HTTP kernel (matchRoute/parseCookies/readFormBody/
 * sendResult — the same machinery apps/dashboard/index.ts dispatches
 * through) and drives it with real `fetch`, the
 * tests/integration/dashboard/credentials-journeys pattern:
 *  - the SDK client rides a fake `fetchImpl` (an in-memory public-API
 *    wire world carrying HOSTILE execution records — hostile ids, task
 *    fields, event payloads with secret-shaped keys);
 *  - the credential console rides a fake transport (a list carrying a
 *    HOSTILE label; issue → the show-once reveal view).
 *
 * THE DEFECT PINS (every one fixed on this branch; each test fails on the
 * pre-fix markup and passes on the fixed markup):
 *  - D1 responsive scroll-trap: wide table.data/table.kv (the console's
 *    5–8 column tables measure 826–1092px intrinsic min-content) stretched
 *    the .app-shell grid items (min-width:auto) and trapped the whole
 *    document in horizontal scroll on mobile/tablet viewports. Fix:
 *    min-width:0 on the four shell regions + display:block/overflow-x:auto
 *    on the wide tables (they scroll WITHIN their box; table semantics
 *    survive display:block — verified in the DEP-033 browser drive).
 *  - D2 aria-describedby rode the LABEL (meaningless to assistive tech):
 *    now injected on the CONTROL in executionFormField/workloadFormField.
 *  - D3 field errors rendered with the .form-error class that carried NO
 *    stylesheet rule (unstyled errors), and the idempotency-key form-level
 *    error was validated but NEVER RENDERED. Fix: .field-error + role=alert
 *    + the idempotency-key errorOf() call.
 *  - D4 forms used class="card form" — the .form class carried no rule (no
 *    form layout at all). Fix: class="flow card" (the real form grid).
 *  - D5 the credentials issue form never wired its hints/errors to the
 *    controls (label input + role select carried no aria-describedby).
 *  - D6 the show-once secret reveal (section.reveal/.secret-reveal) had no
 *    styling rules — the copy affordance rendered as a bare input.
 *  - D7 the numbered step journeys (quickstart five steps) reused
 *    ol.timeline's time+stage two-column grid — each single-paragraph step
 *    was squeezed into the 9rem time column (144px usable beside 784px
 *    dead space, measured in the DEP-033 browser drive). Fix: ol.steps
 *    grid rule + the markup switch.
 *  - D8 the command-suggestions rule "mangled" in tool output was a
 *    DISPLAY-PIPELINE PHANTOM (the environment strips the byte sequence
 *    "[h" from displayed output; od -c verified the file bytes carry the
 *    well-formed `li[hidden]` selector). Pinned here byte-exactly so a
 *    REAL mangle can never land silently.
 *  - D9 the composer's fixed-by-contract fields render their label as
 *    <p class="form-label"> — unstyled (lighter than the editable fields'
 *    labels, so one composed form read as two kinds of fields). Fix:
 *    .form-field > .form-label { font-weight: 600 }.
 *
 * AC3 hostile-value probes: every console render path that interpolates
 * user-influenced strings — execution ids (lookup redirect, path params,
 * cookie-derived recents), family ids (the playground route param),
 * labels (credential records), form values (re-rendered on validation
 * failure) — refuses/escapes, never reflects markup, and the
 * `[not displayed]` redaction doctrine holds on the raw-payload view.
 *
 * AC4 no-script foundation: the rendered console pages carry native links,
 * GET forms and details/summary disclosures — no inline handlers, no
 * script dependence in the markup; client.js is the enhancement layer
 * only.
 *
 * AC7 route-count pin: the route table carries exactly the pinned 88
 * routes (this order adds none).
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  type CredentialConsoleTransport,
  type CredentialIssueView,
  type CredentialListView,
} from "../../../apps/dashboard/credentials";
import {
  FormTooLargeError,
  matchRoute,
  parseCookies,
  readFormBody,
  sendResult,
} from "../../../apps/dashboard/http";
import { createDashboardRoutes } from "../../../apps/dashboard/pages";
import { DASHBOARD_CSS } from "../../../apps/dashboard/tokens";
import { createZeckClient, type ZeckClient } from "../../../sdk";

const APP_ID = "00000000-0000-7000-8000-0000000000a1";
const EXECUTION_ID = "00000000-0000-7000-8000-0000000000e1";
/** Markup-carrying hostile values, the html-escape.test.ts discipline. */
const HOSTILE = `"><script>zeck("x")</script>&'`;
const HOSTILE_ENCODED = encodeURIComponent(HOSTILE);
/** A hostile execution id that "exists" in the fake API world. */
const HOSTILE_EXECUTION_ID = `h-"><script>alert(1)</script>-id`;

function hostileExecution(id: string): ReturnType<typeof benignExecution> {
  return {
    ...benignExecution(),
    id,
    task: { kind: HOSTILE, description: HOSTILE },
    metadata: { hostile: HOSTILE },
  };
}

function benignExecution(): {
  id: string;
  applicationId: string;
  environmentId: string | null;
  status: string;
  task: { kind: string; description: string };
  constraints: null;
  metadata: Record<string, string>;
  createdAt: string;
  updatedAt: string;
  terminalAt: string | null;
} {
  return {
    id: EXECUTION_ID,
    applicationId: APP_ID,
    environmentId: null,
    status: "COMPLETED",
    task: { kind: "outcome", description: "Contract risk analysis" },
    constraints: null,
    metadata: {},
    createdAt: "2026-09-15T12:00:00Z",
    updatedAt: "2026-09-15T12:03:42Z",
    terminalAt: "2026-09-15T12:03:42Z",
  };
}

/** The fake public-API wire world: hostile records + honest 404s. */
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
  const path = new URL(String(input)).pathname;
  if (path === `/executions/${encodeURIComponent(HOSTILE_EXECUTION_ID)}`) {
    return json(hostileExecution(HOSTILE_EXECUTION_ID));
  }
  if (path === `/executions/${encodeURIComponent(HOSTILE_EXECUTION_ID)}/events`) {
    // A hostile event payload that ALSO carries secret-shaped keys: the
    // redaction doctrine must render [not displayed], never the value.
    return json([
      {
        eventId: "ev-1",
        executionId: HOSTILE_EXECUTION_ID,
        applicationId: APP_ID,
        sequence: 1,
        type: HOSTILE,
        occurredAt: "2026-09-15T12:00:01Z",
        payload: {
          message: HOSTILE,
          api_key: "sk-live-should-never-render-7731",
          nested: { token: "sk-live-nested-9910", note: HOSTILE },
        },
      },
    ]);
  }
  if (path === `/executions/${encodeURIComponent(HOSTILE_EXECUTION_ID)}/results`) {
    return json({
      executionId: HOSTILE_EXECUTION_ID,
      status: "COMPLETED",
      route: { provider: HOSTILE, model: HOSTILE, strategyClass: "hybrid", modelCalls: 2 },
      cost: { totalMicroUsd: "4180000", currency: "usd" },
      usage: null,
      outputArtifacts: [],
      verification: [],
      warnings: [],
      terminalAt: "2026-09-15T12:03:42Z",
    });
  }
  if (path === "/executions" && init?.method === "POST") {
    return json({ message: HOSTILE, code: "VALIDATION_ERROR", retryable: false }, 422);
  }
  // Every OTHER execution id (hostile or not) is an honest API 404 whose
  // message itself carries hostile material — the error path is a render
  // path too.
  if (path.startsWith("/executions/")) {
    return json(
      { code: "NOT_FOUND", message: `no execution ${decodeURIComponent(path.split("/")[2] ?? "")}` },
      404,
    );
  }
  if (path === "/agents") return json([]);
  return json({ code: "PROVIDER_ERROR", message: `unexpected path ${path}`, retryable: true }, 500);
}) as unknown as typeof fetch;

/** The fake credential console transport: a hostile label in the list. */
const credentials: CredentialConsoleTransport & { readonly issued: CredentialIssueView[] } = {
  issued: [],
  async listCredentials(): Promise<CredentialListView> {
    return {
      credentials: [
        {
          id: "00000000-0000-7000-8000-0000000000c1",
          credentialId: "00000000-0000-7000-8000-0000000000c1",
          applicationId: APP_ID,
          label: HOSTILE,
          role: "member",
          status: "active",
          createdAt: "2026-09-15T12:00:00Z",
          rotatedAt: null,
          supersededBy: null,
          permissions: ["applications:read"],
        },
      ],
      issuance: { enabled: true },
    };
  },
  async issueCredential(input, idempotencyKey): Promise<CredentialIssueView> {
    const view: CredentialIssueView = {
      replayed: false,
      secret: "zeck-test-secret-issued-once-4f2a",
      credential: {
        id: "00000000-0000-7000-8000-0000000000c2",
        credentialId: "00000000-0000-7000-8000-0000000000c2",
        applicationId: APP_ID,
        label: input.label,
        role: input.role,
        status: "active",
        createdAt: "2026-09-17T09:00:00Z",
        rotatedAt: null,
        supersededBy: null,
        permissions: ["applications:read"],
      },
      idempotencyKey,
    };
    this.issued.push(view);
    return view;
  },
  async rotateCredential(): Promise<CredentialIssueView> {
    throw new Error("rotate is not exercised by this suite");
  },
  async revokeCredential(): Promise<never> {
    throw new Error("revoke is not exercised by this suite");
  },
};

let base = "";
let server: ReturnType<typeof createServer>;
let client: ZeckClient;
let routes: ReturnType<typeof createDashboardRoutes>;

beforeAll(async () => {
  client = createZeckClient({
    baseUrl: "http://fake.local",
    token: "token",
    applicationId: APP_ID,
    fetchImpl,
  });
  routes = createDashboardRoutes(client, { applicationId: APP_ID, credentials });
  server = createServer((request, response) => {
    void dispatch(request, response).catch(() => {
      response.destroy();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
});

/** The dashboard's dispatch (apps/dashboard/index.ts's own machinery). */
async function dispatch(
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

async function get(path: string, cookie?: string): Promise<Response> {
  return fetch(`${base}${path}`, {
    redirect: "manual",
    headers: cookie === undefined ? {} : { cookie },
  });
}

async function getHtml(path: string, cookie?: string): Promise<string> {
  const response = await get(path, cookie);
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

/** The hostile value's escaped HTML form (components.ts esc). */
const ESCAPED_HOSTILE = HOSTILE.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(
  />/g,
  "&gt;",
).replace(/"/g, "&quot;").replace(/'/g, "&#39;");

// ---------------------------------------------------------------------------
// D1 — the responsive scroll-trap
// ---------------------------------------------------------------------------

describe("D1: the wide tables scroll in-box (fail-before: they stretched the page grid)", () => {
  test("the stylesheet carries min-width:0 on all four shell regions", () => {
    // Pre-fix: .app-header/.app-nav/.app-main/.app-footer inherited the
    // grid default min-width:auto, so one wide child stretched the whole
    // document. Post-fix the regions can shrink below their content.
    expect(DASHBOARD_CSS).toContain(".app-header, .app-nav, .app-main, .app-footer { min-width: 0; }");
  });

  test("the stylesheet makes table.data/table.kv scroll within their own box", () => {
    // Pre-fix: an 826–1092px intrinsic table widened the page grid and
    // trapped the document in horizontal scroll on mobile/tablet.
    expect(DASHBOARD_CSS).toContain("table.data, table.kv { display: block; overflow-x: auto; }");
  });

  test("the SERVED page embeds both responsive rules (the wire carries them)", async () => {
    const html = await getHtml("/console/quickstart");
    expect(html).toContain(".app-header, .app-nav, .app-main, .app-footer { min-width: 0; }");
    expect(html).toContain("table.data, table.kv { display: block; overflow-x: auto; }");
    // The responsive foundation the shell already carried (pinned by
    // navigation.test.ts) stays present alongside the fix.
    expect(html).toContain('name="viewport"');
    expect(html).toContain("@media (max-width: 1024px)");
    expect(html).toContain("@media (max-width: 640px)");
  });
});

// ---------------------------------------------------------------------------
// D2 — aria-describedby rides the CONTROL
// ---------------------------------------------------------------------------

describe("D2: error references ride the control, not the label (fail-before: on the label, meaningless to AT)", () => {
  test("the execution form's invalid fields carry aria-describedby on their inputs", async () => {
    // Reviewable (outcome + applicationId present) but invalid values →
    // the re-rendered form carries field errors.
    const response = await get(
      `/build/execution?outcome=${encodeURIComponent(
        "Analyze these contracts",
      )}&applicationId=${APP_ID}&spendLimitDollars=abc&latencySeconds=xyz&quality=hostile`,
    );
    expect(response.status).toBe(200);
    const html = await response.text();
    // Pre-fix: aria-describedby="<id>-error" sat on the <label> — focus
    // landing on the CONTROL never announced the error. Post-fix the
    // control references the error paragraph.
    expect(html).toContain('id="f-spend" aria-describedby="f-spend-error"');
    expect(html).toContain('id="f-latency" aria-describedby="f-latency-error"');
    expect(html).toContain('id="f-quality" aria-describedby="f-quality-error"');
    // …and the LABELS no longer carry the attribute.
    expect(html).not.toContain('<label for="f-spend" aria-describedby');
    expect(html).not.toContain('<label for="f-latency" aria-describedby');
    // The error paragraphs themselves still render (id + class + text).
    expect(html).toContain('class="field-error" id="f-spend-error"');
    expect(html).toContain("Enter a spend limit as a dollar amount");
  });

  test("the workload form's invalid fields carry aria-describedby on their inputs", async () => {
    const response = await get(
      `/build/workload?purpose=${encodeURIComponent(
        "Summarize the quarter",
      )}&applicationId=${APP_ID}&budgetDollars=not-a-number`,
    );
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('id="wl-budget" aria-describedby="wl-budget-error"');
    expect(html).not.toContain('<label for="wl-budget" aria-describedby');
  });

  test("the playground composer's invalid fields carry aria-describedby on their controls", async () => {
    const response = await postForm("/console/playground/text", {
      applicationId: "",
      idempotencyKey: "",
    });
    expect(response.status).toBe(422);
    const html = await response.text();
    expect(html).toContain('id="pf-application" aria-describedby="pf-application-error"');
    expect(html).not.toContain('<label for="pf-application" aria-describedby');
  });
});

// ---------------------------------------------------------------------------
// D3 — field errors render styled + announced (incl. the idempotency-key error)
// ---------------------------------------------------------------------------

describe("D3: field errors render with .field-error + role=alert (fail-before: the .form-error class carried no rule; the idempotency-key error never rendered)", () => {
  test("validation failures render styled, announced error paragraphs — never the ruleless .form-error class", async () => {
    const response = await postForm("/console/applications/keys/issue", {
      label: HOSTILE,
      role: "hostile-role",
      idempotencyKey: "",
    });
    expect(response.status).toBe(422);
    const html = await response.text();
    // Pre-fix: <p class="form-error"> — a class the stylesheet never
    // defined, so errors rendered as unstyled body text.
    expect(html).toContain('class="field-error" id="label-error" role="alert"');
    expect(html).toContain('class="field-error" id="role-error" role="alert"');
    expect(html).not.toContain('class="form-error"');
  });

  test("the idempotency-key form-level error RENDERS (fail-before: validated but never rendered)", async () => {
    const response = await postForm("/console/applications/keys/issue", {
      label: "a valid label",
      role: "member",
      idempotencyKey: "",
    });
    expect(response.status).toBe(422);
    const html = await response.text();
    expect(html).toContain('class="field-error" id="idempotencyKey-error"');
    expect(html).toContain("The form state was lost");
  });
});

// ---------------------------------------------------------------------------
// D4 — the flow-card form layout
// ---------------------------------------------------------------------------

describe("D4: forms use the flow card layout (fail-before: class=\"card form\" carried no stylesheet rule)", () => {
  test("the explorer's lookup form uses class=\"flow card\"", async () => {
    const html = await getHtml("/console/executions");
    expect(html).toContain('class="flow card"');
    // Pre-fix: the lookup form rendered class="card form" — the .form
    // class has no rule, so the fields stacked with no gap discipline.
    expect(html).not.toContain('card form"');
  });

  test("the credentials issue form uses class=\"flow card\"", async () => {
    const html = await getHtml("/console/applications/keys");
    expect(html).toContain('class="flow card"');
    expect(html).not.toContain('card form"');
  });
});

// ---------------------------------------------------------------------------
// D5 — the credentials issue form wires hints + errors to the controls
// ---------------------------------------------------------------------------

describe("D5: the credentials form wires aria-describedby to its controls (fail-before: neither input nor select carried it)", () => {
  test("the happy-path label input references its hint", async () => {
    const html = await getHtml("/console/applications/keys");
    expect(html).toMatch(
      /<input id="credential-label" name="label"[^>]*aria-describedby="credential-label-help"/,
    );
  });

  test("on validation failure the label input references hint + error, the role select references its error", async () => {
    const response = await postForm("/console/applications/keys/issue", {
      label: HOSTILE,
      role: "hostile-role",
      idempotencyKey: "dash-kept",
    });
    expect(response.status).toBe(422);
    const html = await response.text();
    expect(html).toMatch(
      /<input id="credential-label" name="label"[^>]*aria-describedby="credential-label-help label-error"/,
    );
    expect(html).toMatch(
      /<select id="credential-role" name="role"[^>]*aria-describedby="role-error"/,
    );
    // The label ELEMENT itself stays a plain label (D2's rule).
    expect(html).not.toContain('<label for="credential-label" aria-describedby');
    expect(html).not.toContain('<label for="credential-role" aria-describedby');
  });
});

// ---------------------------------------------------------------------------
// D6 — the show-once reveal surface
// ---------------------------------------------------------------------------

describe("D6: the show-once secret reveal surface is styled (fail-before: section.reveal/.secret-reveal carried no rules)", () => {
  test("the stylesheet carries the reveal surface rules", () => {
    expect(DASHBOARD_CSS).toContain("section.reveal .secret-reveal {");
    expect(DASHBOARD_CSS).toContain("section.reveal .secret-reveal input {");
  });

  test("the issued reveal renders the styled copy affordance with its a11y wiring", async () => {
    const response = await postForm("/console/applications/keys/issue", {
      label: "ci integration",
      role: "member",
      idempotencyKey: "dash-reveal-1",
    });
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('<section class="reveal" aria-labelledby="reveal-title">');
    expect(html).toContain('<div class="secret-reveal">');
    // The no-script copy affordance: a readonly mono field labelled for
    // screen readers, with its hint wired through aria-describedby.
    expect(html).toMatch(
      /<input id="credential-secret" class="mono" type="text" readonly value="zeck-test-secret-[^"]*" aria-describedby="secret-help">/,
    );
    expect(html).toContain("shown exactly once");
    expect(html).toContain("You will not see it again");
  });
});

// ---------------------------------------------------------------------------
// D7 — the numbered step journeys
// ---------------------------------------------------------------------------

describe("D7: the quickstart steps use the steps grid (fail-before: ol.timeline squeezed each step into the 9rem time column)", () => {
  test("the quickstart renders <ol class=\"steps\">, never a timeline", async () => {
    const html = await getHtml("/console/quickstart");
    expect(html).toContain('<ol class="steps">');
    // Pre-fix: <ol class="timeline"> — the time+stage two-column grid
    // rendered each single-paragraph step in the 144px time column.
    expect(html).not.toContain('<ol class="timeline">');
  });

  test("the stylesheet carries the steps grid rule (and keeps the run timeline's own rule)", () => {
    expect(DASHBOARD_CSS).toContain("ol.steps { display: grid;");
    // The .timeline rule itself stays — the execution activity timeline
    // (time + stage) still uses it; only the numbered step journeys moved.
    expect(DASHBOARD_CSS).toContain(".timeline {");
  });
});

// ---------------------------------------------------------------------------
// D8 — the display-pipeline phantom, byte-pinned
// ---------------------------------------------------------------------------

describe("D8: the command-suggestions rules are well-formed (the tool-display phantom, byte-pinned)", () => {
  test("the stylesheet carries the exact well-formed li[hidden] selector — a real mangle cannot land silently", () => {
    // During DEP-033 the rule APPEARED mangled in tool output as
    // `.command-suggestions liidden]` — byte-level verification (od -c +
    // git blob comparison) proved the file carries the well-formed
    // selector and the DISPLAY pipeline strips the "[h" byte sequence
    // from shown output. This pin reads the REAL bytes in-process (no
    // display pipeline), so it holds the line against a genuine mangle.
    expect(DASHBOARD_CSS).toContain(".command-suggestions li[hidden] { display: none; }");
    expect(DASHBOARD_CSS).not.toContain("liidden]");
    // The surrounding rule family stays well-formed too.
    expect(DASHBOARD_CSS).toContain(".command-suggestions { list-style: none;");
    expect(DASHBOARD_CSS).toContain(".command-suggestions a:hover { background: var(--surface-sunken); text-decoration: underline; }");
  });
});

// ---------------------------------------------------------------------------
// D9 — the composer's fixed-field label weight
// ---------------------------------------------------------------------------

describe("D9: the composer's fixed-field labels match the editable label weight (fail-before: .form-label rendered unstyled)", () => {
  test("the stylesheet weights .form-field > .form-label like editable labels", () => {
    expect(DASHBOARD_CSS).toContain(".form-field > .form-label { font-weight: 600; }");
  });

  test("the playground composer renders its fixed-by-contract fields with class=\"form-label\"", async () => {
    const html = await getHtml("/console/playground/text");
    // The task discriminator is fixed by the advertised contract — it
    // renders as a labelled non-editable fact beside the editable fields.
    expect(html).toContain('class="form-label"');
    expect(html).toContain("fixed by the advertised contract");
  });
});

// ---------------------------------------------------------------------------
// AC3 — hostile-value probes over every user-influenced render path
// ---------------------------------------------------------------------------

describe("AC3 hostile probes: no reflected markup on any user-influenced render path", () => {
  test("a hostile execution id in the lookup redirect is percent-encoded, never raw", async () => {
    const response = await get(`/executions?id=${HOSTILE_ENCODED}`);
    expect(response.status).toBe(303);
    const location = response.headers.get("location") ?? "";
    expect(location).toBe(`/runs/${HOSTILE_ENCODED}`);
    expect(location).not.toContain("<script>");
  });

  test("a hostile execution id in the path renders the honest 404 with the id escaped", async () => {
    const response = await get(`/runs/${HOSTILE_ENCODED}`);
    expect(response.status).toBe(404);
    const html = await response.text();
    expect(html).not.toContain("<script>");
    expect(html).not.toContain('">"');
    // The hostile id appears only in escaped form inside the honest
    // error state (the fake API's 404 message carries it raw — the
    // console must escape what it renders).
    expect(html).toContain(ESCAPED_HOSTILE);
  });

  test("a hostile family id renders the honest 404 with the id escaped", async () => {
    const response = await get(`/console/playground/${HOSTILE_ENCODED}`);
    expect(response.status).toBe(404);
    const html = await response.text();
    expect(html).toContain("No such workload family");
    expect(html).not.toContain("<script>");
    expect(html).toContain(ESCAPED_HOSTILE);
  });

  test("a hostile credential label in the list renders escaped (metadata list, never a secret field)", async () => {
    const html = await getHtml("/console/applications/keys");
    expect(html).toContain(ESCAPED_HOSTILE);
    expect(html).not.toContain(`>${HOSTILE}<`);
    expect(html).not.toContain("<script>");
    // The secret-shaped material from the transport never renders here.
    expect(html).not.toContain("zeck-test-secret");
  });

  test("hostile form values re-render escaped on validation failure (no attribute breakout)", async () => {
    const response = await get(
      `/build/execution?outcome=${encodeURIComponent(
        HOSTILE,
      )}&applicationId=${APP_ID}&quality=hostile-quality`,
    );
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).not.toContain("<script>");
    // The hostile outcome is re-rendered inside the textarea's escaped
    // content; the hostile quality fails validation and its select keeps
    // no reflected raw value.
    expect(html).toContain("&quot;&gt;&lt;script&gt;");
  });

  test("cookie-derived recents carrying hostile ids render escaped and prune on 404", async () => {
    // One known hostile-id execution (renders escaped) + one unknown
    // hostile id (the live read 404s → pruned, Set-Cookie re-issued).
    const cookie = `zeck_recent_executions=${encodeURIComponent(
      `${HOSTILE_EXECUTION_ID},${HOSTILE}`,
    )}`;
    const html = await getHtml("/", cookie);
    expect(html).not.toContain("<script>");
    expect(html).toContain(ESCAPED_HOSTILE);
    // The pruned cookie re-issued by this read carries ONLY the surviving
    // id, percent-encoded (serializeCookie's own encoding) — the unknown
    // hostile id is dropped, and neither id crosses the wire raw.
    const response = await get("/", cookie);
    const setCookie = response.headers.get("set-cookie") ?? "";
    expect(setCookie).toContain("zeck_recent_executions=");
    expect(setCookie).toContain(encodeURIComponent(HOSTILE_EXECUTION_ID));
    expect(setCookie).not.toContain(encodeURIComponent(HOSTILE));
    expect(setCookie).not.toContain("<script>");
  });

  test("the hostile execution detail renders every field escaped (task, metadata, route)", async () => {
    const html = await getHtml(`/runs/${encodeURIComponent(HOSTILE_EXECUTION_ID)}`);
    expect(html).not.toContain("<script>");
    expect(html).toContain(ESCAPED_HOSTILE);
  });

  test("the raw payload view enforces the [not displayed] redaction doctrine on secret-shaped keys", async () => {
    const html = await getHtml(
      `/runs/${encodeURIComponent(HOSTILE_EXECUTION_ID)}?tab=activity&view=raw`,
    );
    // Secret-shaped keys render the doctrine marker, never the value —
    // at the top level AND nested.
    expect(html).toContain("[not displayed]");
    expect(html).not.toContain("sk-live-should-never-render-7731");
    expect(html).not.toContain("sk-live-nested-9910");
    // The hostile free-text values in the same payload stay escaped.
    expect(html).not.toContain("<script>");
  });

  test("the hostile API error message on a failed create renders escaped (the 422 boundary)", async () => {
    const response = await postForm("/build/execution", {
      applicationId: APP_ID,
      outcome: "Analyze these contracts",
      idempotencyKey: "dash-hostile-1",
    });
    // The fake API refuses the create with a hostile message; the
    // console renders it through the public error shape, escaped.
    expect(response.status).toBe(422);
    const html = await response.text();
    expect(html).not.toContain("<script>");
    expect(html).toContain(ESCAPED_HOSTILE);
  });
});

// ---------------------------------------------------------------------------
// AC4 — the no-script foundation
// ---------------------------------------------------------------------------

describe("AC4: the no-script foundation — native links, GET forms, details/summary, zero inline handlers", () => {
  const PAGES = [
    "/console",
    "/console/quickstart",
    "/console/applications",
    "/console/applications/keys",
    "/console/applications/environments",
    "/console/applications/usage",
    "/console/playground",
    "/console/playground/text",
    "/console/executions",
    "/console/docs",
    "/console/settings",
  ] as const;

  test("every console primary-journey page renders native links (usable with script off)", async () => {
    for (const path of PAGES) {
      const html = await getHtml(path);
      expect(html, path).toContain('<a href="/');
    }
  });

  test("no console page carries an inline event handler or javascript: URL", async () => {
    for (const path of PAGES) {
      const html = await getHtml(path);
      expect(html, path).not.toMatch(/\son[a-z]+\s*=/i);
      expect(html, path).not.toContain("javascript:");
    }
  });

  test("the lookup journey is a native GET form; the mode/appearance preferences are native GET forms", async () => {
    const explorerHtml = await getHtml("/console/executions");
    expect(explorerHtml).toContain('<form method="get" action="/executions" class="flow card">');
    const settingsHtml = await getHtml("/console/settings");
    expect(settingsHtml).toContain('method="get" action="/mode"');
    expect(settingsHtml).toContain('method="get" action="/appearance"');
  });

  test("the credentials journey's issue form is a native POST form (no script needed to submit)", async () => {
    const html = await getHtml("/console/applications/keys");
    expect(html).toContain('<form method="post" action="/console/applications/keys/issue"');
    expect(html).toContain('<button type="submit" class="primary">Issue credential</button>');
  });

  test("disclosures render as native details/summary (openable with script off)", async () => {
    const keysHtml = await getHtml("/console/applications/keys");
    expect(keysHtml).toMatch(/<details class="[^"]*"[^>]*>\s*<summary/);
    const explorerHtml = await getHtml("/console/executions");
    expect(explorerHtml).toContain("<details");
    expect(explorerHtml).toContain("<summary");
  });

  test("client.js is the enhancement layer only: a deferred external script, never inline behavior", async () => {
    const html = await getHtml("/console/quickstart");
    expect(html).toContain('<script src="/assets/client.js" defer></script>');
    // The foundation above (links, forms, details) all rendered BEFORE
    // and WITHOUT that script: exactly one script tag, and it is external.
    expect((html.match(/<script/g) ?? []).length).toBe(1);
  });

  test("the skip link stays the first focusable element on console pages", async () => {
    const html = await getHtml("/console/quickstart");
    expect(html).toContain('<a class="skip-link" href="#main">Skip to main content</a>');
    const mainIndex = html.indexOf('<a class="skip-link"');
    const firstLinkIndex = html.indexOf("<a ");
    expect(mainIndex).toBe(firstLinkIndex);
  });
});

// ---------------------------------------------------------------------------
// AC7 — the route-count pin
// ---------------------------------------------------------------------------

describe("AC7: the route table carries exactly the pinned routes (this order adds none)", () => {
  test("the dashboard route table is exactly 88 routes — the base count, unchanged by DEP-033", () => {
    expect(routes.length).toBe(88);
    // The console surface set stays pinned (spot-check the DEP-033 scope:
    // no new route patterns landed beside the existing console routes).
    const patterns = routes.map((route) => `${route.method} ${route.pattern}`);
    expect(patterns).toContain("GET /console/quickstart");
    expect(patterns).toContain("GET /console/executions");
    expect(patterns).toContain("GET /console/compare");
    expect(patterns).toContain("GET /console/settings");
    expect(patterns.filter((pattern) => pattern.startsWith("GET /console")).length).toBe(40);
    expect(patterns.filter((pattern) => pattern.startsWith("POST /console")).length).toBe(6);
    // The public API's machine contract is untouched by this order
    // (AC7's zero-new-routes rule covers the openapi boundary too —
    // verified against the base blob in the delivery evidence).
  });
});
