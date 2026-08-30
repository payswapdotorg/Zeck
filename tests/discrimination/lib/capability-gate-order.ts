/**
 * Shared capability-before-route order scanner (WORK-005).
 *
 * One definition of the INT-002 ordering boundary, two uses — the
 * architecture gate over the REAL gateway source, and the discrimination
 * proofs over synthetic bypass mutations — so a weakened protection is
 * provably rejected (same pattern as `provider-neutrality.ts`).
 *
 * The boundary under protection: inside EVERY dispatch method of the model
 * gateway (`complete` / `stream`), each `rails.providerFor(` route
 * resolution must be preceded — within the SAME method body — by a
 * capability resolution consultation (`resolveCapabilities(` or a direct
 * `capabilities.resolve(`), and an unsatisfied resolution must surface the
 * canonical `CAPABILITY_UNAVAILABLE` failure. Method-scoped checking is
 * what makes the scanner discriminate real reorderings: a gate call that
 * merely exists elsewhere in the file (or in a helper defined above) does
 * not authorize a route-first dispatch method.
 */

const RAIL_CALL = "deps.rails.providerFor(";
const GATE_CALLS = ["resolveCapabilities(", "deps.capabilities.resolve("] as const;
const METHOD_BOUNDARIES = ["async complete(", "async stream("] as const;

export function capabilityGateOrderViolations(source: string): string[] {
  const violations: string[] = [];

  const hasGateCall = GATE_CALLS.some((marker) => source.includes(marker));
  if (!hasGateCall) {
    violations.push("missing-capability-resolution-call");
  }

  let railIndex = source.indexOf(RAIL_CALL);
  if (railIndex === -1) {
    // Scanner sanity: the dispatch surface under protection must exist.
    violations.push("no-rail-resolution-found");
  }
  while (railIndex !== -1) {
    const boundary = Math.max(
      ...METHOD_BOUNDARIES.map((marker) => source.lastIndexOf(marker, railIndex)),
    );
    const segment = boundary >= 0 ? source.slice(boundary, railIndex) : source.slice(0, railIndex);
    const preceded = GATE_CALLS.some((marker) => segment.includes(marker));
    if (!preceded) {
      violations.push("rail-resolution-before-capability-resolution");
    }
    railIndex = source.indexOf(RAIL_CALL, railIndex + 1);
  }

  if (!source.includes("CAPABILITY_UNAVAILABLE")) {
    violations.push("missing-canonical-capability-unavailable-failure");
  }
  return violations;
}
