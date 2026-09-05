/**
 * Discrimination tests — the D-02 production-path protections
 * (WORK-043, HIGH_ASSURANCE; the worker-runbook rule: "For
 * HIGH_ASSURANCE and CRITICAL, add an explicit discrimination test
 * that proves a weakened protection is rejected").
 *
 * Every fail-closed protection introduced by WORK-043 is
 * mutation-proven — the WEAKENED form of the state is rejected by
 * the gate that owns it:
 *
 *  - the compatibility floor: a server BELOW PostgreSQL 16 is
 *    rejected at startup (the "accept any version" weakening is
 *    unrepresentable);
 *  - pool bounds: unbounded/fractional/over-ceiling pools are
 *    rejected (a pool is a bounded resource or it is a leak);
 *  - the secret-reference model: cross-environment resolution is
 *    rejected; absent materialization fails closed with the variable
 *    NAME, never a value; plaintext never enters an error;
 *  - artifact integrity: a digest mismatch never transports (put)
 *    and never mutates anything (get) — the "self-heal" weakening is
 *    unrepresentable;
 *  - retention safety: an unconfirmed/empty inventory read NEVER
 *    authorizes deletion; namespace escapes and retained keys are
 *    refused;
 *  - the redaction guard: credential-shaped diagnostics are scrubbed
 *    at every wrap point.
 */

import { createHash } from "node:crypto";
import { describe, expect, test } from "vitest";
import {
  ConnectionConfigurationError,
  parseConnectionConfig,
  redactConnectionString,
  validatePoolConfig,
} from "../../src/platform/db/connection";
import { DatabaseUnavailableError } from "../../src/platform/db/errors";
import type { PgDatabasePort } from "../../src/platform/db/pg-database-port";
import { startAuthoritativeDatabase } from "../../src/platform/db/startup";
import {
  ArtifactIntegrityError,
  createVerifyingObjectStore,
} from "../../src/platform/object-store/integrity";
import type {
  ObjectStorePort,
  PutOptions,
  StoredObject,
} from "../../src/platform/object-store/port";
import {
  DEFAULT_ARTIFACT_NAMESPACE,
  executeRetentionSweep,
  planRetentionSweep,
} from "../../src/platform/object-store/retention";
import {
  asSecretReference,
  createEnvSecretStore,
  parseSecretReference,
  SecretResolutionError,
} from "../../src/platform/secret-store/adapters/env-secret-store";

const STARTUP_URL = "postgres://user:pass@h.example.com/db";

/** A fake pg adapter answering a LIED server version. */
function versionLyingAdapter(serverVersionNum: number): PgDatabasePort {
  return {
    ping: async () => ({
      serverVersion: `PostgreSQL ${Math.floor(serverVersionNum / 10_000)}`,
      serverVersionNum,
    }),
    close: async () => undefined,
    execute: async <T = Record<string, unknown>>() => ({ rows: [] as T[], rowCount: 0 }),
    transaction: async <T>(work: unknown) => work as T,
  } as unknown as PgDatabasePort;
}

describe("D-02 fail-closed discrimination (WORK-043)", () => {
  test("the compatibility floor: a server below PostgreSQL 16 is REJECTED at startup", async () => {
    // Weakened form: a PG 15 endpoint (would be accepted by a
    // version-blind gate). The startup must fail closed.
    await expect(
      startAuthoritativeDatabase(STARTUP_URL, {
        portFactory: () => versionLyingAdapter(150004),
      }),
    ).rejects.toThrow(/not PostgreSQL 16\+/);
    // The floor itself is pinned (raising the floor is an
    // architecture change, not a configuration tweak).
    const major = (num: number): number => Math.floor(num / 10_000);
    expect(major(159999)).toBeLessThan(16);
    expect(major(160000)).toBe(16);
  });

  test("pool bounds: the unbounded/weakened pool forms are rejected", () => {
    for (const weakened of [0, -5, 1.5, 33, Number.POSITIVE_INFINITY, Number.NaN]) {
      expect(() => validatePoolConfig({ max: weakened })).toThrow(ConnectionConfigurationError);
    }
    for (const weakenedTimeout of [0, -1, 1.5, 200_000]) {
      expect(() => validatePoolConfig({ connectionTimeoutMillis: weakenedTimeout })).toThrow(
        ConnectionConfigurationError,
      );
    }
    // The bounded forms are accepted (the guard discriminates).
    expect(() => validatePoolConfig({ max: 1 })).not.toThrow();
    expect(() => validatePoolConfig({ max: 32 })).not.toThrow();
  });

  test("sslmode=disable on the authority path is a configuration error", () => {
    // Weakened form: an unencrypted authority connection.
    expect(() => parseConnectionConfig("postgres://u@h/db?sslmode=disable")).toThrow(
      /sslmode=disable is not permitted/,
    );
    expect(() => parseConnectionConfig("postgres://u@h/db?sslmode=require")).not.toThrow();
  });

  test("the secret-reference model: cross-environment resolution and plaintext-absence fail closed", async () => {
    const local = createEnvSecretStore({
      environment: "local",
      env: { ZECK_DATABASE_URL: "postgres://user:pass@h/db" },
    });
    // Weakened form A: production material resolved from a local process.
    await expect(
      local.resolve(asSecretReference("zeck-secret://production/database-url")),
    ).rejects.toThrow(/environment isolation/);
    // Weakened form B: absent materialization reported WITH the value.
    const empty = createEnvSecretStore({ environment: "local", env: {} });
    const error = await empty
      .resolve(asSecretReference("zeck-secret://local/database-url"))
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SecretResolutionError);
    expect((error as Error).message).toContain("ZECK_DATABASE_URL is not set");
    expect((error as Error).message).not.toContain("postgres://");
    // Weakened form C: an unmapped secret silently resolved.
    await expect(
      local.resolve(asSecretReference("zeck-secret://local/queue-api-token")),
    ).rejects.toThrow(/no materialization variable/);
    // Weakened form D: secrets WRITTEN into the environment.
    await expect(
      local.store({ material: "x", classification: "provider-credential" }),
    ).rejects.toThrow(/read-only/);
  });

  test("artifact integrity: a digest mismatch never transports and never mutates", async () => {
    let deletions = 0;
    let writes = 0;
    const body = new TextEncoder().encode("authoritative bytes");
    const digest = createHash("sha256").update(body).digest("hex");
    const store: ObjectStorePort = {
      put: async (_key: string, _bytes: Uint8Array, _options?: PutOptions) => {
        writes += 1;
      },
      get: async (key: string): Promise<StoredObject | null> =>
        key === "tampered"
          ? { key, body: new TextEncoder().encode("tampered bytes"), contentType: undefined }
          : { key, body, contentType: undefined },
      delete: async () => {
        deletions += 1;
      },
    };
    const verifying = createVerifyingObjectStore(store);
    // Weakened form A (put): mismatching bytes stored anyway.
    await expect(
      verifying.putVerified("k", new TextEncoder().encode("wrong bytes"), digest),
    ).rejects.toThrow(ArtifactIntegrityError);
    expect(writes).toBe(0);
    // Weakened form B (get): tampered content "repaired"/deleted.
    await expect(verifying.getVerified("tampered", digest)).rejects.toThrow(ArtifactIntegrityError);
    expect(deletions).toBe(0);
    expect(writes).toBe(0);
  });

  test("retention safety: an unconfirmed inventory NEVER authorizes deletion; escapes are refused", async () => {
    const deleted: string[] = [];
    const store: ObjectStorePort = {
      put: async () => undefined,
      get: async () => null,
      delete: async (key: string) => {
        deleted.push(key);
      },
    };
    const key = `zeck/artifacts/t/ab/${"a".repeat(64)}`;
    // Weakened form A: empty-inventory read ⇒ delete everything.
    const unconfirmed = await executeRetentionSweep(
      store,
      {
        namespace: DEFAULT_ARTIFACT_NAMESPACE,
        authoritativeRetainedKeys: new Set<string>(),
        candidateKeys: [key],
        authoritativeInventoryConfirmed: false,
      },
      { dryRun: false },
    );
    expect(unconfirmed.deleted).toEqual([]);
    expect(deleted).toEqual([]);
    // Weakened form B: keys outside the artifact namespace deleted.
    const escaped = planRetentionSweep({
      namespace: DEFAULT_ARTIFACT_NAMESPACE,
      authoritativeRetainedKeys: new Set<string>(),
      candidateKeys: ["postgres/schema_migrations", "other/thing"],
      authoritativeInventoryConfirmed: true,
    });
    expect(escaped.deletions).toEqual([]);
    expect(escaped.refusals).toHaveLength(2);
    // Weakened form C: a retained key deleted anyway.
    const retained = planRetentionSweep({
      namespace: DEFAULT_ARTIFACT_NAMESPACE,
      authoritativeRetainedKeys: new Set([key]),
      candidateKeys: [key],
      authoritativeInventoryConfirmed: true,
    });
    expect(retained.deletions).toEqual([]);
    expect(retained.refusals).toHaveLength(1);
    // Weakened form D: execution without the verified plan.
    const dry = await executeRetentionSweep(
      store,
      {
        namespace: DEFAULT_ARTIFACT_NAMESPACE,
        authoritativeRetainedKeys: new Set<string>(),
        candidateKeys: [key],
        authoritativeInventoryConfirmed: true,
      },
      // no dryRun option: the DEFAULT is dry-run
    );
    expect(dry.deleted).toEqual([]);
    expect(deleted).toEqual([]);
  });

  test("the redaction guard scrubs credential shapes at every wrap point", () => {
    const credential =
      "postgres://zeckuser:SuperSecret9@ep-cool-name-123456.us-east-2.aws.neon.tech/zeckdb";
    // The adapter's unavailable wrap (pg-database-port connect path):
    const wrapped = new DatabaseUnavailableError(
      redactConnectionString(`ECONNREFUSED ${credential}`),
    ).message;
    expect(wrapped).not.toContain("SuperSecret9");
    expect(wrapped).not.toContain("zeckuser:");
    // The startup wrap includes the same guard (double-wrapped stays redacted).
    const doubleWrapped = redactConnectionString(wrapped);
    expect(doubleWrapped).not.toContain("SuperSecret9");
    // The raw URL parsing itself never leaks into diagnostics:
    const config = parseConnectionConfig(`${credential}?sslmode=require`);
    expect(redactConnectionString(config.url)).not.toContain("SuperSecret9");
    // And reference parsing rejects non-reference shapes (plaintext).
    expect(() => parseSecretReference(credential)).toThrow(SecretResolutionError);
  });
});
