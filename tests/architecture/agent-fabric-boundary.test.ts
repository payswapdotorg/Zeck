/**
 * Architecture gate: the agent fabric boundary (WORK-011; checkpoint
 * contracts AUTH-PRESERVATION, DEPENDENCY-DIRECTION, TENANT-ISOLATION,
 * POLICY-BEFORE-DISPATCH, EXECUTION-PROVENANCE, EXTERNAL-SIDE-EFFECTS —
 * proof class "static").
 *
 * Runs the SHARED scanner over the REAL src tree — one definition of the
 * protections (tests/discrimination/lib/agent-fabric.ts), two uses: this
 * gate over the real tree, the discrimination proofs over synthetic
 * mutations. A weakened protection is provably rejected.
 *
 * The dynamic halves live in tests/unit/agents and
 * tests/integration/postgres/agents-*; the mutation (discrimination)
 * proofs live in tests/discrimination/agent-fabric.discrimination.test.ts.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import {
  AGENT_FABRIC_CANONICAL_PATHS,
  type AgentFabricFile,
  agentFabricViolations,
  hasCanonicalAgentFabric,
} from "../discrimination/lib/agent-fabric";

function loadSourceFiles(root: string, dir: string): AgentFabricFile[] {
  const files: AgentFabricFile[] = [];
  for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
    const relative = `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      files.push(...loadSourceFiles(root, relative));
    } else if (entry.name.endsWith(".ts")) {
      files.push({ path: relative, content: readFileSync(join(root, relative), "utf8") });
    }
  }
  return files;
}

test("the agent fabric keeps every named boundary (M1..M24 static protections)", () => {
  const files = loadSourceFiles(process.cwd(), "src");
  expect(hasCanonicalAgentFabric(files)).toBe(true);
  expect(agentFabricViolations(files)).toEqual([]);
});

test("the protected surface files exist (scanner sanity)", () => {
  const files = loadSourceFiles(process.cwd(), "src");
  const paths = new Set(files.map((file) => file.path));
  for (const canonical of AGENT_FABRIC_CANONICAL_PATHS) {
    expect(paths.has(canonical), canonical).toBe(true);
  }
});

test("the agents module's cross-module imports target public barrels only", () => {
  const files = loadSourceFiles(process.cwd(), "src/modules/agents");
  for (const file of files) {
    const imports = [...file.content.matchAll(/from ["'](\.[^"']+)["']/g)].map((m) => m[1] ?? "");
    for (const specifier of imports) {
      if (specifier.includes("/executions/") || specifier.includes("/policies/")) {
        expect(
          specifier.endsWith("/public") || specifier.endsWith("/public.ts"),
          `${file.path} imports ${specifier} — must target the public barrel`,
        ).toBe(true);
      }
    }
  }
});

test("the executions module remains the sole owner of the agent step-event vocabulary", () => {
  const executionsEvent = readFileSync(
    join(process.cwd(), "src/modules/executions/domain/event.ts"),
    "utf8",
  );
  expect(executionsEvent).toContain('"agent-session-started"');
  expect(executionsEvent).toContain('"agent-action-recorded"');
  expect(executionsEvent).toContain('"agent-session-completed"');
  // The vocabulary constant exists exactly once in src/.
  const files = loadSourceFiles(process.cwd(), "src");
  const definers = files.filter((f) => /STEP_EVENT_COMMANDS\s*=\s*\[/.test(f.content));
  expect(definers.map((f) => f.path)).toEqual(["src/modules/executions/domain/event.ts"]);
});
