/**
 * VAL-031 acceptance criteria 3, 4, 5, 7 — the crown proof: the pinned
 * replay corpus drives its replay POPULATIONS end to end over the REAL
 * platform path (the repeated-replay trajectory analysis every later
 * learning claim must account for).
 *
 * REAL pieces in this suite (nothing faked on the critical path):
 *   - the REAL Fastify public API served over the REAL SQL authorities
 *     (seeded PostgreSQL world) on a real port — the customer
 *     application (runWorkloadReplayApp) rides the public SDK boundary:
 *     every replay's submission lands its OWN durable execution under
 *     its OWN idempotency key (a shoulder-in is a re-arbitration and
 *     FAILs), the per-replay completion polls observe each replay's
 *     honest terminal, the result retrievals observe the verification
 *     statuses and each replay's route model-call count, and the events
 *     reads re-derive every replay's trajectory digest over the PUBLIC
 *     step-event journal;
 *   - the REAL execution lifecycle per replay: the canonical
 *     transitions (authorize → plan → the durable planning decision →
 *     queue → start → the replay chain → verify → pass/fail), the
 *     terminal derived MECHANICALLY (the replay's own outcome — an
 *     honest FAILED row (the guard-rejected population) surfaces its
 *     visible FAIL cause on every replay) and the verification criteria
 *     recorded durably with the terminal transition;
 *   - the REAL recorder path: every trajectory step of every replay
 *     (dispatch rounds, the effects in the world-scheduled equivalent
 *     ordering — the varying row's legitimate variance basis — the
 *     verification boundary) is journaled through the REAL executions
 *     recordStepEvent seam (the same append-only, gapless,
 *     provenance-bound ledger the lifecycle itself uses) — and the
 *     crown mechanically verifies over REAL SQL that the journal holds
 *     EXACTLY the world-scheduled control trajectory per replay: the
 *     projected trajectory digest IS the recorded digest and a MEMBER
 *     of the corpus-pinned equivalence class;
 *   - the REAL replay ledger: every replay's exactly-once identity
 *     observation rides the REAL SQL unique-index arbitration over
 *     platform.idempotency_records (the replay key as the idempotency
 *     key, the identity content digest as the request fingerprint):
 *     ONE immutable trajectory identity per replay — exactly N per row,
 *     no duplicates (a shoulder-in would be refused), and every
 *     identity is the derived stable VAL-007 form;
 *   - the REAL frozen-baseline registry: the append-only commits (the
 *     superseded RAG revision 1 + every referenced baseline pin,
 *     digests over the pinned artifacts — never the artifacts copied)
 *     ride the same REAL SQL arbitration; the baseline-pin leg reads
 *     the committed entries back from the REAL durable rows (a
 *     read-through view — replays never rewrite the manifests).
 *
 * The lab-contract seams (the platform slice's own design): the
 * competence-system gate binding returns FRESH rounds and never
 * shortcircuits the verification boundary (learning explicitly INERT —
 * the pre-learning reference population; the discrimination suite
 * drives the contaminated variants), the recorder's world-scheduling
 * seam owns the varying row's per-replay equivalent orderings (the
 * pinned schedule the stability honesty REPORTS), and the live row's
 * REAL model dispatch rides the REAL model gateway (env-gated, BYOK,
 * measured — never fabricated).
 *
 * Boundary recorded honestly (the val-030 crown precedent): the
 * app-side trajectory-digest and stability-distribution criteria (the
 * raw public-events digest re-derivation) are exercised over the
 * controlled fake world in the unit suite — over the REAL journal the
 * public event projection carries type+sequence (the platform's own
 * lifecycle envelopes — creation, transitions, the planning decision —
 * are legitimately part of the public stream, and the trajectory steps'
 * kind/detail identities live in the reference the public wire does
 * not project into the digested view), so every replay's raw public
 * stream is structurally identical and the app-side digest analysis
 * cannot observe the world-scheduled variance. The crown therefore
 * verifies the trajectory-class reproduction AND the stability
 * distribution through the REAL recorder path (the SQL projection
 * over the journaled reference) instead, mechanically per replay; the
 * app-side legs that ARE observable over the real wire (submissions
 * landed, terminals, per-replay dispatch counts, the population
 * dispatch total, the measured latency population) are asserted
 * directly.
 *
 * The live rail row (env-gated on the operator-authorized
 * OPENROUTER_API_KEY) drives TWO replays × ONE REAL model confirmation
 * round each through the REAL platform model gateway (measured usage
 * per replay, never estimated). Absent credentials are a recorded
 * NOT RUN boundary — never a fake success.
 */

import { createHash } from "node:crypto";
import { expect, test } from "vitest";
import { runWorkloadReplayApp } from "../../../benchmarks/validation/apps/workload-replay/application";
import {
  liveGateOpen,
  REFERENCED_BASELINE_ROWS,
  replaySubmissionKey,
  replayTaskBodyFor,
  WORKLOAD_REPLAY_CORPUS,
  WORKLOAD_REPLAY_TASK_KIND,
} from "../../../benchmarks/validation/apps/workload-replay/corpus";
import {
  createReplayRecorder,
  SUPERSEDED_RAG_MANIFEST,
} from "../../../benchmarks/validation/apps/workload-replay/fixtures";
import { validateHarnessEvidence } from "../../../benchmarks/validation/harness";
import type { LabUsage } from "../../../benchmarks/validation/platform/derive";
import {
  type BaselineManifestEntry,
  type BaselineRegistryEntry,
  type ControlDispatch,
  controlTrajectoryStepsOf,
  deriveWorkloadAdmission,
  type FrozenBaselineRegistryPort,
  type TrajectoryStepKind,
  type TrajectoryStepRecord,
  trajectoryDigestOf,
} from "../../../benchmarks/validation/platform/longitudinal-baseline";
import type {
  ReplayLearningPort,
  ReplayLedgerPort,
  WorkloadReplayCorpusRow,
  WorkloadReplayResult,
} from "../../../benchmarks/validation/platform/workload-replay";
import {
  driveWorkloadReplay,
  replayIdentityIdOf,
  replayKeyOf,
} from "../../../benchmarks/validation/platform/workload-replay";
import { createSqlAuthModule } from "../../../src/modules/auth/adapters/sql-identity-store";
import { createScopeResolver } from "../../../src/modules/auth/public";
import {
  SqlConnectionStore,
  SqlConnectionsIdempotency,
} from "../../../src/modules/connections/adapters/sql-connection-store";
import {
  createTxCredentialVault,
  SqlCredentialVault,
} from "../../../src/modules/connections/adapters/sql-credential-vault";
import { createConnectionService } from "../../../src/modules/connections/application/connection-service";
import { createFetchTransport } from "../../../src/modules/models/adapters/fetch-transport";
import { createOpenRouterAdapter } from "../../../src/modules/models/adapters/openrouter";
import { createSqlDispatchJournal } from "../../../src/modules/models/adapters/sql-dispatch-journal";
import { createModelGateway } from "../../../src/modules/models/application/model-gateway";
import { createRailRegistry } from "../../../src/modules/models/application/rail-registry";
import {
  createEnvelopeCipher,
  generateMasterKey,
} from "../../../src/platform/crypto/envelope-cipher";
import type { Transaction } from "../../../src/platform/db/port";
import { createUuidv7Generator } from "../../../src/shared/ids";
import { type ApiPgWorld, seedApiPgWorld } from "../postgres/api-world";
import { definePgSuite, type PgContext } from "../postgres/harness";

const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY ?? "";
const MODEL = process.env.ZECK_VAL_031_MODEL ?? "meta-llama/llama-3.3-70b-instruct";
const REVISION = createHash("sha256")
  .update("val-031|workload-replay|pinned")
  .digest("hex")
  .slice(0, 40);
const MAX_TOKENS = 64;

/** The REAL SQL operations the crown's durable bindings ride. */
const REGISTRY_OPERATION = "val-031.replay-baseline-registry";
const LEDGER_OPERATION = "val-031.replay-ledger";

/** Per-run REAL facts collected for the evidence document. */
interface RunFacts {
  readonly rowId: string;
  readonly terminal: string;
  readonly replays: number;
  readonly digests: string;
  readonly stability: string;
  readonly identities: number;
  readonly steps: number;
  readonly modelCalls: string;
  readonly latency: string;
  readonly totalLatencyMs: number;
  readonly appSubmissions: string;
  readonly appTerminal: string;
  readonly usage: string;
  readonly keysDigest: string;
  readonly bodyDigest: string;
  readonly manifestDigest: string;
}

/** The app's own outcome (the settled app promise's payload). */
interface AppOutcome {
  readonly ok: true;
  readonly outcome: Awaited<ReturnType<typeof runWorkloadReplayApp>>;
}

// ---------------------------------------------------------------------------
// The REAL durable bindings (the platform slice's lifecycle ports)
// ---------------------------------------------------------------------------

/**
 * The REAL frozen-baseline registry: the append-only commits ride the
 * REAL SQL unique-index arbitration (the platform's own idempotency
 * discipline — the pin as the idempotency key, the manifest digest as
 * the request fingerprint), then the baseline-pin leg reads the
 * committed entries back from the REAL durable rows (a read-through
 * view: entryFor/historyOf serve the durable state, never fabricated
 * content; commit is the seed-time arbitration only).
 */
async function seedRealReplayBaselineRegistry(
  ctx: PgContext,
  world: ApiPgWorld,
): Promise<FrozenBaselineRegistryPort> {
  const generateId = createUuidv7Generator();
  const pinOf = (manifest: BaselineManifestEntry): string =>
    `${manifest.appId}|${manifest.workloadId}|r${manifest.workloadRevision}`;

  const commitOne = async (manifest: BaselineManifestEntry, committedAt: string): Promise<void> => {
    await ctx.port.transaction(async (tx) => {
      const inserted = await tx.execute<{ id: string }>({
        sql: `INSERT INTO platform.idempotency_records
                (id, actor_id, application_id, operation_name, idempotency_key, request_fingerprint, durable_outcome)
              VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
              ON CONFLICT (application_id, operation_name, idempotency_key) WHERE application_id IS NOT NULL
              DO NOTHING
              RETURNING id`,
        parameters: [
          generateId(),
          world.actorId,
          world.applicationId,
          REGISTRY_OPERATION,
          pinOf(manifest),
          manifest.manifestDigest,
          JSON.stringify({ workloadRevision: manifest.workloadRevision, manifest, committedAt }),
        ],
      });
      if (inserted.rows.length > 0) {
        return;
      }
      const existing = await tx.execute<{ request_fingerprint: string }>({
        sql: `SELECT request_fingerprint FROM platform.idempotency_records
              WHERE application_id = $1 AND operation_name = $2 AND idempotency_key = $3`,
        parameters: [world.applicationId, REGISTRY_OPERATION, pinOf(manifest)],
      });
      const row = existing.rows[0];
      if (row === undefined) {
        throw new Error(`the registry arbitration lost the pin ${pinOf(manifest)}`);
      }
      if (row.request_fingerprint !== manifest.manifestDigest) {
        throw new Error(
          `append-only violation: the pin ${pinOf(manifest)} is already committed with different ` +
            "content — a correction must be a NEW workload revision, never an edit",
        );
      }
      // The identical re-commit replays the committed entry (idempotent).
    });
  };

  // The correction history FIRST (the superseded RAG revision 1), then
  // every referenced baseline pin in reference order — the deterministic
  // default registry shape, durably committed over REAL SQL.
  await commitOne(SUPERSEDED_RAG_MANIFEST, "2025-01-01T00:00:00.000Z");
  for (const [index, baseline] of REFERENCED_BASELINE_ROWS.entries()) {
    await commitOne(
      baseline.manifest,
      `2025-02-01T00:${String(index + 1).padStart(2, "0")}:00.000Z`,
    );
  }

  // The read-through view over the REAL durable rows.
  const readBack = await ctx.port.execute<{
    idempotency_key: string;
    request_fingerprint: string;
    durable_outcome: {
      manifest?: unknown;
      committedAt?: unknown;
    };
    created_at: Date;
  }>({
    sql: `SELECT idempotency_key, request_fingerprint, durable_outcome, created_at
          FROM platform.idempotency_records
          WHERE application_id = $1 AND operation_name = $2
          ORDER BY created_at ASC, id ASC`,
    parameters: [world.applicationId, REGISTRY_OPERATION],
  });
  const entries: BaselineRegistryEntry[] = readBack.rows.flatMap((row) => {
    const manifest = row.durable_outcome?.manifest as BaselineManifestEntry | undefined;
    if (manifest === undefined) {
      return [];
    }
    const committedAt =
      typeof row.durable_outcome?.committedAt === "string"
        ? row.durable_outcome.committedAt
        : row.created_at.toISOString();
    return [{ workloadRevision: manifest.workloadRevision, manifest, committedAt }];
  });
  return {
    // The durable commits are the seed-time arbitration above; the
    // derivation only ever READS the committed state on this path.
    commit() {
      throw new Error(
        "the crown's registry is read-through over the REAL durable commits " +
          "(append through the REAL SQL arbitration at seed time only)",
      );
    },
    entryFor(pin) {
      return (
        entries.find(
          (entry) =>
            entry.manifest.appId === pin.appId &&
            entry.manifest.workloadId === pin.workloadId &&
            entry.workloadRevision === pin.workloadRevision,
        ) ?? null
      );
    },
    historyOf(appId, workloadId) {
      return entries
        .filter(
          (entry) => entry.manifest.appId === appId && entry.manifest.workloadId === workloadId,
        )
        .sort((a, b) => a.workloadRevision - b.workloadRevision);
    },
  };
}

/**
 * The REAL replay ledger: the exactly-once identity observation per
 * replay rides the REAL SQL unique-index arbitration (the replay key
 * as the idempotency key, the identity content digest as the request
 * fingerprint). The first observation RECORDS the derived stable
 * identity form (ONE immutable trajectory identity per replay — a
 * shoulder-in is refused by the arbitration itself); a same-content
 * re-observation REPLAYS it (never a second identity); a
 * different-content re-observation is REFUSED (the identity's content
 * is immutable). The facts view is the read-back of the REAL durable
 * rows after every observation.
 */
function createRealReplayLedger(ctx: PgContext, world: ApiPgWorld): ReplayLedgerPort {
  const generateId = createUuidv7Generator();
  let identities: readonly {
    readonly identityId: string;
    readonly replayKey: string;
    readonly contentDigest: string;
  }[] = [];

  const readBack = async (): Promise<void> => {
    const rows = await ctx.port.execute<{
      idempotency_key: string;
      request_fingerprint: string;
      durable_outcome: { identityId?: unknown };
    }>({
      sql: `SELECT idempotency_key, request_fingerprint, durable_outcome
            FROM platform.idempotency_records
            WHERE application_id = $1 AND operation_name = $2
            ORDER BY created_at ASC, id ASC`,
      parameters: [world.applicationId, LEDGER_OPERATION],
    });
    identities = rows.rows.map((row) => ({
      replayKey: row.idempotency_key,
      contentDigest: row.request_fingerprint,
      identityId:
        typeof row.durable_outcome?.identityId === "string" ? row.durable_outcome.identityId : "",
    }));
  };

  return {
    async observeReplay({ replayKey, contentDigest }) {
      const observation = await ctx.port.transaction(async (tx: Transaction) => {
        const inserted = await tx.execute<{ id: string }>({
          sql: `INSERT INTO platform.idempotency_records
                  (id, actor_id, application_id, operation_name, idempotency_key, request_fingerprint, durable_outcome)
                VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)
                ON CONFLICT (application_id, operation_name, idempotency_key) WHERE application_id IS NOT NULL
                DO NOTHING
                RETURNING id`,
          parameters: [
            generateId(),
            world.actorId,
            world.applicationId,
            LEDGER_OPERATION,
            replayKey,
            contentDigest,
            JSON.stringify({ identityId: replayIdentityIdOf(replayKey) }),
          ],
        });
        if (inserted.rows.length > 0) {
          // The first observation RECORDS the derived stable identity
          // (ONE immutable trajectory identity per replay).
          return {
            contentDigest,
            identityId: replayIdentityIdOf(replayKey),
            replayed: false,
            refused: false,
            dropped: false,
          };
        }
        const existing = await tx.execute<{
          request_fingerprint: string;
          durable_outcome: { identityId?: unknown };
        }>({
          sql: `SELECT request_fingerprint, durable_outcome FROM platform.idempotency_records
                WHERE application_id = $1 AND operation_name = $2 AND idempotency_key = $3`,
          parameters: [world.applicationId, LEDGER_OPERATION, replayKey],
        });
        const row = existing.rows[0];
        if (row === undefined) {
          throw new Error(`the replay ledger arbitration lost the replay key ${replayKey}`);
        }
        const identityId =
          typeof row.durable_outcome?.identityId === "string"
            ? row.durable_outcome.identityId
            : null;
        if (row.request_fingerprint === contentDigest) {
          // The re-observation of the SAME replay with the SAME content
          // REPLAYS the recorded identity (never a second one).
          return { contentDigest, identityId, replayed: true, refused: false, dropped: false };
        }
        // The identity's content is IMMUTABLE — the honest refusal.
        return { contentDigest, identityId, replayed: false, refused: true, dropped: false };
      });
      await readBack();
      return observation;
    },
    facts() {
      return { identities: [...identities] };
    },
  };
}

/**
 * The inert-learning gate binding (the lab-contract seam): every
 * dispatch round of every replay is FRESH and the verification
 * boundary is never shortcircuited — learning explicitly INERT over
 * the REAL platform path (the pre-learning reference population; the
 * discrimination suite drives the contaminated variants over the
 * fixture gate).
 */
const INERT_LEARNING: ReplayLearningPort = {
  async gateRound() {
    return { mode: "fresh" };
  },
  verificationShortcut() {
    return false;
  },
};

/** Parse one REAL journal step kind (the trajectory vocabulary — honest on unknowns). */
function trajectoryStepKindOf(kind: string): TrajectoryStepKind {
  if (kind === "dispatch" || kind === "effect" || kind === "verification") {
    return kind;
  }
  throw new Error(`the REAL journal holds an unknown trajectory step kind: ${kind}`);
}

// ---------------------------------------------------------------------------
// The REAL lifecycle driving (the canonical transitions per replay)
// ---------------------------------------------------------------------------

/** The canonical prologue: authorize → plan → the planning decision → queue → start. */
async function driveLifecycleToRunning(
  world: ApiPgWorld,
  executionId: string,
  row: WorkloadReplayCorpusRow,
  generateId: () => string,
): Promise<void> {
  const transitionCounter = { count: 0 };
  const transition = async (command: "authorize" | "plan" | "queue" | "start"): Promise<void> => {
    transitionCounter.count += 1;
    await world.executions.transition(
      {
        actorId: world.actorId,
        applicationId: world.applicationId,
        tenantId: world.tenantId,
        executionId,
        command,
        reason: `val-031-${command}`,
      },
      `val-031-${executionId}-${command}-${transitionCounter.count}`,
    );
  };
  await transition("authorize");
  await transition("plan");
  await world.executions.recordPlanningDecision(
    {
      applicationId: world.applicationId,
      executionId,
      tenantId: world.tenantId,
      actorId: world.actorId,
      decisionId: generateId(),
      planId: generateId(),
      payload: {
        candidates: [
          {
            strategyId: "val-031-replay",
            plan: {
              strategyClass: "workload-replay",
              // The replay's OWN dispatch demand — the route read
              // surfaces it at the customer boundary.
              modelCalls: row.expectedModelCallsPerReplay,
              steps: [
                {
                  routeRef: {
                    provider: row.needsDispatch ? "openrouter" : "deterministic-fixture",
                    model: row.needsDispatch ? MODEL : "none",
                  },
                },
              ],
            },
          },
        ],
        selectedStrategyId: "val-031-replay",
      },
    },
    `val-031-${executionId}-decision`,
  );
  await transition("queue");
  await transition("start");
}

/**
 * The verification boundary + the terminal for ONE replay's landed
 * execution: the mechanically derived verdict (the replay's own
 * outcome), the per-replay legs (the expected terminal, the
 * trajectory-class membership over the recorder's own digest, the
 * replay's own dispatch count, its recorded ledger identity) plus the
 * population verdict every replay's verification carries — recorded
 * durably with the terminal transition. An honest FAILED replay (the
 * guard-rejected population) surfaces its visible FAIL cause.
 */
async function completeReplayExecution(
  world: ApiPgWorld,
  executionId: string,
  row: WorkloadReplayCorpusRow,
  result: WorkloadReplayResult,
  replayOrdinal: number,
): Promise<void> {
  const replay = result.replays[replayOrdinal - 1];
  if (replay === undefined) {
    throw new Error(`the population result holds no replay ${replayOrdinal}`);
  }
  await world.executions.transition(
    {
      actorId: world.actorId,
      applicationId: world.applicationId,
      tenantId: world.tenantId,
      executionId,
      command: "verify",
      reason: "val-031-verify",
    },
    `val-031-${executionId}-verify`,
  );
  const admission = deriveWorkloadAdmission(row.workload);
  const inClass =
    replay.trajectoryDigest !== null &&
    row.expectedTrajectoryClass.includes(replay.trajectoryDigest);
  const criteria = [
    // The honest guard admission: PASS when the budget guard admitted
    // the declared demand, the visible FAIL cause when it rejected (the
    // honest FAILED population replays the rejection N times).
    {
      criterionId: "guard-admission",
      strategy: "deterministic" as const,
      status: admission.allowed ? ("PASS" as const) : ("FAIL" as const),
      evidence: [
        `quotaMicro:${row.workload.quotaMicro}`,
        `demandedMicro:${admission.demandedMicro}`,
        `guard:${admission.allowed ? "admitted" : "rejected"}`,
        ...(admission.reason === null ? [] : [admission.reason]),
      ],
    },
    {
      criterionId: `replay-${replayOrdinal}-expected-terminal`,
      strategy: "deterministic" as const,
      status: replay.outcome === row.expected.terminal ? ("PASS" as const) : ("FAIL" as const),
      evidence: [
        `expected:${row.expected.terminal}`,
        `observed:${replay.outcome}`,
        `failure:${replay.failure?.category ?? "none"}`,
      ],
    },
    {
      criterionId: `replay-${replayOrdinal}-trajectory-class-membership`,
      strategy: "deterministic" as const,
      status: inClass ? ("PASS" as const) : ("FAIL" as const),
      evidence: [
        `trajectoryDigest:${replay.trajectoryDigest ?? "none"}`,
        `classSize:${row.expectedTrajectoryClass.length}`,
        inClass ? "in-class" : "OUT-OF-CLASS",
      ],
    },
    {
      criterionId: `replay-${replayOrdinal}-own-dispatches`,
      strategy: "deterministic" as const,
      status:
        replay.modelCalls === row.expectedModelCallsPerReplay
          ? ("PASS" as const)
          : ("FAIL" as const),
      evidence: [`expected:${row.expectedModelCallsPerReplay}`, `observed:${replay.modelCalls}`],
    },
    {
      criterionId: `replay-${replayOrdinal}-ledger-identity-recorded`,
      strategy: "deterministic" as const,
      status:
        replay.identityId !== null && !replay.replayed ? ("PASS" as const) : ("FAIL" as const),
      evidence: [
        `identityId:${replay.identityId ?? "none"}`,
        `replayed:${String(replay.replayed)}`,
      ],
    },
    // The population verdict every replay's verification carries.
    ...result.criteria.filter((criterion) =>
      [
        "population-exactly-n",
        "population-no-duplicate-replays",
        "population-no-gaps",
        "population-completeness-summary",
        "ledger-identities-exactly-n",
        "population-own-dispatch-total",
        "stability-honesty-summary",
      ].includes(criterion.criterionId),
    ),
  ];
  const verdict = replay.outcome === "COMPLETED" ? "pass" : "fail";
  await world.executions.transition(
    {
      actorId: world.actorId,
      applicationId: world.applicationId,
      tenantId: world.tenantId,
      executionId,
      command: verdict,
      reason:
        verdict === "pass"
          ? "val-031-verified"
          : `val-031-${replay.failure?.category ?? "criterion-fail"}`,
      verificationResults: criteria.map((criterion) => ({
        criterionId: criterion.criterionId,
        strategy: criterion.strategy,
        status: criterion.status,
        recordedBy: "val-031-platform",
        evidence: [...criterion.evidence],
      })),
    },
    `val-031-${executionId}-${verdict}`,
  );
}

// ---------------------------------------------------------------------------
// The landed-replay provider (the app's submissions land through the
// public wire; the crown polls the REAL SQL for the durable rows)
// ---------------------------------------------------------------------------

/** One replay's landed durable execution (the public submission's row). */
interface LandedReplay {
  readonly executionId: string;
  readonly replayOrdinal: number;
}

async function awaitLandedReplayExecutions(
  ctx: PgContext,
  world: ApiPgWorld,
  driven: Set<string>,
  row: WorkloadReplayCorpusRow,
): Promise<LandedReplay[]> {
  for (let attempt = 0; attempt < 4_800; attempt += 1) {
    const rows = await ctx.port.execute<{ id: string; replay: number }>({
      sql: `SELECT id, (task->>'replay')::int AS replay FROM executions.executions
            WHERE application_id = $1
              AND task->>'kind' = $2
              AND task->>'rowId' = $3
              AND id != ALL($4::uuid[])
            ORDER BY (task->>'replay')::int ASC, id ASC`,
      parameters: [world.applicationId, WORKLOAD_REPLAY_TASK_KIND, row.rowId, [...driven]],
    });
    if (rows.rows.length >= row.replayCount) {
      const landed = rows.rows.map((rowResult) => ({
        executionId: rowResult.id,
        replayOrdinal: rowResult.replay,
      }));
      for (const replay of landed) {
        driven.add(replay.executionId);
      }
      if (landed.length !== row.replayCount) {
        throw new Error(
          `the row ${row.rowId} landed more executions than its replay count ` +
            `(${landed.length} > ${row.replayCount})`,
        );
      }
      return landed;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(
    `no landed replay population for row ${row.rowId} after 120s ` +
      `(expected ${row.replayCount} durable executions)`,
  );
}

// ---------------------------------------------------------------------------
// The live dispatch binding (the REAL model gateway — the live row's seam)
// ---------------------------------------------------------------------------

/** Build the REAL model-gateway dispatch round (the live row's seam). */
async function buildLiveDispatch(
  ctx: PgContext,
  world: ApiPgWorld,
): Promise<{ readonly dispatch: ControlDispatch }> {
  const generateId = createUuidv7Generator();
  const cipher = createEnvelopeCipher(generateMasterKey());
  const auth = createSqlAuthModule(ctx.port, generateId);
  const vault = new SqlCredentialVault(ctx.port, cipher, generateId);
  const connections = createConnectionService(
    new SqlConnectionStore(ctx.port),
    new SqlConnectionsIdempotency(
      ctx.port,
      (tx: Transaction) => createTxCredentialVault(tx, cipher, generateId),
      generateId,
    ),
    createScopeResolver(auth.store),
    auth.store,
    generateId,
  );
  const registry = createRailRegistry([
    createOpenRouterAdapter({ transport: createFetchTransport() }),
  ]);
  const gateway = createModelGateway({
    resolver: createScopeResolver(auth.store),
    catalog: connections,
    credentials: vault,
    admission: {
      async admit() {
        return { allowed: true };
      },
    },
    capabilities: {
      async resolve() {
        return { satisfied: true, catalogRevision: "val-031", satisfactions: [] };
      },
    },
    rails: registry,
    journal: createSqlDispatchJournal(ctx.port),
    generateId,
    defaultTimeoutMs: 150_000,
    hashRequest: (request) =>
      createHash("sha256").update(JSON.stringify(request), "utf8").digest("hex"),
  });
  const principal = { actorId: world.actorId, authenticatedAt: new Date().toISOString() };
  const { connection } = await connections.registerConnection(
    {
      principal,
      applicationId: world.applicationId,
      rail: "openrouter",
      label: "val-031-openrouter",
      registerCredential: { material: OPENROUTER_KEY },
    },
    `val-031-conn-${generateId().slice(-8)}`,
  );

  const dispatch: ControlDispatch = async ({ round, attempt }) => {
    const startedAt = Date.now();
    const result = await gateway.complete(principal, world.applicationId, connection.id, {
      model: MODEL,
      maxTokens: MAX_TOKENS,
      temperature: 0,
      messages: [
        {
          role: "system",
          content: [
            "You are the replay-population confirmation supervisor of a governed validation execution.",
            "You receive the frozen baseline workload's replay confirmation request and decide whether",
            "the replay's dispatch round completed. Answer with the single word: confirm",
          ].join(" "),
        },
        {
          role: "user",
          content:
            `Workload replay population round (golden:live-confirmation, round ${round}, ` +
            `attempt ${attempt}). Confirm the replay dispatch.`,
        },
      ],
    });
    const latencyMs = Date.now() - startedAt;
    if (result.outcome.kind === "provider-success") {
      const response = result.outcome.response;
      const usage: LabUsage = {
        inputTokens: response.usage.inputTokens,
        outputTokens: response.usage.outputTokens,
        ...(response.usage.costUsd === null || response.usage.costUsd === undefined
          ? {}
          : { costUsd: response.usage.costUsd }),
      };
      if (!/confirm/i.test(response.content.join("\n"))) {
        return {
          kind: "failure",
          category: "supervisor-halt",
          message: `the confirmation supervisor did not confirm: ${response.content
            .join("\n")
            .slice(0, 120)}`,
          latencyMs,
        };
      }
      return { kind: "success", usage, latencyMs };
    }
    const failure = result.outcome.failure;
    return {
      kind: "failure",
      category: failure.category,
      message: failure.providerMessage ?? "provider failure (no provider message)",
      latencyMs,
    };
  };
  return { dispatch };
}

// ---------------------------------------------------------------------------
// The per-row crown orchestration
// ---------------------------------------------------------------------------

/**
 * Drive one corpus row's replay population crown-style: the app rides
 * the public wire (N replay submissions → per-replay completion polls
 * → result reads → events reads) while the crown waits for the landed
 * executions and drives the REAL lifecycle around each replay (the
 * prologue transitions → the replay population through the platform
 * driver with the REAL recorder/ledger/registry bindings → the
 * trajectory flush through the REAL recorder path per landed
 * execution → the verification boundary + the mechanically derived
 * terminal per replay).
 */
async function driveCrownPopulation(options: {
  readonly ctx: PgContext;
  readonly world: ApiPgWorld;
  readonly address: string;
  readonly row: WorkloadReplayCorpusRow;
  readonly taskIndex: number;
  readonly runSuffix: string;
  readonly registry: FrozenBaselineRegistryPort;
  readonly ledger: ReplayLedgerPort;
  readonly dispatch?: ControlDispatch;
  readonly driven: Set<string>;
}): Promise<{
  readonly populationId: string;
  readonly landed: readonly LandedReplay[];
  readonly result: WorkloadReplayResult;
  readonly appSettled: AppOutcome;
  readonly appKeys: readonly string[];
  readonly appBodies: readonly Record<string, unknown>[];
}> {
  const { world, row, taskIndex } = options;
  const generateId = createUuidv7Generator();
  const populationId = `val-031-pop-${options.runSuffix}`;
  const appKeys = Array.from({ length: row.replayCount }, (_, index) =>
    replaySubmissionKey({ runSuffix: options.runSuffix, taskIndex, replayOrdinal: index + 1 }),
  );
  const appBodies = Array.from({ length: row.replayCount }, (_, index) =>
    replayTaskBodyFor({ rowId: row.rowId, replayOrdinal: index + 1 }),
  );

  // The app promise: the customer application over the REAL served
  // public wire (the app never touches platform internals).
  const appPromise: Promise<AppOutcome> = runWorkloadReplayApp({
    config: {
      applicationId: world.applicationId,
      baseUrl: options.address,
      tokenEnvVar: "ZECK_VALIDATION_TOKEN",
      applicationRevision: REVISION,
      corpusRevision: REVISION,
      integrationSurface: "sdk",
      pollIntervalMs: 250,
      completionTimeoutMs: row.needsDispatch ? 240_000 : 120_000,
    },
    token: world.bearerToken,
    transport: globalThis.fetch,
    now: () => new Date(),
    sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    environment: {
      runtime: `node ${process.version}`,
      toolchain: "vitest",
      database: "postgresql",
      configuration: { suite: "val-031-workload-replay" },
    },
    runSuffix: options.runSuffix,
    taskIndex,
  }).then((outcome) => ({ ok: true as const, outcome }));

  // The landed replay executions (the app's N submissions through the
  // public wire, in replay-ordinal order).
  const landed = await awaitLandedReplayExecutions(options.ctx, world, options.driven, row);

  // The canonical prologue per landed execution (authorize → plan →
  // the planning decision → queue → start) — every replay drives over
  // the REAL state machine.
  for (const replay of landed) {
    await driveLifecycleToRunning(world, replay.executionId, row, generateId);
  }

  // The replay population through the platform driver with the REAL
  // registry/ledger bindings and the recorder's world-scheduling seam
  // (the varying row's per-replay equivalent orderings — the pinned
  // schedule the stability honesty REPORTS).
  const recorder = createReplayRecorder({
    ...(row.replayOrderings === undefined ? {} : { replayOrderPlan: row.replayOrderings }),
  });
  const result = await driveWorkloadReplay({
    row,
    populationId,
    registry: options.registry,
    ledger: options.ledger,
    recorder,
    learning: INERT_LEARNING,
    ...(options.dispatch === undefined ? {} : { dispatch: options.dispatch }),
    retry: {
      maxExtraAttempts: 2,
      backoffMs: 4_000,
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    },
    now: () => new Date(),
  });

  // The trajectory flush through the REAL recorder path: each replay's
  // captured (world-scheduled) steps journal into ITS landed execution
  // while the execution is RUNNING — the step events project back onto
  // the canonical scheduled trajectory (verified below over REAL SQL).
  for (const replay of landed) {
    const capture = recorder.replayCapture(populationId, replay.replayOrdinal);
    if (capture === null) {
      throw new Error(
        `the recorder holds no capture for replay ${replay.replayOrdinal} of ${row.rowId}`,
      );
    }
    for (const step of capture.steps) {
      await world.executions.recordStepEvent(
        {
          applicationId: world.applicationId,
          executionId: replay.executionId,
          actor: { actorId: world.actorId, tenantId: world.tenantId },
          command: "agent-action-recorded",
          cause: `val-031-${step.kind}-${step.ordinal}`,
          reference: {
            kind: step.kind,
            ordinal: step.ordinal,
            detail: step.detail,
            digest: step.digest,
          },
          payload: { kind: step.kind, detail: step.detail, ordinal: step.ordinal },
        },
        `val-031-${replay.executionId}-${step.kind}-${step.ordinal}`,
      );
    }
  }

  // The verification boundary + the mechanically derived terminal per
  // landed replay execution.
  for (const replay of landed) {
    await completeReplayExecution(world, replay.executionId, row, result, replay.replayOrdinal);
  }

  const appSettled = await appPromise;
  return { populationId, landed, result, appSettled, appKeys, appBodies };
}

// ---------------------------------------------------------------------------
// The per-row mechanical verification (over the REAL SQL)
// ---------------------------------------------------------------------------

/**
 * Verify one row's crown outcome mechanically: the platform's
 * population analysis (completeness, membership, stability honesty,
 * accounting honesty, latency), the per-replay contracts, the REAL
 * journal projection per landed execution (the trajectory-class
 * reproduction through the REAL recorder path), the REAL ledger's
 * exactly-N immutable identities, and the app's honest observations
 * over the public wire.
 */
async function verifyCrownRow(options: {
  readonly ctx: PgContext;
  readonly world: ApiPgWorld;
  readonly row: WorkloadReplayCorpusRow;
  readonly populationId: string;
  readonly landed: readonly LandedReplay[];
  readonly result: WorkloadReplayResult;
  readonly appSettled: AppOutcome;
}): Promise<void> {
  const { ctx, world, row, result, appSettled } = options;
  const { outcome: app } = appSettled;

  // ---- the honest population contracts (the platform side) ----
  if (result.terminal !== row.expected.terminal) {
    console.info(
      `[VAL-031][DIAGNOSTIC] ${row.rowId} terminal=${result.terminal} failure=${JSON.stringify(result.failure)}`,
    );
    for (const criterion of result.criteria) {
      if (criterion.status === "FAIL") {
        console.info(
          `[VAL-031][DIAGNOSTIC]   FAIL ${criterion.criterionId}: ${criterion.evidence.join(" | ")}`,
        );
      }
    }
  }
  expect(result.terminal, `${row.rowId} terminal`).toBe(row.expected.terminal);
  const failedCriteria = result.criteria.filter((criterion) => criterion.status === "FAIL");
  expect(failedCriteria, `${row.rowId}: ${JSON.stringify(failedCriteria)}`).toEqual([]);
  // Population completeness: exactly N replays, no duplicates, no gaps.
  expect(result.population.complete, `${row.rowId} population complete`).toBe(true);
  expect(result.population.observedCount, `${row.rowId} observed replays`).toBe(row.replayCount);
  // Trajectory-class membership: every replay in the pinned class.
  expect(result.membership.allInClass, `${row.rowId} membership`).toBe(true);
  // Stability honesty: the observed kind and distribution reproduce the pin.
  expect(result.stability.honest, `${row.rowId} stability honest`).toBe(true);
  expect(result.stability.observedKind, `${row.rowId} observed stability`).toBe(
    row.expectedStability.kind,
  );
  // Accounting honesty: latency measured, usage honestly none offline.
  expect(result.accounting.honest, `${row.rowId} accounting`).toBe(true);
  expect(result.latency.measured, `${row.rowId} latency measured`).toBe(true);
  expect(result.latency.count, `${row.rowId} latency population`).toBe(row.replayCount);
  expect(result.observedModelCalls, `${row.rowId} population dispatches`).toBe(
    row.expectedModelCallsPerReplay * row.replayCount,
  );
  if (row.needsDispatch) {
    // The live row's usage is MEASURED per replay (never estimated).
    expect(result.usage === null || result.usage.inputTokens >= 0).toBe(true);
    expect(result.replays.every((replay) => replay.usage !== null)).toBe(true);
  } else {
    expect(result.usage, `${row.rowId} offline usage none-reported`).toBeNull();
    expect(result.replays.every((replay) => replay.usage === null)).toBe(true);
  }

  // ---- the per-replay contracts (identities + digests + terminals) ----
  for (const replay of result.replays) {
    const replayKey = replayKeyOf({
      populationId: options.populationId,
      manifest: row.manifest,
      replayOrdinal: replay.replayOrdinal,
    });
    expect(replay.outcome, `${row.rowId} replay ${replay.replayOrdinal} outcome`).toBe(
      row.expected.terminal,
    );
    expect(replay.identityId, `${row.rowId} replay ${replay.replayOrdinal} identity`).toBe(
      replayIdentityIdOf(replayKey),
    );
    expect(replay.replayed, `${row.rowId} replay ${replay.replayOrdinal} never shouldered`).toBe(
      false,
    );
    expect(row.expectedTrajectoryClass).toContain(replay.trajectoryDigest ?? "");
    expect(
      replay.latencyMs,
      `${row.rowId} replay ${replay.replayOrdinal} latency`,
    ).toBeGreaterThanOrEqual(0);
  }

  // ---- the REAL journal projection per landed execution ----
  // The REAL journal's trajectory step events project onto the
  // world-scheduled control trajectory: the projected digest IS the
  // driver's recorded digest (a pinned class member) and the ordinals
  // are 1..M.
  for (const landedReplay of options.landed) {
    const stepRows = await ctx.port.execute<{
      ordinal: number;
      kind: string;
      detail: string;
      digest: string;
    }>({
      sql: `SELECT (reference->>'ordinal')::int AS ordinal, reference->>'kind' AS kind,
                     reference->>'detail' AS detail, reference->>'digest' AS digest
              FROM executions.execution_events
              WHERE execution_id = $1 AND type = 'execution.agent-action-recorded'
              ORDER BY sequence ASC`,
      parameters: [landedReplay.executionId],
    });
    const projection: TrajectoryStepRecord[] = stepRows.rows.map((step) => ({
      ordinal: step.ordinal,
      kind: trajectoryStepKindOf(step.kind),
      detail: step.detail,
      digest: step.digest,
    }));
    const driverDigest = result.replays[landedReplay.replayOrdinal - 1]?.trajectoryDigest ?? "none";
    const replayOrder =
      row.replayOrderings === undefined
        ? undefined
        : (row.replayOrderings[(landedReplay.replayOrdinal - 1) % row.replayOrderings.length] ??
          row.workload.effects.map((_, index) => index));
    expect(
      projection.length,
      `${row.rowId} replay ${landedReplay.replayOrdinal} journal steps`,
    ).toBe(
      controlTrajectoryStepsOf({
        workload: row.workload,
        ...(replayOrder === undefined ? {} : { effectOrder: replayOrder }),
      }).length,
    );
    expect(
      trajectoryDigestOf(projection),
      `${row.rowId} replay ${landedReplay.replayOrdinal} REAL journal digest`,
    ).toBe(driverDigest);
    expect(row.expectedTrajectoryClass).toContain(trajectoryDigestOf(projection));
    const ordinals = projection.map((step) => step.ordinal);
    expect(
      ordinals.every((ordinal, index) => ordinal === index + 1),
      `${row.rowId} replay ${landedReplay.replayOrdinal} ordinals: ${ordinals.join(",")}`,
    ).toBe(true);

    // ---- the durable terminal + the journal gaplessness ----
    const durable = await world.executions.getExecution(
      world.applicationId,
      landedReplay.executionId,
    );
    expect(
      durable?.status,
      `${row.rowId} replay ${landedReplay.replayOrdinal} durable terminal`,
    ).toBe(row.expected.terminal);
    const events = await ctx.port.execute<{ sequence: number }>({
      sql: `SELECT sequence FROM executions.execution_events
            WHERE execution_id = $1 ORDER BY sequence ASC`,
      parameters: [landedReplay.executionId],
    });
    const sequences = events.rows.map((eventRow) => eventRow.sequence);
    expect(
      sequences.every((sequence, index) => sequence === index + 1),
      `${row.rowId} replay ${landedReplay.replayOrdinal} journal sequences: ${sequences.join(",")}`,
    ).toBe(true);
  }

  // ---- the replay ledger over REAL SQL: exactly N immutable identities ----
  for (const landedReplay of options.landed) {
    const replayKey = replayKeyOf({
      populationId: options.populationId,
      manifest: row.manifest,
      replayOrdinal: landedReplay.replayOrdinal,
    });
    const ledgerRow = await ctx.port.execute<{ c: number; identityId: string | null }>({
      sql: `SELECT count(*)::int AS c, min(durable_outcome->>'identityId') AS "identityId"
            FROM platform.idempotency_records
            WHERE application_id = $1 AND operation_name = $2 AND idempotency_key = $3`,
      parameters: [world.applicationId, LEDGER_OPERATION, replayKey],
    });
    expect(
      Number(ledgerRow.rows[0]?.c ?? 0),
      `${row.rowId} replay ${landedReplay.replayOrdinal} ONE ledger identity`,
    ).toBe(1);
    expect(
      ledgerRow.rows[0]?.identityId,
      `${row.rowId} replay ${landedReplay.replayOrdinal} ledger identity form`,
    ).toBe(replayIdentityIdOf(replayKey));
  }
  const populationPrefix = replayKeyOf({
    populationId: options.populationId,
    manifest: row.manifest,
    replayOrdinal: 1,
  }).slice(0, -"replay-1".length);
  const populationLedger = await ctx.port.execute<{ c: number }>({
    sql: `SELECT count(*)::int AS c FROM platform.idempotency_records
          WHERE application_id = $1 AND operation_name = $2 AND idempotency_key LIKE $3`,
    parameters: [world.applicationId, LEDGER_OPERATION, `${populationPrefix}%`],
  });
  expect(Number(populationLedger.rows[0]?.c ?? 0), `${row.rowId} exactly N ledger identities`).toBe(
    row.replayCount,
  );

  // ---- the app's honest observations over the public wire ----
  expect(validateHarnessEvidence(app.evidence)).toEqual([]);
  expect(app.submissions).toHaveLength(row.replayCount);
  for (const submission of app.submissions) {
    expect(
      submission.rejection,
      `${row.rowId} replay ${submission.replayOrdinal} submission`,
    ).toBeNull();
    expect(submission.replayed, `${row.rowId} replay ${submission.replayOrdinal} created`).toBe(
      false,
    );
    expect(
      submission.executionId.length,
      `${row.rowId} replay ${submission.replayOrdinal} landed`,
    ).toBeGreaterThan(0);
  }
  for (const [index, terminal] of app.observedTerminals.entries()) {
    expect(terminal, `${row.rowId} replay ${index + 1} app terminal`).toBe(row.expected.terminal);
  }
  for (const [index, calls] of app.observedModelCalls.entries()) {
    expect(calls, `${row.rowId} replay ${index + 1} app model calls`).toBe(
      row.expectedModelCallsPerReplay,
    );
  }
  // The app's own observable population analysis over the real wire:
  // the measured latency population and the dispatch total are the
  // app's OWN observations that hold over the REAL public projection
  // (the stability-distribution re-derivation is the recorded boundary
  // above — verified here through the REAL recorder path instead).
  expect(app.population.latency.count, `${row.rowId} app latency count`).toBe(row.replayCount);
  expect(app.submissionLatencyMs).toHaveLength(row.replayCount);
  expect(app.population.observedModelCalls, `${row.rowId} app population dispatches`).toBe(
    row.expectedModelCallsPerReplay * row.replayCount,
  );
  // The per-replay terminal↔criteria agreements + the population legs
  // over the public wire (the anyFail→FAILED invariant visible at the
  // customer boundary).
  for (let replayOrdinal = 1; replayOrdinal <= row.replayCount; replayOrdinal += 1) {
    expect(
      app.appCriteria.find(
        (criterion) =>
          criterion.criterionId === `app-replay-${replayOrdinal}-terminal-criteria-agreement`,
      )?.status,
      `${row.rowId} replay ${replayOrdinal} app terminal-criteria agreement`,
    ).toBe("PASS");
    expect(
      app.appCriteria.find(
        (criterion) => criterion.criterionId === `app-replay-${replayOrdinal}-expected-terminal`,
      )?.status,
      `${row.rowId} replay ${replayOrdinal} app expected terminal`,
    ).toBe("PASS");
    expect(
      app.appCriteria.find(
        (criterion) => criterion.criterionId === `app-replay-${replayOrdinal}-own-dispatches`,
      )?.status,
      `${row.rowId} replay ${replayOrdinal} app own dispatches`,
    ).toBe("PASS");
  }
  expect(
    app.appCriteria.find((criterion) => criterion.criterionId === "app-replay-submissions-landed")
      ?.status,
    `${row.rowId} app submissions landed`,
  ).toBe("PASS");
  expect(
    app.appCriteria.find(
      (criterion) => criterion.criterionId === "app-population-no-duplicate-replays",
    )?.status,
    `${row.rowId} app population no duplicates`,
  ).toBe("PASS");
  expect(
    app.appCriteria.find((criterion) => criterion.criterionId === "app-stability-full-population")
      ?.status,
    `${row.rowId} app stability full population`,
  ).toBe("PASS");
  expect(
    app.appCriteria.find((criterion) => criterion.criterionId === "app-population-dispatch-total")
      ?.status,
    `${row.rowId} app population dispatch total`,
  ).toBe("PASS");
}

/** The per-replay key digests (payload DIGESTS only — never the key bytes). */
function keysDigestOf(keys: readonly string[]): string {
  return createHash("sha256").update(keys.join("\n"), "utf8").digest("hex").slice(0, 16);
}

/** The per-replay body digests (payload DIGESTS only — never the body bytes). */
function bodiesDigestOf(bodies: readonly Record<string, unknown>[]): string {
  return createHash("sha256")
    .update(bodies.map((body) => JSON.stringify(body)).join("\n"), "utf8")
    .digest("hex")
    .slice(0, 16);
}

// ---------------------------------------------------------------------------
// The suites
// ---------------------------------------------------------------------------

definePgSuite(
  "VAL-031 repeated workload replay and trajectory analysis over the real platform path",
  (ctx) => {
    test("the offline replay corpus drives population/membership/stability/accounting semantics over the REAL platform path", {
      timeout: 300_000,
    }, async () => {
      const world = await seedApiPgWorld(ctx.port);
      const address = await world.server.app.listen({ port: 0, host: "127.0.0.1" });
      const driven = new Set<string>();
      const runFacts: RunFacts[] = [];

      try {
        // The REAL durable frozen-baseline registry (the append-only
        // arbitration over REAL SQL: the superseded RAG r1 + every
        // referenced baseline pin) and the REAL replay ledger.
        const registry = await seedRealReplayBaselineRegistry(ctx, world);
        const ledger = createRealReplayLedger(ctx, world);

        for (const [taskIndex, row] of WORKLOAD_REPLAY_CORPUS.entries()) {
          if (row.liveGate !== undefined) {
            continue;
          }
          const generateId = createUuidv7Generator();
          const runSuffix = `it-${generateId().slice(-8)}`;
          const { populationId, landed, result, appSettled, appKeys, appBodies } =
            await driveCrownPopulation({
              ctx,
              world,
              address,
              row,
              taskIndex,
              runSuffix,
              registry,
              ledger,
              driven,
            });

          await verifyCrownRow({ ctx, world, row, populationId, landed, result, appSettled });

          // The app key's ledger record: ONE create arbitration per replay
          // submission key (no ledger drift — every replay landed its OWN
          // durable execution under its OWN key).
          for (const appKey of appKeys) {
            const keyRecords = await ctx.port.execute<{ c: number }>({
              sql: `SELECT count(*)::int AS c FROM platform.idempotency_records
                  WHERE application_id = $1 AND idempotency_key = $2
                    AND operation_name = 'executions.create'`,
              parameters: [world.applicationId, appKey],
            });
            expect(Number(keyRecords.rows[0]?.c ?? 0), `${row.rowId} app key records`).toBe(1);
          }

          const distribution = result.stability.observedDistribution
            .map((entry) => `${entry.digest}x${entry.count}`)
            .join("|");
          const stepsPerReplay = result.replays.map(
            (replay) =>
              controlTrajectoryStepsOf({
                workload: row.workload,
                ...(row.replayOrderings === undefined
                  ? {}
                  : {
                      effectOrder:
                        row.replayOrderings[
                          (replay.replayOrdinal - 1) % row.replayOrderings.length
                        ] ?? row.workload.effects.map((_, index) => index),
                    }),
              }).length,
          );
          runFacts.push({
            rowId: row.rowId,
            terminal: result.terminal,
            replays: row.replayCount,
            digests: result.replays.map((replay) => replay.trajectoryDigest ?? "none").join(","),
            stability: `${result.stability.observedKind} (${distribution})`,
            identities: row.replayCount,
            steps: stepsPerReplay.reduce((sum, count) => sum + count, 0),
            modelCalls: `${result.observedModelCalls}/${row.expectedModelCallsPerReplay * row.replayCount}`,
            latency: `${result.latency.minMs ?? 0}/${result.latency.medianMs ?? 0}/${result.latency.maxMs ?? 0}`,
            totalLatencyMs: result.totalLatencyMs,
            appSubmissions: `${row.replayCount}c+0r+0x`,
            appTerminal: appSettled.outcome.observedTerminals[0] ?? "none",
            usage: "none-reported",
            keysDigest: keysDigestOf(appKeys),
            bodyDigest: bodiesDigestOf(appBodies),
            manifestDigest: row.manifest.manifestDigest,
          });
          console.info(
            `[VAL-031]   ${row.rowId} -> ${result.terminal} replays=${row.replayCount} ` +
              `digests=[${runFacts[runFacts.length - 1]?.digests}] ` +
              `stability=${runFacts[runFacts.length - 1]?.stability} ` +
              `identities=${runFacts[runFacts.length - 1]?.identities} ` +
              `steps=${runFacts[runFacts.length - 1]?.steps} ` +
              `modelCalls=${runFacts[runFacts.length - 1]?.modelCalls} ` +
              `latency(min/med/max)=${runFacts[runFacts.length - 1]?.latency}ms ` +
              `app=${runFacts[runFacts.length - 1]?.appSubmissions}/${runFacts[runFacts.length - 1]?.appTerminal} ` +
              `usage=${runFacts[runFacts.length - 1]?.usage} manifest=${row.manifest.manifestDigest} ` +
              `keysDigest=${runFacts[runFacts.length - 1]?.keysDigest} ` +
              `bodyDigest=${runFacts[runFacts.length - 1]?.bodyDigest}`,
          );
        }

        // ---- the battery-level integrity (the whole offline corpus) ----
        const drivenRows = runFacts.length;
        const expectedRows = WORKLOAD_REPLAY_CORPUS.filter(
          (row) => row.liveGate === undefined,
        ).length;
        expect(drivenRows).toBe(expectedRows);
        const totalReplays = runFacts.reduce((sum, fact) => sum + fact.replays, 0);

        // No phantom executions: exactly ONE durable execution per replay
        // across the whole corpus (every population landed its OWN N).
        const execCount = await ctx.port.execute<{ c: number }>({
          sql: `SELECT count(*)::int AS c FROM executions.executions WHERE application_id = $1`,
          parameters: [world.applicationId],
        });
        expect(Number(execCount.rows[0]?.c ?? 0), "no phantom executions").toBe(totalReplays);

        // The idempotency ledger: exactly ONE create arbitration per
        // replay submission key (no ledger drift).
        const keyCount = await ctx.port.execute<{ c: number }>({
          sql: `SELECT count(*)::int AS c FROM platform.idempotency_records
              WHERE application_id = $1 AND operation_name = 'executions.create'`,
          parameters: [world.applicationId],
        });
        expect(Number(keyCount.rows[0]?.c ?? 0), "no ledger drift").toBe(totalReplays);

        // Zero orphan events.
        const orphans = await ctx.port.execute<{ c: number }>({
          sql: `SELECT count(*)::int AS c FROM executions.execution_events e
              LEFT JOIN executions.executions x ON e.execution_id = x.id
              WHERE e.application_id = $1 AND x.id IS NULL`,
          parameters: [world.applicationId],
        });
        expect(Number(orphans.rows[0]?.c ?? 0), "zero orphan events").toBe(0);

        // The replay ledger holds exactly ONE immutable identity per
        // replay across the whole corpus (exactly N per row — no
        // duplicates, no gaps).
        const ledgerCount = await ctx.port.execute<{ c: number }>({
          sql: `SELECT count(*)::int AS c FROM platform.idempotency_records
              WHERE application_id = $1 AND operation_name = $2`,
          parameters: [world.applicationId, LEDGER_OPERATION],
        });
        expect(Number(ledgerCount.rows[0]?.c ?? 0), "one identity per replay").toBe(totalReplays);

        // The append-only registry history over REAL SQL: the superseded
        // RAG revision 1 stays intact and verifiable after the
        // correction (the r1→r2 correction discipline as durable fact —
        // the replays never rewrote the manifests).
        const ragHistory = registry.historyOf("portfolio:rag", "golden:rag-retrieval");
        expect(
          ragHistory.map((entry) => entry.workloadRevision),
          "the append-only RAG correction history",
        ).toEqual([1, 2]);
        for (const row of WORKLOAD_REPLAY_CORPUS) {
          if (row.liveGate !== undefined) {
            continue;
          }
          const entry = registry.entryFor({
            appId: row.manifest.appId,
            workloadId: row.manifest.workloadId,
            workloadRevision: row.manifest.workloadRevision,
          });
          expect(entry?.manifest.manifestDigest, `${row.rowId} registry pin`).toBe(
            row.manifest.manifestDigest,
          );
        }

        const completed = runFacts.filter((fact) => fact.terminal === "COMPLETED").length;
        const failed = runFacts.filter((fact) => fact.terminal === "FAILED").length;
        const totalSteps = runFacts.reduce((sum, fact) => sum + fact.steps, 0);
        console.info(
          `[VAL-031] OFFLINE corpus summary: ${completed} COMPLETED / ${failed} FAILED (both honest) ` +
            `of ${runFacts.length} driven replay populations (${totalReplays} replays total — every ` +
            `population exactly-N, no duplicates, no gaps); ${totalSteps} trajectory steps recorded ` +
            `through the REAL recorder path (every projected digest a member of its pinned class; the ` +
            `varying population REPORTED varying with its observed distribution); the replay ledger ` +
            `holds exactly ${ledgerCount.rows[0]?.c} immutable identities (ONE per replay); the ` +
            `registry holds the append-only history (r1→r2 correction intact over REAL SQL); usage ` +
            `honestly none-reported offline; latency measured, never estimated; digests only, payload ` +
            `bytes never journaled.`,
        );
      } finally {
        await world.server.app.close();
      }
    });

    test("the REAL live rail drives the replay population with REAL model confirmation rounds", {
      timeout: 600_000,
    }, async () => {
      const generateId = createUuidv7Generator();
      const notRun: string[] = [];
      if (OPENROUTER_KEY.length === 0) {
        console.warn(
          "[VAL-031] OPENROUTER_API_KEY absent — the REAL live replay row is a NOT RUN " +
            "boundary (recorded honestly; no fake success is asserted). The offline corpus above " +
            "covers every population/membership/stability/accounting path without credentials. " +
            "Required access: an operator-authorized OpenRouter credential (env OPENROUTER_API_KEY) " +
            "covering the default chat model — the live replay population demands a REAL model " +
            "confirmation round per replay (measured usage per replay, never estimated, never " +
            "fabricated).",
        );
        expect(true).toBe(true);
        return;
      }

      const world = await seedApiPgWorld(ctx.port);
      const address = await world.server.app.listen({ port: 0, host: "127.0.0.1" });
      const driven = new Set<string>();
      const runFacts: RunFacts[] = [];

      try {
        // The REAL durable registry + ledger for the live world.
        const registry = await seedRealReplayBaselineRegistry(ctx, world);
        const ledger = createRealReplayLedger(ctx, world);

        // ONE live dispatch binding for ALL live rows (the VAL-025
        // review lesson): the connection and its sealed credential
        // envelope are registered ONCE and shared.
        let liveDispatch: ControlDispatch | undefined;
        for (const [taskIndex, row] of WORKLOAD_REPLAY_CORPUS.entries()) {
          if (row.liveGate === undefined) {
            continue;
          }
          if (!liveGateOpen(row, process.env)) {
            notRun.push(
              `${row.rowId} — gate closed (${row.liveGate.envVars.join("+")} absent); ` +
                `requirement: ${row.liveGate.requirement}`,
            );
            continue;
          }
          // Provider-side pacing before the live population.
          await new Promise((resolve) => setTimeout(resolve, 2_000));
          const runSuffix = `live-${generateId().slice(-8)}`;
          if (liveDispatch === undefined) {
            liveDispatch = (await buildLiveDispatch(ctx, world)).dispatch;
          }
          const dispatch: ControlDispatch = liveDispatch;
          const { populationId, landed, result, appSettled, appKeys, appBodies } =
            await driveCrownPopulation({
              ctx,
              world,
              address,
              row,
              taskIndex,
              runSuffix,
              registry,
              ledger,
              driven,
              dispatch,
            });

          await verifyCrownRow({ ctx, world, row, populationId, landed, result, appSettled });

          const distribution = result.stability.observedDistribution
            .map((entry) => `${entry.digest}x${entry.count}`)
            .join("|");
          const usage =
            result.usage === null
              ? "none-reported"
              : `${result.usage.inputTokens}+${result.usage.outputTokens}` +
                (result.usage.costUsd === undefined ? "" : `/$${result.usage.costUsd}`);
          const stepsPerReplay = result.replays.map(
            () => controlTrajectoryStepsOf({ workload: row.workload }).length,
          );
          runFacts.push({
            rowId: row.rowId,
            terminal: result.terminal,
            replays: row.replayCount,
            digests: result.replays.map((replay) => replay.trajectoryDigest ?? "none").join(","),
            stability: `${result.stability.observedKind} (${distribution})`,
            identities: row.replayCount,
            steps: stepsPerReplay.reduce((sum, count) => sum + count, 0),
            modelCalls: `${result.observedModelCalls}/${row.expectedModelCallsPerReplay * row.replayCount}`,
            latency: `${result.latency.minMs ?? 0}/${result.latency.medianMs ?? 0}/${result.latency.maxMs ?? 0}`,
            totalLatencyMs: result.totalLatencyMs,
            appSubmissions: `${row.replayCount}c+0r+0x`,
            appTerminal: appSettled.outcome.observedTerminals[0] ?? "none",
            usage,
            keysDigest: keysDigestOf(appKeys),
            bodyDigest: bodiesDigestOf(appBodies),
            manifestDigest: row.manifest.manifestDigest,
          });
          console.info(
            `[VAL-031]   LIVE ${row.rowId} -> ${result.terminal} replays=${row.replayCount} ` +
              `digests=[${runFacts[runFacts.length - 1]?.digests}] ` +
              `identities=${runFacts[runFacts.length - 1]?.identities} ` +
              `modelCalls=${runFacts[runFacts.length - 1]?.modelCalls} ` +
              `latency(min/med/max)=${runFacts[runFacts.length - 1]?.latency}ms ` +
              `usage=${runFacts[runFacts.length - 1]?.usage}`,
          );
        }

        const completed = runFacts.filter((fact) => fact.terminal === "COMPLETED").length;
        console.info(
          `[VAL-031] LIVE rail summary: ${completed} COMPLETED of ${runFacts.length} driven live ` +
            `replay populations over the REAL OpenRouter rail (model ${MODEL}); measured usage on ` +
            `every replay's dispatched round (BYOK); digests only, payload bytes never journaled.`,
        );
        for (const boundary of notRun) {
          console.warn(`[VAL-031] NOT RUN boundary: ${boundary}`);
        }
        // At least one REAL live dispatch happened (never an
        // all-NOT-RUN silent pass once a credential is present).
        expect(runFacts.length).toBeGreaterThan(0);
      } finally {
        await world.server.app.close();
      }
    });
  },
);
