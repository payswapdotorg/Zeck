/**
 * The PPR-019 egress-deny runtime preload — the proof-environment egress
 * control for the CLINE RUNTIME's outbound traffic (the application
 * under proof), not the Zeck-side harness (whose model-rail supply
 * egress is platform-side BYOK dispatch, exactly as in production; the
 * identical discipline PPR-018 established with its proxy, adapted to
 * Bun/Node runtimes where HTTP_PROXY env vars are NOT honored by
 * global fetch).
 *
 * MECHANISM: this preload runs INSIDE the pinned Cline process (bun),
 * BEFORE the CLI entry is imported. It installs a default-deny wrapped
 * transport as the runtime's GLOBAL fetch:
 *
 *  - loopback hosts (127.0.0.1, ::1, localhost — the local Zeck adapter
 *    endpoint) pass through untouched;
 *  - every non-loopback host is matched (with the PPR-017 framework's
 *    own `hostMatchesPattern` rule, imported from the public barrel)
 *    against the named deny rules (the direct AI-provider egress class)
 *    plus the default-deny catch-all — a matching request is REFUSED
 *    (fail closed) and recorded as an EgressViolation in the
 *    compatibility framework's exact field vocabulary, so the battery's
 *    egress observation uses the framework's shapes;
 *  - every recorded violation is appended (JSONL) to the proof log file
 *    whose path the spawner passes in PPR_019_EGRESS_LOG.
 *
 * NO CLINE FILE IS MODIFIED: the pinned revision runs 100% unmodified;
 * this is a host-level runtime control (the same role an HTTP proxy
 * played for PPR-018's Python runtime — the injected-transport seam the
 * PPR-017 harness documents: "a proof run hands it the application
 *    runtime's transport, or the global one via the composition seam").
 *
 * The shared policy (rules / scrub list / loopback rule) lives in
 * egress-policy.ts — a side-effect-free library — so importing the
 * policy never patches anything. THIS FILE IS A SCRIPT: importing it
 * installs the control and runs the CLI.
 *
 * Usage (from the corpus runner):
 *   bun <zeck-root>/compat/cline/harness/egress-preload.ts -- <cline args>
 */

import { appendFileSync } from "node:fs";
import { denyRuleFor, isLoopbackHost, type EgressViolationRecord } from "./egress-policy";

const PPR_019_EGRESS_LOG = process.env.PPR_019_EGRESS_LOG ?? "";
const PPR_019_CLINE_ENTRY = process.env.PPR_019_CLINE_ENTRY ?? "";
/**
 * The DIRECT-BASELINE arm's explicit provider allowance (comma-separated
 * hostnames the proof operator marks reachable for THAT arm only — the
 * certified Zeck arm never sets it; a allowed host is passed through and
 * recorded as a blocked=false observation so the direct arm's provider
 * egress is honestly visible in the log).
 */
const PPR_019_EGRESS_ALLOW = (process.env.PPR_019_EGRESS_ALLOW ?? "")
  .split(",")
  .map((host) => host.trim().toLowerCase())
  .filter((host) => host.length > 0);

async function main(): Promise<void> {
  // The PPR-017 framework's own matching rule (the public barrel — the
  // exact shapes and semantics the evidence record's egress observation
  // uses; bun transpiles the Zeck repo's TS in-process).
  const { hostMatchesPattern } = await import(
    "../../../src/integrations/compatibility/public"
  );

  const realFetch = globalThis.fetch.bind(globalThis);
  const record = (violation: EgressViolationRecord): void => {
    if (PPR_019_EGRESS_LOG.length === 0) {
      return;
    }
    try {
      appendFileSync(PPR_019_EGRESS_LOG, `${JSON.stringify(violation)}\n`);
    } catch {
      // The proof log is best-effort from inside the runtime; the
      // battery treats an unreadable log as an honest observation gap.
    }
  };
  const pathOf = (url: string): string => {
    try {
      return new URL(url).pathname;
    } catch {
      return "(unparseable request target)";
    }
  };

  const wrapped = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    let host: string;
    let hostname: string;
    try {
      const parsed = new URL(url);
      host = parsed.host;
      hostname = parsed.hostname;
    } catch {
      host = "";
      hostname = "";
    }
    if (isLoopbackHost(hostname)) {
      return realFetch(input, init);
    }
    if (PPR_019_EGRESS_ALLOW.includes(hostname.toLowerCase())) {
      record({ host, url: pathOf(url), rule: "direct-baseline allowance (PPR_019_EGRESS_ALLOW)", at: new Date().toISOString(), blocked: false });
      return realFetch(input, init);
    }
    const rule = denyRuleFor(host, hostMatchesPattern);
    record({ host, url: pathOf(url), rule: rule.note, at: new Date().toISOString(), blocked: true });
    throw new Error(
      `direct-provider egress denied: ${host} matched deny rule "${rule.note}" (proof-environment egress control)`,
    );
  };

  globalThis.fetch = wrapped as typeof fetch;

  if (PPR_019_CLINE_ENTRY.length === 0) {
    console.error("[ppr-019 egress preload] PPR_019_CLINE_ENTRY is not set");
    process.exit(2);
  }
  // Rewrite argv so the CLI's own arg parser sees a normal invocation.
  const rawArgv = process.argv.slice(2);
  const args = rawArgv[0] === "--" ? rawArgv.slice(1) : rawArgv;
  process.argv = [process.argv[0] ?? "bun", PPR_019_CLINE_ENTRY, ...args];
  await import(PPR_019_CLINE_ENTRY);
}

void main().catch((error) => {
  console.error("[ppr-019 egress preload] failed:", error);
  process.exit(1);
});
