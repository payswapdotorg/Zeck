/**
 * Deterministic-replacement executor port (tools module outbound;
 * WORK-021, acceptance criterion "deterministic replacements must
 * execute in an appropriate sandbox").
 *
 * THE compile/run seam of deterministicization candidates: the ONLY
 * surface through which a candidate's replacement program is executed
 * — during offline replay validation runs, differential evaluation,
 * property/metamorphic test runs and mutation probes. The WORK-018
 * synthesis-sandbox-executor pattern, applied to the deterministicization
 * lifecycle:
 *
 *   - the deterministicization lifecycle service (learning module) has
 *     NO execution surface (the observation island invariant); the
 *     composition root drives validation runs through THIS port and
 *     records the observations as learning evidence;
 *   - the ONLY shipped implementation of this port
 *     (`adapters/deterministic-replacement-sandbox-executor.ts`) wraps
 *     the sandbox module's public `SandboxService` + environment
 *     catalog — every run is a fully admitted, dispatched and
 *     journaled sandbox execution with its own durable identity,
 *     policy/capability/budget admission and step-event provenance
 *     (a promoted replacement can NEVER bypass the sandbox admission
 *     chain — the contract's Safety clause);
 *   - the executor is capability-CONFINING: it refuses before dispatch
 *     when the replacement's declared compute contract (network
 *     egress) exceeds what the target compute environment grants.
 *
 * The port returns observations, never authority: an outcome row for
 * evidence, stdout for output comparison, the sandbox identity for
 * provenance — nothing that mutates execution, planner or learning
 * state.
 */

/**
 * The neutral dispatch shape (provider-neutral; the composition root
 * maps a learning candidate's program + contract onto it — the tools
 * module owns no learning types).
 */
export interface DeterministicReplacementDispatch {
  /** The replacement program being executed (identity + source). */
  readonly replacement: {
    /** The deterministicization candidate identity. */
    readonly replacementId: string;
    /** sha256 digest of the candidate basis (integrity binding). */
    readonly replacementDigest: string;
    readonly source: string;
    readonly sourceDigest: string;
  };
  /** The declared compute confinement basis (the contract's compute half). */
  readonly contract: {
    readonly networkEgress: "none" | "allowlist";
    readonly allowedHosts: readonly string[];
    readonly timeoutMs: number;
  };
  /** Input already validated against the replacement contract's schema. */
  readonly input: Readonly<Record<string, unknown>>;
  /** Server-derived scope (never caller-asserted). */
  readonly actor: {
    readonly actorId: string;
    readonly applicationId: string;
    readonly tenantId: string;
  };
  /** Parent execution the run is provenance-bound to (may be a validation execution). */
  readonly executionId: string;
  /** Sandbox idempotency key (per logical run — the stable key scheme). */
  readonly idempotencyKey: string;
}

/**
 * The normalized run observation (the sandbox outcome mapped onto the
 * validation axis — never a state transition). This is the object the
 * composition feeds into the learning module's stage-evidence
 * recording (with `sandboxExecutionId` as the mandatory provenance).
 */
export type DeterministicReplacementRun =
  | {
      readonly outcome: "success";
      /** The program's raw stdout (the differential comparison basis). */
      readonly stdout: string;
      readonly outputDigest: string | null;
      readonly durationMs: number;
      /** The durable sandbox execution identity (provenance). */
      readonly sandboxExecutionId: string;
    }
  | {
      readonly outcome: "failure";
      readonly failureClass: string;
      readonly message: string;
      readonly sandboxExecutionId: string | null;
    };

export interface DeterministicReplacementExecutor {
  /**
   * Execute one replacement-program run inside the sandbox manager.
   * Refusal classes (fail-closed, BEFORE dispatch):
   *   - `CAPABILITY_UNAVAILABLE` — the declared compute contract
   *     exceeds the target environment's grants (substrate
   *     confinement), or the target environment is not registered;
   *   - `TOOL_ERROR` — the source/input serialization exceeds the v1
   *     bound or the source violates the pure-compute subset.
   */
  execute(dispatch: DeterministicReplacementDispatch): Promise<DeterministicReplacementRun>;
}
