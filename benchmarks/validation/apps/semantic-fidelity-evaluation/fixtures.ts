/**
 * The quality fixture corpus (PCS-004 — ACR-009 §6 "quality fixtures").
 *
 * THE CURATED CORPUS: eighteen semantic-retrieval fixtures across the
 * three classes the work order names — paraphrase/synonym retrieval,
 * cross-lingual nearest-neighbor, polysemy discrimination — where
 * model-backed semantic quality is MEASURABLY DISTINCT from
 * deterministic lexical/hash substitutes. Every fixture is constructed
 * under ONE mechanical law, verified in-suite against the REAL
 * PPR-025 deterministic executor (imported read-only):
 *
 *   the distractor shares MORE discriminating surface lexical tokens
 *   with the query than the ground-truth target does (so the
 *   deterministic lexical-hash substitute ranks the distractor FIRST —
 *   the substitute's honest failure), while the target is the
 *   ground-truth semantic nearest neighbor (a paraphrase, a
 *   translation, or the same-sense family — so a representation with
 *   the curated semantic knowledge ranks the target FIRST).
 *
 * THE CURATED SEMANTIC DICTIONARIES (the synthetic semantic supply's
 * knowledge): the synonym/translation/sense maps below are the
 * evaluation's OWN committed, digest-pinned content — the synthetic
 * supply of the semantic knowledge a model-backed embedding service
 * would bring to this corpus (labeled `synthetic-semantic-supply` on
 * every number; NEVER a live model measurement — live credentialed
 * semantic-quality validation remains the operator-era obligation,
 * never backfilled).
 *
 * THE TWO REPRESENTATIONS COMPARED (representations.ts): the
 * deterministic substitute is the REAL PPR-025 lexical-hash executor
 * (`compat/openwebui/harness/embeddings.ts`, imported read-only — the
 * genuine article, never a strawman); the synthetic semantic supply is
 * concept-normalization + the SAME feature-hash arithmetic (same
 * tokenizer, same 512 dimensions, same sublinear TF, same L2
 * normalization — the ONLY difference is surface tokens vs
 * dictionary-canonicalized concepts). The comparison is fair by
 * construction: the measured distinction is exactly the curated
 * semantic knowledge.
 *
 * HONEST LABELS (binding on every number this corpus's evaluation
 * emits): synthetic-supply (the declared deterministic profiles and
 * the curated dictionaries — never a live provider), synthetic-cost
 * (none — this evaluation makes no cost measurements), and no latency
 * measurements at all. A threshold miss with honest attribution is a
 * valid delivery (the program's truth discipline).
 */

// ---------------------------------------------------------------------------
// The fixture classes (the closed group vocabulary)
// ---------------------------------------------------------------------------

/** The three fixture classes the work order names (closed). */
export const FIXTURE_GROUPS = [
  "paraphrase-synonym-retrieval",
  "cross-lingual-nearest-neighbor",
  "polysemy-discrimination",
] as const;
export type FixtureGroup = (typeof FIXTURE_GROUPS)[number];

/** One candidate text of a fixture (the ground-truth target or a distractor). */
export interface FixtureCandidate {
  readonly id: string;
  readonly text: string;
  readonly role: "ground-truth" | "distractor";
}

/** One curated quality fixture (the construction law asserted in-suite). */
export interface QualityFixture {
  readonly fixtureId: string;
  readonly group: FixtureGroup;
  readonly query: string;
  readonly groundTruthTargetId: string;
  /** The ranked candidate set (the ground truth + the lexically-closer distractor). */
  readonly candidates: readonly FixtureCandidate[];
  /** The curated semantic relation that makes the target the ground truth. */
  readonly relationLabel: string;
}

// ---------------------------------------------------------------------------
// The curated semantic dictionaries (the synthetic semantic supply's
// knowledge — committed, digest-pinned, honestly labeled)
// ---------------------------------------------------------------------------

/** One curated dictionary entry: a surface token (or bigram, `_`-spelled) → a weighted concept. */
export interface CuratedDictionaryEntry {
  readonly token: string;
  readonly concept: string;
  /** The concept weight (ambiguous sense tokens carry 0.5 on each sense). */
  readonly weight: number;
  readonly source: "synonym" | "translation" | "sense";
}

/**
 * The curated semantic dictionary — ONE committed flat map. Synonym
 * entries canonicalize paraphrases; translation entries bridge the
 * cross-lingual pairs (English ↔ German/Spanish/French); sense entries
 * carry the polysemy discrimination (an ambiguous token contributes
 * 0.5 to EACH sense concept; the query's unambiguous context tokens
 * dominate the concept coherence toward the true sense).
 */
export const CURATED_SEMANTIC_DICTIONARY: readonly CuratedDictionaryEntry[] = [
  // --- paraphrase/synonym canonicalization (fixtures pcs004-p1..p6) ---
  { token: "open", concept: "unlocking", weight: 1, source: "synonym" },
  { token: "unlock", concept: "unlocking", weight: 1, source: "synonym" },
  { token: "front", concept: "primary-entry", weight: 1, source: "synonym" },
  { token: "main", concept: "primary-entry", weight: 1, source: "synonym" },
  { token: "entrance", concept: "entryway", weight: 1, source: "synonym" },
  { token: "doorway", concept: "entryway", weight: 1, source: "synonym" },
  { token: "fee", concept: "charge", weight: 1, source: "synonym" },
  { token: "festival", concept: "event", weight: 1, source: "synonym" },
  { token: "refunded", concept: "repayment", weight: 1, source: "synonym" },
  { token: "exit", concept: "leaving-egress", weight: 1, source: "synonym" },
  { token: "emergency", concept: "urgent-egress", weight: 1, source: "synonym" },
  { token: "escape", concept: "urgent-egress", weight: 1, source: "synonym" },
  { token: "stairway", concept: "stairs", weight: 1, source: "synonym" },
  { token: "stairs", concept: "stairs", weight: 1, source: "synonym" },
  { token: "located", concept: "found-place", weight: 1, source: "synonym" },
  { token: "found", concept: "found-place", weight: 1, source: "synonym" },
  { token: "route", concept: "path", weight: 1, source: "synonym" },
  { token: "beside", concept: "near", weight: 1, source: "synonym" },
  { token: "interview", concept: "meeting", weight: 1, source: "synonym" },
  { token: "leaves", concept: "leaving", weight: 1, source: "synonym" },
  { token: "rain", concept: "rainfall", weight: 1, source: "synonym" },
  { token: "precipitation", concept: "rainfall", weight: 1, source: "synonym" },
  { token: "heavily", concept: "intensity", weight: 1, source: "synonym" },
  { token: "strong", concept: "intensity", weight: 1, source: "synonym" },
  { token: "tomorrow", concept: "next-day", weight: 1, source: "synonym" },
  { token: "next_day", concept: "next-day", weight: 1, source: "synonym" },
  { token: "morning", concept: "early-hours", weight: 1, source: "synonym" },
  { token: "early", concept: "early-hours", weight: 1, source: "synonym" },
  { token: "dance", concept: "dance", weight: 1, source: "synonym" },
  { token: "features", concept: "features", weight: 1, source: "synonym" },
  { token: "heavy", concept: "heavy-weight", weight: 1, source: "synonym" },
  { token: "drums", concept: "drums", weight: 1, source: "synonym" },
  { token: "reschedule", concept: "rescheduling", weight: 1, source: "synonym" },
  { token: "shifting", concept: "rescheduling", weight: 1, source: "synonym" },
  { token: "meeting", concept: "meeting-noun", weight: 1, source: "synonym" },
  { token: "appointment", concept: "meeting-noun", weight: 1, source: "synonym" },
  { token: "time", concept: "time-slot", weight: 1, source: "synonym" },
  { token: "slot", concept: "time-slot", weight: 1, source: "synonym" },
  { token: "another", concept: "different-a", weight: 1, source: "synonym" },
  { token: "different", concept: "different-a", weight: 1, source: "synonym" },
  { token: "room", concept: "room", weight: 1, source: "synonym" },
  { token: "reservation", concept: "reservation", weight: 1, source: "synonym" },
  { token: "passphrase", concept: "passphrase", weight: 1, source: "synonym" },
  { token: "phrase", concept: "passphrase", weight: 1, source: "synonym" },
  { token: "secret_phrase", concept: "passphrase", weight: 1, source: "synonym" },
  { token: "forgot", concept: "forgotten", weight: 1, source: "synonym" },
  { token: "misplaced", concept: "forgotten", weight: 1, source: "synonym" },
  { token: "account", concept: "account-profile", weight: 1, source: "synonym" },
  { token: "login_profile", concept: "account-profile", weight: 1, source: "synonym" },
  { token: "again", concept: "repeatedly", weight: 1, source: "synonym" },
  { token: "once_more", concept: "repeatedly", weight: 1, source: "synonym" },
  { token: "balance", concept: "balance", weight: 1, source: "synonym" },
  { token: "debited", concept: "debit", weight: 1, source: "synonym" },
  { token: "road", concept: "roadway", weight: 1, source: "synonym" },
  { token: "path", concept: "roadway", weight: 1, source: "synonym" },
  { token: "leads", concept: "leading", weight: 1, source: "synonym" },
  { token: "reached", concept: "leading", weight: 1, source: "synonym" },
  { token: "ancient", concept: "old-thing", weight: 1, source: "synonym" },
  { token: "old", concept: "old-thing", weight: 1, source: "synonym" },
  { token: "castle", concept: "fortress", weight: 1, source: "synonym" },
  { token: "fortress", concept: "fortress", weight: 1, source: "synonym" },
  { token: "following", concept: "following", weight: 1, source: "synonym" },
  { token: "northern", concept: "northern", weight: 1, source: "synonym" },
  { token: "closed", concept: "closed", weight: 1, source: "synonym" },
  { token: "construction", concept: "construction", weight: 1, source: "synonym" },
  { token: "work", concept: "work", weight: 1, source: "synonym" },
  // --- cross-lingual bridges (fixtures pcs004-c1..c6) ---
  { token: "where", concept: "location-q", weight: 1, source: "translation" },
  { token: "railway", concept: "rail", weight: 1, source: "translation" },
  { token: "station", concept: "station", weight: 1, source: "translation" },
  { token: "situated", concept: "situated", weight: 1, source: "translation" },
  { token: "bahnhof", concept: "station", weight: 1, source: "translation" },
  { token: "befindet", concept: "situated", weight: 1, source: "translation" },
  { token: "stadtrand", concept: "city-edge", weight: 1, source: "translation" },
  { token: "museum", concept: "museum", weight: 1, source: "translation" },
  { token: "displays", concept: "exhibit", weight: 1, source: "translation" },
  { token: "signal", concept: "signal", weight: 1, source: "translation" },
  { token: "lamps", concept: "lamp", weight: 1, source: "translation" },
  { token: "chef", concept: "cook", weight: 1, source: "translation" },
  { token: "cocinero", concept: "cook", weight: 1, source: "translation" },
  { token: "prepares", concept: "cooking", weight: 1, source: "translation" },
  { token: "prepara", concept: "cooking", weight: 1, source: "translation" },
  { token: "soup", concept: "soup", weight: 1, source: "translation" },
  { token: "sopa", concept: "soup", weight: 1, source: "translation" },
  { token: "hot", concept: "hot-temp", weight: 1, source: "translation" },
  { token: "caliente", concept: "hot-temp", weight: 1, source: "translation" },
  { token: "today", concept: "today", weight: 1, source: "translation" },
  { token: "hoy", concept: "today", weight: 1, source: "translation" },
  { token: "kitchen", concept: "kitchen", weight: 1, source: "translation" },
  { token: "serves", concept: "serving", weight: 1, source: "translation" },
  { token: "meals", concept: "meal", weight: 1, source: "translation" },
  { token: "every", concept: "every", weight: 1, source: "translation" },
  { token: "day", concept: "day-part", weight: 1, source: "translation" },
  { token: "bicycle", concept: "bicycle", weight: 1, source: "translation" },
  { token: "fahrradreifen", concept: "bicycle", weight: 1, source: "translation" },
  { token: "fahrradreifen", concept: "tire", weight: 1, source: "translation" },
  { token: "tire", concept: "tire", weight: 1, source: "translation" },
  { token: "flat", concept: "flat-state", weight: 1, source: "translation" },
  { token: "platt", concept: "flat-state", weight: 1, source: "translation" },
  { token: "needs", concept: "must", weight: 1, source: "translation" },
  { token: "muss", concept: "must", weight: 1, source: "translation" },
  { token: "repair", concept: "repair", weight: 1, source: "translation" },
  { token: "repariert", concept: "repair", weight: 1, source: "translation" },
  { token: "shop", concept: "shop", weight: 1, source: "translation" },
  { token: "sells", concept: "selling", weight: 1, source: "translation" },
  { token: "helmets", concept: "helmet", weight: 1, source: "translation" },
  { token: "tools", concept: "tools", weight: 1, source: "translation" },
  { token: "children", concept: "children", weight: 1, source: "translation" },
  { token: "enfants", concept: "children", weight: 1, source: "translation" },
  { token: "play", concept: "playing", weight: 1, source: "translation" },
  { token: "jouent", concept: "playing", weight: 1, source: "translation" },
  { token: "football", concept: "ball-game", weight: 1, source: "translation" },
  { token: "ballon", concept: "ball-game", weight: 1, source: "translation" },
  { token: "park", concept: "park", weight: 1, source: "translation" },
  { token: "parc", concept: "park", weight: 1, source: "translation" },
  { token: "match", concept: "match", weight: 1, source: "translation" },
  { token: "attracted", concept: "attracted", weight: 1, source: "translation" },
  { token: "large", concept: "large", weight: 1, source: "translation" },
  { token: "crowd", concept: "crowd", weight: 1, source: "translation" },
  { token: "starker", concept: "intensity", weight: 1, source: "translation" },
  { token: "storm", concept: "storm", weight: 1, source: "translation" },
  { token: "sturm", concept: "storm", weight: 1, source: "translation" },
  { token: "damaged", concept: "damage", weight: 1, source: "translation" },
  { token: "zerbrach", concept: "damage", weight: 1, source: "translation" },
  { token: "harbor", concept: "harbor", weight: 1, source: "translation" },
  { token: "hafenboote", concept: "harbor", weight: 1, source: "translation" },
  { token: "hafenboote", concept: "boat", weight: 1, source: "translation" },
  { token: "boats", concept: "boat", weight: 1, source: "translation" },
  { token: "warning", concept: "warning", weight: 1, source: "translation" },
  { token: "broadcast", concept: "broadcast", weight: 1, source: "translation" },
  { token: "radio", concept: "radio", weight: 1, source: "translation" },
  { token: "she", concept: "she-pronoun", weight: 1, source: "translation" },
  { token: "ella", concept: "she-pronoun", weight: 1, source: "translation" },
  { token: "studies", concept: "studying", weight: 1, source: "translation" },
  { token: "estudia", concept: "studying", weight: 1, source: "translation" },
  { token: "medicine", concept: "medicine", weight: 1, source: "translation" },
  { token: "medicina", concept: "medicine", weight: 1, source: "translation" },
  { token: "university", concept: "university", weight: 1, source: "translation" },
  { token: "universidad", concept: "university", weight: 1, source: "translation" },
  { token: "library", concept: "library", weight: 1, source: "translation" },
  { token: "closes", concept: "closing", weight: 1, source: "translation" },
  { token: "midnight", concept: "midnight", weight: 1, source: "translation" },
  { token: "during", concept: "during", weight: 1, source: "translation" },
  { token: "exams", concept: "exam", weight: 1, source: "translation" },
  // --- polysemy senses (fixtures pcs004-y1..y6): the ambiguous token
  //     contributes 0.5 to EACH sense; the context tokens disambiguate ---
  { token: "bank", concept: "riverside", weight: 0.5, source: "sense" },
  { token: "bank", concept: "money-institution", weight: 0.5, source: "sense" },
  { token: "fished", concept: "fishing", weight: 1, source: "sense" },
  { token: "angler", concept: "fishing", weight: 1, source: "sense" },
  { token: "stream", concept: "watercourse", weight: 1, source: "sense" },
  { token: "creek", concept: "watercourse", weight: 1, source: "sense" },
  { token: "winding", concept: "curving", weight: 1, source: "sense" },
  { token: "grassy", concept: "meadow", weight: 1, source: "sense" },
  { token: "shore", concept: "riverside", weight: 1, source: "sense" },
  { token: "approved", concept: "lending", weight: 1, source: "sense" },
  { token: "mortgage", concept: "lending", weight: 1, source: "sense" },
  { token: "loan", concept: "lending", weight: 1, source: "sense" },
  { token: "mouse", concept: "rodent", weight: 0.5, source: "sense" },
  { token: "mouse", concept: "pointer-device", weight: 0.5, source: "sense" },
  { token: "computer", concept: "computing", weight: 1, source: "sense" },
  { token: "desktop", concept: "computing", weight: 1, source: "sense" },
  { token: "clicks", concept: "clicking", weight: 1, source: "sense" },
  { token: "tap", concept: "clicking", weight: 1, source: "sense" },
  { token: "pointer", concept: "pointer-device", weight: 1, source: "sense" },
  { token: "field", concept: "farmland", weight: 1, source: "sense" },
  { token: "nested", concept: "nesting", weight: 1, source: "sense" },
  { token: "barn", concept: "farm-building", weight: 1, source: "sense" },
  { token: "wall", concept: "wall", weight: 1, source: "sense" },
  { token: "letter", concept: "mail", weight: 0.5, source: "sense" },
  { token: "letter", concept: "character", weight: 0.5, source: "sense" },
  { token: "mailed", concept: "mail", weight: 1, source: "sense" },
  { token: "postal", concept: "mail", weight: 1, source: "sense" },
  { token: "sent", concept: "mail", weight: 1, source: "sense" },
  { token: "handwritten", concept: "handwriting", weight: 1, source: "sense" },
  { token: "hand", concept: "handwriting", weight: 1, source: "sense" },
  { token: "grandmother", concept: "elderly-relative", weight: 1, source: "sense" },
  { token: "elderly", concept: "elderly-relative", weight: 1, source: "sense" },
  { token: "note", concept: "message", weight: 1, source: "sense" },
  { token: "written", concept: "writing", weight: 1, source: "sense" },
  { token: "relative", concept: "relative", weight: 1, source: "sense" },
  { token: "printed", concept: "printing", weight: 1, source: "sense" },
  { token: "shapes", concept: "glyph-shape", weight: 1, source: "sense" },
  { token: "taught", concept: "teaching", weight: 1, source: "sense" },
  { token: "alphabet", concept: "alphabet", weight: 1, source: "sense" },
  { token: "plant", concept: "factory", weight: 0.5, source: "sense" },
  { token: "plant", concept: "flora", weight: 0.5, source: "sense" },
  { token: "chemical", concept: "industrial", weight: 1, source: "sense" },
  { token: "industrial", concept: "industrial", weight: 1, source: "sense" },
  { token: "employs", concept: "staffing", weight: 1, source: "sense" },
  { token: "staffs", concept: "staffing", weight: 1, source: "sense" },
  { token: "workers", concept: "employees", weight: 1, source: "sense" },
  { token: "employees", concept: "employees", weight: 1, source: "sense" },
  { token: "thousand", concept: "thousands", weight: 1, source: "sense" },
  { token: "thousands", concept: "thousands", weight: 1, source: "sense" },
  { token: "facility", concept: "facility", weight: 1, source: "sense" },
  { token: "water", concept: "water", weight: 1, source: "sense" },
  { token: "watering", concept: "water", weight: 1, source: "sense" },
  { token: "sunlight", concept: "sunlight", weight: 1, source: "sense" },
  { token: "grow", concept: "growing", weight: 1, source: "sense" },
  { token: "leaves", concept: "foliage", weight: 1, source: "sense" },
  { token: "bat", concept: "club-tool", weight: 0.5, source: "sense" },
  { token: "bat", concept: "flying-mammal", weight: 0.5, source: "sense" },
  { token: "baseball", concept: "baseball", weight: 1, source: "sense" },
  { token: "club", concept: "club-tool", weight: 1, source: "sense" },
  { token: "cracked", concept: "splintering", weight: 1, source: "sense" },
  { token: "splintered", concept: "splintering", weight: 1, source: "sense" },
  { token: "pitch", concept: "pitch", weight: 1, source: "sense" },
  { token: "wooden", concept: "wooden", weight: 1, source: "sense" },
  { token: "striking", concept: "striking", weight: 1, source: "sense" },
  { token: "thrown", concept: "throwing", weight: 1, source: "sense" },
  { token: "ball", concept: "ball", weight: 1, source: "sense" },
  { token: "hung", concept: "hanging", weight: 1, source: "sense" },
  { token: "upside", concept: "upside", weight: 1, source: "sense" },
  { token: "dark", concept: "darkness", weight: 1, source: "sense" },
  { token: "cave", concept: "cave", weight: 1, source: "sense" },
  { token: "tunnel", concept: "tunnel", weight: 1, source: "sense" },
  { token: "crane", concept: "hoisting-machine", weight: 0.5, source: "sense" },
  { token: "crane", concept: "wading-bird", weight: 0.5, source: "sense" },
  { token: "lifted", concept: "hoisting", weight: 1, source: "sense" },
  { token: "hoisting", concept: "hoisting", weight: 1, source: "sense" },
  { token: "steel", concept: "metal", weight: 1, source: "sense" },
  { token: "metal", concept: "metal", weight: 1, source: "sense" },
  { token: "beams", concept: "girders", weight: 1, source: "sense" },
  { token: "girders", concept: "girders", weight: 1, source: "sense" },
  { token: "roof", concept: "roof", weight: 1, source: "sense" },
  { token: "machine", concept: "machine", weight: 1, source: "sense" },
  { token: "raised", concept: "raising", weight: 1, source: "sense" },
  { token: "upward", concept: "upward", weight: 1, source: "sense" },
  { token: "waded", concept: "wading", weight: 1, source: "sense" },
  { token: "marsh", concept: "marsh", weight: 1, source: "sense" },
  { token: "looking", concept: "looking", weight: 1, source: "sense" },
  { token: "fish", concept: "fish", weight: 1, source: "sense" },
] as const;

// ---------------------------------------------------------------------------
// The fixtures (the committed corpus — 18 fixtures, 6 per class)
// ---------------------------------------------------------------------------

/** The committed quality fixture corpus (stable order — the digest covers this exact order). */
export const QUALITY_FIXTURES: readonly QualityFixture[] = [
  // --- paraphrase / synonym retrieval ---
  {
    fixtureId: "pcs004-p1",
    group: "paraphrase-synonym-retrieval",
    query: "How do I open the front entrance?",
    groundTruthTargetId: "pcs004-p1-target",
    candidates: [
      {
        id: "pcs004-p1-target",
        text: "The main doorway unlock procedure requires the access card.",
        role: "ground-truth",
      },
      {
        id: "pcs004-p1-distractor",
        text: "The entrance fee for the main festival is refunded upon exit.",
        role: "distractor",
      },
    ],
    relationLabel: "paraphrase: open↔unlock, front↔main, entrance↔doorway",
  },
  {
    fixtureId: "pcs004-p2",
    group: "paraphrase-synonym-retrieval",
    query: "Where is the emergency exit stairway located?",
    groundTruthTargetId: "pcs004-p2-target",
    candidates: [
      {
        id: "pcs004-p2-target",
        text: "The escape route stairs are found beside the lift shaft.",
        role: "ground-truth",
      },
      {
        id: "pcs004-p2-distractor",
        text: "The exit interview is scheduled after the manager leaves.",
        role: "distractor",
      },
    ],
    relationLabel: "paraphrase: emergency↔escape, stairway↔stairs, located↔found",
  },
  {
    fixtureId: "pcs004-p3",
    group: "paraphrase-synonym-retrieval",
    query: "Will it rain heavily tomorrow morning?",
    groundTruthTargetId: "pcs004-p3-target",
    candidates: [
      {
        id: "pcs004-p3-target",
        text: "Strong precipitation is expected early the next day.",
        role: "ground-truth",
      },
      {
        id: "pcs004-p3-distractor",
        text: "The rain dance festival tomorrow features heavy drums.",
        role: "distractor",
      },
    ],
    relationLabel:
      "paraphrase: rain↔precipitation, heavily↔strong, tomorrow↔next day, morning↔early",
  },
  {
    fixtureId: "pcs004-p4",
    group: "paraphrase-synonym-retrieval",
    query: "Can we reschedule our meeting to another time?",
    groundTruthTargetId: "pcs004-p4-target",
    candidates: [
      {
        id: "pcs004-p4-target",
        text: "Shifting the appointment to a different slot is possible.",
        role: "ground-truth",
      },
      {
        id: "pcs004-p4-distractor",
        text: "The meeting room reservation cannot exceed two hours.",
        role: "distractor",
      },
    ],
    relationLabel:
      "paraphrase: reschedule↔shifting, meeting↔appointment, time↔slot, another↔different",
  },
  {
    fixtureId: "pcs004-p5",
    group: "paraphrase-synonym-retrieval",
    query: "I forgot the passphrase for my account again.",
    groundTruthTargetId: "pcs004-p5-target",
    candidates: [
      {
        id: "pcs004-p5-target",
        text: "The secret phrase for the login profile was misplaced once more.",
        role: "ground-truth",
      },
      {
        id: "pcs004-p5-distractor",
        text: "The account passphrase expires again this month.",
        role: "distractor",
      },
    ],
    relationLabel:
      "paraphrase: passphrase↔secret phrase, forgot↔misplaced, account↔login profile, again↔once more",
  },
  {
    fixtureId: "pcs004-p6",
    group: "paraphrase-synonym-retrieval",
    query: "Which road leads to the ancient castle?",
    groundTruthTargetId: "pcs004-p6-target",
    candidates: [
      {
        id: "pcs004-p6-target",
        text: "The old fortress is reached by following the northern path.",
        role: "ground-truth",
      },
      {
        id: "pcs004-p6-distractor",
        text: "The road to the castle is closed for construction work.",
        role: "distractor",
      },
    ],
    relationLabel: "paraphrase: road↔path, leads↔reached, ancient↔old, castle↔fortress",
  },
  // --- cross-lingual nearest-neighbor (en query → de/es/fr target) ---
  {
    fixtureId: "pcs004-c1",
    group: "cross-lingual-nearest-neighbor",
    query: "Where is the railway station located?",
    groundTruthTargetId: "pcs004-c1-target",
    candidates: [
      {
        id: "pcs004-c1-target",
        text: "Der Bahnhof befindet sich am Stadtrand.",
        role: "ground-truth",
      },
      {
        id: "pcs004-c1-distractor",
        text: "The railway museum displays old signal lamps.",
        role: "distractor",
      },
    ],
    relationLabel: "translation en→de: station↔Bahnhof, located↔befindet",
  },
  {
    fixtureId: "pcs004-c2",
    group: "cross-lingual-nearest-neighbor",
    query: "The chef prepares a hot soup today.",
    groundTruthTargetId: "pcs004-c2-target",
    candidates: [
      {
        id: "pcs004-c2-target",
        text: "El cocinero prepara una sopa caliente hoy.",
        role: "ground-truth",
      },
      {
        id: "pcs004-c2-distractor",
        text: "The soup kitchen serves hot meals every day.",
        role: "distractor",
      },
    ],
    relationLabel:
      "translation en→es: chef↔cocinero, prepares↔prepara, soup↔sopa, hot↔caliente, today↔hoy",
  },
  {
    fixtureId: "pcs004-c3",
    group: "cross-lingual-nearest-neighbor",
    query: "My bicycle tire is flat and needs repair.",
    groundTruthTargetId: "pcs004-c3-target",
    candidates: [
      {
        id: "pcs004-c3-target",
        text: "Mein Fahrradreifen ist platt und muss repariert werden.",
        role: "ground-truth",
      },
      {
        id: "pcs004-c3-distractor",
        text: "The bicycle shop sells helmets and repair tools.",
        role: "distractor",
      },
    ],
    relationLabel: "translation en→de: bicycle tire↔Fahrradreifen, flat↔platt, repair↔repariert",
  },
  {
    fixtureId: "pcs004-c4",
    group: "cross-lingual-nearest-neighbor",
    query: "The children play football in the park.",
    groundTruthTargetId: "pcs004-c4-target",
    candidates: [
      {
        id: "pcs004-c4-target",
        text: "Les enfants jouent au ballon dans le parc.",
        role: "ground-truth",
      },
      {
        id: "pcs004-c4-distractor",
        text: "The football match attracted a large crowd.",
        role: "distractor",
      },
    ],
    relationLabel: "translation en→fr: children↔enfants, play↔jouent, football↔ballon, park↔parc",
  },
  {
    fixtureId: "pcs004-c5",
    group: "cross-lingual-nearest-neighbor",
    query: "A strong storm damaged the harbor boats.",
    groundTruthTargetId: "pcs004-c5-target",
    candidates: [
      {
        id: "pcs004-c5-target",
        text: "Ein starker Sturm zerbrach die Hafenboote.",
        role: "ground-truth",
      },
      {
        id: "pcs004-c5-distractor",
        text: "The storm warning was broadcast on the harbor radio.",
        role: "distractor",
      },
    ],
    relationLabel:
      "translation en→de: strong↔starker, storm↔Sturm, damaged↔zerbrach, harbor boats↔Hafenboote",
  },
  {
    fixtureId: "pcs004-c6",
    group: "cross-lingual-nearest-neighbor",
    query: "She studies medicine at the university.",
    groundTruthTargetId: "pcs004-c6-target",
    candidates: [
      {
        id: "pcs004-c6-target",
        text: "Ella estudia medicina en la universidad.",
        role: "ground-truth",
      },
      {
        id: "pcs004-c6-distractor",
        text: "The university library closes at midnight during exams.",
        role: "distractor",
      },
    ],
    relationLabel:
      "translation en→es: she↔ella, studies↔estudia, medicine↔medicina, university↔universidad",
  },
  // --- polysemy discrimination (ambiguous token, two senses) ---
  {
    fixtureId: "pcs004-y1",
    group: "polysemy-discrimination",
    query: "We fished from the bank of the winding stream.",
    groundTruthTargetId: "pcs004-y1-target",
    candidates: [
      {
        id: "pcs004-y1-target",
        text: "An angler sat by the grassy creek shore.",
        role: "ground-truth",
      },
      {
        id: "pcs004-y1-distractor",
        text: "The bank approved the mortgage and the loan.",
        role: "distractor",
      },
    ],
    relationLabel: "sense: bank=riverside (context fished/stream) vs money-institution",
  },
  {
    fixtureId: "pcs004-y2",
    group: "polysemy-discrimination",
    query: "The computer mouse stopped responding to clicks.",
    groundTruthTargetId: "pcs004-y2-target",
    candidates: [
      {
        id: "pcs004-y2-target",
        text: "The desktop pointer device froze and ignored every tap.",
        role: "ground-truth",
      },
      {
        id: "pcs004-y2-distractor",
        text: "A field mouse nested in the barn wall.",
        role: "distractor",
      },
    ],
    relationLabel: "sense: mouse=pointer-device (context computer/clicks) vs rodent",
  },
  {
    fixtureId: "pcs004-y3",
    group: "polysemy-discrimination",
    query: "She mailed a handwritten letter to her grandmother.",
    groundTruthTargetId: "pcs004-y3-target",
    candidates: [
      {
        id: "pcs004-y3-target",
        text: "The postal note was written by hand and sent to the elderly relative.",
        role: "ground-truth",
      },
      {
        id: "pcs004-y3-distractor",
        text: "She mailed a printed letter chart to her teacher for the alphabet lesson.",
        role: "distractor",
      },
    ],
    relationLabel: "sense: letter=mail (context mailed/handwritten) vs character",
  },
  {
    fixtureId: "pcs004-y4",
    group: "polysemy-discrimination",
    query: "The chemical plant employs three thousand workers.",
    groundTruthTargetId: "pcs004-y4-target",
    candidates: [
      {
        id: "pcs004-y4-target",
        text: "The industrial facility staffs thousands of employees.",
        role: "ground-truth",
      },
      {
        id: "pcs004-y4-distractor",
        text: "The plant grew three leaves and needed watering.",
        role: "distractor",
      },
    ],
    relationLabel: "sense: plant=factory (context chemical/employs) vs flora",
  },
  {
    fixtureId: "pcs004-y5",
    group: "polysemy-discrimination",
    query: "The baseball bat cracked against the fast pitch.",
    groundTruthTargetId: "pcs004-y5-target",
    candidates: [
      {
        id: "pcs004-y5-target",
        text: "A wooden club splintered when striking the thrown ball.",
        role: "ground-truth",
      },
      {
        id: "pcs004-y5-distractor",
        text: "A bat hung upside down in the dark cave tunnel.",
        role: "distractor",
      },
    ],
    relationLabel: "sense: bat=club-tool (context baseball/pitch) vs flying-mammal",
  },
  {
    fixtureId: "pcs004-y6",
    group: "polysemy-discrimination",
    query: "A crane lifted the steel beams onto the roof.",
    groundTruthTargetId: "pcs004-y6-target",
    candidates: [
      {
        id: "pcs004-y6-target",
        text: "One hoisting machine raised metal girders upward.",
        role: "ground-truth",
      },
      {
        id: "pcs004-y6-distractor",
        text: "The crane waded through the marsh looking for fish.",
        role: "distractor",
      },
    ],
    relationLabel: "sense: crane=hoisting-machine (context lifted/steel) vs wading-bird",
  },
] as const;

// ---------------------------------------------------------------------------
// The corpus integrity invariants (asserted in-suite over the committed set)
// ---------------------------------------------------------------------------

/** Every fixture id is unique, every target id matches a ground-truth candidate (the corpus integrity law). */
export function fixtureCorpusIntegrity(): readonly string[] {
  const problems: string[] = [];
  const ids = new Set<string>();
  for (const fixture of QUALITY_FIXTURES) {
    if (ids.has(fixture.fixtureId)) {
      problems.push(`${fixture.fixtureId}: duplicate fixture id`);
    }
    ids.add(fixture.fixtureId);
    const targets = fixture.candidates.filter((candidate) => candidate.role === "ground-truth");
    const distractors = fixture.candidates.filter((candidate) => candidate.role === "distractor");
    if (targets.length !== 1) {
      problems.push(`${fixture.fixtureId}: expected exactly one ground-truth candidate`);
    }
    if (distractors.length < 1) {
      problems.push(`${fixture.fixtureId}: expected at least one distractor`);
    }
    if (targets[0]?.id !== fixture.groundTruthTargetId) {
      problems.push(
        `${fixture.fixtureId}: groundTruthTargetId does not name the ground-truth candidate`,
      );
    }
    if (fixture.query.trim().length === 0) {
      problems.push(`${fixture.fixtureId}: empty query`);
    }
  }
  return problems;
}

/** The fixture census per group (the corpus shape — pinned in-suite). */
export function fixtureCensusByGroup(): Readonly<Record<FixtureGroup, number>> {
  const out = {
    "paraphrase-synonym-retrieval": 0,
    "cross-lingual-nearest-neighbor": 0,
    "polysemy-discrimination": 0,
  } as Record<FixtureGroup, number>;
  for (const fixture of QUALITY_FIXTURES) {
    out[fixture.group] += 1;
  }
  return out;
}

/** The dictionary lookup index (token → weighted concepts; committed content, deterministic). */
export function dictionaryIndex(): ReadonlyMap<
  string,
  readonly { concept: string; weight: number }[]
> {
  const index = new Map<string, { concept: string; weight: number }[]>();
  for (const entry of CURATED_SEMANTIC_DICTIONARY) {
    if (entry.weight <= 0) {
      continue; // a zero-weight entry documents an intentionally-unmapped token
    }
    const existing = index.get(entry.token) ?? [];
    existing.push({ concept: entry.concept, weight: entry.weight });
    index.set(entry.token, existing);
  }
  return index;
}
