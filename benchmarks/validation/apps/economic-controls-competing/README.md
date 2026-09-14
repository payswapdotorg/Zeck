# Economic-Controls-Competing Application (VAL-043)

A customer-style economics application: one pinned competing-stack
corpus row per run, submitted through Zeck's public SDK boundary,
delivering the COMPETING GATEWAY/ROUTER STACK benchmark arm of the
economic validation wave — the frozen app portfolio replayed through
a real routing product a customer could use INSTEAD of Zeck,
configured per its own documented best practices, so the economic
comparison includes the actual market alternative (VAL-005's
competing-stack arm grammar; roadmap hypothesis 5).

## The competing stack (the declared configuration)

The competitor is instantiated as **OpenRouter itself in its
documented gateway/router posture** — the natural market alternative:
the same pinned models, routed through OpenRouter's own gateway
semantics with its documented defaults. The stack's configuration is
EXPLICIT, EXHAUSTIVE and CONTENT-ADDRESSED (alongside the VAL-040
pinned price manifests): `competitor-config.ts` pins the registry —
each toggle named, bounded, and carrying its DOCUMENTED reference
(the competitor's own documentation). `cmp-rev-001` declares:

- **model-selection-by-task-class** — the customer's declared
  per-class model slugs through the competitor's catalog (summarize →
  retry-relay, extract → openrouter/llama-3.3-70b, translate →
  euro-relay, transform-batch → batch-relay; every rail priced through
  the pinned manifest rev-001);
- **provider-pool-routing** — the competitor's own pool ordering (its
  documented default): the gateway may route equivalent requests to
  different pool endpoints — the nondeterministic routing is DECLARED
  honest variance (the reproducibility oracle's declared path,
  carried with the Wilson 95% interval, never waived);
- **automatic-provider-fallback** — the competitor's documented
  retry-across-providers behavior, bounded at 2 internal retries
  (**tightened to 1 in the corrected cmp-rev-002** — the correction
  is a NEW revision, append-only); the amortization happens INSIDE
  the competitor's boundary: one request reports the AGGREGATE usage
  its gateway saw, internal attempts included;
- **generation-usage-accounting** — the generation-data usage is the
  measured fact; the rail's own charge is a CROSS-CHECK OBSERVATION
  ONLY (never the comparison basis — every arm prices through the
  pinned manifest's public list prices);
- **request-defaults-documented** — temperature unset (the model's
  own default), provider sort unset (the pool's own ordering);
- **completion-budget-pinned** — max_tokens pinned explicitly per
  request (the OpenRouter unaffordable-budget 402 lesson).

The configuration-conformance oracle FAILs any run where the
competitor applies a setting the declaration does not name (the
undocumented-configuration masquerade catch); the
configuration-integrity oracle FAILs an in-place bound mutation (the
digest disagreement catch); the model-selection-conformance oracle
FAILs a misrouted request; the retry-posture oracle FAILs an
undeclared retry escalation; the behavior-variance oracle FAILs
nondeterministic routing UNLESS declared as honest variance with the
confidence carried; the replay-fidelity oracle FAILs an understated
token count; the charge-observation-separation oracle FAILs any
conflation of the rail's own charge into the comparison basis.

## The experiment protocol

Every run executes the FROZEN VAL-040 protocol: the arms declare
their kind (fixed-quality / fixed-cost), the pinned price revision,
the pre-registered corpus slice and the statistical minimums; every
comparison carries the Wilson 95% interval; threshold attainment is
recomputed from the accounted runs; the budget gate decides BEFORE
dispatch (the per-round bound is the worst case over the row's
declared classes' model selections). The usage facts price per-fact
through the ROUTED rail — the canonical
micro-USD-per-resolved-outcome basis normalizes the mixed-rail
economics exactly.

## The pinned corpus (`economic-controls-competing.experiment.v1`)

| Row | Arm | Competing surface | Expected |
|---|---|---|---|
| fixed-quality-competitor-default-routing | fq-competing-default (0.75, 8) | 7 primary-endpoint requests + 1 request with TWO internal fallbacks (aggregate 360/50) + a competitor quote | COMPLETED; 8/8; measured 210 µ$; cpr 26 µ$; est 17 µ$ |
| fixed-quality-competitor-routed-classes | fq-competing-routed (0.75, 8) | 3 catalog classes (summarize/extract/transform-batch), 1 internal fallback, ceil-to-batch on BOTH tiers (520 in → 1000 charged; 60 out → 500 charged) | COMPLETED; 8/8; measured 602 µ$; cpr 75 µ$; est 17 µ$ |
| fixed-quality-competitor-eu-catalog | fq-competing-eur (0.75, 6) | the EU-priced catalog entry (EUR per-1M → pinned FX), 1 honest moderation refusal | COMPLETED; 5/6; measured 747 µ$; cpr 149 µ$ |
| fixed-quality-competitor-corrected-config | fq-competing-corrected (0.75, 6) | the CORRECTED config (cmp-rev-002: fallback tightened to 1) — 2 requests with one internal fallback | COMPLETED; 6/6; measured 166 µ$; cpr 28 µ$ |
| fixed-cost-competitor-within-budget | fc-competing-default (400 µ$, 6, min 6) | 5 confirmations + 1 honest refusal within the budget | COMPLETED; 5/6; measured 125 µ$; cpr 25 µ$ |
| fixed-cost-competitor-budget-exhausted-honest-stop | fc-competing-stop (70 µ$, 8, min 3) | the pinned round bound (24 µ$) stops after 3 requests — the declared prefix stop | COMPLETED; 2/3; measured 59 µ$; cpr 30 µ$ |
| zero-resolved-competitor-null-discipline | fc-competing-zero (1200 µ$, 6, min 6) | every request fails honestly at the competitor boundary | COMPLETED; 0/6 resolved; **costPerResolved NULL** |

The live rows (env-gated on `OPENROUTER_API_KEY`):
`live-fixed-quality-competitor-real-dispatch` (4 REAL requests through
the competitor's REAL interface — the REAL model gateway over the
REAL OpenRouter rail, temperature unset per the documented default,
max_tokens 64 pinned) and `live-fixed-cost-competitor-real-budget`
(the 600 µ$ REAL budget gating 4 REAL requests).

Every offline row references the FROZEN app portfolio (the VAL-030
baseline revisions) by content digest — never copied. The offline
rows need no credentials: the recorded competitor-interface traces
drive every row deterministically (zero network). The live rows are
env-gated on the operator-authorized OpenRouter credential; absent
credentials are a recorded NOT RUN boundary — never a fake success.

## Boundaries

- The application never embeds prices: the arms declare WHICH pinned
  manifest revision priced their runs (`rev-001`); pricing resolves
  through the registry only.
- The competitor's configuration never embeds negotiated behavior:
  the rows declare WHICH pinned configuration revision configured the
  stack (`cmp-rev-001` / `cmp-rev-002`); the declaration is exhaustive
  by construction and probed adversarially (an undocumented toggle
  FAILs, a silent behavior change FAILs unless declared variance).
- Evidence carries payload digests only — never payload bytes.
- Secrets never appear in the repository, logs or reports.

## Run entry points

- Unit (offline oracle floor): `tests/unit/validation/val-043-competing-stack.test.ts`
- App over the fake world: `tests/unit/validation/val-043-apps.test.ts`
- Discrimination battery (AC6):
  `tests/discrimination/competing-stack-validation.discrimination.test.ts`
- The PG-gated crown (AC3/4/5/7 — REAL platform path + env-gated live
  rail): `tests/integration/validation/val-043-competing-stack.test.ts`
