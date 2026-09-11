/**
 * Unit tests: the runtime provider adapters (WORK-054) — E2B, Daytona,
 * Modal and self-hosted as neutral MECHANISMS behind the declared
 * compute/sandbox seam, exercised against typed contract doubles
 * (live provider APIs are NOT RUN in this environment — exact
 * disclosure). Proves: the neutral translation tables (started ≠
 * ready), cross-execution identity separation, idempotent replay
 * convergence, fail-closed unmappable states, the composition binding
 * validation, and vendor vocabulary confinement to the adapter files.
 */
import { describe, expect, test } from "vitest";
import type { ContainerConfiguration } from "../../../../src/platform/sandbox/container-profile";
import type { ContainerRuntimeClient } from "../../../../src/platform/sandbox/runtime-client";
import type {
  DaytonaProviderTransport,
  DaytonaSandboxPhase,
} from "../../../../src/platform/substrate-economics/adapters/daytona";
import { createDaytonaAdapter } from "../../../../src/platform/substrate-economics/adapters/daytona";
import type {
  E2bProviderTransport,
  E2bSandboxPhase,
} from "../../../../src/platform/substrate-economics/adapters/e2b";
import { createE2bAdapter } from "../../../../src/platform/substrate-economics/adapters/e2b";
import type {
  ModalProviderTransport,
  ModalSandboxPhase,
} from "../../../../src/platform/substrate-economics/adapters/modal";
import { createModalAdapter } from "../../../../src/platform/substrate-economics/adapters/modal";
import {
  assertAdapterBinding,
  SubstrateAdapterError,
} from "../../../../src/platform/substrate-economics/adapters/port";
import type { SelfHostedProbeTransport } from "../../../../src/platform/substrate-economics/adapters/self-hosted";
import { createSelfHostedAdapter } from "../../../../src/platform/substrate-economics/adapters/self-hosted";
import { SubstrateEconomicsError } from "../../../../src/platform/substrate-economics/catalog";

const NOW = 1_800_000_000_000;
const now = () => NOW;

/** A minimal validated container configuration (the neutral seam input). */
function configuration(): ContainerConfiguration {
  return {
    image: "zeck-workload:1",
    command: "python3",
    args: ["-c", "print('ok')"],
    env: [{ name: "ZECK_RUN", value: "1" }],
    mounts: [],
    network: { mode: "none", allowedHosts: [] },
    resourceLimits: { cpuMilliCores: 500, memoryMiB: 256, executionTimeoutMs: 5000 },
    isolationClass: "standard",
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
  };
}

const RUN_OPTIONS = { runIdentity: "app/exec-1/sandbox-1", timeoutMs: 5000 };

// ---------------------------------------------------------------------------
// Contract doubles (typed fake provider surfaces)
// ---------------------------------------------------------------------------

function e2bDouble(options: { phase?: E2bSandboxPhase; failCreate?: boolean } = {}) {
  const created = new Map<string, string>();
  const calls: string[] = [];
  const transport: E2bProviderTransport = {
    async createSandbox(request) {
      calls.push(`create:${request.environmentId}:${request.snapshotId ?? "cold"}`);
      if (options.failCreate) {
        throw new Error("provider unreachable");
      }
      const existing = created.get(request.environmentId);
      if (existing !== undefined) {
        // Idempotent submission: the same environment id converges on
        // the held sandbox (the transport contract).
        return { sandboxId: existing };
      }
      const sandboxId = `sbx-${created.size + 1}`;
      created.set(request.environmentId, sandboxId);
      return { sandboxId };
    },
    async getSandboxPhase() {
      return { phase: options.phase ?? "running" };
    },
    async probeReadiness() {
      return { phase: options.phase ?? "running" };
    },
    async runCommand(request) {
      calls.push(`run:${request.sandboxId}:${request.program}`);
      return {
        exitCode: 0,
        stdout: "ok",
        stderr: "",
        timedOut: false,
        durationMs: 42,
      };
    },
    async destroySandbox() {},
  };
  return { transport, created, calls };
}

function daytonaDouble(options: { phase?: DaytonaSandboxPhase; stdout?: string } = {}) {
  const created = new Map<string, string>();
  const transport: DaytonaProviderTransport = {
    async createSandbox(request) {
      const existing = created.get(request.environmentId);
      if (existing !== undefined) {
        return { sandboxId: existing };
      }
      const sandboxId = `day-${created.size + 1}`;
      created.set(request.environmentId, sandboxId);
      return { sandboxId };
    },
    async getSandboxPhase() {
      return { phase: options.phase ?? "running" };
    },
    async probeReadiness() {
      return { phase: options.phase ?? "running" };
    },
    async runCommand() {
      return {
        exitCode: 0,
        stdout: options.stdout ?? "daytona-ok",
        stderr: "",
        timedOut: false,
        durationMs: 33,
      };
    },
    async destroySandbox() {},
  };
  return { transport, created };
}

function modalDouble(options: { phase?: ModalSandboxPhase; stdout?: string } = {}) {
  const created = new Map<string, string>();
  const transport: ModalProviderTransport = {
    async createSandbox(request) {
      const existing = created.get(request.environmentId);
      if (existing !== undefined) {
        return { sandboxId: existing };
      }
      const sandboxId = `mdl-${created.size + 1}`;
      created.set(request.environmentId, sandboxId);
      return { sandboxId };
    },
    async getSandboxPhase() {
      return { phase: options.phase ?? "ready" };
    },
    async probeReadiness() {
      return { phase: options.phase ?? "ready" };
    },
    async runCommand() {
      return {
        exitCode: 0,
        stdout: options.stdout ?? "modal-ok",
        stderr: "",
        timedOut: false,
        durationMs: 21,
      };
    },
    async terminateSandbox() {},
  };
  return { transport, created };
}

// ---------------------------------------------------------------------------
// The adapter contract tests
// ---------------------------------------------------------------------------

describe("adapter seam: configuration validation (fail closed BEFORE any provider call)", () => {
  test("a vendor-shaped adapterRef is rejected (the neutral binding key discipline)", () => {
    const e2b = e2bDouble();
    expect(() =>
      createE2bAdapter(
        { adapterRef: "vendor://e2b", templateId: "tpl", nowEpochMs: now },
        e2b.transport,
      ),
    ).toThrow(SubstrateEconomicsError);
    const daytona = daytonaDouble();
    expect(() =>
      createDaytonaAdapter({ adapterRef: "", nowEpochMs: now }, daytona.transport),
    ).toThrow(SubstrateEconomicsError);
  });

  test("unbounded readiness timeouts are typed rejections", () => {
    const { transport } = e2bDouble();
    for (const readinessTimeoutMs of [0, 999, 600_001]) {
      expect(() =>
        createE2bAdapter(
          {
            adapterRef: "substrate-adapter-01",
            templateId: "tpl",
            readinessTimeoutMs,
            nowEpochMs: now,
          },
          transport,
        ),
      ).toThrow(SubstrateAdapterError);
    }
  });

  test("run options without a runIdentity are PERMANENT rejections before any wire call", async () => {
    const { transport, calls } = e2bDouble();
    const adapter = createE2bAdapter(
      { adapterRef: "substrate-adapter-01", templateId: "tpl", nowEpochMs: now },
      transport,
    );
    await expect(
      adapter.run(configuration(), { runIdentity: "", timeoutMs: 5000 }),
    ).rejects.toMatchObject({ failureKind: "permanent" });
    await expect(
      adapter.run(configuration(), { runIdentity: "x".repeat(257), timeoutMs: 5000 }),
    ).rejects.toMatchObject({ failureKind: "permanent" });
    await expect(
      adapter.run(configuration(), { runIdentity: "valid", timeoutMs: 0 }),
    ).rejects.toMatchObject({ failureKind: "permanent" });
    expect(calls).toEqual([]);
  });
});

describe("adapter seam: cross-execution identity separation", () => {
  test("two different executions doing identical work NEVER collapse into one provider environment", async () => {
    const { transport, created } = e2bDouble();
    const adapter = createE2bAdapter(
      { adapterRef: "substrate-adapter-01", templateId: "tpl", nowEpochMs: now },
      transport,
    );
    await adapter.run(configuration(), RUN_OPTIONS);
    await adapter.run(configuration(), { ...RUN_OPTIONS, runIdentity: "app/exec-2/sandbox-1" });
    expect(created.size).toBe(2);
  });

  test("a REPLAY of the same logical run converges on the SAME provider environment (idempotent)", async () => {
    const { transport, created } = e2bDouble();
    const adapter = createE2bAdapter(
      { adapterRef: "substrate-adapter-01", templateId: "tpl", nowEpochMs: now },
      transport,
    );
    await adapter.run(configuration(), RUN_OPTIONS);
    await adapter.run(configuration(), RUN_OPTIONS);
    expect(created.size).toBe(1);
  });

  test("a different admitted timeout is a different logical run (the derivation input set)", async () => {
    const { transport, created } = e2bDouble();
    const adapter = createE2bAdapter(
      { adapterRef: "substrate-adapter-01", templateId: "tpl", nowEpochMs: now },
      transport,
    );
    await adapter.run(configuration(), RUN_OPTIONS);
    await adapter.run(configuration(), { ...RUN_OPTIONS, timeoutMs: 6000 });
    expect(created.size).toBe(2);
  });
});

describe("the E2B adapter (contract double round-trip)", () => {
  test("a cold run executes the validated configuration and returns the neutral result", async () => {
    const { transport, calls } = e2bDouble();
    const adapter = createE2bAdapter(
      { adapterRef: "substrate-adapter-01", templateId: "tpl-e2b", nowEpochMs: now },
      transport,
    );
    const result = await adapter.run(configuration(), RUN_OPTIONS);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("ok");
    expect(result.stdoutDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(calls[0]).toMatch(/^create:zeck-env-[0-9a-f]{24}:cold$/);
    expect(calls[1]).toMatch(/^run:sbx-1:python3$/);
  });

  test("a snapshot-configured adapter restores instead of cold-creating (the snapshot mode)", async () => {
    const { transport, calls } = e2bDouble();
    const adapter = createE2bAdapter(
      {
        adapterRef: "substrate-adapter-01",
        templateId: "tpl-e2b",
        snapshotId: "snap-77",
        nowEpochMs: now,
      },
      transport,
    );
    await adapter.run(configuration(), RUN_OPTIONS);
    expect(calls[0]).toMatch(/^create:zeck-env-[0-9a-f]{24}:snap-77$/);
  });

  test("the neutral translation: creating→started (NOT ready), running→ready", async () => {
    const booting = e2bDouble({ phase: "creating" });
    const adapter = createE2bAdapter(
      {
        adapterRef: "substrate-adapter-01",
        templateId: "tpl-e2b",
        nowEpochMs: now,
        readinessTimeoutMs: 5000,
      },
      booting.transport,
    );
    const observation = await adapter.observeReadiness({ substrateId: "std-microvm-a" });
    expect(observation.state).toBe("started");
    expect(observation.substrateId).toBe("std-microvm-a");
    expect(observation.observedAtEpochMs).toBe(NOW);
    expect(observation.source).toBe("substrate-probe:substrate-adapter-01");

    const ready = e2bDouble({ phase: "running" });
    const readyAdapter = createE2bAdapter(
      { adapterRef: "substrate-adapter-01", templateId: "tpl-e2b", nowEpochMs: now },
      ready.transport,
    );
    const readyObservation = await readyAdapter.observeReadiness({ substrateId: "std-microvm-a" });
    expect(readyObservation.state).toBe("ready");
  });

  test("an unmappable phase (stopped/not-found) is a PERMANENT typed rejection, never a fabricated observation", async () => {
    for (const phase of ["stopped", "not-found"] as const) {
      const dead = e2bDouble({ phase });
      const adapter = createE2bAdapter(
        { adapterRef: "substrate-adapter-01", templateId: "tpl-e2b", nowEpochMs: now },
        dead.transport,
      );
      await expect(
        adapter.observeReadiness({ substrateId: "std-microvm-a" }),
      ).rejects.toMatchObject({
        failureKind: "permanent",
        name: "SubstrateAdapterError",
      });
    }
  });

  test("a never-ready sandbox fails closed within the bounded readiness wait (transient)", async () => {
    const { transport } = e2bDouble({ phase: "creating" });
    // An ADVANCING clock: every time read crosses the readiness
    // deadline (the bounded wait must terminate fail-closed, never
    // spin forever on a frozen clock).
    let ticks = 0;
    const advanceClock = (): number => {
      ticks += 6000;
      return NOW + ticks;
    };
    const adapter = createE2bAdapter(
      {
        adapterRef: "substrate-adapter-01",
        templateId: "tpl-e2b",
        nowEpochMs: advanceClock,
        readinessTimeoutMs: 5000,
      },
      transport,
    );
    await expect(adapter.run(configuration(), RUN_OPTIONS)).rejects.toMatchObject({
      failureKind: "transient",
    });
  });

  test("transport unreachability is TRANSIENT (the caller's bounded retry budget decides)", async () => {
    const { transport } = e2bDouble({ failCreate: true });
    const adapter = createE2bAdapter(
      { adapterRef: "substrate-adapter-01", templateId: "tpl-e2b", nowEpochMs: now },
      transport,
    );
    await expect(adapter.run(configuration(), RUN_OPTIONS)).rejects.toMatchObject({
      failureKind: "transient",
    });
  });

  test("the adapter declares the neutral runtime identity and microvm isolation", async () => {
    const { transport } = e2bDouble();
    const adapter = createE2bAdapter(
      { adapterRef: "substrate-adapter-01", templateId: "tpl-e2b", nowEpochMs: now },
      transport,
    );
    expect(adapter.adapterRef).toBe("substrate-adapter-01");
    expect(adapter.servesIsolation).toEqual(["microvm"]);
    expect(adapter.runtimeId).toBe("substrate-runtime:substrate-adapter-01");
  });
});

describe("the Daytona adapter (contract double round-trip)", () => {
  test("a cold run round-trips with the neutral result", async () => {
    const { transport } = daytonaDouble();
    const adapter = createDaytonaAdapter(
      { adapterRef: "substrate-adapter-02", nowEpochMs: now },
      transport,
    );
    const result = await adapter.run(configuration(), RUN_OPTIONS);
    expect(result.stdout).toBe("daytona-ok");
    expect(result.exitCode).toBe(0);
  });

  test("the neutral translation: pending→started (NOT ready), running→ready", async () => {
    const pending = daytonaDouble({ phase: "pending" });
    const adapter = createDaytonaAdapter(
      { adapterRef: "substrate-adapter-02", nowEpochMs: now },
      pending.transport,
    );
    expect((await adapter.observeReadiness({ substrateId: "s" })).state).toBe("started");
    const running = daytonaDouble({ phase: "running" });
    const runningAdapter = createDaytonaAdapter(
      { adapterRef: "substrate-adapter-02", nowEpochMs: now },
      running.transport,
    );
    expect((await runningAdapter.observeReadiness({ substrateId: "s" })).state).toBe("ready");
  });

  test("unmappable phases (stopped/archived/not-found) are PERMANENT rejections", async () => {
    for (const phase of ["stopped", "archived", "not-found"] as const) {
      const dead = daytonaDouble({ phase });
      const adapter = createDaytonaAdapter(
        { adapterRef: "substrate-adapter-02", nowEpochMs: now },
        dead.transport,
      );
      await expect(adapter.observeReadiness({ substrateId: "s" })).rejects.toMatchObject({
        failureKind: "permanent",
      });
    }
  });

  test("a snapshot-configured Daytona adapter restores (the snapshot mode)", async () => {
    const calls: string[] = [];
    const transport: DaytonaProviderTransport = {
      async createSandbox(request) {
        calls.push(request.snapshotId ?? "cold");
        return { sandboxId: "day-1" };
      },
      async getSandboxPhase() {
        return { phase: "running" };
      },
      async probeReadiness() {
        return { phase: "running" };
      },
      async runCommand() {
        return { exitCode: 0, stdout: "", stderr: "", timedOut: false, durationMs: 1 };
      },
      async destroySandbox() {},
    };
    const adapter = createDaytonaAdapter(
      { adapterRef: "substrate-adapter-02", snapshotId: "snap-d1", nowEpochMs: now },
      transport,
    );
    await adapter.run(configuration(), RUN_OPTIONS);
    expect(calls).toEqual(["snap-d1"]);
  });

  test("the adapter declares microvm isolation", () => {
    const { transport } = daytonaDouble();
    const adapter = createDaytonaAdapter(
      { adapterRef: "substrate-adapter-02", nowEpochMs: now },
      transport,
    );
    expect(adapter.servesIsolation).toEqual(["microvm"]);
  });
});

describe("the Modal adapter (contract double round-trip)", () => {
  test("the 1:1 lifecycle mapping: created/scheduled/started map verbatim; ready maps to ready", async () => {
    for (const [phase, expected] of [
      ["created", "created"],
      ["scheduled", "scheduled"],
      ["started", "started"],
      ["ready", "ready"],
    ] as const) {
      const double = modalDouble({ phase });
      const adapter = createModalAdapter(
        { adapterRef: "substrate-adapter-04", imageRef: "img", nowEpochMs: now },
        double.transport,
      );
      expect((await adapter.observeReadiness({ substrateId: "s" })).state).toBe(expected);
    }
  });

  test("in-use is NOT ready (a busy environment never grants a free warm collapse)", async () => {
    const busy = modalDouble({ phase: "in-use" });
    const adapter = createModalAdapter(
      { adapterRef: "substrate-adapter-04", imageRef: "img", nowEpochMs: now },
      busy.transport,
    );
    expect((await adapter.observeReadiness({ substrateId: "s" })).state).toBe("started");
  });

  test("terminated is a PERMANENT rejection", async () => {
    const dead = modalDouble({ phase: "terminated" });
    const adapter = createModalAdapter(
      { adapterRef: "substrate-adapter-04", imageRef: "img", nowEpochMs: now },
      dead.transport,
    );
    await expect(adapter.observeReadiness({ substrateId: "s" })).rejects.toMatchObject({
      failureKind: "permanent",
    });
  });

  test("a run waits for the FULL created→ready path (a started sandbox is not enough)", async () => {
    let phase: ModalSandboxPhase = "created";
    const transport: ModalProviderTransport = {
      async createSandbox() {
        return { sandboxId: "mdl-1" };
      },
      async getSandboxPhase() {
        return { phase };
      },
      async probeReadiness() {
        return { phase };
      },
      async runCommand() {
        return { exitCode: 0, stdout: "modal-ok", stderr: "", timedOut: false, durationMs: 5 };
      },
      async terminateSandbox() {},
    };
    // A ticking clock: the sandbox becomes ready after two observations.
    let tick = 0;
    const adapter = createModalAdapter(
      {
        adapterRef: "substrate-adapter-04",
        imageRef: "img",
        readinessTimeoutMs: 5000,
        nowEpochMs: () => {
          tick += 1;
          if (tick === 3) {
            phase = "ready";
          }
          return NOW + tick;
        },
      },
      transport,
    );
    const result = await adapter.run(configuration(), RUN_OPTIONS);
    expect(result.stdout).toBe("modal-ok");
  });

  test("the adapter declares container isolation", () => {
    const { transport } = modalDouble();
    const adapter = createModalAdapter(
      { adapterRef: "substrate-adapter-04", imageRef: "img", nowEpochMs: now },
      transport,
    );
    expect(adapter.servesIsolation).toEqual(["container"]);
  });
});

describe("the self-hosted adapter (the EXISTING seam ride)", () => {
  function runnerDouble(): ContainerRuntimeClient {
    return {
      runtimeId: "container-runner:http://localhost:9090",
      async run() {
        return {
          exitCode: 0,
          timedOut: false,
          stdout: "runner-ok",
          stderr: "",
          stdoutDigest: "a".repeat(64),
          durationMs: 11,
        };
      },
    };
  }

  function probeDouble(phase: "ready" | "starting" | "down"): SelfHostedProbeTransport {
    return {
      async probeReadiness() {
        return { phase };
      },
    };
  }

  test("run() rides the wrapped EXISTING client unchanged (zero new protocol)", async () => {
    const adapter = createSelfHostedAdapter(
      { adapterRef: "substrate-adapter-05", nowEpochMs: now },
      runnerDouble(),
    );
    const result = await adapter.run(configuration(), RUN_OPTIONS);
    expect(result.stdout).toBe("runner-ok");
    expect(adapter.runtimeId).toBe("container-runner:http://localhost:9090");
  });

  test("with a probe: ready→ready, starting→started, down→PERMANENT rejection", async () => {
    const ready = createSelfHostedAdapter(
      { adapterRef: "substrate-adapter-05", nowEpochMs: now },
      runnerDouble(),
      probeDouble("ready"),
    );
    expect((await ready.observeReadiness({ substrateId: "s" })).state).toBe("ready");

    const starting = createSelfHostedAdapter(
      { adapterRef: "substrate-adapter-05", nowEpochMs: now },
      runnerDouble(),
      probeDouble("starting"),
    );
    expect((await starting.observeReadiness({ substrateId: "s" })).state).toBe("started");

    const down = createSelfHostedAdapter(
      { adapterRef: "substrate-adapter-05", nowEpochMs: now },
      runnerDouble(),
      probeDouble("down"),
    );
    await expect(down.observeReadiness({ substrateId: "s" })).rejects.toMatchObject({
      failureKind: "permanent",
    });
  });

  test("WITHOUT a probe: readiness is a typed PERMANENT failure (never fabricated, never assumed)", async () => {
    const adapter = createSelfHostedAdapter(
      { adapterRef: "substrate-adapter-05", nowEpochMs: now },
      runnerDouble(),
    );
    await expect(adapter.observeReadiness({ substrateId: "s" })).rejects.toMatchObject({
      failureKind: "permanent",
      name: "SubstrateAdapterError",
    });
  });

  test("the served isolation classes are deployment-declared (default customer-runner)", () => {
    const defaultAdapter = createSelfHostedAdapter(
      { adapterRef: "substrate-adapter-05", nowEpochMs: now },
      runnerDouble(),
    );
    expect(defaultAdapter.servesIsolation).toEqual(["customer-runner"]);
    const containerRunner = createSelfHostedAdapter(
      {
        adapterRef: "substrate-adapter-05",
        servesIsolation: ["container", "process"],
        nowEpochMs: now,
      },
      runnerDouble(),
    );
    expect(containerRunner.servesIsolation).toEqual(["container", "process"]);
  });
});

describe("the composition-root binding validation", () => {
  test("a matching binding passes; an isolation mismatch is a PERMANENT rejection", async () => {
    const { transport } = e2bDouble();
    const adapter = createE2bAdapter(
      { adapterRef: "substrate-adapter-01", templateId: "tpl", nowEpochMs: now },
      transport,
    );
    expect(() =>
      assertAdapterBinding(adapter, { adapterRef: "substrate-adapter-01", isolation: "microvm" }),
    ).not.toThrow();
    expect(() =>
      assertAdapterBinding(adapter, { adapterRef: "substrate-adapter-01", isolation: "process" }),
    ).toThrow(SubstrateAdapterError);
  });

  test("an adapterRef mismatch is a PERMANENT rejection (no silent weaker substitution)", () => {
    const { transport } = e2bDouble();
    const adapter = createE2bAdapter(
      { adapterRef: "substrate-adapter-01", templateId: "tpl", nowEpochMs: now },
      transport,
    );
    expect(() =>
      assertAdapterBinding(adapter, { adapterRef: "substrate-adapter-99", isolation: "microvm" }),
    ).toThrow(SubstrateAdapterError);
  });
});

describe("vendor vocabulary confinement (the neutral outputs are vendor-free)", () => {
  const VENDOR_WORDS = [
    "e2b",
    "daytona",
    "modal",
    "firecracker",
    "sandbox-template",
    "warm-pool",
    "directory-snapshot",
  ];

  /** Collect every NEUTRAL shape an adapter can emit across the seam. */
  async function adapterNeutralOutputs(
    adapter: ReturnType<typeof createE2bAdapter>,
  ): Promise<unknown[]> {
    return [
      await adapter.run(configuration(), RUN_OPTIONS),
      await adapter.observeReadiness({ substrateId: "std-substrate-x" }),
      adapter.runtimeId,
      adapter.adapterRef,
      adapter.servesIsolation,
    ];
  }

  test("no vendor vocabulary crosses the adapter seam in any neutral output", async () => {
    // The doubles' provider-returned data is vendor-free here so the
    // assertion covers EVERY neutral shape the adapters emit — the
    // constructed fields (runtimeId, adapterRef, source, states) and
    // the passthrough fields alike prove the adapters ADD nothing.
    const outputs: unknown[] = [];
    outputs.push(
      ...(await adapterNeutralOutputs(
        createE2bAdapter(
          {
            adapterRef: "substrate-adapter-01",
            templateId: "tpl",
            snapshotId: "snap",
            nowEpochMs: now,
          },
          e2bDouble().transport,
        ),
      )),
    );
    outputs.push(
      ...(await adapterNeutralOutputs(
        createDaytonaAdapter(
          { adapterRef: "substrate-adapter-02", snapshotId: "snap", nowEpochMs: now },
          daytonaDouble({ stdout: "ok" }).transport,
        ),
      )),
    );
    outputs.push(
      ...(await adapterNeutralOutputs(
        createModalAdapter(
          {
            adapterRef: "substrate-adapter-04",
            imageRef: "img",
            snapshotRef: "snap",
            nowEpochMs: now,
          },
          modalDouble({ stdout: "ok" }).transport,
        ),
      )),
    );
    outputs.push(
      ...(await adapterNeutralOutputs(
        createSelfHostedAdapter(
          { adapterRef: "substrate-adapter-05", nowEpochMs: now },
          {
            runtimeId: "container-runner:unit",
            async run() {
              return {
                exitCode: 0,
                timedOut: false,
                stdout: "ok",
                stderr: "",
                stdoutDigest: "a".repeat(64),
                durationMs: 11,
              };
            },
          },
          { probeReadiness: async () => ({ phase: "ready" as const }) },
        ),
      )),
    );
    const serialized = JSON.stringify(outputs).toLowerCase();
    for (const word of VENDOR_WORDS) {
      expect(serialized, `the neutral outputs must not carry "${word}"`).not.toContain(word);
    }
  });

  test("a runtime garbage phase (an unknown provider state) is a PERMANENT fail-closed rejection, never a passthrough", async () => {
    // The transport contract is typed, but a misbehaving provider
    // client can still emit an unmapped value at runtime — the
    // translation tables must be TOTAL and fail closed.
    const garbage = { phase: "something-new" } as unknown as { phase: E2bSandboxPhase };
    const transport: E2bProviderTransport = {
      async createSandbox() {
        return { sandboxId: "sbx-1" };
      },
      async getSandboxPhase() {
        return garbage;
      },
      async probeReadiness() {
        return garbage;
      },
      async runCommand() {
        return { exitCode: 0, stdout: "", stderr: "", timedOut: false, durationMs: 1 };
      },
      async destroySandbox() {},
    };
    const adapter = createE2bAdapter(
      { adapterRef: "substrate-adapter-01", templateId: "tpl", nowEpochMs: now },
      transport,
    );
    await expect(adapter.observeReadiness({ substrateId: "std-microvm-a" })).rejects.toMatchObject({
      failureKind: "permanent",
      name: "SubstrateAdapterError",
    });
  });
});
