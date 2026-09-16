/**
 * Zeck Validation Lab module (DEP-025 — the validation-library projection
 * layer over the repository's executed validation program).
 *
 * A PROJECTION, NEVER A SECOND VALIDATION AUTHORITY (DEP-025 AC8): this
 * module holds NO console-local source of truth. Every validation
 * definition is SOURCED from repository truth at load time and narrowed
 * fail-fast (the same discipline as the DEP-010 capability-manifest
 * projection):
 *
 *   - the governed program state  `spec/validation-state/program-state.json`
 *     and `spec/validation-state/dependency-state.json` (the ONE authority
 *     for which work orders exist and how they merged);
 *   - the validation stages       `docs/VALIDATION-ROADMAP.md` (the stage
 *     ranges block — the console never invents a stage);
 *   - the work-order objectives   `spec/validation-work-orders/VAL-*.md`
 *     (the `## Objective` section, verbatim);
 *   - the historical evidence     `benchmarks/validation/evidence/VAL-001.md`
 *     and `docs/work-items/VAL-*.md` (served READ-ONLY — a rerun never
 *     mutates them; AC4);
 *   - the experiment applications `benchmarks/validation/apps/*` (the
 *     README's recorded work order, the secret-free `config.json` facts,
 *     the repository suite that reproduces them);
 *   - the golden corpus           `benchmarks/validation/corpus` (imported —
 *     the corpus IS the task data, append-only, synthetic);
 *   - the capability matrix       `benchmarks/validation/capabilities`
 *     (imported — required access and credential env-var NAMES);
 *   - the recorded availability   `docs/VALIDATION-REPORT.md` (the
 *     provider/model coverage, application-coverage and NOT-RUN boundary
 *     tables, parsed verbatim).
 *
 * If any of those artifacts drift, this module fails loudly at load — it
 * never invents a family, a definition, an availability fact or a stage.
 *
 * THE SANDBOX ENVELOPE (DEP-025 AC6/AC7): every console rerun is an
 * ordinary governed execution through the public create contract — the
 * lab enforces its envelope CLIENT-side (form validation, before any
 * wire call) and CONTRACT-side (the built request always carries the
 * hard budget/latency constraints, the disposable-sandbox identity and
 * the lineage metadata that links the NEW run to the immutable
 * definition). Provider selection is structurally impossible: the
 * request builder can emit only the frozen create vocabulary. Missing
 * provider/model access is surfaced BEFORE execution with the exact
 * dependency (credential env-var NAMES only — values are never read,
 * never rendered) and is NEVER represented as PASS.
 */

import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { CAPABILITY_MATRIX, PROVIDER_ACCESS } from "../../benchmarks/validation/capabilities";
import { CORPUS_VERSION, GOLDEN_TASKS } from "../../benchmarks/validation/corpus";
import type { GoldenTask, WorkloadFamily } from "../../benchmarks/validation/corpus/schema";
import { WORKLOAD_FAMILIES } from "../../benchmarks/validation/corpus/schema";
import type { Execution, ExecutionRequest, ExecutionResult } from "../../sdk";
import { dollarsToMicroUsd } from "./projection";

// ---------------------------------------------------------------------------
// The Validation Lab sandbox envelope (DEP-025 AC7)
// ---------------------------------------------------------------------------

/** Hard per-run sandbox budget ceiling: $2.00 (integer micro-USD string). */
export const VALIDATION_BUDGET_LIMIT_MICRO_USD = "2000000";

/** The same ceiling in the dollars vocabulary the form uses. */
export const VALIDATION_BUDGET_LIMIT_DOLLARS = "2.00";

/** Hard per-run latency ceiling: four minutes (the request always carries it). */
export const VALIDATION_LATENCY_LIMIT_MS = 240_000;

/** Hard concurrency ceiling: in-flight (non-terminal) sandbox runs per browser. */
export const VALIDATION_MAX_CONCURRENT_RUNS = 3;

/** The metadata origin marker every Validation Lab run carries. */
export const VALIDATION_LAB_ORIGIN = "zeck-console-validation-lab";

/** The rerun modes (DEP-025's contract-mandated vocabulary). */
export const VALIDATION_RUN_MODES: readonly string[] = [
  "replay-exact",
  "rerun-current",
  "modified",
];

/** The form keys the rerun round-trips (the closed form vocabulary). */
export const VALIDATION_FORM_KEYS: readonly string[] = [
  "applicationId",
  "environmentId",
  "spendLimitDollars",
  "mode",
  "taskId",
  "idempotencyKey",
];

// ---------------------------------------------------------------------------
// Repository-truth loading (fail-fast narrowing — the console.ts discipline)
// ---------------------------------------------------------------------------

function requireString(value: unknown, what: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`validation lab: ${what} must be a non-empty string`);
  }
  return value;
}

function optionalString(value: unknown, what: string): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  return requireString(value, what);
}

function requireNumber(value: unknown, what: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`validation lab: ${what} must be a finite number`);
  }
  return value;
}

interface GovernedWorkOrder {
  readonly id: string;
  readonly status: string;
  readonly title: string;
  readonly pr: number | null;
  readonly mergeCommit: string | null;
  readonly implementationHead: string | null;
  readonly finalBranchHead: string | null;
  readonly baseRevision: string | null;
}

function narrowGovernedWorkOrders(value: unknown): readonly GovernedWorkOrder[] {
  const record =
    typeof value === "object" && value !== null
      ? (value as Readonly<Record<string, unknown>>)
      : null;
  if (record === null) {
    throw new Error("validation lab: program-state workOrders must be an object");
  }
  const out: GovernedWorkOrder[] = [];
  for (const id of Object.keys(record)) {
    if (!/^VAL-\d{3}$/.test(id)) {
      throw new Error(`validation lab: unexpected work order id "${id}"`);
    }
    const entry = record[id] as Readonly<Record<string, unknown>> | null;
    if (typeof entry !== "object" || entry === null) {
      throw new Error(`validation lab: work order ${id} must be an object`);
    }
    const merged =
      typeof entry.mergedAs === "object" && entry.mergedAs !== null
        ? (entry.mergedAs as Readonly<Record<string, unknown>>)
        : null;
    out.push({
      id,
      status: requireString(entry.status, `work order ${id} status`),
      title: requireString(entry.title, `work order ${id} title`),
      pr: merged !== null && typeof merged.pr === "number" ? merged.pr : null,
      mergeCommit: merged !== null ? optionalString(merged.mergeCommit, `${id} mergeCommit`) : null,
      implementationHead:
        merged !== null
          ? optionalString(merged.implementationHead, `${id} implementationHead`)
          : null,
      finalBranchHead:
        merged !== null ? optionalString(merged.finalBranchHead, `${id} finalBranchHead`) : null,
      baseRevision:
        merged !== null ? optionalString(merged.baseRevision, `${id} baseRevision`) : null,
    });
  }
  out.sort((a, b) => (a.id < b.id ? -1 : 1));
  return out;
}

const PROGRAM_STATE_URL = new URL(
  "../../spec/validation-state/program-state.json",
  import.meta.url,
);
const DEPENDENCY_STATE_URL = new URL(
  "../../spec/validation-state/dependency-state.json",
  import.meta.url,
);
const ROADMAP_URL = new URL("../../docs/VALIDATION-ROADMAP.md", import.meta.url);
const REPORT_URL = new URL("../../docs/VALIDATION-REPORT.md", import.meta.url);
const APPS_URL = new URL("../../benchmarks/validation/apps/", import.meta.url);

/** The governed work orders (the ONE authority — 46 complete at load). */
const GOVERNED_WORK_ORDERS: readonly GovernedWorkOrder[] = narrowGovernedWorkOrders(
  (
    JSON.parse(readFileSync(fileURLToPath(PROGRAM_STATE_URL), "utf8")) as {
      workOrders?: unknown;
    }
  ).workOrders,
);

/** The dependency graph, projected verbatim from the governed state. */
const DEPENDENCIES: Readonly<Record<string, readonly string[]>> = (() => {
  const parsed = JSON.parse(readFileSync(fileURLToPath(DEPENDENCY_STATE_URL), "utf8")) as {
    dependencies?: Readonly<Record<string, unknown>>;
  };
  const raw = parsed.dependencies ?? {};
  const out: Record<string, readonly string[]> = {};
  for (const id of Object.keys(raw)) {
    const list = raw[id];
    if (!Array.isArray(list) || list.some((entry) => typeof entry !== "string")) {
      throw new Error(`validation lab: dependency-state ${id} must be an array of ids`);
    }
    out[id] = list as readonly string[];
  }
  return out;
})();

/** The workload families of the corpus, in registry order. */
const FAMILY_ORDER: Readonly<Record<string, number>> = (() => {
  const out: Record<string, number> = {};
  WORKLOAD_FAMILIES.forEach((family, index) => {
    out[family] = index;
  });
  return out;
})();

/** Every corpus scenario id (the README scenario-token match target). */
const CORPUS_SCENARIO_IDS: Readonly<Set<string>> = new Set(
  GOLDEN_TASKS.map((task) => task.scenarioId),
);

/**
 * The validation stages, parsed from the roadmap's own stage block
 * (`VAL-001..009 Validation laboratory foundations` lines). The console
 * projects the roadmap's vocabulary — it never invents a stage.
 */
function parseStages(roadmap: string): Readonly<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const match of roadmap.matchAll(/^VAL-(\d{3})\.\.(\d{3})\s+(.+)$/gm)) {
    const from = Number(match[1]);
    const to = Number(match[2]);
    const label = (match[3] ?? "").trim().replace(/\s+/g, " ");
    if (!Number.isInteger(from) || !Number.isInteger(to) || to < from || label.length === 0) {
      throw new Error("validation lab: the roadmap stage block drifted");
    }
    for (let index = from; index <= to; index += 1) {
      out[`VAL-${String(index).padStart(3, "0")}`] = label;
    }
  }
  if (Object.keys(out).length === 0) {
    throw new Error("validation lab: the roadmap stage block is missing");
  }
  return out;
}

const STAGES: Readonly<Record<string, string>> = parseStages(
  readFileSync(fileURLToPath(ROADMAP_URL), "utf8"),
);

/** The `## Objective` first paragraph of a work-order spec, verbatim. */
function parseObjective(spec: string, id: string): string {
  const heading = spec.indexOf("## Objective");
  if (heading === -1) {
    throw new Error(`validation lab: work-order spec ${id} carries no ## Objective section`);
  }
  const afterHeading = spec.slice(heading + "## Objective".length);
  const nextSection = afterHeading.indexOf("\n## ");
  const section = (nextSection === -1 ? afterHeading : afterHeading.slice(0, nextSection)).trim();
  const paragraph: string[] = [];
  for (const line of section.split("\n")) {
    if (line.trim().length === 0) {
      if (paragraph.length > 0) {
        break;
      }
      continue;
    }
    paragraph.push(line.trim());
  }
  const objective = paragraph.join(" ");
  if (objective.length === 0) {
    throw new Error(`validation lab: work-order spec ${id} has an empty Objective section`);
  }
  return objective;
}

/** One parsed markdown-table row (cells trimmed). */
function markdownTableRows(section: string): readonly (readonly string[])[] {
  const rows: (readonly string[])[] = [];
  for (const line of section.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("|") || !trimmed.endsWith("|")) {
      continue;
    }
    if (/^\|[\s:|-]+\|$/.test(trimmed)) {
      continue;
    }
    rows.push(
      trimmed
        .slice(1, -1)
        .split("|")
        .map((cell) => cell.trim()),
    );
  }
  return rows;
}

/** One `## section` of a markdown document (empty when absent). */
function markdownSection(markdown: string, heading: string): string {
  const index = markdown.indexOf(`## ${heading}`);
  if (index === -1) {
    return "";
  }
  const rest = markdown.slice(index);
  const next = rest.indexOf("\n## ", 1);
  return next === -1 ? rest : rest.slice(0, next);
}

/** A recorded provider/model coverage row (VALIDATION-REPORT, verbatim). */
export interface ProviderCoverageRow {
  readonly providerModel: string;
  readonly capability: string;
  readonly accessStatus: string;
  readonly evidenceRefs: string;
}

/** A recorded NOT RUN boundary (VALIDATION-REPORT, verbatim). */
export interface NotRunBoundary {
  readonly surface: string;
  readonly exactReason: string;
  readonly surfacedToOperator: string;
}

/** A recorded application-coverage row (VALIDATION-REPORT, verbatim). */
export interface CoverageRow {
  readonly workload: string;
  readonly app: string;
  readonly corpusVersion: string;
  readonly runs: string;
  readonly quality: string;
  readonly reliability: string;
  readonly costPerSuccess: string;
  readonly status: string;
  readonly workOrders: readonly string[];
}

const REPORT_MARKDOWN = readFileSync(fileURLToPath(REPORT_URL), "utf8");

function parseProviderCoverage(): readonly ProviderCoverageRow[] {
  const section = markdownSection(REPORT_MARKDOWN, "Provider/model coverage and access");
  const rows = markdownTableRows(section);
  if (rows.length < 2) {
    throw new Error("validation lab: the VALIDATION-REPORT provider table drifted");
  }
  const [header, ...data] = rows;
  if (header === undefined || !header.join("|").includes("Provider")) {
    throw new Error("validation lab: the VALIDATION-REPORT provider table header drifted");
  }
  return data.map((cells) => ({
    providerModel: cells[0] ?? "",
    capability: cells[1] ?? "",
    accessStatus: cells[2] ?? "",
    evidenceRefs: cells[3] ?? "",
  }));
}

function parseNotRunBoundaries(): readonly NotRunBoundary[] {
  const section = markdownSection(REPORT_MARKDOWN, "NOT RUN boundaries");
  const rows = markdownTableRows(section);
  if (rows.length < 2) {
    throw new Error("validation lab: the VALIDATION-REPORT NOT RUN boundaries table drifted");
  }
  const [header, ...data] = rows;
  if (header === undefined || !header.join("|").includes("Surface")) {
    throw new Error("validation lab: the VALIDATION-REPORT NOT RUN boundaries header drifted");
  }
  return data.map((cells) => ({
    surface: cells[0] ?? "",
    exactReason: cells[1] ?? "",
    surfacedToOperator: cells[2] ?? "",
  }));
}

function parseCoverage(): readonly CoverageRow[] {
  const section = markdownSection(REPORT_MARKDOWN, "Application coverage");
  const rows = markdownTableRows(section);
  if (rows.length < 2) {
    throw new Error("validation lab: the VALIDATION-REPORT application coverage table drifted");
  }
  const [header, ...data] = rows;
  if (header === undefined || !header.join("|").includes("Workload")) {
    throw new Error("validation lab: the VALIDATION-REPORT application coverage header drifted");
  }
  return data.map((cells) => {
    const app = cells[1] ?? "";
    return {
      workload: cells[0] ?? "",
      app,
      corpusVersion: cells[2] ?? "",
      runs: cells[3] ?? "",
      quality: cells[4] ?? "",
      reliability: cells[5] ?? "",
      costPerSuccess: cells[6] ?? "",
      status: cells[7] ?? "",
      workOrders: [...app.matchAll(/VAL-\d{3}/g)].map((match) => match[0]),
    };
  });
}

const PROVIDER_COVERAGE: readonly ProviderCoverageRow[] = parseProviderCoverage();
const NOT_RUN_BOUNDARIES: readonly NotRunBoundary[] = parseNotRunBoundaries();
const COVERAGE: readonly CoverageRow[] = parseCoverage();

// ---------------------------------------------------------------------------
// The experiment applications (benchmarks/validation/apps/*)
// ---------------------------------------------------------------------------

/** One validation application as the repository records it. */
export interface ValidationApp {
  readonly dir: string;
  readonly workOrder: string;
  readonly readmeTitle: string;
  readonly scenarioIds: readonly string[];
  readonly families: readonly WorkloadFamily[];
  readonly taskCount: number | null;
  readonly pollIntervalMs: number | null;
  readonly completionTimeoutMs: number | null;
  readonly liveGateEnvVars: readonly string[];
  readonly suitePath: string | null;
}

function scenarioTokensOf(readme: string): readonly string[] {
  const tokens = new Set<string>();
  for (const match of readme.matchAll(/`([a-z][a-z0-9-]*\.[a-z0-9-]+\.v\d+)`/g)) {
    const token = match[1] ?? "";
    if (CORPUS_SCENARIO_IDS.has(token)) {
      tokens.add(token);
    }
  }
  return [...tokens];
}

/** The corpus task-input kinds (each maps to exactly one family — verified at load). */
const KIND_TO_FAMILY: Readonly<Record<string, WorkloadFamily>> = (() => {
  const out: Record<string, WorkloadFamily> = {};
  for (const task of GOLDEN_TASKS) {
    const kind = String(task.input.kind ?? "");
    if (kind.length === 0) {
      continue;
    }
    const existing = out[kind];
    if (existing !== undefined && existing !== task.family) {
      throw new Error(
        `validation lab: corpus kind "${kind}" maps to two families (${existing}, ${task.family}) — the kind projection drifted`,
      );
    }
    out[kind] = task.family;
  }
  return out;
})();

/** The backticked single-word tokens a README carries (kind candidates). */
function wordTokensOf(readme: string): readonly string[] {
  const tokens = new Set<string>();
  for (const match of readme.matchAll(/`([a-z][a-z0-9-]+)`/g)) {
    tokens.add(match[1] ?? "");
  }
  for (const match of readme.matchAll(/`kind:\s*"([a-z0-9-]+)"`/g)) {
    tokens.add(match[1] ?? "");
  }
  return [...tokens];
}

/**
 * The app→family derivation (mechanical, layered — every layer is
 * repository content): (1) corpus scenario ids named in the README,
 * (2) corpus task-kind tokens named in the README (each kind maps to
 * exactly one family — collision-checked at load), (3) the app's own
 * directory name matching a corpus family ("realtime-voice", "voice-io"
 * → the voice families). Apps whose pinned corpus is app-local still
 * derive their workload family this way; an app no rule can place stays
 * family-less and its experiment says so honestly.
 */
function familiesOfApp(dir: string, readme: string): readonly WorkloadFamily[] {
  const families = new Set<string>();
  for (const scenarioId of scenarioTokensOf(readme)) {
    const task = GOLDEN_TASKS.find((candidate) => candidate.scenarioId === scenarioId);
    if (task !== undefined) {
      families.add(task.family);
    }
  }
  for (const token of wordTokensOf(readme)) {
    const byKind = KIND_TO_FAMILY[token];
    if (byKind !== undefined) {
      families.add(byKind);
    }
  }
  for (const family of WORKLOAD_FAMILIES) {
    if (dir === family || dir.startsWith(`${family}-`)) {
      families.add(family);
    }
  }
  return [...families]
    .filter((family): family is WorkloadFamily =>
      (WORKLOAD_FAMILIES as readonly string[]).includes(family),
    )
    .sort((a, b) => (FAMILY_ORDER[a] ?? 0) - (FAMILY_ORDER[b] ?? 0));
}

function suitePathOf(readme: string): string | null {
  const runSection = markdownSection(readme, "Run");
  const match = /tests\/[A-Za-z0-9/._-]+\.test\.ts/.exec(runSection);
  return match === null ? null : match[0];
}

function narrowAppConfig(
  value: unknown,
  dir: string,
): {
  taskCount: number | null;
  pollIntervalMs: number | null;
  completionTimeoutMs: number | null;
  liveGateEnvVars: readonly string[];
} {
  if (typeof value !== "object" || value === null) {
    throw new Error(`validation lab: apps/${dir}/config.json must be an object`);
  }
  const record = value as Readonly<Record<string, unknown>>;
  const gates = new Set<string>();
  if (Array.isArray(record.tasks)) {
    for (const task of record.tasks) {
      if (typeof task === "object" && task !== null) {
        const gate = (task as Readonly<Record<string, unknown>>).liveGate;
        if (typeof gate === "string") {
          gates.add(gate);
        } else if (Array.isArray(gate)) {
          for (const name of gate) {
            if (typeof name === "string" && name.length > 0) {
              gates.add(name);
            }
          }
        }
      }
    }
  }
  return {
    taskCount:
      record.taskCount !== undefined
        ? requireNumber(record.taskCount, `${dir} taskCount`)
        : Array.isArray(record.tasks)
          ? record.tasks.length
          : null,
    pollIntervalMs:
      record.pollIntervalMs === undefined
        ? null
        : requireNumber(record.pollIntervalMs, `${dir} pollIntervalMs`),
    completionTimeoutMs:
      record.completionTimeoutMs === undefined
        ? null
        : requireNumber(record.completionTimeoutMs, `${dir} completionTimeoutMs`),
    liveGateEnvVars: [...gates].sort(),
  };
}

function scanApps(): readonly ValidationApp[] {
  const out: ValidationApp[] = [];
  const entries = readdirSync(fileURLToPath(APPS_URL), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  for (const dir of entries) {
    if (dir === "shared") {
      continue; // the acknowledged non-app support module (no work order)
    }
    const readmePath = fileURLToPath(new URL(`${dir}/README.md`, APPS_URL));
    const readme = readFileSync(readmePath, "utf8");
    const firstLine = readme.split("\n", 1)[0] ?? "";
    const workOrderMatch =
      /\(?(VAL-\d{3})\)?\s*$/.exec(firstLine.trim()) ??
      /^#\s+\((VAL-\d{3})\)/.exec(firstLine.trim()) ??
      /^#\s+(VAL-\d{3})\b/.exec(firstLine.trim());
    if (workOrderMatch === null) {
      throw new Error(
        `validation lab: apps/${dir}/README.md first line carries no work order tag — the app-to-work-order mapping drifted`,
      );
    }
    const scenarioIds = scenarioTokensOf(readme);
    const families = familiesOfApp(dir, readme);
    const config = narrowAppConfig(
      JSON.parse(readFileSync(fileURLToPath(new URL(`${dir}/config.json`, APPS_URL)), "utf8")),
      dir,
    );
    const readmeTitle = firstLine
      .replace(/^#\s+/, "")
      .replace(/^VAL-\d{3}\s*[—–:-]\s*/, "")
      .replace(/\s*\(VAL-\d{3}\)\s*$/, "")
      .trim();
    out.push({
      dir,
      workOrder: workOrderMatch[1] ?? "",
      readmeTitle,
      scenarioIds,
      families,
      taskCount: config.taskCount,
      pollIntervalMs: config.pollIntervalMs,
      completionTimeoutMs: config.completionTimeoutMs,
      liveGateEnvVars: config.liveGateEnvVars,
      suitePath: suitePathOf(readme),
    });
  }
  if (out.length === 0) {
    throw new Error(
      "validation lab: no validation applications found under benchmarks/validation/apps",
    );
  }
  return out;
}

const VALIDATION_APPS: readonly ValidationApp[] = scanApps();

// ---------------------------------------------------------------------------
// The experiment catalog (the DEP-025 AC1 projection)
// ---------------------------------------------------------------------------

/** One validation experiment — the console projection of a work order. */
export interface ValidationExperiment {
  readonly id: string;
  readonly title: string;
  readonly status: string;
  readonly stage: string;
  readonly objective: string;
  readonly specPath: string;
  readonly evidencePath: string;
  readonly dependencies: readonly string[];
  readonly apps: readonly ValidationApp[];
  readonly families: readonly WorkloadFamily[];
  readonly corpusTaskCount: number;
  readonly recordedCoverage: readonly CoverageRow[];
  readonly notRunBoundaries: readonly NotRunBoundary[];
  readonly definitionRevision: string;
  readonly mergedAs: {
    readonly pr: number | null;
    readonly mergeCommit: string | null;
    readonly implementationHead: string | null;
    readonly finalBranchHead: string | null;
    readonly baseRevision: string | null;
  };
}

function evidencePathOf(id: string): string {
  return id === "VAL-001"
    ? "benchmarks/validation/evidence/VAL-001.md"
    : `docs/work-items/${id}.md`;
}

function assembleCatalog(): readonly ValidationExperiment[] {
  const governedIds = new Set(GOVERNED_WORK_ORDERS.map((order) => order.id));
  for (const id of Object.keys(DEPENDENCIES)) {
    if (!governedIds.has(id)) {
      throw new Error(`validation lab: dependency-state references unregistered ${id}`);
    }
  }
  const appsByWorkOrder: Record<string, ValidationApp[]> = {};
  for (const app of VALIDATION_APPS) {
    if (!governedIds.has(app.workOrder)) {
      throw new Error(`validation lab: apps/${app.dir} references unregistered ${app.workOrder}`);
    }
    const existing = appsByWorkOrder[app.workOrder];
    if (existing === undefined) {
      appsByWorkOrder[app.workOrder] = [app];
    } else {
      existing.push(app);
    }
  }
  return GOVERNED_WORK_ORDERS.map((order) => {
    const stage = STAGES[order.id];
    if (stage === undefined) {
      throw new Error(`validation lab: the validation roadmap records no stage for ${order.id}`);
    }
    const specPath = `spec/validation-work-orders/${order.id}.md`;
    const spec = readFileSync(
      fileURLToPath(new URL(specPath.replace(/^spec\//, "../../spec/"), import.meta.url)),
      "utf8",
    );
    const evidencePath = evidencePathOf(order.id);
    readFileSync(
      fileURLToPath(
        new URL(evidencePath.replace(/^(docs|benchmarks)\//, "../../$1/"), import.meta.url),
      ),
      "utf8",
    );
    const apps = (appsByWorkOrder[order.id] ?? []).sort((a, b) => (a.dir < b.dir ? -1 : 1));
    const families = [...new Set(apps.flatMap((app) => app.families))].sort(
      (a, b) => (FAMILY_ORDER[a] ?? 0) - (FAMILY_ORDER[b] ?? 0),
    );
    const corpusTaskCount = GOLDEN_TASKS.filter((task) => families.includes(task.family)).length;
    const definitionRevision =
      order.mergeCommit ?? order.implementationHead ?? order.baseRevision ?? "unrecorded";
    return {
      id: order.id,
      title: order.title,
      status: order.status,
      stage,
      objective: parseObjective(spec, order.id),
      specPath,
      evidencePath,
      dependencies: DEPENDENCIES[order.id] ?? [],
      apps,
      families,
      corpusTaskCount,
      recordedCoverage: COVERAGE.filter((row) => row.workOrders.includes(order.id)),
      notRunBoundaries: NOT_RUN_BOUNDARIES.filter((row) => row.surface.includes(order.id)),
      definitionRevision,
      mergedAs: {
        pr: order.pr,
        mergeCommit: order.mergeCommit,
        implementationHead: order.implementationHead,
        finalBranchHead: order.finalBranchHead,
        baseRevision: order.baseRevision,
      },
    };
  });
}

/** The ONE catalog instance, loaded once at module scope (fail-fast on drift). */
const EXPERIMENTS: readonly ValidationExperiment[] = assembleCatalog();

/** Every validation experiment in governed id order (VAL-001..VAL-052 minus unissued). */
export function validationExperiments(): readonly ValidationExperiment[] {
  return EXPERIMENTS;
}

/** One experiment by id, or null when the governed state records none. */
export function experimentOf(id: string): ValidationExperiment | null {
  return EXPERIMENTS.find((experiment) => experiment.id === id) ?? null;
}

/** The un-issued id gaps inside VAL-001..VAL-052 (the honest catalog note). */
export function unissuedValidationIds(): readonly string[] {
  const issued = new Set(EXPERIMENTS.map((experiment) => experiment.id));
  const out: string[] = [];
  for (let index = 1; index <= 52; index += 1) {
    const id = `VAL-${String(index).padStart(3, "0")}`;
    if (!issued.has(id)) {
      out.push(id);
    }
  }
  return out;
}

/** The experiments grouped by the roadmap's stage vocabulary. */
export function experimentsByStage(): readonly {
  readonly stage: string;
  readonly experiments: readonly ValidationExperiment[];
}[] {
  const stages: string[] = [];
  for (const experiment of EXPERIMENTS) {
    if (!stages.includes(experiment.stage)) {
      stages.push(experiment.stage);
    }
  }
  return stages.map((stage) => ({
    stage,
    experiments: EXPERIMENTS.filter((experiment) => experiment.stage === stage),
  }));
}

/** The capability-matrix view (the By-capability projection source). */
export function capabilityMatrixRows(): readonly {
  readonly capability: string;
  readonly kind: string;
  readonly requiredBy: readonly string[];
  readonly candidates: readonly string[];
  readonly accessRequirement: string;
  readonly experiments: readonly ValidationExperiment[];
}[] {
  return CAPABILITY_MATRIX.map((entry) => ({
    capability: entry.capability,
    kind: entry.kind,
    requiredBy: entry.requiredBy,
    candidates: entry.candidates,
    accessRequirement: entry.accessRequirement,
    experiments: EXPERIMENTS.filter((experiment) =>
      experiment.families.some((family) => entry.requiredBy.includes(family)),
    ),
  }));
}

/** The provider access registry (credential env-var NAMES only). */
export function providerAccessRows(): readonly {
  readonly provider: string;
  readonly credentialEnvVar: string;
  readonly probeSummary: string;
}[] {
  return PROVIDER_ACCESS.map((access) => ({
    provider: access.provider,
    credentialEnvVar: access.credentialEnvVar,
    probeSummary: access.probeSummary,
  }));
}

/** The recorded provider/model coverage rows (VALIDATION-REPORT, verbatim). */
export function providerCoverageRows(): readonly ProviderCoverageRow[] {
  return PROVIDER_COVERAGE;
}

/** The recorded NOT RUN boundaries (VALIDATION-REPORT, verbatim). */
export function notRunBoundaries(): readonly NotRunBoundary[] {
  return NOT_RUN_BOUNDARIES;
}

// ---------------------------------------------------------------------------
// Availability (DEP-025 AC6 — exact dependency surfaced BEFORE execution)
// ---------------------------------------------------------------------------

/** One required-access fact for an experiment (names only, never values). */
export interface RequiredAccessFact {
  readonly capability: string;
  readonly kind: string;
  readonly accessRequirement: string;
  readonly candidateEnvVars: readonly string[];
}

/** The availability view of one experiment against a concrete environment. */
export interface AvailabilityView {
  readonly access: readonly RequiredAccessFact[];
  readonly presentEnvVars: readonly string[];
  readonly missingEnvVars: readonly string[];
  readonly hardBlocked: readonly {
    readonly capability: string;
    readonly accessRequirement: string;
    readonly reason: string;
  }[];
}

function accessFactsOf(experiment: ValidationExperiment): readonly RequiredAccessFact[] {
  const envNamesOf = (providers: readonly string[]): readonly string[] => {
    const names = new Set<string>();
    for (const access of PROVIDER_ACCESS) {
      if (providers.includes(access.provider)) {
        names.add(access.credentialEnvVar);
      }
    }
    return [...names].sort();
  };
  const facts: RequiredAccessFact[] = [];
  for (const entry of CAPABILITY_MATRIX) {
    if (experiment.families.some((family) => entry.requiredBy.includes(family))) {
      facts.push({
        capability: entry.capability,
        kind: entry.kind,
        accessRequirement: entry.accessRequirement,
        candidateEnvVars: envNamesOf(entry.candidates),
      });
    }
  }
  return facts;
}

/**
 * The availability view: which candidate credential NAMES the deployment
 * environment carries, and which capabilities are HARD-blocked because the
 * capability matrix records no candidate provider at all (the recorded
 * no-provider boundary). Values are never read — presence by name only.
 */
export function availabilityOf(
  experiment: ValidationExperiment,
  env: Readonly<Record<string, string | undefined>> = process.env,
): AvailabilityView {
  const access = accessFactsOf(experiment);
  const present = new Set<string>();
  const missing = new Set<string>();
  for (const fact of access) {
    for (const name of fact.candidateEnvVars) {
      if (typeof env[name] === "string" && (env[name] as string).length > 0) {
        present.add(name);
      } else {
        missing.add(name);
      }
    }
  }
  const hardBlocked = access
    .filter((fact) => fact.candidateEnvVars.length === 0)
    .map((fact) => ({
      capability: fact.capability,
      accessRequirement: fact.accessRequirement,
      reason:
        "the capability matrix records no candidate provider for this capability — a console rerun would be a NOT RUN boundary, never a pass",
    }));
  return {
    access,
    presentEnvVars: [...present].sort(),
    missingEnvVars: [...missing].sort(),
    hardBlocked,
  };
}

/** True when the experiment can be rerun from the console at all. */
export function experimentIsRerunnable(experiment: ValidationExperiment): boolean {
  return experiment.families.length > 0 && experiment.corpusTaskCount > 0;
}

/** The golden tasks of an experiment (corpus order). */
export function tasksOfExperiment(experiment: ValidationExperiment): readonly GoldenTask[] {
  return GOLDEN_TASKS.filter((task) => experiment.families.includes(task.family));
}

/** The corpus task count of one workload family. */
export function familyTaskCountOf(family: string): number {
  return GOLDEN_TASKS.filter((task) => task.family === family).length;
}

/**
 * The default (pinned) task: the first corpus task — in corpus registry
 * order — of the scenarios the experiment's applications name in their
 * READMEs; else the first task of the experiment's first family.
 * Deterministic by construction.
 */
export function defaultTaskOf(experiment: ValidationExperiment): GoldenTask | null {
  const named: string[] = [];
  for (const app of experiment.apps) {
    for (const scenarioId of app.scenarioIds) {
      if (!named.includes(scenarioId)) {
        named.push(scenarioId);
      }
    }
  }
  for (const task of GOLDEN_TASKS) {
    if (named.includes(task.scenarioId)) {
      return task;
    }
  }
  return tasksOfExperiment(experiment)[0] ?? null;
}

/**
 * The recommended starting points (the IA surface): console-rerunnable
 * experiments whose recorded coverage completed and whose required
 * capabilities all have candidate providers (no recorded no-provider gap).
 */
export function recommendedExperiments(): readonly ValidationExperiment[] {
  return EXPERIMENTS.filter(
    (experiment) =>
      experimentIsRerunnable(experiment) &&
      experiment.recordedCoverage.length > 0 &&
      experiment.recordedCoverage.some((row) => row.status.includes("COMPLETED")) &&
      accessFactsOf(experiment).every((fact) => fact.candidateEnvVars.length > 0),
  );
}

// ---------------------------------------------------------------------------
// The rerun form (client-side envelope enforcement, before any wire call)
// ---------------------------------------------------------------------------

export interface ValidationRunFormValues {
  readonly applicationId: string;
  readonly environmentId: string;
  readonly spendLimitDollars: string;
  readonly mode: string;
  readonly taskId: string;
  readonly spendMicroUsd?: string;
}

export type ValidationRunFormErrors = Partial<Record<keyof ValidationRunFormValues, string>>;

/**
 * Validate the rerun form AGAINST THE ENVELOPE (client-side, before any
 * wire call): the application scope is required, the mode must be one of
 * the contract's rerun modes, the task must belong to the experiment's
 * corpus families, and the optional spend limit must sit at or under the
 * sandbox ceiling.
 */
export function validateValidationRunForm(
  experiment: ValidationExperiment,
  form: Readonly<Record<string, string>>,
): {
  values: ValidationRunFormValues | null;
  errors: ValidationRunFormErrors;
} {
  const errors: ValidationRunFormErrors = {};
  const applicationId = (form.applicationId ?? "").trim();
  const environmentId = (form.environmentId ?? "").trim();
  const spendLimitDollars = (form.spendLimitDollars ?? "").trim();
  const mode = (form.mode ?? "").trim();
  const taskId = (form.taskId ?? "").trim();
  if (applicationId.length === 0) {
    errors.applicationId = "The application scope is required — the rerun belongs to it.";
  }
  if (!VALIDATION_RUN_MODES.includes(mode)) {
    errors.mode = `Choose a rerun mode: ${VALIDATION_RUN_MODES.join(", ")}.`;
  }
  const tasks = tasksOfExperiment(experiment);
  const task = tasks.find((candidate) => candidate.taskId === taskId);
  if (task === undefined) {
    errors.taskId = "Choose a corpus task of this experiment's workload families.";
  }
  let spendMicroUsd: string | null = null;
  if (spendLimitDollars.length > 0) {
    spendMicroUsd = dollarsToMicroUsd(spendLimitDollars);
    if (spendMicroUsd === null) {
      errors.spendLimitDollars =
        "Enter the spend ceiling as dollars with at most two decimals (e.g. 1.50).";
    } else if (BigInt(spendMicroUsd) > BigInt(VALIDATION_BUDGET_LIMIT_MICRO_USD)) {
      errors.spendLimitDollars = `Validation reruns are capped at $${VALIDATION_BUDGET_LIMIT_DOLLARS} per execution — enter a lower ceiling.`;
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
      mode,
      taskId,
      ...(spendMicroUsd === null ? {} : { spendMicroUsd }),
    },
    errors: {},
  };
}

/**
 * Build the rerun execution request (contract-side enforcement): the corpus
 * task's synthetic input verbatim, the hard budget and latency constraints
 * (replay-exact honors the corpus row's recorded latency target where one
 * exists, capped by the sandbox ceiling), the disposable-sandbox identity
 * and the LINEAGE metadata that links this NEW run to the immutable
 * definition (AC4). The builder can emit ONLY the frozen create vocabulary.
 */
export function buildValidationRunRequest(
  experiment: ValidationExperiment,
  task: GoldenTask,
  values: ValidationRunFormValues,
): ExecutionRequest {
  const declared = values.spendMicroUsd ?? dollarsToMicroUsd(values.spendLimitDollars.trim());
  const budgetMicroUsd =
    declared !== null && BigInt(declared) < BigInt(VALIDATION_BUDGET_LIMIT_MICRO_USD)
      ? declared
      : VALIDATION_BUDGET_LIMIT_MICRO_USD;
  const recordedLatency =
    values.mode === "replay-exact" && task.latencyTargetMs !== undefined
      ? Math.min(task.latencyTargetMs, VALIDATION_LATENCY_LIMIT_MS)
      : VALIDATION_LATENCY_LIMIT_MS;
  const defaultTask = defaultTaskOf(experiment);
  const metadata: Record<string, unknown> = {
    origin: VALIDATION_LAB_ORIGIN,
    workOrder: experiment.id,
    mode: values.mode,
    corpusTask: task.taskId,
    corpusVersion: CORPUS_VERSION,
    definitionRevision: experiment.definitionRevision,
    sandbox: "disposable",
  };
  if (values.mode === "modified" && defaultTask !== null && defaultTask.taskId !== task.taskId) {
    metadata.modifiedFrom = defaultTask.taskId;
  }
  return {
    applicationId: values.applicationId,
    ...(values.environmentId.length === 0 ? {} : { environmentId: values.environmentId }),
    task: task.input,
    constraints: {
      maxCostMicroUsd: budgetMicroUsd,
      maxLatencyMs: recordedLatency,
    },
    metadata,
  };
}

// ---------------------------------------------------------------------------
// Run history and comparison (derived live from executions this browser opened)
// ---------------------------------------------------------------------------

/** One Validation Lab run fact, derived from a live execution record. */
export interface ValidationRunFact {
  readonly executionId: string;
  readonly workOrder: string | null;
  readonly mode: string | null;
  readonly corpusTask: string | null;
  readonly corpusVersion: string | null;
  readonly definitionRevision: string | null;
  readonly status: string;
  readonly createdAt: string;
  readonly updatedAt: string;
}

function stringMetadata(metadata: Readonly<Record<string, unknown>>, key: string): string | null {
  const value = metadata[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

/** The Validation Lab runs among a recents read (the run history source). */
export function validationRunsOf(executions: readonly Execution[]): readonly ValidationRunFact[] {
  return executions
    .filter((execution) => stringMetadata(execution.metadata, "origin") === VALIDATION_LAB_ORIGIN)
    .map((execution) => ({
      executionId: execution.id,
      workOrder: stringMetadata(execution.metadata, "workOrder"),
      mode: stringMetadata(execution.metadata, "mode"),
      corpusTask: stringMetadata(execution.metadata, "corpusTask"),
      corpusVersion: stringMetadata(execution.metadata, "corpusVersion"),
      definitionRevision: stringMetadata(execution.metadata, "definitionRevision"),
      status: execution.status,
      createdAt: execution.createdAt,
      updatedAt: execution.updatedAt,
    }));
}

/** The run history of one experiment (recents-derived, navigation-only). */
export function validationRunsForWorkOrder(
  executions: readonly Execution[],
  workOrderId: string,
): readonly ValidationRunFact[] {
  return validationRunsOf(executions).filter((run) => run.workOrder === workOrderId);
}

/** One comparison row: a live run read against the corpus's recorded expectation. */
export interface RunComparisonRow {
  readonly executionId: string;
  readonly mode: string | null;
  readonly corpusTask: string | null;
  readonly status: string;
  readonly expectedTerminalStatus: string | null;
  readonly matchesExpectedTerminal: boolean | null;
  readonly expectedVerification: string | null;
  readonly matchesExpectedVerification: boolean | null;
  readonly costMicroUsd: string | null;
  readonly durationMs: number | null;
  readonly warningCount: number;
}

function durationOf(execution: Execution): number | null {
  if (execution.terminalAt === null) {
    return null;
  }
  const from = Date.parse(execution.createdAt);
  const to = Date.parse(execution.terminalAt);
  if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) {
    return null;
  }
  return to - from;
}

/**
 * The comparison fact of one run: the corpus row's RECORDED expectation
 * (terminal status / verification) against the live execution's own
 * records. A mismatch is an honest finding — never converted, never
 * retried away.
 */
export function validationComparisonOf(
  execution: Execution,
  result: ExecutionResult | null,
): RunComparisonRow {
  const corpusTask = stringMetadata(execution.metadata, "corpusTask");
  const task =
    corpusTask === null
      ? null
      : (GOLDEN_TASKS.find((candidate) => candidate.taskId === corpusTask) ?? null);
  const expected = task?.expectedOutcome ?? null;
  const verificationStatuses = (result?.verification ?? []).map(
    (verification) => verification.status,
  );
  const verificationVerdict =
    verificationStatuses.length === 0
      ? null
      : verificationStatuses.every((status) => status === "PASS")
        ? "PASS"
        : verificationStatuses.every((status) => status === "FAIL")
          ? "FAIL"
          : "INCONCLUSIVE";
  return {
    executionId: execution.id,
    mode: stringMetadata(execution.metadata, "mode"),
    corpusTask,
    status: execution.status,
    expectedTerminalStatus: expected?.terminalStatus ?? null,
    matchesExpectedTerminal:
      expected === null ? null : execution.status === expected.terminalStatus,
    expectedVerification: expected?.verification ?? null,
    matchesExpectedVerification:
      expected?.verification === undefined || verificationVerdict === null
        ? null
        : verificationVerdict === expected.verification,
    costMicroUsd: result?.cost?.totalMicroUsd ?? null,
    durationMs: durationOf(execution),
    warningCount: result?.warnings.length ?? 0,
  };
}

// ---------------------------------------------------------------------------
// The agent/machine interface (DEP-025 AC3 — no undocumented UI-only state)
// ---------------------------------------------------------------------------

function experimentCatalogEntry(experiment: ValidationExperiment): Record<string, unknown> {
  const defaultTask = defaultTaskOf(experiment);
  return {
    id: experiment.id,
    title: experiment.title,
    status: experiment.status,
    stage: experiment.stage,
    objective: experiment.objective,
    families: experiment.families,
    dependencies: experiment.dependencies,
    specPath: experiment.specPath,
    evidencePath: experiment.evidencePath,
    definitionRevision: experiment.definitionRevision,
    mergedAs: experiment.mergedAs,
    apps: experiment.apps.map((app) => ({
      dir: `benchmarks/validation/apps/${app.dir}`,
      taskCount: app.taskCount,
      liveGateEnvVars: app.liveGateEnvVars,
      suitePath: app.suitePath,
      scenarioIds: app.scenarioIds,
    })),
    corpus: {
      version: CORPUS_VERSION,
      taskCount: experiment.corpusTaskCount,
      ...(defaultTask === null ? {} : { defaultTask: defaultTask.taskId }),
    },
    requiredAccess: accessFactsOf(experiment).map((fact) => ({
      capability: fact.capability,
      accessRequirement: fact.accessRequirement,
      candidateEnvVars: fact.candidateEnvVars,
    })),
    recordedCoverage: experiment.recordedCoverage.map((row) => ({
      workload: row.workload,
      runs: row.runs,
      status: row.status,
      costPerSuccess: row.costPerSuccess,
    })),
    notRunBoundaries: experiment.notRunBoundaries,
    rerunnable: experimentIsRerunnable(experiment),
    links: {
      self: `/console/validation/${experiment.id}`,
      definition: `/console/validation/api/${experiment.id}.json`,
      evidence: `/console/validation/api/evidence/${experiment.id}`,
      bundle: `/console/validation/api/${experiment.id}/bundle.json`,
      startRun: `/console/validation/${experiment.id}/run`,
      html: `/console/validation/${experiment.id}`,
    },
  };
}

/** The machine-readable validation catalog (the agent's list step). */
export function validationCatalogJson(): string {
  return JSON.stringify(
    {
      schemaVersion: 1,
      program: "zeck-validation",
      programStatus: "roadmap-complete (spec/validation-state/program-state.json)",
      corpusVersion: CORPUS_VERSION,
      description:
        "The Validation Lab catalog, projected from repository truth (governed program state, work-order specs, evidence documents, the golden corpus, the capability matrix and the recorded VALIDATION-REPORT). The same catalog powers the human console — there is no console-only source of truth.",
      unissuedIds: unissuedValidationIds(),
      experiments: EXPERIMENTS.map(experimentCatalogEntry),
      stages: experimentsByStage().map((stage) => ({
        stage: stage.stage,
        experiments: stage.experiments.map((experiment) => experiment.id),
      })),
      providerCoverage: PROVIDER_COVERAGE,
      notRunBoundaries: NOT_RUN_BOUNDARIES,
      agentInterface: {
        schema: "/console/validation/api/schema.json",
        definition: "/console/validation/api/VAL-010.json (pattern)",
        runRecord: "/console/validation/api/runs/{executionId}.json",
        evidence: "/console/validation/api/evidence/{workOrderId}",
        bundle: "/console/validation/api/{workOrderId}/bundle.json",
      },
    },
    null,
    2,
  );
}

/** The machine-readable definition of one experiment (inspect + access + cost). */
export function experimentDefinitionJson(
  experiment: ValidationExperiment,
  env: Readonly<Record<string, string | undefined>> = process.env,
): string {
  const availability = availabilityOf(experiment, env);
  const defaultTask = defaultTaskOf(experiment);
  return JSON.stringify(
    {
      schemaVersion: 1,
      ...experimentCatalogEntry(experiment),
      tasks: tasksOfExperiment(experiment).map((task) => ({
        taskId: task.taskId,
        family: task.family,
        scenarioId: task.scenarioId,
        description: task.description,
        input: task.input,
        expectedOutcome: task.expectedOutcome,
        forbiddenOutcomes: task.forbiddenOutcomes,
        latencyTargetMs: task.latencyTargetMs ?? null,
        evaluation: task.evaluation,
        determinism: task.determinism,
        ...(task.requiresCapabilities === undefined
          ? {}
          : { requiresCapabilities: task.requiresCapabilities }),
      })),
      ...(defaultTask === null ? {} : { defaultTaskId: defaultTask.taskId }),
      availability: {
        presentEnvVars: availability.presentEnvVars,
        missingEnvVars: availability.missingEnvVars,
        hardBlocked: availability.hardBlocked,
        note: "Credential NAMES only — values are never read or rendered. A missing rail is surfaced before execution and is NEVER represented as PASS; the platform's policy admission remains the final gate on every run.",
      },
      costEstimate: {
        budgetCeilingMicroUsd: VALIDATION_BUDGET_LIMIT_MICRO_USD,
        latencyCeilingMs: VALIDATION_LATENCY_LIMIT_MS,
        note: "No pre-run estimate exists; the request carries the hard ceiling and the settled cost is recorded per execution. Recorded validation-program costs appear in recordedCoverage.costPerSuccess where measured.",
      },
      runInstructions: {
        method: "POST",
        action: `/console/validation/${experiment.id}/run`,
        contentType: "application/x-www-form-urlencoded",
        fields: [
          { name: "applicationId", required: true },
          { name: "environmentId", required: false },
          { name: "spendLimitDollars", required: false, max: VALIDATION_BUDGET_LIMIT_DOLLARS },
          { name: "mode", required: true, enum: VALIDATION_RUN_MODES },
          { name: "taskId", required: true, source: "tasks[].taskId of this definition" },
          { name: "idempotencyKey", required: true },
          { name: "format", required: false, enum: ["html", "json"] },
        ],
        success: {
          html: "303 redirect to /runs/{executionId}",
          json: "format=json → 200 application/json { executionId, runRecord }",
        },
      },
    },
    null,
    2,
  );
}

/** The machine schema document (the agent's interface contract). */
export function agentSchemaJson(): string {
  return JSON.stringify(
    {
      schemaVersion: 1,
      description:
        "The Validation Lab machine interface: the same projected catalog the human console renders, plus the governed run path. An agent can list → inspect → check access → estimate cost → start → poll → retrieve → compare → export without any UI-only state.",
      steps: {
        list: {
          method: "GET",
          url: "/console/validation/api/catalog.json",
          returns: "the full experiment catalog (stages, definitions, availability, boundaries)",
        },
        inspect: {
          method: "GET",
          url: "/console/validation/api/{workOrderId}.json",
          returns: "one definition: objective, tasks, expected outcomes, access, cost, run fields",
        },
        checkAccess: {
          description:
            "availability.missingEnvVars on the definition lists the exact credential NAMES absent from the deployment; availability.hardBlocked lists capabilities with no candidate provider (a NOT RUN boundary).",
        },
        estimateCost: {
          description:
            "costEstimate on the definition: the binding hard ceilings plus the recorded validation-program costs where measured.",
        },
        start: {
          method: "POST",
          url: "/console/validation/{workOrderId}/run",
          contentType: "application/x-www-form-urlencoded",
          fields: VALIDATION_FORM_KEYS.concat(["format"]),
          returns:
            "303 → /runs/{executionId} (html) or 200 { executionId, runRecord } (format=json)",
        },
        poll: {
          method: "GET",
          url: "/console/validation/api/runs/{executionId}.json",
          returns:
            "the live run record: status, outcome, cost, latency, trajectory, lineage, comparison",
        },
        retrieve: {
          description:
            "the run record's evidence block names the public API reads (results/events/verification) and the console run page; the original evidence document is GET /console/validation/api/evidence/{workOrderId}.",
        },
        compare: {
          method: "GET",
          url: "/console/validation/compare?runs={id1},{id2}",
          returns:
            "the human comparison surface; the same facts ride each run record's comparisonToExpectation",
        },
        export: {
          method: "GET",
          url: "/console/validation/api/{workOrderId}/bundle.json",
          returns:
            "the reproducibility bundle: definition + evidence + reproduction suite + boundaries",
        },
      },
      rerunModes: VALIDATION_RUN_MODES,
      sandboxEnvelope: {
        budgetCeilingMicroUsd: VALIDATION_BUDGET_LIMIT_MICRO_USD,
        latencyCeilingMs: VALIDATION_LATENCY_LIMIT_MS,
        maxConcurrentRuns: VALIDATION_MAX_CONCURRENT_RUNS,
        data: "synthetic (the golden corpus's authored inputs)",
        identity: VALIDATION_LAB_ORIGIN,
        providerSelection: "impossible — the frozen create contract forbids it",
      },
      providerCredentialNames: PROVIDER_ACCESS.map((access) => access.credentialEnvVar),
    },
    null,
    2,
  );
}

/** The live run record (the agent's poll/retrieve step). */
export function runRecordJson(input: {
  readonly execution: Execution;
  readonly result: ExecutionResult | null;
  readonly events: readonly {
    readonly sequence: number;
    readonly occurredAt: string;
    readonly type: string;
  }[];
  readonly verification: readonly { readonly status: string }[];
  readonly now: string;
}): string {
  const { execution, result, events, verification } = input;
  const metadata = execution.metadata;
  const isValidationRun = stringMetadata(metadata, "origin") === VALIDATION_LAB_ORIGIN;
  const corpusTask = stringMetadata(metadata, "corpusTask");
  const task =
    corpusTask === null
      ? null
      : (GOLDEN_TASKS.find((candidate) => candidate.taskId === corpusTask) ?? null);
  const expected = task?.expectedOutcome ?? null;
  const verificationStatuses = verification.map((entry) => entry.status);
  const verificationVerdict =
    verificationStatuses.length === 0
      ? null
      : verificationStatuses.every((status) => status === "PASS")
        ? "PASS"
        : verificationStatuses.every((status) => status === "FAIL")
          ? "FAIL"
          : "INCONCLUSIVE";
  const record: Record<string, unknown> = {
    schemaVersion: 1,
    executionId: execution.id,
    applicationId: execution.applicationId,
    environmentId: execution.environmentId,
    status: execution.status,
    terminal: execution.terminalAt !== null,
    createdAt: execution.createdAt,
    updatedAt: execution.updatedAt,
    terminalAt: execution.terminalAt,
    durationMs: durationOf(execution),
    latencySource: "console derivation over the public record (createdAt → terminalAt)",
    lineage: isValidationRun
      ? {
          origin: VALIDATION_LAB_ORIGIN,
          workOrder: stringMetadata(metadata, "workOrder"),
          mode: stringMetadata(metadata, "mode"),
          corpusTask,
          corpusVersion: stringMetadata(metadata, "corpusVersion"),
          definitionRevision: stringMetadata(metadata, "definitionRevision"),
          modifiedFrom: stringMetadata(metadata, "modifiedFrom"),
          sandbox: "disposable",
        }
      : null,
    outcome: {
      status: execution.status,
      verificationStatuses,
      warnings: result?.warnings ?? [],
    },
    cost: result?.cost ?? null,
    usage: result?.usage ?? null,
    trajectory: events.map((event) => ({
      sequence: event.sequence,
      at: event.occurredAt,
      type: event.type,
    })),
    evidence: {
      consoleRunUrl: `/runs/${encodeURIComponent(execution.id)}`,
      resultThroughApi: `GET /executions/${encodeURIComponent(execution.id)}/results`,
      eventsThroughApi: `GET /executions/${encodeURIComponent(execution.id)}/events`,
      verificationThroughApi: `GET /executions/${encodeURIComponent(execution.id)}/verification`,
    },
    comparisonToExpectation:
      expected === null
        ? null
        : {
            corpusTask,
            expectedTerminalStatus: expected.terminalStatus,
            matchesTerminalStatus: execution.status === expected.terminalStatus,
            ...(expected.verification === undefined
              ? {}
              : {
                  expectedVerification: expected.verification,
                  matchesVerification: verificationVerdict === expected.verification,
                }),
            note: "The corpus row's recorded expectation. A mismatch is an honest finding — never converted into a pass.",
          },
  };
  return JSON.stringify(record, null, 2);
}

/** The reproducibility bundle (the agent's export step). */
export function reproducibilityBundleJson(
  experiment: ValidationExperiment,
  evidenceContent: string,
): string {
  const defaultTask = defaultTaskOf(experiment);
  return JSON.stringify(
    {
      schemaVersion: 1,
      description:
        "The reproducibility bundle for one validation experiment: the projected definition, the immutable historical evidence document (verbatim), the repository reproduction suites and the recorded NOT RUN boundaries. Historical evidence is read-only; a rerun creates a NEW run identity linked to this definition.",
      definition: experimentCatalogEntry(experiment),
      ...(defaultTask === null
        ? {}
        : {
            defaultCorpusTask: {
              taskId: defaultTask.taskId,
              input: defaultTask.input,
              expectedOutcome: defaultTask.expectedOutcome,
              forbiddenOutcomes: defaultTask.forbiddenOutcomes,
              latencyTargetMs: defaultTask.latencyTargetMs ?? null,
            },
          }),
      evidence: {
        path: experiment.evidencePath,
        content: evidenceContent,
      },
      reproduction: {
        suites: experiment.apps
          .map((app) => app.suitePath)
          .filter((path): path is string => path !== null),
        governedBattery: [
          "bun run typecheck",
          "bun run lint",
          "bun run test:unit",
          "bun run test:architecture",
          "ZECK_PG_TEST_URL=<postgres-url> bun run test:integration",
          "python3 scripts/governance-check.py",
        ],
        environmentGates: [
          ...new Set(experiment.apps.flatMap((app) => app.liveGateEnvVars)),
        ].sort(),
        note: "The suites above are the repository's governed reproduction path; the environment gates are the credential env-var NAMES the live rows require (never values). CI runs credential-less and skips env-gated suites honestly — the recorded proof is the evidence document in this bundle.",
      },
      notRunBoundaries: experiment.notRunBoundaries,
      corpusVersion: CORPUS_VERSION,
    },
    null,
    2,
  );
}

/** Read one experiment's historical evidence document verbatim (read-only). */
export function readValidationEvidence(
  workOrderId: string,
): { readonly experiment: ValidationExperiment; readonly content: string } | null {
  const experiment = experimentOf(workOrderId);
  if (experiment === null) {
    return null;
  }
  const content = readFileSync(
    fileURLToPath(
      new URL(
        experiment.evidencePath.replace(/^(docs|benchmarks)\//, "../../$1/"),
        import.meta.url,
      ),
    ),
    "utf8",
  );
  return { experiment, content };
}

/**
 * The copyable SDK example for one experiment's default (pinned) task —
 * the exact governed create request a console replay submits, composed
 * from the projected definition (never a hand-maintained snippet).
 */
export function sdkExampleOf(experiment: ValidationExperiment, task: GoldenTask): string {
  const request = buildValidationRunRequest(experiment, task, {
    applicationId: "process.env.ZECK_APPLICATION_ID",
    environmentId: "",
    spendLimitDollars: "",
    mode: "replay-exact",
    taskId: task.taskId,
  });
  const constraints = request.constraints;
  const metadata = request.metadata as Readonly<Record<string, unknown>>;
  const metadataLines = Object.keys(metadata)
    .map((key) => `    ${key}: ${JSON.stringify(metadata[key])},`)
    .join("\n");
  return `import { createZeckClient } from "./sdk";

const client = createZeckClient({
  baseUrl: process.env.ZECK_API_URL,
  token: process.env.ZECK_TOKEN,
  applicationId: process.env.ZECK_APPLICATION_ID,
});

// ${experiment.id} replay — corpus task ${task.taskId} (synthetic input, verbatim
// from the golden corpus ${CORPUS_VERSION}; the lineage metadata links this NEW
// run to the immutable definition).
const { receipt } = await client.createExecution(
  {
    applicationId: process.env.ZECK_APPLICATION_ID,
    task: ${JSON.stringify(request.task)},
    constraints: {
      maxCostMicroUsd: ${JSON.stringify(constraints?.maxCostMicroUsd ?? VALIDATION_BUDGET_LIMIT_MICRO_USD)},
      maxLatencyMs: ${JSON.stringify(constraints?.maxLatencyMs ?? VALIDATION_LATENCY_LIMIT_MS)},
    },
    metadata: {
${metadataLines}
    },
  },
  "${experiment.id.toLowerCase()}-replay-1",
);
console.log(receipt.executionId);`;
}
