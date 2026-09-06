/**
 * Release promotion policy (WORK-047 / D-06; the PROMOTION-GATES
 * checkpoint).
 *
 * Repository-resident truth: `deploy/manifests/release-policy.json`
 * declares the CLOSED gate-kind vocabulary (each gate's scope and
 * evidence contract) and the ENTRY GATES per ladder phase. The
 * ladder order and the per-phase `requires` come from the D-01
 * `environments.json` (the single source of truth for the ladder):
 * this loader FAILS CLOSED on any drift between the two — every
 * environments.json requirement must be covered by the release
 * policy's entry gates for the corresponding phase, so weakening
 * either file is unrepresentable.
 *
 * Evaluation is PURE: recorded gate results + policy → the promotion
 * decision inputs (allowed / missing gates / refusal reasons). The
 * durable enforcement is the store's (the policy travels to
 * `activate`/`rollback` as the required-gate input; the store
 * re-verifies inside the governed transaction).
 */

import type { DeploymentManifest } from "../deployment/manifest";
import { RELEASE_PHASES, type ReleasePhase } from "./port";

export type GateScope = "checkout" | "environment" | "release";

export interface GateKindContract {
  readonly kind: string;
  readonly scope: GateScope;
  readonly evidence: string;
  /** The repository tool that produces the evidence (when tool-run). */
  readonly tool: string | null;
}

export interface ReleasePolicy {
  readonly gateKinds: readonly GateKindContract[];
  /** Entry gates per ladder phase (the promotion requirement sets). */
  readonly entryGates: Readonly<Record<ReleasePhase, readonly string[]>>;
}

export class ReleasePolicyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReleasePolicyError";
  }
}

const GATE_SCOPES: readonly GateScope[] = ["checkout", "environment", "release"];

/**
 * Load and validate the repository release policy against the
 * deployment manifest (environments.json ladder cross-check).
 * Fail-closed: any drift, unknown gate kind, phase hole or unlisted
 * requirement refuses with the exact problem.
 */
export function loadReleasePolicy(source: string, manifest: DeploymentManifest): ReleasePolicy {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch (error) {
    throw new ReleasePolicyError(
      `release-policy.json is not valid JSON: ${(error as Error).message}`,
    );
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new ReleasePolicyError("release-policy.json: expected a JSON object");
  }
  const record = parsed as Record<string, unknown>;

  const problems: string[] = [];

  // --- gateKinds (the closed vocabulary) ---
  const gateKindList = record.gateKinds;
  if (!Array.isArray(gateKindList) || gateKindList.length === 0) {
    throw new ReleasePolicyError("release-policy.json: gateKinds must be a non-empty array");
  }
  const gateKinds: GateKindContract[] = [];
  const kindNames = new Set<string>();
  for (const [index, entry] of gateKindList.entries()) {
    if (typeof entry !== "object" || entry === null) {
      problems.push(`gateKinds[${index}]: expected an object`);
      continue;
    }
    const gate = entry as Record<string, unknown>;
    const kind = gate.kind;
    if (typeof kind !== "string" || kind.trim() === "") {
      problems.push(`gateKinds[${index}].kind must be a non-empty string`);
      continue;
    }
    if (kindNames.has(kind)) {
      problems.push(`gateKinds: duplicate kind "${kind}"`);
      continue;
    }
    kindNames.add(kind);
    const scope = gate.scope;
    if (typeof scope !== "string" || !(GATE_SCOPES as readonly string[]).includes(scope)) {
      problems.push(
        `gateKinds[${kind}].scope must be one of ${GATE_SCOPES.join("|")} (got: "${String(scope)}")`,
      );
      continue;
    }
    const evidence = gate.evidence;
    if (typeof evidence !== "string" || evidence.trim() === "") {
      problems.push(`gateKinds[${kind}].evidence must be a non-empty string`);
      continue;
    }
    const tool = gate.tool;
    if (tool !== undefined && tool !== null && typeof tool !== "string") {
      problems.push(`gateKinds[${kind}].tool must be a string or null`);
      continue;
    }
    gateKinds.push({
      kind,
      scope: scope as GateScope,
      evidence,
      tool: tool === undefined || tool === null ? null : tool,
    });
  }

  // --- entryGates per phase ---
  const entryGatesSource = record.entryGates;
  if (typeof entryGatesSource !== "object" || entryGatesSource === null) {
    throw new ReleasePolicyError("release-policy.json: entryGates must be an object");
  }
  const entryGates: Record<ReleasePhase, readonly string[]> = {} as Record<
    ReleasePhase,
    readonly string[]
  >;
  for (const phase of RELEASE_PHASES) {
    const listed = (entryGatesSource as Record<string, unknown>)[phase];
    if (!Array.isArray(listed)) {
      problems.push(`entryGates.${phase} must be an array of gate kinds`);
      entryGates[phase] = [];
      continue;
    }
    const gates: string[] = [];
    for (const gate of listed) {
      if (typeof gate !== "string" || !kindNames.has(gate)) {
        problems.push(
          `entryGates.${phase}: gate "${String(gate)}" is not declared in gateKinds (closed vocabulary)`,
        );
        continue;
      }
      gates.push(gate);
    }
    const unique = new Set(gates);
    if (unique.size !== gates.length) {
      problems.push(`entryGates.${phase}: duplicate gate kinds`);
    }
    entryGates[phase] = [...unique];
  }

  // --- the environments.json ladder cross-check (single source of truth) ---
  // local.promotion.requires (leaving local, entering ci) ⊆ entryGates.ci;
  // preview.promotion.requires ⊆ entryGates.staging;
  // staging.promotion.requires ⊆ entryGates.production.
  const ladderCrossChecks: readonly {
    readonly environment: string;
    readonly entering: ReleasePhase;
  }[] = [
    { environment: "local", entering: "ci" },
    { environment: "preview", entering: "staging" },
    { environment: "staging", entering: "production" },
  ];
  for (const check of ladderCrossChecks) {
    const environment = manifest.environments.find(
      (candidate) => candidate.id === check.environment,
    );
    if (environment === undefined || environment.promotion === null) {
      problems.push(
        `environments.json: environment "${check.environment}" must declare its promotion (the ladder cross-check)`,
      );
      continue;
    }
    for (const requirement of environment.promotion.requires) {
      if (!entryGates[check.entering].includes(requirement)) {
        problems.push(
          `entryGates.${check.entering} must cover the environments.json requirement "${requirement}" of "${check.environment}.promotion" (drift between the ladder and the release policy)`,
        );
      }
    }
  }

  if (problems.length > 0) {
    throw new ReleasePolicyError(
      `invalid release policy (${problems.length} problem(s)):\n- ${problems.join("\n- ")}`,
    );
  }
  return { gateKinds, entryGates };
}

export interface PromotionEvaluation {
  readonly allowed: boolean;
  readonly satisfied: readonly string[];
  readonly missing: readonly string[];
  /** The refusal reason (when not allowed). */
  readonly reason: string | null;
}

/**
 * Pure promotion evaluation: the recorded (effective) gate kinds vs
 * the target phase's entry gates. Only PASSED gates count; a failed
 * latest attempt is a missing gate (re-run to satisfy, evidence
 * stays append-only).
 */
export function evaluatePromotion(
  target: ReleasePhase,
  effectiveGates: readonly { readonly gateKind: string; readonly status: string }[],
  policy: ReleasePolicy,
): PromotionEvaluation {
  const passed = new Set(
    effectiveGates.filter((gate) => gate.status === "passed").map((gate) => gate.gateKind),
  );
  const required = policy.entryGates[target] ?? [];
  const missing = required.filter((gate) => !passed.has(gate));
  if (missing.length > 0) {
    return {
      allowed: false,
      satisfied: required.filter((gate) => passed.has(gate)),
      missing,
      reason: `promotion to ${target} is missing required gate evidence: ${missing.join(", ")}`,
    };
  }
  return { allowed: true, satisfied: required, missing: [], reason: null };
}
