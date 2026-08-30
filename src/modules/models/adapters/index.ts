/**
 * `models` adapters layer — infrastructure and provider implementations for this module.

The only module layer allowed to import `src/platform/**` and to contain
provider-specific code, each confined to its owning adapter file
(`IMPLEMENTATION.md` §1, §3; architecture-lock invariant 2).
 */

export {
  ANTHROPIC_API_VERSION,
  ANTHROPIC_DEFAULT_ENDPOINT,
  type AnthropicAdapterOptions,
  createAnthropicAdapter,
} from "./anthropic";
export { createFetchTransport } from "./fetch-transport";
export {
  createOpenRouterAdapter,
  OPENROUTER_DEFAULT_ENDPOINT,
  type OpenRouterAdapterOptions,
} from "./openrouter";
export { createSqlDispatchJournal, SqlDispatchJournal } from "./sql-dispatch-journal";
export { parseSseStream, type SseEvent } from "./sse";
