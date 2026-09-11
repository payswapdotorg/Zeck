/**
 * Tolerance evaluation (VAL-008, acceptance criterion 2).
 *
 * Applies the corpus's stated numeric tolerance bands to RECORDED
 * measurements: each comparison in the tolerance text (">=", "<=",
 * ">", "<", "within N ms", "within +/- N percent", "exact") is parsed
 * mechanically and checked against the matching measured value. A
 * band that cannot be parsed — or a measurement that is absent — is
 * recorded honestly as unverified (never silently passed).
 */

/** One parsed numeric band. */
export interface ToleranceBand {
  readonly operator: "<=" | ">=" | "<" | ">" | "within" | "within-percent" | "exact";
  readonly bound: number;
  /** The band's unit hint from the source text (ms, percent, …). */
  readonly unit: string;
  readonly source: string;
}

/** One measured value offered to the evaluation. */
export interface Measurement {
  readonly name: string;
  readonly value: number;
  readonly unit: string;
}

/** One tolerance check verdict. */
export interface ToleranceVerdict {
  readonly band: ToleranceBand;
  readonly measurement: Measurement | null;
  readonly passed: boolean;
  readonly detail: string;
}

/**
 * Parse the numeric bands out of a tolerance statement. Only the
 * mechanical forms are recognized; anything else returns an empty list
 * (the caller records the statement as unverified).
 */
export function parseToleranceBands(text: string): readonly ToleranceBand[] {
  const bands: ToleranceBand[] = [];
  const comparison = /([A-Za-z0-9 ._-]+?)\s*(<=|>=|<|>)\s*([0-9]+(?:\.[0-9]+)?)(ms|percent|%|s)?/g;
  for (const match of text.matchAll(comparison)) {
    const operator = match[2] as "<=" | ">=" | "<" | ">";
    const bound = Number.parseFloat(match[3] ?? "0");
    const unit = (match[4] ?? "").replace("%", "percent");
    bands.push({ operator, bound, unit, source: match[0] ?? "" });
  }
  const withinMs = /within\s+([0-9]+(?:\.[0-9]+)?)\s*ms/g;
  for (const match of text.matchAll(withinMs)) {
    bands.push({
      operator: "within",
      bound: Number.parseFloat(match[1] ?? "0"),
      unit: "ms",
      source: match[0] ?? "",
    });
  }
  const withinPercent = /within\s*\+\/-\s*([0-9]+(?:\.[0-9]+)?)\s*percent/g;
  for (const match of text.matchAll(withinPercent)) {
    bands.push({
      operator: "within-percent",
      bound: Number.parseFloat(match[1] ?? "0"),
      unit: "percent",
      source: match[0] ?? "",
    });
  }
  if (/\bexact\b/i.test(text)) {
    bands.push({ operator: "exact", bound: 0, unit: "", source: "exact" });
  }
  return bands;
}

/**
 * Evaluate the parsed bands against recorded measurements. A band
 * matches a measurement by unit (and approximate name when the source
 * text names the metric); unmatched bands are recorded as unverified.
 */
export function evaluateTolerance(
  bands: readonly ToleranceBand[],
  measurements: readonly Measurement[],
): readonly ToleranceVerdict[] {
  return bands.map((band) => {
    const measurement = measurements.find((candidate) => unitMatches(band, candidate)) ?? null;
    if (measurement === null) {
      return {
        band,
        measurement,
        passed: false,
        detail: `no recorded measurement matches the band "${band.source}"`,
      };
    }
    const passed = applyBand(band, measurement);
    return {
      band,
      measurement,
      passed,
      detail: `${measurement.name} ${measurement.value}${measurement.unit} vs band ${band.source} — ${passed ? "within" : "outside"}`,
    };
  });
}

function unitMatches(band: ToleranceBand, measurement: Measurement): boolean {
  if (band.unit === "" || band.operator === "exact") {
    return true;
  }
  return measurement.unit === band.unit || band.unit.includes(measurement.unit);
}

function applyBand(band: ToleranceBand, measurement: Measurement): boolean {
  switch (band.operator) {
    case "<=":
      return measurement.value <= band.bound;
    case ">=":
      return measurement.value >= band.bound;
    case "<":
      return measurement.value < band.bound;
    case ">":
      return measurement.value > band.bound;
    case "within":
      return measurement.value <= band.bound;
    case "within-percent":
      return measurement.value <= band.bound;
    case "exact":
      return measurement.value === 0;
    default:
      return false;
  }
}
