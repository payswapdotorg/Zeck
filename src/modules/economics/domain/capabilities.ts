/**
 * Economic capability requirements (economics module domain; WORK-032,
 * ECO-001 "required capabilities").
 *
 * A minimal, provider-neutral requirement shape MIRRORED from the
 * capabilities module's public `CapabilityRequirement` vocabulary (kind +
 * name + optional minimum version). The economics module does NOT resolve
 * capabilities itself: the REQUIRED `EconomicCapabilityAdmissionPort`
 * (ports/capability-admission.ts) delegates resolution to the capabilities
 * module's registry authority — the same one-claim-authority pattern the
 * planning module uses. This file only carries the neutral requirement
 * shape so the EconomicAction contract is self-contained.
 */

export const ECONOMIC_CAPABILITY_KINDS = [
  "model",
  "tool",
  "algorithm",
  "data",
  "runtime",
  "human",
] as const;

export type EconomicCapabilityKind = (typeof ECONOMIC_CAPABILITY_KINDS)[number];

export function isEconomicCapabilityKind(value: string): value is EconomicCapabilityKind {
  return (ECONOMIC_CAPABILITY_KINDS as readonly string[]).includes(value);
}

/** A required capability, expressed in the neutral platform vocabulary. */
export interface EconomicCapabilityRequirement {
  readonly kind: EconomicCapabilityKind;
  readonly name: string;
  readonly minVersion?: string;
}

/**
 * Deterministic requirement equality (fingerprint + substitution use):
 * two requirements are the same iff kind, name and minVersion match.
 */
export function sameEconomicCapabilityRequirement(
  a: EconomicCapabilityRequirement,
  b: EconomicCapabilityRequirement,
): boolean {
  return a.kind === b.kind && a.name === b.name && (a.minVersion ?? "") === (b.minVersion ?? "");
}
