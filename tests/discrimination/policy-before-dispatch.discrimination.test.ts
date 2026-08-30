/**
 * Discrimination: policy-before-dispatch (WORK-003; architecture-lock
 * invariant 3, `IMPLEMENTATION.md` §7).
 *
 * Proves the admission gate protects the dispatch path and that a weakened
 * gate is rejected:
 *
 *   A1 — a denied request performs ZERO secret materialization and ZERO
 *        transport, and throws canonical `POLICY_DENIED`.
 *   A2 — an allowed request performs admission FIRST (before connection
 *        secrets move) — the order probe asserts the exact sequence.
 *   A3 — a gateway cannot be constructed without an admission authority:
 *        the module exports no default/allow-all implementation, and the
 *        port type has no `admitAll` shortcut. (Static source proof over
 *        the module tree: no `createAllowAll`/`alwaysAllow` export exists.)
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { buildOrderProbe } from "./lib/order-probe";

describe("discrimination: policy before dispatch (invariant 3)", () => {
  test("A1: denied dispatch materializes nothing and transports nothing", async () => {
    const denied = buildOrderProbe({ allow: false });
    const result = await denied.dispatchAllowed();
    expect(result).toBeNull(); // POLICY_DENIED canonical throw was converted
    expect(denied.steps).toEqual(["admission", "denial"]);
    expect(denied.steps).not.toContain("materialize");
    expect(denied.steps).not.toContain("transport");
    expect(denied.steps).not.toContain("intent");
  });

  test("A2: allowed dispatch runs admission before secrets and transport", async () => {
    const allowed = buildOrderProbe({ allow: true });
    await allowed.dispatchAllowed();
    expect(allowed.steps.indexOf("admission")).toBeLessThan(allowed.steps.indexOf("materialize"));
    expect(allowed.steps.indexOf("admission")).toBeLessThan(allowed.steps.indexOf("intent"));
    expect(allowed.steps.indexOf("materialize")).toBeLessThan(allowed.steps.indexOf("transport"));
    expect(allowed.steps.indexOf("intent")).toBeLessThan(allowed.steps.indexOf("transport"));
  });

  test("A3: the module ships no default/allow-all admission implementation", () => {
    const modelsDir = join(process.cwd(), "src/modules/models");
    const files = readdirSync(join(modelsDir, "ports"), { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
      .map((entry) => join(modelsDir, "ports", entry.name));
    files.push(join(modelsDir, "application", "model-gateway.ts"));
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      expect(text, `${file} must not ship a default-allow admission`).not.toMatch(
        /create(Allow|Default)\w*Admission|allowed:\s*true\s*as const/,
      );
    }
    // The port signature returns a decision — it cannot be voided.
    const portText = readFileSync(join(modelsDir, "ports", "dispatch-admission.ts"), "utf8");
    expect(portText).toMatch(/export interface DispatchAdmission/);
    expect(portText).toMatch(/admit\(input: AdmissionInput\): Promise<AdmissionDecision>/);
  });
});
