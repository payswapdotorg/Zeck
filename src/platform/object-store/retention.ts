/**
 * Artifact byte retention/cleanup contract and tooling (WORK-043 /
 * D-02, acceptance criterion 7).
 *
 * SAFETY MODEL (the invariant: cleanup can never accidentally delete
 * authoritative metadata):
 *
 * 1. The object store contains BYTES ONLY. Authoritative artifact
 *    metadata, provenance, digests and lifecycle state live in Zeck
 *    PostgreSQL — this module has no database access and cannot
 *    touch metadata AT ALL (architecturally pinned).
 * 2. Deletion is EXPLICIT-KEY ONLY: the sweep deletes exactly the
 *    keys the AUTHORITY (the caller, deriving from PostgreSQL state)
 *    listed as candidates — never keys discovered by listing or
 *    globbing the store.
 * 3. The candidate set must be confirmed authoritative
 *    (`authoritativeInventoryConfirmed: true`): an empty or
 *    failed-read inventory never authorizes deletion (fail closed).
 * 4. Every deletable key must match the configured namespace prefix
 *    AND key shape; anything else is REFUSED with a reason.
 * 5. Keys in the authoritative retained set are NEVER deleted —
 *    refusal recorded.
 * 6. Execution is DRY-RUN by default; `executeRetentionSweep` only
 *    deletes what the verified plan says, reports every per-key
 *    outcome, and never reports success for failed deletions.
 */
import type { ObjectStorePort } from "./port";

export interface RetentionNamespace {
  /** Required key prefix, e.g. `zeck/artifacts/`. */
  readonly prefix: string;
  /** Required key shape (regex) applied to the full key. */
  readonly keyPattern: string;
}

/**
 * The default namespace: content-addressed artifact keys of the form
 * `zeck/artifacts/<tenant>/<2-hex>/<64-hex digest>`.
 */
export const DEFAULT_ARTIFACT_NAMESPACE: RetentionNamespace = {
  prefix: "zeck/artifacts/",
  keyPattern: "^zeck/artifacts/[a-z0-9-]{1,64}/[0-9a-f]{2}/[0-9a-f]{64}$",
};

export interface RetentionSweepInput {
  readonly namespace: RetentionNamespace;
  /**
   * The keys the authority currently RETAINS (live references from
   * PostgreSQL). A retained key is never deletable.
   */
  readonly authoritativeRetainedKeys: ReadonlySet<string>;
  /**
   * Candidate keys the authority has determined are no longer
   * retained (expired/unreferenced per authoritative lifecycle
   * state). The sweep validates and refuses — it never expands.
   */
  readonly candidateKeys: readonly string[];
  /**
   * The caller's explicit assertion that the retained-key inventory
   * was read AUTHORITATIVELY (a failed or empty read must set this
   * false; an unconfirmed inventory refuses every deletion).
   */
  readonly authoritativeInventoryConfirmed: boolean;
}

export interface RetentionRefusal {
  readonly key: string;
  readonly reason: string;
}

export interface RetentionSweepPlan {
  /** Keys that passed every guard (the exact deletion set). */
  readonly deletions: readonly string[];
  /** Keys refused, with the exact reason (reported, never silently dropped). */
  readonly refusals: readonly RetentionRefusal[];
}

export class RetentionSafetyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RetentionSafetyError";
  }
}

function compilePattern(namespace: RetentionNamespace): RegExp {
  try {
    return new RegExp(namespace.keyPattern);
  } catch {
    throw new RetentionSafetyError(
      `the retention key pattern does not compile: ${namespace.keyPattern}`,
    );
  }
}

/**
 * Plan a retention sweep: validate every candidate against the
 * namespace, the retained set and the inventory-confirmation guard.
 * This is the pure half of the contract — planning NEVER touches the
 * store.
 */
export function planRetentionSweep(input: RetentionSweepInput): RetentionSweepPlan {
  if (input.namespace.prefix.length === 0) {
    throw new RetentionSafetyError("the retention namespace prefix is required");
  }
  const pattern = compilePattern(input.namespace);
  const deletions: string[] = [];
  const refusals: RetentionRefusal[] = [];
  for (const key of input.candidateKeys) {
    const refusal = refusalFor(key, input, pattern);
    if (refusal === null) {
      deletions.push(key);
    } else {
      refusals.push(refusal);
    }
  }
  // The inventory guard: candidates exist but the retained inventory
  // is empty AND unconfirmed ⇒ everything is refused (fail closed —
  // an unreadable authority never authorizes deletion).
  if (
    !input.authoritativeInventoryConfirmed &&
    input.candidateKeys.length > 0 &&
    deletions.length > 0
  ) {
    const guarded: RetentionRefusal[] = deletions.map((key) => ({
      key,
      reason:
        "the authoritative retained-key inventory was not confirmed (a failed or empty inventory read never authorizes deletion)",
    }));
    return { deletions: [], refusals: [...refusals, ...guarded] };
  }
  return { deletions, refusals };
}

function refusalFor(
  key: string,
  input: RetentionSweepInput,
  pattern: RegExp,
): RetentionRefusal | null {
  if (!key.startsWith(input.namespace.prefix)) {
    return {
      key,
      reason: `outside the retention namespace (${input.namespace.prefix}) — authoritative metadata and non-artifact keys are never deletable by the sweep`,
    };
  }
  if (!pattern.test(key)) {
    return {
      key,
      reason: "does not match the content-addressed artifact key shape required for deletion",
    };
  }
  if (input.authoritativeRetainedKeys.has(key)) {
    return {
      key,
      reason: "retained by the authoritative ledger (live artifact reference)",
    };
  }
  return null;
}

export interface RetentionSweepOutcome {
  readonly plannedDeletions: readonly string[];
  readonly deleted: readonly string[];
  /** Deletion attempts that failed (fail-closed outcomes, reported). */
  readonly failures: readonly { readonly key: string; readonly error: string }[];
  readonly refusals: readonly RetentionRefusal[];
  readonly dryRun: boolean;
}

/**
 * Execute a planned retention sweep against an object store. DRY-RUN
 * by default; every deletion outcome is reported individually — no
 * silent success. The store is only ever called with keys from the
 * VERIFIED plan.
 */
export async function executeRetentionSweep(
  store: ObjectStorePort,
  input: RetentionSweepInput,
  options: { readonly dryRun?: boolean } = {},
): Promise<RetentionSweepOutcome> {
  const dryRun = options.dryRun ?? true;
  const plan = planRetentionSweep(input);
  if (dryRun || plan.deletions.length === 0) {
    return {
      plannedDeletions: plan.deletions,
      deleted: [],
      failures: [],
      refusals: plan.refusals,
      dryRun,
    };
  }
  const deleted: string[] = [];
  const failures: { key: string; error: string }[] = [];
  for (const key of plan.deletions) {
    try {
      await store.delete(key);
      deleted.push(key);
    } catch (error) {
      failures.push({ key, error: (error as Error).message });
    }
  }
  return {
    plannedDeletions: plan.deletions,
    deleted,
    failures,
    refusals: plan.refusals,
    dryRun: false,
  };
}
