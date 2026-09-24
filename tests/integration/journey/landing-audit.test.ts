/**
 * PPR-011 — the redirect-following landing audit's fixture matrix (the
 * six-scenario proof, no live plane and no database): a local fixture
 * server on a random loopback port serves the honest shapes a plane's
 * root bridge can take, and the harness's chain follower is asserted
 * against each — the result kind, the hop count and the per-hop
 * status + Location records.
 *
 * The LIVE re-run is the Lead's MEASURE step at the wave's redeploy;
 * nothing here touches the deploy chain or a real plane.
 */

import { createServer, type Server } from "node:http";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createContext, type HarnessContext } from "../../../tests/journey/context";
import { titleOf } from "../../../tests/journey/dom";
import {
  followLandingChain,
  MAX_LANDING_REDIRECT_HOPS,
} from "../../../tests/journey/landing-chain";

/** The served HTML landing every within-budget chain terminates on. */
const DIRECT_HTML =
  '<html lang="en"><head><meta charset="utf-8"><title>Direct landing fixture</title></head><body><h1>Direct landing</h1></body></html>';

/** The fixture's redirect table: path -> the raw Location header of its 307. */
const REDIRECTS: Readonly<Record<string, string>> = {
  "/one-hop": "/direct",
  "/two-hops": "/one-hop",
  "/loop-a": "/loop-b",
  "/loop-b": "/loop-a",
  "/over-budget": "/ob1",
  "/ob1": "/ob2",
  "/ob2": "/ob3",
  "/ob3": "/ob4",
  "/ob4": "/direct",
  "/cross-origin": "http://external.example.invalid/landing",
};

const server: Server = createServer((request, response) => {
  const redirect = REDIRECTS[request.url ?? ""];
  if (redirect !== undefined) {
    response.writeHead(307, { location: redirect });
    response.end();
    return;
  }
  if (request.url === "/direct") {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(DIRECT_HTML);
    return;
  }
  response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
  response.end("not found");
});

let baseUrl = "";
let ctx: HarnessContext;

beforeAll(async () => {
  await new Promise<void>((resolvePromise) => {
    server.listen(0, "127.0.0.1", () => resolvePromise());
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("the landing fixture did not bind");
  }
  baseUrl = `http://127.0.0.1:${address.port}`;
  ctx = createContext({
    targetUrl: baseUrl,
    environment: "local",
    allowDegraded: true,
    credentials: null,
  });
});

afterAll(async () => {
  await new Promise<void>((resolvePromise) => {
    server.close(() => resolvePromise());
  });
});

describe("PPR-011: the redirect-following landing chain (the six-scenario fixture matrix)", () => {
  test("the hop budget is the work order's named constant (3 same-origin hops)", () => {
    expect(MAX_LANDING_REDIRECT_HOPS).toBe(3);
  });

  test("SCENARIO 1 — a direct HTML landing terminates the chain at the first fetch", async () => {
    const chain = await followLandingChain(ctx, `${baseUrl}/direct`);
    expect(chain.kind).toBe("html");
    if (chain.kind !== "html") {
      throw new Error("unreachable");
    }
    expect(chain.hops.length).toBe(1);
    expect(chain.hops[0]?.status).toBe(200);
    expect(chain.hops[0]?.location).toBeNull();
    expect(chain.url).toBe(`${baseUrl}/direct`);
    expect(chain.response.evidence.contentType).toContain("text/html");
    expect(titleOf(chain.response.body)).toBe("Direct landing fixture");
  });

  test("SCENARIO 2 — a single 307 bridge lands on the served HTML surface (1 hop)", async () => {
    const chain = await followLandingChain(ctx, `${baseUrl}/one-hop`);
    expect(chain.kind).toBe("html");
    if (chain.kind !== "html") {
      throw new Error("unreachable");
    }
    expect(chain.hops.length).toBe(2);
    expect(chain.hops[0]?.status).toBe(307);
    expect(chain.hops[0]?.location).toBe("/direct");
    expect(chain.hops[1]?.status).toBe(200);
    expect(chain.hops[1]?.location).toBeNull();
    expect(chain.url).toBe(`${baseUrl}/direct`);
  });

  test("SCENARIO 3 — a two-hop 307 chain lands within the budget", async () => {
    const chain = await followLandingChain(ctx, `${baseUrl}/two-hops`);
    expect(chain.kind).toBe("html");
    if (chain.kind !== "html") {
      throw new Error("unreachable");
    }
    expect(chain.hops.length).toBe(3);
    expect(chain.hops.map((hop) => hop.status)).toEqual([307, 307, 200]);
    expect(chain.hops.map((hop) => hop.location)).toEqual(["/one-hop", "/direct", null]);
    expect(chain.url).toBe(`${baseUrl}/direct`);
  });

  test("SCENARIO 4 — a redirect loop is detected, never followed forever", async () => {
    const chain = await followLandingChain(ctx, `${baseUrl}/loop-a`);
    expect(chain.kind).toBe("loop");
    if (chain.kind !== "loop") {
      throw new Error("unreachable");
    }
    expect(chain.loopUrl).toBe(`${baseUrl}/loop-a`);
    expect(chain.hops.length).toBe(2);
    expect(chain.hops.map((hop) => hop.status)).toEqual([307, 307]);
    expect(chain.hops.map((hop) => hop.location)).toEqual(["/loop-b", "/loop-a"]);
  });

  test("SCENARIO 5 — a chain exceeding the hop budget stops at the budget", async () => {
    const chain = await followLandingChain(ctx, `${baseUrl}/over-budget`);
    expect(chain.kind).toBe("budget-exceeded");
    if (chain.kind !== "budget-exceeded") {
      throw new Error("unreachable");
    }
    expect(chain.hops.length).toBe(MAX_LANDING_REDIRECT_HOPS);
    expect(chain.hops.every((hop) => hop.status === 307)).toBe(true);
    expect(chain.hops.map((hop) => hop.location)).toEqual(["/ob1", "/ob2", "/ob3"]);
  });

  test("SCENARIO 6 — a cross-origin hop stops the chain (out of audit scope, never fetched)", async () => {
    const chain = await followLandingChain(ctx, `${baseUrl}/cross-origin`);
    expect(chain.kind).toBe("cross-origin");
    if (chain.kind !== "cross-origin") {
      throw new Error("unreachable");
    }
    expect(chain.hopUrl).toBe("http://external.example.invalid/landing");
    expect(chain.hops.length).toBe(1);
    expect(chain.hops[0]?.status).toBe(307);
  });
});
