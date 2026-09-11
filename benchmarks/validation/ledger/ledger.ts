/**
 * The longitudinal experiment ledger (VAL-007, acceptance criteria
 * 1-3).
 *
 * An append-only registry of experiments — repeated workload replays,
 * learning trials, shadow/canary comparisons — each binding immutable
 * run identities to a declared hypothesis and a cohort definition.
 * History NEVER mutates: corrections are new ledger entries, and
 * tampering is detected mechanically via content digests (criterion
 * 5).
 */

import { createHash } from "node:crypto";

/** The experiment kinds the ledger tracks. */
export const EXPERIMENT_KINDS = [
  "repeated-replay",
  "learning-trial",
  "shadow-comparison",
  "canary-comparison",
  "baseline-measurement",
] as const;

export type ExperimentKind = (typeof EXPERIMENT_KINDS)[number];

/** A cohort definition: which runs belong to the experiment. */
export interface CohortDefinition {
  readonly corpusSlice: string;
  /** Frozen application revision(s) under test. */
  readonly applicationRevisions: readonly string[];
  /** Controlled repetition count per task. */
  readonly repetitions: number;
  /** The comparison arm (baseline/candidate) — single-arm for replays. */
  readonly arm: string;
}

/** One registered experiment (immutable). */
export interface ExperimentEntry {
  /** Stable identity: `exp-<kind>-<sha8>`. */
  readonly experimentId: string;
  readonly kind: ExperimentKind;
  readonly hypothesis: string;
  readonly cohort: CohortDefinition;
  readonly registeredAt: string;
  /** Content digest of the registration (tamper detection). */
  readonly digest: string;
}

/** One immutable run attachment (append-only). */
export interface RunAttachment {
  readonly experimentId: string;
  readonly runId: string;
  readonly runRevision: number;
  readonly attachedAt: string;
}

/** One ledger rejection finding. */
export interface LedgerViolation {
  readonly path: string;
  readonly reason: string;
}

const NON_EMPTY = /^.+$/;

/**
 * Register an experiment: the entry is content-digested and frozen.
 * Re-registration with the same identity is an error (append-only).
 */
export function registerExperiment(input: {
  readonly kind: ExperimentKind;
  readonly hypothesis: string;
  readonly cohort: CohortDefinition;
  readonly registeredAt: string;
}): ExperimentEntry {
  if (!EXPERIMENT_KINDS.includes(input.kind)) {
    throw new Error(`unknown experiment kind ${String(input.kind)}`);
  }
  if (!NON_EMPTY.test(input.hypothesis)) {
    throw new Error("an experiment must declare its hypothesis");
  }
  if (!Number.isInteger(input.cohort.repetitions) || input.cohort.repetitions < 1) {
    throw new Error("a cohort must declare a positive repetition count");
  }
  if (input.cohort.applicationRevisions.length === 0) {
    throw new Error("a cohort must freeze at least one application revision");
  }
  if (!NON_EMPTY.test(input.cohort.corpusSlice)) {
    throw new Error("a cohort must declare its corpus slice");
  }
  const digestBase = canonicalJson({
    kind: input.kind,
    hypothesis: input.hypothesis,
    cohort: input.cohort,
  });
  const digest = `sha256:${createHash("sha256").update(digestBase).digest("hex")}`;
  return Object.freeze({
    experimentId: `exp-${input.kind}-${digest.slice(7, 15)}`,
    kind: input.kind,
    hypothesis: input.hypothesis,
    cohort: input.cohort,
    registeredAt: input.registeredAt,
    digest,
  });
}

/**
 * The append-only ledger. Attachments bind run identities to
 * experiments immutably; re-attaching the same run is an error, and a
 * run already attached to a DIFFERENT experiment is refused (cohort
 * contamination guard).
 */
export class ExperimentLedger {
  private readonly experiments = new Map<string, ExperimentEntry>();
  private readonly attachments: RunAttachment[] = [];
  private readonly runsAttached = new Map<string, string>();

  register(entry: ExperimentEntry): void {
    // ALWAYS verify the content digest first: a copied digest with
    // mutated content is a tamper, never a valid re-registration.
    this.verifyDigest(entry);
    const existing = this.experiments.get(entry.experimentId);
    if (existing !== undefined) {
      if (existing.digest !== entry.digest) {
        throw new Error(
          `append-only violation: experiment ${entry.experimentId} already registered with different content`,
        );
      }
      return;
    }
    this.experiments.set(entry.experimentId, entry);
  }

  /** Attach a run (identity + revision) to an experiment. */
  attach(input: {
    readonly experimentId: string;
    readonly runId: string;
    readonly runRevision: number;
    readonly attachedAt: string;
  }): void {
    if (!this.experiments.has(input.experimentId)) {
      throw new Error(`unknown experiment ${input.experimentId}`);
    }
    const owner = this.runsAttached.get(input.runId);
    if (owner === input.experimentId) {
      throw new Error(`run ${input.runId} is already attached to ${input.experimentId}`);
    }
    if (owner !== undefined) {
      throw new Error(`cohort contamination: run ${input.runId} already belongs to ${owner}`);
    }
    const attachment: RunAttachment = { ...input };
    this.attachments.push(attachment);
    this.runsAttached.set(input.runId, input.experimentId);
  }

  /** The experiments in registration order (immutable entries). */
  experimentsList(): readonly ExperimentEntry[] {
    return [...this.experiments.values()];
  }

  /** The attachments of one experiment, in order. */
  attachmentsOf(experimentId: string): readonly RunAttachment[] {
    return this.attachments.filter((a) => a.experimentId === experimentId);
  }

  /** Ledger integrity (criterion 5): every digest verifies, no double-attach. */
  integrity(): readonly LedgerViolation[] {
    const violations: LedgerViolation[] = [];
    const seen = new Map<string, number>();
    for (const attachment of this.attachments) {
      const count = (seen.get(attachment.runId) ?? 0) + 1;
      seen.set(attachment.runId, count);
      if (count > 1) {
        violations.push({
          path: `attachment:${attachment.runId}`,
          reason: "run attached more than once",
        });
      }
    }
    for (const entry of this.experiments.values()) {
      try {
        this.verifyDigest(entry);
      } catch (error) {
        violations.push({
          path: `experiment:${entry.experimentId}`,
          reason: error instanceof Error ? error.message : "digest mismatch",
        });
      }
    }
    return violations;
  }

  /**
   * Export one experiment's cohort dataset: the attachment set with
   * the frozen cohort definition (criterion 4 — the analysis input).
   */
  exportCohort(experimentId: string): {
    readonly experiment: ExperimentEntry;
    readonly attachments: readonly RunAttachment[];
  } | null {
    const experiment = this.experiments.get(experimentId);
    if (experiment === undefined) {
      return null;
    }
    return { experiment, attachments: this.attachmentsOf(experimentId) };
  }

  private verifyDigest(entry: ExperimentEntry): void {
    const recomputed = `sha256:${createHash("sha256")
      .update(
        canonicalJson({
          kind: entry.kind,
          hypothesis: entry.hypothesis,
          cohort: entry.cohort,
        }),
      )
      .digest("hex")}`;
    if (recomputed !== entry.digest) {
      throw new Error(`tamper detected: experiment ${entry.experimentId} digest mismatch`);
    }
  }
}

/** Canonical JSON: sorted keys, no insignificant whitespace. */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}
