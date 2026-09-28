/**
 * The Demo Mirror run-executor port (PPR-018A scope items 7/8; ACR-006
 * §5 + ACR-007 §9 "Demonstration requirement").
 *
 * A certified demo entry runs the EXACT pinned application integration
 * — never a synthetic response, never a toy generator. This port is
 * the WEBSITE-SIDE seam: the dashboard's run route resolves the entry
 * + its bound record, hands them to the executor, and renders whatever
 * the executor honestly produces (a real run outcome, or a real
 * refusal reason).
 *
 * THE AUTHORIZATION LAW (structural, in the application layer that
 * implements this port): the executor may only execute when the bound
 * record's DERIVED status is AI_EXECUTION_COMPLETE and the entry binds
 * a pinned runtime that exactly matches the record's pins. The port
 * itself carries no status — the implementation derives it.
 */

import type {
  CompatibilityEvidenceRecord,
  EgressObservation,
  ProviderCredentialFact,
  ZeckTraceFact,
} from "../domain/evidence";
import type { TaskRunOutcome } from "../domain/runtime";
import type { PinnedRuntimeDriver } from "./runtime";

/** The honest result of one demo run request (ran, or refused with its reason). */
export interface DemoRunResult {
  /** Did the run execute the certified path? */
  readonly ran: boolean;
  /** The verbatim reason (the honest refusal when ran=false; the run's summary when ran=true). */
  readonly reason: string;
  /** Present only when ran=true — the certified run's facts. */
  readonly outcome?: {
    readonly taskRun: TaskRunOutcome;
    readonly traces: readonly ZeckTraceFact[];
    readonly egressObservation: EgressObservation | null;
    readonly credentialErasure: {
      readonly erased: boolean;
      readonly facts: readonly ProviderCredentialFact[];
    };
    /** The runtime that executed (registry id + exact pins, verbatim). */
    readonly runtime: {
      readonly runtimeId: string;
      readonly pin: import("../domain/revisions").RevisionPin;
    };
    readonly measuredAt: string;
  };
}

/** The Demo Mirror run executor (the website-side certified-run seam). */
export interface DemoRunExecutor {
  /**
   * Run one demo entry's representative task through its exact pinned
   * integration. IMPLEMENTATIONS MUST refuse (ran=false, honest
   * reason) when the bound record does not derive
   * AI_EXECUTION_COMPLETE, when no driver is registered for the
   * entry's runtime binding, or when the driver's pins do not exactly
   * match the record's — never a synthetic response. The optional
   * `inventory` is the record's discovered edge inventory (the
   * reconciliation input certification requires; null stays the
   * honest unreconciled state).
   */
  run(
    entry: {
      readonly demoId: string;
      readonly evidenceRecordId: string;
      readonly runBinding:
        | { readonly kind: "none" }
        | { readonly kind: "pinned-runtime"; readonly runtime: string };
      readonly representativeTask: { readonly title: string; readonly description: string };
    },
    record: CompatibilityEvidenceRecord,
    inventory?: import("../domain/execution-graph").DiscoveredEdgeInventory | null,
  ): Promise<DemoRunResult>;
}

/** Re-export for implementors (the driver type the executor composes). */
export type { PinnedRuntimeDriver };
