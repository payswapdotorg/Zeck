/**
 * Public contract barrel of the `models` module.
 *
 * This file is the ONLY supported import surface for other modules and for
 * the API layer (`IMPLEMENTATION.md` §2, `spec/contracts.md` "Public
 * module rule"). Everything else under `src/modules/models/` is private to
 * this module.
 *
 * WORK-003 introduces the provider fabric that sits UNDERNEATH Execution:
 * neutral model request/response/streaming/usage contracts, the normalized
 * provider-failure taxonomy (durably distinct from quality/verification
 * failure — CON-005), the `ModelProvider` port every rail implements, the
 * admission gate that enforces policy-before-dispatch, the dispatch journal
 * and the gateway. Provider adapters are NOT re-exported here: the public
 * surface is provider-neutral by construction (no rail may become a public
 * abstraction — `spec/architecture.md` §2.3, §12); composition roots wire
 * adapters into the registry at assembly time.
 */

import type { ModuleDescriptor } from "../../shared/module";
import type { TaskCapabilityProfile } from "../capabilities/public";
import { createCapabilityGate } from "./application/capability-gate";
import {
  createModelGateway,
  type ModelDispatchResult,
  type ModelGateway,
  type ModelGatewayDeps,
} from "./application/model-gateway";
import { createRailRegistry } from "./application/rail-registry";
import type { DispatchStatus, ModelCallOutcome, ProviderAxisOutcomeClass } from "./domain/outcome";
import type { ProviderErrorCategory, ProviderFailure } from "./domain/provider-failure";
import { PROVIDER_ERROR_CATEGORIES, toPlatformProviderError } from "./domain/provider-failure";
import type {
  ModelMessage,
  ModelRequest,
  StopReason,
  StructuredOutputSpec,
} from "./domain/request";
import { STOP_REASONS } from "./domain/request";
import type { ModelResponse, NormalizedStructuredOutput, NormalizedUsage } from "./domain/response";
import type { StreamEvent } from "./domain/stream";
import type { TaskCapabilityResolution } from "./ports/capability-gate";
import type {
  AdmissionDecision,
  AdmissionInput,
  DispatchAdmission,
} from "./ports/dispatch-admission";
import type {
  DispatchIntentInput,
  DispatchJournal,
  JournalAttempt,
} from "./ports/dispatch-journal";
import type { HttpRequestBody, HttpResponse, HttpTransport } from "./ports/http-transport";
import type { ModelProvider, ProviderDispatchContext, RailRegistry } from "./ports/model-provider";

export const moduleDescriptor: ModuleDescriptor = { id: "models" };

export { PROVIDER_AXIS_OUTCOME_CLASSES } from "./domain/outcome";
// Neutral request/response contracts (CON-001 / CON-004).
// Provider-failure taxonomy — durable distinct from quality failure (CON-005).
// Streaming normalization (acceptance criterion 4).
// Module ports.
// Application services.
// Capability-before-provider gate (WORK-005 / INT-002): the gateway's
// required capability authority port and its registry-backed wiring.
export type {
  AdmissionDecision,
  AdmissionInput,
  DispatchAdmission,
  DispatchIntentInput,
  DispatchJournal,
  DispatchStatus,
  HttpRequestBody,
  HttpResponse,
  HttpTransport,
  JournalAttempt,
  ModelCallOutcome,
  ModelDispatchResult,
  ModelGateway,
  ModelGatewayDeps,
  ModelMessage,
  ModelProvider,
  ModelRequest,
  ModelResponse,
  NormalizedStructuredOutput,
  NormalizedUsage,
  ProviderAxisOutcomeClass,
  ProviderDispatchContext,
  ProviderErrorCategory,
  ProviderFailure,
  RailRegistry,
  StopReason,
  StreamEvent,
  StructuredOutputSpec,
  TaskCapabilityProfile,
  TaskCapabilityResolution,
};
export {
  createCapabilityGate,
  createModelGateway,
  createRailRegistry,
  PROVIDER_ERROR_CATEGORIES,
  STOP_REASONS,
  toPlatformProviderError,
};
