/**
 * `models` domain layer — entities, invariants and value objects of this module.

Domain code may import this module's own layers, `src/shared/**` and other
modules' `public.ts` — never `src/platform/**`, adapters, provider SDKs or
HTTP libraries (`IMPLEMENTATION.md` §3).
 */

export type { DispatchStatus, ModelCallOutcome, ProviderAxisOutcomeClass } from "./outcome";
export { DISPATCH_STATUSES, PROVIDER_AXIS_OUTCOME_CLASSES } from "./outcome";
export type { ProviderErrorCategory, ProviderFailure } from "./provider-failure";
export {
  isProviderFailure,
  isRetryableCategory,
  PROVIDER_ERROR_CATEGORIES,
  toPlatformProviderError,
} from "./provider-failure";
export type { ModelMessage, ModelRequest, StopReason, StructuredOutputSpec } from "./request";
export { STOP_REASONS } from "./request";
export type { ModelResponse, NormalizedStructuredOutput, NormalizedUsage } from "./response";
export { EMPTY_USAGE } from "./response";
export type { StreamEvent } from "./stream";
