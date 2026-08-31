/**
 * In-memory synthesis store (tools module adapter; WORK-018).
 *
 * The test/world implementation of the `SynthesisStore` port: the same
 * idempotency/arbitration contract as the SQL store (converge on the
 * same key + fingerprint; guarded transitions; scope-filtered reads).
 */

import { PlatformError } from "../../../shared/errors";
import type { SynthesizedProgramRecord } from "../domain/synthesis";
import { canTransitionSynthesizedProgram } from "../domain/synthesis";
import type {
  SynthesisInsertInput,
  SynthesisInsertOutcome,
  SynthesisStore,
  SynthesisTransitionInput,
} from "../ports/synthesis-store";

export class InMemorySynthesisStore implements SynthesisStore {
  private readonly byKey = new Map<string, SynthesizedProgramRecord>();
  private readonly fingerprints = new Map<string, string>();

  private key(applicationId: string, idempotencyKey: string): string {
    return `${applicationId}:${idempotencyKey}`;
  }

  async insert(input: SynthesisInsertInput): Promise<SynthesisInsertOutcome> {
    const key = this.key(input.program.applicationId, input.program.submissionIdempotencyKey);
    const existing = this.byKey.get(key);
    if (existing !== undefined) {
      const fingerprint = this.fingerprints.get(key);
      if (fingerprint !== input.submissionFingerprint) {
        throw new PlatformError({
          code: "IDEMPOTENCY_KEY_REUSED",
          message: "idempotency key was already used with a different submission fingerprint",
          details: { programId: existing.id },
        });
      }
      return { status: "converged", program: existing };
    }
    this.byKey.set(key, input.program);
    this.fingerprints.set(key, input.submissionFingerprint);
    return { status: "inserted", program: input.program };
  }

  async transition(input: SynthesisTransitionInput): Promise<SynthesizedProgramRecord> {
    const program = await this.get(input.applicationId, input.programId);
    if (program === null) {
      throw new PlatformError({
        code: "TOOL_ERROR",
        message: `synthesized program ${input.programId} not found`,
      });
    }
    if (program.status !== input.from) {
      throw new PlatformError({
        code: "INVALID_STATE_TRANSITION",
        message: `program ${program.toolId} is ${program.status}; the guarded transition expected ${input.from} (replay converges on the committed state)`,
      });
    }
    if (!canTransitionSynthesizedProgram(input.from, input.to)) {
      throw new PlatformError({
        code: "INVALID_STATE_TRANSITION",
        message: `synthesized program cannot move from ${input.from} to ${input.to}`,
      });
    }
    const next: SynthesizedProgramRecord = {
      ...program,
      status: input.to,
      staticValidation: input.staticValidation ?? program.staticValidation,
      runtimeTests: input.runtimeTests ?? program.runtimeTests,
      rejection: input.rejection ?? program.rejection,
      updatedAt: new Date().toISOString(),
    };
    // Preserve the durable row under its submission key.
    const subKey = this.key(program.applicationId, program.submissionIdempotencyKey);
    this.byKey.set(subKey, next);
    return next;
  }

  async get(applicationId: string, programId: string): Promise<SynthesizedProgramRecord | null> {
    for (const record of this.byKey.values()) {
      if (record.id === programId && record.applicationId === applicationId) {
        return record;
      }
    }
    return null;
  }

  async listByApplication(applicationId: string): Promise<readonly SynthesizedProgramRecord[]> {
    const records = [...this.byKey.values()]
      .filter((record) => record.applicationId === applicationId)
      .sort((a, b) =>
        a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id < b.id ? -1 : 1,
      );
    return records;
  }

  async listUsable(
    applicationId: string,
    asOf: Date,
  ): Promise<readonly SynthesizedProgramRecord[]> {
    const asOfIso = asOf.toISOString();
    return (await this.listByApplication(applicationId)).filter(
      (record) => record.status === "usable" && record.expiresAt > asOfIso,
    );
  }
}
