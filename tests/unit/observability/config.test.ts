/**
 * Unit — the telemetry configuration loader (WORK-047 / D-06): the
 * bounded fail-closed loader; unconfigured = logs-only.
 */

import { describe, expect, test } from "vitest";
import { loadTelemetryConfig } from "../../../src/platform/observability/config";

describe("telemetry configuration (WORK-047 D-06)", () => {
  test("unconfigured = the logs-only degraded mode (never an error)", () => {
    const config = loadTelemetryConfig({});
    expect(config.endpoint).toBeNull();
    expect(config.requestTimeoutMs).toBe(5000);
    expect(config.flushEvery).toBe(50);
  });

  test("a valid endpoint configures export", () => {
    const config = loadTelemetryConfig({
      ZECK_OTLP_ENDPOINT: "https://collector.example.org/",
      ZECK_OTLP_REQUEST_TIMEOUT_MS: "9000",
      ZECK_TELEMETRY_FLUSH_EVERY: "128",
    });
    expect(config.endpoint).toBe("https://collector.example.org/");
    expect(config.requestTimeoutMs).toBe(9000);
    expect(config.flushEvery).toBe(128);
  });

  test("a non-http(s) endpoint is rejected fail-closed", () => {
    expect(() => loadTelemetryConfig({ ZECK_OTLP_ENDPOINT: "ftp://nope" })).toThrow(
      /ZECK_OTLP_ENDPOINT must be an http\(s\) URL/,
    );
    expect(() => loadTelemetryConfig({ ZECK_OTLP_ENDPOINT: "not a url" })).toThrow(
      /ZECK_OTLP_ENDPOINT/,
    );
  });

  test("out-of-bounds integers refuse with the exact variable name", () => {
    expect(() => loadTelemetryConfig({ ZECK_OTLP_REQUEST_TIMEOUT_MS: "99" })).toThrow(
      /ZECK_OTLP_REQUEST_TIMEOUT_MS must be an integer in \[100, 120000\]/,
    );
    expect(() => loadTelemetryConfig({ ZECK_OTLP_REQUEST_TIMEOUT_MS: "130000" })).toThrow(
      /ZECK_OTLP_REQUEST_TIMEOUT_MS/,
    );
    expect(() => loadTelemetryConfig({ ZECK_TELEMETRY_FLUSH_EVERY: "4" })).toThrow(
      /ZECK_TELEMETRY_FLUSH_EVERY must be an integer in \[8, 512\]/,
    );
    expect(() => loadTelemetryConfig({ ZECK_TELEMETRY_FLUSH_EVERY: "abc" })).toThrow(
      /ZECK_TELEMETRY_FLUSH_EVERY/,
    );
  });

  test("the loader never reads or returns credential material", () => {
    const config = loadTelemetryConfig({
      ZECK_OTLP_ENDPOINT: "https://collector.example.org",
      ZECK_OTLP_AUTH_TOKEN: "super-secret-token-material",
    });
    expect(JSON.stringify(config)).not.toContain("super-secret-token-material");
  });
});
