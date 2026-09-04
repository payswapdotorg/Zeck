/**
 * Zeck dashboard design tokens — the ONE stylesheet (WORK-033, extended
 * as the WORK-035 experience foundation).
 *
 * A semantic token system (UX-IMPLEMENTATION-PLAN "Visual system"):
 * spacing, radius, surface, text, border, focus, status, attention,
 * success, warning, error, shadow and motion are expressed as CSS custom
 * properties; every component consumes the semantics, never raw values.
 *
 * WORK-035 foundation layer (UX-EXPERIENCE-ARCHITECTURE-V2): adds the
 * overlay/sheet/dialog surface tokens, the sidebar and touch-target size
 * tokens, the attention-kind vocabulary (decision / approval / failed /
 * recommendation), the breadcrumb + page-title treatment, the experience
 * mode selector, the header attention indicator, the global command
 * dialog (the Cmd/Ctrl+K second front door) and the confirmation
 * (consequence preview) presentation. All rules consume the SAME semantic
 * tokens — no component-specific one-off hierarchy.
 *
 * Appearance: light is the default root palette; dark applies through
 * `[data-theme="dark"]` (the explicit user choice) or through the system
 * preference when no explicit choice exists (`prefers-color-scheme` with
 * `:root:not([data-theme])`). `color-scheme` is declared so native form
 * controls follow the same appearance.
 *
 * Responsive behavior (UX-ARCHITECTURE §22): desktop (>1024px) keeps the
 * persistent sidebar; tablet (641–1024px) collapses navigation into a
 * disclosure-based menu bar; mobile (≤640px) is a single column with
 * ≥44px (2.75rem) touch targets on primary interactive elements.
 *
 * Accessibility (UX-ARCHITECTURE §23): rem-based typography (text scales
 * with user font settings), `:focus-visible` outlines on every focusable
 * element, status color is always paired with symbol+text in the markup,
 * and all motion is gated by `prefers-reduced-motion`.
 *
 * Calm and content-first (UX-ARCHITECTURE §28): flat restrained surfaces,
 * no gradients, color reserved for state and attention.
 */

export const DASHBOARD_CSS = `
*, *::before, *::after { box-sizing: border-box; }
html { font-size: 100%; }
body {
  margin: 0;
  font-family: var(--font-stack);
  font-size: 1rem;
  line-height: 1.55;
  color: var(--text-primary);
  background: var(--surface-page);
}
h1, h2, h3, h4 { line-height: 1.25; margin: 0 0 var(--space-3); font-weight: 600; }
h1 { font-size: 1.5rem; }
h2 { font-size: 1.25rem; margin-top: var(--space-6); }
h3 { font-size: 1.0625rem; margin-top: var(--space-5); }
h4 { font-size: 1rem; margin-top: var(--space-4); }
p { margin: 0 0 var(--space-3); max-width: 70ch; }
ul, ol { margin: 0 0 var(--space-3); padding-left: 1.25rem; }
a { color: var(--link); text-decoration: underline; text-underline-offset: 2px; }
a:hover { text-decoration-thickness: 2px; }
code, .mono { font-family: var(--font-mono); font-size: 0.9em; }
.muted { color: var(--text-muted); }
hr { border: 0; border-top: 1px solid var(--border-subtle); margin: var(--space-5) 0; }

:root {
  color-scheme: light dark;
  --font-stack: system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", sans-serif;
  --font-mono: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  --space-1: 0.25rem; --space-2: 0.5rem; --space-3: 0.75rem; --space-4: 1rem;
  --space-5: 1.5rem; --space-6: 2rem; --space-7: 3rem;
  --radius-sm: 0.25rem; --radius-md: 0.5rem; --radius-lg: 0.75rem;
  /* WORK-035 foundation size tokens: the persistent sidebar width and the */
  /* minimum touch target (UX v2 §27–28) are semantic, not one-off values. */
  --sidebar-width: 16rem;
  --touch-target: 2.75rem;
  --surface-page: #f6f6f3;
  --surface-raised: #ffffff;
  --surface-sunken: #ebebe7;
  --text-primary: #1f2328;
  --text-secondary: #525a63;
  --text-muted: #6b7280;
  --border-subtle: #d9d9d4;
  --border-strong: #a9b0a8;
  --link: #0b62c4;
  --focus-ring: #0b62c4;
  --status-ok: #1a7f37;
  --status-info: #0b62c4;
  --status-warn: #96590b;
  --status-error: #c02d2d;
  --attention-bg: #fdf6d8;
  --attention-border: #d9ac2c;
  --success-bg: #e9f3ea;
  --warning-bg: #fbf1d5;
  --error-bg: #fbe6e6;
  /* WORK-035: the overlay family (dialog/sheet/command surfaces) and the */
  /* decision/approval/recommendation attention-kind accents. */
  --overlay-scrim: rgba(20, 24, 28, 0.45);
  --attention-decision: #0b62c4;
  --attention-approval: #96590b;
  --attention-recommendation: #1a7f37;
  --shadow-card: 0 1px 2px rgba(20, 24, 28, 0.06), 0 1px 3px rgba(20, 24, 28, 0.04);
  --shadow-overlay: 0 8px 30px rgba(20, 24, 28, 0.18);
  --motion-fast: 120ms;
  --motion-slow: 240ms;
  --ease: cubic-bezier(0.2, 0, 0.1, 1);
}
[data-theme="light"] { color-scheme: light; }
[data-theme="dark"] {
  color-scheme: dark;
  --surface-page: #14181d;
  --surface-raised: #1c2127;
  --surface-sunken: #242a31;
  --text-primary: #e4e9ee;
  --text-secondary: #a9b3bd;
  --text-muted: #8a95a1;
  --border-subtle: #2f3742;
  --border-strong: #4a5560;
  --link: #6cb2f5;
  --focus-ring: #6cb2f5;
  --status-ok: #57c072;
  --status-info: #6cb2f5;
  --status-warn: #d9a848;
  --status-error: #ee7b7b;
  --attention-bg: #33290f;
  --attention-border: #7a6324;
  --attention-decision: #6cb2f5;
  --attention-approval: #d9a848;
  --attention-recommendation: #57c072;
  --success-bg: #12291a;
  --warning-bg: #2d2612;
  --error-bg: #331a1a;
  --overlay-scrim: rgba(0, 0, 0, 0.55);
  --shadow-card: 0 1px 2px rgba(0, 0, 0, 0.4);
  --shadow-overlay: 0 8px 30px rgba(0, 0, 0, 0.55);
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme]) {
    color-scheme: dark;
    --surface-page: #14181d;
    --surface-raised: #1c2127;
    --surface-sunken: #242a31;
    --text-primary: #e4e9ee;
    --text-secondary: #a9b3bd;
    --text-muted: #8a95a1;
    --border-subtle: #2f3742;
    --border-strong: #4a5560;
    --link: #6cb2f5;
    --focus-ring: #6cb2f5;
    --status-ok: #57c072;
    --status-info: #6cb2f5;
    --status-warn: #d9a848;
    --status-error: #ee7b7b;
    --attention-bg: #33290f;
    --attention-border: #7a6324;
    --attention-decision: #6cb2f5;
    --attention-approval: #d9a848;
    --attention-recommendation: #57c072;
    --success-bg: #12291a;
    --warning-bg: #2d2612;
    --error-bg: #331a1a;
    --overlay-scrim: rgba(0, 0, 0, 0.55);
    --shadow-card: 0 1px 2px rgba(0, 0, 0, 0.4);
    --shadow-overlay: 0 8px 30px rgba(0, 0, 0, 0.55);
  }
}

:focus-visible {
  outline: 2px solid var(--focus-ring);
  outline-offset: 2px;
  border-radius: var(--radius-sm);
}
.skip-link {
  position: absolute;
  left: -100vw;
  top: 0;
  z-index: 20;
  background: var(--surface-raised);
  color: var(--text-primary);
  padding: var(--space-2) var(--space-4);
  border: 2px solid var(--focus-ring);
  border-radius: var(--radius-sm);
  text-decoration: none;
}
.skip-link:focus { left: var(--space-2); top: var(--space-2); }
.visually-hidden {
  position: absolute;
  width: 1px; height: 1px; margin: -1px; padding: 0;
  overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; border: 0;
}

.app-shell {
  min-height: 100vh;
  display: grid;
  grid-template-columns: 1fr;
  grid-template-areas:
    "header"
    "nav"
    "main"
    "footer";
}
.app-header {
  grid-area: header;
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-3);
  align-items: center;
  padding: var(--space-3) var(--space-5);
  background: var(--surface-raised);
  border-bottom: 1px solid var(--border-subtle);
}
.brand { font-weight: 700; font-size: 1.125rem; color: var(--text-primary); text-decoration: none; }
.command-bar { display: flex; gap: var(--space-2); flex: 1 1 18rem; min-width: 12rem; }
.command-bar input { flex: 1 1 auto; min-width: 0; }
.appearance-form { display: flex; gap: var(--space-2); align-items: center; }

.app-nav {
  grid-area: nav;
  background: var(--surface-raised);
  border-bottom: 1px solid var(--border-subtle);
  padding: var(--space-2) var(--space-5);
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
  align-items: flex-start;
}
.nav-home { font-weight: 600; padding: var(--space-2) var(--space-3); }
.nav-group {
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-md);
  background: var(--surface-page);
  min-width: 8.5rem;
}
.nav-group > summary {
  padding: var(--space-2) var(--space-3);
  font-weight: 600;
  list-style: none;
  cursor: pointer;
}
.nav-group > summary::-webkit-details-marker { display: none; }
.nav-group > summary::after { content: " \\25be"; color: var(--text-muted); }
.nav-group[open] > summary { border-bottom: 1px solid var(--border-subtle); }
.nav-group > ul { margin: 0; padding: var(--space-2) 0; list-style: none; }
.nav-group > ul li a {
  display: block;
  padding: var(--space-1) var(--space-3);
  text-decoration: none;
  color: var(--text-secondary);
}
.nav-group > ul li a:hover { color: var(--text-primary); text-decoration: underline; }
.nav-group > ul li a[aria-current="page"] {
  color: var(--text-primary);
  font-weight: 600;
  background: var(--surface-raised);
  box-shadow: inset 2px 0 0 var(--focus-ring);
}

.app-main {
  grid-area: main;
  padding: var(--space-5);
  width: 100%;
  max-width: 74rem;
  margin: 0 auto;
}
.app-footer {
  grid-area: footer;
  padding: var(--space-4) var(--space-5);
  border-top: 1px solid var(--border-subtle);
  color: var(--text-muted);
  font-size: 0.875rem;
}

.attention-area { display: grid; gap: var(--space-3); margin-bottom: var(--space-5); }
.attention-card {
  border: 1px solid var(--attention-border);
  border-left: 4px solid var(--attention-border);
  background: var(--attention-bg);
  border-radius: var(--radius-md);
  padding: var(--space-3) var(--space-4);
  box-shadow: var(--shadow-card);
}
.attention-card.attention-failed {
  border-color: var(--status-error);
  border-left-color: var(--status-error);
  background: var(--error-bg);
}
.attention-card .card-title { margin: 0 0 var(--space-1); font-weight: 600; }
.attention-card .card-body { margin: 0 0 var(--space-2); color: var(--text-secondary); }
.attention-card .card-actions { display: flex; flex-wrap: wrap; gap: var(--space-4); margin: 0; }

.card {
  background: var(--surface-raised);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-lg);
  padding: var(--space-4) var(--space-5);
  box-shadow: var(--shadow-card);
  margin-bottom: var(--space-5);
}

table.data, table.kv {
  border-collapse: collapse;
  width: 100%;
  margin: var(--space-3) 0;
  font-size: 0.95rem;
}
th, td { text-align: left; padding: var(--space-2) var(--space-3); border-bottom: 1px solid var(--border-subtle); vertical-align: top; }
th { color: var(--text-secondary); font-weight: 600; }
table.data thead th { border-bottom: 2px solid var(--border-strong); }

.badge {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  padding: 0.125rem var(--space-2);
  border-radius: 999px;
  border: 1px solid var(--border-subtle);
  font-size: 0.875rem;
  white-space: nowrap;
}
.badge .symbol { font-size: 1rem; line-height: 1; }
.status-COMPLETED { color: var(--status-ok); border-color: var(--status-ok); background: var(--success-bg); }
.status-FAILED { color: var(--status-error); border-color: var(--status-error); background: var(--error-bg); }
.status-CANCELLED, .status-EXPIRED,
.status-WAITING_TOOL, .status-WAITING_USER, .status-WAITING_HUMAN {
  color: var(--status-warn); border-color: var(--status-warn); background: var(--warning-bg);
}
.status-CREATED, .status-AUTHORIZED, .status-PLANNING, .status-QUEUED,
.status-RUNNING, .status-REPLANNING, .status-VERIFYING {
  color: var(--status-info); border-color: var(--status-info);
}
.chip {
  display: inline-block;
  padding: 0 var(--space-2);
  border-radius: var(--radius-sm);
  font-size: 0.875rem;
  border: 1px solid var(--border-subtle);
  background: var(--surface-sunken);
}
.chip-derived { color: var(--status-ok); border-color: var(--status-ok); background: var(--success-bg); }

.execution-header { margin-bottom: var(--space-3); }
.execution-header .title-line { display: flex; flex-wrap: wrap; gap: var(--space-3); align-items: center; }
.execution-header h1 { margin: 0; }
.execution-header .facts { display: flex; flex-wrap: wrap; gap: var(--space-2) var(--space-5); color: var(--text-secondary); margin-top: var(--space-2); }
.fact { display: inline-flex; gap: var(--space-1); align-items: baseline; }
.fact .fact-label {
  color: var(--text-muted);
  font-size: 0.75rem;
  text-transform: uppercase;
  letter-spacing: 0.05em;
}

/* WORK-036 AC5: the four-axis trust strip (separate facts, never a score). */
.trust-strip {
  list-style: none;
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-1) var(--space-5);
  margin: var(--space-2) 0 0;
  padding: 0;
  color: var(--text-secondary);
  font-size: 0.875rem;
}
.trust-strip li { display: inline-flex; gap: var(--space-1); align-items: baseline; }
.trust-strip .axis-kind {
  color: var(--text-muted);
  font-size: 0.75rem;
  text-transform: uppercase;
  letter-spacing: 0.05em;
}
.trust-strip .axis-fact { color: var(--text-secondary); }

/* WORK-036 AC2/AC3: the composer's secondary affordances + the review envelope. */
.composer-secondary { margin-top: var(--space-2); border: 1px solid var(--border-subtle); border-radius: var(--radius-md); padding: var(--space-2) var(--space-3); background: var(--surface-sunken); }
.composer-secondary > summary { color: var(--text-secondary); font-weight: 600; cursor: pointer; }
.composer-affordance { color: var(--text-muted); font-size: 0.875rem; margin: var(--space-2) 0 0; }
.review-envelope h3 { margin: var(--space-4) 0 var(--space-1); }
.review-envelope p { margin: var(--space-1) 0; }

/* WORK-036 AC8/AC10: the wait decision + the failure distinction surfaces. */
.wait-question { font-size: 1.05rem; margin: var(--space-1) 0 var(--space-2); }
.decision-consequences { margin: var(--space-2) 0; padding: var(--space-2) var(--space-3); border-left: 3px solid var(--border-strong); }
.decision-consequences p { margin: var(--space-1) 0; }
.failure-dimension { margin: var(--space-1) 0; }
.recovery-fact { margin: var(--space-2) 0; padding: var(--space-2) var(--space-3); border-left: 3px solid var(--border-strong); background: var(--surface-sunken); }
.failure-distinction { color: var(--text-muted); font-size: 0.875rem; margin: var(--space-2) 0; }
.quality-failure-surface h3 { margin-top: 0; }

/* WORK-037: the at-a-glance grids (agent/deployment), the training/
 * evaluation/release distinction list and the long-running workload view. */
.glance-grid { display: grid; gap: var(--space-3); grid-template-columns: repeat(auto-fill, minmax(17rem, 1fr)); margin: var(--space-3) 0; }
.glance-cell { background: var(--surface-raised); border: 1px solid var(--border-subtle); border-radius: var(--radius-md); padding: var(--space-3); }
.glance-cell h4 { margin: 0 0 var(--space-1); }
.glance-cell p { margin: 0 0 var(--space-1); font-size: 0.9375rem; }
.glance-kind { color: var(--text-muted); font-size: 0.75rem; text-transform: uppercase; letter-spacing: 0.05em; margin: 0; }
.distinction-list { list-style: none; margin: var(--space-2) 0; padding: 0; }
.distinction-list li { display: grid; gap: var(--space-1); border-bottom: 1px dashed var(--border-subtle); padding: var(--space-2) 0; }
.distinction-list li:last-child { border-bottom: none; }
.distinction-state { font-weight: 600; }
.distinction-fact { color: var(--text-secondary); }
.workload-facts { margin: var(--space-4) 0; padding: var(--space-3) var(--space-4); border: 1px solid var(--border-subtle); border-radius: var(--radius-lg); background: var(--surface-raised); }
.workload-facts h2 { margin-top: 0; }
.workload-facts h3 { margin: var(--space-3) 0 var(--space-1); }

/* WORK-038: the trust presentation — the result-view trust summary, the
 * evidence-ref links (linked only where a public artifact exists), the
 * lineage chains and the contextual traversal strip. Every rule consumes
 * the same tokens; no one-off hierarchy. */
.trust-summary { margin: var(--space-3) 0; padding: var(--space-3) var(--space-4); border: 1px solid var(--border-subtle); border-radius: var(--radius-lg); background: var(--surface-raised); }
.trust-summary h3 { margin-top: 0; }
.trust-summary-lead { color: var(--text-secondary); margin: var(--space-1) 0 var(--space-2); }
.trust-summary-axes { list-style: none; margin: 0 0 var(--space-2); padding: 0; }
.trust-summary-axis { display: grid; gap: var(--space-1); border-bottom: 1px dashed var(--border-subtle); padding: var(--space-2) 0; grid-template-columns: 1fr; }
.trust-summary-axis:last-child { border-bottom: none; }
.trust-summary-chip { margin: var(--space-1) 0; color: var(--text-secondary); }
.trust-summary-note, .trust-note { color: var(--text-muted); font-size: 0.875rem; margin: var(--space-2) 0 0; }
.axis-evidence { font-size: 0.875rem; }
.evidence-ref { font-family: var(--font-mono); font-size: 0.875rem; word-break: break-all; }
.evidence-ref-plain { color: var(--text-secondary); }
.lineage-list { list-style: none; margin: var(--space-2) 0; padding: 0; }
.lineage-list li { padding: var(--space-1) 0; border-bottom: 1px dashed var(--border-subtle); }
.lineage-list li:last-child { border-bottom: none; }
.lineage-chains { list-style: none; margin: var(--space-3) 0; padding: 0; }
.lineage-chain { display: grid; gap: var(--space-2); border: 1px solid var(--border-subtle); border-radius: var(--radius-md); padding: var(--space-3); margin-bottom: var(--space-3); background: var(--surface-raised); grid-template-columns: 1fr; }
.lineage-step { display: grid; gap: var(--space-1); }
.context-traversal { display: flex; flex-wrap: wrap; gap: var(--space-1) var(--space-3); align-items: baseline; margin: var(--space-2) 0 var(--space-3); padding: var(--space-2) var(--space-3); border: 1px dashed var(--border-subtle); border-radius: var(--radius-md); }
@media (max-width: 640px) {
  .trust-summary { padding: var(--space-2) var(--space-3); }
  .lineage-chain { padding: var(--space-2); }
}

.timeline { list-style: none; margin: var(--space-3) 0; padding: 0; }
.timeline li {
  display: grid;
  grid-template-columns: 9rem 1fr;
  gap: var(--space-3);
  padding: var(--space-2) 0;
  border-bottom: 1px dashed var(--border-subtle);
}
.timeline time { color: var(--text-muted); font-family: var(--font-mono); font-size: 0.85rem; }
.timeline .stage { font-weight: 600; }
.timeline .stage-detail { color: var(--text-secondary); }

.tabs {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
  border-bottom: 1px solid var(--border-strong);
  margin: var(--space-4) 0;
}
.tabs a {
  padding: var(--space-2) var(--space-4);
  text-decoration: none;
  color: var(--text-secondary);
  border: 1px solid transparent;
  border-bottom: none;
  border-radius: var(--radius-sm) var(--radius-sm) 0 0;
}
.tabs a[aria-current="page"] {
  color: var(--text-primary);
  font-weight: 600;
  border-color: var(--border-subtle);
  background: var(--surface-raised);
  box-shadow: inset 0 -2px 0 var(--focus-ring);
}

details.why-panel, details.advanced {
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-md);
  background: var(--surface-raised);
  padding: var(--space-3) var(--space-4);
  margin: var(--space-4) 0;
}
details.advanced { background: var(--surface-sunken); }
details.why-panel > summary, details.advanced > summary { font-weight: 600; cursor: pointer; }
details.why-panel > summary::-webkit-details-marker, details.advanced > summary::-webkit-details-marker { display: none; }
details.why-panel > summary::after, details.advanced > summary::after { content: " \\25be"; color: var(--text-muted); }

.state {
  border: 1px dashed var(--border-strong);
  border-radius: var(--radius-md);
  padding: var(--space-4);
  margin: var(--space-4) 0;
  color: var(--text-secondary);
  background: var(--surface-raised);
}
.state .state-title { font-weight: 600; margin: 0 0 var(--space-1); color: var(--text-primary); }
.state .state-body { margin: 0; }
.state .state-source { margin: var(--space-1) 0 0; color: var(--text-muted); font-size: 0.875rem; }

.command-results { list-style: none; margin: var(--space-3) 0; padding: 0; }
.command-results li { border-bottom: 1px solid var(--border-subtle); }
.command-results a { display: block; padding: var(--space-3); text-decoration: none; }
.command-results a:hover { background: var(--surface-raised); text-decoration: underline; }
.command-results .result-kind { display: block; color: var(--text-muted); font-size: 0.8rem; }
.command-example { font-family: var(--font-mono); font-size: 0.9rem; }

form.flow { display: grid; gap: var(--space-4); max-width: 44rem; }
.form-field { display: grid; gap: var(--space-1); }
.form-field > label { font-weight: 600; }
.form-hint { color: var(--text-muted); font-size: 0.875rem; }
.field-error { color: var(--status-error); font-size: 0.875rem; }
.live-region { color: var(--status-error); font-weight: 600; }
.form-actions { display: flex; flex-wrap: wrap; gap: var(--space-3); }

.actions { display: flex; flex-wrap: wrap; gap: var(--space-3); margin-top: var(--space-3); }
.suggested { display: flex; flex-wrap: wrap; gap: var(--space-3); margin-top: var(--space-3); }

input, select, textarea, button { font: inherit; color: inherit; }
input, select, textarea {
  background: var(--surface-raised);
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-sm);
  padding: var(--space-2) var(--space-3);
}
textarea { min-height: 6rem; resize: vertical; }
button {
  background: var(--surface-raised);
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-sm);
  padding: var(--space-2) var(--space-4);
  cursor: pointer;
  transition: background var(--motion-fast) var(--ease), border-color var(--motion-fast) var(--ease);
}
button:hover { border-color: var(--focus-ring); }
button.primary { background: var(--focus-ring); color: #ffffff; border-color: var(--focus-ring); }
button.danger { color: var(--status-error); border-color: var(--status-error); }

.tiles { display: grid; gap: var(--space-4); grid-template-columns: repeat(auto-fill, minmax(16rem, 1fr)); }
.tile {
  background: var(--surface-raised);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-lg);
  padding: var(--space-4);
  box-shadow: var(--shadow-card);
}
.tile h3 { margin-top: 0; }
.tile p { margin-bottom: var(--space-2); }

pre.raw {
  background: var(--surface-sunken);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-sm);
  padding: var(--space-3);
  overflow-x: auto;
  font-family: var(--font-mono);
  font-size: 0.85rem;
}
.detail-grid { display: grid; gap: var(--space-5); grid-template-columns: 1fr; align-items: start; }
.runs-list { list-style: none; margin: 0; padding: 0; }
.runs-list li { border-bottom: 1px solid var(--border-subtle); padding: var(--space-3) 0; }
.runs-list .run-line { display: flex; flex-wrap: wrap; gap: var(--space-3); align-items: baseline; }
.runs-list .run-title { font-weight: 600; }

/* ===========================================================================
 * WORK-035 experience foundation (UX-EXPERIENCE-ARCHITECTURE-V2)
 * All rules below consume the SAME semantic tokens as the WORK-033 layer.
 * =========================================================================== */

/* --- Attention kinds (v2 §23): decision / approval / failed /
 * recommendation. Color is per-kind but NEVER the only signal — the markup
 * always pairs a symbol + kind label with the text. */
.attention-card.attention-decision {
  border-color: var(--attention-decision);
  border-left-color: var(--attention-decision);
}
.attention-card.attention-approval {
  border-color: var(--attention-approval);
  border-left-color: var(--attention-approval);
  background: var(--warning-bg);
}
.attention-card.attention-recommendation {
  border-color: var(--attention-recommendation);
  border-left-color: var(--attention-recommendation);
  background: var(--success-bg);
}
.attention-kind {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  font-size: 0.8125rem;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--text-muted);
}
.attention-summary { list-style: none; margin: var(--space-2) 0 0; padding: 0; display: grid; gap: var(--space-1); }
.attention-summary li { display: flex; gap: var(--space-2); align-items: baseline; }
.attention-summary .kind-count { font-weight: 700; min-width: 1.5rem; }

/* --- Header attention indicator (v2 §2): visible only when action is
 * required; symbol + text, never color alone. */
.attention-indicator {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  padding: var(--space-1) var(--space-3);
  border: 1px solid var(--attention-border);
  border-radius: 999px;
  background: var(--attention-bg);
  color: var(--text-primary);
  text-decoration: none;
  font-weight: 600;
}
.attention-indicator:hover { text-decoration: underline; }
.attention-indicator .count {
  display: inline-block;
  min-width: 1.25rem;
  text-align: center;
  background: var(--attention-border);
  color: var(--surface-raised);
  border-radius: 999px;
  font-size: 0.8125rem;
  padding: 0 var(--space-1);
}

/* --- Header utilities: the experience-mode selector (v2 §25 — a
 * presentation preference, exactly like appearance). */
.header-utilities { display: flex; flex-wrap: wrap; gap: var(--space-2); align-items: center; margin-left: auto; }
.mode-form { display: flex; gap: var(--space-2); align-items: center; }
.mode-form select { min-width: 9rem; }

/* --- Command trigger + kbd hint (v2 §7). */
.command-trigger {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-2) var(--space-3);
}
kbd {
  font-family: var(--font-mono);
  font-size: 0.75rem;
  border: 1px solid var(--border-strong);
  border-bottom-width: 2px;
  border-radius: var(--radius-sm);
  padding: 0 var(--space-1);
  background: var(--surface-sunken);
  white-space: nowrap;
}

/* --- Native dialog family: the command surface and the sheet primitive.
 * The UA owns modal focus and Escape; the client script owns focus
 * restore (data-focus-return). Backdrop uses the scrim token. */
dialog.command-dialog,
dialog.sheet {
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-lg);
  background: var(--surface-raised);
  color: var(--text-primary);
  box-shadow: var(--shadow-overlay);
  padding: 0;
  max-width: min(36rem, calc(100vw - 2 * var(--space-4)));
}
dialog.command-dialog { width: 36rem; margin: 10vh auto auto auto; }
dialog.command-dialog::backdrop,
dialog.sheet::backdrop { background: var(--overlay-scrim); }
dialog.command-dialog .dialog-body { padding: var(--space-4); display: grid; gap: var(--space-3); }
dialog.command-dialog .dialog-title {
  margin: 0;
  font-size: 1rem;
  font-weight: 600;
  display: flex;
  justify-content: space-between;
  gap: var(--space-3);
  align-items: baseline;
}
dialog.command-dialog .dialog-title kbd { flex: none; }
dialog.command-dialog input[type="text"] { width: 100%; }
dialog.command-dialog .dialog-actions { display: flex; gap: var(--space-3); justify-content: flex-end; }
.command-suggestions { list-style: none; margin: 0; padding: 0; max-height: 16rem; overflow-y: auto; }
.command-suggestions li { border-bottom: 1px solid var(--border-subtle); }
.command-suggestions li[hidden] { display: none; }
.command-suggestions a {
  display: flex;
  justify-content: space-between;
  gap: var(--space-3);
  padding: var(--space-2) var(--space-3);
  text-decoration: none;
}
.command-suggestions a:hover { background: var(--surface-sunken); text-decoration: underline; }
.command-suggestions .suggestion-kind {
  color: var(--text-muted);
  font-size: 0.8rem;
  flex: none;
}
.command-suggestion-empty { margin: 0; padding: var(--space-3); color: var(--text-muted); }

/* --- Sheet primitive: the tablet/mobile focused panel (v2 §27). Desktop
 * docks right; mobile docks bottom full-width with touch-safe padding. */
dialog.sheet { width: min(28rem, calc(100vw - 2 * var(--space-3))); margin: auto 0 auto auto; height: 100dvh; max-height: 100dvh; border-radius: 0; border-right: none; }
dialog.sheet .sheet-body { padding: var(--space-4); display: grid; gap: var(--space-3); overflow-y: auto; height: 100%; }
dialog.sheet .sheet-head { display: flex; justify-content: space-between; align-items: baseline; gap: var(--space-3); }
dialog.sheet .sheet-head h2 { margin: 0; font-size: 1.125rem; }
dialog.sheet form.dialog-close { display: flex; justify-content: flex-end; }
dialog.sheet form.dialog-actions { display: flex; flex-wrap: wrap; gap: var(--space-3); justify-content: flex-end; }

/* --- Breadcrumb + page-title treatment (v2 §2, spec §2): contextual
 * orientation above the one h1, with room for one dominant primary
 * action. */
.page-head { display: grid; gap: var(--space-2); margin-bottom: var(--space-4); }
.breadcrumb { font-size: 0.875rem; }
.breadcrumb ol { list-style: none; display: flex; flex-wrap: wrap; gap: var(--space-2); margin: 0; padding: 0; align-items: baseline; }
.breadcrumb li { display: flex; gap: var(--space-2); align-items: baseline; }
.breadcrumb li + li::before { content: "\\203a"; color: var(--text-muted); }
.breadcrumb a { text-decoration: none; }
.breadcrumb a:hover { text-decoration: underline; }
.breadcrumb [aria-current="page"] { color: var(--text-primary); font-weight: 600; }
.page-head .title-line { display: flex; flex-wrap: wrap; gap: var(--space-3); align-items: center; justify-content: space-between; }
.page-head .title-line h1 { margin: 0; }
.page-actions { display: flex; flex-wrap: wrap; gap: var(--space-3); }
.page-actions .primary { background: var(--focus-ring); color: #ffffff; border-color: var(--focus-ring); }
a.button-link {
  display: inline-flex;
  align-items: center;
  padding: var(--space-2) var(--space-4);
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-sm);
  text-decoration: none;
  background: var(--surface-raised);
}
a.button-link:hover { border-color: var(--focus-ring); text-decoration: underline; }
a.button-link.danger { color: var(--status-error); border-color: var(--status-error); }

/* --- Loading state (spec §19): preserves page hierarchy — it renders
 * INSIDE main as a region with stage text and the retained context note;
 * it never replaces the shell. No spinner animation (calm + reduced
 * motion by construction). */
.state.state-loading { border-style: solid; border-color: var(--status-info); background: var(--surface-raised); }
.state.state-loading .state-stage { display: flex; gap: var(--space-2); align-items: baseline; font-weight: 600; color: var(--text-primary); }

/* --- Confirmation primitive (v2 §26, spec §5): the universal consequence
 * preview. Consequence, authorization, cost, reversibility and the
 * idempotency handling are stated BEFORE the single confirm button. */
.confirmation {
  border: 1px solid var(--status-warn);
  border-left: 4px solid var(--status-warn);
  border-radius: var(--radius-md);
  background: var(--surface-raised);
  padding: var(--space-4);
  margin: var(--space-4) 0;
  box-shadow: var(--shadow-card);
}
.confirmation .confirmation-title { margin: 0 0 var(--space-1); font-size: 1.125rem; font-weight: 700; }
.confirmation .confirmation-warning { color: var(--status-warn); font-weight: 600; margin: 0 0 var(--space-3); }
.confirmation .form-actions { margin-top: var(--space-3); display: flex; flex-wrap: wrap; gap: var(--space-3); align-items: center; }
.confirmation button.primary { background: var(--status-error); border-color: var(--status-error); color: #ffffff; }

@media (min-width: 1025px) {
  .app-shell {
    grid-template-columns: var(--sidebar-width) 1fr;
    grid-template-areas:
      "nav header"
      "nav main"
      "nav footer";
  }
  .app-nav {
    position: sticky;
    top: 0;
    height: 100vh;
    overflow-y: auto;
    flex-direction: column;
    padding: var(--space-4) var(--space-3);
    border-bottom: none;
    border-right: 1px solid var(--border-subtle);
  }
  .nav-home { padding: var(--space-2) var(--space-3); }
  .nav-group { width: 100%; }
  .app-main { padding: var(--space-6) var(--space-7); }
  .detail-grid { grid-template-columns: minmax(0, 2fr) minmax(16rem, 1fr); }
}
@media (max-width: 1024px) {
  .detail-grid { grid-template-columns: 1fr; }
  .app-nav { padding: var(--space-2) var(--space-3); }
  .app-header { padding: var(--space-3); }
}
@media (max-width: 640px) {
  .app-main { padding: var(--space-4) var(--space-3); }
  .app-header { padding: var(--space-3); }
  .command-bar { flex-basis: 100%; }
  h1 { font-size: 1.25rem; }
  .timeline li { grid-template-columns: 1fr; gap: var(--space-1); }
  .app-nav > a, .app-nav summary, .app-nav ul li a,
  .app-header button, .app-header input, .app-header select,
  .app-main button, .app-main input, .app-main select, .app-main textarea, .app-main summary,
  .tabs a, .command-results a, .actions a, .actions button, .suggested a,
  .command-suggestions a, .page-actions a, .page-actions button,
  .attention-indicator, a.button-link {
    min-height: var(--touch-target);
  }
  .app-nav > ul li a { display: flex; align-items: center; }
  dialog.command-dialog { margin: var(--space-3) auto; }
  dialog.sheet {
    width: 100vw;
    margin: auto 0 0 0;
    height: 90dvh;
    max-height: 90dvh;
    border-radius: var(--radius-lg) var(--radius-lg) 0 0;
    border-bottom: none;
  }
  dialog.sheet .sheet-body { padding-bottom: max(var(--space-4), env(safe-area-inset-bottom)); }
}
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
    scroll-behavior: auto !important;
  }
}
`;
