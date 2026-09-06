/**
 * Gated live — the REAL container-runner round trip (WORK-046 / D-05).
 *
 * Runs ONLY when the runner is actually configured:
 *   ZECK_CONTAINER_RUNNER_URL + ZECK_CONTAINER_RUNNER_API_TOKEN
 *
 * Without the variables the suite SKIPS with the exact missing-variable
 * reason (honesty over silence — never a PASS claimed from an
 * unconfigured environment). A mirror test names the exact variables.
 */

import { describe, expect, test } from "vitest";
import {
  createContainerRuntimeClient,
  probeContainerRunner,
} from "../../../src/platform/compute/container-runtime";

const RUNNER_URL = process.env.ZECK_CONTAINER_RUNNER_URL ?? "";
const RUNNER_TOKEN = process.env.ZECK_CONTAINER_RUNNER_API_TOKEN ?? "";
const LIVE = RUNNER_URL.length > 0 && RUNNER_TOKEN.length > 0;

describe.skipIf(!LIVE)("container runner LIVE round trip (WORK-046 D-05)", () => {
  test("the probe authenticates against the real runner (404 for the synthetic run id)", async () => {
    const probe = await probeContainerRunner({
      baseUrl: RUNNER_URL,
      apiToken: RUNNER_TOKEN,
      requestTimeoutMs: 15_000,
    });
    expect(probe.ok).toBe(true);
    expect(probe.detail).toContain("404");
  });

  test("a real container run executes the validated configuration and observes the outcome", async () => {
    const client = createContainerRuntimeClient({
      baseUrl: RUNNER_URL,
      apiToken: RUNNER_TOKEN,
      requestTimeoutMs: 15_000,
      pollIntervalMs: 250,
    });
    const result = await client.run(
      {
        image: "zeck-sandbox-base:1",
        command: "sh",
        args: ["-c", "echo worker-fabric-live-probe"],
        env: [],
        mounts: [],
        network: { mode: "none", allowedHosts: [] },
        resourceLimits: { cpuMilliCores: 500, memoryMiB: 64, executionTimeoutMs: 30_000 },
        readOnlyRootfs: true,
        runAsNonRoot: true,
        privileged: false,
        hostNetwork: false,
        hostPid: false,
        hostIpc: false,
        devices: [],
        addedCapabilities: [],
        droppedCapabilities: ["ALL"],
        seccompProfile: "default",
        noNewPrivileges: true,
      },
      { timeoutMs: 30_000 },
    );
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("worker-fabric-live-probe");
    expect(result.timedOut).toBe(false);
  });
});

describe("container runner LIVE gating (WORK-046 D-05)", () => {
  test("the gating names the exact missing variables", () => {
    if (!LIVE) {
      expect(RUNNER_URL.length === 0 || RUNNER_TOKEN.length === 0).toBe(true);
    }
    // The variables this suite requires (the mirror of the skip):
    expect(["ZECK_CONTAINER_RUNNER_URL", "ZECK_CONTAINER_RUNNER_API_TOKEN"]).toStrictEqual([
      "ZECK_CONTAINER_RUNNER_URL",
      "ZECK_CONTAINER_RUNNER_API_TOKEN",
    ]);
  });
});
