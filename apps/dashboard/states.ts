/**
 * Zeck reusable states (WORK-035) — the shared loading / empty / error /
 * permission-denied / confirmation / advanced-disclosure vocabulary
 * (UX-SCREEN-SPEC-V2 §18–§22, §5; UX-EXPERIENCE-ARCHITECTURE-V2 §26).
 *
 * Every state primitive obeys the same structural contract:
 *  - a title (the situation in ordinary language);
 *  - a body (what is known);
 *  - where applicable, the next useful action (a link — never a mutation
 *    performed by the state itself);
 *  - loading PRESERVES page hierarchy (an in-main region with stage text
 *    and the retained context — never a shell-replacing spinner);
 *  - errors state what happened, what is known, what to do next and
 *    whether retry is safe;
 *  - permission-denied states explain the requested action, the missing
 *    permission and the owner/admin pathway, and NEVER expose
 *    authorization internals;
 *  - confirmation surfaces state the consequence, the authorization, the
 *    cost, the reversibility and the idempotency handling BEFORE the one
 *    confirm button (which submits a governed POST form supplied by the
 *    caller).
 *
 * All interpolated values pass through esc — a state primitive can never
 * become an injection surface (pinned by the discrimination test).
 */

import { esc } from "./components";
import { advancedDisclosure } from "./disclosure";

export { advancedDisclosure };

function stateBlock(className: string, title: string, body: string, source?: string): string {
  return `<div class="state ${className}">
  <p class="state-title">${esc(title)}</p>
  <p class="state-body">${esc(body)}</p>${source === undefined ? "" : `\n  <p class="state-source">${esc(source)}</p>`}
</div>`;
}

/**
 * The loading region (spec §19): preserves page hierarchy — renders inside
 * main with the current stage and the user's retained context; NEVER a
 * dashboard-wide spinner replacing the shell (AC1; pinned by D1).
 */
export function loadingState(stage: string, contextNote?: string): string {
  return `<div class="state state-loading" role="status">
  <p class="state-stage"><span aria-hidden="true">…</span> Loading — ${esc(stage)}</p>
  <p class="state-body">This region is reading live through the governed API. The page keeps its place; nothing is replaced.</p>${
    contextNote === undefined ? "" : `\n  <p class="state-source">${esc(contextNote)}</p>`
  }
</div>`;
}

/** The empty state (spec §18): explains the value and offers the next useful action. */
export function emptyState(title: string, body: string, hint?: string): string {
  return stateBlock("state-empty", title, body, hint);
}

/** The error state (spec §20): what happened / what is known / next step / retry safety. */
export function errorState(title: string, body: string, detail?: string): string {
  return stateBlock("state-error", title, body, detail);
}

/**
 * The permission-denied state (spec §21): the requested action, the
 * missing permission, the owner/admin pathway — never secret or
 * authorization internals.
 */
export function permissionDeniedState(title: string, body: string, detail?: string): string {
  return stateBlock("state-denied", title, body, detail);
}

/**
 * The honest "not yet exposed by the public API" state: a one-line
 * explanation of the concept in user language and a pointer to where its
 * facts WILL come from. NEVER a fabricated placeholder.
 */
export function unavailableState(
  concept: string,
  explanation: string,
  futureSource: string,
): string {
  return `<div class="state state-unavailable">
  <p class="state-title">${esc(concept)} — not yet exposed by the public API</p>
  <p class="state-body">${esc(explanation)}</p>
  <p class="state-source">When this surface ships, its facts will come from ${esc(futureSource)}.</p>
</div>`;
}

/**
 * The universal consequence preview (v2 §26, spec §5): what will happen,
 * who/what is affected, what it costs, why it is allowed, whether it can
 * be undone and which approval applies — stated BEFORE commitment. The
 * confirm action is ALWAYS a form the caller supplies (a governed POST
 * through the SDK client with an idempotency key); the primitive never
 * mutates anything itself.
 */
export interface ConfirmationView {
  readonly title: string;
  readonly consequence: string;
  readonly affected: string | null;
  readonly cost: string | null;
  readonly whyAllowed: string | null;
  readonly reversible: boolean;
  readonly approvalNote: string | null;
  readonly idempotencyNote: string | null;
  /** The confirm form's hidden inputs (idempotency key, application id…). */
  readonly hiddenFields: readonly (readonly [string, string])[];
  /** The governed POST target the confirm button submits to. */
  readonly confirmAction: string;
  readonly confirmLabel: string;
  /** Where "not now" returns to. */
  readonly cancelHref: string;
}

export function confirmationCard(view: ConfirmationView): string {
  const rows: [string, string][] = [
    ["What will happen", view.consequence],
    ["Who or what is affected", view.affected ?? "—"],
    ["What it costs", view.cost ?? "—"],
    ["Why it is allowed", view.whyAllowed ?? "—"],
    ["Can it be undone", view.reversible ? "Yes" : "No — this is a terminal change"],
    ["Approval required", view.approvalNote ?? "—"],
    ["Idempotency", view.idempotencyNote ?? "—"],
  ];
  const hidden = view.hiddenFields
    .map(([name, value]) => `<input type="hidden" name="${esc(name)}" value="${esc(value)}">`)
    .join("\n    ");
  return `<section class="confirmation" aria-labelledby="confirmation-title">
  <h2 class="confirmation-title" id="confirmation-title">${esc(view.title)}</h2>
  <p class="confirmation-warning">Consequential action — review the consequence before committing.</p>
  <table class="kv">
    <tbody>${rows
      .map(([key, value]) => `<tr><th scope="row">${esc(key)}</th><td>${esc(value)}</td></tr>`)
      .join("")}</tbody>
  </table>
  <form method="post" action="${esc(view.confirmAction)}">
    ${hidden}
    <div class="form-actions">
      <button type="submit" class="primary">${esc(view.confirmLabel)}</button>
      <a class="button-link" href="${esc(view.cancelHref)}">Not now</a>
    </div>
  </form>
</section>`;
}
