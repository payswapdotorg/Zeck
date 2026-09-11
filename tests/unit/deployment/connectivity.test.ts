/**
 * Unit tests — the private-connectivity plane (WORK-060 / D-08,
 * SEC-003).
 *
 * Proves over the REAL repository manifests: every environment
 * declares a connectivity profile over the closed vocabulary, and
 * production declares host-spanning private paths. Proves the PURE
 * classifier: loopback / private / dns-name / public address classes
 * over URL forms (scheme://host, postgres connection strings,
 * userinfo-bearing URLs). Proves the contract evaluation: a PUBLIC
 * internal endpoint is refused for EVERY environment class (no
 * vocabulary entry authorizes it); loopback/private endpoints must be
 * authorized by the declared profile; the environment-contract
 * integration rejects materialized public internal endpoints
 * fail-closed.
 */

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import {
  classifyAddress,
  classifyEndpointAddress,
  evaluateConnectivityContract,
  INTERNAL_ENDPOINT_VARIABLES,
  internalEndpointsOfEnvironment,
  pathClassAllowedByProfile,
} from "../../../src/platform/deployment/connectivity";
import { evaluateEnvironmentContract } from "../../../src/platform/deployment/env-contract";
import {
  INTERNAL_CONNECTIVITY_PATHS,
  loadDeploymentManifest,
} from "../../../src/platform/deployment/manifest";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

function loadReal() {
  return loadDeploymentManifest((file) =>
    readFileSync(join(REPO_ROOT, "deploy", "manifests", file), "utf8"),
  );
}

describe("the real environment matrix declares private connectivity (SEC-003)", () => {
  test("every environment declares a non-empty profile over the closed vocabulary", () => {
    const manifest = loadReal();
    for (const environment of manifest.environments) {
      expect(environment.connectivity.internalPaths.length).toBeGreaterThan(0);
      for (const path of environment.connectivity.internalPaths) {
        expect(INTERNAL_CONNECTIVITY_PATHS).toContain(path);
      }
    }
  });

  test("production declares host-spanning private paths (its HA topology is multi-host)", () => {
    const production = loadReal().environments.find((entry) => entry.id === "production");
    expect(production).toBeDefined();
    const paths = production?.connectivity.internalPaths ?? [];
    expect(paths).toContain("private-endpoint");
    expect(paths).toContain("tunnel");
    expect(paths).not.toContain("loopback");
  });

  test("local declares loopback (the workstation form)", () => {
    const local = loadReal().environments.find((entry) => entry.id === "local");
    expect(local?.connectivity.internalPaths).toEqual(["loopback"]);
  });
});

describe("the address classifier (pure, conservative)", () => {
  test("loopback addresses and localhost", () => {
    for (const host of ["127.0.0.1", "127.8.9.10", "localhost", "LOCALHOST", "::1"]) {
      expect(classifyAddress(host)).toBe("loopback");
    }
    expect(classifyEndpointAddress("http://localhost:8080")).toBe("loopback");
    expect(classifyEndpointAddress("postgres://user:pass@127.0.0.1:5432/zeck")).toBe("loopback");
  });

  test("private addresses (RFC1918 + CGNAT tunnel meshes + IPv6 local)", () => {
    for (const host of [
      "10.0.0.5",
      "172.16.1.2",
      "172.31.255.255",
      "192.168.1.10",
      "100.64.0.1",
      "100.127.255.254",
      "fd00::1234",
      "fc42::1",
      "fe80::1",
    ]) {
      expect(classifyAddress(host)).toBe("private");
    }
    expect(classifyEndpointAddress("https://10.1.2.3:443")).toBe("private");
    expect(classifyEndpointAddress("redis://user@192.168.0.4:6379")).toBe("private");
  });

  test("public addresses are unambiguous", () => {
    for (const host of ["8.8.8.8", "1.1.1.1", "172.32.0.1", "100.128.0.1", "203.0.113.9"]) {
      expect(classifyAddress(host)).toBe("public");
    }
    expect(classifyEndpointAddress("http://8.8.8.8:8080")).toBe("public");
  });

  test("non-IP hostnames carry no objective path evidence (dns-name class)", () => {
    for (const host of ["runner.internal.example", "db.privatelink.azure.com", "example.com"]) {
      expect(classifyAddress(host)).toBe("dns-name");
    }
    expect(classifyEndpointAddress("https://runner.internal.example")).toBe("dns-name");
  });

  test("unparseable endpoints fail closed to the public class", () => {
    expect(classifyEndpointAddress("not a url")).toBe("public");
    expect(classifyEndpointAddress("")).toBe("public");
  });
});

describe("the profile authorization map", () => {
  test("no vocabulary entry authorizes a public internal path", () => {
    for (const path of INTERNAL_CONNECTIVITY_PATHS) {
      expect(pathClassAllowedByProfile({ internalPaths: [path] }, "public")).toBe(false);
    }
    expect(
      pathClassAllowedByProfile({ internalPaths: [...INTERNAL_CONNECTIVITY_PATHS] }, "public"),
    ).toBe(false);
  });

  test("loopback addresses are authorized by loopback or tunnel vocabulary", () => {
    expect(pathClassAllowedByProfile({ internalPaths: ["loopback"] }, "loopback")).toBe(true);
    expect(pathClassAllowedByProfile({ internalPaths: ["tunnel"] }, "loopback")).toBe(true);
    expect(pathClassAllowedByProfile({ internalPaths: ["private-endpoint"] }, "loopback")).toBe(
      false,
    );
  });

  test("private and dns endpoints ride the private vocabulary", () => {
    for (const pathClass of ["private", "dns-name"] as const) {
      expect(pathClassAllowedByProfile({ internalPaths: ["private-endpoint"] }, pathClass)).toBe(
        true,
      );
      expect(pathClassAllowedByProfile({ internalPaths: ["tunnel"] }, pathClass)).toBe(true);
      expect(pathClassAllowedByProfile({ internalPaths: ["loopback"] }, pathClass)).toBe(false);
    }
  });
});

describe("the connectivity contract evaluation (fail closed)", () => {
  test("a public internal endpoint is refused for EVERY environment class", () => {
    for (const profile of [
      { internalPaths: ["loopback"] as const },
      { internalPaths: ["tunnel"] as const },
      { internalPaths: ["private-endpoint", "tunnel"] as const },
    ]) {
      const evaluation = evaluateConnectivityContract(profile, [
        { component: "ZECK_CONTAINER_RUNNER_URL", url: "http://8.8.8.8:9123" },
      ]);
      expect(evaluation.satisfied).toBe(false);
      expect(evaluation.problems[0] ?? "").toContain(
        "internal control-plane/worker communication may not traverse public paths (SEC-003)",
      );
    }
  });

  test("a loopback endpoint is refused for a profile without loopback/tunnel vocabulary", () => {
    const evaluation = evaluateConnectivityContract({ internalPaths: ["private-endpoint"] }, [
      { component: "ZECK_CONTAINER_RUNNER_URL", url: "http://127.0.0.1:9123" },
    ]);
    expect(evaluation.satisfied).toBe(false);
  });

  test("authorized endpoints pass; problems never echo the endpoint URL", () => {
    const evaluation = evaluateConnectivityContract(
      { internalPaths: ["private-endpoint", "tunnel"] },
      [
        { component: "ZECK_CONTAINER_RUNNER_URL", url: "https://10.2.3.4:9123" },
        { component: "ZECK_CONTAINER_RUNNER_URL", url: "https://runner.internal.example" },
      ],
    );
    expect(evaluation.satisfied).toBe(true);
    expect(evaluation.problems).toEqual([]);
    // Secret-safety: even the refusal path never embeds the URL.
    const refused = evaluateConnectivityContract({ internalPaths: ["loopback"] }, [
      {
        component: "ZECK_CONTAINER_RUNNER_URL",
        url: "https://user:supersecret@8.8.8.8:9123",
      },
    ]);
    expect(refused.satisfied).toBe(false);
    expect(refused.problems.join("\n")).not.toContain("supersecret");
    expect(refused.problems.join("\n")).not.toContain("8.8.8.8:9123");
  });

  test("the internal endpoint vocabulary covers the control-plane/worker seam only", () => {
    expect(INTERNAL_ENDPOINT_VARIABLES).toEqual(["ZECK_CONTAINER_RUNNER_URL"]);
    expect(
      internalEndpointsOfEnvironment({
        ZECK_CONTAINER_RUNNER_URL: "http://127.0.0.1:9123",
        OTHER: "x",
      }),
    ).toEqual([{ component: "ZECK_CONTAINER_RUNNER_URL", url: "http://127.0.0.1:9123" }]);
    expect(internalEndpointsOfEnvironment({})).toEqual([]);
  });
});

describe("the environment-contract integration (validated, not documented-only)", () => {
  test("a materialized public internal endpoint fails the contract for the real local profile", () => {
    const evaluation = evaluateEnvironmentContract(loadReal(), "local", {
      ZECK_ENVIRONMENT: "local",
      ZECK_CONTAINER_RUNNER_URL: "http://203.0.113.9:9123",
    });
    expect(evaluation.satisfied).toBe(false);
    expect(evaluation.problems.join("\n")).toContain(
      "ZECK_CONTAINER_RUNNER_URL internal endpoint resolves to a public path",
    );
  });

  test("a loopback runner endpoint satisfies the real local profile", () => {
    const evaluation = evaluateEnvironmentContract(loadReal(), "local", {
      ZECK_ENVIRONMENT: "local",
      ZECK_CONTAINER_RUNNER_URL: "http://127.0.0.1:9123",
    });
    expect(evaluation.satisfied).toBe(true);
  });

  test("a loopback-only production profile would refuse loopback endpoints... and production declares more (real tree)", () => {
    // The real production profile declares private-endpoint + tunnel:
    // private and dns-declared runner endpoints satisfy it, and a
    // loopback address is authorized through the TUNNEL vocabulary (an
    // SSH local port-forward presents a loopback address) — the
    // authorization map, not the raw vocabulary list, is the truth.
    const production = loadReal().environments.find((entry) => entry.id === "production");
    expect(production).toBeDefined();
    const profile = production?.connectivity ?? { internalPaths: [] };
    expect(pathClassAllowedByProfile(profile, "private")).toBe(true);
    expect(pathClassAllowedByProfile(profile, "dns-name")).toBe(true);
    expect(pathClassAllowedByProfile(profile, "loopback")).toBe(true); // via tunnel
    expect(pathClassAllowedByProfile(profile, "public")).toBe(false);
    // A loopback-ONLY production profile (unrepresentable in the real
    // tree by validate rule 11) would not authorize private endpoints.
    expect(pathClassAllowedByProfile({ internalPaths: ["loopback"] }, "private")).toBe(false);
  });
});
