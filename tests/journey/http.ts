/**
 * PPR-003 — the HTTP surface client (real HTTP only, never a mock).
 *
 * Every journey step fetches its surface through this client so every
 * observation carries the SAME evidence shape: URL, method, status,
 * content type, body sha256 and duration — the DEP-040 driver's own
 * evidence grammar (digests, never raw bodies, in the report).
 */

import { createHash } from "node:crypto";
import type { StepEvidence } from "./types";

/** The default per-request timeout (fail-closed, bounded). */
const DEFAULT_TIMEOUT_MS = 15_000;

/** One fetched surface (the raw observation + the evidence record). */
export interface SurfaceFetch {
  readonly evidence: StepEvidence;
  /** The raw body (NEVER copied into the report; findings quote redacted excerpts only). */
  readonly body: string;
  readonly ok: boolean;
}

export interface SurfaceFetchRequest {
  readonly method?: string;
  readonly headers?: Record<string, string>;
  readonly body?: string;
  readonly timeoutMs?: number;
}

/** sha256 hex of a body (the evidence digest grammar). */
export function sha256Of(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

/**
 * Fetch one surface over real HTTP. Transport failures are OBSERVED
 * (ok=false, evidence.transportError carries the exact reason) — the
 * caller records the reachability fact; the harness never crashes on
 * an unreachable target.
 */
export async function fetchSurface(
  url: string,
  request: SurfaceFetchRequest = {},
): Promise<SurfaceFetch> {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), request.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      method: request.method ?? "GET",
      headers: request.headers,
      ...(request.body === undefined ? {} : { body: request.body }),
      redirect: "manual",
      signal: controller.signal,
    });
    const body = await response.text();
    const evidence: StepEvidence = {
      url,
      method: request.method ?? "GET",
      status: response.status,
      contentType: response.headers.get("content-type"),
      bodySha256: sha256Of(body),
      durationMs: Date.now() - started,
    };
    return { evidence, body, ok: true };
  } catch (error) {
    const evidence: StepEvidence = {
      url,
      method: request.method ?? "GET",
      status: null,
      contentType: null,
      bodySha256: null,
      durationMs: Date.now() - started,
      transportError: (error as Error).message,
    };
    return { evidence, body: "", ok: false };
  } finally {
    clearTimeout(timer);
  }
}

/** A short, safe excerpt of a body for finding evidence (bounded + escape-safe). */
export function excerptOf(body: string, maxChars = 160): string {
  const flat = body.replaceAll(/\s+/g, " ").trim();
  return flat.length <= maxChars ? flat : `${flat.slice(0, maxChars)}…`;
}
