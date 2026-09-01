/**
 * Economics module application layer (WORK-032).
 *
 * The governed economic-action boundary service: the implementation
 * principle made executable (intent → policy → capability → budget →
 * authorization → rail → settlement → verification-evidence → learning
 * projection; NEVER `agent → rail API`).
 */

export { createEconomicActionService } from "./economic-action-service";
export type {
  AuthorizeEconomicActionCommand,
  AuthorizeEconomicActionOutcome,
  ChargeEconomicActionCommand,
  ChargeEconomicActionOutcome,
  CreateEconomicActionCommand,
  CreateEconomicActionOutcome,
  EconomicActionService,
  EconomicActionServiceDeps,
  EconomicCommandScope,
  EconomicDeliveryEvidenceBundle,
  EconomicExecutionLedger,
  RecordDeliveryObservationCommand,
  RecordDeliveryOutcome,
  RecordExternalSettlementCommand,
  RecordExternalSettlementOutcome,
} from "./economic-action-service.contracts";
