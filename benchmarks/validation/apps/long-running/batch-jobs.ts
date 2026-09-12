/**
 * The synthetic batch-job fixtures (VAL-013) with ground truths.
 *
 * Each job is an ordered list of items whose effects are DETERMINISTIC
 * (the driver's in-lab effect journal counts each item's application).
 * The interruption directive tells the driver where the interruption
 * lands; the ground truth pins the expected terminal, the expected
 * effect counts (exactly-once per item across interruptions), and the
 * fault-injection semantics for the corrupted-checkpoint edge (the
 * corpus's designed failure).
 */

export interface BatchJobDefinition {
  readonly jobId: string;
  readonly items: readonly string[];
  /** Where the interruption lands. */
  readonly interrupt:
    | "after-checkpoint-1"
    | "mid-item-3"
    | "twice"
    | "corrupt-checkpoint"
    | "stale-worker"
    | "before-final"
    | "none";
  /** True when the scenario replays a no-op resume after terminal. */
  readonly resumeAfterTerminal?: boolean;
  readonly expectedTerminal: "COMPLETED" | "FAILED";
}

export const BATCH_JOBS: readonly BatchJobDefinition[] = [
  {
    jobId: "job-001",
    items: ["alpha", "bravo", "charlie", "delta"],
    interrupt: "after-checkpoint-1",
    expectedTerminal: "COMPLETED",
  },
  {
    jobId: "job-002",
    items: ["alpha", "bravo", "charlie", "delta", "echo"],
    interrupt: "mid-item-3",
    expectedTerminal: "COMPLETED",
  },
  {
    jobId: "job-003",
    items: ["alpha", "bravo", "charlie", "delta"],
    interrupt: "twice",
    expectedTerminal: "COMPLETED",
  },
  {
    jobId: "job-005",
    items: ["alpha", "bravo", "charlie", "delta"],
    interrupt: "corrupt-checkpoint",
    expectedTerminal: "FAILED",
  },
  {
    jobId: "job-006",
    items: ["alpha", "bravo", "charlie"],
    interrupt: "stale-worker",
    expectedTerminal: "COMPLETED",
  },
  {
    jobId: "job-007",
    items: ["alpha", "bravo"],
    interrupt: "none",
    resumeAfterTerminal: true,
    expectedTerminal: "COMPLETED",
  },
];

/** The app's pinned task payloads (the public-API task shapes). */
export const LONG_RUNNING_TASKS = BATCH_JOBS.map((job) => ({
  kind: "long-run" as const,
  job: job.jobId,
  ...(job.resumeAfterTerminal === true
    ? { resume: "after-terminal" as const }
    : { interrupt: job.interrupt }),
})) as readonly { kind: "long-run"; job: string; interrupt?: string; resume?: string }[];

/** The deterministic item effect (the exactly-once journal entry). */
export function effectOf(jobId: string, item: string): string {
  return `${jobId}:${item}:applied`;
}
