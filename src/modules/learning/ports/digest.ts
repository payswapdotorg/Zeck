/**
 * Digest port (learning module outbound; WORK-014).
 *
 * Server-derived content addressing for telemetry fingerprints, scorecard
 * digests and strategy description digests (sha256, lowercase hex).
 * Adapters own crypto — the node digest adapter is the single file in
 * this module that touches the crypto module (the WORK-008/WORK-009
 * confinement precedent).
 */

export interface DigestPort {
  sha256Hex(value: string): string;
}
