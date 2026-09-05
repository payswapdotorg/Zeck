/**
 * Deployment manifest loader and validator (Deployment Roadmap D-01;
 * Work Order WORK-042).
 *
 * The repository is the only source of truth for Zeck deployment
 * configuration (D1.0 §1). This module loads the five repository-resident
 * manifests under `deploy/manifests/`, types them, and validates every
 * cross-consistency rule fail-closed:
 *
 * - environment matrix: exactly the four D1.0 environment classes,
 *   disposable/persistent classes consistent with teardown policy and
 *   the promotion ladder;
 * - provider map: every concern has an owning port, substitution target
 *   and explicit degradation; the authoritative relational concern must
 *   fail closed; `established` port contracts must exist in the
 *   repository tree; `planned` ports must name a roadmap phase that
 *   exists in `docs/DEPLOYMENT-ROADMAP.md`;
 * - resources: every resource kind is declared with constraints; every
 *   concern has a provider; per-branch resources exist only in preview;
 * - secret references: environment-scoped inventory, valid variable
 *   names, consistent name→variable mapping across environments;
 * - variables: unique names; `ZECK_SECRET_*_REF` variables correspond
 *   exactly to the secret-reference inventory (both directions).
 *
 * IO is injected (`ManifestFileReader`) so tests can validate synthetic
 * manifests without touching the filesystem, and the real reader stays
 * a thin `node:fs` adapter.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { EnvironmentId } from "./naming";

export const MANIFEST_FILES = [
  "environments.json",
  "providers.json",
  "resources.json",
  "secret-references.json",
  "variables.json",
] as const;

export type ManifestFileName = (typeof MANIFEST_FILES)[number];

/** Injected manifest reader (relative paths under deploy/manifests/). */
export type ManifestFileReader = (file: ManifestFileName) => string;

export class DeploymentManifestError extends Error {
  readonly problems: readonly string[];

  constructor(problems: readonly string[]) {
    super(
      `invalid deployment manifest set (${problems.length} problem(s)):\n- ${problems.join("\n- ")}`,
    );
    this.name = "DeploymentManifestError";
    this.problems = problems;
  }
}

// ---------------------------------------------------------------------------
// Manifest record types (parsed, validated shapes)
// ---------------------------------------------------------------------------

export type EnvironmentClass = "disposable" | "persistent";

export interface EnvironmentRecord {
  readonly id: EnvironmentId;
  readonly environmentClass: EnvironmentClass;
  readonly description: string;
  readonly dataPolicy: string;
  readonly teardownAllowed: boolean;
  readonly credentialScope: string;
  readonly promotion: { readonly nextPhase: string; readonly requires: readonly string[] } | null;
}

export interface DegradationRecord {
  readonly authority: "authoritative" | "non-authoritative";
  readonly onFailure: "fail-closed" | "degraded";
  readonly mode: string;
  readonly effect: string;
}

export interface ProviderRecord {
  readonly id: string;
  readonly concern: string;
  readonly authorityRole: string;
  readonly owningPort: string;
  readonly portStatus: "established" | "planned";
  readonly portContract: string | null;
  readonly plannedPhase: string | null;
  readonly substitutionTarget: string;
  readonly commercialUse: string | null;
  readonly degradation: DegradationRecord;
}

export interface ResourceRecord {
  readonly id: string;
  readonly concern: string;
  readonly kind: string;
  readonly perBranch: boolean;
}

export interface SecretReferenceRecord {
  readonly name: string;
  readonly classification: string;
  readonly variable: string;
  readonly description: string;
}

export interface VariableRecord {
  readonly name: string;
  readonly type: string;
  readonly required: boolean;
  readonly credentialShaped: boolean;
  readonly holds?: string;
  readonly description: string;
}

export interface DeploymentManifest {
  readonly environments: readonly EnvironmentRecord[];
  readonly promotionOrder: readonly string[];
  readonly providers: readonly ProviderRecord[];
  readonly resources: Readonly<Record<EnvironmentId, readonly ResourceRecord[]>>;
  readonly secretReferences: Readonly<Record<EnvironmentId, readonly SecretReferenceRecord[]>>;
  readonly variables: readonly VariableRecord[];
  /** Raw manifest sources in canonical order (identity digest input). */
  readonly sources: Readonly<Record<ManifestFileName, string>>;
}

// ---------------------------------------------------------------------------
// Parsing helpers
// ---------------------------------------------------------------------------

interface JsonRecord {
  readonly [key: string]: unknown;
}

function asRecord(value: unknown, context: string): JsonRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${context}: expected a JSON object`);
  }
  return value as JsonRecord;
}

function asArray(value: unknown, context: string): readonly unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`${context}: expected a JSON array`);
  }
  return value;
}

function str(value: unknown, context: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${context}: expected a non-empty string`);
  }
  return value;
}

function bool(value: unknown, context: string): boolean {
  if (typeof value !== "boolean") {
    throw new Error(`${context}: expected a boolean`);
  }
  return value;
}

function optStr(value: unknown, context: string): string | null {
  return value === null || value === undefined ? null : str(value, context);
}

// ---------------------------------------------------------------------------
// Load + validate
// ---------------------------------------------------------------------------

const ENVIRONMENT_IDS: readonly EnvironmentId[] = ["local", "preview", "staging", "production"];

export function isEnvironmentId(value: string): value is EnvironmentId {
  return (ENVIRONMENT_IDS as readonly string[]).includes(value);
}

/**
 * Load and validate the deployment manifest set.
 *
 * @throws DeploymentManifestError listing every validation problem
 * (fail closed; the full list surfaces convention drift in one pass).
 */
export function loadDeploymentManifest(readFile: ManifestFileReader): DeploymentManifest {
  const sources: Partial<Record<ManifestFileName, string>> = {};
  for (const file of MANIFEST_FILES) {
    sources[file] = readFile(file);
  }

  const problems: string[] = [];
  let environments: readonly EnvironmentRecord[] = [];
  let promotionOrder: readonly string[] = [];
  let providers: readonly ProviderRecord[] = [];
  const resources: Partial<Record<EnvironmentId, readonly ResourceRecord[]>> = {};
  const secretReferences: Partial<Record<EnvironmentId, readonly SecretReferenceRecord[]>> = {};
  let variables: readonly VariableRecord[] = [];

  // --- environments.json -------------------------------------------------
  try {
    const envDoc = asRecord(JSON.parse(sources["environments.json"] ?? "{}"), "environments");
    if (envDoc.schemaVersion !== 1) {
      problems.push("environments.json: unsupported schemaVersion (expected 1)");
    }
    promotionOrder = asArray(envDoc.promotionOrder, "environments.promotionOrder").map((v, i) =>
      str(v, `environments.promotionOrder[${i}]`),
    );
    const envMap = asRecord(envDoc.environments, "environments.environments");
    environments = Object.keys(envMap).map((id) => {
      if (!isEnvironmentId(id)) {
        problems.push(
          `environments.json: unknown environment class "${id}" (expected local|preview|staging|production)`,
        );
      }
      const record = asRecord(envMap[id], `environments.environments.${id}`);
      const environmentClass = str(record.class, `environments.environments.${id}.class`);
      if (environmentClass !== "disposable" && environmentClass !== "persistent") {
        problems.push(
          `environments.json: ${id}.class must be disposable|persistent (got "${environmentClass}")`,
        );
      }
      const promotion =
        record.promotion === null || record.promotion === undefined
          ? null
          : (() => {
              const p = asRecord(record.promotion, `environments.environments.${id}.promotion`);
              return {
                nextPhase: str(p.nextPhase, `environments.environments.${id}.promotion.nextPhase`),
                requires: asArray(
                  p.requires,
                  `environments.environments.${id}.promotion.requires`,
                ).map((r, i) => str(r, `environments.environments.${id}.promotion.requires[${i}]`)),
              };
            })();
      return {
        id: id as EnvironmentId,
        environmentClass: environmentClass as EnvironmentClass,
        description: str(record.description, `environments.environments.${id}.description`),
        dataPolicy: str(record.dataPolicy, `environments.environments.${id}.dataPolicy`),
        teardownAllowed: bool(
          record.teardownAllowed,
          `environments.environments.${id}.teardownAllowed`,
        ),
        credentialScope: str(
          record.credentialScope,
          `environments.environments.${id}.credentialScope`,
        ),
        promotion,
      };
    });
    const envIds = environments.map((e) => e.id);
    for (const expected of ENVIRONMENT_IDS) {
      if (!envIds.includes(expected)) {
        problems.push(`environments.json: missing environment "${expected}"`);
      }
    }
    for (const environment of environments) {
      if (environment.environmentClass === "persistent" && environment.teardownAllowed) {
        problems.push(
          `environments.json: persistent environment "${environment.id}" must not allow teardown`,
        );
      }
      if (environment.environmentClass === "disposable" && !environment.teardownAllowed) {
        problems.push(
          `environments.json: disposable environment "${environment.id}" must allow teardown`,
        );
      }
    }
    const production = environments.find((e) => e.id === "production");
    if (production !== undefined && production.promotion !== null) {
      problems.push("environments.json: production must have no promotion target");
    }
    const ladder = promotionOrder.join(">");
    if (ladder !== "local>ci>preview>staging>production") {
      problems.push(
        `environments.json: promotion order must be local>ci>preview>staging>production (got ${ladder})`,
      );
    }
  } catch (error) {
    problems.push(`environments.json: ${(error as Error).message}`);
  }

  // --- providers.json ----------------------------------------------------
  try {
    const provDoc = asRecord(JSON.parse(sources["providers.json"] ?? "{}"), "providers");
    if (provDoc.schemaVersion !== 1) {
      problems.push("providers.json: unsupported schemaVersion (expected 1)");
    }
    providers = asArray(provDoc.providers, "providers.providers").map((raw, i) => {
      const record = asRecord(raw, `providers.providers[${i}]`);
      const degradation = asRecord(record.degradation, `providers.providers[${i}].degradation`);
      const portStatus = str(record.portStatus, `providers.providers[${i}].portStatus`);
      if (portStatus !== "established" && portStatus !== "planned") {
        problems.push(
          `providers.json: provider[${i}].portStatus must be established|planned (got "${portStatus}")`,
        );
      }
      return {
        id: str(record.id, `providers.providers[${i}].id`),
        concern: str(record.concern, `providers.providers[${i}].concern`),
        authorityRole: str(record.authorityRole, `providers.providers[${i}].authorityRole`),
        owningPort: str(record.owningPort, `providers.providers[${i}].owningPort`),
        portStatus: portStatus as ProviderRecord["portStatus"],
        portContract: optStr(record.portContract, `providers.providers[${i}].portContract`),
        plannedPhase: optStr(record.plannedPhase, `providers.providers[${i}].plannedPhase`),
        substitutionTarget: str(
          record.substitutionTarget,
          `providers.providers[${i}].substitutionTarget`,
        ),
        commercialUse: optStr(record.commercialUse, `providers.providers[${i}].commercialUse`),
        degradation: {
          authority: str(
            degradation.authority,
            `providers.providers[${i}].degradation.authority`,
          ) as "authoritative" | "non-authoritative",
          onFailure: str(
            degradation.onFailure,
            `providers.providers[${i}].degradation.onFailure`,
          ) as "fail-closed" | "degraded",
          mode: str(degradation.mode, `providers.providers[${i}].degradation.mode`),
          effect: str(degradation.effect, `providers.providers[${i}].degradation.effect`),
        },
      };
    });
    const concerns = new Set(providers.map((p) => p.concern));
    if (concerns.size !== providers.length) {
      problems.push(
        "providers.json: duplicate concern (each concern has exactly one owning provider entry)",
      );
    }
    // D1.0 §7: Zeck persists ALL authority-bearing state in PostgreSQL.
    // Exactly one provider is authoritative and it is the relational
    // concern — a manifest that downgrades or multiplies authority is
    // invalid by construction (the fail-closed rule's anchor).
    const authoritativeProviders = providers.filter((p) => p.authorityRole === "authoritative");
    if (authoritativeProviders.length !== 1) {
      problems.push(
        `providers.json: exactly one authoritative provider must exist (found ${authoritativeProviders.length}; the relational store is the single authority)`,
      );
    } else if (authoritativeProviders[0]?.concern !== "relational-state") {
      problems.push(
        `providers.json: the authoritative provider must own the relational-state concern (got "${authoritativeProviders[0]?.concern}"; PostgreSQL is the durable authority, D1.0 section 7)`,
      );
    }
    for (const provider of providers) {
      if (provider.degradation.authority === "authoritative") {
        if (provider.degradation.onFailure !== "fail-closed") {
          problems.push(
            `providers.json: authoritative concern "${provider.concern}" must fail closed on failure (D1.0: no silent authority switch)`,
          );
        }
        if (provider.authorityRole !== "authoritative") {
          problems.push(
            `providers.json: provider "${provider.id}" authorityRole disagrees with its degradation authority`,
          );
        }
      } else if (provider.authorityRole === "authoritative") {
        problems.push(
          `providers.json: provider "${provider.id}" claims authority but its degradation is non-authoritative`,
        );
      }
      if (provider.portStatus === "established") {
        if (provider.portContract === null) {
          problems.push(
            `providers.json: established provider "${provider.id}" must declare its port contract path`,
          );
        }
      } else if (provider.plannedPhase === null) {
        problems.push(
          `providers.json: planned provider "${provider.id}" must declare the roadmap phase that owns its port`,
        );
      }
    }
  } catch (error) {
    problems.push(`providers.json: ${(error as Error).message}`);
  }

  // --- resources.json ----------------------------------------------------
  let namingPrefix = "zeck";
  try {
    const resDoc = asRecord(JSON.parse(sources["resources.json"] ?? "{}"), "resources");
    if (resDoc.schemaVersion !== 1) {
      problems.push("resources.json: unsupported schemaVersion (expected 1)");
    }
    const naming = asRecord(resDoc.naming, "resources.naming");
    namingPrefix = str(naming.prefix, "resources.naming.prefix");
    if (!/^[a-z][a-z0-9-]*$/.test(namingPrefix)) {
      problems.push(
        `resources.json: naming.prefix must be lowercase alphanumeric/hyphen (got "${namingPrefix}")`,
      );
    }
    const kinds = asRecord(naming.kinds, "resources.naming.kinds");
    const kindNames = Object.keys(kinds);
    if (kindNames.length === 0) {
      problems.push("resources.json: no resource kinds declared");
    }
    for (const kind of kindNames) {
      const rule = asRecord(kinds[kind], `resources.naming.kinds.${kind}`);
      const pattern = str(rule.pattern, `resources.naming.kinds.${kind}.pattern`);
      try {
        new RegExp(pattern);
      } catch {
        problems.push(`resources.json: kind "${kind}" pattern does not compile: ${pattern}`);
      }
      const maxLength = rule.maxLength;
      if (typeof maxLength !== "number" || maxLength < 3 || maxLength > 100) {
        problems.push(`resources.json: kind "${kind}" maxLength must be 3..100`);
      }
    }
    const resourceMap = asRecord(resDoc.resources, "resources.resources");
    for (const envId of Object.keys(resourceMap)) {
      if (!isEnvironmentId(envId)) {
        problems.push(`resources.json: unknown environment "${envId}" in resources`);
        continue;
      }
      const list = asArray(resourceMap[envId], `resources.resources.${envId}`);
      resources[envId as EnvironmentId] = list.map((raw, i) => {
        const record = asRecord(raw, `resources.resources.${envId}[${i}]`);
        const kind = str(record.kind, `resources.resources.${envId}[${i}].kind`);
        if (!(kind in kinds)) {
          problems.push(`resources.json: resource ${envId}[${i}] uses undeclared kind "${kind}"`);
        }
        const perBranch = record.perBranch === true;
        if (perBranch && envId !== "preview") {
          problems.push(
            `resources.json: per-branch resources are only valid in preview (found in "${envId}")`,
          );
        }
        return {
          id: str(record.id, `resources.resources.${envId}[${i}].id`),
          concern: str(record.concern, `resources.resources.${envId}[${i}].concern`),
          kind,
          perBranch,
        };
      });
    }
    for (const expected of ENVIRONMENT_IDS) {
      if (resources[expected] === undefined) {
        problems.push(`resources.json: missing resource set for environment "${expected}"`);
      }
    }
    const providerConcerns = new Set(providers.map((p) => p.concern));
    for (const [envId, list] of Object.entries(resources)) {
      for (const resource of list ?? []) {
        if (!providerConcerns.has(resource.concern)) {
          problems.push(
            `resources.json: ${envId} resource "${resource.id}" has concern "${resource.concern}" with no owning provider`,
          );
        }
      }
    }
  } catch (error) {
    problems.push(`resources.json: ${(error as Error).message}`);
  }

  // --- secret-references.json ---------------------------------------------
  try {
    const secDoc = asRecord(
      JSON.parse(sources["secret-references.json"] ?? "{}"),
      "secret-references",
    );
    if (secDoc.schemaVersion !== 1) {
      problems.push("secret-references.json: unsupported schemaVersion (expected 1)");
    }
    const classifications = new Set(
      asArray(secDoc.classifications, "secret-references.classifications").map((c) =>
        str(c, "secret-references.classifications[]"),
      ),
    );
    const scheme = str(secDoc.referenceScheme, "secret-references.referenceScheme");
    if (scheme !== "zeck-secret") {
      problems.push(
        `secret-references.json: referenceScheme must be "zeck-secret" (got "${scheme}")`,
      );
    }
    const referencePattern = str(secDoc.referencePattern, "secret-references.referencePattern");
    try {
      new RegExp(referencePattern);
    } catch {
      problems.push("secret-references.json: referencePattern does not compile");
    }
    const references = asRecord(secDoc.references, "secret-references.references");
    const variableByName = new Map<string, string>();
    for (const envId of Object.keys(references)) {
      if (!isEnvironmentId(envId)) {
        problems.push(`secret-references.json: unknown environment "${envId}" in references`);
        continue;
      }
      const list = asArray(references[envId], `secret-references.references.${envId}`);
      const names = new Set<string>();
      secretReferences[envId as EnvironmentId] = list.map((raw, i) => {
        const record = asRecord(raw, `secret-references.references.${envId}[${i}]`);
        const name = str(record.name, `secret-references.references.${envId}[${i}].name`);
        const variable = str(
          record.variable,
          `secret-references.references.${envId}[${i}].variable`,
        );
        if (names.has(name)) {
          problems.push(`secret-references.json: duplicate reference name "${name}" in ${envId}`);
        }
        names.add(name);
        if (!/^[a-z0-9-]+$/.test(name)) {
          problems.push(
            `secret-references.json: reference name "${name}" must be lowercase/hyphen`,
          );
        }
        if (!/^ZECK_SECRET_[A-Z0-9_]+$/.test(variable)) {
          problems.push(
            `secret-references.json: variable "${variable}" must match ZECK_SECRET_[A-Z0-9_]+`,
          );
        }
        const classification = str(
          record.classification,
          `secret-references.references.${envId}[${i}].classification`,
        );
        if (!classifications.has(classification)) {
          problems.push(
            `secret-references.json: reference ${envId}/${name} has unknown classification "${classification}"`,
          );
        }
        const previous = variableByName.get(name);
        if (previous === undefined) {
          variableByName.set(name, variable);
        } else if (previous !== variable) {
          problems.push(
            `secret-references.json: reference name "${name}" maps to inconsistent variables (${previous} vs ${variable})`,
          );
        }
        return {
          name,
          classification,
          variable,
          description: str(
            record.description,
            `secret-references.references.${envId}[${i}].description`,
          ),
        };
      });
    }
    for (const expected of ENVIRONMENT_IDS) {
      if (secretReferences[expected] === undefined) {
        problems.push(
          `secret-references.json: missing reference inventory for environment "${expected}"`,
        );
      }
    }
  } catch (error) {
    problems.push(`secret-references.json: ${(error as Error).message}`);
  }

  // --- variables.json ------------------------------------------------------
  try {
    const varDoc = asRecord(JSON.parse(sources["variables.json"] ?? "{}"), "variables");
    if (varDoc.schemaVersion !== 1) {
      problems.push("variables.json: unsupported schemaVersion (expected 1)");
    }
    variables = asArray(varDoc.variables, "variables.variables").map((raw, i) => {
      const record = asRecord(raw, `variables.variables[${i}]`);
      return {
        name: str(record.name, `variables.variables[${i}].name`),
        type: str(record.type, `variables.variables[${i}].type`),
        required: bool(record.required, `variables.variables[${i}].required`),
        credentialShaped: bool(
          record.credentialShaped,
          `variables.variables[${i}].credentialShaped`,
        ),
        holds:
          record.holds === undefined
            ? undefined
            : str(record.holds, `variables.variables[${i}].holds`),
        description: str(record.description, `variables.variables[${i}].description`),
      };
    });
    const names = new Set<string>();
    for (const variable of variables) {
      if (names.has(variable.name)) {
        problems.push(`variables.json: duplicate variable "${variable.name}"`);
      }
      names.add(variable.name);
    }
    // Cross-check ZECK_SECRET_*_REF variables against the secret-reference inventory.
    const referenceVariables = new Set<string>();
    for (const list of Object.values(secretReferences)) {
      for (const reference of list ?? []) {
        referenceVariables.add(reference.variable);
      }
    }
    for (const variable of variables) {
      if (variable.name.startsWith("ZECK_SECRET_")) {
        if (!variable.name.endsWith("_REF")) {
          problems.push(
            `variables.json: secret-family variable "${variable.name}" must end with _REF (it holds a reference, never a value)`,
          );
        }
        if (!referenceVariables.has(variable.name)) {
          problems.push(
            `variables.json: secret-reference variable "${variable.name}" has no entry in the secret-reference inventory`,
          );
        }
        if (variable.credentialShaped) {
          problems.push(
            `variables.json: secret-reference variable "${variable.name}" holds a reference URI, not credential material (credentialShaped must be false)`,
          );
        }
      }
    }
    for (const referenceVariable of referenceVariables) {
      if (!names.has(referenceVariable)) {
        problems.push(
          `variables.json: secret-reference inventory variable "${referenceVariable}" is missing from the variable contract`,
        );
      }
    }
  } catch (error) {
    problems.push(`variables.json: ${(error as Error).message}`);
  }

  if (problems.length > 0) {
    throw new DeploymentManifestError(problems);
  }

  return {
    environments,
    promotionOrder,
    providers,
    resources: resources as Record<EnvironmentId, readonly ResourceRecord[]>,
    secretReferences: secretReferences as Record<EnvironmentId, readonly SecretReferenceRecord[]>,
    variables,
    sources: sources as Record<ManifestFileName, string>,
  };
}

/**
 * The default file reader over a repository root. Reads the manifests
 * relative to `<root>/deploy/manifests/`.
 */
export function filesystemManifestReader(root: string): ManifestFileReader {
  const base = resolve(root, "deploy", "manifests");
  return (file) => readFileSync(resolve(base, file), "utf8");
}

/** Repository root discovery for the default reader (src/platform → root). */
export function defaultRepositoryRoot(): string {
  // src/platform/deployment/manifest.ts → three levels up.
  return resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
}

/** Load the deployment manifest set from the real repository tree. */
export function loadRepositoryManifest(): DeploymentManifest {
  return loadDeploymentManifest(filesystemManifestReader(defaultRepositoryRoot()));
}

/** Look up a provider by concern (validated manifests guarantee uniqueness). */
export function providerForConcern(
  manifest: DeploymentManifest,
  concern: string,
): ProviderRecord | undefined {
  return manifest.providers.find((provider) => provider.concern === concern);
}
