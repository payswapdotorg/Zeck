/**
 * Zeck dashboard app shell (WORK-033, rebuilt as the WORK-035 v2 shell).
 *
 * One shell for every route, now realizing UX-EXPERIENCE-ARCHITECTURE-V2
 * §2/§5/§7 and UX-SCREEN-SPEC-V2 §2:
 *  - the skip link stays the first focusable element;
 *  - the header landmark carries the brand, the global command surface
 *    (the no-JS GET form to /command AND the Cmd/Ctrl+K dialog trigger),
 *    the attention indicator (rendered ONLY when action is required) and
 *    the presentation preferences (experience mode + appearance);
 *  - the nav landmark carries the v2 information architecture
 *    (Home + WORK/BUILD/LIBRARY/TRUST/CONTROL/IMPROVE) as native
 *    details/summary groups — the same DOM serves desktop's persistent
 *    quiet sidebar and tablet/mobile's collapsed menu, purely CSS-driven;
 *    in Simple mode the nav collapses to the four §25 primary
 *    destinations (Home/Work/Results/Approvals) — visibility only, never
 *    semantics;
 *  - the page-head treatment (breadcrumb + contextual title + one
 *    dominant primary action) is provided by `pageHead` for page content;
 *  - the command dialog (the second front door) is rendered once per
 *    page and submits through the EXISTING GET /command dispatch path;
 *  - the appearance and mode preferences are presentation cookies; the
 *    page frame itself holds NO state (M24).
 *
 * The active nav group is rendered open and the active item carries
 * `aria-current="page"`.
 */

import { type AttentionItem, attentionIndicator } from "./attention";
import { esc } from "./components";
import { DEFAULT_MODE, type ExperienceMode, modeSelectionForm, visibleInMode } from "./modes";
import { DASHBOARD_CSS } from "./tokens";

export type Appearance = "system" | "light" | "dark";

export interface NavItem {
  readonly label: string;
  readonly path: string;
  readonly description: string;
  readonly keywords: readonly string[];
  /** v2 §25: the modes in which this entry is visible (never semantic). */
  readonly modes: readonly ExperienceMode[];
}

export interface NavGroup {
  readonly label: string;
  readonly path: string;
  readonly keywords: readonly string[];
  readonly modes: readonly ExperienceMode[];
  readonly items: readonly NavItem[];
}

const PROFESSIONAL: readonly ExperienceMode[] = ["professional", "expert"];
const EXPERT_ONLY: readonly ExperienceMode[] = ["expert"];

/**
 * The v2 §5 information architecture. Every entry points at a REAL route
 * (the WORK-033 route map, preserved); entries whose facts the public API
 * does not expose yet lead to honest unavailable states — never
 * fabricated content. The `modes` field is the §25 visibility rule.
 */
export const NAV_GROUPS: readonly NavGroup[] = [
  {
    label: "Work",
    path: "/runs",
    keywords: ["work", "runs", "executions", "history"],
    modes: PROFESSIONAL,
    items: [
      {
        label: "New",
        path: "/build/execution",
        description: "Describe an outcome; Zeck plans and executes it under policy.",
        keywords: ["new", "execution", "run", "create", "outcome", "task", "ask"],
        modes: PROFESSIONAL,
      },
      {
        label: "Active",
        path: "/runs/active",
        description: "Executions opened in this browser that are not terminal yet.",
        keywords: ["active", "running", "in-progress"],
        modes: PROFESSIONAL,
      },
      {
        label: "History",
        path: "/runs/history",
        description: "Terminal executions opened in this browser.",
        keywords: ["history", "completed", "failed", "terminal", "past", "results"],
        modes: PROFESSIONAL,
      },
      {
        label: "Scheduled",
        path: "/runs/scheduled",
        description: "Scheduled runs (no scheduling surface in the public API yet).",
        keywords: ["scheduled", "future", "recurring"],
        modes: PROFESSIONAL,
      },
    ],
  },
  {
    label: "Build",
    path: "/build",
    keywords: ["build", "create", "new", "agents"],
    modes: PROFESSIONAL,
    items: [
      {
        label: "Agents",
        path: "/agents",
        description: "The governed agent inventory (read-only projection).",
        keywords: ["agent", "inventory", "versions", "build"],
        modes: PROFESSIONAL,
      },
      {
        label: "Deployments",
        path: "/deployments",
        description: "Persistent availability surfaces (not exposed by the public API yet).",
        keywords: ["deployment", "availability", "version", "channels"],
        modes: PROFESSIONAL,
      },
      {
        label: "Workloads",
        path: "/build/workload",
        description:
          "Training and batch compute as governed executions (creation is live through the execution authority).",
        keywords: ["workload", "training", "batch", "compute"],
        modes: PROFESSIONAL,
      },
      {
        label: "Competences",
        path: "/assets/competences",
        description: "Reusable, evidence-backed ways of describing work (not exposed yet).",
        keywords: ["competence", "skill", "reusable", "procedure"],
        modes: PROFESSIONAL,
      },
    ],
  },
  {
    label: "Library",
    path: "/assets",
    keywords: ["library", "assets", "artifacts", "connections"],
    modes: PROFESSIONAL,
    items: [
      {
        label: "Artifacts",
        path: "/assets/artifacts",
        description: "Output artifacts of executions you open (per-execution facts).",
        keywords: ["artifact", "file", "output", "result", "digest", "library"],
        modes: PROFESSIONAL,
      },
      {
        label: "Connections",
        path: "/assets/connections",
        description:
          "External tool and data connections (not exposed yet; secrets never rendered).",
        keywords: ["connection", "credential", "tool", "integration", "library"],
        modes: PROFESSIONAL,
      },
    ],
  },
  {
    label: "Trust",
    path: "/trust/evidence",
    keywords: ["trust", "evidence", "evaluations", "verification"],
    modes: PROFESSIONAL,
    items: [
      {
        label: "Evidence",
        path: "/trust/evidence",
        description: "The evidence surface across your work (not exposed yet).",
        keywords: ["evidence", "trust", "verification", "checks"],
        modes: PROFESSIONAL,
      },
      {
        label: "Evaluations",
        path: "/improve/evaluations",
        description: "Evaluation records behind quality claims (not exposed yet).",
        keywords: ["evaluation", "scoring", "quality", "trust"],
        modes: PROFESSIONAL,
      },
      {
        label: "Lineage",
        path: "/trust/lineage",
        description: "Artifact and result lineage (an expert inspection surface, not exposed yet).",
        keywords: ["lineage", "provenance", "graph", "expert"],
        modes: EXPERT_ONLY,
      },
    ],
  },
  {
    label: "Control",
    path: "/admin/policies",
    keywords: ["control", "admin", "settings", "governance"],
    modes: PROFESSIONAL,
    items: [
      {
        label: "Policies",
        path: "/admin/policies",
        description: "Rules and controls in user language (not exposed yet).",
        keywords: ["policy", "rules", "controls", "quality", "limits", "control"],
        modes: PROFESSIONAL,
      },
      {
        label: "Spend",
        path: "/admin/budgets",
        description: "Spend management (not exposed yet).",
        keywords: ["spend", "budget", "limit", "cost", "control"],
        modes: PROFESSIONAL,
      },
      {
        label: "Team",
        path: "/admin/team",
        description: "Workspace members and roles (not exposed yet).",
        keywords: ["team", "members", "roles", "people", "control"],
        modes: PROFESSIONAL,
      },
      {
        label: "Environments",
        path: "/admin/environments",
        description: "Compute environments (not exposed yet).",
        keywords: ["environment", "compute", "substrate", "control"],
        modes: PROFESSIONAL,
      },
      {
        label: "Audit",
        path: "/admin/audit",
        description: "Audit records (an expert inspection surface, not exposed yet).",
        keywords: ["audit", "records", "evidence", "expert"],
        modes: EXPERT_ONLY,
      },
    ],
  },
  {
    label: "Improve",
    path: "/improve/insights",
    keywords: ["improve", "learning", "recommendations"],
    modes: PROFESSIONAL,
    items: [
      {
        label: "Insights",
        path: "/improve/insights",
        description: "Recommendations to improve your workflows (not exposed yet).",
        keywords: ["insight", "recommendation", "improvement"],
        modes: PROFESSIONAL,
      },
      {
        label: "Learning",
        path: "/improve/learning",
        description: "Learning telemetry (not exposed yet).",
        keywords: ["learning", "telemetry", "signal", "improve"],
        modes: PROFESSIONAL,
      },
    ],
  },
];

/**
 * The Simple-mode primary destinations (v2 §25: Home, Work, Results,
 * Approvals). These are the SAME routes the grouped tree addresses —
 * visibility only, never a second route tree or object model.
 */
export const SIMPLE_NAV_ITEMS: readonly NavItem[] = [
  {
    label: "Work",
    path: "/runs",
    description: "Your work — active and recent executions.",
    keywords: ["work", "runs", "executions"],
    modes: ["simple"],
  },
  {
    label: "Results",
    path: "/runs/history",
    description: "Completed work and its results.",
    keywords: ["results", "history", "completed"],
    modes: ["simple"],
  },
  {
    label: "Approvals",
    path: "/attention",
    description: "Decisions and failed work that need you.",
    keywords: ["approvals", "attention", "decisions"],
    modes: ["simple"],
  },
];

/** Flatten the FULL IA tree (every mode) into the command-search index. */
export function navIndex(): readonly NavItem[] {
  return [...NAV_GROUPS.flatMap((group) => group.items), ...SIMPLE_NAV_ITEMS];
}

/** The nav groups with their mode-visible items (a group appears when it has one). */
export function visibleNavGroups(mode: ExperienceMode): readonly NavGroup[] {
  return NAV_GROUPS.flatMap((group) => {
    const items = group.items.filter((item) => visibleInMode(item, mode));
    return items.length === 0 ? [] : [{ ...group, items }];
  });
}

// ---------------------------------------------------------------------------
// Breadcrumbs + the page-head treatment
// ---------------------------------------------------------------------------

export interface Crumb {
  readonly label: string;
  readonly href: string;
}

function itemPathOf(item: NavItem): string {
  return item.path.split("#")[0] ?? item.path;
}

function matchesPath(prefix: string, path: string): boolean {
  return prefix === path || (prefix !== "/" && path.startsWith(`${prefix}/`));
}

/**
 * The contextual breadcrumb trail (v2 §2): Home → group → item → current.
 * Derived from the IA model — never a second hierarchy to maintain.
 */
export function breadcrumbTrail(activePath: string, currentLabel?: string): readonly Crumb[] {
  const trail: Crumb[] = [{ label: "Home", href: "/" }];
  if (activePath === "/" || activePath === "") {
    return trail;
  }
  let bestGroup: NavGroup | null = null;
  let bestItem: NavItem | null = null;
  for (const group of NAV_GROUPS) {
    for (const item of group.items) {
      if (matchesPath(itemPathOf(item), activePath)) {
        bestGroup = group;
        bestItem = item;
      }
    }
  }
  if (bestGroup === null) {
    for (const group of NAV_GROUPS) {
      if (matchesPath(group.path, activePath)) {
        bestGroup = group;
        break;
      }
    }
    if (bestGroup === null) {
      for (const item of SIMPLE_NAV_ITEMS) {
        if (matchesPath(itemPathOf(item), activePath)) {
          trail.push({ label: item.label, href: itemPathOf(item) });
          if (itemPathOf(item) !== activePath && currentLabel !== undefined) {
            trail.push({ label: currentLabel, href: activePath });
          }
          return trail;
        }
      }
    }
  }
  if (bestGroup !== null) {
    trail.push({ label: bestGroup.label, href: bestGroup.path });
    if (bestGroup.path === activePath) {
      return trail;
    }
    if (bestItem !== null) {
      const itemPath = itemPathOf(bestItem);
      if (itemPath === activePath) {
        trail.push({ label: bestItem.label, href: itemPath });
      } else if (currentLabel !== undefined) {
        trail.push({ label: bestItem.label, href: itemPath });
        trail.push({ label: currentLabel, href: activePath });
      }
    } else if (currentLabel !== undefined) {
      trail.push({ label: currentLabel, href: activePath });
    }
  }
  return trail;
}

export interface PageHeadView {
  /** The contextual page title (the breadcrumb current crumb and fallback heading). */
  readonly title: string;
  readonly path: string;
  /** The current page's own label when deeper than the IA (execution title…). */
  readonly currentLabel?: string;
  /**
   * Optional heading content replacing the plain title inside the single
   * h1 (e.g. the execution title + status badge on one line, v2 §9). The
   * page-head remains the ONE h1 site — callers never emit their own h1.
   */
  readonly headingHtml?: string;
  /** ONE dominant primary action (v2 §2); a link or small form's html. */
  readonly primaryActionHtml?: string;
}

/**
 * The page-head treatment: breadcrumb trail, the contextual title (the
 * page's single h1) and room for one dominant primary action. Pages
 * consume this instead of emitting bare `<h1>`s (AC10: downstream work
 * consumes the foundation without re-defining shell semantics).
 */
export function pageHead(view: PageHeadView): string {
  const trail = breadcrumbTrail(view.path, view.currentLabel);
  const crumbs = trail
    .map((crumb, index) => {
      const last = index === trail.length - 1;
      return `<li>${
        last
          ? `<span aria-current="page">${esc(crumb.label)}</span>`
          : `<a href="${esc(crumb.href)}">${esc(crumb.label)}</a>`
      }</li>`;
    })
    .join("");
  return `<div class="page-head">
  <nav class="breadcrumb" aria-label="Breadcrumb">
    <ol>
      ${crumbs}
    </ol>
  </nav>
  <div class="title-line">
    <h1>${view.headingHtml === undefined ? esc(view.title) : view.headingHtml}</h1>
    ${view.primaryActionHtml === undefined ? "" : `<div class="page-actions">${view.primaryActionHtml}</div>`}
  </div>
</div>`;
}

// ---------------------------------------------------------------------------
// Navigation rendering
// ---------------------------------------------------------------------------

function navGroupActive(group: NavGroup, activePath: string): boolean {
  if (matchesPath(group.path, activePath)) {
    return true;
  }
  return group.items.some((item) => matchesPath(itemPathOf(item), activePath));
}

function renderItemLink(item: NavItem, activePath: string): string {
  const itemPath = itemPathOf(item);
  const current = matchesPath(itemPath, activePath) ? ' aria-current="page"' : "";
  return `<li><a href="${esc(item.path)}"${current}>${esc(item.label)}</a></li>`;
}

function renderNav(activePath: string, mode: ExperienceMode): string {
  const commandHint = `<p class="nav-command-hint">Press <kbd>Ctrl</kbd> <kbd>K</kbd> to search or run a command</p>`;
  if (mode === "simple") {
    const homeCurrent = activePath === "/" ? ' aria-current="page"' : "";
    const items = SIMPLE_NAV_ITEMS.map((item) => renderItemLink(item, activePath)).join("\n    ");
    return `<nav class="app-nav" aria-label="Primary">
  <a class="nav-home" href="/"${homeCurrent}>Home</a>
  <ul>
    ${items}
  </ul>
  ${commandHint}
</nav>`;
  }
  const groups = visibleNavGroups(mode)
    .map((group) => {
      const open = navGroupActive(group, activePath) ? " open" : "";
      const renderedItems = group.items
        .map((item) => renderItemLink(item, activePath))
        .join("\n      ");
      return `<details class="nav-group"${open}>
    <summary>${esc(group.label)}</summary>
    <ul>
      ${renderedItems}
    </ul>
  </details>`;
    })
    .join("\n  ");
  const homeCurrent = activePath === "/" ? ' aria-current="page"' : "";
  return `<nav class="app-nav" aria-label="Primary">
  <a class="nav-home" href="/"${homeCurrent}>Home</a>
  ${groups}
  ${commandHint}
</nav>`;
}

// ---------------------------------------------------------------------------
// The global command dialog (the second front door, v2 §7)
// ---------------------------------------------------------------------------

export interface CommandSuggestion {
  readonly label: string;
  readonly href: string;
  readonly kind: string;
}

/**
 * The mode-aware static suggestion set: the visible navigation targets
 * plus the documented example commands. Every suggestion is a LINK —
 * mutations open their confirmation flows through the existing dispatch
 * path (never a direct POST from the dialog).
 */
export function commandSuggestions(mode: ExperienceMode): readonly CommandSuggestion[] {
  const navEntries: readonly CommandSuggestion[] =
    mode === "simple"
      ? SIMPLE_NAV_ITEMS.map((item) => ({
          label: item.label,
          href: itemPathOf(item),
          kind: "Navigation",
        }))
      : visibleNavGroups(mode).flatMap((group) =>
          group.items.map((item) => ({
            label: `${group.label} — ${item.label}`,
            href: item.path,
            kind: "Navigation",
          })),
        );
  const examples: readonly CommandSuggestion[] = [
    { label: "show failed runs yesterday", href: "/command?q=failed%20runs", kind: "Example" },
    {
      label: "show agents requiring approval",
      href: "/command?q=agents%20approval",
      kind: "Example",
    },
    { label: "open an execution by id", href: "/command?q=", kind: "Example" },
    {
      label: "propose cancel for an execution",
      href: "/command?q=cancel",
      kind: "Proposed action",
    },
  ];
  return [...navEntries, ...examples];
}

function commandDialog(mode: ExperienceMode): string {
  const suggestions = commandSuggestions(mode);
  const list = suggestions
    .map(
      (suggestion) =>
        `<li><a href="${esc(suggestion.href)}">${esc(suggestion.label)}<span class="suggestion-kind">${esc(
          suggestion.kind,
        )}</span></a></li>`,
    )
    .join("\n      ");
  return `<dialog class="command-dialog" id="command-dialog" aria-labelledby="command-dialog-title">
  <form method="get" action="/command" class="dialog-body">
    <p class="dialog-title">
      <span id="command-dialog-title">Search or run a command</span>
      <span aria-hidden="true"><kbd>Esc</kbd> to close</span>
    </p>
    <div>
      <label for="command-dialog-input" class="visually-hidden">Type a search or command</label>
      <input id="command-dialog-input" type="text" enterkeyhint="search" name="q" placeholder="Search, open, or act — every result is governed" autocomplete="off">
    </div>
    <p class="form-hint">Enter runs the search through the governed dispatch path; arrow keys move through suggestions; suggested actions open their confirmation flows.</p>
    <ul class="command-suggestions" data-command-suggestions>
      ${list}
    </ul>
    <p class="command-suggestion-empty" data-command-empty hidden>No suggestion matches — press Enter to search through the governed dispatch path.</p>
    <div class="dialog-actions">
      <button type="submit">Search</button>
    </div>
  </form>
</dialog>`;
}

// ---------------------------------------------------------------------------
// The shell
// ---------------------------------------------------------------------------

export interface AppShellInput {
  readonly title: string;
  readonly activePath: string;
  readonly mainContent: string;
  /** Attention items (drives the header indicator; the Home surface passes them). */
  readonly attention?: readonly AttentionItem[];
  readonly appearance?: Appearance;
  /** The v2 §25 experience mode (presentation only). */
  readonly mode?: ExperienceMode;
  readonly searchEcho?: string;
  /** Current path for the no-script appearance/mode fallback redirect. */
  readonly returnTo?: string;
}

function renderAppearanceForm(appearance: Appearance, returnTo: string): string {
  const option = (value: Appearance, label: string): string =>
    `<option value="${value}"${appearance === value ? " selected" : ""}>${label}</option>`;
  return `<form class="appearance-form" method="get" action="/appearance">
  <div>
    <label for="appearance-mode" class="visually-hidden">Appearance</label>
    <select id="appearance-mode" name="mode">
      ${option("system", "System appearance")}
      ${option("light", "Light")}
      ${option("dark", "Dark")}
    </select>
  </div>
  <button type="submit">Apply</button>
  <input type="hidden" name="returnTo" value="${esc(returnTo)}">
</form>`;
}

/**
 * Render the complete page (exactly one h1 — provided by the page's
 * pageHead — with landmarks, skip link, the command dialog and the client
 * script).
 */
export function appShell(input: AppShellInput): string {
  const mode = input.mode ?? DEFAULT_MODE;
  const themeAttr =
    input.appearance === undefined || input.appearance === "system"
      ? ""
      : ` data-theme="${esc(input.appearance)}"`;
  const modeAttr = mode === DEFAULT_MODE ? "" : ` data-mode="${esc(mode)}"`;
  const returnTo = input.returnTo ?? input.activePath;
  return `<!doctype html>
<html lang="en"${themeAttr}${modeAttr}>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${esc(input.title)}</title>
  <style>${DASHBOARD_CSS}</style>
</head>
<body>
  <a class="skip-link" href="#main">Skip to main content</a>
  <div class="app-shell">
    <header class="app-header">
      <a class="brand" href="/">Zeck</a>
      <form class="command-bar" role="search" method="get" action="/command">
        <div>
          <label for="command-input" class="visually-hidden">Search or run a command</label>
          <input id="command-input" type="search" name="q" placeholder="Search or run a command" value="${
            input.searchEcho === undefined ? "" : esc(input.searchEcho)
          }">
        </div>
        <button type="submit">Search</button>
      </form>
      <button type="button" class="command-trigger" data-command-open>Command <kbd>Ctrl</kbd> <kbd>K</kbd></button>
      ${attentionIndicator(input.attention?.length ?? 0, "/attention")}
      <div class="header-utilities">
        ${modeSelectionForm(mode, returnTo)}
        ${renderAppearanceForm(input.appearance ?? "system", returnTo)}
      </div>
    </header>
    ${renderNav(input.activePath, mode)}
    <main id="main" class="app-main">
      ${input.mainContent}
    </main>
    <footer class="app-footer">
      <p>Zeck dashboard — a projection over the governed public API. Every view reads live through the Zeck SDK client; no facts are cached in this browser beyond navigation-only recents.</p>
    </footer>
  </div>
  ${commandDialog(mode)}
  <script src="/assets/client.js" defer></script>
</body>
</html>`;
}
