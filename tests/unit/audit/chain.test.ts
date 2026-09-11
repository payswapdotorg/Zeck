/**
 * Hash-chain verification unit tests (WORK-059).
 *
 * Proves the pure domain verifier: valid chains pass; tampered
 * records, forged links, uncovered gaps, tampered/overlapping purge
 * manifests fail — deterministic verdicts.
 */

import { describe, expect, test } from "vitest";
import { createAuditNodeDigest } from "../../../src/modules/audit/adapters/node-digest";
import {
  type AuditRecord,
  type AuditSubmission,
  chainLinkSubmission,
  type PurgeManifest,
  purgeManifestCommitment,
  verifyAuditChain,
} from "../../../src/modules/audit/public";

const digest = createAuditNodeDigest();

const APPLICATION_ID = "00000000-0000-7000-8000-0000000000aa";
const TENANT_ID = "00000000-0000-7000-8000-0000000000bb";

function submission(key: string): AuditSubmission {
  return {
    applicationId: APPLICATION_ID,
    tenantId: TENANT_ID,
    environment: "production",
    actor: { actorId: "actor-1", actorKind: "service-principal" },
    action: { kind: "execution.transitioned", command: "authorize", operationKey: key },
    target: { kind: "execution", id: "00000000-0000-7000-8000-0000000000cc" },
    provenance: {
      seam: "executions.transition",
      sourceRecordId: "00000000-0000-7000-8000-0000000000cc",
    },
    rationale: { why: `transition ${key}` },
    occurredAt: "2026-09-20T12:00:00.000Z",
    actionDetail: { from: "CREATED", to: "AUTHORIZED", sequence: 1 },
  };
}

function chainOf(count: number) {
  const records = [];
  let previous = "0".repeat(64);
  for (let index = 1; index <= count; index += 1) {
    const record = chainLinkSubmission(
      submission(`op-${index}`),
      {
        chainSequence: index,
        previousRecordDigest: previous,
        recordedAt: "2026-09-20T12:00:01.000Z",
      },
      digest,
    );
    previous = record.recordDigest;
    records.push(record);
  }
  return records;
}

function manifestFor(
  records: readonly ReturnType<typeof chainLinkSubmission>[],
  entries: { sequence: number; recordDigest: string }[],
): PurgeManifest {
  return {
    policyVersion: 1,
    cutoff: "2026-01-01T00:00:00.000Z",
    entries,
    commitment: purgeManifestCommitment(
      { policyVersion: 1, cutoff: "2026-01-01T00:00:00.000Z", entries },
      digest,
    ),
  };
}

describe("chain verification (WORK-059)", () => {
  test("a valid gapless chain verifies", () => {
    const verification = verifyAuditChain(chainOf(5), { digest });
    expect(verification.ok).toBe(true);
    expect(verification.violations).toEqual([]);
    expect(verification.lastSequence).toBe(5);
    expect(verification.lastDigest).toBe(chainOf(5)[4]?.recordDigest);
  });

  test("the empty chain verifies vacuously", () => {
    const verification = verifyAuditChain([], { digest });
    expect(verification.ok).toBe(true);
    expect(verification.lastSequence).toBe(0);
  });

  test("a tampered record is detected (content no longer digests)", () => {
    const records = chainOf(5);
    const tampered = [...records];
    (tampered[2] as { rationale: { why: string } }).rationale.why = "rewritten";
    const verification = verifyAuditChain(tampered, { digest });
    expect(verification.ok).toBe(false);
    expect(verification.violations.some((violation) => violation.code === "record-invalid")).toBe(
      true,
    );
  });

  test("a broken link is detected (re-signed record with forged predecessor)", () => {
    const records = chainOf(5);
    // Re-sign the forged record (a raw forgery would fail its own
    // digest first — the LINK check needs a digest-valid record whose
    // linkage points at the wrong predecessor).
    const forged = chainLinkSubmission(
      submission("op-4"),
      {
        chainSequence: 4,
        previousRecordDigest: "f".repeat(64),
        recordedAt: "2026-09-20T12:00:01.000Z",
      },
      digest,
    );
    const chain = [records[0], records[1], records[2], forged, records[4]].filter(
      (record): record is AuditRecord => record !== undefined,
    );
    const verification = verifyAuditChain(chain, { digest });
    expect(verification.ok).toBe(false);
    expect(
      verification.violations.some((violation) => violation.code === "chain-link-broken"),
    ).toBe(true);
  });

  test("the first record must chain from genesis", () => {
    const records = chainOf(3);
    const forged = chainLinkSubmission(
      submission("op-1"),
      {
        chainSequence: 1,
        previousRecordDigest: "a".repeat(64),
        recordedAt: "2026-09-20T12:00:01.000Z",
      },
      digest,
    );
    const chain = [forged, records[1], records[2]].filter(
      (record): record is AuditRecord => record !== undefined,
    );
    const verification = verifyAuditChain(chain, { digest });
    expect(
      verification.violations.some((violation) => violation.code === "chain-link-broken"),
    ).toBe(true);
  });

  test("an uncovered gap is detected (missing record, no manifest)", () => {
    const records = chainOf(5);
    const gapped = [records[0], records[2], records[3], records[4]].filter(
      (record): record is AuditRecord => record !== undefined,
    );
    const verification = verifyAuditChain(gapped, { digest });
    expect(verification.ok).toBe(false);
    expect(
      verification.violations.some((violation) => violation.code === "chain-gap-uncovered"),
    ).toBe(true);
  });

  test("a manifest-covered gap verifies when the link matches the highest purged digest", () => {
    const records = chainOf(5);
    const purged = records[1]!;
    const survivor = records[2]!;
    // The survivor's link points at the purged record's digest (the
    // real chain), so the manifest must carry that digest.
    const manifest = manifestFor(records, [
      { sequence: purged.chainSequence, recordDigest: purged.recordDigest },
    ]);
    const evidence = chainLinkSubmission(
      {
        ...submission("purge-op"),
        action: {
          kind: "retention.purge-executed",
          command: "retention-purge",
          operationKey: `purge:v1:2026-01-01T00:00:00.000Z:${manifest.commitment}`,
        },
        target: { kind: "application", id: APPLICATION_ID },
        provenance: { seam: "retention.purge", sourceRecordId: null },
        rationale: { why: "governed retention purge" },
        actionDetail: {
          policyVersion: 1,
          cutoff: "2026-01-01T00:00:00.000Z",
          purgedCount: 1,
          purge: manifest,
        },
      },
      {
        chainSequence: 6,
        previousRecordDigest: records[4]!.recordDigest,
        recordedAt: "2026-09-20T12:00:01.000Z",
      },
      digest,
    );
    const chain = [records[0], survivor, records[3], records[4], evidence].filter(
      (record): record is AuditRecord => record !== undefined,
    );
    const verification = verifyAuditChain(chain, { digest });
    expect(verification.ok).toBe(true);
    expect(verification.lastSequence).toBe(6);
  });

  test("a manifest gap whose link digest does NOT match fails closed", () => {
    const records = chainOf(5);
    const survivor = records[2]!;
    const manifest = manifestFor(records, [{ sequence: 2, recordDigest: "b".repeat(64) }]);
    const evidence = chainLinkSubmission(
      {
        ...submission("purge-op"),
        action: {
          kind: "retention.purge-executed",
          command: "retention-purge",
          operationKey: `purge:v1:2026-01-01T00:00:00.000Z:${manifest.commitment}`,
        },
        target: { kind: "application", id: APPLICATION_ID },
        provenance: { seam: "retention.purge", sourceRecordId: null },
        rationale: { why: "governed retention purge" },
        actionDetail: {
          policyVersion: 1,
          cutoff: "2026-01-01T00:00:00.000Z",
          purgedCount: 1,
          purge: manifest,
        },
      },
      {
        chainSequence: 6,
        previousRecordDigest: records[4]!.recordDigest,
        recordedAt: "2026-09-20T12:00:01.000Z",
      },
      digest,
    );
    const verification = verifyAuditChain(
      [records[0], survivor, records[3], records[4], evidence].filter(
        (record): record is AuditRecord => record !== undefined,
      ),
      { digest },
    );
    expect(verification.ok).toBe(false);
    expect(
      verification.violations.some((violation) => violation.code === "chain-link-broken"),
    ).toBe(true);
  });

  test("a tampered manifest (commitment does not cover entries) is rejected", () => {
    const records = chainOf(5);
    const purged = records[1]!;
    const manifest = {
      policyVersion: 1,
      cutoff: "2026-01-01T00:00:00.000Z",
      entries: [{ sequence: purged.chainSequence, recordDigest: purged.recordDigest }],
      commitment: "f".repeat(64),
    };
    const evidence = chainLinkSubmission(
      {
        ...submission("purge-op"),
        action: {
          kind: "retention.purge-executed",
          command: "retention-purge",
          operationKey: `purge:v1:x:${manifest.commitment}`,
        },
        target: { kind: "application", id: APPLICATION_ID },
        provenance: { seam: "retention.purge", sourceRecordId: null },
        rationale: { why: "governed retention purge" },
        actionDetail: {
          policyVersion: 1,
          cutoff: "2026-01-01T00:00:00.000Z",
          purgedCount: 1,
          purge: manifest,
        },
      },
      {
        chainSequence: 6,
        previousRecordDigest: records[4]!.recordDigest,
        recordedAt: "2026-09-20T12:00:01.000Z",
      },
      digest,
    );
    const verification = verifyAuditChain(
      [records[0], records[2], records[3], records[4], evidence].filter(
        (record): record is AuditRecord => record !== undefined,
      ),
      {
        digest,
      },
    );
    expect(verification.violations.some((violation) => violation.code === "manifest-invalid")).toBe(
      true,
    );
  });

  test("overlapping manifests (double purge) are detected", () => {
    const records = chainOf(6);
    const purged = records[1]!;
    const entry = { sequence: purged.chainSequence, recordDigest: purged.recordDigest };
    const manifestA = manifestFor(records, [entry]);
    const manifestB = manifestFor(records, [entry]);
    const evidenceA = chainLinkSubmission(
      {
        ...submission("purge-op-a"),
        action: {
          kind: "retention.purge-executed",
          command: "retention-purge",
          operationKey: `purge:v1:a:${manifestA.commitment}`,
        },
        target: { kind: "application", id: APPLICATION_ID },
        provenance: { seam: "retention.purge", sourceRecordId: null },
        rationale: { why: "governed retention purge" },
        actionDetail: {
          policyVersion: 1,
          cutoff: "2026-01-01T00:00:00.000Z",
          purgedCount: 1,
          purge: manifestA,
        },
      },
      {
        chainSequence: 7,
        previousRecordDigest: records[5]!.recordDigest,
        recordedAt: "2026-09-20T12:00:01.000Z",
      },
      digest,
    );
    const evidenceB = chainLinkSubmission(
      {
        ...submission("purge-op-b"),
        action: {
          kind: "retention.purge-executed",
          command: "retention-purge",
          operationKey: `purge:v1:b:${manifestB.commitment}`,
        },
        target: { kind: "application", id: APPLICATION_ID },
        provenance: { seam: "retention.purge", sourceRecordId: null },
        rationale: { why: "governed retention purge" },
        actionDetail: {
          policyVersion: 1,
          cutoff: "2026-01-01T00:00:00.000Z",
          purgedCount: 1,
          purge: manifestB,
        },
      },
      {
        chainSequence: 8,
        previousRecordDigest: evidenceA.recordDigest,
        recordedAt: "2026-09-20T12:00:02.000Z",
      },
      digest,
    );
    const verification = verifyAuditChain(
      [records[0], records[2], records[3], records[4], records[5], evidenceA, evidenceB].filter(
        (record): record is AuditRecord => record !== undefined,
      ),
      { digest },
    );
    expect(verification.violations.some((violation) => violation.code === "manifest-overlap")).toBe(
      true,
    );
  });

  test("verification is deterministic (repeated runs, same verdict)", () => {
    const records = chainOf(4);
    const first = verifyAuditChain(records, { digest });
    const second = verifyAuditChain([...records], { digest });
    expect(second).toEqual(first);
  });
});
