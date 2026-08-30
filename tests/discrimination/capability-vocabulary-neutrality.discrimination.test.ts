/**
 * Discrimination: provider neutrality of the capability vocabulary
 * (WORK-005 / INT-002, acceptance criterion 1).
 *
 *   N1 — the REAL capabilities module tree is provider-neutral (shared
 *        scanner: no provider identifiers, no rail slugs, no runtime HTTP).
 *   N2/N3 — synthetic mutations leaking a provider identifier / rail slug
 *        into the capability vocabulary are FLAGGED by the same scanner
 *        (the gate over the real tree is live protection, not decoration).
 *   N4 — runtime complement: the claim DESCRIPTORS published by the rail
 *        adapters serialize without any provider identifier or rail slug —
 *        provider specifics stay confined to provenance/evidence, which is
 *        where `spec/contracts.md` requires them to live.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { anthropicCapabilityFacts } from "../../src/modules/models/adapters/anthropic";
import { openRouterCapabilityFacts } from "../../src/modules/models/adapters/openrouter";
import { PROVIDER_IDENTIFIER, RAIL_LITERAL } from "./lib/patterns";
import type { SourceFileLike } from "./lib/provider-neutrality";
import { providerNeutralityViolations } from "./lib/provider-neutrality";

function collectCapabilitiesSources(dir: string): SourceFileLike[] {
  const out: SourceFileLike[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current)) {
      const full = join(current, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
      } else if (full.endsWith(".ts")) {
        const relative = full.slice(process.cwd().length + 1);
        out.push({ path: relative, content: readFileSync(full, "utf8") });
      }
    }
  };
  walk(dir);
  return out;
}

describe("discrimination: provider neutrality of the capability vocabulary", () => {
  const capabilitiesSources = collectCapabilitiesSources(
    join(process.cwd(), "src/modules/capabilities"),
  );

  test("N1: the capabilities module carries no provider identifiers, rail slugs or HTTP egress", () => {
    expect(capabilitiesSources.length).toBeGreaterThan(0);
    const violations = providerNeutralityViolations(capabilitiesSources);
    expect(violations.identifierViolations).toEqual([]);
    expect(violations.railLiteralViolations).toEqual([]);
    expect(violations.fetchViolations).toEqual([]);
  });

  test("N2 mutation record: a provider identifier leaking into the capability vocabulary is flagged", () => {
    const mutated = [
      ...capabilitiesSources,
      {
        path: "src/modules/capabilities/domain/synthetic.ts",
        content: 'export const leak = { providerRef: "openRouterModel" };\n',
      },
    ];
    expect(providerNeutralityViolations(mutated).identifierViolations).toContain(
      "src/modules/capabilities/domain/synthetic.ts",
    );
  });

  test("N3 mutation record: a rail slug leaking into the capability vocabulary is flagged", () => {
    const mutated = [
      ...capabilitiesSources,
      {
        path: "src/modules/capabilities/domain/synthetic.ts",
        content: 'export const DEFAULT_RAIL = "openrouter";\n',
      },
    ];
    expect(providerNeutralityViolations(mutated).railLiteralViolations).toContain(
      "src/modules/capabilities/domain/synthetic.ts",
    );
  });

  test("N4: adapter-published claim descriptors serialize provider-neutral (rail identity only in provenance/evidence)", () => {
    const facts = [...openRouterCapabilityFacts(), ...anthropicCapabilityFacts()];
    expect(facts.length).toBeGreaterThan(0);
    for (const fact of facts) {
      const descriptor = JSON.stringify(fact.claim);
      expect(PROVIDER_IDENTIFIER.test(descriptor)).toBe(false);
      expect(RAIL_LITERAL.test(descriptor)).toBe(false);
      // Provider specifics ARE retained as adapter detail — in evidence/provenance.
      expect(fact.evidence.reference.length).toBeGreaterThan(0);
      expect(fact.provenance.publisher.startsWith("models:adapter:")).toBe(true);
    }
  });
});
