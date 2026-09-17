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

