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
 *
 * Proves the PPR-002 refresh contract (2026-09-20 baseline):
 *  - every entry carries its own asOf, source (public documentation
 *    URL, or repository contract path for repository-defined entries)
 *    and verification status;
 *  - the refreshed free-tier facts are recorded (Neon 100 projects /
 *    100 CU-hours / 0.5 GB / 10 branches; Queues + Workflows on the
 *    Workers Free allowances at doctrine position 1; Upstash 256 MB /
 *    500K monthly commands / 10 GB monthly bandwidth; Vercel $0 with
 *    the commercial-use restriction);
 *  - the commercial boundary is recorded on the delivery tier and
 *    the preview environment manifest.
 */

import { existsSync, readFileSync } from "node:fs";
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

describe("the PPR-002 refresh contract (2026-09-20 baseline)", () => {
  interface RawTierEntry {
    readonly provider: string;
    readonly asOf?: unknown;
    readonly source?: unknown;
    readonly verification?: unknown;
  }

  function rawTiers(): RawTierEntry[] {
    const document = JSON.parse(realLedgerSource()) as { tiers: RawTierEntry[] };
    return document.tiers;
  }

  test("every entry carries its own asOf, source and verification status", () => {
    for (const entry of rawTiers()) {
      expect(typeof entry.asOf).toBe("string");
      expect(entry.asOf).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(entry.asOf).toBe("2026-09-20");
      expect(typeof entry.source).toBe("string");
      expect((entry.source as string).length).toBeGreaterThan(0);
      expect(["live-verified", "recorded-not-live-verified"]).toContain(entry.verification);
    }
  });

  test("external providers cite public documentation URLs; repository-defined entries cite repository contracts", () => {
    const repositoryRoot = resolve(REPO_ROOT);
    for (const entry of rawTiers()) {
      const source = String(entry.source);
      if (entry.provider === "zeck-container-runner" || entry.provider === "otel-export") {
        expect(source).not.toMatch(/^https?:\/\//);
        expect(existsSync(join(repositoryRoot, source))).toBe(true);
      } else {
        expect(source).toMatch(/^https?:\/\//);
      }
    }
  });

  test("Neon Free records the refreshed baseline: 100 projects / 100 CU-hours / 0.5 GB / 10 branches", () => {
    const ledger = parseLedger(realLedgerSource());
    const neon = tierOfProvider(ledger, "neon");
    expect(neon?.selectedTier.tierClass).toBe("provider-free-tier");
    const metrics = new Map(neon?.limits.map((limit) => [limit.metric, limit.value]));
    expect(metrics.get("projects")).toContain("100");
    expect(metrics.get("compute")).toContain("100 CU-hours");
    expect(metrics.get("storage")).toContain("0.5 GB");
    expect(metrics.get("branches")).toContain("10 branches");
  });

  test("Queues and Workflows ride the Workers Free allowances (doctrine position 1)", () => {
    const ledger = parseLedger(realLedgerSource());
    const queues = tierOfProvider(ledger, "cloudflare-queues");
    expect(queues?.selectedTier.tierClass).toBe("provider-free-tier");
    expect(queues?.selectedTier.tierName).toContain("Workers Free");
    const queueMetrics = new Map(queues?.limits.map((limit) => [limit.metric, limit.value]));
    expect(queueMetrics.get("operations")).toContain("10,000");
    expect(queueMetrics.get("message-retention")).toContain("24 hours");

    const workflows = tierOfProvider(ledger, "cloudflare-workflows");
    expect(workflows?.selectedTier.tierClass).toBe("provider-free-tier");
    expect(workflows?.selectedTier.tierName).toContain("Workers Free");
    const workflowMetrics = new Map(workflows?.limits.map((limit) => [limit.metric, limit.value]));
    expect(workflowMetrics.get("requests")).toContain("100,000");
    expect(workflowMetrics.get("steps")).toContain("3,000");
    expect(workflowMetrics.get("storage")).toContain("1 GB-month");
  });

  test("Upstash Redis Free records the refreshed baseline: 256 MB / 500K monthly commands / 10 GB monthly bandwidth", () => {
    const ledger = parseLedger(realLedgerSource());
    const upstash = tierOfProvider(ledger, "upstash-redis");
    expect(upstash?.selectedTier.tierClass).toBe("provider-free-tier");
    const metrics = new Map(upstash?.limits.map((limit) => [limit.metric, limit.value]));
    expect(metrics.get("max-data-size")).toContain("256 MB");
    expect(metrics.get("commands")).toContain("500,000");
    expect(metrics.get("commands")).toContain("month");
    expect(metrics.get("bandwidth")).toContain("10 GB");
  });

  test("the commercial boundary is recorded on the delivery tier and the preview environment", () => {
    const ledger = parseLedger(realLedgerSource());
    const vercel = tierOfProvider(ledger, "vercel");
    const price = vercel?.limits.find((limit) => limit.metric === "price");
    expect(price?.value).toContain("$0");
    expect(vercel?.terms).toContain("non-commercial");

    // The preview environment manifest carries the explicit boundary
    // annotation (read raw: the loader ignores annotation fields).
    const environments = JSON.parse(
      readFileSync(join(REPO_ROOT, "deploy", "manifests", "environments.json"), "utf8"),
    ) as { environments: { preview: { commercialBoundary?: string } } };
    const boundary = environments.environments.preview.commercialBoundary;
    expect(typeof boundary).toBe("string");
    expect(boundary).toContain("non-commercial");
    expect(boundary).toContain("commercial production");
  });

  test("the refreshed ledger still loads against the real manifest set (structure preserved)", () => {
    // The exhaustion/degradation/upgrade/exit behavior fields are
    // preserved by the refresh — pinned by the DEP-001 block above;
    // this pins that the refresh did not break the parse itself.
    expect(() => parseLedger(realLedgerSource())).not.toThrow();
  });
});
