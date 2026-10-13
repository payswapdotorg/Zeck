/**
 * Work-order vocabulary tests (PCS-001 — the console's app-to-work-order
 * mapping reads the competitiveness programs' own vocabularies).
 *
 * Pure-function and projection proofs over
 * apps/dashboard/validation-lab.ts — the mapping/projection layer ONLY
 * (no dashboard UI redesign is in scope):
 *  - the CLOSED tag family (VAL/PCR/PCS) accepts every positional variant
 *    (trailing `(TAG)`, leading `(TAG)`, bare `TAG`) for every program
 *    prefix, and admits nothing else (unknown prefixes, lowercase tags
 *    and wrong digit counts never match);
 *  - the program-aware spec resolution: `VAL-*` resolves against
 *    spec/validation-work-orders/, `PCR-*`/`PCS-*` against
 *    spec/competitiveness-work-orders/ — a tag whose spec file is absent
 *    fails closed with the TYPED error naming the tag and the searched
 *    path, never a silent skip;
 *  - the program discriminator rides the projection wherever work-order
 *    identity renders today (every experiment entry, the machine catalog);
 *  - THE ACCEPTANCE PROBE: the economic-recovery-plan-evaluation app
 *    carries its TRUE tag PCR-003 and projects under it; the per-program
 *    census is exact; the validation catalog and every VAL-tagged app
 *    project exactly as before (the extension is additive).
 */

import { describe, expect, test } from "vitest";
import {
  competitivenessWorkOrderOf,
  competitivenessWorkOrders,
  experimentOf,
  experimentsByStage,
  programOfWorkOrder,
  resolveWorkOrderSpec,
  specPathOfWorkOrder,
  unissuedValidationIds,
  validationCatalogJson,
  validationExperiments,
  WorkOrderSpecResolutionError,
  workOrderCensusByProgram,
  workOrderTagOfFirstLine,
} from "../../../apps/dashboard/validation-lab";

describe("the closed work-order tag family (every prefix × every positional variant)", () => {
  test("trailing (TAG) matches for VAL, PCR and PCS", () => {
    expect(workOrderTagOfFirstLine("# text-generation (VAL-010)")).toBe("VAL-010");
    expect(workOrderTagOfFirstLine("# economic-recovery-plan-evaluation (PCR-003)")).toBe(
      "PCR-003",
    );
    expect(workOrderTagOfFirstLine("# semantic-fidelity-evaluation (PCS-004)")).toBe("PCS-004");
  });

  test("leading (TAG) matches for VAL, PCR and PCS", () => {
    expect(workOrderTagOfFirstLine("# (VAL-010) the application portfolio")).toBe("VAL-010");
    expect(workOrderTagOfFirstLine("# (PCR-003) the three-arm replay evaluation")).toBe("PCR-003");
    expect(workOrderTagOfFirstLine("# (PCS-001) program enablement")).toBe("PCS-001");
  });

  test("bare TAG after the heading marker matches for VAL, PCR and PCS", () => {
    expect(workOrderTagOfFirstLine("# VAL-048 — cross-workload competitive benchmark")).toBe(
      "VAL-048",
    );
    expect(workOrderTagOfFirstLine("# PCR-002 — the wired seam")).toBe("PCR-002");
    expect(workOrderTagOfFirstLine("# PCS-002 — semantic-fidelity typed facts")).toBe("PCS-002");
  });

  test("a trailing bare tag (no parentheses) still matches the trailing variant", () => {
    expect(workOrderTagOfFirstLine("# an-app VAL-024")).toBe("VAL-024");
    expect(workOrderTagOfFirstLine("# an-app PCR-003")).toBe("PCR-003");
  });

  test("the family admits NOTHING else — unknown prefixes, lowercase, wrong digit counts", () => {
    expect(workOrderTagOfFirstLine("# an-app (PXR-001)")).toBeNull();
    expect(workOrderTagOfFirstLine("# an-app (VAL-1)")).toBeNull();
    expect(workOrderTagOfFirstLine("# an-app (VAL-0001)")).toBeNull();
    expect(workOrderTagOfFirstLine("# an-app (val-010)")).toBeNull();
    expect(workOrderTagOfFirstLine("# an-app (PCR-03)")).toBeNull();
    expect(workOrderTagOfFirstLine("# an-app (pcs-004)")).toBeNull();
    expect(workOrderTagOfFirstLine("# no tag on this line")).toBeNull();
    expect(workOrderTagOfFirstLine("")).toBeNull();
    // A MID-line tag (neither leading nor trailing) matches no variant.
    expect(workOrderTagOfFirstLine("# the (VAL-010) app")).toBeNull();
    expect(workOrderTagOfFirstLine("# reads (PCR-003) mid-line")).toBeNull();
    // A leading parenthesized tag followed by title text is the leading
    // variant (never end-anchored — the original behavior, preserved).
    expect(workOrderTagOfFirstLine("# (VAL-010) tag then title")).toBe("VAL-010");
  });
});

describe("the program-aware spec resolution (fail-closed, typed)", () => {
  test("VAL-* resolves against spec/validation-work-orders/", () => {
    expect(specPathOfWorkOrder("VAL-010")).toBe("spec/validation-work-orders/VAL-010.md");
    expect(resolveWorkOrderSpec("VAL-010")).toBe("spec/validation-work-orders/VAL-010.md");
  });

  test("PCR-* and PCS-* resolve against spec/competitiveness-work-orders/", () => {
    expect(specPathOfWorkOrder("PCR-003")).toBe("spec/competitiveness-work-orders/PCR-003.md");
    expect(resolveWorkOrderSpec("PCR-003")).toBe("spec/competitiveness-work-orders/PCR-003.md");
    expect(specPathOfWorkOrder("PCS-004")).toBe("spec/competitiveness-work-orders/PCS-004.md");
    expect(resolveWorkOrderSpec("PCS-004")).toBe("spec/competitiveness-work-orders/PCS-004.md");
  });

  test("a competitiveness tag whose spec file is absent fails closed with the typed error", () => {
    let caught: unknown = null;
    try {
      resolveWorkOrderSpec("PCR-005");
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(WorkOrderSpecResolutionError);
    const typed = caught as WorkOrderSpecResolutionError;
    expect(typed.name).toBe("WorkOrderSpecResolutionError");
    expect(typed.workOrder).toBe("PCR-005");
    expect(typed.searchedPath).toBe("spec/competitiveness-work-orders/PCR-005.md");
    expect(typed.message).toContain("PCR-005");
    expect(typed.message).toContain("spec/competitiveness-work-orders/PCR-005.md");
    expect(typed.message).toContain("never a silent skip");
  });

  test("an un-issued VAL tag (no spec file) fails closed the same typed way", () => {
    let caught: unknown = null;
    try {
      resolveWorkOrderSpec("VAL-027");
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(WorkOrderSpecResolutionError);
    const typed = caught as WorkOrderSpecResolutionError;
    expect(typed.workOrder).toBe("VAL-027");
    expect(typed.searchedPath).toBe("spec/validation-work-orders/VAL-027.md");
  });

  test("an id outside the closed family is rejected by the vocabulary itself", () => {
    expect(() => specPathOfWorkOrder("PXR-001")).toThrow(
      "outside the closed work-order tag vocabulary",
    );
    expect(() => specPathOfWorkOrder("VAL-0010")).toThrow(
      "outside the closed work-order tag vocabulary",
    );
  });
});

describe("the program discriminator rides the projection", () => {
  test("every validation experiment carries the validation program's own name", () => {
    for (const experiment of validationExperiments()) {
      expect(experiment.program, experiment.id).toBe("zeck-validation");
    }
  });

  test("the machine catalog carries the program on every experiment entry", () => {
    const catalog = JSON.parse(validationCatalogJson());
    expect(catalog.experiments.length).toBe(46);
    for (const entry of catalog.experiments) {
      expect(entry.program, entry.id).toBe("zeck-validation");
    }
    expect(
      catalog.experiments.find((entry: { id: string }) => entry.id === "VAL-010")?.specPath,
    ).toBe("spec/validation-work-orders/VAL-010.md");
  });

  test("programOfWorkOrder names each program from repository truth, fail-closed otherwise", () => {
    expect(programOfWorkOrder("VAL-010")).toBe("zeck-validation");
    expect(programOfWorkOrder("PCR-003")).toBe("zeck-competitiveness-p1");
    expect(programOfWorkOrder("PCR-001")).toBe("zeck-competitiveness-p1");
    expect(programOfWorkOrder("PCS-001")).toBe("zeck-competitiveness-p2");
    expect(programOfWorkOrder("PCS-004")).toBe("zeck-competitiveness-p2");
    expect(() => programOfWorkOrder("PCR-005")).toThrow(WorkOrderSpecResolutionError);
    expect(() => programOfWorkOrder("VAL-027")).toThrow(WorkOrderSpecResolutionError);
  });

  test("the competitiveness work orders project from their spec directory, verbatim", () => {
    const orders = competitivenessWorkOrders();
    expect(orders.map((order) => order.id)).toEqual([
      "PCR-001",
      "PCR-002",
      "PCR-003",
      "PCR-004",
      "PCS-001",
      "PCS-002",
      "PCS-003",
      "PCS-004",
    ]);
    for (const order of orders) {
      expect(order.program, order.id).toMatch(/^zeck-competitiveness-p[12]$/);
      expect(order.specPath, order.id).toBe(`spec/competitiveness-work-orders/${order.id}.md`);
      expect(order.status.length, order.id).toBeGreaterThan(0);
      expect(order.title.length, order.id).toBeGreaterThan(0);
      expect(order.objective.length, order.id).toBeGreaterThan(0);
    }
    const p1 = orders.filter((order) => order.program === "zeck-competitiveness-p1");
    const p2 = orders.filter((order) => order.program === "zeck-competitiveness-p2");
    expect(p1.map((order) => order.id)).toEqual(["PCR-001", "PCR-002", "PCR-003", "PCR-004"]);
    expect(p2.map((order) => order.id)).toEqual(["PCS-001", "PCS-002", "PCS-003", "PCS-004"]);
    expect(competitivenessWorkOrderOf("PCR-999")).toBeNull();
  });
});

describe("THE ACCEPTANCE PROBE — the evaluation app projects under its TRUE work order", () => {
  test("economic-recovery-plan-evaluation carries PCR-003 and projects under it", () => {
    const pcr3 = competitivenessWorkOrderOf("PCR-003");
    expect(pcr3).not.toBeNull();
    expect(pcr3?.program).toBe("zeck-competitiveness-p1");
    expect(pcr3?.apps.map((app) => app.dir)).toEqual(["economic-recovery-plan-evaluation"]);
    const app = pcr3?.apps[0];
    expect(app?.workOrder).toBe("PCR-003");
    expect(app?.readmeTitle).toBe("economic-recovery-plan-evaluation");
    expect(app?.suitePath).toBe("tests/unit/validation/pcr-003-recovery-plan-evaluation.test.ts");
    // The work order is no longer borrowed: the app is NOT under VAL-048.
    expect(experimentOf("VAL-048")?.apps.map((a) => a.dir)).toEqual([
      "economic-competitive-benchmark",
    ]);
  });

  test("the per-program census is exact (work orders and apps)", () => {
    const census = workOrderCensusByProgram();
    expect(census.map((section) => section.program)).toEqual([
      "zeck-validation",
      "zeck-competitiveness-p1",
      "zeck-competitiveness-p2",
      "zeck-competitiveness-p3",
    ]);
    const [validation, p1, p2, p3] = census as [
      { program: string; workOrders: string[]; apps: string[] },
      { program: string; workOrders: string[]; apps: string[] },
      { program: string; workOrders: string[]; apps: string[] },
      { program: string; workOrders: string[]; apps: string[] },
    ];
    expect(validation.workOrders.length).toBe(46);
    expect(validation.workOrders[0]).toBe("VAL-001");
    expect(validation.workOrders.at(-1)).toBe("VAL-052");
    expect(validation.apps.length).toBe(51);
    expect(validation.apps).not.toContain("economic-recovery-plan-evaluation");
    expect(p1.workOrders).toEqual(["PCR-001", "PCR-002", "PCR-003", "PCR-004"]);
    expect(p1.apps).toEqual(["economic-recovery-plan-evaluation"]);
    expect(p2.workOrders).toEqual(["PCS-001", "PCS-002", "PCS-003", "PCS-004"]);
    // PCS-004's evaluation app registered under its TRUE tag: the P2
    // program's app census advances from none to the
    // semantic-fidelity-evaluation app.
    expect(p2.apps).toEqual(["semantic-fidelity-evaluation"]);
    // The P3 program (ACR-010/DEL-2026-10-13-P3, registered 2026-10-13):
    // work orders PCL-001..003, no apps yet (the PCL-003 evaluation app
    // will register under its TRUE tag when delivered).
    expect(p3.workOrders).toEqual(["PCL-001", "PCL-002", "PCL-003"]);
    expect(p3.apps).toEqual([]);
    // Every app projects under exactly one program: 51 + 1 + 1 = the 53 app dirs.
    const total = validation.apps.length + p1.apps.length + p2.apps.length;
    expect(total).toBe(53);
  });

  test("the validation catalog is byte-identical in behavior (the extension is additive)", () => {
    // The governed validation census: still 46 experiments, same ids,
    // same stages, same un-issued gaps — the competitiveness programs
    // project through their own surface, never by widening this catalog.
    const experiments = validationExperiments();
    expect(experiments.length).toBe(46);
    expect(experiments.map((experiment) => experiment.id).at(-1)).toBe("VAL-052");
    expect(experimentsByStage().reduce((sum, section) => sum + section.experiments.length, 0)).toBe(
      46,
    );
    expect(unissuedValidationIds()).toEqual([
      "VAL-027",
      "VAL-028",
      "VAL-029",
      "VAL-037",
      "VAL-038",
      "VAL-039",
    ]);
    // Every VAL-tagged app still projects under its own work order.
    expect(experimentOf("VAL-010")?.apps.map((app) => app.dir)).toEqual([
      "structured-extraction",
      "text-generation",
      "transformation",
    ]);
    expect(experimentOf("VAL-048")?.apps.map((app) => app.dir)).toEqual([
      "economic-competitive-benchmark",
    ]);
    // The competitiveness ids are NOT validation experiments.
    expect(experimentOf("PCR-003")).toBeNull();
    expect(experimentOf("PCS-004")).toBeNull();
  });
});
