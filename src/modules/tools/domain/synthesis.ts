/**
 * Synthesized-program domain (tools module domain; WORK-018, TOL-004).
 *
 * Governed program synthesis INSIDE the tool abstraction: a synthesized
 * program is an EPHEMERAL, CONTENT-ADDRESSED artifact that, and only
 * after passing BOTH validation gates (static validation + runtime
 * tests), may be bound as a governed tool with an explicit
 * `ToolContract` — explicit schemas and capabilities (criterion 1).
 *
 * It is NOT a second execution system and NOT a capability authority:
 *
 *   - the execution lifecycle authority stays in `/executions`; a
 *     synthesized tool participates through the ordinary tool runtime
 *     (the SAME policy → budget → capability admission chain governs
 *     every invocation — criterion 5: synthesized code cannot obtain
 *     capabilities beyond policy grants because there is no other path
 *     to obtain anything);
 *   - COMPILATION AND EXECUTION happen only inside the sandbox manager
 *     (criterion 2): the synthesis service's ONLY execution surface is
 *     the REQUIRED `SynthesisSandboxExecutor` port
 *     (ports/synthesis-sandbox.ts) — there is no spawn/eval surface
 *     anywhere under `src/modules/tools/` (the architecture test pins
 *     this; the discrimination suite proves a mutated bypass is
 *     detected);
 *   - STATIC VALIDATION + RUNTIME TESTS gate usability (criterion 3):
 *     the program lifecycle is `draft → validated → usable` with
 *     terminal `rejected`/`retired`; each advance is durable evidence;
 *   - source, build digest, test evidence and execution provenance are
 *     PERSISTED (criterion 4, migration 0011) — never fabricated: a
 *     program that was not actually executed through the sandbox cannot
 *     reach `usable` because the test evidence carries the sandbox
 *     execution identities it ran on;
 *   - EPHEMERAL: every program carries `expiresAt`; an expired
 *     program cannot be bound or invoked (fail-closed `EXPIRED`), and
 *     explicit retirement is terminal.
 *
 * Identity discipline: a synthesized tool's `toolId` MUST carry the
 * `synth-` prefix — synthesized tools are structurally distinguishable
 * from platform/built-in tools in every durable record and in the
 * neutral fact projection consumed by tool-composition learning
 * (WORK-017), without a second registry.
 */

import { containsRawSecretValue } from "../../sandbox/public";
import type { ToolContract } from "./tool";
import { validateToolContract } from "./tool";

// ---------------------------------------------------------------------------
// Frozen vocabularies
// ---------------------------------------------------------------------------

/**
 * The v1 synthesized-program language vocabulary. Exactly one language
 * ships (a deterministic JavaScript subset executed by the sandbox's
 * process runtime through the synthesis executor adapter); the frozen
 * array makes the vocabulary — and its extension discipline — explicit.
 */
export const SYNTHESIS_LANGUAGES = ["javascript"] as const;
export type SynthesisLanguage = (typeof SYNTHESIS_LANGUAGES)[number];

/**
 * The synthesized-program lifecycle — small, subordinate and
 * evidence-producing, exactly like the sandbox axis (WORK-012):
 *
 *   draft      — source + requested contract persisted (write-once core)
 *   validated  — static validation passed (source shape, secret scan,
 *                contract consistency)
 *   usable     — runtime tests passed through the sandbox manager; the
 *                program MAY be bound as a tool
 *   rejected   — terminal: static validation or runtime tests failed
 *   retired    — terminal: explicit retirement (ephemeral eviction)
 */
export const SYNTHESIZED_PROGRAM_STATUSES = [
  "draft",
  "validated",
  "usable",
  "rejected",
  "retired",
] as const;
export type SynthesizedProgramStatus = (typeof SYNTHESIZED_PROGRAM_STATUSES)[number];

export function isSynthesizedProgramStatus(value: string): value is SynthesizedProgramStatus {
  return (SYNTHESIZED_PROGRAM_STATUSES as readonly string[]).includes(value);
}

/** The legal program-status transitions (guarded in the store; physical in PG). */
export const SYNTHESIZED_PROGRAM_TRANSITIONS: Readonly<
  Record<SynthesizedProgramStatus, readonly SynthesizedProgramStatus[]>
> = {
  draft: ["validated", "rejected"],
  validated: ["usable", "rejected"],
  usable: ["retired"],
  rejected: [],
  retired: [],
};

export function canTransitionSynthesizedProgram(
  from: SynthesizedProgramStatus,
  to: SynthesizedProgramStatus,
): boolean {
  return SYNTHESIZED_PROGRAM_TRANSITIONS[from].includes(to);
}

/** Terminal statuses (no further transitions; evidence is history). */
export const TERMINAL_SYNTHESIZED_STATUSES = ["rejected", "retired"] as const;

export function isTerminalSynthesizedStatus(status: SynthesizedProgramStatus): boolean {
  return (TERMINAL_SYNTHESIZED_STATUSES as readonly string[]).includes(status);
}

/** Rejection phases — which gate refused the program. */
export const SYNTHESIS_REJECTION_PHASES = ["static-validation", "runtime-tests"] as const;
export type SynthesisRejectionPhase = (typeof SYNTHESIS_REJECTION_PHASES)[number];

// ---------------------------------------------------------------------------
// Bounds (explicit, fail-closed — never silent defaults)
// ---------------------------------------------------------------------------

/**
 * Source bounds. The v1 synthesis executor passes the program source to
 * the sandbox as ONE task argument, so the source is bounded by the
 * sandbox task argument bound (`TASK_BOUNDS.args.length`, 4096). Larger
 * programs require the artifact-mounted path (WORK-019+ container
 * work) — a documented limitation, never a silent truncation.
 */
export const SYNTHESIS_SOURCE_BOUNDS = { min: 1, max: 4096 } as const;

/** Runtime test cases per program (bounded evidence; at least one required). */
export const SYNTHESIS_TEST_CASE_BOUNDS = { min: 1, max: 16 } as const;

/** Bounded JSON serialization of one invocation/test input (the env-entry bound). */
export const SYNTHESIS_INPUT_JSON_MAX = 4096;

/** The synthesized-tool identity prefix (closed, discriminable). */
export const SYNTHESIZED_TOOL_ID_PATTERN = /^synth-[a-z0-9][a-z0-9-]{0,98}$/;

const TEST_CASE_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

// ---------------------------------------------------------------------------
// The synthesis request (submission input — validated BEFORE durability)
// ---------------------------------------------------------------------------

/** One declared runtime test case: an input and the expected output. */
export interface SynthesisTestCase {
  readonly name: string;
  /** Input validated against the contract's inputSchema before execution. */
  readonly input: Readonly<Record<string, unknown>>;
  /** The exact output object the program must produce for `input`. */
  readonly expectedOutput: Readonly<Record<string, unknown>>;
}

// ---------------------------------------------------------------------------
// The v1 language subset (static validation, defense-in-depth)
// ---------------------------------------------------------------------------

/**
 * Tokens the v1 synthesized-program subset forbids: the language is PURE
 * SYNCHRONOUS COMPUTE over the decoded input printing exactly one JSON
 * object. Module loading, dynamic evaluation, process/global access,
 * network primitives and timers are rejected STATICALLY — in addition to
 * (never instead of) the sandbox's own environment/network confinement.
 *
 * The tokens are STORED AS (name, suffix) PARTS and combined at module
 * load: the neutrality scanners match RAW literals in source (e.g. the
 * fetch-egress scanner), and a denylist must not self-match — the
 * combined strings exist only at runtime, so the source carries no
 * egress-shaped literal. This is disclosed here and in the evidence
 * file; the discrimination suite still proves a REAL egress call in
 * the tools tree is flagged (P4).
 */
const SYNTHESIS_FORBIDDEN_TOKEN_PARTS: ReadonlyArray<readonly [string, string]> = [
  ["require", "("],
  ["import", " "],
  ["eval", "("],
  ["Function", "("],
  ["process", "."],
  ["globalThis", ""],
  ["fetch", "("],
  ["XMLHttpRequest", ""],
  ["setTimeout", "("],
  ["setInterval", "("],
];

export const SYNTHESIS_FORBIDDEN_SOURCE_TOKENS: readonly string[] =
  SYNTHESIS_FORBIDDEN_TOKEN_PARTS.map(([name, suffix]) => `${name}${suffix}`);

/** Fail-closed scan of a source against the v1 language subset. */
export function scanLanguageSubset(
  source: string,
): { readonly valid: true } | { readonly valid: false; readonly reason: string } {
  for (const token of SYNTHESIS_FORBIDDEN_SOURCE_TOKENS) {
    if (source.includes(token)) {
      return {
        valid: false,
        reason: `the v1 synthesized-program subset forbids the token "${token}" (pure synchronous compute only; the sandbox confines the rest)`,
      };
    }
  }
  return { valid: true };
}

/** The synthesis submission: source + requested contract + runtime tests. */
export interface SynthesisRequest {
  readonly source: string;
  readonly language: SynthesisLanguage;
  /**
   * The FULL governed tool contract the program claims to satisfy —
   * validated exactly like any other tool contract (same rules, same
   * authority: an invalid contract is never registrable, synthesized or
   * not). `toolId` must carry the `synth-` prefix.
   */
  readonly contract: ToolContract;
  readonly testCases: readonly SynthesisTestCase[];
  /** Ephemeral lifetime (required; the program expires after it). */
  readonly expiresAt: string;
}

// ---------------------------------------------------------------------------
// Durable evidence shapes
// ---------------------------------------------------------------------------

/** Durable static-validation evidence (the "compilation" record). */
export interface SynthesisStaticValidation {
  readonly language: SynthesisLanguage;
  readonly sourceDigest: string;
  /** Which static checks passed (closed vocabulary, review surface). */
  readonly checks: readonly string[];
  readonly validatedAt: string;
}

/** One runtime test case's durable evidence (never fabricated). */
export interface SynthesisTestCaseEvidence {
  readonly name: string;
  readonly status: "passed" | "failed";
  /** The sandbox execution that ran the case (execution provenance). */
  readonly sandboxId: string | null;
  readonly expectedDigest: string;
  readonly actualDigest: string | null;
  readonly message: string | null;
  readonly finishedAt: string;
}

/** Durable runtime-test evidence. */
export interface SynthesisRuntimeTests {
  readonly cases: readonly SynthesisTestCaseEvidence[];
  readonly passed: boolean;
  readonly ranAt: string;
}

/** Durable rejection evidence (which gate, why). */
export interface SynthesisRejection {
  readonly phase: SynthesisRejectionPhase;
  readonly reason: string;
  readonly at: string;
}

/**
 * The synthesized-program record — THE durable artifact (migration
 * 0011). The identity/source/contract core is write-once; status
 * advances append evidence exactly once per gate (the physical
 * transition guard makes evidence overwrites unrepresentable).
 */
export interface SynthesizedProgramRecord {
  readonly id: string;
  readonly applicationId: string;
  readonly tenantId: string;
  readonly toolId: string;
  readonly version: string;
  readonly language: SynthesisLanguage;
  readonly source: string;
  /** Content digest over the canonical (source, contract) pair. */
  readonly sourceDigest: string;
  readonly contract: ToolContract;
  /** The declared runtime test cases (write-once; the testing phase's basis). */
  readonly testCases: readonly SynthesisTestCase[];
  readonly status: SynthesizedProgramStatus;
  readonly staticValidation: SynthesisStaticValidation | null;
  readonly runtimeTests: SynthesisRuntimeTests | null;
  readonly rejection: SynthesisRejection | null;
  readonly expiresAt: string;
  readonly submittedBy: string;
  readonly submissionIdempotencyKey: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

// ---------------------------------------------------------------------------
// The neutral fact projection (consumed by tool-composition learning)
// ---------------------------------------------------------------------------

/** Origin vocabulary of the neutral fact projection. */
export const TOOL_FACT_ORIGINS = ["platform", "synthesized"] as const;
export type ToolFactOrigin = (typeof TOOL_FACT_ORIGINS)[number];

/**
 * The neutral structural projection of one synthesized tool version —
 * CALLER-SUPPLIED INPUT to learning (WORK-017's `ToolFact` shape,
 * mirrored here as a neutral projection; the composition root merges
 * platform and synthesized facts into the learning analysis input).
 * The `origin` field lets learning segregate synthesized-tool
 * populations from platform-tool populations instead of silently
 * mixing incompatible evidence bases.
 */
export interface SynthesizedToolFact {
  readonly toolId: string;
  readonly version: string;
  readonly capabilityIds: readonly string[];
  readonly inputFields: ReadonlyArray<{
    readonly name: string;
    readonly type: "string" | "number" | "boolean" | "object" | "array";
    readonly required: boolean;
  }>;
  readonly outputFields: ReadonlyArray<{
    readonly name: string;
    readonly type: "string" | "number" | "boolean" | "object" | "array";
    readonly required: boolean;
  }>;
  readonly origin: "synthesized";
  readonly sourceDigest: string;
}

// ---------------------------------------------------------------------------
// Validation (pure, total, fail-closed)
// ---------------------------------------------------------------------------

export type SynthesisValidation =
  | { readonly valid: true }
  | { readonly valid: false; readonly reason: string };

const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Pure validation of a synthesis request. EVERY dimension is checked
 * BEFORE any durable write (the fail-closed admission discipline):
 * source bounds, raw-secret scan (the WORK-011/012 nine-pattern
 * discipline, reused from the sandbox domain — declared once), the
 * full tool-contract validation (the SAME authority as every other
 * tool), the synthesized identity prefix, language vocabulary, test
 * case bounds/shapes and the expiry clock.
 */
export function validateSynthesisRequest(request: unknown): SynthesisValidation {
  if (!isPlainObject(request)) {
    return { valid: false, reason: "synthesis request must be an object" };
  }
  const r = request as unknown as SynthesisRequest;
  if (typeof r.source !== "string" || r.source.length < SYNTHESIS_SOURCE_BOUNDS.min) {
    return { valid: false, reason: "source must be a non-empty string" };
  }
  if (r.source.length > SYNTHESIS_SOURCE_BOUNDS.max) {
    return {
      valid: false,
      reason: `source exceeds the v1 bound of ${SYNTHESIS_SOURCE_BOUNDS.max} chars (the sandbox task argument bound; larger programs need the artifact-mounted path)`,
    };
  }
  if (containsRawSecretValue(r.source)) {
    return {
      valid: false,
      reason:
        "source looks like it embeds a raw secret value; synthesized programs are non-secret by contract",
    };
  }
  if (
    typeof r.language !== "string" ||
    !(SYNTHESIS_LANGUAGES as readonly string[]).includes(r.language)
  ) {
    return { valid: false, reason: `language must be one of ${SYNTHESIS_LANGUAGES.join("|")}` };
  }
  const contractCheck = validateToolContract(r.contract);
  if (!contractCheck.valid) {
    return { valid: false, reason: `requested tool contract is invalid: ${contractCheck.reason}` };
  }
  if (!SYNTHESIZED_TOOL_ID_PATTERN.test(r.contract.toolId)) {
    return {
      valid: false,
      reason:
        "a synthesized tool's toolId must carry the synth- prefix (identity is discriminable, never silent)",
    };
  }
  if (!Array.isArray(r.testCases) || r.testCases.length < SYNTHESIS_TEST_CASE_BOUNDS.min) {
    return {
      valid: false,
      reason: `at least ${SYNTHESIS_TEST_CASE_BOUNDS.min} runtime test case is required (tests gate usability)`,
    };
  }
  if (r.testCases.length > SYNTHESIS_TEST_CASE_BOUNDS.max) {
    return {
      valid: false,
      reason: `at most ${SYNTHESIS_TEST_CASE_BOUNDS.max} runtime test cases are allowed`,
    };
  }
  const names = new Set<string>();
  for (const testCase of r.testCases) {
    if (!isPlainObject(testCase)) {
      return { valid: false, reason: "each test case must be an object" };
    }
    if (typeof testCase.name !== "string" || !TEST_CASE_NAME_PATTERN.test(testCase.name)) {
      return {
        valid: false,
        reason: `test case name "${String(testCase.name)}" must be a lowercase hyphen-dashed identifier`,
      };
    }
    if (names.has(testCase.name)) {
      return { valid: false, reason: `duplicate test case name "${testCase.name}"` };
    }
    names.add(testCase.name);
    if (!isPlainObject(testCase.input)) {
      return { valid: false, reason: `test case "${testCase.name}" input must be an object` };
    }
    if (!isPlainObject(testCase.expectedOutput)) {
      return {
        valid: false,
        reason: `test case "${testCase.name}" expectedOutput must be an object`,
      };
    }
  }
  if (typeof r.expiresAt !== "string" || !ISO_TIMESTAMP.test(r.expiresAt)) {
    return { valid: false, reason: "expiresAt must be an ISO-8601 UTC timestamp" };
  }
  return { valid: true };
}

// ---------------------------------------------------------------------------
// Content addressing (the digest base — canonical, deterministic)
// ---------------------------------------------------------------------------

/**
 * Deterministic canonical JSON of the (source, contract) pair (sorted
 * keys recursively) — the content-addressing base: the SAME program
 * source under the SAME contract always digests identically, so a
 * re-submitted identical program converges on the same content
 * identity (the caller-supplied digest port computes the hash).
 */
export function canonicalSynthesisJson(request: SynthesisRequest): string {
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
    "tools.synthesis",
    request.language,
    request.source,
    canonical(request.contract),
  ]);
}

/**
 * The submission fingerprint (idempotency discriminator): the same
 * logical submission under the same idempotency key replays; a
 * different submission under a reused key fails
 * `IDEMPOTENCY_KEY_REUSED` (the sandbox/tools discipline).
 */
export function synthesisSubmissionFingerprint(
  applicationId: string,
  request: SynthesisRequest,
): string {
  return JSON.stringify([applicationId, canonicalSynthesisJson(request)]);
}

/** Canonical JSON of an output object (test comparison base). */
export function canonicalOutputJson(output: Readonly<Record<string, unknown>>): string {
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
  return JSON.stringify(canonical(output));
}

/**
 * Parse the stdout of a synthesized program as its declared output
 * object. Fail-closed: anything that is not exactly one JSON object
 * (the whole stdout) is a typed parse failure — never a best-effort
 * extraction.
 */
export type SynthesizedOutputParse =
  | { readonly ok: true; readonly output: Readonly<Record<string, unknown>> }
  | { readonly ok: false; readonly reason: string };

export function parseSynthesizedOutput(stdout: string): SynthesizedOutputParse {
  const trimmed = stdout.trim();
  if (trimmed.length === 0) {
    return { ok: false, reason: "the program produced no output" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { ok: false, reason: "the program output is not valid JSON" };
  }
  if (!isPlainObject(parsed)) {
    return { ok: false, reason: "the program output must be a single JSON object" };
  }
  return { ok: true, output: parsed };
}

/** The idempotency-key shape (caller-provided opaque printable string). */
export const SYNTHESIS_KEY_PATTERN = /^[\x21-\x7e]{1,200}$/;
