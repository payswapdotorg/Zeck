/**
 * The tenant-isolation corpus (VAL-024, AC1): the declared rows of the
 * isolation application. Per row: the isolation probe family (the
 * cross-tenant read / transition / artifact fetch / cross-application
 * state families the work order names, the create/environment/planning/
 * adoption/forged-scope discrimination families AC6 pins, and the
 * own-tenant control), the target ROLE the probe addresses (the
 * run-time world binds the actual ids — the corpus stays
 * repository-reproducible and secret-free), the platform-side probe
 * operations, the app-side (public SDK) probe and the expected typed
 * rejection per observation.
 *
 * Every row is offline and deterministic: the isolation probes need no
 * provider (the scope checks are pre-dispatch) — the REAL PostgreSQL
 * row-scoping is the system under test at the crown. The inversion the
 * corpus pins: a correctly-denied boundary COMPLETES the probe
 * execution (the denial IS the verified outcome); a disclosed
 * cross-tenant read/transition/artifact fetch would FAIL honestly.
 */

import type {
  ExpectedObservation,
  IsolationOperation,
  IsolationOracle,
  IsolationProbeFamily,
  TypedRejection,
} from "../../platform/tenant-isolation";

/** The target ROLES the run-time world resolves for the probes. */
export const TARGET_ROLES = [
  /** The OTHER tenant's application id (confusion probes). */
  "foreign-application",
  /** The OTHER tenant's environment id (create probes). */
  "foreign-environment",
  /** The OTHER tenant's execution id (read/transition/state probes). */
  "foreign-execution",
  /** The OTHER tenant's artifact digest (artifact probes). */
  "foreign-artifact-digest",
  /** One's OWN submitted execution id (the control). */
  "own-execution",
  /** One's OWN tenant's artifact digest (the control). */
  "own-artifact-digest",
] as const;

export type TargetRole = (typeof TARGET_ROLES)[number];

/** The app-side (public SDK) probe operations. */
export const SDK_PROBE_OPERATIONS = [
  /** GET /executions/:id with the app's own scope, foreign id. */
  "sdk-read-foreign-execution",
  /** POST /executions/:id/cancel with the app's own scope, foreign id. */
  "sdk-cancel-foreign-execution",
  /** GET /executions/:id/events with the app's own scope, foreign id. */
  "sdk-events-foreign-execution",
  /** POST /executions naming the foreign application in the body. */
  "sdk-create-foreign-application",
  /** POST /executions for one's own application naming the foreign environment. */
  "sdk-create-foreign-environment",
  /** A scoped read carrying the forged X-Zeck-Application selector. */
  "sdk-forged-scope-read",
  /** GET /executions/:id with the app's own scope, own id (the control). */
  "sdk-read-own-execution",
] as const;

export type SdkProbeOperation = (typeof SDK_PROBE_OPERATIONS)[number];

/** One row of the tenant-isolation corpus (oracle included). */
export interface IsolationCorpusRow extends IsolationOracle {
  readonly rowId: string;
  readonly description: string;
  /** The target role the row's probes address (run-time resolved). */
  readonly targetRole: TargetRole;
  /** The platform-side probe operations (driven by the crown driver). */
  readonly platformProbes: readonly IsolationOperation[];
  /** The app-side (public SDK) probe (absent on operator-only rows). */
  readonly appProbe?: {
    readonly operation: SdkProbeOperation;
    readonly expected: ExpectedObservation;
  };
  /** Provenance of the boundary the row probes. */
  readonly source: string;
}

/** The typed wire-level denial of the scope-checked miss (the app observes the 404 as a typed rejection). */
const wireMiss = (): ExpectedObservation => ({ kind: "denied", rejection: "SCOPE_CHECKED_MISS" });

const denied = (rejection: TypedRejection): ExpectedObservation => ({
  kind: "denied",
  rejection,
});

const miss = (): ExpectedObservation => ({ kind: "miss", rejection: "SCOPE_CHECKED_MISS" });

const granted = (): ExpectedObservation => ({ kind: "granted", rejection: null });

const oracle = (
  family: IsolationProbeFamily,
  observations: readonly ExpectedObservation[],
  appObservations: readonly ExpectedObservation[],
  zeroForeignRows = true,
): IsolationOracle => ({
  family,
  expected: {
    observations,
    appObservations,
    terminal: "COMPLETED",
    zeroForeignRows,
  },
});

/**
 * The pinned corpus: 10 rows — the four work-order-named families, the
 * five AC6 discrimination families and the own-tenant control.
 */
export const ISOLATION_CORPUS: readonly IsolationCorpusRow[] = [
  {
    rowId: "cross-tenant-read",
    targetRole: "foreign-execution",
    description:
      "A tenant reads another tenant's execution through its own application scope: the app-scoped getter answers the null scope-checked miss (zero rows, zero disclosure) and the public wire answers the 404 indistinguishable miss — never data, never a tenant oracle.",
    platformProbes: ["svc-read-foreign-execution"],
    appProbe: { operation: "sdk-read-foreign-execution", expected: wireMiss() },
    ...oracle("cross-tenant-read", [miss()], [denied("SCOPE_CHECKED_MISS")]),
    source:
      "the executions store's application-scoped getter (every store query bound by application + tenant)",
  },
  {
    rowId: "cross-tenant-transition",
    targetRole: "foreign-execution",
    description:
      "A tenant commands a lifecycle transition against another tenant's execution: the execution store's locked-row check answers the typed TENANT_SCOPE_VIOLATION (missing or owned by another application) — never a state change; the public cancel route answers the 404 indistinguishable miss.",
    platformProbes: ["svc-transition-foreign-execution"],
    appProbe: { operation: "sdk-cancel-foreign-execution", expected: wireMiss() },
    ...oracle(
      "cross-tenant-transition",
      [denied("TENANT_SCOPE_VIOLATION")],
      [denied("SCOPE_CHECKED_MISS")],
    ),
    source:
      "the execution store's locked-row check (lockExecution bound by application + tenant — the typed scope violation the work order names)",
  },
  {
    rowId: "cross-tenant-planning",
    targetRole: "foreign-execution",
    description:
      "A tenant records a planning decision against another tenant's execution: the same locked-row check answers the typed TENANT_SCOPE_VIOLATION before any durable write — the operator-side surface of the boundary (no public route exists for planning decisions).",
    platformProbes: ["svc-planning-foreign-execution"],
    ...oracle("cross-tenant-planning", [denied("TENANT_SCOPE_VIOLATION")], []),
    source:
      "the execution store's locked-row check on the planning-decision command (WORK-002 discipline: scope + state legality always from the locked row)",
  },
  {
    rowId: "cross-tenant-artifact-fetch",
    targetRole: "foreign-artifact-digest",
    description:
      "A tenant fetches an artifact digest that exists only under another tenant's namespace: the artifacts tenant-namespace boundary answers the typed TENANT_SCOPE_VIOLATION rather than an ambiguous miss — never the payload.",
    platformProbes: ["svc-artifact-fetch-foreign"],
    ...oracle("cross-tenant-artifact-fetch", [denied("TENANT_SCOPE_VIOLATION")], []),
    source:
      "the artifacts service's tenant namespace (a digest that exists only under another tenant raises the typed violation, never an ambiguous miss)",
  },
  {
    rowId: "cross-tenant-artifact-adoption",
    targetRole: "foreign-artifact-digest",
    description:
      "A tenant submits an artifact whose lineage adopts another tenant's digest as a parent: the cross-tenant adoption boundary answers the typed TENANT_SCOPE_VIOLATION — the artifact-ref probing discrimination (AC6).",
    platformProbes: ["svc-artifact-adopt-foreign-parent"],
    ...oracle("cross-tenant-artifact-adoption", [denied("TENANT_SCOPE_VIOLATION")], []),
    source:
      "the artifacts service's adoption boundary (parent digests outside the caller's namespace are rejected before any write)",
  },
  {
    rowId: "cross-application-state",
    targetRole: "foreign-execution",
    description:
      "A tenant queries its own application's event ledger for another application's execution: the application-scoped query returns ZERO rows and the public events route answers the 404 indistinguishable miss — no ledger row of the foreign application is ever visible.",
    platformProbes: ["svc-events-foreign-execution"],
    appProbe: { operation: "sdk-events-foreign-execution", expected: wireMiss() },
    ...oracle("cross-application-state", [miss()], [denied("SCOPE_CHECKED_MISS")]),
    source:
      "the execution_events store's application-scoped queries (cross-application queries return zero rows)",
  },
  {
    rowId: "cross-tenant-create",
    targetRole: "foreign-application",
    description:
      "A tenant submits work naming another tenant's application: the public create answers AUTHORIZATION_DENIED (the actor holds no membership for that application — the scope resolver's membership boundary) and the service-level create answers the typed TENANT_SCOPE_VIOLATION (the application belongs to a different tenant) — application-id confusion (AC6).",
    platformProbes: ["svc-create-foreign-application"],
    appProbe: {
      operation: "sdk-create-foreign-application",
      expected: denied("AUTHORIZATION_DENIED"),
    },
    ...oracle(
      "cross-tenant-create",
      [denied("TENANT_SCOPE_VIOLATION")],
      [denied("AUTHORIZATION_DENIED")],
    ),
    source:
      "the scope resolver's membership boundary (public path) + the execution service's application-ownership check (service path)",
  },
  {
    rowId: "cross-tenant-environment",
    targetRole: "foreign-environment",
    description:
      "A tenant submits work for its OWN application naming another tenant's environment: the execution service's environment-ownership check answers the typed TENANT_SCOPE_VIOLATION on BOTH the public wire and the service path — a create-time typed rejection through the public API.",
    platformProbes: ["svc-create-foreign-environment"],
    appProbe: {
      operation: "sdk-create-foreign-environment",
      expected: denied("TENANT_SCOPE_VIOLATION"),
    },
    ...oracle(
      "cross-tenant-environment",
      [denied("TENANT_SCOPE_VIOLATION")],
      [denied("TENANT_SCOPE_VIOLATION")],
    ),
    source:
      "the execution service's environment-ownership check (environmentId must belong to the target application)",
  },
  {
    rowId: "forged-scope-header",
    targetRole: "foreign-application",
    description:
      "An actor forges the application-scope selector (the X-Zeck-Application header naming another tenant's application): the server-side scope resolution answers AUTHORIZATION_DENIED before any execution row is touched — the client's selector never authorizes by itself (the forged-tenant-header discrimination, AC6).",
    platformProbes: ["svc-resolve-forged-scope"],
    appProbe: { operation: "sdk-forged-scope-read", expected: denied("AUTHORIZATION_DENIED") },
    ...oracle(
      "forged-scope-header",
      [denied("AUTHORIZATION_DENIED")],
      [denied("AUTHORIZATION_DENIED")],
    ),
    source:
      "the scope resolver's server-side membership derivation (scope is derived from durable membership rows, never from client assertions)",
  },
  {
    rowId: "own-tenant-control",
    targetRole: "own-execution",
    description:
      "The control: the SAME access within the probe tenant's own namespace is granted — the app-scoped read of one's own execution returns the row (200) and one's own artifact digest fetches cleanly. The boundary denies CROSS-tenant access only; it never over-denies.",
    platformProbes: ["svc-read-own-execution", "svc-artifact-fetch-own"],
    appProbe: { operation: "sdk-read-own-execution", expected: granted() },
    ...oracle("own-tenant-control", [granted(), granted()], [granted()]),
    source: "the same authorities' own-namespace paths (the over-denial discrimination control)",
  },
];

/** The row ids in corpus order (config.json mirrors this slice). */
export const ISOLATION_ROW_IDS: readonly string[] = ISOLATION_CORPUS.map((row) => row.rowId);

/** Look up one corpus row by id (the config task slice references rows by id). */
export function isolationRowById(rowId: string): IsolationCorpusRow | null {
  return ISOLATION_CORPUS.find((row) => row.rowId === rowId) ?? null;
}
