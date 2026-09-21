/**
 * PPR-003 — the public user-journey acceptance harness CLI.
 *
 * THE LEAD'S INVOCATION (the moment the public preview is live):
 *
 *   # from a checkout of the EXACT deployed revision:
 *   bun tests/journey/run.ts \
 *     --url https://<the-public-preview-url> \
 *     --environment production
 *   # (the expected revision defaults to the checkout's HEAD; or pass
 *   #  --expected-revision <40-hex-sha> to pin it explicitly)
 *   # Credentialed journey steps (optional):
 *   #   ZECK_JOURNEY_TOKEN=<bearer> ZECK_JOURNEY_APPLICATION_ID=<uuid> ...
 *
 * LOCAL MODES (the harness's own proof):
 *
 *   bun tests/journey/run.ts --local-plane
 *     boots the REAL deploy/api.ts plane (the deploy chain's local
 *     mode; the no-PG degradation is supported — run with
 *     --allow-degraded when the environment carries no PostgreSQL) and
 *     runs the 12 journeys against it end to end.
 *
 *   bun tests/journey/run.ts --self-proof
 *     the local-plane run + the three hostile negatives (wrong
 *     revision, unreachable target, secret-leak page) — the full
 *     PPR-003 local proof battery in one command.
 *
 * Output: one JSON report on stdout (--report <path> additionally
 * writes it to a file); exit 0 = every executed step passed (not-run
 * boundaries are honest, never failures); exit 1 = any step failed,
 * any finding fired, or the identity gate refused; exit 2 = the
 * harness's own preflight refusal (bad arguments, URL-hygiene
 * violation).
 */

import { writeFileSync } from "node:fs";
import { expectedRevisionOf } from "./identity-gate";
import { bootLocalPlane } from "./local-plane";
import { negativeSecretLeak, negativeUnreachable, negativeWrongRevision } from "./negatives";
import { runJourneyHarness } from "./runner";

function optionalValue(argv: readonly string[], flag: string): string | undefined {
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] : undefined;
}

function hasFlag(argv: readonly string[], flag: string): boolean {
  return argv.includes(flag);
}

function credentialsFromEnvironment(): {
  readonly token: string;
  readonly applicationId: string;
} | null {
  const token = process.env.ZECK_JOURNEY_TOKEN?.trim();
  const applicationId = process.env.ZECK_JOURNEY_APPLICATION_ID?.trim();
  if (
    token === undefined ||
    token.length === 0 ||
    applicationId === undefined ||
    applicationId.length === 0
  ) {
    return null;
  }
  return { token, applicationId };
}

interface CliOutcome {
  readonly exitCode: number;
  readonly label: string;
  readonly summaryLine: string;
}

async function runOnce(options: {
  readonly targetUrl: string;
  readonly environment: "local" | "preview" | "staging" | "production";
  readonly expectedRevision?: string;
  readonly branch?: string;
  readonly allowDegraded: boolean;
  readonly mode: string;
  readonly reportPath?: string;
}): Promise<CliOutcome> {
  const outcome = await runJourneyHarness({
    targetUrl: options.targetUrl,
    environment: options.environment,
    ...(options.expectedRevision === undefined
      ? {}
      : { expectedRevision: options.expectedRevision }),
    ...(options.branch === undefined ? {} : { branch: options.branch }),
    allowDegraded: options.allowDegraded,
    credentials: credentialsFromEnvironment(),
    mode: options.mode,
  });
  const report = outcome.report;
  const summaryLine =
    `[${options.mode}] exit ${outcome.exitCode} — journeys ${report.summary.journeys}, ` +
    `steps ${report.summary.stepsTotal} (pass ${report.summary.stepsPassed} / fail ${report.summary.stepsFailed} / not-run ${report.summary.stepsNotRun}), ` +
    `findings ${report.findings.length} (blocker ${report.summary.findingsBySeverity.blocker} / major ${report.summary.findingsBySeverity.major} / minor ${report.summary.findingsBySeverity.minor}), ` +
    `identity gate ${report.identityGate.verified ? "verified" : `REFUSED: ${report.identityGate.reason ?? "?"}`}, ` +
    `duration ${report.durationMs}ms`;
  if (options.reportPath !== undefined) {
    writeFileSync(options.reportPath, `${JSON.stringify(report, null, 2)}\n`);
  } else {
    console.log(JSON.stringify(report, null, 2));
  }
  return { exitCode: outcome.exitCode, label: options.mode, summaryLine };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const environment = (optionalValue(argv, "--environment") ?? "local") as
    | "local"
    | "preview"
    | "staging"
    | "production";
  if (
    environment !== "local" &&
    environment !== "preview" &&
    environment !== "staging" &&
    environment !== "production"
  ) {
    console.error("error: --environment must be local|preview|staging|production");
    process.exit(2);
  }
  const expectedRevision = optionalValue(argv, "--expected-revision");
  const revisionCheck = expectedRevisionOf(expectedRevision);
  if (revisionCheck.error !== undefined) {
    console.error(`error: ${revisionCheck.error}`);
    process.exit(2);
  }
  const allowDegraded = hasFlag(argv, "--allow-degraded");
  const reportPath = optionalValue(argv, "--report");
  const url = optionalValue(argv, "--url");
  const branch = optionalValue(argv, "--branch");
  const localPlane = hasFlag(argv, "--local-plane");
  const selfProof = hasFlag(argv, "--self-proof");
  if (url !== undefined && (localPlane || selfProof)) {
    console.error("error: --url cannot be combined with --local-plane / --self-proof");
    process.exit(2);
  }
  if (environment === "preview" && branch === undefined && url !== undefined) {
    console.error(
      "error: --environment preview requires --branch <branch-name> (the per-branch preview resource set: the preview slug is an identity input — the same contract as deploy/public-smoke.ts --url)",
    );
    process.exit(2);
  }
  if (url === undefined && !localPlane && !selfProof) {
    console.error(
      "error: one of --url <baseUrl>, --local-plane or --self-proof is required (see the file header for the Lead's invocation)",
    );
    process.exit(2);
  }

  const outcomes: CliOutcome[] = [];

  if (url !== undefined) {
    outcomes.push(
      await runOnce({
        targetUrl: url,
        environment,
        ...(expectedRevision === undefined ? {} : { expectedRevision }),
        ...(branch === undefined ? {} : { branch }),
        allowDegraded,
        mode: "url",
        ...(reportPath === undefined ? {} : { reportPath }),
      }),
    );
  }

  if (localPlane || selfProof) {
    // THE LOCAL PLANE (the deploy chain's local mode; no-PG degradation).
    const plane = await bootLocalPlane({ label: "ppr-003-local-proof" });
    try {
      outcomes.push(
        await runOnce({
          targetUrl: plane.baseUrl,
          environment: "local",
          ...(expectedRevision === undefined ? {} : { expectedRevision }),
          allowDegraded: true,
          mode: "local-plane",
          ...(reportPath === undefined ? {} : { reportPath }),
        }),
      );
    } finally {
      await plane.stop();
    }
  }

  if (selfProof) {
    // NEGATIVE 1: the wrong-revision target refuses the whole run.
    const wrong = await negativeWrongRevision(revisionCheck.revision);
    const wrongOk =
      wrong.refused &&
      wrong.blockedSteps === 12 &&
      wrong.executedSteps === 0 &&
      wrong.reason.length > 0;
    outcomes.push({
      exitCode: wrongOk ? 0 : 1,
      label: "negative/wrong-revision",
      summaryLine: `[negative/wrong-revision] ${wrongOk ? "REFUSED AS DESIGNED" : "DRILL FAILED"} — refused=${wrong.refused}, blockedSteps=${wrong.blockedSteps}/12, executedSteps=${wrong.executedSteps}, reason="${wrong.reason.slice(0, 140)}"`,
    });

    // NEGATIVE 2: the unreachable target records findings, never a crash.
    const unreachable = await negativeUnreachable();
    const unreachableOk =
      unreachable.refusedCleanly &&
      unreachable.reachabilityFinding &&
      unreachable.reportProduced &&
      unreachable.reason.length > 0;
    outcomes.push({
      exitCode: unreachableOk ? 0 : 1,
      label: "negative/unreachable",
      summaryLine: `[negative/unreachable] ${unreachableOk ? "RECORDED AS DESIGNED" : "DRILL FAILED"} — refusedCleanly=${unreachable.refusedCleanly}, reachabilityFinding=${unreachable.reachabilityFinding}, reportProduced=${unreachable.reportProduced}, reason="${unreachable.reason.slice(0, 140)}"`,
    });

    // NEGATIVE 3: the secret-leak page fires the redacted finding.
    const leak = await negativeSecretLeak();
    const leakOk = leak.findingFired && leak.redactedEvidence && leak.outputClean;
    outcomes.push({
      exitCode: leakOk ? 0 : 1,
      label: "negative/secret-leak",
      summaryLine: `[negative/secret-leak] ${leakOk ? "FIRED AS DESIGNED" : "DRILL FAILED"} — findingFired=${leak.findingFired}, redactedEvidence=${leak.redactedEvidence}, outputClean=${leak.outputClean}`,
    });
  }

  // The consolidated verdict (stderr, so stdout stays the JSON report).
  let exitCode = 0;
  for (const outcome of outcomes) {
    process.stderr.write(`${outcome.summaryLine}\n`);
    if (outcome.exitCode !== 0) {
      exitCode = 1;
    }
  }
  process.exit(exitCode);
}

const IS_ENTRY =
  process.argv[1] !== undefined &&
  (process.argv[1].endsWith("tests/journey/run.ts") ||
    process.argv[1].endsWith("tests/journey/run.js"));

if (IS_ENTRY) {
  main().catch((error: unknown) => {
    console.error(`error: ${(error as Error).message}`);
    process.exit(1);
  });
}
