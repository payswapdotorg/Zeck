/**
 * Policy authority application service (policies module; WORK-007).
 *
 * The single policy authority:
 *  - PUBLISH arbitration: serialized in-memory (promise-chain queue, the
 *    WORK-005 registry precedent). Validate → content-hash → version
 *    monotonicity → store. Identical republish converges; a version
 *    rollback/conflict is rejected; malformed policy data fails closed.
 *  - ADMISSION: deny-by-default — with NO configured set every admit
 *    fails closed (there is no default-allow anywhere). With a set, the
 *    pure domain resolver produces the effective restriction chain
 *    (POL-001) enforcing monotonic tightening (POL-003), then the typed
 *    fact evaluation decides. Every decision carries durable admission
 *    provenance: set identity (version + content hash) + the digest of the
 *    exact resolved restriction set.
 *
 * The durable record of a decision is written by the caller's ledger
 * (executions EventEnvelope on the authorize seam) — decisions carry the
 * evidence that makes the record provenance-bound.
 */

import { PlatformError } from "../../../shared/errors";
import { evaluateDispatchFacts, evaluateExecutionFacts } from "../domain/admission";
import {
  canonicalPolicyJson,
  type PolicySet,
  type RestrictionSet,
  resolvePolicy,
  type TighteningCheck,
  validatePolicySet,
} from "../domain/policy";
import type {
  PolicyAdmissionRequest,
  PolicyAdmissionResult,
  PolicyAuthority,
  PolicyDispatchRequest,
  PolicyHasher,
  PolicyPublishOutcome,
  PolicySetIdentity,
  PolicyStore,
} from "../ports/policy-authority";

export interface PolicyAuthorityOptions {
  readonly store: PolicyStore;
  readonly hasher: PolicyHasher;
  readonly now?: () => Date;
  /**
   * Monotonic-tightening check override (POL-003). The default is the
   * domain `checkMonotonicTightening`; injection exists so discrimination
   * proofs can remove the protection and observe the violation (the
   * WORK-005 validation-hook precedent — production never overrides it).
   */
  readonly monotonic?: (lower: RestrictionSet, higher: RestrictionSet) => TighteningCheck;
}

export function createPolicyAuthority(options: PolicyAuthorityOptions): PolicyAuthority {
  const { store, hasher } = options;
  const now = options.now ?? (() => new Date());
  const monotonic = options.monotonic;

  // Serialized publish arbitration — one publish at a time observes a
  // consistent current-set read-modify-write (the in-memory equivalent of
  // the registry's single-flight discipline; a durable store adapter keeps
  // the same contract under a transaction).
  let publishQueue: Promise<unknown> = Promise.resolve();

  const identityOf = (set: PolicySet): PolicySetIdentity => ({
    id: set.id,
    version: set.version,
    contentHash: hasher.sha256Hex(canonicalPolicyJson(set)),
  });

  const publish = async (set: PolicySet): Promise<PolicyPublishOutcome> => {
    const issues = validatePolicySet(set);
    if (issues.length > 0) {
      // Malformed policy data never becomes authoritative (fail closed).
      throw new PlatformError({
        code: "POLICY_DENIED",
        message: "policy set rejected: invalid policy data",
        details: { issues: issues.slice(0, 20) },
      });
    }
    const identity = identityOf(set);
    const run = async (): Promise<PolicyPublishOutcome> => {
      const current = await store.load();
      if (current !== null) {
        if (current.contentHash === identity.contentHash) {
          return { status: "converged", identity };
        }
        if (set.version <= current.set.version) {
          throw new PlatformError({
            code: "POLICY_DENIED",
            message: "policy set rejected: version must strictly increase (no rollback/conflict)",
            details: {
              setId: set.id,
              attemptedVersion: set.version,
              currentVersion: current.set.version,
            },
          });
        }
      }
      await store.save({
        set,
        contentHash: identity.contentHash,
        publishedAt: now().toISOString(),
      });
      return { status: "published", identity };
    };
    const outcome = publishQueue.then(run, run);
    publishQueue = outcome.catch(() => undefined);
    return outcome;
  };

  const resolveCurrent = async (
    context: Parameters<typeof resolvePolicy>[1],
  ): Promise<PolicyAdmissionResult> => {
    const record = await store.load();
    if (record === null) {
      // DENY BY DEFAULT: nothing is admitted while no effective policy set
      // is configured — no default-allow exists anywhere in this module.
      return {
        allowed: false,
        reason: "no effective policy set is configured (deny-by-default)",
        denial: { kind: "no-policy-set", message: "no effective policy set is configured" },
      };
    }
    const resolution = resolvePolicy(
      record.set,
      context,
      monotonic === undefined ? {} : { monotonic },
    );
    const identity = {
      policySetId: record.set.id,
      policySetVersion: record.set.version,
      policyContentHash: record.contentHash,
    };
    if (resolution.outcome === "deny") {
      const denial = resolution.denial;
      const message =
        denial.kind === "prohibited"
          ? `prohibited by ${denial.scope}-scope policy: ${denial.reason}`
          : denial.message;
      return {
        allowed: false,
        reason: message,
        evidence: { ...identity, restrictionSetDigest: hasher.sha256Hex(canonicalPolicyJson({})) },
        denial: {
          kind: denial.kind === "prohibited" ? "prohibited" : "weakening",
          message,
          ...(denial.kind === "weakening"
            ? { dimension: denial.weakenings[0]?.dimension ?? "" }
            : {}),
        },
      };
    }
    const restrictionSetDigest = hasher.sha256Hex(canonicalPolicyJson(resolution.effective));
    return {
      allowed: true,
      evidence: { ...identity, restrictionSetDigest },
      effective: resolution.effective,
    };
  };

  const admit = async (request: PolicyAdmissionRequest): Promise<PolicyAdmissionResult> => {
    const resolved = await resolveCurrent(request.context);
    if (!resolved.allowed) {
      return resolved;
    }
    const effective = resolved.effective ?? {};
    const check = evaluateExecutionFacts(effective, request.facts ?? {});
    if (!check.ok) {
      return {
        allowed: false,
        reason: check.denial?.message ?? "execution facts violate the effective policy",
        evidence: resolved.evidence,
        effective,
        denial: {
          kind: "restriction",
          dimension: check.denial?.dimension,
          message: check.denial?.message ?? "execution facts violate the effective policy",
        },
      };
    }
    return resolved;
  };

  const admitDispatch = async (request: PolicyDispatchRequest): Promise<PolicyAdmissionResult> => {
    const resolved = await resolveCurrent(request.context);
    if (!resolved.allowed) {
      return resolved;
    }
    const effective = resolved.effective ?? {};
    const check = evaluateDispatchFacts(effective, request.facts);
    if (!check.ok) {
      return {
        allowed: false,
        reason: check.denial?.message ?? "dispatch facts violate the effective policy",
        evidence: resolved.evidence,
        effective,
        denial: {
          kind: "restriction",
          dimension: check.denial?.dimension,
          message: check.denial?.message ?? "dispatch facts violate the effective policy",
        },
      };
    }
    return resolved;
  };

  return {
    publish,
    admit,
    admitDispatch,
    async current() {
      return store.load();
    },
  };
}
