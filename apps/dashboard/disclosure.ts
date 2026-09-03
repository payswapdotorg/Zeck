/**
 * Zeck disclosure primitives (WORK-035) — the progressive-disclosure
 * vocabulary (UX-EXPERIENCE-ARCHITECTURE-V2 §24, §27).
 *
 * Two shapes, one grammar:
 *
 *  1. `advancedDisclosure` — the native `<details>` inline disclosure
 *     (WORK-033's primitive, unchanged semantics): collapsed by default,
 *     zero-JS, the Depth-3/Depth-4 container inside a page.
 *
 *  2. `sheetDialog` — the focused overlay panel (the tablet "advanced
 *     information in focused sheets/panels" and the mobile bottom sheet).
 *     It is a native `<dialog>`: the USER AGENT owns the modal focus trap
 *     and the Escape key; the shared client script owns OPENING (any
 *     element with `data-sheet-open="<id>"`) and RESTORING focus to the
 *     opener on close (`data-focus-return`). The body content and its
 *     actions are supplied by the caller — the primitive itself never
 *     mutates state and never performs transport.
 *
 * `method="dialog"` close forms work with zero script (the dialog element
 * honors them natively); the script only adds the opener/restore wiring.
 */

import { esc } from "./components";

/** Reusable collapsed-by-default disclosure for expert fields. */
export function advancedDisclosure(
  summary: string,
  content: string,
  options: { readonly id?: string } = {},
): string {
  return `<details class="advanced"${options.id === undefined ? "" : ` id="${esc(options.id)}"`}><summary>${esc(
    summary,
  )}</summary><div class="advanced-body">${content}</div></details>`;
}

export interface SheetDialogView {
  /** The dialog element id (openers reference it via data-sheet-open). */
  readonly id: string;
  readonly title: string;
  readonly bodyHtml: string;
  /** Optional trailing action row inside the sheet (forms the caller supplies). */
  readonly actionsHtml?: string;
  readonly closeLabel?: string;
}

/**
 * The sheet primitive. Focus ownership: while open, the UA keeps focus
 * inside the dialog (native modal semantics); on close the client script
 * restores focus to the element that opened it. The close form is
 * `method="dialog"` (native, zero-script).
 */
export function sheetDialog(view: SheetDialogView): string {
  const closeLabel = view.closeLabel ?? "Close panel";
  return `<dialog class="sheet" id="${esc(view.id)}" aria-labelledby="${esc(view.id)}-title">
  <div class="sheet-body">
    <div class="sheet-head">
      <h2 id="${esc(view.id)}-title">${esc(view.title)}</h2>
      <form method="dialog" class="dialog-close">
        <button type="submit" data-focus-return aria-label="${esc(closeLabel)}">${esc(closeLabel)}</button>
      </form>
    </div>
    ${view.bodyHtml}
    ${view.actionsHtml ?? ""}
  </div>
</dialog>`;
}
