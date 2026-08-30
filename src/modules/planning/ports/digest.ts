/**
 * Digest port (planning module outbound; WORK-009).
 *
 * Server-derived content addressing for plans and decision records
 * (sha256, lowercase hex). Adapters own crypto: the node digest adapter
 * is the single file that touches the crypto module (the WORK-008
 * confinement precedent).
 */

export interface DigestPort {
  sha256Hex(value: string): string;
}
