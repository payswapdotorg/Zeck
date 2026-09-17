/**
 * Zeck execution reproducibility-bundle module (DEP-032 — the export,
 * reproducibility and self-host/deployment handoff surface).
 *
 * A PROJECTION, NEVER A SECOND AUTHORITY (DEP-032): this module holds NO
 * console-local source of truth and NO second artifact, evidence or export
 * authority. The bundle it composes is exactly:
 *
 *   - the verbatim public facts — the SAME composition the explorer's
 *     facts.json machine view serves (`explorerFactsOf`, imported from
 *     the explorer module and embedded UNTOUCHED: the bundle IS the
 *     machine view plus recipe, so machine parity holds by construction
 *     and the two cannot drift);
 *   - the artifact references WITH DIGESTS — the result record's own
 *     `outputArtifacts` (id + digest), never artifact content: bytes stay
 *     in the platform's object store behind their digests, and this
 *     bundle carries references and instructions only;
 *   - the repository revision facts the machine manifests carry — the
 *     declared revision facts of `docs/developer/machine/*.json`
 *     (schemaVersion / openapi version) plus a sha256 digest computed
 *     over each manifest's exact bytes at export time, pinning this
 *     checkout's contract state. The RUNNING deployment's git revision
 *     is the deployment foundation's `GET /identity` attestation
 *     (operator-side) — a named boundary here, never approximated;
 *   - the reproduction recipe — the integration-kit example the machine
 *     manifests record for the run's workload family (or the quickstart
 *     fallback with the miss named), the documented API calls that
 *     recreate the run, and the create request reconstructed from the
 *     RECORDED execution facts (task/constraints/metadata are public
 *     record; the request's idempotency key and userId are not, and
 *     that boundary is explicit);
 *   - the self-host/deployment handoff pointer — the console-served
 *     `docs/developer/SELF-HOSTING.md` guide that PROJECTS the deploy/
 *     foundation by link (never a duplicated, drifting copy).
 *
 * Every fact those sources do NOT carry renders as an explicit boundary
 * entry in the bundle (`boundaries`), never an approximation — the
 * DEP-010/012/025 honesty doctrine.
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { esc, keyValueTable } from "./components";
import { familyOf } from "./console";
import type { ExplorerFacts } from "./explorer";
import { explorerFactsOf, explorerFamilyOf } from "./explorer";
import { exampleOfFamily } from "./playground";
import { emptyState, errorState } from "./states";

// ---------------------------------------------------------------------------
// The repository revision facts (projected from the machine manifests)
// ---------------------------------------------------------------------------

/** The machine manifests the bundle carries revision facts from. */
const MACHINE_MANIFEST_PATHS: readonly string[] = [
  "docs/developer/machine/capability-manifest.json",
  "docs/developer/machine/env-vars.json",
  "docs/developer/machine/error-codes.json",
  "docs/developer/machine/examples-manifest.json",
  "docs/developer/machine/integration-recipe.json",
  "docs/developer/machine/openapi.json",
];

/** One machine manifest's revision facts, as that manifest declares them. */
export interface MachineManifestRevision {
  readonly path: string;
  /**
   * The revision facts the manifest ITSELF carries (its declared
   * schemaVersion, and for the OpenAPI document its openapi/info
   * version) — projected verbatim, never re-derived.
   */
  readonly carriedRevisionFacts: Readonly<Record<string, string>>;
  /** sha256 over the manifest's exact bytes, computed at export time. */
  readonly sha256: string;
}

function manifestFileUrl(path: string): URL {
  return new URL(path.replace(/^docs\//, "../../docs/"), import.meta.url);
}

/**
 * Read one machine manifest's revision facts: the version facts the
 * manifest declares plus the sha256 of its exact bytes (the export-time
 * pin of this checkout's contract state). A manifest that cannot be read
 * or parsed is a hard failure — the bundle never silently drops a
 * manifest it promises to carry.
 */
function machineManifestRevisionOf(path: string): MachineManifestRevision {
  const bytes = readFileSync(fileURLToPath(manifestFileUrl(path)));
  const parsed = JSON.parse(bytes.toString("utf8")) as Readonly<Record<string, unknown>>;
  const carried: Record<string, string> = {};
  if (typeof parsed.schemaVersion === "number" || typeof parsed.schemaVersion === "string") {
    carried.schemaVersion = String(parsed.schemaVersion);
  }
  if (typeof parsed.openapi === "string") {
    carried.openapi = parsed.openapi;
  }
  const info = parsed.info;
  if (typeof info === "object" && info !== null) {
    const version = (info as Readonly<Record<string, unknown>>).version;
    if (typeof version === "string") {
      carried.infoVersion = version;
    }
  }
  return {
    path,
    carriedRevisionFacts: carried,
    sha256: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
  };
}

/** The revision-facts row for every machine manifest (export-time read). */
export function machineManifestRevisions(): readonly MachineManifestRevision[] {
  return MACHINE_MANIFEST_PATHS.map(machineManifestRevisionOf);
}

// ---------------------------------------------------------------------------
// The honest boundary vocabulary (explicit, never approximated)
// ---------------------------------------------------------------------------

/** One explicit boundary: a fact the public records do not carry. */
export interface ExportBoundary {
  readonly field: string;
  readonly statement: string;
  /** The missing public contract that would carry the fact, when named. */
  readonly missingContract?: string;
}

/** The boundaries that hold for EVERY execution export (doctrine-level). */
function universalBoundaries(): readonly ExportBoundary[] {
  return [
    {
      field: "artifactContent",
      statement:
        "Artifact bytes live in the platform's object store behind their digests — this bundle carries references and digests only, never content, and is never a second copy of authority state.",
    },
    {
      field: "environmentConfiguration",
      statement:
        "The public records carry the execution's environment id (when set), never the environment's configuration details — those facts are not exposed by the public API.",
      missingContract: "an environment-configuration projection over the public API",
    },
    {
      field: "requestIdentity",
      statement:
        "The create request's Idempotency-Key and userId are not readable facts: the idempotency SEMANTICS are governed by the create contract (same key + same fingerprint replays the same durable outcome), but the key itself does not cross back. The reproduction recipe therefore uses a FRESH idempotency key by design.",
      missingContract: "a request-identity projection over GET /executions/:id",
    },
    {
      field: "deploymentGitRevision",
      statement:
        "The running deployment's exact git revision is attested by the deployment foundation's GET /identity surface (operator-side: git revision + manifest digest + provider topology). This bundle pins the repository's CONTRACT state instead, through the machine manifests' declared revision facts and the sha256 digests of their exact bytes.",
      missingContract: "the deployment identity attestation (deploy/api.ts GET /identity)",
    },
    {
      field: "perStepCostBreakdown",
      statement:
        "The public API exposes no per-step or per-model cost breakdown — only the settled total on the result record. The bundle reports exactly that.",
      missingContract: "a cost-breakdown projection over GET /executions/:id/results",
    },
  ];
}

// ---------------------------------------------------------------------------
// The reproduction recipe (real, machine-usable without the console)
// ---------------------------------------------------------------------------

/** The recipe's integration-kit example reference (manifest-sourced). */
export interface RecipeExample {
  readonly path: string;
  readonly title: string;
  readonly classification: string;
  readonly envVars: readonly string[];
  /** The console page that serves this example's source verbatim. */
  readonly consolePath: string;
}

/** The documented API calls that recreate and then follow the run. */
const RECIPE_API_CALLS: readonly string[] = [
  "POST /executions (Idempotency-Key header; body: applicationId, task, constraints?, metadata?)",
  "GET /executions/:id (identity, status, task, constraints, metadata)",
  "GET /executions/:id/results (route summary, cost, usage, output artifacts with digests, verification, warnings)",
  "GET /executions/:id/events (the event ledger in causal order)",
  "GET /executions/:id/verification (every recorded check with evidence refs)",
];

/** The recipe's documented developer-doc anchors (all repository-resident). */
const RECIPE_DOC_PATHS: readonly string[] = [
  "docs/developer/QUICKSTART.md",
  "docs/developer/EXECUTIONS.md",
  "docs/developer/SDK.md",
];

/** The canonical fallback example (the quickstart every family composes over). */
const QUICKSTART_EXAMPLE: RecipeExample = {
  path: "examples/quickstart.ts",
  title: "Quickstart — first execution, result, evidence and cost",
  classification: "runnable",
  envVars: ["ZECK_API_URL", "ZECK_TOKEN", "ZECK_APPLICATION_ID"],
  consolePath: "/console/playground/text/example",
};

/**
 * The reproduction recipe's create request, reconstructed from the
 * RECORDED public facts only: task, constraints and metadata cross back
 * verbatim from the execution record; applicationId and environmentId
 * are the record's own scope facts. This is a projection of recorded
 * facts, not a second authority — and it uses a fresh idempotency key
 * by design (the original key is not a readable fact; reusing the
 * recorded outcome is impossible and not the goal — the recipe recreates
 * the RUN, not the row).
 */
function recreateRequestOf(
  execution: ExplorerFacts["execution"],
): Readonly<Record<string, unknown>> {
  const request: Record<string, unknown> = {
    applicationId: execution.applicationId,
    ...(execution.environmentId === null ? {} : { environmentId: execution.environmentId }),
    task: execution.task,
    ...(execution.constraints === null ? {} : { constraints: execution.constraints }),
    ...(Object.keys(execution.metadata).length === 0 ? {} : { metadata: execution.metadata }),
  };
  return request;
}

// ---------------------------------------------------------------------------
// The bundle composition (machine parity by construction)
// ---------------------------------------------------------------------------

/** The bundle's schema version (the export projection's own contract). */
export const EXPORT_BUNDLE_SCHEMA_VERSION = 1;

/**
 * Compose the reproducibility bundle for one execution: the explorer's
 * facts.json composition VERBATIM (embedded under `facts`), the artifact
 * references with digests, the machine manifests' revision facts with
 * byte digests, the reproduction recipe, the self-host handoff pointer,
 * and the explicit boundaries. Pure over its inputs plus the repository
 * checkout (the machine manifests are read at composition time).
 */
export function reproducibilityBundleOf(facts: ExplorerFacts): Readonly<Record<string, unknown>> {
  const { execution, result } = facts;
  const family = explorerFamilyOf(execution);
  const familyRecord = familyOf(family);
  const exampleFact = familyRecord === null ? null : exampleOfFamily(familyRecord);
  const example: RecipeExample =
    exampleFact === null
      ? QUICKSTART_EXAMPLE
      : {
          path: exampleFact.path,
          title: exampleFact.title,
          classification: exampleFact.classification,
          envVars: exampleFact.envVars,
          consolePath: `/console/playground/${encodeURIComponent(family)}/example`,
        };

  const boundaries = [...universalBoundaries()];
  if (familyRecord === null) {
    boundaries.push({
      field: "workloadFamilyExample",
      statement: `The machine capability manifest records no family "${family}" for this run, so the recipe falls back to the quickstart example — the recorded task itself crosses verbatim in the recreated create request.`,
      missingContract:
        "a family record for this run's task kind in docs/developer/machine/capability-manifest.json",
    });
  }
  if (result.cost === null) {
    boundaries.push({
      field: "settledCost",
      statement:
        "The result record carries no settled cost summary for this run (GET /executions/:id/results → cost is null) — nothing is approximated here.",
    });
  }
  if (result.usage === null) {
    boundaries.push({
      field: "usage",
      statement:
        "The result record carries no usage summary for this run (GET /executions/:id/results → usage is null) — provider-reported token counts are never fabricated.",
    });
  }
  if (result.outputArtifacts.length === 0) {
    boundaries.push({
      field: "outputArtifacts",
      statement:
        "The result record carries no output artifacts for this run — the artifacts section lists none rather than inventing references.",
    });
  }
  const noDigest = result.outputArtifacts.filter((artifact) => artifact.digest === null);
  if (noDigest.length > 0) {
    boundaries.push({
      field: "artifactDigests",
      statement: `${String(noDigest.length)} referenced artifact(s) carry no recorded digest (the result record's digest field is null for them) — the reference is carried, the integrity fact is not.`,
    });
  }

  return {
    schemaVersion: EXPORT_BUNDLE_SCHEMA_VERSION,
    description:
      "The reproducibility bundle for one execution: the verbatim public facts (the same composition the execution explorer's facts.json machine view serves), the artifact references with digests (never content), the repository revision facts the machine manifests carry, the reproduction recipe, and the explicit boundaries for every fact the public records do not carry. Machine parity holds by construction — the bundle IS the machine view plus recipe.",
    export: {
      executionId: execution.id,
      bundleView: `/console/executions/${encodeURIComponent(execution.id)}/export`,
      bundleJson: `/console/executions/${encodeURIComponent(execution.id)}/export/bundle.json`,
      machineView: `/console/executions/${encodeURIComponent(execution.id)}/facts.json`,
      explorer: `/console/executions/${encodeURIComponent(execution.id)}`,
    },
    facts: explorerFactsOf(facts),
    artifacts: {
      note: "References and digests only — artifact bytes stay in the platform's object store behind their digests; this bundle never carries content and is never a second authority copy.",
      outputArtifacts: result.outputArtifacts.map((artifact) => ({
        id: artifact.id,
        digest: artifact.digest,
        createdAt: artifact.createdAt,
        reference: `/assets/artifacts/${encodeURIComponent(artifact.id)}?executionId=${encodeURIComponent(
          execution.id,
        )}`,
      })),
    },
    repository: {
      manifests: machineManifestRevisions(),
      note: "The revision facts each machine manifest declares (schemaVersion / openapi version), plus the sha256 of each manifest's exact bytes computed at export time — the export-time pin of this checkout's contract state.",
      boundary:
        "The running deployment's git revision is attested by the deployment foundation's GET /identity surface (operator-side); the dashboard projection cannot read it and does not approximate it.",
    },
    reproduction: {
      example,
      quickstart: QUICKSTART_EXAMPLE.path,
      documentedApiCalls: RECIPE_API_CALLS,
      docs: RECIPE_DOC_PATHS,
      recreatedCreateRequest: recreateRequestOf(execution),
      idempotencyNote:
        "Use a FRESH Idempotency-Key for the recreated run: the original request's key is not a readable public fact, and replaying the recorded row is not the goal — the recipe recreates the run as a new governed execution with its own identity.",
      runCommand: `ZECK_API_URL=<url> ZECK_TOKEN=<token> ZECK_APPLICATION_ID=<id> bun run ${example.path}`,
      selfHostingGuide: {
        consolePath: "/console/docs/SELF-HOSTING.md",
        repositoryPath: "docs/developer/SELF-HOSTING.md",
        note: "To reproduce against a deployment you run yourself, follow the self-host/deployment handoff guide — it projects the repository's deployment foundation (deploy/) by link, with the operator/developer boundary drawn honestly.",
      },
    },
    boundaries,
  };
}

// ---------------------------------------------------------------------------
// The console views (every interpolation escaped — the house rule)
// ---------------------------------------------------------------------------

/** The export action on the execution explorer (DEP-032 AC1's entry point). */
export function explorerExportAction(executionId: string): string {
  const id = encodeURIComponent(executionId);
  return `<a class="button-link primary" href="/console/executions/${id}/export">Export reproducibility bundle</a>`;
}

/** The not-found honest state for the export of an unknown/invisible execution. */
export function exportNotFoundView(executionId: string): string {
  return errorState(
    "This execution is not visible through the governed API",
    `No execution "${executionId}" was returned — it may belong to another application or not exist. The console can only export executions the API authorizes for this token.`,
    "GET /executions/:id through the Zeck SDK client",
  );
}

function boundaryRow(boundary: ExportBoundary): string {
  return `<tr>
      <td class="mono">${esc(boundary.field)}</td>
      <td>${esc(boundary.statement)}${
        boundary.missingContract === undefined
          ? ""
          : ` <span class="muted">(missing contract: ${esc(boundary.missingContract)})</span>`
      }</td>
    </tr>`;
}

/**
 * The bundle view (the human surface of the SAME composition the
 * bundle.json route serves verbatim). Renders from the composed bundle —
 * there is no second composition to drift.
 */
export function executionExportView(bundle: Readonly<Record<string, unknown>>): string {
  const exp = bundle.export as { readonly executionId: string };
  const artifacts = bundle.artifacts as {
    readonly outputArtifacts: readonly {
      readonly id: string;
      readonly digest: string | null;
      readonly reference: string;
    }[];
  };
  const repository = bundle.repository as {
    readonly manifests: readonly MachineManifestRevision[];
  };
  const reproduction = bundle.reproduction as {
    readonly example: RecipeExample;
    readonly quickstart: string;
    readonly documentedApiCalls: readonly string[];
    readonly docs: readonly string[];
    readonly recreatedCreateRequest: Readonly<Record<string, unknown>>;
    readonly idempotencyNote: string;
    readonly runCommand: string;
  };
  const boundaries = bundle.boundaries as readonly ExportBoundary[];

  const artifactRows =
    artifacts.outputArtifacts.length === 0
      ? emptyState(
          "No output artifacts recorded",
          "The result record carries no output artifacts for this run — references appear here when the platform records them (GET /executions/:id/results → outputArtifacts).",
        )
      : `<table class="data">
  <thead><tr><th scope="col">Artifact reference</th><th scope="col">Content digest</th></tr></thead>
  <tbody>${artifacts.outputArtifacts
    .map(
      (artifact) => `<tr>
      <td><a class="evidence-ref" href="${esc(artifact.reference)}">${esc(artifact.id)}</a></td>
      <td>${
        artifact.digest === null
          ? '<span class="muted">(no digest recorded)</span>'
          : `<span class="mono">${esc(artifact.digest)}</span>`
      }</td>
    </tr>`,
    )
    .join("")}</tbody>
</table>`;

  const manifestRows = `<table class="data">
  <thead><tr><th scope="col">Machine manifest</th><th scope="col">Carried revision facts</th><th scope="col">sha256 (exact bytes)</th></tr></thead>
  <tbody>${repository.manifests
    .map(
      (manifest) => `<tr>
      <td class="mono">${esc(manifest.path)}</td>
      <td>${Object.entries(manifest.carriedRevisionFacts)
        .map(([key, value]) => `${esc(key)}: <span class="mono">${esc(value)}</span>`)
        .join(", ")}</td>
      <td class="mono">${esc(manifest.sha256)}</td>
    </tr>`,
    )
    .join("")}</tbody>
</table>`;

  const requestJson = JSON.stringify(reproduction.recreatedCreateRequest, null, 2);

  return `<p class="muted">The reproducibility bundle for this execution: the verbatim public facts (the same composition the <a href="/console/executions/${encodeURIComponent(
    exp.executionId,
  )}/facts.json">facts.json machine view</a> serves), the artifact references with digests, the repository revision facts the machine manifests carry, and the reproduction recipe. Machine parity by construction — <a href="/console/executions/${encodeURIComponent(
    exp.executionId,
  )}/export/bundle.json">download the bundle as verbatim JSON</a>; it is exactly this composition.</p>
<h2>Output artifacts (references and digests only)</h2>
${artifactRows}
<p class="muted">Artifact bytes stay in the platform's object store behind their digests — the bundle carries references and instructions, never content, and is never a second authority copy.</p>
<h2>Repository revision facts (the machine manifests)</h2>
${manifestRows}
<p class="muted">The running deployment's git revision is the deployment foundation's GET /identity attestation (operator-side) — the bundle pins this checkout's contract state through the manifests' declared revision facts and the sha256 digests of their exact bytes, and names the boundary rather than approximating it.</p>
<h2>Reproduction recipe</h2>
${keyValueTable([
  [
    "Integration-kit example",
    `<a href="${esc(reproduction.example.consolePath)}">${esc(reproduction.example.path)}</a> (${esc(
      reproduction.example.classification,
    )})`,
  ],
  ["Quickstart fallback", esc(reproduction.quickstart)],
  ["Run it", `<span class="mono">${esc(reproduction.runCommand)}</span>`],
  [
    "Env vars (names only)",
    reproduction.example.envVars.map((name) => `<span class="mono">${esc(name)}</span>`).join(", "),
  ],
  ["Documented API calls", reproduction.documentedApiCalls.map(esc).join("<br>")],
  ["Docs", reproduction.docs.map((path) => `<span class="mono">${esc(path)}</span>`).join("<br>")],
])}
<h3>The recreated create request (from the recorded facts)</h3>
<pre class="raw">${esc(requestJson)}</pre>
<p class="muted">${esc(reproduction.idempotencyNote)}</p>
<h2>Self-host / deployment handoff</h2>
<p>Reproducing against a deployment you run yourself: follow the <a href="/console/docs/SELF-HOSTING.md">self-hosting guide</a> — it projects the repository's deployment foundation (<span class="mono">deploy/</span>) by link, with the operator/developer boundary drawn honestly (credentials, provider accounts, promotion ladder).</p>
<h2>Honest boundaries</h2>
<table class="data">
  <thead><tr><th scope="col">Field</th><th scope="col">Boundary</th></tr></thead>
  <tbody>${boundaries.map(boundaryRow).join("")}</tbody>
</table>
<h2>The bundle (copyable JSON)</h2>
<pre class="raw">${esc(JSON.stringify(bundle, null, 2))}</pre>`;
}
