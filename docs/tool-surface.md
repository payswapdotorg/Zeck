# Tool Surface — operator and developer guide (WORK-051 / E1.1 stage 3)

The tool-surface plane (`src/platform/tool-surface/`) is the E1.1
charter's stage-3 compiler: it derives the MINIMAL useful tool surface
for a governed plan (ADR-0019 §5's seven representations) and the
bounded programmatic-execution path that lets mechanical fan-out /
filter / aggregate / projection work execute OUTSIDE model context
INSIDE the existing sandbox authority (ADR-0019 §6) — with no new tool
authority.

## What it is — and what it is not

| It IS | It is NOT |
|---|---|
| A pure, deterministic DERIVATION of the minimal tool surface from (plan IR, capability facts, configuration) | A negotiated or model-selected tool surface |
| A closed, typed seven-representation catalog with recorded per-representation preconditions | A tool registry or tool-routing authority (the catalog is DATA; decisions stay compiler/seam-owned) |
| Bounded programmatic execution through the EXISTING sandbox authority (admission → dispatch → journaling, verbatim) | A second sandbox, a sandbox escape, or a capability widening |
| Compact, structured, typed, content-addressed results that round-trip into the plan's result contract | An unbounded or untyped result channel |
| A deterministic, replayable provenance audit (plan → IR → surface → run) | A state machine, a durable store, or an execution lifecycle |

MCP is ONE representation among the closed set — never required: it
participates only when BOTH a binding exists AND the adapter is
explicitly enabled; a disabled adapter records the typed
`mcp-adapter-disabled` rejection and the selection moves on.

## The derivation

```
governed, validated Execution IR (WORK-049), optionally a
WORK-050 compiled variant (source chain must match)
      │
      │  governing constraints (READ-ONLY capability + policy mirrors)
      │  + tool-surface configuration (caller-provided DATA)
      ▼
deriveToolSurface(input) ──────────────────────────────▶ ToolSurface
      │   extract declared tool needs (call-tool steps)               │
      │   capability + policy conditioning (fail-closed)              ├─ surfaceId (sha256, content-addressed)
      │   per-need representation selection                            ├─ toolBindings (one per declared need)
      │   programmatic decisions for mechanical steps                  ├─ programmatic decisions
      │   minimality self-check + canonical digest                     └─ provenance (plan → IR → variant)
      ▼
auditToolSurface(surface, input) ── replayable proof: zero violations
```

The surface is DERIVED, never negotiated: the plan's declared needs
plus the governing facts determine it deterministically. A need whose
tool capability is unsatisfied (or absent) fails the whole derivation
closed (`capability-condition`); a denied or unlisted tool fails closed
(`policy-condition`) across ALL SEVEN representations — the
configuration can never widen, grant or bypass a capability or a
policy restriction.

## The closed representation set (7) and the selection order

`direct` · `deferred` · `cli` · `script` · `code` · `mcp` ·
`competence` — exactly ADR-0019 §5, closed and typed: an invented
representation is unrepresentable (validation rejects it).

Every need gets EXACTLY ONE representation: the FIRST ADMISSIBLE one
in the frozen canonical order (lexicographic over the recorded rank
triple — context cost, orchestration cost, failure surface — then the
representation id):

```
direct > competence > code > cli > script > mcp > deferred
```

Every NON-selected representation records exactly one closed
rejection code:

- `binding-absent` — the configuration carries no binding of this
  representation for the tool;
- `mcp-adapter-disabled` — an mcp binding exists but the adapter is
  disabled (MCP never required);
- `lower-canonical-rank` — admissible but ranked after the selected
  representation (the deterministic preference itself is the evidence).

A need with NO admissible representation fails the derivation closed
(`no-admissible-representation`) — never a silently dropped tool.

## Minimality and determinism (proven, not claimed)

- **Minimality**: the surface carries exactly one binding per declared
  need and nothing else — `assertSurfaceMinimal` proves set equality
  against the plan's extracted needs; the audit re-proves it. A
  superset (or subset) surface is rejected (`surface-non-minimal`),
  EVEN when the attacker recomputes the content digest — the audit's
  deterministic replay catches what identity forgery hides.
- **Determinism**: the same (IR, constraints, configuration) produce
  the identical `surfaceId`, byte-identical including every recorded
  rejection (content-addressed over the canonical form). Re-derivation
  is a bounded no-op; drift is detected (`derivation-mismatch`).
- **Identity**: `validateToolSurface` re-digests the canonical content
  — a surface whose content does not digest to its claimed
  `surfaceId` is rejected (`surface-identity-mismatch`).

## Bounded programmatic execution

A plan's MECHANICAL steps (deterministic, pure) may declare bounded
programmatic work through the closed step-config key `programmatic`:

```json
{
  "specId": "curate-filter",
  "stepId": "curate",
  "operation": "filter",
  "params": { "field": "status", "equals": "ok" },
  "bounds": {
    "maxInputItems": 64,
    "maxIterations": 512,
    "maxOutputBytes": 8192,
    "wallClockMs": 5000
  }
}
```

- the OPERATION vocabulary is closed: `fan-out` · `filter` ·
  `aggregate` (count/sum) · `projection`;
- the BOUNDS are explicit and fail closed: every bound is required,
  integer, positive and hard-capped (unbounded work is
  unrepresentable — `bound-violation`, `iteration-exceeded`,
  `output-unbounded`, `input-unbounded` are all typed rejections);
- the evaluator KERNEL (`evaluateProgrammaticSpec`) is the pure
  in-process reference; the sandbox-side runner implements the SAME
  closed semantics inside the dispatched process (a dedicated test
  pins the two implementations together so they cannot drift).

### The execution path (inside the EXISTING sandbox authority)

```
declared spec (validated) + bounded input
      │
      ▼
runProgrammaticExecution(request, seam, digest)
      │   total validation before anything crosses
      ▼
SandboxComputeSeam.runProgrammaticWork()        [neutral port]
      │   implemented by the ONE module-side adapter:
      │   src/modules/sandbox/adapters/tool-surface-compute-seam.ts
      ▼
the PUBLIC SandboxService — the FULL existing authority:
policy → capability → budget admission, durable identity,
ledger envelopes, provider dispatch, timeout enforcement
      │
      ▼
compact structured result (typed, bounded, content-addressed,
bound to the plan's mechanical family)
```

THE CROSSING (v1): the validated spec and bounded input are embedded
as constants inside ONE content-addressed runner file under the OS
temp domain; the sandbox task names that file by its digest-pinned
path. The durable task stays tiny — the sandbox authority's frozen
request fingerprint (bounded to 500 chars, migration 0008) covers the
whole canonical task, so a task carrying kilobytes of payload is
unrepresentable durably; the content-addressed file keeps the
idempotency fingerprint a pure function of the crossing CONTENT
(identical logical requests produce identical tasks, and the
digest-pinned path records exactly which runner+payload ran). The
runner reads nothing — no argv payload, no environment, no
filesystem.

Wall-clock honesty: the declared `wallClockMs` must be covered by the
environment's admitted `executionTimeoutMs` — the adapter fails the
run closed BEFORE submission when it is not (the authority enforces
the timeout itself).

Every post-admission authority outcome surfaces as a TYPED
observation — completed / failed / denied / non-convergent — including
the authority's §14 discipline (an in-flight dispatch may not be
re-executed: concurrent same-key runs converge on ONE durable row,
the winner's outcome is the durable truth, and the losers surface the
typed `non-convergent` fail-closed error). The executor never
fabricates a success from a mutating runner: the runner's closed
result envelope is validated totally (unknown codes, unparseable
output and untyped values are rejected — never trusted).

## Compact structured results

The result crosses back into the plan as a `CompactStructuredResult`:
the typed value (shape enforced per operation), bounded by the spec's
`maxOutputBytes` (oversized results are rejected, never truncated),
content-addressed (`resultDigest` = sha256 over the canonical
`{stepId, operation, value}`), with exact provenance (spec id, the
durable sandbox execution identity, the sandbox output digest, the
tool-surface identity). `bindResultToPlan` proves the result binds to
a step of the plan's MECHANICAL family (a result for an invented or
non-mechanical step is unrepresentable); `roundTripCompactResult`
proves byte-stable round-trips.

## The module surface (7 files + 1 adapter)

- `catalog.ts` — the closed representation set, rank triples,
  selection order, precondition/invariant vocabularies, the bounded
  configuration and its total validation, the READ-ONLY capability /
  policy conditioning helpers;
- `needs.ts` — pure tool-need extraction + the honest programmatic
  decisions (declared / not-declared / disabled);
- `programmatic.ts` — the closed operation/bound/error vocabularies,
  the spec/input validation and the pure evaluator kernel;
- `results.ts` — compact structured results: typed values, digests,
  plan binding, round-trips;
- `derive.ts` — `deriveToolSurface`, `validateToolSurface`,
  `assertSurfaceMinimal`, `auditToolSurface`;
- `seams.ts` — the neutral `SandboxComputeSeam` port (the ONLY path
  into the sandbox authority);
- `executor.ts` — `runProgrammaticExecution` (validate → submit →
  validate the output → bind to the plan);
- `src/modules/sandbox/adapters/tool-surface-compute-seam.ts` — the
  ONE shipped seam implementation, over the sandbox module's PUBLIC
  service (the only module-side reference to this plane).

The plane holds NO store, NO SQL, NO migration, NO state machine: the
durable surfaces are the sandbox authority's own (every programmatic
run is an admitted, dispatched, journaled sandbox execution).

## Where this goes next

WORK-056 (competence-aware optimization and progressive
deterministicization) consumes these representations: the competence
binding becomes a selectable representation with equivalence
evidence, and repeatedly-successful programmatic work is the
deterministic-replacement candidate feed. Nothing in this plane needs
to change for that.
