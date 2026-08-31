/**
 * In-memory substrate operator (substrate-federation integration
 * adapter; WORK-031) — the test/world double for the neutral
 * `SubstrateOperatorAdapter` seam.
 */
import type { ExternalSubstrateSubmission } from "../domain/submission";
import type { SubstrateOperatorAdapter } from "../ports/operator-adapter";

export class InMemorySubstrateOperator implements SubstrateOperatorAdapter {
  readonly operatorId: string;
  private readonly submissions = new Map<string, ExternalSubstrateSubmission>();

  constructor(operatorId: string) {
    this.operatorId = operatorId;
  }

  declare(submission: ExternalSubstrateSubmission): this {
    this.submissions.set(
      `${submission.substrate.substrateId}@${submission.substrate.version}`,
      submission,
    );
    return this;
  }

  async listSubstrates(): Promise<readonly ExternalSubstrateSubmission[]> {
    return [...this.submissions.values()];
  }
}
