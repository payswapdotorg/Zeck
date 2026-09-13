/**
 * The tenant-isolation isolation-probe corpus (VAL-024, AC1): the
 * declared rows of the isolation application. Per row: the isolation
 * probe family (cross-tenant read, cross-tenant transition,
 * cross-tenant artifact fetch, cross-application state probe — plus
 * the create-path probes, the journaling-path probes, the
 * forged-scope family and the false-positive control) and the
 * expected typed rejection on each surface:
 *
 *   * the SERVICE surface (the executions service — the store's
 *     locked-row discipline): TENANT_SCOPE_VIOLATION for every
 *     cross-tenant create/transition/planning/step-event probe; the
 *     scope-checked miss (zero rows, never data) for every read;
 *   * the WIRE surface (the public API — the server-side scope
 *     derivation): TENANT_SCOPE_VIOLATION 403 for the
 *     foreign-environment create, AUTHORIZATION_DENIED 403 for the
 *     forged application scope and the foreign-application create
 *     confusion, CAPABILITY_UNAVAILABLE 404 (the scope-checked miss —
 *     indistinguishable from missing) for every foreign-execution
 *     read/cancel/fetch.
 *
 * Every offline row is deterministically reproducible with zero
 * network and zero credentials: the isolation probes need NO provider
 * (the scope checks are pre-dispatch — nothing is dispatched, nothing
 * is executed, nothing is written). There are no live-gated rows in
 * this corpus: the system under test is the platform's OWN row
 * scoping, which needs no external rail.
 */

import {
  type IsolationProbeKind,
  type IsolationRejectionSummary,
  type PlannedIsolationProbe,
  planIsolationProbes,
} from "../../platform/tenant-isolation";

/** The per-row contract: the probe family and its expected typed rejection. */
export interface IsolationCorpusRow {
  readonly rowId: string;
  /** AC1: the isolation probe family this row exercises. */
  readonly probe: IsolationProbeKind;
  readonly description: string;
  /** AC1: the expected typed rejection per surface. */
  readonly expectedRejection: {
    /** The service-surface boundary (the locked-row checks). */
    readonly service: IsolationRejectionSummary;
    /** The wire-surface boundary (the public API). */
    readonly wire: IsolationRejectionSummary;
  };
  readonly expected: {
    /**
     * The carrier's terminal: COMPLETED when the battery proved the
     * isolation (every probe denied with its expected typed rejection,
     * zero data disclosure, zero effects); FAILED when any probe was
     * admitted, leaked content or wrote (the honest failure, never a
     * fabricated isolation).
     */
    readonly terminal: "COMPLETED" | "FAILED";
  };
  readonly source: string;
}

/** The pinned corpus: ten isolation-probe rows (the full probe vocabulary). */
export const TENANT_ISOLATION_CORPUS: readonly IsolationCorpusRow[] = [
  {
    rowId: "cross-tenant-application-create",
    probe: "cross-tenant:create-application",
    description:
      "A tenant submitting work that references another tenant's APPLICATION: the create " +
      "is rejected by the service's application-tenant check (TENANT_SCOPE_VIOLATION — the " +
      "locked-row family's create-side boundary) before any durable write (the idempotency " +
      "arbitration rolls back with it).",
    expectedRejection: { service: "TENANT_SCOPE_VIOLATION", wire: "NOT_APPLICABLE" },
    expected: { terminal: "COMPLETED" },
    source: "the execution service's create-path application-tenant check",
  },
  {
    rowId: "cross-tenant-environment-create",
    probe: "cross-tenant:create-environment",
    description:
      "A tenant submitting work that references another application's ENVIRONMENT: the " +
      "create is rejected by the environment-ownership check (TENANT_SCOPE_VIOLATION) on " +
      "BOTH surfaces — the typed scope violation is public: the customer's own wire request " +
      "gets the same typed rejection, never an execution, never data.",
    expectedRejection: { service: "TENANT_SCOPE_VIOLATION", wire: "TENANT_SCOPE_VIOLATION" },
    expected: { terminal: "COMPLETED" },
    source: "the execution service's create-path environment-ownership check",
  },
  {
    rowId: "cross-tenant-read",
    probe: "cross-tenant:read",
    description:
      "A tenant reading another tenant's execution: the store's application-scoped read " +
      "returns no row (the scope-checked miss — zero rows, never data); the public wire " +
      "maps the miss to 404 CAPABILITY_UNAVAILABLE, indistinguishable from a missing " +
      "execution — the other tenant's content never crosses the boundary.",
    expectedRejection: { service: "SCOPE_CHECKED_MISS", wire: "CAPABILITY_UNAVAILABLE" },
    expected: { terminal: "COMPLETED" },
    source: "the execution store's application-scoped read queries",
  },
  {
    rowId: "cross-tenant-transition",
    probe: "cross-tenant:transition",
    description:
      "A tenant transitioning another tenant's execution (cancel): the store's locked-row " +
      "discipline rejects the command with TENANT_SCOPE_VIOLATION — a foreign execution " +
      "locks no row in this application; a tenant-mismatched command on an own execution " +
      "is rejected likewise (the locked row's tenant wins). The wire's scope-checked miss " +
      "maps to 404 before the command ever reaches the lifecycle.",
    expectedRejection: { service: "TENANT_SCOPE_VIOLATION", wire: "CAPABILITY_UNAVAILABLE" },
    expected: { terminal: "COMPLETED" },
    source: "the execution store's locked-row transition discipline",
  },
  {
    rowId: "cross-tenant-artifact-fetch",
    probe: "cross-tenant:artifact-fetch",
    description:
      "A tenant fetching another tenant's result package, event ledger and verification " +
      "evidence (the artifact-ref probing shape): every fetch is a scope-checked miss on " +
      "both surfaces (zero rows / 404) — the other tenant's artifacts, evidence and " +
      "ledger rows never cross the boundary.",
    expectedRejection: { service: "SCOPE_CHECKED_MISS", wire: "CAPABILITY_UNAVAILABLE" },
    expected: { terminal: "COMPLETED" },
    source: "the execution store's application-scoped event/verification queries",
  },
  {
    rowId: "cross-tenant-step-event",
    probe: "cross-tenant:step-event",
    description:
      "A tenant journaling step events (artifact references, tool-surface observations) " +
      "against another tenant's execution: the locked-row discipline rejects the journal " +
      "write with TENANT_SCOPE_VIOLATION — a foreign execution accepts no step event, " +
      "and a tenant-mismatched actor journals nothing.",
    expectedRejection: { service: "TENANT_SCOPE_VIOLATION", wire: "NOT_APPLICABLE" },
    expected: { terminal: "COMPLETED" },
    source: "the execution service's step-event locked-row checks",
  },
  {
    rowId: "cross-tenant-planning-decision",
    probe: "cross-tenant:planning-decision",
    description:
      "A tenant recording planning decisions on another tenant's execution: the " +
      "locked-row discipline rejects the decision with TENANT_SCOPE_VIOLATION — no " +
      "foreign planning evidence ever lands on another tenant's ledger.",
    expectedRejection: { service: "TENANT_SCOPE_VIOLATION", wire: "NOT_APPLICABLE" },
    expected: { terminal: "COMPLETED" },
    source: "the execution service's planning-decision locked-row checks",
  },
  {
    rowId: "cross-application-state-probe",
    probe: "cross-application:state-probe",
    description:
      "One application's fixture state, evidence and ledger rows leaking into another's: " +
      "the forward reads (own scope, foreign execution) AND the reverse reads (foreign " +
      "scope, own execution) are all scope-checked misses (zero rows); the row-count " +
      "invariants verify both applications' durable rows are untouched by the battery.",
    expectedRejection: { service: "SCOPE_CHECKED_MISS", wire: "CAPABILITY_UNAVAILABLE" },
    expected: { terminal: "COMPLETED" },
    source: "the execution store's application-scoped queries (both directions)",
  },
  {
    rowId: "forged-application-scope",
    probe: "cross-tenant:forged-scope",
    description:
      "A forged application-scope header (a client constructed with the other " +
      "application's scope) and an application-id confusion (a create whose body names " +
      "the other application): the server-side scope derivation refuses both — " +
      "AUTHORIZATION_DENIED 403, no membership, no data, no writes. The header never " +
      "authorizes by itself.",
    expectedRejection: { service: "NOT_APPLICABLE", wire: "AUTHORIZATION_DENIED" },
    expected: { terminal: "COMPLETED" },
    source: "the auth scope resolver's server-side derivation",
  },
  {
    rowId: "control-tenant-healthy",
    probe: "control:healthy",
    description:
      "The false-positive control: the SAME tenant's legitimate flow — the carrier's own " +
      "reads return its own data (own-scope admission), the app's own submission " +
      "completes. The scope checks never block legitimate same-tenant access.",
    expectedRejection: { service: "OWN_SCOPE_DATA", wire: "NOT_APPLICABLE" },
    expected: { terminal: "COMPLETED" },
    source: "the legitimate same-tenant access path",
  },
];

/** The offline rows (deterministic — every row of this corpus; no live gates). */
export const OFFLINE_CORPUS_ROWS: readonly IsolationCorpusRow[] = TENANT_ISOLATION_CORPUS;

/** The row for one scenario id (deterministic miss = undefined). */
export function corpusRowByScenario(scenario: string): IsolationCorpusRow | undefined {
  return TENANT_ISOLATION_CORPUS.find((row) => row.rowId === scenario);
}

/** The planned probes of one row (the platform's PURE plan). */
export function plannedProbesForRow(row: IsolationCorpusRow): readonly PlannedIsolationProbe[] {
  return planIsolationProbes(row.probe);
}
