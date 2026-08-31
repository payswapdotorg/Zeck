/**
 * `learning` ports layer (WORK-014) — outbound interfaces owned by this
 * module: the durable learning store, the digest seam.
 *
 * Ports are provider-neutral: no infrastructure clients, no provider
 * SDKs, no policy/budget/capability/execution seams (the shadow
 * evaluator and the learning service have NO authority deps by
 * construction).
 */

export type { DigestPort } from "./digest";
export type {
  LearningStore,
  RatingIngestionOutcome,
  ScorecardScope,
  TelemetryIngestionOutcome,
  TelemetryQuery,
} from "./learning-store";
