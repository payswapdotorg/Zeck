/**
 * VAL-007 acceptance criteria 1-5: experiments register with stable
 * identities, declared hypotheses and cohort membership; runs attach
 * immutably; cohort datasets export; history integrity is checked
 * mechanically. Discrimination: tampering, double-attach, cohort
 * contamination and re-registration are all rejected.
 */

import { describe, expect, test } from "vitest";
import { ExperimentLedger, registerExperiment } from "../../../benchmarks/validation/ledger";

const REVISION = "1111111111111111111111111111111111111111";

function makeExperiment() {
  return registerExperiment({
    kind: "repeated-replay",
    hypothesis: "repeated exposure to successful trajectories reduces per-run cost",
    cohort: {
      corpusSlice: "text.summarize-doc.v1",
      applicationRevisions: [REVISION],
      repetitions: 10,
      arm: "candidate",
    },
    registeredAt: "2026-09-11T22:40:00.000Z",
  });
}

describe("validation: experiment registration (VAL-007 AC1)", () => {
  test("an experiment registers with a stable content-digested identity", () => {
    const entry = makeExperiment();
    expect(entry.experimentId).toMatch(/^exp-repeated-replay-[0-9a-f]{8}$/);
    expect(entry.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(Object.isFrozen(entry)).toBe(true);
    const same = makeExperiment();
    expect(same.experimentId).toBe(entry.experimentId);
    expect(same.digest).toBe(entry.digest);
  });

  test("registration validates the hypothesis and cohort (discrimination)", () => {
    expect(() =>
      registerExperiment({
        kind: "repeated-replay",
        hypothesis: "",
        cohort: { corpusSlice: "x", applicationRevisions: [REVISION], repetitions: 1, arm: "a" },
        registeredAt: "t",
      }),
    ).toThrow(/hypothesis/);
    expect(() =>
      registerExperiment({
        kind: "repeated-replay",
        hypothesis: "h",
        cohort: { corpusSlice: "x", applicationRevisions: [], repetitions: 1, arm: "a" },
        registeredAt: "t",
      }),
    ).toThrow(/revision/);
    expect(() =>
      registerExperiment({
        kind: "repeated-replay",
        hypothesis: "h",
        cohort: { corpusSlice: "x", applicationRevisions: [REVISION], repetitions: 0, arm: "a" },
        registeredAt: "t",
      }),
    ).toThrow(/repetition/);
  });

  test("unknown experiment kinds are rejected (discrimination)", () => {
    expect(() =>
      registerExperiment({
        kind: "time-travel" as "repeated-replay",
        hypothesis: "h",
        cohort: { corpusSlice: "x", applicationRevisions: [REVISION], repetitions: 1, arm: "a" },
        registeredAt: "t",
      }),
    ).toThrow(/unknown experiment kind/);
  });
});

describe("validation: append-only attachments (VAL-007 AC2)", () => {
  test("runs attach immutably to their experiment", () => {
    const ledger = new ExperimentLedger();
    const entry = makeExperiment();
    ledger.register(entry);
    ledger.attach({
      experimentId: entry.experimentId,
      runId: "val-run-" + "a".repeat(64),
      runRevision: 1,
      attachedAt: "2026-09-11T22:41:00.000Z",
    });
    expect(ledger.attachmentsOf(entry.experimentId)).toHaveLength(1);
    expect(ledger.integrity()).toEqual([]);
  });

  test("double-attaching the same run is rejected (discrimination)", () => {
    const ledger = new ExperimentLedger();
    const entry = makeExperiment();
    ledger.register(entry);
    const attachment = {
      experimentId: entry.experimentId,
      runId: "val-run-" + "b".repeat(64),
      runRevision: 1,
      attachedAt: "2026-09-11T22:41:00.000Z",
    };
    ledger.attach(attachment);
    expect(() => ledger.attach({ ...attachment })).toThrow(/already attached/);
  });

  test("a run cannot join two experiments (cohort contamination, discrimination)", () => {
    const ledger = new ExperimentLedger();
    const first = makeExperiment();
    const second = registerExperiment({
      kind: "learning-trial",
      hypothesis: "learning reduces cost",
      cohort: {
        corpusSlice: "text.summarize-doc.v1",
        applicationRevisions: [REVISION],
        repetitions: 5,
        arm: "candidate",
      },
      registeredAt: "2026-09-11T22:42:00.000Z",
    });
    ledger.register(first);
    ledger.register(second);
    const runId = "val-run-" + "c".repeat(64);
    ledger.attach({ experimentId: first.experimentId, runId, runRevision: 1, attachedAt: "t" });
    expect(() =>
      ledger.attach({ experimentId: second.experimentId, runId, runRevision: 1, attachedAt: "t" }),
    ).toThrow(/cohort contamination/);
  });

  test("attaching to an unknown experiment is rejected (discrimination)", () => {
    const ledger = new ExperimentLedger();
    expect(() =>
      ledger.attach({
        experimentId: "exp-unknown-00000000",
        runId: "val-run-" + "d".repeat(64),
        runRevision: 1,
        attachedAt: "t",
      }),
    ).toThrow(/unknown experiment/);
  });
});

describe("validation: history integrity and export (VAL-007 AC4/AC5)", () => {
  test("re-registration with different content is rejected (append-only, discrimination)", () => {
    const ledger = new ExperimentLedger();
    const entry = makeExperiment();
    ledger.register(entry);
    const mutated = { ...entry, hypothesis: "a different hypothesis" };
    expect(() => ledger.register(mutated)).toThrow(/tamper detected/);
  });

  test("tampered content cannot masquerade as a registered experiment (discrimination)", () => {
    const ledger = new ExperimentLedger();
    const entry = makeExperiment();
    ledger.register(entry);
    // re-registration with mutated content under the same identity is rejected
    expect(() => ledger.register({ ...entry, hypothesis: "a different hypothesis" })).toThrow(
      /tamper detected/,
    );
    // the identity is content-derived: tampered content yields a different
    // id + digest, so it can never alias the original entry
    const tampered = registerExperiment({
      kind: entry.kind,
      hypothesis: "a different hypothesis",
      cohort: entry.cohort,
      registeredAt: entry.registeredAt,
    });
    expect(tampered.experimentId).not.toBe(entry.experimentId);
    expect(tampered.digest).not.toBe(entry.digest);
    // and the ledger stays clean
    expect(ledger.integrity()).toEqual([]);
  });

  test("a cohort exports its frozen definition with attachments (AC4)", () => {
    const ledger = new ExperimentLedger();
    const entry = makeExperiment();
    ledger.register(entry);
    ledger.attach({
      experimentId: entry.experimentId,
      runId: "val-run-" + "e".repeat(64),
      runRevision: 1,
      attachedAt: "t",
    });
    const cohort = ledger.exportCohort(entry.experimentId);
    expect(cohort).not.toBeNull();
    expect(cohort?.experiment.cohort.repetitions).toBe(10);
    expect(cohort?.attachments).toHaveLength(1);
    expect(ledger.exportCohort("exp-unknown-00000000")).toBeNull();
  });

  test("identical re-registration is idempotent (no duplicate entries)", () => {
    const ledger = new ExperimentLedger();
    const entry = makeExperiment();
    ledger.register(entry);
    ledger.register(entry);
    expect(ledger.experimentsList()).toHaveLength(1);
  });
});
