/**
 * Shared training/accelerator fabric scanner (WORK-030).
 *
 * Used by BOTH the architecture gate
 * (tests/architecture/training-boundary.test.ts) and the discrimination
 * proofs (tests/discrimination/training.discrimination.test.ts) — one
 * definition of each protection, two uses, so a weakened protection is
 * provably rejected (the WORK-003/006/007/012 scanner discipline).
 *
 * Every violation id corresponds to a named WORK-030 boundary:
 *
 *   T1  budget/resource admission removed from the submission path
 *       (or reordered after the paid allocation)
 *   T2  the budget denial stops failing closed (no durable denied row)
 *   T3  verification-before-release gate removed (completion alone
 *       would release)
 *   T4  a non-completed (e.g. FAILED) workload becomes releasable
 *   T5  the release binding stops being write-once
 *   T6  vendor vocabulary leaks into the neutral contracts
 *   T7  a second execution identity appears (direct executions table
 *       writes / missing execution binding)
 *   T8  the checkpoint identity stops being content-addressed
 *   T9  the admitted runtime metadata becomes mutable
 *   T10 the durable operation discipline is removed
 *   T11 the run-lease discipline is removed
 *   T12 the accelerators integration stops implementing the neutral
 *       port only (authority/store/SQL leaking into the adapter)
 *   T13 the simulated-substrate UNVERIFIED honesty declaration is
 *       removed
 */

export interface TrainingFabricFile {
  /** POSIX path relative to the repository root. */
  readonly path: string;
  readonly content: string;
}

export type TrainingFabricViolation = string;

/** Strip comments so prose cannot satisfy code-shape assertions. */
export function codeOnly(content: string): string {
  return content.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

/** The canonical protected files the scanner reasons about. */
export const TRAINING_CANONICAL_PATHS = [
  "src/modules/sandbox/domain/workload.ts",
  "src/modules/sandbox/application/training-service.ts",
  "src/modules/sandbox/ports/accelerator-substrate.ts",
  "src/modules/sandbox/ports/training-admission.ts",
  "src/modules/sandbox/ports/training-ledger.ts",
  "src/modules/sandbox/ports/training-store.ts",
  "src/modules/sandbox/ports/training-verification.ts",
  "src/modules/sandbox/adapters/policy-training-admission.ts",
  "src/modules/sandbox/adapters/substrate-catalog.ts",
  "src/modules/sandbox/adapters/training-execution-ledger.ts",
  "src/modules/sandbox/adapters/verification-training-gate.ts",
  "src/modules/sandbox/adapters/sql-training-store.ts",
  "src/modules/sandbox/adapters/in-memory-training-store.ts",
  "src/integrations/accelerators/public.ts",
  "src/integrations/accelerators/domain/accelerator.ts",
  "src/integrations/accelerators/ports/accelerator-fleet.ts",
  "src/integrations/accelerators/adapters/accelerator-operator.ts",
  "src/integrations/accelerators/adapters/accelerator-substrate-runtime.ts",
  "src/integrations/accelerators/adapters/simulated-accelerator-fleet.ts",
  "src/platform/db/migrations/0025_training_accelerator_workloads.sql",
] as const;

/** Vendor/accelerator product vocabulary that must NEVER cross the contracts. */
const VENDOR_TOKENS = [
  "nvidia",
  "cuda",
  "tpu",
  "h100",
  "a100",
  "v100",
  "b200",
  "mi300",
  "mi250",
  "habana",
  "rocm",
  "coral",
  "jetson",
  "tensorflow",
  "pytorch",
  "jaxlib",
];

export function hasCanonicalTrainingFabric(files: readonly TrainingFabricFile[]): boolean {
  const paths = new Set(files.map((f) => f.path));
  return TRAINING_CANONICAL_PATHS.every((path) => paths.has(path));
}

/**
 * Scan a source tree (the training fabric files) for WORK-030 boundary
 * violations. Pure: returns the violation ids (empty = clean).
 */
export function trainingFabricViolations(
  files: readonly TrainingFabricFile[],
): TrainingFabricViolation[] {
  const violations: TrainingFabricViolation[] = [];
  const byPath = new Map(files.map((f) => [f.path, f] as const));
  const service = byPath.get("src/modules/sandbox/application/training-service.ts");
  const domain = byPath.get("src/modules/sandbox/domain/workload.ts");
  const migration = byPath.get(
    "src/platform/db/migrations/0025_training_accelerator_workloads.sql",
  );
  const sqlStore = byPath.get("src/modules/sandbox/adapters/sql-training-store.ts");
  const inMemoryStore = byPath.get("src/modules/sandbox/adapters/in-memory-training-store.ts");
  const ledgerAdapter = byPath.get("src/modules/sandbox/adapters/training-execution-ledger.ts");
  const verificationAdapter = byPath.get(
    "src/modules/sandbox/adapters/verification-training-gate.ts",
  );
  const runtimeAdapter = byPath.get(
    "src/integrations/accelerators/adapters/accelerator-substrate-runtime.ts",
  );
  const simulatedFleet = byPath.get(
    "src/integrations/accelerators/adapters/simulated-accelerator-fleet.ts",
  );

  // ---- T1/T2: budget BEFORE paid allocation (the service shape) ----
  if (service !== undefined) {
    const code = codeOnly(service.content);
    const reserveIndex = code.indexOf("budgetAuthority.reserve");
    const allocateIndex = code.indexOf("runtime.allocate");
    if (reserveIndex === -1) {
      violations.push("training-budget-before-allocation");
    } else if (allocateIndex !== -1 && allocateIndex < reserveIndex) {
      violations.push("training-budget-before-allocation");
    }
    if (!code.includes("training-reserve:")) {
      violations.push("training-budget-before-allocation");
    }
    if (!code.includes('error.code === "BUDGET_EXCEEDED"') || !code.includes('"budget"')) {
      violations.push("training-budget-denial-fail-closed");
    }
    // ---- T3/T4: verification before release (the release shape) ----
    const verifyIndex = code.indexOf("verification.verify");
    const passedGuard = code.indexOf("!verdict.passed");
    const bindRelease = code.indexOf("bindWorkloadRelease");
    if (verifyIndex === -1 || passedGuard === -1) {
      violations.push("training-verification-before-release");
    } else if (bindRelease !== -1 && bindRelease < passedGuard) {
      violations.push("training-verification-before-release");
    }
    if (code.split("bindWorkloadRelease").length - 1 !== 1) {
      violations.push("training-verification-before-release");
    }
    if (!code.includes('status !== "completed"')) {
      violations.push("training-failed-never-released");
    }
  } else {
    violations.push("training-budget-before-allocation", "training-verification-before-release");
  }

  // ---- T5: the release binding is write-once (migration + stores) ----
  if (migration === undefined || !migration.content.includes("tw_release_shape")) {
    violations.push("training-release-write-once");
  }
  if (
    migration === undefined ||
    !/OLD\.verified_release_at IS NOT NULL AND \(NEW\.verified_release_at <> OLD\.verified_release_at/.test(
      migration.content,
    )
  ) {
    violations.push("training-release-write-once");
  }
  if (inMemoryStore === undefined || !inMemoryStore.content.includes("never re-bound")) {
    violations.push("training-release-write-once");
  }

  // ---- T6: vendor neutrality (code shape only, comments stripped;
  // whole-word matching so e.g. "output" never matches "tpu") ----
  for (const file of files) {
    if (
      !file.path.startsWith("src/modules/sandbox/") &&
      !file.path.startsWith("src/integrations/accelerators/")
    ) {
      continue;
    }
    const code = file.path.endsWith(".sql") ? file.content : codeOnly(file.content);
    for (const token of VENDOR_TOKENS) {
      const pattern = new RegExp(`\\b${token}\\b`, "i");
      if (pattern.test(code)) {
        violations.push(`training-vendor-neutral:${file.path}:${token}`);
      }
    }
  }

  // ---- T7: one execution identity (the ledger seam, no direct writes) ----
  if (
    ledgerAdapter === undefined ||
    !codeOnly(ledgerAdapter.content).includes("service.recordStepEvent")
  ) {
    violations.push("training-single-execution-identity");
  }
  if (sqlStore !== undefined) {
    const code = codeOnly(sqlStore.content);
    if (/\b(UPDATE|INSERT INTO|DELETE FROM)\s+(executions|platform)\./i.test(code)) {
      violations.push("training-single-execution-identity");
    }
  }
  if (
    migration === undefined ||
    !migration.content.includes("REFERENCES executions.executions (id, application_id)")
  ) {
    violations.push("training-single-execution-identity");
  }

  // ---- T8: the checkpoint identity is content-addressed ----
  if (domain === undefined || !domain.content.includes("zeck:training-checkpoint:v1:")) {
    violations.push("training-checkpoint-content-addressed");
  }
  if (migration === undefined || !migration.content.includes("tc_identity_unique")) {
    violations.push("training-checkpoint-content-addressed");
  }
  if (
    sqlStore === undefined ||
    !sqlStore.content.includes("ON CONFLICT (application_id, content_digest) DO NOTHING")
  ) {
    violations.push("training-checkpoint-content-addressed");
  }

  // ---- T9: the admitted runtime metadata is immutable ----
  if (
    migration === undefined ||
    !migration.content.includes("NEW.runtime_metadata <> OLD.runtime_metadata")
  ) {
    violations.push("training-immutable-runtime-metadata");
  }

  // ---- T10: the durable operation discipline ----
  if (
    migration === undefined ||
    !migration.content.includes("to_lifecycle") ||
    !migration.content.includes("to_key_unique")
  ) {
    violations.push("training-operation-discipline");
  }

  // ---- T11: the run-lease discipline ----
  if (
    migration === undefined ||
    !migration.content.includes("tl_lease_guards") ||
    !/NEW\.epoch < OLD\.epoch/.test(migration.content)
  ) {
    violations.push("training-lease-discipline");
  }

  // ---- T12: the accelerators integration implements the neutral port only ----
  if (runtimeAdapter !== undefined) {
    const code = codeOnly(runtimeAdapter.content);
    if (!code.includes('from "../../../modules/sandbox/public"')) {
      violations.push("accelerators-implements-neutral-port-only");
    }
    if (/\b(INSERT INTO|SELECT .* FROM|UPDATE .* SET|CREATE TABLE|DatabasePort)\b/i.test(code)) {
      violations.push("accelerators-implements-neutral-port-only");
    }
  } else {
    violations.push("accelerators-implements-neutral-port-only");
  }
  if (simulatedFleet !== undefined) {
    const code = codeOnly(simulatedFleet.content);
    if (/\b(INSERT INTO|DatabasePort|Sql[A-Z]|Client)\b/.test(code)) {
      violations.push("accelerators-implements-neutral-port-only");
    }
  }

  // ---- T13: the simulated-substrate UNVERIFIED honesty is pinned in-tree ----
  if (
    simulatedFleet === undefined ||
    !/UNVERIFIED/.test(simulatedFleet.content) ||
    !/WORK-030\.md|docs\/work-items/.test(simulatedFleet.content)
  ) {
    violations.push("training-simulated-substrate-unverified-pinned");
  }

  return violations;
}
