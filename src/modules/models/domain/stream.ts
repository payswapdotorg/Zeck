/**
 * Provider-neutral streaming events (models module domain).
 *
 * `spec/architecture.md` §12 / acceptance criterion 4: adapters normalize
 * provider streaming into this event vocabulary regardless of the upstream
 * chunk format (SSE or otherwise). Errors mid-stream arrive as a terminal
 * `stream-error` event carrying the same normalized `ProviderFailure` used
 * by non-streaming dispatch — one failure taxonomy everywhere.
 */

import type { ProviderFailure } from "./provider-failure";
import type { StopReason } from "./request";
import type { NormalizedUsage } from "./response";

export type StreamEvent =
  | { readonly type: "text-delta"; readonly text: string }
  | { readonly type: "structured-delta"; readonly jsonFragment: string }
  | { readonly type: "usage"; readonly usage: NormalizedUsage }
  | {
      readonly type: "stream-done";
      readonly stopReason: StopReason;
      readonly usage: NormalizedUsage;
    }
  | { readonly type: "stream-error"; readonly failure: ProviderFailure };
