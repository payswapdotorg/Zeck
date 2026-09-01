/**
 * Unit — learning facts projection and learning non-authority (WORK-032,
 * ECO-008).
 *
 * `economicOutcomeFacts` is a PURE PROJECTION (durable economic records
 * -> neutral closed-shape facts OUT). Proves:
 *  - the fact shape is closed and versioned; outcome/denial-cause/
 *    delivery-evidence derive from durable records only;
 *  - the projection never carries authority semantics (no callbacks, no
 *    spending effect, no verdict vocabulary);
 *  - the economics module has ZERO learning imports and the service
 *    dependency surface has NO learning input at all (learning scores
 *    cannot authorize spend — mechanically).
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { ECONOMIC_OUTCOME_FACT_OUTCOMES } from "../../../src/modules/economics/domain/learning-facts";
import type {
  DeliveryObservationRecord,
  EconomicActionRecord,
  PaymentAuthorizationRecord,
  SettlementObservationRecord,
} from "../../../src/modules/economics/public";
import {
  ECONOMIC_OUTCOME_FACT_SCHEMA_VERSION,
  economicOutcomeFacts,
} from "../../../src/modules/economics/public";
import { createEconomicsUnitWorld } from "./fakes";

const REPO_ROOT = join(process.cwd());
const ECONOMICS_DIR = join(REPO_ROOT, "src/modules/economics");

function collectFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectFiles(full));
    } else if (entry.name.endsWith(".ts")) {
      out.push(full);
    }
  }
  return out;
}

const action = (
  id: string,
  status: string,
  metadata: Record<string, unknown> = {},
): EconomicActionRecord =>
  ({
    id,
    applicationId: "app-1",
    tenantId: "tenant-1",
    executionId: "exec-1",
    proposedBy: "actor-1",
    purpose: "purchase",
    recipient: { kind: "merchant", id: "merchant-42" },
    amount: { kind: "exact", microUsd: "125000" },
    currency: "usd",
    expiresAt: "2026-09-15T13:00:00.000Z",
    requiredCapabilities: [],
    railPreference: null,
    metadata,
    status: status as EconomicActionRecord["status"],
    idempotencyKey: `key-${id}`,
    createdAt: "2026-09-15T12:00:00.000Z",
    updatedAt: "2026-09-15T12:30:00.000Z",
  }) as EconomicActionRecord;

const settlement = (actionId: string): SettlementObservationRecord =>
  ({
    id: `settlement-${actionId}`,
    economicActionId: actionId,
    authorizationId: `auth-${actionId}`,
    applicationId: "app-1",
    tenantId: "tenant-1",
    railId: "simulated-rail-a",
    railTransactionRef: "sim:simulated-rail-a:1",
    status: "confirmed",
    settledAmountMicroUsd: "125000",
    currency: "usd",
    observedAt: "2026-09-15T12:10:00.000Z",
    evidenceDigest: "fnv1a32:1",
    recordedAt: "2026-09-15T12:10:00.000Z",
  }) as SettlementObservationRecord;

const authorization = (actionId: string): PaymentAuthorizationRecord =>
  ({
    id: `auth-${actionId}`,
    economicActionId: actionId,
    applicationId: "app-1",
    tenantId: "tenant-1",
    constraints: {},
    status: "consumed",
    reservationOperationId: `econ-${actionId}`,
    admissionEvidence: {},
    issuedAt: "2026-09-15T12:05:00.000Z",
    expiresAt: "2026-09-15T13:00:00.000Z",
    consumedAt: "2026-09-15T12:10:00.000Z",
    createdAt: "2026-09-15T12:05:00.000Z",
  }) as PaymentAuthorizationRecord;

const delivery = (actionId: string): DeliveryObservationRecord =>
  ({
    id: `delivery-${actionId}`,
    economicActionId: actionId,
    applicationId: "app-1",
    tenantId: "tenant-1",
    kind: "resource-receipt",
    digest: "sha256:abc",
    contentRef: "ref://1",
    observedAt: "2026-09-15T12:20:00.000Z",
    recordedAt: "2026-09-15T12:20:00.000Z",
  }) as DeliveryObservationRecord;

describe("economic outcome facts: the pure Learning projection (ECO-008)", () => {
  test("the fact vocabulary is closed and versioned", () => {
    expect(ECONOMIC_OUTCOME_FACT_SCHEMA_VERSION).toBe(1);
    expect(ECONOMIC_OUTCOME_FACT_OUTCOMES).toEqual([
      "settled",
      "failed",
      "denied",
      "expired",
      "proposed",
      "authorized",
      "executing",
    ]);
  });

  test("a settled+delivered action projects the full outcome evidence", () => {
    const facts = economicOutcomeFacts(
      [action("a-1", "settled")],
      [settlement("a-1")],
      [authorization("a-1")],
      [delivery("a-1")],
    );
    expect(facts).toHaveLength(1);
    expect(facts[0]).toMatchObject({
      schemaVersion: 1,
      economicActionId: "a-1",
      executionId: "exec-1",
      applicationId: "app-1",
      purpose: "purchase",
      railId: "simulated-rail-a",
      currency: "usd",
      settledAmountMicroUsd: "125000",
      deliveryEvidence: "observed",
      outcome: "settled",
      denialCause: null,
    });
  });

  test("a denied action projects its denial CAUSE as evidence (not a verdict)", () => {
    const facts = economicOutcomeFacts(
      [action("a-2", "denied", { denialCause: "budget", denialReason: "no funds" })],
      [],
      [],
      [],
    );
    expect(facts[0]?.denialCause).toBe("budget");
    expect(facts[0]?.outcome).toBe("denied");
    expect(facts[0]?.railId).toBeNull();
    expect(facts[0]?.settledAmountMicroUsd).toBeNull();
    expect(facts[0]?.deliveryEvidence).toBe("none");
  });

  test("a settled action with no deliveries projects deliveryEvidence 'none' (settlement is not delivery)", () => {
    const facts = economicOutcomeFacts(
      [action("a-3", "settled")],
      [settlement("a-3")],
      [authorization("a-3")],
      [],
    );
    expect(facts[0]?.deliveryEvidence).toBe("none");
  });

  test("an action with deliveries but no settlement projects delivery without settlement", () => {
    const facts = economicOutcomeFacts(
      [action("a-4", "authorized")],
      [],
      [authorization("a-4")],
      [delivery("a-4")],
    );
    expect(facts[0]).toMatchObject({
      outcome: "authorized",
      railId: null,
      deliveryEvidence: "observed",
    });
  });

  test("every action projects exactly one fact (actions without records project too)", () => {
    const facts = economicOutcomeFacts(
      [action("a-5", "proposed"), action("a-6", "failed")],
      [],
      [],
      [],
    );
    expect(facts.map((fact) => fact.economicActionId)).toEqual(["a-5", "a-6"]);
    expect(facts.map((fact) => fact.outcome)).toEqual(["proposed", "failed"]);
  });

  test("the service projection is data OUT only: zero authority semantics on the fact shape", () => {
    const facts = economicOutcomeFacts([action("a-7", "settled")], [settlement("a-7")], [], []);
    const keys = Object.keys(facts[0] ?? {});
    // The closed projection surface: identity + outcome EVIDENCE only.
    expect(keys.sort()).toEqual([
      "applicationId",
      "currency",
      "deliveryEvidence",
      "denialCause",
      "economicActionId",
      "executionId",
      "outcome",
      "purpose",
      "railId",
      "recordedAt",
      "schemaVersion",
      "settledAmountMicroUsd",
    ]);
    // No verdict / authorize / reserve / consume semantics exist on the
    // projection (it is data OUT, never a decision input).
    for (const key of keys) {
      expect(key).not.toMatch(/^verdict|^authoriz|^approv|^reservation|^consumed|^revoke/i);
    }
  });
});

describe("learning is non-authoritative in economics (ECO-008)", () => {
  test("the economics module imports NOTHING from the learning module", () => {
    const violations: string[] = [];
    for (const file of collectFiles(ECONOMICS_DIR)) {
      const text = readFileSync(file, "utf8");
      if (/modules\/learning|\/learning\/public|from\s+["']\.\.\/learning/.test(text)) {
        violations.push(file.slice(REPO_ROOT.length + 1));
      }
    }
    expect(violations).toEqual([]);
  });

  test("the service dependency surface has NO learning input (mechanical pin)", () => {
    const contracts = readFileSync(
      join(ECONOMICS_DIR, "application/economic-action-service.contracts.ts"),
      "utf8",
    );
    const match = /interface EconomicActionServiceDeps \{([\s\S]*?)\n\}/.exec(contracts);
    expect(match).not.toBeNull();
    const fields = [...(match?.[1] ?? "").matchAll(/readonly\s+(\w+)\s*:/g)].map(
      (field) => field[1],
    );
    expect(fields.sort()).toEqual([
      "budget",
      "capabilities",
      "executions",
      "generateId",
      "idempotency",
      "now",
      "policy",
      "store",
    ]);
    // No learning IMPORT exists anywhere in the service wiring (comments
    // may reference learning conceptually; code paths cannot).
    const service = readFileSync(
      join(ECONOMICS_DIR, "application/economic-action-service.ts"),
      "utf8",
    );
    for (const match of service.matchAll(/from\s+["']([^"']+)["']/g)) {
      // Cross-module learning imports are forbidden; the module's own
      // `../domain/learning-facts` projection file is intra-module data OUT.
      expect(match[1]).not.toMatch(/^\.\.\/\.\.\/learning\/|modules\/learning/);
    }
    expect(service).not.toMatch(/learningScore|recommendationScore|score\s*>=|learningInput/);
  });

  test("learning facts flow OUT of durable records only (no live consultation path)", async () => {
    const world = await createEconomicsUnitWorld();
    // Nothing consumed the service yet: zero facts.
    expect(await world.economics.economicOutcomeFacts(world.applicationId)).toEqual([]);
    // After a full charge, the facts derive from the DURABLE records.
    const { createCommand: command, authorizedAction } = await import("./fakes");
    void command;
    const { actionId } = await authorizedAction(world);
    await world.economics.chargeEconomicAction(
      {
        applicationId: world.applicationId,
        tenantId: world.tenantId,
        actorId: world.actorId,
        economicActionId: actionId,
      },
      world.journaledRail,
      "facts-charge",
    );
    const facts = await world.economics.economicOutcomeFacts(world.applicationId);
    expect(facts).toHaveLength(1);
    expect(facts[0]).toMatchObject({
      outcome: "settled",
      railId: "simulated-rail-a",
      settledAmountMicroUsd: "125000",
    });
  });
});
