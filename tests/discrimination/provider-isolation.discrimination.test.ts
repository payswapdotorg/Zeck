/**
 * Discrimination: provider isolation boundaries (WORK-003, CON-001).
 *
 * Proves the provider-neutrality protections actually discriminate: each
 * synthetic mutation that would leak provider specificity into neutral
 * territory is REJECTED by the corresponding gate. A gate that passes on the
 * mutated tree would be dead protection.
 *
 * Mutations proven rejected:
 *   P1 — a provider SDK import outside the owning adapter
 *        (`provider-sdk-outside-adapter` rule).
 *   P2 — a provider-specific type leaking into a neutral contract source
 *        (identifier scan).
 *   P3 — a provider rail slug leaking outside the vocabulary/adapters
 *        (rail-literal scan).
 *   P4 — runtime HTTP egress outside the transport adapter (fetch scan).
 */

import { describe, expect, test } from "vitest";
import { collectSourceFiles } from "../architecture/lib/collect";
import { scanDependencyRules } from "../architecture/lib/dependency-rules";
import { providerNeutralityViolations } from "./lib/provider-neutrality";

const IDENTIFIER_MUTATION = `export interface Leaky {
  readonly openRouterModelRef: OpenRouterModelRef;
  readonly anthropicToolUse: unknown;
}
`;
const RAIL_LITERAL_MUTATION = `export const DEFAULT_RAIL = "openrouter";
`;
const FETCH_MUTATION = `export async function callOut() {
  return fetch("https://example.invalid");
}
`;

describe("discrimination: provider isolation (CON-001)", () => {
  const files = collectSourceFiles(process.cwd());
  const allowedPackages: string[] = [];

  test("P1: provider SDK import outside its adapter is flagged by the rule engine", () => {
    const mutated = [
      ...files,
      {
        path: "src/modules/planning/domain/synthetic.ts",
        content: 'import { Anthropic } from "@anthropic-ai/sdk";\nexport const x = Anthropic;\n',
      },
    ];
    const violations = scanDependencyRules(mutated, { allowedPackages });
    expect(
      violations.filter((v) => v.rule === "provider-sdk-outside-adapter").map((v) => v.path),
    ).toContain("src/modules/planning/domain/synthetic.ts");
  });

  test("P1b: the same SDK import inside the owning adapter area is NOT an isolation violation", () => {
    const mutated = [
      ...files,
      {
        path: "src/modules/models/adapters/synthetic-rail.ts",
        content: 'import { Anthropic } from "@anthropic-ai/sdk";\nexport const x = Anthropic;\n',
      },
    ];
    const violations = scanDependencyRules(mutated, { allowedPackages });
    expect(
      violations.filter(
        (v) => v.rule === "provider-sdk-outside-adapter" && v.path.includes("synthetic-rail"),
      ),
    ).toEqual([]);
  });

  test("P2: a provider identifier leaking into a neutral contract source is flagged", () => {
    const mutated = [
      ...files,
      { path: "src/modules/models/domain/synthetic.ts", content: IDENTIFIER_MUTATION },
    ];
    const violations = providerNeutralityViolations(mutated);
    expect(violations.identifierViolations).toContain("src/modules/models/domain/synthetic.ts");
    // And the clean tree has none.
    expect(providerNeutralityViolations(files).identifierViolations).toEqual([]);
  });

  test("P3: a rail slug leaking outside the vocabulary/adapters is flagged", () => {
    const mutated = [
      ...files,
      { path: "src/modules/planning/domain/synthetic.ts", content: RAIL_LITERAL_MUTATION },
    ];
    const violations = providerNeutralityViolations(mutated);
    expect(violations.railLiteralViolations).toContain("src/modules/planning/domain/synthetic.ts");
    expect(providerNeutralityViolations(files).railLiteralViolations).toEqual([]);
  });

  test("P4: runtime HTTP egress outside the transport adapter is flagged", () => {
    const mutated = [
      ...files,
      { path: "src/modules/tools/domain/synthetic.ts", content: FETCH_MUTATION },
    ];
    const violations = providerNeutralityViolations(mutated);
    expect(violations.fetchViolations).toContain("src/modules/tools/domain/synthetic.ts");
    expect(providerNeutralityViolations(files).fetchViolations).toEqual([]);
  });
});
