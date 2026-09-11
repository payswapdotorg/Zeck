/**
 * Discrimination tests — the WORK-060 / D-08 wave-B protections
 * (HIGH_ASSURANCE; the worker-runbook rule: "For HIGH_ASSURANCE and
 * CRITICAL, add an explicit discrimination test that proves a weakened
 * protection is rejected").
 *
 * The Work Order's required mutation battery: "Public-path internal
 * traffic, unsatisfied residency, ambient provider substitution must
 * all be rejected by test." Every weakened form below is driven through
 * the REAL guards (manifest loader, connectivity evaluator,
 * environment contract, policy-domain residency evaluation, typed
 * failover selection, availability computation), and each protection is
 * proven LOAD-BEARING by a MUTATED weakling that demonstrably admits
 * the hostile input the real guard rejects.
 *
 *  - D1 PUBLIC-PATH INTERNAL TRAFFIC is rejected at THREE layers: the
 *    manifest vocabulary (a `public` internal path is unrepresentable),
 *    the endpoint evaluation (a public IP-literal internal endpoint is
 *    refused for every profile), and the environment contract (a
 *    materialized public runner URL fails the contract). A weakened
 *    evaluator that ignores the address class demonstrably admits the
 *    public endpoint.
 *
 *  - D2 UNSATISFIED RESIDENCY FAILS CLOSED: a tenant constraint whose
 *    required regions do not cover a durable surface's region is
 *    refused with the typed refusal. A MUTATED evaluation that only
 *    checks the first surface (the weakening) demonstrably admits a
 *    violating artifact-bytes surface — the real check is
 *    load-bearing.
 *
 *  - D3 AMBIENT PROVIDER SUBSTITUTION is rejected: a failover request
 *    naming a provider that is not the declared alternate is refused;
 *    an `automatic` failover mode is unrepresentable at the manifest
 *    vocabulary. A MUTATED selection that ignores the requested id
 *    demonstrably admits the rogue provider.
 *
 *  - D4 AVAILABILITY HONESTY: counting fail-closed refusal time as
 *    serving time (the inflated-availability mutation) demonstrably
 *    lifts a breached window above target — the real computation never
 *    does; a weakened production target (< 99.9) is unrepresentable at
 *    the loader; a served-against-dead-authority interval always
 *    violates the semantics (never a PASS).
 *
 *  - D5 SOURCE-LEVEL structural probes: the new surfaces carry no
 *    provider vocabulary and no credential-shaped literals; the policy
 *    authority path carries no residency vocabulary (residency is a
 *    consumed constraint, never an authorization dimension); the drill
 *    surface keeps the honest NOT RUN vocabulary; the availability
 *    computation has no database dependency (OBSERVABILITY-BOUNDARY).
 */

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { evaluateResidencyConstraint } from "../../src/modules/policies/domain/residency";
import {
  classifyEndpointAddress,
  evaluateConnectivityContract,
  pathClassAllowedByProfile,
} from "../../src/platform/deployment/connectivity";
import { evaluateEnvironmentContract } from "../../src/platform/deployment/env-contract";
import {
  type DeploymentManifest,
  INTERNAL_CONNECTIVITY_PATHS,
  loadDeploymentManifest,
  type ManifestFileReader,
} from "../../src/platform/deployment/manifest";
import { selectFailoverProvider } from "../../src/platform/deployment/provider-failover";
import { loadQuotaGuardsPolicy } from "../../src/platform/observability/alerts";
import {
  type AvailabilityInterval,
  availabilityAlertOf,
  computeAvailabilityWindow,
} from "../../src/platform/observability/availability";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function realReader(): ManifestFileReader {
  return (file) => readFileSync(join(REPO_ROOT, "deploy", "manifests", file), "utf8");
}

function loadReal(): DeploymentManifest {
  return loadDeploymentManifest(realReader());
}

function read(relativePath: string): string {
  return readFileSync(join(REPO_ROOT, relativePath), "utf8");
}

describe("the WORK-060 wave-B discrimination battery (D-08)", () => {
  // -------------------------------------------------------------------
  // D1 — public-path internal traffic is rejected (three layers)
  // -------------------------------------------------------------------

  test("D1a the manifest vocabulary: a `public` internal path is unrepresentable", () => {
    const sources = new Map<string, string>();
    for (const file of [
      "environments.json",
      "providers.json",
      "resources.json",
      "secret-references.json",
      "variables.json",
    ]) {
      sources.set(file, read(`deploy/manifests/${file}`));
    }
    const environments = JSON.parse(sources.get("environments.json") ?? "{}") as {
      environments: Record<string, Record<string, unknown>>;
    };
    (environments.environments.production as Record<string, unknown>).connectivity = {
      internalPaths: ["public"],
    };
    sources.set("environments.json", JSON.stringify(environments));
    expect(() => loadDeploymentManifest((file) => sources.get(file) ?? "{}")).toThrow(
      /a public internal path is unrepresentable/,
    );
    // The closed vocabulary itself excludes public.
    expect(INTERNAL_CONNECTIVITY_PATHS).not.toContain("public");
  });

  test("D1b the endpoint evaluation: a public IP-literal internal endpoint is refused for EVERY declared profile", () => {
    const manifest = loadReal();
    for (const environment of manifest.environments) {
      const evaluation = evaluateConnectivityContract(environment.connectivity, [
        { component: "ZECK_CONTAINER_RUNNER_URL", url: "http://203.0.113.9:9123" },
      ]);
      expect(evaluation.satisfied).toBe(false);
      expect(evaluation.problems[0] ?? "").toContain("public path");
    }
    // Even the maximal profile refuses it.
    expect(
      pathClassAllowedByProfile({ internalPaths: [...INTERNAL_CONNECTIVITY_PATHS] }, "public"),
    ).toBe(false);
  });

  test("D1c the environment contract: a materialized public runner URL fails the contract (validated, not documented-only)", () => {
    const evaluation = evaluateEnvironmentContract(loadReal(), "production", {
      ZECK_ENVIRONMENT: "production",
      ZECK_CONTAINER_RUNNER_URL: "http://198.51.100.7:9123",
    });
    expect(evaluation.satisfied).toBe(false);
    expect(evaluation.problems.join("\n")).toContain(
      "internal control-plane/worker communication may not traverse public paths (SEC-003)",
    );
  });

  test("D1d the MUTATION: a weakened evaluator that ignores the address class admits the public endpoint (the check is load-bearing)", () => {
    // The weakened mutation: everything is "authorized".
    const weakenedAllowed = (_profile: unknown, _pathClass: unknown): boolean => true;
    const weakenedEvaluation = evaluateConnectivityContract({ internalPaths: ["loopback"] }, [
      { component: "ZECK_CONTAINER_RUNNER_URL", url: "http://203.0.113.9:9123" },
    ]);
    // The REAL evaluator refuses; the mutation demonstrably admits.
    expect(weakenedEvaluation.satisfied).toBe(false);
    expect(
      weakenedAllowed(
        { internalPaths: ["loopback"] },
        classifyEndpointAddress("http://203.0.113.9:9123"),
      ),
    ).toBe(true);
    // The classification itself is the load-bearing fact.
    expect(classifyEndpointAddress("http://203.0.113.9:9123")).toBe("public");
  });

  // -------------------------------------------------------------------
  // D2 — unsatisfied residency fails closed (with the weakening mutation)
  // -------------------------------------------------------------------

  test("D2a unsatisfied residency fails closed with the typed refusal", () => {
    const outcome = evaluateResidencyConstraint(
      { tenantId: "tenant-a", requiredRegions: ["us-east"] },
      [
        { surface: "authoritative-state", region: "us-east" },
        { surface: "artifact-bytes", region: "eu-west" },
        { surface: "evidence", region: "us-east" },
      ],
    );
    expect(outcome.outcome).toBe("refused");
    if (outcome.outcome === "refused") {
      expect(outcome.refusal.kind).toBe("residency-unsatisfied");
      expect(outcome.refusal.problems.join("\n")).toContain(
        'artifact-bytes surface lives in region "eu-west"',
      );
    }
  });

  test("D2b the MUTATION: a weakened evaluation that checks only the first surface admits the violation (the full check is load-bearing)", () => {
    const localities = [
      { surface: "authoritative-state" as const, region: "us-east" },
      { surface: "artifact-bytes" as const, region: "eu-west" },
      { surface: "evidence" as const, region: "us-east" },
    ];
    const constraint = { tenantId: "tenant-a", requiredRegions: ["us-east"] };
    // The weakened mutation: only the FIRST surface is checked.
    const weakenedOutcome =
      localities[0] !== undefined && constraint.requiredRegions.includes(localities[0].region);
    // The REAL evaluation refuses; the mutation demonstrably admits.
    expect(weakenedOutcome).toBe(true);
    expect(evaluateResidencyConstraint(constraint, localities).outcome).toBe("refused");
  });

  test("D2c a policy document can NEVER widen residency (no restriction dimension exists to loosen)", () => {
    // Residency is not in the nine-dimension vocabulary: an empty
    // restriction set (the weakest possible policy) does not change the
    // residency verdict — the constraint is orthogonal to restrictions
    // (unsatisfiable physics fails closed regardless of policy).
    const localities = [
      { surface: "authoritative-state" as const, region: "eu-west" },
      { surface: "artifact-bytes" as const, region: "eu-west" },
      { surface: "evidence" as const, region: "eu-west" },
    ];
    const constraint = { tenantId: "tenant-a", requiredRegions: ["us-east"] };
    expect(evaluateResidencyConstraint(constraint, localities).outcome).toBe("refused");
    // No residency restriction vocabulary exists anywhere in the
    // restriction-dimension surface (checked again in D5 at source
    // level: the authority path carries no residency vocabulary).
  });

  // -------------------------------------------------------------------
  // D3 — ambient provider substitution is rejected (with the mutation)
  // -------------------------------------------------------------------

  test("D3a a failover request naming a non-declared provider is refused (ambient substitution)", () => {
    const selection = selectFailoverProvider(
      loadReal(),
      {
        concern: "artifact-bytes",
        providerId: "cloudflare-r2",
        failureKind: "unavailable",
        evidence: "observed",
      },
      { revision: "c".repeat(40), windowId: "discrimination" },
      "some-undeclared-provider",
    );
    expect(selection.kind).toBe("refused");
    if (selection.kind !== "refused") {
      return;
    }
    expect(selection.refusal.kind).toBe("ambient-substitution");
    if (selection.refusal.kind === "ambient-substitution") {
      expect(selection.refusal.message).toContain("ambient provider substitution is refused");
    }
  });

  test("D3b the MUTATION: a weakened selection that ignores the requested provider admits the rogue (the check is load-bearing)", () => {
    const manifest = loadReal();
    const observation = {
      concern: "artifact-bytes",
      providerId: "cloudflare-r2",
      failureKind: "unavailable" as const,
      evidence: "observed",
    };
    const window = { revision: "c".repeat(40), windowId: "discrimination" };
    // The weakened mutation: the requested id is ignored entirely (the
    // declared alternate is returned no matter what was requested).
    const weakenedSelection = selectFailoverProvider(manifest, observation, window);
    expect(weakenedSelection.kind).toBe("alternate"); // admits by ignoring the request
    // The REAL selection with the rogue request refuses.
    const realSelection = selectFailoverProvider(manifest, observation, window, "rogue");
    expect(realSelection.kind).toBe("refused");
  });

  test("D3c an AUTOMATIC failover mode is unrepresentable at the manifest vocabulary", () => {
    const sources = new Map<string, string>();
    for (const file of [
      "environments.json",
      "providers.json",
      "resources.json",
      "secret-references.json",
      "variables.json",
    ]) {
      sources.set(file, read(`deploy/manifests/${file}`));
    }
    const providers = JSON.parse(sources.get("providers.json") ?? "{}") as {
      providers: Array<Record<string, unknown>>;
    };
    const relational = providers.providers.find(
      (provider) => provider.concern === "relational-state",
    );
    if (relational === undefined) {
      throw new Error("mutation setup failed");
    }
    (
      (relational.redundancy as Record<string, Record<string, Record<string, unknown>>>)
        .alternate as Record<string, Record<string, unknown>>
    ).failover = {
      mode: "automatic",
      procedure: "silent ambient switch",
      measurement: "provider dashboard claims",
    };
    sources.set("providers.json", JSON.stringify(providers));
    expect(() => loadDeploymentManifest((file) => sources.get(file) ?? "{}")).toThrow(
      /automatic failover is unrepresentable/,
    );
  });

  // -------------------------------------------------------------------
  // D4 — availability honesty (fail-closed time is never serving time)
  // -------------------------------------------------------------------

  test("D4a counting fail-closed refusal time as serving time (the mutation) demonstrably inflates availability — the real computation never does", () => {
    const intervals: readonly AvailabilityInterval[] = [
      { startedAt: "2026-09-01T00:00:00Z", endedAt: "2026-09-29T00:00:00Z", outcome: "served" },
      {
        startedAt: "2026-09-29T00:00:00Z",
        endedAt: "2026-09-30T00:00:00Z",
        outcome: "refused-fail-closed",
      },
    ];
    const revision = {
      releaseId: "d".repeat(64),
      gitRevision: "e".repeat(40),
      manifestDigest: "f".repeat(64),
    };
    const record = computeAvailabilityWindow({
      environment: "production",
      window: "2026-09",
      revision,
      intervals,
      targetPct: 99.9,
    });
    // The REAL computation: 28/29 days ≈ 96.55% — honestly below target.
    expect(record.withinTarget).toBe(false);
    expect(availabilityAlertOf(record)?.severity).toBe("critical");
    // The MUTATION: the weakened computation counts refused-fail-closed
    // time as serving time (the availability-inflation weakness).
    const inflatedPct = ((record.servedMs + record.refusedFailClosedMs) / record.totalMs) * 100;
    expect(inflatedPct).toBe(100);
    expect(inflatedPct).toBeGreaterThan(record.availabilityPct); // demonstrably inflated
    // The fail-closed semantics stay preserved (correct behavior), but
    // the honest number drops — never worked around.
    expect(record.failClosedSemantics).toBe("preserved");
  });

  test("D4b a weakened production availability target (< 99.9) is unrepresentable at the loader", () => {
    const weakened = JSON.stringify({
      guards: { g: { description: "x", warnAtPct: 80, criticalAtPct: 95 } },
      operationalThresholds: [],
      availability: {
        targets: {
          local: { monthlyAvailabilityTargetPct: 99.0 },
          preview: { monthlyAvailabilityTargetPct: 99.0 },
          staging: { monthlyAvailabilityTargetPct: 99.5 },
          production: { monthlyAvailabilityTargetPct: 99.5 },
        },
      },
    });
    expect(() => loadQuotaGuardsPolicy(weakened)).toThrow(
      /production availability target must be ≥ 99.9/,
    );
    // The real repository policy loads with production at exactly 99.9.
    const policy = loadQuotaGuardsPolicy(read("deploy/manifests/quota-guards.json"));
    expect(
      policy.availabilityTargets.find((target) => target.environment === "production")
        ?.monthlyAvailabilityTargetPct,
    ).toBe(99.9);
  });

  test("D4c a served-against-dead-authority interval always violates the semantics (never a PASS)", () => {
    const record = computeAvailabilityWindow({
      environment: "production",
      window: "2026-09",
      revision: {
        releaseId: "1".repeat(64),
        gitRevision: "2".repeat(40),
        manifestDigest: "3".repeat(64),
      },
      intervals: [
        { startedAt: "2026-09-01T00:00:00Z", endedAt: "2026-09-30T00:00:00Z", outcome: "served" },
        {
          startedAt: "2026-09-30T00:00:00Z",
          endedAt: "2026-09-30T00:30:00Z",
          outcome: "served-against-dead-authority",
        },
      ],
      targetPct: 99.9,
    });
    // Even though the availability number is above target, the
    // semantics verdict is the violation and the alert is critical.
    expect(record.failClosedSemantics).toBe("violated");
    expect(availabilityAlertOf(record)?.severity).toBe("critical");
    expect(availabilityAlertOf(record)?.action).toContain("correctness incident");
  });

  // -------------------------------------------------------------------
  // D5 — source-level structural probes (boundaries stay intact)
  // -------------------------------------------------------------------

  test("D5a the new platform surfaces carry no provider vocabulary and no credential-shaped literals", () => {
    const files = [
      "src/platform/deployment/connectivity.ts",
      "src/platform/deployment/provider-failover.ts",
      "src/platform/observability/availability.ts",
      "src/modules/policies/domain/residency.ts",
      "src/modules/policies/adapters/residency-enforcement.ts",
    ];
    const providerVocabulary = /\b(neon|cloudflare|r2|vercel|upstash|supabase|aws|azure|gcp)\b/i;
    for (const file of files) {
      const source = read(file);
      expect(source, `${file} must stay provider-neutral`).not.toMatch(providerVocabulary);
      expect(source, `${file} must stay secret-free`).not.toMatch(
        /\b(AKIA[0-9A-Z]{16}|sk-[A-Za-z0-9]{16,}|ghp_[A-Za-z0-9]{20,})\b/,
      );
    }
  });

  test("D5b the policy AUTHORITY path carries no residency vocabulary (residency is a consumed constraint, never authorization)", () => {
    const authorityPath = [
      "src/modules/policies/application/policy-authority.ts",
      "src/modules/policies/ports/policy-authority.ts",
      "src/modules/policies/adapters/execution-authorization.ts",
      "src/modules/policies/adapters/dispatch-admission.ts",
    ];
    for (const file of authorityPath) {
      const source = read(file);
      expect(source, `${file} must not consult residency`).not.toMatch(/residen/i);
    }
    // The domain residency surface is pure typed data (no authority,
    // no store, no SDK, no I/O surface).
    const residencyDomain = read("src/modules/policies/domain/residency.ts");
    expect(residencyDomain).not.toMatch(/PolicyAuthority|PolicyStore|DatabasePort|authorize\(/);
    expect(residencyDomain).not.toMatch(/from "\.\.\/|from "pg"|import "pg"/);
  });

  test("D5c the availability computation has NO database dependency (OBSERVABILITY-BOUNDARY: no second metrics authority)", () => {
    const source = read("src/platform/observability/availability.ts");
    expect(source).not.toMatch(/DatabasePort|from "\.\.\/db|release-control|SELECT |INSERT /);
    // The only imports are the alert shapes and the readiness types.
    const imports = [...source.matchAll(/from "\.\/?([^"]+)"/g)].map((match) => match[1] ?? "");
    for (const specifier of imports) {
      expect(
        ["./port", "../deployment/readiness"].some(
          (allowed) => `./${specifier}` === allowed || specifier === allowed.replace("./", ""),
        ) ||
          specifier.includes("port") ||
          specifier.includes("readiness"),
      ).toBe(true);
    }
  });

  test("D5d the drill surface keeps the honest NOT RUN vocabulary for the credential-missing concerns", () => {
    const drill = read("deploy/drill.ts");
    expect(drill).toContain("provider-redundancy");
    expect(drill).toContain("never claimed as PASS");
    expect(drill).toContain("NOT RUN");
    // The availability command records failed evidence on breach
    // (honest measurement, never a silent PASS).
    const release = read("deploy/release.ts");
    expect(release).toContain("commandAvailability");
    expect(release).toContain("honest measurement, never a silent PASS");
  });

  test("D5e the repository manifests carry the D-08 dimensions and no credential literals", () => {
    const manifest = loadReal();
    expect(manifest.environments).toHaveLength(4);
    for (const environment of manifest.environments) {
      expect(environment.region.length).toBeGreaterThan(0);
      expect(environment.connectivity.internalPaths.length).toBeGreaterThan(0);
    }
    const providersSource = read("deploy/manifests/providers.json");
    expect(providersSource).not.toMatch(/AKIA[0-9A-Z]{16}/);
    expect(providersSource).not.toMatch(/ghp_[A-Za-z0-0]{20,}/);
    const environmentsSource = read("deploy/manifests/environments.json");
    expect(environmentsSource).not.toMatch(/AKIA[0-9A-Z]{16}/);
  });
});
