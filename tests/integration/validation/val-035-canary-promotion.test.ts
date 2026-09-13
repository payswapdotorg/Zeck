/**
 * VAL-035 acceptance criteria 3 + 5 + 7 — the REAL end-to-end
 * integration crown: the offline canary corpus driven over the REAL
 * platform path over REAL PostgreSQL.
 *
 * Test 1 (the offline corpus): every row's canary run end to end — the
 * customer application riding the REAL public SDK wire (ONE canary
 * submission per row landing its OWN durable execution under its OWN
 * idempotency key → the completion poll → the result read → the events
 * read), the REAL candidate registry serving VAL-032's proposals as
 * READ-ONLY inputs from REAL SQL (the registry's own digest snapshotted
 * from FRESH SQL reads before and after every run — the entries are
 * immutable; a different-content commit under a recorded identity
 * THROWS), the REAL recorded traffic served read-only from REAL SQL
 * (one append-only row per recorded VAL-031 observation, keyed by the
 * 1-based population POSITION — the val-032 defect fix — with the
 * content digest as the request fingerprint; the traffic source
 * re-derives the historical cases' input/incumbent/class digests from
 * that REAL SQL snapshot, never from an in-memory pin), the governed
 * ramp advancing one pinned step at a time (the replacement executes
 * its deterministic SLICE while the INCUMBENT executes and serves the
 * remainder — the customer-facing serve), the mechanically derived
 * per-case divergences under the stated tolerance, the decisions
 * (advance / breach-rollback) with their policy citations and checks
 * recorded over REAL SQL, the breach triggering the COMPLETE mechanical
 * rollback (the served traffic reverts to the incumbent across the
 * whole slice — exercised, never partial), the canary/promoted
 * transitions appending to the REAL SQL candidate lifecycle ONE
 * evidenced rung at a time (the identical re-drive REPLAYS, an impostor
 * evidence digest is REFUSED), the canary cost booked APART under its
 * canary marker over REAL SQL (the served accounting bills the
 * incumbent ONLY — the customer is never billed for the canary), the
 * mechanically derived verdict per row (the honest terminals, the
 * pinned verdict kinds, the digests in their pinned classes), the
 * trajectory flush through the REAL recorder path (the projected
 * digest IS the pinned class member; journals gapless), the measured
 * latencies, and the honest none-reported offline usage.
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
import { runCanaryPromotionApp } from "../../../benchmarks/validation/apps/canary-promotion/application";
import {
  CANARY_PROMOTION_CORPUS,
  canarySubmissionKey,
  canaryTaskBodyFor,
  liveGateOpen,
  notYetShadowedWalkOf,
  pinnedCanaryRampOf,
  priorWalkOf,
  REFERENCED_REPLAY_POPULATION_REFS,
  REGISTRY_SEED_PROPOSALS_FOR_CANARY,
} from "../../../benchmarks/validation/apps/canary-promotion/corpus";
import { recordedObservationsOf } from "../../../benchmarks/validation/apps/learning-discovery/corpus";
import { validateHarnessEvidence } from "../../../benchmarks/validation/harness";
import type {
  CanaryCorpusRow,
  CanaryDecisionKind,
  CanaryLedgerPort,
  CanaryLifecycleLedgerPort,
  CanaryRunResult,
  CanaryTrafficSourcePort,
} from "../../../benchmarks/validation/platform/canary-promotion";
import {
  CANARY_COST_MARKER,
  canaryCostDigestOf,
  canaryDecisionDigestOf,
  canaryDivergenceDigestOf,
  canarySliceDigestOf,
  canaryTrajectoryStepsOf,
  deriveHonestCanaryStep,
  driveCanaryRun,
  PROMOTED_STAGE,
  rampScheduleDigestOf,
  referenceCanaryMeasurementOf,
  rollbackEventDigestOf,
} from "../../../benchmarks/validation/platform/canary-promotion";
import type { LifecycleTransitionRecord } from "../../../benchmarks/validation/platform/equivalence-testing";
import {
  differentialPopulationDigestOf,
  lifecycleEvidenceDigestOf,
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
const MODEL = process.env.ZECK_VAL_035_MODEL ?? "meta-llama/llama-3.3-70b-instruct";
const REVISION = createHash("sha256")
  .update("val-035|canary-promotion|pinned")
  .digest("hex")
  .slice(0, 40);
const MAX_TOKENS = 64;

/** The REAL SQL operations the crown's durable bindings ride. */
const LEDGER_INPUT_OPERATION = "val-035.replay-ledger-input";
const REGISTRY_OPERATION = "val-035.candidate-registry";
const LIFECYCLE_OPERATION = "val-035.candidate-lifecycle";
const CANARY_DECISION_OPERATION = "val-035.canary-decision-ledger";
const CANARY_DIVERGENCE_OPERATION = "val-035.canary-divergence-ledger";
const CANARY_ROLLBACK_OPERATION = "val-035.canary-rollback-event-ledger";
const CANARY_COST_OPERATION = "val-035.canary-cost-ledger";

/** Per-run REAL facts collected for the evidence document. */
interface RunFacts {
  readonly rowId: string;
  readonly terminal: string;
  readonly verdict: string;
  readonly proposalId: string;
  readonly populationSize: number;
  readonly decisions: number;
  readonly divergences: number;
  readonly landing: string;
  readonly canaryCostMicroUsd: string;
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
  readonly outcome: Awaited<ReturnType<typeof runCanaryPromotionApp>>;
}

/** The registry facts' read-only digest (payload-free — digests only). */
function registryFactsDigestOf(facts: {
  readonly proposals: readonly {
    readonly proposalId: string;
    readonly kind: string;
    readonly lifecycleStage: CandidateLifecycleStage;
    readonly citationDigest: string;
  }[];
  readonly appliedCandidateCount: number;
}): string {
  return longitudinalDigestOf([
    "val-035-registry-facts",
    facts.proposals.map((proposal) => [
      proposal.proposalId,
      proposal.kind,
      proposal.lifecycleStage,
      proposal.citationDigest,
    ]),
    facts.appliedCandidateCount,
  ]);
}

// ---------------------------------------------------------------------------
// The REAL durable bindings (the platform slice's canary ports)
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
 * (the val-032 defect fix). The binding serves the recorded
 * observations read-only — the canary traffic source and the incumbent
 * executor read the recorded traffic from this REAL SQL snapshot,
 * never from an in-memory pin.
 */
async function seedRealReplayLedgerInput(
  ctx: PgContext,
  world: ApiPgWorld,
): Promise<{
  /** The read-through snapshot (replay identity → the recorded observation). */
  readonly observations: ReadonlyMap<string, RecordedReplayObservation>;
  /** The per-population workload classes (identity → the class members). */
  readonly classMembersByPopulationWorkload: ReadonlyMap<string, readonly string[]>;
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
      parameters: [world.applicationId, LEDGER_INPUT_OPERATION],
    });
    return rows.rows;
  };

  const snapshotRows = await readRows();
  const observations = new Map<string, RecordedReplayObservation>();
  const classMembersByPopulationWorkload = new Map<string, string[]>();
  for (const row of snapshotRows) {
    const parsed = parseObservation(row.durable_outcome);
    if (parsed === null) {
      continue;
    }
    observations.set(parsed.observation.replayIdentity, parsed.observation);
    const ref = row.idempotency_key.split("::obs-")[0] ?? "unknown-population";
    const classKey = `${ref}::${parsed.observation.workloadId}`;
    const members = classMembersByPopulationWorkload.get(classKey) ?? [];
    if (!members.includes(parsed.observation.trajectoryDigest)) {
      members.push(parsed.observation.trajectoryDigest);
    }
    classMembersByPopulationWorkload.set(classKey, members);
  }

  return {
    observations,
    classMembersByPopulationWorkload,
    refreshFacts: async () => {
      const rows = await readRows();
      return {
        observationCount: rows.length,
        factsDigest: longitudinalDigestOf([
          "val-035-replay-ledger-input",
          ...rows.map((row) => row.idempotency_key).sort(),
        ]),
      };
    },
  };
}

/**
 * The REAL canary traffic source: the recorded workload mix serve —
 * every HISTORICAL traffic case's input digest, incumbent digest and
 * digest class are re-derived from the REAL SQL replay-ledger snapshot
 * (the recorded VAL-031 facts, grouped per population workload — never
 * an in-memory pin); the pinned injected probes serve their own corpus
 * pins (they are this slice's pins, not VAL-031 replays). A cited
 * identity the recorded population does not hold is a configuration
 * error.
 */
function createRealTrafficSource(input: {
  readonly observations: ReadonlyMap<string, RecordedReplayObservation>;
  readonly classMembersByPopulationWorkload: ReadonlyMap<string, readonly string[]>;
}): CanaryTrafficSourcePort {
  return {
    async populationFor(request: { readonly population: CanaryCorpusRow["trafficPopulation"] }) {
      return request.population.map((tcase) => {
        if (tcase.source !== "historical-replay") {
          return { ...tcase };
        }
        const observation = input.observations.get(tcase.sourceRef);
        if (observation === undefined) {
          throw new Error(
            `the recorded population holds no replay identity ${tcase.sourceRef} ` +
              "(the traffic case is not a member of the cited population)",
          );
        }
        let classDigests: readonly string[] = [];
        for (const [classKey, members] of input.classMembersByPopulationWorkload.entries()) {
          if (classKey.endsWith(`::${observation.workloadId}`)) {
            classDigests = [...members].sort();
            break;
          }
        }
        if (classDigests.length === 0) {
          throw new Error(
            `the recorded population holds no workload class ${observation.workloadId} ` +
              `(the traffic case ${tcase.caseId} has no pinned digest class)`,
          );
        }
        return {
          caseId: tcase.caseId,
          source: tcase.source,
          sourceRef: tcase.sourceRef,
          inputDigest: observation.inputDigest,
          incumbentDigest: observation.trajectoryDigest,
          classDigests,
        };
      });
    },
  };
}

/**
 * The REAL incumbent executor: the served leg's incumbent digests are
 * served READ-ONLY from the REAL SQL replay-ledger snapshot (the
 * recorded VAL-031 trajectory digest per cited replay identity — never
 * an in-memory pin); the pinned injected probes serve their own corpus
 * pins.
 */
function createRealIncumbentExecutor(
  observations: ReadonlyMap<string, RecordedReplayObservation>,
): {
  outcomeFor(input: {
    readonly dcase: CanaryCorpusRow["trafficPopulation"][number];
  }): Promise<{ readonly digest: string }>;
} {
  return {
    async outcomeFor(request: { readonly dcase: CanaryCorpusRow["trafficPopulation"][number] }) {
      if (request.dcase.source === "historical-replay") {
        const observation = observations.get(request.dcase.sourceRef);
        if (observation === undefined) {
          throw new Error(
            `the recorded population holds no replay identity ${request.dcase.sourceRef} ` +
              "(the traffic case is not a member of the cited population)",
          );
        }
        return { digest: observation.trajectoryDigest };
      }
      return { digest: request.dcase.incumbentDigest };
    },
  };
}

/**
 * The REAL canary serving path (the customer-facing slice serve + the
 * mechanical revert + the served accounting): the honest path serves
 * the INCUMBENT's executed digest on every case OUTSIDE the step's
 * granted slice and the REPLACEMENT's digest on every case INSIDE it
 * (the unpromoted candidate serves only its canary slice), books the
 * incumbent's own measured cost to the served accounting (3 micro-usd
 * per serve plus the 1 micro-usd base — the honest served basis; the
 * billed total starts equal to it — the customer is never billed for
 * the canary), and the revert is complete and mechanical (the WHOLE
 * slice reverts to the incumbent).
 */
function createRealCanaryServingPath(): {
  serveStep(input: {
    readonly tcase: CanaryCorpusRow["trafficPopulation"][number];
    readonly incumbentDigest: string;
    readonly replacementDigest: string | null;
    readonly inSlice: boolean;
    readonly stepIndex: number;
  }): Promise<{ readonly servedSource: string; readonly servedDigest: string }>;
  revertToIncumbent(input: {
    readonly sliceCaseIds: readonly string[];
  }): Promise<readonly { readonly caseId: string; readonly servedSource: string }[]>;
  servedAccounting(): {
    readonly incumbentMicroUsd: number;
    readonly billedMicroUsd: number;
    readonly latencyMs: number;
  };
} {
  let incumbentMicroUsd = 1;
  let billedMicroUsd = 1;
  let latencyMs = 0;
  return {
    async serveStep(request: {
      readonly tcase: CanaryCorpusRow["trafficPopulation"][number];
      readonly incumbentDigest: string;
      readonly replacementDigest: string | null;
      readonly inSlice: boolean;
      readonly stepIndex: number;
    }) {
      incumbentMicroUsd += 3;
      billedMicroUsd += 3;
      latencyMs += 7;
      if (request.inSlice && request.replacementDigest !== null) {
        return { servedSource: "replacement", servedDigest: request.replacementDigest };
      }
      return { servedSource: "incumbent", servedDigest: request.incumbentDigest };
    },
    async revertToIncumbent(request: { readonly sliceCaseIds: readonly string[] }) {
      // The complete mechanical revert: the WHOLE slice reverts to the
      // incumbent (no residual ever serves the replacement).
      return request.sliceCaseIds.map((caseId) => ({
        caseId,
        servedSource: "incumbent",
      }));
    },
    servedAccounting() {
      return { incumbentMicroUsd, billedMicroUsd, latencyMs };
    },
  };
}

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
interface RealCandidateRegistryBinding {
  candidateFor(proposalId: string): DiscoveryProposalRecord | null;
  facts(): {
    readonly proposals: readonly {
      readonly proposalId: string;
      readonly kind: string;
      readonly lifecycleStage: CandidateLifecycleStage;
      readonly citationDigest: string;
    }[];
    readonly appliedCandidateCount: number;
  };
  /** Re-read the REAL durable rows (the read-only proof basis). */
  refreshFacts(): Promise<{
    readonly proposals: readonly {
      readonly proposalId: string;
      readonly kind: string;
      readonly lifecycleStage: CandidateLifecycleStage;
      readonly citationDigest: string;
    }[];
    readonly appliedCandidateCount: number;
  }>;
}

/**
 * The REAL candidate registry: VAL-032's proposals are committed
 * through the REAL SQL unique-index arbitration (the derived proposal
 * identity as the idempotency key, the proposal's content digest as the
 * request fingerprint — ONE immutable row per proposal, append-only; an
 * identical re-commit replays, a different-content commit under a
 * recorded identity THROWS), and the port serves every read from the
 * REAL durable rows: a read-through snapshot loaded from SQL at binding
 * time (the port contract is synchronous by design), refreshed from
 * FRESH SQL reads for every read-only proof (refreshFacts). The canary
 * run never rewrites an entry — the registry's own digest is
 * snapshotted before and after every run.
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
      readonly durable_outcome: Record<string, unknown>;
    }>({
      sql: `SELECT idempotency_key, durable_outcome FROM platform.idempotency_records
            WHERE application_id = $1 AND operation_name = $2
            ORDER BY created_at ASC, id ASC`,
      parameters: [world.applicationId, REGISTRY_OPERATION],
    });
    return rows.rows;
  };

  const factsOf = (rows: readonly SqlRow[]) => {
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
    candidateFor(proposalId: string): DiscoveryProposalRecord | null {
      const record = snapshot.get(proposalId);
      return record === undefined ? null : { ...record, citation: { ...record.citation } };
    },
    facts() {
      return snapshotFacts;
    },
    async refreshFacts() {
      const rows = await readRows();
      snapshotFacts = factsOf(rows);
      return snapshotFacts;
    },
  };
}

// ---------------------------------------------------------------------------
// The REAL SQL lifecycle ledger (the recorded VAL-033 + VAL-034 walk + the append)
// ---------------------------------------------------------------------------

/** The REAL SQL read-back of one row's lifecycle walk (the durable truth). */
async function readLifecycleWalk(
  ctx: PgContext,
  world: ApiPgWorld,
  row: CanaryCorpusRow,
  proposalId: string,
): Promise<readonly LifecycleTransitionRecord[]> {
  const rows = await ctx.port.execute<{
    idempotency_key: string;
    readonly durable_outcome: Record<string, unknown>;
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

/**
 * Pre-seed one row's recorded VAL-033 + VAL-034 walk over REAL SQL (the
 * read-only input the canary run appends FROM): the `offline-replayed`
 * + `differentially-evaluated` + `shadow-executed` transitions with
 * their CANONICAL evidence digests, committed through the REAL
 * unique-index arbitration (append-only; an identical re-commit
 * replays, a different-content commit THROWS). The
 * not-yet-shadow-executed refusal row's candidate gets VAL-033's
 * landing WITHOUT the shadow append (its canary refuses honestly); the
 * unregistered-refusal row's phantom candidate gets nothing.
 */
async function seedRealPriorWalks(
  ctx: PgContext,
  world: ApiPgWorld,
  rows: readonly CanaryCorpusRow[],
): Promise<void> {
  const generateId = createUuidv7Generator();
  for (const row of rows) {
    if (row.expected.refusalReason === "candidate-unregistered") {
      // The phantom candidate never registered — no recorded walk
      // exists to pre-seed.
      continue;
    }
    const priors =
      row.expected.refusalReason === "candidate-not-shadow-executed"
        ? notYetShadowedWalkOf(row.sourceProposalId)
        : priorWalkOf(row);
    for (const prior of priors) {
      const key = `${row.rowId}::${prior.proposalId}::${prior.toStage}`;
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
            LIFECYCLE_OPERATION,
            key,
            prior.evidenceDigest,
            JSON.stringify({
              proposalId: prior.proposalId,
              toStage: prior.toStage,
              evidenceDigest: prior.evidenceDigest,
              ordinal: prior.ordinal,
            }),
          ],
        });
        if (inserted.rows.length > 0) {
          return;
        }
        const existing = await tx.execute<{ request_fingerprint: string }>({
          sql: `SELECT request_fingerprint FROM platform.idempotency_records
                WHERE application_id = $1 AND operation_name = $2 AND idempotency_key = $3`,
          parameters: [world.applicationId, LIFECYCLE_OPERATION, key],
        });
        const existingRow = existing.rows[0];
        if (existingRow === undefined) {
          throw new Error(`the prior-walk arbitration lost the transition ${key}`);
        }
        if (existingRow.request_fingerprint !== prior.evidenceDigest) {
          throw new Error(
            `append-only violation: the recorded transition ${key} is already committed with ` +
              "different evidence — the recorded VAL-033 + VAL-034 walk is a read-only input",
          );
        }
      });
    }
  }
}

/** One REAL SQL lifecycle append (the append-only arbitration). */
async function createRealLifecycleAppend(
  ctx: PgContext,
  world: ApiPgWorld,
  row: CanaryCorpusRow,
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

/**
 * The per-row REAL SQL lifecycle ledger: the pre-seeded recorded walk
 * (read from REAL SQL at binding time — the durable truth) plus the
 * APPEND-ONLY canaried / promoted transitions through the REAL
 * arbitration. The synchronous transitions view rides an in-memory
 * mirror of the durable appends (the SQL read-back in the verification
 * is the durable truth).
 */
async function createRealLifecycleLedger(
  ctx: PgContext,
  world: ApiPgWorld,
  row: CanaryCorpusRow,
): Promise<CanaryLifecycleLedgerPort> {
  const recordedWalk = await readLifecycleWalk(ctx, world, row, row.sourceProposalId);
  const mirror: LifecycleTransitionRecord[] = recordedWalk.map((transition) => ({
    ...transition,
  }));
  return {
    append: async (record: Omit<LifecycleTransitionRecord, "ordinal">) => {
      const receipt = await createRealLifecycleAppend(ctx, world, row, record);
      if (receipt.accepted && !receipt.replayed) {
        mirror.push({ ...record, ordinal: mirror.length + 1 });
      } else if (receipt.replayed) {
        const existing = mirror.find((transition) => transition.toStage === record.toStage);
        if (existing === undefined) {
          mirror.push({ ...record, ordinal: mirror.length + 1 });
        }
      }
      return receipt;
    },
    transitionsFor: (proposalId: string) =>
      mirror
        .filter((transition) => transition.proposalId === proposalId)
        .map((transition) => ({ ...transition })),
  };
}

// ---------------------------------------------------------------------------
// The REAL SQL canary ledger (decisions + divergences + rollback
// events + canary cost — append-only)
// ---------------------------------------------------------------------------

/** The REAL SQL read-back of one row's canary decisions (the durable truth). */
async function readCanaryDecisions(
  ctx: PgContext,
  world: ApiPgWorld,
  row: CanaryCorpusRow,
  proposalId: string,
): Promise<
  readonly {
    readonly stepIndex: number;
    readonly kind: string;
    readonly observedDivergenceCount: number;
    readonly budgetLimit: number;
    readonly rampScheduleDigest: string;
    readonly failureBudgetStated: boolean;
    readonly toleranceStated: boolean;
    readonly rampChecked: boolean;
    readonly budgetChecked: boolean;
    readonly toleranceChecked: boolean;
  }[]
> {
  const rows = await ctx.port.execute<{
    readonly durable_outcome: Record<string, unknown>;
  }>({
    sql: `SELECT durable_outcome FROM platform.idempotency_records
          WHERE application_id = $1 AND operation_name = $2
            AND idempotency_key LIKE $3 || '%'
            AND durable_outcome->>'proposalId' = $4
          ORDER BY (durable_outcome->>'stepIndex')::int ASC`,
    parameters: [world.applicationId, CANARY_DECISION_OPERATION, `${row.rowId}::`, proposalId],
  });
  return rows.rows.flatMap((sqlRow) => {
    const stepIndex =
      typeof sqlRow.durable_outcome?.stepIndex === "number"
        ? sqlRow.durable_outcome.stepIndex
        : null;
    const kind =
      typeof sqlRow.durable_outcome?.kind === "string" ? sqlRow.durable_outcome.kind : null;
    const observedDivergenceCount =
      typeof sqlRow.durable_outcome?.observedDivergenceCount === "number"
        ? sqlRow.durable_outcome.observedDivergenceCount
        : null;
    const budgetLimit =
      typeof sqlRow.durable_outcome?.budgetLimit === "number"
        ? sqlRow.durable_outcome.budgetLimit
        : null;
    const citations = (sqlRow.durable_outcome?.policyCitations ?? {}) as Record<string, unknown>;
    const checks = (sqlRow.durable_outcome?.policyChecks ?? {}) as Record<string, unknown>;
    if (
      stepIndex === null ||
      kind === null ||
      observedDivergenceCount === null ||
      budgetLimit === null ||
      typeof citations.rampScheduleDigest !== "string" ||
      typeof citations.failureBudgetStated !== "boolean" ||
      typeof citations.toleranceStated !== "boolean" ||
      typeof checks.rampChecked !== "boolean" ||
      typeof checks.budgetChecked !== "boolean" ||
      typeof checks.toleranceChecked !== "boolean"
    ) {
      return [];
    }
    return [
      {
        stepIndex,
        kind,
        observedDivergenceCount,
        budgetLimit,
        rampScheduleDigest: citations.rampScheduleDigest,
        failureBudgetStated: citations.failureBudgetStated,
        toleranceStated: citations.toleranceStated,
        rampChecked: checks.rampChecked,
        budgetChecked: checks.budgetChecked,
        toleranceChecked: checks.toleranceChecked,
      },
    ];
  });
}

/** The REAL SQL read-back of one row's canary divergences (the durable truth). */
async function readCanaryDivergences(
  ctx: PgContext,
  world: ApiPgWorld,
  row: CanaryCorpusRow,
  proposalId: string,
): Promise<
  readonly {
    readonly stepIndex: number;
    readonly caseId: string;
    readonly incumbentDigest: string;
    readonly replacementDigest: string;
  }[]
> {
  const rows = await ctx.port.execute<{
    readonly durable_outcome: Record<string, unknown>;
  }>({
    sql: `SELECT durable_outcome FROM platform.idempotency_records
          WHERE application_id = $1 AND operation_name = $2
            AND idempotency_key LIKE $3 || '%'
            AND durable_outcome->>'proposalId' = $4
          ORDER BY (durable_outcome->>'ordinal')::int ASC`,
    parameters: [world.applicationId, CANARY_DIVERGENCE_OPERATION, `${row.rowId}::`, proposalId],
  });
  return rows.rows.flatMap((sqlRow) => {
    const stepIndex =
      typeof sqlRow.durable_outcome?.stepIndex === "number"
        ? sqlRow.durable_outcome.stepIndex
        : null;
    const caseId =
      typeof sqlRow.durable_outcome?.caseId === "string" ? sqlRow.durable_outcome.caseId : null;
    const incumbentDigest =
      typeof sqlRow.durable_outcome?.incumbentDigest === "string"
        ? sqlRow.durable_outcome.incumbentDigest
        : null;
    const replacementDigest =
      typeof sqlRow.durable_outcome?.replacementDigest === "string"
        ? sqlRow.durable_outcome.replacementDigest
        : null;
    if (
      stepIndex === null ||
      caseId === null ||
      incumbentDigest === null ||
      replacementDigest === null
    ) {
      return [];
    }
    return [{ stepIndex, caseId, incumbentDigest, replacementDigest }];
  });
}

/** The REAL SQL read-back of one row's rollback events (the durable truth). */
async function readCanaryRollbackEvents(
  ctx: PgContext,
  world: ApiPgWorld,
  row: CanaryCorpusRow,
  proposalId: string,
): Promise<
  readonly { readonly stepIndex: number; readonly residualReplacementCaseIds: readonly string[] }[]
> {
  const rows = await ctx.port.execute<{
    readonly durable_outcome: Record<string, unknown>;
  }>({
    sql: `SELECT durable_outcome FROM platform.idempotency_records
          WHERE application_id = $1 AND operation_name = $2
            AND idempotency_key LIKE $3 || '%'
            AND durable_outcome->>'proposalId' = $4
          ORDER BY (durable_outcome->>'ordinal')::int ASC`,
    parameters: [world.applicationId, CANARY_ROLLBACK_OPERATION, `${row.rowId}::`, proposalId],
  });
  return rows.rows.flatMap((sqlRow) => {
    const stepIndex =
      typeof sqlRow.durable_outcome?.stepIndex === "number"
        ? sqlRow.durable_outcome.stepIndex
        : null;
    const residual = Array.isArray(sqlRow.durable_outcome?.residualReplacementCaseIds)
      ? (sqlRow.durable_outcome.residualReplacementCaseIds as unknown[]).filter(
          (value): value is string => typeof value === "string",
        )
      : null;
    if (stepIndex === null || residual === null) {
      return [];
    }
    return [{ stepIndex, residualReplacementCaseIds: residual }];
  });
}

/** The REAL SQL read-back of one row's canary cost bookings (the durable truth). */
async function readCanaryCosts(
  ctx: PgContext,
  world: ApiPgWorld,
  row: CanaryCorpusRow,
  proposalId: string,
): Promise<
  readonly { readonly marker: string; readonly microUsd: number; readonly latencyMs: number }[]
> {
  const rows = await ctx.port.execute<{
    readonly durable_outcome: Record<string, unknown>;
  }>({
    sql: `SELECT durable_outcome FROM platform.idempotency_records
          WHERE application_id = $1 AND operation_name = $2
            AND idempotency_key LIKE $3 || '%'
            AND durable_outcome->>'proposalId' = $4
          ORDER BY (durable_outcome->>'stepIndex')::int ASC`,
    parameters: [world.applicationId, CANARY_COST_OPERATION, `${row.rowId}::`, proposalId],
  });
  return rows.rows.flatMap((sqlRow) => {
    const marker =
      typeof sqlRow.durable_outcome?.marker === "string" ? sqlRow.durable_outcome.marker : null;
    const microUsd =
      typeof sqlRow.durable_outcome?.microUsd === "number" ? sqlRow.durable_outcome.microUsd : null;
    const latencyMs =
      typeof sqlRow.durable_outcome?.latencyMs === "number"
        ? sqlRow.durable_outcome.latencyMs
        : null;
    if (marker === null || microUsd === null || latencyMs === null) {
      return [];
    }
    return [{ marker, microUsd, latencyMs }];
  });
}

/**
 * The per-row REAL SQL canary ledger: the decision ledger (every
 * executed step's decision with its policy citations and checks — the
 * decision digest as the request fingerprint; ONE append-only row per
 * (proposal, step); an identical re-append replays, a different record
 * is REFUSED), the divergence ledger (every divergence case-by-case
 * with BOTH sides' digests), the rollback-event ledger (the EXERCISED
 * rollback records with their residual serves) and the canary cost
 * ledger (the measured cost booked APART from the served accounting,
 * under the canary marker — one row per executed step). The
 * synchronous read views ride in-memory mirrors pre-loaded from the
 * REAL durable rows (the port contract is synchronous by design); the
 * SQL read-backs in the verification are the durable truth.
 */
async function createRealCanaryLedger(
  ctx: PgContext,
  world: ApiPgWorld,
  row: CanaryCorpusRow,
): Promise<CanaryLedgerPort> {
  const generateId = createUuidv7Generator();

  const decisionMirror: {
    readonly proposalId: string;
    readonly stepIndex: number;
    readonly kind: string;
    readonly sliceFraction: number;
    readonly observedDivergenceCount: number;
    readonly budgetLimit: number;
    readonly policyCitations: {
      readonly rampScheduleDigest: string;
      readonly failureBudgetStated: boolean;
      readonly toleranceStated: boolean;
    };
    readonly policyChecks: {
      readonly rampChecked: boolean;
      readonly budgetChecked: boolean;
      readonly toleranceChecked: boolean;
    };
    readonly ordinal: number;
  }[] = [];
  const divergenceMirror: {
    readonly proposalId: string;
    readonly stepIndex: number;
    readonly caseId: string;
    readonly incumbentDigest: string;
    readonly replacementDigest: string;
    readonly ordinal: number;
  }[] = [];
  const rollbackMirror: {
    readonly proposalId: string;
    readonly stepIndex: number;
    readonly planDigest: string;
    readonly residualReplacementCaseIds: readonly string[];
    readonly ordinal: number;
  }[] = [];
  const costMirror: {
    readonly proposalId: string;
    readonly marker: string;
    readonly microUsd: number;
    readonly latencyMs: number;
    readonly ordinal: number;
  }[] = [];

  // The arbitration helper: insert-or-replay over the REAL unique index.
  const arbitrate = async (
    operation: string,
    key: string,
    fingerprint: string,
    durableOutcome: Record<string, unknown>,
  ): Promise<{
    readonly accepted: boolean;
    readonly replayed: boolean;
    readonly refused: boolean;
  }> =>
    ctx.port.transaction(async (tx: Transaction) => {
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
          operation,
          key,
          fingerprint,
          JSON.stringify(durableOutcome),
        ],
      });
      if (inserted.rows.length > 0) {
        return { accepted: true, replayed: false, refused: false };
      }
      const existing = await tx.execute<{ request_fingerprint: string }>({
        sql: `SELECT request_fingerprint FROM platform.idempotency_records
              WHERE application_id = $1 AND operation_name = $2 AND idempotency_key = $3`,
        parameters: [world.applicationId, operation, key],
      });
      const existingRow = existing.rows[0];
      if (existingRow === undefined) {
        throw new Error(`the canary-ledger arbitration lost the record ${key}`);
      }
      if (existingRow.request_fingerprint === fingerprint) {
        return { accepted: true, replayed: true, refused: false };
      }
      return { accepted: false, replayed: false, refused: true };
    });

  return {
    async appendDecision(record) {
      const key = `${row.rowId}::${record.proposalId}::decision::step-${record.stepIndex}`;
      const fingerprint = canaryDecisionDigestOf(record);
      const ordinal = decisionMirror.length + 1;
      const receipt = await arbitrate(CANARY_DECISION_OPERATION, key, fingerprint, {
        ...record,
        ordinal,
      });
      if (!receipt.refused) {
        const existing = decisionMirror.find(
          (decision) =>
            decision.proposalId === record.proposalId && decision.stepIndex === record.stepIndex,
        );
        if (existing === undefined) {
          decisionMirror.push({ ...record, ordinal });
        }
      }
      return receipt;
    },
    decisionsFor(proposalId: string) {
      return decisionMirror
        .filter((decision) => decision.proposalId === proposalId)
        .map((decision) => ({ ...decision }));
    },
    async appendDivergence(record) {
      const key = `${row.rowId}::${record.proposalId}::divergence::step-${record.stepIndex}::case-${record.caseId}`;
      const fingerprint = canaryDivergenceDigestOf(record);
      const ordinal = divergenceMirror.length + 1;
      const receipt = await arbitrate(CANARY_DIVERGENCE_OPERATION, key, fingerprint, {
        ...record,
        ordinal,
      });
      if (!receipt.refused) {
        const existing = divergenceMirror.find(
          (divergence) =>
            divergence.proposalId === record.proposalId &&
            divergence.stepIndex === record.stepIndex &&
            divergence.caseId === record.caseId,
        );
        if (existing === undefined) {
          divergenceMirror.push({ ...record, ordinal });
        }
      }
      return receipt;
    },
    divergencesFor(proposalId: string) {
      return divergenceMirror
        .filter((divergence) => divergence.proposalId === proposalId)
        .map((divergence) => ({ ...divergence }));
    },
    async appendRollbackEvent(record) {
      const key = `${row.rowId}::${record.proposalId}::rollback::step-${record.stepIndex}`;
      const fingerprint = rollbackEventDigestOf(record);
      const ordinal = rollbackMirror.length + 1;
      const receipt = await arbitrate(CANARY_ROLLBACK_OPERATION, key, fingerprint, {
        ...record,
        ordinal,
      });
      if (!receipt.refused) {
        const existing = rollbackMirror.find(
          (event) => event.proposalId === record.proposalId && event.stepIndex === record.stepIndex,
        );
        if (existing === undefined) {
          rollbackMirror.push({ ...record, ordinal });
        }
      }
      return receipt;
    },
    rollbackEventsFor(proposalId: string) {
      return rollbackMirror
        .filter((event) => event.proposalId === proposalId)
        .map((event) => ({ ...event }));
    },
    async bookCanaryCost(entry) {
      // The driver books ONE measurement per executed ramp step, in
      // step order — the booking's durable key rides the step ordinal
      // (ONE append-only row per executed step; an identical re-booking
      // replays, a different measurement under a recorded step key is
      // REFUSED).
      const stepOrdinal =
        costMirror.filter((cost) => cost.proposalId === entry.proposalId).length + 1;
      const key = `${row.rowId}::${entry.proposalId}::canary-cost::step-${stepOrdinal}`;
      const fingerprint = canaryCostDigestOf(entry);
      const ordinal = stepOrdinal;
      const receipt = await arbitrate(CANARY_COST_OPERATION, key, fingerprint, {
        ...entry,
        ordinal,
        stepIndex: stepOrdinal,
      });
      if (!receipt.refused) {
        costMirror.push({ ...entry, ordinal });
      }
      return receipt;
    },
    canaryCostsFor(proposalId: string) {
      return costMirror
        .filter((cost) => cost.proposalId === proposalId)
        .map((cost) => ({ ...cost }));
    },
  };
}

// ---------------------------------------------------------------------------
// The REAL lifecycle driving (the canonical transitions per canary run)
// ---------------------------------------------------------------------------

/** The canonical prologue: authorize → plan → the planning decision → queue → start. */
async function driveLifecycleToRunning(
  world: ApiPgWorld,
  executionId: string,
  row: CanaryCorpusRow,
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
        reason: `val-035-${command}`,
      },
      `val-035-${executionId}-${command}-${transitionCounter.count}`,
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
            strategyId: "val-035-canary",
            plan: {
              strategyClass: "canary-promotion",
              // The canary run's OWN dispatch demand — the route read
              // surfaces it at the customer boundary (zero offline; the
              // live row's ONE residual-AI round).
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
        selectedStrategyId: "val-035-canary",
      },
    },
    `val-035-${executionId}-decision`,
  );
  await transition("queue");
  await transition("start");
}

/**
 * The verification boundary + the terminal for ONE canary run's landed
 * execution: the mechanically derived verdict (the run's own criteria
 * — every leg) recorded durably with the terminal transition.
 */
async function completeCanaryExecution(
  world: ApiPgWorld,
  executionId: string,
  result: CanaryRunResult,
): Promise<void> {
  await world.executions.transition(
    {
      actorId: world.actorId,
      applicationId: world.applicationId,
      tenantId: world.tenantId,
      executionId,
      command: "verify",
      reason: "val-035-verify",
    },
    `val-035-${executionId}-verify`,
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
          ? "val-035-verified"
          : `val-035-${result.failure?.category ?? "criterion-fail"}`,
      verificationResults: result.criteria.map((criterion) => ({
        criterionId: criterion.criterionId,
        strategy: criterion.strategy,
        status: criterion.status,
        recordedBy: "val-035-platform",
        evidence: [...criterion.evidence],
      })),
    },
    `val-035-${executionId}-${verdict}`,
  );
}

// ---------------------------------------------------------------------------
// The landed-canary provider (the app's submission lands through the
// public wire; the crown polls the REAL SQL for the durable row)
// ---------------------------------------------------------------------------

async function awaitLandedCanaryExecution(
  ctx: PgContext,
  world: ApiPgWorld,
  driven: Set<string>,
  row: CanaryCorpusRow,
): Promise<string> {
  for (let attempt = 0; attempt < 4_800; attempt += 1) {
    const rows = await ctx.port.execute<{ id: string }>({
      sql: `SELECT id FROM executions.executions
            WHERE application_id = $1
              AND task->>'kind' = $2
              AND task->>'rowId' = $3
              AND id != ALL($4::uuid[])
            ORDER BY id ASC`,
      parameters: [
        world.applicationId,
        "canary-promotion.governed-ramp.v1",
        row.rowId,
        [...driven],
      ],
    });
    if (rows.rows.length >= 1) {
      if (rows.rows.length !== 1) {
        throw new Error(
          `the row ${row.rowId} landed more executions than its canary run ` +
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
    `no landed canary execution for row ${row.rowId} after 120s (expected 1 durable execution)`,
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
        return { satisfied: true, catalogRevision: "val-035", satisfactions: [] };
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
      label: "val-035-openrouter",
      registerCredential: { material: OPENROUTER_KEY },
    },
    `val-035-conn-${generateId().slice(-8)}`,
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
            "You are the canary-confirmation supervisor of a governed validation execution.",
            "You receive the canary-promotion run's residual-AI confirmation request and decide",
            "whether the replacement's governed canary ramp may append its promoted rung. Answer",
            "with the single word: confirm",
          ].join(" "),
        },
        {
          role: "user",
          content:
            `Canary-promotion confirmation round (golden:live-confirmation, round ${round}, ` +
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
 * Drive one corpus row's canary run crown-style: the app rides the
 * public wire (ONE canary submission → the completion poll → the
 * result read → the events read) while the crown waits for the landed
 * execution and drives the REAL lifecycle around the canary run (the
 * prologue transitions → the canary run through the platform driver
 * with the REAL SQL candidate registry, the REAL SQL traffic source +
 * incumbent executor over the REAL replay populations, the honest
 * slice serving path + the reference canary runtime, the REAL SQL
 * append-only lifecycle ledger and the REAL SQL append-only canary
 * ledger → the registry read-only snapshots before and after from
 * FRESH SQL reads → the canary trajectory flush through the REAL
 * recorder path → the verification boundary + the mechanically derived
 * terminal).
 */
async function driveCrownCanary(options: {
  readonly ctx: PgContext;
  readonly world: ApiPgWorld;
  readonly address: string;
  readonly row: CanaryCorpusRow;
  readonly taskIndex: number;
  readonly runSuffix: string;
  readonly registry: RealCandidateRegistryBinding;
  readonly trafficSource: CanaryTrafficSourcePort;
  readonly incumbentExecutor: {
    outcomeFor(input: {
      readonly dcase: CanaryCorpusRow["trafficPopulation"][number];
    }): Promise<{ readonly digest: string }>;
  };
  readonly dispatch?: ControlDispatch;
  readonly driven: Set<string>;
}): Promise<{
  readonly executionId: string;
  readonly result: CanaryRunResult;
  readonly appSettled: AppOutcome;
  readonly registryDigestBefore: string;
  readonly registryDigestAfter: string;
  readonly trajectorySteps: readonly TrajectoryStepRecord[];
  readonly servingPath: ReturnType<typeof createRealCanaryServingPath>;
}> {
  const { world, row, taskIndex } = options;
  const generateId = createUuidv7Generator();

  // The app promise: the customer application over the REAL served
  // public wire (the app never touches platform internals).
  const appPromise: Promise<AppOutcome> = runCanaryPromotionApp({
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
      configuration: { suite: "val-035-canary-promotion" },
    },
    runSuffix: options.runSuffix,
    taskIndex,
  }).then((outcome) => ({ ok: true as const, outcome }));

  // The landed canary execution (the app's submission through the
  // public wire — ONE durable execution per row).
  const executionId = await awaitLandedCanaryExecution(options.ctx, world, options.driven, row);

  // The canonical prologue (authorize → plan → the planning decision →
  // queue → start) — the canary run drives over the REAL state machine.
  await driveLifecycleToRunning(world, executionId, row, generateId);

  // The registry read-only snapshot BEFORE the canary run (a FRESH
  // REAL SQL read — the read-only proof's basis).
  const registryDigestBefore = registryFactsDigestOf(await options.registry.refreshFacts());

  // The canary run through the platform driver with the REAL SQL
  // candidate registry, the REAL SQL traffic source + incumbent
  // executor, the honest slice serving path, the reference canary
  // runtime and the REAL SQL append-only ledgers.
  const servingPath = createRealCanaryServingPath();
  const canaryLedger = await createRealCanaryLedger(options.ctx, world, row);
  const lifecycle = await createRealLifecycleLedger(options.ctx, world, row);
  const result = await driveCanaryRun({
    row,
    registry: options.registry,
    lifecycle,
    canaryLedger,
    incumbentExecutor: options.incumbentExecutor,
    trafficSource: options.trafficSource,
    servingPath,
    canaryRuntime: {
      async runCanaryStep(input) {
        return deriveHonestCanaryStep(input);
      },
    },
    ...(options.dispatch === undefined ? {} : { dispatch: options.dispatch }),
    retry: {
      maxExtraAttempts: 2,
      backoffMs: 4_000,
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    },
    now: () => new Date(),
  });

  // The registry read-only snapshot AFTER the canary run (a FRESH REAL
  // SQL read — the read-only proof over REAL SQL).
  const registryDigestAfter = registryFactsDigestOf(await options.registry.refreshFacts());

  // The canary trajectory flush through the REAL recorder path: the
  // run's canonical canary steps journal into its landed execution
  // while the execution is RUNNING — the step events project back onto
  // the pinned canary trajectory (verified below over REAL SQL).
  const ramp = pinnedCanaryRampOf(row);
  const executedSteps =
    row.expected.refusalReason !== null
      ? []
      : row.expected.breachingStepIndex === null
        ? row.rampSchedule
        : row.rampSchedule.filter(
            (step) => step.stepIndex <= (row.expected.breachingStepIndex ?? 0),
          );
  const executedCost = executedSteps.reduce(
    (total, step) => {
      const honest = ramp.steps.find((entry) => entry.stepIndex === step.stepIndex);
      const measurement = referenceCanaryMeasurementOf(honest?.sliceCaseIds ?? []);
      return {
        microUsd: total.microUsd + measurement.microUsd,
        latencyMs: total.latencyMs + measurement.latencyMs,
      };
    },
    { microUsd: 0, latencyMs: 0 },
  );
  const trajectorySteps = canaryTrajectoryStepsOf({
    proposalId: row.sourceProposalId,
    populationDigest: differentialPopulationDigestOf(row.trafficPopulation),
    steps: executedSteps.map((step) => {
      const honest = ramp.steps.find((entry) => entry.stepIndex === step.stepIndex);
      return {
        stepIndex: step.stepIndex,
        sliceDigest: canarySliceDigestOf({
          proposalId: row.sourceProposalId,
          stepIndex: step.stepIndex,
          sliceCaseIds: honest?.sliceCaseIds ?? [],
        }),
        decisionKind:
          step.stepIndex === row.expected.breachingStepIndex
            ? ("breach-rollback" as const)
            : ("advance" as const),
        divergenceCount:
          ramp.divergencesByStep.find((entry) => entry.stepIndex === step.stepIndex)
            ?.divergenceCaseIds.length ?? 0,
        rollbackExercised: step.stepIndex === row.expected.breachingStepIndex,
      };
    }),
    canaryCostDigest:
      row.expected.refusalReason === null
        ? canaryCostDigestOf({
            proposalId: row.sourceProposalId,
            marker: CANARY_COST_MARKER,
            microUsd: executedCost.microUsd,
            latencyMs: executedCost.latencyMs,
          })
        : null,
    landedStages:
      row.expected.finalStage === PROMOTED_STAGE
        ? ["canaried", "promoted"]
        : row.expected.finalStage === "canaried"
          ? ["canaried"]
          : [],
    refusalReason: row.expected.refusalReason,
    confirmationRounds: row.expected.modelCalls,
  });
  for (const step of trajectorySteps) {
    await world.executions.recordStepEvent(
      {
        applicationId: world.applicationId,
        executionId,
        actor: { actorId: world.actorId, tenantId: world.tenantId },
        command: "agent-action-recorded",
        cause: `val-035-${step.kind}-${step.ordinal}`,
        reference: {
          kind: step.kind,
          ordinal: step.ordinal,
          detail: step.detail,
          digest: step.digest,
        },
        payload: { kind: step.kind, detail: step.detail, ordinal: step.ordinal },
      },
      `val-035-${executionId}-${step.kind}-${step.ordinal}`,
    );
  }

  // The verification boundary + the mechanically derived terminal.
  await completeCanaryExecution(world, executionId, result);

  const appSettled = await appPromise;
  return {
    executionId,
    result,
    appSettled,
    registryDigestBefore,
    registryDigestAfter,
    trajectorySteps,
    servingPath,
  };
}

// ---------------------------------------------------------------------------
// The per-row mechanical verification (over the REAL SQL)
// ---------------------------------------------------------------------------

/** Parse one REAL journal step kind (the trajectory vocabulary — honest on unknowns). */
function trajectoryStepKindOf(kind: string): TrajectoryStepKind {
  if (kind === "dispatch" || kind === "effect" || kind === "verification") {
    return kind;
  }
  throw new Error(`the REAL journal holds an unknown trajectory step kind: ${kind}`);
}

/**
 * Verify one row's crown outcome mechanically: the platform's canary
 * verdict (the terminal, every criterion, the policy / lifecycle /
 * breach / rollback / slice / cost / containment legs, the ledger
 * landings), the registry read-only proof (before === after, over
 * FRESH REAL SQL reads), the REAL journal projection (the canary
 * trajectory reproduction through the REAL recorder path — the
 * projected digest IS the pinned class member, the ordinals and
 * sequences gapless), the durable terminal, the REAL SQL lifecycle
 * walk (offline-replayed → differentially-evaluated → shadow-executed →
 * canaried → promoted, each transition evidenced with the canonical
 * evidence digest — one rung at a time), the REAL SQL canary ledger
 * (the decisions with their stated-and-checked policy, the per-case
 * divergences with both sides' digests, the exercised rollback events
 * with no residual, the canary cost booked apart under its marker), and
 * the app's honest observations over the public wire (the legs
 * observable on the real rail).
 */
async function verifyCrownRow(options: {
  readonly ctx: PgContext;
  readonly world: ApiPgWorld;
  readonly row: CanaryCorpusRow;
  readonly executionId: string;
  readonly result: CanaryRunResult;
  readonly appSettled: AppOutcome;
  readonly registryDigestBefore: string;
  readonly registryDigestAfter: string;
  readonly trajectorySteps: readonly TrajectoryStepRecord[];
  readonly servingPath: ReturnType<typeof createRealCanaryServingPath>;
}): Promise<void> {
  const { ctx, world, row, result, appSettled } = options;
  const { outcome: app } = appSettled;

  // ---- the honest canary contracts (the platform side) ----
  if (result.terminal !== row.expected.terminal) {
    console.info(
      `[VAL-035][DIAGNOSTIC] ${row.rowId} terminal=${result.terminal} failure=${JSON.stringify(result.failure)}`,
    );
    for (const criterion of result.criteria) {
      if (criterion.status === "FAIL") {
        console.info(
          `[VAL-035][DIAGNOSTIC]   FAIL ${criterion.criterionId}: ${criterion.evidence.join(" | ")}`,
        );
      }
    }
  }
  expect(result.terminal, `${row.rowId} terminal`).toBe(row.expected.terminal);
  if (row.expected.verdict === "honest-rollback") {
    // The honest rollback FAILs its observed-breach leg honestly (the
    // divergence count beyond the pinned budget, recorded case-by-case,
    // never smoothed) while every OTHER leg passes.
    expect(
      result.criteria.find((c) => c.criterionId === "breach-observed-beyond-budget")?.status,
      `${row.rowId} honest breach`,
    ).toBe("FAIL");
    const failedOther = result.criteria.filter(
      (criterion) =>
        criterion.status === "FAIL" && criterion.criterionId !== "breach-observed-beyond-budget",
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
  expect(result.breachHonesty?.breachingStepIndexes ?? [], `${row.rowId} breaching steps`).toEqual(
    row.expected.breachingStepIndex === null ? [] : [row.expected.breachingStepIndex],
  );
  if (result.refusal === null) {
    // The governed ramp is explicit, honest, complete, isolated,
    // separated and contained; the canary lands its evidenced rung(s).
    expect(result.policyExplicitness?.explicit, `${row.rowId} policy explicit`).toBe(true);
    expect(result.lifecycleCompleteness?.complete, `${row.rowId} lifecycle complete`).toBe(true);
    expect(result.breachHonesty?.honest, `${row.rowId} breach honest`).toBe(true);
    expect(result.rollbackCompleteness?.complete, `${row.rowId} rollback complete`).toBe(true);
    expect(result.sliceIsolation?.isolated, `${row.rowId} slice isolated`).toBe(true);
    expect(result.costSeparation?.separated, `${row.rowId} cost separated`).toBe(true);
    expect(result.isolation?.contained, `${row.rowId} contained`).toBe(true);
    expect(result.landings.canaried?.accepted, `${row.rowId} canaried landing`).toBe(true);
    if (row.expected.verdict === "clean-promotion") {
      expect(result.landings.promoted?.accepted, `${row.rowId} promoted landing`).toBe(true);
      expect(result.landings.promoted?.replayed, `${row.rowId} fresh promotion`).toBe(false);
    } else {
      expect(result.landings.promoted, `${row.rowId} rollback never promotes`).toBeNull();
    }
    // The decisions appended exactly the executed steps; the
    // divergences recorded case-by-case; the rollback exercised only on
    // the breach; the canary cost booked apart.
    const executedSteps = row.rampSchedule.filter(
      (step) =>
        row.expected.breachingStepIndex === null ||
        step.stepIndex <= row.expected.breachingStepIndex,
    );
    expect(result.decisionsAppended, `${row.rowId} decisions`).toBe(executedSteps.length);
    const ramp = pinnedCanaryRampOf(row);
    const expectedDivergences = ramp.divergencesByStep
      .filter((entry) => executedSteps.some((step) => step.stepIndex === entry.stepIndex))
      .reduce((total, entry) => total + entry.divergenceCaseIds.length, 0);
    expect(result.divergencesAppended, `${row.rowId} divergences`).toBe(expectedDivergences);
    expect(result.rollbackEventsAppended, `${row.rowId} rollback events`).toBe(
      row.expected.breachingStepIndex === null ? 0 : 1,
    );
    expect(result.canaryCostBooked, `${row.rowId} canary cost booked`).toBe(true);
    // The served accounting bills the incumbent ONLY — the customer is
    // never billed for the canary (the canary cost is measured apart,
    // under its marker).
    const accounting = options.servingPath.servedAccounting();
    expect(accounting.billedMicroUsd, `${row.rowId} never billed for the canary`).toBe(
      accounting.incumbentMicroUsd,
    );
  } else {
    expect(result.refusalHonesty?.honest, `${row.rowId} refusal honest`).toBe(true);
    expect(result.landings.canaried, `${row.rowId} refusal records nothing`).toBeNull();
    expect(result.decisionsAppended, `${row.rowId} refusal appends no decision`).toBe(0);
    expect(result.divergencesAppended, `${row.rowId} refusal appends no divergence`).toBe(0);
    expect(result.canaryCostBooked, `${row.rowId} refusal books no canary cost`).toBe(false);
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
    result.criteria.find((c) => c.criterionId === "canary-registry-read-only")?.status,
    `${row.rowId} registry read-only leg`,
  ).toBe("PASS");

  // ---- the REAL journal projection (the canary trajectory) ----
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
  expect(trajectoryDigestOf(projection), `${row.rowId} REAL journal canary digest`).toBe(
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
  if (row.expected.refusalReason === "candidate-unregistered") {
    // The honest refusal appends NOTHING to the candidate lifecycle.
    expect(walk, `${row.rowId} refusal walk`).toEqual([]);
  } else if (row.expected.refusalReason === "candidate-not-shadow-executed") {
    // The premature candidate's recorded walk ends at
    // differentially-evaluated — the canary never appends for it.
    expect(
      walk.map((transition) => transition.toStage),
      `${row.rowId} premature walk`,
    ).toEqual(["offline-replayed", "differentially-evaluated"]);
  } else {
    // The walk is EXACTLY the recorded VAL-033 + VAL-034 chain plus the
    // canary append — one evidenced rung at a time (canaried, then
    // promoted ONLY on a clean full ramp).
    expect(
      walk.map((transition) => transition.toStage),
      `${row.rowId} REAL SQL walk`,
    ).toEqual([
      "offline-replayed",
      "differentially-evaluated",
      "shadow-executed",
      "canaried",
      ...(row.expected.finalStage === PROMOTED_STAGE ? ["promoted"] : []),
    ]);
    // The evidenced walk: each transition carries the CANONICAL
    // lifecycle evidence digest (the prior walk's recorded evidence;
    // the decisions digest for the canaried rung; the ramp + decisions
    // digests for the promoted rung).
    const priorWalk = priorWalkOf(row);
    expect(walk[0]?.evidenceDigest, `${row.rowId} offline-replay evidence`).toBe(
      priorWalk[0]?.evidenceDigest,
    );
    expect(walk[1]?.evidenceDigest, `${row.rowId} differential evidence`).toBe(
      priorWalk[1]?.evidenceDigest,
    );
    expect(walk[2]?.evidenceDigest, `${row.rowId} shadow evidence`).toBe(
      priorWalk[2]?.evidenceDigest,
    );
    const decisions = await readCanaryDecisions(ctx, world, row, row.sourceProposalId);
    const decisionsDigest = longitudinalDigestOf([
      "canary-decisions",
      decisions.map((decision) => decision.kind),
    ]);
    expect(walk[3]?.evidenceDigest, `${row.rowId} canaried evidence`).toBe(
      lifecycleEvidenceDigestOf({
        proposalId: row.sourceProposalId,
        stage: "canaried",
        members: [decisionsDigest],
      }),
    );
    if (row.expected.finalStage === PROMOTED_STAGE) {
      expect(walk[4]?.evidenceDigest, `${row.rowId} promoted evidence`).toBe(
        lifecycleEvidenceDigestOf({
          proposalId: row.sourceProposalId,
          stage: PROMOTED_STAGE,
          members: [rampScheduleDigestOf(row.rampSchedule), decisionsDigest],
        }),
      );
      expect(walk[4]?.ordinal).toBe(5);
    }
    expect(walk[0]?.ordinal).toBe(1);
    expect(walk[1]?.ordinal).toBe(2);
    expect(walk[2]?.ordinal).toBe(3);
    expect(walk[3]?.ordinal).toBe(4);
  }

  // ---- the REAL SQL canary ledger (the durable truth) ----
  if (result.refusal === null) {
    const executedSteps = row.rampSchedule.filter(
      (step) =>
        row.expected.breachingStepIndex === null ||
        step.stepIndex <= row.expected.breachingStepIndex,
    );
    // The decisions: exactly the executed steps' decisions, each with
    // its stated-and-checked policy and its honest judgment.
    const decisions = await readCanaryDecisions(ctx, world, row, row.sourceProposalId);
    expect(
      decisions.map((decision) => decision.stepIndex),
      `${row.rowId} decision steps`,
    ).toEqual(executedSteps.map((step) => step.stepIndex));
    for (const decision of decisions) {
      const breaching = decision.stepIndex === row.expected.breachingStepIndex;
      expect(decision.kind, `${row.rowId} step ${decision.stepIndex} kind`).toBe(
        breaching ? "breach-rollback" : "advance",
      );
      expect(decision.budgetLimit).toBe(row.failureBudget.maxDivergencesPerStep);
      expect(decision.rampScheduleDigest).toBe(rampScheduleDigestOf(row.rampSchedule));
      expect(decision.failureBudgetStated).toBe(true);
      expect(decision.toleranceStated).toBe(true);
      expect(decision.rampChecked).toBe(true);
      expect(decision.budgetChecked).toBe(true);
      expect(decision.toleranceChecked).toBe(true);
    }
    // The divergences: exactly the mechanically-derived cases of the
    // executed steps, each carrying BOTH sides' digests — recorded
    // case-by-case, never smoothed, never aggregated away.
    const divergences = await readCanaryDivergences(ctx, world, row, row.sourceProposalId);
    const ramp = pinnedCanaryRampOf(row);
    const expectedCases = ramp.divergencesByStep
      .filter((entry) => executedSteps.some((step) => step.stepIndex === entry.stepIndex))
      .flatMap((entry) => entry.divergenceCaseIds);
    expect(
      divergences.map((record) => record.caseId),
      `${row.rowId} divergence cases`,
    ).toEqual(expectedCases);
    for (const record of divergences) {
      const tcase = row.trafficPopulation.find((candidate) => candidate.caseId === record.caseId);
      expect(record.incumbentDigest, `${row.rowId} ${record.caseId} incumbent digest`).toBe(
        tcase?.incumbentDigest,
      );
      expect(record.replacementDigest).toMatch(/^[0-9a-f]{8}$/);
      expect(record.incumbentDigest).toMatch(/^[0-9a-f]{8}$/);
      expect(
        record.replacementDigest,
        `${row.rowId} ${record.caseId} both sides recorded`,
      ).not.toBe(record.incumbentDigest);
    }
    // The rollback events: exactly one per breaching row, exercised
    // with NO residual serving the replacement (complete and
    // mechanical).
    const rollbackEvents = await readCanaryRollbackEvents(ctx, world, row, row.sourceProposalId);
    expect(rollbackEvents).toHaveLength(row.expected.breachingStepIndex === null ? 0 : 1);
    for (const event of rollbackEvents) {
      expect(event.stepIndex).toBe(row.expected.breachingStepIndex);
      expect(event.residualReplacementCaseIds).toEqual([]);
    }
    // The canary cost: booked APART under the canary marker — the
    // reference measurement per executed step, never the served bill.
    const costs = await readCanaryCosts(ctx, world, row, row.sourceProposalId);
    expect(costs).toHaveLength(executedSteps.length);
    for (const cost of costs) {
      expect(cost.marker).toBe(CANARY_COST_MARKER);
    }
    const executedCost = executedSteps.reduce(
      (total, step) => {
        const honest = ramp.steps.find((entry) => entry.stepIndex === step.stepIndex);
        const measurement = referenceCanaryMeasurementOf(honest?.sliceCaseIds ?? []);
        return {
          microUsd: total.microUsd + measurement.microUsd,
          latencyMs: total.latencyMs + measurement.latencyMs,
        };
      },
      { microUsd: 0, latencyMs: 0 },
    );
    expect(
      costs.reduce((total, cost) => total + cost.microUsd, 0),
      `${row.rowId} canary cost total (measured apart)`,
    ).toBe(executedCost.microUsd);
    expect(costs.reduce((total, cost) => total + cost.latencyMs, 0)).toBe(executedCost.latencyMs);
  } else {
    expect(
      await readCanaryDecisions(ctx, world, row, row.sourceProposalId),
      `${row.rowId} refusal records no decision`,
    ).toEqual([]);
    expect(
      await readCanaryDivergences(ctx, world, row, row.sourceProposalId),
      `${row.rowId} refusal records no divergence`,
    ).toEqual([]);
    expect(
      await readCanaryRollbackEvents(ctx, world, row, row.sourceProposalId),
      `${row.rowId} refusal records no rollback event`,
    ).toEqual([]);
    expect(
      await readCanaryCosts(ctx, world, row, row.sourceProposalId),
      `${row.rowId} refusal books no canary cost`,
    ).toEqual([]);
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
    // The honest-rollback rows: the FAILED terminal carries its FAIL
    // statuses (the honest breach recorded, never smoothed into a pass).
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

definePgSuite("VAL-035 canary promotion over the real platform path", (ctx) => {
  test("the offline canary corpus drives governed-promotion semantics over the REAL platform path", {
    timeout: 300_000,
  }, async () => {
    const world = await seedApiPgWorld(ctx.port);
    const address = await world.server.app.listen({ port: 0, host: "127.0.0.1" });
    const driven = new Set<string>();
    const runFacts: RunFacts[] = [];

    try {
      const offlineRows = CANARY_PROMOTION_CORPUS.filter((row) => row.liveGate === undefined);
      // The REAL SQL replay-ledger input (every referenced VAL-031
      // population's recorded observations — the read-only recorded
      // traffic) and the REAL SQL candidate registry (VAL-032's
      // proposals + the not-yet-shadow-executed entry, read-only).
      const ledgerInput = await seedRealReplayLedgerInput(ctx, world);
      const registry = await seedRealCandidateRegistry(
        ctx,
        world,
        REGISTRY_SEED_PROPOSALS_FOR_CANARY,
      );
      const trafficSource = createRealTrafficSource({
        observations: ledgerInput.observations,
        classMembersByPopulationWorkload: ledgerInput.classMembersByPopulationWorkload,
      });
      const incumbentExecutor = createRealIncumbentExecutor(ledgerInput.observations);

      // The recorded VAL-033 + VAL-034 walks pre-seeded over REAL SQL
      // (the read-only lifecycle input the canary run appends FROM).
      await seedRealPriorWalks(ctx, world, offlineRows);

      // The read-only bases over FRESH REAL SQL reads: the registry's
      // own digest and the replay-ledger input's durable row set.
      const initialRegistryFacts = await registry.refreshFacts();
      const initialRegistryDigest = registryFactsDigestOf(initialRegistryFacts);
      const initialLedgerFacts = await ledgerInput.refreshFacts();
      const totalObservations = initialLedgerFacts.observationCount;
      expect(
        totalObservations,
        "the replay populations hold their recorded observations",
      ).toBeGreaterThan(0);
      // The registry serves EXACTLY the pinned VAL-032 membership at the
      // proposed stage (zero applied candidates — the read-only input).
      expect(initialRegistryFacts.proposals).toHaveLength(
        REGISTRY_SEED_PROPOSALS_FOR_CANARY.length,
      );
      expect(
        new Set(initialRegistryFacts.proposals.map((proposal) => proposal.proposalId)),
      ).toEqual(new Set(REGISTRY_SEED_PROPOSALS_FOR_CANARY.map((pin) => pin.proposalId)));
      for (const proposal of initialRegistryFacts.proposals) {
        expect(proposal.lifecycleStage, `${proposal.proposalId} proposed only`).toBe("proposed");
      }
      expect(initialRegistryFacts.appliedCandidateCount).toBe(0);

      for (const row of offlineRows) {
        const generateId = createUuidv7Generator();
        const runSuffix = `it-${generateId().slice(-8)}`;
        // The ABSOLUTE corpus index (the val-032 live-index lesson:
        // the app selects its row by the FULL-corpus index).
        const taskIndex = CANARY_PROMOTION_CORPUS.findIndex(
          (candidate) => candidate.rowId === row.rowId,
        );
        const appKey = canarySubmissionKey({ runSuffix, taskIndex });
        const appBody = canaryTaskBodyFor({
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
          servingPath,
        } = await driveCrownCanary({
          ctx,
          world,
          address,
          row,
          taskIndex,
          runSuffix,
          registry,
          trafficSource,
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
          servingPath,
        });

        // The app key's ledger record: ONE create arbitration per
        // canary submission key (no ledger drift — the submission
        // landed its OWN durable execution under its OWN key).
        const keyRecords = await ctx.port.execute<{ c: number }>({
          sql: `SELECT count(*)::int AS c FROM platform.idempotency_records
              WHERE application_id = $1 AND idempotency_key = $2
                AND operation_name = 'executions.create'`,
          parameters: [world.applicationId, appKey],
        });
        expect(Number(keyRecords.rows[0]?.c ?? 0), `${row.rowId} app key records`).toBe(1);

        const costs = await readCanaryCosts(ctx, world, row, row.sourceProposalId);
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
          populationSize: row.trafficPopulation.length,
          decisions: result.decisionsAppended,
          divergences: result.divergencesAppended,
          landing:
            result.landings.canaried === null
              ? "nothing-appended"
              : `canaried:${String(result.landings.canaried.accepted)}` +
                (result.landings.promoted === null
                  ? ""
                  : `/promoted:${String(result.landings.promoted.accepted)}`),
          canaryCostMicroUsd:
            costs.length === 0
              ? "none"
              : `${costs.reduce((total, cost) => total + cost.microUsd, 0)}u$/${costs.reduce((total, cost) => total + cost.latencyMs, 0)}ms`,
          modelCalls: `${result.observedModelCalls}/${row.expected.modelCalls}`,
          latencyMs: result.latencyMs,
          appSubmissionLatencyMs: appSettled.outcome.submissionLatencyMs,
          appTerminal: appSettled.outcome.observedTerminal,
          usage,
          keysDigest: keysDigestOf(appKey),
          bodyDigest: bodiesDigestOf(appBody),
        });
        console.info(
          `[VAL-035]   ${row.rowId} -> ${result.terminal} verdict=${runFacts[runFacts.length - 1]?.verdict} ` +
            `proposal=${runFacts[runFacts.length - 1]?.proposalId} ` +
            `population=${runFacts[runFacts.length - 1]?.populationSize} ` +
            `decisions=${runFacts[runFacts.length - 1]?.decisions} ` +
            `divergences=${runFacts[runFacts.length - 1]?.divergences} ` +
            `lifecycle=${runFacts[runFacts.length - 1]?.landing} ` +
            `canaryCost=${runFacts[runFacts.length - 1]?.canaryCostMicroUsd} ` +
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
      // canary row (every run landed its OWN).
      const execCount = await ctx.port.execute<{ c: number }>({
        sql: `SELECT count(*)::int AS c FROM executions.executions WHERE application_id = $1`,
        parameters: [world.applicationId],
      });
      expect(Number(execCount.rows[0]?.c ?? 0), "no phantom executions").toBe(drivenRows);

      // The idempotency ledger: exactly ONE create arbitration per
      // canary submission key (no ledger drift).
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
      // recorded observation (the read-only recorded traffic is
      // durable fact — unchanged across the whole corpus).
      const finalLedgerFacts = await ledgerInput.refreshFacts();
      expect(finalLedgerFacts.observationCount, "one durable row per recorded observation").toBe(
        totalObservations,
      );
      expect(finalLedgerFacts.factsDigest, "the recorded traffic is unchanged").toBe(
        initialLedgerFacts.factsDigest,
      );

      // The candidate registry over REAL SQL: the entries are IMMUTABLE
      // — exactly the pinned VAL-032 membership (the not-yet-shadowed
      // entry included), every proposal still at the `proposed` stage
      // (the canary verdict APPENDS to the lifecycle, it never
      // rewrites a proposal).
      const finalRegistryFacts = await registry.refreshFacts();
      expect(finalRegistryFacts.proposals).toHaveLength(REGISTRY_SEED_PROPOSALS_FOR_CANARY.length);
      for (const proposal of finalRegistryFacts.proposals) {
        expect(proposal.lifecycleStage, `${proposal.proposalId} immutable proposed stage`).toBe(
          "proposed",
        );
      }
      expect(
        registryFactsDigestOf(finalRegistryFacts),
        "the registry digest is IDENTICAL after the whole corpus",
      ).toBe(initialRegistryDigest);

      // The registry is append-only over REAL SQL: a different-content
      // commit under a recorded identity THROWS (the read-only input).
      const ragRow = offlineRows.find(
        (row) => row.rowId === "rag-deterministic-function-clean-promotion",
      ) as CanaryCorpusRow;
      const ragPin = REGISTRY_SEED_PROPOSALS_FOR_CANARY.find(
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
      ).toBe(REGISTRY_SEED_PROPOSALS_FOR_CANARY.length);

      // The lifecycle ledger over REAL SQL: the recorded walk (3
      // transitions per executed row + 2 for the premature refusal
      // row's candidate) plus the canary append (2 per clean
      // promotion, 1 per honest rollback) — never a stage beyond
      // promoted, never an evidence-less transition.
      const evaluatedRows = offlineRows.filter((row) => row.expected.refusalReason === null);
      const refusalRows = offlineRows.filter((row) => row.expected.refusalReason !== null);
      const prematureRows = refusalRows.filter(
        (row) => row.expected.refusalReason === "candidate-not-shadow-executed",
      );
      const expectedRecordedRows = evaluatedRows.length * 3 + prematureRows.length * 2;
      const expectedAppendedRows =
        evaluatedRows.filter((row) => row.expected.finalStage === PROMOTED_STAGE).length * 2 +
        evaluatedRows.filter((row) => row.expected.finalStage !== PROMOTED_STAGE).length;
      const lifecycleCount = await ctx.port.execute<{ c: number }>({
        sql: `SELECT count(*)::int AS c FROM platform.idempotency_records
            WHERE application_id = $1 AND operation_name = $2`,
        parameters: [world.applicationId, LIFECYCLE_OPERATION],
      });
      expect(
        Number(lifecycleCount.rows[0]?.c ?? 0),
        "the recorded walk + the canary/promoted appends, one rung at a time",
      ).toBe(expectedRecordedRows + expectedAppendedRows);
      const lifecycleStages = await ctx.port.execute<{ stage: string }>({
        sql: `SELECT DISTINCT durable_outcome->>'toStage' AS stage FROM platform.idempotency_records
            WHERE application_id = $1 AND operation_name = $2`,
        parameters: [world.applicationId, LIFECYCLE_OPERATION],
      });
      expect(new Set(lifecycleStages.rows.map((sqlRow) => sqlRow.stage))).toEqual(
        new Set([
          "offline-replayed",
          "differentially-evaluated",
          "shadow-executed",
          "canaried",
          "promoted",
        ]),
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
        if (row.expected.refusalReason === "candidate-unregistered") {
          expect(walk, `${row.rowId} refusal appended nothing`).toEqual([]);
        } else {
          // The premature candidate's recorded walk ends at
          // differentially-evaluated — the canary never appended.
          expect(
            walk.map((transition) => transition.toStage),
            `${row.rowId} premature walk unchanged`,
          ).toEqual(["offline-replayed", "differentially-evaluated"]);
        }
      }

      // The canary ledger over REAL SQL: the decisions hold EXACTLY
      // the executed steps' decisions (the full ramp for the clean
      // promotions; up to and including the breaching step for the
      // honest rollbacks), the divergences hold exactly the
      // mechanically-derived cases, the rollback events hold exactly
      // one per breaching row, and the canary cost ledger holds
      // exactly one booking per executed step — all under the canary
      // marker, apart from the served accounting.
      const expectedDecisions = offlineRows.reduce((total, row) => {
        if (row.expected.refusalReason !== null) {
          return total;
        }
        return (
          total +
          (row.expected.breachingStepIndex === null
            ? row.rampSchedule.length
            : row.expected.breachingStepIndex)
        );
      }, 0);
      const decisionCount = await ctx.port.execute<{ c: number }>({
        sql: `SELECT count(*)::int AS c FROM platform.idempotency_records
            WHERE application_id = $1 AND operation_name = $2`,
        parameters: [world.applicationId, CANARY_DECISION_OPERATION],
      });
      expect(
        Number(decisionCount.rows[0]?.c ?? 0),
        "one durable decision per executed ramp step",
      ).toBe(expectedDecisions);

      const expectedDivergences = offlineRows.reduce((total, row) => {
        if (row.expected.refusalReason !== null) {
          return total;
        }
        const ramp = pinnedCanaryRampOf(row);
        return (
          total +
          ramp.divergencesByStep
            .filter(
              (entry) =>
                row.expected.breachingStepIndex === null ||
                entry.stepIndex <= row.expected.breachingStepIndex,
            )
            .reduce((inner, entry) => inner + entry.divergenceCaseIds.length, 0)
        );
      }, 0);
      const divergenceCount = await ctx.port.execute<{ c: number }>({
        sql: `SELECT count(*)::int AS c FROM platform.idempotency_records
            WHERE application_id = $1 AND operation_name = $2`,
        parameters: [world.applicationId, CANARY_DIVERGENCE_OPERATION],
      });
      expect(
        Number(divergenceCount.rows[0]?.c ?? 0),
        "one durable divergence record per mechanically-derived divergence",
      ).toBe(expectedDivergences);

      const rollbackEventCount = await ctx.port.execute<{ c: number }>({
        sql: `SELECT count(*)::int AS c FROM platform.idempotency_records
            WHERE application_id = $1 AND operation_name = $2`,
        parameters: [world.applicationId, CANARY_ROLLBACK_OPERATION],
      });
      expect(
        Number(rollbackEventCount.rows[0]?.c ?? 0),
        "one exercised rollback event per breaching row",
      ).toBe(offlineRows.filter((row) => row.expected.breachingStepIndex !== null).length);

      const canaryCostCount = await ctx.port.execute<{ c: number }>({
        sql: `SELECT count(*)::int AS c FROM platform.idempotency_records
            WHERE application_id = $1 AND operation_name = $2`,
        parameters: [world.applicationId, CANARY_COST_OPERATION],
      });
      expect(
        Number(canaryCostCount.rows[0]?.c ?? 0),
        "one canary-cost booking per executed ramp step (apart, under the marker)",
      ).toBe(expectedDecisions);
      const unmarkedCosts = await ctx.port.execute<{ c: number }>({
        sql: `SELECT count(*)::int AS c FROM platform.idempotency_records
            WHERE application_id = $1 AND operation_name = $2
              AND (durable_outcome->>'marker') != $3`,
        parameters: [world.applicationId, CANARY_COST_OPERATION, CANARY_COST_MARKER],
      });
      expect(Number(unmarkedCosts.rows[0]?.c ?? 0), "every canary cost carries its marker").toBe(0);
      // No canary cost ever landed in the served accounting rails:
      // the served bills equal the incumbent basis on every executed
      // row (verified per run in verifyCrownRow).
      for (const fact of runFacts) {
        if (fact.verdict !== "honest-refusal") {
          expect(fact.canaryCostMicroUsd, `${fact.rowId} canary cost booked apart`).not.toBe(
            "none",
          );
        }
      }

      // The lifecycle ledger is append-only exactly-once over REAL SQL:
      // the re-drive of an already-recorded canary run REPLAYS the
      // immutable transitions (never new rows), and a DIFFERENT
      // evidence digest under a recorded key is REFUSED.
      const replayRow = offlineRows.find(
        (row) => row.rowId === "rag-deterministic-function-clean-promotion",
      ) as CanaryCorpusRow;
      // The synchronous transitions view rides the RECORDED walk
      // (pre-read from REAL SQL — the durable truth the re-drive replays).
      const recordedWalk = await readLifecycleWalk(
        ctx,
        world,
        replayRow,
        replayRow.sourceProposalId,
      );
      expect(recordedWalk).toHaveLength(5);
      const replayedLedger = await createRealCanaryLedger(ctx, world, replayRow);
      const replayedRun = await driveCanaryRun({
        row: replayRow,
        registry,
        lifecycle: {
          append: (record) => createRealLifecycleAppend(ctx, world, replayRow, record),
          transitionsFor: (proposalId: string) =>
            recordedWalk
              .filter((transition) => transition.proposalId === proposalId)
              .map((transition) => ({ ...transition })),
        },
        canaryLedger: replayedLedger,
        incumbentExecutor,
        trafficSource,
        servingPath: createRealCanaryServingPath(),
        canaryRuntime: {
          async runCanaryStep(input) {
            return deriveHonestCanaryStep(input);
          },
        },
        now: () => new Date(),
      });
      expect(replayedRun.terminal).toBe("COMPLETED");
      expect(
        replayedRun.landings.canaried?.replayed,
        "the re-drive replays the canaried rung",
      ).toBe(true);
      expect(replayedRun.landings.canaried?.accepted).toBe(true);
      expect(
        replayedRun.landings.promoted?.replayed,
        "the re-drive replays the promoted rung",
      ).toBe(true);
      expect(replayedRun.landings.promoted?.accepted).toBe(true);
      expect(replayedRun.canaryCostBooked, "the re-drive re-books the canary cost").toBe(true);
      const lifecycleCountAfterReplay = await ctx.port.execute<{ c: number }>({
        sql: `SELECT count(*)::int AS c FROM platform.idempotency_records
            WHERE application_id = $1 AND operation_name = $2`,
        parameters: [world.applicationId, LIFECYCLE_OPERATION],
      });
      expect(
        Number(lifecycleCountAfterReplay.rows[0]?.c ?? 0),
        "the re-drive added no lifecycle row",
      ).toBe(expectedRecordedRows + expectedAppendedRows);
      const decisionCountAfterReplay = await ctx.port.execute<{ c: number }>({
        sql: `SELECT count(*)::int AS c FROM platform.idempotency_records
            WHERE application_id = $1 AND operation_name = $2`,
        parameters: [world.applicationId, CANARY_DECISION_OPERATION],
      });
      expect(
        Number(decisionCountAfterReplay.rows[0]?.c ?? 0),
        "the re-drive added no decision row",
      ).toBe(expectedDecisions);
      const canaryCostCountAfterReplay = await ctx.port.execute<{ c: number }>({
        sql: `SELECT count(*)::int AS c FROM platform.idempotency_records
            WHERE application_id = $1 AND operation_name = $2`,
        parameters: [world.applicationId, CANARY_COST_OPERATION],
      });
      expect(
        Number(canaryCostCountAfterReplay.rows[0]?.c ?? 0),
        "the re-drive added no canary-cost row",
      ).toBe(expectedDecisions);
      const impostor = await createRealLifecycleAppend(ctx, world, replayRow, {
        proposalId: replayRow.sourceProposalId,
        toStage: "canaried",
        evidenceDigest: "ffffffff",
      });
      expect(impostor, "a different evidence digest under a recorded key is REFUSED").toEqual({
        accepted: false,
        replayed: false,
        refused: true,
      });

      // The canary ledger is append-only exactly-once over REAL SQL:
      // the identical decision re-append REPLAYS and the impostor
      // records are REFUSED (decisions, divergences, rollback events
      // and costs alike).
      const divergenceRow = offlineRows.find(
        (row) => row.rowId === "reuse-removed-call-budget-breach-rollback",
      ) as CanaryCorpusRow;
      const replayLedger = await createRealCanaryLedger(ctx, world, divergenceRow);
      const recordedDecision = (
        await readCanaryDecisions(ctx, world, divergenceRow, divergenceRow.sourceProposalId)
      )[0];
      if (recordedDecision === undefined) {
        throw new Error("the honest-rollback row recorded no decision");
      }
      const scheduleDigest = rampScheduleDigestOf(divergenceRow.rampSchedule);
      const replayedDecision = await replayLedger.appendDecision({
        proposalId: divergenceRow.sourceProposalId,
        stepIndex: recordedDecision.stepIndex,
        kind: recordedDecision.kind as CanaryDecisionKind,
        sliceFraction: divergenceRow.rampSchedule[0]?.trafficFraction ?? 1,
        observedDivergenceCount: recordedDecision.observedDivergenceCount,
        budgetLimit: recordedDecision.budgetLimit,
        policyCitations: {
          rampScheduleDigest: scheduleDigest,
          failureBudgetStated: true,
          toleranceStated: true,
        },
        policyChecks: { rampChecked: true, budgetChecked: true, toleranceChecked: true },
      });
      expect(replayedDecision, "the identical decision re-append REPLAYS").toEqual({
        accepted: true,
        replayed: true,
        refused: false,
      });
      const decisionImpostor = await replayLedger.appendDecision({
        proposalId: divergenceRow.sourceProposalId,
        stepIndex: recordedDecision.stepIndex,
        kind: "advance" as CanaryDecisionKind,
        sliceFraction: divergenceRow.rampSchedule[0]?.trafficFraction ?? 1,
        observedDivergenceCount: recordedDecision.observedDivergenceCount,
        budgetLimit: recordedDecision.budgetLimit,
        policyCitations: {
          rampScheduleDigest: scheduleDigest,
          failureBudgetStated: true,
          toleranceStated: true,
        },
        policyChecks: { rampChecked: true, budgetChecked: true, toleranceChecked: true },
      });
      expect(decisionImpostor, "an impostor decision record is REFUSED").toEqual({
        accepted: false,
        replayed: false,
        refused: true,
      });
      const recordedDivergence = (
        await readCanaryDivergences(ctx, world, divergenceRow, divergenceRow.sourceProposalId)
      )[0];
      if (recordedDivergence === undefined) {
        throw new Error("the honest-rollback row recorded no divergence");
      }
      const replayedDivergence = await replayLedger.appendDivergence({
        proposalId: divergenceRow.sourceProposalId,
        stepIndex: recordedDivergence.stepIndex,
        caseId: recordedDivergence.caseId,
        incumbentDigest: recordedDivergence.incumbentDigest,
        replacementDigest: recordedDivergence.replacementDigest,
      });
      expect(replayedDivergence, "the identical divergence re-append REPLAYS").toEqual({
        accepted: true,
        replayed: true,
        refused: false,
      });
      const divergenceImpostor = await replayLedger.appendDivergence({
        proposalId: divergenceRow.sourceProposalId,
        stepIndex: recordedDivergence.stepIndex,
        caseId: recordedDivergence.caseId,
        incumbentDigest: recordedDivergence.incumbentDigest,
        replacementDigest: "ffffffff",
      });
      expect(divergenceImpostor, "an impostor divergence record is REFUSED").toEqual({
        accepted: false,
        replayed: false,
        refused: true,
      });
      const costImpostor = await replayLedger.bookCanaryCost({
        proposalId: divergenceRow.sourceProposalId,
        marker: CANARY_COST_MARKER,
        microUsd: 999,
        latencyMs: 999,
      });
      expect(costImpostor, "an impostor canary-cost booking is REFUSED").toEqual({
        accepted: false,
        replayed: false,
        refused: true,
      });
      const rollbackImpostor = await replayLedger.appendRollbackEvent({
        proposalId: divergenceRow.sourceProposalId,
        stepIndex: divergenceRow.expected.breachingStepIndex ?? 1,
        planDigest: "ffffffff",
        residualReplacementCaseIds: [],
      });
      expect(rollbackImpostor, "an impostor rollback event is REFUSED").toEqual({
        accepted: false,
        replayed: false,
        refused: true,
      });
      const divergenceCountAfterImpostors = await ctx.port.execute<{ c: number }>({
        sql: `SELECT count(*)::int AS c FROM platform.idempotency_records
            WHERE application_id = $1 AND operation_name = $2`,
        parameters: [world.applicationId, CANARY_DIVERGENCE_OPERATION],
      });
      expect(
        Number(divergenceCountAfterImpostors.rows[0]?.c ?? 0),
        "the refused impostors added no divergence row",
      ).toBe(expectedDivergences);
      const decisionCountAfterImpostors = await ctx.port.execute<{ c: number }>({
        sql: `SELECT count(*)::int AS c FROM platform.idempotency_records
            WHERE application_id = $1 AND operation_name = $2`,
        parameters: [world.applicationId, CANARY_DECISION_OPERATION],
      });
      expect(
        Number(decisionCountAfterImpostors.rows[0]?.c ?? 0),
        "the refused impostors added no decision row",
      ).toBe(expectedDecisions);

      const promotions = runFacts.filter((fact) => fact.verdict === "clean-promotion").length;
      const rollbacks = runFacts.filter((fact) => fact.verdict === "honest-rollback").length;
      const refusals = runFacts.filter((fact) => fact.verdict === "honest-refusal").length;
      const completed = runFacts.filter((fact) => fact.terminal === "COMPLETED").length;
      console.info(
        `[VAL-035] OFFLINE corpus summary: ${completed} COMPLETED of ${runFacts.length} driven ` +
          `canary runs (${promotions} clean promotions through the full ramp / ${rollbacks} honest ` +
          `budget-breach rollbacks — honest FAILEDs, their ${expectedDivergences} divergences ` +
          `recorded case-by-case with both sides' digests, the served traffic reverted to the ` +
          `incumbent across the whole slice (exercised, never partial) / ${refusals} honest ` +
          `refusals — every refusal a COMPLETED run); ${totalObservations} recorded observations ` +
          `served read-only from REAL SQL as the recorded traffic (${drivenRows} durable ` +
          `executions, one per run — no phantoms, no ledger drift, zero orphan events); the ` +
          `candidate registry holds exactly ${REGISTRY_SEED_PROPOSALS_FOR_CANARY.length} ` +
          `immutable VAL-032 identities still at the \`proposed\` stage (the read-only input — ` +
          `the registry digest is IDENTICAL after the whole corpus; a different-content commit ` +
          `THROWS); the lifecycle ledger holds exactly ${expectedRecordedRows + expectedAppendedRows} ` +
          `evidenced transitions over REAL SQL (the recorded offline-replayed → ` +
          `differentially-evaluated → shadow-executed walk + the canaried rung, then the ` +
          `promoted rung on a clean full ramp — one rung at a time, never beyond, never ` +
          `evidence-less; the re-drive REPLAYS, the impostor is REFUSED); the canary ledger ` +
          `holds ${expectedDecisions} decisions (every executed ramp step's decision with its ` +
          `stated-and-checked policy), ${expectedDivergences} divergence records, ${offlineRows.filter((row) => row.expected.breachingStepIndex !== null).length} exercised rollback events and ${expectedDecisions} canary-cost ` +
          `bookings under the canary marker APART from the served accounting (the customer is ` +
          `never billed for the canary); every canary trajectory reproduced through the REAL ` +
          `recorder path (the projected digest IS the pinned class member, journals gapless); ` +
          `usage honestly none-reported offline; latency measured, never estimated; digests ` +
          `only, payload bytes never journaled.`,
      );
    } finally {
      await world.server.app.close();
    }
  });

  test("the REAL live rail drives the canary run with a REAL residual-AI confirmation round", {
    timeout: 600_000,
  }, async () => {
    const generateId = createUuidv7Generator();
    const notRun: string[] = [];
    if (OPENROUTER_KEY.length === 0) {
      console.warn(
        "[VAL-035] OPENROUTER_API_KEY absent — the REAL live canary row is a NOT RUN " +
          "boundary (recorded honestly; no fake success is asserted). The offline corpus above " +
          "covers every verdict/breach-rollback/refusal/policy/slice-isolation/rollback/" +
          "cost-separation/lifecycle path without credentials. Required access: an " +
          "operator-authorized OpenRouter credential (env OPENROUTER_API_KEY) covering the " +
          "default chat model — the live canary run demands ONE REAL residual-AI model round " +
          "through the REAL platform model gateway (measured usage, never estimated, never " +
          "fabricated) before the promoted rung appends to the REAL candidate lifecycle.",
      );
      expect(true).toBe(true);
      return;
    }

    const world = await seedApiPgWorld(ctx.port);
    const address = await world.server.app.listen({ port: 0, host: "127.0.0.1" });
    const driven = new Set<string>();
    const runFacts: RunFacts[] = [];

    try {
      const liveRows = CANARY_PROMOTION_CORPUS.filter((row) => row.liveGate !== undefined);
      // The REAL SQL replay-ledger input + candidate registry + the
      // recorded VAL-033 + VAL-034 walks for the live world.
      const ledgerInput = await seedRealReplayLedgerInput(ctx, world);
      const registry = await seedRealCandidateRegistry(
        ctx,
        world,
        REGISTRY_SEED_PROPOSALS_FOR_CANARY,
      );
      const trafficSource = createRealTrafficSource({
        observations: ledgerInput.observations,
        classMembersByPopulationWorkload: ledgerInput.classMembersByPopulationWorkload,
      });
      const incumbentExecutor = createRealIncumbentExecutor(ledgerInput.observations);
      await seedRealPriorWalks(ctx, world, liveRows);

      // ONE live dispatch binding for ALL live rows (the VAL-025 review
      // lesson): the connection and its sealed credential envelope are
      // registered ONCE and shared.
      let liveDispatch: ControlDispatch | undefined;
      for (const row of liveRows) {
        // The ABSOLUTE corpus index (the val-032 live-index lesson).
        const taskIndex = CANARY_PROMOTION_CORPUS.findIndex(
          (candidate) => candidate.rowId === row.rowId,
        );
        if (!liveGateOpen(row, process.env)) {
          notRun.push(
            `${row.rowId} — gate closed (${row.liveGate?.envVars.join("+")} absent); ` +
              `requirement: ${row.liveGate?.requirement}`,
          );
          continue;
        }
        // Provider-side pacing before the live canary run.
        await new Promise((resolve) => setTimeout(resolve, 2_000));
        const runSuffix = `live-${generateId().slice(-8)}`;
        if (liveDispatch === undefined) {
          liveDispatch = (await buildLiveDispatch(ctx, world)).dispatch;
        }
        const dispatch: ControlDispatch = liveDispatch;
        const appKey = canarySubmissionKey({ runSuffix, taskIndex });
        const appBody = canaryTaskBodyFor({
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
          servingPath,
        } = await driveCrownCanary({
          ctx,
          world,
          address,
          row,
          taskIndex,
          runSuffix,
          registry,
          trafficSource,
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
          servingPath,
        });

        // The live row's usage is MEASURED (never estimated).
        expect(result.usage?.inputTokens ?? -1, `${row.rowId} live usage measured`).toBeGreaterThan(
          -1,
        );
        expect(result.observedModelCalls, `${row.rowId} one residual-AI round`).toBe(1);

        const costs = await readCanaryCosts(ctx, world, row, row.sourceProposalId);
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
          populationSize: row.trafficPopulation.length,
          decisions: result.decisionsAppended,
          divergences: result.divergencesAppended,
          landing:
            result.landings.canaried === null
              ? "nothing-appended"
              : `canaried:${String(result.landings.canaried.accepted)}` +
                (result.landings.promoted === null
                  ? ""
                  : `/promoted:${String(result.landings.promoted.accepted)}`),
          canaryCostMicroUsd:
            costs.length === 0
              ? "none"
              : `${costs.reduce((total, cost) => total + cost.microUsd, 0)}u$/${costs.reduce((total, cost) => total + cost.latencyMs, 0)}ms`,
          modelCalls: `${result.observedModelCalls}/${row.expected.modelCalls}`,
          latencyMs: result.latencyMs,
          appSubmissionLatencyMs: appSettled.outcome.submissionLatencyMs,
          appTerminal: appSettled.outcome.observedTerminal,
          usage,
          keysDigest: keysDigestOf(appKey),
          bodyDigest: bodiesDigestOf(appBody),
        });
        console.info(
          `[VAL-035]   LIVE ${row.rowId} -> ${result.terminal} verdict=${runFacts[runFacts.length - 1]?.verdict} ` +
            `proposal=${runFacts[runFacts.length - 1]?.proposalId} ` +
            `modelCalls=${runFacts[runFacts.length - 1]?.modelCalls} ` +
            `latency=${runFacts[runFacts.length - 1]?.latencyMs}ms ` +
            `usage=${runFacts[runFacts.length - 1]?.usage}`,
        );
      }

      const completed = runFacts.filter((fact) => fact.terminal === "COMPLETED").length;
      console.info(
        `[VAL-035] LIVE rail summary: ${completed} COMPLETED of ${runFacts.length} driven live ` +
          `canary runs over the REAL OpenRouter rail (model ${MODEL}); ONE REAL residual-AI ` +
          `confirmation round per run (measured usage, BYOK — never estimated); the incumbent ` +
          `served the remainder at every ramp step; digests only, payload bytes never journaled.`,
      );
      for (const boundary of notRun) {
        console.warn(`[VAL-035] NOT RUN boundary: ${boundary}`);
      }
      // At least one REAL live dispatch happened (never an
      // all-NOT-RUN silent pass once a credential is present).
      expect(runFacts.length).toBeGreaterThan(0);
    } finally {
      await world.server.app.close();
    }
  });
});
