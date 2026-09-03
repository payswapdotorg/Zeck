/**
 * Zeck experience modes (WORK-035) — the Simple / Professional / Expert
 * visibility model (UX-EXPERIENCE-ARCHITECTURE-V2 §25).
 *
 * A mode is a PRESENTATION preference, exactly like appearance: it is a
 * cookie (`zeck_mode`), it changes which navigation entries and advanced
 * affordances are VISIBLE, and it never changes semantics — the same
 * routes, the same objects, the same wire reads and the same governed
 * commands exist in every mode. There are no duplicated route trees and
 * no duplicated object models (Implementation Requirement 4).
 *
 * The vocabulary (v2 §25):
 *  - Simple: Home, Work, Results, Approvals — the flat, outcome-first set.
 *  - Professional: the full v2 information architecture (the default).
 *  - Expert: Professional plus the expert-only inspection entries
 *    (Lineage, Audit).
 *
 * Downstream Work Orders (WORK-036+) apply the same predicate to their own
 * affordances; they must consume this module rather than re-defining the
 * model.
 */

import { esc } from "./components";

export const EXPERIENCE_MODES = ["simple", "professional", "expert"] as const;

export type ExperienceMode = (typeof EXPERIENCE_MODES)[number];

/** The mode is a presentation cookie (same family as appearance). */
export const MODE_COOKIE = "zeck_mode";

/** Professional is the default: the full v2 information architecture. */
export const DEFAULT_MODE: ExperienceMode = "professional";

export const MODE_LABELS: Readonly<Record<ExperienceMode, string>> = {
  simple: "Simple",
  professional: "Professional",
  expert: "Expert",
};

/** Parse the mode cookie (unknown values fall back to the default). */
export function modeOf(cookies: Readonly<Record<string, string>>): ExperienceMode {
  const value = cookies[MODE_COOKIE];
  return value === "simple" || value === "expert" ? value : DEFAULT_MODE;
}

/** Serialize the mode cookie header (presentation state, 1 year). */
export function modeCookieHeader(mode: ExperienceMode): string {
  return `${MODE_COOKIE}=${encodeURIComponent(mode)}; Path=/; Max-Age=31536000; SameSite=Lax`;
}

/** Anything carrying a mode visibility list (nav items, affordances). */
export interface ModeVisibility {
  readonly modes: readonly ExperienceMode[];
}

/**
 * The single visibility predicate: is this entry visible in this mode?
 * Pure, total, and shared by every consumer — the one definition of the
 * v2 §25 rule ("modes alter visibility and density, never semantics").
 */
export function visibleInMode(entry: ModeVisibility, mode: ExperienceMode): boolean {
  return entry.modes.includes(mode);
}

/** Filter a list of mode-visible entries for one mode (order preserved). */
export function filterByMode<T extends ModeVisibility>(
  entries: readonly T[],
  mode: ExperienceMode,
): T[] {
  return entries.filter((entry) => visibleInMode(entry, mode));
}

/**
 * The header mode selector (the no-JS GET form; the client script applies
 * the change instantly and submits, exactly like the appearance form).
 */
export function modeSelectionForm(mode: ExperienceMode, returnTo: string): string {
  const option = (value: ExperienceMode): string =>
    `<option value="${value}"${mode === value ? " selected" : ""}>${MODE_LABELS[value]} mode</option>`;
  return `<form class="mode-form" method="get" action="/mode">
  <div>
    <label for="experience-mode" class="visually-hidden">Experience mode</label>
    <select id="experience-mode" name="level" data-mode-select>
      ${option("simple")}
      ${option("professional")}
      ${option("expert")}
    </select>
  </div>
  <button type="submit">Apply</button>
  <input type="hidden" name="returnTo" value="${esc(returnTo)}">
</form>`;
}
