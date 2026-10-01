/**
 * The PPR-021 egress-deny runtime preload — the proof-environment egress
 * control for the CONTINUE RUNTIME's outbound traffic (the application
 * under proof), not the Zeck-side harness (whose model-rail supply
 * egress is platform-side BYOK dispatch, exactly as in production).
 *
 * MECHANISM: this preload runs INSIDE the pinned Continue process (bun),
 * BEFORE the CLI entry is imported. It installs a default-deny wrapped
 * transport as the runtime's GLOBAL fetch:
 *
 *  - ONLY real network egress (http/https URLs) is intercepted: loopback
 *    hosts (127.0.0.1, ::1, localhost — the local Zeck adapter endpoint)
 *    pass through untouched, every non-loopback http/https host is
 *    matched (with the PPR-017 framework's own `hostMatchesPattern`
 *    rule, imported from the public barrel) against the named deny rules
 *    (the direct AI-provider egress class) plus the default-deny
 *    catch-all — a matching request is REFUSED (fail closed) and
 *    recorded as an EgressViolation in the compatibility framework's
 *    exact field vocabulary;
 *  - NON-http(s) fetches (data: URLs, relative WASM loads — e.g. the
 *    yoga-layout WASM loader the CLI's UI stack calls at import time)
 *    are passed through to the real fetch untouched: they are runtime
 *    machinery, not network egress (a live finding from the proof
 *    environment bring-up, disclosed here);
 *  - every recorded violation is appended (JSONL) to the proof log file
 *    whose path the spawner passes in PPR_021_EGRESS_LOG.
 *
 * BELT-AND-BRACES WITH THE DENY PROXY: Continue's model-path fetches go
 * through `fetchwithRequestOptions` (packages/fetch — a bundled
 * node-fetch), which does NOT use the global fetch — but it DOES honor
 * HTTP_PROXY/HTTPS_PROXY + NO_PROXY (verified at the pinned revision).
 * The spawner therefore ALSO points the runtime's proxy env at the
 * harness's deny proxy (egress-proxy.ts — the PPR-018/PPR-020 pattern):
 * every model-path request (chat/completions, completions, embeddings,
 * rerank) is denied by the proxy, and this preload covers every
 * global-fetch straggler (version checks, telemetry, hub fetches).
 * BOTH controls record violations in the framework's exact shapes and
 * the battery merges them.
 *
 * NO CONTINUE FILE IS MODIFIED: the pinned revision runs 100% unmodified;
 * these are host-level runtime controls (the same role an HTTP proxy
 * played for PPR-018's Python runtime — the injected-transport seam the
 * PPR-017 harness documents).
 *
 * Usage (from the corpus runner):
 *   bun <zeck-root>/compat/continue/harness/egress-preload.ts -- <continue args>
 */

import { appendFileSync } from "node:fs";
import { denyRuleFor, isLoopbackHost, type EgressViolationRecord } from "./egress-policy";

const PPR_021_EGRESS_LOG = process.env.PPR_021_EGRESS_LOG ?? "";
const PPR_021_CONTINUE_ENTRY = process.env.PPR_021_CONTINUE_ENTRY ?? "";
/**
 * The DIRECT-BASELINE arm's explicit provider allowance (comma-separated
 * hostnames the proof operator marks reachable for THAT arm only — the
 * certified Zeck arm never sets it; an allowed host is passed through
 * and recorded as a blocked=false observation so the direct arm's
 * provider egress is honestly visible in the log).
 */
const PPR_021_EGRESS_ALLOW = (process.env.PPR_021_EGRESS_ALLOW ?? "")
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
    if (PPR_021_EGRESS_LOG.length === 0) {
      return;
    }
    try {
      appendFileSync(PPR_021_EGRESS_LOG, `${JSON.stringify(violation)}\n`);
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
    let parsed: URL | null = null;
    try {
      parsed = new URL(url);
    } catch {
      parsed = null;
    }
    // Only real network egress (http/https) is intercepted; runtime
    // machinery fetches (data: URLs, relative WASM loads) pass through.
    if (parsed === null || (parsed.protocol !== "http:" && parsed.protocol !== "https:")) {
      return realFetch(input, init);
    }
    const host = parsed.host;
    if (isLoopbackHost(parsed.hostname)) {
      return realFetch(input, init);
    }
    if (PPR_021_EGRESS_ALLOW.includes(parsed.hostname.toLowerCase())) {
      record({
        host,
        url: pathOf(url),
        rule: "direct-baseline allowance (PPR_021_EGRESS_ALLOW)",
        at: new Date().toISOString(),
        blocked: false,
      });
      return realFetch(input, init);
    }
    const rule = denyRuleFor(host, hostMatchesPattern);
    record({ host, url: pathOf(url), rule: rule.note, at: new Date().toISOString(), blocked: true });
    throw new Error(
      `direct-provider egress denied: ${host} matched deny rule "${rule.note}" (proof-environment egress control)`,
    );
  };

  globalThis.fetch = wrapped as typeof fetch;

  if (PPR_021_CONTINUE_ENTRY.length === 0) {
    console.error("[ppr-021 egress preload] PPR_021_CONTINUE_ENTRY is not set");
    process.exit(2);
  }
  // Rewrite argv so the CLI's own arg parser sees a normal invocation.
  const rawArgv = process.argv.slice(2);
  const args = rawArgv[0] === "--" ? rawArgv.slice(1) : rawArgv;
  process.argv = [process.argv[0] ?? "bun", PPR_021_CONTINUE_ENTRY, ...args];
  await import(PPR_021_CONTINUE_ENTRY);
}

void main().catch((error) => {
  console.error("[ppr-021 egress preload] failed:", error);
  process.exit(1);
});
