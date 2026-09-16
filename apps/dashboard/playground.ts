/**
 * Zeck interactive sandbox playground module (DEP-013 — the choose →
 * compose → run → inspect surface over the public contracts).
 *
 * A PROJECTION AND COMPOSITION SURFACE, NEVER A SECOND AUTHORITY
 * (DEP-013): this module holds NO console-local source of truth and NO
 * second admission path. Every fact it renders is SOURCED from
 * repository truth at load time and narrowed fail-fast (the same
 * discipline as the DEP-010 capability-manifest projection in
 * console.ts and the DEP-025 validation-lab projection):
 *
 *   - the workload-class catalog  `docs/developer/machine/
 *     capability-manifest.json` (through console.ts's fail-fast
 *     projection — the SAME catalog the machine manifests carry; the
 *     picker renders THIS, never a copy);
 *   - the example inventory       `docs/developer/machine/
 *     examples-manifest.json` (loaded here, fail-fast — the machine
 *     parity links project it; a family whose recorded example is
 *     missing from the inventory fails loudly at load, never renders
 *     an invented link);
 *   - the synthetic value         `benchmarks/validation/corpus` (the
 *     vocabulary                             imported — the corpus IS the
 *     synthetic task data, append-only, provenance synthetic-authored;
 *     the composer's closed vocabularies, numeric envelopes and list
 *     vocabularies are DERIVED from it, so a composed run can only
 *     reference recorded synthetic fixtures);
 *   - the capability matrix       `benchmarks/validation/capabilities`
 *     (imported — the honest availability view: which required
 *     capability has candidate provider rails, which credential env
 *     var NAMES are present in this deployment, and which capabilities
 *     are hard NOT RUN boundaries because the authorized set carries
 *     no candidate at all).
 *
 * If any of those artifacts drift, this module fails loudly at load —
 * it never invents a family, a fixture, an envelope or an availability
 * fact.
 *
 * THE INTERACTIVE RUN IS AN ORDINARY GOVERNED EXECUTION (DEP-013 AC2):
 * the composer validates CLIENT-side (before any wire call), the
 * builder emits ONLY the frozen create vocabulary (provider selection
 * is structurally impossible — the closed `task.*` form vocabulary is
 * derived from the class's advertised contract and unknown keys are
 * rejected), and the run passes through the public API under the same
 * disposable-sandbox identity, hard budget and latency ceiling the
 * DEP-010 envelope already carries (console.ts owns those constants —
 * this module composes them, never re-declares them).
 *
 * SYNTHETIC-DATA-ONLY ENFORCEMENT (DEP-013 AC7): every editable task
 * field is constrained to the synthetic corpus vocabulary — fixture
 * references and list items must be RECORDED synthetic values, numeric
 * parameters must sit inside the corpus-recorded envelope, and free
 * text is neutralized (real-world identifiers, credential-shaped
 * material, markup and opaque blobs are refused before any wire call).
 * The platform-wide synthetic-data POLICY surface is DEP-014's (not
 * yet merged at this revision) — this module enforces what exists
 * today and states that boundary honestly in the composer UI.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { CAPABILITY_MATRIX, PROVIDER_ACCESS } from "../../benchmarks/validation/capabilities";
import { GOLDEN_TASKS } from "../../benchmarks/validation/corpus";
import type { Execution, ExecutionRequest } from "../../sdk";
import {
  type ConsoleFamily,
  consoleFamilies,
  PLAYGROUND_BUDGET_LIMIT_MICRO_USD,
  PLAYGROUND_LATENCY_LIMIT_MS,
  PLAYGROUND_ORIGIN,
  type PlaygroundFormValues,
  seedCapabilities,
  validatePlaygroundForm,
} from "./console";

// ---------------------------------------------------------------------------
// The examples-manifest projection (machine parity — DEP-013 AC6)
// ---------------------------------------------------------------------------

/** One integration-kit example as the machine examples manifest records it. */
export interface PlaygroundExampleFact {
  readonly path: string;
  readonly name: string;
  readonly family: string;
  readonly title: string;
  readonly classification: string;
  readonly envVars: readonly string[];
}

const EXAMPLES_MANIFEST_URL = new URL(
  "../../docs/developer/machine/examples-manifest.json",
  import.meta.url,
);

/** The example path shape the manifest is narrowed to (examples/ only). */
const EXAMPLE_PATH_PATTERN = /^examples\/[a-z0-9][a-z0-9-]*\.ts$/;

function narrowExample(value: unknown): PlaygroundExampleFact {
  if (typeof value !== "object" || value === null) {
    throw new Error("examples manifest: each example must be a JSON object");
  }
  const record = value as Record<string, unknown>;
  const path = record.path;
  if (typeof path !== "string" || !EXAMPLE_PATH_PATTERN.test(path)) {
    throw new Error(
      `examples manifest: example path must match ${EXAMPLE_PATH_PATTERN.source} (got ${String(path)})`,
    );
  }
  const strings = (key: string): readonly string[] => {
    const raw = record[key];
    if (!Array.isArray(raw) || raw.some((entry) => typeof entry !== "string")) {
      throw new Error(`examples manifest: ${path} ${key} must be an array of strings`);
    }
    return raw as readonly string[];
  };
  const requireString = (key: string): string => {
    const raw = record[key];
    if (typeof raw !== "string" || raw.length === 0) {
      throw new Error(`examples manifest: ${path} ${key} must be a non-empty string`);
    }
    return raw;
  };
  return {
    path,
    name: requireString("name"),
    family: requireString("family"),
    title: requireString("title"),
    classification: requireString("classification"),
    envVars: strings("envVars"),
  };
}

/**
 * The ONE examples-manifest instance, loaded once at module scope from
 * the repository's validated machine artifact (fail-fast on drift).
 */
const PLAYGROUND_EXAMPLES: readonly PlaygroundExampleFact[] = (() => {
  const parsed = JSON.parse(readFileSync(fileURLToPath(EXAMPLES_MANIFEST_URL), "utf8")) as unknown;
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error("examples manifest: root must be a JSON object");
  }
  const rawExamples = (parsed as Record<string, unknown>).examples;
  if (!Array.isArray(rawExamples) || rawExamples.length === 0) {
    throw new Error("examples manifest: examples must be a non-empty array");
  }
  return rawExamples.map(narrowExample);
})();

/** Every integration-kit example the machine manifest records. */
export function playgroundExamples(): readonly PlaygroundExampleFact[] {
  return PLAYGROUND_EXAMPLES;
}

/**
 * The example behind one workload class: the manifest entry whose path
 * is the family's RECORDED example (cross-manifest single source — a
 * mismatch fails loudly at load, below, never renders an invented link).
 */
export function exampleOfFamily(family: ConsoleFamily): PlaygroundExampleFact | null {
  return PLAYGROUND_EXAMPLES.find((example) => example.path === family.example) ?? null;
}

// The single-source invariant (DEP-013 AC5) — every family's recorded
// example exists in the examples manifest and every family-classified
// example names a family the capability manifest carries — is verified
// mechanically in tests/unit/dashboard/playground-catalog.test.ts and
// by the load-time check at the bottom of this module.

// ---------------------------------------------------------------------------
// The composer schema (derived from the advertised contract + corpus)
// ---------------------------------------------------------------------------

/** One editable (or fixed) field of a workload class's advertised contract. */
export type ComposerField =
  | {
      readonly key: string;
      readonly kind: "fixed";
      readonly value: string;
      readonly label: string;
    }
  | {
      readonly key: string;
      readonly kind: "select";
      readonly values: readonly string[];
      readonly defaultValue: string;
      readonly label: string;
    }
  | {
      readonly key: string;
      readonly kind: "number";
      readonly min: number;
      readonly max: number;
      readonly defaultValue: number;
      readonly label: string;
    }
  | {
      readonly key: string;
      readonly kind: "boolean";
      readonly defaultValue: boolean;
      readonly label: string;
    }
  | {
      readonly key: string;
      readonly kind: "list";
      readonly vocabulary: readonly string[];
      readonly defaultValue: readonly string[];
      readonly label: string;
    }
  | {
      readonly key: string;
      readonly kind: "text";
      readonly maxLength: number;
      readonly defaultValue: string;
      readonly label: string;
    };

/** The synthetic-id shape a closed vocabulary value must carry. */
const SYNTHETIC_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

/** The free-text length ceiling (server-enforced; the input carries it too). */
export const SYNTHETIC_TEXT_MAX_LENGTH = 240;

/** The corpus task count of one workload family (the coverage snapshot). */
export function corpusTaskCountOf(familyId: string): number {
  return GOLDEN_TASKS.filter((task) => task.family === familyId).length;
}

/** The corpus-recorded values of one task key within one family. */
function corpusValuesOf(familyId: string, key: string): readonly unknown[] {
  const values: unknown[] = [];
  for (const task of GOLDEN_TASKS) {
    if (task.family !== familyId) {
      continue;
    }
    const value = task.input[key];
    if (value !== undefined) {
      values.push(value);
    }
  }
  return values;
}

/**
 * Derive the composer schema of one workload class from its ADVERTISED
 * CONTRACT (the manifest's recorded taskShape) with the corpus as the
 * synthetic value authority:
 *  - `kind` is FIXED (the discriminator is part of the class identity —
 *    the manifest records exactly one canonical shape per family);
 *  - a string key whose corpus values are all synthetic ids is a
 *    CLOSED vocabulary (select) — only recorded synthetic fixtures;
 *  - any other string key is FREE TEXT (synthetic-neutralized);
 *  - numbers carry the corpus-recorded envelope [min, max];
 *  - booleans are checkboxes; string lists carry the corpus vocabulary.
 */
export function composerSchemaOf(family: ConsoleFamily): readonly ComposerField[] {
  const fields: ComposerField[] = [];
  for (const [key, recorded] of Object.entries(family.taskShape)) {
    const label = `task.${key}`;
    if (key === "kind" && typeof recorded === "string") {
      fields.push({ key, kind: "fixed", value: recorded, label });
      continue;
    }
    const corpusValues = corpusValuesOf(family.family, key);
    if (typeof recorded === "number" && Number.isFinite(recorded)) {
      const numbers = corpusValues.filter(
        (value): value is number => typeof value === "number" && Number.isFinite(value),
      );
      const min = numbers.length > 0 ? Math.min(...numbers) : recorded;
      const max = numbers.length > 0 ? Math.max(...numbers) : recorded;
      fields.push({ key, kind: "number", min, max, defaultValue: recorded, label });
      continue;
    }
    if (typeof recorded === "boolean") {
      fields.push({ key, kind: "boolean", defaultValue: recorded, label });
      continue;
    }
    if (Array.isArray(recorded)) {
      const vocabulary = new Set<string>();
      for (const value of corpusValues) {
        if (Array.isArray(value)) {
          for (const item of value) {
            if (typeof item === "string") {
              vocabulary.add(item);
            }
          }
        }
      }
      const items = recorded.filter((item): item is string => typeof item === "string");
      // The manifest's recorded items are part of the advertised contract.
      for (const item of items) {
        vocabulary.add(item);
      }
      fields.push({
        key,
        kind: "list",
        vocabulary: [...vocabulary].sort(),
        defaultValue: items,
        label,
      });
      continue;
    }
    if (typeof recorded === "string") {
      const stringValues = corpusValues.filter(
        (value): value is string => typeof value === "string",
      );
      // Empty corpus values are recorded edge rows (empty-source probes),
      // not vocabulary: classification rides the non-empty values.
      const nonEmpty = stringValues.filter((value) => value.length > 0);
      const closedVocabulary =
        nonEmpty.length > 0 && nonEmpty.every((value) => SYNTHETIC_ID_PATTERN.test(value));
      if (closedVocabulary) {
        const unique = new Set(nonEmpty);
        // The manifest's recorded value is part of the advertised contract
        // even when the corpus has not (yet) recorded it as a row.
        if (recorded.length > 0) {
          unique.add(recorded);
        }
        fields.push({
          key,
          kind: "select",
          values: [...unique].sort(),
          defaultValue: recorded,
          label,
        });
        continue;
      }
      fields.push({
        key,
        kind: "text",
        maxLength: SYNTHETIC_TEXT_MAX_LENGTH,
        defaultValue: recorded,
        label,
      });
      continue;
    }
    // The manifest records a shape the composer cannot honestly edit
    // (an object or null): render it FIXED as its JSON form rather than
    // inventing an editor — the recorded shape still rides the run.
    fields.push({
      key,
      kind: "fixed",
      value: JSON.stringify(recorded) ?? String(recorded),
      label,
    });
  }
  return fields;
}

// ---------------------------------------------------------------------------
// Synthetic-data-only enforcement (hostile-input neutralization)
// ---------------------------------------------------------------------------

/** One hostile-text rule: what it catches and the honest refusal message. */
export interface SyntheticTextRule {
  readonly rule: string;
  readonly pattern: RegExp;
  readonly message: string;
}

/**
 * The neutralization rules for FREE TEXT fields — the synthetic-data
 * discipline that exists at this revision (the corpus's own
 * NO_SECRET_FLOW and NO_PROVIDER_SELECTION constraints, extended to
 * the shapes real-world data takes). A value matching ANY rule is
 * refused before any wire call.
 */
export const SYNTHETIC_TEXT_RULES: readonly SyntheticTextRule[] = [
  {
    rule: "web-address",
    pattern: /https?:\/\/\S+|www\.\S+|\b\S+\.(?:com|net|org|io|dev|app|co|edu|gov)\b/i,
    message: "real-world web addresses are not synthetic data",
  },
  {
    rule: "email-address",
    pattern: /[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,24}/,
    message: "email addresses are not synthetic data",
  },
  {
    rule: "ip-address",
    pattern: /\b\d{1,3}(?:\.\d{1,3}){3}\b/,
    message: "IP addresses are not synthetic data",
  },
  {
    rule: "long-digit-run",
    pattern: /\d{7,}/,
    message: "runs of seven or more digits (phone/card-shaped) are not synthetic data",
  },
  {
    rule: "credential-shaped",
    pattern:
      /\b(?:sk|rk|pk|ghp|gho|xoxb|xoxp)-[a-z0-9]{10,}\b|\bAKIA[A-Z0-9]{12,}\b|(?:api[_-]?key|secret|password|passwd|token|bearer|authorization)\s*[:=]\s*\S+/i,
    message: "credential-shaped material may never appear in a task (the secret-flow guard)",
  },
  {
    rule: "markup",
    pattern: /<\/?[a-z][^>]*>/i,
    message: "HTML/script markup is not accepted in synthetic text",
  },
  {
    rule: "control-characters",
    // biome-ignore lint/suspicious/noControlCharactersInRegex: control-char stripping is the point.
    pattern: /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/,
    message: "control characters are not accepted in synthetic text",
  },
  {
    rule: "opaque-blob",
    pattern: /\b[A-Za-z0-9+/]{40,}={0,2}\b/,
    message: "opaque base64-shaped blobs are not synthetic data",
  },
];

/** The first hostile-text rule a value violates, or null when it is clean. */
export function syntheticTextViolation(value: string): SyntheticTextRule | null {
  for (const rule of SYNTHETIC_TEXT_RULES) {
    if (rule.pattern.test(value)) {
      return rule;
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// The interactive run form (client-side enforcement, before any wire call)
// ---------------------------------------------------------------------------

/** The base form keys the interactive composer round-trips. */
export const INTERACTIVE_FORM_BASE_KEYS: readonly string[] = [
  "applicationId",
  "environmentId",
  "spendLimitDollars",
  "idempotencyKey",
];

/** The form key one composer field rides (`task.<key>`). */
export function formKeyOf(field: ComposerField): string {
  return `task.${field.key}`;
}

/** The raw form-string form of a field's recorded default. */
function defaultRawValueOf(field: ComposerField): string {
  switch (field.kind) {
    case "fixed":
      return field.value;
    case "select":
    case "text":
      return field.defaultValue;
    case "number":
      return String(field.defaultValue);
    case "boolean":
      return field.defaultValue ? "true" : "false";
    case "list":
      return field.defaultValue.join(",");
  }
}

/** Every form key the interactive composer round-trips for one family. */
export function interactiveFormKeysOf(family: ConsoleFamily): readonly string[] {
  return [
    ...INTERACTIVE_FORM_BASE_KEYS,
    ...composerSchemaOf(family)
      .filter((field) => field.kind !== "fixed")
      .map(formKeyOf),
  ];
}

/** The validated interactive-run form values. */
export interface InteractiveRunFormValues {
  readonly envelope: PlaygroundFormValues;
  /** Raw per-field string values keyed by `task.<key>`. */
  readonly task: Readonly<Record<string, string>>;
}

/** Per-field errors (form keys, including `task.<key>` keys). */
export type InteractiveRunFormErrors = Record<string, string>;

/**
 * Validate the composed run AGAINST THE CONTRACT AND THE SYNTHETIC
 * DISCIPLINE (client-side, before any wire call): the envelope fields
 * ride the DEP-010 validation (application scope required, spend at or
 * under the sandbox ceiling), and every composed task field is checked
 * against the class's advertised contract — closed vocabularies accept
 * only recorded synthetic values, numbers only the recorded envelope,
 * free text only neutralized synthetic text, and UNKNOWN task keys are
 * rejected outright (the composer's vocabulary is closed; a provider or
 * kind injection is unrepresentable).
 */
export function validateInteractiveRunForm(
  family: ConsoleFamily,
  form: Readonly<Record<string, string>>,
): {
  readonly values: InteractiveRunFormValues | null;
  readonly errors: InteractiveRunFormErrors;
} {
  const errors: InteractiveRunFormErrors = {};
  const envelope = validatePlaygroundForm(form);
  for (const [key, message] of Object.entries(envelope.errors)) {
    if (message !== undefined) {
      errors[key] = message;
    }
  }
  const schema = composerSchemaOf(family);
  const task: Record<string, string> = {};
  // The closed form vocabulary: every EDITABLE field's key. Fixed fields
  // (the task discriminator) are deliberately absent — a client-supplied
  // `task.kind` is an unknown key and is refused, so the wire payload's
  // discriminator can only ever be the manifest's recorded value.
  const knownKeys = new Set(
    schema.filter((field) => field.kind !== "fixed").map((field) => `task.${field.key}`),
  );
  for (const [formKey] of Object.entries(form)) {
    if (formKey.startsWith("task.") && !knownKeys.has(formKey)) {
      errors[formKey] =
        "Unknown composed field — the composer's vocabulary is the class's advertised contract (the manifest's task shape); it is closed.";
    }
  }
  for (const field of schema) {
    const formKey = formKeyOf(field);
    // An ABSENT field rides the manifest's recorded default — the
    // advertised contract's own value, synthetic by construction (the
    // composer form always submits every field, so absence means a
    // hand-addressed URL or the DEP-010 guided default, never a bypass).
    if (!(formKey in form)) {
      task[field.key] = defaultRawValueOf(field);
      continue;
    }
    const raw = (form[formKey] ?? "").trim();
    switch (field.kind) {
      case "fixed":
        break;
      case "select":
        if (!field.values.includes(raw)) {
          errors[formKey] =
            "Choose one of the family's recorded synthetic corpus values for this field (synthetic-data-only enforcement — free entry is not accepted).";
        } else {
          task[field.key] = raw;
        }
        break;
      case "number": {
        if (!/^-?\d+$/.test(raw)) {
          errors[formKey] = "Enter a whole number.";
          break;
        }
        const parsed = Number.parseInt(raw, 10);
        if (parsed < field.min || parsed > field.max) {
          errors[formKey] = `Enter a value within the recorded envelope for this family: ${String(
            field.min,
          )}–${String(field.max)}.`;
        } else {
          task[field.key] = raw;
        }
        break;
      }
      case "boolean":
        if (raw.length === 0 || raw === "false") {
          task[field.key] = "false";
        } else if (raw === "true") {
          task[field.key] = "true";
        } else {
          errors[formKey] = "The value must be true or false.";
        }
        break;
      case "list": {
        const items = raw
          .split(",")
          .map((item) => item.trim())
          .filter((item) => item.length > 0);
        const unknown = items.filter((item) => !field.vocabulary.includes(item));
        if (items.length === 0) {
          errors[formKey] = "Enter at least one item from the recorded synthetic vocabulary.";
        } else if (unknown.length > 0) {
          errors[formKey] =
            `Only recorded synthetic vocabulary items are accepted (not synthetic: ${unknown
              .map((item) => `"${item}"`)
              .join(", ")}).`;
        } else {
          task[field.key] = items.join(",");
        }
        break;
      }
      case "text": {
        if (raw.length === 0) {
          errors[formKey] = "Enter the synthetic text for this field.";
          break;
        }
        if (raw.length > field.maxLength) {
          errors[formKey] =
            `Keep the synthetic text at or under ${String(field.maxLength)} characters.`;
          break;
        }
        const violation = syntheticTextViolation(raw);
        if (violation !== null) {
          errors[formKey] = `Refused — ${violation.message} (${violation.rule}).`;
        } else {
          task[field.key] = raw;
        }
        break;
      }
    }
  }
  if (envelope.values === null || Object.keys(errors).length > 0) {
    return { values: null, errors };
  }
  return { values: { envelope: envelope.values, task }, errors: {} };
}

/** The default composed-task form values (the manifest's recorded shape). */
export function defaultTaskFormValuesOf(family: ConsoleFamily): Record<string, string> {
  const values: Record<string, string> = {};
  for (const field of composerSchemaOf(family)) {
    switch (field.kind) {
      case "fixed":
        break;
      case "select":
        values[formKeyOf(field)] = field.defaultValue;
        break;
      case "number":
        values[formKeyOf(field)] = String(field.defaultValue);
        break;
      case "boolean":
        values[formKeyOf(field)] = field.defaultValue ? "true" : "false";
        break;
      case "list":
        values[formKeyOf(field)] = field.defaultValue.join(",");
        break;
      case "text":
        values[formKeyOf(field)] = field.defaultValue;
        break;
    }
  }
  return values;
}

/**
 * The composed task (the wire payload): the family's FIXED kind plus
 * every composed field, in the advertised contract's key order, with
 * values coerced to their recorded types. Only validated values reach
 * this function.
 */
export function composedTaskOf(
  family: ConsoleFamily,
  values: InteractiveRunFormValues,
): Record<string, unknown> {
  const task: Record<string, unknown> = {};
  for (const field of composerSchemaOf(family)) {
    const raw = values.task[field.key];
    switch (field.kind) {
      case "fixed":
        task[field.key] = family.taskShape[field.key];
        break;
      case "select":
      case "text":
        task[field.key] = raw ?? field.defaultValue;
        break;
      case "number":
        task[field.key] = raw === undefined ? field.defaultValue : Number.parseInt(raw, 10);
        break;
      case "boolean":
        task[field.key] = raw === "true";
        break;
      case "list":
        task[field.key] =
          raw === undefined
            ? [...field.defaultValue]
            : raw
                .split(",")
                .map((item) => item.trim())
                .filter((item) => item.length > 0);
        break;
    }
  }
  return task;
}

/**
 * Build the interactive run's execution request (contract-side
 * enforcement): the COMPOSED task, the hard budget and latency
 * constraints (never above the sandbox ceiling, always present), the
 * disposable-sandbox identity and the machine-parity provenance. The
 * builder can emit ONLY the frozen create vocabulary — provider
 * selection is structurally impossible.
 */
export function buildInteractiveRunRequest(
  family: ConsoleFamily,
  task: Readonly<Record<string, unknown>>,
  envelope: PlaygroundFormValues,
): ExecutionRequest {
  const declared = envelope.spendMicroUsd ?? null;
  const budgetMicroUsd =
    declared !== null && BigInt(declared) < BigInt(PLAYGROUND_BUDGET_LIMIT_MICRO_USD)
      ? declared
      : PLAYGROUND_BUDGET_LIMIT_MICRO_USD;
  return {
    applicationId: envelope.applicationId,
    ...(envelope.environmentId.length === 0 ? {} : { environmentId: envelope.environmentId }),
    task: { ...task },
    constraints: {
      maxCostMicroUsd: budgetMicroUsd,
      maxLatencyMs: PLAYGROUND_LATENCY_LIMIT_MS,
    },
    metadata: {
      origin: PLAYGROUND_ORIGIN,
      family: family.family,
      sandbox: "disposable",
      composed: "interactive",
      example: family.example,
    },
  };
}

// ---------------------------------------------------------------------------
// The availability view (the honest NOT RUN facts — DEP-013 AC3)
// ---------------------------------------------------------------------------

/** One required capability's access fact for a workload class. */
export interface PlaygroundAccessFact {
  readonly capability: string;
  readonly kind: "provider-rail" | "platform-seeded" | "unrecorded";
  /** The operator-facing access requirement (matrix, verbatim). */
  readonly accessRequirement: string;
  /** Candidate credential env var NAMES (never values). */
  readonly candidateEnvVars: readonly string[];
  /** The seeded capability's version when the platform seeds it. */
  readonly seededVersion: string | null;
}

/** The availability view of one workload class against a deployment. */
export interface PlaygroundAvailability {
  readonly facts: readonly PlaygroundAccessFact[];
  readonly presentEnvVars: readonly string[];
  readonly missingEnvVars: readonly string[];
  readonly hardBlocked: readonly {
    readonly capability: string;
    readonly accessRequirement: string;
    readonly reason: string;
  }[];
}

function envNamesOfProviders(providers: readonly string[]): readonly string[] {
  const names = new Set<string>();
  for (const access of PROVIDER_ACCESS) {
    if (providers.includes(access.provider)) {
      names.add(access.credentialEnvVar);
    }
  }
  return [...names].sort();
}

/**
 * The availability view of one workload class: each recorded
 * capability requirement becomes an access fact — a provider-rail fact
 * (candidates from the capability matrix, credential env var NAMES
 * present/absent in this deployment — values are never read), a
 * platform-seeded fact (the seeded catalog carries the capability — no
 * provider credential required), or an honest unrecorded note. A
 * requirement whose matrix entry carries NO candidate provider is a
 * HARD NOT RUN boundary (the same discipline as the Validation Lab's
 * rerun gate: never converted into a pass, never silently submittable).
 */
export function playgroundAvailabilityOf(
  family: ConsoleFamily,
  env: Readonly<Record<string, string | undefined>> = process.env,
): PlaygroundAvailability {
  const facts: PlaygroundAccessFact[] = [];
  const present = new Set<string>();
  const missing = new Set<string>();
  const hardBlocked: {
    readonly capability: string;
    readonly accessRequirement: string;
    readonly reason: string;
  }[] = [];
  for (const requirement of family.capabilityRequirements) {
    const matrixEntry = CAPABILITY_MATRIX.find((entry) => entry.capability === requirement);
    if (matrixEntry !== undefined) {
      const candidateEnvVars = envNamesOfProviders(matrixEntry.candidates);
      for (const name of candidateEnvVars) {
        if (typeof env[name] === "string" && (env[name] as string).length > 0) {
          present.add(name);
        } else {
          missing.add(name);
        }
      }
      facts.push({
        capability: requirement,
        kind: "provider-rail",
        accessRequirement: matrixEntry.accessRequirement,
        candidateEnvVars,
        seededVersion: null,
      });
      if (matrixEntry.candidates.length === 0) {
        hardBlocked.push({
          capability: requirement,
          accessRequirement: matrixEntry.accessRequirement,
          reason:
            "the capability matrix records no candidate provider for this capability — an interactive run would be a NOT RUN boundary, never a pass",
        });
      }
      continue;
    }
    const name = requirement.split(":")[1] ?? requirement;
    const kind = requirement.split(":")[0];
    const seeded = seedCapabilities().find(
      (capability) => capability.id === name && capability.kind === kind,
    );
    if (seeded !== undefined) {
      facts.push({
        capability: requirement,
        kind: "platform-seeded",
        accessRequirement: `seeded platform capability (${seeded.id} ${seeded.version}) — no provider credential required`,
        candidateEnvVars: [],
        seededVersion: seeded.version,
      });
      continue;
    }
    facts.push({
      capability: requirement,
      kind: "unrecorded",
      accessRequirement:
        "no access fact is recorded for this requirement — the console renders the recorded availability note only",
      candidateEnvVars: [],
      seededVersion: null,
    });
  }
  return {
    facts,
    presentEnvVars: [...present].sort(),
    missingEnvVars: [...missing].sort(),
    hardBlocked,
  };
}

/** True when any required capability of the family is a hard NOT RUN boundary. */
export function familyIsHardBlocked(availability: PlaygroundAvailability): boolean {
  return availability.hardBlocked.length > 0;
}

// ---------------------------------------------------------------------------
// Run facts (derived live from executions this browser opened)
// ---------------------------------------------------------------------------

/** One interactive playground run fact, derived from a live execution record. */
export interface PlaygroundRunFact {
  readonly executionId: string;
  readonly family: string | null;
  readonly composed: boolean;
  readonly status: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

function stringMetadata(metadata: Readonly<Record<string, unknown>>, key: string): string | null {
  const value = metadata[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** The interactive playground runs among a recents read (navigation-only). */
export function playgroundRunsOf(executions: readonly Execution[]): readonly PlaygroundRunFact[] {
  return executions
    .filter((execution) => stringMetadata(execution.metadata, "origin") === PLAYGROUND_ORIGIN)
    .map((execution) => ({
      executionId: execution.id,
      family: stringMetadata(execution.metadata, "family"),
      composed: stringMetadata(execution.metadata, "composed") === "interactive",
      status: execution.status,
      createdAt: execution.createdAt,
      updatedAt: execution.updatedAt,
    }));
}

/** The playground runs of one workload family (recents-derived). */
export function playgroundRunsForFamily(
  executions: readonly Execution[],
  familyId: string,
): readonly PlaygroundRunFact[] {
  return playgroundRunsOf(executions).filter((run) => run.family === familyId);
}

// ---------------------------------------------------------------------------
// The copyable example source (machine parity — served read-only)
// ---------------------------------------------------------------------------

/**
 * Read the family's recorded integration-kit example SOURCE verbatim
 * (the path comes from the machine manifests, never from request
 * input). Returns null only when the recorded file is absent from the
 * repository — an honest miss the page renders as such.
 */
export function readPlaygroundExampleSource(family: ConsoleFamily): string | null {
  try {
    return readFileSync(fileURLToPath(new URL(`../../${family.example}`, import.meta.url)), "utf8");
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// The load-time single-source invariant (fail fast, never render a lie)
// ---------------------------------------------------------------------------

/**
 * Every family's recorded example must exist in the examples manifest
 * (cross-manifest no-drift) — checked once at load so the console can
 * never render a machine-parity link the machine inventory does not
 * carry. The full battery (families ↔ corpus ↔ examples ↔ composer
 * schemas) is pinned by tests/unit/dashboard/playground-*.test.ts.
 */
for (const family of consoleFamilies()) {
  if (exampleOfFamily(family) === null) {
    throw new Error(
      `interactive playground: family "${family.family}" records example "${family.example}" which the machine examples manifest does not carry — the manifests have drifted`,
    );
  }
}
