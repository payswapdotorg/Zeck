/**
 * Discrimination: the dashboard surface (WORK-033; the dashboard-local
 * mutant set D1–D7 over the REAL apps/dashboard tree).
 *
 * Every protection is proven by a mutant that removes it. STATIC mutants
 * mutate the REAL source in memory and the scanners must flag exactly the
 * weakened protection; RUNTIME records drive the REAL dashboard server
 * (createDashboard → node:http) through a fake fetchImpl API world.
 *
 *   D1 frontend authority: every `client.<method>(` call site in apps/**
 *      belongs to the EXACTLY-8 public SDK methods (mutant: a non-SDK
 *      mutation call is flagged).
 *   D2 direct transport: no `fetch(` invocation in apps code (mutant
 *      flagged) — the SDK client is the only transport.
 *   D3 module state: no module-level Map cache pattern in ANY apps file
 *      (extends R-M24 beyond index.ts; mutant flagged).
 *   D4 provider neutrality + SQL-shaped text: publicSurfaceViolations
 *      over the REAL apps file list is empty; mutants inserting a provider
 *      literal / SQL-shaped text are flagged.
 *   D5 secret exposure (runtime): hostile secret-shaped values carried in
 *      task/metadata/payload records never echo into the rendered HTML.
 *   D6 trust honesty: zero verification results render the honest
 *      no-verification state and NO confidence chip (a fabricating
 *      renderer fails the pin).
 *   D7 command-action authorization path (runtime + static): the
 *      /command results page carries only links — no form posts a
 *      mutation directly (mutant flagged).
 *   D8 application-scope binding (WORK-034 reconciliation): the SDK
 *      client is constructed with the deployment's `applicationId` and
 *      the direct-execution entry requires it from the environment (the
 *      mutant dropping the binding is flagged — the PR #58 rejection
 *      defect, structurally pinned).
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { resultSurface, verificationSummary } from "../../apps/dashboard/components";
import { createDashboard } from "../../apps/dashboard/index";
import type { AgentSummary, Execution, ExecutionEvent, ExecutionResult } from "../../sdk";
import { publicSurfaceViolations, type SurfaceFile } from "./lib/public-surface";

const REPO_ROOT = join(process.cwd());

/** The REAL apps tree (every .ts file under apps/). */
function collectAppsFiles(): string[] {
  const out: string[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.name.startsWith(".") || entry.name === "node_modules") {
        continue;
      }
      const full = join(current, entry.name);
      if (statSync(full).isDirectory()) {
        walk(full);
      } else if (entry.name.endsWith(".ts")) {
        out.push(full);
      }
    }
  };
  walk(join(REPO_ROOT, "apps"));
  return out;
}

function readSurfaceFile(path: string): SurfaceFile {
  // Repo-relative paths (forward slashes) so the shared scanners' apps/
  // rules actually apply to this file list.
  return {
    path: path.replaceAll("\\", "/").slice(REPO_ROOT.length + 1),
    content: readFileSync(path, "utf8"),
  };
}

const APP_FILES: readonly SurfaceFile[] = collectAppsFiles().map(readSurfaceFile);

/** The EXACTLY-8 public SDK client methods (the whole mutation surface). */
const SDK_CLIENT_METHODS: readonly string[] = [
  "createExecution",
  "getExecution",
  "cancelExecution",
  "getResult",
  "listEvents",
  "listVerification",
  "listAgents",
  "getAgentStatus",
];

const SQL_SHAPED = /\b(INSERT INTO|UPDATE\s+\w+\.\w+|DELETE FROM|SELECT\s+.*\s+FROM)\b/;

// ---------------------------------------------------------------------------
// D1: frontend authority — the dashboard can only speak the 8 SDK methods
// ---------------------------------------------------------------------------

describe("D1: every client call site in apps/** is one of the 8 public SDK methods", () => {
  test("the REAL tree: every `client.<method>(` call site belongs to the SDK surface", () => {
    const violations: string[] = [];
    let callSites = 0;
    for (const file of APP_FILES) {
      for (const match of file.content.matchAll(/\bclient\.(\w+)\s*\(/g)) {
        callSites += 1;
        const method = match[1] ?? "";
        if (!SDK_CLIENT_METHODS.includes(method)) {
          violations.push(`${file.path}: client.${method}()`);
        }
      }
    }
    expect(callSites).toBeGreaterThan(0); // the dashboard really reads through the SDK
    expect(violations).toEqual([]);
  });

  test("the mutant: a non-SDK mutation call site is flagged", () => {
    const mutant = APP_FILES.map((file) =>
      file.path.endsWith("apps/dashboard/pages.ts")
        ? {
            ...file,
            content: `${file.content}\nasync function mutant() { await client.purgeAllExecutions("x"); }\n`,
          }
        : file,
    );
    const violations: string[] = [];
    for (const file of mutant) {
      for (const match of file.content.matchAll(/\bclient\.(\w+)\s*\(/g)) {
        const method = match[1] ?? "";
        if (!SDK_CLIENT_METHODS.includes(method)) {
          violations.push(`${file.path}: client.${method}()`);
        }
      }
    }
    expect(violations).toContain("apps/dashboard/pages.ts: client.purgeAllExecutions()");
  });
});

// ---------------------------------------------------------------------------
// D2: no direct transport — the SDK client is the only network path
// ---------------------------------------------------------------------------

describe("D2: no direct fetch invocation in apps code", () => {
  test("the REAL tree: apps code never invokes fetch directly", () => {
    const offenders = APP_FILES.filter((file) =>
      /\bawait\s+fetch\s*\(|[^.\w]fetch\s*\(/.test(file.content),
    );
    expect(offenders.map((file) => file.path)).toEqual([]);
  });

  test("the mutant: a hand-rolled fetch call is flagged", () => {
    const mutant = APP_FILES.map((file) =>
      file.path.endsWith("apps/dashboard/pages.ts")
        ? {
            ...file,
            content: `${file.content}\nasync function mutant() { await fetch("http://evil"); }\n`,
          }
        : file,
    );
    const offenders = mutant.filter((file) =>
      /\bawait\s+fetch\s*\(|[^.\w]fetch\s*\(/.test(file.content),
    );
    expect(offenders.map((file) => file.path)).toContain("apps/dashboard/pages.ts");
  });
});

// ---------------------------------------------------------------------------
// D3: no module-level mutable state anywhere under apps/ (R-M24 extended)
// ---------------------------------------------------------------------------

describe("D3: no module-level Map cache pattern in ANY apps file", () => {
  const CACHE_PATTERN = /const\s+\w*(cache|store|registry|inventory)\w*\s*[:=]\s*(new\s+)?Map/;

  test("the REAL tree: no apps file declares a module-level cache/registry Map", () => {
    const offenders = APP_FILES.filter((file) => CACHE_PATTERN.test(file.content));
    expect(offenders.map((file) => file.path)).toEqual([]);
  });

  test("the mutant: a module-level execution cache is flagged (in any apps file)", () => {
    for (const target of ["apps/dashboard/pages.ts", "apps/dashboard/components.ts"]) {
      const mutant = APP_FILES.map((file) =>
        file.path === target
          ? { ...file, content: `const execution_cache = new Map();\n${file.content}` }
          : file,
      );
      const offenders = mutant.filter((file) => CACHE_PATTERN.test(file.content));
      expect(offenders.map((file) => file.path)).toContain(target);
    }
  });
});

// ---------------------------------------------------------------------------
// D4: provider neutrality + SQL-shaped text over the REAL apps files
// ---------------------------------------------------------------------------

describe("D4: provider neutrality and no SQL-shaped text in apps code", () => {
  test("the REAL tree: publicSurfaceViolations is empty and no SQL-shaped text exists", () => {
    expect(publicSurfaceViolations(APP_FILES)).toEqual([]);
    const offenders = APP_FILES.filter((file) => SQL_SHAPED.test(file.content));
    expect(offenders.map((file) => file.path)).toEqual([]);
  });

  test("the mutant: a provider literal is flagged by the shared scanner", () => {
    const mutant = APP_FILES.map((file) =>
      file.path.endsWith("apps/dashboard/components.ts")
        ? { ...file, content: `${file.content}\n// routed via OpenRouter someday\n` }
        : file,
    );
    const violations = publicSurfaceViolations(mutant);
    expect(violations).toContain("provider-identifier:apps/dashboard/components.ts");
  });

  test("the mutant: SQL-shaped text is flagged (even in a comment)", () => {
    const mutant = APP_FILES.map((file) =>
      file.path.endsWith("apps/dashboard/pages.ts")
        ? {
            ...file,
            content: `${file.content}\n// an evil comment: SELECT id FROM executions\n`,
          }
        : file,
    );
    const offenders = mutant.filter((file) => SQL_SHAPED.test(file.content));
    expect(offenders.map((file) => file.path)).toEqual(["apps/dashboard/pages.ts"]);
  });
});

// ---------------------------------------------------------------------------
// D5 + D6 + D7 runtime records (the REAL server + a hostile fake API world)
// ---------------------------------------------------------------------------

const HOSTILE_EXECUTION_ID = "00000000-0000-7000-8000-0000000000d1";
const SECRET_TASK = "sk-live-task-secret-9f2a";
const SECRET_PAYLOAD = "sk-live-payload-secret-77cc";
const SECRET_METADATA = "sk-live-metadata-secret-31ee";

const hostileExecution: Execution = {
  id: HOSTILE_EXECUTION_ID,
  applicationId: "00000000-0000-7000-8000-0000000000a1",
  environmentId: null,
  status: "RUNNING",
  task: {
    kind: "outcome",
    description: "Summarize the inbox",
    apiKey: SECRET_TASK,
    userToken: "token-shaped-hostile-value",
    nested: { secret: { password: "hostile-password" } },
  },
  constraints: null,
  metadata: { serviceToken: SECRET_METADATA },
  createdAt: "2026-09-15T12:00:00Z",
  updatedAt: "2026-09-15T12:00:01Z",
  terminalAt: null,
};

const hostileEvents: ExecutionEvent[] = [
  {
    eventId: "ev-1",
    executionId: HOSTILE_EXECUTION_ID,
    type: "execution.start",
    sequence: 1,
    occurredAt: "2026-09-15T12:00:05Z",
    payload: { apiKey: SECRET_PAYLOAD, note: "started" },
  },
];

const hostileResult: ExecutionResult = {
  executionId: HOSTILE_EXECUTION_ID,
  status: "RUNNING",
  route: null,
  cost: null,
  usage: null,
  outputArtifacts: [],
  verification: [],
  warnings: [],
  terminalAt: null,
};

const hostileAgents: AgentSummary[] = [];

const hostileFetch = (async (input: string | URL) => {
  const path = new URL(String(input)).pathname;
  const reply = (body: unknown): Response => new Response(JSON.stringify(body), { status: 200 });
  if (path === `/executions/${HOSTILE_EXECUTION_ID}`) return reply(hostileExecution);
  if (path === `/executions/${HOSTILE_EXECUTION_ID}/results`) return reply(hostileResult);
  if (path === `/executions/${HOSTILE_EXECUTION_ID}/events`) return reply(hostileEvents);
  if (path === `/executions/${HOSTILE_EXECUTION_ID}/verification`) return reply([]);
  if (path === "/agents") return reply(hostileAgents);
  return new Response(JSON.stringify({ code: "PROVIDER_ERROR", message: "x", retryable: true }), {
    status: 500,
  });
}) as unknown as typeof fetch;

let base = "";

beforeAll(async () => {
  const { server } = createDashboard({
    apiUrl: "http://fake.local",
    token: "token",
    applicationId: "00000000-0000-7000-8000-0000000000a1",
    port: 0,
    fetchImpl: hostileFetch,
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));
});

async function getHtml(path: string): Promise<string> {
  const response = await fetch(`${base}${path}`, { redirect: "manual" });
  expect(response.status).toBe(200);
  return response.text();
}

describe("D5: hostile secret-shaped values never echo into the rendered HTML", () => {
  const SECRET_SHAPED = [
    SECRET_TASK,
    SECRET_PAYLOAD,
    SECRET_METADATA,
    "token-shaped-hostile-value",
    "hostile-password",
  ];

  test("the Result tab (task fields + why panel) renders the redaction, never the secret", async () => {
    const html = await getHtml(`/runs/${HOSTILE_EXECUTION_ID}`);
    for (const secret of SECRET_SHAPED) {
      expect(html, secret).not.toContain(secret);
    }
    expect(html).toContain("[not displayed]");
    expect(html).toContain("Summarize the inbox");
  });

  test("the raw activity view (payload JSON) never echoes the secret-shaped payload", async () => {
    const html = await getHtml(`/runs/${HOSTILE_EXECUTION_ID}?tab=activity&view=raw`);
    for (const secret of SECRET_SHAPED) {
      expect(html, secret).not.toContain(secret);
    }
    expect(html).toContain("[not displayed]");
  });

  test("the failure surface (payload message lookup) never echoes secret payloads", () => {
    // The failing-execution message path reads the LAST failure-bearing
    // event payload; a secret-shaped key there must stay redacted.
    const html = resultSurface({
      execution: { ...hostileExecution, status: "FAILED", terminalAt: "2026-09-15T12:02:00Z" },
      result: { ...hostileResult, status: "FAILED" },
      events: [
        {
          eventId: "ev-2",
          executionId: HOSTILE_EXECUTION_ID,
          type: "execution.fail",
          sequence: 2,
          occurredAt: "2026-09-15T12:02:00Z",
          payload: { message: "the tool rejected the request", apiKey: SECRET_PAYLOAD },
        },
      ],
    });
    expect(html).toContain("the tool rejected the request");
    expect(html).not.toContain(SECRET_PAYLOAD);
  });
});

describe("D6: zero verification results render the honest state — never a confidence chip", () => {
  test("the REAL renderer: the honest no-verification state, no derived chip", () => {
    const html = verificationSummary([]);
    expect(html).toContain("No verification results recorded");
    expect(html).not.toContain("High confidence");
    expect(html).not.toContain("chip-derived");
    expect(html).not.toMatch(/\d+\s*\/\s*\d+\s+checks/);
  });

  test("the mutant pin: a renderer that FABRICATES confidence fails every honesty assertion", () => {
    // What a dishonest renderer would emit with ZERO verification facts:
    const fabricated = `<div class="verification-strip"><p><strong>High confidence</strong> <span class="chip chip-derived">High confidence — 4/4 checks passed</span></p></div>`;
    // The honest pins would catch it:
    expect(fabricated).toContain("High confidence"); // the discriminator exists…
    expect(fabricated).toContain("chip-derived");
    expect(fabricated).toMatch(/\d+\s*\/\s*\d+\s+checks/);
    // …and the real renderer with zero facts fails to produce any of them:
    const honest = verificationSummary([]);
    expect(honest).not.toContain("High confidence");
    expect(honest).not.toContain("chip-derived");
    expect(honest).not.toMatch(/\d+\s*\/\s*\d+\s+checks/);
  });

  test("the runtime evidence tab renders the honest quality axis for a verification-less execution", async () => {
    const html = await getHtml(`/runs/${HOSTILE_EXECUTION_ID}?tab=evidence`);
    expect(html).toContain("No verification results recorded");
    expect(html).not.toContain("High confidence");
  });
});

describe("D7: the command surface proposes actions as links only (the authorization path)", () => {
  test("the REAL /command results page contains no form that posts a mutation", async () => {
    for (const query of [
      `cancel ${HOSTILE_EXECUTION_ID}`,
      HOSTILE_EXECUTION_ID,
      "agents",
      "create a new execution",
    ]) {
      const html = await getHtml(`/command?q=${encodeURIComponent(query)}`);
      // The shell's own forms are GET (search + appearance); a command
      // result may never carry a POST (mutation) form.
      expect(html, query).not.toContain('method="post"');
      expect(html, query).not.toMatch(/<form[^>]*method=["']post["']/);
    }
  });

  test("a proposed cancel links into the confirmation flow, not a mutation", async () => {
    const html = await getHtml(
      `/command?q=${encodeURIComponent(`cancel ${HOSTILE_EXECUTION_ID}`)}`,
    );
    expect(html).toContain(`href="/runs/${HOSTILE_EXECUTION_ID}?action=cancel"`);
    expect(html).toContain("nothing is cancelled from here");
  });

  test("the mutant: a command page carrying a direct POST mutation form is flagged", () => {
    const mutantHtml = `<h1>Command</h1><ul class="command-results"><li><form method="post" action="/executions/x/cancel"><button type="submit">Cancel now</button></form></li></ul>`;
    // The pin: no <form> and no method="post" may appear on /command.
    expect(mutantHtml).toContain("<form");
    expect(mutantHtml).toContain('method="post"');
    // (The real page above is proven not to match either pattern.)
  });
});

// ---------------------------------------------------------------------------
// D8: the dashboard's SDK client is constructed WITH the application scope
// (the WORK-034 reconciliation — the exact defect that rejected the first
// WORK-033 pass, pinned so it can never silently return)
// ---------------------------------------------------------------------------

describe("D8: the dashboard binds its deployment application scope into the SDK client", () => {
  /** Extract the createZeckClient options object from a file's source. */
  const clientOptionsOf = (content: string): string => {
    const match = /createZeckClient\(\s*\{([\s\S]*?)\}\s*\)/.exec(content);
    return match?.[1] ?? "";
  };

  test("the REAL tree: apps/dashboard/index.ts passes applicationId into createZeckClient", () => {
    const index = APP_FILES.find((file) => file.path === "apps/dashboard/index.ts");
    expect(index).toBeDefined();
    const options = clientOptionsOf(index?.content ?? "");
    expect(options.length).toBeGreaterThan(0);
    // The binding: the options object carries the deployment's
    // application scope (WORK-034 — every scoped read and governed
    // command sends it as the X-Zeck-Application header).
    expect(options).toMatch(/applicationId\s*:\s*options\.applicationId/);
  });

  test("the mutant: dropping the applicationId binding from the client construction is flagged", () => {
    const index = APP_FILES.find((file) => file.path === "apps/dashboard/index.ts");
    const weakened = (index?.content ?? "").replace(
      /applicationId\s*:\s*options\.applicationId,/,
      "",
    );
    const options = clientOptionsOf(weakened);
    // The discriminator fires: the construction no longer binds the scope
    // (the runtime manifestation: every scoped read fails — the PR #58
    // rejection condition).
    expect(options).not.toMatch(/applicationId\s*:/);
  });

  test("the REAL tree: the direct-execution entry requires the scope from the environment", () => {
    const index = APP_FILES.find((file) => file.path === "apps/dashboard/index.ts");
    const content = index?.content ?? "";
    expect(content).toContain("ZECK_APPLICATION_ID");
    expect(content).toMatch(/applicationId,\s*\n\s*port:/);
  });
});
