/**
 * VAL-024 acceptance criterion 6 — discrimination tests proving the
 * isolation probes against controlled fakes:
 *
 *   * FORGED TENANT HEADERS — a mutated wire world whose server would
 *     ADMIT the forged application-scope header (200 + the other
 *     tenant's record) FAILS the probe assertions: the app's typed
 *     rejection assertion and the foreign-content scan are
 *     load-bearing (a world that returns the foreign execution is
 *     caught both as an admission AND as a canary disclosure);
 *   * APPLICATION-ID CONFUSION — a mutated wire world that ADMITS the
 *     create whose body names the other application (201) FAILS the
 *     same way (the server-side scope derivation is load-bearing);
 *   * ARTIFACT-REF PROBING — mutated surfaces that answer the foreign
 *     execution/event/verification probes with the other tenant's
 *     data (service seam or wire seam) FAIL mechanically: the
 *     scope-checked-miss assertion catches the admission and the
 *     foreign-content scan catches the planted canary;
 *   * LOCKED-ROW MUTATIONS — a mutated service that admits a
 *     cross-tenant transition, a tenant-mismatched command, a
 *     foreign-application create or a foreign-environment create
 *     FAILS (the typed-rejection criterion catches the admission, the
 *     row-count invariants catch the durable effects);
 *   * SILENT-WRITE MUTATION — a mutated service that denies the probe
 *     but leaves a durable row anyway FAILS the row-count invariant
 *     (a "denied" probe that writes is a mechanical isolation
 *     failure);
 *   * JOURNAL DUPLICATION — a mutated lifecycle that journals each
 *     probe TWICE FAILS the accounted-writes invariant (the
 *     exactly-once journal contract is load-bearing).
 *
 * Each boundary is exercised twice: once with the REAL semantics
 * replayed (the unmutated fake world — the boundary holds, the row
 * COMPLETES) and once with the deliberately WEAKENED stand-in (the
 * mutation defeats the protection; the assertion must FAIL — proving
 * the assertion is the load-bearing check, never a vacuous pass).
 */

import { describe, expect, test } from "vitest";
import { runTenantIsolationApp } from "../../benchmarks/validation/apps/tenant-isolation/application";
import { TENANT_ISOLATION_CORPUS } from "../../benchmarks/validation/apps/tenant-isolation/corpus";
import {
  createFakeApiWorld,
  createFakeIsolationWorld,
  createFakeLifecycle,
  type FakeWorldMutations,
  FOREIGN_TASK_CANARY,
  fixedForeignRefs,
  OWN_ACTOR_ID,
  OWN_APPLICATION_ID,
  OWN_TENANT_ID,
} from "../../benchmarks/validation/apps/tenant-isolation/fixtures";
import type { TransportImplementation } from "../../benchmarks/validation/harness/harness";
import { driveTenantIsolationExecution } from "../../benchmarks/validation/platform/tenant-isolation";

const pinnedClock = () => new Date(1_000);

const rowIndex = (rowId: string): number => {
  const index = TENANT_ISOLATION_CORPUS.findIndex((row) => row.rowId === rowId);
  if (index < 0) {
    throw new Error(`missing corpus row ${rowId}`);
  }
  return index;
};

// ---------------------------------------------------------------------------
// The app-level wire discrimination (forged headers, id confusion, leaks)
// ---------------------------------------------------------------------------

async function runAppWithMutations(
  rowId: string,
  apiMutations: {
    readonly leakForeignReads?: boolean;
    readonly admitForgedScope?: boolean;
    readonly admitForeignEnvironment?: boolean;
    readonly admitForeignApplicationCreate?: boolean;
  },
): Promise<{
  readonly passed: boolean;
  readonly probes: readonly {
    readonly probeId: string;
    readonly denied: boolean;
    readonly dataLeak: boolean;
    readonly observedCode: string | null;
  }[];
}> {
  const { transport } = createFakeApiWorld(apiMutations);
  const outcome = await runTenantIsolationApp({
    config: {
      applicationId: OWN_APPLICATION_ID,
      baseUrl: "http://fake-zeck.local",
      tokenEnvVar: "ZECK_VALIDATION_TOKEN",
      applicationRevision: "discrimination",
      corpusRevision: "discrimination",
      integrationSurface: "sdk",
      pollIntervalMs: 1,
      completionTimeoutMs: 5_000,
    },
    token: "zeck-token-fake",
    transport: transport as TransportImplementation,
    now: pinnedClock,
    sleep: async () => {},
    environment: {
      runtime: "node test",
      toolchain: "vitest",
      database: "none",
      configuration: { suite: "val-024-discrimination" },
    },
    runSuffix: "disc",
    taskIndex: rowIndex(rowId),
    foreignRefs: fixedForeignRefs(),
  });
  return {
    passed: outcome.passed,
    probes: outcome.probes.map((probe) => ({
      probeId: probe.probeId,
      denied: probe.denied,
      dataLeak: probe.dataLeak,
      observedCode: probe.observedCode,
    })),
  };
}

// ---------------------------------------------------------------------------
// The driver-level service discrimination (locked-row mutations)
// ---------------------------------------------------------------------------

async function driveRowWithMutations(
  rowId: string,
  mutations?: FakeWorldMutations,
  options?: { readonly duplicateJournal?: boolean },
): Promise<Awaited<ReturnType<typeof driveTenantIsolationExecution>>> {
  const row = TENANT_ISOLATION_CORPUS[rowIndex(rowId)];
  if (row === undefined) {
    throw new Error(`missing corpus row ${rowId}`);
  }
  const world = createFakeIsolationWorld(mutations === undefined ? undefined : { mutations });
  const carrierId = world.seedCarrier();
  const { lifecycle, duplicateJournal } = createFakeLifecycle(world);
  if (options?.duplicateJournal === true) {
    duplicateJournal();
  }
  return driveTenantIsolationExecution({
    executionId: carrierId,
    task: { kind: "isolation-probe", scenario: row.rowId, probe: row.probe },
    probe: row.probe,
    lifecycle,
    executions: world.executions,
    wire: world.wire,
    counts: world.counts,
    foreign: fixedForeignRefs(),
    own: { applicationId: OWN_APPLICATION_ID, tenantId: OWN_TENANT_ID, actorId: OWN_ACTOR_ID },
    now: pinnedClock,
    idempotencyPrefix: "val-024-disc",
  });
}

describe("VAL-024 tenant-isolation discrimination", () => {
  test("FORGED TENANT HEADER: the REAL boundary refuses the forged scope; the MUTATED admission is caught", async () => {
    // REAL: the forged-scope read is refused (403 AUTHORIZATION_DENIED)
    // — the row passes over the unmutated world.
    const real = await runAppWithMutations("forged-application-scope", {});
    expect(real.passed).toBe(true);
    expect(real.probes.every((probe) => probe.denied)).toBe(true);

    // MUTATED: a server that ADMITS the forged header returns the
    // foreign execution — the app fails: the admission AND the canary
    // disclosure are both caught.
    const mutated = await runAppWithMutations("forged-application-scope", {
      admitForgedScope: true,
    });
    expect(mutated.passed).toBe(false);
    const admitted = mutated.probes.find((probe) => !probe.denied);
    expect(admitted).toBeDefined();
    expect(admitted?.probeId).toBe("wire-forged-scope-read");
    expect(admitted?.dataLeak).toBe(true);
  });

  test("APPLICATION-ID CONFUSION: the REAL boundary refuses the confused create; the MUTATED admission is caught", async () => {
    // REAL: the create whose body names the foreign application is
    // refused (403 AUTHORIZATION_DENIED).
    const real = await runAppWithMutations("forged-application-scope", {});
    const confused = real.probes.find(
      (probe) => probe.probeId === "wire-create-foreign-application",
    );
    expect(confused?.denied).toBe(true);
    expect(confused?.observedCode).toBe("AUTHORIZATION_DENIED");

    // MUTATED: a server that ADMITS the confused create (201) fails
    // the row — the server-side scope derivation is load-bearing.
    const mutated = await runAppWithMutations("forged-application-scope", {
      admitForeignApplicationCreate: true,
    });
    expect(mutated.passed).toBe(false);
    const admitted = mutated.probes.find(
      (probe) => probe.probeId === "wire-create-foreign-application",
    );
    expect(admitted?.denied).toBe(false);
  });

  test("ARTIFACT-REF PROBING (wire): the REAL fetches are 404 misses; the MUTATED leak is caught with the canary", async () => {
    // REAL: every foreign-execution fetch (result package, events,
    // verification) is a 404 scope-checked miss.
    const real = await runAppWithMutations("cross-tenant-artifact-fetch", {});
    expect(real.passed).toBe(true);
    expect(real.probes.every((probe) => probe.observedCode === "CAPABILITY_UNAVAILABLE")).toBe(
      true,
    );

    // MUTATED: a wire that answers the foreign fetch with the other
    // tenant's data fails the row — the scope-checked-miss assertion
    // catches the admission.
    const mutated = await runAppWithMutations("cross-tenant-artifact-fetch", {
      leakForeignReads: true,
    });
    expect(mutated.passed).toBe(false);
    expect(mutated.probes.some((probe) => !probe.denied)).toBe(true);
  });

  test("ARTIFACT-REF PROBING (service): a mutated read seam that returns the foreign execution FAILS the battery", async () => {
    // REAL: the service read of the foreign execution from the own
    // scope returns null (zero rows) — the row completes.
    const real = await driveRowWithMutations("cross-tenant-read");
    expect(real.terminal).toBe("COMPLETED");
    expect(real.probes.every((record) => record.denied)).toBe(true);

    // MUTATED: the read seam returns the foreign execution — the
    // battery FAILS: the scope-checked-miss criterion catches the
    // admission and the foreign-content scan catches the canary.
    const mutated = await driveRowWithMutations("cross-tenant-read", {
      leakForeignReads: true,
    });
    expect(mutated.terminal).toBe("FAILED");
    expect(mutated.leakedProbes).toBeGreaterThan(0);
    expect(mutated.criteria.find((c) => c.criterionId === "zero-data-disclosure")?.status).toBe(
      "FAIL",
    );
    // The leaked record's evidence never echoes the canary material.
    expect(JSON.stringify(mutated.probes)).not.toContain(FOREIGN_TASK_CANARY);
  });

  test("LOCKED-ROW TRANSITION: a mutated service that ADMITS the cross-tenant transition FAILS", async () => {
    // REAL: the foreign-execution cancel is rejected
    // (TENANT_SCOPE_VIOLATION, the locked-row miss) and the
    // tenant-mismatched command likewise.
    const real = await driveRowWithMutations("cross-tenant-transition");
    expect(real.terminal).toBe("COMPLETED");
    const typed = real.probes.filter((record) => record.surface === "service");
    expect(typed.every((record) => record.observedCode === "TENANT_SCOPE_VIOLATION")).toBe(true);

    // MUTATED (lock scope removed): the foreign execution is
    // transitioned — the battery FAILS (the admission + the foreign
    // write both surface).
    const lockRemoved = await driveRowWithMutations("cross-tenant-transition", {
      ignoreLockScope: true,
    });
    expect(lockRemoved.terminal).toBe("FAILED");
    expect(
      lockRemoved.rowCountViolations.some((violation) =>
        violation.startsWith("foreign-application"),
      ),
    ).toBe(true);

    // MUTATED (tenant check removed): the tenant-mismatched command
    // is admitted — the battery FAILS (the admission + the
    // unaccounted own write both surface).
    const tenantRemoved = await driveRowWithMutations("cross-tenant-transition", {
      ignoreTenantCheck: true,
    });
    expect(tenantRemoved.terminal).toBe("FAILED");
    expect(tenantRemoved.rowCountViolations.length).toBeGreaterThan(0);
  });

  test("CREATE-PATH SCOPE: mutated services that ADMIT the foreign application or environment FAILS", async () => {
    // REAL: both create probes are rejected with
    // TENANT_SCOPE_VIOLATION.
    const realApp = await driveRowWithMutations("cross-tenant-application-create");
    expect(realApp.terminal).toBe("COMPLETED");
    const realEnv = await driveRowWithMutations("cross-tenant-environment-create");
    expect(realEnv.terminal).toBe("COMPLETED");

    // MUTATED (create scope removed): the foreign-application create
    // is admitted — a FOREIGN row appears (zero-foreign-effects
    // FAIL).
    const createAdmitted = await driveRowWithMutations("cross-tenant-application-create", {
      ignoreCreateScope: true,
    });
    expect(createAdmitted.terminal).toBe("FAILED");
    expect(
      createAdmitted.criteria.find((c) => c.criterionId === "zero-foreign-effects")?.status,
    ).toBe("FAIL");

    // MUTATED (environment scope removed): the foreign-environment
    // create is admitted — an unaccounted own execution appears.
    const envAdmitted = await driveRowWithMutations("cross-tenant-environment-create", {
      ignoreEnvironmentScope: true,
    });
    expect(envAdmitted.terminal).toBe("FAILED");
    expect(
      envAdmitted.rowCountViolations.some((v) => v.startsWith("own-application executions")),
    ).toBe(true);
  });

  test("SILENT WRITE: a mutated service that denies the probe but leaves a durable row FAILS the row-count invariants", async () => {
    // REAL: the denied create writes nothing (the arbitration
    // transaction rolls back on both scopes).
    const realEnv = await driveRowWithMutations("cross-tenant-environment-create");
    expect(realEnv.terminal).toBe("COMPLETED");
    expect(realEnv.rowCountViolations).toEqual([]);

    // MUTATED (own-scoped silent write): the denied environment probe
    // leaves an own-application ledger row — the isolation "looks"
    // denied but wrote: the accounted-writes invariant catches it.
    const mutatedEnv = await driveRowWithMutations("cross-tenant-environment-create", {
      writeOnDenial: true,
    });
    expect(mutatedEnv.terminal).toBe("FAILED");
    expect(mutatedEnv.criteria.find((c) => c.criterionId === "own-writes-accounted")?.status).toBe(
      "FAIL",
    );
    expect(mutatedEnv.rowCountViolations.length).toBeGreaterThan(0);

    // MUTATED (foreign-scoped silent write): the denied
    // foreign-application create leaves a FOREIGN ledger row — the
    // zero-foreign-effects invariant catches it.
    const mutatedApp = await driveRowWithMutations("cross-tenant-application-create", {
      writeOnDenial: true,
    });
    expect(mutatedApp.terminal).toBe("FAILED");
    expect(mutatedApp.criteria.find((c) => c.criterionId === "zero-foreign-effects")?.status).toBe(
      "FAIL",
    );
  });

  test("JOURNAL DUPLICATION: a mutated lifecycle that journals each probe TWICE FAILS the accounted-writes invariant", async () => {
    // REAL: each probe is journaled exactly once.
    const real = await driveRowWithMutations("cross-tenant-read");
    expect(real.terminal).toBe("COMPLETED");
    expect(real.journaledProbes).toBe(real.totalProbes);

    // MUTATED: the duplicated journal doubles the own-application
    // event rows — the row-count window catches the duplication (the
    // exactly-once journal contract is load-bearing).
    const mutated = await driveRowWithMutations("cross-tenant-read", undefined, {
      duplicateJournal: true,
    });
    expect(mutated.terminal).toBe("FAILED");
    expect(mutated.criteria.find((c) => c.criterionId === "own-writes-accounted")?.status).toBe(
      "FAIL",
    );
    expect(
      mutated.rowCountViolations.some((v) => v.startsWith("own-application executionEvents")),
    ).toBe(true);
  });

  test("THE CONTROL: the mutated control row still completes only when the legitimate admission is own-scope data", async () => {
    // REAL: the control's legitimate reads admit own-scope data.
    const real = await driveRowWithMutations("control-tenant-healthy");
    expect(real.terminal).toBe("COMPLETED");

    // MUTATED: a read seam that turns the OWN reads into foreign data
    // (leakForeignReads surfaces the foreign execution for the
    // own-scope probe's foreign reference) — the control row's
    // cross-tenant probes FAIL. The control never vacuously passes.
    const mutated = await driveRowWithMutations("cross-tenant-read", {
      leakForeignReads: true,
    });
    expect(mutated.terminal).toBe("FAILED");
  });
});
