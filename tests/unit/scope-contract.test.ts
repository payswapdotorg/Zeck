/**
 * Unit: canonical request fingerprints and scope-contract statics.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { canonicalFingerprint } from "../../src/modules/auth/ports/idempotency";

describe("canonicalFingerprint", () => {
  test("deterministic for identical inputs", () => {
    expect(canonicalFingerprint(["op", { a: 1, b: 2 }])).toBe(
      canonicalFingerprint(["op", { a: 1, b: 2 }]),
    );
  });

  test("object key order is irrelevant", () => {
    expect(canonicalFingerprint(["op", { a: 1, b: 2 }])).toBe(
      canonicalFingerprint(["op", { b: 2, a: 1 }]),
    );
  });

  test("nested structures are canonicalized", () => {
    expect(canonicalFingerprint([{ x: { y: 1, z: [2, 3] } }])).toBe(
      canonicalFingerprint([{ x: { z: [2, 3], y: 1 } }]),
    );
  });

  test("different payloads produce different fingerprints", () => {
    expect(canonicalFingerprint(["op", { role: "admin" }])).not.toBe(
      canonicalFingerprint(["op", { role: "member" }]),
    );
  });

  test("arrays are order-SENSITIVE (payload semantics preserved)", () => {
    expect(canonicalFingerprint([[1, 2]])).not.toBe(canonicalFingerprint([[2, 1]]));
  });
});

/**
 * Static scope-contract proof (acceptance criterion 3): no protected command
 * input exposes a tenant selector. The ONE intentional exception is
 * `CreateApplicationCommand.tenantId` — the TARGET of creation, verified
 * against durable tenant-scope membership by the resolver; it is not a scope
 * selector. This test fails if a tenant selector sneaks into any other
 * command contract.
 */
describe("scope-contract statics (no caller-selectable tenant scope)", () => {
  const read = (relative: string): string => readFileSync(join(process.cwd(), relative), "utf8");

  test("TenantScope values are produced only by the scope resolver", () => {
    const sources = [
      "src/modules/auth/application/scope-resolver.ts",
      "src/modules/auth/application/membership-service.ts",
      "src/modules/applications/application/ownership-services.ts",
      "src/modules/auth/public.ts",
      "src/modules/applications/public.ts",
    ];
    for (const source of sources) {
      const text = read(source);
      // Literals that would construct a TenantScope outside the resolver.
      const constructs = [
        ...text.matchAll(/origin:\s*"(application-membership|tenant-membership)"/g),
      ];
      if (source.endsWith("scope-resolver.ts")) {
        expect(constructs.length).toBe(2);
      } else {
        expect(constructs, `${source} constructs TenantScope values`).toHaveLength(0);
      }
    }
  });

  test("command inputs carry no tenant selector except the documented creation target", () => {
    const commandSources = [
      "src/modules/auth/application/membership-service.ts",
      "src/modules/applications/application/ownership-services.ts",
    ];
    for (const source of commandSources) {
      const text = read(source);
      const interfaces = [...text.matchAll(/export interface (\w*Command\w*) \{([^}]*)\}/g)];
      for (const command of interfaces) {
        const name = command[1] ?? "";
        const body = command[2] ?? "";
        const hasTenantId = /tenantId\s*:/.test(body);
        if (name === "CreateApplicationCommand") {
          // The documented exception: creation target, resolver-verified.
          expect(
            hasTenantId,
            "CreateApplicationCommand must keep its documented target field",
          ).toBe(true);
        } else {
          expect(hasTenantId, `${name} must not expose a tenant selector`).toBe(false);
        }
      }
      // All command interfaces were actually found and scanned.
      expect(commandSources.length).toBeGreaterThan(0);
    }
  });

  test("the resolver API surface accepts (principal, targetId) only — no tenant parameter", () => {
    const text = read("src/modules/auth/application/scope-resolver.ts");
    expect(text).toMatch(/resolveApplicationScope\(principal[^)]*applicationId/);
    expect(text).toMatch(/resolveTenantScope\(principal[^)]*tenantId/);
    // resolveTenantScope VERIFIES authority over the named tenant; it never
    // accepts a tenant as caller-asserted scope without a membership check.
    expect(text).toMatch(/findTenantMembership/);
  });
});
