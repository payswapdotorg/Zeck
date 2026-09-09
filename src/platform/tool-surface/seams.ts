/**
 * The declared minimal module seam of the tool-surface plane (platform
 * tool-surface plane; WORK-051).
 *
 * Following the WORK-048/049 seam precedent: this platform plane
 * defines a NEUTRAL seam CONTRACT; the owning module implements it
 * inside its own adapter layer over its own authority
 * (`src/platform/**` never imports a module).
 *
 * `SandboxComputeSeam` is the ONLY path bounded programmatic work
 * takes into the EXISTING sandbox authority: the module-side adapter
 * (sandbox module, `adapters/tool-surface-compute-seam.ts`) implements
 * it by wrapping the sandbox module's PUBLIC `SandboxService` +
 * `EnvironmentCatalog` verbatim — every programmatic run is a FULLY
 * ADMITTED, DISPATCHED AND JOURNALED sandbox execution (policy →
 * capability → budget admission chain, durable identity, ledger
 * evidence envelopes, provider dispatch, timeout enforcement, bounded
 * output evidence). There is NO second sandbox, NO escape path and NO
 * capability widening anywhere in this plane: the seam is a contract,
 * the authority is the sandbox module's own, consulted exactly as-is.
 *
 * No module may depend on this plane for authority (asserted by the
 * architecture boundary tests; the only module-side reference to this
 * plane is the ONE declared seam adapter file).
 */

import type { ProgrammaticInput, ProgrammaticSpec } from "./programmatic";

// ---------------------------------------------------------------------------
// The seam request/observation (neutral, bounded, typed)
// ---------------------------------------------------------------------------

/** The execution scope the sandbox authority binds the run to. */
export interface ProgrammaticSandboxScope {
  /** The parent governed execution (the sandbox's own binding rule). */
  readonly executionId: string;
  /** The target compute environment (registered in the catalog). */
  readonly environmentId: string;
  /** The idempotency key: the same logical run replays the same outcome. */
  readonly idempotencyKey: string;
  readonly actor: {
    readonly actorId: string;
    readonly applicationId: string;
    readonly tenantId: string;
  };
}

/**
 * One bounded programmatic run submitted into the sandbox authority.
 * The spec and input are ALREADY VALIDATED (closed vocabulary, bounded,
 * typed) when they cross this seam — the adapter materializes them into
 * the sandbox task shape (its own composition choice, like the
 * synthesis executor's runner wiring).
 */
export interface ProgrammaticSandboxRequest {
  readonly scope: ProgrammaticSandboxScope;
  readonly spec: ProgrammaticSpec;
  readonly input: ProgrammaticInput;
}

/** The sandbox-axis outcome classes of a programmatic run. */
export const PROGRAMMATIC_SANDBOX_STATUSES = [
  "completed",
  "failed",
  "denied",
  "non-convergent",
] as const;
export type ProgrammaticSandboxStatus = (typeof PROGRAMMATIC_SANDBOX_STATUSES)[number];

/**
 * The neutral observation of a programmatic run's sandbox execution:
 * exactly the bounded evidence the executor needs — the retained
 * stdout (completed runs only, bounded by the runtime's output bound),
 * the sandbox output digest, the failure class/message and the
 * duration. NEVER an authorization surface, never a status write.
 */
export interface ProgrammaticSandboxObservation {
  readonly status: ProgrammaticSandboxStatus;
  /** The durable sandbox execution identity (null only for malformed scopes). */
  readonly sandboxId: string | null;
  /** The bounded retained stdout (completed runs only). */
  readonly stdout: string | null;
  /** The sandbox observation's output digest. */
  readonly outputDigest: string | null;
  readonly failure: {
    readonly failureClass: string;
    readonly message: string;
  } | null;
  readonly durationMs: number | null;
}

/**
 * The sandbox-compute seam: the module-side adapter implements this
 * over the sandbox module's public service. The executor calls it
 * EXACTLY once per programmatic run; the admission chain, durable
 * identity, evidence envelopes and provider dispatch all happen inside
 * the existing authority — this plane holds no store, no SQL, no
 * state machine.
 */
export interface SandboxComputeSeam {
  runProgrammaticWork(request: ProgrammaticSandboxRequest): Promise<ProgrammaticSandboxObservation>;
}
