# economic-audit (VAL-049)

The reproducibility and anti-gaming audit of the economic results: the mechanical AUDIT engine over digest-referenced RECORDED evidence — the recorded verdicts of VAL-041..048 replayed end-to-end (bit-stable) and every gaming vector re-probed against the FINAL integrated machinery.

**Every audited input is a content-digest reference into the audited work order's OWN corpus** — imported (never copied), re-derived through the audited corpora's own public machinery (the VAL-048 extractor/synthesis, the VAL-044 adjusted synthesis, the VAL-045 split derivation, the VAL-046 window builder, the VAL-047 point references). The audit READS the recorded corpora — it never writes them, never re-runs them, never re-prices them.

## The two arms

| Arm | What it proves |
|---|---|
| `REPRODUCIBILITY` | every recorded verdict of VAL-041..048 re-derived from the recorded inputs (digest-verified), bit-stable — a verdict that flips on replay FAILs named; an honest divergence record WITH cause is permitted where declared |
| `ANTI-GAMING` | every gaming vector (quality inflation, latency omission, failure hiding, estimate conflation, post-hoc exclusion, window cherry-picking, regime normalization, hidden weights, silent drops, re-measurement masquerade) re-probed against the final integrated machinery, PLUS cross-vector combinations — each expected GAMING-DETECTED with the mechanism(s) NAMED |
| `BOUNDS` | a sampled re-run's measured economics checked against the recorded declared bounds (an out-of-bounds re-run reported as held FAILs named) — the offline floor + the env-gated live re-run slice |

## The corpus (29 rows)

| Row | Arm | Expected verdict |
|---|---|---|
| `replay-controls-recorded-arms` | repro | **COMPLETED** REPRODUCIBLE-VERIFIED (VAL-041/042/043 offline corpora replayed) |
| `replay-adjusted-cost-verdicts` | repro | **COMPLETED** REPRODUCIBLE-VERIFIED (VAL-044) |
| `replay-savings-attribution-splits` | repro | **COMPLETED** REPRODUCIBLE-VERIFIED (VAL-045) |
| `replay-substrate-window-facts` | repro | **COMPLETED** REPRODUCIBLE-VERIFIED (VAL-046) |
| `replay-longitudinal-curve-points` | repro | **COMPLETED** REPRODUCIBLE-VERIFIED (VAL-047) |
| `replay-cross-workload-verdicts` | repro | **COMPLETED** REPRODUCIBLE-VERIFIED (VAL-048) |
| `replay-declared-divergence-recorded` | repro | **COMPLETED** REPRODUCIBLE-VERIFIED (the declared extrapolation divergence — cause named, permitted) |
| `boundary-live-measured-slices-not-auditable` | repro | **COMPLETED** NOT-AUDITABLE (the live measured slices demand the credential) |
| `boundary-payload-bytes-never-recorded` | repro | **COMPLETED** NOT-AUDITABLE (digest references only — no bytes to replay) |
| `bounds-recorded-confidence-offline` | bounds | **COMPLETED** BOUNDS-HELD (the recorded Wilson interval floor) |
| `probe-vector-*` (10 rows) | anti-gaming | **COMPLETED** GAMING-DETECTED (each vector, mechanism NAMED) |
| `probe-combination-*` (3 rows) | anti-gaming | **COMPLETED** GAMING-DETECTED (BOTH mechanisms named) |
| `probe-finding-accepted-risk-recorded` | anti-gaming | **COMPLETED** GAMING-DETECTED (accepted-risk record carried) |
| `probe-audit-rubber-stamp` | repro | **FAILED** (rubber-stamp-detection — the claimed skip named) |
| `probe-audit-favorable-subset` | repro | **FAILED** (favorable-subset-sampling — the omitted rows named) |
| `probe-audit-off-bounds` | bounds | **FAILED** (bounds-held — the offending value + bound named) |
| `probe-audit-unresolved-finding` | anti-gaming | **FAILED** (resolution-honesty — the unresolved finding named) |
| `live-audit-real-rerun-slice` | bounds | **COMPLETED** BOUNDS-HELD (env-gated on `OPENROUTER_API_KEY`; honest NOT RUN without) |

## The mechanical verification core (per row)

The oracles (each FAILs with the offending items NAMED): replay bit-stability (digest + verdict equality, the re-derivation trace), rubber-stamp detection (verification claimed without re-derivation), favorable-subset sampling (the omitted rows named), verdict-grounding (every verdict cites its evidence digest — an ungrounded verdict FAILs named), gaming-probe completeness (every vector + combination caught with the mechanism named), bounds-held checking (measured vs recorded bounds), resolution honesty (a resolved finding without a fix or accepted-risk record FAILs named), audit input integrity (disagreeing digest / unresolvable reference FAILs named).

## Boundaries

- The offline corpus is deterministic: zero credentials, zero network, zero re-measurement — every audit row re-derives from the imported recorded corpora.
- The live re-run row is env-gated on `OPENROUTER_API_KEY` (BYOK, measured usage, `max_tokens` 32 pinned, temperature unset per the provider's documented default). Without the credential the row is honestly NOT RUN.
- Evidence carries payload DIGESTS only — never payload bytes. No credentials in the repository, logs or reports.
