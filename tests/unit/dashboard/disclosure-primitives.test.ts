/**
 * Disclosure primitive tests (WORK-035) — the progressive-disclosure
 * vocabulary (UX-EXPERIENCE-ARCHITECTURE-V2 §24, §27).
 *
 * The contract under test:
 *  - advancedDisclosure: the native `<details>` inline disclosure —
 *    collapsed by default, summary-first, zero-JS;
 *  - sheetDialog: the focused overlay panel — a native `<dialog>` with
 *    aria-labelledby, a `method="dialog"` close form (zero-JS), and the
 *    `data-focus-return` marker for the client-side focus restore;
 *  - D4 (discrimination): the focus-restore WIRING exists end-to-end —
 *    the client script contains the close handler that restores focus to
 *    the stored opener, and openers reference dialogs by
 *    data-sheet-open; a mutant that removes the restore fails.
 *  - hostile content in sheet ids/titles/bodies is escaped.
 */

import { describe, expect, test } from "vitest";
import { CLIENT_SCRIPT } from "../../../apps/dashboard/client";
import { advancedDisclosure, sheetDialog } from "../../../apps/dashboard/disclosure";

describe("advancedDisclosure (the native inline disclosure)", () => {
  test("renders a collapsed-by-default details element with the summary first", () => {
    const html = advancedDisclosure("Route detail (advanced)", "<p>content</p>");
    expect(html).toContain('<details class="advanced">');
    expect(html).not.toContain('<details class="advanced" open');
    expect(html.indexOf("<summary>")).toBeLessThan(html.indexOf("<p>content</p>"));
    expect(html).toContain("advanced-body");
  });

  test("the optional id is escaped", () => {
    const html = advancedDisclosure("s", "c", { id: '"><script>' });
    expect(html).not.toContain("<script>");
    expect(html).toContain('id="&quot;&gt;&lt;script&gt;"');
  });
});

describe("sheetDialog (the focused panel, v2 §27)", () => {
  test("renders a native dialog with accessible labelling and a zero-JS close form", () => {
    const html = sheetDialog({
      id: "route-detail-sheet",
      title: "Route detail — focused panel",
      bodyHtml: "<p>body</p>",
    });
    expect(html).toContain('<dialog class="sheet" id="route-detail-sheet"');
    expect(html).toContain('aria-labelledby="route-detail-sheet-title"');
    expect(html).toContain('id="route-detail-sheet-title"');
    // method="dialog" close form: native, works without any script.
    expect(html).toContain('<form method="dialog" class="dialog-close">');
    expect(html).toContain("Close panel");
    // The focus-restore marker on the close control.
    expect(html).toContain("data-focus-return");
  });

  test("optional actions render inside the sheet body", () => {
    const html = sheetDialog({
      id: "s",
      title: "t",
      bodyHtml: "b",
      actionsHtml: '<form method="dialog" class="dialog-actions"><button>x</button></form>',
    });
    expect(html).toContain('class="dialog-actions"');
  });

  test("hostile ids/titles/bodies are escaped", () => {
    const html = sheetDialog({
      id: '"><script>',
      title: "<script>alert(1)</script>",
      bodyHtml: "<p>ok</p>",
    });
    expect(html).not.toContain("<script>alert");
    expect(html).toContain("&lt;script&gt;");
  });
});

describe("D4: the focus-ownership wiring is present end-to-end", () => {
  test("the client script restores focus to the stored opener on dialog close", () => {
    // The shared client script owns: storing the opener on open,
    // listening for close, and restoring focus (guarded to still-connected
    // elements). A mutant dropping any of these fails this assertion.
    expect(CLIENT_SCRIPT).toContain("lastOpener");
    expect(CLIENT_SCRIPT).toContain('addEventListener("close"');
    expect(CLIENT_SCRIPT).toContain("opener.focus()");
    expect(CLIENT_SCRIPT).toContain("document.contains(opener)");
  });

  test("the client script opens sheets from [data-sheet-open] triggers and traps nothing itself (the UA owns the modal trap)", () => {
    expect(CLIENT_SCRIPT).toContain("[data-sheet-open]");
    expect(CLIENT_SCRIPT).toContain("data-sheet-open");
    expect(CLIENT_SCRIPT).toContain("showModal");
    // The UA owns Escape/modal focus — the script never synthesizes a
    // trap (no manual Tab handling, no keydown Escape handler for dialogs).
    expect(CLIENT_SCRIPT).not.toContain('event.key === "Escape"');
    expect(CLIENT_SCRIPT).not.toContain(
      'keydown", function (event) {\n      if (event.key === "Tab"',
    );
  });

  test("the execution surface wires a real sheet usage (the route-detail focused panel)", async () => {
    const { whyPanel } = await import("../../../apps/dashboard/components");
    const html = whyPanel({
      execution: {
        id: "00000000-0000-7000-8000-0000000000e1",
        applicationId: "00000000-0000-7000-8000-0000000000a1",
        environmentId: null,
        status: "COMPLETED",
        task: { kind: "outcome", description: "Contract risk analysis" },
        constraints: null,
        metadata: {},
        createdAt: "2026-09-15T12:00:00Z",
        updatedAt: "2026-09-15T12:03:42Z",
        terminalAt: "2026-09-15T12:03:42Z",
      },
      result: {
        executionId: "00000000-0000-7000-8000-0000000000e1",
        status: "COMPLETED",
        route: {
          provider: "neutral-p",
          model: "neutral-m",
          strategyClass: "hybrid",
          modelCalls: 2,
        },
        cost: { totalMicroUsd: "4180000", currency: "usd" },
        usage: null,
        outputArtifacts: [],
        verification: [],
        warnings: [],
        terminalAt: "2026-09-15T12:03:42Z",
      },
      events: [],
    });
    expect(html).toContain('<dialog class="sheet" id="route-detail-sheet"');
    expect(html).toContain('data-sheet-open="route-detail-sheet"');
    // The inline disclosure carries the same facts without any script.
    expect(html).toContain('<details class="advanced">');
  });
});
