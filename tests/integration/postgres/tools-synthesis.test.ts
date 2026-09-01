/**
 * Real-PostgreSQL integration — governed tool synthesis end-to-end
 * (WORK-018, TOL-004; checkpoint contracts IDENTITY-IDEMPOTENCY,
 * CONCURRENCY-CRASH-SAFETY, EXECUTION-PROVENANCE,
 * SELF-HOSTING-BOUNDARY).
 *
 * Proves against real PostgreSQL (migrations 0001..0011) and the REAL
 * process provider (the programs execute for real under
 * `process.execPath` inside the governed sandbox):
 *
 *   - migration 0011: the synthesized-program table + physical guards
 *     + the additive sandbox output-evidence column;
 *   - the durable lifecycle: draft → validated → usable with durable
 *     source/digest/test evidence whose per-case records carry REAL
 *     sandbox execution identities, and the sandbox rows carry the
 *     durable output evidence (the program's actual stdout);
 *   - submission idempotency (converge vs. key-reuse) on real SQL
 *     unique-key arbitration;
 *   - physical transition guards (illegal advances, identity-core
 *     immutability, one-write evidence — trigger-enforced);
 *   - application/tenant scope on real rows;
 *   - the FULL governed invocation: bind → invoke through the REAL
 *     tool runtime with the REAL policy admission — a deterministic
 *     synthesized tool computes for real (node), and a policy-denied
 *     synthesized tool is refused at the SAME admission chain
 *     (criterion 5: synthesized code cannot obtain capabilities
 *     beyond policy grants);
 *   - substrate confinement: a program declaring un-granted network
 *     capabilities never becomes usable (durable rejection);
 *   - the fact projection flows into tool-composition learning input
 *     (origin vocabulary).
 */

import { describe, expect, test } from "vitest";
import { validateToolFacts } from "../../../src/modules/learning/public";
import type { ToolContract } from "../../../src/modules/tools/public";
import { definePgSuite } from "./harness";
import { type SynthesisPgWorld, seedSynthesisWorld } from "./tools-synthesis-world";

/** A real deterministic JavaScript program (the v1 pure-compute subset). */
const DOUBLER_SOURCE = "console.log(JSON.stringify({ doubled: INPUT.value * 2 }));";

function synthContract(toolId = "synth-doubler"): ToolContract {
  return {
    toolId,
    version: "1.0.0",
    capability: { id: "arithmetic", kind: "tool", minVersion: "1.0.0" },
    inputSchema: { fields: [{ name: "value", type: "number", required: true }] },
    outputSchema: { fields: [{ name: "doubled", type: "number", required: true }] },
    execution: { deterministic: true, timeoutMs: 10000, idempotent: true },
    sideEffect: "none",
    network: { egress: "none", hosts: [] },
    secrets: { access: "none", refs: [] },
    cost: { estimatedMicroUsd: "0" },
    evidence: { producesArtifacts: false },
  };
}

definePgSuite("tools synthesis (WORK-018) on real PostgreSQL", (ctx) => {
  async function freshWorld(): Promise<SynthesisPgWorld> {
    return seedSynthesisWorld(ctx.port);
  }

  const actorOf = (world: SynthesisPgWorld) => ({
    actorId: world.actor().actorId,
    applicationId: world.applicationId,
    tenantId: world.tenantId,
  });

  async function sqlError(world: SynthesisPgWorld, statement: string): Promise<unknown> {
    try {
      await world.db.execute({ sql: statement, parameters: [] });
      return null;
    } catch (error) {
      return error;
    }
  }

  describe("schema (migration 0011)", () => {
    test("the synthesized-program table, guards and the sandbox output column exist", async () => {
      const world = await freshWorld();
      const table = await world.db.execute<{ column_name: string }>({
        sql: `SELECT column_name FROM information_schema.columns
WHERE table_schema = 'tools' AND table_name = 'synthesized_programs' ORDER BY column_name`,
        parameters: [],
      });
      const columns = table.rows.map((row) => String(row.column_name));
      expect(columns).toContain("source_digest");
      expect(columns).toContain("static_validation");
      expect(columns).toContain("runtime_tests");
      expect(columns).toContain("expires_at");
      const sandboxOutput = await world.db.execute<{ column_name: string }>({
        sql: `SELECT column_name FROM information_schema.columns
WHERE table_schema = 'sandbox' AND table_name = 'sandbox_executions' AND column_name = 'output'`,
        parameters: [],
      });
      expect(sandboxOutput.rows).toHaveLength(1);
      const triggers = await world.db.execute<{ trigger_name: string }>({
        sql: `SELECT trigger_name FROM information_schema.triggers
WHERE event_object_schema = 'tools' AND event_object_table = 'synthesized_programs'`,
        parameters: [],
      });
      const names = triggers.rows.map((row) => String(row.trigger_name));
      expect(names).toContain("synthesized_programs_core_guard");
      expect(names).toContain("synthesized_programs_lifecycle_guard");
      expect(names).toContain("synthesized_programs_no_delete_guard");
    });
  });

  describe("the durable lifecycle", () => {
    test("compile → test → usable with REAL sandbox execution and durable output evidence", async () => {
      const world = await freshWorld();
      const actor = actorOf(world);
      const executionId = await world.seedExecution("RUNNING");

      const submitted = await world.synthesis.submitProgram(
        {
          source: DOUBLER_SOURCE,
          language: "javascript",
          contract: synthContract(),
          testCases: [
            { name: "doubles-two", input: { value: 2 }, expectedOutput: { doubled: 4 } },
            { name: "doubles-five", input: { value: 5 }, expectedOutput: { doubled: 10 } },
          ],
          expiresAt: "2099-01-01T00:00:00Z",
        },
        "synth-lifecycle-1",
        actor,
      );
      expect(submitted.status).toBe("submitted");
      if (submitted.status !== "submitted") return;
      const programId = submitted.program.id;

      const validated = await world.synthesis.compileProgram(programId, actor);
      expect(validated.status).toBe("validated");
      expect(validated.staticValidation?.checks).toContain("v1-language-subset");

      const usable = await world.synthesis.testProgram(programId, actor, executionId);
      expect(usable.status).toBe("usable");
      const cases = usable.runtimeTests?.cases ?? [];
      expect(cases).toHaveLength(2);
      for (const evidence of cases) {
        expect(evidence.status).toBe("passed");
        expect(evidence.sandboxId).not.toBeNull();
        // The referenced sandbox row is COMPLETED and carries the durable
        // OUTPUT evidence — the program's actual stdout (criterion 4).
        const sandboxRow = await world.sandboxService.getSandbox(
          world.applicationId,
          String(evidence.sandboxId),
        );
        expect(sandboxRow?.status).toBe("completed");
        expect(typeof sandboxRow?.output?.stdout).toBe("string");
      }
      // The programs computed for real: 2→4 and 5→10.
      const first = await world.sandboxService.getSandbox(
        world.applicationId,
        String(cases[0]?.sandboxId),
      );
      const second = await world.sandboxService.getSandbox(
        world.applicationId,
        String(cases[1]?.sandboxId),
      );
      expect(JSON.parse(String(first?.output?.stdout))).toEqual({ doubled: 4 });
      expect(JSON.parse(String(second?.output?.stdout))).toEqual({ doubled: 10 });
    });

    test("submission idempotency on real SQL arbitration (converge vs. reuse)", async () => {
      const world = await freshWorld();
      const actor = actorOf(world);
      const base = {
        source: DOUBLER_SOURCE,
        language: "javascript",
        contract: synthContract(),
        testCases: [{ name: "doubles-two", input: { value: 2 }, expectedOutput: { doubled: 4 } }],
        expiresAt: "2099-01-01T00:00:00Z",
      };
      const first = await world.synthesis.submitProgram(base, "synth-idem-key", actor);
      expect(first.status).toBe("submitted");
      const replay = await world.synthesis.submitProgram(base, "synth-idem-key", actor);
      expect(replay.status).toBe("converged");
      if (first.status !== "rejected" && replay.status !== "rejected") {
        expect(replay.program.id).toBe(first.program.id);
      }
      await expect(
        world.synthesis.submitProgram(
          { ...base, source: "console.log(1);" },
          "synth-idem-key",
          actor,
        ),
      ).rejects.toMatchObject({ code: "IDEMPOTENCY_KEY_REUSED" });
    });

    test("physical transition guards: illegal advances, core immutability, one-write evidence, no delete", async () => {
      const world = await freshWorld();
      const actor = actorOf(world);
      const submitted = await world.synthesis.submitProgram(
        {
          source: DOUBLER_SOURCE,
          language: "javascript",
          contract: synthContract(),
          testCases: [{ name: "doubles-two", input: { value: 2 }, expectedOutput: { doubled: 4 } }],
          expiresAt: "2099-01-01T00:00:00Z",
        },
        "synth-guards-1",
        actor,
      );
      if (submitted.status !== "submitted") throw new Error("submission failed");
      const programId = submitted.program.id;

      // draft → usable is illegal (skips the gates).
      const skipGates = await sqlError(
        world,
        `UPDATE tools.synthesized_programs SET status = 'usable' WHERE id = '${programId}'`,
      );
      expect(String((skipGates as Error | null)?.message ?? "")).toContain(
        "cannot move from status",
      );

      // The identity core is immutable: source cannot be rewritten.
      const core = await sqlError(
        world,
        `UPDATE tools.synthesized_programs SET source = 'malicious();' WHERE id = '${programId}'`,
      );
      expect(String((core as Error | null)?.message ?? "")).toContain("identity core is immutable");

      // Rows are never deleted.
      const noDelete = await sqlError(
        world,
        `DELETE FROM tools.synthesized_programs WHERE id = '${programId}'`,
      );
      expect(String((noDelete as Error | null)?.message ?? "")).toContain("never deleted");

      // One-write evidence: a same-status evidence rewrite is refused.
      const compiled = await world.synthesis.compileProgram(programId, actor);
      expect(compiled.status).toBe("validated");
      const rewrite = await sqlError(
        world,
        `UPDATE tools.synthesized_programs SET static_validation = '{"checks":["fake"]}'::jsonb WHERE id = '${programId}'`,
      );
      // A same-status rewrite is refused by the lifecycle guard (the
      // status-preserving transition check) — evidence is one-write.
      const rewriteMessage = String((rewrite as Error | null)?.message ?? "");
      expect(
        rewriteMessage.includes("cannot move from status") ||
          rewriteMessage.includes("exactly once"),
      ).toBe(true);
    });

    test("application/tenant scope on real rows", async () => {
      const world = await freshWorld();
      const actor = actorOf(world);
      const submitted = await world.synthesis.submitProgram(
        {
          source: DOUBLER_SOURCE,
          language: "javascript",
          contract: synthContract(),
          testCases: [{ name: "doubles-two", input: { value: 2 }, expectedOutput: { doubled: 4 } }],
          expiresAt: "2099-01-01T00:00:00Z",
        },
        "synth-scope-1",
        actor,
      );
      if (submitted.status !== "submitted") throw new Error("submission failed");
      const otherApp = "00000000-0000-7000-8000-0000000000ab";
      expect(await world.synthesis.getProgram(otherApp, submitted.program.id)).toBeNull();
      expect(await world.synthesis.listPrograms(otherApp)).toHaveLength(0);
    });
  });

  describe("the governed invocation path", () => {
    test("bind → invoke through the REAL runtime (real node execution + durable evidence)", async () => {
      const world = await freshWorld();
      const actor = world.actor();
      const fullActor = actorOf(world);
      const executionId = await world.seedExecution("RUNNING");

      const submitted = await world.synthesis.submitProgram(
        {
          source: DOUBLER_SOURCE,
          language: "javascript",
          contract: synthContract("synth-doubler"),
          testCases: [{ name: "doubles-two", input: { value: 2 }, expectedOutput: { doubled: 4 } }],
          expiresAt: "2099-01-01T00:00:00Z",
        },
        "synth-invoke-1",
        fullActor,
      );
      if (submitted.status !== "submitted") throw new Error("submission failed");
      const programId = submitted.program.id;
      await world.synthesis.compileProgram(programId, fullActor);
      const usable = await world.synthesis.testProgram(programId, fullActor, executionId);
      expect(usable.status).toBe("usable");
      const bound = await world.synthesis.bindTool(programId, fullActor);
      expect(bound.status).toBe("registered");

      // The invocation goes through the REAL governed runtime: policy →
      // budget → capability admission, then the adapter's sandbox dispatch.
      const result = await world.runtime.invoke(
        {
          applicationId: world.applicationId,
          executionId,
          actor,
          toolId: "synth-doubler",
          input: { value: 21 },
        },
        "synth-invocation-1",
      );
      expect(result.status).toBe("succeeded");
      expect(result.output).toEqual({ doubled: 42 });
      // Durable invocation evidence on the tool axis.
      const stored = await world.toolStore.findById(world.applicationId, result.invocationId);
      expect(stored?.toolId).toBe("synth-doubler");
      expect(stored?.outcomeClass).toBe("tool-success");
    });

    test("criterion 5 (admission layer): a policy-denied synthesized tool is refused at the SAME chain", async () => {
      const world = await freshWorld();
      const actor = world.actor();
      const fullActor = actorOf(world);
      const executionId = await world.seedExecution("RUNNING");

      const submitted = await world.synthesis.submitProgram(
        {
          source: DOUBLER_SOURCE,
          language: "javascript",
          contract: synthContract("synth-policy-tool"),
          testCases: [{ name: "doubles-two", input: { value: 2 }, expectedOutput: { doubled: 4 } }],
          expiresAt: "2099-01-01T00:00:00Z",
        },
        "synth-policy-1",
        fullActor,
      );
      if (submitted.status !== "submitted") throw new Error("submission failed");
      const programId = submitted.program.id;
      await world.synthesis.compileProgram(programId, fullActor);
      await world.synthesis.testProgram(programId, fullActor, executionId);
      await world.synthesis.bindTool(programId, fullActor);

      // The effective policy now DENIES this exact tool identity: the
      // invocation must be refused at admission (journaled denial) —
      // exactly like a built-in tool. No synthesis path bypasses policy.
      await world.policyAuthority.publish({
        id: "default",
        version: 2,
        documents: [
          {
            scope: "platform",
            selector: {},
            restrictions: { tool: { deniedTools: ["synth-policy-tool"] } },
          },
        ],
      });
      // The SAME admission chain refuses the synthesized tool exactly
      // like a built-in: the typed denial is thrown AFTER journaling.
      const denial = await world.runtime
        .invoke(
          {
            applicationId: world.applicationId,
            executionId,
            actor,
            toolId: "synth-policy-tool",
            input: { value: 2 },
          },
          "synth-policy-invocation-1",
        )
        .catch((error: unknown) => error);
      expect((denial as { code?: string }).code).toBe("POLICY_DENIED");
      // The denial is DURABLE evidence (journaled by idempotency key).
      const stored = await world.toolStore.findByKey(
        world.applicationId,
        "synth-policy-invocation-1",
      );
      expect(stored?.status).toBe("denied");
      expect(stored?.denialClass).toBe("policy");
      expect(stored?.toolId).toBe("synth-policy-tool");
    });

    test("criterion 5 (substrate layer): an un-granted network declaration never becomes usable", async () => {
      const world = await freshWorld();
      const fullActor = actorOf(world);
      const executionId = await world.seedExecution("RUNNING");

      // A synthesized program declaring allowlisted network egress: the
      // synthesis environment (closed process) grants none — the runtime
      // tests fail closed at the substrate confinement, and the program
      // is durably REJECTED (never usable, never bindable).
      const netDeclaring: ToolContract = {
        ...synthContract("synth-net-tool"),
        capability: { id: "web-retrieval", kind: "tool", minVersion: "1.0.0" },
        network: { egress: "allowlist", hosts: ["api.example.com"] },
        sideEffect: "write-external",
        execution: { deterministic: false, timeoutMs: 10000, idempotent: false },
      };
      const submitted = await world.synthesis.submitProgram(
        {
          source: DOUBLER_SOURCE,
          language: "javascript",
          contract: netDeclaring,
          testCases: [{ name: "doubles-two", input: { value: 2 }, expectedOutput: { doubled: 4 } }],
          expiresAt: "2099-01-01T00:00:00Z",
        },
        "synth-confine-1",
        fullActor,
      );
      if (submitted.status !== "submitted") throw new Error("submission failed");
      const programId = submitted.program.id;
      await world.synthesis.compileProgram(programId, fullActor);
      const outcome = await world.synthesis.testProgram(programId, fullActor, executionId);
      expect(outcome.status).toBe("rejected");
      expect(outcome.rejection?.phase).toBe("runtime-tests");
      const message = outcome.runtimeTests?.cases[0]?.message ?? "";
      expect(message).toContain("substrate confinement");
      // And no sandbox execution row was ever created for the case.
      expect(outcome.runtimeTests?.cases[0]?.sandboxId).toBeNull();
      // Never bindable.
      await expect(world.synthesis.bindTool(programId, fullActor)).rejects.toMatchObject({
        code: "INVALID_STATE_TRANSITION",
      });
    });
  });

  describe("learning integration", () => {
    test("the fact projection flows into tool-composition learning input", async () => {
      const world = await freshWorld();
      const actor = actorOf(world);
      const executionId = await world.seedExecution("RUNNING");
      const submitted = await world.synthesis.submitProgram(
        {
          source: DOUBLER_SOURCE,
          language: "javascript",
          contract: synthContract("synth-fact-tool"),
          testCases: [{ name: "doubles-two", input: { value: 2 }, expectedOutput: { doubled: 4 } }],
          expiresAt: "2099-01-01T00:00:00Z",
        },
        "synth-facts-1",
        actor,
      );
      if (submitted.status !== "submitted") throw new Error("submission failed");
      await world.synthesis.compileProgram(submitted.program.id, actor);
      await world.synthesis.testProgram(submitted.program.id, actor, executionId);

      const facts = await world.synthesis.synthesizedFacts(world.applicationId);
      expect(facts).toHaveLength(1);
      // The projection validates through the learning module's input
      // vocabulary (origin: synthesized — population segregation).
      const catalog = validateToolFacts([...facts]);
      expect(catalog.facts[0]?.origin).toBe("synthesized");
      expect(catalog.facts[0]?.toolId).toBe("synth-fact-tool");
      // An UNKNOWN origin fails closed in the learning input vocabulary.
      expect(() =>
        validateToolFacts([{ ...(facts[0] as Record<string, unknown>), origin: "vendor" }]),
      ).toThrowError(/origin must be one of the frozen origin vocabulary/);
    });
  });
});
