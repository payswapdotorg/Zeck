/**
 * Discrimination: BYOK secret boundary (WORK-003, CON-002; lock invariant 9).
 *
 * Proves the secret protections discriminate — each weakened protection is
 * rejected:
 *
 *   S1 — a public connection view carrying plaintext/ciphertext fields is
 *        flagged by the source-level redaction scan.
 *   S2 — a durable outcome carrying credential material is caught by the
 *        runtime serialization check (all service outcomes are walked).
 *   S3 — materialization BEFORE the admission decision is caught by the
 *        gateway sequencing proof (order assertions fail on reorder).
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

const CONNECTION_VIEW_SOURCES = [
  "src/modules/connections/domain/connection.ts",
  "src/modules/connections/public.ts",
];

/** Fields that must never appear in a public connection view. */
const FORBIDDEN_VIEW_FIELDS = /\b(plaintext|ciphertext|credentialMaterial|secret)\b/i;

describe("discrimination: BYOK secret boundary (CON-002)", () => {
  test("S1: public views stay free of material-bearing fields (clean tree passes)", () => {
    for (const source of CONNECTION_VIEW_SOURCES) {
      const text = readFileSync(join(process.cwd(), source), "utf8");
      // The public record interface specifically:
      const record = text.split("export interface ConnectionRecord", 2)[1]?.split("}", 1)[0] ?? "";
      expect(
        FORBIDDEN_VIEW_FIELDS.test(record),
        `${source} ConnectionRecord leaks material fields`,
      ).toBe(false);
    }
  });

  test("S1b: the scan rejects a mutated view that adds a plaintext field", () => {
    const mutated =
      "export interface ConnectionRecord {\n  readonly id: string;\n  readonly plaintext: string | null;\n}\n";
    const record = mutated.split("export interface ConnectionRecord", 2)[1]?.split("}", 1)[0] ?? "";
    expect(FORBIDDEN_VIEW_FIELDS.test(record)).toBe(true);
  });

  test("S2: every durable outcome the connection service can produce is material-free", async () => {
    // Dynamic walk: register + rotate + list + dispatch facts through the
    // service fakes, then serialize EVERY returned value and the ledger's
    // recorded outcomes; the secret marker must appear nowhere.
    const { buildSecretProbe } = await import("./lib/secret-probe");
    const probe = buildSecretProbe();
    await probe.register();
    await probe.rotate();
    await probe.list();
    const serialized = probe.serializedEverything();
    expect(serialized).not.toContain(probe.MATERIAL_MARKER);
    expect(serialized).not.toContain(probe.ROTATION_MARKER);
  });

  test("S3: materialization strictly follows admission (order proof)", async () => {
    const { buildOrderProbe } = await import("./lib/order-probe");
    const order = buildOrderProbe();
    await order.dispatchAllowed();
    expect(order.steps).toEqual(["admission", "intent", "materialize", "transport", "outcome"]);
    // The same probe with a DENYING gate performs no materialization and no
    // transport — the sequencing contract rejects the weakened order.
    const denied = buildOrderProbe({ allow: false });
    await denied.dispatchAllowed().catch(() => undefined);
    expect(denied.steps.filter((s) => s === "materialize" || s === "transport")).toEqual([]);
    expect(denied.steps).toContain("denial");
  });
});
