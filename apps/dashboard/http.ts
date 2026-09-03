/**
 * Zeck dashboard HTTP kernel (WORK-033) — pure routing, no state.
 *
 * The kernel owns: the route table shape (method + path pattern with
 * `:param` segments), path/query parsing, size-capped urlencoded form
 * reading, cookie parse/serialize, and the response constructors
 * (HTML / redirect / text / static asset). Every handler is a pure
 * function of the request context; there is no server-side session
 * state anywhere (M24).
 */

import type { IncomingMessage, ServerResponse } from "node:http";

export interface HttpContext {
  readonly method: "GET" | "POST";
  readonly path: string;
  readonly params: Readonly<Record<string, string>>;
  readonly query: URLSearchParams;
  readonly cookies: Readonly<Record<string, string>>;
  readonly form: Readonly<Record<string, string>>;
}

export interface HandlerResult {
  readonly status: number;
  /** HTML body (text/html; charset=utf-8). */
  readonly html?: string;
  /** Redirect target (303). */
  readonly location?: string;
  /** Non-HTML body (with contentType). */
  readonly body?: string;
  readonly contentType?: string;
  /** Set-Cookie headers to attach. */
  readonly setCookies?: readonly string[];
}

export interface RouteDefinition {
  readonly method: "GET" | "POST";
  readonly pattern: string;
  readonly handler: (ctx: HttpContext) => Promise<HandlerResult> | HandlerResult;
}

/** The form body exceeded the size cap (413). */
export class FormTooLargeError extends Error {
  constructor(maxBytes: number) {
    super(`form body exceeded ${maxBytes} bytes`);
    this.name = "FormTooLargeError";
  }
}

/** Parse a Cookie header into a plain record. */
export function parseCookies(header: string | undefined): Record<string, string> {
  if (header === undefined || header.trim().length === 0) {
    return {};
  }
  const out: Record<string, string> = {};
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator <= 0) {
      continue;
    }
    const name = part.slice(0, separator).trim();
    const rawValue = part.slice(separator + 1).trim();
    try {
      out[name] = decodeURIComponent(rawValue);
    } catch {
      out[name] = rawValue;
    }
  }
  return out;
}

export interface CookieOptions {
  readonly maxAge?: number;
  readonly path?: string;
  readonly httpOnly?: boolean;
  readonly sameSite?: "Lax" | "Strict" | "None";
}

/** Serialize one Set-Cookie header value. */
export function serializeCookie(name: string, value: string, options: CookieOptions = {}): string {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  parts.push(`Path=${options.path ?? "/"}`);
  if (options.maxAge !== undefined) {
    parts.push(`Max-Age=${options.maxAge}`);
  }
  if (options.httpOnly === true) {
    parts.push("HttpOnly");
  }
  parts.push(`SameSite=${options.sameSite ?? "Lax"}`);
  return parts.join("; ");
}

/** Read a urlencoded form body (size-capped; rejects oversized bodies). */
export async function readFormBody(
  request: IncomingMessage,
  maxBytes = 65_536,
): Promise<Record<string, string>> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    total += buffer.length;
    if (total > maxBytes) {
      throw new FormTooLargeError(maxBytes);
    }
    chunks.push(buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  const params = new URLSearchParams(text);
  const out: Record<string, string> = {};
  for (const [key, value] of params) {
    out[key] = value;
  }
  return out;
}

export interface RouteMatch {
  readonly route: RouteDefinition;
  readonly params: Record<string, string>;
}

/**
 * Match a method + pathname against the route table (first match wins —
 * static routes are listed before parameterized ones).
 */
export function matchRoute(
  routes: readonly RouteDefinition[],
  method: string,
  pathname: string,
): RouteMatch | null {
  const segments = pathname.split("/").filter((segment) => segment.length > 0);
  for (const route of routes) {
    if (route.method !== method) {
      continue;
    }
    const patternSegments = route.pattern.split("/").filter((segment) => segment.length > 0);
    if (patternSegments.length !== segments.length) {
      continue;
    }
    const params: Record<string, string> = {};
    let matched = true;
    for (let index = 0; index < patternSegments.length; index += 1) {
      const patternSegment = patternSegments[index] ?? "";
      const actual = segments[index] ?? "";
      if (patternSegment.startsWith(":")) {
        try {
          params[patternSegment.slice(1)] = decodeURIComponent(actual);
        } catch {
          // A malformed percent-escape can never address a route.
          matched = false;
          break;
        }
      } else if (patternSegment !== actual) {
        matched = false;
        break;
      }
    }
    if (matched) {
      return { route, params };
    }
  }
  return null;
}

/** 200-family HTML response. */
export function htmlResult(
  html: string,
  options: { setCookies?: readonly string[] } = {},
): HandlerResult {
  return {
    status: 200,
    html,
    ...(options.setCookies === undefined ? {} : { setCookies: options.setCookies }),
  };
}

/** HTML response with an explicit status (error pages). */
export function htmlStatusResult(
  status: number,
  html: string,
  options: { setCookies?: readonly string[] } = {},
): HandlerResult {
  return {
    status,
    html,
    ...(options.setCookies === undefined ? {} : { setCookies: options.setCookies }),
  };
}

/** 303 redirect. */
export function redirectResult(
  location: string,
  options: { setCookies?: readonly string[] } = {},
): HandlerResult {
  return {
    status: 303,
    location,
    ...(options.setCookies === undefined ? {} : { setCookies: options.setCookies }),
  };
}

/** A static-asset response. */
export function assetResult(body: string, contentType: string): HandlerResult {
  return { status: 200, body, contentType };
}

/** Write a handler result to the raw server response. */
export function sendResult(response: ServerResponse, result: HandlerResult): void {
  // Multiple cookies MUST cross as separate Set-Cookie headers (never a
  // single joined value).
  if (result.setCookies !== undefined && result.setCookies.length > 0) {
    response.setHeader("set-cookie", [...result.setCookies]);
  }
  if (result.location !== undefined) {
    response.writeHead(result.status, { location: result.location });
    response.end();
    return;
  }
  if (result.body !== undefined) {
    response.writeHead(result.status, {
      "content-type": `${result.contentType ?? "text/plain"}; charset=utf-8`,
      "cache-control": "no-store",
    });
    response.end(result.body);
    return;
  }
  response.writeHead(result.status, { "content-type": "text/html; charset=utf-8" });
  response.end(result.html ?? "");
}
