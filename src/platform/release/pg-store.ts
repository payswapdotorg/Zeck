/**
 * The durable release-control store (platform release plane;
 * WORK-047, D-06) over the provider-neutral platform `DatabasePort`.
 *
 * THE ONLY writer of the release ledger (schema `release_control`,
 * migration 0029). The physical immutability (append-only evidence,
 * immutable attribution, never-deleted pointers) is enforced by the
 * migration's triggers; the GOVERNED transitions (gate-sufficient
 * activation, journal-linked promotion, safe rollback) are enforced
 * here, inside one transaction each.
 *
 * ROLLBACK SAFETY BY CONSTRUCTION: every statement in this file
 * addresses the release_control schema exclusively. A rollback
 * appends its event and flips the active pointer — it cannot touch
 * durable execution/business authority because it has no statement
 * that could (pinned by the isolation tests and by the architecture
 * suite).
 *
 * No driver import: `pg` is owned by `src/platform/db/` (the SDK
 * boundary). Every payload is bounded and reference-only (ids,
 * digests, bounded reasons) — secret material is unrepresentable in
 * this store's vocabulary.
 */

import type { DatabasePort } from "../db/port";
import {
  type ActiveDeploymentRecord,
  type EnvironmentDeploymentRecord,
  type GateResultRecord,
  type GateStatus,
  type HostingEnvironment,
  isHostingEnvironment,
  isReleasePhase,
  type PromotionDecision,
  type PromotionDecisionRecord,
  ReleaseControlError,
  type ReleaseControlStore,
  type ReleaseInspection,
  type ReleasePhase,
  type ReleaseRecord,
  type ReleaseRefusal,
  type RollbackRecord,
  releaseIdentityId,
  validateReleaseIdentityInputs,
} from "./port";

export interface SqlReleaseControlStoreDeps {
  readonly db: DatabasePort;
  readonly now: () => Date;
  readonly generateId: () => string;
}

interface ReleaseRow {
  readonly release_id: string;
  readonly git_revision: string;
  readonly manifest_digest: string;
  readonly recorded_at: Date | string;
  readonly recorded_by: string;
}

interface EnvironmentDeploymentRow {
  readonly release_id: string;
  readonly environment: string;
  readonly deployment_identity_id: string;
  readonly resource_digest: string;
  readonly recorded_at: Date | string;
  readonly recorded_by: string;
}

interface GateRow {
  readonly release_id: string;
  readonly environment: string;
  readonly gate_kind: string;
  readonly attempt: number;
  readonly status: string;
  readonly evidence_digest: string;
  readonly evidence_detail: string;
  readonly source: string;
  readonly recorded_at: Date | string;
  readonly recorded_by: string;
}

interface PromotionRow {
  readonly id: string;
  readonly release_id: string;
  readonly from_phase: string;
  readonly to_phase: string;
  readonly decision: string;
  readonly reason: string;
  readonly actor: string;
  readonly decided_at: Date | string;
}

interface RollbackRow {
  readonly id: string;
  readonly environment: string;
  readonly from_release_id: string;
  readonly to_release_id: string;
  readonly reason: string;
  readonly actor: string;
  readonly recorded_at: Date | string;
}

interface ActiveDeploymentRow {
  readonly environment: string;
  readonly release_id: string;
  readonly deployment_identity_id: string;
  readonly activated_at: Date | string;
  readonly activated_by: string;
}

const iso = (value: Date | string): string =>
  value instanceof Date ? value.toISOString() : new Date(value).toISOString();

const toRelease = (row: ReleaseRow): ReleaseRecord => ({
  releaseId: row.release_id,
  gitRevision: row.git_revision,
  manifestDigest: row.manifest_digest,
  recordedAt: iso(row.recorded_at),
  recordedBy: row.recorded_by,
});

const toEnvironmentDeployment = (row: EnvironmentDeploymentRow): EnvironmentDeploymentRecord => ({
  releaseId: row.release_id,
  environment: row.environment as HostingEnvironment,
  deploymentIdentityId: row.deployment_identity_id,
  resourceDigest: row.resource_digest,
  recordedAt: iso(row.recorded_at),
  recordedBy: row.recorded_by,
});

const toGate = (row: GateRow): GateResultRecord => ({
  releaseId: row.release_id,
  environment: row.environment as ReleasePhase,
  gateKind: row.gate_kind,
  attempt: row.attempt,
  status: row.status as GateStatus,
  evidenceDigest: row.evidence_digest,
  evidenceDetail: row.evidence_detail,
  source: row.source as GateResultRecord["source"],
  recordedAt: iso(row.recorded_at),
  recordedBy: row.recorded_by,
});

const toPromotion = (row: PromotionRow): PromotionDecisionRecord => ({
  id: row.id,
  releaseId: row.release_id,
  fromPhase: row.from_phase as PromotionDecisionRecord["fromPhase"],
  toPhase: row.to_phase as ReleasePhase,
  decision: row.decision as PromotionDecision,
  reason: row.reason,
  actor: row.actor,
  decidedAt: iso(row.decided_at),
});

const toRollback = (row: RollbackRow): RollbackRecord => ({
  id: row.id,
  environment: row.environment as HostingEnvironment,
  fromReleaseId: row.from_release_id,
  toReleaseId: row.to_release_id,
  reason: row.reason,
  actor: row.actor,
  recordedAt: iso(row.recorded_at),
});

const toActive = (row: ActiveDeploymentRow): ActiveDeploymentRecord => ({
  environment: row.environment as HostingEnvironment,
  releaseId: row.release_id,
  deploymentIdentityId: row.deployment_identity_id,
  activatedAt: iso(row.activated_at),
  activatedBy: row.activated_by,
});

function refuse(refusal: ReleaseRefusal): never {
  throw new ReleaseControlError(refusal);
}

/** The SQL release-control ledger. */
export class SqlReleaseControlStore implements ReleaseControlStore {
  private readonly db: DatabasePort;
  private readonly now: () => Date;
  private readonly generateId: () => string;

  constructor(deps: SqlReleaseControlStoreDeps) {
    this.db = deps.db;
    this.now = deps.now;
    this.generateId = deps.generateId;
  }

  async recordRelease(input: {
    readonly gitRevision: string;
    readonly manifestDigest: string;
    readonly actor: string;
  }): Promise<ReleaseRecord> {
    const validation = validateReleaseIdentityInputs(input.gitRevision, input.manifestDigest);
    if (!validation.valid) {
      refuse({
        kind: "invalid-revision",
        message: validation.message ?? "invalid release identity",
      });
    }
    const releaseId = releaseIdentityId(input.gitRevision, input.manifestDigest);
    const now = this.now().toISOString();
    await this.db.execute({
      sql: `INSERT INTO release_control.releases
(release_id, git_revision, manifest_digest, recorded_at, recorded_by)
VALUES ($1, $2, $3, $4, $5)
ON CONFLICT (release_id) DO NOTHING`,
      parameters: [releaseId, input.gitRevision, input.manifestDigest, now, input.actor],
    });
    const found = await this.db.execute<ReleaseRow>({
      sql: `SELECT * FROM release_control.releases WHERE release_id = $1`,
      parameters: [releaseId],
    });
    if (found.rows.length === 0) {
      refuse({ kind: "unknown-release", message: `release ${releaseId} vanished after recording` });
    }
    return toRelease(found.rows[0] as ReleaseRow);
  }

  async recordEnvironmentDeployment(input: {
    readonly releaseId: string;
    readonly environment: HostingEnvironment;
    readonly deploymentIdentityId: string;
    readonly resourceDigest: string;
    readonly actor: string;
  }): Promise<EnvironmentDeploymentRecord> {
    if (!isHostingEnvironment(input.environment)) {
      refuse({
        kind: "not-deployed",
        message: `environment deployments bind hosting environments only (got: "${input.environment}")`,
      });
    }
    return this.db.transaction(async (tx) => {
      const existing = await tx.execute<EnvironmentDeploymentRow>({
        sql: `SELECT * FROM release_control.environment_deployments
WHERE release_id = $1 AND environment = $2`,
        parameters: [input.releaseId, input.environment],
      });
      const now = this.now().toISOString();
      if (existing.rows.length > 0) {
        const prior = toEnvironmentDeployment(existing.rows[0] as EnvironmentDeploymentRow);
        if (prior.deploymentIdentityId !== input.deploymentIdentityId) {
          refuse({
            kind: "identity-mismatch",
            message: `release ${input.releaseId} already binds environment ${input.environment} to deployment identity ${prior.deploymentIdentityId}; the binding is immutable (got: ${input.deploymentIdentityId})`,
          });
        }
        return prior;
      }
      await tx.execute({
        sql: `INSERT INTO release_control.environment_deployments
(release_id, environment, deployment_identity_id, resource_digest, recorded_at, recorded_by)
VALUES ($1, $2, $3, $4, $5, $6)`,
        parameters: [
          input.releaseId,
          input.environment,
          input.deploymentIdentityId,
          input.resourceDigest,
          now,
          input.actor,
        ],
      });
      return {
        releaseId: input.releaseId,
        environment: input.environment,
        deploymentIdentityId: input.deploymentIdentityId,
        resourceDigest: input.resourceDigest,
        recordedAt: now,
        recordedBy: input.actor,
      } satisfies EnvironmentDeploymentRecord;
    });
  }

  async recordGateResult(input: {
    readonly releaseId: string;
    readonly environment: ReleasePhase;
    readonly gateKind: string;
    readonly status: GateStatus;
    readonly evidenceDigest: string;
    readonly evidenceDetail: string;
    readonly source: GateResultRecord["source"];
    readonly actor: string;
  }): Promise<GateResultRecord> {
    if (!isReleasePhase(input.environment)) {
      refuse({
        kind: "not-deployed",
        message: `gate evidence applies to ladder phases only (got: "${input.environment}")`,
      });
    }
    if (input.evidenceDetail.length > 4096) {
      refuse({
        kind: "not-deployed",
        message: `gate evidence detail exceeds the 4096-character bound (${input.evidenceDetail.length})`,
      });
    }
    return this.db.transaction(async (tx) => {
      const exists = await tx.execute<{ readonly count: string }>({
        sql: `SELECT count(*) AS count FROM release_control.releases WHERE release_id = $1`,
        parameters: [input.releaseId],
      });
      if (Number(exists.rows[0]?.count ?? 0) === 0) {
        refuse({
          kind: "unknown-release",
          message: `gate evidence requires the release ${input.releaseId} to be recorded first`,
        });
      }
      const prior = await tx.execute<{ readonly max: number | string | null }>({
        sql: `SELECT max(attempt) AS max FROM release_control.gate_results
WHERE release_id = $1 AND environment = $2 AND gate_kind = $3`,
        parameters: [input.releaseId, input.environment, input.gateKind],
      });
      const attempt = Number((prior.rows[0]?.max ?? 0) || 0) + 1;
      const now = this.now().toISOString();
      await tx.execute({
        sql: `INSERT INTO release_control.gate_results
(release_id, environment, gate_kind, attempt, status, evidence_digest, evidence_detail, source, recorded_at, recorded_by)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        parameters: [
          input.releaseId,
          input.environment,
          input.gateKind,
          attempt,
          input.status,
          input.evidenceDigest,
          input.evidenceDetail,
          input.source,
          now,
          input.actor,
        ],
      });
      return {
        releaseId: input.releaseId,
        environment: input.environment,
        gateKind: input.gateKind,
        attempt,
        status: input.status,
        evidenceDigest: input.evidenceDigest,
        evidenceDetail: input.evidenceDetail,
        source: input.source,
        recordedAt: now,
        recordedBy: input.actor,
      } satisfies GateResultRecord;
    });
  }

  async effectiveGateResults(
    releaseId: string,
    environment: ReleasePhase,
  ): Promise<readonly GateResultRecord[]> {
    const result = await this.db.execute<GateRow>({
      sql: `SELECT g.* FROM release_control.gate_results g
JOIN (
    SELECT release_id, environment, gate_kind, max(attempt) AS attempt
    FROM release_control.gate_results
    WHERE release_id = $1 AND environment = $2
    GROUP BY release_id, environment, gate_kind
) latest ON latest.release_id = g.release_id
    AND latest.environment = g.environment
    AND latest.gate_kind = g.gate_kind
    AND latest.attempt = g.attempt
WHERE g.release_id = $1 AND g.environment = $2
ORDER BY g.gate_kind`,
      parameters: [releaseId, environment],
    });
    return result.rows.map(toGate);
  }

  async recordPromotionDecision(input: {
    readonly releaseId: string;
    readonly fromPhase: PromotionDecisionRecord["fromPhase"];
    readonly toPhase: ReleasePhase;
    readonly decision: PromotionDecision;
    readonly reason: string;
    readonly actor: string;
  }): Promise<PromotionDecisionRecord> {
    const id = `promotion-${this.generateId()}`;
    const now = this.now().toISOString();
    await this.db.execute({
      sql: `INSERT INTO release_control.promotions
(id, release_id, from_phase, to_phase, decision, reason, actor, decided_at)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      parameters: [
        id,
        input.releaseId,
        input.fromPhase,
        input.toPhase,
        input.decision,
        input.reason,
        input.actor,
        now,
      ],
    });
    return {
      id,
      releaseId: input.releaseId,
      fromPhase: input.fromPhase,
      toPhase: input.toPhase,
      decision: input.decision,
      reason: input.reason,
      actor: input.actor,
      decidedAt: now,
    };
  }

  async activate(input: {
    readonly environment: HostingEnvironment;
    readonly releaseId: string;
    readonly requiredGates: readonly string[];
    readonly actor: string;
  }): Promise<ActiveDeploymentRecord> {
    return this.db.transaction(async (tx) => {
      const now = this.now().toISOString();
      // 1. The release must exist (the exact-commit attribution).
      const release = await tx.execute<ReleaseRow>({
        sql: `SELECT * FROM release_control.releases WHERE release_id = $1`,
        parameters: [input.releaseId],
      });
      if (release.rows.length === 0) {
        refuse({
          kind: "unknown-release",
          message: `activation requires a recorded release (unknown: ${input.releaseId})`,
        });
      }
      // 2. The environment deployment identity must be bound.
      const deployment = await tx.execute<EnvironmentDeploymentRow>({
        sql: `SELECT * FROM release_control.environment_deployments
WHERE release_id = $1 AND environment = $2`,
        parameters: [input.releaseId, input.environment],
      });
      if (deployment.rows.length === 0) {
        refuse({
          kind: "not-deployed",
          message: `activation requires the environment deployment binding for ${input.environment} (release ${input.releaseId})`,
        });
      }
      const deploymentRow = toEnvironmentDeployment(deployment.rows[0] as EnvironmentDeploymentRow);
      // 3. The required gates must have PASSED (latest attempt each).
      await this.assertGatesPassed(tx, input.releaseId, input.environment, input.requiredGates);
      // 4. The promotion journal must carry the `promoted` decision
      //    for this phase (the pointer never moves without it).
      const journal = await tx.execute<{ readonly count: string }>({
        sql: `SELECT count(*) AS count FROM release_control.promotions
WHERE release_id = $1 AND to_phase = $2 AND decision = 'promoted'`,
        parameters: [input.releaseId, input.environment],
      });
      if (Number(journal.rows[0]?.count ?? 0) === 0) {
        refuse({
          kind: "no-journal-entry",
          message: `activation of ${input.environment} requires a recorded 'promoted' decision for release ${input.releaseId} (the governed promotion path)`,
        });
      }
      // 5. Flip the pointer (the single governed write).
      await tx.execute({
        sql: `INSERT INTO release_control.active_deployments
(environment, release_id, deployment_identity_id, activated_at, activated_by)
VALUES ($1, $2, $3, $4, $5)
ON CONFLICT (environment) DO UPDATE
SET release_id = $2, deployment_identity_id = $3, activated_at = $4, activated_by = $5`,
        parameters: [
          input.environment,
          input.releaseId,
          deploymentRow.deploymentIdentityId,
          now,
          input.actor,
        ],
      });
      return {
        environment: input.environment,
        releaseId: input.releaseId,
        deploymentIdentityId: deploymentRow.deploymentIdentityId,
        activatedAt: now,
        activatedBy: input.actor,
      } satisfies ActiveDeploymentRecord;
    });
  }

  async rollback(input: {
    readonly environment: HostingEnvironment;
    readonly toReleaseId: string;
    readonly requiredGates: readonly string[];
    readonly reason: string;
    readonly actor: string;
  }): Promise<ActiveDeploymentRecord> {
    return this.db.transaction(async (tx) => {
      const now = this.now().toISOString();
      // 1. There must be an active deployment to roll back FROM.
      const current = await tx.execute<ActiveDeploymentRow>({
        sql: `SELECT * FROM release_control.active_deployments WHERE environment = $1`,
        parameters: [input.environment],
      });
      if (current.rows.length === 0) {
        refuse({
          kind: "no-active-deployment",
          message: `rollback of ${input.environment} requires an active deployment (none recorded)`,
        });
      }
      const currentRow = toActive(current.rows[0] as ActiveDeploymentRow);
      if (currentRow.releaseId === input.toReleaseId) {
        refuse({
          kind: "same-release",
          message: `rollback of ${input.environment} requires a target release other than the active one (${input.toReleaseId})`,
        });
      }
      // 2. The target must be a DEPLOYED, gate-passed release of this
      //    environment — rollback never activates unproven state.
      const target = await tx.execute<EnvironmentDeploymentRow>({
        sql: `SELECT * FROM release_control.environment_deployments
WHERE release_id = $1 AND environment = $2`,
        parameters: [input.toReleaseId, input.environment],
      });
      if (target.rows.length === 0) {
        refuse({
          kind: "not-deployed",
          message: `rollback target ${input.toReleaseId} has no environment deployment binding for ${input.environment}`,
        });
      }
      const targetRow = toEnvironmentDeployment(target.rows[0] as EnvironmentDeploymentRow);
      await this.assertGatesPassed(tx, input.toReleaseId, input.environment, input.requiredGates);
      // 3. The rollback event (append-only) + the pointer flip — one
      //    transaction, release_control only.
      const id = `rollback-${this.generateId()}`;
      await tx.execute({
        sql: `INSERT INTO release_control.rollbacks
(id, environment, from_release_id, to_release_id, reason, actor, recorded_at)
VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        parameters: [
          id,
          input.environment,
          currentRow.releaseId,
          input.toReleaseId,
          input.reason,
          input.actor,
          now,
        ],
      });
      await tx.execute({
        sql: `UPDATE release_control.active_deployments
SET release_id = $2, deployment_identity_id = $3, activated_at = $4, activated_by = $5
WHERE environment = $1`,
        parameters: [
          input.environment,
          input.toReleaseId,
          targetRow.deploymentIdentityId,
          now,
          input.actor,
        ],
      });
      return {
        environment: input.environment,
        releaseId: input.toReleaseId,
        deploymentIdentityId: targetRow.deploymentIdentityId,
        activatedAt: now,
        activatedBy: input.actor,
      } satisfies ActiveDeploymentRecord;
    });
  }

  async activeDeployment(environment: HostingEnvironment): Promise<ActiveDeploymentRecord | null> {
    const result = await this.db.execute<ActiveDeploymentRow>({
      sql: `SELECT * FROM release_control.active_deployments WHERE environment = $1`,
      parameters: [environment],
    });
    return result.rows.length === 0 ? null : toActive(result.rows[0] as ActiveDeploymentRow);
  }

  async inspect(_environment?: HostingEnvironment): Promise<ReleaseInspection> {
    const releases = await this.db.execute<ReleaseRow>({
      sql: `SELECT * FROM release_control.releases ORDER BY recorded_at, release_id`,
    });
    if (releases.rows.length === 0) {
      return {
        release: null,
        environmentDeployments: [],
        effectiveGates: [],
        promotions: [],
        rollbacks: [],
        activeDeployments: [],
      };
    }
    const release = toRelease(releases.rows[releases.rows.length - 1] as ReleaseRow);
    return this.inspectRelease(release.releaseId);
  }

  async inspectRelease(releaseId: string): Promise<ReleaseInspection> {
    const release = await this.db.execute<ReleaseRow>({
      sql: `SELECT * FROM release_control.releases WHERE release_id = $1`,
      parameters: [releaseId],
    });
    const deployments = await this.db.execute<EnvironmentDeploymentRow>({
      sql: `SELECT * FROM release_control.environment_deployments WHERE release_id = $1
ORDER BY environment`,
      parameters: [releaseId],
    });
    const gates = await this.db.execute<GateRow>({
      sql: `SELECT g.* FROM release_control.gate_results g
JOIN (
    SELECT release_id, environment, gate_kind, max(attempt) AS attempt
    FROM release_control.gate_results
    WHERE release_id = $1
    GROUP BY release_id, environment, gate_kind
) latest ON latest.release_id = g.release_id
    AND latest.environment = g.environment
    AND latest.gate_kind = g.gate_kind
    AND latest.attempt = g.attempt
WHERE g.release_id = $1
ORDER BY g.environment, g.gate_kind`,
      parameters: [releaseId],
    });
    const promotions = await this.db.execute<PromotionRow>({
      sql: `SELECT * FROM release_control.promotions WHERE release_id = $1 ORDER BY decided_at, id`,
      parameters: [releaseId],
    });
    const rollbacks = await this.db.execute<RollbackRow>({
      sql: `SELECT * FROM release_control.rollbacks
WHERE from_release_id = $1 OR to_release_id = $1
ORDER BY recorded_at, id`,
      parameters: [releaseId],
    });
    const active = await this.db.execute<ActiveDeploymentRow>({
      sql: `SELECT * FROM release_control.active_deployments ORDER BY environment`,
    });
    return {
      release: release.rows.length === 0 ? null : toRelease(release.rows[0] as ReleaseRow),
      environmentDeployments: deployments.rows.map(toEnvironmentDeployment),
      effectiveGates: gates.rows.map(toGate),
      promotions: promotions.rows.map(toPromotion),
      rollbacks: rollbacks.rows.map(toRollback),
      activeDeployments: active.rows.map(toActive),
    };
  }

  /** In-transaction gate sufficiency check (the governed transitions). */
  private async assertGatesPassed(
    tx: {
      execute: <T>(query: {
        sql: string;
        parameters?: readonly unknown[];
      }) => Promise<{ rows: readonly T[]; rowCount: number }>;
    },
    releaseId: string,
    environment: string,
    requiredGates: readonly string[],
  ): Promise<void> {
    const gates = await tx.execute<GateRow>({
      sql: `SELECT g.* FROM release_control.gate_results g
JOIN (
    SELECT release_id, environment, gate_kind, max(attempt) AS attempt
    FROM release_control.gate_results
    WHERE release_id = $1 AND environment = $2
    GROUP BY release_id, environment, gate_kind
) latest ON latest.release_id = g.release_id
    AND latest.environment = g.environment
    AND latest.gate_kind = g.gate_kind
    AND latest.attempt = g.attempt
WHERE g.release_id = $1 AND g.environment = $2`,
      parameters: [releaseId, environment],
    });
    const passed = new Set(
      gates.rows.filter((row) => row.status === "passed").map((row) => row.gate_kind),
    );
    const missing = requiredGates.filter((gate) => !passed.has(gate));
    if (missing.length > 0) {
      refuse({
        kind: "gates-missing",
        message: `release ${releaseId} at ${environment} is missing passed gate evidence: ${missing.join(", ")}`,
        missing,
      });
    }
  }
}
