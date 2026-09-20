/**
 * PPR-003 — the hostile negatives (the harness's self-proof drills).
 *
 * Three provider-independent negatives, each driven END TO END over
 * real HTTP against real processes (the DEP-040 driver's drill
 * discipline — every negative is an EXPECTED refusal, and the refusal
 * must carry its exact reason or the drill fails):
 *
 *  1. WRONG-REVISION TARGET — a REAL local plane booted with an
 *     overridden ZECK_DEPLOY_GIT_REVISION attests the wrong revision;
 *     the harness's identity gate must REFUSE THE WHOLE RUN (every
 *     journey step records the blocked state; zero journeys execute).
 *  2. UNREACHABLE TARGET — a reserved-then-closed port; the harness
 *     records reachability findings, never a crash (a well-formed
 *     report is still produced).
 *  3. SECRET-LEAK PAGE — a local fixture server serving a page with a
 *     RUNTIME-BUILT secret-shaped value (the literal is assembled at
 *     runtime so no scanner ever matches this source file); the
 *     harness's surface audit must fire the secret-exposure finding
 *     with the redacted evidence, and the harness's own output must
 *     stay clean (redaction held).
 */

import { createServer, type Server } from "node:http";
import { auditSurface, createContext, raiseDimensionFindings } from "./context";
import { bootLocalPlane, reservePort } from "./local-plane";
import { runJourneyHarness } from "./runner";

/** The wrong-revision drill: the whole run must refuse at the gate. */
export async function negativeWrongRevision(expectedRevision: string): Promise<{
  readonly refused: boolean;
  readonly reason: string;
  readonly blockedSteps: number;
  readonly executedSteps: number;
}> {
  // A valid 40-hex sha that is guaranteed different from the expected
  // revision (the DEP-040 driver's own drill constant).
  const wrongRevision = "b".repeat(40);
  if (wrongRevision === expectedRevision) {
    throw new Error(
      "the wrong-revision drill cannot run: the expected revision collides with the drill constant",
    );
  }
  const plane = await bootLocalPlane({ revisionOverride: wrongRevision, label: "wrong-revision" });
  try {
    const outcome = await runJourneyHarness({
      targetUrl: plane.baseUrl,
      environment: "local",
      expectedRevision,
      allowDegraded: true,
      credentials: null,
      mode: "negative-drill/wrong-revision",
    });
    const blocked = outcome.report.journeys
      .flatMap((journey) => journey.steps)
      .filter((step) => step.id === "identity-gate-blocked");
    return {
      refused: outcome.report.identityGate.verified === false && outcome.exitCode === 1,
      reason: outcome.report.identityGate.reason ?? "",
      blockedSteps: blocked.length,
      executedSteps: outcome.report.summary.stepsTotal - blocked.length,
    };
  } finally {
    await plane.stop();
  }
}

/** The unreachable drill: findings, never a crash. */
export async function negativeUnreachable(): Promise<{
  readonly refusedCleanly: boolean;
  readonly reachabilityFinding: boolean;
  readonly reportProduced: boolean;
  readonly reason: string;
}> {
  const port = await reservePort();
  const deadUrl = `http://127.0.0.1:${port}`;
  // The port was reserved then released — nothing listens: a real
  // refused connect for every probe.
  const outcome = await runJourneyHarness({
    targetUrl: deadUrl,
    environment: "local",
    allowDegraded: true,
    credentials: null,
    mode: "negative-drill/unreachable",
  });
  const reachabilityFinding = outcome.report.findings.some(
    (finding) => finding.defectClass === "reachability",
  );
  return {
    refusedCleanly: outcome.exitCode === 1,
    reachabilityFinding,
    reportProduced: outcome.report.summary.journeys === 12,
    reason: outcome.report.identityGate.reason ?? "",
  };
}

/** The runtime-built secret-shaped value (no literal pattern in this file). */
function syntheticLeakedSecret(): string {
  return ["s", "k-journeyleakfixture", "000000000000"].join("");
}

/** The secret-leak drill server: one page leaking a secret-shaped value. */
export async function startSecretLeakServer(): Promise<{
  readonly url: string;
  readonly stop: () => Promise<void>;
}> {
  const server: Server = createServer((request, response) => {
    if (request.url === "/leak") {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end(
        `<html lang="en"><head><meta charset="utf-8"><title>Leak fixture</title></head><body><h1>Leak fixture</h1><p>api_key: ${syntheticLeakedSecret()}</p></body></html>`,
      );
      return;
    }
    response.writeHead(404, { "content-type": "text/html; charset=utf-8" });
    response.end("<html><body><h1>404</h1></body></html>");
  });
  await new Promise<void>((resolvePromise) => {
    server.listen(0, "127.0.0.1", () => resolvePromise());
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("the leak fixture did not bind");
  }
  return {
    url: `http://127.0.0.1:${address.port}`,
    stop: async () => {
      await new Promise<void>((resolvePromise) => server.close(() => resolvePromise()));
    },
  };
}

/** The secret-leak drill: the audit machinery must fire the redacted finding. */
export async function negativeSecretLeak(): Promise<{
  readonly findingFired: boolean;
  readonly redactedEvidence: boolean;
  readonly outputClean: boolean;
}> {
  const fixture = await startSecretLeakServer();
  try {
    const ctx = createContext({
      targetUrl: fixture.url,
      environment: "local",
      allowDegraded: true,
      credentials: null,
    });
    ctx.journey = { id: "negative-drill", title: "Negative drill" };
    const audited = await auditSurface(ctx, "/leak");
    // The production fold: every audited dimension failure becomes a
    // finding (the same path every journey step takes).
    raiseDimensionFindings(ctx, "leak-page", `${fixture.url}/leak`, audited);
    const finding = ctx.findings.find((item) => item.defectClass === "secret-exposure");
    const reportText = JSON.stringify({ findings: ctx.findings });
    return {
      findingFired: finding !== undefined,
      redactedEvidence:
        finding !== undefined &&
        !reportText.includes(syntheticLeakedSecret()) &&
        reportText.includes("chars)"),
      outputClean: !reportText.includes(syntheticLeakedSecret()),
    };
  } finally {
    await fixture.stop();
  }
}
