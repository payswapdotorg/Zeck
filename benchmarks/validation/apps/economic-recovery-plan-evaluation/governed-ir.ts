/**
 * The evaluation's governed Execution IR (PCR-003) — a PINNED CAPTURED
 * CONSTANT, not a reconstruction.
 *
 * THE BOUNDARY DISCIPLINE: the customer boundary (VAL-002 AC7) forbids
 * importing the platform's planning compiler (`buildPlan` →
 * `createIrPlanSource().toPlanSnapshot` → `deriveExecutionIr`) from the
 * application tree. The recovery seam consumes the governed IR as an
 * explicit caller-supplied input (`ExperimentRecoveryPlanInputs.ir`) —
 * and the seam reads exactly one thing from it: the generative step the
 * model-rail re-route selection resolves (`requireGenerativeStep`:
 * `ir.steps` by step id, generative step class only).
 *
 * This module therefore carries the governed IR as a CAPTURED PLATFORM
 * VALUE — the byte-exact output of the platform's own construction (the
 * same 3-step governed plan: fetch → generate [the model-rail
 * generative step on supply-a/synth-text] → verify, plan revision 1,
 * hybrid strategy), captured once and pinned. The test suite proves the
 * capture is exact — deep equality AND content-addressed identity
 * (`irId`) against a LIVE platform construction — so any platform-side
 * drift in the governed IR's derivation fails the suite (drift-visible,
 * never silent; the constant must then be re-captured deliberately).
 *
 * The value is DATA (a typed record), never compiler logic — the app
 * references the platform's value; it does not rebuild the compiler.
 * The compile-time structural check flows through the LAB's exported
 * interface (`satisfies ExperimentRecoveryPlanInputs["ir"]`) — never an
 * import from `src/**`.
 */

import type { ExperimentRecoveryPlanInputs } from "../shared/seam";

/**
 * The pinned governed Execution IR (captured from the platform's own
 * construction; equality pinned in-suite — see
 * tests/unit/validation/pcr-003-recovery-plan-evaluation.test.ts).
 */
export const EVALUATION_GOVERNED_IR = {
  irSchema: 1,
  planId: "b1025969ba127f960b32b983d76034fa18218abc2e425e80534240ddb8a50720",
  planRevision: 1,
  strategyClass: "hybrid",
  steps: [
    {
      id: "fetch",
      stepClass: "retrieve",
      computationType: "deterministic",
      sideEffectClass: "pure",
      capabilityId: "document-retrieval",
    },
    {
      id: "generate",
      stepClass: "call-model",
      computationType: "probabilistic",
      sideEffectClass: "model-inference",
      capabilityId: "text-generation",
      routeRef: {
        provider: "supply-a",
        model: "synth-text",
      },
    },
    {
      id: "verify",
      stepClass: "verify",
      computationType: "deterministic",
      sideEffectClass: "verification",
      verificationStrategy: "schema-check",
    },
  ],
  edges: [
    {
      from: "fetch",
      to: "generate",
    },
    {
      from: "generate",
      to: "verify",
    },
  ],
  modelCalls: 1,
  hasRouteRef: true,
  provenance: {
    source: "planning.governed-plan",
    derivationBasis: "governed-plan-lossless-view",
  },
  irId: "e9e22d17f9ca19e8f6cc694aa93fffaa868e70af8e6c413715c50ab8225014b1",
} as const satisfies ExperimentRecoveryPlanInputs["ir"];

/** The governed IR's model-selection step id (the recovery's generative step). */
export const GOVERNED_IR_STEP_ID = "generate";
