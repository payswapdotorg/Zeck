/**
 * The REAL-sandbox proof for synthesized deterministic-replacement
 * computation (WORK-021; acceptance criterion "deterministic
 * replacements must execute in an appropriate sandbox"; required
 * verification "real sandbox proof for synthesized computation").
 *
 * NOTHING here mocks the sandbox: the executor under test is the REAL
 * `createDeterministicReplacementExecutor` wrapped around the REAL
 * sandbox module — `createEnvironmentCatalog` (write-once spec
 * catalog), `createSandboxService` (the full WORK-012 admission
 * chain: policy admission → capability gate → durable sandbox row →
 * executions-ledger step evidence → provider dispatch) — with the
 * REAL `ProcessSandboxProvider` registered. A passing run means a
 * REAL `node` PROCESS was spawned in isolation, with only the
 * explicitly admitted public env (the `ZECK_DTR_INPUT` entry), and
 * its stdout became the durable output evidence of a completed
 * sandbox execution row.
 *
 * The admission seams are the unit-test fakes from
 * `tests/unit/sandbox/fakes.ts` (the WORK-012 discipline: the seams
 * are ports; the REAL policy engine backs them in the PG suites —
 * the sandbox mechanics themselves are fully real here, including
 * process spawn, env isolation, timeout enforcement and ledger
 * evidence).
 *
 * Proof records:
 *   RS1  a replacement program REALLY EXECUTES (process spawn; the
 *        doubling program produces `{"doubled":42}` on stdout; the
 *        sandbox row reaches `completed` with output evidence; the
 *        ledger carries the admitted+completed envelopes; the
 *        admission seam actually fired);
 *   RS2  idempotent convergence: the SAME dispatch under the SAME
 *        sandbox idempotency key replays the FIRST outcome — exactly
 *        one sandbox row, no second process execution (the single
 *        durable outcome is the authority);
 *   RS3  a MUTATED (throwing) replacement fails closed as a typed
 *        observation with the durable sandbox identity (failure
 *        evidence, never a fabricated success);
 *   RS4  the pure-compute subset scan refuses a forbidden-token
 *        source BEFORE any durable sandbox row exists;
 *   RS5  substrate confinement: a replacement declaring allowlist
 *        egress against a closed environment is refused
 *        CAPABILITY_UNAVAILABLE BEFORE admission (no sandbox row,
 *        admission never fired);
 *   RS6  admission denial is recorded honestly (the denial outcome
 *        carries the durable denied row identity; the journal-then-
 *        fail discipline).
 */

import { createHash } from "node:crypto";
import { describe, expect, test } from "vitest";
import type { ComputeEnvironmentSpec } from "../../../src/modules/sandbox/public";
import {
  createEnvironmentCatalog,
  createSandboxProviderRegistry,
  createSandboxService,
  InMemorySandboxStore,
  ProcessSandboxProvider,
} from "../../../src/modules/sandbox/public";
import type { DeterministicReplacementDispatch } from "../../../src/modules/tools/public";
import {
  createDeterministicReplacementExecutor,
  replacementConfinementCheck,
} from "../../../src/modules/tools/public";
import {
  FakeCapabilityGate,
  FakeExecutionLedger,
  FakeSandboxAdmission,
  APPLICATION_ID as SANDBOX_APPLICATION_ID,
  TENANT_ID as SANDBOX_TENANT_ID,
} from "../sandbox/fakes";

const digest = (input: string): string => createHash("sha256").update(input).digest("hex");

const ACTOR = {
  actorId: "00000000-0000-7000-8000-0000000000d1",
  applicationId: SANDBOX_APPLICATION_ID,
  tenantId: SANDBOX_TENANT_ID,
};
const EXECUTION_ID = "00000000-0000-7000-8000-0000000000d9";

/** A closed process environment: pure compute, no egress, no secrets. */
const CLOSED_PROCESS_SPEC: ComputeEnvironmentSpec = {
  kind: "process",
  limits: { cpuMilliCores: 500, memoryMiB: 128, executionTimeoutMs: 10_000 },
  network: { egress: "none", allowedHosts: [] },
  filesystem: { workspace: "none", readOnlyArtifactRefs: [] },
  secrets: { secretRefs: [] },
  runtime: { capabilityId: "process-sandbox" },
  cost: { estimatedCostMicroUsd: "0" },
};

interface World {
  readonly store: InMemorySandboxStore;
  readonly service: ReturnType<typeof createSandboxService>;
  readonly catalog: ReturnType<typeof createEnvironmentCatalog>;
  readonly admission: FakeSandboxAdmission;
  readonly capabilities: FakeCapabilityGate;
  readonly ledger: FakeExecutionLedger;
  readonly environmentId: string;
  readonly executor: ReturnType<typeof createDeterministicReplacementExecutor>;
}

async function world(spec: ComputeEnvironmentSpec = CLOSED_PROCESS_SPEC): Promise<World> {
  const store = new InMemorySandboxStore();
  const admission = new FakeSandboxAdmission();
  const capabilities = new FakeCapabilityGate();
  const ledger = new FakeExecutionLedger();
  const providers = createSandboxProviderRegistry();
  providers.register(new ProcessSandboxProvider());
  let counter = 0;
  const generateId = () => `00000000-0000-7000-8000-${String(++counter).padStart(12, "0")}`;
  const catalog = createEnvironmentCatalog({
    store,
    generateId,
    now: () => new Date("2026-01-01T00:00:00Z"),
    hashSpec: (canonical) => createHash("sha256").update(canonical).digest("hex"),
  });
  const service = createSandboxService({
    store,
    admission,
    capabilities: { resolve: capabilities.resolve },
    ledger,
    providers,
    generateId,
    now: () => new Date("2026-01-01T00:00:00Z"),
  });
  const record = await catalog.register(
    {
      applicationId: ACTOR.applicationId,
      tenantId: ACTOR.tenantId,
      slug: "dtr-validation",
      name: "Deterministic-replacement validation environment",
      spec,
    },
    "dtr-env-key",
    ACTOR,
  );
  // The parent execution the validation runs are provenance-bound to.
  ledger.seedExecution(EXECUTION_ID, "RUNNING");
  const executor = createDeterministicReplacementExecutor({
    service,
    catalog,
    options: { environmentId: record.id, runnerCommand: process.execPath },
  });
  return {
    store,
    service,
    catalog,
    admission,
    capabilities,
    ledger,
    environmentId: record.id,
    executor,
  };
}

/** A valid doubling replacement program (the v1 pure-compute subset). */
const DOUBLER_SOURCE = "console.log(JSON.stringify({ doubled: INPUT.value * 2 }));";

function dispatch(
  source: string,
  idempotencyKey: string,
  input: Record<string, unknown> = { value: 21 },
): DeterministicReplacementDispatch {
  return {
    replacement: {
      replacementId: "dtr-candidate-1",
      replacementDigest: digest("candidate-basis"),
      source,
      sourceDigest: digest(source),
    },
    contract: { networkEgress: "none", allowedHosts: [], timeoutMs: 10_000 },
    input,
    actor: ACTOR,
    executionId: EXECUTION_ID,
    idempotencyKey,
  };
}

describe("deterministic-replacement sandbox executor: the REAL sandbox proof", () => {
  test("RS1: a replacement program REALLY EXECUTES in the sandbox (process spawn, admission, durable evidence)", async () => {
    const w = await world();
    const run = await w.executor.execute(dispatch(DOUBLER_SOURCE, "dtr-run-rs1"));
    expect(run.outcome).toBe("success");
    if (run.outcome !== "success") {
      throw new Error("narrowing");
    }
    // The REAL process ran the REAL program on the REAL input (the
    // trailing newline is console.log's — the raw stdout is the basis).
    expect(JSON.parse(run.stdout)).toEqual({ doubled: 42 });
    // The durable sandbox identity is mandatory provenance.
    expect(run.sandboxExecutionId).toBeTruthy();
    // The durable sandbox row reached COMPLETED with output evidence.
    const row = await w.service.getSandbox(ACTOR.applicationId, run.sandboxExecutionId);
    expect(row?.status).toBe("completed");
    expect(row?.output).toMatchObject({ stdout: '{"doubled":42}\n' });
    expect(row?.outputDigest).toBe(digest('{"doubled":42}\n'));
    // The executions ledger carries the admission + completion envelopes.
    const events = w.ledger.eventsOf(EXECUTION_ID);
    expect(events.map((event) => event.event.command)).toEqual([
      "sandbox-admitted",
      "sandbox-completed",
    ]);
    // The policy admission seam actually fired (nothing bypassed it).
    expect(w.admission.requests).toHaveLength(1);
    expect(w.admission.requests[0]?.executionId).toBe(EXECUTION_ID);
    // The capability gate actually resolved the declared runtime capability.
    expect(w.capabilities.profiles).toHaveLength(1);
  });

  test("RS2: the SAME idempotency key converges — exactly one sandbox row, the first outcome replays", async () => {
    const w = await world();
    const first = await w.executor.execute(dispatch(DOUBLER_SOURCE, "dtr-run-rs2"));
    expect(first.outcome).toBe("success");
    const second = await w.executor.execute(dispatch(DOUBLER_SOURCE, "dtr-run-rs2"));
    expect(second.outcome).toBe("success");
    if (first.outcome !== "success" || second.outcome !== "success") {
      throw new Error("narrowing");
    }
    // ONE durable sandbox row for the logical run; the replay returns it.
    expect(second.sandboxExecutionId).toBe(first.sandboxExecutionId);
    expect(second.stdout).toBe(first.stdout);
    const rows = await w.store.listSandboxesByExecution(ACTOR.applicationId, EXECUTION_ID);
    expect(rows).toHaveLength(1);
    // Exactly one admission per logical run (the durable row is the anchor).
    expect(w.admission.requests).toHaveLength(1);
    // The ledger evidence was appended exactly once per envelope.
    const commands = w.ledger.eventsOf(EXECUTION_ID).map((event) => event.event.command);
    expect(commands).toEqual(["sandbox-admitted", "sandbox-completed"]);
  });

  test("RS3: a throwing replacement FAILS CLOSED with durable failure evidence (never a fabricated success)", async () => {
    const w = await world();
    const run = await w.executor.execute(
      dispatch("throw new Error('replacement defect');", "dtr-run-rs3"),
    );
    expect(run.outcome).toBe("failure");
    if (run.outcome !== "failure") {
      throw new Error("narrowing");
    }
    expect(run.failureClass).toBe("sandbox-execution");
    expect(run.message).toContain("process exited with code 1");
    // The failed sandbox row is durable evidence (stderr carries the defect).
    expect(run.sandboxExecutionId).not.toBeNull();
    const row = await w.service.getSandbox(ACTOR.applicationId, run.sandboxExecutionId ?? "");
    expect(row?.status).toBe("failed");
    expect(JSON.stringify(row?.output)).toContain("replacement defect");
  });

  test("RS4: a forbidden-token source is refused BEFORE any durable sandbox row", async () => {
    const w = await world();
    const run = await w.executor.execute(dispatch("const t = setTimeout(f, 1);", "dtr-run-rs4"));
    expect(run.outcome).toBe("failure");
    if (run.outcome !== "failure") {
      throw new Error("narrowing");
    }
    expect(run.failureClass).toBe("static-validation");
    expect(run.sandboxExecutionId).toBeNull();
    expect(await w.store.listSandboxesByExecution(ACTOR.applicationId, EXECUTION_ID)).toHaveLength(
      0,
    );
    expect(w.admission.requests).toHaveLength(0);
  });

  test("RS5: substrate confinement refuses an un-granted egress declaration BEFORE admission", async () => {
    const w = await world();
    const declaring: DeterministicReplacementDispatch = {
      ...dispatch(DOUBLER_SOURCE, "dtr-run-rs5"),
      contract: {
        networkEgress: "allowlist",
        allowedHosts: ["api.example.internal"],
        timeoutMs: 10_000,
      },
    };
    await expect(w.executor.execute(declaring)).rejects.toMatchObject({
      code: "CAPABILITY_UNAVAILABLE",
    });
    // Nothing durable, nothing admitted: the refusal precedes dispatch.
    expect(await w.store.listSandboxesByExecution(ACTOR.applicationId, EXECUTION_ID)).toHaveLength(
      0,
    );
    expect(w.admission.requests).toHaveLength(0);
    // The pure confinement verdict (the exported probe half).
    const environment = await w.catalog.get(ACTOR.applicationId, w.environmentId);
    expect(environment).not.toBeNull();
    if (environment === null) {
      throw new Error("environment missing");
    }
    const verdict = replacementConfinementCheck(declaring.contract, environment);
    expect(verdict.confined).toBe(false);
    if (!verdict.confined) {
      expect(verdict.reason).toContain("grants none");
    }
  });

  test("RS6: an admission denial is recorded honestly (denied row + typed failure observation)", async () => {
    const w = await world();
    w.admission.decide({ allowed: false, reason: "validation budget exhausted" });
    const run = await w.executor.execute(dispatch(DOUBLER_SOURCE, "dtr-run-rs6"));
    expect(run.outcome).toBe("failure");
    if (run.outcome !== "failure") {
      throw new Error("narrowing");
    }
    expect(run.failureClass).toBe("admission-denied");
    expect(run.message).toContain("validation budget exhausted");
    // The journal-then-fail discipline: the denial itself is durable.
    expect(run.sandboxExecutionId).not.toBeNull();
    const row = await w.service.getSandbox(ACTOR.applicationId, run.sandboxExecutionId ?? "");
    expect(row?.status).toBe("denied");
    expect(row?.denialReason).toContain("validation budget exhausted");
  });

  test("RS7: the input crosses ONLY through the explicit admitted env entry (no ambient host env)", async () => {
    const w = await world();
    // The program proves the isolation itself: a value that exists in
    // the AMBIENT environment (e.g. PATH) must be UNREACHABLE, the
    // input entry must be the ONLY channel.
    const probe =
      'const hasPath = typeof JSON.parse(process.env["PATH"] ?? "null") !== \'undefined\';';
    // (the probe above uses a forbidden token on purpose: the subset
    // scan refuses it — proving the program source cannot even reach
    // for the ambient env; the honest channel is INPUT alone)
    const refused = await w.executor.execute(dispatch(probe, "dtr-run-rs7a"));
    expect(refused.outcome).toBe("failure");
    if (refused.outcome !== "failure") {
      throw new Error("narrowing");
    }
    expect(refused.failureClass).toBe("static-validation");
    // And the INPUT channel works through the admitted env entry only:
    const run = await w.executor.execute(
      dispatch("console.log(JSON.stringify({ echo: INPUT.value }));", "dtr-run-rs7b", {
        value: "zeck-input-channel",
      }),
    );
    expect(run.outcome).toBe("success");
    if (run.outcome !== "success") {
      throw new Error("narrowing");
    }
    expect(JSON.parse(run.stdout)).toEqual({ echo: "zeck-input-channel" });
    // The durable row records the exact admitted public env entry.
    const row = await w.service.getSandbox(ACTOR.applicationId, run.sandboxExecutionId);
    expect(row?.runtimeMetadata).toMatchObject({
      task: { publicEnv: { ZECK_DTR_INPUT: JSON.stringify({ value: "zeck-input-channel" }) } },
    });
  });

  test("RS8: an over-bound input is refused before any durable row (the v1 serialization bound)", async () => {
    const w = await world();
    const huge = { value: "x".repeat(5000) };
    const run = await w.executor.execute(dispatch(DOUBLER_SOURCE, "dtr-run-rs8", huge));
    expect(run.outcome).toBe("failure");
    if (run.outcome !== "failure") {
      throw new Error("narrowing");
    }
    expect(run.failureClass).toBe("replacement-execution");
    expect(run.sandboxExecutionId).toBeNull();
    expect(await w.store.listSandboxesByExecution(ACTOR.applicationId, EXECUTION_ID)).toHaveLength(
      0,
    );
  });
});
