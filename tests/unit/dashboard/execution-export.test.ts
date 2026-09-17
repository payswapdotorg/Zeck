/**
 * Execution reproducibility-bundle export tests (DEP-032 ACs).
 *
 * Boots the REAL dashboard server with a wire-exact fake API and drives
 * the export surface end to end, plus pure-function proofs over the
 * composition:
 *  - AC1 MACHINE PARITY BY CONSTRUCTION: the bundle's `facts` member IS
 *    the facts.json composition (HTTP-verified verbatim equality against
 *    the served machine view, and composition-level equality against
 *    explorerFactsOf);
 *  - AC2 REFERENCES + DIGESTS ONLY: the bundle's artifact rows are the
 *    result record's own references (id/digest/createdAt + the
 *    object-store route), never content — no content-bearing key can
 *    appear, and a digest-less reference names its boundary;
 *  - AC3 A REAL, CONSOLE-FREE RECIPE: the example path, the quickstart
 *    fallback and every documented doc path resolve to actual repository
 *    files; the documented API calls are the public routes; the
 *    recreated create request is the recorded task/constraints/metadata
 *    verbatim;
 *  - AC4 THE SELF-HOST HANDOFF PROJECTS deploy/ BY LINK: the
 *    console-served guide resolves, every deploy seam it references
 *    exists, and it embeds no manifest copy that could drift;
 *  - REVISION FACTS: every machine manifest's declared revision facts
 *    cross verbatim and the sha256 pins the exact bytes on disk;
 *  - HONEST BOUNDARIES: every fact the public records do not carry
 *    (environment configuration, request identity, deployment git
 *    revision, per-step cost, missing cost/usage/artifacts) renders as
 *    an explicit boundary field — never approximated;
 *  - HOSTILE PROBES: markup-carrying ids, metadata, families and
 *    artifact fields never render unescaped on any new interpolation
 *    path, and the machine bundle stays parseable JSON.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { type ExplorerFacts, explorerFactsOf } from "../../../apps/dashboard/explorer";
import { reproducibilityBundleOf } from "../../../apps/dashboard/export";
import { createDashboard } from "../../../apps/dashboard/index";
import type { Execution, ExecutionEvent, ExecutionResult, VerificationResult } from "../../../sdk";

const REPOSITORY_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

const APP_ID = "00000000-0000-7000-8000-0000000000c4";
const RUN_ID = "00000000-0000-7000-8000-0000000000e7";
const BARE_ID = "00000000-0000-7000-8000-0000000000e9";

const execution: Execution = {
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

const result: ExecutionResult = {
  executionId: RUN_ID,
  status: "COMPLETED",
  route: {
    provider: "openrouter",
    model: "qwen/qwen3-14b",
    strategyClass: "hybrid",
    modelCalls: 1,
  },
  cost: { totalMicroUsd: "41250", currency: "usd" },
  usage: { inputTokens: 2100, outputTokens: 340 },
  outputArtifacts: [
    { id: "art-0001", digest: "sha256:abcdef0123456789", createdAt: "2026-09-16T09:00:02Z" },
    { id: "art-0002", digest: null, createdAt: "2026-09-16T09:00:02Z" },
  ],
  verification: [
    {
      id: "ver-0001",
      executionId: RUN_ID,
      criterionId: "quickstart-criterion",
      strategy: "deterministic-oracle",
      status: "PASS",
      confidence: null,
      evaluator: { kind: "builtin", id: "quickstart-check", version: "1" },
      evidenceRefs: ["art-0001"],
      recordedAt: "2026-09-16T09:00:02Z",
    },
  ],
  warnings: [],
  terminalAt: "2026-09-16T09:00:02Z",
};

const events: ExecutionEvent[] = [
  {
    eventId: "evt-0001",
    executionId: RUN_ID,
    type: "execution.created",
    sequence: 1,
    occurredAt: "2026-09-16T09:00:00Z",
    payload: { status: "CREATED" },
  },
  {
    eventId: "evt-0002",
    executionId: RUN_ID,
    type: "execution.completed",
    sequence: 2,
    occurredAt: "2026-09-16T09:00:02Z",
    payload: { status: "COMPLETED" },
  },
];

const verification: readonly VerificationResult[] = result.verification;

/** A run with NO cost, NO usage and hostile metadata (boundary + probes). */
const bareExecution: Execution = {
  ...execution,
  id: BARE_ID,
  status: "FAILED",
  terminalAt: "2026-09-16T09:00:03Z",
  metadata: {
    origin: "<script>origin()</script>",
    family: "<script>family()</script>",
    note: "<img src=x onerror=alert(1)>",
  },
};
const bareResult: ExecutionResult = {
  ...result,
  executionId: BARE_ID,
  route: null,
  cost: null,
  usage: null,
  outputArtifacts: [
    { id: "<img src=x onerror=alert(1)>", digest: "sha256:<script>", createdAt: "t" },
  ],
  verification: [],
  warnings: [],
};

/** A run whose id itself carries markup (the hostile-id probe). */

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
  const url = new URL(String(input));
  const path = url.pathname;
  const method = init?.method ?? "GET";
  if (path === "/agents") {
    return json([]);
  }
  const match = /^\/executions\/([^/]+)$/.exec(path);
  if (match !== null && method === "GET") {
    const id = decodeURIComponent(match[1] ?? "");
    if (id === RUN_ID) {
      return json(execution);
    }
    if (id === BARE_ID) {
      return json(bareExecution);
    }
    return json({ code: "PROVIDER_ERROR", message: "not found" }, 404);
  }
  const sub = /^\/executions\/([^/]+)\/(results|events|verification)$/.exec(path);
  if (sub !== null && method === "GET") {
    const id = decodeURIComponent(sub[1] ?? "");
    if (id !== RUN_ID && id !== BARE_ID) {
      return json({ code: "PROVIDER_ERROR", message: "not found" }, 404);
    }
    if (sub[2] === "results") {
      return id === RUN_ID ? json(result) : json(bareResult);
    }
    if (sub[2] === "events") {
      return json(events);
    }
    return json(verification);
  }
  return json({ code: "PROVIDER_ERROR", message: `unexpected ${path}` }, 500);
}) as unknown as typeof fetch;

let base = "";

beforeAll(async () => {
  const { server } = createDashboard({
    apiUrl: "http://fake.local",
    token: "token",
    applicationId: APP_ID,
    port: 0,
    fetchImpl,
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));
});

const RECENTS = `zeck_recent_executions=${RUN_ID}`;

async function get(path: string, cookie = RECENTS): Promise<Response> {
  return fetch(`${base}${path}`, {
    headers: cookie === "" ? {} : { cookie },
    redirect: "manual",
  });
}

const facts: ExplorerFacts = { execution, result, events, verification };

describe("the export action and the bundle view (DEP-032 AC1)", () => {
  test("the explorer carries the export action linking the bundle view", async () => {
    const res = await get(`/console/executions/${RUN_ID}`);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain(`href="/console/executions/${RUN_ID}/export"`);
    expect(body).toContain("Export reproducibility bundle");
  });

  test("the bundle view renders the composition sections", async () => {
    const res = await get(`/console/executions/${RUN_ID}/export`);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("Output artifacts (references and digests only)");
    expect(body).toContain("Repository revision facts (the machine manifests)");
    expect(body).toContain("Reproduction recipe");
    expect(body).toContain("Self-host / deployment handoff");
    expect(body).toContain("Honest boundaries");
    expect(body).toContain("The bundle (copyable JSON)");
    expect(body).toContain(`href="/console/executions/${RUN_ID}/export/bundle.json"`);
  });

  test("bundle.json serves the composition as parseable JSON", async () => {
    const res = await get(`/console/executions/${RUN_ID}/export/bundle.json`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.schemaVersion).toBe(1);
    expect((body.export as { executionId: string }).executionId).toBe(RUN_ID);
  });
});

describe("machine parity by construction (DEP-032 AC1)", () => {
  test("the bundle's facts ARE the facts.json composition (HTTP verbatim)", async () => {
    const [bundleRes, factsRes] = await Promise.all([
      get(`/console/executions/${RUN_ID}/export/bundle.json`),
      get(`/console/executions/${RUN_ID}/facts.json`),
    ]);
    const bundle = (await bundleRes.json()) as { facts: unknown };
    const machineView = await factsRes.json();
    expect(bundle.facts).toEqual(machineView);
  });

  test("the composition-level proof: bundle.facts equals explorerFactsOf", () => {
    const bundle = reproducibilityBundleOf(facts);
    expect(bundle.facts).toEqual(explorerFactsOf(facts));
    expect((bundle.facts as { execution: Execution }).execution).toEqual(execution);
    expect((bundle.facts as { result: ExecutionResult }).result).toEqual(result);
  });

  test("the bundle view and the machine route cannot drift (one composition)", () => {
    const bundle = reproducibilityBundleOf(facts);
    // The view's copyable JSON block is the same object the route serves
    // (both serialize the ONE composition with the same shape).
    const rendered = JSON.stringify(bundle, null, 2);
    expect(rendered).toContain('"schemaVersion": 1');
    expect(rendered).toContain(`"executionId": "${RUN_ID}"`);
    expect(JSON.parse(rendered)).toEqual(bundle);
  });
});

describe("artifact references and digests only — never content (DEP-032 AC2)", () => {
  test("the bundle carries the result record's artifact references verbatim", async () => {
    const res = await get(`/console/executions/${RUN_ID}/export/bundle.json`);
    const bundle = (await res.json()) as {
      artifacts: { outputArtifacts: Record<string, unknown>[] };
    };
    expect(bundle.artifacts.outputArtifacts).toHaveLength(2);
    expect(bundle.artifacts.outputArtifacts[0]).toEqual({
      id: "art-0001",
      digest: "sha256:abcdef0123456789",
      createdAt: "2026-09-16T09:00:02Z",
      reference: `/assets/artifacts/art-0001?executionId=${RUN_ID}`,
    });
    for (const row of bundle.artifacts.outputArtifacts) {
      expect(Object.keys(row).sort()).toEqual(["createdAt", "digest", "id", "reference"]);
    }
  });

  test("no content-bearing key can appear in the artifacts section", () => {
    const bundle = reproducibilityBundleOf(facts) as {
      artifacts: { outputArtifacts: Record<string, unknown>[] };
    };
    const forbidden = ["content", "bytes", "data", "body", "value", "base64", "text"];
    for (const row of bundle.artifacts.outputArtifacts) {
      for (const key of Object.keys(row)) {
        expect(forbidden, key).not.toContain(key);
      }
    }
  });

  test("a digest-less reference names its boundary, never a fabricated digest", async () => {
    const res = await get(`/console/executions/${RUN_ID}/export/bundle.json`);
    const bundle = (await res.json()) as {
      artifacts: { outputArtifacts: { id: string; digest: string | null }[] };
      boundaries: { field: string; statement: string }[];
    };
    expect(bundle.artifacts.outputArtifacts[1]?.digest).toBeNull();
    expect(bundle.boundaries.map((b) => b.field)).toContain("artifactDigests");
  });

  test("the HTML view renders digests and the object-store reference, escaped", async () => {
    const res = await get(`/console/executions/${RUN_ID}/export`);
    const body = await res.text();
    expect(body).toContain("sha256:abcdef0123456789");
    expect(body).toContain(`href="/assets/artifacts/art-0001?executionId=${RUN_ID}"`);
    expect(body).toContain("(no digest recorded)");
    expect(body).toContain("never content");
  });
});

describe("a real, console-free reproduction recipe (DEP-032 AC3)", () => {
  test("the example reference resolves to an actual repository file", async () => {
    const res = await get(`/console/executions/${RUN_ID}/export/bundle.json`);
    const bundle = (await res.json()) as {
      reproduction: {
        example: { path: string; envVars: string[]; classification: string };
        quickstart: string;
        docs: string[];
      };
    };
    expect(bundle.reproduction.example.path).toBe("examples/text-summarization.ts");
    expect(existsSync(join(REPOSITORY_ROOT, bundle.reproduction.example.path))).toBe(true);
    expect(existsSync(join(REPOSITORY_ROOT, bundle.reproduction.quickstart))).toBe(true);
    for (const doc of bundle.reproduction.docs) {
      expect(existsSync(join(REPOSITORY_ROOT, doc)), doc).toBe(true);
    }
    expect(bundle.reproduction.example.envVars).toEqual([
      "ZECK_API_URL",
      "ZECK_TOKEN",
      "ZECK_APPLICATION_ID",
    ]);
  });

  test("the documented API calls are the public routes, and the request is the recorded facts", async () => {
    const res = await get(`/console/executions/${RUN_ID}/export/bundle.json`);
    const bundle = (await res.json()) as {
      reproduction: {
        documentedApiCalls: string[];
        recreatedCreateRequest: Record<string, unknown>;
        runCommand: string;
      };
    };
    const calls = bundle.reproduction.documentedApiCalls.join(" | ");
    expect(calls).toContain("POST /executions");
    expect(calls).toContain("GET /executions/:id");
    expect(calls).toContain("GET /executions/:id/results");
    expect(calls).toContain("GET /executions/:id/events");
    expect(calls).toContain("GET /executions/:id/verification");
    // The recreated request is EXACTLY the recorded public facts.
    expect(bundle.reproduction.recreatedCreateRequest).toEqual({
      applicationId: APP_ID,
      task: execution.task,
      constraints: execution.constraints,
      metadata: execution.metadata,
    });
    expect(bundle.reproduction.runCommand).toContain("bun run examples/text-summarization.ts");
  });

  test("an unrecorded family falls back to the quickstart with the miss named", async () => {
    const res = await get(`/console/executions/${BARE_ID}/export/bundle.json`);
    const bundle = (await res.json()) as {
      reproduction: { example: { path: string } };
      boundaries: { field: string }[];
    };
    expect(bundle.reproduction.example.path).toBe("examples/quickstart.ts");
    expect(bundle.boundaries.map((b) => b.field)).toContain("workloadFamilyExample");
  });
});

describe("the self-host handoff projects deploy/ by link (DEP-032 AC4)", () => {
  test("the console-served guide route resolves", async () => {
    const res = await get("/console/docs/SELF-HOSTING.md");
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("Self-Hosting");
    expect(body).toContain("deploy/README.md");
  });

  test("the docs index carries the guide (the directory is the index)", async () => {
    const res = await get("/console/docs");
    const body = await res.text();
    expect(body).toContain("SELF-HOSTING.md");
  });

  test("the bundle carries the guide pointer with a real repository path", async () => {
    const res = await get(`/console/executions/${RUN_ID}/export/bundle.json`);
    const bundle = (await res.json()) as {
      reproduction: { selfHostingGuide: { consolePath: string; repositoryPath: string } };
    };
    const guide = bundle.reproduction.selfHostingGuide;
    expect(guide.consolePath).toBe("/console/docs/SELF-HOSTING.md");
    expect(existsSync(join(REPOSITORY_ROOT, guide.repositoryPath))).toBe(true);
  });

  test("every deploy seam the guide references exists, and no manifest copy is embedded", () => {
    const guidePath = join(REPOSITORY_ROOT, "docs/developer/SELF-HOSTING.md");
    const guide = readFileSync(guidePath, "utf8");
    for (const seam of [
      "deploy/README.md",
      "deploy/PUBLIC-DEPLOYMENT.md",
      "deploy/manifests/environments.json",
      "deploy/manifests/providers.json",
      "deploy/manifests/provider-tiers.json",
      "deploy/manifests/resources.json",
      "deploy/manifests/secret-references.json",
      "deploy/manifests/variables.json",
      "deploy/manifests/quota-guards.json",
      "deploy/manifests/release-policy.json",
    ]) {
      expect(guide, seam).toContain(seam);
      expect(existsSync(join(REPOSITORY_ROOT, seam)), seam).toBe(true);
    }
    // Anti-drift: the guide PROJECTS by link — it embeds no JSON manifest
    // copy (a fenced json block would be a second, drifting authority).
    expect(guide).not.toContain("```json");
    // The honest non-duplication statements are part of the contract.
    expect(guide).toContain("never duplicates");
    expect(guide).toContain("wins");
  });
});

describe("repository revision facts (the machine manifests)", () => {
  test("every machine manifest crosses with its declared revision facts and an exact-byte digest", async () => {
    const res = await get(`/console/executions/${RUN_ID}/export/bundle.json`);
    const bundle = (await res.json()) as {
      repository: {
        manifests: {
          path: string;
          carriedRevisionFacts: Record<string, string>;
          sha256: string;
        }[];
      };
    };
    const expectedPaths = [
      "docs/developer/machine/capability-manifest.json",
      "docs/developer/machine/env-vars.json",
      "docs/developer/machine/error-codes.json",
      "docs/developer/machine/examples-manifest.json",
      "docs/developer/machine/integration-recipe.json",
      "docs/developer/machine/openapi.json",
    ];
    expect(bundle.repository.manifests.map((m) => m.path)).toEqual(expectedPaths);
    for (const manifest of bundle.repository.manifests) {
      const bytes = readFileSync(join(REPOSITORY_ROOT, manifest.path));
      expect(manifest.sha256).toBe(`sha256:${createHash("sha256").update(bytes).digest("hex")}`);
      const parsed = JSON.parse(bytes.toString("utf8")) as Record<string, unknown>;
      if (parsed.schemaVersion !== undefined) {
        expect(manifest.carriedRevisionFacts.schemaVersion).toBe(String(parsed.schemaVersion));
      } else {
        // openapi.json carries its revision facts as openapi/info.version.
        expect(manifest.carriedRevisionFacts.schemaVersion).toBeUndefined();
      }
    }
    const openapi = bundle.repository.manifests.find(
      (m) => m.path === "docs/developer/machine/openapi.json",
    );
    expect(openapi?.carriedRevisionFacts.openapi).toBe("3.1.0");
    expect(openapi?.carriedRevisionFacts.infoVersion).toBe("1.0.0");
  });

  test("the deployment git revision stays an explicit boundary, never approximated", async () => {
    const res = await get(`/console/executions/${RUN_ID}/export/bundle.json`);
    const bundle = (await res.json()) as {
      boundaries: { field: string; statement: string }[];
      repository: { boundary: string };
    };
    const boundary = bundle.boundaries.find((b) => b.field === "deploymentGitRevision");
    expect(boundary).toBeDefined();
    expect(boundary?.statement).toContain("GET /identity");
    expect(bundle.repository.boundary).toContain("GET /identity");
  });
});

describe("honest boundaries for every fact the records do not carry", () => {
  test("the universal doctrine boundaries are always present", async () => {
    const res = await get(`/console/executions/${RUN_ID}/export/bundle.json`);
    const bundle = (await res.json()) as { boundaries: { field: string }[] };
    const fields = bundle.boundaries.map((b) => b.field);
    for (const field of [
      "artifactContent",
      "environmentConfiguration",
      "requestIdentity",
      "deploymentGitRevision",
      "perStepCostBreakdown",
    ]) {
      expect(fields, field).toContain(field);
    }
  });

  test("missing cost and usage render as boundaries, not approximations", async () => {
    const res = await get(`/console/executions/${BARE_ID}/export/bundle.json`);
    const bundle = (await res.json()) as {
      facts: { result: { cost: unknown; usage: unknown } };
      boundaries: { field: string }[];
    };
    expect(bundle.facts.result.cost).toBeNull();
    expect(bundle.facts.result.usage).toBeNull();
    const fields = bundle.boundaries.map((b) => b.field);
    expect(fields).toContain("settledCost");
    expect(fields).toContain("usage");
  });

  test("an empty artifact list is a boundary, never an invented reference", () => {
    const bundle = reproducibilityBundleOf({
      execution,
      result: { ...result, outputArtifacts: [] },
      events,
      verification,
    }) as { artifacts: { outputArtifacts: unknown[] }; boundaries: { field: string }[] };
    expect(bundle.artifacts.outputArtifacts).toEqual([]);
    expect(bundle.boundaries.map((b) => b.field)).toContain("outputArtifacts");
  });
});

describe("hostile probes on every new interpolation path (DEP-032 AC5)", () => {
  test("an id carrying markup never renders unescaped (view + machine 404)", async () => {
    const hostile = encodeURIComponent("<img src=x onerror=alert(1)>");
    const view = await get(`/console/executions/${hostile}/export`);
    expect(view.status).toBe(404);
    const body = await view.text();
    expect(body).not.toContain("<img src=x");
    expect(body).toContain("&lt;img src=x");
    const machine = await get(`/console/executions/${hostile}/export/bundle.json`);
    expect(machine.status).toBe(404);
    const parsed = (await machine.json()) as { error: string };
    expect(parsed.error).toBe("NOT_FOUND");
  });

  test("hostile metadata, artifact ids and digests stay escaped in the view and parseable in JSON", async () => {
    const view = await get(`/console/executions/${BARE_ID}/export`);
    expect(view.status).toBe(200);
    const body = await view.text();
    expect(body).not.toContain("<img src=x onerror=alert(1)>");
    expect(body).not.toContain("<script>family()</script>");
    expect(body).toContain("&lt;img src=x onerror=alert(1)&gt;");
    const machine = await get(`/console/executions/${BARE_ID}/export/bundle.json`);
    expect(machine.status).toBe(200);
    const bundle = (await machine.json()) as {
      facts: { execution: { metadata: Record<string, unknown> } };
      artifacts: { outputArtifacts: { id: string; digest: string | null }[] };
    };
    // The machine bundle carries the hostile values verbatim (they are
    // recorded facts) — as JSON they cannot inject; the HTML view escapes.
    expect(bundle.facts.execution.metadata.note).toBe("<img src=x onerror=alert(1)>");
    expect(bundle.artifacts.outputArtifacts[0]?.id).toBe("<img src=x onerror=alert(1)>");
    expect(bundle.artifacts.outputArtifacts[0]?.digest).toBe("sha256:<script>");
  });

  test("the recreated create request round-trips hostile metadata as data, not markup", async () => {
    const res = await get(`/console/executions/${BARE_ID}/export/bundle.json`);
    const bundle = (await res.json()) as {
      reproduction: { recreatedCreateRequest: { metadata: Record<string, unknown> } };
    };
    expect(bundle.reproduction.recreatedCreateRequest.metadata.note).toBe(
      "<img src=x onerror=alert(1)>",
    );
  });
});
