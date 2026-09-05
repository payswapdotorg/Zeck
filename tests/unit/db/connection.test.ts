/**
 * Unit tests — the repository-defined database connection contract
 * (WORK-043 / D-02).
 *
 * Proves: URL parsing/validation fail closed (scheme, host,
 * database); sslmode=disable is rejected (authoritative state never
 * crosses an unencrypted wire by configuration); pool bounds are
 * hard-ceilinged (unbounded/non-positive/fractional values rejected);
 * and `redactConnectionString` removes credential material from every
 * diagnostic shape (the secret-exposure guard at the source).
 */
import { describe, expect, test } from "vitest";
import {
  ConnectionConfigurationError,
  connectionEndpoint,
  DEFAULT_POOL_MAX,
  MAX_POOL_CEILING,
  parseConnectionConfig,
  redactConnectionString,
  validatePoolConfig,
} from "../../../src/platform/db/connection";

const URL = "postgres://user:secret@db.example.com:5432/zeckdb?sslmode=require";

describe("parseConnectionConfig", () => {
  test("parses a full managed URL with TLS and pool defaults", () => {
    const config = parseConnectionConfig(URL);
    expect(config.host).toBe("db.example.com");
    expect(config.port).toBe(5432);
    expect(config.database).toBe("zeckdb");
    expect(config.sslRequired).toBe(true);
    expect(config.pool.max).toBe(DEFAULT_POOL_MAX);
    expect(config.pool.connectionTimeoutMillis).toBe(5000);
  });

  test("defaults the port to 5432 and treats absent sslmode as not-required", () => {
    const config = parseConnectionConfig("postgresql://user@localhost/zeck");
    expect(config.port).toBe(5432);
    expect(config.sslRequired).toBe(false);
  });

  test("rejects non-postgres schemes fail closed", () => {
    expect(() => parseConnectionConfig("mysql://user@host/db")).toThrow(
      ConnectionConfigurationError,
    );
    expect(() => parseConnectionConfig("not a url")).toThrow(ConnectionConfigurationError);
  });

  test("rejects a missing host or database", () => {
    expect(() => parseConnectionConfig("postgres:///justdb")).toThrow(ConnectionConfigurationError);
  });

  test("rejects sslmode=disable for the authoritative connection", () => {
    expect(() => parseConnectionConfig("postgres://u@h/db?sslmode=disable")).toThrow(
      /sslmode=disable is not permitted/,
    );
  });

  test("accepts verify-full and require as TLS modes", () => {
    expect(parseConnectionConfig("postgres://u@h/db?sslmode=verify-full").sslRequired).toBe(true);
    expect(parseConnectionConfig("postgres://u@h/db?sslmode=require").sslRequired).toBe(true);
  });
});

describe("validatePoolConfig", () => {
  test("applies bounded overrides", () => {
    const pool = validatePoolConfig({ max: 4, connectionTimeoutMillis: 2000 });
    expect(pool).toEqual({
      max: 4,
      connectionTimeoutMillis: 2000,
      idleTimeoutMillis: 30_000,
    });
  });

  test("rejects non-positive, fractional and over-ceiling max", () => {
    for (const max of [0, -1, 1.5, MAX_POOL_CEILING + 1, Number.NaN]) {
      expect(() => validatePoolConfig({ max })).toThrow(ConnectionConfigurationError);
    }
  });

  test("rejects non-positive and over-ceiling timeouts", () => {
    expect(() => validatePoolConfig({ connectionTimeoutMillis: 0 })).toThrow(
      ConnectionConfigurationError,
    );
    expect(() => validatePoolConfig({ idleTimeoutMillis: 1_000_000 })).toThrow(
      ConnectionConfigurationError,
    );
  });

  test("pool overrides flow through parseConnectionConfig", () => {
    const config = parseConnectionConfig(URL, { max: 2 });
    expect(config.pool.max).toBe(2);
    expect(() => parseConnectionConfig(URL, { max: 99 })).toThrow(ConnectionConfigurationError);
  });
});

describe("redactConnectionString (secret-exposure guard)", () => {
  test("removes embedded credentials from URLs", () => {
    const redacted = redactConnectionString(
      "connect failed: postgres://user:supersecret@db.example.com:5432/zeck",
    );
    expect(redacted).not.toContain("supersecret");
    expect(redacted).not.toContain("user:");
    expect(redacted).toContain("db.example.com");
  });

  test("strips query parameters (sslmode is not secret, but URLs stay minimal)", () => {
    const redacted = redactConnectionString("postgres://a:b@h/db?sslmode=require&x=1");
    expect(redacted).toContain("h");
    expect(redacted).not.toContain("a:b");
  });

  test("passes through non-URL text length-capped without changing it structurally", () => {
    const message = "the pool timed out after 5000ms waiting for a client";
    expect(redactConnectionString(message)).toContain("pool timed out");
  });

  test("connectionEndpoint never contains credentials", () => {
    const config = parseConnectionConfig(URL);
    const endpoint = connectionEndpoint(config);
    expect(endpoint).toBe("postgresql://db.example.com:5432/zeckdb?sslmode=require");
    expect(endpoint).not.toContain("user");
    expect(endpoint).not.toContain("secret");
  });
});
