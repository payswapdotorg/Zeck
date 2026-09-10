/**
 * Discrimination tests: the substrate-economics plane (WORK-054).
 *
 * Proves the WEAKENED forms of every plane invariant are rejected,
 * not merely that the happy path works (the work order's required
 * discrimination set):
 *
 *  - vendor-vocabulary leakage past the adapter seam is rejected
 *    (a vendor-branded binding key is a typed rejection; the neutral
 *    shapes that cross the seam are vendor-free; the non-adapter
 *    plane sources carry zero vendor vocabulary);
 *  - below-floor selections are inadmissible (the cheapest substrate
 *    below the quality floor is never selected; a selection without
 *    the hard quality floor cannot be constructed at all);
 *  - unattributed or unbounded facts are rejected (execution claims
 *    without a basis; startup facts without a basis or beyond the
 *    bounds);
 *  - mandatory-adoption paths are impossible (the zero-provider
 *    outcome with no fallback substrate; the pure selection runs
 *    with ZERO adapters registered and the domain modules never
 *    import the adapter directory);
 *  - non-deterministic tie-breaks are detected/rejected (identical
 *    inputs produce byte-identical records; input order never
 *    changes identity; a drifted input changes the content-addressed
 *    identity; a tampered record is rejected at read time);
 *  - authorization consults of substrate decisions are impossible
 *    (no admission/authorization vocabulary on the plane surface; no
 *    module/integration/api file references the plane).
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { buildSubstrateAccountingRecord } from "../../src/platform/substrate-economics/accounting";
import type { E2bProviderTransport } from "../../src/platform/substrate-economics/adapters/e2b";
import { createE2bAdapter } from "../../src/platform/substrate-economics/adapters/e2b";
import { SubstrateEconomicsError } from "../../src/platform/substrate-economics/catalog";
import { validateSubstrateDescriptor } from "../../src/platform/substrate-economics/facts";
import {
  deriveSelectionConstraints,
  selectSubstrate,
  validateSubstrateSelectionRecord,
} from "../../src/platform/substrate-economics/selection";
import {
  APPLICATION_ID,
  constraints,
  EXECUTION_ID,
  governedIr,
  nodeDigest,
  substrateCorpus,
  TENANT_ID,
} from "../unit/platform/substrate-economics/helpers";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

const digest = {
  sha256Hex: (value: string) => createHash("sha256").update(value, "utf8").digest("hex"),
};

const RECORDED_AT = "2026-09-24T12:00:00Z";

function derivedSelection() {
  const derived = deriveSelectionConstraints(constraints());
  return {
    candidates: substrateCorpus(),
    constraints: derived.constraints,
    sourceConstraintIds: derived.sourceConstraintIds,
    recordedAt: RECORDED_AT,
  };
}

// ---------------------------------------------------------------------------
// Vendor-vocabulary leakage past the adapter seam
// ---------------------------------------------------------------------------

describe("discrimination: vendor-vocabulary leakage past seams must be rejected", () => {
  function e2bDouble(): E2bProviderTransport {
    return {
      async createSandbox() {
        return { sandboxId: "sbx-1" };
      },
      async getSandboxPhase() {
        return { phase: "running" };
      },
      async probeReadiness() {
        return { phase: "running" };
      },
      async runCommand() {
        return { exitCode: 0, stdout: "ok", stderr: "", timedOut: false, durationMs: 5 };
      },
      async destroySandbox() {},
    };
  }

  test("a vendor-branded adapter binding key is a TYPED rejection (never admitted as neutral)", () => {
    expect(() =>
      createE2bAdapter(
        { adapterRef: "vendor://e2b", templateId: "tpl", nowEpochMs: () => 0 },
        e2bDouble(),
      ),
    ).toThrow(SubstrateEconomicsError);
    expect(() =>
      createE2bAdapter({ adapterRef: "E2B", templateId: "tpl", nowEpochMs: () => 0 }, e2bDouble()),
    ).toThrow(SubstrateEconomicsError);
  });

  test("the neutral shapes that cross the adapter seam are vendor-free (no leakage in outputs)", async () => {
    const adapter = createE2bAdapter(
      { adapterRef: "substrate-adapter-01", templateId: "tpl", nowEpochMs: () => 1 },
      e2bDouble(),
    );
    const outputs = [
      await adapter.run(
        {
          image: "zeck-workload:1",
          command: "python3",
          args: [],
          env: [],
          mounts: [],
          network: { mode: "none", allowedHosts: [] },
          resourceLimits: { cpuMilliCores: 500, memoryMiB: 256, executionTimeoutMs: 5000 },
          readOnlyRootfs: true,
          runAsNonRoot: true,
          privileged: false,
          hostNetwork: false,
          hostPid: false,
          hostIpc: false,
          devices: [],
          addedCapabilities: [],
          droppedCapabilities: ["ALL"],
          seccompProfile: "default",
          noNewPrivileges: true,
        },
        { runIdentity: "app/exec-1/sandbox-1", timeoutMs: 5000 },
      ),
      await adapter.observeReadiness({ substrateId: "std-microvm-a" }),
      adapter.runtimeId,
      adapter.adapterRef,
    ];
    const serialized = JSON.stringify(outputs).toLowerCase();
    for (const word of ["e2b", "daytona", "modal", "firecracker"]) {
      expect(serialized, `the seam outputs must not carry "${word}"`).not.toContain(word);
    }
  });

  test("the non-adapter plane sources carry ZERO vendor vocabulary (static confinement)", () => {
    const planeRoot = join(REPO_ROOT, "src/platform/substrate-economics");
    const files = readdirSync(planeRoot, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
      .map((entry) => join(planeRoot, entry.name));
    expect(files.length).toBe(6);
    for (const file of files) {
      const content = readFileSync(file, "utf8");
      for (const word of ["e2b", "daytona", "modal", "firecracker", "openrouter"]) {
        expect(content, `${file} must not carry "${word}"`).not.toMatch(
          new RegExp(`(?<![a-zA-Z])${word}(?![a-zA-Z])`, "i"),
        );
      }
    }
  });
});

// ---------------------------------------------------------------------------
// Below-floor selections are inadmissible
// ---------------------------------------------------------------------------

describe("discrimination: below-floor selections must be inadmissible", () => {
  test("the CHEAPEST substrate below the quality floor is never selected (admission impossible)", () => {
    // The corpus's cheapest candidate (cheap-process-c, 50 µ$) is far
    // below the 0.8 hard floor — the selection must NEVER admit it.
    const result = selectSubstrate(
      {
        candidates: substrateCorpus(),
        constraints: { minQuality: 0.85 },
        recordedAt: RECORDED_AT,
      },
      digest,
    );
    expect(result.outcome).toBe("selected");
    expect(result.selected?.substrateId).not.toBe("cheap-process-c");
    for (const verdict of result.verdicts.filter((v) => v.substrateId === "cheap-process-c")) {
      expect(verdict.sufficient).toBe(false);
      expect(verdict.insufficiencyCode).toBe("quality-below-floor");
    }
  });

  test("the weakened form — selection WITHOUT the hard quality floor — cannot be constructed", () => {
    const floorless = constraints().filter(
      (constraint) => !(constraint.kind === "quality" && constraint.enforcement === "hard"),
    );
    expect(() => deriveSelectionConstraints(floorless)).toThrow(SubstrateEconomicsError);
  });

  test("a MUTATED floor (the hard quality floor weakened to soft) is likewise rejected", () => {
    const weakened = constraints().map((constraint) =>
      constraint.kind === "quality" ? { ...constraint, enforcement: "soft" as const } : constraint,
    );
    expect(() => deriveSelectionConstraints(weakened)).toThrow(SubstrateEconomicsError);
  });
});

// ---------------------------------------------------------------------------
// Unattributed or unbounded facts are rejected
// ---------------------------------------------------------------------------

describe("discrimination: unattributed or unbounded facts must be rejected", () => {
  const wellFormed = substrateCorpus()[0] as Record<string, unknown>;

  function coldFact(descriptor: Record<string, unknown>): Record<string, unknown> {
    const startup = descriptor.startup as Record<string, Record<string, unknown>>;
    const cold = startup.cold;
    if (cold === undefined) {
      throw new Error("test fixture: the cold startup fact is missing");
    }
    return cold;
  }

  test("an execution claim WITHOUT a basis is rejected (unattributed fact)", () => {
    const unattributed = structuredClone(wellFormed);
    (unattributed.execution as Record<string, unknown>).basis = undefined;
    // The WORK-049 foundation's own validation applies WHOLESALE.
    expect(() => validateSubstrateDescriptor(unattributed)).toThrowError(
      expect.objectContaining({ name: "CostModelError" }),
    );
  });

  test("a startup fact WITHOUT a basis is rejected (unattributed fact)", () => {
    const unattributed = structuredClone(wellFormed);
    coldFact(unattributed).basis = undefined;
    expect(() => validateSubstrateDescriptor(unattributed)).toThrow(SubstrateEconomicsError);
  });

  test("an UNBOUNDED startup readiness expectation is rejected (never silently rounded)", () => {
    const unbounded = structuredClone(wellFormed);
    coldFact(unbounded).readinessMs = Number.NaN;
    expect(() => validateSubstrateDescriptor(unbounded)).toThrow(SubstrateEconomicsError);
    const negative = structuredClone(wellFormed);
    coldFact(negative).readinessMs = -1;
    expect(() => validateSubstrateDescriptor(negative)).toThrow(SubstrateEconomicsError);
  });
});

// ---------------------------------------------------------------------------
// Mandatory adoption is impossible (the zero-provider proof)
// ---------------------------------------------------------------------------

describe("discrimination: mandatory-adoption paths must be impossible", () => {
  test("the EMPTY candidate set is the zero-provider outcome — NO fallback substrate is invented", () => {
    const result = selectSubstrate(
      {
        candidates: [],
        constraints: { minQuality: 0.8 },
        recordedAt: RECORDED_AT,
      },
      digest,
    );
    expect(result.outcome).toBe("no-candidates");
    expect(result.selected).toBeNull();
    // The record is still representable and replayable (zero-provider
    // operation is a first-class outcome, never an error).
    expect(() => validateSubstrateSelectionRecord(result.record, digest)).not.toThrow();
  });

  test("NO sufficient candidate is fail-closed (never a below-floor fallback adoption)", () => {
    const result = selectSubstrate(
      {
        candidates: substrateCorpus(),
        constraints: { minQuality: 0.99 },
        recordedAt: RECORDED_AT,
      },
      digest,
    );
    expect(result.outcome).toBe("no-sufficient-substrate");
    expect(result.selected).toBeNull();
  });

  test("the pure selection runs with ZERO adapters registered (adapters are never required)", () => {
    // The real selection over the real corpus + the derived real
    // constraints — no adapter object exists anywhere in this call.
    const result = selectSubstrate(derivedSelection(), nodeDigest);
    expect(result.outcome).toBe("selected");
    expect(result.selected?.substrateId).toBe("mid-container-b");
  });

  test("the domain modules NEVER import the adapter directory (mechanisms, never dependencies)", () => {
    const planeRoot = join(REPO_ROOT, "src/platform/substrate-economics");
    for (const name of [
      "catalog.ts",
      "facts.ts",
      "lifecycle.ts",
      "selection.ts",
      "accounting.ts",
    ]) {
      const content = readFileSync(join(planeRoot, name), "utf8");
      expect(content, `${name} must not depend on the adapters`).not.toContain("./adapters");
    }
  });
});

// ---------------------------------------------------------------------------
// Non-deterministic tie-breaks are detected/rejected
// ---------------------------------------------------------------------------

describe("discrimination: non-deterministic tie-breaks must be detected/rejected", () => {
  test("identical inputs produce the byte-identical record (the determinism baseline)", () => {
    const first = selectSubstrate(derivedSelection(), nodeDigest);
    const second = selectSubstrate(derivedSelection(), nodeDigest);
    expect(JSON.stringify(second.record)).toBe(JSON.stringify(first.record));
    expect(second.record.selectionId).toBe(first.record.selectionId);
  });

  test("input ORDER never changes the selection or the record identity", () => {
    const input = derivedSelection();
    const reversed = {
      ...input,
      candidates: [...input.candidates].reverse(),
    };
    const straight = selectSubstrate(input, nodeDigest);
    const flipped = selectSubstrate(reversed, nodeDigest);
    expect(flipped.record.selectionId).toBe(straight.record.selectionId);
    expect(flipped.selected?.substrateId).toBe(straight.selected?.substrateId);
    expect(flipped.selected?.mode).toBe(straight.selected?.mode);
  });

  test("a DRIFTED input produces a different selectionId (mutation is detected by content addressing)", () => {
    const input = derivedSelection();
    const drifted = {
      ...input,
      candidates: input.candidates.map((candidate) =>
        (candidate as Record<string, unknown>).substrateId === "mid-container-b"
          ? {
              ...(candidate as Record<string, unknown> as Record<string, unknown>),
              version: "2.0.1",
            }
          : candidate,
      ),
    };
    const straight = selectSubstrate(input, nodeDigest);
    const mutated = selectSubstrate(drifted, nodeDigest);
    expect(mutated.record.selectionId).not.toBe(straight.record.selectionId);
  });

  test("a TAMPERED record is rejected at read time (deterministic audit)", () => {
    const result = selectSubstrate(derivedSelection(), nodeDigest);
    const record = result.record as unknown as { selectionId: string };
    // A guaranteed-different first character: content addressing must
    // detect the mutation at validation time.
    const replacement = record.selectionId.startsWith("f") ? "0" : "f";
    const tampered = {
      ...(result.record as unknown as Record<string, unknown>),
      selectionId: replacement + record.selectionId.slice(1),
    };
    expect(() => validateSubstrateSelectionRecord(tampered, nodeDigest)).toThrow();
  });
});

// ---------------------------------------------------------------------------
// Authorization consults of substrate decisions are impossible
// ---------------------------------------------------------------------------

describe("discrimination: authorization consults of substrate decisions must be impossible", () => {
  test("the plane sources expose NO admission/authorization vocabulary", () => {
    const planeRoot = join(REPO_ROOT, "src/platform/substrate-economics");
    const walk = (dir: string, out: string[]): string[] => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(path, out);
        } else if (entry.name.endsWith(".ts")) {
          out.push(path);
        }
      }
      return out;
    };
    for (const file of walk(planeRoot, [])) {
      const content = readFileSync(file, "utf8");
      for (const word of ["authorize", "admission", "approve", "reserve", "settle", "release"]) {
        expect(content, `${file} must not expose "${word}"`).not.toMatch(
          new RegExp(`(?:function|async|readonly|type|interface)\\s+${word}\\b`, "i"),
        );
      }
    }
  });

  test("NO module/integration/api file references the plane (nothing consults it for authority)", () => {
    for (const area of ["src/modules", "src/integrations", "src/api"]) {
      const walk = (dir: string, out: string[]): string[] => {
        for (const entry of readdirSync(join(REPO_ROOT, dir), { withFileTypes: true })) {
          const path = join(dir, entry.name);
          if (entry.isDirectory()) {
            walk(path, out);
          } else if (entry.name.endsWith(".ts")) {
            out.push(path);
          }
        }
        return out;
      };
      for (const file of walk(area, [])) {
        const content = readFileSync(join(REPO_ROOT, file), "utf8");
        expect(content, `${file} must not reference the plane`).not.toContain(
          "substrate-economics",
        );
      }
    }
  });

  test("the selection record is EVIDENCE, never permission — no grant/deny semantics on the record", () => {
    const result = selectSubstrate(derivedSelection(), nodeDigest);
    const serialized = JSON.stringify(result.record).toLowerCase();
    for (const word of ["authorize", "permission", "grant", "deny", "admission", "approve"]) {
      expect(serialized, `the record must not carry "${word}" semantics`).not.toContain(word);
    }
  });

  test("the accounting ride rejects INCOHERENT provenance before any record exists", () => {
    const ir = governedIr();
    const selection = selectSubstrate(derivedSelection(), nodeDigest);
    // The mutated constraint set is NOT the read-only derivation of
    // the IR's governing set — the accounting ride must reject the
    // forged provenance BEFORE the record exists.
    const forged = constraints().map((constraint) =>
      constraint.constraintId === "quality-floor"
        ? { ...constraint, payload: { minQuality: 0.01 } }
        : constraint,
    );
    expect(() =>
      buildSubstrateAccountingRecord(
        {
          applicationId: APPLICATION_ID,
          tenantId: TENANT_ID,
          executionId: EXECUTION_ID,
          ir,
          constraints: forged,
          selection,
          representationClass: "programmatic-execution",
          recordedAt: RECORDED_AT,
        },
        nodeDigest,
      ),
    ).toThrow(SubstrateEconomicsError);
  });
});
