/**
 * Architecture: the D-08 audit/compliance boundaries (WORK-059 / SEC-004;
 * checkpoint contracts IDENTITY-IDEMPOTENCY, CONCURRENCY-CRASH-SAFETY,
 * EXECUTION-PROVENANCE, MIGRATION-SAFETY, DEPENDENCY-DIRECTION,
 * SELF-HOSTING-BOUNDARY, IMPLEMENTATION-COMPLETENESS).
 *
 * Mechanically proves over the REAL tree (the discriminating power of
 * each rule is proven in `tests/discrimination/audit.discrimination.test.ts`
 * with synthetic weakened protections):
 *
 *  - B1 LAYERING: the audit module passes the shared dependency-rule
 *    engine (public-barrel-only cross-module imports, layer direction,
 *    domain purity — IMPLEMENTATION.md §3).
 *  - B2 NO-AUDIT-CONSULTATION: nothing outside the audit module
 *    imports it — the projection is evidence, consulted by nobody.
 *  - B3 EVIDENCE-ONLY VOCABULARY: the public barrel, ports and the
 *    durable store define no authorization-shaped method.
 *  - B4 NO SECOND LEDGER: no governed-state vocabulary in the audit
 *    sources; no status/state columns in the migration.
 *  - B5 MIGRATION INVARIANTS: append-only triggers (row + statement
 *    TRUNCATE), the governed-purge gate, identity/chain uniqueness,
 *    bounded retention, tenant composite FKs.
 *  - B6 SECRET-FREE SOURCES.
 *  - B7 NO NEW SDK (self-hosting: no external compliance SaaS, no
 *    provider SDK — the DatabasePort bridge only).
 *  - B8 VOCABULARY SYNC: the closed code vocabularies equal the
 *    migration CHECK lists (completeness is machine-checked).
 *  - B9 ONE DURABLE AUTHORITY: the SQL store is the ONLY durable
 *    audit implementation; the module skeleton is intact.
 *  - B10 THE SEAM DISCIPLINE: the audit module references the
 *    execution-ir plane nowhere (the e11-ir B3 seam boundary holds);
 *    other modules are imported through public barrels only.
 */
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import {
  AUDIT_ACTION_KINDS,
  AUDIT_ACTOR_KINDS,
  AUDIT_SEAMS,
  AUDIT_TARGET_KINDS,
  moduleDescriptor,
} from "../../src/modules/audit/public";
import { scanAuditRules } from "./lib/audit-boundary-rules";
import { collectSourceFiles, declaredRuntimePackages } from "./lib/collect";
import { type SourceFile, scanDependencyRules } from "./lib/dependency-rules";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const MIGRATION_PATH = "src/platform/db/migrations/0032_audit_compliance.sql";

function listFiles(dir: string): string[] {
  const base = join(REPO_ROOT, dir);
  const walk = (current: string, prefix: string, out: string[]): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) {
        walk(join(current, entry.name), rel, out);
      } else if (entry.name.endsWith(".ts")) {
        out.push(rel);
      }
    }
  };
  const out: string[] = [];
  walk(base, dir, out);
  return out.sort();
}

describe("D-08 audit/compliance architecture boundaries (WORK-059)", () => {
  const files = collectSourceFiles(REPO_ROOT);
  const auditFiles = files.filter((file) => file.path.startsWith("src/modules/audit/"));
  // The migration is SQL — loaded explicitly (collectSourceFiles is
  // TypeScript-only).
  const migrationSource: SourceFile = {
    path: MIGRATION_PATH,
    content: readFileSync(join(REPO_ROOT, MIGRATION_PATH), "utf8"),
  };

  test("B1 layering: the audit module passes the shared dependency-rule engine", () => {
    expect(auditFiles.length).toBeGreaterThanOrEqual(15);
    // The engine resolves relative imports against the WHOLE tree
    // (the audit module's imports reach shared/platform/executions).
    const violations = scanDependencyRules(files, {
      allowedPackages: declaredRuntimePackages(REPO_ROOT),
    }).filter((violation) => violation.path.startsWith("src/modules/audit/"));
    expect(violations.map((v) => `${v.rule} @ ${v.path} -> ${v.importSpecifier}`)).toEqual([]);
  });

  test("B2-B8 the audit boundary rules pass over the real tree", () => {
    const violations = scanAuditRules([...files, migrationSource], {
      migrationPath: MIGRATION_PATH,
      vocabularies: {
        actionKinds: AUDIT_ACTION_KINDS,
        actorKinds: AUDIT_ACTOR_KINDS,
        targetKinds: AUDIT_TARGET_KINDS,
        seams: AUDIT_SEAMS,
      },
    });
    expect(violations.map((v) => `${v.rule} @ ${v.path}: ${v.detail}`)).toEqual([]);
  });

  test("B9 one durable authority: the SQL store is the only durable audit implementation", () => {
    const implementors = files.filter(
      (file) =>
        file.content.includes("implements AuditRecordStore") ||
        file.content.includes("implements LegalHoldStore") ||
        file.content.includes("implements RetentionPolicyStore"),
    );
    expect(implementors.map((file) => file.path).sort()).toEqual([
      "src/modules/audit/adapters/in-memory-audit-store.ts",
      "src/modules/audit/adapters/sql-audit-store.ts",
    ]);
    // The module skeleton is intact (public + five layers).
    expect(moduleDescriptor.id).toBe("audit");
    for (const layer of ["domain", "application", "ports", "adapters", "internal"]) {
      expect(listFiles(`src/modules/audit/${layer}`).length).toBeGreaterThan(0);
    }
  });

  test("B10 the seam discipline: the audit module never references the execution-ir plane; cross-module imports are public-only", () => {
    for (const file of auditFiles) {
      // The E1.1 seam boundary (WORK-049 B3): no module file may
      // reference the decision-record foundation — the audit observer
      // uses STRUCTURAL seam typing, never an import.
      expect(
        file.content.includes("execution-ir"),
        `${file.path} must not reference the execution-ir plane`,
      ).toBe(false);
      expect(
        file.content.includes("platform/execution-ir"),
        `${file.path} must not reference the platform execution-ir plane`,
      ).toBe(false);
    }
    // Cross-module imports go through public barrels (the engine's
    // cross-module-public-only rule over the whole tree — pinned again
    // for the audit files specifically).
    const violations = scanDependencyRules(files, {
      allowedPackages: declaredRuntimePackages(REPO_ROOT),
    }).filter((v) => v.path.startsWith("src/modules/audit/"));
    expect(violations).toEqual([]);
  });

  test("the migration ships in the platform set with the next available version", () => {
    const migrations = readdirSync(join(REPO_ROOT, "src/platform/db/migrations"))
      .filter((name) => name.endsWith(".sql"))
      .sort();
    expect(migrations).toContain("0032_audit_compliance.sql");
    const highest = migrations[migrations.length - 1];
    expect(highest).toBe("0032_audit_compliance.sql");
    const sql = readFileSync(join(REPO_ROOT, MIGRATION_PATH), "utf8");
    expect(sql).toContain("CREATE SCHEMA audit");
    expect(sql).toContain("audit.audit_records");
    expect(sql).toContain("audit.chain_heads");
    expect(sql).toContain("audit.legal_holds");
    expect(sql).toContain("audit.retention_policies");
  });
});
