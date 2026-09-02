/**
 * Computer-use environment port (tools module outbound; WORK-027,
 * CUI-001/CUI-002).
 *
 * The provider-neutral EXTERNAL computer-use environment seam — the
 * isolated browser context, the isolated desktop surface and the
 * deterministic/API executor. Every method is KEYED: the environment
 * MUST converge repeated calls under the same operation key (exactly
 * one external effect per stable key — the WORK-024 crash-safety
 * standard applied to the environment boundary).
 *
 * ISOLATION CONTRACT (the "no ambient inheritance" invariant): an
 * environment context is constructed ONLY from the declared profile —
 * a fresh EMPTY cookie jar, no ambient host credentials, no ambient
 * environment variables, no host mounts, no unrestricted sockets. The
 * context exposes `inheritedHostState` so the proofs can assert ZERO
 * inherited items while a SIMULATED HOST WORLD carries cookies,
 * credentials and mounts that must NOT leak in.
 *
 * TERMINAL actions do NOT cross this seam: they dispatch through the
 * `ComputerUseTerminalExecutor` port (the approved WORK-012 sandbox
 * boundary) — see computer-use-terminal.ts.
 */

import type {
  ComputerUseBrowserProfile,
  ComputerUseDesktopEnvelope,
  ComputerUseMode,
  ComputerUseObservationType,
  ComputerUseSideEffectClass,
  ComputerUseTerminalPolicy,
} from "../domain/computer-use";

/** A simulated external-environment failure (typed, never a crash). */
export interface ComputerUseEnvironmentFailure {
  readonly failureClass: string;
  readonly message: string;
}

/** The isolation introspection of one opened context (the proof surface). */
export interface ComputerUseEnvironmentContextState {
  readonly environmentRef: string;
  readonly mode: ComputerUseMode;
  /**
   * The ambient host items this context inherited — ALWAYS EMPTY by
   * construction (the isolation proof: host cookies/credentials/env/
   * mounts/sockets are never silently inherited).
   */
  readonly inheritedHostState: readonly {
    readonly kind: "cookie" | "credential" | "env" | "mount" | "socket";
    readonly name: string;
  }[];
  /** The cookie jar's current entries (starts EMPTY for every context). */
  readonly cookies: readonly string[];
  /** The hosts the context may egress to (the declared allowlist). */
  readonly egressAllowlist: readonly string[];
}

export interface ComputerUseEnvironmentOpenRequest {
  readonly applicationId: string;
  readonly tenantId: string;
  readonly sessionId: string;
  readonly executionId: string;
  readonly mode: ComputerUseMode;
  /** The capability id whose profile/envelope governs the context. */
  readonly capabilityId: string;
  readonly browserProfile: ComputerUseBrowserProfile | null;
  readonly desktopEnvelope: ComputerUseDesktopEnvelope | null;
  readonly terminalPolicy: ComputerUseTerminalPolicy | null;
}

export interface ComputerUseEnvironmentOpenResult {
  readonly environmentRef: string;
  readonly openedMode: ComputerUseMode;
  readonly inheritedHostState: ComputerUseEnvironmentContextState["inheritedHostState"];
}

export interface ComputerUseEnvironmentActionRequest {
  readonly environmentRef: string;
  readonly sessionId: string;
  readonly executionId: string;
  readonly mode: ComputerUseMode;
  readonly actionType: string;
  /** The action's TARGET (url, selector, window id, file path...). */
  readonly target: string;
  readonly input: Readonly<Record<string, unknown>>;
  /** The declared side-effect class (audited on the environment too). */
  readonly sideEffect: ComputerUseSideEffectClass;
}

export interface ComputerUseObservationFrame {
  readonly observationType: ComputerUseObservationType;
  /** Bounded serialized observation content (digest computed by the caller). */
  readonly body: Readonly<Record<string, unknown>>;
  readonly retention: "session" | "execution" | "ephemeral";
  readonly redaction: "none" | "sensitive-ui" | "secret-bearing";
  readonly artifactRef: string | null;
}

export interface ComputerUseEnvironmentActionResult {
  readonly outcome: "succeeded" | "failed";
  readonly failure?: ComputerUseEnvironmentFailure;
  /** Observation frames the action produced (the evidence model). */
  readonly observations: readonly ComputerUseObservationFrame[];
  /** The environment-visible usage in micro-USD (bounded by the envelope). */
  readonly usageMicroUsd: string;
  /** Arbitrary bounded result payload (digest computed by the caller). */
  readonly result: Readonly<Record<string, unknown>> | null;
}

export interface ComputerUseEnvironmentObserveRequest {
  readonly environmentRef: string;
  readonly sessionId: string;
  readonly executionId: string;
  readonly mode: ComputerUseMode;
  readonly observationType: ComputerUseObservationType;
  readonly target: string;
}

export interface ComputerUseEnvironmentObservationResult {
  readonly frame: ComputerUseObservationFrame;
}

export interface ComputerUseEnvironmentCloseRequest {
  readonly environmentRef: string;
  readonly sessionId: string;
  readonly cause: string;
}

/** One recorded external-environment activity entry (the proof surface). */
export interface ComputerUseEnvironmentActivityEntry {
  readonly operation: "open" | "action" | "observe" | "close";
  readonly mode: ComputerUseMode | "none";
  readonly operationKey: string;
  readonly actionType: string | null;
  readonly sideEffect: ComputerUseSideEffectClass;
  readonly at: string;
  readonly replayed: boolean;
}

export interface ComputerUseEnvironment {
  /** Open one isolated context (idempotent per operation key). */
  open(
    request: ComputerUseEnvironmentOpenRequest,
    operationKey: string,
  ): Promise<ComputerUseEnvironmentOpenResult | ComputerUseEnvironmentFailure>;
  /** Dispatch one action into an open context (idempotent per operation key). */
  dispatchAction(
    request: ComputerUseEnvironmentActionRequest,
    operationKey: string,
  ): Promise<ComputerUseEnvironmentActionResult>;
  /** Read one observation frame from an open context (idempotent per key). */
  observe(
    request: ComputerUseEnvironmentObserveRequest,
    operationKey: string,
  ): Promise<ComputerUseEnvironmentObservationResult | ComputerUseEnvironmentFailure>;
  /** Close one context (idempotent per operation key; terminal). */
  close(
    request: ComputerUseEnvironmentCloseRequest,
    operationKey: string,
  ): Promise<{ closed: true } | ComputerUseEnvironmentFailure>;
  /** The full activity journal (the zero-side-effect proof surface). */
  activity(): readonly ComputerUseEnvironmentActivityEntry[];
  /** The isolation introspection of one context (the no-inheritance proof). */
  contextState(environmentRef: string): ComputerUseEnvironmentContextState | null;
}
