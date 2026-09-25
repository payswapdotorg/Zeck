/**
 * deploy/experience-routing — PPR-015's derived routing projection.
 *
 * THE AUTHORITY PROBLEM THIS MODULE SOLVES: vercel.json's rewrite list
 * is a static hosting artifact; the dashboard's route table
 * (`createDashboardRoutes`) is the experience route authority and the
 * bootstrap API route table (`buildBootstrapApp(...).server.routes`) is
 * the machine contract authority. A hand-duplicated rewrite list drifts
 * — the exact productization defect class PPR-015 corrects (visible
 * navigation routes falling through to the API plane). This module
 * DERIVES the public experience rewrite set from the two real route
 * tables so tests can pin vercel.json against them:
 *
 *  - every dashboard route whose path does NOT collide with a public
 *    API route path is a PUBLIC EXPERIENCE route — its first path
 *    segment MUST be rewritten to the experience function;
 *  - a dashboard route whose path collides with an API route path (any
 *    method — the platform's rewrites are method-agnostic, so the
 *    rewrite decision is per-path, never per-method) is API-OWNED on
 *    the public origin: it MUST NOT be rewritten (a rewrite would
 *    shadow the frozen public API contract — e.g. GET /agents, the
 *    architecture-pinned machine inventory);
 *  - a first-segment prefix whose dashboard routes are PART experience
 *    and PART api-owned is a MIXED prefix — structurally ambiguous and
 *    a projection failure (the caller refuses it, never guesses).
 *
 * The platform facts this projection respects (the live-proven
 * correction #8 record): the bare `/` is a FILESYSTEM match for the
 * framework build's root function — no rewrite can ever serve it, so
 * the root is excluded from the rewrite derivation entirely and lands
 * through vercel.json's `redirects` entry instead (PPR-015: `/` →
 * `/home`, the canonical Home experience).
 */

/** A route-table entry's method + path pattern (either plane's shape). */
export interface RoutePatternEntry {
  readonly method: string;
  readonly pattern: string;
}

/** Split a path pattern into its non-empty segments. */
export function segmentsOf(pattern: string): readonly string[] {
  return pattern.split("/").filter((segment) => segment.length > 0);
}

/**
 * The rewrite prefix a route owns publicly: its first path segment
 * (`/build/agents` → `/build`; `/command` → `/command`). The root `/`
 * has no first segment — it is the redirect bridge, never a rewrite.
 */
export function prefixOf(pattern: string): string | null {
  const first = segmentsOf(pattern)[0];
  return first === undefined ? null : `/${first}`;
}

/**
 * Do two path patterns address the same path space? A `:param` segment
 * matches any concrete segment (the two planes use different parameter
 * names for the same coordinates — `/executions/:id` and
 * `/executions/:executionId` collide).
 */
export function patternsCollide(a: string, b: string): boolean {
  const left = segmentsOf(a);
  const right = segmentsOf(b);
  if (left.length !== right.length) {
    return false;
  }
  for (let index = 0; index < left.length; index += 1) {
    const l = left[index] ?? "";
    const r = right[index] ?? "";
    if (l === r) {
      continue;
    }
    if (l.startsWith(":") || r.startsWith(":")) {
      continue;
    }
    return false;
  }
  return true;
}

/** True when a dashboard route pattern collides with ANY public API route path. */
export function isApiOwned(dashboardPattern: string, apiPatterns: readonly string[]): boolean {
  return apiPatterns.some((apiPattern) => patternsCollide(dashboardPattern, apiPattern));
}

/** The derived public routing projection over the two route tables. */
export interface RoutingProjection {
  /** First-segment prefixes whose dashboard routes are ALL experience routes (MUST be rewritten). */
  readonly experiencePrefixes: readonly string[];
  /** First-segment prefixes whose dashboard routes are ALL api-owned (MUST NOT be rewritten). */
  readonly apiOwnedPrefixes: readonly string[];
  /** Structurally ambiguous prefixes — a projection failure when non-empty. */
  readonly mixedPrefixes: readonly string[];
  /** The dashboard route patterns that are api-owned (each collides with an API route path). */
  readonly apiOwnedPatterns: readonly string[];
}

/**
 * Derive the public routing projection: group the dashboard route
 * patterns by first segment and classify each group against the public
 * API route table. Pure and total — no filesystem, no environment.
 */
export function deriveRoutingProjection(
  dashboardRoutes: readonly RoutePatternEntry[],
  apiRoutes: readonly RoutePatternEntry[],
): RoutingProjection {
  const apiPatterns = apiRoutes.map((route) => route.pattern);
  const experience = new Set<string>();
  const apiOwned = new Set<string>();
  const mixed = new Set<string>();
  const apiOwnedPatterns = new Set<string>();
  for (const route of dashboardRoutes) {
    const prefix = prefixOf(route.pattern);
    if (prefix === null) {
      // The root bridge — excluded by construction (redirects, never
      // rewrites).
      continue;
    }
    if (isApiOwned(route.pattern, apiPatterns)) {
      apiOwnedPatterns.add(route.pattern);
      if (experience.has(prefix) && !mixed.has(prefix)) {
        mixed.add(prefix);
      }
      apiOwned.add(prefix);
      continue;
    }
    if (apiOwned.has(prefix) && !mixed.has(prefix)) {
      mixed.add(prefix);
    }
    experience.add(prefix);
  }
  for (const prefix of mixed) {
    experience.delete(prefix);
    apiOwned.delete(prefix);
  }
  return {
    experiencePrefixes: [...experience].sort(),
    apiOwnedPrefixes: [...apiOwned].sort(),
    mixedPrefixes: [...mixed].sort(),
    apiOwnedPatterns: [...apiOwnedPatterns].sort(),
  };
}

// ---------------------------------------------------------------------------
// The vercel.json grammar (the static artifact the projection pins)
// ---------------------------------------------------------------------------

export interface VercelRouting {
  readonly redirects: readonly {
    readonly source: string;
    readonly destination: string;
    readonly permanent: boolean;
  }[];
  readonly rewrites: readonly { readonly source: string; readonly destination: string }[];
}

/**
 * The vercel.json source grammar this repository uses (the documented
 * path-to-regexp shapes): an exact source matches itself; a
 * `/:path*`-suffixed source matches the bare base and every deeper
 * path. Mirrors the live-proven platform semantics the routing split
 * has depended on since PPR-007.
 */
export function matchesSource(source: string, pathname: string): boolean {
  if (source.endsWith("/:path*")) {
    const base = source.slice(0, -":path*".length);
    return pathname === base.slice(0, -1) || pathname.startsWith(base);
  }
  return pathname === source;
}

/**
 * Apply vercel.json's routing grammar to one request path — the local
 * model of the platform's routing phases, in the live-proven order:
 *
 *  1. REDIRECTS run before the filesystem phase (correction #8's
 *     platform fact) — a matching source answers its destination as a
 *     temporary redirect;
 *  2. the framework build's root function is a FILESYSTEM match for
 *     the bare `/` — no rewrite can serve it (the dead root rewrite
 *     finding);
 *  3. REWRITES match every other path — the first matching source's
 *     destination wins, with the source's `:path*` capture substituted
 *     into the destination (the platform's documented capture-to-query
 *     conversion);
 *  4. everything else falls through to the API function (the framework
 *     build's root function is the platform's catch-all).
 */
export type GatewayDecision =
  | { readonly kind: "redirect"; readonly location: string }
  | { readonly kind: "experience"; readonly destination: string }
  | { readonly kind: "api" };

/** Resolve one request path against the vercel.json routing grammar. */
export function resolveGatewayRoute(
  routing: VercelRouting,
  method: string,
  pathname: string,
): GatewayDecision {
  void method; // The platform's rewrites/redirects are method-agnostic.
  for (const redirect of routing.redirects) {
    if (matchesSource(redirect.source, pathname)) {
      return { kind: "redirect", location: redirect.destination };
    }
  }
  if (pathname === "/") {
    // The filesystem root match: the framework root function owns the
    // bare "/" (the platform fact correction #8 proved live).
    return { kind: "api" };
  }
  for (const rewrite of routing.rewrites) {
    if (matchesSource(rewrite.source, pathname)) {
      return { kind: "experience", destination: substituteDestination(rewrite, pathname) };
    }
  }
  return { kind: "api" };
}

/** Substitute the matched `:path*` capture into a rewrite destination. */
function substituteDestination(
  rewrite: { readonly source: string; readonly destination: string },
  pathname: string,
): string {
  if (!rewrite.source.endsWith("/:path*")) {
    return rewrite.destination;
  }
  const base = rewrite.source.slice(0, -":path*".length - 1);
  const captured = pathname === base ? "" : pathname.slice(base.length + 1);
  return rewrite.destination.replaceAll(":path*", captured);
}
