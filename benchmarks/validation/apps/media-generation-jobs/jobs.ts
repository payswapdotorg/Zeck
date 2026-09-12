/**
 * The pinned media-generation JOB fixtures (VAL-016).
 *
 * A media-generation job is an ordered list of asynchronous
 * media-generation items (each a `generate-video` task payload with a
 * seeded storyboard prompt fixture key and bounded declared
 * parameters). Every job exercises the full asynchronous job
 * semantics the work order pins: submission → polling → retrieval
 * per item, with complete job-level accounting — no lost tasks
 * (every submitted item must reach a terminal status within the
 * bounded completion window or be reported as LOST, never silently
 * dropped) and honest task-failure propagation (a failed item fails
 * the job mechanically; a healthy sibling item still completes and
 * is accounted).
 *
 * Determinism: items reference the SAME seeded fixture keys as the
 * video-generation application (`vid-prompt-XXX` from the VAL-003
 * `prompts-synthetic-video-v1` set) with fixed generation parameters
 * — every dispatch is reproducible at the request level (the platform
 * derives the canonical rail request and its digest). No external
 * media, no free-text prompts, no randomness.
 */

/** One asynchronous media-generation item inside a job. */
export interface MediaJobItem {
  /** Stable item identity within the job (accounting key). */
  readonly itemKey: string;
  /** The submitted task payload (the public-API task shape). */
  readonly task: {
    readonly kind: "generate-video";
    /** The seeded storyboard prompt fixture key. */
    readonly prompt: string;
    /** The declared clip duration in seconds (the zero edge = honest failure). */
    readonly seconds?: number;
    /** The declared aspect ratio. */
    readonly aspect?: "16:9" | "9:16";
  };
  /** The corpus row's own expected terminal for THIS item. */
  readonly expectedItemTerminal: "COMPLETED" | "FAILED";
}

/** One pinned media-generation job with its ground truth. */
export interface MediaGenerationJobDefinition {
  readonly jobId: string;
  readonly items: readonly MediaJobItem[];
  /**
   * The job's expected terminal — must equal the mechanical
   * derivation (all items COMPLETED → COMPLETED; any item FAILED or
   * LOST → FAILED). The unit tests assert this consistency.
   */
  readonly expectedJobTerminal: "COMPLETED" | "FAILED";
  /** Fixture provenance (recorded in evidence). */
  readonly annotation: string;
}

export const MEDIA_GENERATION_JOBS: readonly MediaGenerationJobDefinition[] = [
  {
    jobId: "media-job-001",
    items: [
      {
        itemKey: "clip-a",
        task: { kind: "generate-video", prompt: "vid-prompt-001", seconds: 5, aspect: "16:9" },
        expectedItemTerminal: "COMPLETED",
      },
      {
        itemKey: "clip-b",
        task: { kind: "generate-video", prompt: "vid-prompt-006", seconds: 5, aspect: "9:16" },
        expectedItemTerminal: "COMPLETED",
      },
    ],
    expectedJobTerminal: "COMPLETED",
    annotation:
      "two-item async job: submission -> polling -> retrieval per item, every item accounted (no lost tasks)",
  },
  {
    jobId: "media-job-002",
    items: [
      {
        itemKey: "clip-a",
        task: { kind: "generate-video", prompt: "vid-prompt-003", seconds: 5, aspect: "16:9" },
        expectedItemTerminal: "COMPLETED",
      },
      {
        itemKey: "edge-zero-duration",
        task: { kind: "generate-video", prompt: "vid-prompt-005", seconds: 0 },
        expectedItemTerminal: "FAILED",
      },
    ],
    expectedJobTerminal: "FAILED",
    annotation:
      "task-failure propagation: the zero-duration item fails honestly before any paid dispatch; " +
      "the healthy sibling still completes and is accounted (no lost tasks, no fabricated job success)",
  },
];

/**
 * Derive a job's terminal from its item outcomes — PURE and
 * mechanical: every item COMPLETED → the job COMPLETED; any item
 * FAILED, or any item LOST (no terminal within the bounded
 * completion window), → the job FAILED. A lost item can never
 * silently vanish: it is a job-level failure by construction.
 */
export function deriveMediaJobTerminal(
  items: readonly { readonly terminalStatus: string | null }[],
): "COMPLETED" | "FAILED" {
  for (const item of items) {
    if (item.terminalStatus === null || item.terminalStatus !== "COMPLETED") {
      return "FAILED";
    }
  }
  return "COMPLETED";
}

/** The job table's internal consistency check (pinned ground truth). */
export function jobDefinitionIsConsistent(job: MediaGenerationJobDefinition): boolean {
  const derived = deriveMediaJobTerminal(
    job.items.map((item) => ({ terminalStatus: item.expectedItemTerminal })),
  );
  return derived === job.expectedJobTerminal;
}
