/**
 * `deployments` application layer — use cases and orchestration local
 * to this module (WORK-023, WORK-024, WORK-025, WORK-026).
 *
 * Application code reaches outward only through this module's ports;
 * it never imports adapters or `src/platform/**` directly
 * (`IMPLEMENTATION.md` §3).
 */

export {
  createDeploymentService,
  type DeploymentActor,
  type DeploymentService,
  type DeploymentServiceDeps,
} from "./deployment-service";
export {
  createMediaGenerationService,
  type MediaActor,
  type MediaDeploymentFacts,
  type MediaGenerationService,
  type MediaGenerationServiceDeps,
  type MediaJobCancelOutcome,
  type MediaObservationApplyOutcome,
  type MediaVariantOutcome,
  type RetryMediaJobInput,
  type SubmitMediaJobOutcome,
} from "./media-generation-service";
export {
  createMessagingConversationService,
  type MessagingActor,
  type MessagingConversationService,
  type MessagingConversationServiceDeps,
  type MessagingDeliveryApplyOutcome,
  type MessagingDeploymentFacts,
  type MessagingEscalationOutcome,
  type MessagingIngestOutcome,
  type StartMessagingConversationOutcome,
} from "./messaging-conversation-service";
export {
  createRealtimeSessionService,
  type RealtimeActor,
  type RealtimeDeploymentFacts,
  type RealtimeIngestOutcome,
  type RealtimeSessionService,
  type RealtimeSessionServiceDeps,
  type StartRealtimeSessionOutcome,
} from "./realtime-session-service";
