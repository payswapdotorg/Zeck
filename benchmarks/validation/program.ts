/**
 * Zeck validation program — the deterministic entrypoint (VAL-001).
 *
 * VALIDATION = EVIDENCE, NEVER AUTHORITY: this module is a pure projection
 * of the validation program's governed identity. It names the canonical
 * governing documents, the stage table and the concurrency ceiling exactly
 * as the Architect issued them (`docs/VALIDATION-ROADMAP.md`,
 * `docs/LLM-VALIDATION-TECH-LEAD-CONTRACT.md`,
 * `spec/validation-state/*`). It creates no second authority: it mutates
 * nothing, reads nothing at import time and derives everything from its
 * inputs, so the same inputs always produce the same entrypoint
 * descriptor.
 *
 * SELF-CONTAINED: the validation lab under `benchmarks/validation/` owns
 * the customer-style validation contracts and must stay independent of
 * product module internals — the lab consumes the same public artifacts
 * (roadmap, contract, state JSON, the public SDK in later work orders)
 * a fresh Tech Lead or an external reviewer would read.
 */

/** The governed identity of the validation program. */
export const VALIDATION_PROGRAM = {
  program: "zeck-validation",
  repository: "payswapdotorg/Zeck",
  authority: "Architect / LLM Tech Lead",
  status: "active",
  /** The canonical governing documents (repository-relative paths). */
  canonicalDocuments: {
    roadmap: "docs/VALIDATION-ROADMAP.md",
    techLeadContract: "docs/LLM-VALIDATION-TECH-LEAD-CONTRACT.md",
    cumulativeReport: "docs/VALIDATION-REPORT.md",
    programState: "spec/validation-state/program-state.json",
    frontierState: "spec/validation-state/frontier-state.json",
    dependencyState: "spec/validation-state/dependency-state.json",
    workOrderDirectory: "spec/validation-work-orders",
  },
  /** Maximum concurrent validation workers (roadmap three-worker rule). */
  maxConcurrentWorkers: 3,
  /** The validation stages, in execution order. */
  stages: [
    { id: "VAL-000", name: "Program governance" },
    { id: "VAL-001..009", name: "Validation laboratory foundations" },
    { id: "VAL-010..019", name: "Customer-style application portfolio" },
    { id: "VAL-020..029", name: "Reliability, adversarial and soak validation" },
    { id: "VAL-030..039", name: "Longitudinal learning and deterministicization" },
    { id: "VAL-040..049", name: "Cost, quality and competition economics" },
    { id: "VAL-050..052", name: "Final report, pilot and release gate" },
  ],
} as const;

/** The shape of one governed validation state snapshot (three files). */
export interface ValidationStateSnapshot {
  readonly program: ProgramStateFile;
  readonly frontier: FrontierStateFile;
  readonly dependencies: DependencyStateFile;
}

export interface ProgramStateFile {
  readonly schemaVersion: number;
  readonly program: string;
  readonly status: string;
  readonly maxConcurrentWorkers: number;
  readonly workOrders: Readonly<Record<string, { status: string; title: string }>>;
}

export interface FrontierStateFile {
  readonly schemaVersion: number;
  readonly program: string;
  readonly status: string;
  readonly eligible: readonly string[];
  readonly inFlight: readonly string[];
  readonly blocked: readonly string[];
  readonly maxConcurrentWorkers: number;
}

export interface DependencyStateFile {
  readonly schemaVersion: number;
  readonly program: string;
  readonly dependencies: Readonly<Record<string, readonly string[]>>;
}

/**
 * Resolve the deterministic program entrypoint descriptor.
 *
 * Pure: the same state snapshot always yields the same descriptor; a
 * snapshot from a different repository revision yields a different
 * descriptor (the base revision is part of the input).
 */
export function resolveProgramEntrypoint(input: {
  readonly baseRevision: string;
  readonly state: ValidationStateSnapshot;
}): {
  readonly program: string;
  readonly baseRevision: string;
  readonly roadmap: string;
  readonly techLeadContract: string;
  readonly workOrderCount: number;
  readonly inFlight: readonly string[];
  readonly eligible: readonly string[];
  readonly maxConcurrentWorkers: number;
} {
  return {
    program: VALIDATION_PROGRAM.program,
    baseRevision: input.baseRevision,
    roadmap: VALIDATION_PROGRAM.canonicalDocuments.roadmap,
    techLeadContract: VALIDATION_PROGRAM.canonicalDocuments.techLeadContract,
    workOrderCount: Object.keys(input.state.program.workOrders).length,
    inFlight: [...input.state.frontier.inFlight],
    eligible: [...input.state.frontier.eligible],
    maxConcurrentWorkers: VALIDATION_PROGRAM.maxConcurrentWorkers,
  };
}
