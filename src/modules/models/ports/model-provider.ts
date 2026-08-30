/**
 * ModelProvider port (models module outbound, CON-001).
 *
 * The ONE contract every provider rail implements — the aggregation rail
 * (CON-003) and direct provider adapters (CON-004) behind the identical
 * surface. Adapters normalize usage, streaming, structured output and
 * provider errors into the neutral domain contracts; no provider SDK type
 * crosses this port (`spec/architecture.md` §2.3, architecture-lock
 * invariant 2).
 */

import type { ModelCallOutcome } from "../domain/outcome";
import type { ModelRequest } from "../domain/request";
import type { StreamEvent } from "../domain/stream";

/**
 * Credentials and routing the adapter needs for one dispatch. Plaintext
 * material is present ONLY here — produced by the authorized
 * materialization step immediately before the adapter call
 * (`IMPLEMENTATION.md` §7, §9) and never persisted, logged or returned.
 */
export interface ProviderDispatchContext {
  /** Base URL override from the connection (customer endpoints, gateways). */
  readonly endpointUrl: string | null;
  /**
   * Materialized credential, or null when the connection carries no
   * per-connection material (platform-credential connections rely on the
   * adapter's composed platform credential).
   */
  readonly credential: string | null;
  readonly timeoutMs: number;
}

export interface ModelProvider {
  /** The rail slug this adapter serves (matches `connections.PROVIDER_RAILS`). */
  readonly rail: string;
  /** One-shot completion; the normalized outcome (never a thrown provider error). */
  complete(request: ModelRequest, context: ProviderDispatchContext): Promise<ModelCallOutcome>;
  /** Streaming completion; failures surface as terminal `stream-error` events. */
  stream(request: ModelRequest, context: ProviderDispatchContext): AsyncIterable<StreamEvent>;
}

/** Registry of rails available to a gateway instance (composition-owned). */
export interface RailRegistry {
  readonly rails: readonly string[];
  providerFor(rail: string): ModelProvider | null;
}
