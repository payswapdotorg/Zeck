/**
 * Seeded transformation-instruction fixtures (VAL-018, app-local).
 *
 * The VAL-003 "seeded prompt" recipe, kept inside this application's
 * slice (concurrent workers share `apps/shared/media.ts`; this file
 * adds fixtures without touching any shared file). Each fixture is the
 * exact instruction text the chain's vision stage is dispatched with;
 * the same key always yields the same instruction bytes (so the same
 * stage-1 request digest). Structural provenance travels with the
 * fixture; the source-image ground truth (oracle terms) comes from the
 * SHARED deterministic image fixtures' own annotations.
 */

/** A seeded structured-description instruction fixture. */
export interface TransformationInstructionFixture {
  readonly key: string;
  /** The exact question text dispatched with the source image. */
  readonly instruction: string;
  /** Structural provenance (recorded in evidence; never an oracle). */
  readonly annotation: string;
}

const TRANSFORMATION_INSTRUCTIONS: readonly TransformationInstructionFixture[] = [
  {
    key: "mm-instruction-001",
    instruction:
      'Describe the main subject of this image as a JSON object with exactly these fields: "subject" (the main object in one to three words), "colors" (an array of the subject\'s main color names, lowercase), "background" (one to three words describing the background), "composition" (one short phrase describing the spatial layout). Answer with ONLY the JSON object and no other text.',
    annotation: "structured-description schema v1 (standard)",
  },
  {
    key: "mm-instruction-002",
    instruction:
      'Describe this chart as a JSON object with exactly these fields: "subject" (what the chart shows, one to three words), "colors" (an array of the main colors used, lowercase), "background" (one to three words), "composition" (one short phrase that states the direction of the trend). Answer with ONLY the JSON object and no other text.',
    annotation: "structured-description schema v1 (chart trend focus)",
  },
];

/**
 * The seeded instruction fixtures by key (deterministic; unknown keys
 * throw — a NOT RUN boundary, never a silently degraded instruction).
 */
export function transformationInstructionFixture(key: string): TransformationInstructionFixture {
  const fixture = TRANSFORMATION_INSTRUCTIONS.find((candidate) => candidate.key === key);
  if (fixture === undefined) {
    throw new Error(`transformation instruction fixture not materialized: ${key}`);
  }
  return fixture;
}

/** Every pinned instruction key (table integrity checks). */
export function transformationInstructionKeys(): readonly string[] {
  return TRANSFORMATION_INSTRUCTIONS.map((fixture) => fixture.key);
}

/**
 * The declared derived-media raster size the chain's imagegen stage
 * requests (rail-supported shape; the dimensions-declared criterion
 * requires exact equality — an unsupported size would fail honestly).
 */
export const DERIVED_MEDIA_SIZE = { width: 1328, height: 1328 } as const;
