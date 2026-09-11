/**
 * Validation worker submission / evidence contract (VAL-001, acceptance
 * criterion 3 and the roadmap solution-reporting rule).
 *
 * A validation worker submits EXACTLY this structure: the work order, the
 * exact dispatch base, the final branch head, the changed-file inventory,
 * the executed battery, every issue found with the full solution protocol
 * (reproduction, impact, root-cause classification, viable solutions,
 * recommended solution with trade-offs, defect classification, required
 * verification evidence) and every NOT RUN boundary. The contract is
 * validated mechanically — a submission missing any mandated part is
 * rejected, so an incomplete submission can never count as delivered
 * evidence.
 */

/** The seven-part solution protocol every material issue must carry. */
export interface IssueSolutionProtocol {
  /** 1. exact reproduction (command or sequence + observed output). */
  readonly reproduction: string;
  /** 2. impact and affected acceptance criteria. */
  readonly impact: string;
  /** 3. root-cause classification (application/Zeck/provider/model/
   *  test-harness/infrastructure, possibly multiple). */
  readonly rootCause: readonly string[];
  /** 4. viable solution options (at least one). */
  readonly viableSolutions: readonly string[];
  /** 5. the recommended solution with trade-offs. */
  readonly recommendedSolution: string;
  /** 6. defect classification. */
  readonly classification:
    | "implementation-defect"
    | "validation-defect"
    | "external-limitation"
    | "architecture-gap-candidate";
  /** 7. the exact evidence required to verify the proposed solution. */
  readonly verificationEvidence: string;
}

/** One battery command the worker executed with its verdict. */
export interface BatteryResult {
  readonly command: string;
  readonly outcome: "pass" | "fail";
  readonly detail: string;
}

/** An explicitly recorded NOT RUN boundary with its exact reason. */
export interface NotRunBoundary {
  readonly surface: string;
  readonly reason: string;
}

/** The standard validation worker submission. */
export interface SubmissionRecord {
  readonly workOrder: string;
  /** The exact dispatch base revision (full SHA). */
  readonly baseRevision: string;
  /** The final implementation head (full SHA). */
  readonly finalHead: string;
  /** The one branch the work landed on. */
  readonly branch: string;
  /** Pull request that carries the work (opened, never self-merged). */
  readonly pullRequest: number;
  /** The complete changed-file inventory. */
  readonly changedFiles: readonly string[];
  /** The executed battery, in execution order. */
  readonly battery: readonly BatteryResult[];
  /** Every material issue with the full solution protocol. */
  readonly issues: readonly IssueSolutionProtocol[];
  /** Every NOT RUN boundary. */
  readonly notRun: readonly NotRunBoundary[];
  /** Repository-relative evidence references (e.g. the evidence doc). */
  readonly evidenceRefs: readonly string[];
}

/** One mechanical rejection finding for a submission. */
export interface SubmissionViolation {
  readonly path: string;
  readonly reason: string;
}

const NON_EMPTY_STRING = /^.+$/;
const FULL_SHA = /^[0-9a-f]{40}$/;

/**
 * Validate a submission record against the contract. Weakened submissions
 * are rejected: every mandated field must be present and non-empty, the
 * revisions must be full SHAs, the battery must be non-empty, every issue
 * must carry all seven protocol parts with at least one viable solution,
 * and NOT RUN boundaries must state an exact reason.
 */
export function validateSubmission(submission: SubmissionRecord): readonly SubmissionViolation[] {
  const violations: SubmissionViolation[] = [];
  const requireText = (path: string, value: unknown): void => {
    if (typeof value !== "string" || !NON_EMPTY_STRING.test(value)) {
      violations.push({ path, reason: "must be a non-empty string" });
    }
  };

  requireText("workOrder", submission.workOrder);
  requireText("branch", submission.branch);
  requireText("baseRevision", submission.baseRevision);
  requireText("finalHead", submission.finalHead);
  if (typeof submission.baseRevision === "string" && !FULL_SHA.test(submission.baseRevision)) {
    violations.push({ path: "baseRevision", reason: "must be a full 40-char SHA" });
  }
  if (typeof submission.finalHead === "string" && !FULL_SHA.test(submission.finalHead)) {
    violations.push({ path: "finalHead", reason: "must be a full 40-char SHA" });
  }
  if (
    typeof submission.pullRequest !== "number" ||
    !Number.isInteger(submission.pullRequest) ||
    submission.pullRequest <= 0
  ) {
    violations.push({ path: "pullRequest", reason: "must be a positive integer PR number" });
  }
  if (!Array.isArray(submission.changedFiles) || submission.changedFiles.length === 0) {
    violations.push({ path: "changedFiles", reason: "must list at least one changed file" });
  } else {
    submission.changedFiles.forEach((file, index) => {
      requireText(`changedFiles[${index}]`, file);
    });
  }
  if (!Array.isArray(submission.battery) || submission.battery.length === 0) {
    violations.push({ path: "battery", reason: "must record the executed battery" });
  } else {
    submission.battery.forEach((entry, index) => {
      requireText(`battery[${index}].command`, entry?.command);
      if (entry?.outcome !== "pass" && entry?.outcome !== "fail") {
        violations.push({
          path: `battery[${index}].outcome`,
          reason: 'must be "pass" or "fail"',
        });
      }
      requireText(`battery[${index}].detail`, entry?.detail);
    });
  }
  if (!Array.isArray(submission.issues)) {
    violations.push({ path: "issues", reason: "must be an array (possibly empty)" });
  } else {
    submission.issues.forEach((issue, index) => {
      requireText(`issues[${index}].reproduction`, issue?.reproduction);
      requireText(`issues[${index}].impact`, issue?.impact);
      if (!Array.isArray(issue?.rootCause) || issue.rootCause.length === 0) {
        violations.push({
          path: `issues[${index}].rootCause`,
          reason: "must classify at least one root cause",
        });
      }
      if (!Array.isArray(issue?.viableSolutions) || issue.viableSolutions.length === 0) {
        violations.push({
          path: `issues[${index}].viableSolutions`,
          reason: "must propose at least one viable solution",
        });
      }
      requireText(`issues[${index}].recommendedSolution`, issue?.recommendedSolution);
      const classifications: readonly string[] = [
        "implementation-defect",
        "validation-defect",
        "external-limitation",
        "architecture-gap-candidate",
      ];
      if (!classifications.includes(issue?.classification ?? "")) {
        violations.push({
          path: `issues[${index}].classification`,
          reason: "must be one of the four defect classifications",
        });
      }
      requireText(`issues[${index}].verificationEvidence`, issue?.verificationEvidence);
    });
  }
  if (!Array.isArray(submission.notRun)) {
    violations.push({ path: "notRun", reason: "must be an array (possibly empty)" });
  } else {
    submission.notRun.forEach((boundary, index) => {
      requireText(`notRun[${index}].surface`, boundary?.surface);
      requireText(`notRun[${index}].reason`, boundary?.reason);
    });
  }
  if (!Array.isArray(submission.evidenceRefs) || submission.evidenceRefs.length === 0) {
    violations.push({
      path: "evidenceRefs",
      reason: "must reference at least one repository evidence artifact",
    });
  } else {
    submission.evidenceRefs.forEach((ref, index) => {
      requireText(`evidenceRefs[${index}]`, ref);
    });
  }

  return violations;
}
