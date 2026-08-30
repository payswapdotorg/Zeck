/**
 * Discrimination: capability-before-route (WORK-005 / INT-002, the CORE
 * ordering boundary — `spec/architecture.md` §2.5, `IMPLEMENTATION.md` §7).
 *
 * Proves the ordering boundary protects route selection and that a weakened
 * gate is rejected:
 *
 *   C1 — a task profile the capability authority cannot satisfy fails
 *        canonical `CAPABILITY_UNAVAILABLE` BEFORE any rail/provider
 *        resolution, secret materialization, durable intent or transport —
 *        and the denial is journaled (admission-denial pattern).
 *   C2 — a satisfied profile resolves capabilities BEFORE the rail is
 *        selected (order probe with a rail-recording registry).
 *   C3 — the module ships no default/bypass/skip capability gate (static
 *        source proof mirroring the policy-before-dispatch A3 discipline).
 *   C4 — synthetic gateway mutations that select a provider route before
 *        capability resolution (gate removed, gate deferred past the rail,
 *        non-canonical failure) are REJECTED by the shared scanner — a
 *        weakened protection fails the gate (mutation record).
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { capabilityGateOrderViolations } from "./lib/capability-gate-order";
import { buildCapabilityOrderProbe } from "./lib/capability-order-probe";

const GATEWAY_SOURCE = readFileSync(
  join(process.cwd(), "src/modules/models/application/model-gateway.ts"),
  "utf8",
);

describe("discrimination: capability before provider route (INT-002)", () => {
  test("C1: unsatisfiable profile fails CAPABILITY_UNAVAILABLE before any route selection", async () => {
    const probe = buildCapabilityOrderProbe({ satisfy: false });
    const error = await probe.complete().then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(Error);
    expect((error as { code?: string }).code).toBe("CAPABILITY_UNAVAILABLE");
    // Zero route selection, zero durable intent, zero secrets, zero transport.
    expect(probe.steps).toEqual(["admission", "capability", "denial"]);
    expect(probe.railLookups).toHaveLength(0);
    expect(probe.steps).not.toContain("intent");
    expect(probe.steps).not.toContain("materialize");
    expect(probe.steps).not.toContain("transport");
    // The denial reason is capability-scoped, journaled like admission denials.
    expect(probe.getDenialReason()?.startsWith("capability-unavailable:")).toBe(true);
  });

  test("C1b: streaming dispatch enforces the identical boundary", async () => {
    const probe = buildCapabilityOrderProbe({ satisfy: false });
    const error = await probe.stream().then(
      () => null,
      (e: unknown) => e,
    );
    expect((error as { code?: string }).code).toBe("CAPABILITY_UNAVAILABLE");
    expect(probe.railLookups).toHaveLength(0);
    expect(probe.steps).not.toContain("transport");
  });

  test("C2: satisfied profile resolves capabilities BEFORE the rail is selected", async () => {
    const probe = buildCapabilityOrderProbe({ satisfy: true });
    const result = await probe.complete();
    expect(result).not.toBeNull();
    expect(probe.steps).toEqual([
      "admission",
      "capability",
      "rail",
      "intent",
      "materialize",
      "transport",
      "outcome",
    ]);
    expect(probe.steps.indexOf("capability")).toBeLessThan(probe.steps.indexOf("rail"));
    expect(probe.steps.indexOf("capability")).toBeLessThan(probe.steps.indexOf("intent"));
    // Policy still precedes everything (frozen order preserved, additive step).
    expect(probe.steps.indexOf("admission")).toBeLessThan(probe.steps.indexOf("capability"));
    expect(probe.railLookups).toEqual(["openrouter"]);
  });

  test("C3: the models module ships no default/bypass/skip capability gate", () => {
    const modelsDir = join(process.cwd(), "src/modules/models");
    const files = readdirSync(join(modelsDir, "ports"), { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
      .map((entry) => join(modelsDir, "ports", entry.name));
    files.push(join(modelsDir, "application", "model-gateway.ts"));
    files.push(join(modelsDir, "application", "capability-gate.ts"));
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      expect(text, `${file} must not ship a bypass capability gate`).not.toMatch(
        /create(Bypass|Skip|Default|AllowAll|AcceptAll)\w*Capabilit|satisfied:\s*true\s*as const/,
      );
    }
    // The port signature returns a resolution — it cannot be voided.
    const portText = readFileSync(join(modelsDir, "ports", "capability-gate.ts"), "utf8");
    expect(portText).toMatch(/export interface TaskCapabilityResolution/);
    expect(portText).toMatch(
      /resolve\(profile: TaskCapabilityProfile\): Promise<CapabilityResolution>/,
    );
  });

  test("C4 mutation record: gateway mutations that route before resolving capabilities are rejected by the shared scanner", () => {
    // The real gateway source passes the scanner.
    expect(capabilityGateOrderViolations(GATEWAY_SOURCE)).toEqual([]);

    // Mutation 1: the gate consultation is removed entirely (bypass) — both
    // the dispatch-method calls and the underlying port consultation.
    const gateRemoved = GATEWAY_SOURCE.replaceAll(
      "await resolveCapabilities(request, intent, connectionId);",
      "",
    ).replaceAll("deps.capabilities.resolve(", "deps.removed(");
    expect(capabilityGateOrderViolations(gateRemoved)).toContain(
      "missing-capability-resolution-call",
    );

    // Mutation 2: provider selection happens BEFORE capability resolution
    // (the gate call is deferred past the rail lookup inside `complete`).
    const CALL = "await resolveCapabilities(request, intent, connectionId);";
    const firstCall = GATEWAY_SOURCE.indexOf(CALL);
    expect(firstCall).toBeGreaterThan(-1);
    const afterRemoval =
      GATEWAY_SOURCE.slice(0, firstCall) + GATEWAY_SOURCE.slice(firstCall + CALL.length);
    const intentAnchor = afterRemoval.indexOf("recordIntent(intent);");
    expect(intentAnchor).toBeGreaterThan(firstCall); // the anchor sits AFTER the rail lookup
    const railFirst = `${afterRemoval.slice(0, intentAnchor)}${CALL}\n${afterRemoval.slice(intentAnchor)}`;
    expect(capabilityGateOrderViolations(railFirst)).toContain(
      "rail-resolution-before-capability-resolution",
    );

    // Mutation 3: unsatisfied profiles fail with a non-canonical error code.
    const nonCanonical = GATEWAY_SOURCE.replaceAll(
      "CAPABILITY_UNAVAILABLE",
      "INVALID_STATE_TRANSITION",
    );
    expect(capabilityGateOrderViolations(nonCanonical)).toContain(
      "missing-canonical-capability-unavailable-failure",
    );
  });
});
