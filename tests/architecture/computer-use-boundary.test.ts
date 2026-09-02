/**
 * Architecture: the governed computer-use boundary (WORK-027, CUI-001/
 * 002/003; checkpoint contracts SELF-HOSTING-BOUNDARY,
 * EXECUTION-PROVENANCE, CONCURRENCY-CRASH-SAFETY).
 *
 * Mechanically proves over the REAL `src/modules/tools/` computer-use
 * tree and migration 0023:
 *
 *  - CU1 the computer-use environment port carries NO authority surface:
 *    its method set is exactly the transport surface {open, dispatchAction,
 *    observe, close, activity, contextState} — no admission/authorize/
 *    budget/execute/invoke/transition vocabulary, no authority type
 *    handles; the terminal port is exactly {execute} (the approved
 *    sandbox seam is the only terminal path);
 *  - CU2 the REQUIRED admission seams exist with the frozen method
 *    vocabulary (admit / resolve / mediate; budget is the WORK-004
 *    authority consumed directly) — the computer-use service cannot be
 *    constructed without them (no default-allow path exists);
 *  - CU3 the computer-use service deps are pinned: exactly {registry,
 *    policy, capabilities, secrets, budgetAuthority?, store, ledger,
 *    environment, terminal, generateId, now, digest} — no additional
 *    authority handles are reachable;
 *  - CU4 the deterministic-first contract is PURE (the route evaluation
 *    carries no store/service/environment/authority imports) and the
 *    route decision PRECEDES the durable operation claim in the session
 *    creation flow (the planner-facing evidence is computed before any
 *    admission or environment interaction can occur);
 *  - CU5 ambient host inheritance is UNREPRESENTABLE: the ambient-
 *    inheritance vocabulary has exactly one value ("none"), the cookie
 *    jar policy is fresh-empty, and the isolation introspection
 *    (inheritedHostState) exists on the environment port (the proof
 *    surface); the desktop envelope is a FULL explicit grant set (a
 *    partial envelope fails validation — ambient authority cannot be
 *    defaulted in);
 *  - CU6 migration 0023 is the computer-use migration with the physical
 *    guards (session identity-core immutability, the closed subordinate
 *    lifecycle + terminal immutability, the escalation ladder pinned
 *    physically ascending, the append-only escalation/observation
 *    ledgers with the gapless gates, the keyed action journal with
 *    write-once ledger bindings, the durable recoverable operation
 *    state with attempts/checkpoint/terminal discipline) and the
 *    parallel-wave collision-rule discipline (0015 burned, WORK-027
 *    claims 0023);
 *  - CU7 provider neutrality: no computer-use vendor identifier
 *    anywhere in the tools tree (no browser/desktop automation vendor,
 *    no VNC/remote-desktop vendor, no vendor rail literals);
 *  - CU8 the computer-use domain and ports stay pure: no src/platform/**
 *    import in domain/ or ports/, no provider SDK imports, no node:*
 *    runtime imports in the domain;
 *  - CU9 no second execution state machine: computer-use provenance
 *    rides the canonical executions ledger through the tools module's
 *    recordStepEvent seam (tool-requested / tool-result / tool-denied
 *    ONLY); the store port carries no execution-transition vocabulary;
 *    a session row never writes execution status (subordinate
 *    bookkeeping bound by execution_id reference);
 *  - CU10 the durable recoverable operation state is STRUCTURAL in the
 *    store port: begin/checkpoint/complete/fail over a CLOSED operation
 *    vocabulary with stable keys — the crash-safety contract (the
 *    WORK-024 standard) is not an optional extension point.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { PROVIDER_IDENTIFIER, RAIL_LITERAL } from "../discrimination/lib/patterns";

const REPO_ROOT = join(process.cwd());
const TOOLS_DIR = join(REPO_ROOT, "src/modules/tools");
const MIGRATION_PATH = join(REPO_ROOT, "src/platform/db/migrations/0023_computer_use_sessions.sql");

function collectFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (statSync(full).isDirectory()) {
      out.push(...collectFiles(full));
    } else if (entry.name.endsWith(".ts")) {
      out.push(full);
    }
  }
  return out;
}

const FILES = collectFiles(TOOLS_DIR);
const COMPUTER_USE_FILES = FILES.filter((file) => /computer-use/.test(file));

/** Authority-shaped method vocabulary that must never appear on a rail port. */
const AUTHORITY_VOCABULARY = [
  "admit(",
  "authorize(",
  "invoke(",
  "transition(",
  "reserve(",
  "settle(",
  "release(",
  "ToolAdmission",
  "BudgetAuthority",
  "ExecutionService",
  "ExecutionStore",
  "PolicyStore",
  "CapabilityRegistry",
  "SecretVault",
  "CredentialVault",
];

/** Computer-use vendor identifiers (browser/desktop automation vendors). */
const COMPUTER_USE_VENDOR_IDENTIFIER =
  /\b(Playwright|Selenium|Puppeteer|Cypress|Browserbase|BrowserStack|LambdaTest|TestingBot|Appium|VNC|noVNC|xdotool|pyautogui|AutoIt|RDP|playwright|selenium|puppeteer|cypress|browserbase|browserstack|lambdatest|testingbot|appium|novnc|xdotool|pyautogui|autoit)\w*/;

/** Computer-use vendor names as string literals (rail slugs). */
const COMPUTER_USE_RAIL_LITERAL =
  /["'](playwright|selenium|puppeteer|cypress|browserbase|browserstack|lambdatest|testingbot|appium|vnc|novnc|xdotool|pyautogui|autoit|rdp)["']/;

function read(relative: string): string {
  return readFileSync(join(TOOLS_DIR, relative), "utf8");
}

const ENVIRONMENT_PORT = read("ports/computer-use-environment.ts");
const TERMINAL_PORT = read("ports/computer-use-terminal.ts");
const ADMISSION_PORT = read("ports/computer-use-admission.ts");
const REGISTRY_PORT = read("ports/computer-use-registry.ts");
const STORE_PORT = read("ports/computer-use-store.ts");
const SERVICE_SOURCE = read("application/computer-use-service.ts");
const DOMAIN_SOURCE = read("domain/computer-use.ts");
const MIGRATION_SOURCE = readFileSync(MIGRATION_PATH, "utf8");

/** The brace-balanced body of one named interface in a port source. */
function interfaceBody(source: string, name: string): string {
  const opener = `export interface ${name} {`;
  const start = source.indexOf(opener);
  if (start === -1) {
    throw new Error(`interface not found: ${name}`);
  }
  let depth = 0;
  let end = -1;
  for (let index = start + opener.length - 1; index < source.length; index += 1) {
    const char = source[index];
    if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        end = index;
        break;
      }
    }
  }
  if (end === -1) {
    throw new Error(`interface body unterminated: ${name}`);
  }
  return source.slice(start + opener.length, end);
}

/** The method names of an interface (paren methods only). */
function methodNamesOf(source: string, name: string): string[] {
  const body = interfaceBody(source, name);
  return [
    ...new Set(
      [...body.matchAll(/^\s{2,}(?:readonly\s+)?([A-Za-z_]\w*)\s*\(/gm)].map(
        (match) => match[1] ?? "",
      ),
    ),
  ].sort();
}

describe("architecture: the governed computer-use boundary (WORK-027)", () => {
  test("the computer-use files are present and scanned", () => {
    expect(COMPUTER_USE_FILES.length).toBeGreaterThanOrEqual(12);
  });

  test("CU1: the environment/terminal ports carry exactly the transport surfaces (no authority)", () => {
    for (const forbidden of AUTHORITY_VOCABULARY) {
      expect(
        ENVIRONMENT_PORT.includes(forbidden),
        `the environment port must not carry "${forbidden}"`,
      ).toBe(false);
      expect(
        TERMINAL_PORT.includes(forbidden),
        `the terminal port must not carry "${forbidden}"`,
      ).toBe(false);
    }
    expect(methodNamesOf(ENVIRONMENT_PORT, "ComputerUseEnvironment")).toEqual([
      "activity",
      "close",
      "contextState",
      "dispatchAction",
      "observe",
      "open",
    ]);
    expect(methodNamesOf(TERMINAL_PORT, "ComputerUseTerminalExecutor")).toEqual(["execute"]);
    // Every side-effecting environment method carries the stable key.
    for (const method of ["open", "dispatchAction", "observe", "close"]) {
      const signature = `${method}(`;
      expect(ENVIRONMENT_PORT.includes(signature)).toBe(true);
    }
    expect(ENVIRONMENT_PORT.includes("operationKey: string")).toBe(true);
    // The terminal dispatch is the sandbox-boundary shape (argv + policy).
    const dispatch = interfaceBody(TERMINAL_PORT, "ComputerUseTerminalDispatch");
    expect(dispatch.includes("readonly terminalPolicy: ComputerUseTerminalPolicy;")).toBe(true);
    expect(dispatch.includes("readonly command: string;")).toBe(true);
    expect(dispatch.includes("readonly args: readonly string[];")).toBe(true);
  });

  test("CU2: the REQUIRED admission seams exist with the frozen method vocabulary", () => {
    expect(methodNamesOf(ADMISSION_PORT, "ComputerUsePolicyAdmission")).toEqual(["admit"]);
    expect(methodNamesOf(ADMISSION_PORT, "ComputerUseCapabilityGate")).toEqual(["resolve"]);
    expect(methodNamesOf(ADMISSION_PORT, "ComputerUseSecretMediation")).toEqual(["mediate"]);
    expect(methodNamesOf(REGISTRY_PORT, "ComputerUseCapabilityRegistry")).toEqual([
      "list",
      "register",
      "resolve",
    ]);
    // The mediation grant is REFERENCE-ONLY (raw secret values never cross).
    expect(ADMISSION_PORT.includes("readonly grantRef: string;")).toBe(true);
    expect(ADMISSION_PORT.includes("OPAQUE grant reference")).toBe(true);
    // No default-allow policy: the admission decision is a discriminated
    // union with a REQUIRED reason on denial.
    expect(ADMISSION_PORT.includes("readonly allowed: false;")).toBe(true);
    expect(ADMISSION_PORT.includes("readonly reason: string;")).toBe(true);
  });

  test("CU3: the computer-use service deps are pinned (no additional authority handles)", () => {
    const deps = interfaceBody(SERVICE_SOURCE, "ComputerUseServiceDeps");
    const depNames = [
      ...new Set(
        [...deps.matchAll(/^\s{2}(?:readonly\s+)?([A-Za-z_]\w*)\??\s*:/gm)].map(
          (match) => match[1] ?? "",
        ),
      ),
    ].sort();
    expect(depNames).toEqual([
      "budgetAuthority",
      "capabilities",
      "digest",
      "environment",
      "generateId",
      "ledger",
      "now",
      "policy",
      "registry",
      "secrets",
      "store",
      "terminal",
    ]);
    // The seams are REQUIRED (only the budget authority is optional at
    // construction, and costed routes fail closed without it).
    expect(deps.includes("readonly policy: ComputerUsePolicyAdmission;")).toBe(true);
    expect(deps.includes("readonly capabilities: ComputerUseCapabilityGate;")).toBe(true);
    expect(deps.includes("readonly secrets: ComputerUseSecretMediation;")).toBe(true);
    expect(deps.includes("readonly budgetAuthority?: BudgetAuthority;")).toBe(true);
    expect(SERVICE_SOURCE.includes("costed sessions never execute unbudgeted")).toBe(true);
  });

  test("CU4: the deterministic-first contract is pure and precedes the durable claim", () => {
    // The route evaluation lives in the domain with no imports at all
    // (pure, total): the domain file imports nothing module-external.
    expect(DOMAIN_SOURCE.includes("import ")).toBe(false);
    expect(DOMAIN_SOURCE.includes("export function evaluateComputerUseRoute")).toBe(true);
    // The planner-facing evidence is a pure data contract.
    expect(DOMAIN_SOURCE.includes("export interface ComputerUseRouteEvidence")).toBe(true);
    // In createSession the route evaluation PRECEDES the durable
    // operation claim (no durable state exists before the route is known).
    const createBody = SERVICE_SOURCE.slice(
      SERVICE_SOURCE.indexOf("const createSession = async ("),
      SERVICE_SOURCE.indexOf(
        "  // -----------------------------------------------------------------------\n  // dispatchAction",
      ),
    );
    const routeAt = createBody.indexOf("evaluateComputerUseRoute({");
    const claimAt = createBody.indexOf("store.beginComputerUseOperation({");
    expect(routeAt).toBeGreaterThan(-1);
    expect(claimAt).toBeGreaterThan(-1);
    expect(routeAt).toBeLessThan(claimAt);
    // The route evidence rides the session receipt (planner-facing).
    expect(SERVICE_SOURCE.includes("readonly routeEvidence: ComputerUseRouteEvidence;")).toBe(true);
  });

  test("CU5: ambient host inheritance is unrepresentable and the envelope is explicit", () => {
    // Exactly ONE ambient-inheritance value exists.
    expect(DOMAIN_SOURCE).toMatch(/export const AMBIENT_HOST_INHERITANCE = "none" as const;/);
    expect(DOMAIN_SOURCE).not.toMatch(/AmbientHostInheritance = "[^n]/);
    expect(DOMAIN_SOURCE).toMatch(
      /export const BROWSER_COOKIE_JAR_POLICY = "session-fresh-empty" as const;/,
    );
    // The validation refuses every other cookie-jar/inheritance value.
    expect(DOMAIN_SOURCE.includes("ambient cookies are unrepresentable")).toBe(true);
    // The isolation introspection is on the environment port (the proof
    // surface: contexts report what they inherited).
    expect(ENVIRONMENT_PORT.includes("readonly inheritedHostState: readonly")).toBe(true);
    // The desktop envelope is a FULL grant set — a partial envelope is
    // rejected (ambient authority cannot default in).
    expect(DOMAIN_SOURCE.includes("COMPUTER_USE_DESKTOP_GRANTS")).toBe(true);
    expect(DOMAIN_SOURCE.includes("the desktop envelope must declare the")).toBe(true);
    expect(DOMAIN_SOURCE.includes("grant explicitly (boolean)")).toBe(true);
    // Networked terminal policies must declare a non-empty egress
    // allowlist (hidden network access is unrepresentable).
    expect(DOMAIN_SOURCE.includes("networked terminal policies must declare a non-empty")).toBe(
      true,
    );
    // The service fails closed when a context reports inherited state.
    expect(SERVICE_SOURCE.includes("inherited ambient host state; isolation violated")).toBe(true);
  });

  test("CU6: migration 0023 is the computer-use migration with the physical guards", () => {
    // The five tables.
    for (const table of [
      "tools.computer_use_sessions",
      "tools.computer_use_escalations",
      "tools.computer_use_actions",
      "tools.computer_use_observations",
      "tools.computer_use_operations",
    ]) {
      expect(MIGRATION_SOURCE.includes(`CREATE TABLE ${table} (`)).toBe(true);
    }
    // The session lifecycle guards: insert gate, identity-core
    // immutability, terminal immutability, the ASCENDING ladder.
    expect(MIGRATION_SOURCE.includes("tools.cu_sessions_insert_gate()")).toBe(true);
    expect(MIGRATION_SOURCE.includes("identity core is immutable")).toBe(true);
    expect(MIGRATION_SOURCE.includes("escalation ladder only ascends")).toBe(true);
    expect(MIGRATION_SOURCE.includes("is terminal-immutable in status")).toBe(true);
    // The append-only ledgers with the gapless, convergence-aware gates.
    expect(MIGRATION_SOURCE.includes("tools.cu_escalations_append_only()")).toBe(true);
    expect(MIGRATION_SOURCE.includes("tools.cu_observations_append_only()")).toBe(true);
    expect(MIGRATION_SOURCE.includes("escalation sequence must be gapless")).toBe(true);
    expect(MIGRATION_SOURCE.includes("observation sequence must be gapless")).toBe(true);
    expect(MIGRATION_SOURCE.includes("action sequence must be gapless")).toBe(true);
    // The write-once ledger bindings on the action journal.
    expect(MIGRATION_SOURCE.includes("cu_actions_lifecycle_guard")).toBe(true);
    // The durable recoverable operation state (the WORK-024 standard).
    expect(MIGRATION_SOURCE.includes("pending -> completed|failed only")).toBe(true);
    expect(MIGRATION_SOURCE.includes("cu_ops_lifecycle_guard")).toBe(true);
    expect(MIGRATION_SOURCE.includes("attempts never regress")).toBe(true);
    // The denied-row discipline.
    expect(MIGRATION_SOURCE.includes("cu_session_denial_shape")).toBe(true);
    // The parallel-wave collision rule: 0015 burned, 0023 claimed by
    // WORK-027 (this migration).
    expect(MIGRATION_SOURCE.includes("**WORK-027 claims 0023")).toBe(true);
    // Execution subordination: sessions bind the EXISTING execution
    // identity; status is never written here.
    expect(MIGRATION_SOURCE.includes("REFERENCES executions.executions (id, application_id)")).toBe(
      true,
    );
    expect(MIGRATION_SOURCE.includes("no active computer-use session may be created on it")).toBe(
      true,
    );
  });

  test("CU7: provider neutrality over the whole tools tree", () => {
    for (const file of FILES) {
      const source = readFileSync(file, "utf8");
      const relative = file.replace(`${REPO_ROOT}/`, "");
      expect(source.match(COMPUTER_USE_VENDOR_IDENTIFIER), relative).toBeNull();
      expect(source.match(COMPUTER_USE_RAIL_LITERAL), relative).toBeNull();
      expect(source.match(PROVIDER_IDENTIFIER), relative).toBeNull();
      expect(source.match(RAIL_LITERAL), relative).toBeNull();
    }
  });

  test("CU8: the computer-use domain and ports stay pure", () => {
    // Comments may MENTION the rules; the CODE may not carry the imports
    // (the house discipline: strip comments before scanning imports).
    const codeOnly = (content: string): string =>
      content.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    for (const file of FILES) {
      const relative = file.replace(`${REPO_ROOT}/`, "");
      if (relative.includes("/domain/") || relative.includes("/ports/")) {
        const code = codeOnly(sourceOf(file));
        expect(code, `${relative}: no platform import`).not.toContain("src/platform/");
        expect(code, `${relative}: no node runtime import`).not.toMatch(
          /from "node:(crypto|fs|http|net|child_process|path)"/,
        );
        expect(code, `${relative}: no sdk import`).not.toMatch(
          /from "(playwright|selenium-webdriver|puppeteer)"/,
        );
      }
    }
    // The domain has no imports at all (pure).
    expect(DOMAIN_SOURCE.includes("import ")).toBe(false);
  });

  test("CU9: no second execution state machine (subordinate bookkeeping only)", () => {
    // The store port carries NO execution-transition vocabulary.
    for (const forbidden of [
      "authorize(",
      "transition(",
      "markCompleted(",
      "markFailed(",
      "updateExecutionStatus",
      "execution_status",
    ]) {
      expect(STORE_PORT.includes(forbidden), `store port must not carry "${forbidden}"`).toBe(
        false,
      );
    }
    // Computer-use provenance rides the canonical executions ledger with
    // the tools producer vocabulary ONLY (the frozen union on the ledger
    // event signature — no computer-use-specific event type exists).
    expect(
      SERVICE_SOURCE.includes('command: "tool-requested" | "tool-result" | "tool-denied",'),
    ).toBe(true);
    expect(SERVICE_SOURCE.includes('"computer-use-')).toBe(true);
    // The ledger adapter delegates to the executions PUBLIC seam only.
    const ledgerAdapter = read("adapters/execution-ledger.ts");
    expect(ledgerAdapter.includes("service.recordStepEvent(")).toBe(true);
    expect(ledgerAdapter.includes('from "../../executions/public"')).toBe(true);
    // No executions SQL anywhere in the tools tree (comments may MENTION
    // the discipline — the CODE may not carry the SQL).
    const codeOnly = (content: string): string =>
      content.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    for (const file of FILES) {
      expect(codeOnly(readFileSync(file, "utf8")), file.replace(`${REPO_ROOT}/`, "")).not.toContain(
        "executions.executions",
      );
    }
    // The session status vocabulary is CLOSED and subordinate.
    expect(DOMAIN_SOURCE).toMatch(
      /export const COMPUTER_USE_SESSION_STATUSES = \[\s*"denied",\s*"active",\s*"completed",\s*"failed",\s*"cancelled",\s*\] as const;/,
    );
  });

  test("CU10: the durable recoverable operation state is structural in the store port", () => {
    expect(methodNamesOf(STORE_PORT, "ComputerUseStore")).toContain("beginComputerUseOperation");
    expect(methodNamesOf(STORE_PORT, "ComputerUseStore")).toContain("recordOperationCheckpoint");
    expect(methodNamesOf(STORE_PORT, "ComputerUseStore")).toContain("completeOperation");
    expect(methodNamesOf(STORE_PORT, "ComputerUseStore")).toContain("failOperation");
    // The operation vocabulary is CLOSED.
    expect(DOMAIN_SOURCE.includes("export const COMPUTER_USE_OPERATION_KINDS = [")).toBe(true);
    expect(DOMAIN_SOURCE.includes('"session-create"')).toBe(true);
    expect(DOMAIN_SOURCE.includes('"budget-settle"')).toBe(true);
    // The stable key scheme derives from the session identity.
    expect(DOMAIN_SOURCE.includes("COMPUTER_USE_KEY_PREFIXES")).toBe(true);
    expect(DOMAIN_SOURCE.includes("cuop:session-create")).toBe(true);
    // The service routes every durable operation through the claim.
    expect(SERVICE_SOURCE.includes("beginComputerUseOperation")).toBe(true);
  });

  test("the simulated environment declares its honesty (no real browser/desktop rail)", () => {
    const simulated = read("adapters/simulated-computer-use-environment.ts");
    expect(simulated.includes("**HONESTY: this is a SIMULATED in-process environment.**")).toBe(
      true,
    );
    expect(simulated.includes("UNVERIFIED here")).toBe(true);
  });
});

function sourceOf(file: string): string {
  return readFileSync(file, "utf8");
}
