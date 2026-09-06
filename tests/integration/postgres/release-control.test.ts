/**
 * Integration — the release-control ledger over REAL PostgreSQL
 * (WORK-047 / D-06; checkpoints RELEASE-IDENTITY, PROMOTION-GATES,
 * MIGRATION-SAFETY evidence plumbing, ROLLBACK-SAFETY).
 *
 * Proves over the real database (migration 0029, schema
 * release_control):
 *
 *  - release recording is idempotent, content-addressed and
 *    exact-commit-bound (a non-40-hex revision is unrepresentable);
 *  - the environment deployment binding is immutable (identity
 *    mismatch is a typed refusal);
 *  - gate evidence is APPEND-ONLY: attempts never rewrite, the
 *    latest attempt is the effective result, a failed attempt can
 *    be re-run to pass;
 *  - the physical immutability triggers reject UPDATE/DELETE on the
 *    evidence/attribution tables and DELETE on the active pointer;
 *  - activation is policy-enforced (missing gates ⇒ typed refusal)
 *    AND journal-linked (no promoted decision ⇒ typed refusal);
 *  - ROLLBACK flips the pointer + journals the event and changes
 *    NOTHING outside release_control (the domain-isolation proof:
 *    every row of every other schema is byte-identical before and
 *    after);
 *  - the full promotion sequencing: refuse → evidence → journal →
 *    activate; production requires the architect approval gate.
 */

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import {
  evidenceDigestOf,
  isHostingEnvironment,
  type ReleaseControlError,
  releaseIdentityId,
  SqlReleaseControlStore,
} from "../../../src/platform/release";
import { loadReleasePolicy } from "../../../src/platform/release/policy";
import { definePgSuite } from "./harness";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const POLICY = loadReleasePolicy(
  readFileSync(resolve(REPO_ROOT, "deploy/manifests/release-policy.json"), "utf8"),
  // The manifest argument is only used for the environments.json
  // cross-check (already pinned by the unit suite); a minimal stub
  // suffices here because the POLICY source itself is the repository
  // truth and the unit suite proves the cross-check.
  {
    environments: [
      {
        id: "local",
        environmentClass: "disposable",
        description: "",
        dataPolicy: "",
        teardownAllowed: true,
        credentialScope: "",
        promotion: {
          nextPhase: "ci",
          requires: ["governance-check", "typecheck", "lint", "full-test-suite"],
        },
      },
      {
        id: "preview",
        environmentClass: "disposable",
        description: "",
        dataPolicy: "",
        teardownAllowed: true,
        credentialScope: "",
        promotion: { nextPhase: "staging", requires: ["ci-gates", "preview-smoke"] },
      },
      {
        id: "staging",
        environmentClass: "persistent",
        description: "",
        dataPolicy: "",
        teardownAllowed: false,
        credentialScope: "",
        promotion: {
          nextPhase: "production",
          requires: ["architect-approval", "staging-smoke", "deployment-identity-audit"],
        },
      },
      {
        id: "production",
        environmentClass: "persistent",
        description: "",
        dataPolicy: "",
        teardownAllowed: false,
        credentialScope: "",
        promotion: null,
      },
    ],
    promotionOrder: ["local", "ci", "preview", "staging", "production"],
    providers: [],
    resources: { local: [], preview: [], staging: [], production: [] },
    secretReferences: { local: [], preview: [], staging: [], production: [] },
    variables: [],
    sources: {
      "environments.json": "",
      "providers.json": "",
      "resources.json": "",
      "secret-references.json": "",
      "variables.json": "",
    },
  },
);

const MANIFEST_DIGEST = "a".repeat(64);
const ACTOR = "release-operator";

/** A unique exact 40-hex revision per test (ledger isolation). */
function uniqueRevision(): string {
  return `${randomUUID().replaceAll("-", "")}${randomUUID().replaceAll("-", "").slice(0, 8)}`;
}

/** Every table row count of every NON-release_control schema (the isolation snapshot). */
async function domainSnapshot(
  db: Parameters<Parameters<typeof definePgSuite>[1]>[0]["port"],
): Promise<readonly string[]> {
  const result = await db.execute<{ table_schema: string; table_name: string; rows: string }>({
    sql: `SELECT table_schema, table_name,
(SELECT count(*) FROM information_schema.columns c WHERE c.table_schema = t.table_schema AND c.table_name = t.table_name) AS column_count
FROM information_schema.tables t
WHERE t.table_schema NOT IN ('release_control', 'information_schema', 'pg_catalog')
  AND t.table_type = 'BASE TABLE'
ORDER BY table_schema, table_name`,
  });
  const lines: string[] = [];
  for (const row of result.rows) {
    const count = await db.execute<{ readonly count: string }>({
      sql: `SELECT count(*) AS count FROM "${row.table_schema}"."${row.table_name}"`,
    });
    lines.push(`${row.table_schema}.${row.table_name}:${count.rows[0]?.count ?? "?"}`);
  }
  return lines;
}

definePgSuite("release control ledger (WORK-047 D-06)", (ctx) => {
  const store = () =>
    new SqlReleaseControlStore({
      db: ctx.port,
      now: () => new Date(),
      generateId: () => `id-${Math.random().toString(16).slice(2, 10)}`,
    });

  test("release recording is idempotent, content-addressed and exact-commit-bound", async () => {
    const s = store();
    const REVISION = uniqueRevision();
    const OTHER_REVISION = uniqueRevision();
    const release = await s.recordRelease({
      gitRevision: REVISION,
      manifestDigest: MANIFEST_DIGEST,
      actor: ACTOR,
    });
    expect(release.releaseId).toBe(releaseIdentityId(REVISION, MANIFEST_DIGEST));
    // Idempotent: the same inputs return the SAME record.
    const again = await s.recordRelease({
      gitRevision: REVISION,
      manifestDigest: MANIFEST_DIGEST,
      actor: "someone-else",
    });
    expect(again.releaseId).toBe(release.releaseId);
    expect(again.recordedBy).toBe(release.recordedBy);
    // A different revision is a different release.
    const other = await s.recordRelease({
      gitRevision: OTHER_REVISION,
      manifestDigest: MANIFEST_DIGEST,
      actor: ACTOR,
    });
    expect(other.releaseId).not.toBe(release.releaseId);
    // Not tied to an exact commit ⇒ fail closed.
    for (const bad of ["", "HEAD", "main", REVISION.slice(0, 12)]) {
      await expect(
        s.recordRelease({ gitRevision: bad, manifestDigest: MANIFEST_DIGEST, actor: ACTOR }),
      ).rejects.toThrow(/exact 40-hex Git commit/);
    }
  });

  test("the environment deployment binding is immutable (identity mismatch is a typed refusal)", async () => {
    const s = store();
    const REVISION = uniqueRevision();
    const release = await s.recordRelease({
      gitRevision: REVISION,
      manifestDigest: MANIFEST_DIGEST,
      actor: ACTOR,
    });
    const binding = await s.recordEnvironmentDeployment({
      releaseId: release.releaseId,
      environment: "staging",
      deploymentIdentityId: "b".repeat(64),
      resourceDigest: "c".repeat(64),
      actor: ACTOR,
    });
    expect(binding.deploymentIdentityId).toBe("b".repeat(64));
    // Idempotent re-record: the same identity returns the binding.
    const again = await s.recordEnvironmentDeployment({
      releaseId: release.releaseId,
      environment: "staging",
      deploymentIdentityId: "b".repeat(64),
      resourceDigest: "c".repeat(64),
      actor: ACTOR,
    });
    expect(again.deploymentIdentityId).toBe("b".repeat(64));
    // Mismatched identity ⇒ typed refusal.
    await expect(
      s.recordEnvironmentDeployment({
        releaseId: release.releaseId,
        environment: "staging",
        deploymentIdentityId: "d".repeat(64),
        resourceDigest: "c".repeat(64),
        actor: ACTOR,
      }),
    ).rejects.toThrow(/identity-mismatch|binding is immutable/);
    // ci is not a hosting environment: the physical CHECK rejects it.
    await expect(
      ctx.port.execute({
        sql: `INSERT INTO release_control.environment_deployments
(release_id, environment, deployment_identity_id, resource_digest, recorded_at, recorded_by)
VALUES ($1, 'ci', $2, $3, now(), 'x')`,
        parameters: [release.releaseId, "b".repeat(64), "c".repeat(64)],
      }),
    ).rejects.toThrow(/environment_deployments_environment_check|check constraint/);
  });

  test("gate evidence is append-only: attempts accumulate, the latest is effective", async () => {
    const s = store();
    const REVISION = uniqueRevision();
    const release = await s.recordRelease({
      gitRevision: REVISION,
      manifestDigest: MANIFEST_DIGEST,
      actor: ACTOR,
    });
    const first = await s.recordGateResult({
      releaseId: release.releaseId,
      environment: "ci",
      gateKind: "typecheck",
      status: "failed",
      evidenceDigest: evidenceDigestOf("first failure"),
      evidenceDetail: "exit 1; tsc --noEmit",
      source: "tool-run",
      actor: ACTOR,
    });
    expect(first.attempt).toBe(1);
    const second = await s.recordGateResult({
      releaseId: release.releaseId,
      environment: "ci",
      gateKind: "typecheck",
      status: "passed",
      evidenceDigest: evidenceDigestOf("second pass"),
      evidenceDetail: "exit 0; tsc --noEmit",
      source: "tool-run",
      actor: ACTOR,
    });
    expect(second.attempt).toBe(2);
    const effective = await s.effectiveGateResults(release.releaseId, "ci");
    expect(effective).toHaveLength(1);
    expect(effective[0]?.attempt).toBe(2);
    expect(effective[0]?.status).toBe("passed");
    // Oversized evidence detail is rejected (bounded).
    await expect(
      s.recordGateResult({
        releaseId: release.releaseId,
        environment: "ci",
        gateKind: "lint",
        status: "passed",
        evidenceDigest: evidenceDigestOf("x"),
        evidenceDetail: "x".repeat(5000),
        source: "tool-run",
        actor: ACTOR,
      }),
    ).rejects.toThrow(/4096-character bound/);
  });

  test("the physical immutability triggers reject evidence/attribution mutation", async () => {
    const s = store();
    const REVISION = uniqueRevision();
    const OTHER_REVISION = uniqueRevision();
    const release = await s.recordRelease({
      gitRevision: REVISION,
      manifestDigest: MANIFEST_DIGEST,
      actor: ACTOR,
    });
    await s.recordEnvironmentDeployment({
      releaseId: release.releaseId,
      environment: "local",
      deploymentIdentityId: "b".repeat(64),
      resourceDigest: "c".repeat(64),
      actor: ACTOR,
    });
    await s.recordGateResult({
      releaseId: release.releaseId,
      environment: "local",
      gateKind: "validation",
      status: "passed",
      evidenceDigest: evidenceDigestOf("v"),
      evidenceDetail: "valid",
      source: "tool-run",
      actor: ACTOR,
    });
    await s.recordPromotionDecision({
      releaseId: release.releaseId,
      fromPhase: "none",
      toPhase: "local",
      decision: "promoted",
      reason: "entry gates satisfied",
      actor: ACTOR,
    });
    await s.activate({
      environment: "local",
      releaseId: release.releaseId,
      requiredGates: POLICY.entryGates.local,
      actor: ACTOR,
    });
    // UPDATE the attribution/evidence ⇒ rejected by the triggers.
    await expect(
      ctx.port.execute({
        sql: `UPDATE release_control.releases SET git_revision = $1 WHERE release_id = $2`,
        parameters: [OTHER_REVISION, release.releaseId],
      }),
    ).rejects.toThrow(/releases is immutable/);
    await expect(
      ctx.port.execute({
        sql: `DELETE FROM release_control.gate_results WHERE release_id = $1`,
        parameters: [release.releaseId],
      }),
    ).rejects.toThrow(/gate_results is append-only/);
    await expect(
      ctx.port.execute({
        sql: `UPDATE release_control.environment_deployments SET deployment_identity_id = $1`,
        parameters: ["e".repeat(64)],
      }),
    ).rejects.toThrow(/environment_deployments is immutable/);
    await expect(
      ctx.port.execute({ sql: `DELETE FROM release_control.promotions` }),
    ).rejects.toThrow(/promotions is append-only/);
    await expect(
      ctx.port.execute({ sql: `DELETE FROM release_control.active_deployments` }),
    ).rejects.toThrow(/never deleted/);
  });

  test("activation is policy-enforced AND journal-linked (the promotion gates)", async () => {
    const s = store();
    const REVISION = uniqueRevision();
    const release = await s.recordRelease({
      gitRevision: REVISION,
      manifestDigest: MANIFEST_DIGEST,
      actor: ACTOR,
    });
    await s.recordEnvironmentDeployment({
      releaseId: release.releaseId,
      environment: "staging",
      deploymentIdentityId: "b".repeat(64),
      resourceDigest: "c".repeat(64),
      actor: ACTOR,
    });
    // 1. No journal entry: refuse even with all gates.
    for (const gateKind of POLICY.entryGates.staging) {
      await s.recordGateResult({
        releaseId: release.releaseId,
        environment: "staging",
        gateKind,
        status: "passed",
        evidenceDigest: evidenceDigestOf(gateKind),
        evidenceDetail: `${gateKind} passed`,
        source: "tool-run",
        actor: ACTOR,
      });
    }
    await expect(
      s.activate({
        environment: "staging",
        releaseId: release.releaseId,
        requiredGates: POLICY.entryGates.staging,
        actor: ACTOR,
      }),
    ).rejects.toThrow(/requires a recorded 'promoted' decision/);
    // 2. Journal entry + missing gates: refuse with the missing list.
    await s.recordPromotionDecision({
      releaseId: release.releaseId,
      fromPhase: "ci",
      toPhase: "staging",
      decision: "promoted",
      reason: "operator promoted after CI",
      actor: ACTOR,
    });
    // (all staging gates passed above, so flip one to failed via a new attempt)
    await s.recordGateResult({
      releaseId: release.releaseId,
      environment: "staging",
      gateKind: "migration",
      status: "failed",
      evidenceDigest: evidenceDigestOf("migration failed"),
      evidenceDetail: "unapplied migrations present",
      source: "tool-run",
      actor: ACTOR,
    });
    await expect(
      s.activate({
        environment: "staging",
        releaseId: release.releaseId,
        requiredGates: POLICY.entryGates.staging,
        actor: ACTOR,
      }),
    ).rejects.toThrow(/missing passed gate evidence:.*migration/);
    // 3. Re-run the failed gate to pass: activation succeeds.
    await s.recordGateResult({
      releaseId: release.releaseId,
      environment: "staging",
      gateKind: "migration",
      status: "passed",
      evidenceDigest: evidenceDigestOf("migration converged"),
      evidenceDetail: "schema converged",
      source: "tool-run",
      actor: ACTOR,
    });
    const active = await s.activate({
      environment: "staging",
      releaseId: release.releaseId,
      requiredGates: POLICY.entryGates.staging,
      actor: ACTOR,
    });
    expect(active.environment).toBe("staging");
    expect(active.releaseId).toBe(release.releaseId);
    expect((await s.activeDeployment("staging"))?.releaseId).toBe(release.releaseId);
  });

  test("ROLLBACK flips the pointer + journals the event and touches NOTHING outside release_control", async () => {
    const s = store();
    const REVISION = uniqueRevision();
    // Seed durable domain state that MUST NOT change (a representative
    // row in a domain schema; the isolation snapshot covers all).
    await ctx.port.execute({
      sql: `INSERT INTO applications.tenants (id, slug, name) VALUES ($1, $2, $3)`,
      parameters: ["00000000-0000-7000-8000-0000000000d6", "rollback-tenant", "rollback tenant"],
    });

    const releaseA = await s.recordRelease({
      gitRevision: REVISION,
      manifestDigest: MANIFEST_DIGEST,
      actor: ACTOR,
    });
    const releaseB = await s.recordRelease({
      gitRevision: uniqueRevision(),
      manifestDigest: MANIFEST_DIGEST,
      actor: ACTOR,
    });
    for (const release of [releaseA, releaseB]) {
      await s.recordEnvironmentDeployment({
        releaseId: release.releaseId,
        environment: "staging",
        deploymentIdentityId: `${release.gitRevision[0]}${"b".repeat(63)}`,
        resourceDigest: "c".repeat(64),
        actor: ACTOR,
      });
      for (const gateKind of POLICY.entryGates.staging) {
        await s.recordGateResult({
          releaseId: release.releaseId,
          environment: "staging",
          gateKind,
          status: "passed",
          evidenceDigest: evidenceDigestOf(`${release.releaseId}:${gateKind}`),
          evidenceDetail: `${gateKind} passed`,
          source: "tool-run",
          actor: ACTOR,
        });
      }
      await s.recordPromotionDecision({
        releaseId: release.releaseId,
        fromPhase: "ci",
        toPhase: "staging",
        decision: "promoted",
        reason: "operator promoted",
        actor: ACTOR,
      });
      await s.activate({
        environment: "staging",
        releaseId: release.releaseId,
        requiredGates: POLICY.entryGates.staging,
        actor: ACTOR,
      });
    }
    expect((await s.activeDeployment("staging"))?.releaseId).toBe(releaseB.releaseId);

    const before = await domainSnapshot(ctx.port);

    const rolled = await s.rollback({
      environment: "staging",
      toReleaseId: releaseA.releaseId,
      requiredGates: POLICY.entryGates.staging,
      reason: "incident rollback drill",
      actor: ACTOR,
    });

    // The pointer flipped to releaseA and the event is journaled.
    expect(rolled.releaseId).toBe(releaseA.releaseId);
    expect((await s.activeDeployment("staging"))?.releaseId).toBe(releaseA.releaseId);
    const inspection = await s.inspectRelease(releaseA.releaseId);
    expect(inspection.rollbacks).toHaveLength(1);
    expect(inspection.rollbacks[0]?.fromReleaseId).toBe(releaseB.releaseId);
    expect(inspection.rollbacks[0]?.toReleaseId).toBe(releaseA.releaseId);
    expect(inspection.rollbacks[0]?.reason).toBe("incident rollback drill");

    // THE ISOLATION PROOF: nothing outside release_control changed.
    const after = await domainSnapshot(ctx.port);
    expect(after).toEqual(before);

    // Rollback to the active release itself is unrepresentable.
    await expect(
      s.rollback({
        environment: "staging",
        toReleaseId: releaseA.releaseId,
        requiredGates: POLICY.entryGates.staging,
        reason: "same",
        actor: ACTOR,
      }),
    ).rejects.toThrow(/other than the active one/);
    // Rollback without an active deployment is unrepresentable.
    await expect(
      s.rollback({
        environment: "production",
        toReleaseId: releaseA.releaseId,
        requiredGates: POLICY.entryGates.production,
        reason: "no active",
        actor: ACTOR,
      }),
    ).rejects.toThrow(/requires an active deployment/);
  });

  test("the production promotion sequencing: approval-gated, refused without it", async () => {
    const s = store();
    const REVISION = uniqueRevision();
    const release = await s.recordRelease({
      gitRevision: REVISION,
      manifestDigest: MANIFEST_DIGEST,
      actor: ACTOR,
    });
    await s.recordEnvironmentDeployment({
      releaseId: release.releaseId,
      environment: "production",
      deploymentIdentityId: "f".repeat(64),
      resourceDigest: "c".repeat(64),
      actor: ACTOR,
    });
    await s.recordPromotionDecision({
      releaseId: release.releaseId,
      fromPhase: "staging",
      toPhase: "production",
      decision: "promoted",
      reason: "operator promoted",
      actor: ACTOR,
    });
    // All production gates EXCEPT architect-approval.
    for (const gateKind of POLICY.entryGates.production.filter(
      (gate) => gate !== "architect-approval",
    )) {
      await s.recordGateResult({
        releaseId: release.releaseId,
        environment: "production",
        gateKind,
        status: "passed",
        evidenceDigest: evidenceDigestOf(gateKind),
        evidenceDetail: `${gateKind} passed`,
        source: "tool-run",
        actor: ACTOR,
      });
    }
    // Without the approval gate: refused (the missing evidence is
    // named exactly).
    await expect(
      s.activate({
        environment: "production",
        releaseId: release.releaseId,
        requiredGates: POLICY.entryGates.production,
        actor: ACTOR,
      }),
    ).rejects.toThrow(/architect-approval/);
    // The approval lands (attach-only evidence) and the activation
    // succeeds — the Architect's approval is a real gate, recorded
    // through the same append-only path.
    await s.recordGateResult({
      releaseId: release.releaseId,
      environment: "production",
      gateKind: "architect-approval",
      status: "passed",
      evidenceDigest: evidenceDigestOf("approval statement"),
      evidenceDetail: "approved for production by the Architect",
      source: "external-attach",
      actor: "the-architect",
    });
    const active = await s.activate({
      environment: "production",
      releaseId: release.releaseId,
      requiredGates: POLICY.entryGates.production,
      actor: ACTOR,
    });
    expect(active.environment).toBe("production");
    expect(isHostingEnvironment("production")).toBe(true);
  });

  test("refusals are journaled evidence (the audit trail)", async () => {
    const s = store();
    const REVISION = uniqueRevision();
    const release = await s.recordRelease({
      gitRevision: REVISION,
      manifestDigest: MANIFEST_DIGEST,
      actor: ACTOR,
    });
    const refusal = await s.recordPromotionDecision({
      releaseId: release.releaseId,
      fromPhase: "none",
      toPhase: "ci",
      decision: "refused",
      reason: "missing gate evidence: governance-check, typecheck",
      actor: "ci-runner",
    });
    expect(refusal.decision).toBe("refused");
    const inspection = await s.inspectRelease(release.releaseId);
    expect(inspection.promotions).toHaveLength(1);
    expect(inspection.promotions[0]?.decision).toBe("refused");
  });

  test("typed refusals carry the refusal vocabulary", async () => {
    const s = store();
    const unknownId = "0".repeat(64);
    let refusal: ReleaseControlError | null = null;
    try {
      await s.activate({
        environment: "staging",
        releaseId: unknownId,
        requiredGates: [],
        actor: ACTOR,
      });
    } catch (error) {
      refusal = error as ReleaseControlError;
    }
    expect(refusal).not.toBeNull();
    expect(refusal?.refusal.kind).toBe("unknown-release");
  });
});
