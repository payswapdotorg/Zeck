/**
 * Discrimination tests — the WORK-059 audit/compliance protections
 * (HIGH_ASSURANCE; the worker-runbook rule: "For HIGH_ASSURANCE and
 * CRITICAL, add an explicit discrimination test that proves a weakened
 * protection is rejected").
 *
 * Every fail-closed protection introduced by WORK-059 is
 * mutation-proven — the WEAKENED form is rejected by the gate that
 * owns it (the integration suites prove the same gates over real
 * PostgreSQL; these proofs pin the protections at the source seam):
 *
 *  - AUTHORIZATION-CONSULTING AUDIT ACCESS IS NON-EXISTENT: a
 *    synthetic audit store exposing an authorization-shaped method is
 *    rejected by the evidence-only-vocabulary rule; a synthetic src
 *    file importing the audit module is rejected (the projection is
 *    consulted by nobody);
 *  - SECOND-LEDGER PATTERNS REJECTED: synthetic audit sources carrying
 *    governed execution-state literals are rejected; a synthetic
 *    migration with a status column is rejected; a synthetic audit
 *    file referencing the execution-ir plane is rejected (the E1.1
 *    seam discipline);
 *  - MIGRATION WEAKENING REJECTED: a synthetic migration missing the
 *    append-only triggers / the governed purge gate / the uniqueness
 *    constraints / the bounded-retention CHECK is rejected;
 *  - SECRET-SHAPE SCRUBBING: a submission carrying secret-shaped keys
 *    is rejected at the service scrub gate; credential-shaped values
 *    are redacted (never stored);
 *  - SDK ABSORPTION REJECTED: a synthetic audit source importing an
 *    external compliance/provider package is rejected
 *    (SELF-HOSTING-BOUNDARY: no external compliance SaaS);
 *  - COMPLETENESS DRIFT REJECTED: a synthetic code vocabulary entry
 *    missing from the migration CHECK lists is rejected
 *    (vocabulary-sync);
 *  - THE VERDICT PASS-THROUGH: a hostile wrapped admission verdict
 *    passes through VERBATIM (the observer never flips, filters or
 *    fabricates decisions — recording only).
 */

import { describe, expect, test } from "vitest";
import { InMemoryAuditStore } from "../../src/modules/audit/adapters/in-memory-audit-store";
import { createAuditNodeDigest } from "../../src/modules/audit/adapters/node-digest";
import { createObservingAdmission } from "../../src/modules/audit/adapters/observing-authorization";
import {
  AUDIT_ACTION_KINDS,
  AUDIT_ACTOR_KINDS,
  AUDIT_SEAMS,
  AUDIT_TARGET_KINDS,
  AuditProjectionError,
  type AuditSubmission,
  createAuditService,
  scrubAuditDetail,
} from "../../src/modules/audit/public";
import { scanAuditRules } from "../architecture/lib/audit-boundary-rules";

const digest = createAuditNodeDigest();

const MIGRATION_PATH = "src/platform/db/migrations/0032_audit_compliance.sql";
const REAL_MIGRATION = await import("node:fs").then((fs) =>
  fs.readFileSync(new URL(`../../${MIGRATION_PATH}`, import.meta.url), "utf8"),
);

const VOCABULARIES = {
  actionKinds: AUDIT_ACTION_KINDS,
  actorKinds: AUDIT_ACTOR_KINDS,
  targetKinds: AUDIT_TARGET_KINDS,
  seams: AUDIT_SEAMS,
};

const BASE_AUDIT_FILE = {
  path: "src/modules/audit/adapters/sql-audit-store.ts",
  content: "export class SqlAuditStore {\n  async appendRecord() {}\n  async listRecords() {}\n}",
};
const BASE_OTHER_FILE = {
  path: "src/modules/executions/public.ts",
  content: "export const moduleDescriptor = { id: 'executions' };",
};
/** A stub audit barrel so import resolution lands (the consultation rule is import-precise). */
const BASE_AUDIT_BARREL = {
  path: "src/modules/audit/public.ts",
  content: "export const moduleDescriptor = { id: 'audit' };",
};

function violationsOf(
  extra: { path: string; content: string }[],
  migration = REAL_MIGRATION,
  base: { path: string; content: string } = BASE_AUDIT_FILE,
) {
  const files = [base, BASE_AUDIT_BARREL, { path: MIGRATION_PATH, content: migration }, ...extra];
  return scanAuditRules(files as never, {
    migrationPath: MIGRATION_PATH,
    vocabularies: VOCABULARIES,
  });
}

describe("audit boundary discrimination (WORK-059: weakened protections are rejected)", () => {
  test("an authorization-shaped method on the audit store is rejected (evidence-only vocabulary)", () => {
    const weakened = {
      path: "src/modules/audit/adapters/sql-audit-store.ts",
      content:
        "export class SqlAuditStore {\n  async authorize(request: unknown) {\n    return { allowed: true };\n  }\n}",
    };
    const violations = violationsOf([], REAL_MIGRATION, weakened);
    expect(violations.some((violation) => violation.rule === "evidence-only-vocabulary")).toBe(
      true,
    );
  });

  test("a src file importing the audit module is rejected (no consultation — evidence, never authority)", () => {
    const hostile = {
      path: "src/modules/planning/public.ts",
      content: 'import { AuditRecordStore } from "../audit/public";',
    };
    const violations = violationsOf([hostile]);
    expect(violations.some((violation) => violation.rule === "no-audit-consultation")).toBe(true);
    // The BARREL-import form (the sanctioned surface) is equally
    // rejected: NOTHING may consult the projection, barrel or not.
    const viaBarrel = {
      path: "src/api/server.ts",
      content: 'import { createAuditService } from "../modules/audit/public";',
    };
    const barrelViolations = violationsOf([viaBarrel]);
    expect(barrelViolations.some((violation) => violation.rule === "no-audit-consultation")).toBe(
      true,
    );
  });

  test("governed execution-state literals in the audit module are rejected (no second ledger)", () => {
    for (const state of ['"CREATED"', '"RUNNING"', '"COMPLETED"']) {
      const weakened = {
        path: "src/modules/audit/adapters/in-memory-audit-store.ts",
        content: `export class Store { status = ${state}; }`,
      };
      const violations = violationsOf([weakened]);
      expect(violations.some((violation) => violation.rule === "no-second-ledger")).toBe(true);
    }
  });

  test("a status column in the migration is rejected (audit records are not a state machine)", () => {
    const weakenedMigration = REAL_MIGRATION.replace(
      "CREATE TABLE audit.audit_records (",
      "CREATE TABLE audit.audit_records (\n    status text NOT NULL,",
    );
    const violations = violationsOf([], weakenedMigration);
    expect(violations.some((violation) => violation.rule === "no-second-ledger")).toBe(true);
  });

  test("a missing append-only trigger in the migration is rejected", () => {
    // Weaken the NEEDLE itself: no row-level mutation-rejecting
    // trigger clause at all.
    const weakenedMigration = REAL_MIGRATION.replace(
      "BEFORE UPDATE OR DELETE ON audit.audit_records",
      "BEFORE NOTHING ON audit.audit_records",
    );
    const violations = violationsOf([], weakenedMigration);
    expect(violations.some((violation) => violation.rule === "migration-invariants")).toBe(true);
  });

  test("a missing governed-purge gate in the migration is rejected", () => {
    // EVERY occurrence removed (comment + trigger body): the
    // session gate is the only legal deletion path.
    const weakenedMigration = REAL_MIGRATION.replaceAll(
      "audit.governed_purge",
      "audit.removed_gate",
    );
    const violations = violationsOf([], weakenedMigration);
    expect(violations.some((violation) => violation.rule === "migration-invariants")).toBe(true);
  });

  test("an unbounded-retention migration is rejected (bounded retention by construction)", () => {
    const weakenedMigration = REAL_MIGRATION.replace(
      "retention_days >= 1 AND retention_days <= 3650",
      "retention_days >= 0",
    );
    const violations = violationsOf([], weakenedMigration);
    expect(violations.some((violation) => violation.rule === "migration-invariants")).toBe(true);
  });

  test("a missing chain-uniqueness constraint in the migration is rejected", () => {
    // Weaken EVERY occurrence (constraint + the top comment): a
    // gapless chain is enforced by the uniqueness, not by prose.
    const weakenedMigration = REAL_MIGRATION.replaceAll(
      "UNIQUE (application_id, chain_sequence)",
      "UNIQUE (application_id)",
    );
    const violations = violationsOf([], weakenedMigration);
    expect(violations.some((violation) => violation.rule === "migration-invariants")).toBe(true);
  });

  test("credential-shaped literals in audit sources are rejected (secret-free sources)", () => {
    // Fragment-assembled: no credential-shaped literal exists in THIS
    // file — the synthetic weakened source is built at runtime.
    const tokenLiteral = ["sk", "abcdefghijklmnopqrstuvwx"].join("-");
    const weakened = {
      path: "src/modules/audit/adapters/sql-audit-store.ts",
      content: `const apiToken = "${tokenLiteral}";`,
    };
    const violations = violationsOf([weakened]);
    expect(violations.some((violation) => violation.rule === "secret-free-sources")).toBe(true);
  });

  test("an external compliance/provider SDK import in the audit module is rejected (self-hosting boundary)", () => {
    for (const specifier of ['"pg"', '"@compliance-saas/sdk"', '"openai"']) {
      const weakened = {
        path: "src/modules/audit/adapters/sql-audit-store.ts",
        content: `import pg from ${specifier};`,
      };
      const violations = violationsOf([weakened]);
      expect(violations.some((violation) => violation.rule === "no-new-sdk")).toBe(true);
    }
  });

  test("an audit file referencing the execution-ir plane is rejected (the E1.1 seam discipline)", () => {
    const weakened = {
      path: "src/modules/audit/adapters/observing-decision-store.ts",
      content:
        'import { SqlOptimizationDecisionStore } from "../../../platform/execution-ir/decision-store";',
    };
    const violations = violationsOf([weakened]);
    expect(violations.some((violation) => violation.rule === "no-execution-ir-reference")).toBe(
      true,
    );
  });

  test("vocabulary drift between code and migration CHECKs is rejected (honest completeness)", () => {
    // A code vocabulary entry that the migration does NOT CHECK-bind.
    const violations = scanAuditRules(
      [
        BASE_AUDIT_FILE,
        { path: MIGRATION_PATH, content: REAL_MIGRATION },
        BASE_OTHER_FILE,
      ] as never,
      {
        migrationPath: MIGRATION_PATH,
        vocabularies: { ...VOCABULARIES, actionKinds: [...AUDIT_ACTION_KINDS, "budget.reserved"] },
      },
    );
    expect(violations.some((violation) => violation.rule === "vocabulary-sync")).toBe(true);
  });

  test("the REAL tree passes every audit boundary rule (the discrimination baseline)", async () => {
    const { collectSourceFiles } = await import("../architecture/lib/collect");
    const { resolve } = await import("node:path");
    const files = [
      ...collectSourceFiles(resolve(import.meta.dirname, "../..")),
      { path: MIGRATION_PATH, content: REAL_MIGRATION },
    ];
    const violations = scanAuditRules(files, {
      migrationPath: MIGRATION_PATH,
      vocabularies: VOCABULARIES,
    });
    expect(violations).toEqual([]);
  });
});

describe("audit behavioral discrimination (WORK-059)", () => {
  const APPLICATION_ID = "00000000-0000-7000-8000-0000000000aa";
  const TENANT_ID = "00000000-0000-7000-8000-0000000000bb";
  const EXECUTION_ID = "00000000-0000-7000-8000-0000000000cc";
  const NOW = () => new Date("2026-09-20T12:00:00.000Z");

  function submission(overrides: Partial<AuditSubmission> = {}): AuditSubmission {
    return {
      applicationId: APPLICATION_ID,
      tenantId: TENANT_ID,
      environment: "production",
      actor: { actorId: "actor-1", actorKind: "service-principal" },
      action: { kind: "execution.transitioned", command: "authorize", operationKey: "op-1" },
      target: { kind: "execution", id: EXECUTION_ID },
      provenance: { seam: "executions.transition", sourceRecordId: EXECUTION_ID },
      rationale: { why: "discrimination probe" },
      occurredAt: "2026-09-20T12:00:00.000Z",
      actionDetail: { from: "CREATED", to: "AUTHORIZED", sequence: 1 },
      ...overrides,
    };
  }

  test("a submission with a secret-shaped detail key is rejected at the service scrub gate", async () => {
    const store = new InMemoryAuditStore(digest, NOW);
    const audit = createAuditService({ store, digest });
    for (const key of ["apiToken", "clientSecret", "password", "authorization"]) {
      await expect(
        audit.record(submission({ actionDetail: { [key]: "x" } })),
      ).rejects.toBeInstanceOf(AuditProjectionError);
    }
    // Nothing was recorded (fail closed BEFORE the authority).
    expect(await store.listRecords(APPLICATION_ID)).toEqual([]);
  });

  test("credential-shaped VALUES are redacted, never stored (scrub discrimination)", () => {
    const fragment = "ghp_" + "abcdefghijklmnopqrstuvwx";
    const result = scrubAuditDetail({ note: `token ${fragment} in note` });
    expect(result.admissible).toBe(true);
    expect(JSON.stringify(result.detail)).not.toContain(fragment);
    expect(JSON.stringify(result.detail)).toContain("[redacted]");
  });

  test("a hostile admission verdict passes through VERBATIM (the observer never changes a decision)", async () => {
    const store = new InMemoryAuditStore(digest, NOW);
    const hostileDeny = { allowed: false, reason: "hostile: policy denial" };
    const observing = createObservingAdmission({
      inner: { evaluate: async () => hostileDeny },
      store,
      environment: "production",
      command: "authorize",
      now: NOW,
    });
    const request = {
      execution: {
        id: EXECUTION_ID,
        applicationId: APPLICATION_ID,
        tenantId: TENANT_ID,
        status: "CREATED",
      },
      actorId: "actor-1",
    };
    const verdict = await observing.evaluate(request);
    expect(verdict).toEqual(hostileDeny);
    // The evidence records the DENIAL faithfully (it never rewrites
    // the decision it observed).
    const record = (await store.listRecords(APPLICATION_ID))[0]!;
    expect(record.actionDetail).toEqual({
      allowed: false,
      executionStatus: "CREATED",
      denialReason: "hostile: policy denial",
    });
  });

  test("a failing projection NEVER flips an allow into a deny (it fails closed instead)", async () => {
    const failingStore = {
      appendRecord: () => Promise.reject(new Error("projection unavailable")),
      getRecord: () => Promise.resolve(null),
      listRecords: () => Promise.resolve([]),
      chainHead: () => Promise.resolve(null),
      purgeExpiredRecords: () => Promise.resolve({ purged: false, purgedCount: 0, evidence: null }),
      listPurgeManifests: () => Promise.resolve([]),
    };
    const observing = createObservingAdmission({
      inner: { evaluate: async () => ({ allowed: true }) },
      store: failingStore,
      environment: "production",
      command: "authorize",
      now: NOW,
    });
    await expect(
      observing.evaluate({
        execution: {
          id: EXECUTION_ID,
          applicationId: APPLICATION_ID,
          tenantId: TENANT_ID,
          status: "CREATED",
        },
        actorId: "actor-1",
      }),
    ).rejects.toBeInstanceOf(AuditProjectionError);
  });
});
