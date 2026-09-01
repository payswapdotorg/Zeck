/**
 * In-memory substrate store (capabilities module adapter; WORK-031).
 *
 * The test/world implementation of the `SubstrateStore` port with the
 * SAME arbitration contract as the SQL store.
 */

import { PlatformError } from "../../../shared/errors";
import type { ComputationalSubstrateRecord } from "../domain/substrate";
import { canTransitionSubstrate } from "../domain/substrate";
import type {
  SubstrateInsertInput,
  SubstrateInsertOutcome,
  SubstrateStatusInput,
  SubstrateStore,
} from "../ports/substrate-store";

export class InMemorySubstrateStore implements SubstrateStore {
  private readonly records = new Map<string, ComputationalSubstrateRecord>();

  private key(applicationId: string, substrateId: string, version: string): string {
    return `${applicationId}:${substrateId}:${version}`;
  }

  async insert(input: SubstrateInsertInput): Promise<SubstrateInsertOutcome> {
    const key = this.key(
      input.record.applicationId,
      input.record.substrateId,
      input.record.version,
    );
    const existing = this.records.get(key);
    if (existing !== undefined) {
      if (existing.digest !== input.digest) {
        throw new PlatformError({
          code: "IDEMPOTENCY_KEY_REUSED",
          message: "substrate version already exists with a different body",
        });
      }
      return { status: "converged", record: existing };
    }
    const record: ComputationalSubstrateRecord = {
      ...input.record,
      digest: input.digest,
      status: "available",
      createdAt: new Date().toISOString(),
    };
    this.records.set(key, record);
    return { status: "published", record };
  }

  async find(applicationId: string, substrateId: string, version: string) {
    return this.records.get(this.key(applicationId, substrateId, version)) ?? null;
  }

  async list(applicationId: string) {
    return [...this.records.values()]
      .filter((record) => record.applicationId === applicationId)
      .sort((a, b) =>
        a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : 1,
      );
  }

  async listAvailableByWorkloadClass(applicationId: string, workloadClass: string) {
    return (await this.list(applicationId)).filter(
      (record) =>
        record.status === "available" && record.workloadClasses.includes(workloadClass as never),
    );
  }

  async updateStatus(input: SubstrateStatusInput) {
    const key = this.key(input.applicationId, input.substrateId, input.version);
    const record = this.records.get(key);
    if (record === undefined) {
      throw new PlatformError({
        code: "CAPABILITY_UNAVAILABLE",
        message: "substrate not registered",
      });
    }
    if (record.status === input.to) {
      return record; // converged
    }
    if (record.status !== input.from || !canTransitionSubstrate(record.status, input.to)) {
      throw new PlatformError({
        code: "INVALID_STATE_TRANSITION",
        message: `substrate ${input.substrateId}@${input.version} cannot move from ${record.status} to ${input.to}`,
      });
    }
    const next: ComputationalSubstrateRecord = { ...record, status: input.to };
    this.records.set(key, next);
    return next;
  }
}
