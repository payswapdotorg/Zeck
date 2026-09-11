/**
 * Audit-plane boundary rules (WORK-059) — the pure rule engine used by
 * BOTH the architecture boundary test (over the real tree) and the
 * discrimination suite (over synthetic weakened protections: a
 * weakened form MUST be rejected — the runbook's HIGH_ASSURANCE rule).
 *
 * Rules (each maps to a WORK-059 architecture invariant):
 *
 *  - `no-audit-consultation` (invariant 2): no src/ file OUTSIDE the
 *    audit module imports the audit module — the projection is
 *    consulted by nobody (for authorization or anything else; the
 *    production composition wiring arrives with its own Work Order).
 *  - `evidence-only-vocabulary` (invariant 2): the audit public
 *    barrel, ports and durable store define NO authorization-shaped
 *    method (append/read/export/retention/hold vocabulary only).
 *  - `no-second-ledger` (invariant 2/scope): the audit sources and
 *    migration carry no governed-state vocabulary (no execution-state
 *    string literals in src, no status/state/lifecycle COLUMNS in the
 *    migration — authoritative state stays in the module stores).
 *  - `migration-invariants` (invariant 1): the audit migration pins
 *    the append-only triggers (row UPDATE/DELETE + statement
 *    TRUNCATE), the governed-purge session gate, the closed-vocabulary
 *    CHECKs, the bounded-retention CHECK and the identity/chain
 *    uniqueness constraints.
 *  - `secret-free-sources`: no credential-shaped literals in the audit
 *    surfaces.
 *  - `no-new-sdk` (SELF-HOSTING-BOUNDARY): the audit adapters import
 *    only node builtins and repository-relative modules (no provider
 *    SDK — the SQL store bridges the provider-neutral DatabasePort).
 *  - `vocabulary-sync` (invariant 5): the code vocabularies equal the
 *    migration CHECK lists exactly (completeness is honest and
 *    machine-checked).
 */

import { posix } from "node:path";
import { extractImportSpecifiers, type SourceFile } from "./dependency-rules";

export type AuditRuleId =
  | "no-audit-consultation"
  | "evidence-only-vocabulary"
  | "no-second-ledger"
  | "no-execution-ir-reference"
  | "migration-invariants"
  | "secret-free-sources"
  | "no-new-sdk"
  | "vocabulary-sync";

export interface AuditRuleViolation {
  readonly rule: AuditRuleId;
  readonly path: string;
  readonly detail: string;
}

/** Authorization-shaped method names the audit evidence surfaces must never define. */
const AUTHORIZATION_METHOD_PATTERN =
  /^\s*(?:export\s+)?(?:async\s+)?(?:readonly\s+)?(?:authorize|admit|isAllowed|checkPermission|canTransition|reserveFunds|settleUsage|allowAction|denyAction)\s*[(:<(]/m;

/** Governed-state string literals (the executions state machine — second-ledger vocabulary). */
const EXECUTION_STATE_LITERALS = [
  '"CREATED"',
  '"AUTHORIZED"',
  '"PLANNING"',
  '"QUEUED"',
  '"RUNNING"',
  '"WAITING_TOOL"',
  '"WAITING_USER"',
  '"WAITING_HUMAN"',
  '"VERIFYING"',
  '"REPLANNING"',
  '"COMPLETED"',
  '"FAILED"',
  '"CANCELLED"',
  '"EXPIRED"',
];

const CREDENTIAL_LITERAL_PATTERNS: readonly RegExp[] = [
  /AKIA[0-9A-Z]{16}/,
  /ghp_[A-Za-z0-9]{20,}/,
  /sk-[A-Za-z0-9]{20,}/,
  /(secretAccessKey|apiToken|password|apiKey|clientSecret)\s*[:=]\s*"[^"${}]+"/,
];

/** Which files count as the audit module's evidence-shaped authority surface. */
export function isAuditAuthoritySurface(path: string): boolean {
  return (
    path === "src/modules/audit/public.ts" ||
    path.startsWith("src/modules/audit/ports/") ||
    path === "src/modules/audit/adapters/sql-audit-store.ts" ||
    path === "src/modules/audit/adapters/in-memory-audit-store.ts"
  );
}

export function isAuditFile(path: string): boolean {
  return path.startsWith("src/modules/audit/");
}

export interface AuditRuleOptions {
  /** The audit migration's repository path. */
  readonly migrationPath: string;
  /** The closed vocabularies as declared in code (vocabulary-sync). */
  readonly vocabularies: {
    readonly actionKinds: readonly string[];
    readonly actorKinds: readonly string[];
    readonly targetKinds: readonly string[];
    readonly seams: readonly string[];
  };
}

/** Resolve a relative import the way the dependency engine does (against the scanned set). */
function resolveRelative(fromPath: string, specifier: string, paths: Set<string>): string | null {
  const directory = posix.dirname(fromPath);
  const target = posix.normalize(posix.join(directory, specifier));
  const candidates = [
    target,
    `${target}.ts`,
    target.endsWith(".js") ? `${target.slice(0, -3)}.ts` : `${posix.join(target, "index")}.ts`,
  ];
  for (const candidate of candidates) {
    if (paths.has(candidate)) {
      return candidate;
    }
  }
  return null;
}

export function scanAuditRules(
  files: readonly SourceFile[],
  options: AuditRuleOptions,
): AuditRuleViolation[] {
  const violations: AuditRuleViolation[] = [];
  const report = (rule: AuditRuleId, path: string, detail: string): void => {
    violations.push({ rule, path, detail });
  };

  const migration = files.find((file) => file.path === options.migrationPath);
  const auditFiles = files.filter((file) => isAuditFile(file.path));

  // R1 — nothing outside the audit module consults the projection.
  // (Import-precise: a relative import that RESOLVES into
  // src/modules/audit/ — from a sibling module, the api layer, the
  // platform or an integration — is consultation, whatever the
  // specifier text looks like.)
  const knownPaths = new Set(files.map((file) => file.path));
  for (const file of files) {
    if (isAuditFile(file.path) || !file.path.startsWith("src/")) {
      continue;
    }
    for (const specifier of extractImportSpecifiers(file.content)) {
      if (!specifier.startsWith(".")) {
        continue;
      }
      const resolved = resolveRelative(file.path, specifier, knownPaths);
      if (resolved !== null && resolved.startsWith("src/modules/audit/")) {
        report(
          "no-audit-consultation",
          file.path,
          `imports ${specifier} -> ${resolved}: the audit projection is evidence and is consulted by nobody (composition wiring arrives with its own Work Order)`,
        );
      }
    }
  }

  // R2 — the evidence surfaces define no authorization vocabulary.
  for (const file of auditFiles) {
    if (!isAuditAuthoritySurface(file.path)) {
      continue;
    }
    if (AUTHORIZATION_METHOD_PATTERN.test(file.content)) {
      report(
        "evidence-only-vocabulary",
        file.path,
        "defines an authorization-shaped method: audit surfaces are append/read/export/retention/hold vocabulary only (evidence, never authority)",
      );
    }
  }

  // R3 — no governed-state vocabulary (no second ledger).
  for (const file of auditFiles) {
    for (const literal of EXECUTION_STATE_LITERALS) {
      if (file.content.includes(literal)) {
        report(
          "no-second-ledger",
          file.path,
          `carries the governed execution-state literal ${literal}: authoritative state stays in the module stores, the audit projection is a projection`,
        );
      }
    }
  }
  if (migration !== undefined) {
    if (/\bstatus\s+(text|integer|varchar|boolean)\b/i.test(migration.content)) {
      report(
        "no-second-ledger",
        options.migrationPath,
        "the audit migration defines a status column: audit records are evidence, not a state machine",
      );
    }
    if (
      /\b(state|lifecycle|transition)\s+(text|integer|varchar|boolean)\b/i.test(migration.content)
    ) {
      report(
        "no-second-ledger",
        options.migrationPath,
        "the audit migration defines a state/lifecycle/transition column: audit records are evidence, not a state machine",
      );
    }
  }

  // R3b — the E1.1 seam discipline: the audit module never references
  // the execution-ir plane (WORK-049's B3 boundary — the observer
  // uses STRUCTURAL seam typing, never an import or name reference).
  for (const file of auditFiles) {
    if (file.content.includes("execution-ir")) {
      report(
        "no-execution-ir-reference",
        file.path,
        "references the execution-ir plane: module files never depend on the decision-record foundation (structural seam typing only)",
      );
    }
  }

  // R4 — the migration pins the physical invariants.
  if (migration === undefined) {
    report(
      "migration-invariants",
      options.migrationPath,
      "the audit migration is missing from the scanned tree",
    );
  } else {
    const content = migration.content;
    const required: readonly [string, string][] = [
      ["audit.audit_records_append_only", "the append-only trigger function"],
      [
        "BEFORE UPDATE OR DELETE ON audit.audit_records",
        "the row-level mutation-rejecting trigger",
      ],
      ["BEFORE TRUNCATE ON audit.audit_records", "the statement-level TRUNCATE-rejecting trigger"],
      ["audit.governed_purge", "the governed-purge session gate"],
      ["UNIQUE (application_id, record_id)", "the identity uniqueness constraint"],
      ["UNIQUE (application_id, chain_sequence)", "the gapless chain uniqueness constraint"],
      ["retention_days >= 1 AND retention_days <= 3650", "the bounded-retention CHECK"],
      ["REFERENCES applications.applications (id, tenant_id)", "the tenant composite FK"],
    ];
    for (const [needle, what] of required) {
      if (!content.includes(needle)) {
        report("migration-invariants", options.migrationPath, `missing ${what} (${needle})`);
      }
    }
  }

  // R5 — secret-free sources (audit surfaces + migration).
  for (const file of [...auditFiles, ...(migration !== undefined ? [migration] : [])]) {
    for (const pattern of CREDENTIAL_LITERAL_PATTERNS) {
      if (pattern.test(file.content)) {
        report(
          "secret-free-sources",
          file.path,
          `carries a credential-shaped literal (${pattern.source}) — secrets never live in sources`,
        );
      }
    }
  }

  // R6 — no new SDK: the audit module imports only node builtins + relative.
  for (const file of auditFiles) {
    const specifiers = [...file.content.matchAll(/from\s+["']([^"']+)["']/g)].map(
      (m) => m[1] ?? "",
    );
    for (const specifier of specifiers) {
      if (!specifier.startsWith(".") && !specifier.startsWith("node:")) {
        report(
          "no-new-sdk",
          file.path,
          `imports the external package "${specifier}": the audit module bridges the provider-neutral DatabasePort only`,
        );
      }
    }
  }

  // R7 — vocabulary-sync: the code vocabularies equal the migration CHECKs.
  if (migration !== undefined) {
    const checkLists: readonly [readonly string[], string][] = [
      [options.vocabularies.actionKinds, "action"],
      [options.vocabularies.actorKinds, "actor"],
      [options.vocabularies.targetKinds, "target"],
      [options.vocabularies.seams, "seam"],
    ];
    for (const [vocabulary, what] of checkLists) {
      for (const entry of vocabulary) {
        if (!migration.content.includes(`'${entry}'`)) {
          report(
            "vocabulary-sync",
            options.migrationPath,
            `the code ${what} vocabulary entry "${entry}" is not CHECK-bound in the migration (completeness drift)`,
          );
        }
      }
    }
  }

  return violations;
}
