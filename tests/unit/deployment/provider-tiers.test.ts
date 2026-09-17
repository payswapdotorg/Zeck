/**
 * Unit tests — the free-tier-first provider topology ledger (DEP-001
 * AC4: "Free-tier/low-cost provider choices and exact tested limits
 * are recorded").
 *
 * Proves over the REAL manifest set:
 *  - the ledger loads fail-closed and covers EVERY providers.json
 *    provider exactly once;
 *  - the tier-class vocabulary follows the roadmap doctrine order;
 *  - the verification status is the honest worker-pod state
 *    (recorded-not-live-verified) with the re-verification boundary;
 *  - the authoritative concern on a free tier carries the upgrade
 *    path (disposable free-tier resources never become
 *    operationally critical without an exit note);
 *  - every exhaustion mode equals the providers.json declared
 *    degradation mode (the ledger never invents degradation stories).
 *
 * Proves over SYNTHETIC mutations (fail-closed negative paths):
 *  - a missing provider entry, an unknown provider, a duplicate
 *    entry, a wrong doctrine order, an unknown tier class, a drifted
 *    degradation mode, an empty limits array, a bad asOf date and an
 *    unknown verification status are each rejected with the exact
 *    problem.
 */

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { loadDeploymentManifest } from "../../../src/platform/deployment/manifest";
import {
  PROVIDER_TIER_CLASSES,
  ProviderTiersError,
  parseProviderTiers,
  tierOfProvider,
} from "../../../src/platform/deployment/provider-tiers";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

function loadReal() {
  return loadDeploymentManifest((file) =>
    readFileSync(join(REPO_ROOT, "deploy", "manifests", file), "utf8"),
  );
}

function realLedgerSource(): string {
  return readFileSync(join(REPO_ROOT, "deploy", "manifests", "provider-tiers.json"), "utf8");
}

function parseLedger(source: string): ReturnType<typeof parseProviderTiers> {
  return parseProviderTiers(source, loadReal());
}

function problemsOf(source: string): string[] {
  try {
    parseLedger(source);
  } catch (error) {
    if (error instanceof ProviderTiersError) {
      return [...error.problems];
    }
    throw error;
  }
  throw new Error("expected the mutated ledger to fail closed");
}

/** Mutate a top-level or nested field of the ledger document. */
function mutate(mutator: (document: Record<string, unknown>) => void): string {
  const document = JSON.parse(realLedgerSource()) as Record<string, unknown>;
  mutator(document);
  return JSON.stringify(document, null, 2);
}

describe("the real provider-tiers ledger (DEP-001 AC4)", () => {
  test("loads fail-closed against the real manifest set", () => {
    expect(() => parseLedger(realLedgerSource())).not.toThrow();
  });

  test("covers every providers.json provider exactly once", () => {
    const ledger = parseLedger(realLedgerSource());
    const manifest = loadReal();
    expect(ledger.tiers.map((tier) => tier.provider).sort()).toEqual(
      manifest.providers.map((provider) => provider.id).sort(),
    );
  });

  test("declares the roadmap doctrine order exactly", () => {
    const ledger = JSON.parse(realLedgerSource()) as { doctrineOrder: string[] };
    expect(ledger.doctrineOrder).toEqual([...PROVIDER_TIER_CLASSES]);
  });

  test("records the honest worker-pod verification boundary", () => {
    const ledger = parseLedger(realLedgerSource());
    expect(ledger.verificationStatus).toBe("recorded-not-live-verified");
    expect(ledger.verificationDetail).toContain("NOT RUN");
    expect(ledger.verificationDetail).toContain("re-verify");
  });

  test("records non-empty exact limits with a source for every provider", () => {
    const ledger = parseLedger(realLedgerSource());
    for (const tier of ledger.tiers) {
      expect(tier.limits.length).toBeGreaterThan(0);
      for (const limit of tier.limits) {
        expect(limit.metric.length).toBeGreaterThan(0);
        expect(limit.value.length).toBeGreaterThan(0);
      }
      expect(tier.limitsSource.length).toBeGreaterThan(0);
      expect(tier.upgradeExit.length).toBeGreaterThan(0);
    }
  });

  test("the authoritative concern on a free tier carries the production upgrade path", () => {
    const ledger = parseLedger(realLedgerSource());
    const manifest = loadReal();
    const neon = tierOfProvider(ledger, "neon");
    expect(neon?.selectedTier.tierClass).toBe("provider-free-tier");
    const provider = manifest.providers.find((entry) => entry.id === "neon");
    expect(provider?.degradation.authority).toBe("authoritative");
    expect(neon?.upgradeExit).toContain("Launch");
    expect(neon?.operationallyCritical).toBe(true);
  });

  test("Vercel Hobby carries the commercial-use restriction as a recorded limit", () => {
    const ledger = parseLedger(realLedgerSource());
    const vercel = tierOfProvider(ledger, "vercel");
    expect(vercel?.selectedTier.tierClass).toBe("provider-free-tier");
    const commercial = vercel?.limits.find((limit) => limit.metric === "commercial-use");
    expect(commercial?.value).toContain("PROHIBITED");
    expect(vercel?.terms).toContain("non-commercial");
  });

  test("every exhaustion mode equals the providers.json declared degradation mode", () => {
    const ledger = parseLedger(realLedgerSource());
    const manifest = loadReal();
    for (const tier of ledger.tiers) {
      const provider = manifest.providers.find((entry) => entry.id === tier.provider);
      expect(tier.exhaustionBehavior.mode).toBe(provider?.degradation.mode);
    }
  });
});

describe("the ledger fails closed on synthetic mutations", () => {
  test("a provider missing its tier entry is rejected", () => {
    const problems = problemsOf(
      mutate((document) => {
        const tiers = document.tiers as { provider: string }[];
        document.tiers = tiers.filter((tier) => tier.provider !== "upstash-redis");
      }),
    );
    expect(problems.join("\n")).toContain(
      'provider "upstash-redis" (concern "ephemeral-coordination") has no tier entry',
    );
  });

  test("an unknown provider entry is rejected", () => {
    const problems = problemsOf(
      mutate((document) => {
        const tiers = document.tiers as Record<string, unknown>[];
        const first = tiers[0];
        if (first === undefined) {
          throw new Error("test fixture: the ledger has no entries");
        }
        tiers.push({ ...first, provider: "mystery-vendor" });
      }),
    );
    expect(problems.join("\n")).toContain(
      'provider "mystery-vendor" is not declared in providers.json',
    );
  });

  test("a duplicate provider entry is rejected", () => {
    const problems = problemsOf(
      mutate((document) => {
        const tiers = document.tiers as Record<string, unknown>[];
        const first = tiers[0];
        if (first === undefined) {
          throw new Error("test fixture: the ledger has no entries");
        }
        tiers.push(structuredClone(first));
      }),
    );
    expect(problems.join("\n")).toContain("appears more than once");
  });

  test("a drifted doctrine order is rejected", () => {
    const problems = problemsOf(
      mutate((document) => {
        (document.doctrineOrder as string[]).reverse();
      }),
    );
    expect(problems.join("\n")).toContain("doctrineOrder must equal the roadmap doctrine order");
  });

  test("an unknown tier class is rejected", () => {
    const problems = problemsOf(
      mutate((document) => {
        const tiers = document.tiers as { selectedTier: { tierClass: string } }[];
        const first = tiers[0];
        if (first === undefined) {
          throw new Error("test fixture: the ledger has no entries");
        }
        first.selectedTier.tierClass = "generous-unlimited";
      }),
    );
    expect(problems.join("\n")).toContain("selectedTier.tierClass must be one of");
  });

  test("an exhaustion mode that contradicts providers.json is rejected", () => {
    const problems = problemsOf(
      mutate((document) => {
        const tiers = document.tiers as { exhaustionBehavior: { mode: string } }[];
        const first = tiers[0];
        if (first === undefined) {
          throw new Error("test fixture: the ledger has no entries");
        }
        first.exhaustionBehavior.mode = "silently-keep-spending";
      }),
    );
    expect(problems.join("\n")).toContain(
      "disagrees with the providers.json declared degradation mode",
    );
  });

  test("an empty limits array is rejected (exact limits are the AC4 record)", () => {
    const problems = problemsOf(
      mutate((document) => {
        const tiers = document.tiers as { limits: unknown[] }[];
        const first = tiers[0];
        if (first === undefined) {
          throw new Error("test fixture: the ledger has no entries");
        }
        first.limits = [];
      }),
    );
    expect(problems.join("\n")).toContain("limits must be a non-empty array");
  });

  test("a malformed asOf date is rejected", () => {
    const problems = problemsOf(
      mutate((document) => {
        document.asOf = "sometime";
      }),
    );
    expect(problems.join("\n")).toContain("asOf must be an ISO calendar date");
  });

  test("an unknown verification status is rejected", () => {
    const problems = problemsOf(
      mutate((document) => {
        const verification = document.verification as { status: string };
        verification.status = "trust-me";
      }),
    );
    expect(problems.join("\n")).toContain("verification.status must be one of");
  });

  test("a concern disagreement with providers.json is rejected", () => {
    const problems = problemsOf(
      mutate((document) => {
        const tiers = document.tiers as { concern: string }[];
        const first = tiers[0];
        if (first === undefined) {
          throw new Error("test fixture: the ledger has no entries");
        }
        first.concern = "some-other-concern";
      }),
    );
    expect(problems.join("\n")).toContain("disagrees with providers.json");
  });
});
