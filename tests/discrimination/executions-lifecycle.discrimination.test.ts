/**
 * Discrimination: execution single-write-path + completion binding +
 * convergence guard (WORK-006 CRITICAL boundaries; checkpoints
 * EXECUTION-PROVENANCE, IDENTITY-IDEMPOTENCY, IMPLEMENTATION-COMPLETENESS).
 *
 * Every protection here is proven by a mutant that removes it:
 *
 *   R1 RED RECORD (convergence guard removed) — the arbitration that makes
 *      concurrent duplicate creates converge is removed (always-run-work
 *      mutant); the SAME concurrent scenario that the green suites assert
 *      (one identity, one creation event) observes N identities — the
 *      production convergence tests detect exactly this mutation. The
 *      PostgreSQL uniqueness backstop is proven in
 *      executions-concurrency.test.ts (guard PRESENT).
 *
 *   R2 (completion shortcut) — a store mutant that DROPS the verification
 *      binding (returns COMPLETED but persists empty refs) makes the
 *      green completion assertions FAIL (violation observed); on real
 *      PostgreSQL the same shortcut is PHYSICALLY rejected by migration
 *      0004's CHECKs (executions-schema.test.ts). Also: the service
 *      rejects a `pass` without a PASS verification result before any
 *      write (VERIFICATION_FAILED).
 *
 *   R3 (second write path) — synthetic source mutants that add a second
 *      UPDATE executions.executions site (in the application layer / a
 *      second adapter) or call the mutation ports outside the transition
 *      service are REJECTED by the shared scanner — the architecture gate
 *      discriminates (static red records). The physical half (direct SQL
 *      status mutation without an envelope; terminal-row mutation; row
 *      deletion) is rejected by the migration triggers, proven in the
 *      schema suite.
 *
 *   R4 (ledger mutation) — synthetic source mutants adding UPDATE/DELETE
 *      statements against execution_events / verification_results are
 *      rejected by the scanner; the physical UPDATE/DELETE rejection is
 *      proven on real PG in the schema suite.
 */

import { describe, expect, test } from "vitest";
import { PlatformError } from "../../src/shared/errors";
import {
  ACTOR,
  allowAllAuthorization,
  baseCreateInput,
  createInMemoryExecutions,
  InMemoryExecutionsIdempotency,
  transitionScope,
} from "../unit/executions/fakes";
import {
  executionWritePathViolations,
  hasCanonicalWriteSites,
  type WritePathFile,
} from "./lib/execution-write-path";

const APP_ID = "11111111-1111-7000-8000-000000000001";

describe("discrimination: executions convergence guard (R1)", () => {
  test("R1 RED RECORD: guard removed => N concurrent same-key creates produce N identities (green tests detect it)", async () => {
    // Production fake: same-key creates serialize and converge.
    const green = createInMemoryExecutions();
    green.store.seedApplication(APP_ID, ACTOR.tenantId);
    const results = await Promise.all(
      Array.from({ length: 8 }, () =>
        green.service.createExecution(baseCreateInput(APP_ID), "same-key", ACTOR),
      ),
    );
    expect(new Set(results.map((r) => r.executionId)).size).toBe(1);
    expect(green.store.events).toHaveLength(1);

    // MUTANT: the arbitration record is bypassed (always run work) — the
    // convergence guarantee is removed. The SAME scenario now observes
    // multiple durable identities and multiple creation envelopes: the
    // violation the production suites detect.
    const mutantStore = createInMemoryExecutions().store;
    mutantStore.seedApplication(APP_ID, ACTOR.tenantId);
    const mutantIdempotency = new InMemoryExecutionsIdempotency({ alwaysRunWork: true });
    mutantIdempotency.store = mutantStore;
    const mutantWorld = createInMemoryExecutions({
      store: mutantStore,
      idempotency: mutantIdempotency,
    });
    const mutantResults = await Promise.all(
      Array.from({ length: 8 }, () =>
        mutantWorld.service.createExecution(baseCreateInput(APP_ID), "same-key", ACTOR),
      ),
    );
    const observedIdentities = new Set(mutantResults.map((r) => r.executionId)).size;
    expect(observedIdentities).toBe(8); // violation OBSERVED under the mutant
    expect(mutantStore.events).toHaveLength(8);
  });
});

describe("discrimination: completion-verification binding (R2)", () => {
  test("R2: the service rejects a pass without a PASS verification result (no provider/planner shortcut)", async () => {
    const world = createInMemoryExecutions();
    world.store.seedApplication(APP_ID, ACTOR.tenantId);
    const { executionId } = await world.service.createExecution(
      baseCreateInput(APP_ID),
      "c",
      ACTOR,
    );
    // Seed directly into VERIFYING (the only state with a pass edge).
    const row = world.store.executions.get(executionId);
    if (row === undefined) throw new Error("missing row");
    world.store.executions.set(executionId, { ...row, status: "VERIFYING" });

    await expect(
      world.service.transition(
        {
          ...transitionScope(APP_ID, executionId),
          command: "pass",
          verificationResults: [
            { criterionId: "c", strategy: "s", status: "FAIL", recordedBy: "v" },
          ],
        },
        "k-fail-only",
      ),
    ).rejects.toMatchObject({ code: "VERIFICATION_FAILED" });
    await expect(
      world.service.transition(
        { ...transitionScope(APP_ID, executionId), command: "pass", verificationResults: [] },
        "k-empty",
      ),
    ).rejects.toMatchObject({ code: "VERIFICATION_FAILED" });
    expect(world.store.executions.get(executionId)?.status).toBe("VERIFYING"); // unchanged
  });

  test("R2 MUTANT: a store that drops the verification binding produces COMPLETED without refs — the green binding assertion FAILS (observed)", async () => {
    // Mutant: updateExecutionForTransition forgets to persist the
    // verification refs (the persisted binding is lost). The REAL service
    // is wired onto the mutant store.
    const { InMemoryExecutionStore } = await import("../unit/executions/fakes");
    class BindingDroppingStore extends InMemoryExecutionStore {
      override async updateExecutionForTransition(
        input: import("../../src/modules/executions/ports/execution-store").ApplyTransitionInput,
      ) {
        return super.updateExecutionForTransition({ ...input, verificationRefs: [] });
      }
    }
    const mutantStore = new BindingDroppingStore();
    mutantStore.seedApplication(APP_ID, ACTOR.tenantId);
    const mutantIdempotency = new InMemoryExecutionsIdempotency();
    mutantIdempotency.store = mutantStore;
    const world = createInMemoryExecutions({ store: mutantStore, idempotency: mutantIdempotency });
    const { executionId } = await world.service.createExecution(
      baseCreateInput(APP_ID),
      "c",
      ACTOR,
    );
    const row = mutantStore.executions.get(executionId);
    if (row === undefined) throw new Error("missing row");
    mutantStore.executions.set(executionId, { ...row, status: "VERIFYING" });
    const completed = await world.service.transition(
      {
        ...transitionScope(APP_ID, executionId),
        command: "pass",
        verificationResults: [{ criterionId: "c", strategy: "s", status: "PASS", recordedBy: "v" }],
      },
      "k-pass",
    );
    // VIOLATION OBSERVED under the mutant: COMPLETED with an EMPTY durable
    // binding — exactly what the green assertion in the unit + PG suites
    // detects (refs >= 1), and what PostgreSQL rejects physically
    // (executions_completion_requires_verification; proven in the schema
    // suite). The green suites' binding assertions would FAIL here.
    expect(completed.execution.status).toBe("COMPLETED");
    expect(completed.execution.verificationRefs).toHaveLength(0); // mutation observed
    expect(world.store.verificationResults.size).toBe(1); // the evidence row exists — only the BINDING was lost
  });
});

describe("discrimination: single write path + append-only ledger (R3/R4, static scanner)", () => {
  const canonical: WritePathFile[] = [
    {
      path: "src/modules/executions/adapters/sql-execution-store.ts",
      content: `export class SqlExecutionStore {
        async updateExecutionForTransition() { await this.db.execute({ sql: "UPDATE executions.executions SET status = $1" }); }
        async appendEvent() { await this.db.execute({ sql: "INSERT INTO executions.execution_events (id) VALUES ($1)" }); }
      }`,
    },
    {
      path: "src/modules/executions/application/execution-service.ts",
      content:
        "export function createExecutionService() { store.updateExecutionForTransition(x); store.appendEvent(y); }",
    },
    { path: "src/modules/budgets/public.ts", content: "export const x = 1;" },
  ];

  test("R3 MUTANT a: a SECOND UPDATE executions.executions site (application layer) is rejected", () => {
    const mutant: WritePathFile[] = [
      ...canonical,
      {
        path: "src/modules/executions/application/execution-service.ts",
        content:
          "export function createExecutionService() { await tx.execute({ sql: 'UPDATE executions.executions SET status = $1' }); }",
      },
    ];
    // Two update-site FILES now (adapter + application): the alternative
    // writer is flagged.
    const violations = executionWritePathViolations(mutant);
    expect(violations.some((v) => v.startsWith("execution-update-site-files:2"))).toBe(true);
    expect(hasCanonicalWriteSites(mutant)).toBe(true); // sanity: surface present
  });

  test("R3 MUTANT b: the ONLY UPDATE site moved out of the adapter (an alternative writer module) is rejected", () => {
    const mutant: WritePathFile[] = [
      {
        path: "src/modules/executions/application/execution-service.ts",
        content:
          "export function createExecutionService() { await tx.execute({ sql: 'UPDATE executions.executions SET status = $1' }); store.appendEvent(); }",
      },
      {
        path: "src/modules/executions/adapters/sql-execution-store.ts",
        content:
          'async appendEvent() { sql: "INSERT INTO executions.execution_events (id) VALUES ($1)" }',
      },
    ];
    const violations = executionWritePathViolations(mutant);
    expect(violations).toContain(
      "execution-update-site-location:src/modules/executions/application/execution-service.ts",
    );
  });

  test("R3 MUTANT c: an out-of-module writer referencing executions tables is rejected", () => {
    const mutant: WritePathFile[] = [
      ...canonical,
      {
        path: "src/modules/budgets/adapters/sql-budget-store.ts",
        content: "const sql = \"UPDATE executions.executions SET status = 'FAILED'\"",
      },
    ];
    const violations = executionWritePathViolations(mutant);
    expect(violations).toContain(
      "executions-table-referenced-outside-module:src/modules/budgets/adapters/sql-budget-store.ts:executions.executions",
    );
    expect(violations.some((v) => v.startsWith("execution-update-site-files:2"))).toBe(true);
  });

  test("R4 MUTANT: an UPDATE against the event ledger is rejected (append-only gate)", () => {
    const mutant: WritePathFile[] = [
      ...canonical,
      {
        path: "src/modules/executions/adapters/sql-execution-store.ts",
        content: 'async fixEvent() { sql: "UPDATE executions.execution_events SET payload = $1" }',
      },
    ];
    const violations = executionWritePathViolations(mutant);
    expect(violations.some((v) => v.startsWith("event-ledger-mutation-site:"))).toBe(true);
  });

  test("R4 MUTANT: a DELETE against verification results is rejected", () => {
    const mutant: WritePathFile[] = [
      ...canonical,
      {
        path: "src/modules/executions/adapters/sql-execution-store.ts",
        content: 'async purgeVerification() { sql: "DELETE FROM executions.verification_results" }',
      },
    ];
    const violations = executionWritePathViolations(mutant);
    expect(violations.some((v) => v.startsWith("verification-mutation-site:"))).toBe(true);
  });

  test("the canonical shape itself is clean (scanner discriminates, not overfits)", () => {
    expect(executionWritePathViolations(canonical)).toEqual([]);
  });
});

void allowAllAuthorization;
void PlatformError;
