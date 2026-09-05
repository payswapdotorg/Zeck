/**
 * Deterministic resource naming (Deployment Roadmap D-01; Work Order
 * WORK-042).
 *
 * THE SINGLE NAMING AUTHORITY: resource names are never stored in
 * manifests, provider consoles or ad-hoc scripts — they are computed
 * here from (environment, kind, preview branch identity). Two fresh
 * checkouts at the same revision compute byte-identical resource names;
 * a name that cannot be produced by this module is not a Zeck resource
 * name.
 *
 * Provider constraints (bucket/project/queue naming rules, maximum
 * lengths, charset legality) are validated at computation time, so a
 * convention drift fails closed instead of surfacing as a provider
 * error.
 *
 * Naming is provider-NEUTRAL by construction: this module knows kinds
 * and constraints, not vendor SDKs (D1.0 §19 — substitution changes
 * adapters and configuration, never domain semantics).
 */

export type EnvironmentId = "local" | "preview" | "staging" | "production";

/** Resource kind naming rules (mirrors deploy/manifests/resources.json). */
export interface KindNamingRule {
  readonly suffix: string | null;
  readonly maxLength: number;
  readonly pattern: string;
}

/** Parsed naming conventions from the resources manifest. */
export interface NamingConventions {
  readonly prefix: string;
  readonly previewBranchSlugMaxLength: number;
  readonly kinds: Readonly<Record<string, KindNamingRule>>;
}

export interface ComputedResourceName {
  readonly environment: EnvironmentId;
  readonly kind: string;
  readonly id?: string;
  /**
   * The deterministic provider-facing resource name. Computed, never
   * stored (see module docs).
   */
  readonly name: string;
  /** Environment ownership labels applied where the provider supports tags. */
  readonly labels: Readonly<Record<string, string>>;
}

/** Sanitize a branch name into a preview slug (deterministic). */
export function previewBranchSlug(branch: string, maxLength: number): string {
  const collapsed = branch
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return collapsed.slice(0, maxLength).replace(/-+$/g, "");
}

/**
 * Compute the deterministic name for a resource.
 *
 * - Cloud kinds: `{prefix}-{environment}[-{previewSlug}][-{suffix}]`
 * - `pg-database` (local): `{prefix}_{environment}` (SQL-friendly)
 *
 * @throws Error when the kind is unknown, the environment is not a
 * preview environment for a per-branch resource, or the computed name
 * violates the kind's constraint pattern/length (fail closed).
 */
export function computeResourceName(
  conventions: NamingConventions,
  environment: EnvironmentId,
  kind: string,
  previewSlug?: string,
): string {
  const rule = conventions.kinds[kind];
  if (rule === undefined) {
    throw new Error(`unknown resource kind: ${kind}`);
  }
  if (previewSlug !== undefined && environment !== "preview") {
    throw new Error(
      `preview branch identity is only valid for the preview environment (got: ${environment})`,
    );
  }
  let name: string;
  if (kind === "pg-database") {
    name = `${conventions.prefix}_${environment}`;
  } else {
    const segments = [conventions.prefix, environment];
    if (previewSlug !== undefined && previewSlug.length > 0) {
      segments.push(previewSlug);
    }
    if (rule.suffix !== null) {
      segments.push(rule.suffix);
    }
    name = segments.join("-");
  }
  validateResourceName(rule, kind, name);
  return name;
}

/** Environment-ownership labels (applied where providers support tags). */
export function computeLabels(environment: EnvironmentId): Record<string, string> {
  return {
    "zeck.io/environment": environment,
    "zeck.io/managed-by": "zeck-deploy",
  };
}

/**
 * Compute the full resource set for an environment, in the manifest's
 * declaration order (deterministic output order).
 */
export function computeResourceNames(
  conventions: NamingConventions,
  environment: EnvironmentId,
  resources: readonly {
    readonly id: string;
    readonly kind: string;
    readonly perBranch?: boolean;
  }[],
  previewSlug?: string,
): readonly ComputedResourceName[] {
  return resources.map((resource) => {
    const slug = environment === "preview" && resource.perBranch === true ? previewSlug : undefined;
    return {
      environment,
      kind: resource.kind,
      id: resource.id,
      name: computeResourceName(conventions, environment, resource.kind, slug),
      labels: computeLabels(environment),
    };
  });
}

/** Validate a computed name against its kind constraints (fail closed). */
export function validateResourceName(rule: KindNamingRule, kind: string, name: string): void {
  if (name.length > rule.maxLength) {
    throw new Error(
      `computed name for kind ${kind} exceeds the provider constraint: "${name}" (${name.length} > ${rule.maxLength})`,
    );
  }
  const pattern = new RegExp(rule.pattern);
  if (!pattern.test(name)) {
    throw new Error(
      `computed name for kind ${kind} violates the provider charset constraint: "${name}" (${rule.pattern})`,
    );
  }
}

/** Check whether a preview slug is required by the resource set. */
export function requiresPreviewSlug(
  resources: readonly { readonly perBranch?: boolean }[],
): boolean {
  return resources.some((resource) => resource.perBranch === true);
}
