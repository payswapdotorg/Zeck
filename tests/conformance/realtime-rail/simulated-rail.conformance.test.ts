/**
 * The realtime-rail conformance suite over the SHIPPED SIMULATED RAIL —
 * the semantic reference (PPR-009 requirement 1).
 *
 * The in-process simulated rail is the reference implementation of the
 * `RealtimeRail` seam's semantics (including the in-memory idempotency
 * ledger): it passes this suite BY CONSTRUCTION, and its pass is the
 * calibration point for every REAL rail that runs the same suite. The
 * simulated rail's ledger lives in the rail instance itself (it models
 * the external provider world, which survives a Zeck process crash but
 * not the destruction of the simulated world) — so the crash-restart
 * probe is exercised by the REAL-rail subject (the local livekit
 * server keeps its rooms across adapter processes), not here.
 */

import { createInProcessRealtimeRail } from "../../../src/modules/deployments/adapters/in-process-realtime-rail";
import { defineRealtimeRailConformance } from "./realtime-rail-conformance";

const rail = createInProcessRealtimeRail();

defineRealtimeRailConformance({
  name: "simulated-realtime-rail (the semantic reference)",
  rail,
  armRefusal: () => {
    rail.failNextDelivery("simulated upstream refusal (injected)");
  },
  disarmRefusal: () => {
    // One-shot by construction: the armed refusal clears on the next
    // attempted effect; nothing to restore.
  },
  probes: {
    countOpenSideEffects: async () => rail.openedSessions,
    countDeliverSideEffects: async () =>
      rail.deliveries.filter((record) => record.kind === "deliver").length,
    countTransferSideEffects: async () =>
      rail.deliveries.filter((record) => record.kind === "transfer").length,
    countCloseSideEffects: async () =>
      rail.deliveries.filter((record) => record.kind === "close").length,
  },
});
