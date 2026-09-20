/**
 * Zeck developer console module (DEP-010 — the developer-console
 * projection layer over the public machine contracts).
 *
 * A PROJECTION, NEVER A SECOND AUTHORITY (DEP-010 AC7): this module holds
 * NO console-local source of truth. The workload-family catalog, the
 * availability classifications and the seeded capabilities are projected
 * from the repository's validated machine artifact
 * `docs/developer/machine/capability-manifest.json` (the DEP-020 machine
 * contract, itself reconciled against the validation corpus by
 * `tests/unit/developer-docs/machine-schemas.test.ts`). If that artifact
 * drifts, this module fails loudly at load — it never invents a family,
 * a classification or an availability fact.
 *
 * THE SANDBOX PLAYGROUND LIMITS (DEP-010 AC5): every guided playground
 * run is an ordinary governed execution through the public create
 * contract — the console enforces its sandbox envelope CLIENT-side
 * (form validation, before any wire call) and CONTRACT-side (the built
 * request always carries the hard budget/latency constraints and the
 * disposable-sandbox identity). Provider selection is structurally
 * impossible: the playground request builder emits only the frozen
 * create vocabulary (the same closed vocabulary
 * `FORBIDDEN_REQUEST_KEYS` guards).
 *
 * THE DOCS ENTRY POINTS: `developerDocsIndex`/`readDeveloperDoc` project
 * the repository's `docs/developer/*.md` files verbatim (list + serve,
 * never a copied or paraphrased duplicate).
 */

import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Execution, ExecutionRequest } from "../../sdk";
import { esc, keyValueTable } from "./components";
import { dollarsToMicroUsd, safeTaskPairs } from "./projection";

// ---------------------------------------------------------------------------
// The capability manifest projection (the DEP-020 machine contract)
// ---------------------------------------------------------------------------

/** The recorded example classification vocabulary (AVAILABILITY.md). */
export type FamilyClassification = "runnable" | "provider-gated";

/** One workload family as the machine manifest records it. */
export interface ConsoleFamily {
  readonly family: string;
  readonly example: string;
  readonly classification: FamilyClassification;
  readonly taskShape: Readonly<Record<string, unknown>>;
  readonly capabilityRequirements: readonly string[];
  readonly availability: string;
  /**
   * PPR-001: the credential ENV VAR NAME the manifest records on
   * provider-gated families (e.g. QWEN_API_KEY) — absent when the
   * manifest records no gate. A NAME only, never a value; projected
   * verbatim so the availability-state derivation (discovery.ts) can
   * stay a pure function of manifest facts.
   */
  readonly gatedBy?: string;
}

/** One seeded capability as the machine manifest records it. */
export interface ConsoleSeedCapability {
  readonly id: string;
  readonly kind: string;
  readonly version: string;
}

/** The narrowed console projection of the capability manifest. */
export interface ConsoleManifest {
  readonly capabilityKinds: readonly string[];
  readonly evidenceKinds: readonly string[];
  readonly seedCapabilities: readonly ConsoleSeedCapability[];
  readonly families: readonly ConsoleFamily[];
}

const MANIFEST_URL = new URL(
  "../../docs/developer/machine/capability-manifest.json",
  import.meta.url,
);

function requireString(value: unknown, what: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`capability manifest: ${what} must be a non-empty string`);
  }
  return value;
}

function requireStringArray(value: unknown, what: string): readonly string[] {
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new Error(`capability manifest: ${what} must be an array of strings`);
  }
  return value as readonly string[];
}

function requireRecord(value: unknown, what: string): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`capability manifest: ${what} must be a JSON object`);
  }
  return value as Readonly<Record<string, unknown>>;
}

function narrowClassification(value: unknown, family: string): FamilyClassification {
  if (value === "runnable" || value === "provider-gated") {
    return value;
  }
  throw new Error(
    `capability manifest: family "${family}" carries an unknown classification "${String(value)}"`,
  );
}

function narrowFamily(value: unknown): ConsoleFamily {
  const record = requireRecord(value, "each workload family");
  return {
    family: requireString(record.family, "family"),
    example: requireString(record.example, `family ${String(record.family)} example`),
    classification: narrowClassification(record.classification, String(record.family)),
    taskShape: requireRecord(record.taskShape, `family ${String(record.family)} taskShape`),
    capabilityRequirements: requireStringArray(
      record.capabilityRequirements,
      `family ${String(record.family)} capabilityRequirements`,
    ),
    availability: requireString(
      record.availability,
      `family ${String(record.family)} availability`,
    ),
    ...(record.gatedBy === undefined
      ? {}
      : { gatedBy: requireString(record.gatedBy, `family ${String(record.family)} gatedBy`) }),
  };
}

function narrowSeedCapability(value: unknown): ConsoleSeedCapability {
  const record = requireRecord(value, "each seed capability");
  return {
    id: requireString(record.id, "seed capability id"),
    kind: requireString(record.kind, "seed capability kind"),
    version: requireString(record.version, "seed capability version"),
  };
}

function narrowManifest(value: unknown): ConsoleManifest {
  const record = requireRecord(value, "the capability manifest");
  if (record.schemaVersion !== 1) {
    throw new Error(
      `capability manifest: unsupported schemaVersion ${String(record.schemaVersion)}`,
    );
  }
  const rawFamilies = record.workloadFamilies;
  if (!Array.isArray(rawFamilies)) {
    throw new Error("capability manifest: workloadFamilies must be an array");
  }
  const rawCapabilities = record.seedCapabilities;
  if (!Array.isArray(rawCapabilities)) {
    throw new Error("capability manifest: seedCapabilities must be an array");
  }
  return {
    capabilityKinds: requireStringArray(record.capabilityKinds, "capabilityKinds"),
    evidenceKinds: requireStringArray(record.evidenceKinds, "evidenceKinds"),
    seedCapabilities: rawCapabilities.map(narrowSeedCapability),
    families: rawFamilies.map(narrowFamily),
  };
}

/**
 * The ONE manifest instance, loaded once at module scope from the
 * repository's validated machine artifact (fail-fast on drift — the same
 * discipline as every other module-scope constant, e.g. DASHBOARD_CSS).
 */
const CAPABILITY_MANIFEST: ConsoleManifest = narrowManifest(
  JSON.parse(readFileSync(fileURLToPath(MANIFEST_URL), "utf8")) as unknown,
);

/** Every workload family the machine manifest records (manifest order). */
export function consoleFamilies(): readonly ConsoleFamily[] {
  return CAPABILITY_MANIFEST.families;
}

/** One family by id, or null when the manifest records no such family. */
export function familyOf(familyId: string): ConsoleFamily | null {
  return CAPABILITY_MANIFEST.families.find((family) => family.family === familyId) ?? null;
}

/** The seeded capabilities the machine manifest records. */
export function seedCapabilities(): readonly ConsoleSeedCapability[] {
  return CAPABILITY_MANIFEST.seedCapabilities;
}

/** The capability-kind vocabulary the machine manifest records. */
export function capabilityKinds(): readonly string[] {
  return CAPABILITY_MANIFEST.capabilityKinds;
}

/** The evidence-kind vocabulary the machine manifest records. */
export function evidenceKinds(): readonly string[] {
  return CAPABILITY_MANIFEST.evidenceKinds;
}

/** The families grouped by recorded classification (the availability split). */
export function familiesByClassification(): {
  readonly runnable: readonly ConsoleFamily[];
  readonly providerGated: readonly ConsoleFamily[];
} {
  return {
    runnable: CAPABILITY_MANIFEST.families.filter((family) => family.classification === "runnable"),
    providerGated: CAPABILITY_MANIFEST.families.filter(
      (family) => family.classification === "provider-gated",
    ),
  };
}

// ---------------------------------------------------------------------------
// The sandbox playground limits (DEP-010 AC5 — enforced client- and
// contract-side; the platform's policy admission stays the final gate)
// ---------------------------------------------------------------------------

/** Hard per-run sandbox budget ceiling: $2.00 (integer micro-USD string). */
export const PLAYGROUND_BUDGET_LIMIT_MICRO_USD = "2000000";

/** The same ceiling in the dollars vocabulary the form uses. */
export const PLAYGROUND_BUDGET_LIMIT_DOLLARS = "2.00";

/** Hard per-run latency ceiling: two minutes (the request always carries it). */
export const PLAYGROUND_LATENCY_LIMIT_MS = 120_000;

/** Hard concurrency ceiling: in-flight (non-terminal) sandbox runs per browser. */
export const PLAYGROUND_MAX_CONCURRENT_RUNS = 3;

/** The metadata origin marker every playground run carries. */
export const PLAYGROUND_ORIGIN = "zeck-console-playground";

/** The form keys the playground round-trips (the closed form vocabulary). */
export const PLAYGROUND_FORM_KEYS: readonly string[] = [
  "applicationId",
  "environmentId",
  "spendLimitDollars",
  "idempotencyKey",
];

export interface PlaygroundFormValues {
  readonly applicationId: string;
  readonly environmentId: string;
  readonly spendLimitDollars: string;
  /** The parsed ceiling (integer micro-USD) when a valid one was entered. */
  readonly spendMicroUsd?: string;
}

export type PlaygroundFormErrors = Partial<Record<keyof PlaygroundFormValues, string>>;

/** Count the in-flight (non-terminal) executions of a recents read. */
export function inFlightCount(executions: readonly Execution[]): number {
  return executions.filter((execution) => {
    const status = execution.status;
    return (
      status !== "COMPLETED" &&
      status !== "FAILED" &&
      status !== "CANCELLED" &&
      status !== "EXPIRED"
    );
  }).length;
}

/**
 * Validate the sandbox run form AGAINST THE LIMITS (client-side, before
 * any wire call): the application scope is required, the optional spend
 * limit must parse and sit at or under the sandbox ceiling.
 */
export function validatePlaygroundForm(form: Readonly<Record<string, string>>): {
  values: PlaygroundFormValues | null;
  errors: PlaygroundFormErrors;
} {
  const errors: PlaygroundFormErrors = {};
  const applicationId = (form.applicationId ?? "").trim();
  const environmentId = (form.environmentId ?? "").trim();
  const spendLimitDollars = (form.spendLimitDollars ?? "").trim();
  if (applicationId.length === 0) {
    errors.applicationId = "The application scope is required — the execution belongs to it.";
  }
  let spendMicroUsd: string | null = null;
  if (spendLimitDollars.length > 0) {
    spendMicroUsd = dollarsToMicroUsd(spendLimitDollars);
    if (spendMicroUsd === null) {
      errors.spendLimitDollars =
        "Enter the spend ceiling as dollars with at most two decimals (e.g. 1.50).";
    } else if (BigInt(spendMicroUsd) > BigInt(PLAYGROUND_BUDGET_LIMIT_MICRO_USD)) {
      errors.spendLimitDollars = `Sandbox runs are capped at $${PLAYGROUND_BUDGET_LIMIT_DOLLARS} per execution — enter a lower ceiling.`;
      spendMicroUsd = null;
    }
  }
  if (Object.keys(errors).length > 0) {
    return { values: null, errors };
  }
  return {
    values: {
      applicationId,
      environmentId,
      spendLimitDollars,
      ...(spendMicroUsd === null ? {} : { spendMicroUsd }),
    },
    errors: {},
  };
}
/**
 * Build the sandbox execution request (contract-side enforcement): the
 * family's recorded SYNTHETIC task shape verbatim, the hard budget and
 * latency constraints (never above the sandbox ceiling, always present),
 * and the explicit disposable-sandbox identity. The builder can emit
 * ONLY the frozen create vocabulary — provider selection is structurally
 * impossible.
 */
export function buildPlaygroundExecutionRequest(
  family: ConsoleFamily,
  values: PlaygroundFormValues,
): ExecutionRequest {
  const declared = values.spendMicroUsd ?? dollarsToMicroUsd(values.spendLimitDollars.trim());
  const budgetMicroUsd =
    declared !== null && BigInt(declared) < BigInt(PLAYGROUND_BUDGET_LIMIT_MICRO_USD)
      ? declared
      : PLAYGROUND_BUDGET_LIMIT_MICRO_USD;
  return {
    applicationId: values.applicationId,
    ...(values.environmentId.length === 0 ? {} : { environmentId: values.environmentId }),
    task: family.taskShape,
    constraints: {
      maxCostMicroUsd: budgetMicroUsd,
      maxLatencyMs: PLAYGROUND_LATENCY_LIMIT_MS,
    },
    metadata: {
      origin: PLAYGROUND_ORIGIN,
      family: family.family,
      sandbox: "disposable",
    },
  };
}

// ---------------------------------------------------------------------------
// Console presentation helpers (pure; pages.ts composes them)
// ---------------------------------------------------------------------------

/** The classification chip (symbol + text, never color alone). */
export function classificationChip(classification: FamilyClassification): string {
  if (classification === "runnable") {
    return '<span class="chip">▶ runnable</span>';
  }
  return '<span class="chip">⊘ provider-gated</span>';
}

/**
 * The availability panel: the manifest's RECORDED availability verbatim
 * (escaped), plus the console's own honest deployment note — the run is
 * submitted through the governed public API with synthetic data, and
 * live completion depends on the deployment's authorized provider rails.
 */
export function familyAvailabilitySection(family: ConsoleFamily): string {
  return `<section class="card">
  <h2>Availability</h2>
  ${classificationChip(family.classification)}
  <p>${esc(family.availability)}</p>
  <p class="muted">Recorded by the validation program and carried by the machine capability manifest — the console projects it, never re-classifies it. In this console a run is submitted through the governed public API with the synthetic task below; live completion depends on the deployment's authorized provider rails, and real-rail rows without operator credentials are NOT RUN (an operator action, never silently converted into a pass).</p>
</section>`;
}

/** The synthetic task the guided run submits (manifest-recorded, verbatim). */
export function playgroundTaskTable(family: ConsoleFamily): string {
  return keyValueTable(safeTaskPairs(family.taskShape));
}

/**
 * The sandbox envelope panel: exactly the limits this console enforces,
 * where each is enforced, and what stays with the platform.
 */
export function sandboxLimitsSection(): string {
  return `<section class="card">
  <h2>Sandbox envelope</h2>
  <p>Every playground run is an ordinary governed execution — the same public create contract, the same policy admission — wrapped in the console's hard sandbox limits:</p>
  ${keyValueTable([
    [
      "Budget ceiling",
      `$${PLAYGROUND_BUDGET_LIMIT_DOLLARS} per run (the request always carries the cost constraint; a higher entry is refused before any wire call)`,
    ],
    [
      "Latency ceiling",
      `${String(PLAYGROUND_LATENCY_LIMIT_MS / 1000)} seconds per run (the request always carries the latency constraint)`,
    ],
    [
      "Concurrency",
      `at most ${String(PLAYGROUND_MAX_CONCURRENT_RUNS)} in-flight sandbox runs per browser (derived live from the runs this browser opened — the console holds no server-side session state)`,
    ],
    [
      "Input size",
      "form bodies are capped at 64 KiB by the console transport (an oversized submit is refused with 413, never forwarded)",
    ],
    [
      "Data",
      "synthetic: the guided run submits the family's recorded synthetic task shape verbatim",
    ],
    [
      "Provider selection",
      "impossible — the create contract forbids it and the playground request can emit only the closed vocabulary",
    ],
    [
      "Identity",
      `every run carries the disposable-sandbox identity in its metadata (origin ${PLAYGROUND_ORIGIN})`,
    ],
    [
      "Side effects",
      "consequential real-world effects stay behind the platform's policy admission and approval gates",
    ],
  ])}
  <p class="muted">These are the console's client- and contract-side controls. The platform's policy admission, budgets authority and verification axis remain the governing boundaries on every run.</p>
</section>`;
}

// ---------------------------------------------------------------------------
// Applications derivations (from the executions the browser opened)
// ---------------------------------------------------------------------------

export interface ConsoleApplicationFact {
  readonly applicationId: string;
  readonly runCount: number;
  readonly lastSeenAt: string;
}

/** Distinct applications on a recents read, most-recently-seen first. */
export function consoleApplicationsOf(
  executions: readonly Execution[],
): readonly ConsoleApplicationFact[] {
  const byId = new Map<string, ConsoleApplicationFact>();
  for (const execution of executions) {
    const existing = byId.get(execution.applicationId);
    if (existing === undefined) {
      byId.set(execution.applicationId, {
        applicationId: execution.applicationId,
        runCount: 1,
        lastSeenAt: execution.updatedAt,
      });
    } else {
      byId.set(execution.applicationId, {
        applicationId: execution.applicationId,
        runCount: existing.runCount + 1,
        lastSeenAt:
          existing.lastSeenAt >= execution.updatedAt ? existing.lastSeenAt : execution.updatedAt,
      });
    }
  }
  return [...byId.values()].sort((a, b) => (a.lastSeenAt >= b.lastSeenAt ? -1 : 1));
}

// ---------------------------------------------------------------------------
// The developer documentation projection (docs/developer/*.md, verbatim)
// ---------------------------------------------------------------------------

const DEVELOPER_DOCS_URL = new URL("../../docs/developer/", import.meta.url);

export interface DeveloperDocEntry {
  readonly id: string;
  readonly title: string;
}

function docTitle(id: string, content: string): string {
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("# ")) {
      return trimmed.slice(2).trim();
    }
  }
  return id;
}

/**
 * The developer docs index, projected from the repository's
 * `docs/developer/` directory at call time (no copied list — the
 * directory IS the index).
 */
export function developerDocsIndex(): readonly DeveloperDocEntry[] {
  const entries = readdirSync(fileURLToPath(DEVELOPER_DOCS_URL), { withFileTypes: true })
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
    .map((entry) => entry.name)
    .sort();
  return entries.map((id) => ({
    id,
    title: docTitle(id, readFileSync(fileURLToPath(new URL(id, DEVELOPER_DOCS_URL)), "utf8")),
  }));
}

/**
 * Read one developer doc verbatim. The id must be a plain `.md` file name
 * that exists in the projected directory — no traversal, no other path
 * can cross.
 */
export function readDeveloperDoc(
  id: string,
): { readonly entry: DeveloperDocEntry; readonly content: string } | null {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\.md$/.test(id)) {
    return null;
  }
  const known = developerDocsIndex().find((entry) => entry.id === id);
  if (known === undefined) {
    return null;
  }
  const content = readFileSync(fileURLToPath(new URL(id, DEVELOPER_DOCS_URL)), "utf8");
  return { entry: known, content };
}
