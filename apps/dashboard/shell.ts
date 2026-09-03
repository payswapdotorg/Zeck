/**
 * Zeck dashboard app shell (WORK-033) — the global page frame.
 *
 * One shell for every route: skip link (first focusable element), header
 * landmark (product name + global command/search form + appearance
 * control), nav landmark (the UX §3 information architecture as native
 * details/summary groups — the same DOM serves desktop's persistent
 * sidebar and tablet/mobile's collapsed menu, purely CSS-driven), the
 * `Attention` area at the top of the main landmark, and the footer.
 *
 * The active nav group is rendered open and the active item carries
 * `aria-current="page"`. The appearance preference is a presentation
 * cookie; the page frame itself holds NO state (M24).
 */

import { attentionArea, esc } from "./components";
import type { AttentionItem } from "./projection";
import { DASHBOARD_CSS } from "./tokens";

export interface NavItem {
  readonly label: string;
  readonly path: string;
  readonly description: string;
  readonly keywords: readonly string[];
}

export interface NavGroup {
  readonly label: string;
  readonly path: string;
  readonly keywords: readonly string[];
  readonly items: readonly NavItem[];
}

/** The UX §3 information architecture (nav + command-search index). */
export const NAV_GROUPS: readonly NavGroup[] = [
  {
    label: "Build",
    path: "/build",
    keywords: ["build", "create", "new"],
    items: [
      {
        label: "Executions",
        path: "/build/execution",
        description: "Describe an outcome; Zeck plans and executes it under policy.",
        keywords: ["execution", "run", "create", "outcome", "task"],
      },
      {
        label: "Agents",
        path: "/agents",
        description: "The governed agent inventory (read-only projection).",
        keywords: ["agent", "inventory", "versions"],
      },
      {
        label: "Deployments",
        path: "/build#deployments",
        description: "Persistent availability surfaces (not exposed by the public API yet).",
        keywords: ["deployment", "availability", "version"],
      },
      {
        label: "Workloads",
        path: "/build/workload",
        description: "Training and batch compute as governed executions (not exposed yet).",
        keywords: ["workload", "training", "batch", "compute"],
      },
    ],
  },
  {
    label: "Runs",
    path: "/runs",
    keywords: ["runs", "executions", "history"],
    items: [
      {
        label: "Active",
        path: "/runs/active",
        description: "Executions opened in this browser that are not terminal yet.",
        keywords: ["active", "running", "in-progress"],
      },
      {
        label: "History",
        path: "/runs/history",
        description: "Terminal executions opened in this browser.",
        keywords: ["history", "completed", "failed", "terminal", "past"],
      },
      {
        label: "Scheduled",
        path: "/runs/scheduled",
        description: "Scheduled runs (no scheduling surface in the public API yet).",
        keywords: ["scheduled", "future", "recurring"],
      },
    ],
  },
  {
    label: "Assets",
    path: "/assets",
    keywords: ["assets", "artifacts", "competences", "connections"],
    items: [
      {
        label: "Artifacts",
        path: "/assets/artifacts",
        description: "Output artifacts of executions you open (per-execution facts).",
        keywords: ["artifact", "file", "output", "result", "digest"],
      },
      {
        label: "Competences",
        path: "/assets/competences",
        description: "Reusable, evidence-backed ways of describing work (not exposed yet).",
        keywords: ["competence", "skill", "reusable", "procedure"],
      },
      {
        label: "Connections",
        path: "/assets/connections",
        description:
          "External tool and data connections (not exposed yet; secrets never rendered).",
        keywords: ["connection", "credential", "tool", "integration"],
      },
    ],
  },
  {
    label: "Improve",
    path: "/improve/insights",
    keywords: ["improve", "learning", "recommendations"],
    items: [
      {
        label: "Evaluations",
        path: "/improve/evaluations",
        description: "Evaluation records behind quality claims (not exposed yet).",
        keywords: ["evaluation", "scoring", "quality"],
      },
      {
        label: "Insights",
        path: "/improve/insights",
        description: "Recommendations to improve your workflows (not exposed yet).",
        keywords: ["insight", "recommendation", "improvement"],
      },
      {
        label: "Learning",
        path: "/improve/learning",
        description: "Learning telemetry (not exposed yet).",
        keywords: ["learning", "telemetry", "signal"],
      },
    ],
  },
  {
    label: "Admin",
    path: "/admin/policies",
    keywords: ["admin", "settings", "governance"],
    items: [
      {
        label: "Policies",
        path: "/admin/policies",
        description: "Rules and controls in user language (not exposed yet).",
        keywords: ["policy", "rules", "controls", "quality", "limits"],
      },
      {
        label: "Budgets",
        path: "/admin/budgets",
        description: "Spend management (not exposed yet).",
        keywords: ["budget", "spend", "limit", "cost"],
      },
      {
        label: "Team",
        path: "/admin/team",
        description: "Workspace members and roles (not exposed yet).",
        keywords: ["team", "members", "roles", "people"],
      },
      {
        label: "Environments",
        path: "/admin/environments",
        description: "Compute environments (not exposed yet).",
        keywords: ["environment", "compute", "substrate"],
      },
      {
        label: "Audit",
        path: "/admin/audit",
        description: "Audit records (not exposed yet).",
        keywords: ["audit", "records", "evidence"],
      },
    ],
  },
];

/** Flatten the IA tree into the command-search navigation index. */
export function navIndex(): readonly NavItem[] {
  return NAV_GROUPS.flatMap((group) => group.items);
}

function navGroupActive(group: NavGroup, activePath: string): boolean {
  if (activePath === group.path || activePath.startsWith(`${group.path}/`)) {
    return true;
  }
  return group.items.some((item) => {
    const itemPath = item.path.split("#")[0] ?? item.path;
    return activePath === itemPath || activePath.startsWith(`${itemPath}/`);
  });
}

function renderNav(activePath: string): string {
  const groups = NAV_GROUPS.map((group) => {
    const open = navGroupActive(group, activePath) ? " open" : "";
    const items = group.items
      .map((item) => {
        const itemPath = item.path.split("#")[0] ?? item.path;
        const current =
          activePath === itemPath || (itemPath !== "/" && activePath.startsWith(`${itemPath}/`))
            ? ' aria-current="page"'
            : "";
        return `<li><a href="${esc(item.path)}"${current}>${esc(item.label)}</a></li>`;
      })
      .join("\n      ");
    return `<details class="nav-group"${open}>
    <summary>${esc(group.label)}</summary>
    <ul>
      ${items}
    </ul>
  </details>`;
  }).join("\n  ");
  const homeCurrent = activePath === "/" ? ' aria-current="page"' : "";
  return `<nav class="app-nav" aria-label="Primary">
  <a class="nav-home" href="/"${homeCurrent}>Home</a>
  ${groups}
</nav>`;
}

export type Appearance = "system" | "light" | "dark";

export interface AppShellInput {
  readonly title: string;
  readonly activePath: string;
  readonly mainContent: string;
  readonly attention?: readonly AttentionItem[];
  readonly appearance?: Appearance;
  readonly searchEcho?: string;
  /** Current path for the no-script appearance fallback redirect. */
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
 * Render the complete page (exactly one h1 — provided by the page's main
 * content — with landmarks, skip link and the client script).
 */
export function appShell(input: AppShellInput): string {
  const themeAttr =
    input.appearance === undefined || input.appearance === "system"
      ? ""
      : ` data-theme="${esc(input.appearance)}"`;
  return `<!doctype html>
<html lang="en"${themeAttr}>
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
      ${renderAppearanceForm(input.appearance ?? "system", input.returnTo ?? input.activePath)}
    </header>
    ${renderNav(input.activePath)}
    <main id="main" class="app-main">
      ${attentionArea(input.attention ?? [])}
      ${input.mainContent}
    </main>
    <footer class="app-footer">
      <p>Zeck dashboard — a projection over the governed public API. Every view reads live through the Zeck SDK client; no facts are cached in this browser beyond navigation-only recents.</p>
    </footer>
  </div>
  <script src="/assets/client.js" defer></script>
</body>
</html>`;
}
