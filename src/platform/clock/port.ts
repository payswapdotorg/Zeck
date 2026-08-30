/**
 * Clock port — injectable time.
 *
 * Domain code never reads ambient system time directly: time flows through
 * module ports satisfied by adapters that delegate to this port. Timestamps
 * persisted in event envelopes use the RFC3339 UTC form
 * (`spec/contracts.md` — `EventEnvelope.occurredAt`).
 */
export interface ClockPort {
  now(): Date;

  /** RFC3339 UTC timestamp string. */
  nowIso(): string;
}
