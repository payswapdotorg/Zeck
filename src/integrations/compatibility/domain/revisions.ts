/**
 * Exact application/integration revision pinning (ACR-006 §3; the proof
 * program's battery step 1).
 *
 * A compatibility claim is only meaningful against EXACT revisions: the
 * pinned UPSTREAM revision (the external application's own commit — the
 * revision the graph was inventoried against) and the pinned INTEGRATION
 * revision (the revision of the Zeck-side integration that delegates the
 * edges). Both are mandatory, both are immutable once declared: the types
 * below expose NO mutation path, and every consumer (evidence record,
 * demo registry entry, projection) binds the pin BY VALUE — a record or
 * demo that carries a different pin is a DIFFERENT object, never an
 * update of this one.
 *
 * Revisions are opaque non-empty strings (a commit SHA, a tag, a
 * content digest — the integration names its own convention); nothing
 * here interprets or normalizes them. Comparison is exact string
 * equality.
 */

/** An exact revision reference (opaque, non-empty, never normalized). */
export interface RevisionPin {
  /** The pinned upstream application revision (commit SHA / tag). */
  readonly upstreamRevision: string;
  /** The pinned Zeck integration revision (commit SHA / tag). */
  readonly integrationRevision: string;
}

/**
 * The identity of the pinned application: the external application's
 * name/repository plus the Zeck-side application identity its delegated
 * executions run under (the applicationId of the public create
 * contract — an opaque Zeck application identifier, never a provider
 * concept).
 */
export interface ApplicationIdentity {
  /** Human-readable application name (e.g. the upstream project name). */
  readonly name: string;
  /** The upstream repository reference (opaque string, e.g. the origin URL). */
  readonly repository: string;
  /** The Zeck application identity the integration's executions carry. */
  readonly applicationId: string;
}

/** A pinned application: identity + the exact revision pin. */
export interface PinnedApplication {
  readonly identity: ApplicationIdentity;
  readonly pin: RevisionPin;
}

/** A named validation issue (fail-closed, machine-readable). */
export interface RevisionValidationIssue {
  readonly field: string;
  readonly issue: string;
}

/** Validate a revision pin: both revisions mandatory, non-empty, trimmed. */
export function validateRevisionPin(pin: unknown): readonly RevisionValidationIssue[] {
  const issues: RevisionValidationIssue[] = [];
  if (typeof pin !== "object" || pin === null) {
    return [{ field: "pin", issue: "revision pin must be an object" }];
  }
  const record = pin as { upstreamRevision?: unknown; integrationRevision?: unknown };
  if (typeof record.upstreamRevision !== "string" || record.upstreamRevision.trim().length === 0) {
    issues.push({ field: "pin.upstreamRevision", issue: "upstream revision is mandatory" });
  }
  if (
    typeof record.integrationRevision !== "string" ||
    record.integrationRevision.trim().length === 0
  ) {
    issues.push({ field: "pin.integrationRevision", issue: "integration revision is mandatory" });
  }
  return issues;
}

/** Validate an application identity: every field mandatory and non-empty. */
export function validateApplicationIdentity(identity: unknown): readonly RevisionValidationIssue[] {
  if (typeof identity !== "object" || identity === null) {
    return [{ field: "identity", issue: "application identity must be an object" }];
  }
  const issues: RevisionValidationIssue[] = [];
  const record = identity as { name?: unknown; repository?: unknown; applicationId?: unknown };
  if (typeof record.name !== "string" || record.name.trim().length === 0) {
    issues.push({ field: "identity.name", issue: "application name is mandatory" });
  }
  if (typeof record.repository !== "string" || record.repository.trim().length === 0) {
    issues.push({ field: "identity.repository", issue: "application repository is mandatory" });
  }
  if (typeof record.applicationId !== "string" || record.applicationId.trim().length === 0) {
    issues.push({ field: "identity.applicationId", issue: "Zeck application id is mandatory" });
  }
  return issues;
}

/** Validate a whole pinned application (identity + pin). */
export function validatePinnedApplication(pinned: unknown): readonly RevisionValidationIssue[] {
  if (typeof pinned !== "object" || pinned === null) {
    return [{ field: "pinnedApplication", issue: "pinned application must be an object" }];
  }
  const record = pinned as { identity?: unknown; pin?: unknown };
  return [...validateApplicationIdentity(record.identity), ...validateRevisionPin(record.pin)];
}

/** Exact-revision equality: true only when BOTH revisions match exactly. */
export function revisionPinsEqual(a: RevisionPin, b: RevisionPin): boolean {
  return (
    a.upstreamRevision === b.upstreamRevision && a.integrationRevision === b.integrationRevision
  );
}
