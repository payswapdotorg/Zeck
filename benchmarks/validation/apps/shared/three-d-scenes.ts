/**
 * Deterministic seeded 3D prompt fixtures (VAL-018).
 *
 * The VAL-003 "seeded prompt" recipe, additive as a NEW shared file
 * (concurrent workers edit `apps/shared/media.ts` — this file leaves it
 * untouched): every 3D generation prompt is pinned text. The same key
 * always yields the same prompt bytes (so the same sha256 request
 * digest); no external media, no environment, no randomness. Structural
 * ground-truth annotations travel with the fixtures (provenance only —
 * recorded in evidence; never used as an aesthetic oracle).
 */

/** A seeded 3D generation prompt fixture. */
export interface ThreeDPromptFixture {
  readonly key: string;
  /** The exact prompt text a 3D generation rail would be dispatched with. */
  readonly prompt: string;
  /**
   * Structural ground-truth annotation (provenance only — recorded in
   * evidence; never used as an aesthetic oracle).
   */
  readonly annotation: string;
}

const THREE_D_PROMPTS: readonly ThreeDPromptFixture[] = [
  {
    key: "prompt-3d-001",
    prompt:
      "A single box primitive 2 x 1 x 2 units, centered at the origin and resting on a plain gray ground plane. Flat untextured matte material, neutral even lighting, no background elements.",
    annotation: "single box primitive on ground plane",
  },
  {
    key: "prompt-3d-002",
    prompt:
      "Two primitives on a plain ground plane: a sphere on the left and a box on the right, clearly separated from each other. Flat untextured materials, neutral lighting.",
    annotation: "sphere and box, two primitives with relation",
  },
  {
    key: "prompt-3d-003",
    prompt:
      "A cylinder 1 unit in diameter and 2 units tall, standing upright at the origin, with a brushed-metal look material. Plain ground plane, neutral lighting.",
    annotation: "textured cylinder primitive",
  },
  {
    key: "prompt-3d-004",
    prompt:
      "A lit scene: a box and a sphere on a plain ground plane, lit by a single warm light source from the upper left, with soft shadows. No other objects.",
    annotation: "lit scene, warm light from upper left",
  },
];

/**
 * The seeded 3D generation-prompt fixtures by key (deterministic). The
 * corpus's own empty-prompt edge row materializes as the empty prompt
 * (the platform rejects it BEFORE any paid dispatch — the honest
 * expected-FAILED row); unknown keys throw.
 */
export function threeDPromptFixture(key: string): ThreeDPromptFixture {
  if (key === "") {
    // The corpus row `three-d.render-scene.v1` "edge: empty scene" pins
    // input { prompt: "" } — materialized here, never silently dropped.
    return { key: "", prompt: "", annotation: "empty prompt" };
  }
  const fixture = THREE_D_PROMPTS.find((candidate) => candidate.key === key);
  if (fixture === undefined) {
    throw new Error(`three-d prompt fixture not materialized: ${key}`);
  }
  return fixture;
}

/** Every pinned 3D prompt fixture key (table integrity checks). */
export function threeDPromptFixtureKeys(): readonly string[] {
  return THREE_D_PROMPTS.map((fixture) => fixture.key);
}
