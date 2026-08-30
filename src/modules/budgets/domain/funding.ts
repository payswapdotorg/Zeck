/**
 * Funding modes and sources (budgets module domain; BUD-003).
 *
 * `spec/architecture.md` §17 — the budget subsystem supports
 * application-funded spending, user-funded spending, BYOK, hybrid funding
 * and platform subsidy. A funding MODE is application-level policy (stored
 * in `budgets.application_funding_settings`); it selects which funding
 * SOURCES a reservation may draw from, and in which order.
 *
 * FUNDING PRECEDENCE (frozen, deterministic):
 *
 *   1. byok      — the customer's own credential pays the provider; no
 *                  platform wallet is drawn at all;
 *   2. subsidy   — platform-granted credits are consumed before customer
 *                  money (grants exist to be spent where intended);
 *   3. user      — the end user's own funds;
 *   4. developer — the application's developer funds, the backstop.
 *
 * A mode selects the eligible subsequence of that order. Each reservation
 * draws from EXACTLY ONE source (no split draws): the first eligible
 * source whose available balance covers the full amount wins; if none
 * does, the reservation is denied (`BUDGET_EXCEEDED`, reason
 * `insufficient-funds`). Single-source draws keep denial semantics and
 * the concurrency domain deterministic — splitting would multiply the
 * rows a racing draw must coordinate.
 */

/** Application-level funding policy (`spec/architecture.md` §17). */
export type FundingMode = "developer" | "user" | "byok" | "hybrid" | "subsidy";

/** Wallet-bearing funding sources. BYOK is not a wallet. */
export type WalletOwnerKind = "developer" | "user" | "subsidy";

/** Every source a reservation may be funded from. */
export type FundingSourceKind = WalletOwnerKind | "byok";

export const FUNDING_MODES: readonly FundingMode[] = [
  "developer",
  "user",
  "byok",
  "hybrid",
  "subsidy",
];

/** The frozen funding precedence (byok > subsidy > user > developer). */
export const FUNDING_PRECEDENCE: readonly FundingSourceKind[] = [
  "byok",
  "subsidy",
  "user",
  "developer",
];

export function isFundingMode(value: string): value is FundingMode {
  return (FUNDING_MODES as readonly string[]).includes(value);
}

/**
 * Wallet sources a mode may draw from, in funding-precedence order:
 *
 *   developer -> [developer]      user -> [user]
 *   subsidy   -> [subsidy]        byok -> [] (no wallet draw)
 *   hybrid    -> [user, developer] (user funds first, developer backstop)
 *
 * Deterministic by construction: the returned order is a subsequence of
 * `FUNDING_PRECEDENCE`, so wallet selection never depends on insertion
 * order, map iteration or timing.
 */
export function eligibleWalletSources(mode: FundingMode): readonly WalletOwnerKind[] {
  switch (mode) {
    case "developer":
      return ["developer"];
    case "user":
      return ["user"];
    case "subsidy":
      return ["subsidy"];
    case "hybrid":
      return ["user", "developer"];
    case "byok":
      return [];
  }
}

/** Modes whose reservation evaluation requires an end-user identity. */
export const MODES_REQUIRING_USER: readonly FundingMode[] = ["user", "hybrid"];

export function modeRequiresUser(mode: FundingMode): boolean {
  return (MODES_REQUIRING_USER as readonly string[]).includes(mode);
}
