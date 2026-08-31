/**
 * Shared tool-synthesis boundary scanners (WORK-018).
 *
 * Used by BOTH the architecture gate (over the real `src/` tree) and
 * the discrimination proofs (over mutated real source) — one
 * definition of the protection, two uses, so a weakened protection is
 * provably rejected (the provider-neutrality precedent).
 */

import { readFileSync } from "node:fs";

export interface SourceFileLike {
  readonly path: string;
  readonly content: string;
}

/** Patterns that denote DIRECT code execution (raw literals). */
const EXECUTION_SURFACE: readonly RegExp[] = [
  /\bspawn\s*\(/,
  /\beval\s*\(/,
  /\bnew\s+Function\s*\(/,
  /child_process/,
  /worker_threads/,
  /\bfetch\s*\(/,
  /\bexec\s*\(/,
  /\bexecSync\s*\(/,
];

/** S1: no execution surface outside the sandbox seam (criterion 2). */
export function executionSurfaceViolations(files: readonly SourceFileLike[]): string[] {
  const violations: string[] = [];
  for (const file of files) {
    if (!file.path.startsWith("src/modules/tools/")) continue;
    for (const pattern of EXECUTION_SURFACE) {
      if (pattern.test(file.content)) {
        violations.push(`${file.path}: ${pattern.source}`);
      }
    }
  }
  return violations;
}

/**
 * S2: the executor's only implementation wraps the sandbox manager.
 * Returns violations: the wrapper file missing the sandbox-public
 * import/dispatch tokens, or any OTHER file implementing the port.
 */
export function executorImplementationViolations(files: readonly SourceFileLike[]): string[] {
  const violations: string[] = [];
  const wrapper = files.find(
    (f) => f.path === "src/modules/tools/adapters/synthesis-sandbox-executor.ts",
  );
  if (wrapper === undefined) {
    violations.push("missing: src/modules/tools/adapters/synthesis-sandbox-executor.ts");
  } else {
    if (!wrapper.content.includes('from "../../sandbox/public"')) {
      violations.push(`${wrapper.path}: sandbox-public import removed`);
    }
    if (!wrapper.content.includes("createSandboxExecution")) {
      violations.push(`${wrapper.path}: sandbox create path removed`);
    }
    if (!wrapper.content.includes("dispatchSandboxExecution")) {
      violations.push(`${wrapper.path}: sandbox dispatch path removed`);
    }
  }
  for (const file of files) {
    if (
      file.path.startsWith("src/modules/tools/") &&
      !file.path.endsWith("synthesis-sandbox-executor.ts") &&
      !file.path.endsWith("synthesis-sandbox.ts") &&
      /SynthesisSandboxExecutor/.test(file.content) &&
      /execute\s*\(\s*dispatch[^)]*\)\s*:\s*Promise<SynthesisSandboxResult>/.test(file.content)
    ) {
      violations.push(`${file.path}: a second executor implementation`);
    }
  }
  return violations;
}

/**
 * S3: the synthesis service deps are exactly the pinned set — no
 * authority seam is reachable, no bypass executor swap.
 */
export const PINNED_SYNTHESIS_DEPS = [
  "adapterFactory",
  "digest",
  "generateId",
  "now",
  "registry",
  "sandbox",
  "store",
] as const;

export function synthesisDepsViolations(serviceSource: string): string[] {
  const violations: string[] = [];
  const depsMatch = /export interface SynthesisServiceDeps \{([\s\S]*?)\n\}/.exec(serviceSource);
  if (depsMatch === null) {
    return ["SynthesisServiceDeps interface not found"];
  }
  const depNames = [...(depsMatch[1] ?? "").matchAll(/readonly (\w+):/g)]
    .map((m) => m[1] ?? "")
    .sort();
  if (JSON.stringify(depNames) !== JSON.stringify([...PINNED_SYNTHESIS_DEPS])) {
    violations.push(`deps are ${JSON.stringify(depNames)}, expected the pinned set`);
  }
  for (const forbidden of [
    "ToolAdmission",
    "BudgetAuthority",
    "ToolCapabilityResolution",
    "ExecutionService",
    "nextState",
    "canTransition",
  ]) {
    if (serviceSource.includes(forbidden)) {
      violations.push(`service mentions the authority seam ${forbidden}`);
    }
  }
  return violations;
}

/** S6: the synthesized-program lifecycle vocabulary is confined to tools. */
export function lifecycleVocabularyViolations(files: readonly SourceFileLike[]): string[] {
  const violations: string[] = [];
  for (const file of files) {
    if (!file.path.startsWith("src/modules/") || file.path.startsWith("src/modules/tools/")) {
      continue;
    }
    if (/SynthesizedProgram(Record|Status|Store)/.test(file.content)) {
      violations.push(`${file.path}: synthesized-program vocabulary leaked`);
    }
  }
  return violations;
}

/** Convenience: read the real synthesis service source. */
export function readRealServiceSource(root: string): string {
  return readFileSync(`${root}/src/modules/tools/application/synthesis-service.ts`, "utf8");
}
