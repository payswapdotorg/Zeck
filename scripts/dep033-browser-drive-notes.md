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
