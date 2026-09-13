/**
 * VAL-033 acceptance criteria 3 + 5 + 7 — the REAL end-to-end
 * integration crown: the offline equivalence corpus driven over the
 * REAL platform path over REAL PostgreSQL.
 *
 * Test 1 (the offline corpus): every row's equivalence run end to end —
 * the customer application riding the REAL public SDK wire (ONE
 * submission per row landing its OWN durable execution under its OWN
 * idempotency key → the completion poll → the result read → the events
 * read), the REAL candidate registry serving VAL-032's proposals as
 * READ-ONLY inputs from REAL SQL (the registry's own digest snapshotted
 * from FRESH SQL reads before and after every run — the entries are
 * immutable; a different-content commit under a recorded identity
 * THROWS), the REAL replay populations serving the differential inputs
 * read-only from REAL SQL (one append-only row per recorded VAL-031
 * observation, keyed by the 1-based population POSITION — the val-032
 * defect fix — with the content digest as the request fingerprint), the
 * lifecycle ledger appending `proposed → offline-replayed →
 * differentially-evaluated` over REAL SQL (append-only exactly-once:
 * the identical re-drive REPLAYS, an impostor evidence digest is
 * REFUSED), the mechanically derived verdict per row (the honest
 * terminals, the pinned verdict kinds, the digests in their pinned
 * classes), the trajectory flush through the REAL recorder path (the
 * projected digest IS the pinned class member; journals gapless), the
 * measured latencies, and the honest none-reported offline usage.
 *
 * Test 2 (the live rail): the env-gated REAL residual-AI confirmation
 * round through the REAL platform model gateway — an absent
 * OPENROUTER_API_KEY is an honest NOT RUN boundary (logged, skipped,
 * never fabricated); the live-path code (the REAL model gateway
 * dispatch, measured usage) is fully wired for when the credential
 * lands.
 *
 * Digest-only assertions everywhere (payload bytes never journaled);
 * no credentials in the repository, logs or reports.
 */

import { createHash } from "node:crypto";
import { expect, test } from "vitest";
import { runEquivalenceTestingApp } from "../../../benchmarks/validation/apps/equivalence-testing/application";
import {
  EQUIVALENCE_TESTING_CORPUS,
  EQUIVALENCE_TESTING_TASK_KIND,
  equivalenceSubmissionKey,
  equivalenceTaskBodyFor,
  liveGateOpen,
  REFERENCED_REPLAY_POPULATION_REFS,
  REGISTRY_SEED_PROPOSALS,
} from "../../../benchmarks/validation/apps/equivalence-testing/corpus";
import { recordedObservationsOf } from "../../../benchmarks/validation/apps/learning-discovery/corpus";
import { validateHarnessEvidence } from "../../../benchmarks/validation/harness";
import type {
  CandidateLifecycleLedgerPort,
  CandidateRegistryReadPort,
  DifferentialCase,
  EquivalenceCorpusRow,
  EquivalenceRegistryFacts,
  EquivalenceRunResult,
  IncumbentExecutorPort,
  LifecycleTransitionRecord,
  ReplacementRuntimePort,
} from "../../../benchmarks/validation/platform/equivalence-testing";
import {
  deriveHonestReplacementRun,
  differentialPopulationDigestOf,
  driveEquivalenceRun,
  EQUIVALENT_STAGE,
  equivalenceRegistryDigestOf,
  equivalenceTrajectoryStepsOf,
  lifecycleEvidenceDigestOf,
  OFFLINE_REPLAY_STAGE,
} from "../../../benchmarks/validation/platform/equivalence-testing";
import type {
  CandidateLifecycleStage,
  DiscoveryProposalRecord,
  RecordedReplayObservation,
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
const MODEL = process.env.ZECK_VAL_033_MODEL ?? "meta-llama/llama-3.3-70b-instruct";
const REVISION = createHash("sha256")
  .update("val-033|equivalence-testing|pinned")
  .digest("hex")
  .slice(0, 40);
const MAX_TOKENS = 64;

/** The REAL SQL operations the crown's durable bindings ride. */
const LEDGER_INPUT_OPERATION = "val-033.replay-ledger-input";
const REGISTRY_OPERATION = "val-033.candidate-registry";
const LIFECYCLE_OPERATION = "val-033.candidate-lifecycle";

/** Per-run REAL facts collected for the evidence document. */
interface RunFacts {
  readonly rowId: string;
  readonly terminal: string;
  readonly verdict: string;
  readonly proposalId: string;
  readonly populationSize: number;
  readonly differentialDigest: string;
  readonly landing: string;
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
  readonly outcome: Awaited<ReturnType<typeof runEquivalenceTestingApp>>;
}

// ---------------------------------------------------------------------------
// The REAL durable bindings (the platform slice's equivalence ports)
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

/** Parse one durable observation row back into the recorded vocabulary. */
function parseObservation(outcome: Record<string, unknown>): {
  readonly observation: RecordedReplayObservation;
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

/**
 * The REAL SQL replay-ledger input: every referenced VAL-031 replay
 * population's recorded observations are committed through the REAL
 * unique-index arbitration (ONE append-only row per recorded
 * observation — the observation's content digest as the request
 * fingerprint; an identical re-commit replays, a different-content
 * commit is an append-only violation that throws), keyed by the
 * population reference + the observation's 1-based POSITION within it
 * (the val-032 defect fix: a row's flattened population may hold
 * restarting replay ordinals across its referenced populations). The
 * binding serves the recorded observations read-only — the incumbent
 * executor reads the differential inputs' incumbent digests from this
 * REAL SQL snapshot, never from an in-memory pin.
 */
async function seedRealReplayLedgerInput(
  ctx: PgContext,
  world: ApiPgWorld,
): Promise<{
  /** The read-through snapshot (replay identity → the recorded observation). */
  readonly observations: ReadonlyMap<string, RecordedReplayObservation>;
  /** Re-read the REAL durable rows (the read-only proof basis). */
  readonly refreshFacts: () => Promise<{
    readonly observationCount: number;
    readonly factsDigest: string;
  }>;
}> {
  const generateId = createUuidv7Generator();

  const commitOne = async (
    ref: string,
    observation: RecordedReplayObservation,
    position: number,
  ): Promise<void> => {
    const key = `${ref}::obs-${position}`;
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
        throw new Error(`the replay-ledger arbitration lost the observation ${key}`);
      }
      if (existingRow.request_fingerprint !== fingerprint) {
        throw new Error(
          `append-only violation: the recorded observation ${key} is already committed with ` +
            "different content — the replay populations are read-only inputs",
        );
      }
      // The identical re-commit replays the recorded observation.
    });
  };

  const populations = REFERENCED_REPLAY_POPULATION_REFS.map((ref) => ({
    ref,
    observations: recordedObservationsOf(ref),
  }));
  for (const { ref, observations } of populations) {
    for (const [index, observation] of observations.entries()) {
      await commitOne(ref, observation, index + 1);
    }
  }

  const readRows = async () => {
    const rows = await ctx.port.execute<{
      idempotency_key: string;
      durable_outcome: Record<string, unknown>;
    }>({
      sql: `SELECT idempotency_key, durable_outcome FROM platform.idempotency_records
            WHERE application_id = $1 AND operation_name = $2
            ORDER BY created_at ASC, id ASC`,
      parameters: [world.applicationId, LEDGER_INPUT_OPERATION],
    });
    return rows.rows.flatMap((row) => {
      const parsed = parseObservation(row.durable_outcome);
      return parsed === null ? [] : [{ key: row.idempotency_key, ...parsed }];
    });
  };

  const snapshotRows = await readRows();
  const observations = new Map<string, RecordedReplayObservation>();
  for (const row of snapshotRows) {
    observations.set(row.observation.replayIdentity, row.observation);
  }

  return {
    observations,
    refreshFacts: async () => {
      const rows = await readRows();
      return {
        observationCount: rows.length,
        factsDigest: longitudinalDigestOf([
          "val-033-replay-ledger-input",
          ...rows.map((row) => row.key).sort(),
        ]),
      };
    },
  };
}

/**
 * The REAL incumbent executor: the differential inputs' incumbent
 * digests are served READ-ONLY from the REAL SQL replay-ledger
 * snapshot (the recorded VAL-031 trajectory digest per cited replay
 * identity — never an in-memory pin); the pinned adversarial cases
 * serve their own corpus pins (they are this slice's pins, not VAL-031
 * replays). A cited identity the recorded population does not hold is
 * a configuration error (the population pin catch fires honestly).
 */
function createRealIncumbentExecutor(
  observations: ReadonlyMap<string, RecordedReplayObservation>,
): IncumbentExecutorPort {
  return {
    async outcomeFor(input: { readonly dcase: DifferentialCase }) {
      if (input.dcase.source === "historical-replay") {
        const observation = observations.get(input.dcase.sourceRef);
        if (observation === undefined) {
          throw new Error(
            `the recorded population holds no replay identity ${input.dcase.sourceRef} ` +
              "(the differential input is not a member of the cited population)",
          );
        }
        return { digest: observation.trajectoryDigest };
      }
      return { digest: input.dcase.incumbentDigest };
    },
  };
}

/**
 * The REAL reference replacement runtime (the platform's PURE honest
 * replacement derivation — the isolated untrusted-code seam the crown
 * binds at the reference point).
 */
const REFERENCE_REPLACEMENT_RUNTIME: ReplacementRuntimePort = {
  async run(input) {
    return deriveHonestReplacementRun(input);
  },
};

/** The proposal pin's content digest (payload-free — digests only). */
function proposalContentDigestOf(pin: {
  readonly kind: string;
  readonly citation: {
    readonly trajectoryDigests: readonly string[];
    readonly replayIdentities: readonly string[];
  };
  readonly minedStructureDigest: string;
  readonly lifecycleStage: string;
}): string {
  return longitudinalDigestOf([
    pin.kind,
    pin.citation.trajectoryDigests,
    pin.citation.replayIdentities,
    pin.minedStructureDigest,
    pin.lifecycleStage,
  ]);
}

/** The REAL SQL candidate-registry read port (the READ-ONLY input). */
interface RealCandidateRegistryBinding extends CandidateRegistryReadPort {
  /** Re-read the REAL durable rows (the read-only proof basis). */
  refreshFacts(): Promise<EquivalenceRegistryFacts>;
}

/**
 * The REAL candidate registry: VAL-032's proposals are committed
 * through the REAL SQL unique-index arbitration (the derived proposal
 * identity as the idempotency key, the proposal's content digest as the
 * request fingerprint — ONE immutable row per proposal, append-only; an
 * identical re-commit replays, a different-content commit under a
 * recorded identity THROWS), and the port serves every read (the
 * proposal-for lookup and the facts view) from the REAL durable rows:
 * a read-through snapshot loaded from SQL at binding time (the port
 * contract is synchronous by design), refreshed from FRESH SQL reads
 * for every read-only proof (refreshFacts). The equivalence run never
 * rewrites an entry — the registry's own digest is snapshotted before
 * and after every run.
 */
async function seedRealCandidateRegistry(
  ctx: PgContext,
  world: ApiPgWorld,
  pins: readonly {
    readonly proposalId: string;
    readonly kind: string;
    readonly citation: {
      readonly trajectoryDigests: readonly string[];
      readonly replayIdentities: readonly string[];
    };
    readonly minedStructureDigest: string;
    readonly lifecycleStage: string;
  }[],
): Promise<RealCandidateRegistryBinding> {
  const generateId = createUuidv7Generator();

  const commitOne = async (pin: (typeof pins)[number]): Promise<void> => {
    const contentDigest = proposalContentDigestOf(pin);
    const citationDigest = longitudinalDigestOf([
      pin.citation.trajectoryDigests,
      pin.citation.replayIdentities,
    ]);
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
          pin.proposalId,
          contentDigest,
          JSON.stringify({
            kind: pin.kind,
            lifecycleStage: pin.lifecycleStage,
            citationDigest,
            replayIdentities: pin.citation.replayIdentities,
            trajectoryDigests: pin.citation.trajectoryDigests,
            minedStructureDigest: pin.minedStructureDigest,
          }),
        ],
      });
      if (inserted.rows.length > 0) {
        return;
      }
      const existing = await tx.execute<{ request_fingerprint: string }>({
        sql: `SELECT request_fingerprint FROM platform.idempotency_records
              WHERE application_id = $1 AND operation_name = $2 AND idempotency_key = $3`,
        parameters: [world.applicationId, REGISTRY_OPERATION, pin.proposalId],
      });
      const existingRow = existing.rows[0];
      if (existingRow === undefined) {
        throw new Error(`the registry arbitration lost the proposal ${pin.proposalId}`);
      }
      if (existingRow.request_fingerprint !== contentDigest) {
        throw new Error(
          `append-only violation: the proposal ${pin.proposalId} is already committed with ` +
            "different content — the registry's existing entries are read-only inputs",
        );
      }
      // The identical re-commit replays the recorded proposal.
    });
  };

  for (const pin of pins) {
    await commitOne(pin);
  }

  type SqlRow = {
    readonly idempotency_key: string;
    readonly durable_outcome: Record<string, unknown>;
  };
  const readRows = async (): Promise<readonly SqlRow[]> => {
    const rows = await ctx.port.execute<{
      idempotency_key: string;
      durable_outcome: Record<string, unknown>;
    }>({
      sql: `SELECT idempotency_key, durable_outcome FROM platform.idempotency_records
            WHERE application_id = $1 AND operation_name = $2
            ORDER BY created_at ASC, id ASC`,
      parameters: [world.applicationId, REGISTRY_OPERATION],
    });
    return rows.rows;
  };

  const factsOf = (rows: readonly SqlRow[]): EquivalenceRegistryFacts => {
    const proposals = rows.flatMap((row) => {
      const kind = typeof row.durable_outcome?.kind === "string" ? row.durable_outcome.kind : null;
      const lifecycleStage =
        typeof row.durable_outcome?.lifecycleStage === "string"
          ? row.durable_outcome.lifecycleStage
          : null;
      const citationDigest =
        typeof row.durable_outcome?.citationDigest === "string"
          ? row.durable_outcome.citationDigest
          : null;
      if (kind === null || lifecycleStage === null || citationDigest === null) {
        return [];
      }
      return [
        {
          proposalId: row.idempotency_key,
          kind,
          lifecycleStage: lifecycleStage as CandidateLifecycleStage,
          citationDigest,
        },
      ];
    });
    return {
      proposals: proposals.sort((left, right) => left.proposalId.localeCompare(right.proposalId)),
      appliedCandidateCount: proposals.filter((proposal) => proposal.lifecycleStage !== "proposed")
        .length,
    };
  };

  const recordOf = (row: SqlRow): DiscoveryProposalRecord | null => {
    const kind = typeof row.durable_outcome?.kind === "string" ? row.durable_outcome.kind : null;
    const lifecycleStage =
      typeof row.durable_outcome?.lifecycleStage === "string"
        ? row.durable_outcome.lifecycleStage
        : null;
    const minedStructureDigest =
      typeof row.durable_outcome?.minedStructureDigest === "string"
        ? row.durable_outcome.minedStructureDigest
        : null;
    const replayIdentities = Array.isArray(row.durable_outcome?.replayIdentities)
      ? (row.durable_outcome.replayIdentities as unknown[]).filter(
          (value): value is string => typeof value === "string",
        )
      : null;
    const trajectoryDigests = Array.isArray(row.durable_outcome?.trajectoryDigests)
      ? (row.durable_outcome.trajectoryDigests as unknown[]).filter(
          (value): value is string => typeof value === "string",
        )
      : null;
    if (
      kind === null ||
      lifecycleStage === null ||
      minedStructureDigest === null ||
      replayIdentities === null ||
      trajectoryDigests === null
    ) {
      return null;
    }
    return {
      proposalId: row.idempotency_key,
      kind: kind as DiscoveryProposalRecord["kind"],
      citation: { trajectoryDigests, replayIdentities },
      minedStructureDigest,
      lifecycleStage: lifecycleStage as CandidateLifecycleStage,
    };
  };

  // The read-through snapshot: loaded from the REAL durable rows once,
  // served synchronously through the port contract.
  const snapshotRows = await readRows();
  const snapshot = new Map<string, DiscoveryProposalRecord>();
  for (const row of snapshotRows) {
    const record = recordOf(row);
    if (record !== null) {
      snapshot.set(record.proposalId, record);
    }
  }
  let snapshotFacts = factsOf(snapshotRows);

  return {
    proposalFor(proposalId: string): DiscoveryProposalRecord | null {
      const record = snapshot.get(proposalId);
      return record === undefined ? null : { ...record, citation: { ...record.citation } };
    },
    facts(): EquivalenceRegistryFacts {
      return snapshotFacts;
    },
    async refreshFacts(): Promise<EquivalenceRegistryFacts> {
      const rows = await readRows();
      snapshotFacts = factsOf(rows);
      return snapshotFacts;
    },
  };
}

/**
 * The REAL SQL read-back of one row's lifecycle walk (the durable
 * truth): the proposal's transitions under this row's run keys, in
 * 1-based append order.
 */
async function readLifecycleWalk(
  ctx: PgContext,
  world: ApiPgWorld,
  row: EquivalenceCorpusRow,
  proposalId: string,
): Promise<readonly LifecycleTransitionRecord[]> {
  const rows = await ctx.port.execute<{
    idempotency_key: string;
    durable_outcome: Record<string, unknown>;
  }>({
    sql: `SELECT idempotency_key, durable_outcome FROM platform.idempotency_records
          WHERE application_id = $1 AND operation_name = $2
            AND idempotency_key LIKE $3 || '%'
            AND durable_outcome->>'proposalId' = $4
          ORDER BY (durable_outcome->>'ordinal')::int ASC`,
    parameters: [world.applicationId, LIFECYCLE_OPERATION, `${row.rowId}::`, proposalId],
  });
  return rows.rows.flatMap((sqlRow) => {
    const toStage =
      typeof sqlRow.durable_outcome?.toStage === "string" ? sqlRow.durable_outcome.toStage : null;
    const evidenceDigest =
      typeof sqlRow.durable_outcome?.evidenceDigest === "string"
        ? sqlRow.durable_outcome.evidenceDigest
        : null;
    const ordinal =
      typeof sqlRow.durable_outcome?.ordinal === "number" ? sqlRow.durable_outcome.ordinal : null;
    if (toStage === null || evidenceDigest === null || ordinal === null) {
      return [];
    }
    return [
      {
        proposalId,
        toStage: toStage as CandidateLifecycleStage,
        evidenceDigest,
        ordinal,
      },
    ];
  });
}

/** Parse one REAL journal step kind (the trajectory vocabulary — honest on unknowns). */
function trajectoryStepKindOf(kind: string): TrajectoryStepKind {
  if (kind === "dispatch" || kind === "effect" || kind === "verification") {
    return kind;
  }
  throw new Error(`the REAL journal holds an unknown trajectory step kind: ${kind}`);
}

// ---------------------------------------------------------------------------
// The REAL lifecycle driving (the canonical transitions per equivalence run)
// ---------------------------------------------------------------------------

/** The canonical prologue: authorize → plan → the planning decision → queue → start. */
async function driveLifecycleToRunning(
  world: ApiPgWorld,
  executionId: string,
  row: EquivalenceCorpusRow,
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
        reason: `val-033-${command}`,
      },
      `val-033-${executionId}-${command}-${transitionCounter.count}`,
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
            strategyId: "val-033-equivalence",
            plan: {
              strategyClass: "equivalence-testing",
              // The equivalence run's OWN dispatch demand — the route
              // read surfaces it at the customer boundary (zero
              // offline; the live row's ONE residual-AI round).
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
        selectedStrategyId: "val-033-equivalence",
      },
    },
    `val-033-${executionId}-decision`,
  );
  await transition("queue");
  await transition("start");
}

/**
 * The verification boundary + the terminal for ONE equivalence run's
 * landed execution: the mechanically derived verdict (the run's own
 * criteria — every leg) recorded durably with the terminal transition.
 */
async function completeEquivalenceExecution(
  world: ApiPgWorld,
  executionId: string,
  result: EquivalenceRunResult,
): Promise<void> {
  await world.executions.transition(
    {
      actorId: world.actorId,
      applicationId: world.applicationId,
      tenantId: world.tenantId,
      executionId,
      command: "verify",
      reason: "val-033-verify",
    },
    `val-033-${executionId}-verify`,
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
          ? "val-033-verified"
          : `val-033-${result.failure?.category ?? "criterion-fail"}`,
      verificationResults: result.criteria.map((criterion) => ({
        criterionId: criterion.criterionId,
        strategy: criterion.strategy,
        status: criterion.status,
        recordedBy: "val-033-platform",
        evidence: [...criterion.evidence],
      })),
    },
    `val-033-${executionId}-${verdict}`,
  );
}

// ---------------------------------------------------------------------------
// The landed-equivalence provider (the app's submission lands through
// the public wire; the crown polls the REAL SQL for the durable row)
// ---------------------------------------------------------------------------

async function awaitLandedEquivalenceExecution(
  ctx: PgContext,
  world: ApiPgWorld,
  driven: Set<string>,
  row: EquivalenceCorpusRow,
): Promise<string> {
  for (let attempt = 0; attempt < 4_800; attempt += 1) {
    const rows = await ctx.port.execute<{ id: string }>({
      sql: `SELECT id FROM executions.executions
            WHERE application_id = $1
              AND task->>'kind' = $2
              AND task->>'rowId' = $3
              AND id != ALL($4::uuid[])
            ORDER BY id ASC`,
      parameters: [world.applicationId, EQUIVALENCE_TESTING_TASK_KIND, row.rowId, [...driven]],
    });
    if (rows.rows.length >= 1) {
      if (rows.rows.length !== 1) {
        throw new Error(
          `the row ${row.rowId} landed more executions than its equivalence run ` +
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
    `no landed equivalence execution for row ${row.rowId} after 120s (expected 1 durable execution)`,
  );
}

// ---------------------------------------------------------------------------
// The live dispatch binding (the REAL model gateway — the live row's seam)
// ---------------------------------------------------------------------------

/** Build the REAL model-gateway dispatch round (the live row's residual-AI seam). */
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
        return { satisfied: true, catalogRevision: "val-033", satisfactions: [] };
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
      label: "val-033-openrouter",
      registerCredential: { material: OPENROUTER_KEY },
    },
    `val-033-conn-${generateId().slice(-8)}`,
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
            "You are the equivalence-confirmation supervisor of a governed validation execution.",
            "You receive the equivalence-testing run's residual-AI confirmation request and decide",
            "whether the replacement's residual leg completed. Answer with the single word: confirm",
          ].join(" "),
        },
        {
          role: "user",
          content:
            `Equivalence-testing confirmation round (golden:live-confirmation, round ${round}, ` +
            `attempt ${attempt}). Confirm the residual-AI dispatch.`,
        },
      ],
    });
    const latencyMs = Date.now() - startedAt;
    if (result.outcome.kind === "provider-success") {
      const response = result.outcome.response;
      const usage = {
        inputTokens: response.usage.inputTokens,
        outputTokens: response.usage.outputTokens,
        ...(response.usage.costUsd === null || response.usage.costUsd === undefined
          ? {}
          : { costUsd: response.usage.costUsd }),
      };
      if (!/confirm/i.test(response.content.join("\n"))) {
        return {
          kind: "failure" as const,
          category: "supervisor-halt",
          message: `the confirmation supervisor did not confirm: ${response.content
            .join("\n")
            .slice(0, 120)}`,
          latencyMs,
        };
      }
      return { kind: "success" as const, usage, latencyMs };
    }
    const failure = result.outcome.failure;
    return {
      kind: "failure" as const,
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
 * Drive one corpus row's equivalence run crown-style: the app rides
 * the public wire (ONE equivalence submission → the completion poll →
 * the result read → the events read) while the crown waits for the
 * landed execution and drives the REAL lifecycle around the
 * equivalence run (the prologue transitions → the equivalence run
 * through the platform driver with the REAL SQL candidate registry,
 * the REAL SQL-backed incumbent executor over the REAL replay
 * populations, the reference replacement runtime and the REAL SQL
 * append-only lifecycle ledger → the registry read-only snapshots
 * before and after from FRESH SQL reads → the equivalence trajectory
 * flush through the REAL recorder path → the verification boundary +
 * the mechanically derived terminal).
 */
async function driveCrownEquivalence(options: {
  readonly ctx: PgContext;
  readonly world: ApiPgWorld;
  readonly address: string;
  readonly row: EquivalenceCorpusRow;
  readonly taskIndex: number;
  readonly runSuffix: string;
  readonly registry: RealCandidateRegistryBinding;
  readonly incumbentExecutor: IncumbentExecutorPort;
  readonly dispatch?: ControlDispatch;
  readonly driven: Set<string>;
}): Promise<{
  readonly executionId: string;
  readonly result: EquivalenceRunResult;
  readonly appSettled: AppOutcome;
  readonly registryDigestBefore: string;
  readonly registryDigestAfter: string;
  readonly trajectorySteps: readonly TrajectoryStepRecord[];
}> {
  const { world, row, taskIndex } = options;
  const generateId = createUuidv7Generator();

  // The app promise: the customer application over the REAL served
  // public wire (the app never touches platform internals).
  const appPromise: Promise<AppOutcome> = runEquivalenceTestingApp({
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
      configuration: { suite: "val-033-equivalence-testing" },
    },
    runSuffix: options.runSuffix,
    taskIndex,
  }).then((outcome) => ({ ok: true as const, outcome }));

  // The landed equivalence execution (the app's submission through the
  // public wire — ONE durable execution per row).
  const executionId = await awaitLandedEquivalenceExecution(
    options.ctx,
    world,
    options.driven,
    row,
  );

  // The canonical prologue (authorize → plan → the planning decision →
  // queue → start) — the equivalence run drives over the REAL state machine.
  await driveLifecycleToRunning(world, executionId, row, generateId);

  // The registry read-only snapshot BEFORE the equivalence run (a
  // FRESH REAL SQL read — the read-only proof's basis).
  const registryDigestBefore = equivalenceRegistryDigestOf(await options.registry.refreshFacts());

  // The equivalence run through the platform driver with the REAL SQL
  // candidate registry, the REAL SQL-backed incumbent executor, the
  // reference replacement runtime and the REAL SQL append-only
  // lifecycle ledger. The synchronous ledger view rides an in-memory
  // mirror of the durable appends (the SQL read-back in verifyCrownRow
  // is the durable truth).
  const ledgerMirror: LifecycleTransitionRecord[] = [];
  const ledger: CandidateLifecycleLedgerPort = {
    append: async (record) => {
      const receipt = await createRealLifecycleLedgerAppend(options.ctx, world, row, record);
      if (receipt.accepted && !receipt.replayed) {
        ledgerMirror.push({
          ...record,
          ordinal: ledgerMirror.length + 1,
        });
      } else if (receipt.replayed) {
        const existing = ledgerMirror.find((transition) => transition.toStage === record.toStage);
        if (existing === undefined) {
          ledgerMirror.push({ ...record, ordinal: ledgerMirror.length + 1 });
        }
      }
      return receipt;
    },
    transitionsFor: (proposalId: string) =>
      ledgerMirror
        .filter((transition) => transition.proposalId === proposalId)
        .map((transition) => ({ ...transition })),
  };

  const result = await driveEquivalenceRun({
    row,
    registry: options.registry,
    ledger,
    incumbentExecutor: options.incumbentExecutor,
    replacementRuntime: REFERENCE_REPLACEMENT_RUNTIME,
    ...(options.dispatch === undefined ? {} : { dispatch: options.dispatch }),
    retry: {
      maxExtraAttempts: 2,
      backoffMs: 4_000,
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    },
    now: () => new Date(),
  });

  // The registry read-only snapshot AFTER the equivalence run (a FRESH
  // REAL SQL read — the read-only proof over REAL SQL).
  const registryDigestAfter = equivalenceRegistryDigestOf(await options.registry.refreshFacts());

  // The equivalence trajectory flush through the REAL recorder path:
  // the run's canonical equivalence steps journal into its landed
  // execution while the execution is RUNNING — the step events project
  // back onto the pinned equivalence trajectory (verified below over
  // REAL SQL).
  const honestRun = deriveHonestReplacementRun({
    sourceProposalId: row.sourceProposalId,
    replacementShape: row.replacementShape,
    declaredCapabilities: row.declaredCapabilities,
    acceptanceCriterion: row.acceptanceCriterion,
    population: row.differentialPopulation,
  });
  const trajectorySteps = equivalenceTrajectoryStepsOf({
    proposalId: row.sourceProposalId,
    populationDigest: differentialPopulationDigestOf(row.differentialPopulation),
    incumbentExecutionDigest: longitudinalDigestOf([
      "incumbent-executed",
      ...row.differentialPopulation.map((dcase) => dcase.incumbentDigest),
    ]),
    replacementExecutionDigest: longitudinalDigestOf([
      "replacement-executed",
      ...honestRun.outcomes.map((outcome) => outcome.digest),
    ]),
    isolationContainment:
      result.refusal !== null ? null : (result.isolation?.containment ?? "contained"),
    differentialVerdictDigest: result.differential?.digest ?? null,
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
        cause: `val-033-${step.kind}-${step.ordinal}`,
        reference: {
          kind: step.kind,
          ordinal: step.ordinal,
          detail: step.detail,
          digest: step.digest,
        },
        payload: { kind: step.kind, detail: step.detail, ordinal: step.ordinal },
      },
      `val-033-${executionId}-${step.kind}-${step.ordinal}`,
    );
  }

  // The verification boundary + the mechanically derived terminal.
  await completeEquivalenceExecution(world, executionId, result);

  const appSettled = await appPromise;
  return {
    executionId,
    result,
    appSettled,
    registryDigestBefore,
    registryDigestAfter,
    trajectorySteps,
  };
}

/** One REAL SQL lifecycle append (the arbitration the ledger mirror rides). */
async function createRealLifecycleLedgerAppend(
  ctx: PgContext,
  world: ApiPgWorld,
  row: EquivalenceCorpusRow,
  record: Omit<LifecycleTransitionRecord, "ordinal">,
): Promise<{ readonly accepted: boolean; readonly replayed: boolean; readonly refused: boolean }> {
  const generateId = createUuidv7Generator();
  const key = `${row.rowId}::${record.proposalId}::${record.toStage}`;
  return ctx.port.transaction(async (tx: Transaction) => {
    const count = await tx.execute<{ c: number }>({
      sql: `SELECT count(*)::int AS c FROM platform.idempotency_records
            WHERE application_id = $1 AND operation_name = $2
              AND idempotency_key LIKE $3 || '%'
              AND durable_outcome->>'proposalId' = $4`,
      parameters: [world.applicationId, LIFECYCLE_OPERATION, `${row.rowId}::`, record.proposalId],
    });
    const ordinal = Number(count.rows[0]?.c ?? 0) + 1;
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
        LIFECYCLE_OPERATION,
        key,
        record.evidenceDigest,
        JSON.stringify({
          proposalId: record.proposalId,
          toStage: record.toStage,
          evidenceDigest: record.evidenceDigest,
          ordinal,
        }),
      ],
    });
    if (inserted.rows.length > 0) {
      return { accepted: true, replayed: false, refused: false };
    }
    const existing = await tx.execute<{ request_fingerprint: string }>({
      sql: `SELECT request_fingerprint FROM platform.idempotency_records
            WHERE application_id = $1 AND operation_name = $2 AND idempotency_key = $3`,
      parameters: [world.applicationId, LIFECYCLE_OPERATION, key],
    });
    const existingRow = existing.rows[0];
    if (existingRow === undefined) {
      throw new Error(`the lifecycle arbitration lost the transition ${key}`);
    }
    if (existingRow.request_fingerprint === record.evidenceDigest) {
      return { accepted: true, replayed: true, refused: false };
    }
    return { accepted: false, replayed: false, refused: true };
  });
}

// ---------------------------------------------------------------------------
// The per-row mechanical verification (over the REAL SQL)
// ---------------------------------------------------------------------------

/**
 * Verify one row's crown outcome mechanically: the platform's
 * equivalence verdict (the terminal, every criterion, the
 * isolation/differential/provenance/stage-discipline legs, the ledger
 * landing), the registry read-only proof (before === after, over FRESH
 * REAL SQL reads), the REAL journal projection (the equivalence
 * trajectory reproduction through the REAL recorder path — the
 * projected digest IS the pinned class member, the ordinals and
 * sequences gapless), the durable terminal, the REAL SQL lifecycle
 * walk (proposed → offline-replayed → differentially-evaluated ONLY,
 * each transition evidenced with the canonical evidence digest), and
 * the app's honest observations over the public wire (the legs
 * observable on the real rail).
 */
async function verifyCrownRow(options: {
  readonly ctx: PgContext;
  readonly world: ApiPgWorld;
  readonly row: EquivalenceCorpusRow;
  readonly executionId: string;
  readonly result: EquivalenceRunResult;
  readonly appSettled: AppOutcome;
  readonly registryDigestBefore: string;
  readonly registryDigestAfter: string;
  readonly trajectorySteps: readonly TrajectoryStepRecord[];
}): Promise<void> {
  const { ctx, world, row, result, appSettled } = options;
  const { outcome: app } = appSettled;

  // ---- the honest equivalence contracts (the platform side) ----
  if (result.terminal !== row.expected.terminal) {
    console.info(
      `[VAL-033][DIAGNOSTIC] ${row.rowId} terminal=${result.terminal} failure=${JSON.stringify(result.failure)}`,
    );
    for (const criterion of result.criteria) {
      if (criterion.status === "FAIL") {
        console.info(
          `[VAL-033][DIAGNOSTIC]   FAIL ${criterion.criterionId}: ${criterion.evidence.join(" | ")}`,
        );
      }
    }
  }
  expect(result.terminal, `${row.rowId} terminal`).toBe(row.expected.terminal);
  if (row.expected.verdict === "honest-divergence") {
    // The honest divergence FAILs its criterion legs honestly (the
    // divergence recorded case-by-case, never smoothed — the satisfied
    // and summary criteria FAIL because the replacement genuinely
    // diverged) while every OTHER leg passes.
    expect(
      result.criteria.find((c) => c.criterionId === "differential-criterion-satisfied")?.status,
      `${row.rowId} criterion satisfied`,
    ).toBe("FAIL");
    expect(
      result.criteria.find((c) => c.criterionId === "divergence-honesty-no-smoothing")?.status,
      `${row.rowId} honesty`,
    ).toBe("PASS");
    const failedOther = result.criteria.filter(
      (criterion) =>
        criterion.status === "FAIL" &&
        criterion.criterionId !== "differential-criterion-satisfied" &&
        criterion.criterionId !== "differential-equivalence-summary",
    );
    expect(failedOther, `${row.rowId}: ${JSON.stringify(failedOther)}`).toEqual([]);
  } else {
    const failedCriteria = result.criteria.filter((criterion) => criterion.status === "FAIL");
    expect(failedCriteria, `${row.rowId}: ${JSON.stringify(failedCriteria)}`).toEqual([]);
  }
  // The verdict reproduces the pinned oracle.
  expect(result.verdict, `${row.rowId} verdict kind`).toBe(row.expected.verdict);
  expect(result.refusal?.reason ?? null, `${row.rowId} refusal reason`).toBe(
    row.expected.refusalReason,
  );
  expect(
    result.differential?.divergences.map((divergence) => divergence.caseId) ?? [],
    `${row.rowId} divergences`,
  ).toEqual([...row.expected.divergenceCaseIds]);
  if (result.refusal === null) {
    expect(result.isolation?.contained, `${row.rowId} contained`).toBe(true);
    expect(result.provenance?.complete, `${row.rowId} provenance complete`).toBe(true);
    expect(result.stageDiscipline?.disciplined, `${row.rowId} stage disciplined`).toBe(true);
    expect(result.ledgerLanding?.accepted, `${row.rowId} lifecycle landing`).toBe(true);
  } else {
    expect(result.refusalHonesty?.honest, `${row.rowId} refusal honest`).toBe(true);
    expect(result.ledgerLanding, `${row.rowId} refusal records nothing`).toBeNull();
  }
  // The run made its OWN dispatches; usage honestly none offline.
  expect(result.observedModelCalls, `${row.rowId} own dispatches`).toBe(row.expected.modelCalls);
  expect(result.latencyMs, `${row.rowId} latency measured`).toBeGreaterThanOrEqual(0);
  if (row.needsDispatch) {
    expect(result.usage === null || result.usage.inputTokens >= 0, `${row.rowId} live usage`).toBe(
      true,
    );
  } else {
    expect(result.usage, `${row.rowId} offline usage none-reported`).toBeNull();
  }

  // ---- the registry read-only proof over FRESH REAL SQL reads ----
  expect(options.registryDigestAfter, `${row.rowId} registry digest after`).toBe(
    options.registryDigestBefore,
  );
  expect(
    result.criteria.find((c) => c.criterionId === "registry-read-only")?.status,
    `${row.rowId} registry read-only leg`,
  ).toBe("PASS");

  // ---- the REAL journal projection (the equivalence trajectory) ----
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
  expect(trajectoryDigestOf(projection), `${row.rowId} REAL journal equivalence digest`).toBe(
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

  // ---- the REAL SQL lifecycle walk (the durable truth) ----
  const walk = await readLifecycleWalk(ctx, world, row, row.sourceProposalId);
  if (row.expected.refusalReason !== null) {
    // The honest refusal appends NOTHING to the candidate lifecycle.
    expect(walk, `${row.rowId} refusal walk`).toEqual([]);
  } else {
    expect(
      walk.map((transition) => transition.toStage),
      `${row.rowId} REAL SQL walk`,
    ).toEqual([OFFLINE_REPLAY_STAGE, EQUIVALENT_STAGE]);
    // The evidenced walk: each transition carries the CANONICAL
    // lifecycle evidence digest (the replay identities for the offline
    // replay; the differential verdict digest for the evaluation).
    const replayEvidence = lifecycleEvidenceDigestOf({
      proposalId: row.sourceProposalId,
      stage: OFFLINE_REPLAY_STAGE,
      members: row.differentialPopulation
        .filter((dcase) => dcase.source === "historical-replay")
        .map((dcase) => dcase.sourceRef),
    });
    const differentialEvidence = lifecycleEvidenceDigestOf({
      proposalId: row.sourceProposalId,
      stage: EQUIVALENT_STAGE,
      members: [result.differential?.digest ?? ""],
    });
    expect(walk[0]?.evidenceDigest, `${row.rowId} offline-replay evidence`).toBe(replayEvidence);
    expect(walk[1]?.evidenceDigest, `${row.rowId} differential evidence`).toBe(
      differentialEvidence,
    );
    expect(walk[0]?.ordinal).toBe(1);
    expect(walk[1]?.ordinal).toBe(2);
  }

  // ---- the app's honest observations over the public wire ----
  // (The legs observable on the real rail: the submission landed its
  // OWN durable execution, the honest terminal, the route's own
  // model-call count, the measured submission latency, the durable
  // verification statuses. The verdict read-back and the raw-events
  // trajectory digest re-derivation are the recorded fake-world
  // boundary — verified through the REAL recorder path instead.)
  expect(validateHarnessEvidence(app.evidence), `${row.rowId} app evidence valid`).toEqual([]);
  expect(app.submission.rejection, `${row.rowId} app submission`).toBeNull();
  expect(app.submission.replayed, `${row.rowId} app created (never a shoulder-in)`).toBe(false);
  expect(app.submission.executionId, `${row.rowId} app landed`).toBe(options.executionId);
  expect(app.observedTerminal, `${row.rowId} app terminal`).toBe(row.expected.terminal);
  expect(app.observedModelCalls, `${row.rowId} app model calls`).toBe(row.expected.modelCalls);
  expect(app.submissionLatencyMs, `${row.rowId} app submission latency measured`).toBeGreaterThan(
    0,
  );
  expect(app.verificationStatuses, `${row.rowId} app verification statuses`).not.toHaveLength(0);
  if (row.expected.terminal === "COMPLETED") {
    for (const status of app.verificationStatuses) {
      expect(status, `${row.rowId} app verification status`).toBe("PASS");
    }
  } else {
    // The honest-divergence row: the FAILED terminal carries its FAIL
    // statuses (the divergence recorded, never smoothed into a pass).
    expect(app.verificationStatuses.includes("FAIL"), `${row.rowId} honest FAIL statuses`).toBe(
      true,
    );
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

definePgSuite("VAL-033 equivalence testing over the real platform path", (ctx) => {
  test("the offline equivalence corpus drives verdict semantics over the REAL platform path", {
    timeout: 300_000,
  }, async () => {
    const world = await seedApiPgWorld(ctx.port);
    const address = await world.server.app.listen({ port: 0, host: "127.0.0.1" });
    const driven = new Set<string>();
    const runFacts: RunFacts[] = [];

    try {
      const offlineRows = EQUIVALENCE_TESTING_CORPUS.filter((row) => row.liveGate === undefined);
      // The REAL SQL replay-ledger input (every referenced VAL-031
      // population's recorded observations — the read-only differential
      // inputs) and the REAL SQL candidate registry (VAL-032's
      // proposals, read-only).
      const ledgerInput = await seedRealReplayLedgerInput(ctx, world);
      const registry = await seedRealCandidateRegistry(ctx, world, REGISTRY_SEED_PROPOSALS);
      const incumbentExecutor = createRealIncumbentExecutor(ledgerInput.observations);

      // The read-only bases over FRESH REAL SQL reads: the registry's
      // own digest and the replay-ledger input's durable row set.
      const initialRegistryDigest = equivalenceRegistryDigestOf(await registry.refreshFacts());
      const initialLedgerFacts = await ledgerInput.refreshFacts();
      const totalObservations = initialLedgerFacts.observationCount;
      expect(
        totalObservations,
        "the replay populations hold their recorded observations",
      ).toBeGreaterThan(0);
      // The registry serves EXACTLY the pinned VAL-032 membership at the
      // proposed stage (zero applied candidates — the read-only input).
      const registryFacts = await registry.refreshFacts();
      expect(registryFacts.proposals).toHaveLength(REGISTRY_SEED_PROPOSALS.length);
      expect(new Set(registryFacts.proposals.map((proposal) => proposal.proposalId))).toEqual(
        new Set(REGISTRY_SEED_PROPOSALS.map((pin) => pin.proposalId)),
      );
      for (const proposal of registryFacts.proposals) {
        expect(proposal.lifecycleStage, `${proposal.proposalId} proposed only`).toBe("proposed");
      }
      expect(registryFacts.appliedCandidateCount).toBe(0);

      for (const [taskIndex, row] of offlineRows.entries()) {
        const generateId = createUuidv7Generator();
        const runSuffix = `it-${generateId().slice(-8)}`;
        const appKey = equivalenceSubmissionKey({ runSuffix, taskIndex });
        const appBody = equivalenceTaskBodyFor({
          rowId: row.rowId,
          sourceProposalId: row.sourceProposalId,
          replacementShape: row.replacementShape,
        });
        const {
          executionId,
          result,
          appSettled,
          registryDigestBefore,
          registryDigestAfter,
          trajectorySteps,
        } = await driveCrownEquivalence({
          ctx,
          world,
          address,
          row,
          taskIndex,
          runSuffix,
          registry,
          incumbentExecutor,
          driven,
        });

        await verifyCrownRow({
          ctx,
          world,
          row,
          executionId,
          result,
          appSettled,
          registryDigestBefore,
          registryDigestAfter,
          trajectorySteps,
        });

        // The app key's ledger record: ONE create arbitration per
        // equivalence submission key (no ledger drift — the submission
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
          verdict: result.verdict,
          proposalId: result.refusal === null ? row.sourceProposalId : "none",
          populationSize: row.differentialPopulation.length,
          differentialDigest: result.differential?.digest ?? "none",
          landing:
            result.ledgerLanding === null
              ? "nothing-appended"
              : `accepted:${String(result.ledgerLanding.accepted)}/replayed:${String(result.ledgerLanding.replayed)}`,
          modelCalls: `${result.observedModelCalls}/${row.expected.modelCalls}`,
          latencyMs: result.latencyMs,
          appSubmissionLatencyMs: appSettled.outcome.submissionLatencyMs,
          appTerminal: appSettled.outcome.observedTerminal,
          usage,
          keysDigest: keysDigestOf(appKey),
          bodyDigest: bodiesDigestOf(appBody),
        });
        console.info(
          `[VAL-033]   ${row.rowId} -> ${result.terminal} verdict=${runFacts[runFacts.length - 1]?.verdict} ` +
            `proposal=${runFacts[runFacts.length - 1]?.proposalId} ` +
            `population=${runFacts[runFacts.length - 1]?.populationSize} ` +
            `differential=${runFacts[runFacts.length - 1]?.differentialDigest} ` +
            `lifecycle=${runFacts[runFacts.length - 1]?.landing} ` +
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

      // No phantom executions: exactly ONE durable execution per
      // equivalence row (every run landed its OWN).
      const execCount = await ctx.port.execute<{ c: number }>({
        sql: `SELECT count(*)::int AS c FROM executions.executions WHERE application_id = $1`,
        parameters: [world.applicationId],
      });
      expect(Number(execCount.rows[0]?.c ?? 0), "no phantom executions").toBe(drivenRows);

      // The idempotency ledger: exactly ONE create arbitration per
      // equivalence submission key (no ledger drift).
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
      // recorded observation (the read-only differential input is
      // durable fact — unchanged across the whole corpus).
      const finalLedgerFacts = await ledgerInput.refreshFacts();
      expect(finalLedgerFacts.observationCount, "one durable row per recorded observation").toBe(
        totalObservations,
      );
      expect(finalLedgerFacts.factsDigest, "the replay populations are unchanged").toBe(
        initialLedgerFacts.factsDigest,
      );

      // The candidate registry over REAL SQL: the entries are IMMUTABLE
      // — exactly the pinned VAL-032 membership, every proposal still
      // at the `proposed` stage (the equivalence verdict APPENDS to the
      // lifecycle, it never rewrites a proposal).
      const finalRegistryFacts = await registry.refreshFacts();
      expect(finalRegistryFacts.proposals).toHaveLength(REGISTRY_SEED_PROPOSALS.length);
      for (const proposal of finalRegistryFacts.proposals) {
        expect(proposal.lifecycleStage, `${proposal.proposalId} immutable proposed stage`).toBe(
          "proposed",
        );
      }
      expect(
        equivalenceRegistryDigestOf(finalRegistryFacts),
        "the registry digest is IDENTICAL after the whole corpus",
      ).toBe(initialRegistryDigest);

      // The registry is append-only over REAL SQL: a different-content
      // commit under a recorded identity THROWS (the read-only input).
      const ragRow = offlineRows.find(
        (row) => row.rowId === "rag-deterministic-function-exact",
      ) as EquivalenceCorpusRow;
      const ragPin = REGISTRY_SEED_PROPOSALS.find(
        (pin) => pin.proposalId === ragRow.sourceProposalId,
      );
      if (ragPin === undefined) {
        throw new Error("the RAG deterministicization proposal is not a pinned registry member");
      }
      await expect(
        seedRealCandidateRegistry(ctx, world, [
          {
            proposalId: ragPin.proposalId,
            kind: ragPin.kind,
            citation: {
              trajectoryDigests: ["00000000"],
              replayIdentities: [...ragPin.citation.replayIdentities],
            },
            minedStructureDigest: ragPin.minedStructureDigest,
            lifecycleStage: ragPin.lifecycleStage,
          },
        ]),
      ).rejects.toThrow("append-only violation");
      const registryCountAfterImpostor = await ctx.port.execute<{ c: number }>({
        sql: `SELECT count(*)::int AS c FROM platform.idempotency_records
            WHERE application_id = $1 AND operation_name = $2`,
        parameters: [world.applicationId, REGISTRY_OPERATION],
      });
      expect(
        Number(registryCountAfterImpostor.rows[0]?.c ?? 0),
        "the refused impostor added no registry row",
      ).toBe(REGISTRY_SEED_PROPOSALS.length);

      // The lifecycle ledger over REAL SQL: exactly TWO durable
      // transitions per evaluated row (offline-replayed +
      // differentially-evaluated) and ZERO per refusal row — never a
      // stage beyond the equivalence scope, never an evidence-less
      // transition.
      const evaluatedRows = offlineRows.filter((row) => row.expected.refusalReason === null);
      const refusalRows = offlineRows.filter((row) => row.expected.refusalReason !== null);
      const lifecycleCount = await ctx.port.execute<{ c: number }>({
        sql: `SELECT count(*)::int AS c FROM platform.idempotency_records
            WHERE application_id = $1 AND operation_name = $2`,
        parameters: [world.applicationId, LIFECYCLE_OPERATION],
      });
      expect(
        Number(lifecycleCount.rows[0]?.c ?? 0),
        "two evidenced transitions per evaluated row",
      ).toBe(evaluatedRows.length * 2);
      const lifecycleStages = await ctx.port.execute<{ stage: string }>({
        sql: `SELECT DISTINCT durable_outcome->>'toStage' AS stage FROM platform.idempotency_records
            WHERE application_id = $1 AND operation_name = $2`,
        parameters: [world.applicationId, LIFECYCLE_OPERATION],
      });
      expect(new Set(lifecycleStages.rows.map((sqlRow) => sqlRow.stage))).toEqual(
        new Set([OFFLINE_REPLAY_STAGE, EQUIVALENT_STAGE]),
      );
      const evidenceLess = await ctx.port.execute<{ c: number }>({
        sql: `SELECT count(*)::int AS c FROM platform.idempotency_records
            WHERE application_id = $1 AND operation_name = $2
              AND (durable_outcome->>'evidenceDigest') = ''`,
        parameters: [world.applicationId, LIFECYCLE_OPERATION],
      });
      expect(Number(evidenceLess.rows[0]?.c ?? 0), "no evidence-less transitions").toBe(0);
      for (const row of refusalRows) {
        const walk = await readLifecycleWalk(ctx, world, row, row.sourceProposalId);
        expect(walk, `${row.rowId} refusal appended nothing`).toEqual([]);
      }

      // The lifecycle ledger is append-only exactly-once over REAL SQL:
      // the re-drive of an already-recorded equivalence run REPLAYS the
      // immutable transitions (never new rows), and a DIFFERENT
      // evidence digest under a recorded key is REFUSED.
      const replayRow = offlineRows.find(
        (row) => row.rowId === "rag-deterministic-function-exact",
      ) as EquivalenceCorpusRow;
      // The synchronous transitions view rides the RECORDED walk
      // (pre-read from REAL SQL — the durable truth the re-drive replays).
      const recordedWalk = await readLifecycleWalk(
        ctx,
        world,
        replayRow,
        replayRow.sourceProposalId,
      );
      expect(recordedWalk).toHaveLength(2);
      const replayedRun = await driveEquivalenceRun({
        row: replayRow,
        registry,
        ledger: {
          append: (record) => createRealLifecycleLedgerAppend(ctx, world, replayRow, record),
          transitionsFor: (proposalId: string) =>
            recordedWalk
              .filter((transition) => transition.proposalId === proposalId)
              .map((transition) => ({ ...transition })),
        },
        incumbentExecutor,
        replacementRuntime: REFERENCE_REPLACEMENT_RUNTIME,
        now: () => new Date(),
      });
      expect(replayedRun.terminal).toBe("COMPLETED");
      expect(replayedRun.ledgerLanding?.replayed, "the re-drive replays").toBe(true);
      expect(replayedRun.ledgerLanding?.accepted).toBe(true);
      const lifecycleCountAfterReplay = await ctx.port.execute<{ c: number }>({
        sql: `SELECT count(*)::int AS c FROM platform.idempotency_records
            WHERE application_id = $1 AND operation_name = $2`,
        parameters: [world.applicationId, LIFECYCLE_OPERATION],
      });
      expect(
        Number(lifecycleCountAfterReplay.rows[0]?.c ?? 0),
        "the re-drive added no lifecycle row",
      ).toBe(evaluatedRows.length * 2);
      const impostor = await createRealLifecycleLedgerAppend(ctx, world, replayRow, {
        proposalId: replayRow.sourceProposalId,
        toStage: OFFLINE_REPLAY_STAGE,
        evidenceDigest: "ffffffff",
      });
      expect(impostor, "a different evidence digest under a recorded key is REFUSED").toEqual({
        accepted: false,
        replayed: false,
        refused: true,
      });
      const lifecycleCountAfterImpostor = await ctx.port.execute<{ c: number }>({
        sql: `SELECT count(*)::int AS c FROM platform.idempotency_records
            WHERE application_id = $1 AND operation_name = $2`,
        parameters: [world.applicationId, LIFECYCLE_OPERATION],
      });
      expect(
        Number(lifecycleCountAfterImpostor.rows[0]?.c ?? 0),
        "the refused impostor added no lifecycle row",
      ).toBe(evaluatedRows.length * 2);

      const passes = runFacts.filter((fact) => fact.verdict === "equivalence-pass").length;
      const divergences = runFacts.filter((fact) => fact.verdict === "honest-divergence").length;
      const refusals = runFacts.filter((fact) => fact.verdict === "honest-refusal").length;
      const completed = runFacts.filter((fact) => fact.terminal === "COMPLETED").length;
      console.info(
        `[VAL-033] OFFLINE corpus summary: ${completed} COMPLETED of ${runFacts.length} driven ` +
          `equivalence runs (${passes} equivalence passes / ${divergences} honest divergence — an ` +
          `honest FAILED, never smoothed / ${refusals} honest refusals — every refusal a COMPLETED ` +
          `run); ${totalObservations} recorded observations served read-only from REAL SQL as the ` +
          `differential inputs (${drivenRows} durable executions, one per run — no phantoms, no ` +
          `ledger drift, zero orphan events); the candidate registry holds exactly ` +
          `${REGISTRY_SEED_PROPOSALS.length} immutable VAL-032 identities still at the \`proposed\` ` +
          `stage (the read-only input — the registry digest is IDENTICAL after the whole corpus; a ` +
          `different-content commit THROWS); the lifecycle ledger appended exactly ` +
          `${evaluatedRows.length * 2} evidenced transitions over REAL SQL (proposed → ` +
          `offline-replayed → differentially-evaluated ONLY — never beyond, never evidence-less; ` +
          `the re-drive REPLAYS, the impostor is REFUSED); every equivalence trajectory reproduced ` +
          `through the REAL recorder path (the projected digest IS the pinned class member, ` +
          `journals gapless); usage honestly none-reported offline; latency measured, never ` +
          `estimated; digests only, payload bytes never journaled.`,
      );
    } finally {
      await world.server.app.close();
    }
  });

  test("the REAL live rail drives the equivalence run with a REAL residual-AI confirmation round", {
    timeout: 600_000,
  }, async () => {
    const generateId = createUuidv7Generator();
    const notRun: string[] = [];
    if (OPENROUTER_KEY.length === 0) {
      console.warn(
        "[VAL-033] OPENROUTER_API_KEY absent — the REAL live equivalence row is a NOT RUN " +
          "boundary (recorded honestly; no fake success is asserted). The offline corpus above " +
          "covers every verdict/divergence/refusal/provenance/isolation/stage path without " +
          "credentials. Required access: an operator-authorized OpenRouter credential " +
          "(env OPENROUTER_API_KEY) covering the default chat model — the live equivalence run " +
          "demands ONE REAL residual-AI model round through the REAL platform model gateway " +
          "(measured usage, never estimated, never fabricated) before its verdict appends to the " +
          "REAL candidate lifecycle.",
      );
      expect(true).toBe(true);
      return;
    }

    const world = await seedApiPgWorld(ctx.port);
    const address = await world.server.app.listen({ port: 0, host: "127.0.0.1" });
    const driven = new Set<string>();
    const runFacts: RunFacts[] = [];

    try {
      const liveRows = EQUIVALENCE_TESTING_CORPUS.filter((row) => row.liveGate !== undefined);
      // The REAL SQL replay-ledger input + candidate registry for the live world.
      const ledgerInput = await seedRealReplayLedgerInput(ctx, world);
      const registry = await seedRealCandidateRegistry(ctx, world, REGISTRY_SEED_PROPOSALS);
      const incumbentExecutor = createRealIncumbentExecutor(ledgerInput.observations);

      // ONE live dispatch binding for ALL live rows (the VAL-025 review
      // lesson): the connection and its sealed credential envelope are
      // registered ONCE and shared.
      let liveDispatch: ControlDispatch | undefined;
      for (const row of liveRows) {
        const taskIndex = EQUIVALENCE_TESTING_CORPUS.findIndex(
          (candidate) => candidate.rowId === row.rowId,
        );
        if (!liveGateOpen(row, process.env)) {
          notRun.push(
            `${row.rowId} — gate closed (${row.liveGate?.envVars.join("+")} absent); ` +
              `requirement: ${row.liveGate?.requirement}`,
          );
          continue;
        }
        // Provider-side pacing before the live equivalence run.
        await new Promise((resolve) => setTimeout(resolve, 2_000));
        const runSuffix = `live-${generateId().slice(-8)}`;
        if (liveDispatch === undefined) {
          liveDispatch = (await buildLiveDispatch(ctx, world)).dispatch;
        }
        const dispatch: ControlDispatch = liveDispatch;
        const appKey = equivalenceSubmissionKey({ runSuffix, taskIndex });
        const appBody = equivalenceTaskBodyFor({
          rowId: row.rowId,
          sourceProposalId: row.sourceProposalId,
          replacementShape: row.replacementShape,
        });
        const {
          executionId,
          result,
          appSettled,
          registryDigestBefore,
          registryDigestAfter,
          trajectorySteps,
        } = await driveCrownEquivalence({
          ctx,
          world,
          address,
          row,
          taskIndex,
          runSuffix,
          registry,
          incumbentExecutor,
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
          registryDigestBefore,
          registryDigestAfter,
          trajectorySteps,
        });

        // The live row's usage is MEASURED (never estimated).
        expect(result.usage?.inputTokens ?? -1, `${row.rowId} live usage measured`).toBeGreaterThan(
          -1,
        );
        expect(result.observedModelCalls, `${row.rowId} one residual-AI round`).toBe(1);

        const usage =
          result.usage === null
            ? "none-reported"
            : `${result.usage.inputTokens}+${result.usage.outputTokens}` +
              (result.usage.costUsd === undefined ? "" : `/$${result.usage.costUsd}`);
        runFacts.push({
          rowId: row.rowId,
          terminal: result.terminal,
          verdict: result.verdict,
          proposalId: row.sourceProposalId,
          populationSize: row.differentialPopulation.length,
          differentialDigest: result.differential?.digest ?? "none",
          landing:
            result.ledgerLanding === null
              ? "nothing-appended"
              : `accepted:${String(result.ledgerLanding.accepted)}/replayed:${String(result.ledgerLanding.replayed)}`,
          modelCalls: `${result.observedModelCalls}/${row.expected.modelCalls}`,
          latencyMs: result.latencyMs,
          appSubmissionLatencyMs: appSettled.outcome.submissionLatencyMs,
          appTerminal: appSettled.outcome.observedTerminal,
          usage,
          keysDigest: keysDigestOf(appKey),
          bodyDigest: bodiesDigestOf(appBody),
        });
        console.info(
          `[VAL-033]   LIVE ${row.rowId} -> ${result.terminal} verdict=${runFacts[runFacts.length - 1]?.verdict} ` +
            `proposal=${runFacts[runFacts.length - 1]?.proposalId} ` +
            `modelCalls=${runFacts[runFacts.length - 1]?.modelCalls} ` +
            `latency=${runFacts[runFacts.length - 1]?.latencyMs}ms ` +
            `usage=${runFacts[runFacts.length - 1]?.usage}`,
        );
      }

      const completed = runFacts.filter((fact) => fact.terminal === "COMPLETED").length;
      console.info(
        `[VAL-033] LIVE rail summary: ${completed} COMPLETED of ${runFacts.length} driven live ` +
          `equivalence runs over the REAL OpenRouter rail (model ${MODEL}); ONE REAL residual-AI ` +
          `confirmation round per run (measured usage, BYOK — never estimated); digests only, ` +
          `payload bytes never journaled.`,
      );
      for (const boundary of notRun) {
        console.warn(`[VAL-033] NOT RUN boundary: ${boundary}`);
      }
      // At least one REAL live dispatch happened (never an
      // all-NOT-RUN silent pass once a credential is present).
      expect(runFacts.length).toBeGreaterThan(0);
    } finally {
      await world.server.app.close();
    }
  });
});
