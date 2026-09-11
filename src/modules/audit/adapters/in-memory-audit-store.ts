/**
 * In-memory audit store (audit module adapter; WORK-059).
 *
 * The provider-neutral test double implementing the SAME governed
 * semantics as the SQL store (identity idempotency, serialized chain
 * extension, governed purge semantics, audited holds/policies). Unit
 * tests and discrimination proofs run against this double; the
 * DURABLE semantics (DB-level immutability triggers, transactional
 * crash-safety, advisory serialization) are proven over real
 * PostgreSQL by the integration suites — the double never substitutes
 * for those proofs (no simulated PASS claims).
 */

import { createUuidv7Generator } from "../../../shared/ids";
import type {
  AdoptPolicyInput,
  AuditDigestPort,
  AuditRecord,
  AuditSubmission,
  LegalHoldRecord,
  PlaceHoldInput,
  PurgeManifest,
  RetentionPolicyRecord,
} from "../domain";
import {
  chainLinkSubmission,
  computeAuditRecordId,
  purgeManifestCommitment,
  validateAdoptPolicyInput,
  validateAuditSubmission,
  validatePlaceHoldInput,
} from "../domain";
import type {
  AuditAppendOutcome,
  AuditChainHead,
  AuditListOptions,
  AuditRecordStore,
  AuditStoreError,
  GovernedPurgeInput,
  GovernedPurgeOutcome,
  LegalHoldStore,
  RetentionPolicyStore,
} from "../ports/audit-store";
import { AuditStoreError as AuditStoreErrorClass } from "../ports/audit-store";

const generateId = createUuidv7Generator();

function fail(code: AuditStoreError["code"], message: string): never {
  throw new AuditStoreErrorClass(code, message);
}

interface MemoryState {
  readonly records: Map<string, AuditRecord>; // recordId -> record (per application via record)
  readonly byApplication: Map<string, AuditRecord[]>;
  readonly heads: Map<string, { tenantId: string; sequence: number; digest: string }>;
  readonly holds: Map<string, LegalHoldRecord>;
  readonly policies: Map<string, RetentionPolicyRecord>;
}

/**
 * The in-memory double. A single mutex-promise serializes appends per
 * instance (the in-memory analogue of the chain-head row lock).
 */
export class InMemoryAuditStore implements AuditRecordStore, LegalHoldStore, RetentionPolicyStore {
  private readonly state: MemoryState = {
    records: new Map(),
    byApplication: new Map(),
    heads: new Map(),
    holds: new Map(),
    policies: new Map(),
  };
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly digest: AuditDigestPort,
    private readonly now: () => Date = () => new Date(),
  ) {}

  private serialized<T>(work: () => Promise<T>): Promise<T> {
    const run = this.queue.then(work, work);
    this.queue = run.catch(() => undefined);
    return run;
  }

  async appendRecord(submission: AuditSubmission): Promise<AuditAppendOutcome> {
    validateAuditSubmission(submission);
    return this.serialized(async () => {
      const head = this.state.heads.get(submission.applicationId);
      const tenantId = head?.tenantId ?? submission.tenantId;
      const recordId = computeAuditRecordId(submission, this.digest);
      const existing = this.state.records.get(recordId);
      if (existing !== undefined && existing.applicationId === submission.applicationId) {
        return { recordId, chainSequence: existing.chainSequence, replayed: true };
      }
      const sequence = (head?.sequence ?? 0) + 1;
      const record = chainLinkSubmission(
        submission,
        {
          chainSequence: sequence,
          previousRecordDigest: head?.digest ?? "0".repeat(64),
          recordedAt: this.now().toISOString(),
        },
        this.digest,
      );
      this.state.records.set(recordId, record);
      const list = this.state.byApplication.get(submission.applicationId) ?? [];
      list.push(record);
      this.state.byApplication.set(submission.applicationId, list);
      this.state.heads.set(submission.applicationId, {
        tenantId,
        sequence,
        digest: record.recordDigest,
      });
      return { recordId, chainSequence: sequence, replayed: false };
    });
  }

  async getRecord(applicationId: string, recordId: string): Promise<AuditRecord | null> {
    const record = this.state.records.get(recordId);
    return record !== undefined && record.applicationId === applicationId ? record : null;
  }

  async listRecords(
    applicationId: string,
    options: AuditListOptions = {},
  ): Promise<readonly AuditRecord[]> {
    const from = options.fromSequence ?? 1;
    const to = options.toSequence ?? Number.MAX_SAFE_INTEGER;
    const limit = options.limit ?? 500;
    return (this.state.byApplication.get(applicationId) ?? [])
      .filter((record) => record.chainSequence >= from && record.chainSequence <= to)
      .slice(0, limit);
  }

  async chainHead(applicationId: string): Promise<AuditChainHead | null> {
    const head = this.state.heads.get(applicationId);
    return head === undefined
      ? null
      : { applicationId, lastSequence: head.sequence, lastDigest: head.digest };
  }

  async purgeExpiredRecords(input: GovernedPurgeInput): Promise<GovernedPurgeOutcome> {
    return this.serialized(async () => {
      const head = this.state.heads.get(input.applicationId);
      if (head === undefined) {
        return { purged: false, purgedCount: 0, evidence: null };
      }
      const cutoffMs = new Date(input.cutoff).getTime();
      const activeHolds = [...this.state.holds.values()].filter(
        (hold) =>
          hold.applicationId === input.applicationId &&
          hold.releasedAt === null &&
          hold.holdScope === "application",
      );
      const heldTargets = new Set(
        [...this.state.holds.values()]
          .filter(
            (hold) =>
              hold.applicationId === input.applicationId &&
              hold.releasedAt === null &&
              hold.holdScope === "target",
          )
          .map((hold) => `${hold.targetKind}:${hold.targetId}`),
      );
      const records = this.state.byApplication.get(input.applicationId) ?? [];
      const expired = records.filter(
        (record) =>
          record.action.kind !== "retention.purge-executed" &&
          new Date(record.recordedAt).getTime() < cutoffMs &&
          activeHolds.length === 0 &&
          !heldTargets.has(`${record.target.kind}:${record.target.id}`),
      );
      if (expired.length === 0) {
        return { purged: false, purgedCount: 0, evidence: null };
      }
      const entries = expired
        .map((record) => ({ sequence: record.chainSequence, recordDigest: record.recordDigest }))
        .sort((left, right) => left.sequence - right.sequence);
      const manifest: PurgeManifest = {
        policyVersion: input.policyVersion,
        cutoff: input.cutoff,
        entries,
        commitment: purgeManifestCommitment(
          { policyVersion: input.policyVersion, cutoff: input.cutoff, entries },
          this.digest,
        ),
      };
      for (const record of expired) {
        this.state.records.delete(record.recordId);
      }
      this.state.byApplication.set(
        input.applicationId,
        records.filter((record) => !expired.includes(record)),
      );
      const submission: AuditSubmission = {
        applicationId: input.applicationId,
        tenantId: head.tenantId,
        environment: input.environment,
        actor: { actorId: input.procedureActorId, actorKind: "system-procedure" },
        action: {
          kind: "retention.purge-executed",
          command: "retention-purge",
          operationKey: `purge:v${input.policyVersion}:${input.cutoff}:${manifest.commitment}`,
        },
        target: { kind: "application", id: input.applicationId },
        provenance: { seam: "retention.purge", sourceRecordId: null },
        rationale: { why: input.reason },
        occurredAt: input.asOf,
        actionDetail: {
          policyVersion: input.policyVersion,
          cutoff: input.cutoff,
          purgedCount: entries.length,
          purge: manifest,
        },
      };
      const evidence = chainLinkSubmission(
        submission,
        {
          chainSequence: head.sequence + 1,
          previousRecordDigest: head.digest,
          recordedAt: this.now().toISOString(),
        },
        this.digest,
      );
      this.state.records.set(evidence.recordId, evidence);
      this.state.byApplication.get(input.applicationId)?.push(evidence);
      this.state.heads.set(input.applicationId, {
        tenantId: head.tenantId,
        sequence: head.sequence + 1,
        digest: evidence.recordDigest,
      });
      return { purged: true, purgedCount: entries.length, evidence };
    });
  }

  async listPurgeManifests(
    applicationId: string,
    window: { readonly fromSequence: number; readonly toSequence: number },
  ): Promise<readonly PurgeManifest[]> {
    const manifests: PurgeManifest[] = [];
    for (const record of this.state.byApplication.get(applicationId) ?? []) {
      if (record.action.kind !== "retention.purge-executed") {
        continue;
      }
      const manifest = (record.actionDetail as Record<string, unknown>).purge as PurgeManifest;
      if (
        manifest.entries.some(
          (entry) => entry.sequence >= window.fromSequence && entry.sequence <= window.toSequence,
        )
      ) {
        manifests.push(manifest);
      }
    }
    return manifests;
  }

  async placeHold(input: PlaceHoldInput): Promise<LegalHoldRecord> {
    const validated = validatePlaceHoldInput(input);
    for (const hold of this.state.holds.values()) {
      if (
        hold.applicationId === validated.applicationId &&
        hold.releasedAt === null &&
        hold.holdScope === validated.holdScope &&
        hold.targetKind === (validated.targetKind ?? null) &&
        hold.targetId === (validated.targetId ?? null)
      ) {
        if (hold.reason === validated.reason) {
          return hold;
        }
        fail(
          "AUDIT_HOLD_IDENTITY_CONFLICT",
          "an active hold already covers this scope with a different rationale",
        );
      }
    }
    const holdId = generateId();
    const placedAt = validated.placedAt ?? this.now().toISOString();
    const hold: LegalHoldRecord = {
      holdId,
      applicationId: validated.applicationId,
      tenantId: validated.tenantId,
      holdScope: validated.holdScope,
      targetKind: validated.targetKind ?? null,
      targetId: validated.targetId ?? null,
      reason: validated.reason,
      placedBy: validated.placedBy,
      placedAt,
      releasedAt: null,
      releasedBy: null,
    };
    this.state.holds.set(holdId, hold);
    await this.appendRecord({
      applicationId: validated.applicationId,
      tenantId: validated.tenantId,
      environment: "control-plane",
      actor: { actorId: validated.placedBy, actorKind: "service-principal" },
      action: {
        kind: "audit.legal-hold-placed",
        command: "legal-hold-place",
        operationKey: `hold:${holdId}`,
      },
      target:
        validated.holdScope === "target" &&
        validated.targetKind !== undefined &&
        validated.targetId !== undefined
          ? { kind: validated.targetKind, id: validated.targetId }
          : { kind: "application", id: validated.applicationId },
      provenance: { seam: "audit.legal-hold", sourceRecordId: holdId },
      rationale: { why: validated.reason },
      occurredAt: placedAt,
      actionDetail: { holdId, holdScope: validated.holdScope },
    });
    return hold;
  }

  async releaseHold(
    applicationId: string,
    holdId: string,
    releasedBy: string,
    releasedAt?: string,
  ): Promise<LegalHoldRecord> {
    const hold = this.state.holds.get(holdId);
    if (hold === undefined || hold.applicationId !== applicationId) {
      fail("AUDIT_HOLD_UNKNOWN", `legal hold ${holdId} was not found for this application`);
    }
    if (hold.releasedAt !== null) {
      fail("AUDIT_HOLD_ALREADY_RELEASED", `legal hold ${holdId} is already released`);
    }
    const releasedAtValue = releasedAt ?? this.now().toISOString();
    const released: LegalHoldRecord = { ...hold, releasedAt: releasedAtValue, releasedBy };
    this.state.holds.set(holdId, released);
    await this.appendRecord({
      applicationId,
      tenantId: hold.tenantId,
      environment: "control-plane",
      actor: { actorId: releasedBy, actorKind: "service-principal" },
      action: {
        kind: "audit.legal-hold-released",
        command: "legal-hold-release",
        operationKey: `hold-release:${holdId}:${releasedAtValue}`,
      },
      target: { kind: "application", id: applicationId },
      provenance: { seam: "audit.legal-hold", sourceRecordId: holdId },
      rationale: { why: "legal hold released" },
      occurredAt: releasedAtValue,
      actionDetail: { holdId },
    });
    return released;
  }

  async getHold(applicationId: string, holdId: string): Promise<LegalHoldRecord | null> {
    const hold = this.state.holds.get(holdId);
    return hold !== undefined && hold.applicationId === applicationId ? hold : null;
  }

  async listActiveHolds(applicationId: string): Promise<readonly LegalHoldRecord[]> {
    return [...this.state.holds.values()]
      .filter((hold) => hold.applicationId === applicationId && hold.releasedAt === null)
      .sort((left, right) => left.placedAt.localeCompare(right.placedAt));
  }

  async adoptPolicy(input: AdoptPolicyInput): Promise<RetentionPolicyRecord> {
    const validated = validateAdoptPolicyInput(input);
    for (const policy of this.state.policies.values()) {
      if (
        policy.applicationId === validated.applicationId &&
        policy.version === validated.version
      ) {
        if (
          policy.retentionDays === validated.retentionDays &&
          policy.reason === validated.reason
        ) {
          return policy;
        }
        fail(
          "AUDIT_POLICY_IDENTITY_CONFLICT",
          `policy version ${validated.version} already holds different content`,
        );
      }
    }
    const policyId = generateId();
    const adoptedAt = validated.adoptedAt ?? this.now().toISOString();
    const policy: RetentionPolicyRecord = {
      policyId,
      applicationId: validated.applicationId,
      tenantId: validated.tenantId,
      version: validated.version,
      retentionDays: validated.retentionDays,
      reason: validated.reason,
      adoptedBy: validated.adoptedBy,
      adoptedAt,
    };
    this.state.policies.set(policyId, policy);
    await this.appendRecord({
      applicationId: validated.applicationId,
      tenantId: validated.tenantId,
      environment: "control-plane",
      actor: { actorId: validated.adoptedBy, actorKind: "service-principal" },
      action: {
        kind: "retention.policy-adopted",
        command: "retention-policy-adopt",
        operationKey: `policy:${validated.applicationId}:v${validated.version}`,
      },
      target: { kind: "application", id: validated.applicationId },
      provenance: { seam: "retention.policy", sourceRecordId: policyId },
      rationale: { why: validated.reason },
      occurredAt: adoptedAt,
      actionDetail: {
        policyId,
        version: validated.version,
        retentionDays: validated.retentionDays,
      },
    });
    return policy;
  }

  async latestPolicy(applicationId: string): Promise<RetentionPolicyRecord | null> {
    const policies = [...this.state.policies.values()]
      .filter((policy) => policy.applicationId === applicationId)
      .sort((left, right) => right.version - left.version);
    return policies[0] ?? null;
  }
}
