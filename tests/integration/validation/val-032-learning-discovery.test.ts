/**
 * VAL-032 acceptance criteria 3, 4, 5, 7 — the crown proof: the pinned
 * learning-discovery corpus drives its discovery runs end to end over
 * the REAL platform path (the learned-structure discovery every later
 * application claim must stand on).
 *
 * REAL pieces in this suite (nothing faked on the critical path):
 *   - the REAL replay-ledger input over REAL SQL: every discovery row's
 *     recorded VAL-031 population (the immutable replay identities, the
 *     observed trajectory digests and the payload-free structural
 *     digests — digests only, never payload bytes) is committed through
 *     the REAL platform.idempotency_records unique-index arbitration
 *     (one append-only row per recorded observation: the observation's
 *     content digest as the request fingerprint — an identical
 *     re-commit replays, a different content commit is an append-only
 *     violation that throws), and the port serves the populations and
 *     its own facts (every population digest + the frozen baseline
 *     registry digest over the REAL committed manifests) from the REAL
 *     durable rows (the read-through snapshot loaded from SQL at
 *     binding time — the discovery reads them, it never rewrites them;
 *     the port contract is synchronous by design, so the binding is a
 *     SQL-backed read-through snapshot, refreshed from fresh SQL reads
 *     for every no-application proof);
 *   - the REAL candidate registry over REAL SQL: every VERIFIED
 *     proposal lands through the same REAL unique-index arbitration
 *     (the derived proposal identity as the idempotency key, the
 *     proposal's content digest as the request fingerprint): append-only
 *     exactly-once — an IDENTICAL re-proposal REPLAYS the immutable
 *     identity, a DIFFERENT proposal under a recorded id is REFUSED —
 *     and the facts view mirrors exactly what the SQL arbitration
 *     committed (the `proposed` lifecycle stage only — never an applied
 *     stage; discovery proposes, application is VAL-033+'s scope);
 *   - the REAL reference miner (the platform's PURE
 *     deriveHonestDiscoveryOutcome) over the SQL-served populations;
 *   - the REAL Fastify public API served over the REAL SQL authorities
 *     (seeded PostgreSQL world) on a real port — the customer
 *     application (runLearningDiscoveryApp) rides the public SDK
 *     boundary: each discovery submission lands its OWN durable
 *     execution under its OWN idempotency key, the completion poll
 *     observes the honest terminal (an honest refusal is a COMPLETED
 *     discovery), the result retrieval observes the verification
 *     statuses and the route's model-call count, and the events read
 *     re-derives the discovery trajectory digest over the PUBLIC
 *     step-event journal;
 *   - the REAL execution lifecycle per discovery run: the canonical
 *     transitions (authorize → plan → the durable planning decision →
 *     queue → start → the discovery run → verify → pass), the terminal
 *     derived MECHANICALLY (the discovery run's own criteria) and the
 *     verification criteria recorded durably with the terminal
 *     transition;
 *   - the REAL recorder path: every discovery trajectory step (the
 *     live row's REAL confirmation round, the read-only population
 *     read, the structure mining, the citation derivation, the
 *     mechanical verification, the registry recording or the honest
 *     refusal) is journaled through the REAL executions recordStepEvent
 *     seam — and the crown mechanically verifies over REAL SQL that the
 *     journal projects EXACTLY the canonical discovery trajectory: the
 *     projected trajectory digest IS the pinned class member;
 *   - the REAL no-application proof: the replay-ledger input's own
 *     frozen digest (populations + baseline manifests over FRESH SQL
 *     reads) is snapshotted BEFORE and AFTER every discovery run and
 *     across the whole corpus — identical (the recorded populations are
 *     read-only inputs; discovery proposes, never applies).
 *
 * Boundary recorded honestly (the val-031 crown precedent): the
 * app-side proposal read-back and the raw public-events trajectory
 * digest re-derivation are exercised over the controlled fake world in
 * the unit suite — over the REAL journal the public event projection
 * carries type+sequence (the platform's own lifecycle envelopes are
 * legitimately part of the public stream, and the discovery outcome's
 * read-back proposal field is the fake world's forward projection of
 * the discovery result surface), so the crown verifies the discovery
 * trajectory reproduction through the REAL recorder path (the SQL
 * projection over the journaled reference) and asserts the app legs
 * that ARE observable over the real wire (submissions landed,
 * terminals, the route's model-call count, the measured submission
 * latency) directly.
 *
 * The live rail row (env-gated on the operator-authorized
 * OPENROUTER_API_KEY) drives ONE REAL model confirmation round through
 * the REAL platform model gateway (measured usage, never estimated,
 * never fabricated) before its deterministicization proposal lands in
 * the REAL candidate registry. Absent credentials are a recorded NOT
 * RUN boundary — never a fake success.
 */

import { createHash } from "node:crypto";
import { expect, test } from "vitest";
import { runLearningDiscoveryApp } from "../../../benchmarks/validation/apps/learning-discovery/application";
import {
  discoverySubmissionKey,
  discoveryTaskBodyFor,
  LEARNING_DISCOVERY_CORPUS,
  LEARNING_DISCOVERY_TASK_KIND,
  liveGateOpen,
  REFERENCED_REPLAY_ROWS,
} from "../../../benchmarks/validation/apps/learning-discovery/corpus";
import { frozenBaselineRegistryDigestOf } from "../../../benchmarks/validation/apps/learning-discovery/fixtures";
import { validateHarnessEvidence } from "../../../benchmarks/validation/harness";
import type { LabUsage } from "../../../benchmarks/validation/platform/derive";
import type {
  CandidateRegistryFacts,
  CandidateRegistryPort,
  DiscoveryMinerPort,
  DiscoveryProposalRecord,
  LearningDiscoveryCorpusRow,
  LearningDiscoveryResult,
  RecordedReplayObservation,
  ReplayLedgerInputFacts,
  ReplayLedgerInputPort,
} from "../../../benchmarks/validation/platform/learning-discovery";
import {
  deriveHonestDiscoveryOutcome,
  discoveryTrajectoryStepsOf,
  driveLearningDiscovery,
  PROPOSAL_LIFECYCLE_STAGE,
  recordedPopulationDigestOf,
  replayLedgerInputDigestOf,
} from "../../../benchmarks/validation/platform/learning-discovery";
import type {
  ControlDispatch,
  TrajectoryStepKind,
  TrajectoryStepRecord,
} from "../../../benchmarks/validation/platform/longitudinal-baseline";
import {
  longitudinalDigestOf,
  trajectoryDigestOf,
} from "../../../benchmarks/validation/platform/longitudinal-baseline";
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
const MODEL = process.env.ZECK_VAL_032_MODEL ?? "meta-llama/llama-3.3-70b-instruct";
const REVISION = createHash("sha256")
  .update("val-032|learning-discovery|pinned")
  .digest("hex")
  .slice(0, 40);
const MAX_TOKENS = 64;

/** The REAL SQL operations the crown's durable bindings ride. */
const LEDGER_INPUT_OPERATION = "val-032.replay-ledger-input";
const BASELINE_OPERATION = "val-032.baseline-registry";
const REGISTRY_OPERATION = "val-032.candidate-registry";

/** Per-run REAL facts collected for the evidence document. */
interface RunFacts {
  readonly rowId: string;
  readonly terminal: string;
  readonly outcome: string;
  readonly populationSize: number;
  readonly structureDigest: string;
  readonly proposalId: string;
  readonly registryRecording: string;
  readonly modelCalls: string;
  readonly latencyMs: number;
  readonly appSubmissionLatencyMs: number;
  readonly appTerminal: string | null;
  readonly usage: string;
  readonly keysDigest: string;
  readonly bodyDigest: string;
}

/** The app's own outcome (the settled app promise's payload). */
interface AppOutcome {
  readonly ok: true;
  readonly outcome: Awaited<ReturnType<typeof runLearningDiscoveryApp>>;
}

// ---------------------------------------------------------------------------
// The REAL durable bindings (the platform slice's discovery ports)
// ---------------------------------------------------------------------------

/** The observation's content digest (payload-free — digests only). */
function observationDigestOf(observation: RecordedReplayObservation): string {
  return longitudinalDigestOf([
    observation.workloadId,
    observation.replayOrdinal,
    observation.replayIdentity,
    observation.trajectoryDigest,
    observation.subTrajectoryShapeDigest,
    observation.inputDigest,
    observation.outputDigest,
    observation.stepPatternDigest,
    observation.dispatchedRounds,
  ]);
}

/** The proposal's content digest (payload-free — digests only). */
function proposalContentDigestOf(record: DiscoveryProposalRecord): string {
  return longitudinalDigestOf([
    record.kind,
    record.citation.trajectoryDigests,
    record.citation.replayIdentities,
    record.minedStructureDigest,
    record.lifecycleStage,
  ]);
}

/** Parse one durable observation row back into the recorded vocabulary. */
function parseObservation(outcome: Record<string, unknown>): {
  readonly observation: RecordedReplayObservation;
  /** The observation's 1-based position within its row's population (the serve order). */
  readonly position: number;
} | null {
  const strings = [
    outcome.workloadId,
    outcome.replayIdentity,
    outcome.trajectoryDigest,
    outcome.subTrajectoryShapeDigest,
    outcome.inputDigest,
    outcome.outputDigest,
    outcome.stepPatternDigest,
  ];
  if (strings.some((value) => typeof value !== "string")) {
    return null;
  }
  if (
    typeof outcome.replayOrdinal !== "number" ||
    typeof outcome.dispatchedRounds !== "number" ||
    typeof outcome.position !== "number"
  ) {
    return null;
  }
  return {
    observation: {
      workloadId: outcome.workloadId as string,
      replayOrdinal: outcome.replayOrdinal as number,
      replayIdentity: outcome.replayIdentity as string,
      trajectoryDigest: outcome.trajectoryDigest as string,
      subTrajectoryShapeDigest: outcome.subTrajectoryShapeDigest as string,
      inputDigest: outcome.inputDigest as string,
      outputDigest: outcome.outputDigest as string,
      stepPatternDigest: outcome.stepPatternDigest as string,
      dispatchedRounds: outcome.dispatchedRounds as number,
    },
    position: outcome.position as number,
  };
}

/** The REAL SQL read-back of the ledger-input operation's durable rows. */
async function readLedgerSqlRows(
  ctx: PgContext,
  world: ApiPgWorld,
): Promise<readonly { readonly key: string; readonly outcome: Record<string, unknown> }[]> {
  const readBack = await ctx.port.execute<{
    idempotency_key: string;
    durable_outcome: Record<string, unknown>;
  }>({
    sql: `SELECT idempotency_key, durable_outcome FROM platform.idempotency_records
          WHERE application_id = $1 AND operation_name = $2
          ORDER BY created_at ASC, id ASC`,
    parameters: [world.applicationId, LEDGER_INPUT_OPERATION],
  });
  return readBack.rows.map((row) => ({ key: row.idempotency_key, outcome: row.durable_outcome }));
}

/** The REAL SQL read-back of the baseline operation's durable rows. */
async function readBaselineSqlRows(
  ctx: PgContext,
  world: ApiPgWorld,
): Promise<
  readonly {
    readonly appId: string;
    readonly workloadId: string;
    readonly workloadRevision: number;
    readonly manifestDigest: string;
  }[]
> {
  const readBack = await ctx.port.execute<{ durable_outcome: Record<string, unknown> }>({
    sql: `SELECT durable_outcome FROM platform.idempotency_records
          WHERE application_id = $1 AND operation_name = $2
          ORDER BY created_at ASC, id ASC`,
    parameters: [world.applicationId, BASELINE_OPERATION],
  });
  return readBack.rows.flatMap((row) => {
    const appId = typeof row.durable_outcome?.appId === "string" ? row.durable_outcome.appId : null;
    const workloadId =
      typeof row.durable_outcome?.workloadId === "string" ? row.durable_outcome.workloadId : null;
    const workloadRevision =
      typeof row.durable_outcome?.workloadRevision === "number"
        ? row.durable_outcome.workloadRevision
        : null;
    const manifestDigest =
      typeof row.durable_outcome?.manifestDigest === "string"
        ? row.durable_outcome.manifestDigest
        : null;
    if (
      appId === null ||
      workloadId === null ||
      workloadRevision === null ||
      manifestDigest === null
    ) {
      return [];
    }
    return [{ appId, workloadId, workloadRevision, manifestDigest }];
  });
}

/** The ledger-input facts over FRESH REAL SQL reads (the snapshot basis). */
async function replayLedgerFactsFromSql(
  ctx: PgContext,
  world: ApiPgWorld,
): Promise<ReplayLedgerInputFacts> {
  const [ledgerRows, baselineRows] = await Promise.all([
    readLedgerSqlRows(ctx, world),
    readBaselineSqlRows(ctx, world),
  ]);
  const byRow = new Map<string, RecordedReplayObservation[]>();
  for (const ledgerRow of ledgerRows) {
    const parsed = parseObservation(ledgerRow.outcome);
    if (parsed === null) {
      continue;
    }
    const rowId = ledgerRow.key.split("::obs-")[0] ?? "";
    byRow.set(rowId, [...(byRow.get(rowId) ?? []), parsed.observation]);
  }
  return {
    populations: [...byRow.entries()]
      .map(([rowId, observations]) => ({
        rowId,
        populationDigest: recordedPopulationDigestOf(
          // The digest basis is canonically sorted — order-independent —
          // but sort by the recorded serve position for determinism.
          [...observations].sort((left, right) =>
            left.replayIdentity.localeCompare(right.replayIdentity),
          ),
        ),
      }))
      .sort((left, right) => left.rowId.localeCompare(right.rowId)),
    baselineRegistryDigest: longitudinalDigestOf(
      baselineRows.map((entry) => [
        entry.appId,
        entry.workloadId,
        `r${entry.workloadRevision}`,
        entry.manifestDigest,
      ]),
    ),
  };
}

/** The REAL SQL ledger-input binding (a read-through snapshot + fresh reads). */
interface RealLedgerInputBinding extends ReplayLedgerInputPort {
  /** Re-read the REAL durable rows (the fresh no-application snapshot basis). */
  refreshFacts(): Promise<ReplayLedgerInputFacts>;
}

/**
 * The REAL replay-ledger input: every discovery row's recorded VAL-031
 * population is committed through the REAL SQL unique-index arbitration
 * (ONE append-only row per recorded observation — the observation's
 * content digest as the request fingerprint; an identical re-commit
 * replays, a different content commit is an append-only violation that
 * throws), and the port serves the populations and its own facts from
 * the REAL durable rows: the read-through snapshot loaded from SQL at
 * binding time (the port contract is synchronous by design — the
 * binding is a SQL-backed read-through snapshot), refreshed from FRESH
 * SQL reads for every no-application proof (refreshFacts). The facts
 * view's frozen digest (every population digest + the frozen baseline
 * registry digest over the REAL committed manifests) is the
 * no-application snapshot basis.
 */
async function seedRealReplayLedgerInput(
  ctx: PgContext,
  world: ApiPgWorld,
  rows: readonly LearningDiscoveryCorpusRow[],
): Promise<RealLedgerInputBinding> {
  const generateId = createUuidv7Generator();

  const commitOne = async (
    rowId: string,
    observation: RecordedReplayObservation,
    /** The observation's 1-based position within its row's population. */
    position: number,
  ): Promise<void> => {
    const key = `${rowId}::obs-${position}`;
    const fingerprint = observationDigestOf(observation);
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
          LEDGER_INPUT_OPERATION,
          key,
          fingerprint,
          JSON.stringify({ ...observation, position }),
        ],
      });
      if (inserted.rows.length > 0) {
        return;
      }
      const existing = await tx.execute<{ request_fingerprint: string }>({
        sql: `SELECT request_fingerprint FROM platform.idempotency_records
              WHERE application_id = $1 AND operation_name = $2 AND idempotency_key = $3`,
        parameters: [world.applicationId, LEDGER_INPUT_OPERATION, key],
      });
      const existingRow = existing.rows[0];
      if (existingRow === undefined) {
        throw new Error(`the ledger-input arbitration lost the observation ${key}`);
      }
      if (existingRow.request_fingerprint !== fingerprint) {
        throw new Error(
          `append-only violation: the recorded observation ${key} is already committed with ` +
            "different content — the recorded populations are read-only inputs",
        );
      }
      // The identical re-commit replays the recorded observation.
    });
  };

  // The frozen baseline registry over the referenced VAL-031 manifests:
  // one append-only row per referenced manifest (the manifest digest as
  // the request fingerprint — the read-through basis of the frozen
  // digest).
  const commitBaseline = async (
    manifest: {
      readonly appId: string;
      readonly workloadId: string;
      readonly workloadRevision: number;
      readonly manifestDigest: string;
    },
    committedAt: string,
  ): Promise<void> => {
    const key = `${manifest.appId}|${manifest.workloadId}|r${manifest.workloadRevision}`;
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
          BASELINE_OPERATION,
          key,
          manifest.manifestDigest,
          JSON.stringify({ ...manifest, committedAt }),
        ],
      });
      if (inserted.rows.length > 0) {
        return;
      }
      const existing = await tx.execute<{ request_fingerprint: string }>({
        sql: `SELECT request_fingerprint FROM platform.idempotency_records
              WHERE application_id = $1 AND operation_name = $2 AND idempotency_key = $3`,
        parameters: [world.applicationId, BASELINE_OPERATION, key],
      });
      const existingRow = existing.rows[0];
      if (existingRow === undefined) {
        throw new Error(`the baseline arbitration lost the pin ${key}`);
      }
      if (existingRow.request_fingerprint !== manifest.manifestDigest) {
        throw new Error(
          `append-only violation: the baseline pin ${key} is already committed with different content`,
        );
      }
    });
  };

  // The deterministic seeding pass: every referenced baseline manifest,
  // then every recorded observation of every served row in population
  // order (the 1-based position keys the append-only row — a row's
  // flattened population may legitimately hold restarting replay
  // ordinals across its referenced populations).
  for (const [index, replayRow] of REFERENCED_REPLAY_ROWS.entries()) {
    await commitBaseline(
      replayRow.manifest,
      `2025-03-01T00:${String(index + 1).padStart(2, "0")}:00.000Z`,
    );
  }
  for (const row of rows) {
    for (const [index, observation] of row.population.entries()) {
      await commitOne(row.rowId, observation, index + 1);
    }
  }

  // The read-through snapshot: loaded from the REAL durable rows once,
  // served synchronously through the port contract.
  const loadSnapshot = async (): Promise<{
    readonly populations: Map<string, RecordedReplayObservation[]>;
    readonly facts: ReplayLedgerInputFacts;
  }> => {
    const facts = await replayLedgerFactsFromSql(ctx, world);
    const ledgerRows = await readLedgerSqlRows(ctx, world);
    const byRow = new Map<
      string,
      { readonly observation: RecordedReplayObservation; readonly position: number }[]
    >();
    for (const ledgerRow of ledgerRows) {
      const parsed = parseObservation(ledgerRow.outcome);
      if (parsed === null) {
        continue;
      }
      const rowId = ledgerRow.key.split("::obs-")[0] ?? "";
      byRow.set(rowId, [...(byRow.get(rowId) ?? []), parsed]);
    }
    // The serve order is the recorded population order (the pinned
    // citation's replay-identity order).
    const populations = new Map<string, RecordedReplayObservation[]>();
    for (const [rowId, entries] of byRow.entries()) {
      populations.set(
        rowId,
        [...entries]
          .sort((left, right) => left.position - right.position)
          .map((entry) => entry.observation),
      );
    }
    return { populations, facts };
  };
  const snapshot = await loadSnapshot();

  return {
    populationFor(row) {
      return (snapshot.populations.get(row.rowId) ?? []).map((observation) => ({
        ...observation,
      }));
    },
    facts() {
      return snapshot.facts;
    },
    refreshFacts: () => replayLedgerFactsFromSql(ctx, world),
  };
}

/** The REAL SQL candidate-registry binding (arbitration + a truthful mirror). */
interface RealCandidateRegistryBinding extends CandidateRegistryPort {
  /** Re-read the REAL durable rows (the read-back verification basis). */
  refreshFacts(): Promise<CandidateRegistryFacts>;
}

/**
 * The REAL candidate registry: every proposal lands through the REAL
 * SQL unique-index arbitration (the derived proposal identity as the
 * idempotency key, the proposal's content digest as the request
 * fingerprint). The first proposal RECORDS the lifecycle candidate at
 * the `proposed` stage (ONE immutable identity per proposal —
 * append-only); a same-content re-proposal REPLAYS it (exactly-once,
 * never a second row); a different-content re-proposal is REFUSED (the
 * identity's content is immutable). The synchronous facts view mirrors
 * EXACTLY what the SQL arbitration committed (the mirror is updated
 * only after the SQL transaction resolved), and refreshFacts re-reads
 * the REAL durable rows back.
 */
function createRealCandidateRegistry(
  ctx: PgContext,
  world: ApiPgWorld,
): RealCandidateRegistryBinding {
  const generateId = createUuidv7Generator();
  // The truthful mirror: exactly the rows the SQL arbitration committed.
  let mirror: readonly {
    readonly proposalId: string;
    readonly kind: DiscoveryProposalRecord["kind"];
    readonly lifecycleStage: DiscoveryProposalRecord["lifecycleStage"];
    readonly citationDigest: string;
    readonly minedStructureDigest: string;
  }[] = [];

  const factsOf = (): CandidateRegistryFacts => ({
    candidates: mirror.map((candidate) => ({ ...candidate })),
    appliedCandidateCount: mirror.filter(
      (candidate) => candidate.lifecycleStage !== PROPOSAL_LIFECYCLE_STAGE,
    ).length,
  });

  const refreshFacts = async (): Promise<CandidateRegistryFacts> => {
    const rows = await ctx.port.execute<{
      idempotency_key: string;
      durable_outcome: Record<string, unknown>;
    }>({
      sql: `SELECT idempotency_key, durable_outcome FROM platform.idempotency_records
            WHERE application_id = $1 AND operation_name = $2
            ORDER BY created_at ASC, id ASC`,
      parameters: [world.applicationId, REGISTRY_OPERATION],
    });
    mirror = rows.rows.flatMap((row) => {
      const kind = typeof row.durable_outcome?.kind === "string" ? row.durable_outcome.kind : null;
      const lifecycleStage =
        typeof row.durable_outcome?.lifecycleStage === "string"
          ? row.durable_outcome.lifecycleStage
          : null;
      const citationDigest =
        typeof row.durable_outcome?.citationDigest === "string"
          ? row.durable_outcome.citationDigest
          : null;
      const minedStructureDigest =
        typeof row.durable_outcome?.minedStructureDigest === "string"
          ? row.durable_outcome.minedStructureDigest
          : null;
      if (
        kind === null ||
        lifecycleStage === null ||
        citationDigest === null ||
        minedStructureDigest === null
      ) {
        return [];
      }
      return [
        {
          proposalId: row.idempotency_key,
          kind: kind as DiscoveryProposalRecord["kind"],
          lifecycleStage: lifecycleStage as DiscoveryProposalRecord["lifecycleStage"],
          citationDigest,
          minedStructureDigest,
        },
      ];
    });
    return factsOf();
  };

  return {
    async propose(record) {
      const contentDigest = proposalContentDigestOf(record);
      const citationDigest = longitudinalDigestOf([
        record.citation.trajectoryDigests,
        record.citation.replayIdentities,
      ]);
      const receipt = await ctx.port.transaction(async (tx: Transaction) => {
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
            record.proposalId,
            contentDigest,
            JSON.stringify({
              kind: record.kind,
              lifecycleStage: record.lifecycleStage,
              citationDigest,
              minedStructureDigest: record.minedStructureDigest,
            }),
          ],
        });
        if (inserted.rows.length > 0) {
          // The first proposal RECORDS the lifecycle candidate (ONE
          // immutable identity per proposal — append-only).
          return { accepted: true, replayed: false, refused: false };
        }
        const existing = await tx.execute<{ request_fingerprint: string }>({
          sql: `SELECT request_fingerprint FROM platform.idempotency_records
                WHERE application_id = $1 AND operation_name = $2 AND idempotency_key = $3`,
          parameters: [world.applicationId, REGISTRY_OPERATION, record.proposalId],
        });
        const row = existing.rows[0];
        if (row === undefined) {
          throw new Error(
            `the candidate registry arbitration lost the proposal ${record.proposalId}`,
          );
        }
        if (row.request_fingerprint === contentDigest) {
          // The IDENTICAL re-proposal REPLAYS the recorded identity
          // (exactly-once — never a second row).
          return { accepted: true, replayed: true, refused: false };
        }
        // The proposal's content is IMMUTABLE — the honest refusal.
        return { accepted: false, replayed: false, refused: true };
      });
      // The mirror reflects EXACTLY what the SQL arbitration committed
      // (updated only after the transaction resolved).
      if (receipt.accepted && !receipt.replayed) {
        mirror = [
          ...mirror,
          {
            proposalId: record.proposalId,
            kind: record.kind,
            lifecycleStage: record.lifecycleStage,
            citationDigest,
            minedStructureDigest: record.minedStructureDigest,
          },
        ];
      }
      return receipt;
    },
    facts: factsOf,
    refreshFacts,
  };
}

/**
 * The REAL reference miner (the platform's PURE honest discovery
 * derivation over the SQL-served population — the mining engine the
 * crown binds at the seam).
 */
const REFERENCE_MINER: DiscoveryMinerPort = {
  mine(input) {
    return deriveHonestDiscoveryOutcome({
      candidateKind: input.candidateKind,
      population: input.population,
    });
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
// The REAL lifecycle driving (the canonical transitions per discovery run)
// ---------------------------------------------------------------------------

/** The canonical prologue: authorize → plan → the planning decision → queue → start. */
async function driveLifecycleToRunning(
  world: ApiPgWorld,
  executionId: string,
  row: LearningDiscoveryCorpusRow,
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
        reason: `val-032-${command}`,
      },
      `val-032-${executionId}-${command}-${transitionCounter.count}`,
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
            strategyId: "val-032-discovery",
            plan: {
              strategyClass: "learning-discovery",
              // The discovery run's OWN dispatch demand — the route read
              // surfaces it at the customer boundary.
              modelCalls: row.expected.modelCalls,
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
        selectedStrategyId: "val-032-discovery",
      },
    },
    `val-032-${executionId}-decision`,
  );
  await transition("queue");
  await transition("start");
}

/**
 * The verification boundary + the terminal for ONE discovery run's
 * landed execution: the mechanically derived verdict (the discovery
 * run's own criteria — every leg: the population pin, the citation
 * completeness, the kind fidelity, the conservatism, the refusal
 * honesty, the registry landing, the no-application discipline, the
 * outcome contract, the digest discipline, the own-dispatch total)
 * recorded durably with the terminal transition.
 */
async function completeDiscoveryExecution(
  world: ApiPgWorld,
  executionId: string,
  result: LearningDiscoveryResult,
): Promise<void> {
  await world.executions.transition(
    {
      actorId: world.actorId,
      applicationId: world.applicationId,
      tenantId: world.tenantId,
      executionId,
      command: "verify",
      reason: "val-032-verify",
    },
    `val-032-${executionId}-verify`,
  );
  const verdict = result.terminal === "COMPLETED" ? "pass" : "fail";
  await world.executions.transition(
    {
      actorId: world.actorId,
      applicationId: world.applicationId,
      tenantId: world.tenantId,
      executionId,
      command: verdict,
      reason:
        verdict === "pass"
          ? "val-032-verified"
          : `val-032-${result.failure?.category ?? "criterion-fail"}`,
      verificationResults: result.criteria.map((criterion) => ({
        criterionId: criterion.criterionId,
        strategy: criterion.strategy,
        status: criterion.status,
        recordedBy: "val-032-platform",
        evidence: [...criterion.evidence],
      })),
    },
    `val-032-${executionId}-${verdict}`,
  );
}

// ---------------------------------------------------------------------------
// The landed-discovery provider (the app's submission lands through the
// public wire; the crown polls the REAL SQL for the durable row)
// ---------------------------------------------------------------------------

async function awaitLandedDiscoveryExecution(
  ctx: PgContext,
  world: ApiPgWorld,
  driven: Set<string>,
  row: LearningDiscoveryCorpusRow,
): Promise<string> {
  for (let attempt = 0; attempt < 4_800; attempt += 1) {
    const rows = await ctx.port.execute<{ id: string }>({
      sql: `SELECT id FROM executions.executions
            WHERE application_id = $1
              AND task->>'kind' = $2
              AND task->>'rowId' = $3
              AND id != ALL($4::uuid[])
            ORDER BY id ASC`,
      parameters: [world.applicationId, LEARNING_DISCOVERY_TASK_KIND, row.rowId, [...driven]],
    });
    if (rows.rows.length >= 1) {
      if (rows.rows.length !== 1) {
        throw new Error(
          `the row ${row.rowId} landed more executions than its discovery run ` +
            `(${rows.rows.length} > 1)`,
        );
      }
      const executionId = rows.rows[0]?.id as string;
      driven.add(executionId);
      return executionId;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(
    `no landed discovery execution for row ${row.rowId} after 120s (expected 1 durable execution)`,
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
        return { satisfied: true, catalogRevision: "val-032", satisfactions: [] };
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
      label: "val-032-openrouter",
      registerCredential: { material: OPENROUTER_KEY },
    },
    `val-032-conn-${generateId().slice(-8)}`,
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
            "You are the discovery-confirmation supervisor of a governed validation execution.",
            "You receive the learning-discovery run's confirmation request and decide whether",
            "the discovery's model confirmation round completed. Answer with the single word: confirm",
          ].join(" "),
        },
        {
          role: "user",
          content:
            `Learning-discovery confirmation round (golden:live-confirmation, round ${round}, ` +
            `attempt ${attempt}). Confirm the discovery dispatch.`,
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
 * Drive one corpus row's discovery run crown-style: the app rides the
 * public wire (ONE discovery submission → the completion poll → the
 * result read → the events read) while the crown waits for the landed
 * execution and drives the REAL lifecycle around the discovery (the
 * prologue transitions → the discovery run through the platform driver
 * with the REAL SQL ledger input / candidate registry / reference
 * miner, the frozen-input snapshots before and after from FRESH SQL
 * reads → the discovery trajectory flush through the REAL recorder
 * path → the verification boundary + the mechanically derived terminal).
 */
async function driveCrownDiscovery(options: {
  readonly ctx: PgContext;
  readonly world: ApiPgWorld;
  readonly address: string;
  readonly row: LearningDiscoveryCorpusRow;
  readonly taskIndex: number;
  readonly runSuffix: string;
  readonly ledgerInput: RealLedgerInputBinding;
  readonly registry: RealCandidateRegistryBinding;
  readonly dispatch?: ControlDispatch;
  readonly driven: Set<string>;
}): Promise<{
  readonly executionId: string;
  readonly result: LearningDiscoveryResult;
  readonly appSettled: AppOutcome;
  readonly beforeFrozenDigest: string;
  readonly afterFrozenDigest: string;
  readonly trajectorySteps: readonly TrajectoryStepRecord[];
}> {
  const { world, row, taskIndex } = options;
  const generateId = createUuidv7Generator();

  // The app promise: the customer application over the REAL served
  // public wire (the app never touches platform internals).
  const appPromise: Promise<AppOutcome> = runLearningDiscoveryApp({
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
      configuration: { suite: "val-032-learning-discovery" },
    },
    runSuffix: options.runSuffix,
    taskIndex,
  }).then((outcome) => ({ ok: true as const, outcome }));

  // The landed discovery execution (the app's submission through the
  // public wire — ONE durable execution per row).
  const executionId = await awaitLandedDiscoveryExecution(options.ctx, world, options.driven, row);

  // The canonical prologue (authorize → plan → the planning decision →
  // queue → start) — the discovery drives over the REAL state machine.
  await driveLifecycleToRunning(world, executionId, row, generateId);

  // The frozen-input snapshot BEFORE the discovery run (a FRESH REAL
  // SQL read — the no-application proof's basis).
  const beforeFrozenDigest = replayLedgerInputDigestOf(await options.ledgerInput.refreshFacts());

  // The discovery run through the platform driver with the REAL SQL
  // ledger input / candidate registry and the REAL reference miner.
  const result = await driveLearningDiscovery({
    row,
    ledgerInput: options.ledgerInput,
    miner: REFERENCE_MINER,
    registry: options.registry,
    ...(options.dispatch === undefined ? {} : { dispatch: options.dispatch }),
    retry: {
      maxExtraAttempts: 2,
      backoffMs: 4_000,
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    },
    now: () => new Date(),
  });

  // The frozen-input snapshot AFTER the discovery run (a FRESH REAL
  // SQL read — the no-application proof over REAL SQL).
  const afterFrozenDigest = replayLedgerInputDigestOf(await options.ledgerInput.refreshFacts());

  // The discovery trajectory flush through the REAL recorder path: the
  // run's canonical discovery steps journal into its landed execution
  // while the execution is RUNNING — the step events project back onto
  // the pinned discovery trajectory (verified below over REAL SQL).
  const trajectorySteps = discoveryTrajectoryStepsOf({
    populationDigest: recordedPopulationDigestOf(row.population),
    minedStructureDigest: result.structure.digest,
    proposal: result.proposal,
    refusalReason: result.refusal?.reason ?? null,
    confirmationRounds: row.expected.modelCalls,
  });
  for (const step of trajectorySteps) {
    await world.executions.recordStepEvent(
      {
        applicationId: world.applicationId,
        executionId,
        actor: { actorId: world.actorId, tenantId: world.tenantId },
        command: "agent-action-recorded",
        cause: `val-032-${step.kind}-${step.ordinal}`,
        reference: {
          kind: step.kind,
          ordinal: step.ordinal,
          detail: step.detail,
          digest: step.digest,
        },
        payload: { kind: step.kind, detail: step.detail, ordinal: step.ordinal },
      },
      `val-032-${executionId}-${step.kind}-${step.ordinal}`,
    );
  }

  // The verification boundary + the mechanically derived terminal.
  await completeDiscoveryExecution(world, executionId, result);

  const appSettled = await appPromise;
  return {
    executionId,
    result,
    appSettled,
    beforeFrozenDigest,
    afterFrozenDigest,
    trajectorySteps,
  };
}

// ---------------------------------------------------------------------------
// The per-row mechanical verification (over the REAL SQL)
// ---------------------------------------------------------------------------

/**
 * Verify one row's crown outcome mechanically: the platform's discovery
 * verdict (the terminal, every criterion, the citation/fidelity/
 * conservatism/refusal-honesty/no-application legs, the registry
 * landing), the frozen-input no-application proof (before === after,
 * over FRESH REAL SQL reads), the REAL journal projection (the
 * discovery trajectory reproduction through the REAL recorder path —
 * the projected digest IS the pinned class member, the ordinals and
 * sequences gapless), the durable terminal, the candidate registry's
 * REAL SQL row (the `proposed` lifecycle stage only), and the app's
 * honest observations over the public wire (the legs observable on the
 * real rail).
 */
async function verifyCrownRow(options: {
  readonly ctx: PgContext;
  readonly world: ApiPgWorld;
  readonly row: LearningDiscoveryCorpusRow;
  readonly executionId: string;
  readonly result: LearningDiscoveryResult;
  readonly appSettled: AppOutcome;
  readonly beforeFrozenDigest: string;
  readonly afterFrozenDigest: string;
  readonly trajectorySteps: readonly TrajectoryStepRecord[];
}): Promise<void> {
  const { ctx, world, row, result, appSettled } = options;
  const { outcome: app } = appSettled;

  // ---- the honest discovery contracts (the platform side) ----
  if (result.terminal !== row.expected.terminal) {
    console.info(
      `[VAL-032][DIAGNOSTIC] ${row.rowId} terminal=${result.terminal} failure=${JSON.stringify(result.failure)}`,
    );
    for (const criterion of result.criteria) {
      if (criterion.status === "FAIL") {
        console.info(
          `[VAL-032][DIAGNOSTIC]   FAIL ${criterion.criterionId}: ${criterion.evidence.join(" | ")}`,
        );
      }
    }
  }
  expect(result.terminal, `${row.rowId} terminal`).toBe(row.expected.terminal);
  const failedCriteria = result.criteria.filter((criterion) => criterion.status === "FAIL");
  expect(failedCriteria, `${row.rowId}: ${JSON.stringify(failedCriteria)}`).toEqual([]);
  // The outcome reproduces the pinned oracle.
  expect(result.proposal?.kind ?? null, `${row.rowId} proposal kind`).toBe(row.expected.kind);
  expect(result.refusal?.reason ?? null, `${row.rowId} refusal reason`).toBe(
    row.expected.refusalReason,
  );
  if (result.proposal !== null) {
    expect(result.citation?.complete, `${row.rowId} citation complete`).toBe(true);
    expect(result.fidelity?.faithful, `${row.rowId} kind faithful`).toBe(true);
    expect(result.registryRecording?.accepted, `${row.rowId} registry landing`).toBe(true);
    expect(result.proposal.lifecycleStage, `${row.rowId} proposed stage only`).toBe(
      PROPOSAL_LIFECYCLE_STAGE,
    );
  } else {
    expect(result.refusalHonesty?.honest, `${row.rowId} refusal honest`).toBe(true);
    expect(result.registryRecording, `${row.rowId} refusal records nothing`).toBeNull();
  }
  expect(result.conservatism.conservative, `${row.rowId} conservative`).toBe(true);
  expect(result.noApplication.inert, `${row.rowId} inert`).toBe(true);
  // The discovery made its OWN dispatches; usage honestly none offline.
  expect(result.observedModelCalls, `${row.rowId} own dispatches`).toBe(row.expected.modelCalls);
  expect(result.latencyMs, `${row.rowId} latency measured`).toBeGreaterThanOrEqual(0);
  if (row.needsDispatch) {
    expect(result.usage === null || result.usage.inputTokens >= 0, `${row.rowId} live usage`).toBe(
      true,
    );
  } else {
    expect(result.usage, `${row.rowId} offline usage none-reported`).toBeNull();
  }

  // ---- the no-application proof over FRESH REAL SQL reads ----
  expect(result.noApplication.frozenInputUnchanged, `${row.rowId} frozen unchanged`).toBe(true);
  expect(options.afterFrozenDigest, `${row.rowId} frozen digest after`).toBe(
    options.beforeFrozenDigest,
  );

  // ---- the REAL journal projection (the discovery trajectory) ----
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
    parameters: [options.executionId],
  });
  const projection: TrajectoryStepRecord[] = stepRows.rows.map((step) => ({
    ordinal: step.ordinal,
    kind: trajectoryStepKindOf(step.kind),
    detail: step.detail,
    digest: step.digest,
  }));
  expect(projection.length, `${row.rowId} journal steps`).toBe(options.trajectorySteps.length);
  expect(trajectoryDigestOf(projection), `${row.rowId} REAL journal discovery digest`).toBe(
    trajectoryDigestOf(options.trajectorySteps),
  );
  expect(row.expectedTrajectoryClass, `${row.rowId} pinned class`).toContain(
    trajectoryDigestOf(projection),
  );
  const ordinals = projection.map((step) => step.ordinal);
  expect(
    ordinals.every((ordinal, index) => ordinal === index + 1),
    `${row.rowId} ordinals: ${ordinals.join(",")}`,
  ).toBe(true);
  // Every journaled step's own digest is the canonical step digest.
  for (const [index, step] of projection.entries()) {
    expect(step.digest, `${row.rowId} step ${index + 1} digest`).toBe(
      options.trajectorySteps[index]?.digest,
    );
  }

  // ---- the durable terminal + the journal gaplessness ----
  const durable = await world.executions.getExecution(world.applicationId, options.executionId);
  expect(durable?.status, `${row.rowId} durable terminal`).toBe(row.expected.terminal);
  const events = await ctx.port.execute<{ sequence: number }>({
    sql: `SELECT sequence FROM executions.execution_events
          WHERE execution_id = $1 ORDER BY sequence ASC`,
    parameters: [options.executionId],
  });
  const sequences = events.rows.map((eventRow) => eventRow.sequence);
  expect(
    sequences.every((sequence, index) => sequence === index + 1),
    `${row.rowId} journal sequences: ${sequences.join(",")}`,
  ).toBe(true);

  // ---- the candidate registry over REAL SQL (the proposed stage only) ----
  if (result.proposal !== null) {
    const registryRow = await ctx.port.execute<{
      c: number;
      fingerprint: string;
      stage: string | null;
      kind: string | null;
    }>({
      sql: `SELECT count(*)::int AS c,
                   min(request_fingerprint) AS fingerprint,
                   min(durable_outcome->>'lifecycleStage') AS stage,
                   min(durable_outcome->>'kind') AS kind
            FROM platform.idempotency_records
            WHERE application_id = $1 AND operation_name = $2 AND idempotency_key = $3`,
      parameters: [world.applicationId, REGISTRY_OPERATION, result.proposal.proposalId],
    });
    const registryFirst = registryRow.rows[0];
    expect(Number(registryFirst?.c ?? 0), `${row.rowId} ONE registry identity`).toBe(1);
    expect(registryFirst?.stage, `${row.rowId} registry stage proposed only`).toBe(
      PROPOSAL_LIFECYCLE_STAGE,
    );
    expect(registryFirst?.kind, `${row.rowId} registry kind`).toBe(result.proposal.kind);
    expect(registryFirst?.fingerprint, `${row.rowId} registry content digest`).toBe(
      proposalContentDigestOf(result.proposal),
    );
  }

  // ---- the app's honest observations over the public wire ----
  // (The legs observable on the real rail: the submission landed its
  // OWN durable execution, the honest terminal, the route's own
  // model-call count, the measured submission latency, the durable
  // verification statuses. The proposal read-back and the raw-events
  // trajectory digest re-derivation are the recorded fake-world
  // boundary above — verified through the REAL recorder path instead.)
  expect(validateHarnessEvidence(app.evidence)).toEqual([]);
  expect(app.submission.rejection, `${row.rowId} app submission`).toBeNull();
  expect(app.submission.replayed, `${row.rowId} app created (never a shoulder-in)`).toBe(false);
  expect(app.submission.executionId, `${row.rowId} app landed`).toBe(options.executionId);
  expect(app.observedTerminal, `${row.rowId} app terminal`).toBe(row.expected.terminal);
  expect(app.observedModelCalls, `${row.rowId} app model calls`).toBe(row.expected.modelCalls);
  expect(app.submissionLatencyMs, `${row.rowId} app submission latency measured`).toBeGreaterThan(
    0,
  );
  expect(app.verificationStatuses, `${row.rowId} app verification statuses`).not.toHaveLength(0);
  for (const status of app.verificationStatuses) {
    expect(status, `${row.rowId} app verification status`).toBe("PASS");
  }
  if (row.needsDispatch) {
    expect(app.usage === null || app.usage.inputTokens >= 0, `${row.rowId} app live usage`).toBe(
      true,
    );
  } else {
    expect(app.usage, `${row.rowId} app offline usage none-reported`).toBeNull();
  }
}

/** The app key digest (payload DIGEST only — never the key bytes). */
function keysDigestOf(key: string): string {
  return createHash("sha256").update(key, "utf8").digest("hex").slice(0, 16);
}

/** The app body digest (payload DIGEST only — never the body bytes). */
function bodiesDigestOf(body: Record<string, unknown>): string {
  return createHash("sha256").update(JSON.stringify(body), "utf8").digest("hex").slice(0, 16);
}

// ---------------------------------------------------------------------------
// The suites
// ---------------------------------------------------------------------------

definePgSuite("VAL-032 learning discovery over the real platform path", (ctx) => {
  test("the offline discovery corpus drives proposal/refusal semantics over the REAL platform path", {
    timeout: 300_000,
  }, async () => {
    const world = await seedApiPgWorld(ctx.port);
    const address = await world.server.app.listen({ port: 0, host: "127.0.0.1" });
    const driven = new Set<string>();
    const runFacts: RunFacts[] = [];

    try {
      const offlineRows = LEARNING_DISCOVERY_CORPUS.filter((row) => row.liveGate === undefined);
      // The REAL SQL replay-ledger input (every offline row's recorded
      // VAL-031 population + the frozen baseline manifests) and the
      // REAL SQL candidate registry.
      const ledgerInput = await seedRealReplayLedgerInput(ctx, world, offlineRows);
      const registry = createRealCandidateRegistry(ctx, world);

      // The read-through frozen digest reproduces the pinned fixture
      // basis over REAL SQL (the baseline manifests + the recorded
      // populations are the read-only inputs).
      const initialFrozenDigest = replayLedgerInputDigestOf(await ledgerInput.refreshFacts());
      expect((await ledgerInput.refreshFacts()).baselineRegistryDigest).toBe(
        frozenBaselineRegistryDigestOf(REFERENCED_REPLAY_ROWS),
      );
      expect(ledgerInput.facts().populations).toHaveLength(offlineRows.length);
      // The snapshot's own frozen digest IS the durable state's.
      expect(replayLedgerInputDigestOf(ledgerInput.facts())).toBe(initialFrozenDigest);

      for (const [taskIndex, row] of offlineRows.entries()) {
        const generateId = createUuidv7Generator();
        const runSuffix = `it-${generateId().slice(-8)}`;
        const appKey = discoverySubmissionKey({ runSuffix, taskIndex });
        const appBody = discoveryTaskBodyFor({
          rowId: row.rowId,
          candidateKind: row.candidateKind,
        });
        const {
          executionId,
          result,
          appSettled,
          beforeFrozenDigest,
          afterFrozenDigest,
          trajectorySteps,
        } = await driveCrownDiscovery({
          ctx,
          world,
          address,
          row,
          taskIndex,
          runSuffix,
          ledgerInput,
          registry,
          driven,
        });

        await verifyCrownRow({
          ctx,
          world,
          row,
          executionId,
          result,
          appSettled,
          beforeFrozenDigest,
          afterFrozenDigest,
          trajectorySteps,
        });

        // The app key's ledger record: ONE create arbitration per
        // discovery submission key (no ledger drift — the submission
        // landed its OWN durable execution under its OWN key).
        const keyRecords = await ctx.port.execute<{ c: number }>({
          sql: `SELECT count(*)::int AS c FROM platform.idempotency_records
              WHERE application_id = $1 AND idempotency_key = $2
                AND operation_name = 'executions.create'`,
          parameters: [world.applicationId, appKey],
        });
        expect(Number(keyRecords.rows[0]?.c ?? 0), `${row.rowId} app key records`).toBe(1);

        const usage =
          result.usage === null
            ? "none-reported"
            : `${result.usage.inputTokens}+${result.usage.outputTokens}` +
              (result.usage.costUsd === undefined ? "" : `/$${result.usage.costUsd}`);
        runFacts.push({
          rowId: row.rowId,
          terminal: result.terminal,
          outcome:
            result.proposal !== null
              ? `proposal:${result.proposal.kind}`
              : `refusal:${result.refusal?.reason ?? "none"}`,
          populationSize: row.population.length,
          structureDigest: result.structure.digest,
          proposalId: result.proposal?.proposalId ?? "none",
          registryRecording:
            result.registryRecording === null
              ? "nothing-recorded"
              : `accepted:${String(result.registryRecording.accepted)}/replayed:${String(result.registryRecording.replayed)}`,
          modelCalls: `${result.observedModelCalls}/${row.expected.modelCalls}`,
          latencyMs: result.latencyMs,
          appSubmissionLatencyMs: appSettled.outcome.submissionLatencyMs,
          appTerminal: appSettled.outcome.observedTerminal,
          usage,
          keysDigest: keysDigestOf(appKey),
          bodyDigest: bodiesDigestOf(appBody),
        });
        console.info(
          `[VAL-032]   ${row.rowId} -> ${result.terminal} outcome=${runFacts[runFacts.length - 1]?.outcome} ` +
            `population=${runFacts[runFacts.length - 1]?.populationSize} ` +
            `structure=${runFacts[runFacts.length - 1]?.structureDigest} ` +
            `proposal=${runFacts[runFacts.length - 1]?.proposalId} ` +
            `registry=${runFacts[runFacts.length - 1]?.registryRecording} ` +
            `modelCalls=${runFacts[runFacts.length - 1]?.modelCalls} ` +
            `latency=${runFacts[runFacts.length - 1]?.latencyMs}ms ` +
            `appSubmission=${runFacts[runFacts.length - 1]?.appSubmissionLatencyMs}ms ` +
            `appTerminal=${runFacts[runFacts.length - 1]?.appTerminal ?? "none"} ` +
            `usage=${runFacts[runFacts.length - 1]?.usage} ` +
            `keysDigest=${runFacts[runFacts.length - 1]?.keysDigest} ` +
            `bodyDigest=${runFacts[runFacts.length - 1]?.bodyDigest}`,
        );
      }

      // ---- the battery-level integrity (the whole offline corpus) ----
      const drivenRows = runFacts.length;
      expect(drivenRows).toBe(offlineRows.length);
      const totalObservations = offlineRows.reduce((sum, row) => sum + row.population.length, 0);

      // No phantom executions: exactly ONE durable execution per
      // discovery row (every run landed its OWN).
      const execCount = await ctx.port.execute<{ c: number }>({
        sql: `SELECT count(*)::int AS c FROM executions.executions WHERE application_id = $1`,
        parameters: [world.applicationId],
      });
      expect(Number(execCount.rows[0]?.c ?? 0), "no phantom executions").toBe(drivenRows);

      // The idempotency ledger: exactly ONE create arbitration per
      // discovery submission key (no ledger drift).
      const keyCount = await ctx.port.execute<{ c: number }>({
        sql: `SELECT count(*)::int AS c FROM platform.idempotency_records
            WHERE application_id = $1 AND operation_name = 'executions.create'`,
        parameters: [world.applicationId],
      });
      expect(Number(keyCount.rows[0]?.c ?? 0), "no ledger drift").toBe(drivenRows);

      // Zero orphan events.
      const orphans = await ctx.port.execute<{ c: number }>({
        sql: `SELECT count(*)::int AS c FROM executions.execution_events e
            LEFT JOIN executions.executions x ON e.execution_id = x.id
            WHERE e.application_id = $1 AND x.id IS NULL`,
        parameters: [world.applicationId],
      });
      expect(Number(orphans.rows[0]?.c ?? 0), "zero orphan events").toBe(0);

      // The replay-ledger input holds exactly ONE append-only row per
      // recorded observation (the read-only input is durable fact).
      const ledgerInputRows = await ctx.port.execute<{ c: number }>({
        sql: `SELECT count(*)::int AS c FROM platform.idempotency_records
            WHERE application_id = $1 AND operation_name = $2`,
        parameters: [world.applicationId, LEDGER_INPUT_OPERATION],
      });
      expect(
        Number(ledgerInputRows.rows[0]?.c ?? 0),
        "one durable row per recorded observation",
      ).toBe(totalObservations);

      // The candidate registry over REAL SQL: exactly ONE immutable
      // identity per DISTINCT honest proposal (rows sharing a recorded
      // population and candidate kind REPLAY the same identity —
      // exactly-once), every candidate at the `proposed` stage, zero
      // applied candidates (the mirror re-read from the durable rows).
      const distinctProposals = new Set(
        offlineRows
          .filter((row) => row.expected.emitsProposal)
          .map(
            (row) =>
              deriveHonestDiscoveryOutcome({
                candidateKind: row.candidateKind,
                population: row.population,
              }).proposal?.proposalId ?? "",
          ),
      );
      const registryFacts = await registry.refreshFacts();
      expect(
        registryFacts.candidates.length,
        "one registry identity per distinct honest proposal",
      ).toBe(distinctProposals.size);
      expect(new Set(registryFacts.candidates.map((candidate) => candidate.proposalId))).toEqual(
        distinctProposals,
      );
      for (const candidate of registryFacts.candidates) {
        expect(candidate.lifecycleStage, `${candidate.proposalId} proposed stage only`).toBe(
          PROPOSAL_LIFECYCLE_STAGE,
        );
      }
      expect(registryFacts.appliedCandidateCount, "no applied candidates").toBe(0);

      // The registry is append-only exactly-once over REAL SQL: the
      // re-drive of an already-recorded discovery REPLAYS the immutable
      // identity (never a second row), and a DIFFERENT proposal under
      // the recorded id is REFUSED.
      const replayRow = offlineRows.find(
        (row) => row.rowId === "rag-retrieval-deterministicization-candidate",
      ) as LearningDiscoveryCorpusRow;
      const replayedRun = await driveLearningDiscovery({
        row: replayRow,
        ledgerInput,
        miner: REFERENCE_MINER,
        registry,
        now: () => new Date(),
      });
      expect(replayedRun.terminal).toBe("COMPLETED");
      expect(replayedRun.registryRecording?.replayed, "the re-drive replays").toBe(true);
      expect(replayedRun.registryRecording?.accepted).toBe(true);
      const registryCountAfterReplay = await ctx.port.execute<{ c: number }>({
        sql: `SELECT count(*)::int AS c FROM platform.idempotency_records
            WHERE application_id = $1 AND operation_name = $2`,
        parameters: [world.applicationId, REGISTRY_OPERATION],
      });
      expect(
        Number(registryCountAfterReplay.rows[0]?.c ?? 0),
        "the re-drive added no registry row",
      ).toBe(distinctProposals.size);
      const recordedProposal = replayedRun.proposal as DiscoveryProposalRecord;
      const impostor = {
        ...recordedProposal,
        citation: {
          trajectoryDigests: ["00000000"],
          replayIdentities: recordedProposal.citation.replayIdentities,
        },
      };
      const refused = await registry.propose(impostor);
      expect(refused, "a different proposal under a recorded id is REFUSED").toEqual({
        accepted: false,
        replayed: false,
        refused: true,
      });
      const registryCountAfterImpostor = await ctx.port.execute<{ c: number }>({
        sql: `SELECT count(*)::int AS c FROM platform.idempotency_records
            WHERE application_id = $1 AND operation_name = $2`,
        parameters: [world.applicationId, REGISTRY_OPERATION],
      });
      expect(
        Number(registryCountAfterImpostor.rows[0]?.c ?? 0),
        "the refused impostor added no registry row",
      ).toBe(distinctProposals.size);

      // The no-application proof across the WHOLE corpus: the frozen
      // digest (populations + baseline manifests over FRESH SQL reads)
      // is IDENTICAL before and after every discovery run — the
      // recorded populations are read-only inputs and nothing was
      // applied.
      const finalFrozenDigest = replayLedgerInputDigestOf(await ledgerInput.refreshFacts());
      expect(finalFrozenDigest, "the frozen inputs are unchanged").toBe(initialFrozenDigest);

      const proposals = runFacts.filter((fact) => fact.outcome.startsWith("proposal:")).length;
      const refusals = runFacts.filter((fact) => fact.outcome.startsWith("refusal:")).length;
      const completed = runFacts.filter((fact) => fact.terminal === "COMPLETED").length;
      console.info(
        `[VAL-032] OFFLINE corpus summary: ${completed} COMPLETED of ${runFacts.length} driven ` +
          `discovery runs (${proposals} proposals / ${refusals} honest refusals — every refusal a ` +
          `COMPLETED discovery, never a fabricated failure); ${totalObservations} recorded ` +
          `observations served read-only from REAL SQL (${drivenRows} durable executions, one per ` +
          `run — no phantoms, no ledger drift, zero orphan events); the candidate registry holds ` +
          `exactly ${distinctProposals.size} immutable identities at the \`proposed\` stage (the ` +
          `re-drive REPLAYS the identity; the impostor is REFUSED — append-only over REAL SQL); ` +
          `every discovery trajectory reproduced through the REAL recorder path (the projected ` +
          `digest IS the pinned class member, journals gapless); the frozen-input digest is ` +
          `IDENTICAL before and after every run (the no-application proof); usage honestly ` +
          `none-reported offline; latency measured, never estimated; digests only, payload bytes ` +
          `never journaled.`,
      );
    } finally {
      await world.server.app.close();
    }
  });

  test("the REAL live rail drives the discovery run with a REAL model confirmation round", {
    timeout: 600_000,
  }, async () => {
    const generateId = createUuidv7Generator();
    const notRun: string[] = [];
    if (OPENROUTER_KEY.length === 0) {
      console.warn(
        "[VAL-032] OPENROUTER_API_KEY absent — the REAL live discovery row is a NOT RUN " +
          "boundary (recorded honestly; no fake success is asserted). The offline corpus above " +
          "covers every proposal/refusal/citation/fidelity/conservatism/no-application path " +
          "without credentials. Required access: an operator-authorized OpenRouter credential " +
          "(env OPENROUTER_API_KEY) covering the default chat model — the live discovery run " +
          "demands ONE REAL model confirmation round through the REAL platform model gateway " +
          "(measured usage, never estimated, never fabricated) before its deterministicization " +
          "proposal lands in the REAL candidate registry.",
      );
      expect(true).toBe(true);
      return;
    }

    const world = await seedApiPgWorld(ctx.port);
    const address = await world.server.app.listen({ port: 0, host: "127.0.0.1" });
    const driven = new Set<string>();
    const runFacts: RunFacts[] = [];

    try {
      const liveRows = LEARNING_DISCOVERY_CORPUS.filter((row) => row.liveGate !== undefined);
      // The REAL SQL ledger input + candidate registry for the live world.
      const ledgerInput = await seedRealReplayLedgerInput(ctx, world, liveRows);
      const registry = createRealCandidateRegistry(ctx, world);

      // ONE live dispatch binding for ALL live rows (the VAL-025
      // review lesson): the connection and its sealed credential
      // envelope are registered ONCE and shared.
      let liveDispatch: ControlDispatch | undefined;
      // Lead review fix (2026-09-13): the app selects its corpus row by
      // ABSOLUTE corpus index (LEARNING_DISCOVERY_CORPUS[taskIndex] —
      // offline rows first), so a live row's index must be offset by the
      // offline corpus size. The relative live-rows index submitted the
      // WRONG row's task body (corpus[0], an offline row) — the live
      // execution never landed and the crown timed out. The offline test
      // aligns by construction (offline rows ARE the corpus prefix).
      const liveIndexOffset = LEARNING_DISCOVERY_CORPUS.length - liveRows.length;
      for (const [liveIndex, row] of liveRows.entries()) {
        const taskIndex = liveIndexOffset + liveIndex;
        if (!liveGateOpen(row, process.env)) {
          notRun.push(
            `${row.rowId} — gate closed (${row.liveGate?.envVars.join("+")} absent); ` +
              `requirement: ${row.liveGate?.requirement}`,
          );
          continue;
        }
        // Provider-side pacing before the live discovery run.
        await new Promise((resolve) => setTimeout(resolve, 2_000));
        const runSuffix = `live-${generateId().slice(-8)}`;
        if (liveDispatch === undefined) {
          liveDispatch = (await buildLiveDispatch(ctx, world)).dispatch;
        }
        const dispatch: ControlDispatch = liveDispatch;
        const appKey = discoverySubmissionKey({ runSuffix, taskIndex });
        const appBody = discoveryTaskBodyFor({
          rowId: row.rowId,
          candidateKind: row.candidateKind,
        });
        const {
          executionId,
          result,
          appSettled,
          beforeFrozenDigest,
          afterFrozenDigest,
          trajectorySteps,
        } = await driveCrownDiscovery({
          ctx,
          world,
          address,
          row,
          taskIndex,
          runSuffix,
          ledgerInput,
          registry,
          driven,
          dispatch,
        });

        await verifyCrownRow({
          ctx,
          world,
          row,
          executionId,
          result,
          appSettled,
          beforeFrozenDigest,
          afterFrozenDigest,
          trajectorySteps,
        });

        // The live row's usage is MEASURED (never estimated).
        expect(result.usage?.inputTokens ?? -1, `${row.rowId} live usage measured`).toBeGreaterThan(
          -1,
        );
        expect(result.observedModelCalls, `${row.rowId} one confirmation round`).toBe(1);

        const usage =
          result.usage === null
            ? "none-reported"
            : `${result.usage.inputTokens}+${result.usage.outputTokens}` +
              (result.usage.costUsd === undefined ? "" : `/$${result.usage.costUsd}`);
        runFacts.push({
          rowId: row.rowId,
          terminal: result.terminal,
          outcome:
            result.proposal !== null
              ? `proposal:${result.proposal.kind}`
              : `refusal:${result.refusal?.reason ?? "none"}`,
          populationSize: row.population.length,
          structureDigest: result.structure.digest,
          proposalId: result.proposal?.proposalId ?? "none",
          registryRecording:
            result.registryRecording === null
              ? "nothing-recorded"
              : `accepted:${String(result.registryRecording.accepted)}/replayed:${String(result.registryRecording.replayed)}`,
          modelCalls: `${result.observedModelCalls}/${row.expected.modelCalls}`,
          latencyMs: result.latencyMs,
          appSubmissionLatencyMs: appSettled.outcome.submissionLatencyMs,
          appTerminal: appSettled.outcome.observedTerminal,
          usage,
          keysDigest: keysDigestOf(appKey),
          bodyDigest: bodiesDigestOf(appBody),
        });
        console.info(
          `[VAL-032]   LIVE ${row.rowId} -> ${result.terminal} outcome=${runFacts[runFacts.length - 1]?.outcome} ` +
            `proposal=${runFacts[runFacts.length - 1]?.proposalId} ` +
            `modelCalls=${runFacts[runFacts.length - 1]?.modelCalls} ` +
            `latency=${runFacts[runFacts.length - 1]?.latencyMs}ms ` +
            `usage=${runFacts[runFacts.length - 1]?.usage}`,
        );
      }

      const completed = runFacts.filter((fact) => fact.terminal === "COMPLETED").length;
      console.info(
        `[VAL-032] LIVE rail summary: ${completed} COMPLETED of ${runFacts.length} driven live ` +
          `discovery runs over the REAL OpenRouter rail (model ${MODEL}); ONE REAL model ` +
          `confirmation round per run (measured usage, BYOK — never estimated); digests only, ` +
          `payload bytes never journaled.`,
      );
      for (const boundary of notRun) {
        console.warn(`[VAL-032] NOT RUN boundary: ${boundary}`);
      }
      // At least one REAL live dispatch happened (never an
      // all-NOT-RUN silent pass once a credential is present).
      expect(runFacts.length).toBeGreaterThan(0);
    } finally {
      await world.server.app.close();
    }
  });
});
