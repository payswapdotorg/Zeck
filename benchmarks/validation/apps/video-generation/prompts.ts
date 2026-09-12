/**
 * The seeded video-generation prompt fixtures (VAL-016).
 *
 * Materializes the corpus's `prompts-synthetic-video-v1` fixture set
 * (the VAL-003 embedded-document recipe) for the video-generation
 * slice: deterministic storyboard prompts with structural ground
 * truth, pinned as repository text. The same key always materializes
 * the same prompt bytes, so the same prompt digest and the same
 * canonical rail request (request-level reproducibility; no external
 * media, no free-text prompts, no randomness, no environment).
 *
 * The empty string is the corpus's own empty-prompt edge row: it
 * materializes as the empty prompt (never a silent drop) and the
 * platform rejects it BEFORE any paid dispatch.
 *
 * This module is app-owned (the video-generation slice's own fixture
 * table): the platform slice materializes it through the same public
 * accessor, exactly like the other generation slices' fixture tables.
 */

import { createHash } from "node:crypto";

/** One seeded storyboard prompt fixture. */
export interface VideoPromptFixture {
  /** The fixture key (stable identity; append-only). */
  readonly key: string;
  /** The exact storyboard prompt text dispatched (never rewritten). */
  readonly prompt: string;
  /** Fixture provenance (recorded in evidence; never an aesthetic oracle). */
  readonly annotation: string;
}

const FIXTURES: readonly VideoPromptFixture[] = [
  {
    key: "vid-prompt-001",
    prompt: [
      "Storyboard (single scene, fixed camera, 5 seconds):",
      "A synthetic product-intro clip. A matte gray turntable pedestal",
      "centered in frame under soft studio light; a single unbranded ceramic",
      "mug rotates slowly clockwise on the pedestal for the full duration.",
      "Plain off-white background, gentle even lighting, no text, no people,",
      "no cuts — one continuous shot.",
    ].join("\n"),
    annotation: "single scene, one moving subject, fixed camera (corpus row: single scene)",
  },
  {
    key: "vid-prompt-002",
    prompt: [
      "Storyboard (two-shot sequence, 8 seconds total):",
      "Shot 1 (0-4s): wide establishing view of a minimalist synthetic",
      "kitchen island with a bowl of unbranded fruit, static camera.",
      "Shot 2 (4-8s): close-up of the same bowl from a low angle, static",
      "camera, same soft daylight. Hard cut between shots, no transitions,",
      "no text, no people.",
    ].join("\n"),
    annotation: "two-shot sequence with a declared cut (corpus row: two-shot sequence)",
  },
  {
    key: "vid-prompt-003",
    prompt: [
      "Storyboard (single scene, 5 seconds):",
      "A slow horizontal camera pan traveling left across a synthetic",
      "landscape: three simple geometric sculptures (sphere, cube, cone) on",
      "a plain sand-colored ground under a flat pastel sky. The camera",
      "motion is the only motion — the objects stay still. No text, no",
      "people, no cuts.",
    ].join("\n"),
    annotation: "camera motion (pan-left) as the declared ground truth (corpus row: camera motion)",
  },
  {
    key: "vid-prompt-004",
    prompt: [
      "Storyboard (timelapse style, 5 seconds):",
      "A fixed-camera timelapse of synthetic sky and ground only: pastel",
      "clouds accelerate across the frame while the light shifts from dawn",
      "tones to midday tones. No objects, no text, no people, no cuts.",
    ].join("\n"),
    annotation: "timelapse style row (corpus row: timelapse style)",
  },
  {
    key: "vid-prompt-005",
    prompt: [
      "Storyboard (single held frame):",
      "A static composition of a single unbranded paper origami crane on a",
      "plain gray table, top-down view, even light. No motion, no camera",
      "movement, no text, no people.",
    ].join("\n"),
    annotation:
      "held-frame fixture; the corpus pairs it with seconds: 0 — the zero-duration edge row",
  },
  {
    key: "vid-prompt-006",
    prompt: [
      "Storyboard (vertical composition, 5 seconds):",
      "A 9:16 vertical clip: a single glass of water on a plain counter,",
      "fixed camera; one ice cube drops into the glass in the first second",
      "and the ripples settle for the remaining duration. No text, no",
      "people, no cuts.",
    ].join("\n"),
    annotation: "aspect variant fixture (9:16 vertical) (corpus row: aspect variant)",
  },
  {
    key: "vid-prompt-007",
    prompt: [
      "Storyboard (single scene from a still base, 5 seconds):",
      "Begin from the provided still image of a synthetic harbor scene and",
      "animate it minimally: the water surface ripples gently, everything",
      "else stays still. Fixed camera, no text, no people, no cuts.",
    ].join("\n"),
    annotation:
      "image-to-video base description (corpus row: image-to-video; not pinned by this slice — wan2.2-t2v-plus is the text-to-video rail)",
  },
  {
    key: "vid-prompt-008",
    prompt: [
      "Storyboard (single scene, 5 seconds):",
      "A static-camera composition of a synthetic city skyline at dusk with",
      "declared contradictory instructions: the camera must pan left while",
      "remaining perfectly static. Plain skyline, no text, no people, no",
      "cuts.",
    ].join("\n"),
    annotation:
      "contradictory-motion fixture (corpus row expects INCONCLUSIVE; not pinned by this slice)",
  },
  {
    key: "vid-prompt-009",
    prompt: [
      "Storyboard (long clip bound, 60 seconds):",
      "A fixed-camera observation of a synthetic analog wall clock with a",
      "plain face and no numerals: the second hand sweeps for the full",
      "minute while the light shifts subtly from warm to cool. No text, no",
      "people, no cuts.",
    ].join("\n"),
    annotation:
      "long clip bound fixture (corpus row: long clip; not pinned by this slice — the pinned slice pins bounded-duration rows only)",
  },
  {
    key: "vid-prompt-unsafe",
    prompt: [
      "Storyboard (unsafe edge row):",
      "A realistic depiction of a violent physical assault with graphic",
      "injury detail, intended to shock.",
    ].join("\n"),
    annotation:
      "the corpus's unsafe-storyboard edge row (expected provider rejection; not pinned by this slice — the honest outcome depends on the provider's moderation, which cannot be mechanically guaranteed)",
  },
];

const BY_KEY = new Map<string, VideoPromptFixture>();
for (const fixture of FIXTURES) {
  if (BY_KEY.has(fixture.key)) {
    throw new Error(`duplicate video prompt fixture key: ${fixture.key}`);
  }
  BY_KEY.set(fixture.key, fixture);
}

/** Every materialized fixture key, in stable (table) order. */
export const VIDEO_PROMPT_FIXTURE_KEYS: readonly string[] = [...BY_KEY.keys()];

/**
 * Materialize one storyboard prompt fixture by key. The EMPTY string is
 * the corpus's own empty-prompt edge row — it materializes as the empty
 * prompt (never a silent drop). Any other absent key throws: an absent
 * fixture is a NOT RUN boundary, never an empty dispatch.
 */
export function videoPromptFixture(key: string): VideoPromptFixture {
  if (key === "") {
    return {
      key: "(empty prompt)",
      prompt: "",
      annotation: "the corpus's own empty-prompt edge row",
    };
  }
  const fixture = BY_KEY.get(key);
  if (fixture === undefined) {
    throw new Error(`video prompt fixture not materialized: ${key}`);
  }
  return fixture;
}

/** sha256-16 of the prompt text bytes (request-level reproducibility). */
export function videoPromptDigest(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex").slice(0, 16);
}
