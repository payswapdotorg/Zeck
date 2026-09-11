/**
 * Unit — the HA topology declaration parser (WORK-057 / D-08,
 * AVA-002: "HA topology (primary+standby) declarable per environment
 * class through repository truth").
 *
 * Proves the fail-closed contract of `parseHaTopologyTargets` /
 * `parseHaTopologyDocument` / `failoverTargetForMode` /
 * `haEndpointsFromEnvironment`:
 *
 *  - the repository truth (deploy/manifests/recovery-targets.json)
 *    loads for EVERY environment class with the AVA-002 production
 *    shape (failover RTO ≤ 15 min, async RPO ≤ 60 s, sync RPO 0);
 *  - every drift — missing ha block, unknown topology shape,
 *    non-numeric/unbounded targets, unbounded prose, missing
 *    replication paths — is a typed configuration error, never a
 *    default;
 *  - the mode projection composes the D-07 evaluator input (the ONE
 *    objective-evaluation authority — rto-rpo.ts — is reused, never
 *    reimplemented);
 *  - the endpoint contract fails closed: missing materialization,
 *    invalid URLs, identical endpoints, unknown replication mode.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { parseConnectionConfig } from "../../../src/platform/db/connection";
import {
  failoverTargetForMode,
  HaTopologyError,
  haEndpointsFromEnvironment,
  parseHaReplicationMode,
  parseHaTopologyDocument,
  parseHaTopologyTargets,
} from "../../../src/platform/db/ha/topology";
import { parseRecoveryTargets } from "../../../src/platform/recovery/rto-rpo";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const RECOVERY_TARGETS_SOURCE = readFileSync(
  resolve(REPO_ROOT, "deploy", "manifests", "recovery-targets.json"),
  "utf8",
);

function environmentTarget(environment: string): Record<string, unknown> {
  const document = JSON.parse(RECOVERY_TARGETS_SOURCE) as {
    targets: Record<string, Record<string, unknown>>;
  };
  return document.targets[environment] as Record<string, unknown>;
}

function withHa(ha: unknown): Record<string, unknown> {
  return { rtoTargetMs: 900000, rpoTargetMs: 0, scope: "s", measurement: "m", ha };
}

const VALID_HA = {
  topology: "primary-standby",
  replication: { asynchronous: { rpoTargetMs: 60000 }, synchronous: { rpoTargetMs: 0 } },
  failover: {
    rtoTargetMs: 900000,
    scope: "authority failover on the HA topology",
    measurement: "deploy:drill authority-failover",
  },
};

describe("the HA topology declaration (WORK-057 / AVA-002)", () => {
  test("the repository truth declares a primary+standby topology for every environment class", () => {
    const topologies = parseHaTopologyDocument(JSON.parse(RECOVERY_TARGETS_SOURCE));
    expect(Object.keys(topologies).sort()).toEqual([
      "ci",
      "local",
      "preview",
      "production",
      "staging",
    ]);
    for (const ha of Object.values(topologies)) {
      expect(ha.topology).toBe("primary-standby");
      // Both replication paths carry bounded targets on every class
      // (local/ci/preview honestly declare 0 — the disposable drill's
      // caught-up quiescent measurement; production/staging carry the
      // AVA-002 asynchronous bound, proven separately).
      expect(ha.replication.asynchronous.rpoTargetMs).toBeGreaterThanOrEqual(0);
      expect(ha.replication.synchronous.rpoTargetMs).toBe(0);
      expect(ha.failover.rtoTargetMs).toBeGreaterThan(0);
      expect(ha.failover.scope.length).toBeGreaterThan(0);
      expect(ha.failover.measurement.length).toBeGreaterThan(0);
    }
  });

  test("the production class carries the AVA-002 binding targets (failover RTO ≤ 15 min; async RPO ≤ 60 s; sync RPO 0)", () => {
    const production = parseHaTopologyTargets(environmentTarget("production"));
    expect(production.failover.rtoTargetMs).toBeLessThanOrEqual(15 * 60 * 1000);
    expect(production.replication.asynchronous.rpoTargetMs).toBeLessThanOrEqual(60 * 1000);
    expect(production.replication.synchronous.rpoTargetMs).toBe(0);
    // The extension is ADDITIVE: the D-07 core fields stay untouched.
    const core = environmentTarget("production");
    expect(core.rtoTargetMs).toBe(14400000);
    expect(core.rpoTargetMs).toBe(300000);
    expect(core.scope).toContain("Loss of a production provider category");
  });

  test("the staging class mirrors the production-like failover targets", () => {
    const staging = parseHaTopologyTargets(environmentTarget("staging"));
    expect(staging.failover.rtoTargetMs).toBe(900000);
    expect(staging.replication.asynchronous.rpoTargetMs).toBe(60000);
  });

  test("a valid declaration parses frozen and complete", () => {
    const ha = parseHaTopologyTargets(withHa(VALID_HA));
    expect(ha).toEqual(VALID_HA);
    expect(Object.isFrozen(ha)).toBe(true);
    expect(Object.isFrozen(ha.replication)).toBe(true);
    expect(Object.isFrozen(ha.failover)).toBe(true);
  });

  test("fail closed: a missing ha block, unknown topology shape, or missing replication path", () => {
    expect(() =>
      parseHaTopologyTargets({ rtoTargetMs: 1, rpoTargetMs: 0, scope: "s", measurement: "m" }),
    ).toThrow(HaTopologyError);
    expect(() => parseHaTopologyTargets(withHa({ ...VALID_HA, topology: "multi-master" }))).toThrow(
      /ha.topology must be one of primary-standby/,
    );
    expect(() =>
      parseHaTopologyTargets(
        withHa({ ...VALID_HA, replication: { asynchronous: { rpoTargetMs: 1 } } }),
      ),
    ).toThrow(/ha.replication.synchronous must be an object/);
    expect(() => parseHaTopologyTargets(withHa({ ...VALID_HA, failover: undefined }))).toThrow(
      /ha.failover must be an object/,
    );
  });

  test("fail closed: non-numeric, negative, fractional or unbounded targets", () => {
    for (const bad of ["60000", -1, 1.5, null, true]) {
      expect(() =>
        parseHaTopologyTargets(
          withHa({
            ...VALID_HA,
            replication: { asynchronous: { rpoTargetMs: bad }, synchronous: { rpoTargetMs: 0 } },
          }),
        ),
      ).toThrow(/rpoTargetMs must be a non-negative integer/);
    }
    expect(() =>
      parseHaTopologyTargets(
        withHa({ ...VALID_HA, failover: { ...VALID_HA.failover, rtoTargetMs: 999999999999 } }),
      ),
    ).toThrow(/exceeds the .* bound/);
  });

  test("fail closed: unbounded or empty prose", () => {
    expect(() =>
      parseHaTopologyTargets(
        withHa({ ...VALID_HA, failover: { ...VALID_HA.failover, scope: "" } }),
      ),
    ).toThrow(/scope must be a non-empty string/);
    expect(() =>
      parseHaTopologyTargets(
        withHa({ ...VALID_HA, failover: { ...VALID_HA.failover, measurement: "x".repeat(501) } }),
      ),
    ).toThrow(/at most 500 characters/);
  });

  test("the extension never weakens the D-07 core parser (additive by construction)", () => {
    const document = JSON.stringify({
      schemaVersion: 1,
      description: "d",
      note: "n",
      targets: { local: withHa(VALID_HA) },
    });
    // Valid core fields + the ha extension: the core parser stays
    // green (the extension is tolerated and ignored by it).
    expect(() => parseRecoveryTargets(document)).not.toThrow();
    // A record MISSING the core fields still fails the core parser —
    // the ha block never substitutes for the D-07 targets.
    const haOnly = JSON.stringify({
      schemaVersion: 1,
      description: "d",
      note: "n",
      targets: { local: { ha: VALID_HA } },
    });
    expect(() => parseRecoveryTargets(haOnly)).toThrow(/target field rtoTargetMs/);
  });

  test("the mode projection composes the D-07 evaluator input for both replication paths", () => {
    const ha = parseHaTopologyTargets(withHa(VALID_HA));
    const asyncTarget = failoverTargetForMode(ha, "asynchronous");
    expect(asyncTarget).toEqual({
      rtoTargetMs: 900000,
      rpoTargetMs: 60000,
      scope: "authority failover on the HA topology",
      measurement: "deploy:drill authority-failover",
    });
    const syncTarget = failoverTargetForMode(ha, "synchronous");
    expect(syncTarget.rpoTargetMs).toBe(0);
    expect(syncTarget.rtoTargetMs).toBe(900000);
  });

  test("the replication-mode vocabulary is closed", () => {
    expect(parseHaReplicationMode("asynchronous")).toBe("asynchronous");
    expect(parseHaReplicationMode("synchronous")).toBe("synchronous");
    expect(() => parseHaReplicationMode("eventual")).toThrow(HaTopologyError);
  });

  test("the endpoint contract: materialized, valid, distinct", () => {
    const endpoints = haEndpointsFromEnvironment({
      ZECK_HA_PRIMARY_URL: "postgres://postgres@127.0.0.1:55432/zeck",
      ZECK_HA_STANDBY_URL: "postgres://postgres@127.0.0.1:55433/zeck",
    });
    expect(endpoints.mode).toBe("asynchronous"); // the documented default
    expect(parseConnectionConfig(endpoints.primaryUrl).database).toBe("zeck");
    expect(() =>
      haEndpointsFromEnvironment({ ZECK_HA_PRIMARY_URL: "postgres://u:p@h:1/d" }),
    ).toThrow(/missing: ZECK_HA_STANDBY_URL/);
    expect(() =>
      haEndpointsFromEnvironment({
        ZECK_HA_PRIMARY_URL: "postgres://postgres@127.0.0.1:55432/zeck",
        ZECK_HA_STANDBY_URL: "postgres://postgres@127.0.0.1:55432/zeck",
      }),
    ).toThrow(/identical/);
    expect(() =>
      haEndpointsFromEnvironment({
        ZECK_HA_PRIMARY_URL: "postgres://postgres@127.0.0.1:55432/zeck",
        ZECK_HA_STANDBY_URL: "postgres://postgres@127.0.0.1:55433/zeck",
        ZECK_HA_REPLICATION_MODE: "semi",
      }),
    ).toThrow(/replication mode/);
  });
});
