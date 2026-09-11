/**
 * The error taxonomy (VAL-008, acceptance criterion 4).
 *
 * Root-cause families aligned with the Tech Lead contract's issue
 * protocol, with MECHANICAL dispatch rules: the classification is a
 * pure function of recorded failure signals (surfaced error codes,
 * failed assertions, environment-effect failures, terminal status) —
 * no judgment, no LLM, deterministic dispatch.
 */

/** The root-cause families. */
export const ERROR_FAMILIES = [
  "application-defect",
  "zeck-defect",
  "provider-limitation",
  "model-limitation",
  "test-harness-defect",
  "infrastructure-limitation",
  "external-limitation",
  "environment-effect-failure",
] as const;

export type ErrorFamily = (typeof ERROR_FAMILIES)[number];

/** The failure signals a classification dispatches on. */
export interface FailureSignals {
  readonly terminalStatus: string | null;
  /** Failed oracle/assertion names (e.g. "terminal-status", "contains-text:x"). */
  readonly failedAssertions: readonly string[];
  /** Error codes surfaced through the public error taxonomy. */
  readonly surfacedErrorCodes: readonly string[];
  /** Environment-effect expectations that were not observed. */
  readonly failedEnvironmentEffects: readonly string[];
}

/** One classification (mechanically dispatched). */
export interface ErrorClassification {
  readonly family: ErrorFamily;
  readonly evidence: string;
  readonly dispatchRule: string;
}

/** Error-code prefixes and the families they mechanically imply. */
const CODE_RULES: readonly { readonly pattern: RegExp; readonly family: ErrorFamily }[] = [
  {
    pattern: /^(PROVIDER_ERROR|UPSTREAM_TIMEOUT|MODEL_UNAVAILABLE)$/,
    family: "provider-limitation",
  },
  { pattern: /^(RATE_LIMITED|QUOTA_EXCEEDED)$/, family: "provider-limitation" },
  { pattern: /^(AUTHORIZATION_DENIED|AUTHENTICATION_FAILED)$/, family: "application-defect" },
  { pattern: /^(BUDGET_EXCEEDED)$/, family: "application-defect" },
  {
    pattern: /^(INVALID_STATE_TRANSITION|IDEMPOTENCY_KEY_REUSED|VERIFICATION_INCONCLUSIVE)$/,
    family: "zeck-defect",
  },
  {
    pattern: /^(CAPABILITY_UNAVAILABLE|SANDBOX_UNAVAILABLE)$/,
    family: "infrastructure-limitation",
  },
];

/**
 * Dispatch classifications from the recorded signals. Each rule fires
 * on its mechanical pattern; multiple families can co-exist (a run can
 * be BOTH a provider failure and an environment-effect failure).
 */
export function classifyFailure(signals: FailureSignals): readonly ErrorClassification[] {
  const out: ErrorClassification[] = [];

  for (const code of signals.surfacedErrorCodes) {
    for (const rule of CODE_RULES) {
      if (rule.pattern.test(code)) {
        out.push({
          family: rule.family,
          evidence: `surfaced error code ${code}`,
          dispatchRule: `code matches ${rule.family} pattern`,
        });
      }
    }
  }

  const terminalFailed =
    signals.failedAssertions.includes("terminal-status") || signals.terminalStatus === "FAILED";
  if (terminalFailed && out.length === 0) {
    out.push({
      family: "zeck-defect",
      evidence: `terminal status ${signals.terminalStatus ?? "TIMEOUT"} without a surfaced platform/provider error code`,
      dispatchRule:
        "terminal failure with no code-signal defaults to the platform family (the run must be inspected)",
    });
  }

  for (const assertion of signals.failedAssertions) {
    if (assertion.startsWith("contains-text") || assertion.startsWith("output-shape")) {
      out.push({
        family: "model-limitation",
        evidence: `failed quality oracle ${assertion}`,
        dispatchRule:
          "quality-oracle failures with a healthy platform path dispatch to the model family",
      });
    }
  }

  for (const effect of signals.failedEnvironmentEffects) {
    out.push({
      family: "environment-effect-failure",
      evidence: `expected effect not observed: ${effect}`,
      dispatchRule:
        "unobserved environment effects dispatch to the effect family (outcome-state correctness)",
    });
  }

  if (
    signals.failedAssertions.length === 0 &&
    signals.surfacedErrorCodes.length === 0 &&
    signals.failedEnvironmentEffects.length === 0 &&
    out.length === 0
  ) {
    out.push({
      family: "test-harness-defect",
      evidence:
        "no failure signals at all — an evaluation failure with no signal is a harness defect",
      dispatchRule: "signal-less failures dispatch to the harness family",
    });
  }

  return out;
}
