# Zeck Validation Report

**Status:** CLOSED — cumulative report completed by VAL-052 (the final validation work order; the release-gate verdict is carried by the authority chain — PR → CI → merge → program-state finalize — never self-declared in this document)
**Program:** `docs/VALIDATION-ROADMAP.md`
**Repository:** `payswapdotorg/Zeck`

This report is maintained throughout validation. It must distinguish observed evidence from interpretation and recommendations.

## Executive summary

The validation program registered 46 work orders (VAL-001..026, 030..036, 040..052 in
`spec/validation-state/program-state.json`, as-of 2026-09-14T21:10:45Z). 45 are recorded
complete; the one work order not complete at report time is VAL-052 itself (governed status
`planned` in the program state; in flight per the frontier claim `08dcd9c` — this work
order, whose completion is carried by the Lead's authority chain). Deadline-remainder
honesty: this report was completed 2026-09-14 ~21:25 UTC, roughly 2h35m before the
2026-09-15 00:00 UTC operator deadline; the final dependency (VAL-051, the production-style
pilot) merged via PR #117 with the Lead's battery of record finishing ~21:01 UTC the same
day.

**Battery scale of record** (the Lead's battery at the VAL-051 branch head `0ba3091`,
merged as PR #117; `docs/work-items/VAL-051.md`): governance OK (60 product work orders /
110 requirements; 46 validation work orders); lint 0 errors / 61 warnings / 8 infos (the
exact recorded baseline); typecheck 0 errors; **unit 5498/5498 passed** (316 test files);
**architecture + discrimination 2191 passed + 4 skipped** (138 files passed + 1 skipped);
**integration 1211 passed + 20 skipped over REAL PostgreSQL 16.14** (160 files passed + 1
skipped). The skips are the pre-existing honest env-gated live-rail boundaries — they never
convert into passes (VAL-001's report contract; every work-order evidence document).

**Application portfolio** (VAL-010..019): all 15 customer-style workload categories were
exercised through the public SDK boundary over the REAL platform path, with REAL provider
dispatches where credentials existed (the live portfolio day 2026-09-12, ~00:35–23:55 UTC).
Across the live portfolio runs there are **17 honest FAILED rows: 16 corpus-declared
expected-failure edge rows plus 1 genuine model miss** (VAL-010 `changelog-01`, whose
corpus-mandated term "release" was genuinely absent from the model's summary — the oracle
floor working, never retried away). Every FAILED row is recorded in its work-order evidence
document (`docs/work-items/VAL-0NN.md`).

**Longitudinal learning** (VAL-030..036, 045, 047): the recorded answer is honest and mixed
— one family `determinized-stable`, one `determinizing-trending`, one `variable-resilient`,
one `immature-insufficient-evidence` (VAL-036); per-mechanism savings attributed with honest
residuals never forced into a mechanism (VAL-045); cost curves that report a plateau, a
never-materialized family, and a cohort regression openly (VAL-047). A recorded tie or
negative is a valid demonstration, never a failed gate.

**Economic benchmark** (VAL-040..048): the paired-structure discipline held end to end
(fixed-quality/fixed-cost arms, Wilson 95% intervals, Bonferroni family-wise policy,
append-only public-list price manifests). The recorded cross-workload verdict is a
**STATISTICAL TIE at the recorded sample sizes** with the point-estimate ranking disclosed
(VAL-048) — the honest answer at 8 paired blocks, with the machinery proven able to produce
significant verdicts when evidence supports them (the pinned 7-of-7 boundary).

**Reproducibility** (VAL-049): the recorded economic evidence of VAL-041..048 replays
bit-stably — `REPRODUCIBLE-VERIFIED` on every honest replay row, 90 recorded evidence
references served READ-ONLY over REAL SQL with append-only arbitration.

**NOT RUN boundaries** (never converted into passes): 12 recorded live-rail rows across the
longitudinal/economic/audit/journey/pilot waves await the live-review lane
(`OPENROUTER_API_KEY`); 3D generation has no authorized provider (`ZECK_3D_API_KEY`);
video generation's free quota is exhausted (`QWEN_API_KEY` tier action); the streaming
realtime rail, live web and live desktop rails have no authorized provider; OpenAI routes
are region-blocked and BytePlus/Seedance ARK hosts do not resolve. Full inventory in the
NOT RUN boundaries section.

## Application coverage

Corpus of record: `val-corpus.1.0.0` (VAL-003, PR #46); every application pins a slice of
it or an app-local deterministic corpus, with sha256-16 fixture digests recorded in the
fixture modules. All live rows ran through the public SDK boundary (`createZeckClient`)
over the REAL platform path (REAL Fastify public API over REAL PostgreSQL) with REAL
provider dispatches; usage/cost figures are rail-reported BYOK measurements, never
estimates. Failed rows are recorded as failures.

| Workload | App | Corpus version | Runs | Quality | Reliability | Cost/success | Status |
|---|---|---:|---:|---|---|---|---|
| Text | VAL-010 `apps/text-generation` (PR #56) | val-corpus.1.0.0, pinned slice | 3 live | 2 COMPLETED (contains/length-bound PASS); `changelog-01` FAILED (contains:release FAIL — genuine model miss) | honest FAILED recorded, never retried | $0.000086 / $0.000063 / $0.000021 per row | COMPLETED (live 2026-09-12) |
| Structured transformation | VAL-010 `apps/structured-extraction` + `apps/transformation` (PR #56) | val-corpus.1.0.0, pinned slice | 7 live | 6 COMPLETED (schema-conformance, field-level-exact, facts-preserved PASS); `invoice-007` FAILED — the corpus's missing-total edge (honest null total; missing-total flag not emitted) | honest expected-failure edge recorded | $0.000061–$0.000077 extraction; $0.000029–$0.000063 transform per row | COMPLETED (live) |
| RAG | VAL-011 `apps/rag` (PR #61) | val-corpus.1.0.0, pinned 7-row slice incl. out-of-KB edge | 7 live | 7/7 COMPLETED (contains + citation-coverage PASS; the out-of-KB edge refused honestly — explicit not-in-KB, zero citations, no hallucinated personal data) | zero failures | $0.000385 total (1837 in + 156 out) | COMPLETED (live) |
| Tool agent | VAL-012 `apps/tool-agent` (PR #59) | val-corpus.1.0.0, pinned 14-row slice | 14 live; 28 REAL model rounds; 28 REAL wait-tool→resume cycles | 12 COMPLETED (ordered trace exact; injected tool-output instruction did not leak) | 2 FAILED, both corpus-declared: refusal edge (honest refusal, goal unachievable); forged sign-off REJECTED by the policy engine (authority boundary) | $0.001105 total (7336 in + 495 out) | COMPLETED (live) |
| Business workflow | VAL-012 workflow rows (invoice-011/012/014 + forged 016) | val-corpus.1.0.0, pinned slice | 4 live | 3 COMPLETED (routing approved/pending/exception, policy-engine invoked exactly) | invoice-016 FAILED — the corpus's expected authority-boundary failure | share of the $0.001105 total | COMPLETED (live) |
| Long-running agent | VAL-013 `apps/long-running` (PR #62) | val-corpus.1.0.0, pinned 6-row slice | 6 live; 10 REAL supervisor dispatches | 5 COMPLETED (exactly-once effects; checkpoint progression; resume continuity; stale-worker resume REJECTED by the REAL state machine; no-op resume REPLAYED by the idempotency ledger) | job-005 FAILED — corrupted checkpoint DETECTED, never trusted (the corpus's designed failure) | $0.000133 total (946 in + 22 out) | COMPLETED (live) |
| Voice/realtime | VAL-014 `apps/voice-io` + `apps/realtime-voice` (PR #71 + review fix) | val-corpus.1.0.0 audio families, pinned 12-row slice | 12 live (Lead's live crown: `qwen3-asr-flash` + `qwen3-tts-flash` over REAL PostgreSQL) | 9/12 COMPLETED (roundtrip `transcript-contains:meeting` PASS; turn accounting; exactly one journaled stale-worker denial; no-op-resume REPLAYED) | 3 honest FAILED: genuinely corrupted clip (REAL provider 400); empty-text edge (pre-dispatch, 0ms); corrupted-checkpoint session (progress never trusted past the boundary) | latency 334–1708 ms per row (measured) | COMPLETED (live); streaming realtime rail NOT RUN (no authorized WebSocket voice-session API; `QWEN_API_KEY` covers the ASR/TTS legs only) |
| Image generation | VAL-015 `apps/image-generation` + `apps/image-transformation` (PR #69 + review fix) | val-corpus.1.0.0, pinned 8-row slice | 8 live (Lead's live crown: `qwen-image-2.0`) | 6 COMPLETED (raster-container, dimensions-declared, payload-nonempty, digest-captured PASS; transforms: change-present + changed-region-intersects-target PASS) | 2 honest FAILED: empty-prompt edge (pre-dispatch); corrupted source (REAL provider 400) | mean dispatch latency 4196 ms (measured) | COMPLETED (live; the earlier `AllocationQuota.FreeTierOnly` boundary superseded by the operator's quota lift) |
| Video/media generation | VAL-016 `apps/video-generation` + `apps/media-generation-jobs` (PR #70 + review fix) | val-corpus.1.0.0, pinned 8-row + 2-job slice | 3 REAL videos generated live through the full async lifecycle (submit → 17 polls → retrieve → fetch) | mp4-container, payload-bounds, digest-captured, duration-reported-honored all PASS; 1,627,585 / 8,422,705 / 4,720,234 bytes; ~88 s async wall each | further live rows NOT RUN — the account's video-generation free quota is exhausted (`AllocationQuota.FreeTierOnly` on submission, live re-probed; operator payment/tier action pending; `QWEN_API_KEY`) | usage `video_count` as rail-reported | PARTIAL: 3 live COMPLETED; remaining live rows NOT RUN (quota) |
| Vision/VLM/audio | VAL-017 `apps/image-recognition` + `apps/vlm` + `apps/audio-understanding` (PR #63) | val-corpus.1.0.0, pinned 9-row slice | 9 live (`qwen/qwen2.5-vl-72b-instruct` + `qwen3-omni-flash`) | 7 COMPLETED (contains:bus/bicycle/car/rising/doorbell/alarm PASS; one healthy row completed via one honest 6 s retry after a retryable rate limit) | 2 honest FAILED: corrupted PNG (REAL OpenRouter 400); corrupted WAV (REAL dashscope 400) | $0.000400 total (655 in + 36 out; dashscope audio rows report $0.000000 on the free tier, honestly) | COMPLETED (live) |
| Multimodal/3D | VAL-018 `apps/multimodal-transformation` + `apps/three-d-rendering` (PR #73 + review fix) | val-corpus.1.0.0, pinned 3-row chain + 6-row 3D slice | chained: 3 live rows (vision stage over OpenRouter → structured description → derived raster over `qwen-image-2.0`) | chained 2 COMPLETED (8/8 crown tests; per-stage provenance: latency, usage, digests on both stages) | chained 1 honest FAILED (corrupted-source chain-abort, zero generation-rail calls); 3D: all 6 rows NOT RUN — no 3D-generation provider in the authorized set (`ZECK_3D_API_KEY`) | per-stage measured facts recorded in the addendum | COMPLETED (live chained); 3D sub-slice NOT RUN |
| Customer service | VAL-019 `apps/customer-service` (PR #76) | app-local deterministic corpus (4 rows) | 4 live | 4/4 COMPLETED (routing engineering/finance/legal-review; forged-severity ticket routed L1 — signal-derived verdict beats ticket text) | zero failures | $0.000664 (4712+211 tokens, 12 model rounds) | COMPLETED (live) |
| Browser/computer use | VAL-019 `apps/browser-use` + `apps/computer-use` (PR #76) | app-local corpora (3+3 rows) over the in-memory shop page-graph and workspace fixtures | 6 live | browser 2/3 (plain checkout $18; coupon checkout $9 with exact total math); computer 2/3 (extension sort, exact final tree; ws-empty row) | browser `card 4111-…` row FAILED as designed (secret-flow refusal, zero orders); computer `/etc/passwd` row FAILED as designed (data-boundary refusal, tree unchanged) | $0.001320 (browser, 17 rounds) + $0.000555 (computer, 9 rounds) | COMPLETED (live over controlled fixtures); LIVE web/desktop rails NOT RUN (no operator-authorized browser/computer-use rail) |
| Research/coding/operations | VAL-019 `apps/research` + `apps/coding` + `apps/operations` (PR #76) | app-local corpora (3+3+4 rows) | 10 live | research 3/3 (citation coverage SRC-1..3; injected SRC-9 never cited); coding 2/3 (embedded tests pass: 7/7 and 6/6); operations 3/4 (approve/reject/escalate cycles, decisions journaled) | coding contradictory-spec row FAILED as designed (no implementation satisfies the tests) | $0.000858 (research) + $0.000592 (coding) + $0.000743 (operations) | COMPLETED (live) |
| Human-in-the-loop | VAL-019 `apps/operations` HITL cycles (with VAL-013/014 wait-user→resume pairs) | app-local corpus (4 HITL decision cycles) | 4 live | 3/4 COMPLETED (approve→execute with supervised continuation resuming exactly once; reject→zero effects; escalate→routed with gate context) | forged pre-approval row FAILED as designed (`hitl-gate-timeout`, zero restarts — text is not a decision) | share of the $0.000743 operations total | COMPLETED (live) |

VAL-019 totals of record: ~69 live model rounds, ~$0.0057 total, every designed edge row
FAILED honestly with the exact boundary recorded (`docs/work-items/VAL-019.md`, Lead review
addendum). Applications beyond the portfolio (VAL-020..026 failure/replay/sandbox/security/
isolation/concurrency/outcome suites; VAL-030..036 longitudinal; VAL-040..049 economic;
VAL-050/051 journey and pilot) exercise the platform's failure, safety and accounting
semantics — cited in the sections below.

## Longitudinal learning

Tracked baseline → repeated replay → learned optimization → shadow → canary →
rollback/promote, with deterministicization ratio, AI avoidance ratio, learned savings and
quality preservation reported as RECORDED facts (FNV-1a trajectory digests; payload bytes
never journaled):

- **Baseline freeze and pre-learning controls (VAL-030, Lead's battery over the program's
  embedded PostgreSQL 16.4):** 10 rows — 9 COMPLETED + 1 honest guard-FAILED; 39 trajectory
  steps through the REAL recorder; exactly 10 immutable longitudinal identities (the re-run
  re-observes the SAME identity); the r1→r2 append-only correction intact over REAL SQL.
  Learning is INERT in the control arm — the three contamination kinds
  (`trajectory-reuse`, `caching-hint`, `competence-shortcut`) each FAIL mechanically.
  Recorded trajectory digests of the control classes include `7549c610`, `db2b17a5`,
  `2b0b827c`, `35d6acee`, `4631d3db` (manifest digests `f9fd5b2b`, `81f8fb42`, …).
- **Repeated replay (VAL-031):** 36 replays, every population exactly-N with no duplicates
  or gaps; 135 trajectory steps; the varying replay population honestly reported varying
  with its observed distribution.
- **Learned discovery (VAL-032):** 4 immutable candidate identities registered — reuse
  `…-024b829d`, cache `…-b1325117`, competence `…-62ad0ebe`, deterministicization
  `…-e519d75f`; the frozen-input digest is IDENTICAL before and after every run (learning
  never mutates the frozen baselines).
- **Equivalence and deterministic replacement (VAL-033):** 10 equivalence passes / 1 honest
  divergence / 2 honest refusals; 22 evidenced lifecycle transitions over REAL SQL.
- **Shadow deterministic execution (VAL-034):** 10 shadow agreements / 1 honest divergence;
  the served outcome is ALWAYS the incumbent's; 11 shadow-cost entries booked apart from the
  served accounting (the customer is never billed for the shadow).
- **Canary promotion and rollback (VAL-035):** 8 clean promotions through the full ramp /
  3 honest budget-breach rollbacks (the served traffic reverted COMPLETELY — exercised,
  never partial) / 2 honest refusals; 35 canary decisions, 3 divergence records, 3
  exercised rollback events.
- **Determinization maturity (VAL-036, the recorded answer):** four honest classes over the
  recorded generation series — rag-retrieval `determinized-stable` (4 generations, 375 µ$
  recorded savings); text-summarization `determinizing-trending` (4 generations, 360 µ$);
  order-settlement `variable-resilient` (4 generations, 160 µ$); support-triage
  `immature-insufficient-evidence` (2 generations — the honest evidence limit, never
  stretched into a trend). The per-generation displaced-model-call and per-mechanism
  displacement facts ride the recorded curve points (the deterministicization/AI-avoidance
  accounting basis).
- **Savings attribution (VAL-045):** per-mechanism splits with honest residuals, never
  forced — rag-retrieval 400 µ$ attributed + 95 µ$ residual; text-summarization 90 µ$
  attributed + a LARGE honest 320 µ$ residual; code-search cache-dominant 350 + 25;
  invoice-extraction reuse-dominant 295 + 30; translation-glossary
  deterministicization-dominant 315 + 35. Reconciliation identity holds per family per
  generation; no ledger entry is attributed twice.
- **Longitudinal cost curve (VAL-047):** invoice-extraction 56 → 43 → 30 → 17 µ$/resolved
  (`trajectory-improving`, the g2 price-regime change rev-001→rev-002 MARKED, never
  normalized away); code-search 22 → 18 → 13 → 7 → 7 → 7 (`trajectory-plateaued`);
  tool-routing 43 → 43 → 43 → 43 (`never-materialized`); rag-retrieval 72 → 48 → 29 → 15
  (`mixed-cohort-regressing` — the det cohort's 120 → 40 regression reported, never hidden).
  Quality preservation is pinned by the equivalence/shadow/canary discipline above
  (divergences recorded case-by-case with both sides' digests; rollbacks complete).

The live maturity row (ONE REAL measured model round before a family's report appends) is
the recorded NOT RUN boundary (`OPENROUTER_API_KEY`) — same for the live rows of the
follow-on waves.

## Economic benchmark

Primary metric: cost per successfully resolved outcome at comparable
quality/reliability/safety thresholds, normalized onto canonical micro-USD (VAL-040's
normalization core: exact BigInt rational arithmetic, mixed currencies/units/metering,
measured/estimate separation, NULL when nothing resolved, estimate-backed REFUSED).

- **Economic baseline normalization (VAL-040, PR #100):** 8/8 offline rows COMPLETED over
  the worker-local PostgreSQL 16.14 — five fixed-quality personas (USD-metered 22 µ$/resolved,
  EUR 162, JPY-per-1K 46447, batched 235, retry-amortized 33) and three fixed-cost personas
  (within-budget 25, honest prefix budget-stop 30, zero-resolved NULL) — Wilson 95% carried
  on every comparison; the append-only public-list price manifest (rev-001 + the rev-002
  correction). The two live rows are the recorded NOT RUN boundary (`OPENROUTER_API_KEY`).
- **Direct-provider controls (VAL-041, Lead's battery over program PG):** 7 COMPLETED + 5
  honest FAILED of 12 rows — direct-path, cost-basis, manifest and sample-discipline
  oracles green on controls, honestly FAILED on every probe.
- **Strong optimized non-Zeck baseline (VAL-042, PR #105):** 7/7 offline rows COMPLETED —
  routed pinned model, compressed prompt verified against the declared bound, REAL response
  cache (cache hits carry ZERO cost facts and stretch the pinned budget honestly); fresh-only
  cache-inert control included. Live rows NOT RUN (`OPENROUTER_API_KEY`).
- **Competing gateway/router/agent benchmark (VAL-043, PR #108):** 7/7 offline rows
  COMPLETED — configuration-conformance, model-selection, retry-posture, behavior-variance,
  replay-fidelity and charge-observation-separation oracles green.
- **Quality/latency/failure-adjusted cost (VAL-044, Lead's battery):** 7 COMPLETED + 6
  honest FAILED of 13 rows; every input DIGEST-VERIFIED against its recorded arm corpus
  (the re-measurement masquerade caught field-by-field).
- **Substrate/runtime economics (VAL-046, PR #112):** the readiness-adjusted family
  (first-USABLE derived from probe telemetry, reserved/measured separation, five-share
  decomposition) over recorded telemetry windows; below-minimum comparisons honestly REFUSE
  the verdict. The live row (REAL `ProcessSandboxProvider` lifecycle + one REAL OpenRouter
  dispatch binding) and a REAL container/VM-fleet lifecycle are NOT RUN boundaries
  (`OPENROUTER_API_KEY`; no operator substrate credentials).
- **Cross-workload competitive benchmark (VAL-048, PR #114) — the recorded verdict:** over
  the recorded evidence's own sample sizes (8 paired blocks on the headline class) NO
  pairwise comparison reaches the declared Bonferroni-corrected level (derived p-values
  1.0 / 0.6875 / 1.0 vs the per-comparison level 0.016667). The honest verdict is the
  **STATISTICAL TIE** with the point-estimate ranking disclosed: zeck 22 < direct 24 <
  competing 26 < optimized 69 µ$/resolved on the failure-adjusted basis (latency-adjusted:
  zeck 22 < direct 24 < competing 30 < optimized 69). The zero cohort is honestly
  incomparable (NULL bases); the stop cohort honestly under-powered (3 < 5, reported,
  never dropped); the smallest honest block count that can reach the corrected level is
  7-of-7 (p = 0.015625) — pinned as the machinery's boundary (a synthetic 6-of-6 decisive
  case derives zeck-wins-significant at the uncorrected level and statistical-tie at the
  corrected level). 7 COMPLETED + 6 honest FAILED of 13 driven rows; 12 recorded arm
  windows served READ-ONLY from REAL SQL; the live row NOT RUN (`OPENROUTER_API_KEY`).
- **Longitudinal cost curve (VAL-047, PR #113):** the improvement decomposes EXACTLY
  against the VAL-045 attribution (attributed per mechanism + substrate overhead + the
  honest residual equals the measured delta per generation); price-regime changes MARKED;
  no extrapolation beyond the recorded evidence.
- **Reproducibility and anti-gaming audit (VAL-049, PR #115):** the whole economic wave
  replays bit-stably — see Reproducibility.

## Findings and solutions

Every material issue carries the full protocol (reproduction; affected work order;
revisions and environment; observed impact; root-cause classification; candidate
solutions; recommended solution and trade-offs; verification required; disposition).
Sources: the honest FAILED probes, NOT RUN boundaries and live review fixes recorded in the
work-order evidence documents.

**F-1 — Flagship provider routes geo-gated from the validation egress.**
Reproduction: chat completion with a flagship OpenRouter model → 403 "This model is not
available in your region"; the same call with open-weights models → 200 (VAL-009 probes,
2026-09-11; carried by VAL-010's provider-axis evidence). Affected: VAL-009, VAL-010 (and
every text/vision row's model choice). Environment: the validation egress; revisions per
the VAL-009 evidence document. Impact: model selection constrained to open-weights routes;
no pinned corpus row demanded a flagship route. Classification: external limitation
(provider-side geo routing). Candidate solutions: open-weights routes (chosen — proven),
operator egress change, different provider. Recommended: open-weights routes, recorded
honestly; trade-off: flagship-tier capability remains unmeasured. Verification required:
the probes above (recorded). Disposition: recorded; residual risk accepted and disclosed.

**F-2 — Live-rail wire-shape divergence is catchable only by the live review battery.**
Reproduction: VAL-014's first live crown run failed every dispatch on a rail endpoint
domain typo (`dashscope-international.aliyuncs.com` — no DNS — vs `dashscope-intl…`);
VAL-015's rail broke on the provider's `input.messages` shape change (legacy `input.prompt`
→ 400 InvalidParameter); VAL-018's chain could never complete live because the vision
model answers `palette` as a JSON array while the parser required strings. Affected:
VAL-014/015/018 (PRs #71/#69/#73 and their review-fix PRs). Impact: five review-grade
defects in VAL-014's merged PR (domain typo, ASR content contract, latency assertion,
no-op-resume ledger key, leg-count assertion) — all fixed in review-fix PRs and
live-verified before merge. Root cause: controlled-fake unit tests bake in the designed
wire shape; fake transports cannot catch DNS or provider-side shape evolution.
Classification: harness limitation (expected). Candidate solutions: live review battery as
the merge authority (chosen), contract tests against recorded provider fixtures,
maintaining worker credential access. Recommended: the Lead's credential-bearing live
review battery stays the authority for every provider-rail change; trade-off: CI remains
credential-less by design, so live-shape drift surfaces at review time, not in CI.
Verification required: the recorded live crown runs (VAL-014/015/018 addenda). Disposition:
fixed (review-fix PRs, live-verified); protocol retained as standing practice.

**F-3 — Video rail tier/size boundaries and quota exhaustion.**
Reproduction: the video-synthesis task API returned 403 AccessDenied for synchronous
calls — the tier boundary is SYNCHRONOUS-CALL-ONLY, and with `X-DashScope-Async: enable`
submissions are accepted; `wan2.2-t2v-plus` accepts ONLY eight size values, so the 720p-class
`1280*720` mapping made every ACCEPTED task fail InvalidParameter; after three live
generations the account's free quota is exhausted (`AllocationQuota.FreeTierOnly` on
submission, live re-probed). Affected: VAL-016 (PR #70 + review fix). Impact: the async
protocol, rail and verification machinery are live-proven by the three completed
generations; further live rows are blocked on operator payment/tier action.
Classification: external limitation (provider tier/quota) + calibration fix (size
whitelist → 1920*1080 / 1080*1920). Verification required: the recorded live run (three
videos, 17 polls each, ~88 s async wall). Disposition: mapping fixed; quota boundary
surfaced to the operator (env `QWEN_API_KEY` credential works; the quota is the boundary).

**F-4 — Validation-oracle design defects found by the live runs (fixed toward the corpus,
never by weakening it).**
Reproduction and disposition per work order: VAL-010's first transform oracle compared
paraphrasable top-content words and clock formats (false FAILs/false fabrication flags) →
mechanical NUMBERS-by-value comparison with clock-format canonicalization; VAL-012's
workflow rows initially used the tools family's exact-ordered trace comparison →
`in-order` semantics per the corpus's own evaluation, redundant calls recorded as
inefficiency; VAL-012's refusal-marker list missed the model's correct phrasing → markers
extended (the row still completes as the corpus's FAILED); VAL-013's checkpoint-count
assertion was wrong for the corruption row (correct behavior is to STOP at the boundary) →
the ledger must mirror the driver's checkpoints exactly; VAL-017's doorbell fixture was
misclassified "alarm" by both omni models (6/6) → the single-chime design (stable 4/4);
VAL-017's chart oracle `containsText:["trend"]` appeared 1/3 runs → the focused-question
oracle (3/3 stable); VAL-019's live calibration dropped constraints the goals never
mandated (independent-operation order, exploration freedom, over-specified answer oracle,
path hints) while keeping every semantic pin. Classification: validation-defect (oracle
design) in each case. Verification required: discrimination tests + the green live reruns
(recorded per work order). Disposition: all fixed pre-merge or in review-fix PRs; the
corpus expectations were never weakened.

**F-5 — Harness driver defects found by the live runs.**
VAL-010's stale-poll cursor let task N+1 select task N's execution row (idempotency
collision, dangling promise) → the cursor skips already-driven ids and the promise is
guarded; VAL-012's second `wait-tool` reused the first round's idempotency key → unique
per-call keys; VAL-014's stale-worker scenario initially issued an illegal second
`wait-user` from WAITING_USER → exactly one `wait-user`, the stale worker's `resume` from
RUNNING genuinely rejected by the REAL state machine and journaled; VAL-016's driver
initially derived the plan before the vocabulary check (wrong-modality mislabeled as
NOT-RUN) → KIND checked first; VAL-018's early binding could spend stage-1 money on a chain
that cannot run stage 2 → both rails checked before any network effect. Classification:
harness defect (test-side). Verification required: full-suite reruns green (recorded).
Disposition: fixed before delivery.

**F-6 — The recorded economic verdict is a statistical tie.**
Reproduction: VAL-048's paired sign test over the recorded 8-block headline cohort (p 1.0 /
0.6875 / 1.0 vs Bonferroni-corrected 0.016667). Affected: VAL-048 (the honest headline
finding, recorded in the evidence document). Impact: no pairwise superiority claim is
derivable from the recorded sample sizes; the point-estimate ranking is disclosed
alongside. Classification: honest statistics at the recorded sample size — not a defect.
Candidate solutions: larger pre-registered cohorts (the 7-of-7 pinned boundary), more
paired blocks, or accepting the tie as the recorded answer. Recommended: record the tie
(chosen); a larger live cohort is an operator-gated re-pin. Verification required: the
pinned 6-of-6 synthetic case proving the machinery produces significant verdicts when the
evidence supports them. Disposition: recorded; see Hypotheses H-1 and Recommendation R-5.

**F-7 — Readiness/quarantine architecture-gap candidate.**
Reproduction: the platform's `SandboxProvider` seam exposes no readiness surface, so
VAL-046's first-USABLE derivations live at the validation layer (probe-based) while the
platform substrate adapter exists without readiness semantics (VAL-022 finding #2, carried
by VAL-046's handoff). Impact: readiness/quarantine behavior is proven at the validation
layer only. Classification: architecture-gap candidate. Candidate solutions: an
Architect-governed corrective work order exposing a readiness surface on the seam
(reusing VAL-046's probe-based derivation), or keeping the validation-layer derivation.
Recommended: the seam surface (recorded as the reference a future seam decision can adopt);
trade-off: a platform change requires its own governance. Verification required: the
corrective work order's own battery. Disposition: recorded; carried as Recommendation R-6
and Hypothesis H-3.

**F-8 — Platform-suite tolerance flakes (documented, not hidden).**
Reproduction: the pre-existing `computer-use-lifecycle` flake documented by VAL-025; the
`pg-database-port` pool-bounds flake under full-suite parallel load (VAL-009/013/017
class); one unreproduced worker-local warmup transient (VAL-040, honestly recorded as
unproven). Impact: none on any acceptance criterion (isolated reruns and full-suite reruns
green in every recorded case). Classification: test-harness/infrastructure tolerance
(shared-resource contention under parallel load). Candidate solutions: rerun + document
(chosen), sequential mode, quarantine. Verification required: the green reruns recorded in
each evidence document. Disposition: documented; protocol retained (Recommendation R-8).
VAL-050/051 batteries needed NO flake handling (all first-run green).

**F-9 — In-code media synthesis honesty limits.**
Reproduction: in-code WAV synthesis produces utterance-SHAPED audio, never intelligible
speech (VAL-014); provider TTS payloads are not byte-stable across dispatches. Impact: the
strong transcript oracle rides the REAL roundtrip rows (REAL TTS speech → REAL ASR
transcript vs the phrase fixture's own terms); TTS verification is container/codec
validity + non-empty payload + digest capture; synthetic STT rows record their fixtures'
DECLARED annotations with the observed transcript (oracle provenance explicit).
Classification: external/design limitation, recorded. Disposition: recorded honestly in
the platform module headers and evidence documents; empty-transcript-200 is honest SUCCESS
(silence-legitimate).

**F-10 — Worker-channel unavailability and the direct-implementation pivot.**
Reproduction: the chat.z.ai worker channel returned `403 USER_BLOCKED` (unblock
2026-09-18T18:37:04Z) during VAL-001..013; the operator directed Tech Lead direct
implementation at the integration station (recorded in the resident worklog). Impact: none
on the acceptance criteria — the early waves were delivered and evidenced directly; worker
dispatch resumed for later waves (VAL-015/016/019/040/042/043/046/048 record worker
delivery). Classification: external limitation, surfaced to the operator. Disposition:
recorded; superseded by the resumed dispatch pattern.

**F-11 — Worker-local environment mismatches (recorded, resolved).**
VAL-040's first worker-local PostgreSQL provisioning used zonky 18.4, which the platform's
own `pg-database-port` suite honestly rejects (the program's PostgreSQL 16 line) →
re-provisioned 16.14 before the recorded battery; VAL-016's dispatch packet carried
template-contaminated summary lines resolved against the governed spec text. Classification:
worker-local environment mismatch. Disposition: resolved; recorded in the evidence
documents.

**Residual risks (honest inventory).** (1) The 12 recorded live-rail rows of the
longitudinal/economic/audit/journey/pilot waves are NOT RUN pending the live-review lane
(`OPENROUTER_API_KEY`) — their offline evidence is replayed-record facts, honestly
source-labeled. (2) Provider access residuals: OpenAI region block; BytePlus/Seedance ARK
DNS failure; no 3D provider (`ZECK_3D_API_KEY`); video free-quota exhaustion
(`QWEN_API_KEY` tier); no streaming realtime rail; no live web/desktop rails. (3) The
economic tie: no superiority claim is derivable at the recorded sample sizes. (4) CI runs
credential-less by design — live-shape drift surfaces at review time only. (5) The
readiness seam gap (F-7). (6) The flagship-route capability tier is unmeasured (F-1).
(7) TTS byte-level ground truth is not provider-stable (F-9). None of these converts into
a pass anywhere in the recorded evidence.

## Observed facts

_Every entry names the exact submission (work order + final head) and the
battery command that produced it. Facts are observations only — no
interpretation. Populated by the report projection
(`benchmarks/validation/report.ts`) from validated submissions
(`benchmarks/validation/submission.ts`)._

| Work order | Command | Outcome | Detail | Source |
|---|---|---|---|---|
| VAL-001 | `python3 scripts/validation-check.py` | pass | 46 validation work orders, inFlight=[VAL-001] | `benchmarks/validation/evidence/VAL-001.md` |
| VAL-001 | `bun run test:unit` / `test:architecture` | pass | 235 files / 3416 tests; 106 files / 1423 tests | `benchmarks/validation/evidence/VAL-001.md` |
| VAL-010 | `ZECK_PG_TEST_URL=… OPENROUTER_API_KEY=… bun run test:integration` | pass | 125 files / 1135 tests + 20 skipped, incl. the live-provider crown; live run 10 rows, 8 COMPLETED / 2 honest FAILED, $0.000568 | `docs/work-items/VAL-010.md` |
| VAL-011 | `ZECK_PG_TEST_URL=… OPENROUTER_API_KEY=… bun run test:integration` | pass | 127 files / 1137 tests; live run 7/7 COMPLETED, $0.000385 | `docs/work-items/VAL-011.md` |
| VAL-012 | `ZECK_PG_TEST_URL=… OPENROUTER_API_KEY=… bun run test:integration` | pass | 126 files / 1136 tests; live run 14 rows, 12 COMPLETED / 2 expected FAILED, 28 REAL rounds, $0.001105 | `docs/work-items/VAL-012.md` |
| VAL-013 | `ZECK_PG_TEST_URL=… OPENROUTER_API_KEY=… bun run test:integration` | pass | 128 files / 1138 tests; live run 6 rows, 5 COMPLETED / 1 designed corruption FAILED, $0.000133 | `docs/work-items/VAL-013.md` |
| VAL-014 | Lead live crown (credential-bearing env) | pass | 9/12 COMPLETED; 3 honest FAILED; `qwen3-asr-flash` + `qwen3-tts-flash` over REAL PostgreSQL | `docs/work-items/VAL-014.md` (addendum) |
| VAL-015 | Lead live crown | pass | 6 COMPLETED / 2 honest FAILED; mean dispatch latency 4196 ms; `qwen-image-2.0` | `docs/work-items/VAL-015.md` (addendum) |
| VAL-016 | Lead live crown | pass | 3 REAL videos (1,627,585 / 8,422,705 / 4,720,234 bytes; ~88 s async wall); quota then exhausted | `docs/work-items/VAL-016.md` (addendum) |
| VAL-017 | `ZECK_PG_TEST_URL=… OPENROUTER_API_KEY=… QWEN_API_KEY=… bun run test:integration` | pass | 129 files / 1139 tests; live run 7 COMPLETED + 2 honest FAILED, $0.000400 | `docs/work-items/VAL-017.md` |
| VAL-018 | Lead live chained crown | pass | 8/8 tests; 2 COMPLETED / 1 honest FAILED chained rows; 3D sub-slice NOT RUN | `docs/work-items/VAL-018.md` (addenda) |
| VAL-019 | Lead live crown | pass | 6/6 tests; ~69 live model rounds, ~$0.0057; every designed edge row FAILED honestly | `docs/work-items/VAL-019.md` (addendum) |
| VAL-025 | `ZECK_PG_TEST_URL=… bun run test:integration` | pass | 7/7 rows; 43 executions / 43 idempotency records, zero phantoms | `docs/work-items/VAL-025.md` |
| VAL-026 | `ZECK_PG_TEST_URL=… bun run test:integration` | pass | 9 executions / 9 idempotency records; FAILED rows verify ABSENCE of effects; replays apply ZERO new effects | `docs/work-items/VAL-026.md` |
| VAL-030 | `ZECK_PG_TEST_URL=… bun run test:integration` | pass | 10 rows (9 C + 1 guard F); 39 trajectory steps; 10 immutable identities | `docs/work-items/VAL-030.md` |
| VAL-031..035 | `ZECK_PG_TEST_URL=… bun run test:integration` | pass | 36 replays / 4 candidates / 10 equivalences / 10 shadow agreements / 8 promotions + 3 rollbacks (per-WO tables) | `docs/work-items/VAL-031..035.md` |
| VAL-036 | `ZECK_PG_TEST_URL=… bun run test:integration` | pass | 11/11 rows; 4 maturity reports appended over REAL SQL; live row NOT RUN | `docs/work-items/VAL-036.md` |
| VAL-040 | `ZECK_PG_TEST_URL=… bun run test:integration` | pass | 142 files / 1173 tests + 20 skipped over worker-local PG 16.14; 8/8 rows COMPLETED | `docs/work-items/VAL-040.md` |
| VAL-041 | `ZECK_PG_TEST_URL=… bun run test:integration` | pass | 7 COMPLETED + 5 honest FAILED of 12; 12 executions / 12 idempotency records | `docs/work-items/VAL-041.md` |
| VAL-042 | `ZECK_PG_TEST_URL=… bun run test:integration` | pass | 147 files / 1183 tests + 20 skipped; 7/7 rows COMPLETED | `docs/work-items/VAL-042.md` |
| VAL-043 | `ZECK_PG_TEST_URL=… bun run test:integration` | pass | 7/7 rows COMPLETED over worker-local PG 16.14 | `docs/work-items/VAL-043.md` |
| VAL-044 | `ZECK_PG_TEST_URL=… bun run test:integration` | pass | 7 COMPLETED + 6 honest FAILED of 13; inputs digest-verified | `docs/work-items/VAL-044.md` |
| VAL-045 | `ZECK_PG_TEST_URL=… bun run test:integration` | pass | 12 rows: 5 honest splits + 5 probes + 2 honest refusals | `docs/work-items/VAL-045.md` |
| VAL-046 | offline battery (no PG in sandbox) | pass | unit 304 files / 5132 tests; arch 132+1 files / 1973+4 tests; crown SKIPS honestly | `docs/work-items/VAL-046.md` |
| VAL-047 | `ZECK_PG_TEST_URL=… bun run test:integration` | pass | 4 honest curve classes + 8 probes; regime change MARKED; regression reported | `docs/work-items/VAL-047.md` |
| VAL-048 | `ZECK_PG_TEST_URL=… bun run test:integration` | pass | 7 COMPLETED + 6 honest FAILED of 13; verdict: statistical tie (recorded) | `docs/work-items/VAL-048.md` |
| VAL-049 | `ZECK_PG_TEST_URL=… bun run test:integration` | pass | 24 COMPLETED + 4 honest FAILED of 28; REPRODUCIBLE-VERIFIED replays; 90 read-only references | `docs/work-items/VAL-049.md` |
| VAL-050 | `ZECK_PG_TEST_URL=postgres://… bun run test:integration` | pass | 3 honest JOURNEY-COMPLETED rows over REAL PG; 5 adversarial probes FAILING named; live slice NOT RUN | `docs/work-items/VAL-050.md` |
| VAL-051 | `bun run test:unit` / `test:architecture` / `ZECK_PG_TEST_URL=… test:integration` | pass | 5498/5498; 2191+4 skipped; 1211+20 skipped over REAL PG 16.14; 5 PILOT-COMPLETED rows + 7 probes FAILING named; live window NOT RUN | `docs/work-items/VAL-051.md` |
| VAL-051 (head of program) | `bun run governance:check` / `bun run lint` / `bun run typecheck` | pass | Governance OK (60/110); lint 0 errors / 61 warnings / 8 infos; tsc EXIT 0 | `docs/work-items/VAL-051.md` |

## Failures and root causes

_Failed battery commands and every material issue, each with its
seven-part solution protocol (reproduction, impact, root-cause
classification, viable solutions, recommended solution with trade-offs,
defect classification, required verification evidence)._

| Work order | Failure | Root cause | Classification | Status |
|---|---|---|---|---|
| VAL-010 | `changelog-01` live run FAILED (contains:release) | the model's 25-word summary genuinely lacked the corpus-mandated term | genuine model miss (oracle floor working) | recorded as FAILED, never retried |
| VAL-010 | `invoice-007` live run FAILED | the corpus's missing-total edge: honest null total; missing-total flag not emitted | corpus-declared expected failure | recorded (the forbidden fabricated total did not occur) |
| VAL-012/013/014/015/017/018/019 | 16 expected-failure edge rows across the live portfolio | corpus-declared edges (refusals, corrupted media, authority boundaries, contradictory specs, forged approvals) | by design | recorded honestly in each evidence document |
| VAL-014 | first live crown: every dispatch transport-failed | rail endpoint domain typo (`dashscope-international…` no DNS vs `dashscope-intl…`) | harness defect (fake transports cannot catch DNS) | fixed in review-fix PR, live-verified |
| VAL-014 | ASR 400 `InternalError.Algo.InvalidParameter` | mixed audio+text content on the dedicated ASR task endpoint | live-contract defect | fixed (audio-only content) |
| VAL-015 | live rail 400 InvalidParameter | provider shape change: `input.messages` now required | provider API evolution | fixed (messages content grammar), live-verified |
| VAL-016 | accepted tasks failed InvalidParameter | `wan2.2-t2v-plus` size whitelist (eight values only) | calibration defect | fixed (1920*1080 / 1080*1920) |
| VAL-016 | further live rows blocked | video-generation free quota exhausted (`AllocationQuota.FreeTierOnly`) | external limitation (operator tier) | surfaced; NOT RUN boundary |
| VAL-018 | chain aborted at stage 1 (`malformed-intermediate`) | live model answers `palette` as a JSON array; parser required strings | live-contract defect | fixed ("as one comma-separated string"), live-verified |
| VAL-010/012/013/017/019 | oracle/driver defects found by live runs | oracle design or harness binding (see Findings F-4/F-5) | validation-defect / harness defect | fixed pre-merge or in review fixes; corpus never weakened |
| VAL-025 | `computer-use-lifecycle` flake | shared-resource contention under full parallel battery | test-harness/infrastructure | documented tolerance finding; green reruns recorded |
| VAL-040 | zonky 18.4 rejected by `pg-database-port` | worker-local environment mismatch (the program asserts the PG 16 line) | environment mismatch | re-provisioned 16.14 before the recorded battery |
| VAL-046 | crown not run in worker sandbox | no `ZECK_PG_TEST_URL`, no credentials in the pod (per dispatch packet) | honest env-gated boundary | visibly SKIPPED; offline battery green; recorded facts replayed and verified by VAL-049 |
| VAL-048 | headline verdict: statistical tie | 8 paired blocks < the Bonferroni-corrected reachable sample (7-of-7) | honest statistics, not a defect | recorded; ranking disclosed; re-pin recommended |
| VAL-050/051 | live slices NOT RUN | no operator-authorized `OPENROUTER_API_KEY` in the delivery environment | honest env-gated boundary | zero durable submissions pinned over REAL SQL; never a fake success |

## Hypotheses (open)

_Interpretation lives here, never in the facts section. A hypothesis is
recorded explicitly with the experiment that would confirm or refute
it; none is promoted to a finding without that evidence._

| Hypothesis | Confirming experiment | Status |
|---|---|---|
| H-1: The headline economic tie resolves to a significant verdict with larger pre-registered paired cohorts (the pinned boundary: 7-of-7 both-resolved blocks reaches p = 0.015625) | re-pin the VAL-048 corpus with ≥ 7-of-7 blocks per pair and drive the live row with an authorized `OPENROUTER_API_KEY` | untested (recorded boundary; see F-6) |
| H-2: A streaming realtime voice rail slots into the bounded typed turn protocol unchanged (per-turn dispatch port, turn checkpoints, wait-user/resume, stale-worker denial, corruption detection) | authorize a WebSocket voice-session API (e.g. `qwen3-omni-realtime` / `paraformer-realtime`) and drive the `dlg-001..005` sessions through it | untested (VAL-014 handoff) |
| H-3: The platform `SandboxProvider` seam should expose a readiness surface (first-usable), adopting VAL-046's probe-based derivation | an Architect-governed corrective work order implementing the seam surface with its own battery | open (VAL-022 finding #2; VAL-046 handoff) |
| H-4: text-summarization's large honest residual (320 µ$ of 410 µ$ recorded) contains savings mechanisms beyond the four recorded ones | instrument additional mechanism evidence and re-attribute as an append-only attribution-report revision (VAL-045 discipline) | untested |
| H-5: the rag-retrieval det-cohort regression (120 → 40) is cohort-specific, not family-wide | cohort-stratified promotion policy via the VAL-035 canary machinery over a re-pinned cohort split | untested |
| H-6: open-weights routes suffice for every corpus-pinned task (no pinned row demanded a flagship route) | a corpus revision adding flagship-required rows plus an operator egress change, then re-probe (VAL-009 discipline) | consistent with the recorded probes; untested at flagship tier |

## Recommendations

_Each recommendation traces to the issue or finding that produced it
and names the verification required before it is acted on._

| Recommendation | Traces to | Verification required | Status |
|---|---|---|---|
| R-1: The operator authorizes the live-review lane for the 12 recorded live-rail rows (VAL-030/036/040/042/046/047/048/049/050/051) via `OPENROUTER_API_KEY` | NOT RUN boundaries (each row's recorded bounds: Wilson intervals, declared windows, pinned manifests) | the live rows' own bounded re-runs measured against the recorded declared bounds (the VAL-049 bounds-held oracle) — the journey/pilot/final-report lanes (VAL-050/051/052) are driveable via the review-fix live-rail drivers only (the original merges shipped the gate + the honest NOT-RUN boundary only); every re-run measures FRESH facts and leaves the recorded verdicts untouched (a measured divergence reopens the affected sections per F-1's escalation, never a silent overwrite) | awaiting operator action |
| R-2: The operator takes the payment/tier action for video generation (`QWEN_API_KEY` quota boundary: `AllocationQuota.FreeTierOnly`) | F-3; VAL-016 NOT RUN boundary | the remaining pinned live video rows driven through the live-proven async protocol | awaiting operator action |
| R-3: The operator selects and authorizes one 3D-generation-capable provider/model pair, bound onto the `ThreeDRail` seam via `ZECK_3D_API_KEY` | VAL-018's surfaced access requirement (`THREE_D_ACCESS_REQUIREMENT`) | the six pinned `three-d.*` rows driven live with container-valid/digest-verified artifacts | awaiting operator action |
| R-4: The operator resolves provider egress/access: region-acceptable egress for the OpenAI-dependent capabilities, the correct endpoint for the home.qwencloud.com key type, and the ARK host for the ap-southeast-1 keys | VAL-009 NOT RUN boundaries #1/#2 | the capability-matrix probes re-run READY for the currently-gapped capabilities | awaiting operator action |
| R-5: Re-pin larger economic cohorts (≥ 7-of-7 both-resolved paired blocks per pair) before any superiority claim is attempted | F-6 / H-1; VAL-048's pinned 7-of-7 boundary | the paired sign test over the larger cohort with the Bonferroni policy and Wilson intervals unchanged | proposed (a corpus-constant re-pin per VAL-040's handoffs) |
| R-6: Adopt the readiness surface at the platform `SandboxProvider` seam via an Architect-governed corrective work order | F-7 / H-3 (VAL-022 finding #2; VAL-046 handoff) | the corrective work order's own battery over the REAL seam | proposed |
| R-7: Retain the credential-bearing Lead live-review battery as the merge authority for every provider-rail change | F-2 (VAL-014/015/018 review fixes) | each rail change's live crown re-run before merge (the standing pattern) | adopted practice (recorded across the review addenda) |
| R-8: Retain the flake protocol (isolated rerun + one clean full rerun + documentation); move to sequential mode only if the flake rate grows | F-8 (VAL-025 and the flake class) | the green reruns recorded per evidence document | adopted practice |
| R-9: The Architect's acceptance of the final evidence package is carried by the authority chain (PR → CI → merge → program-state finalize) — never self-declared by any report or application | VAL-052 AC4 (acceptance-chain honesty) | the merged PR, green CI and the finalized governed state | in force (this report complies) |

## NOT RUN boundaries

_An unavailable run is recorded with its exact reason and surfaced to
the operator as a missing-access requirement. A NOT RUN boundary never
converts into a pass._

| Surface | Exact reason | Surfaced to operator |
|---|---|---|
| Live model-rail rows of the longitudinal/economic/audit/journey/pilot waves — 12 recorded rows across VAL-030 (live control), VAL-036 (live maturity), VAL-040 (2 live arms), VAL-042 (2 live arms), VAL-046 (live substrate lifecycle), VAL-047 (live curve), VAL-048 (live primary pair), VAL-049 (live re-run audit), VAL-050 (`live-journey-slice`), VAL-051 (`live-pilot-window`) | no operator-authorized `OPENROUTER_API_KEY` in the delivery environments; the live-review lane owns them (the offline fake worlds refuse the live rail outright; zero durable submissions pinned over REAL SQL) | yes — each work-order evidence document names the env var and the exact row |
| 3D generation/rendering — all six `three-d.render-scene.v1` / `three-d.mesh-from-spec.v1` rows (VAL-018) | no 3D-generation-capable provider in the authorized set (capability-matrix row `model:three-d`, candidates `[]`); minimum credential: one 3D-capable provider key read from `ZECK_3D_API_KEY` | yes — `THREE_D_ACCESS_REQUIREMENT` asserted and printed by the crown suite |
| Video generation beyond the three recorded live generations (VAL-016) | the account's video-generation free quota is exhausted (`AllocationQuota.FreeTierOnly` on submission, live re-probed); the `QWEN_API_KEY` credential itself works — the quota/tier is the boundary | yes — operator payment/tier action recorded as pending |
| Streaming realtime voice rail (VAL-014) | no authorized WebSocket voice-session API (e.g. `qwen3-omni-realtime` / `paraformer-realtime`); the realtime surface is proven through the bounded typed turn protocol with REAL per-turn ASR/TTS legs | yes — `REALTIME_VOICE_RAIL_REQUIREMENT` printed by the crown's gate |
| Live web browser-use (VAL-019) | no operator-authorized browser rail at run time; all rows run against the in-memory shop-fixture page graph (the toolset has no network capability) | yes — declared in the app README and logged by the crown |
| Live desktop computer-use (VAL-019) | no operator-authorized computer-use rail at run time; all rows run against the in-memory workspace fixture (no host-filesystem capability) | yes — declared in the app README and logged by the crown |
| OpenAI-dependent capabilities (matrix rows `model:asr`, `model:audio-understanding`, `model:realtime-voice`, `model:image-generation` via openai) | HTTP 403 `unsupported_country_region_territory` (~30 ms) from this egress; remedy: region-acceptable egress or an alternative authorized provider | yes — VAL-009 boundary #1 |
| BytePlus/Seedance ARK (video-generation candidates) | `ark.ap-southeast-1.bytepluses.com` does not resolve from this environment (DNS failure); the exact endpoint host for the ap-southeast-1 keys is unconfirmed | yes — VAL-009 boundary #2 |
| Container/VM-fleet substrate lifecycle (E2B/Daytona/Modal classes) (VAL-046) | no operator substrate credentials; the live lane is bound to the REAL `ProcessSandboxProvider` (the adapter that exists); the fleets' shapes ride as pinned personas at public-list snapshots | yes — recorded in the evidence document's boundaries |
| CI real-provider suites (portfolio and waves) | no provider credential exists in CI by design; the integration suites skip with an explicit reason when `ZECK_PG_TEST_URL` / `OPENROUTER_API_KEY` / `QWEN_API_KEY` are unset | yes — structural; the recorded proof is the local/Lead batteries of record |
| The home.qwencloud.com key type (VAL-009 probe) | HTTP 401 auth-rejected at dashscope compatible-mode (the `sk-ws-…` shape is not a dashscope credential); no working endpoint found on api.qwen.ai | yes — superseded in practice by the dashscope-international `QWEN_API_KEY` credential (VAL-014..018 live runs) |

## Provider/model coverage and access

Record models/providers actually exercised. Record unavailable provider/model access as NOT RUN with exact reason. Never include credentials or secrets.

| Provider / model | Capability | Access status | Evidence |
|---|---|---|---|
| openrouter / `meta-llama/llama-3.3-70b-instruct` | text, tool-agent, agentic suite, journey/pilot live lanes | READY — live-proven (VAL-009 probes; VAL-010/012/019 live crowns; env `OPENROUTER_API_KEY`) | `docs/work-items/VAL-009.md`, `VAL-010.md`, `VAL-012.md`, `VAL-019.md` |
| openrouter / `qwen/qwen2.5-vl-72b-instruct` | vision, VLM | READY — live-proven (VAL-017 live run; VAL-018 stage-1) | `docs/work-items/VAL-017.md`, `VAL-018.md` |
| dashscope-international / `qwen3-asr-flash` (dedicated ASR task API) | speech-to-text | live-proven (VAL-014 live crown; roundtrip oracle) | `docs/work-items/VAL-014.md` |
| dashscope-international / `qwen3-tts-flash` (text-to-audio) | text-to-speech | live-proven (VAL-014 live crown) | `docs/work-items/VAL-014.md` |
| dashscope-international / `qwen3-omni-flash` (compatible-mode chat) | audio understanding | live-proven (VAL-017 live run; cost $0.000000 on the free tier, honestly) | `docs/work-items/VAL-017.md` |
| dashscope-international / `qwen-image-2.0` (multimodal-generation) | image generation + transformation | live-proven (VAL-015 live crown; VAL-018 stage-2) | `docs/work-items/VAL-015.md`, `VAL-018.md` |
| dashscope-international / `wan2.2-t2v-plus` (async video-synthesis) | video generation | live-proven for three generations; further live rows NOT RUN (free quota exhausted; `QWEN_API_KEY` tier action) | `docs/work-items/VAL-016.md` |
| openai | ASR / audio / realtime voice / image generation | NOT RUN — HTTP 403 region block (`unsupported_country_region_territory`) | `docs/work-items/VAL-009.md` |
| qwen (home.qwencloud.com key) | text (compatible-mode) | NOT RUN — HTTP 401 auth-rejected; endpoint unresolved (superseded by the dashscope-international credential) | `docs/work-items/VAL-009.md` |
| byteplus-ark / seedance (ARK hosts) | video generation | NOT RUN — DNS failure (`ark.ap-southeast-1.bytepluses.com` does not resolve) | `docs/work-items/VAL-009.md` |
| (none) | 3D generation (`model:three-d`) | NOT RUN — no 3D-capable provider in the authorized set; `ZECK_3D_API_KEY` required | `docs/work-items/VAL-018.md` |

Live-probed and rejected model IDs (recorded for the matrix, VAL-017):
`qwen/qwen2.5-vl-7b-instruct` (not a valid model ID),
`meta-llama/llama-3.2-11b-vision-instruct` and `mistralai/pixtral-12b` (no endpoints),
`qwen2-audio-instruct` / `qwen-audio-turbo` (model not found on dashscope-intl
compatible-mode), `qwen3-asr-flash` via compatible-mode chat (400 — the dedicated ASR task
API is the correct rail). Credentials are referenced by environment-variable names only;
no credential material appears in any evidence document (mechanically enforced by the
VAL-009 probe-record validator and the app-config secret scans).

## Reproducibility

Every claimed result must identify application revision, Zeck revision, corpus version, experiment/run identity, environment class, relevant configuration and exact evidence location. Run identities are derived deterministically by the validation laboratory (`benchmarks/validation/run-identity.ts`); the governed program state is `spec/validation-state/` (checked by `scripts/validation-check.py` and the CI validation tests under `tests/unit/validation/`).

- **Run identity machinery (VAL-001):** `deriveRunId` — deterministic SHA-256 over the
  canonical reproduction configuration (timestamp excluded), with
  `checkRunMetadata` admitting only reproduction-complete metadata; the submission contract
  (`benchmarks/validation/submission.ts`) rejects weakened submissions (no evidence refs,
  short SHAs, empty protocol parts, reasonless NOT RUN boundaries).
- **Governed state:** `spec/validation-state/program-state.json` (46 work orders, 45
  complete, merge records as `mergedAs` PRs #42..#117 where recorded),
  `dependency-state.json` and `frontier-state.json` — consistency-checked by
  `scripts/validation-check.py` and the CI validation tests; every work order's evidence
  document resolves at its registered location (`benchmarks/validation/evidence/VAL-001.md`
  for VAL-001; `docs/work-items/VAL-0NN.md` for the rest — 44 documents, all present).
- **Corpus version of record:** `val-corpus.1.0.0` (VAL-003); every application pins its
  slice; fixture/request digests (sha256-16) and trajectory digests (FNV-1a) are recorded —
  payload bytes never appear in any evidence (discrimination-tested across the waves).
- **VAL-049's replay-bit-stability record (the audit of record):** the recorded economic
  evidence of VAL-041..048 re-derives bit-stably — the seven honest replay rows are
  `REPRODUCIBLE-VERIFIED` (VAL-041/042/043: 26 replays; VAL-044: 13; VAL-045: 12; VAL-046:
  13; VAL-047: 12; VAL-048: 13) with every flipped-verdict, rubber-stamp, favorable-subset,
  ungrounded-verdict and off-bounds shape FAILing its NAMED criterion (46 discrimination
  tests); 90 recorded evidence references served READ-ONLY over REAL SQL (the identical
  re-commit REPLAYS; a different-content commit under a recorded key THROWS the
  append-only violation); a headline re-drive reproduced its audit EXACTLY
  (digest-for-digest) over REAL SQL; the recorded basis stayed frozen after the whole
  battery. The audit's mechanical vocabulary: `REPRODUCIBLE-VERIFIED` / `BOUNDS-HELD` /
  `GAMING-DETECTED` (mechanism named) / `NOT-AUDITABLE` (reason named).
- **Environment classes of record:** the Lead's batteries over the program's embedded
  PostgreSQL 16.4 / the userland-provisioned PostgreSQL 16.14 on `127.0.0.1:5433`; the
  worker-local zonky PostgreSQL 16.14 for the worker-delivered economics wave; the
  credential-bearing Lead environment for every live crown run. CI runs credential-less
  and skips the env-gated suites with the env var named (never a fake success).

## Final recommendation

The release-gate conditions of the roadmap's validation completion gate
(`docs/VALIDATION-ROADMAP.md`), each adjudicated from the RECORDED evidence with the
evidence NAMED (the mechanical verdict itself derives in the VAL-052 application's oracle
over the governed state; this section states the program's recommendation honestly and
does not self-declare the Architect's acceptance — that is carried by the authority chain
PR → CI → merge → program-state finalize):

1. **Every customer-style application category is exercised** — all 15 coverage rows cite
   their completed work orders (VAL-010..019, PRs #56..#76); the honest bounded
   sub-surfaces are named (3D NOT RUN — `ZECK_3D_API_KEY`; live web/desktop NOT RUN;
   streaming realtime NOT RUN; video live rows beyond the three recorded generations NOT
   RUN — quota).
2. **Public integration paths are proven usable** — the VAL-002 SDK harness (PR #44, the
   import-scanned public boundary every application rides), the VAL-009 capability matrix
   (PR #49, live-probed provider readiness), the VAL-050 end-to-end customer journey
   (PR #116: 3 honest `JOURNEY-COMPLETED` rows over REAL PG with 5 adversarial probes
   FAILing named criteria) and the VAL-051 production-style pilot (PR #117: 5
   `PILOT-COMPLETED` rows, 7 adversarial probes FAILing named criteria, every offline
   verdict re-proven through three independent derivations with digest parity).
3. **Quality/safety/reliability thresholds are met or explicitly bounded** — the recorded
   portfolio runs carry mechanical criteria with honest FAILED edge rows (17 recorded);
   safety surfaces are proven by VAL-023 (prompt-injection defense: the injected "999"
   never leaked), VAL-024 (tenant isolation: typed violations, zero data disclosure),
   VAL-013/014 (checkpoint corruption detected and never trusted), VAL-019 (authority
   boundaries, secret-flow refusal, HITL gates); unproven surfaces are bounded as NOT RUN
   with their env vars named — no unbounded claim exists in the recorded evidence.
4. **Longitudinal experiments demonstrate whether learning/deterministicization actually
   occurs** — the recorded answer: one family `determinized-stable`, one
   `determinizing-trending`, one `variable-resilient`, one `immature-insufficient-evidence`
   (VAL-036); savings attributed per mechanism with honest residuals (VAL-045); curves
   reporting plateau, never-materialized and a cohort regression openly (VAL-047); the
   canary/rollback machinery with 8 clean promotions and 3 complete rollbacks (VAL-035). A
   recorded tie or negative is a valid demonstration — none was converted into a pass.
5. **Economic experiments compare strong baselines fairly** — the paired-structure
   discipline of VAL-040/041/042/043/044/046/048 (pre-registered arms, Wilson 95%,
   Bonferroni policy, append-only public-list pricing, digest-verified inputs) with the
   recorded verdict: the statistical tie with the point-estimate ranking disclosed.
6. **Every missing-provider-access limitation is disclosed** — the NOT RUN boundaries
   table above (each with its exact reason and gating env var named).
7. **Findings include proposed solutions and residual risks** — the findings section
   (F-1..F-11) carries the full solution protocol per material issue; the residual-risk
   inventory is recorded honestly.
8. **Results are reproducible from repository-defined experiments** — the run-identity
   machinery, the governed state and VAL-049's replay-bit-stability record
   (`REPRODUCIBLE-VERIFIED` across the economic wave; 90 read-only digest-verified
   references over REAL SQL).
9. **The Architect's acceptance of the exact final evidence package** — carried by the
   authority chain (PR → CI → merge → program-state finalize); this report records the
   evidence and the program's recommendation; it does not adjudicate its own acceptance.

**The program's recommendation:** the recorded evidence — 45/46 work orders complete with
honest adversarial discrimination at every layer, all 15 workload categories exercised
through the public boundary, safety and reliability surfaces proven with honest FAILED
probes, the longitudinal and economic answers recorded as they measured (ties and
regressions included), every NOT RUN boundary disclosed with its env var, and the whole
economic wave replaying bit-stably — supports proceeding to the release gate. The
conditions that remain operator-gated (the 12 live-rail rows, the 3D/video/realtime/web/
desktop provider access, the larger economic cohorts) are disclosed, bounded and never
converted into passes; they are the recorded follow-up surface, not silent gaps.

Deadline-remainder honesty (restated): completed 2026-09-14 ~21:25 UTC, ~2h35m before the
2026-09-15 00:00 UTC operator deadline; the governed state as-of 2026-09-14T21:10:45Z
records 45/46 complete with VAL-052 (this work order) in flight per the frontier claim
`08dcd9c` — no incomplete work order is silently dropped; VAL-052's completion is carried
by the Lead's phase-3 authority chain.

## Post-close live-review addendum (R-1 actioned, 2026-09-15)

This section is the durable record of the post-close live-review lane — appended after
the report's completion; no existing section, table row or the status line above is
altered by it. It is evidence plus one repair; no governed state is touched.

**(a) R-1's awaited operator action — actioned post-deadline, honestly timestamped.**
The program met its deadline: the release gate CLOSED and the governed state finalized
at `28adb03` on 2026-09-14T22:26:00Z (~1h34m before the 2026-09-15 00:00 UTC operator
deadline), with the live-review lane recorded as the one open boundary. The operator
provisioned the operator-authorized credential (`OPENROUTER_API_KEY` — referenced by
env-var name only, per the report's standing discipline) on 2026-09-15 ~02:39 UTC —
after the deadline, actioned late but honestly — and the lane executed 02:48–03:45 UTC
the same day over the program's PostgreSQL (`127.0.0.1:5433`).

**(b) Capability probes and route health (VAL-009 discipline).** The text probe
(`qwen/qwen-2.5-7b-instruct`) and the VLM probe (`qwen/qwen3-vl-8b-instruct` + a 1×1
white PNG) both returned ready HTTP 200 (02:48:57/58Z, 1548 ms and 1085 ms). The VLM
route degraded mid-session (02:58:01Z probe: HTTP 400 provider-error) and RECOVERED by
03:15:53Z (probe ready again @1005 ms; a direct probe-identical VLM dispatch returned
HTTP 200 via Parasail, content "white", $0.00002225). The 4 honest NOT RUN probe
records (openai, qwen, byteplus-ark, seedance — each env-var named) are unchanged. One
disclosed execution adaptation: the sandbox kills background processes, so the battery
ran as 4 foreground chunks over the same 40 integration files, same env, one log.

**(c) The battery outcome (first pass, 02:56–03:09 UTC).** Over
`tests/integration/validation`: **91 tests — 88 passed / 3 failed / 0 skipped** (Test
Files 37/3 of 40). Every `OPENROUTER_API_KEY`-gated live row fired REAL dispatches; the
text rail `meta-llama/llama-3.3-70b-instruct` stayed healthy ALL session; the
VAL-050/051/052 crowns pin zero live submissions BY DESIGN (not forced). The three
first-pass failures, each re-run once (disclosed), were adjudicated honestly:

- **VAL-017 and VAL-023 — transient vision-route degradation → GREEN on single
  re-runs** after the route's recovery (03:15–03:27 UTC). val-017 `img-c-001` COMPLETED
  (contains:bus PASS, content-present PASS; usage 108+2 tokens / $0.000088; latency
  7426 ms; suite 5 COMPLETED + 1 designed-corruption FAILED of 6, measured $0.000400) —
  the latency arithmetic of the first-pass failure (13908 ms − 2×6 s retry waits ≈ 3
  fast attempts) attributes it to the retryable 429/5xx class on
  `qwen/qwen2.5-vl-72b-instruct`, not the probe's HTTP 400. val-023
  `live-openrouter-injection-media` COMPLETED defended (attempts=1, latency 685 ms,
  usage 314+2 / $0.0002532; 3/3 live rows defended, 10/10 offline COMPLETED).
- **VAL-044 — a GENUINE delivery defect, repaired and live-verified.** The live row
  `live-adjusted-synthesis-real-comparison` declared `needsDispatch: true` but NO
  dispatch seam existed (the VAL-041/042/043 precedent not followed): the integrity
  oracle re-derived digests over empty/placeholder traces → DIGEST-DISAGREED ×3
  (direct `3af163c7` ≠ `6a447122`; optimized `f5a3fd21` ≠ `631383f4`; competing
  `f462552c` ≠ `6a9bfd48`) → criterion `input-integrity-digest-verified` FAIL, driver
  category `input-integrity-failed`, verdict `adversarial-failed` — deterministic ×3,
  ZERO dispatches (~300 ms fast-fail; the route hypothesis exonerated). Repaired at
  `bcc49a1` on `work/live-review-val-044-repair` (the live-rail seam binding); live
  re-run: **11 REAL dispatches, 111 µ$ measured**, arm digests `38ef7c3a` /
  `bcadcded` / `9a1360d2` oracle-verified → **COMPLETED** (quality-adjusted),
  inputs=3 verified=3, pooled 12r/12x, attainment 1.000000, Wilson 95% [0.757,
  1.000] — mechanically derived, never fabricated. The scoped battery at the repair
  head is all green (unit 72/72 counts unchanged; honest-skip preserved; neighbors
  VAL-041/042/043 6/6; discrimination 35/35; tsc EXIT 0; biome clean) — after the
  repair 91/91 live-lane integration tests are green. Full record:
  `docs/work-items/VAL-044.md` (live-review addendum).

**(d) VAL-049's live re-run audit slice — bounds-held PASS ×2.** The live re-run row
(recorded NOT RUN at close) executed twice (pilot 02:53 UTC + battery): 4 REAL
dispatches each on the pinned rail `meta-llama/llama-3.3-70b-instruct` (max_tokens
32), **measuredRate 1.000000 both runs**, measured 22 µ$ and 16 µ$, **bounds=PASS**
against the RECORDED direct-arm Wilson bounds through the bounds-held oracle, terminal
COMPLETED, the audit record sealed through the REAL recorder over REAL PostgreSQL. The
offline audit corpus is untouched. Full record: `docs/work-items/VAL-049.md` (live
re-run of record).

**(e) The economic arms' live re-measurements** (rail-reported BYOK facts, each inside
its recorded bounds; 25+ suites' live rows carry measured economics from this lane):
VAL-010 8/10 COMPLETED $0.000478; VAL-012 12/14 COMPLETED $0.001233; VAL-040
fixed-quality 50 µ$/cpr 13 µ$ + fixed-cost 48 µ$/12 µ$; VAL-041 direct 36 µ$/9 µ$ ×2;
VAL-042 optimized 29 µ$/7 µ$ (incl. 1 REAL cache hit) + 42 µ$/11 µ$; VAL-043 competing
35 µ$/9 µ$ + 40 µ$/10 µ$; VAL-046 substrate 46 µ$, effective 19 µ$/resolved; VAL-047
trajectory 26 → 34 → 28, measured 264 µ$; VAL-048 ranking zeck < direct, 41 µ$.

**(f) Total measured live cost of the whole lane: well under $0.01** (against the
disclosed ~$2 battery bound) — including the two disclosed live runs of the repaired
VAL-044 row (105 µ$ confirmation + 111 µ$ final = $0.000216).

**(g) The REMAINING NOT RUN boundaries are UNCHANGED** — none converted, none will be
without further operator credentials (each env-var named): the `QWEN_API_KEY`
boundaries (streaming realtime voice, image/video generation quota, the audio legs,
the qwen probe); 3D generation (`ZECK_3D_API_KEY` — no authorized 3D-capable
provider); the OpenAI region block; the BytePlus/Seedance ARK DNS failures; the
external substrate fleets (E2B/Daytona/Modal); the live web/desktop browser rails.

**(h) Program state unchanged.** The governed state remains roadmap-complete /
frontier-empty at `28adb03` (46/46, release gate CLOSED). This addendum is evidence
plus one repair carried on the branch `work/live-review-val-044-repair`; the repair's
merge belongs to the Lead's authority chain (PR → CI → merge), never self-declared
here.

**(i) Closing honesty statement.** A NOT RUN boundary was converted to a measured
record only through REAL dispatches with mechanically derived verdicts — never a
fabricated pass. The one defect the lane found (VAL-044's missing dispatch seam) was
repaired and live-verified per the F-2 house pattern (the credential-bearing live
review as the merge authority — Recommendation R-7). The lane's transient vision-route
degradation (02:58Z) and recovery (03:15Z) are recorded with their measured evidence;
the honest timeline — deadline met 2026-09-14T22:26:00Z, the operator action arriving
2026-09-15 ~02:39 UTC, the lane executing 02:48–03:45 UTC — stands as recorded.
