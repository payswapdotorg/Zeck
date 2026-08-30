/**
 * `models` ports layer — outbound/inbound interfaces owned by this module.

Ports are provider-neutral: no infrastructure clients, no provider SDKs.
Adapters (in `adapters/`) implement them (`IMPLEMENTATION.md` §2–§3).
 */
export type { AdmissionDecision, AdmissionInput, DispatchAdmission } from "./dispatch-admission";
export type {
  DispatchIntentInput,
  DispatchJournal,
  JournalAttempt,
} from "./dispatch-journal";
export type { HttpRequestBody, HttpResponse, HttpTransport } from "./http-transport";
export type { ModelProvider, ProviderDispatchContext, RailRegistry } from "./model-provider";
