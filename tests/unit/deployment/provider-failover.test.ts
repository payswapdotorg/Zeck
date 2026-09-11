/**
 * Unit tests — the typed provider failover selection (WORK-060 / D-08,
 * AVA-003).
 *
 * Proves over the REAL repository manifests: every durable concern has
 * exactly one typed alternate with a governed-procedure profile. Proves
 * the selection: the declared alternate is selected with deterministic
 * content-addressed provenance (IDENTITY-IDEMPOTENCY — the same
 * revision window produces the identical selectionId). Proves the
 * refusals: ambient substitution (a requested provider that is not the
 * declared alternate), missing alternate declarations, and observations
 * that do not name the owning primary are all refused with typed
 * messages — never a silent weaker substitution.
 */

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import {
  type DeploymentManifest,
  loadDeploymentManifest,
  type ManifestFileReader,
} from "../../../src/platform/deployment/manifest";
import {
  providerFailoverProfiles,
  selectFailoverProvider,
} from "../../../src/platform/deployment/provider-failover";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

function realReader(): ManifestFileReader {
  return (file) => readFileSync(join(REPO_ROOT, "deploy", "manifests", file), "utf8");
}

function loadReal(): DeploymentManifest {
  return loadDeploymentManifest(realReader());
}

const WINDOW = { revision: "f".repeat(40), windowId: "provider-redundancy-test" };

function observationFor(concern: string, providerId: string) {
  return {
    concern,
    providerId,
    failureKind: "unavailable" as const,
    evidence: "test-observed primary unavailability",
  };
}

describe("the real manifest declares typed redundancy (AVA-003)", () => {
  test("every durable concern has exactly one typed alternate with a governed procedure", () => {
    const profiles = providerFailoverProfiles(loadReal());
    expect(profiles.map((profile) => profile.concern).sort()).toEqual([
      "artifact-bytes",
      "async-transport",
      "experience-delivery",
      "relational-state",
    ]);
    for (const profile of profiles) {
      expect(profile.alternate.id).not.toBe(profile.primaryId);
      expect(profile.alternate.failover.mode).toBe("governed-procedure");
      expect(profile.alternate.failover.procedure.length).toBeGreaterThan(0);
      expect(profile.alternate.failover.measurement.length).toBeGreaterThan(0);
    }
  });

  test("the relational-state alternate points at the WORK-057 standby-hosting procedure", () => {
    const relational = providerFailoverProfiles(loadReal()).find(
      (profile) => profile.concern === "relational-state",
    );
    expect(relational?.primaryId).toBe("neon");
    expect(relational?.alternate.id).toBe("managed-postgresql-standby");
    expect(relational?.alternate.failover.procedure).toContain("authority-failover");
  });
});

describe("the typed selection (governed, idempotent, provenance-bound)", () => {
  test("selects the declared alternate for every durable concern with a deterministic selectionId", () => {
    const manifest = loadReal();
    for (const profile of providerFailoverProfiles(manifest)) {
      const selection = selectFailoverProvider(
        manifest,
        observationFor(profile.concern, profile.primaryId),
        WINDOW,
      );
      expect(selection.kind).toBe("alternate");
      if (selection.kind !== "alternate") {
        continue;
      }
      expect(selection.providerId).toBe(profile.alternate.id);
      expect(selection.provenance.concern).toBe(profile.concern);
      expect(selection.provenance.primaryId).toBe(profile.primaryId);
      expect(selection.provenance.selectionId).toMatch(/^[0-9a-f]{64}$/);
      expect(selection.provenance.canonicalForm).toContain(profile.alternate.id);
    }
  });

  test("IDENTITY-IDEMPOTENCY: the same inputs produce the identical selection (and a different window does not)", () => {
    const manifest = loadReal();
    const observation = observationFor("artifact-bytes", "cloudflare-r2");
    const first = selectFailoverProvider(manifest, observation, WINDOW);
    const second = selectFailoverProvider(manifest, observation, WINDOW);
    expect(first.kind).toBe("alternate");
    expect(second.kind).toBe("alternate");
    if (first.kind === "alternate" && second.kind === "alternate") {
      expect(second.provenance.selectionId).toBe(first.provenance.selectionId);
    }
    const otherWindow = selectFailoverProvider(manifest, observation, {
      revision: "0".repeat(40),
      windowId: "another-window",
    });
    expect(otherWindow.kind).toBe("alternate");
    if (otherWindow.kind === "alternate" && first.kind === "alternate") {
      expect(otherWindow.provenance.selectionId).not.toBe(first.provenance.selectionId);
    }
  });

  test("the evidence text is bounded in the canonical form (bounded provenance)", () => {
    const manifest = loadReal();
    const selection = selectFailoverProvider(
      manifest,
      {
        concern: "artifact-bytes",
        providerId: "cloudflare-r2",
        failureKind: "unavailable",
        evidence: "x".repeat(5000),
      },
      WINDOW,
    );
    expect(selection.kind).toBe("alternate");
    if (selection.kind === "alternate") {
      expect(selection.provenance.canonicalForm.length).toBeLessThan(1200);
    }
  });
});

describe("the typed refusals (never a silent weaker substitution)", () => {
  test("AMBIENT SUBSTITUTION: a requested provider that is not the declared alternate is refused", () => {
    const manifest = loadReal();
    const selection = selectFailoverProvider(
      manifest,
      observationFor("artifact-bytes", "cloudflare-r2"),
      WINDOW,
      "some-rogue-provider",
    );
    expect(selection.kind).toBe("refused");
    if (selection.kind !== "refused") {
      return;
    }
    expect(selection.refusal.kind).toBe("ambient-substitution");
    if (selection.refusal.kind === "ambient-substitution") {
      expect(selection.refusal.requestedProviderId).toBe("some-rogue-provider");
      expect(selection.refusal.declaredAlternateId).toBe("s3-compatible-alternate");
      expect(selection.refusal.message).toContain("ambient provider substitution is refused");
    }
  });

  test("a concern without an alternate declaration is refused (the runtime mirror of the loader rule)", () => {
    const manifest = loadReal();
    // experience-delivery has an alternate in the real tree; strip it
    // synthetically by mutating the provider record.
    const mutated: DeploymentManifest = {
      ...manifest,
      providers: manifest.providers.map((provider) =>
        provider.concern === "experience-delivery"
          ? { ...provider, redundancyAlternate: null }
          : provider,
      ),
    };
    const selection = selectFailoverProvider(
      mutated,
      observationFor("experience-delivery", "vercel"),
      WINDOW,
    );
    expect(selection.kind).toBe("refused");
    if (selection.kind === "refused") {
      expect(selection.refusal.kind).toBe("no-alternate-declared");
      expect(selection.refusal.message).toContain("AVA-003");
    }
  });

  test("an observation that does not name the owning primary is refused", () => {
    const manifest = loadReal();
    const selection = selectFailoverProvider(
      manifest,
      observationFor("artifact-bytes", "not-the-primary"),
      WINDOW,
    );
    expect(selection.kind).toBe("refused");
    if (selection.kind !== "refused") {
      return;
    }
    expect(selection.refusal.kind).toBe("not-primary-observation");
    if (selection.refusal.kind === "not-primary-observation") {
      expect(selection.refusal.primaryId).toBe("cloudflare-r2");
    }
  });

  test("an unknown concern is refused (no profile exists)", () => {
    const selection = selectFailoverProvider(
      loadReal(),
      observationFor("not-a-concern", "anyone"),
      WINDOW,
    );
    expect(selection.kind).toBe("refused");
    if (selection.kind === "refused") {
      expect(selection.refusal.kind).toBe("no-alternate-declared");
    }
  });
});
