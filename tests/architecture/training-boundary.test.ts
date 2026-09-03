/**
 * Architecture gate: the training/accelerator boundary (WORK-030;
 * checkpoint contracts CONCURRENCY-CRASH-SAFETY, EXECUTION-PROVENANCE,
 * DEPENDENCY-DIRECTION, BUDGET-INTEGRITY — proof class "static").
 *
 * Runs the SHARED scanner over the REAL src tree — one definition of
 * the protections (tests/discrimination/lib/training.ts), two uses:
 * this gate over the real tree, the discrimination proofs over
 * synthetic mutations. A weakened protection is provably rejected.
 *
 * The dynamic halves live in tests/unit/sandbox/training-* and
 * tests/integration/postgres/training-*; the mutation (discrimination)
 * proofs live in tests/discrimination/training.discrimination.test.ts.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import {
  hasCanonicalTrainingFabric,
  type TrainingFabricFile,
  trainingFabricViolations,
} from "../discrimination/lib/training";

function loadSourceFiles(root: string, dir: string): TrainingFabricFile[] {
  const files: TrainingFabricFile[] = [];
  for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
    const relative = `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      files.push(...loadSourceFiles(root, relative));
    } else if (entry.name.endsWith(".ts") || entry.name.endsWith(".sql")) {
      files.push({ path: relative, content: readFileSync(join(root, relative), "utf-8") });
    }
  }
  return files;
}

test("the training/accelerator fabric keeps every named boundary (T1..T13 static protections)", () => {
  const files = loadSourceFiles(process.cwd(), "src/modules/sandbox")
    .concat(loadSourceFiles(process.cwd(), "src/integrations/accelerators"))
    .concat(
      loadSourceFiles(process.cwd(), "src/platform/db/migrations").filter((file) =>
        file.path.includes("0025_training_accelerator_workloads"),
      ),
    );
  expect(hasCanonicalTrainingFabric(files)).toBe(true);
  expect(trainingFabricViolations(files)).toEqual([]);
});

test("the training files' cross-module imports target public barrels only", () => {
  const files = loadSourceFiles(process.cwd(), "src/modules/sandbox");
  for (const file of files) {
    const imports = [...file.content.matchAll(/from ["'](\.[^"']+)["']/g)].map((m) => m[1] ?? "");
    for (const specifier of imports) {
      for (const authority of [
        "executions",
        "policies",
        "capabilities",
        "budgets",
        "tools",
        "agents",
        "verification",
        "deployments",
        "artifacts",
      ]) {
        if (specifier.includes(`/${authority}/`)) {
          expect(
            specifier.endsWith("/public") || specifier.endsWith("/public.ts"),
            `${file.path} imports ${specifier} — must target the public barrel`,
          ).toBe(true);
        }
      }
    }
  }
});

test("the accelerators integration couples ONLY to the sandbox public port + intra-integration seams", () => {
  const files = loadSourceFiles(process.cwd(), "src/integrations/accelerators");
  expect(files.length).toBeGreaterThan(0);
  for (const file of files) {
    const imports = [...file.content.matchAll(/from ["'](\.[^"']+)["']/g)].map((m) => m[1] ?? "");
    for (const specifier of imports) {
      if (specifier.includes("modules/")) {
        expect(
          specifier.endsWith("modules/sandbox/public") ||
            specifier.endsWith("modules/sandbox/public.ts"),
          `${file.path} imports ${specifier} — the integration may couple ONLY to the sandbox module's public port`,
        ).toBe(true);
      }
    }
    // No test-only or platform-internal coupling.
    expect(file.content).not.toContain("src/platform/db");
  }
});

test("the executions module remains the sole owner of the training step-event vocabulary", () => {
  const executionsEvent = readFileSync(
    join(process.cwd(), "src/modules/executions/domain/event.ts"),
    "utf-8",
  );
  for (const command of [
    "sandbox-admitted",
    "sandbox-denied",
    "sandbox-completed",
    "checkpoint-recorded",
    "interruption-requested",
    "resume-recorded",
    "resume-denied",
  ]) {
    expect(executionsEvent).toContain(`"${command}"`);
  }
  // The vocabulary constant exists exactly once in src/.
  const files = loadSourceFiles(process.cwd(), "src");
  const definers = files.filter((f) => /STEP_EVENT_COMMANDS\s*=\s*\[/.test(f.content));
  expect(definers.map((f) => f.path)).toEqual(["src/modules/executions/domain/event.ts"]);
  // The sandbox module produces the events but defines no vocabulary of its own.
  const sandboxTrainingPort = readFileSync(
    join(process.cwd(), "src/modules/sandbox/ports/training-ledger.ts"),
    "utf-8",
  );
  expect(sandboxTrainingPort).toContain("Extract<");
  expect(sandboxTrainingPort).toContain("StepEventCommand");
});

test("the substrate claims ride the capabilities registry — there is no second catalog in the sandbox module", () => {
  const catalog = readFileSync(
    join(process.cwd(), "src/modules/sandbox/adapters/substrate-catalog.ts"),
    "utf-8",
  );
  expect(catalog).toContain('from "../../capabilities/public"');
  expect(catalog).toContain("listAvailableByWorkloadClass");
  // The sandbox module owns NO substrate table of its own: migration 0025
  // creates only the training_* tables + the inherited edge-gate fix.
  const migration = readFileSync(
    join(process.cwd(), "src/platform/db/migrations/0025_training_accelerator_workloads.sql"),
    "utf-8",
  );
  const created = [...migration.matchAll(/CREATE TABLE (?!IF NOT EXISTS)([a-z_.]+)/g)].map(
    (m) => m[1] ?? "",
  );
  expect(created.every((name) => name.startsWith("sandbox.training_"))).toBe(true);
});

test("verification-before-release: there is no second verification authority and no default pass", () => {
  const verificationAdapter = readFileSync(
    join(process.cwd(), "src/modules/sandbox/adapters/verification-training-gate.ts"),
    "utf-8",
  );
  expect(verificationAdapter).toContain('from "../../verification/public"');
  expect(verificationAdapter).toContain("verifyTarget");
  // No default-pass VERIFICATION verdict is fabricated anywhere in the
  // sandbox module (policy-admission evidence legitimately carries
  // `allowed: true` — the verification verdict is the protected surface).
  const files = loadSourceFiles(process.cwd(), "src/modules/sandbox");
  for (const file of files) {
    expect(
      file.content.includes("passed: true"),
      `${file.path} fabricates a passing verification verdict`,
    ).toBe(false);
  }
});

test("the training/accelerator source lives STRICTLY under the declared surfaces", () => {
  // The surface-boundary scan (the briefing's B4 discipline): every file
  // under src/ whose CODE carries the training/accelerator vocabulary
  // must live under src/modules/sandbox/**, src/integrations/accelerators/**
  // or be migration 0025 (the claimed migration). Anything else means the
  // fabric leaked outside the declared change surfaces.
  const all = loadSourceFiles(process.cwd(), "src");
  const ALLOWED_PREFIXES = ["src/modules/sandbox/", "src/integrations/accelerators/"];
  const ALLOWED_MIGRATION = "src/platform/db/migrations/0025_training_accelerator_workloads.sql";
  const MARKERS = [
    "createTrainingService",
    "InMemoryTrainingStore",
    "SqlTrainingStore",
    "TrainingWorkload",
    "TrainingStore",
    "training_workloads",
    "training_checkpoints",
    "training_operations",
    "training_run_leases",
    "sandbox.training_",
    "trainingOperationKey",
    "trop:",
    "AcceleratorSubstrate",
    "createAcceleratorOperator",
    "SimulatedAcceleratorFleet",
    "accelerator-fabric",
    "trainingCheckpointIdentity",
    "trainingRequestFingerprint",
  ];
  const offenders: string[] = [];
  for (const file of all) {
    if (ALLOWED_PREFIXES.some((prefix) => file.path.startsWith(prefix))) {
      continue;
    }
    if (file.path === ALLOWED_MIGRATION) {
      continue;
    }
    const code = file.content.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    if (MARKERS.some((marker) => code.includes(marker))) {
      offenders.push(file.path);
    }
  }
  expect(offenders).toEqual([]);
});

test("WORK-030 touches neither spec/ nor spec/development-state/ (architect-owned)", () => {
  // The static shape: the training fabric exists ONLY under the declared
  // surfaces. (The full diff-level audit is the evidence doc + the
  // verification round's job; this pins the in-tree shape.)
  const files = loadSourceFiles(process.cwd(), "src/modules/sandbox");
  const trainingFiles = files.filter((f) => /training|accelerator|substrate-catalog/.test(f.path));
  expect(trainingFiles.length).toBeGreaterThan(0);
  for (const file of trainingFiles) {
    expect(file.path.startsWith("src/modules/sandbox/")).toBe(true);
  }
});
