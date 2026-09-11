/**
 * Validation surface-ownership governance (VAL-001, acceptance criterion 6).
 *
 * Governance must reject simultaneous ownership of the same protected
 * validation surface where reconciliation is non-mechanical: two work
 * orders that are in flight at the same time may only overlap on
 * surfaces their specs declare mechanically reconcilable (additive new
 * files in disjoint directories). This module parses the Allowed-surfaces
 * blocks of validation work-order specs mechanically and computes the
 * conflict verdict. Pure functions over spec text — no file access, no
 * mutation.
 */

/** One declared allowed surface of a validation work order spec. */
export interface WorkOrderSurfaces {
  readonly workOrder: string;
  /** Surface paths exactly as declared in the spec's Allowed surfaces block. */
  readonly surfaces: readonly string[];
}

/** One surface-ownership conflict between in-flight work orders. */
export interface SurfaceConflict {
  readonly kind: "surface-overlap" | "overlapping-prefix";
  readonly workOrders: readonly string[];
  readonly surface: string;
  readonly reason: string;
}

/**
 * Parse the Allowed-surfaces block of a validation work-order spec.
 *
 * The spec format (see `spec/validation-work-orders/VAL-001.md`):
 *
 * ```markdown
 * ## Allowed surfaces
 *
 * - `spec/validation-state/**`
 * - `benchmarks/validation/**`
 * ```
 *
 * Parsing is strictly mechanical: only backticked bullets under the exact
 * "Allowed surfaces" heading are surfaces; anything else is ignored.
 */
export function parseAllowedSurfaces(spec: {
  readonly workOrder: string;
  readonly text: string;
}): WorkOrderSurfaces {
  const lines = spec.text.split("\n");
  const surfaces: string[] = [];
  let inSection = false;
  for (const line of lines) {
    if (/^##\s+Allowed surfaces\s*$/.test(line.trim())) {
      inSection = true;
      continue;
    }
    if (inSection && /^##\s+/.test(line.trim())) {
      inSection = false;
      continue;
    }
    if (!inSection) {
      continue;
    }
    const match = /^-\s+`([^`]+)`/.exec(line.trim());
    if (match !== null && match[1] !== undefined) {
      surfaces.push(match[1]);
    }
  }
  return { workOrder: spec.workOrder, surfaces };
}

/**
 * Compute surface-ownership conflicts for a set of in-flight work orders.
 *
 * A conflict exists when two in-flight work orders declare the same
 * surface path, or when one declares a wildcard prefix (`**`) that covers
 * a surface (or prefix) the other also declares. Additive new
 * directories under a shared wildcard are NOT conflicts when the specs
 * declare disjoint concrete subpaths — the wildcard itself is the
 * reconcilable-additive case and is excluded by prefix-collapse below:
 * two `**` wildcards only conflict when one's directory prefix contains
 * the other's declared non-wildcard surface.
 */
export function surfaceOwnershipConflicts(
  inFlight: readonly WorkOrderSurfaces[],
): readonly SurfaceConflict[] {
  const conflicts: SurfaceConflict[] = [];
  for (let i = 0; i < inFlight.length; i += 1) {
    for (let j = i + 1; j < inFlight.length; j += 1) {
      const left = inFlight[i] ?? { workOrder: "?", surfaces: [] };
      const right = inFlight[j] ?? { workOrder: "?", surfaces: [] };
      for (const leftSurface of left.surfaces) {
        for (const rightSurface of right.surfaces) {
          const exact = leftSurface === rightSurface;
          const prefix =
            coversPrefix(leftSurface, rightSurface) || coversPrefix(rightSurface, leftSurface);
          if (exact) {
            conflicts.push({
              kind: "surface-overlap",
              workOrders: [left.workOrder, right.workOrder],
              surface: leftSurface,
              reason: "two in-flight work orders declare the exact same protected surface",
            });
          } else if (prefix) {
            conflicts.push({
              kind: "overlapping-prefix",
              workOrders: [left.workOrder, right.workOrder],
              surface: `${leftSurface} ~ ${rightSurface}`,
              reason:
                "one in-flight work order's surface prefix covers the other's protected surface",
            });
          }
        }
      }
    }
  }
  return conflicts;
}

/** Does `a` (possibly a `**` wildcard) cover the concrete surface `b`? */
function coversPrefix(a: string, b: string): boolean {
  if (!isWildcard(a)) {
    return false;
  }
  const dir = a.slice(0, -3);
  return b !== a && (b === dir || b.startsWith(`${dir}/`));
}

function isWildcard(surface: string): boolean {
  return surface.endsWith("/**");
}
