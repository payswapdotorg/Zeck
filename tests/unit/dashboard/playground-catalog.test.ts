/**
 * Interactive playground catalog single-source verification (DEP-013
 * AC5 — one source of truth, no drift).
 *
 * Proves mechanically that the workload-class catalog the interactive
 * playground renders is the SAME catalog the machine manifests carry:
 *  - the picker's families are exactly the capability manifest's
 *    families and exactly the corpus's WORKLOAD_FAMILIES (the platform
 *    vocabulary the machine-schemas suite reconciles against);
 *  - every family's recorded example exists in the examples manifest
 *    with a matching family, and every family-classified example names
 *    a known family (cross-manifest no-drift, both directions);
 *  - the composer schema of every class is exactly the class's
 *    ADVERTISED CONTRACT (the manifest's taskShape keys, in order);
 *  - every closed-vocabulary value and list item is corpus-recorded or
 *    the manifest's own recorded default (the synthetic vocabulary is
 *    the corpus's — never a console-local invention);
 *  - every numeric envelope sits inside the corpus-recorded range;
 *  - the default composition validates for every family and composes
 *    to the manifest's recorded task shape (the guided default IS the
 *    advertised contract);
 *  - the availability view's hard NOT RUN set is exactly the families
 *    whose required capability has no candidate provider in the
 *    capability matrix (projected, never hand-classified).
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import { consoleFamilies, familyOf } from "../../../apps/dashboard/console";
import {
  composerSchemaOf,
  corpusTaskCountOf,
  defaultTaskFormValuesOf,
  exampleOfFamily,
  familyIsHardBlocked,
  interactiveFormKeysOf,
  playgroundAvailabilityOf,
  playgroundExamples,
  validateInteractiveRunForm,
} from "../../../apps/dashboard/playground";
import { CAPABILITY_MATRIX, PROVIDER_ACCESS } from "../../../benchmarks/validation/capabilities";
import { GOLDEN_TASKS } from "../../../benchmarks/validation/corpus";
import { WORKLOAD_FAMILIES } from "../../../benchmarks/validation/corpus/schema";

const REPOSITORY_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../..");

const capabilityManifest = JSON.parse(
  readFileSync(join(REPOSITORY_ROOT, "docs/developer/machine/capability-manifest.json"), "utf8"),
) as {
  workloadFamilies: {
    family: string;
    example: string;
    taskShape: Record<string, unknown>;
    capabilityRequirements: string[];
  }[];
};

describe("the picker catalog is the machine manifest's catalog (no drift)", () => {
  test("the projected families are exactly the capability manifest's families, in order", () => {
    expect(consoleFamilies().map((family) => family.family)).toEqual(
      capabilityManifest.workloadFamilies.map((entry) => entry.family),
    );
  });

  test("the picker families are exactly the corpus's WORKLOAD_FAMILIES (the platform vocabulary)", () => {
    expect([...consoleFamilies().map((family) => family.family)].sort()).toEqual(
      [...WORKLOAD_FAMILIES].sort(),
    );
    expect(consoleFamilies()).toHaveLength(22);
  });

  test("every family's recorded example exists in the examples manifest with a matching family", () => {
    for (const family of consoleFamilies()) {
      const example = exampleOfFamily(family);
      expect(example, `${family.family}: example projected`).not.toBeNull();
      expect(example?.path).toBe(family.example);
      expect(example?.family).toBe(family.family);
    }
  });

  test("every family-classified example names a family the capability manifest carries (no orphans)", () => {
    const known = new Set(consoleFamilies().map((family) => family.family));
    for (const example of playgroundExamples()) {
      if (example.family.length > 0) {
        expect(
          known.has(example.family),
          `${example.path}: claims unknown family ${example.family}`,
        ).toBe(true);
      }
    }
  });

  test("every family has corpus tasks recorded (the synthetic vocabulary source is non-empty)", () => {
    for (const family of consoleFamilies()) {
      expect(corpusTaskCountOf(family.family), family.family).toBeGreaterThan(0);
    }
  });
});

describe("the composer schema is the class's advertised contract (AC1)", () => {
  const families = consoleFamilies();

  test("every family's composer fields are exactly the manifest taskShape keys, in order", () => {
    for (const family of families) {
      const schemaKeys = composerSchemaOf(family).map((field) => field.key);
      expect(schemaKeys, family.family).toEqual(Object.keys(family.taskShape));
    }
  });

  test("the task discriminator is fixed to the manifest's recorded kind for every family", () => {
    for (const family of families) {
      const kindField = composerSchemaOf(family).find((field) => field.key === "kind");
      expect(kindField?.kind, family.family).toBe("fixed");
      expect((kindField as { value: string } | undefined)?.value).toBe(family.taskShape.kind);
    }
  });

  test("every closed-vocabulary value is corpus-recorded or the manifest's own default", () => {
    for (const family of families) {
      const corpusEntries = GOLDEN_TASKS.filter((task) => task.family === family.family).flatMap(
        (task) => Object.entries(task.input),
      );
      for (const field of composerSchemaOf(family)) {
        if (field.kind === "select") {
          for (const value of field.values) {
            const recorded = corpusEntries.some(
              ([key, corpusValue]) => key === field.key && corpusValue === value,
            );
            expect(
              recorded || value === field.defaultValue,
              `${family.family}: task.${field.key} value "${value}" is neither corpus-recorded nor the manifest default`,
            ).toBe(true);
          }
        }
        if (field.kind === "list") {
          for (const item of field.vocabulary) {
            const recorded = corpusEntries.some(
              ([key, corpusValue]) =>
                key === field.key && Array.isArray(corpusValue) && corpusValue.includes(item),
            );
            expect(
              recorded || field.defaultValue.includes(item),
              `${family.family}: task.${field.key} item "${item}" is neither corpus-recorded nor a manifest default item`,
            ).toBe(true);
          }
        }
      }
    }
  });

  test("every numeric envelope sits inside the corpus-recorded range for the family", () => {
    for (const family of families) {
      for (const field of composerSchemaOf(family)) {
        if (field.kind !== "number") {
          continue;
        }
        const corpusNumbers = GOLDEN_TASKS.filter(
          (task) => task.family === family.family && typeof task.input[field.key] === "number",
        ).map((task) => task.input[field.key] as number);
        if (corpusNumbers.length === 0) {
          continue;
        }
        expect(field.min, `${family.family}: task.${field.key} min`).toBe(
          Math.min(...corpusNumbers),
        );
        expect(field.max, `${family.family}: task.${field.key} max`).toBe(
          Math.max(...corpusNumbers),
        );
      }
    }
  });

  test("free-text fields exist only where the corpus carries non-fixture string values", () => {
    for (const family of families) {
      for (const field of composerSchemaOf(family)) {
        if (field.kind !== "text") {
          continue;
        }
        const corpusTexts = GOLDEN_TASKS.filter(
          (task) => task.family === family.family && typeof task.input[field.key] === "string",
        );
        expect(
          corpusTexts.length,
          `${family.family}: task.${field.key} is free text but the corpus carries no string values`,
        ).toBeGreaterThan(0);
      }
    }
  });
});

describe("the default composition is the advertised contract (guided default = recorded shape)", () => {
  test("the default form values validate and compose to the manifest's taskShape verbatim, for every family", () => {
    for (const family of consoleFamilies()) {
      const form = {
        applicationId: "00000000-0000-7000-8000-0000000000dd",
        environmentId: "",
        spendLimitDollars: "",
        idempotencyKey: "catalog-default",
        ...defaultTaskFormValuesOf(family),
      };
      const validation = validateInteractiveRunForm(family, form);
      expect(
        validation.values,
        `${family.family}: default composition must validate (errors: ${JSON.stringify(
          validation.errors,
        )})`,
      ).not.toBeNull();
      const task = validation.values?.task ?? {};
      const composed: Record<string, unknown> = {};
      for (const field of composerSchemaOf(family)) {
        if (field.kind === "fixed") {
          composed[field.key] = family.taskShape[field.key];
          continue;
        }
        const raw = task[field.key] ?? "";
        if (field.kind === "number") {
          composed[field.key] = Number.parseInt(raw, 10);
        } else if (field.kind === "boolean") {
          composed[field.key] = raw === "true";
        } else if (field.kind === "list") {
          composed[field.key] = raw.split(",").filter((item) => item.length > 0);
        } else {
          composed[field.key] = raw;
        }
      }
      expect(composed, family.family).toEqual(family.taskShape);
    }
  });

  test("a hand-addressed request without task fields composes the recorded default (no bypass)", () => {
    const family = familyOf("text");
    expect(family).not.toBeNull();
    if (family === null) {
      return;
    }
    const validation = validateInteractiveRunForm(family, {
      applicationId: "app-x",
      environmentId: "",
      spendLimitDollars: "",
      idempotencyKey: "no-task-fields",
    });
    expect(validation.values).not.toBeNull();
    // The composed raw values fall back to the manifest's recorded shape.
    expect(validation.values?.task).toEqual({
      kind: "summarize",
      doc: "quarterly-report-01",
      maxWords: "60",
    });
  });
});

describe("the availability view projects the capability matrix (never hand-classified)", () => {
  test("the hard NOT RUN set is exactly the families with a zero-candidate requirement", () => {
    const zeroCandidateCapabilities = new Set(
      CAPABILITY_MATRIX.filter((entry) => entry.candidates.length === 0).map(
        (entry) => entry.capability,
      ),
    );
    for (const family of consoleFamilies()) {
      const expected = family.capabilityRequirements.some((requirement) =>
        zeroCandidateCapabilities.has(requirement),
      );
      expect(
        familyIsHardBlocked(playgroundAvailabilityOf(family, {})),
        `${family.family}: hard-blocked classification must derive from the matrix`,
      ).toBe(expected);
    }
  });

  test("every provider-rail fact names the matrix's candidate credential env vars (names only)", () => {
    for (const family of consoleFamilies()) {
      const availability = playgroundAvailabilityOf(family, {});
      for (const fact of availability.facts) {
        const matrixEntry = CAPABILITY_MATRIX.find((entry) => entry.capability === fact.capability);
        if (matrixEntry === undefined) {
          expect(fact.kind, `${family.family}: ${fact.capability}`).not.toBe("provider-rail");
          continue;
        }
        expect(fact.kind, `${family.family}: ${fact.capability}`).toBe("provider-rail");
        const expectedNames = [
          ...new Set(
            matrixEntry.candidates.flatMap((provider) =>
              PROVIDER_ACCESS.filter((access) => access.provider === provider).map(
                (access) => access.credentialEnvVar,
              ),
            ),
          ),
        ].sort();
        expect([...fact.candidateEnvVars].sort()).toEqual(expectedNames);
        for (const name of fact.candidateEnvVars) {
          expect(name).toMatch(/^[A-Z][A-Z0-9_]*_KEY$/);
        }
      }
    }
  });

  test("platform-seeded facts reference the manifest's seeded capabilities", () => {
    for (const family of consoleFamilies()) {
      const availability = playgroundAvailabilityOf(family, {});
      for (const fact of availability.facts) {
        if (fact.kind !== "platform-seeded") {
          continue;
        }
        expect(fact.seededVersion).not.toBeNull();
        expect(fact.candidateEnvVars).toEqual([]);
      }
    }
  });
});

describe("the composer vocabulary is closed against the form key space", () => {
  test("every interactive form key is a base key or a task.<contract-key> key", () => {
    const baseKeys = new Set([
      "applicationId",
      "environmentId",
      "spendLimitDollars",
      "idempotencyKey",
    ]);
    for (const family of consoleFamilies()) {
      const schemaKeys = new Set(
        composerSchemaOf(family)
          .filter((field) => field.kind !== "fixed")
          .map((field) => `task.${field.key}`),
      );
      for (const key of interactiveFormKeysOf(family)) {
        expect(
          baseKeys.has(key) || schemaKeys.has(key),
          `${family.family}: unexpected form key ${key}`,
        ).toBe(true);
      }
    }
  });
});
