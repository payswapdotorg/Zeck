/**
 * Synthesized tool-adapter factory port (tools module outbound;
 * WORK-018).
 *
 * The seam through which a `usable` synthesized program is bound as a
 * governed tool: the factory constructs the `ToolAdapter` whose
 * dispatch executes the program through the synthesis sandbox executor
 * (the same ONLY execution surface used during runtime tests — there
 * is no second code path once the program becomes a tool).
 *
 * The application layer never constructs adapters directly (layers
 * point inwards); this port keeps the synthesis service's dependency
 * surface pinned while the adapter mechanics live behind it.
 */

import type { SynthesizedProgramRecord } from "../domain/synthesis";
import type { ToolAdapter } from "./tool-adapter";

export interface SynthesizedToolAdapterFactory {
  /**
   * Construct the governed adapter for one usable program. The adapter
   * dispatches through the sandbox executor port only; expiry and
   * status are re-checked at dispatch time by the service-owned
   * wrapper, so a retired/expired program fails closed even if a
   * previously constructed adapter handle survives.
   */
  create(program: SynthesizedProgramRecord, timeoutMs: number): ToolAdapter;
}
