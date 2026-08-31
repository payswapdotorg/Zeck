/**
 * Architecture: the integration + benchmark boundary (WORK-016;
 * checkpoint contracts SELF-HOSTING-BOUNDARY, BYOA authority boundary,
 * WorkflowOS no-mutation boundary, framework-neutral public contract
 * boundary).
 *
 * Mechanically proves over the REAL trees:
 *  - `src/integrations/` imports ONLY the executions + agents module
 *    public barrels and src/shared (§6/§13: the integration delegates
 *    to the existing authorities — it holds NO policy/budget/
 *    verification/learning logic and no platform internals);
 *  - the integration holds NO WorkflowOS-state mutation channel (no
 *    outbound network, no SQL, no WorkflowOS SDK import — the adapter
 *    submits to Zeck and returns data only; WOS-002/M1/M2);
 *  - no external-framework identifier appears in the integration or
 *    benchmark trees (M10/M20: framework types remain adapter-local —
 *    and none exist yet at all);
 *  - the benchmark MEASUREMENT surfaces (harness/report/contract) hold
 *    no authority mutation calls (§21: benchmark = measurement, never
 *    authority);
 *  - the benchmark STRATEGY surface rides only the governed paths
 *    (executions/agents/integration public barrels — no policy/budget/
 *    registry mutation, no SQL);
 *  - benchmarks import only public barrels (no internals/platform).
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

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

const INTEGRATION_FILES = collectFiles("src/integrations");
const BENCHMARK_FILES = collectFiles("benchmarks");

/** External agent framework identifiers (M10/M20 — never in contracts). */
const FRAMEWORK_IDENTIFIER =
  /\b(LangGraph|CrewAI|AutoGen|OpenAIAgentsSDK|AnthropicAgentSDK|langgraph|crewai|autogen|openai-agents)\w*/;

/** The authority-mutation calls a MEASUREMENT surface must never make. */
const MEASUREMENT_MUTATION_CALL =
  /\.(createExecution|transition|registerAgent|publishVersion|promote|rollback|suspend|resume|retire|reserve|settle|release|publish|submitWork|createSession|runSession|recordStepEvent|recordAction)\s*\(/;

/** Outbound network/SQL surfaces (no WorkflowOS mutation channel). */
const NETWORK_OR_SQL =
  /\bfrom\s+["'](node:http|node:https|node:net|node:tls|undici|axios|got|node-fetch|pg|postgres)["']|\bfetch\s*\(|\b(INSERT INTO|UPDATE\s+[a-z]+\.[a-z_]+|DELETE FROM)\b/;

function resolveSpecifier(fromFile: string, specifier: string): string {
  const from = fromFile.split("/").slice(0, -1);
  for (const segment of specifier.split("/")) {
    if (segment === "..") {
      from.pop();
    } else if (segment === "." || segment === "") {
      // stay
    } else if (segment.endsWith(".ts")) {
      from.push(segment.slice(0, -3));
    } else {
      from.push(segment);
    }
  }
  return from.join("/");
}

describe("architecture: the WORK-016 integration boundary", () => {
  test("src/integrations imports ONLY the executions/agents public barrels + src/shared", () => {
    const violations: string[] = [];
    for (const file of INTEGRATION_FILES) {
      const text = readFileSync(file, "utf8");
      for (const match of text.matchAll(/from\s+["'](\.[^"']+)["']/g)) {
        const specifier = match[1] ?? "";
        if (specifier.startsWith("./")) {
          continue; // intra-integration imports
        }
        const resolved = resolveSpecifier(
          file.slice(REPO_ROOT.length + 1).replaceAll("\\", "/"),
          specifier,
        );
        const segments = resolved.split("/");
        const isExecutionBarrel =
          segments.length === 4 &&
          segments[0] === "src" &&
          segments[1] === "modules" &&
          segments[2] === "executions" &&
          segments[3] === "public";
        const isAgentsBarrel =
          segments.length === 4 &&
          segments[0] === "src" &&
          segments[1] === "modules" &&
          segments[2] === "agents" &&
          segments[3] === "public";
        const isShared = resolved.startsWith("src/shared/");
        const isIntraIntegration = resolved.startsWith("src/integrations/");
        if (!isExecutionBarrel && !isAgentsBarrel && !isShared && !isIntraIntegration) {
          violations.push(`${file}: ${specifier} -> ${resolved}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  test("the integration holds NO policy/budget/verification/learning authority logic", () => {
    // The integration CANNOT decide policy, budgets, verification or
    // learning — it never imports those modules (delegation only).
    for (const file of INTEGRATION_FILES) {
      const text = readFileSync(file, "utf8");
      expect(text, file).not.toMatch(
        /modules\/(policies|budgets|verification|learning|capabilities)\//,
      );
      expect(text, file).not.toMatch(
        /modules\/(policies|budgets|verification|learning|capabilities)\/public/,
      );
    }
  });

  test("M1/M2/M9: no WorkflowOS-state mutation channel exists (no network, no SQL, no SDK)", () => {
    for (const file of [...INTEGRATION_FILES, ...BENCHMARK_FILES]) {
      const text = readFileSync(file, "utf8");
      expect(text, file).not.toMatch(NETWORK_OR_SQL);
      // No WorkflowOS SDK import anywhere (it is not a declared
      // dependency; when one arrives it must live ONLY in
      // src/integrations/workflowos/adapters/ — the engine's boundary).
      expect(text, file).not.toMatch(/from\s+["']@workflowos\//);
    }
  });

  test("M10/M20: no external-framework identifier in the integration or benchmark trees", () => {
    const violations: string[] = [];
    for (const file of [...INTEGRATION_FILES, ...BENCHMARK_FILES]) {
      const text = readFileSync(file, "utf8");
      const match = FRAMEWORK_IDENTIFIER.exec(text);
      if (match !== null) {
        violations.push(`${file}: ${match[0]}`);
      }
    }
    expect(violations).toEqual([]);
  });

  test("the integration public barrel exports no framework/provider type", () => {
    const barrel = readFileSync(join(REPO_ROOT, "src/integrations/workflowos/public.ts"), "utf8");
    expect(barrel).not.toMatch(FRAMEWORK_IDENTIFIER);
    expect(barrel).not.toMatch(/from\s+["']@workflowos\//);
    expect(barrel).toContain("integrationId");
  });
});

describe("architecture: the benchmark non-authority boundary (§21)", () => {
  const MEASUREMENT_FILES = [
    "benchmarks/harness.ts",
    "benchmarks/report.ts",
    "benchmarks/contract.ts",
  ];

  test("the MEASUREMENT surfaces hold no authority mutation call", () => {
    for (const relative of MEASUREMENT_FILES) {
      const text = readFileSync(join(REPO_ROOT, relative), "utf8");
      expect(text, relative).not.toMatch(MEASUREMENT_MUTATION_CALL);
    }
  });

  test("the strategy surface rides only the governed public paths", () => {
    const text = readFileSync(join(REPO_ROOT, "benchmarks/strategies.ts"), "utf8");
    // No policy/budget/registry mutation, no verification mutation.
    expect(text).not.toMatch(
      /\.(publish|promote|rollback|suspend|resume|retire|reserve|settle|release)\s*\(/,
    );
    expect(text).not.toMatch(/modules\/(policies|budgets|verification|learning)\//);
    // The governed paths it DOES ride: executions + sessions + the
    // integration submission seam.
    expect(text).toContain("createExecution");
    expect(text).toContain("submitWork");
  });

  test("benchmarks import only public barrels (no internals, no platform)", () => {
    const violations: string[] = [];
    for (const file of BENCHMARK_FILES) {
      const text = readFileSync(file, "utf8");
      for (const match of text.matchAll(/from\s+["'](\.[^"']+)["']/g)) {
        const specifier = match[1] ?? "";
        const resolved = resolveSpecifier(
          file.slice(REPO_ROOT.length + 1).replaceAll("\\", "/"),
          specifier,
        );
        if (resolved.includes("/internal/") || resolved.startsWith("src/platform/")) {
          violations.push(`${file}: ${specifier} -> ${resolved}`);
        }
        const segments = resolved.split("/");
        if (
          resolved.startsWith("src/modules/") &&
          !(segments.length === 4 && segments[3] === "public")
        ) {
          violations.push(`${file}: ${specifier} -> ${resolved}`);
        }
        if (
          resolved.startsWith("src/integrations/") &&
          !(segments.length === 4 && segments[3] === "public")
        ) {
          violations.push(`${file}: ${specifier} -> ${resolved}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });
});
