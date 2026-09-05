/**
 * Architecture: the public product surface boundary (WORK-015;
 * checkpoint contracts SELF-HOSTING-BOUNDARY, DEPENDENCY-DIRECTION,
 * AUTH-PRESERVATION, TENANT-ISOLATION).
 *
 * Mechanically proves over the REAL trees:
 *  - `src/api/` imports ONLY module public barrels + src/shared +
 *    fastify (the api-boundary rule — the shared dependency-direction
 *    engine already covers src/; this gate pins it explicitly for the
 *    new surface and extends the SAME rules to the sdk/cli/apps
 *    surfaces);
 *  - the public surface (sdk/cli/apps) imports NO provider SDK and
 *    names no provider identifier (M17/M18) — provider-neutral surface;
 *  - the public surface imports no module internals (M13-adjacent: no
 *    cross-module internal imports from the product surfaces);
 *  - secrets cannot cross the public serialization boundary: the
 *    serializer uses allowlist construction (no domain-record spread
 *    into responses — a `...record` spread in a wire serializer is
 *    detected) and the scrub guard exists (M4–M8);
 *  - the API owns no SQL: no pg/driver import anywhere in src/api,
 *    sdk, cli, apps (M13: the API never writes tables directly — it
 *    delegates to authorities);
 *  - the API exposes no internal authority mutation endpoint: the
 *    registered route table carries ONLY the public routes (M21).
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { createApiServer } from "../../src/api";
import {
  fakeAgentRegistry,
  fakeAuthenticate,
  fakeCodebaseAnalyzer,
  fakeEconomicsService,
  fakeExecutionsService,
  fakeScopeResolver,
} from "./lib/public-surface-fakes";

const REPO_ROOT = join(process.cwd());

function collectFiles(dir: string): string[] {
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
  walk(join(REPO_ROOT, dir));
  return out;
}

const API_FILES = collectFiles("src/api");
const SDK_FILES = collectFiles("sdk");
const CLI_FILES = collectFiles("cli");
const APP_FILES = collectFiles("apps");

const PROVIDER_IDENTIFIER =
  /\b(OpenRouter|Anthropic|OpenAI|Gemini|Groq|Mistral|Cohere|Azure|openRouter|anthropic|openAI|gemini|groq|mistral|cohere)\w*/;

describe("architecture: the public API transport boundary (WORK-015)", () => {
  test("src/api imports only module public barrels, src/shared and fastify", () => {
    const violations: string[] = [];
    for (const file of API_FILES) {
      const text = readFileSync(file, "utf8");
      for (const match of text.matchAll(/from\s+["'](\.[^"']+)["']/g)) {
        const specifier = match[1] ?? "";
        const resolved = join(file, specifier)
          .slice(REPO_ROOT.length + 1)
          .replaceAll("\\", "/");
        const segments = resolved.split("/");
        const isModuleBarrel =
          segments.length === 4 &&
          segments[0] === "src" &&
          segments[1] === "modules" &&
          segments[3] === "public.ts";
        const isShared = resolved.startsWith("src/shared/");
        const isApi = resolved.startsWith("src/api/");
        if (!isModuleBarrel && !isShared && !isApi) {
          violations.push(`${file}: ${specifier} -> ${resolved}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  test("src/api contains no SQL/driver import (M13 — authority delegation only)", () => {
    for (const file of [...API_FILES, ...SDK_FILES, ...CLI_FILES, ...APP_FILES]) {
      const text = readFileSync(file, "utf8");
      expect(text, file).not.toMatch(/\bfrom\s+["'](pg|postgres|@neondatabase|@aws-sdk|minio)["']/);
      expect(text, file).not.toMatch(
        /\b(INSERT INTO|UPDATE\s+\w+\.\w+|DELETE FROM|SELECT\s+.*\s+FROM)\b/,
      );
    }
  });

  test("the public surface (sdk/cli/apps) imports no module internals and no src platform", () => {
    const violations: string[] = [];
    for (const file of [...SDK_FILES, ...CLI_FILES, ...APP_FILES]) {
      const text = readFileSync(file, "utf8");
      for (const match of text.matchAll(/from\s+["'](\.[^"']+)["']/g)) {
        const specifier = match[1] ?? "";
        const resolved = join(file, specifier)
          .slice(REPO_ROOT.length + 1)
          .replaceAll("\\", "/");
        if (resolved.includes("/internal/") || resolved.startsWith("src/platform/")) {
          violations.push(`${file}: ${specifier} -> ${resolved}`);
        }
        // sdk/cli/apps may reference src/shared and src/modules public
        // barrels ONLY (the wire contract re-export).
        if (resolved.startsWith("src/modules/") && !resolved.endsWith("/public.ts")) {
          violations.push(`${file}: ${specifier} -> ${resolved}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  test("M17/M18: the public product surface is provider-neutral", () => {
    const violations: string[] = [];
    for (const file of [...SDK_FILES, ...CLI_FILES, ...APP_FILES, ...API_FILES]) {
      const text = readFileSync(file, "utf8");
      const match = PROVIDER_IDENTIFIER.exec(text);
      if (match !== null) {
        violations.push(`${file}: ${match[0]}`);
      }
    }
    expect(violations).toEqual([]);
  });

  test("M4–M8: the serializer uses allowlist construction (no domain spread)", () => {
    const serialization = readFileSync(join(REPO_ROOT, "src/api/serialization.ts"), "utf8");
    // No wire serializer may spread a domain record into the response
    // shape (an accidentally-added domain field would leak).
    for (const fn of [
      "toWireExecution",
      "toWireReceipt",
      "toWireEvent",
      "toWireVerification",
      "toWireAgentSummary",
      "toWireAgentVersion",
      "toWirePromotion",
      "toWireAgentStatus",
      "toWireEconomicAction",
      "toWireEconomicActionReceipt",
      "toWireEconomicActionEvent",
      "toWireEconomicActionOutcome",
      "toWireCodebaseAnalysis",
      "toWireCodebaseAnalysisReport",
      "toWireCodebaseFinding",
      "toWireCodebasePrompt",
      "toWireCodebaseRatingReceipt",
      "toWireCodebaseFindingTransitionReceipt",
    ]) {
      const fnSource = new RegExp(`function ${fn}\\(`).exec(serialization);
      expect(fnSource, `${fn} must exist`).not.toBeNull();
      const bodyStart = fnSource?.index ?? 0;
      const body = serialization.slice(bodyStart, bodyStart + 2000);
      expect(body, `${fn} must not spread domain records into the response shape`).not.toMatch(
        /return\s*\{\s*\.\.\.(record|receipt|envelope|agent|version|selection)\b/,
      );
    }
    // The scrub guard exists.
    expect(serialization).toContain("scrubSecretShapedKeys");
    expect(serialization).toContain("REDACT_KEY_PATTERN");
  });

  test("M21: the registered route table carries ONLY public routes", async () => {
    const server = createApiServer({
      executions: fakeExecutionsService(),
      agents: fakeAgentRegistry(),
      economics: fakeEconomicsService(),
      scopeResolver: fakeScopeResolver(),
      authenticate: fakeAuthenticate(),
      listAgentIdsOfApplication: async () => [],
      codebaseAnalyzer: fakeCodebaseAnalyzer(),
      dependencyReadiness: async () => [],
    });
    const routes = server.routes.map((route) => `${route.method} ${route.url}`);
    expect(routes.sort()).toEqual(
      [
        "GET /agents",
        "GET /agents/:id",
        "GET /agents/:id/status",
        "GET /agents/:id/versions",
        "GET /codebase-analysis/:id",
        "GET /economic-actions/:id",
        "GET /economic-actions/:id/events",
        "GET /economic-actions/:id/outcome",
        "GET /executions/:id",
        "GET /executions/:id/events",
        "GET /executions/:id/results",
        "GET /executions/:id/verification",
        "GET /health",
        "POST /codebase-analysis",
        "POST /codebase-analysis/:id/findings/:findingId/transition",
        "POST /codebase-analysis/:id/ratings",
        "POST /economic-actions",
        "POST /executions",
        "POST /executions/:id/cancel",
      ].sort(),
    );
    // The forbidden internal-authority surface is absent.
    for (const forbidden of [
      "POST /agents",
      "POST /agents/:id/promote",
      "POST /agents/:id/rollback",
      "POST /agents/:id/versions",
      "POST /policies",
      "POST /budgets",
      "POST /capabilities",
      "POST /executions/:id/pass",
      "POST /executions/:id/authorize",
      "POST /executions/:id/plan",
      "POST /executions/:id/queue",
      "POST /executions/:id/start",
      "POST /codebase-analysis/:id/findings/:findingId/promote",
      "POST /codebase-analysis/:id/mutate",
      "POST /codebase-analysis/:id/deploy",
    ]) {
      expect(routes).not.toContain(forbidden);
    }
    await server.app.close();
  });
});
