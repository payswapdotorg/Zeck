/**
 * Shared provider-neutrality scanner (WORK-003).
 *
 * Used by BOTH the architecture gate (over the real `src/` tree) and the
 * discrimination proofs (over synthetic mutations) — one definition of the
 * protection, two uses, so a weakened protection is provably rejected.
 */

import { PROVIDER_IDENTIFIER, RAIL_LITERAL } from "./patterns";

export interface SourceFileLike {
  readonly path: string;
  readonly content: string;
}

export interface NeutralityViolations {
  readonly identifierViolations: string[];
  readonly railLiteralViolations: string[];
  readonly fetchViolations: string[];
}

/** Provider code lives in the models adapter AREA (prefix-sanctioned, like the SDK boundary table). */
const SANCTIONED_IDENTIFIER_PREFIXES = ["src/modules/models/adapters/"];
const SANCTIONED_IDENTIFIER_FILES = new Set([
  // The rail vocabulary file names rails by design — slugs + their meaning.
  "src/modules/connections/domain/rails.ts",
]);

const SANCTIONED_RAIL_PREFIXES = ["src/modules/models/adapters/"];
const SANCTIONED_RAIL_FILES = new Set(["src/modules/connections/domain/rails.ts"]);

const SANCTIONED_FETCH_FILES = new Set(["src/modules/models/adapters/fetch-transport.ts"]);

export function providerNeutralityViolations(
  files: readonly SourceFileLike[],
): NeutralityViolations {
  const identifierViolations: string[] = [];
  const railLiteralViolations: string[] = [];
  const fetchViolations: string[] = [];

  for (const file of files) {
    if (!file.path.startsWith("src/modules/")) continue;
    const identifierSanctioned =
      SANCTIONED_IDENTIFIER_FILES.has(file.path) ||
      SANCTIONED_IDENTIFIER_PREFIXES.some((prefix) => file.path.startsWith(prefix));
    if (!identifierSanctioned && PROVIDER_IDENTIFIER.test(file.content)) {
      identifierViolations.push(file.path);
    }
    const railSanctioned =
      SANCTIONED_RAIL_FILES.has(file.path) ||
      SANCTIONED_RAIL_PREFIXES.some((prefix) => file.path.startsWith(prefix));
    if (!railSanctioned && RAIL_LITERAL.test(file.content)) {
      railLiteralViolations.push(file.path);
    }
    if (!SANCTIONED_FETCH_FILES.has(file.path) && /\bfetch\s*\(/.test(file.content)) {
      fetchViolations.push(file.path);
    }
  }
  return { identifierViolations, railLiteralViolations, fetchViolations };
}
