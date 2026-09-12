# 3D Generation/Rendering Application (VAL-018)

A customer-style 3D application: scene rendering and parametric mesh
generation over seeded spec fixtures, through Zeck's public SDK
boundary, with mechanically verified container outcomes — and an
honest NOT RUN boundary for the REAL dispatches.

## What it does

Submits pinned `three-d.render-scene.v1` / `three-d.mesh-from-spec.v1`
corpus tasks (`kind: "render-3d"` with a seeded scene-spec fixture
key, or `kind: "mesh-from-spec"` with a seeded mesh-spec fixture key),
awaits async completion, retrieves the result package and asserts the
deterministic outcome contract. The provably-invalid edge rows (empty
scene, unknown primitive, corrupted spec) assert the honest failure
contract: terminal `FAILED`, verification `FAIL` — the platform
rejects them before any paid dispatch and never silently substitutes
a different primitive.

## The honest 3D boundary (read this first)

NO operator-authorized 3D-generation provider rail exists (the
capability matrix's `model:three-d` row has zero candidate providers).
The REAL 3D dispatches are therefore a recorded NOT RUN boundary —
never a fabricated equivalent: no fake rail, no invented endpoint, no
simulated PASS. The platform surfaces the EXACT missing access
requirement (provider/model, why needed, experiment unlocked, minimum
credential; env-var NAME only) in `benchmarks/validation/platform/three-d.ts`
(`THREE_D_ACCESS_REQUIREMENT`), recorded in the evidence document and
printed by the crown suite. When the operator authorizes a
3D-generation-capable provider, it binds onto the neutral `ThreeDRail`
seam and the same applications, derivations and mechanical criteria
(container validity by magic-byte glTF/STL/OBJ sniff, byte bounds,
sha256 digest capture) drive the REAL runs.

What executes today (the offline paths): this application's SDK
boundary integration (proven over controlled fakes in the unit
suite), the deterministic derivations (materialization, dispatch
plans with request digests, spec validation, verification criteria)
and the discrimination tests (digest mismatches, wrong-modality,
invalid specs, malformed containers, the no-authorized-rail boundary).

## Boundaries

- Integrates ONLY through the public SDK (the validation harness) —
  never Zeck internals; never selects provider/model/rail.
- Configuration is repository-reproducible and secret-free; the single
  secret is the environment token (`ZECK_VALIDATION_TOKEN`).
- The seeded spec fixtures (`scene3d-001..002`, `scene3d-empty`,
  `scene3d-corrupt`, `mesh-001`, `mesh-008`, materialized in
  `apps/shared/media.ts`) make every future dispatch reproducible at
  the request level — no external 3D media, no free-text prompts.

## Run

The application is executed by the validation integration suite
(`tests/integration/validation/val-018-multimodal-3d.test.ts`), which
binds the run-time configuration, the served API and the real platform
dispatch (the 3D sub-slice as the recorded NOT RUN boundary above). A
clean checkout reproduces the same pinned tasks, the same fixtures and
the same assertions.
