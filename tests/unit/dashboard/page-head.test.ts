/**
 * Page-head tests (WORK-035) — the contextual breadcrumb + title +
 * primary-action treatment (UX-EXPERIENCE-ARCHITECTURE-V2 §2;
 * UX-SCREEN-SPEC-V2 §2).
 *
 * The contract under test:
 *  - breadcrumbTrail derives Home → group → item → current from the IA
 *    model (no second hierarchy to maintain);
 *  - pageHead renders the breadcrumb nav (aria-label="Breadcrumb"), the
 *    single h1, and room for ONE dominant primary action;
 *  - headingHtml replaces the plain title INSIDE the single h1 (the
 *    execution title + status badge line, v2 §9);
 *  - every label/href is escaped;
 *  - the last crumb carries aria-current="page".
 */

import { describe, expect, test } from "vitest";
import { breadcrumbTrail, pageHead } from "../../../apps/dashboard/shell";

describe("breadcrumbTrail (derived from the IA model)", () => {
  test("Home renders the single Home crumb", () => {
    expect(breadcrumbTrail("/")).toEqual([{ label: "Home", href: "/" }]);
  });

  test("a group-path page renders Home → group", () => {
    expect(breadcrumbTrail("/runs")).toEqual([
      { label: "Home", href: "/" },
      { label: "Work", href: "/runs" },
    ]);
  });

  test("an item page renders Home → group → item", () => {
    expect(breadcrumbTrail("/runs/history")).toEqual([
      { label: "Home", href: "/" },
      { label: "Work", href: "/runs" },
      { label: "History", href: "/runs/history" },
    ]);
    expect(breadcrumbTrail("/agents")).toEqual([
      { label: "Home", href: "/" },
      { label: "Build", href: "/build" },
      { label: "Agents", href: "/agents" },
    ]);
    expect(breadcrumbTrail("/trust/lineage")).toEqual([
      { label: "Home", href: "/" },
      { label: "Trust", href: "/trust/evidence" },
      { label: "Lineage", href: "/trust/lineage" },
    ]);
  });

  test("a deep page appends the current label (the execution title)", () => {
    expect(
      breadcrumbTrail("/runs/00000000-0000-7000-8000-0000000000e1", "Contract risk analysis"),
    ).toEqual([
      { label: "Home", href: "/" },
      { label: "Work", href: "/runs" },
      { label: "Contract risk analysis", href: "/runs/00000000-0000-7000-8000-0000000000e1" },
    ]);
  });

  test("unknown paths still carry the Home anchor (never a broken trail)", () => {
    expect(breadcrumbTrail("/definitely-not-a-route")[0]).toEqual({ label: "Home", href: "/" });
  });
});

describe("pageHead (the contextual title treatment)", () => {
  test("renders the breadcrumb nav, the single h1 and the primary action slot", () => {
    const html = pageHead({
      title: "Agents",
      path: "/agents",
      primaryActionHtml: '<a class="button-link primary" href="/build/agent">Propose an agent</a>',
    });
    expect(html).toContain('<nav class="breadcrumb" aria-label="Breadcrumb">');
    expect(html).toContain("<ol>");
    expect(html).toContain('<a href="/">Home</a>');
    expect(html).toContain('<a href="/build">Build</a>');
    expect((html.match(/<h1[^>]*>/g) ?? []).length).toBe(1);
    expect(html).toContain("<h1>Agents</h1>");
    expect(html).toContain('class="page-actions"');
    expect(html).toContain('href="/build/agent"');
    // The current crumb is marked.
    expect(html).toContain('<span aria-current="page">Agents</span>');
  });

  test("no primary action renders the title line without an empty actions div", () => {
    const html = pageHead({ title: "Runs", path: "/runs" });
    expect(html).not.toContain("page-actions");
    expect(html).toContain("<h1>Runs</h1>");
  });

  test("headingHtml replaces the plain title INSIDE the single h1 (v2 §9 title + status line)", () => {
    const html = pageHead({
      title: "Contract risk analysis",
      path: "/runs/00000000-0000-7000-8000-0000000000e1",
      currentLabel: "Contract risk analysis",
      headingHtml:
        'Contract risk analysis\n    <span class="badge status-COMPLETED"><span class="symbol" aria-hidden="true">✓</span>Completed</span>',
    });
    expect((html.match(/<h1[^>]*>/g) ?? []).length).toBe(1);
    expect(html).toContain("<h1>Contract risk analysis");
    expect(html).toContain("status-COMPLETED");
  });

  test("hostile titles are escaped", () => {
    const html = pageHead({ title: '<script>alert("x")</script>', path: "/agents" });
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });
});
