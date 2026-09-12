# Three-D-Rendering Application (VAL-018)

A customer-style 3D generation/rendering application: a seeded 3D
prompt plus declared geometry parameters, submitted through Zeck's
public SDK boundary, with mechanically verified 3D artifacts
(container validity + digest — when a rail exists).

## What it does

Submits pinned three-d corpus tasks (`kind: "generate-3d"` with a
seeded 3D prompt fixture key and declared geometry parameters:
primitive, bounding dimensions, mesh resolution, output format), awaits
async completion, retrieves the result package and asserts the
deterministic outcome contract. The empty-prompt, negative-dimension
and zero-resolution rows are the corpus's own expected-FAILED edge
rows — mechanically invalid requests the platform rejects BEFORE any
paid dispatch (never a silently substituted primitive, never a
fabricated mesh).

## The honest NOT RUN boundary (no 3D rail exists)

No authorized provider in the program's access set (Kimi, Qwen, Muse,
OpenRouter's exposed models, OpenAI, Meta AI, Seedance, Gemini)
currently serves a 3D generation/rendering rail. The REAL dispatch of
the healthy rows is therefore an honest recorded NOT RUN boundary —
surfaced to the operator in `docs/work-items/VAL-018.md` with the
exact missing access requirement (provider/model candidates, why
needed, experiment unlocked, minimum credential) per the roadmap's
provider-access policy — never a fabricated equivalent. Everything
short of the live wire is proven and reproducible:

- the offline task derivations (materialization, canonical request
  bodies, request digests) execute and are unit- and
  discrimination-tested;
- the platform's 3D verification criteria (GLB/OBJ container validity,
  declared-format match, payload presence, sha256 digest capture) are
  proven against synthetic 3D artifacts;
- the dispatch binding's pre-dispatch discriminations (wrong-modality,
  fixture-digest mismatch, blank prompt, invalid geometry) and its
  honest `three-d-rail-absent` boundary are mechanically verified
  with zero rail calls;
- the application itself rides the public SDK boundary end to end
  over the controlled fake API world in the unit suite;
- the driver (`platform/three-d.ts`, mirroring `driver.ts`) lights up
  over a REAL rail the moment operator-authorized 3D access exists —
  the same crown-test wiring then drives the healthy rows end to end.

## Boundaries

- Integrates ONLY through the public SDK (the validation harness) —
  never Zeck internals; never selects provider/model/rail.
- Configuration is repository-reproducible and secret-free; the single
  secret is the environment token (`ZECK_VALIDATION_TOKEN`).
- The seeded 3D prompt fixtures (`prompt-3d-001..004` + the empty
  prompt edge, materialized in `apps/shared/three-d-scenes.ts`) make
  every derivation reproducible at the request level — no external
  media, no external scenes.

## Run

The application is proven over the controlled fake API world by the
unit suite (`tests/unit/validation/val-018-apps.test.ts`). The
integration suite (`tests/integration/validation/val-018-3d-transform.test.ts`)
records the NOT RUN boundary honestly and executes the offline
derivation proofs; the REAL dispatches light up when a 3D rail is
authorized.
