/**
 * Architecture: capability-before-provider ordering (WORK-005 / INT-002).
 *
 * The scanner is SHARED with the discrimination proofs
 * (`tests/discrimination/lib/capability-gate-order.ts`): one definition of
 * the protection, two uses — the gate over the real gateway source, the
 * proofs over synthetic bypass mutations.
 *
 * Additionally asserts the authority direction of the new module set:
 * `models` consumes the capability authority through the capabilities
 * public barrel; `capabilities` imports neither models nor connections.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { capabilityGateOrderViolations } from "../discrimination/lib/capability-gate-order";

const GATEWAY_PATH = join(process.cwd(), "src/modules/models/application/model-gateway.ts");

function collectFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (current: string): void => {
    for (const entry of readdirSync(current)) {
      const full = join(current, entry);
      if (statSync(full).isDirectory()) {
        walk(full);
      } else if (full.endsWith(".ts")) {
        out.push(full);
      }
    }
  };
  walk(dir);
  return out;
}

describe("architecture: capability resolution precedes provider route selection", () => {
  test("the real gateway resolves capabilities before every rail lookup", () => {
    const source = readFileSync(GATEWAY_PATH, "utf8");
    expect(capabilityGateOrderViolations(source)).toEqual([]);
  });

  test("the capability authority stays upstream: capabilities imports neither models nor connections", () => {
    const violations: string[] = [];
    for (const file of collectFiles(join(process.cwd(), "src/modules/capabilities"))) {
      const text = readFileSync(file, "utf8");
      if (/from\s+["']\.\.\/\.\.\/(models|connections)\//.test(text)) {
        violations.push(file);
      }
    }
    expect(violations).toEqual([]);
  });

  test("capability claim vocabulary is frozen to the six architecture kinds", async () => {
    const { CAPABILITY_KINDS } = await import("../../src/modules/capabilities/public");
    expect([...CAPABILITY_KINDS]).toEqual([
      "model",
      "tool",
      "algorithm",
      "data",
      "runtime",
      "human",
    ]);
  });
});
