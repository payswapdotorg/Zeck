/**
 * Unit tests — the environment-materialization secret store
 * (WORK-043 / D-02).
 *
 * Proves: reference URIs resolve only within their environment scope
 * (cross-environment resolution rejected — production material is
 * not addressable from a non-production process); absent
 * materialization fails closed carrying the VARIABLE NAME only
 * (never a value); the read-only store() refuses; and error messages
 * are structurally incapable of carrying credential material.
 */
import { describe, expect, test } from "vitest";
import {
  asSecretReference,
  createEnvSecretStore,
  DEFAULT_MATERIALIZATION,
  parseSecretReference,
  SecretResolutionError,
} from "../../../src/platform/secret-store/adapters/env-secret-store";

const ENV = {
  ZECK_DATABASE_URL: "postgres://user:pass@ep-xyz.neon.tech/zeck?sslmode=require",
  ZECK_OBJECT_STORE_ACCESS_KEY_ID: "AKIAZEXAMPLEKEYID",
  ZECK_OBJECT_STORE_SECRET_ACCESS_KEY: "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY",
};

function localStore(env: Record<string, string | undefined> = ENV) {
  return createEnvSecretStore({ environment: "local", env });
}

describe("the environment-materialization secret store", () => {
  test("resolves a database-url reference to the materialized value with classification", async () => {
    const resolved = await localStore().resolve(
      asSecretReference("zeck-secret://local/database-url"),
    );
    expect(resolved.plaintext).toBe(ENV.ZECK_DATABASE_URL);
    expect(resolved.classification).toBe("provider-credential");
    expect(resolved.reference).toBe("zeck-secret://local/database-url");
  });

  test("resolves the object-store credentials through the repository materialization map", async () => {
    const store = localStore();
    const accessKeyId = await store.resolve(
      asSecretReference("zeck-secret://local/object-store-access-key-id"),
    );
    const secretKey = await store.resolve(
      asSecretReference("zeck-secret://local/object-store-secret-access-key"),
    );
    expect(accessKeyId.plaintext).toBe(ENV.ZECK_OBJECT_STORE_ACCESS_KEY_ID);
    expect(secretKey.plaintext).toBe(ENV.ZECK_OBJECT_STORE_SECRET_ACCESS_KEY);
    expect(DEFAULT_MATERIALIZATION["database-url"]).toBe("ZECK_DATABASE_URL");
    expect(DEFAULT_MATERIALIZATION["object-store-access-key-id"]).toBe(
      "ZECK_OBJECT_STORE_ACCESS_KEY_ID",
    );
    expect(DEFAULT_MATERIALIZATION["object-store-secret-access-key"]).toBe(
      "ZECK_OBJECT_STORE_SECRET_ACCESS_KEY",
    );
  });

  test("cross-environment resolution is rejected (environment isolation)", async () => {
    await expect(
      localStore().resolve(asSecretReference("zeck-secret://production/database-url")),
    ).rejects.toThrow(SecretResolutionError);
    await expect(
      localStore().resolve(asSecretReference("zeck-secret://production/database-url")),
    ).rejects.toThrow(/environment isolation/);
  });

  test("absent materialization fails closed with the VARIABLE NAME, never a value", async () => {
    const error = await localStore({
      ZECK_OBJECT_STORE_ACCESS_KEY_ID: "present",
    })
      .resolve(asSecretReference("zeck-secret://local/database-url"))
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SecretResolutionError);
    const message = (error as Error).message;
    expect(message).toContain("ZECK_DATABASE_URL is not set");
    expect(message).not.toContain("postgres://");
  });

  test("unmapped secret names fail closed (no silent expansion of the inventory)", async () => {
    // queue-api-token is now a MAPPED D-03 secret (WORK-044) — the
    // unmapped-name proof uses a name absent from the inventory.
    await expect(
      localStore().resolve(asSecretReference("zeck-secret://local/not-a-declared-secret")),
    ).rejects.toThrow(/no materialization variable/);
  });

  test("the queue-api-token secret resolves through the D-03 materialization map", async () => {
    const store = createEnvSecretStore({
      environment: "local",
      env: { ...ENV, ZECK_QUEUE_API_TOKEN: "queue-token-material" },
    });
    const resolved = await store.resolve(asSecretReference("zeck-secret://local/queue-api-token"));
    expect(resolved.plaintext).toBe("queue-token-material");
    expect(resolved.classification).toBe("provider-credential");
  });

  test("the store side is read-only (writing secrets is not a platform capability)", async () => {
    await expect(
      localStore().store({ material: "new-secret", classification: "provider-credential" }),
    ).rejects.toThrow(/read-only/);
  });

  test("parseSecretReference validates the URI shape fail closed", () => {
    expect(parseSecretReference("zeck-secret://local/database-url")).toEqual({
      environment: "local",
      name: "database-url",
    });
    for (const bad of ["plaintext-value", "zeck-secret://local", "zeck-secret://local/a b", ""]) {
      expect(() => parseSecretReference(bad)).toThrow(SecretResolutionError);
    }
    // The branded constructor validates identically.
    expect(() => asSecretReference("not-a-reference")).toThrow(SecretResolutionError);
  });

  test("resolution error messages are structurally value-free (secret-exposure guard)", async () => {
    const cases = await Promise.allSettled([
      localStore({}).resolve(asSecretReference("zeck-secret://local/database-url")),
      localStore().resolve(asSecretReference("zeck-secret://staging/database-url")),
    ]);
    for (const outcome of cases) {
      if (outcome.status === "rejected") {
        const message = String(outcome.reason);
        expect(message).not.toContain("postgres://");
        expect(message).not.toContain("AKIAZEXAMPLEKEYID");
        expect(message).not.toContain("wJalrXUtnFEMI");
      }
    }
  });
});
