# PPR-003 — The public user-journey acceptance harness

A repeatable acceptance harness for the actual public Zeck experience:
it executes the 12 public user journeys (the PPR-003 work order's set,
in order) against a TARGET plane over real HTTP, attests the deployed
plane at an EXACT revision BEFORE any journey asserts (the fail-closed
whole-run identity gate), maps all 22 workload families of the machine
capability manifest to discovery location / availability state /
example path / provider-access explanation, records pass | fail |
not-run with evidence for every step, and converts every material
deviation into the findings contract (the input to the next
smallest-valid correction Work Order — the harness never fixes
anything itself).

NO new authority: identity verification, health semantics,
honest-boundary route expectations, boot-document plane waiting and the
secret-pattern vocabulary all reuse the repository's existing modules
(`deploy/plane-identity.ts`, `deploy/lib.ts`, `deploy/e2e-validate.ts`'s
exported boot-document detector, the machine manifests under
`docs/developer/machine/`).

## The Lead's invocation (the moment the public preview is live)

```bash
# from a checkout of the EXACT deployed revision:
git checkout <the-deployed-revision>
bun install
bun tests/journey/run.ts \
  --url https://<the-public-preview-url> \
  --environment preview \
  --branch <the-deployed-branch> \
  --report deploy/evidence/ppr-003-live.json

# credentialed journey steps (optional — the real sandbox path):
ZECK_JOURNEY_TOKEN=<bearer> \
ZECK_JOURNEY_APPLICATION_ID=<application-uuid> \
bun tests/journey/run.ts --url https://<the-public-preview-url> \
  --environment preview --branch <the-deployed-branch>
```

The expected revision defaults to the checkout's HEAD (the
`deploy/public-smoke.ts --url` contract); pin it explicitly with
`--expected-revision <40-hex-sha>` when the checkout and the deployed
revision differ deliberately. A PREVIEW-environment plane requires
`--branch <branch-name>` — the per-branch preview resource set makes
the preview slug an identity input (the same contract as
`deploy/public-smoke.ts --url`; the live PPR-003 run's first finding,
2026-09-21, was the harness dropping it).

Exit codes: `0` = every executed step passed (not-run boundaries are
honest, never failures); `1` = any step failed, any finding fired, or
the identity gate refused the run; `2` = the harness's own preflight
refusal (invalid arguments, a credential-carrying URL, a malformed
revision).

## Local modes (the harness's own proof)

```bash
bun tests/journey/run.ts --local-plane   # boots the REAL deploy/api.ts
                                         # (the deploy chain's local mode;
                                         # no-PG degradation supported —
                                         # /health answers the honest
                                         # fail-closed 503 down with
                                         # controlPlane ready)

bun tests/journey/run.ts --self-proof     # the local-plane run + the three
                                         # hostile negatives (wrong
                                         # revision, unreachable target,
                                         # secret-leak page)
```

## The 12 journeys

discover; capability discovery; sandbox start; first text execution;
execution inspection; evidence/cost; validation rerun; compare;
export/reproduce; trust/limits; agent onboarding;
production/deployment. (Pinned in order by
`tests/unit/journey/harness-contract.test.ts`.)

## The verification dimensions

Applied per step, over real HTTP: reachability; navigation (the served
link graph answers); browser-console-error signal (resource integrity
— every referenced script/style/image answers; the interactive browser
pass is the Lead's, recorded NOT RUN with its owner); the exact
deployment revision (the whole-run gate); real sandbox execution (the
credentialed path); validation rerun surfaces; compare/export; the
provider-gated/NOT RUN disclosure honesty (the manifest's own
vocabulary); keyboard/focus (structural affordances: skip link, main
landmark, primary nav, aria-current); desktop/tablet/mobile (the served
CSS's media-query plan); reduced motion (`prefers-reduced-motion`); and
secret safety (the repository's credential-shaped pattern set, applied
to every fetched body AND to the harness's own serialized report).

## Layout

- `types.ts` — the shared report/finding/matrix types.
- `defect-classes.ts` — the closed defect-class vocabulary.
- `http.ts` — the evidence-carrying HTTP client (digests, never raw bodies).
- `dom.ts` — the structural (layout-independent) assertion helpers.
- `secret-safety.ts` — the secret patterns + the redaction discipline.
- `identity-gate.ts` — the fail-closed exact-revision preflight.
- `capability-matrix.ts` — the 22-family matrix derivation.
- `route-probes.ts` — the public-route honest-boundary table.
- `context.ts` — the step recorder + the surface auditor.
- `journeys.ts` — the 12 journey definitions.
- `runner.ts` — the ordered discipline + the acceptance-gate derivation.
- `local-plane.ts` — the real deploy/api.ts boot (boot-document wait).
- `negatives.ts` — the three hostile-negative drills.
- `run.ts` — the CLI entry.

Its tests: `tests/unit/journey/harness-contract.test.ts` (the fast
contract battery) and `tests/integration/journey/harness-e2e.test.ts`
(the real-subprocess proof — local plane, wrong-revision, unreachable,
secret-leak).

The evidence record: `deploy/evidence/ppr-003.json` (structure follows
`deploy/evidence/dep-040.json`).
