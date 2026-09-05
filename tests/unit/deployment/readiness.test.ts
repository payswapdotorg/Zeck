/**
 * Unit tests — the deployment readiness model (WORK-042 AC6/AC9).
 *
 * Proves over the REAL manifest: control-plane availability and
 * dependency readiness are reported as SEPARATE facts; the
 * authoritative relational dependency failing (or even degrading)
 * takes the whole plane DOWN (fail closed — no silent authority
 * switch); non-authoritative dependencies degrade explicitly with
 * the manifest's degraded mode; unknown probe concerns fail closed;
 * diagnostics never carry credential-shaped content; and the HTTP
 * mapping routes down/unavailable to 503.
 */

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { loadDeploymentManifest } from "../../../src/platform/deployment/manifest";
import {
  type DependencyProbeResult,
  evaluateReadiness,
  httpStatusForReadiness,
  redactDetail,
} from "../../../src/platform/deployment/readiness";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

function loadReal() {
  return loadDeploymentManifest((file) =>
    readFileSync(join(REPO_ROOT, "deploy", "manifests", file), "utf8"),
  );
}

function probes(
  entries: Record<string, "ready" | "degraded" | "unavailable">,
): readonly DependencyProbeResult[] {
  return Object.entries(entries).map(([concern, status]) => ({ concern, status }));
}

describe("the control-plane/dependency distinction (AC6)", () => {
  test("all-ready dependencies report ready with control plane ready", () => {
    const report = evaluateReadiness(loadReal(), {
      controlPlaneAvailable: true,
      probes: probes({
        "relational-state": "ready",
        "artifact-bytes": "ready",
        "ephemeral-coordination": "ready",
      }),
    });
    expect(report.controlPlane).toBe("ready");
    expect(report.overall).toBe("ready");
    expect(report.dependencies).toHaveLength(3);
    expect(
      report.dependencies.every(
        (d) => d.authority === "non-authoritative" || d.concern === "relational-state",
      ),
    ).toBe(true);
  });

  test("control-plane unavailability is reported SEPARATELY from dependencies", () => {
    const report = evaluateReadiness(loadReal(), {
      controlPlaneAvailable: false,
      probes: probes({ "relational-state": "ready" }),
    });
    expect(report.controlPlane).toBe("unavailable");
    expect(report.overall).toBe("unavailable");
    // The dependency facts are still reported — one opaque bit is not
    // the contract.
    expect(report.dependencies[0]?.status).toBe("ready");
  });
});

describe("fail-closed authority (AC9 — PostgreSQL authority failure fails closed)", () => {
  test("the authoritative relational dependency unavailable ⇒ DOWN", () => {
    const report = evaluateReadiness(loadReal(), {
      controlPlaneAvailable: true,
      probes: probes({
        "relational-state": "unavailable",
        "artifact-bytes": "ready",
        "ephemeral-coordination": "ready",
      }),
    });
    expect(report.overall).toBe("down");
    expect(httpStatusForReadiness(report.overall)).toBe(503);
  });

  test("the authoritative dependency DEGRADED is also DOWN (authority must be ready)", () => {
    const report = evaluateReadiness(loadReal(), {
      controlPlaneAvailable: true,
      probes: probes({ "relational-state": "degraded" }),
    });
    expect(report.overall).toBe("down");
  });

  test("non-authoritative dependencies degrade explicitly with the manifest's mode", () => {
    const report = evaluateReadiness(loadReal(), {
      controlPlaneAvailable: true,
      probes: probes({
        "relational-state": "ready",
        "ephemeral-coordination": "unavailable",
        "artifact-bytes": "degraded",
      }),
    });
    expect(report.overall).toBe("degraded");
    expect(report.overall).not.toBe("down");
    const redis = report.dependencies.find((d) => d.concern === "ephemeral-coordination");
    expect(redis?.authority).toBe("non-authoritative");
    expect(redis?.degradedMode).toBe("coordination-degraded");
    const artifacts = report.dependencies.find((d) => d.concern === "artifact-bytes");
    expect(artifacts?.degradedMode).toBe("artifact-store-unavailable");
    expect(httpStatusForReadiness(report.overall)).toBe(200);
  });
});

describe("readiness fails closed on unknown probe concerns", () => {
  test("a probe concern without a declared provider throws", () => {
    expect(() =>
      evaluateReadiness(loadReal(), {
        controlPlaneAvailable: true,
        probes: [{ concern: "mystery-concern", status: "ready" }],
      }),
    ).toThrow(/no declared provider/);
  });
});

describe("secret-free diagnostics (AC6: no secret-bearing diagnostics)", () => {
  test("URL credentials are redacted from probe details", () => {
    const redacted = redactDetail(
      "postgres://postgres:supersecret@127.0.0.1:55432/postgres unreachable",
    );
    expect(redacted).not.toContain("supersecret");
    expect(redacted).toContain("[redacted]");
  });

  test("token-shaped literals are redacted from probe details", () => {
    const redacted = redactDetail("provider said: sk-abcdefgh12345678 is invalid");
    expect(redacted).not.toContain("sk-abcdefgh12345678");
    const github = redactDetail("ghp_0123456789abcdefghijklmnopqrstuv rejected");
    expect(github).not.toContain("ghp_0123456789");
    const bearer = redactDetail("Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345");
    expect(bearer).not.toContain("abcdefghijklmnopqrstuvwxyz012345");
  });

  test("the full report path redacts secret-bearing details", () => {
    const report = evaluateReadiness(loadReal(), {
      controlPlaneAvailable: true,
      probes: [
        {
          concern: "relational-state",
          status: "unavailable",
          detail: "connect failed: postgres://app:p4ssw0rd@db.internal:5432/zeck",
        },
      ],
    });
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain("p4ssw0rd");
    expect(serialized).toContain("[redacted]");
  });

  test("details are length-capped and control characters stripped", () => {
    const redacted = redactDetail(`x`.repeat(500));
    expect(redacted?.length).toBeLessThanOrEqual(200);
    expect(redactDetail("noise\u0007signal")).not.toContain("\u0007");
  });
});

describe("the HTTP status mapping", () => {
  test("ready and degraded map to 200; down and unavailable map to 503", () => {
    expect(httpStatusForReadiness("ready")).toBe(200);
    expect(httpStatusForReadiness("degraded")).toBe(200);
    expect(httpStatusForReadiness("down")).toBe(503);
    expect(httpStatusForReadiness("unavailable")).toBe(503);
  });
});
