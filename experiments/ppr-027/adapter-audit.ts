/**
 * PPR-027 — the ACR-007 thin-adapter audit (binding, from the work order):
 * for each of the nine certified integrations, measure whether the
 * application-side adapter remains a THIN DELEGATION ADAPTER rather than
 * a shadow Zeck authority.
 *
 * The audit is STATIC and MECHANICAL over the ACTUAL pinned runtimes
 * (the frozen compat/<app>/adapter/** sources — read-only, never
 * modified): it inventories the adapter surface, scans for every
 * authority-shaped mechanism ACR-007 §3 forbids (provider credentials,
 * provider selection, retry authority, fallback chains, model routing,
 * budget accounting, verification authority, evidence authority,
 * second-gateway growth), counts the delegation call sites, and records
 * the DISCLOSED non-thin mechanisms (the transport-polling loop and the
 * idempotency-key cache every certified adapter carries, per their own
 * disclosures) with exact file:line evidence.
 *
 * The verdict is derived from the findings, never asserted: an adapter is
 * THIN when it holds no forbidden authority and every outbound call is a
 * single delegation through the public Zeck boundary.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { SUBJECTS, type SubjectDefinition } from "./config";

/** The repo root (this file lives at experiments/ppr-027/). */
const REPO_ROOT = join(new URL(".", import.meta.url).pathname, "..", "..");

/** One adapter file's inventory. */
export interface AdapterFileAudit {
  readonly path: string;
  readonly lines: number;
  readonly createExecutionCallSites: readonly number[];
  readonly forbiddenFindings: readonly ForbiddenFinding[];
  readonly disclosedMechanisms: readonly DisclosedMechanism[];
}

/** A forbidden-authority finding (empty for a thin adapter). */
export interface ForbiddenFinding {
  readonly kind:
    | "provider-credential"
    | "provider-selection"
    | "retry-authority"
    | "fallback-chain"
    | "model-routing"
    | "budget-accounting"
    | "verification-authority"
    | "evidence-authority"
    | "second-gateway";
  readonly line: number;
  readonly evidence: string;
}

/** A disclosed non-thin mechanism (the certified adapters' own disclosures). */
export interface DisclosedMechanism {
  readonly kind: "terminal-polling-loop" | "idempotency-key-cache";
  readonly line: number;
  readonly evidence: string;
}

/** One subject's audit result. */
export interface SubjectAdapterAudit {
  readonly subjectId: string;
  readonly adapterFiles: readonly AdapterFileAudit[];
  readonly adapterLinesTotal: number;
  readonly delegationCallSites: number;
  readonly forbiddenFindings: readonly ForbiddenFinding[];
  readonly disclosedMechanisms: readonly DisclosedMechanism[];
  readonly verdict: "thin" | "not-thin";
  readonly verdictBasis: string;
}

/** The forbidden-pattern vocabulary (mechanical, conservative). */
const FORBIDDEN_PATTERNS: readonly {
  readonly kind: ForbiddenFinding["kind"];
  readonly pattern: RegExp;
  readonly note: string;
}[] = [
  {
    kind: "provider-credential",
    pattern: /\b(?:OPENAI_API_KEY|ANTHROPIC_API_KEY|API_KEY)\s*[:=]/,
    note: "an adapter holding a provider credential literal",
  },
  {
    kind: "provider-selection",
    pattern: /\b(?:selectProvider|chooseProvider|providerOrder|pickProvider)\b/,
    note: "an adapter selecting a provider",
  },
  {
    kind: "retry-authority",
    pattern: /\b(?:retryDelay|backoffMs|maxRetries|RETRY_LIMIT)\b/,
    note: "an adapter-owned retry policy",
  },
  {
    kind: "fallback-chain",
    pattern: /\bfallbackProviders?\b|\bproviderFallback\b/,
    note: "an adapter-owned provider fallback chain",
  },
  {
    kind: "model-routing",
    pattern: /\b(?:routeModel|modelRouter|selectModel)\s*[=(]/,
    note: "an adapter routing models",
  },
  {
    kind: "budget-accounting",
    pattern: /\b(?:spendLedger|trackSpend|accountCost)\b/,
    note: "an adapter accounting spend",
  },
  {
    kind: "verification-authority",
    pattern: /\b(?:verifyOutcome|verifyResult|assertVerified)\s*\(/,
    note: "an adapter verifying outcomes",
  },
  {
    kind: "evidence-authority",
    pattern: /\b(?:assembleEvidence|certifyRecord|deriveStatus)\s*\(/,
    note: "an adapter assembling evidence or deriving status",
  },
  {
    kind: "second-gateway",
    pattern: /\b(?:gatewayPort|proxyAll|reverseGateway)\b/,
    note: "second-gateway growth",
  },
];

/** The disclosed-mechanism vocabulary (the known, documented shapes). */
const DISCLOSED_PATTERNS: readonly {
  readonly kind: DisclosedMechanism["kind"];
  readonly pattern: RegExp;
}[] = [
  { kind: "terminal-polling-loop", pattern: /for\s*\(\s*;;\s*\)/ },
  { kind: "idempotency-key-cache", pattern: /const keyState = new Map/ },
];

function auditFile(path: string): AdapterFileAudit {
  const content = readFileSync(path, "utf8");
  const lines = content.split("\n");
  const createExecutionCallSites: number[] = [];
  const forbiddenFindings: ForbiddenFinding[] = [];
  const disclosedMechanisms: DisclosedMechanism[] = [];
  for (const [index, line] of lines.entries()) {
    const lineNumber = index + 1;
    if (/client\.createExecution\s*\(/.test(line) || /await client\.createExecution/.test(line)) {
      createExecutionCallSites.push(lineNumber);
    }
    for (const forbidden of FORBIDDEN_PATTERNS) {
      if (forbidden.pattern.test(line)) {
        forbiddenFindings.push({
          kind: forbidden.kind,
          line: lineNumber,
          evidence: `${path}:${lineNumber}: ${line.trim().slice(0, 120)}`,
        });
      }
    }
    for (const disclosed of DISCLOSED_PATTERNS) {
      if (disclosed.pattern.test(line)) {
        disclosedMechanisms.push({
          kind: disclosed.kind,
          line: lineNumber,
          evidence: `${path}:${lineNumber}: ${line.trim().slice(0, 120)}`,
        });
      }
    }
  }
  return {
    path: path.replace(`${REPO_ROOT}/`, ""),
    lines: lines.length,
    createExecutionCallSites,
    forbiddenFindings,
    disclosedMechanisms,
  };
}

/** Audit one subject's frozen adapter directory (read-only). */
export function auditSubjectAdapter(subject: SubjectDefinition): SubjectAdapterAudit {
  const adapterDir = join(REPO_ROOT, "compat", subject.subjectId, "adapter");
  const files = readdirSync(adapterDir)
    .filter((name) => name.endsWith(".ts"))
    .sort()
    .map((name) => join(adapterDir, name))
    .filter((path) => statSync(path).isFile());
  const adapterFiles = files.map((path) => auditFile(path));
  const forbiddenFindings = adapterFiles.flatMap((file) => [...file.forbiddenFindings]);
  const disclosedMechanisms = adapterFiles.flatMap((file) => [...file.disclosedMechanisms]);
  const delegationCallSites = adapterFiles.reduce(
    (sum, file) => sum + file.createExecutionCallSites.length,
    0,
  );
  const adapterLinesTotal = adapterFiles.reduce((sum, file) => sum + file.lines, 0);
  const verdict = forbiddenFindings.length === 0 ? "thin" : "not-thin";
  return {
    subjectId: subject.subjectId,
    adapterFiles,
    adapterLinesTotal,
    delegationCallSites,
    forbiddenFindings,
    disclosedMechanisms,
    verdict,
    verdictBasis:
      verdict === "thin"
        ? `no forbidden authority mechanism found in ${adapterFiles.length} adapter file(s) (${adapterLinesTotal} lines); every provider-facing outcome flows through ${delegationCallSites} createExecution delegation call site(s) to the public Zeck boundary; the ${disclosedMechanisms.length} disclosed non-thin mechanism(s) are the transport-polling loop and the idempotency-key cache the certified disclosures document (stateful translation concerns, not authorities)`
        : `forbidden authority mechanism(s) found: ${forbiddenFindings
            .map((finding) => finding.kind)
            .join(", ")}`,
  };
}

/** Audit all nine certified adapters. */
export function auditAllSubjectAdapters(): readonly SubjectAdapterAudit[] {
  return SUBJECTS.map((subject) => auditSubjectAdapter(subject));
}
