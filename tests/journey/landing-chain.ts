/**
 * PPR-011 — the redirect-following landing chain (GAP-004's recorded
 * residual: the bare-root landing answers a redirect, not HTML).
 *
 * The harness's URL-hygiene discipline fetches every surface with
 * redirect: "manual" — NOTHING is auto-followed by fetch. When the
 * discover journey's root answer is a redirect status with a Location
 * header, this follower walks the plane's own redirect bridge hop by
 * hop: one auditSurface-class fetch per hop, SAME-ORIGIN targets only,
 * a hard budget of MAX_LANDING_REDIRECT_HOPS fetches, every hop's
 * status + raw Location recorded. The result is a discriminated union
 * and the journey records the honest terminal shape for each kind.
 */

import type { HarnessContext } from "./context";
import { isHtmlSurface } from "./dom";
import { fetchSurface, type SurfaceFetch } from "./http";
import type { StepEvidence } from "./types";

/** The hard hop budget: at most this many same-origin fetches per followed chain. */
export const MAX_LANDING_REDIRECT_HOPS = 3;

/** True for the redirect statuses the follower treats as one more hop. */
export function isLandingRedirectStatus(status: number | null): boolean {
  return status === 301 || status === 302 || status === 307 || status === 308;
}

/** One followed hop: the fetched URL, its status and its raw Location header. */
export interface LandingHop {
  readonly url: string;
  readonly status: number | null;
  readonly location: string | null;
}

/**
 * The discriminated chain result: "html" (the chain lands on a served
 * HTML surface — it gets the full landed-surface audit); "non-html"
 * (the chain terminates in an honest non-HTML answer); "loop" (a
 * redirect cycle); "budget-exceeded" (the chain is longer than the hop
 * budget); "cross-origin" (the next hop leaves the plane's origin —
 * out of audit scope); "unreachable" (a hop did not answer).
 */
export type LandingChainResult =
  | {
      readonly kind: "html";
      readonly hops: readonly LandingHop[];
      readonly url: string;
      readonly response: SurfaceFetch;
    }
  | {
      readonly kind: "non-html";
      readonly hops: readonly LandingHop[];
      readonly terminalStatus: number | null;
      readonly contentType: string | null;
      readonly evidence: StepEvidence;
    }
  | { readonly kind: "loop"; readonly hops: readonly LandingHop[]; readonly loopUrl: string }
  | { readonly kind: "budget-exceeded"; readonly hops: readonly LandingHop[] }
  | { readonly kind: "cross-origin"; readonly hops: readonly LandingHop[]; readonly hopUrl: string }
  | {
      readonly kind: "unreachable";
      readonly hops: readonly LandingHop[];
      readonly hopUrl: string;
      readonly transportError: string;
    };

/**
 * Follow the plane's own redirect bridge from startUrl, manually and
 * bounded: each iteration fetches the current URL with redirect:
 * "manual", records the hop, and stops at the first honest terminal —
 * a served HTML surface, a non-HTML answer, a loop, the hop budget, a
 * cross-origin hop or a transport failure. The start URL itself is
 * fetched as the chain's first hop (the caller's own root fetch is a
 * separate observation, never reused or trusted here).
 */
export async function followLandingChain(
  ctx: HarnessContext,
  startUrl: string,
): Promise<LandingChainResult> {
  const planeOrigin = new URL(ctx.targetUrl).origin;
  const visited = new Set<string>([startUrl]);
  const hops: LandingHop[] = [];
  let current = startUrl;
  let remaining = MAX_LANDING_REDIRECT_HOPS;
  while (remaining > 0) {
    remaining -= 1;
    const fetched = await fetchSurface(current);
    if (!fetched.ok) {
      return {
        kind: "unreachable",
        hops,
        hopUrl: current,
        transportError: fetched.evidence.transportError ?? "unknown",
      };
    }
    const location = fetched.evidence.location ?? null;
    hops.push({ url: current, status: fetched.evidence.status, location });
    if (!isLandingRedirectStatus(fetched.evidence.status) || location === null) {
      // A terminal answer: HTML gets the landed-surface audit; anything
      // else is the honest non-HTML fact.
      if (isHtmlSurface(fetched.evidence.contentType, fetched.body)) {
        return { kind: "html", hops, url: current, response: fetched };
      }
      return {
        kind: "non-html",
        hops,
        terminalStatus: fetched.evidence.status,
        contentType: fetched.evidence.contentType,
        evidence: fetched.evidence,
      };
    }
    const resolved = new URL(location, current).toString();
    if (new URL(resolved).origin !== planeOrigin) {
      return { kind: "cross-origin", hops, hopUrl: resolved };
    }
    if (visited.has(resolved)) {
      return { kind: "loop", hops, loopUrl: resolved };
    }
    visited.add(resolved);
    current = resolved;
  }
  return { kind: "budget-exceeded", hops };
}

/** The path form of a URL for the human-facing chain description. */
function pathOf(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return url;
  }
}

/**
 * The observed-string prefix that discloses the chain ("" when no
 * redirect was followed): e.g. "307 / -> /console (1 hop); ".
 */
export function landingChainDescription(hops: readonly LandingHop[]): string {
  const redirects = hops.filter(
    (hop) => hop.location !== null && isLandingRedirectStatus(hop.status),
  );
  if (redirects.length === 0) {
    return "";
  }
  const arrows = redirects
    .map((hop) => `${hop.status} ${pathOf(hop.url)} -> ${hop.location}`)
    .join("; ");
  return `${arrows} (${redirects.length} hop${redirects.length === 1 ? "" : "s"}); `;
}

/** The finding-evidence form of the chain (full URLs, every hop's status + Location). */
export function landingChainEvidence(hops: readonly LandingHop[]): string {
  if (hops.length === 0) {
    return "no hop answered";
  }
  return hops
    .map(
      (hop) =>
        `${hop.url} answered ${hop.status ?? "transport failure"}${hop.location === null ? "" : ` location ${hop.location}`}`,
    )
    .join("; ");
}
