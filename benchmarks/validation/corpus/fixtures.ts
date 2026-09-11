/**
 * The corpus fixture manifest (VAL-003, acceptance criterion 5).
 *
 * Fixture KEYS are declared by scenario families; this manifest records
 * each key's determinism classification and its materialization recipe.
 * Text/document/record fixtures are embedded-or-generatable
 * deterministically; media fixtures carry a synthetic generation recipe
 * that the application portfolio (VAL-010+) materializes — an absent
 * fixture is a NOT RUN boundary, never a silent pass.
 */

/** How a fixture materializes. */
export type FixtureRecipe =
  | "embedded-document"
  | "deterministic-generator"
  | "synthetic-media-recipe"
  | "workspace-blueprint";

export interface FixtureRecord {
  readonly key: string;
  readonly determinism: "deterministic" | "nondeterministic-tolerance";
  readonly recipe: FixtureRecipe;
  readonly description: string;
  /** The work order that materializes the fixture (or VAL-003 itself). */
  readonly materializedBy: string;
}

const record = (
  key: string,
  determinism: FixtureRecord["determinism"],
  recipe: FixtureRecipe,
  description: string,
  materializedBy: string,
): FixtureRecord => ({ key, determinism, recipe, description, materializedBy });

/** The manifest: every fixture key declared by the scenario families. */
export const FIXTURES: readonly FixtureRecord[] = [
  record(
    "docs-synthetic-v1",
    "deterministic",
    "embedded-document",
    "synthetic documents (reports, notes, threads)",
    "VAL-003",
  ),
  record(
    "invoices-synthetic-v1",
    "deterministic",
    "embedded-document",
    "synthetic invoice documents with exact expected fields",
    "VAL-003",
  ),
  record(
    "records-synthetic-v1",
    "deterministic",
    "deterministic-generator",
    "synthetic record sets (csv/json/mixed shapes)",
    "VAL-003",
  ),
  record(
    "kb-synthetic-policies-v1",
    "deterministic",
    "embedded-document",
    "synthetic policy knowledge base",
    "VAL-003",
  ),
  record(
    "kb-synthetic-products-v1",
    "deterministic",
    "embedded-document",
    "synthetic product knowledge base",
    "VAL-003",
  ),
  record(
    "toolset-synthetic-v1",
    "deterministic",
    "deterministic-generator",
    "calculator/calendar/converter/lookup tool stubs",
    "VAL-003",
  ),
  record(
    "workflow-policy-invoices-v1",
    "deterministic",
    "embedded-document",
    "invoice approval policy rules",
    "VAL-003",
  ),
  record(
    "workflow-policy-onboarding-v1",
    "deterministic",
    "embedded-document",
    "onboarding step policy",
    "VAL-003",
  ),
  record(
    "batch-jobs-synthetic-v1",
    "deterministic",
    "deterministic-generator",
    "synthetic batch job definitions with seeded failures",
    "VAL-003",
  ),
  record(
    "audio-synthetic-utterances-v1",
    "deterministic",
    "synthetic-media-recipe",
    "synthetic utterance clips with ground-truth transcripts",
    "VAL-014",
  ),
  record(
    "audio-synthetic-commands-v1",
    "deterministic",
    "synthetic-media-recipe",
    "synthetic voice command clips with ground-truth intents",
    "VAL-014",
  ),
  record(
    "audio-synthetic-dialog-v1",
    "deterministic",
    "synthetic-media-recipe",
    "synthetic realtime dialog turn streams",
    "VAL-014",
  ),
  record(
    "audio-synthetic-briefings-v1",
    "deterministic",
    "synthetic-media-recipe",
    "synthetic briefing audio with ground-truth facts",
    "VAL-014",
  ),
  record(
    "audio-synthetic-events-v1",
    "deterministic",
    "synthetic-media-recipe",
    "synthetic audio event clips with ground-truth labels",
    "VAL-017",
  ),
  record(
    "audio-synthetic-conversations-v1",
    "deterministic",
    "synthetic-media-recipe",
    "synthetic conversations with diarization ground truth",
    "VAL-017",
  ),
  record(
    "prompts-synthetic-images-v1",
    "deterministic",
    "embedded-document",
    "image prompts with structural ground truth",
    "VAL-003",
  ),
  record(
    "prompts-synthetic-video-v1",
    "deterministic",
    "embedded-document",
    "video storyboard prompts",
    "VAL-003",
  ),
  record(
    "img-synthetic-transform-v1",
    "deterministic",
    "synthetic-media-recipe",
    "source images with ground-truth transformations",
    "VAL-015",
  ),
  record(
    "img-synthetic-classify-v1",
    "deterministic",
    "synthetic-media-recipe",
    "classification images with ground-truth labels",
    "VAL-017",
  ),
  record(
    "img-synthetic-docs-v1",
    "deterministic",
    "synthetic-media-recipe",
    "rendered documents with ground-truth text",
    "VAL-017",
  ),
  record(
    "img-synthetic-scenes-v1",
    "deterministic",
    "synthetic-media-recipe",
    "annotated scenes for VLM questions",
    "VAL-017",
  ),
  record(
    "scenes-synthetic-3d-v1",
    "deterministic",
    "embedded-document",
    "3d scene specs with geometric ground truth",
    "VAL-003",
  ),
  record(
    "specs-synthetic-mesh-v1",
    "deterministic",
    "embedded-document",
    "parametric mesh specifications",
    "VAL-003",
  ),
  record(
    "specs-synthetic-coding-v1",
    "deterministic",
    "embedded-document",
    "function specifications with embedded unit tests",
    "VAL-003",
  ),
  record(
    "policy-synthetic-refunds-v1",
    "deterministic",
    "embedded-document",
    "refund policy rules",
    "VAL-003",
  ),
  record(
    "policy-synthetic-escalation-v1",
    "deterministic",
    "embedded-document",
    "escalation matrix",
    "VAL-003",
  ),
  record(
    "tickets-synthetic-v1",
    "deterministic",
    "deterministic-generator",
    "synthetic support tickets",
    "VAL-003",
  ),
  record(
    "incidents-synthetic-v1",
    "deterministic",
    "deterministic-generator",
    "synthetic incident reports",
    "VAL-003",
  ),
  record(
    "runbooks-synthetic-v1",
    "deterministic",
    "embedded-document",
    "operational runbooks",
    "VAL-003",
  ),
  record(
    "ops-state-synthetic-v1",
    "deterministic",
    "workspace-blueprint",
    "synthetic operational state",
    "VAL-003",
  ),
  record(
    "web-fixture-shop-v1",
    "deterministic",
    "workspace-blueprint",
    "the deterministic synthetic shop site",
    "VAL-019",
  ),
  record(
    "web-fixture-forms-v1",
    "deterministic",
    "workspace-blueprint",
    "deterministic form fixtures",
    "VAL-019",
  ),
  record(
    "workspace-synthetic-v1",
    "deterministic",
    "workspace-blueprint",
    "the synthetic filesystem workspace",
    "VAL-019",
  ),
  record(
    "apps-synthetic-v1",
    "deterministic",
    "workspace-blueprint",
    "the synthetic application state machines",
    "VAL-019",
  ),
  record(
    "sources-synthetic-research-v1",
    "deterministic",
    "embedded-document",
    "synthetic research sources with provenance",
    "VAL-003",
  ),
  record(
    "sources-synthetic-reference-v1",
    "deterministic",
    "embedded-document",
    "the synthetic reference corpus",
    "VAL-003",
  ),
  record(
    "approvals-synthetic-v1",
    "deterministic",
    "deterministic-generator",
    "approval fixtures with scripted decisions",
    "VAL-003",
  ),
  record(
    "reviews-synthetic-v1",
    "deterministic",
    "deterministic-generator",
    "review fixtures with scripted feedback cycles",
    "VAL-003",
  ),
  record(
    "storyboards-synthetic-v1",
    "deterministic",
    "embedded-document",
    "storyboards with per-scene ground truth",
    "VAL-003",
  ),
];

/** Look up a fixture record by key. */
export function fixtureByKey(key: string): FixtureRecord | undefined {
  return FIXTURES.find((fixture) => fixture.key === key);
}

/**
 * Fixture integrity: every key declared by any corpus task exists in
 * the manifest, and every manifest key is referenced by some task (no
 * orphan fixtures, no undeclared fixtures).
 */
export function fixtureIntegrity(
  tasks: readonly { readonly environmentState: { readonly fixtures: readonly string[] } }[],
): readonly string[] {
  const declared = new Set(FIXTURES.map((fixture) => fixture.key));
  const used = new Set<string>();
  for (const task of tasks) {
    for (const key of task.environmentState.fixtures) {
      used.add(key);
      if (!declared.has(key)) {
        return [`undeclared fixture key: ${key}`];
      }
    }
  }
  const orphans = [...declared].filter((key) => !used.has(key));
  if (orphans.length > 0) {
    return [`orphan manifest fixtures (declared but never used): ${orphans.join(", ")}`];
  }
  return [];
}
