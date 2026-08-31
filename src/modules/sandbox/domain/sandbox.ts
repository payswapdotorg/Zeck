/**
 * Sandbox-execution domain model (sandbox module; WORK-012, ENV-002).
 *
 * `SandboxExecution` is the governed execution of ONE unit of work in ONE
 * compute environment — an execution PARTICIPANT on the sandbox axis,
 * exactly like a tool invocation on the tool axis and an agent session on
 * the agent axis. It is NOT a second execution system:
 *
 *   - the execution lifecycle authority stays in `/executions` (this row
 *     never writes execution status; evidence rides the executions
 *     EventEnvelope ledger as step events through the REQUIRED ledger
 *     seam);
 *   - the sandbox lifecycle here is small and subordinate:
 *     `denied` (insert-only admission denial) · `admitted` (durable
 *     admission bundle) · `dispatching` (durable intent, the §14 honest
 *     crash state) · `completed`/`failed` (terminal, physically immutable);
 *   - policy/capability/budget decisions belong to their authorities and
 *     are consulted through REQUIRED seams — never reimplemented here.
 *
 * Security model at this layer:
 *   - the TASK (command/args/publicEnv) is validated at admission; raw
 *     secret-shaped values are REJECTED before anything durable
 *     (`containsRawSecretValue`, M8);
 *   - the RUNTIME METADATA (the immutable admitted snapshot: spec + task +
 *     admission evidence) is write-once — the dispatched work is ALWAYS
 *     the admitted work (M13);
 *   - the runtime contract the provider receives (`SandboxRuntimeSpec`,
 *     ports layer) carries REFERENCES only — no stores, no authorities,
 *     no secret values, no ambient host access (M1/M7/M8).
 */

import type { SandboxEnvironmentKind } from "./environment";

// ---------------------------------------------------------------------------
// Sandbox lifecycle (subordinate bookkeeping — never an execution system)
// ---------------------------------------------------------------------------

export const SANDBOX_EXECUTION_STATUSES = [
  "denied",
  "admitted",
  "dispatching",
  "completed",
  "failed",
] as const;

export type SandboxExecutionStatus = (typeof SANDBOX_EXECUTION_STATUSES)[number];

export const TERMINAL_SANDBOX_STATUSES = ["denied", "completed", "failed"] as const;

export function isSandboxExecutionStatus(value: string): value is SandboxExecutionStatus {
  return (SANDBOX_EXECUTION_STATUSES as readonly string[]).includes(value);
}

export function isTerminalSandboxStatus(status: SandboxExecutionStatus): boolean {
  return (TERMINAL_SANDBOX_STATUSES as readonly string[]).includes(status);
}

/** The legal row transitions (guarded in the store; enforced physically in PG). */
export const SANDBOX_STATUS_TRANSITIONS: Readonly<
  Record<SandboxExecutionStatus, readonly SandboxExecutionStatus[]>
> = {
  denied: [],
  admitted: ["dispatching"],
  dispatching: ["completed", "failed"],
  completed: [],
  failed: [],
};

export function canTransitionSandbox(
  from: SandboxExecutionStatus,
  to: SandboxExecutionStatus,
): boolean {
  return SANDBOX_STATUS_TRANSITIONS[from].includes(to);
}

// ---------------------------------------------------------------------------
// Admission/outcome vocabularies (the sandbox axis only)
// ---------------------------------------------------------------------------

/** Admission denial classes — exactly the three admission authorities. */
export const SANDBOX_DENIAL_CLASSES = ["policy", "budget", "capability"] as const;

export type SandboxDenialClass = (typeof SANDBOX_DENIAL_CLASSES)[number];

export type SandboxDenialCode = "POLICY_DENIED" | "BUDGET_EXCEEDED" | "CAPABILITY_UNAVAILABLE";

/** Sandbox-axis outcome classes — physically disjoint from verification/provider/tool classes. */
export const SANDBOX_OUTCOME_CLASSES = ["sandbox-success", "sandbox-failure"] as const;

export type SandboxOutcomeClass = (typeof SANDBOX_OUTCOME_CLASSES)[number];

/** Sandbox-axis failure classes. */
export const SANDBOX_FAILURE_CLASSES = [
  "sandbox-execution",
  "timeout",
  "adapter-error",
  "runtime-unavailable",
] as const;

export type SandboxFailureClass = (typeof SANDBOX_FAILURE_CLASSES)[number];

export function isSandboxFailureClass(value: string): value is SandboxFailureClass {
  return (SANDBOX_FAILURE_CLASSES as readonly string[]).includes(value);
}

// ---------------------------------------------------------------------------
// The task (what runs in the environment) — explicit, non-secret by contract
// ---------------------------------------------------------------------------

/**
 * The unit of work a sandbox executes. `command` is an argv program (no
 * shell — the runtimes never invoke a shell); `publicEnv` is the EXPLICIT
 * non-secret environment (never the ambient host environment, M1); secret
 * material is NEVER in the task — it is mediated by reference through the
 * environment's secret policy at adapter-dispatch time (M8).
 */
export interface SandboxTask {
  readonly command: string;
  readonly args: readonly string[];
  readonly publicEnv: Readonly<Record<string, string>>;
}

export const TASK_BOUNDS = {
  command: { min: 1, max: 256 },
  args: { count: 128, length: 4096 },
  env: { count: 64, nameLength: 128, valueLength: 4096 },
} as const;

const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const COMMAND_PATTERN = /^[^ \t\r\n\0]+$/;

/**
 * Env NAMES that are definitionally secret-bearing. A public env entry
 * with such a name is rejected outright: `publicEnv` is non-secret by
 * contract, so a secret-shaped name is a contract violation regardless of
 * the value (M8).
 */
const SECRET_ENV_NAME_PATTERN =
  /(^|_)(API_?KEY|SECRET|PASSWORD|PASSWD|TOKEN|PRIVATE_?KEY|CREDENTIAL|CREDENTIALS)(_|$)/i;

/**
 * Raw-secret VALUE patterns (the WORK-011 9-pattern discipline, restated
 * for the sandbox axis): provider API keys (the sk- family), AWS access keys, GitHub PATs
 * (classic + fine-grained), Slack tokens, PEM private keys, JWTs, bearer
 * tokens and generic key/password assignments. A public env value that
 * matches is rejected BEFORE anything durable.
 */
const RAW_SECRET_VALUE_PATTERNS: readonly RegExp[] = [
  /sk-[A-Za-z0-9]{16,}/,
  /AKIA[0-9A-Z]{16}/,
  /ghp_[A-Za-z0-9]{20,}/,
  /github_pat_[A-Za-z0-9_]{20,}/,
  /xox[baprs]-[A-Za-z0-9-]+/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./,
  /bearer\s+[A-Za-z0-9._-]{16,}/i,
  /(api[_-]?key|apikey|secret|password|passwd|token)\s*[:=]\s*["']?[^\s"']{8,}/i,
];

/** Whether a free-text value looks like a raw long-lived secret. */
export function containsRawSecretValue(value: string): boolean {
  return RAW_SECRET_VALUE_PATTERNS.some((pattern) => pattern.test(value));
}

export interface TaskValidation {
  readonly valid: boolean;
  readonly reason?: string;
}

/** Validate a sandbox task (pure; the admission-time sanitization gate). */
export function validateSandboxTask(task: SandboxTask): TaskValidation {
  if (task === null || typeof task !== "object") {
    return { valid: false, reason: "task must be an object" };
  }
  const command = task.command;
  if (
    typeof command !== "string" ||
    command.length < TASK_BOUNDS.command.min ||
    command.length > TASK_BOUNDS.command.max ||
    !COMMAND_PATTERN.test(command)
  ) {
    return {
      valid: false,
      reason: "task.command must be a shell-free program name (1..256 chars)",
    };
  }
  const args = task.args ?? [];
  if (!Array.isArray(args) || args.length > TASK_BOUNDS.args.count) {
    return {
      valid: false,
      reason: `task.args must be an array of at most ${TASK_BOUNDS.args.count} strings`,
    };
  }
  for (const arg of args) {
    if (typeof arg !== "string" || arg.length > TASK_BOUNDS.args.length || arg.includes("\0")) {
      return {
        valid: false,
        reason: `task.args entries must be strings of at most ${TASK_BOUNDS.args.length} chars`,
      };
    }
  }
  const env = task.publicEnv ?? {};
  if (env === null || typeof env !== "object" || Array.isArray(env)) {
    return { valid: false, reason: "task.publicEnv must be an object" };
  }
  const names = Object.keys(env);
  if (names.length > TASK_BOUNDS.env.count) {
    return {
      valid: false,
      reason: `task.publicEnv may carry at most ${TASK_BOUNDS.env.count} entries`,
    };
  }
  for (const name of names) {
    if (!ENV_NAME_PATTERN.test(name) || name.length > TASK_BOUNDS.env.nameLength) {
      return {
        valid: false,
        reason: `task.publicEnv name "${name}" is not a valid environment variable name`,
      };
    }
    if (SECRET_ENV_NAME_PATTERN.test(name)) {
      return {
        valid: false,
        reason: `task.publicEnv name "${name}" is secret-shaped; publicEnv is non-secret by contract (secrets are mediated references)`,
      };
    }
    const value = env[name];
    if (typeof value !== "string" || value.length > TASK_BOUNDS.env.valueLength) {
      return {
        valid: false,
        reason: `task.publicEnv["${name}"] must be a string of at most ${TASK_BOUNDS.env.valueLength} chars`,
      };
    }
    if (containsRawSecretValue(value)) {
      return {
        valid: false,
        reason: `task.publicEnv["${name}"] looks like a raw secret value; raw secrets are never injected into sandbox tasks`,
      };
    }
  }
  return { valid: true };
}

// ---------------------------------------------------------------------------
// Admission evidence (durable provenance carried on every decision)
// ---------------------------------------------------------------------------

/** Durable policy-admission provenance (the WORK-007 evidence shape). */
export interface SandboxPolicyEvidence {
  readonly policySetId: string;
  readonly policySetVersion: number;
  readonly policyContentHash: string;
  readonly restrictionSetDigest: string;
}

// ---------------------------------------------------------------------------
// The immutable runtime metadata (criterion 4: write-once, provenance-bound)
// ---------------------------------------------------------------------------

/**
 * The IMMUTABLE admitted snapshot: exactly what was admitted, by which
 * authorities, under which environment revision. Dispatch always executes
 * THIS snapshot — never a re-read of the (possibly since-suspended)
 * environment. Persisted write-once (physical immutability, M13).
 */
export interface SandboxRuntimeMetadata {
  readonly kind: SandboxEnvironmentKind;
  readonly environmentId: string;
  readonly environmentDigest: string;
  readonly task: SandboxTask;
  readonly limits: import("./environment").SandboxResourceLimits | null;
  readonly network: import("./environment").SandboxNetworkPolicy;
  readonly filesystem: import("./environment").SandboxFilesystemPolicy;
  readonly secretRefs: readonly string[];
  readonly runtime: import("./environment").SandboxRuntimeRequirement | null;
  readonly policyEvidence: SandboxPolicyEvidence | null;
  readonly capabilitySatisfaction: string | null;
  readonly budgetOperationId: string | null;
}

// ---------------------------------------------------------------------------
// The sandbox execution record
// ---------------------------------------------------------------------------

export interface SandboxExecutionRecord {
  readonly id: string;
  readonly applicationId: string;
  readonly tenantId: string;
  readonly executionId: string;
  readonly sandboxKey: string;
  readonly requestFingerprint: string;
  readonly environmentId: string;
  readonly kind: SandboxEnvironmentKind;
  readonly status: SandboxExecutionStatus;
  readonly runtimeMetadata: SandboxRuntimeMetadata;
  readonly denialClass: SandboxDenialClass | null;
  readonly denialCode: SandboxDenialCode | null;
  readonly denialReason: string | null;
  readonly outcomeClass: SandboxOutcomeClass | null;
  readonly failureClass: SandboxFailureClass | null;
  readonly failureMessage: string | null;
  readonly retryable: boolean;
  readonly outputDigest: string | null;
  readonly usageMicroUsd: string | null;
  readonly budgetOperationId: string | null;
  readonly ledgerAdmittedSequence: number | null;
  readonly ledgerCompletedSequence: number | null;
  readonly createdAt: string;
  readonly dispatchedAt: string | null;
  readonly completedAt: string | null;
  readonly durationMs: number | null;
}

export interface SandboxCreateInput {
  readonly executionId: string;
  readonly environmentId: string;
  readonly task: SandboxTask;
}

/**
 * Canonical request fingerprint (deterministic JSON, sorted keys — the
 * idempotency discriminator): the SAME logical request replays the SAME
 * durable outcome; a different request under a reused key fails
 * `IDEMPOTENCY_KEY_REUSED`.
 */
export function sandboxRequestFingerprint(
  applicationId: string,
  executionId: string,
  actorId: string,
  input: SandboxCreateInput,
): string {
  const canonical = (value: unknown): unknown => {
    if (Array.isArray(value)) {
      return value.map(canonical);
    }
    if (value !== null && typeof value === "object") {
      const record = value as Record<string, unknown>;
      return Object.keys(record)
        .sort()
        .map((key) => [key, canonical(record[key])]);
    }
    return value;
  };
  return JSON.stringify([
    "sandbox.create",
    applicationId,
    executionId,
    actorId,
    input.environmentId,
    canonical(input.task),
  ]);
}

/** The idempotency key shape (caller-provided opaque printable string). */
export const SANDBOX_KEY_PATTERN = /^[\x21-\x7e]{1,200}$/;
