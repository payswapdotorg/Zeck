# DEP-033 browser-drive notes (step 6b — real-Chromium evidence)

Runner: scripts/browser-stack-dep033.ts (REAL API :3928 + REAL dashboard :3929, one SETTLED
execution `00000000-0000-7000-9000-000000000001`, one BARE non-terminal execution
`00000000-0000-7000-9000-000000000011`, credential authority seeded).
Driver: agent-browser 0.35.0 over real Chromium (headless). Measurements appended live
during the drive — this file IS checkpoint 6. Discipline: every measurement is written
to disk immediately after extraction.

## Environment facts

- Stack boot: `setsid nohup bun scripts/browser-stack-dep033.ts` (pid 16002); curl 200 on
  /console/quickstart and the run-detail URL before driving.
- Leftover orphan pid 3670 (browser-smoke-dep032.ts) holds 3921/3922 — no conflict with
  3928/3929; not touched during the drive.

## Persistence mechanism (harness note)

`setsid nohup ... &` does NOT survive this tool's command boundary (verified with a
`sleep 300` probe — reaped); a Bun `spawn(..., {detached: true}).unref()` DOES survive
(ppid 1, own session — same shape as the surviving DEP-032 orphan pid 3670). Stack
therefore booted via the latter (pid 16459): curl 200 on /console/quickstart and the
run-detail URL before driving. agent-browser 0.35.0 daemon + real Chromium
(chrome 152.0.7977.64, headless) persist across commands (daemon pid 16104).

## Surface 1 — /console/quickstart @ 1280x800 (desktop)

- Document: scrollWidth 1280 == clientWidth 1280 -> NO document-level horizontal scroll.
- Interactive elements: 87 in the DOM (incl. closed-disclosure nav links); the keyboard
  tab cycle is 36 stops (closed `details` groups correctly keep their links out of the
  tab order; the open Develop group exposes its 9 links).
- Tab order (36 stops, verified by driving Tab to wraparound at stop 37 -> body):
  skip-link "Skip to main content" -> brand "Zeck" -> command input -> Search ->
  Command Ctrl K -> experience-mode select -> Apply -> appearance-mode select -> Apply ->
  nav Home -> group summaries Work/Build/Develop -> Develop links (Quickstart,
  Applications, Playground, Executions, Usage & economics, Validation Lab, Providers,
  Docs, Settings) -> summaries Library/Trust/Control/Improve -> breadcrumb Home ->
  Develop -> "Run the first sandbox executio[n]" -> Applications -> "API keys &
  credentials" -> "playground's text family" -> "execution explorer" -> Evidence ->
  artifacts -> docs -> body (cycle restarts). DOM order == tab order throughout
  (zero tabIndex>0 escapes observed).
- Focus visibility: ALL 36/36 tab stops render a visible focus indicator — computed
  outline "solid 2px rgb(11, 98, 196)" (= --focus-ring #0b62c4) on every stop,
  including the skip-link (which becomes visible on focus), native summary disclosures,
  selects and inputs.
- Table semantics: 1 table.kv, 8 rows, rendered 878px wide, scrollWidth == clientWidth
  (no overflow at desktop). Accessibility tree roles verified separately (see below).
- Touch targets: every DISCRETE control >= 24x24: smallest observed = nav links
  229x33, buttons 79x43 ("Apply"), selects 193x39, "Run the first sandbox exec"
  288x43, command input 226x43. Below 24px height ONLY inline prose links (h 19-22px,
  w 37-194px: "Home", "Develop", "Applications", "API keys & credentials",
  "playground's text family", "execution explorer", "Evidence", "artifacts", "docs")
  — WCAG 2.5.8 inline-text exception class; recorded, not a defect.
- Page errors: none (agent-browser errors empty). Console: no errors.
- A11y tree (quickstart): the kv table exposes FULL table semantics under display:block —
  `table` role with 8 `row` children, each `rowheader` + `cell` (e.g. rowheader
  "Budget ceiling" / cell "$2.00 per run ..."). The five-step journey renders as an
  ordered `list` with 5 `listitem [level=1]` + ListMarker "1.".."5." (the D7 fix:
  ol.steps grid change preserved list semantics). Skip target, main landmark, nav
  landmarks all present in the tree.

## Surface 2 — /console/applications/keys (+ issue -> reveal journey) @ 1280x800

- Document: no horizontal scroll (scrollWidth 1280 == clientWidth). 90 interactive
  elements; 4 tables (kv 4-row transport-credential table, data 2-row credential list,
  kv 2-row, data 6-row connections) — none overflow at desktop; a11y tree exposes
  columnheader roles (Label / Credential identity / Scope / ... / Rotation / Actions)
  and the honest empty state AS A CELL ("No credentials are issued for this application
  scope ... Issue one below — the secret is shown exactly once, at creation.").
- Issue form a11y wiring (D2/D5): textbox "Label" [required] carries
  aria-describedby -> credential-label-help; combobox "Role scope" (member/owner/admin);
  button "Issue credential".
- Empty-submit gate: clicking "Issue credential" with an empty label does NOT leave the
  page — the browser's native required validation holds (validity.valueMissing=true,
  willValidate=true, form.noValidate=false). The server-rendered field-error path
  (D3) is additionally pinned by the 36-test unit suite + lead smoke 29/29.
- Issue -> reveal journey (mouse-equivalent drive): filled Label "browser-drive key 1",
  selected Role scope "owner", submitted -> 303 to /console/applications/keys/issue.
  Reveal page: h1 "Credential issued — the secret, shown once"; region "This is the
  only time this secret is shown"; the copy affordance is a readonly mono text input
  (value zeck-test-secret-00000001, visually-hidden label "The new secret (select and
  copy)", aria-describedby -> secret-help); secret NOT in URL, NOT in title; credential
  record renders as a kv table with rowheader/cell roles (Label / Credential identity /
  Role scope / Permission scope ...). role="status" aria-live="polite" live region
  present ("The credential was issued. The secret below is shown exactly once.").
- Show-once doctrine (reload probe): reloading the reveal URL re-renders the honest
  replay state — h1 "Credential issuance — replayed outcome", secret GONE from the DOM
  (no #credential-secret input), status live region explains the idempotent replay and
  names the DEP-011 show-once contract. Verified with a real reload.
- Touch targets: all discrete controls >= 24x24 (issue form inputs/buttons full-size);
  only inline prose links below 24px (h 19-22px) — WCAG 2.5.8 inline exception.
- Observation (NOT a defect, no code change): the reveal copy-field is
  `input[type=text][readonly]` without autocomplete="off" — readonly text fields are
  skipped by Chromium autofill and are not password-manager material; the show-once +
  esc()-escaping + readonly triad is pinned by the unit suite. Recorded here for the
  Lead as a possible future belt-and-braces attribute.

## Surface 3 — /console/playground/text (choose -> compose -> review -> run -> inspect) @ 1280x800

- Document: no horizontal scroll (1280 == 1280); 87 interactive elements; 4 tables
  (data availability 2-row, kv advertised contract 3-row, kv sandbox envelope 8-row,
  kv example 4-row) — all fit at desktop; a11y tree exposes columnheader/rowheader/cell.
- Composer (D9 verified in-browser): every field label renders at computed
  font-weight 600 — the editable <label> fields (Application id, Compute environment,
  Spend limit, task.doc, task.maxWords) AND the fixed-by-contract p.form-label
  ("task.kind — fixed by the advertised contract") — one composed form, one weight.
- Server-side validation drive (D2+D3 verified in-browser): submitted Spend limit "50"
  -> the page re-renders with the field error "Sandbox runs are capped at $2.00 per
  execution — enter a lower ceiling." (.field-error styling) AND the control gains
  aria-describedby="pf-spend-error" pointing at that error (the D2 conditional wiring:
  described-by appears exactly when the error exists). The GET form keeps the whole
  review state in the URL (no-script foundation).
- Journey (mouse-equivalent + semantic-locator drive): Spend limit corrected to "1" ->
  "Review the sandbox run" -> review step renders ("Proposed sandbox run", "Run this
  sandbox execution?", the composed request preview) -> "Run sandbox execution" (POST)
  -> 303 redirect to /runs/00000000-0000-7000-9000-000000000013 with h1
  "<id> Created" — the inspect step.
- New-run detail (CREATED status): no horizontal scroll; navigation "Execution views"
  (Result / Evidence / Activity / Inspection); kv status table exposes rowheader/cell
  with the honest non-terminal state ("Terminal at — (still in progress)"); region
  "Can you trust it?" with drill-down links; "Cancel this execution…" affordance present.
- Harness observation (NOT a console defect): an agent-browser ref (@e24) resolved
  against the error re-render did not submit on first click; re-driving via the
  semantic locator (find role button --name) worked. Driver-side quirk, recorded for
  honesty; the form itself submits correctly every time.
- Touch targets: all discrete controls >= 24x24; only inline prose/breadcrumb links
  below 24px height (19-22px) — WCAG 2.5.8 inline exception.
