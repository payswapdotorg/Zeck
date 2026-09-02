/**
 * Computer-use domain model (tools module domain; WORK-027, CUI-001/002/003).
 *
 * Computer use is a governed CAPABILITY FAMILY in the tools module — one
 * more axis of governed sub-execution activity, exactly like a tool
 * invocation (WORK-010) and a sandbox execution (WORK-012). It is NOT an
 * authority and NOT a second execution system:
 *
 *   - the execution lifecycle authority stays in `/executions` (a session
 *     row NEVER writes execution status; evidence rides the executions
 *     EventEnvelope ledger as step events through the REQUIRED ledger
 *     seam, reusing the tools module's producer vocabulary
 *     `tool-requested` / `tool-result` / `tool-denied`);
 *   - policy / capability / budget / tenant / secret decisions belong to
 *     their authorities and are consulted through REQUIRED seams;
 *   - a computer-use session is subordinate bookkeeping:
 *     `denied` (insert-only admission denial) · `active` (durable
 *     admission bundle, possibly mid-escalation) · terminal
 *     `completed`|`failed`|`cancelled`.
 *
 * THE deterministic-first discipline (the work order's escalation
 * diagram): computer use is a FALLBACK computational mode. The three
 * interaction modes form a frozen escalation order
 *
 *     deterministic (API / deterministic computation)
 *       → browser (isolated browser automation)
 *         → desktop (isolated desktop/terminal interaction)
 *
 * and `evaluateComputerUseRoute` (pure, total, tested) makes the
 * deterministic-first decision BEFORE any environment exists: when a
 * deterministic candidate covers the task's requirement atoms with
 * verified quality at or above the target, the route contains ONLY
 * deterministic stages — zero browser/desktop dispatches (the
 * zero-GUI-dispatch property, AC-6/AC-7). Escalation is a planning
 * policy preference expressed as route stages, never an authority: a
 * high-confidence deterministic route is never displaced by a
 * historically successful GUI route.
 *
 * Security model at this layer (fail-closed, pure, total):
 *   - capability declarations are VALIDATED before registration
 *     (`validateComputerUseCapability`) — malformed declarations never
 *     become governable state, so unregistered/fabricated capabilities
 *     cannot dispatch (AC-5);
 *   - actions are confined to the current mode's action vocabulary AND
 *     the declared capability envelope (desktop grants: input devices,
 *     windows/apps, filesystem, network, clipboard, downloads — ambient
 *     authority is unrepresentable);
 *   - browser contexts declare an egress allowlist; a host outside it is
 *     refused BEFORE any environment interaction (no hidden network
 *     access);
 *   - a session NEVER inherits ambient host state: the environment
 *     context is constructed ONLY from the declared profile (fresh empty
 *     cookie jar, no host credentials, no ambient env vars, no mounts,
 *     no unrestricted sockets — `AMBIENT_HOST_INHERITANCE` is the
 *     constant "none" and there is no other value);
 *   - observations carry retention + redaction metadata and digests, and
 *     `serializeObservationEvidence` never emits observation CONTENT
 *     publicly (digest references only) — secrets cannot leak through
 *     public serialization.
 */

// ---------------------------------------------------------------------------
// The frozen mode vocabulary (the escalation order)
// ---------------------------------------------------------------------------

/** The three interaction modes, in ESCALATION ORDER (index = preference). */
export const COMPUTER_USE_MODES = ["deterministic", "browser", "desktop"] as const;
export type ComputerUseMode = (typeof COMPUTER_USE_MODES)[number];

export function isComputerUseMode(value: string): value is ComputerUseMode {
  return (COMPUTER_USE_MODES as readonly string[]).includes(value);
}

/** The next mode in the frozen escalation order (null at the top). */
export function nextComputerUseMode(mode: ComputerUseMode): ComputerUseMode | null {
  const index = COMPUTER_USE_MODES.indexOf(mode);
  if (index < 0 || index >= COMPUTER_USE_MODES.length - 1) {
    return null;
  }
  return COMPUTER_USE_MODES[index + 1] ?? null;
}

/** Modes BELOW `mode` in the escalation order (the already-allowed modes). */
export function priorComputerUseModes(mode: ComputerUseMode): readonly ComputerUseMode[] {
  return COMPUTER_USE_MODES.slice(0, COMPUTER_USE_MODES.indexOf(mode));
}

// ---------------------------------------------------------------------------
// The session lifecycle (subordinate bookkeeping — never an execution system)
// ---------------------------------------------------------------------------

export const COMPUTER_USE_SESSION_STATUSES = [
  "denied",
  "active",
  "completed",
  "failed",
  "cancelled",
] as const;
export type ComputerUseSessionStatus = (typeof COMPUTER_USE_SESSION_STATUSES)[number];

export const TERMINAL_COMPUTER_USE_SESSION_STATUSES = [
  "denied",
  "completed",
  "failed",
  "cancelled",
] as const;

export function isComputerUseSessionStatus(value: string): value is ComputerUseSessionStatus {
  return (COMPUTER_USE_SESSION_STATUSES as readonly string[]).includes(value);
}

export function isTerminalComputerUseSessionStatus(status: ComputerUseSessionStatus): boolean {
  return (TERMINAL_COMPUTER_USE_SESSION_STATUSES as readonly string[]).includes(status);
}

export const COMPUTER_USE_SESSION_TRANSITIONS: Readonly<
  Record<ComputerUseSessionStatus, readonly ComputerUseSessionStatus[]>
> = {
  denied: [],
  active: ["completed", "failed", "cancelled"],
  completed: [],
  failed: [],
  cancelled: [],
};

export function canTransitionComputerUseSession(
  from: ComputerUseSessionStatus,
  to: ComputerUseSessionStatus,
): boolean {
  return COMPUTER_USE_SESSION_TRANSITIONS[from].includes(to);
}

/** Admission denial classes — the authorities that can refuse a session/stage. */
export const COMPUTER_USE_DENIAL_CLASSES = [
  "policy",
  "budget",
  "capability",
  "secret-mediation",
] as const;
export type ComputerUseDenialClass = (typeof COMPUTER_USE_DENIAL_CLASSES)[number];

export function isComputerUseDenialClass(value: string): value is ComputerUseDenialClass {
  return (COMPUTER_USE_DENIAL_CLASSES as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// The evidence model: observation types, action types, side effects
// ---------------------------------------------------------------------------

/**
 * The provider-neutral observation vocabulary (the work order's evidence
 * model: DOM, accessibility tree, screenshot, terminal output, API result).
 */
export const COMPUTER_USE_OBSERVATION_TYPES = [
  "dom",
  "accessibility-tree",
  "screenshot",
  "terminal-output",
  "api-result",
] as const;
export type ComputerUseObservationType = (typeof COMPUTER_USE_OBSERVATION_TYPES)[number];

export function isComputerUseObservationType(
  value: string,
): value is ComputerUseObservationType {
  return (COMPUTER_USE_OBSERVATION_TYPES as readonly string[]).includes(value);
}

/**
 * Retention classes for sensitive observations (the evidence model's
 * retention metadata): `session` (kept with the session record),
 * `execution` (kept with the parent execution's evidence window),
 * `ephemeral` (digest only — the content never persists).
 */
export const COMPUTER_USE_RETENTION_CLASSES = ["session", "execution", "ephemeral"] as const;
export type ComputerUseRetentionClass = (typeof COMPUTER_USE_RETENTION_CLASSES)[number];

export function isComputerUseRetentionClass(value: string): value is ComputerUseRetentionClass {
  return (COMPUTER_USE_RETENTION_CLASSES as readonly string[]).includes(value);
}

/**
 * Redaction classes: `none` (non-sensitive), `sensitive-ui` (screenshots /
 * DOM / accessibility trees — personal UI state), `secret-bearing` (content
 * matching raw-secret shapes — refused before persistence, never
 * serialized publicly).
 */
export const COMPUTER_USE_REDACTION_CLASSES = ["none", "sensitive-ui", "secret-bearing"] as const;
export type ComputerUseRedactionClass = (typeof COMPUTER_USE_REDACTION_CLASSES)[number];

export function isComputerUseRedactionClass(value: string): value is ComputerUseRedactionClass {
  return (COMPUTER_USE_REDACTION_CLASSES as readonly string[]).includes(value);
}

/**
 * The typed action vocabulary per mode. Browser automation is a
 * DETERMINISTIC capability surface when scripted (navigate/click/type by
 * selector) — a generative model is never required to drive it (the work
 * order's "browser/API automation represented as deterministic
 * capabilities").
 */
export const COMPUTER_USE_ACTION_TYPES = [
  // deterministic/API mode (no GUI substrate)
  "api-call",
  // browser mode (isolated browser automation)
  "navigate",
  "click",
  "type",
  "scroll",
  "read-dom",
  "read-accessibility-tree",
  "screenshot",
  // desktop/terminal mode (isolated desktop/terminal interaction)
  "terminal-exec",
  "input-event",
  "window-action",
  "clipboard-read",
  "clipboard-write",
  "file-read",
  "file-write",
  "download",
] as const;
export type ComputerUseActionType = (typeof COMPUTER_USE_ACTION_TYPES)[number];

export function isComputerUseActionType(value: string): value is ComputerUseActionType {
  return (COMPUTER_USE_ACTION_TYPES as readonly string[]).includes(value);
}

/** Which action types each mode may dispatch (mode confinement). */
export const MODE_ACTION_VOCABULARIES: Readonly<
  Record<ComputerUseMode, readonly ComputerUseActionType[]>
> = {
  deterministic: ["api-call"],
  browser: [
    "navigate",
    "click",
    "type",
    "scroll",
    "read-dom",
    "read-accessibility-tree",
    "screenshot",
  ],
  desktop: [
    "terminal-exec",
    "input-event",
    "window-action",
    "clipboard-read",
    "clipboard-write",
    "file-read",
    "file-write",
    "download",
  ],
};

/** The observation types each action type produces (the evidence contract). */
export const ACTION_OBSERVATION_TYPES: Readonly<
  Record<ComputerUseActionType, readonly ComputerUseObservationType[]>
> = {
  "api-call": ["api-result"],
  navigate: ["dom"],
  click: ["dom"],
  type: ["dom"],
  scroll: ["dom"],
  "read-dom": ["dom"],
  "read-accessibility-tree": ["accessibility-tree"],
  screenshot: ["screenshot"],
  "terminal-exec": ["terminal-output"],
  "input-event": ["dom"],
  "window-action": ["accessibility-tree"],
  "clipboard-read": ["terminal-output"],
  "clipboard-write": [],
  "file-read": ["terminal-output"],
  "file-write": [],
  download: ["screenshot"],
};

/** External side-effect classification (typed + auditable, the tools vocabulary). */
export const COMPUTER_USE_SIDE_EFFECT_CLASSES = ["none", "read-only", "write-external"] as const;
export type ComputerUseSideEffectClass = (typeof COMPUTER_USE_SIDE_EFFECT_CLASSES)[number];

/** The side-effect classification per action type (frozen, auditable). */
export const ACTION_SIDE_EFFECTS: Readonly<
  Record<ComputerUseActionType, ComputerUseSideEffectClass>
> = {
  "api-call": "read-only",
  navigate: "read-only",
  click: "write-external",
  type: "write-external",
  scroll: "read-only",
  "read-dom": "read-only",
  "read-accessibility-tree": "read-only",
  screenshot: "read-only",
  "terminal-exec": "write-external",
  "input-event": "write-external",
  "window-action": "write-external",
  "clipboard-read": "read-only",
  "clipboard-write": "write-external",
  "file-read": "read-only",
  "file-write": "write-external",
  download: "write-external",
};

// ---------------------------------------------------------------------------
// The desktop capability envelope (explicit grants, never ambient authority)
// ---------------------------------------------------------------------------

/**
 * The DESKTOP capability envelope: every side-effecting surface a desktop
 * interaction could touch is an EXPLICIT grant. A grant that is false (or
 * absent) makes the corresponding action unrepresentable in the mode —
 * ambient host authority does not exist in this model (the work order's
 * "input devices, windows/apps, filesystem, network, clipboard, downloads
 * and other side effects").
 */
export interface ComputerUseDesktopEnvelope {
  /** Keyboard/pointer input events may be dispatched. */
  readonly inputDevices: boolean;
  /** Windows/apps may be opened/closed/focused. */
  readonly windowsApps: boolean;
  /** The isolated workspace filesystem may be read/written. */
  readonly filesystem: boolean;
  /** Egress to the declared allowlist is permitted (hidden egress is not). */
  readonly network: boolean;
  /** The isolated clipboard may be read/written. */
  readonly clipboard: boolean;
  /** Downloads may be produced into the isolated workspace. */
  readonly downloads: boolean;
  /** Terminal commands may execute through the approved sandbox boundary. */
  readonly terminal: boolean;
}

/** Which envelope grant each desktop action type requires. */
export const DESKTOP_ACTION_GRANTS: Readonly<
  Record<ComputerUseActionType, keyof ComputerUseDesktopEnvelope | null>
> = {
  "terminal-exec": "terminal",
  "input-event": "inputDevices",
  "window-action": "windowsApps",
  "clipboard-read": "clipboard",
  "clipboard-write": "clipboard",
  "file-read": "filesystem",
  "file-write": "filesystem",
  download: "downloads",
  // Browser/deterministic actions are not envelope-gated (the browser
  // isolation profile and the deterministic contract govern them).
  "api-call": null,
  navigate: null,
  click: null,
  type: null,
  scroll: null,
  "read-dom": null,
  "read-accessibility-tree": null,
  screenshot: null,
};

export const COMPUTER_USE_DESKTOP_GRANTS = [
  "inputDevices",
  "windowsApps",
  "filesystem",
  "network",
  "clipboard",
  "downloads",
  "terminal",
] as const;
export type ComputerUseDesktopGrant = (typeof COMPUTER_USE_DESKTOP_GRANTS)[number];

// ---------------------------------------------------------------------------
// The browser isolation profile + the ambient-inheritance constant
// ---------------------------------------------------------------------------

/**
 * The ONLY ambient host inheritance mode: NONE. A computer-use session
 * never inherits the host's credentials, cookies, environment variables,
 * mounted files or unrestricted sockets — the environment context is
 * constructed exclusively from the declared profile. There is no second
 * value in the vocabulary, so "silently inherit ambient host state" is
 * unrepresentable at the contract level.
 */
export const AMBIENT_HOST_INHERITANCE = "none" as const;
export type AmbientHostInheritance = typeof AMBIENT_HOST_INHERITANCE;

/** The browser context cookie policy: every context starts FRESH and EMPTY. */
export const BROWSER_COOKIE_JAR_POLICY = "session-fresh-empty" as const;
export type BrowserCookieJarPolicy = typeof BROWSER_COOKIE_JAR_POLICY;

export interface ComputerUseBrowserProfile {
  /** The egress allowlist (origins/hosts the context may reach). */
  readonly egressAllowlist: readonly string[];
  readonly cookieJar: BrowserCookieJarPolicy;
  readonly ambientHostInheritance: AmbientHostInheritance;
}

/** Terminal sandbox policy: explicit process/filesystem/network capabilities. */
export interface ComputerUseTerminalPolicy {
  readonly process: boolean;
  readonly filesystem: boolean;
  readonly network: boolean;
  /** Hosts the terminal may egress to (required when network is granted). */
  readonly egressAllowlist: readonly string[];
}

// ---------------------------------------------------------------------------
// The task descriptor + capability declarations (the registry input)
// ---------------------------------------------------------------------------

/** Provider-neutral task kinds (what the caller wants done). */
export const COMPUTER_USE_TASK_KINDS = [
  "structured-data-retrieval",
  "web-workflow",
  "desktop-workflow",
  "terminal-task",
] as const;
export type ComputerUseTaskKind = (typeof COMPUTER_USE_TASK_KINDS)[number];

export function isComputerUseTaskKind(value: string): value is ComputerUseTaskKind {
  return (COMPUTER_USE_TASK_KINDS as readonly string[]).includes(value);
}

/**
 * The quality-target vocabulary for a computer-use task (0..1, the
 * platform's quality semantics — deterministic candidates carry a
 * `deterministicQuality` on the same scale).
 */
export const COMPUTER_USE_QUALITY_MIN = 0;
export const COMPUTER_USE_QUALITY_MAX = 1;

/**
 * The mode family a capability declaration serves. A declaration is the
 * provider-neutral contract a registry admits; `deterministic` declares a
 * deterministic/API capability (with quality evidence), the GUI kinds
 * declare isolated browser/desktop surfaces.
 */
export const COMPUTER_USE_CAPABILITY_KINDS = ["deterministic", "browser", "desktop"] as const;
export type ComputerUseCapabilityKind = (typeof COMPUTER_USE_CAPABILITY_KINDS)[number];

export function isComputerUseCapabilityKind(value: string): value is ComputerUseCapabilityKind {
  return (COMPUTER_USE_CAPABILITY_KINDS as readonly string[]).includes(value);
}

export type ComputerUseQualityConfidence = "verified" | "estimated";

/**
 * The provider-neutral computer-use capability declaration (AC-1: one
 * contract family for browser, desktop and terminal interaction).
 *
 * `capabilityId` belongs to the tools module's computer-use namespace
 * (`computer-use-*`); the platform capability ATOM it requires through
 * the capabilities authority is `capabilityAtom` (`computer-use-<kind>`
 * — the WORK-005 registry arbitrates its satisfaction).
 */
export interface ComputerUseCapabilityDeclaration {
  readonly capabilityId: string;
  readonly kind: ComputerUseCapabilityKind;
  readonly description: string;
  /** The platform capability atom the capabilities authority must satisfy. */
  readonly capabilityAtom: string;
  /**
   * Deterministic-kind only: the requirement atoms this capability
   * COVERs (the route evaluation's coverage input).
   */
  readonly covers: readonly string[];
  /** Deterministic-kind only: the expected quality + confidence evidence. */
  readonly deterministicQuality: number | null;
  readonly qualityConfidence: ComputerUseQualityConfidence | null;
  /** Cost ceiling per invocation, integer micro-USD string ("0" = free). */
  readonly estimatedMicroUsd: string;
  /** Network hosts the capability would egress to (empty = none). */
  readonly hosts: readonly string[];
  /** Secret reference the capability would materialize (null = none). */
  readonly secretRef: string | null;
  /** Desktop-kind only: the explicit capability envelope. */
  readonly desktopEnvelope: ComputerUseDesktopEnvelope | null;
  /** Desktop-kind only: the terminal sandbox policy. */
  readonly terminalPolicy: ComputerUseTerminalPolicy | null;
  /** Browser-kind only: the isolation profile (egress allowlist). */
  readonly browserProfile: ComputerUseBrowserProfile | null;
}

// ---------------------------------------------------------------------------
// The deterministic-first route evaluation (pure, total, tested)
// ---------------------------------------------------------------------------

export type ComputerUseRouteDecision = "sufficient" | "insufficient" | "uncertain";

export type ComputerUseRouteReasonCode =
  | "deterministic-coverage-verified"
  | "no-deterministic-candidate"
  | "requirement-coverage-unmet"
  | "quality-gap"
  | "quality-unverified"
  | "gui-task-required"
  | "no-route-available";

export interface ComputerUseRouteReason {
  readonly code: ComputerUseRouteReasonCode;
  readonly detail: string;
}

/** One stage of the escalation route (ordered by preference). */
export interface ComputerUseRouteStage {
  readonly mode: ComputerUseMode;
  readonly capabilityId: string;
  /** Why this stage is present (the sufficiency evidence trail). */
  readonly reason: ComputerUseRouteReasonCode;
}

/**
 * The evidence a deterministic-first PLANNER needs (the "planner-facing
 * result must preserve evidence sufficient for deterministic-first
 * selection" requirement): the full candidate inventory with quality/
 * confidence/cost, the decision + typed reasons, and the route. This is
 * a pure data contract — the planning module (which owns selection)
 * consumes it read-only through the tools public surface; it carries no
 * command surface and authorizes nothing.
 */
export interface ComputerUseRouteEvidence {
  readonly taskKind: ComputerUseTaskKind;
  readonly requirementAtoms: readonly string[];
  readonly qualityTarget: number;
  readonly deterministicCandidates: readonly {
    readonly capabilityId: string;
    readonly capabilityAtom: string;
    readonly expectedQuality: number;
    readonly qualityConfidence: ComputerUseQualityConfidence;
    readonly estimatedMicroUsd: string;
    readonly coversRequirements: boolean;
  }[];
  readonly guiCandidates: readonly {
    readonly mode: ComputerUseMode;
    readonly capabilityId: string;
    readonly capabilityAtom: string;
    readonly estimatedMicroUsd: string;
  }[];
  readonly decision: ComputerUseRouteDecision;
  readonly reasons: readonly ComputerUseRouteReason[];
  readonly route: readonly ComputerUseRouteStage[];
  /**
   * The deterministic sufficiency verdict a planner consults FIRST:
   * `sufficient` ⇒ a deterministic route exists and GUI modes must NOT
   * be dispatched for this task (the zero-GUI-dispatch discipline).
   */
  readonly deterministicFirst: ComputerUseRouteDecision;
}

export interface ComputerUseRouteInput {
  readonly taskKind: ComputerUseTaskKind;
  readonly requirementAtoms: readonly string[];
  readonly qualityTarget: number;
  /** Resolved deterministic candidates (may be empty). */
  readonly deterministic: readonly ComputerUseCapabilityDeclaration[];
  /** Resolved browser candidate (null = none available). */
  readonly browser: ComputerUseCapabilityDeclaration | null;
  /** Resolved desktop candidate (null = none available). */
  readonly desktop: ComputerUseCapabilityDeclaration | null;
}

/**
 * The pure deterministic-first route evaluation. DECISION TABLE (the
 * work order's escalation diagram, restated for the computer-use axis —
 * the same semantics as the planning module's sufficiency table, owned
 * here for THIS capability family without importing planning):
 *
 *  - a deterministic candidate covering every requirement atom with
 *    VERIFIED quality >= target ⇒ `sufficient`: the route is
 *    deterministic ONLY (zero GUI stages — GUI modes are not even
 *    candidates for dispatch);
 *  - deterministic quality < target ⇒ `insufficient` (quality-gap):
 *    escalate to the browser stage, then desktop;
 *  - quality meets the target but confidence is `estimated` ⇒
 *    `uncertain` (quality-unverified): the browser stage is the bounded
 *    compare path (never a blind jump to desktop);
 *  - no deterministic candidate / coverage unmet / the task kind itself
 *    declares a desktop GUI workflow ⇒ `insufficient` with the recorded
 *    reason;
 *  - no GUI candidate exists and deterministic is insufficient ⇒ the
 *    evaluation reports `no-route-available` and the caller fails
 *    closed BEFORE any environment interaction.
 *
 * A GUI route NEVER displaces a sufficient deterministic route — not by
 * cost, not by history, not by preference (the work order: "a
 * high-confidence deterministic/API route must not be displaced solely
 * because a GUI/model route appears historically successful").
 */
export function evaluateComputerUseRoute(input: ComputerUseRouteInput): ComputerUseRouteEvidence {
  const reasons: ComputerUseRouteReason[] = [];
  const deterministicCandidates = input.deterministic.map((candidate) => ({
    capabilityId: candidate.capabilityId,
    capabilityAtom: candidate.capabilityAtom,
    expectedQuality: candidate.deterministicQuality ?? 0,
    qualityConfidence: candidate.qualityConfidence ?? "estimated",
    estimatedMicroUsd: candidate.estimatedMicroUsd,
    coversRequirements: coversRequirements(candidate, input.requirementAtoms),
  }));

  const guiCandidates: {
    readonly mode: ComputerUseMode;
    readonly capabilityId: string;
    readonly capabilityAtom: string;
    readonly estimatedMicroUsd: string;
  }[] = [];
  if (input.browser !== null) {
    guiCandidates.push({
      mode: "browser",
      capabilityId: input.browser.capabilityId,
      capabilityAtom: input.browser.capabilityAtom,
      estimatedMicroUsd: input.browser.estimatedMicroUsd,
    });
  }
  if (input.desktop !== null) {
    guiCandidates.push({
      mode: "desktop",
      capabilityId: input.desktop.capabilityId,
      capabilityAtom: input.desktop.capabilityAtom,
      estimatedMicroUsd: input.desktop.estimatedMicroUsd,
    });
  }

  // The GUI-affinity short-circuit: a task whose KIND is a desktop
  // workflow cannot be satisfied deterministically even when a candidate
  // nominally covers the atoms (the work flow itself drives a UI).
  const desktopWorkflowTask = input.taskKind === "desktop-workflow";

  const covered = deterministicCandidates.filter((candidate) => candidate.coversRequirements);
  const best = covered.length === 0 ? null : (covered[0] ?? null);

  let decision: ComputerUseRouteDecision;
  if (best === null) {
    if (input.deterministic.length === 0) {
      reasons.push({
        code: "no-deterministic-candidate",
        detail: "no deterministic/API capability candidate is registered for this task",
      });
    } else {
      reasons.push({
        code: "requirement-coverage-unmet",
        detail: "no deterministic candidate covers every requirement atom of the task",
      });
    }
    decision = "insufficient";
  } else if (desktopWorkflowTask) {
    reasons.push({
      code: "gui-task-required",
      detail: "the task kind desktop-workflow requires GUI interaction by declaration",
    });
    decision = "insufficient";
  } else if (best.expectedQuality < input.qualityTarget) {
    reasons.push({
      code: "quality-gap",
      detail: `deterministic expected quality ${best.expectedQuality.toFixed(4)} is below the task quality target ${input.qualityTarget.toFixed(4)} — deterministic execution would materially reduce the outcome`,
    });
    decision = "insufficient";
  } else if (best.qualityConfidence !== "verified") {
    reasons.push({
      code: "quality-unverified",
      detail: `deterministic expected quality ${best.expectedQuality.toFixed(4)} meets the target ${input.qualityTarget.toFixed(4)} but is not verified — a bounded compare (browser stage) is required before reliance`,
    });
    decision = "uncertain";
  } else {
    reasons.push({
      code: "deterministic-coverage-verified",
      detail: `deterministic capability ${best.capabilityId} covers every requirement atom with verified quality ${best.expectedQuality.toFixed(4)} at or above the target ${input.qualityTarget.toFixed(4)}`,
    });
    decision = "sufficient";
  }

  const route: ComputerUseRouteStage[] = [];
  if (decision === "sufficient") {
    route.push({
      mode: "deterministic",
      capabilityId: best?.capabilityId ?? "",
      reason: "deterministic-coverage-verified",
    });
  } else {
    // The escalation ladder. For `uncertain` the deterministic stage
    // STAYS FIRST: the planner runs it as the bounded compare and
    // escalates only on recorded insufficiency (never a blind jump to
    // GUI). For `insufficient` the deterministic route would materially
    // reduce the outcome — the browser stage leads. Stages are
    // candidates, NOT dispatches — each stage's environment interaction
    // still requires the full admission chain (re-consulted at every
    // escalation).
    const firstReason = reasons[0]?.code ?? "quality-gap";
    if (decision === "uncertain") {
      route.push({
        mode: "deterministic",
        capabilityId: best?.capabilityId ?? "",
        reason: "quality-unverified",
      });
    }
    if (input.browser !== null) {
      route.push({
        mode: "browser",
        capabilityId: input.browser.capabilityId,
        reason: decision === "uncertain" ? "quality-unverified" : firstReason,
      });
    }
    if (input.desktop !== null) {
      route.push({
        mode: "desktop",
        capabilityId: input.desktop.capabilityId,
        reason: "gui-task-required",
      });
    }
    if (route.length === 0) {
      reasons.push({
        code: "no-route-available",
        detail:
          "the deterministic route is insufficient and no GUI capability is registered — the request fails closed before any environment interaction",
      });
    }
  }

  return {
    taskKind: input.taskKind,
    requirementAtoms: [...input.requirementAtoms],
    qualityTarget: input.qualityTarget,
    deterministicCandidates,
    guiCandidates,
    decision,
    reasons,
    route,
    deterministicFirst: decision,
  };
}

/** Whether a deterministic declaration covers EVERY requirement atom. */
function coversRequirements(
  candidate: ComputerUseCapabilityDeclaration,
  atoms: readonly string[],
): boolean {
  if (atoms.length === 0) {
    return false;
  }
  const declared = new Set(candidate.covers);
  return atoms.every((atom) => declared.has(atom));
}

// ---------------------------------------------------------------------------
// Session / action / observation records (the durable evidence shapes)
// ---------------------------------------------------------------------------

export interface ComputerUseActor {
  readonly actorId: string;
  readonly tenantId: string;
}

/** The caller's session request (deterministic-first: the ROUTE picks the mode). */
export interface ComputerUseSessionRequest {
  readonly applicationId: string;
  readonly executionId: string;
  readonly actor: ComputerUseActor;
  readonly task: {
    readonly kind: ComputerUseTaskKind;
    readonly requirementAtoms: readonly string[];
    readonly qualityTarget: number;
  };
  /**
   * The candidate capability ids (all RESOLVED through the registry —
   * an unregistered id fails closed CAPABILITY_UNAVAILABLE before any
   * dispatch; a fabricated id never had a contract).
   */
  readonly candidates: {
    readonly deterministic: readonly string[];
    readonly browser: string | null;
    readonly desktop: string | null;
  };
  /** The mediated credential reference (null = no credential mediation). */
  readonly connectionRef: string | null;
}

/** The immutable admitted snapshot (what was admitted, by which authorities). */
export interface ComputerUseAdmissionSnapshot {
  readonly taskKind: ComputerUseTaskKind;
  readonly requirementAtoms: readonly string[];
  readonly qualityTarget: number;
  readonly initialMode: ComputerUseMode;
  readonly routeEvidence: ComputerUseRouteEvidence;
  readonly hosts: readonly string[];
  readonly secretRef: string | null;
  readonly policyEvidence: ComputerUsePolicyEvidence | null;
  readonly capabilitySatisfaction: string | null;
  readonly budgetOperationId: string | null;
  readonly costCeilingMicroUsd: string;
  readonly secretGrantRef: string | null;
}

/**
 * The CURRENT mode's capability context (mutable only through governed
 * escalation): the capability id and its declared envelope/policies —
 * the confinement input every action validates against.
 */
export interface ComputerUseModeContext {
  readonly capabilityId: string;
  readonly desktopEnvelope: ComputerUseDesktopEnvelope | null;
  readonly terminalPolicy: ComputerUseTerminalPolicy | null;
  readonly browserProfile: ComputerUseBrowserProfile | null;
}

export interface ComputerUsePolicyEvidence {
  readonly policySetId: string;
  readonly policySetVersion: number;
  readonly policyContentHash: string;
  readonly restrictionSetDigest: string;
}

/** One escalation transition (append-only evidence). */
export interface ComputerUseEscalationRecord {
  readonly id: string;
  readonly applicationId: string;
  readonly tenantId: string;
  readonly sessionId: string;
  readonly executionId: string;
  readonly sequence: number;
  readonly fromMode: ComputerUseMode;
  readonly toMode: ComputerUseMode;
  readonly reasonCode: string;
  readonly reasonDetail: string;
  /** Digest of the prior mode's insufficiency evidence (replayable lineage). */
  readonly insufficiencyDigest: string;
  readonly capabilityId: string;
  readonly admittedAt: string;
  readonly ledgerSequence: number | null;
}

/** The durable action journal (one row per governed action, keyed). */
export const COMPUTER_USE_ACTION_STATUSES = [
  "dispatching",
  "succeeded",
  "failed",
  "denied",
] as const;
export type ComputerUseActionStatus = (typeof COMPUTER_USE_ACTION_STATUSES)[number];

export function isComputerUseActionStatus(value: string): value is ComputerUseActionStatus {
  return (COMPUTER_USE_ACTION_STATUSES as readonly string[]).includes(value);
}

export interface ComputerUseActionRecord {
  readonly id: string;
  readonly applicationId: string;
  readonly tenantId: string;
  readonly sessionId: string;
  readonly executionId: string;
  readonly actionKey: string;
  readonly sequence: number;
  readonly mode: ComputerUseMode;
  readonly actionType: ComputerUseActionType;
  /** The action's TARGET (element selector, window id, file path, command). */
  readonly target: string;
  readonly sideEffect: ComputerUseSideEffectClass;
  readonly status: ComputerUseActionStatus;
  readonly capabilityId: string;
  readonly failureClass: string | null;
  readonly failureMessage: string | null;
  readonly inputDigest: string;
  readonly resultDigest: string | null;
  readonly usageMicroUsd: string | null;
  readonly environmentRef: string | null;
  readonly sandboxExecutionId: string | null;
  readonly observationSequences: readonly number[];
  readonly requestedAt: string;
  readonly dispatchedAt: string | null;
  readonly completedAt: string | null;
  readonly durationMs: number | null;
  readonly ledgerRequestedSequence: number | null;
  readonly ledgerResultSequence: number | null;
}

/** One observation (append-only, sequence-gapless per session, digest-protected). */
export interface ComputerUseObservationRecord {
  readonly id: string;
  readonly applicationId: string;
  readonly tenantId: string;
  readonly sessionId: string;
  readonly executionId: string;
  readonly sequence: number;
  readonly observationType: ComputerUseObservationType;
  readonly mode: ComputerUseMode;
  /** Digest of the observation CONTENT (64 hex — content never crosses publicly). */
  readonly contentDigest: string;
  /** Retention metadata (the evidence model's retention dimension). */
  readonly retention: ComputerUseRetentionClass;
  /** Redaction metadata (sensitive-ui / secret-bearing / none). */
  readonly redaction: ComputerUseRedactionClass;
  /** The bounded serialized content retained per the retention class. */
  readonly content: string | null;
  readonly artifactRef: string | null;
  readonly capabilityId: string;
  readonly actionId: string | null;
  readonly observedAt: string;
  readonly ledgerSequence: number | null;
}

/** The session record. */
export interface ComputerUseSessionRecord {
  readonly id: string;
  readonly applicationId: string;
  readonly tenantId: string;
  readonly executionId: string;
  readonly sessionKey: string;
  readonly requestFingerprint: string;
  readonly taskKind: ComputerUseTaskKind;
  readonly status: ComputerUseSessionStatus;
  readonly initialMode: ComputerUseMode;
  readonly currentMode: ComputerUseMode;
  readonly routeEvidence: ComputerUseRouteEvidence;
  readonly admission: ComputerUseAdmissionSnapshot;
  /** The CURRENT mode's capability context (governed-escalation-mutable). */
  readonly modeContext: ComputerUseModeContext;
  readonly environmentRef: string | null;
  readonly environmentOpenedMode: ComputerUseMode | null;
  readonly denialClass: ComputerUseDenialClass | null;
  readonly denialReason: string | null;
  readonly escalationCount: number;
  readonly usageMicroUsd: string;
  readonly requestedAt: string;
  readonly activatedAt: string | null;
  readonly terminalAt: string | null;
  readonly terminalCause: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

// ---------------------------------------------------------------------------
// The durable operation state (the WORK-024 crash-safety standard)
// ---------------------------------------------------------------------------

export const COMPUTER_USE_OPERATION_KINDS = [
  "session-create",
  "env-open",
  "action-dispatch",
  "escalation",
  "termination",
  "budget-settle",
  "budget-release",
] as const;
export type ComputerUseOperationKind = (typeof COMPUTER_USE_OPERATION_KINDS)[number];

export const COMPUTER_USE_OPERATION_STATUSES = ["pending", "completed", "failed"] as const;
export type ComputerUseOperationStatus = (typeof COMPUTER_USE_OPERATION_STATUSES)[number];

export interface ComputerUseOperationRecord {
  readonly id: string;
  readonly applicationId: string;
  readonly tenantId: string;
  readonly sessionId: string | null;
  readonly executionId: string;
  readonly operationKind: ComputerUseOperationKind;
  readonly operationKey: string;
  readonly requestFingerprint: string;
  readonly status: ComputerUseOperationStatus;
  readonly attempts: number;
  readonly stage: Readonly<Record<string, unknown>> | null;
  readonly failureReason: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly completedAt: string | null;
}

// ---------------------------------------------------------------------------
// The stable idempotency key scheme (claim-pinned, session-scoped)
// ---------------------------------------------------------------------------

/** Key prefix discipline: every computer-use seam key derives from the session identity. */
export const COMPUTER_USE_KEY_PREFIXES = {
  sessionCreate: "cuop:session-create",
  envOpen: "cuop:env-open",
  actionDispatch: "cuop:action-dispatch",
  escalation: "cuop:escalation",
  termination: "cuop:termination",
  budgetSettle: "cu-budget:settle",
  budgetRelease: "cu-budget:release",
  budgetReserve: "cu-budget:reserve",
  envOpenExternal: "cuenv:open",
  envActionExternal: "cuenv:action",
  envObserveExternal: "cuenv:observe",
  envCloseExternal: "cuenv:close",
  ledgerEvent: "culedger",
} as const;

export function computerUseSessionCreateKey(idempotencyKey: string): string {
  return `${COMPUTER_USE_KEY_PREFIXES.sessionCreate}:${idempotencyKey}`;
}

export function computerUseEnvOpenKey(sessionId: string, mode: ComputerUseMode): string {
  return `${COMPUTER_USE_KEY_PREFIXES.envOpen}:${sessionId}:${mode}`;
}

export function computerUseActionDispatchKey(sessionId: string, actionKey: string): string {
  return `${COMPUTER_USE_KEY_PREFIXES.actionDispatch}:${sessionId}:${actionKey}`;
}

export function computerUseEscalationKey(sessionId: string, toMode: ComputerUseMode): string {
  return `${COMPUTER_USE_KEY_PREFIXES.escalation}:${sessionId}:${toMode}`;
}

export function computerUseTerminationKey(sessionId: string, cause: string): string {
  return `${COMPUTER_USE_KEY_PREFIXES.termination}:${sessionId}:${cause}`;
}

export function computerUseBudgetReserveKey(sessionId: string): string {
  return `${COMPUTER_USE_KEY_PREFIXES.budgetReserve}:${sessionId}`;
}

export function computerUseBudgetSettleKey(sessionId: string): string {
  return `${COMPUTER_USE_KEY_PREFIXES.budgetSettle}:${sessionId}`;
}

export function computerUseBudgetReleaseKey(sessionId: string): string {
  return `${COMPUTER_USE_KEY_PREFIXES.budgetRelease}:${sessionId}`;
}

// ---------------------------------------------------------------------------
// Canonical fingerprints + digests (the idempotency discriminators)
// ---------------------------------------------------------------------------

/** Deterministic JSON with recursively sorted object keys (jsonb-safe). */
export function canonicalComputerUseJson(value: unknown): string {
  const canonical = (item: unknown): unknown => {
    if (Array.isArray(item)) {
      return item.map(canonical);
    }
    if (item !== null && typeof item === "object") {
      const record = item as Record<string, unknown>;
      return Object.keys(record)
        .sort()
        .map((key) => [key, canonical(record[key])]);
    }
    return item;
  };
  return JSON.stringify(canonical(value));
}

/** The session-request fingerprint (the idempotency discriminator). */
export function computerUseSessionFingerprint(request: ComputerUseSessionRequest): string {
  return canonicalComputerUseJson([
    "computer-use.session",
    request.applicationId,
    request.executionId,
    request.actor.actorId,
    request.task,
    request.candidates,
    request.connectionRef,
  ]);
}

/**
 * The observation body digest over the CANONICAL (recursively key-sorted)
 * form — PostgreSQL jsonb does not preserve object key order, so a
 * crash-resume replay of the same body must digest identically (the
 * WORK-026 jsonb key-order lesson, applied from the start).
 */
export function computerUseObservationDigest(
  body: Readonly<Record<string, unknown>>,
  digest: (input: string) => string,
): string {
  return digest(canonicalComputerUseJson(body));
}

// ---------------------------------------------------------------------------
// The evidence serialization (public shapes never carry observation content)
// ---------------------------------------------------------------------------

/**
 * The PUBLIC serialization of one observation for evidence consumers:
 * type, lineage, digests and retention metadata ONLY. The retained
 * `content` never crosses this boundary (digest references instead), so
 * secrets and sensitive UI state cannot leak through public
 * serialization (the evidence model's redaction requirement).
 */
export interface ComputerUseObservationEvidence {
  readonly observationType: ComputerUseObservationType;
  readonly mode: ComputerUseMode;
  readonly sessionId: string;
  readonly executionId: string;
  readonly sequence: number;
  readonly contentDigest: string;
  readonly retention: ComputerUseRetentionClass;
  readonly redaction: ComputerUseRedactionClass;
  readonly artifactRef: string | null;
  readonly capabilityId: string;
  readonly actionId: string | null;
  readonly observedAt: string;
}

export function serializeObservationEvidence(
  observation: ComputerUseObservationRecord,
): ComputerUseObservationEvidence {
  return {
    observationType: observation.observationType,
    mode: observation.mode,
    sessionId: observation.sessionId,
    executionId: observation.executionId,
    sequence: observation.sequence,
    contentDigest: observation.contentDigest,
    retention: observation.retention,
    redaction: observation.redaction,
    artifactRef: observation.artifactRef,
    capabilityId: observation.capabilityId,
    actionId: observation.actionId,
    observedAt: observation.observedAt,
  };
}

/**
 * The replayable trajectory: the ordered, lineage-bearing sequence of
 * session events, escalations, actions and observations (AC-8). Each
 * entry carries the full target/session/execution lineage so an
 * independent verifier can replay the trajectory from the durable
 * evidence alone.
 */
export type ComputerUseTrajectoryEntry =
  | {
      readonly kind: "session-opened";
      readonly sequence: number;
      readonly sessionId: string;
      readonly executionId: string;
      readonly mode: ComputerUseMode;
      readonly taskKind: ComputerUseTaskKind;
      readonly routeDigest: string;
      readonly at: string;
    }
  | {
      readonly kind: "escalation";
      readonly sequence: number;
      readonly sessionId: string;
      readonly executionId: string;
      readonly fromMode: ComputerUseMode;
      readonly toMode: ComputerUseMode;
      readonly reasonCode: string;
      readonly insufficiencyDigest: string;
      readonly at: string;
    }
  | {
      readonly kind: "action";
      readonly sequence: number;
      readonly sessionId: string;
      readonly executionId: string;
      readonly mode: ComputerUseMode;
      readonly actionType: ComputerUseActionType;
      readonly actionId: string;
      readonly target: string;
      readonly sideEffect: ComputerUseSideEffectClass;
      readonly capabilityId: string;
      readonly status: ComputerUseActionStatus;
      readonly inputDigest: string;
      readonly resultDigest: string | null;
      readonly observationSequences: readonly number[];
      readonly at: string;
    }
  | {
      readonly kind: "observation";
      readonly sequence: number;
      readonly sessionId: string;
      readonly executionId: string;
      readonly mode: ComputerUseMode;
      readonly observationType: ComputerUseObservationType;
      readonly observationId: string;
      readonly actionId: string | null;
      readonly contentDigest: string;
      readonly retention: ComputerUseRetentionClass;
      readonly redaction: ComputerUseRedactionClass;
      readonly artifactRef: string | null;
      readonly capabilityId: string;
      readonly at: string;
    };

// ---------------------------------------------------------------------------
// Validation (pure, fail-closed)
// ---------------------------------------------------------------------------

const CAPABILITY_ID = /^computer-use-[a-z0-9][a-z0-9-]{0,98}$/;
const MICRO_USD = /^\d{1,19}$/;
const HOST = /^[a-z0-9][a-z0-9.-]{0,253}$/;
const SECRET_REF = /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,199}$/;

export type ComputerUseCheck =
  | { readonly valid: true }
  | { readonly valid: false; readonly reason: string };

/** Validate a capability declaration (fail-closed; AC-5's first half). */
export function validateComputerUseCapability(declaration: unknown): ComputerUseCheck {
  if (declaration === null || typeof declaration !== "object" || Array.isArray(declaration)) {
    return { valid: false, reason: "capability declaration must be an object" };
  }
  const c = declaration as ComputerUseCapabilityDeclaration;
  if (typeof c.capabilityId !== "string" || !CAPABILITY_ID.test(c.capabilityId)) {
    return {
      valid: false,
      reason: "capabilityId must be a computer-use-* namespaced identifier",
    };
  }
  if (typeof c.kind !== "string" || !isComputerUseCapabilityKind(c.kind)) {
    return { valid: false, reason: "kind must be one of the capability-kind vocabulary" };
  }
  if (
    typeof c.description !== "string" ||
    c.description.length === 0 ||
    c.description.length > 500
  ) {
    return { valid: false, reason: "description must be 1..500 chars" };
  }
  if (
    typeof c.capabilityAtom !== "string" ||
    c.capabilityAtom.length === 0 ||
    c.capabilityAtom.length > 120
  ) {
    return { valid: false, reason: "capabilityAtom must be 1..120 chars" };
  }
  if (!Array.isArray(c.covers)) {
    return { valid: false, reason: "covers must be an array of requirement atoms" };
  }
  if (c.covers.length > 64) {
    return { valid: false, reason: "covers is bounded at 64 atoms" };
  }
  for (const atom of c.covers) {
    if (typeof atom !== "string" || atom.length === 0 || atom.length > 200) {
      return { valid: false, reason: "covered requirement atoms must be 1..200 chars" };
    }
  }
  if (c.kind === "deterministic") {
    if (
      typeof c.deterministicQuality !== "number" ||
      c.deterministicQuality < 0 ||
      c.deterministicQuality > 1
    ) {
      return {
        valid: false,
        reason: "deterministic capabilities declare deterministicQuality on the 0..1 scale",
      };
    }
    if (c.qualityConfidence !== "verified" && c.qualityConfidence !== "estimated") {
      return {
        valid: false,
        reason: "deterministic capabilities declare qualityConfidence (verified|estimated)",
      };
    }
    if (c.covers.length === 0) {
      return {
        valid: false,
        reason: "deterministic capabilities declare the requirement atoms they cover",
      };
    }
  } else {
    if (c.deterministicQuality !== null && c.deterministicQuality !== undefined) {
      return { valid: false, reason: "GUI capabilities do not declare deterministic quality" };
    }
    if (c.qualityConfidence !== null && c.qualityConfidence !== undefined) {
      return { valid: false, reason: "GUI capabilities do not declare quality confidence" };
    }
  }
  if (typeof c.estimatedMicroUsd !== "string" || !MICRO_USD.test(c.estimatedMicroUsd)) {
    return { valid: false, reason: "estimatedMicroUsd must be an integer micro-USD string" };
  }
  if (!Array.isArray(c.hosts)) {
    return { valid: false, reason: "hosts must be an array" };
  }
  if (new Set(c.hosts).size !== c.hosts.length) {
    return { valid: false, reason: "hosts must not contain duplicates" };
  }
  for (const host of c.hosts) {
    if (typeof host !== "string" || !HOST.test(host)) {
      return { valid: false, reason: `host "${String(host)}" is not a valid hostname` };
    }
  }
  if (c.secretRef !== null && c.secretRef !== undefined && typeof c.secretRef !== "string") {
    return { valid: false, reason: "secretRef must be a string or null" };
  }
  if (typeof c.secretRef === "string" && !SECRET_REF.test(c.secretRef)) {
    return { valid: false, reason: "secretRef must be an opaque reference" };
  }
  if (c.kind === "desktop") {
    if (c.desktopEnvelope === null || typeof c.desktopEnvelope !== "object") {
      return {
        valid: false,
        reason: "desktop capabilities declare an explicit capability envelope",
      };
    }
    for (const grant of COMPUTER_USE_DESKTOP_GRANTS) {
      if (typeof c.desktopEnvelope[grant] !== "boolean") {
        return {
          valid: false,
          reason: `the desktop envelope must declare the ${grant} grant explicitly (boolean)`,
        };
      }
    }
    if (c.terminalPolicy === null || typeof c.terminalPolicy !== "object") {
      return { valid: false, reason: "desktop capabilities declare an explicit terminal policy" };
    }
    const terminal = c.terminalPolicy;
    if (
      typeof terminal.process !== "boolean" ||
      typeof terminal.filesystem !== "boolean" ||
      typeof terminal.network !== "boolean"
    ) {
      return {
        valid: false,
        reason:
          "the terminal policy must declare process/filesystem/network capabilities explicitly",
      };
    }
    if (!terminal.process) {
      return {
        valid: false,
        reason:
          "a desktop capability with terminal interaction must grant the process capability",
      };
    }
    if (!Array.isArray(terminal.egressAllowlist)) {
      return { valid: false, reason: "terminal egressAllowlist must be an array" };
    }
    if (terminal.network && terminal.egressAllowlist.length === 0) {
      return {
        valid: false,
        reason:
          "networked terminal policies must declare a non-empty egress allowlist (no hidden network access)",
      };
    }
    if (!terminal.network && terminal.egressAllowlist.length > 0) {
      return {
        valid: false,
        reason: "terminal egressAllowlist must be empty when network is not granted",
      };
    }
  }
  if (c.kind === "browser") {
    if (c.browserProfile === null || typeof c.browserProfile !== "object") {
      return { valid: false, reason: "browser capabilities declare an isolation profile" };
    }
    const profile = c.browserProfile;
    if (!Array.isArray(profile.egressAllowlist) || profile.egressAllowlist.length === 0) {
      return {
        valid: false,
        reason: "browser capabilities declare a non-empty egress allowlist (no hidden network access)",
      };
    }
    if (new Set(profile.egressAllowlist).size !== profile.egressAllowlist.length) {
      return { valid: false, reason: "browser egressAllowlist must not contain duplicates" };
    }
    for (const host of profile.egressAllowlist) {
      if (typeof host !== "string" || !HOST.test(host)) {
        return {
          valid: false,
          reason: `browser allowlist host "${String(host)}" is not a valid hostname`,
        };
      }
    }
    if (profile.cookieJar !== BROWSER_COOKIE_JAR_POLICY) {
      return {
        valid: false,
        reason: `browser cookie jar policy is ${BROWSER_COOKIE_JAR_POLICY} (ambient cookies are unrepresentable)`,
      };
    }
    if (profile.ambientHostInheritance !== AMBIENT_HOST_INHERITANCE) {
      return {
        valid: false,
        reason: `ambient host inheritance is ${AMBIENT_HOST_INHERITANCE} (no other value exists)`,
      };
    }
  }
  return { valid: true };
}

/** Validate a session request (fail-closed, pure — before any authority call). */
export function validateComputerUseSessionRequest(request: unknown): ComputerUseCheck {
  if (request === null || typeof request !== "object" || Array.isArray(request)) {
    return { valid: false, reason: "session request must be an object" };
  }
  const r = request as ComputerUseSessionRequest;
  if (typeof r.applicationId !== "string" || r.applicationId.length === 0) {
    return { valid: false, reason: "applicationId is required" };
  }
  if (typeof r.executionId !== "string" || r.executionId.length === 0) {
    return { valid: false, reason: "executionId is required (the parent execution)" };
  }
  if (
    r.actor === null ||
    typeof r.actor !== "object" ||
    typeof r.actor.actorId !== "string" ||
    r.actor.actorId.length === 0 ||
    typeof r.actor.tenantId !== "string" ||
    r.actor.tenantId.length === 0
  ) {
    return { valid: false, reason: "a server-derived actor scope is required" };
  }
  if (r.task === null || typeof r.task !== "object") {
    return { valid: false, reason: "a task descriptor is required" };
  }
  if (typeof r.task.kind !== "string" || !isComputerUseTaskKind(r.task.kind)) {
    return { valid: false, reason: "task.kind must be a task-kind vocabulary value" };
  }
  if (!Array.isArray(r.task.requirementAtoms)) {
    return { valid: false, reason: "task.requirementAtoms must be an array" };
  }
  if (r.task.requirementAtoms.length > 64) {
    return { valid: false, reason: "task.requirementAtoms is bounded at 64 atoms" };
  }
  for (const atom of r.task.requirementAtoms) {
    if (typeof atom !== "string" || atom.length === 0 || atom.length > 200) {
      return { valid: false, reason: "requirement atoms must be 1..200 chars" };
    }
  }
  if (
    typeof r.task.qualityTarget !== "number" ||
    r.task.qualityTarget < COMPUTER_USE_QUALITY_MIN ||
    r.task.qualityTarget > COMPUTER_USE_QUALITY_MAX
  ) {
    return { valid: false, reason: "task.qualityTarget must be on the 0..1 scale" };
  }
  if (r.candidates === null || typeof r.candidates !== "object") {
    return { valid: false, reason: "a candidates descriptor is required" };
  }
  if (!Array.isArray(r.candidates.deterministic)) {
    return { valid: false, reason: "candidates.deterministic must be an array" };
  }
  if (r.candidates.deterministic.length > 8) {
    return { valid: false, reason: "at most 8 deterministic candidates per task" };
  }
  for (const id of r.candidates.deterministic) {
    if (typeof id !== "string" || id.length === 0) {
      return { valid: false, reason: "deterministic candidate ids must be non-empty strings" };
    }
  }
  if (
    r.candidates.browser !== null &&
    r.candidates.browser !== undefined &&
    typeof r.candidates.browser !== "string"
  ) {
    return { valid: false, reason: "candidates.browser must be a capability id or null" };
  }
  if (
    r.candidates.desktop !== null &&
    r.candidates.desktop !== undefined &&
    typeof r.candidates.desktop !== "string"
  ) {
    return { valid: false, reason: "candidates.desktop must be a capability id or null" };
  }
  if (
    r.connectionRef !== null &&
    r.connectionRef !== undefined &&
    typeof r.connectionRef !== "string"
  ) {
    return { valid: false, reason: "connectionRef must be a string or null" };
  }
  return { valid: true };
}

/**
 * Action confinement: the action type must belong to the CURRENT mode's
 * vocabulary, and the desktop envelope grant (when the action needs one)
 * must be explicitly true. Fail-closed — an action outside the declared
 * envelope is unrepresentable (ambient authority does not exist).
 */
export function actionConfinementCheck(
  mode: ComputerUseMode,
  actionType: ComputerUseActionType,
  envelope: ComputerUseDesktopEnvelope | null,
): ComputerUseCheck {
  if (!MODE_ACTION_VOCABULARIES[mode].includes(actionType)) {
    return {
      valid: false,
      reason: `action ${actionType} is not in the ${mode} mode's action vocabulary`,
    };
  }
  const requiredGrant = DESKTOP_ACTION_GRANTS[actionType];
  if (requiredGrant !== null) {
    if (envelope === null) {
      return {
        valid: false,
        reason: `action ${actionType} requires the desktop envelope's ${requiredGrant} grant and no envelope is admitted`,
      };
    }
    if (!envelope[requiredGrant]) {
      return {
        valid: false,
        reason: `the desktop envelope does not grant ${requiredGrant}; action ${actionType} is confined out`,
      };
    }
  }
  return { valid: true };
}

/**
 * Escalation validation: the target must be the NEXT mode in the frozen
 * order (no skipping — deterministic → browser → desktop only), the
 * current mode must be escalatable, and escalation past desktop is
 * unrepresentable.
 */
export function escalationTargetCheck(
  currentMode: ComputerUseMode,
  targetMode: ComputerUseMode,
): ComputerUseCheck {
  const next = nextComputerUseMode(currentMode);
  if (next === null) {
    return {
      valid: false,
      reason:
        "the session is already at the top of the escalation ladder (desktop); no further mode exists",
    };
  }
  if (targetMode !== next) {
    return {
      valid: false,
      reason: `escalation must follow the frozen ladder (${currentMode} → ${next}); skipping to ${targetMode} is unrepresentable`,
    };
  }
  return { valid: true };
}

/**
 * Egress confinement: a host the action would reach must be inside the
 * declared allowlist (no hidden network access — an undeclared host is
 * refused BEFORE any environment interaction).
 */
export function egressConfinementCheck(
  host: string,
  allowlist: readonly string[],
): ComputerUseCheck {
  if (!allowlist.includes(host)) {
    return {
      valid: false,
      reason: `host ${host} is not in the declared egress allowlist; hidden network access is refused before dispatch`,
    };
  }
  return { valid: true };
}
