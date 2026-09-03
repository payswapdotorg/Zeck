/**
 * State primitive tests (WORK-035) — the reusable loading / empty /
 * error / permission-denied / confirmation vocabulary
 * (UX-SCREEN-SPEC-V2 §18–§22, §5; UX-EXPERIENCE-ARCHITECTURE-V2 §26).
 *
 * The contract under test:
 *  - loadingState (spec §19): an in-main REGION with stage text and the
 *    retained context, role="status", and NO shell replacement — D1: a
 *    weakened loading treatment that would replace the page hierarchy
 *    (an own <h1>, or markup that could stand alone as a page) is
 *    structurally impossible;
 *  - emptyState (spec §18): title + body (+ hint);
 *  - errorState (spec §20): what happened / known / next step / retry
 *    safety;
 *  - permissionDeniedState (spec §21): action, missing permission, admin
 *    pathway — never secret internals;
 *  - unavailableState: the honest not-yet-exposed contract;
 *  - confirmationCard (v2 §26): consequence, affected, cost, why
 *    allowed, reversibility, approval and idempotency BEFORE the single
 *    confirm button, which submits a caller-supplied governed POST form
 *    with hidden fields (never a mutation by the primitive itself);
 *  - D3: hostile values in every field are escaped — a state primitive
 *    can never become an injection surface.
 */

import { describe, expect, test } from "vitest";
import {
  type ConfirmationView,
  confirmationCard,
  emptyState,
  errorState,
  loadingState,
  permissionDeniedState,
  unavailableState,
} from "../../../apps/dashboard/states";

describe("loadingState (spec §19 — hierarchy is preserved, D1)", () => {
  test("renders an in-main status region with the stage and the retained context", () => {
    const html = loadingState("reading the execution result", "Contract risk analysis");
    expect(html).toContain('class="state state-loading"');
    expect(html).toContain('role="status"');
    expect(html).toContain("Loading — reading the execution result");
    expect(html).toContain("The page keeps its place; nothing is replaced");
    expect(html).toContain("Contract risk analysis");
  });

  test("D1: the loading region can never replace the shell — no heading, no standalone page structure", () => {
    const html = loadingState("reading");
    // The loading state is a REGION inside main: it carries no h1/h2 (the
    // page-head keeps the single h1), no html/body shell, and no full-
    // viewport styling (class state, not app-shell).
    expect(html).not.toContain("<h1");
    expect(html).not.toContain("<h2");
    expect(html).not.toContain("<html");
    expect(html).not.toContain("<body");
    expect(html).not.toContain("app-shell");
    expect(html).not.toContain("spinner");
    // It is announceable but quiet: role=status, no alert.
    expect(html).toContain('role="status"');
    expect(html).not.toContain('role="alert"');
  });

  test("the stage text is escaped (no injection through the stage label)", () => {
    const html = loadingState('<script>alert("x")</script>');
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });
});

describe("emptyState / errorState / permissionDeniedState / unavailableState", () => {
  test("empty state renders title + body + hint (spec §18)", () => {
    const html = emptyState(
      "No runs yet",
      "Describe something you want Zeck to accomplish.",
      "The public API exposes executions by id.",
    );
    expect(html).toContain("state-empty");
    expect(html).toContain("No runs yet");
    expect(html).toContain("Describe something you want Zeck to accomplish.");
    expect(html).toContain("The public API exposes executions by id.");
  });

  test("error state renders the situation, the known facts and the next step (spec §20)", () => {
    const html = errorState(
      "The Zeck API could not complete this view",
      "The live read failed.",
      "PROVIDER_ERROR — retryable",
    );
    expect(html).toContain("state-error");
    expect(html).toContain("The Zeck API could not complete this view");
    expect(html).toContain("retryable");
  });

  test("permission-denied state carries the requested action and the admin pathway (spec §21)", () => {
    const html = permissionDeniedState(
      "The governed API denied this view",
      "The token is not authorized for this application scope.",
      "FORBIDDEN — ask your workspace owner",
    );
    expect(html).toContain("state-denied");
    expect(html).toContain("denied");
    expect(html).toContain("workspace owner");
  });

  test("unavailable state names the concept, explains it, and states the future fact source", () => {
    const html = unavailableState(
      "Policies",
      "Controls in user language are not exposed yet.",
      "the policy authority through the public API",
    );
    expect(html).toContain("state-unavailable");
    expect(html).toContain("not yet exposed by the public API");
    expect(html).toContain("the policy authority through the public API");
  });
});

describe("confirmationCard (v2 §26 — the universal consequence preview)", () => {
  const view: ConfirmationView = {
    title: "Cancel this execution?",
    consequence: "Cancelling stops the execution at its current state.",
    affected: 'The execution "Contract risk analysis".',
    cost: "No further spend accrues.",
    whyAllowed: "The governed cancel command through the execution lifecycle authority.",
    reversible: false,
    approvalNote: "No separate approval required for this token.",
    idempotencyNote: "An idempotency key converges double submits.",
    hiddenFields: [
      ["idempotencyKey", "dash-1234"],
      ["applicationId", "00000000-0000-7000-8000-0000000000a1"],
    ],
    confirmAction: "/runs/00000000-0000-7000-8000-0000000000e1/cancel",
    confirmLabel: "Cancel execution",
    cancelHref: "/runs/00000000-0000-7000-8000-0000000000e1",
  };

  test("states every consequence fact BEFORE the single confirm button (a governed POST)", () => {
    const html = confirmationCard(view);
    for (const fact of [
      "What will happen",
      "Who or what is affected",
      "What it costs",
      "Why it is allowed",
      "Can it be undone",
      "Approval required",
      "Idempotency",
      "No — this is a terminal change",
    ]) {
      expect(html).toContain(fact);
    }
    // The confirm action is a FORM (POST) carrying the caller's hidden
    // fields — the primitive itself never mutates.
    expect(html).toContain('method="post"');
    expect(html).toContain(`action="${view.confirmAction}"`);
    expect(html).toContain('name="idempotencyKey" value="dash-1234"');
    expect(html).toContain('name="applicationId"');
    expect(html).toContain("Cancel execution</button>");
    expect(html).toContain('class="primary"');
    // The escape hatch.
    expect(html).toContain("Not now");
  });

  test("reversible=true communicates undo honestly (never a fabricated safety)", () => {
    const html = confirmationCard({ ...view, reversible: true });
    expect(html).toContain("<td>Yes</td>");
  });

  test("WORK-036 AC9: a caller-supplied reversibleDetail replaces the default wording (the honest contract fact)", () => {
    const html = confirmationCard({
      ...view,
      reversible: false,
      reversibleDetail:
        "No — a committed execution cannot be undone through the public contract. The governed stop is Cancel.",
    });
    expect(html).toContain(
      "No — a committed execution cannot be undone through the public contract.",
    );
    // The default vocabulary is replaced, not appended alongside.
    expect(html).not.toContain("No — this is a terminal change");
  });

  test("WORK-036 AC9: the default Yes/No vocabulary renders unchanged when no detail is supplied (the substrate is not redefined)", () => {
    expect(confirmationCard(view)).toContain("No — this is a terminal change");
  });

  test("D3: hostile values in every field are escaped (never an injection surface)", () => {
    const hostile: ConfirmationView = {
      ...view,
      title: '<script>alert("t")</script>',
      consequence: '" onmouseover="alert(1)',
      affected: "<b>bold</b>",
      whyAllowed: "javascript:alert(1)",
      hiddenFields: [["x", '"><script>']],
      cancelHref: '"><script>',
    };
    const html = confirmationCard(hostile);
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<b>bold</b>");
  });
});
