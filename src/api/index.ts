/**
 * `src/api/` barrel — the public API transport surface (WORK-015).
 */

export { mapErrorToResponse, PublicValidationError, sendPublicError } from "./error-mapper";
export type { Authenticate } from "./request-identity";
export { bearerTokenOf, resolveRequestIdentity } from "./request-identity";
export {
  scrubSecretShapedKeys,
  toWireAgentStatus,
  toWireAgentSummary,
  toWireAgentVersion,
  toWireEconomicAction,
  toWireEconomicActionEvent,
  toWireEconomicActionOutcome,
  toWireEconomicActionReceipt,
  toWireEvent,
  toWireExecution,
  toWirePromotion,
  toWireReceipt,
  toWireVerification,
} from "./serialization";
export type { ApiServer, ApiServerDeps } from "./server";
export { createApiServer, createBearerTokenAuthenticator } from "./server";
export type {
  WebhookDeliveryOptions,
  WebhookDeliveryResult,
  WebhookEndpoint,
  WebhookSigningSecret,
  WebhookTransport,
} from "./webhooks/delivery";
export {
  buildWebhookEvent,
  deliverWebhookEvent,
  signWebhookEvent,
  WEBHOOK_EVENT_ID_HEADER,
  WEBHOOK_SIGNATURE_HEADER,
} from "./webhooks/delivery";
