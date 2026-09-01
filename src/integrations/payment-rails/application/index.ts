/**
 * Payment-rails integration application barrel (WORK-032).
 *
 * Pure composition helpers over the registered rails — no authority
 * logic, no state, no I/O.
 */
export { type RailRegistry, resolveRailById } from "./rail-registry";
