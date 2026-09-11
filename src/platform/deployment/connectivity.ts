/**
 * Private-connectivity evaluation (D-08 / WORK-060; SEC-003).
 *
 * THE RULE (SEC-003): internal control-plane/worker communication must
 * not traverse public paths in the production class. The environment
 * matrix declares each environment's connectivity profile over the
 * CLOSED vocabulary (`loopback | tunnel | private-endpoint` — a
 * `public` internal path is unrepresentable at the manifest loader).
 *
 * THIS MODULE is the validated-not-documented-only half: it classifies
 * a CONCRETE internal endpoint address (the URL a process would dial)
 * into a path class and evaluates it against the declared profile.
 * The evaluation is wired into the environment contract
 * (`env-contract.ts`), so every drill, smoke attestation and migration
 * tool that evaluates the contract enforces it.
 *
 * CLASSIFICATION is deliberately conservative and PURE:
 *  - `loopback` — 127.0.0.0/8, ::1, or the literal host `localhost`
 *    (traffic never leaves the host);
 *  - `private` — RFC1918 (10/8, 172.16/12, 192.168/16), the CGNAT
 *    range 100.64/10 (overlay/tunnel meshes present here), IPv6
 *    unique-local fc00::/7 and link-local fe80::/10 — the addresses
 *    private endpoints and tunnel interfaces present;
 *  - `dns-name` — a non-IP hostname: NOT objective evidence either
 *    way (DNS can resolve anywhere a pure function cannot see), so it
 *    rides the DECLARED profile (the repository/operator truth that
 *    this environment's internal communication uses the private path
 *    classes — the same trust model as the manifest itself);
 *  - `public` — a public IP literal or an unparseable endpoint:
 *    unambiguously routable, refused for EVERY environment class — no
 *    vocabulary entry can authorize a public internal path.
 *
 * No DNS resolution, no I/O, no environment reads: the caller supplies
 * the endpoint URLs; this module decides.
 */

import type { ConnectivityProfile } from "./manifest";
import { INTERNAL_CONNECTIVITY_PATHS } from "./manifest";

/** The address-path class of a concrete internal endpoint. */
export type AddressPathClass = "loopback" | "private" | "dns-name" | "public";

/** A concrete internal endpoint a Zeck process would dial. */
export interface InternalEndpoint {
  /** The internal component the endpoint belongs to (bounded label). */
  readonly component: string;
  /** The URL as materialized (classified; never echoed into reports verbatim). */
  readonly url: string;
}

export interface ConnectivityEvaluation {
  readonly satisfied: boolean;
  readonly problems: readonly string[];
}

/**
 * The internal control-plane/worker endpoint variables (the closed
 * seam vocabulary). The container-runner endpoint is THE control-plane
 * →worker communication seam (the D-05 runner REST protocol);
 * provider transport/egress endpoints (object store, OTLP, queue API)
 * are NOT internal Zeck communication — they are governed by their own
 * planes (degradation modes, egress policies, residency).
 */
export const INTERNAL_ENDPOINT_VARIABLES = ["ZECK_CONTAINER_RUNNER_URL"] as const;
export type InternalEndpointVariable = (typeof INTERNAL_ENDPOINT_VARIABLES)[number];

/** Parse the host (and explicit port) out of a URL-ish endpoint string. */
function hostOf(url: string): string | null {
  const trimmed = url.trim();
  const match =
    // scheme://host[:port][/path]
    /^[a-z][a-z0-9+.-]*:\/\/([^/?#]+)/i.exec(trimmed) ??
    // scheme:host[:port] (postgres/redis connection strings)
    /^[a-z][a-z0-9+.-]*:([^/?#,]+)/i.exec(trimmed);
  if (match === null) {
    return null;
  }
  const authority = match[1] ?? "";
  // Strip userinfo (user:pass@host) and port.
  const withoutUserInfo = authority.includes("@") ? (authority.split("@").pop() ?? "") : authority;
  const host = withoutUserInfo.replace(/:\d+$/, "").replace(/^\[|\]$/g, "");
  return host.length === 0 ? null : host.toLowerCase();
}

function isIpv4(host: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
}

function ipv4Octets(host: string): readonly number[] {
  const parts = host.split(".");
  if (parts.length !== 4) {
    return [0, 0, 0, 0];
  }
  const first = Number.parseInt(parts[0] ?? "0", 10);
  const second = Number.parseInt(parts[1] ?? "0", 10);
  return [
    first,
    second,
    Number.parseInt(parts[2] ?? "0", 10),
    Number.parseInt(parts[3] ?? "0", 10),
  ];
}

function isIpv6(host: string): boolean {
  return host.includes(":");
}

/** Classify one address (IP literal, `localhost`, or hostname). */
export function classifyAddress(host: string): AddressPathClass {
  const normalized = host
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, "");
  if (normalized === "localhost") {
    return "loopback";
  }
  if (isIpv4(normalized)) {
    const [a, b] = ipv4Octets(normalized);
    const second = b ?? 0;
    if (a === 127) {
      return "loopback";
    }
    if (a === 10 || (a === 192 && second === 168) || (a === 172 && second >= 16 && second <= 31)) {
      return "private";
    }
    // CGNAT 100.64/10 — the overlay/tunnel mesh range.
    if (a === 100 && second >= 64 && second <= 127) {
      return "private";
    }
    return "public";
  }
  if (isIpv6(normalized)) {
    if (normalized === "::1") {
      return "loopback";
    }
    if (normalized === "::") {
      return "public";
    }
    if (normalized.startsWith("fc") || normalized.startsWith("fd")) {
      return "private"; // fc00::/7 unique-local
    }
    if (
      normalized.startsWith("fe8") ||
      normalized.startsWith("fe9") ||
      normalized.startsWith("fea") ||
      normalized.startsWith("feb")
    ) {
      return "private"; // fe80::/10 link-local
    }
    return "public";
  }
  // A non-IP hostname carries no objective path evidence — it rides
  // the declared profile (dns-name).
  return "dns-name";
}

/** Classify a concrete endpoint URL by its host. */
export function classifyEndpointAddress(url: string): AddressPathClass {
  const host = hostOf(url);
  if (host === null) {
    // Unparseable endpoints are never evidence of privacy — fail closed.
    return "public";
  }
  return classifyAddress(host);
}

/** Which path-class a profile entry authorizes (the declared truth). */
export function pathClassAllowedByProfile(
  profile: ConnectivityProfile,
  pathClass: AddressPathClass,
): boolean {
  if (pathClass === "public") {
    // No vocabulary entry can authorize a public internal path — an
    // unambiguously public address is refused for every class.
    return false;
  }
  if (pathClass === "loopback") {
    // A loopback address is either declared directly or presented by a
    // tunnel (e.g. an SSH local port-forward).
    return profile.internalPaths.includes("loopback") || profile.internalPaths.includes("tunnel");
  }
  // Private addresses and DNS-declared endpoints ride the private
  // path vocabulary (private-endpoint / tunnel).
  return (
    profile.internalPaths.includes("private-endpoint") || profile.internalPaths.includes("tunnel")
  );
}

/** True when the profile declares only private-path vocabulary members. */
export function isPrivateOnlyProfile(profile: ConnectivityProfile): boolean {
  return (
    profile.internalPaths.length > 0 &&
    profile.internalPaths.every((path) =>
      (INTERNAL_CONNECTIVITY_PATHS as readonly string[]).includes(path),
    )
  );
}

/**
 * Evaluate concrete internal endpoints against an environment's
 * declared connectivity profile. Fail closed: a public-class internal
 * endpoint (an unambiguous public IP literal, or an unparseable URL)
 * is a problem for EVERY environment class — public internal paths
 * are unrepresentable anywhere; loopback/private/dns endpoints must
 * be authorized by the declared profile's vocabulary.
 *
 * Secret-safety: problems carry the variable/component label and the
 * classified path class — never the endpoint URL itself (credential
 * material embedded in URLs never echoes into reports).
 */
export function evaluateConnectivityContract(
  profile: ConnectivityProfile,
  endpoints: readonly InternalEndpoint[],
): ConnectivityEvaluation {
  const problems: string[] = [];
  for (const endpoint of endpoints) {
    const pathClass = classifyEndpointAddress(endpoint.url);
    if (!pathClassAllowedByProfile(profile, pathClass)) {
      problems.push(
        `${endpoint.component} internal endpoint resolves to a ${pathClass} path; the declared connectivity profile (${profile.internalPaths.join("|")}) does not authorize it — internal control-plane/worker communication may not traverse public paths (SEC-003)`,
      );
    }
  }
  return { satisfied: problems.length === 0, problems };
}

/** The internal endpoints materialized in a process environment (present variables only). */
export function internalEndpointsOfEnvironment(
  env: Readonly<Record<string, string | undefined>>,
): readonly InternalEndpoint[] {
  const endpoints: InternalEndpoint[] = [];
  for (const variable of INTERNAL_ENDPOINT_VARIABLES) {
    const value = env[variable];
    if (value !== undefined && value.trim().length > 0) {
      endpoints.push({ component: variable, url: value });
    }
  }
  return endpoints;
}
