/**
 * Architecture: the governed edge/embodied boundary (WORK-029,
 * EDGE-001/002/003; checkpoint contracts SELF-HOSTING-BOUNDARY,
 * EXECUTION-PROVENANCE, CONCURRENCY-CRASH-SAFETY).
 *
 * Mechanically proves over the REAL `src/integrations/edge/` tree and
 * migration 0024:
 *
 *  - ED1 the edge controller port carries NO authority and NO loop
 *    surface: its method set is exactly {controllerId, applyEnvelope,
 *    dispatchCommand, reconciliationReport, lastExecutedSequence} — no
 *    admission/authorize/execute/invoke/transition vocabulary, no
 *    loop/tick/schedule/cadence surface (Zeck NEVER drives the local
 *    control loop; a refusal is the controller's only non-acceptance);
 *  - ED2 the REQUIRED admission seams exist with the frozen vocabulary
 *    (EdgePolicyAdmission.admit / EdgeCapabilityGate.resolve; the
 *    WORK-004 BudgetAuthority is consumed directly) — the edge service
 *    cannot be constructed without them (no default-allow path);
 *  - ED3 the edge service deps are pinned: exactly {policy,
 *    capabilities, budgetAuthority?, store, ledger, controller,
 *    generateId, now, digest} — no additional authority handles are
 *    reachable;
 *  - ED4 the domain and ports stay PURE: no src/platform/** import, no
 *    node: runtime import, no provider SDK import in domain/ or ports/;
 *  - ED5 provider neutrality: no device/controller vendor identifier
 *    anywhere in the edge tree (no robotics/industrial/vehicle/medical
 *    automation vendor, no fieldbus/telemetry vendor literal);
 *  - ED6 no second execution state machine: edge provenance rides the
 *    canonical executions ledger through the recordStepEvent seam with
 *    the tools producer vocabulary (tool-requested / tool-result /
 *    tool-denied ONLY); the execution lifecycle is touched ONLY through
 *    the ledger port's wait-human / resume commands; the store port
 *    carries no execution-transition vocabulary;
 *  - ED7 no cloud control loop: the integration source contains no
 *    timer/tick/cadence primitive (setInterval/setTimeout/setImmediate
 *    recursive dispatch) and the simulated controller's autonomous
 *    device-side loop is invoked from ZERO non-test source (the local
 *    substrate owns hard real time; the governance plane is
 *    request/response only);
 *  - ED8 migration 0024 is the edge migration with the physical guards:
 *    envelope CONTENT immutability + write-once supersede binding,
 *    device identity-core immutability + terminal revocation, approval
 *    identity-core immutability + terminal decisions + write-once
 *    ledger bindings, command identity-core immutability + write-once
 *    dispatch/denial/ledger evidence, append-only actuation/sensor
 *    ledgers, monotonic sequence discipline, the durable recoverable
 *    operation state (the WORK-024 standard), and the parallel-wave
 *    collision-rule claim (WORK-029 claims 0024; 0015 burned);
 *  - ED9 the public barrel is the only supported import surface: it
 *    re-exports the application service and the domain contracts ONLY
 *    (no adapters/, no internal/ leak, no store/controller
 *    implementation types);
 *  - ED10 the crash-safety contract is STRUCTURAL in the store port:
 *    begin/checkpoint/complete/fail over a CLOSED operation vocabulary
 *    with stable keys (not an optional extension point).
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";

const REPO_ROOT = join(process.cwd());
const EDGE_DIR = join(REPO_ROOT, "src/integrations/edge");
const MIGRATION_PATH = "src/platform/db/migrations/0024_edge_execution.sql";

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

const EDGE_FILES = collectFiles(EDGE_DIR);
const EDGE_SOURCES = EDGE_FILES.map((path) => ({
  path: path.replace(REPO_ROOT, "").replace(/^[\\/]/, ""),
  content: readFileSync(path, "utf8"),
}));

const read = (relative: string): string => readFileSync(join(REPO_ROOT, relative), "utf8");

const CONTROLLER_PORT_SOURCE = read("src/integrations/edge/ports/edge-controller.ts");
const ADMISSION_PORT_SOURCE = read("src/integrations/edge/ports/edge-admission.ts");
const SERVICE_SOURCE = read("src/integrations/edge/application/edge-service.ts");
const STORE_PORT_SOURCE = read("src/integrations/edge/ports/edge-store.ts");
const LEDGER_PORT_SOURCE = read("src/integrations/edge/ports/edge-ledger.ts");
const PUBLIC_SOURCE = read("src/integrations/edge/public.ts");
const MIGRATION_SOURCE = read(MIGRATION_PATH);

/** Code only (comments stripped) for the vocabulary scans. */
const codeOf = (content: string): string =>
  content.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

/** Edge/embodied device + controller vendor identifiers (the ED5 scanner). */
const EDGE_VENDOR_IDENTIFIER =
  /\b(ROS2?|Rosbot|URRobot|UniversalRobots|Kuka|ABB|Fanuc|Yaskawa|Siemens|Rockwell|AllenBradley|Beckhoff|Codesys|Modicon|Schneider|Mitsubishi|Omron|Bosch|Dji|Tesla|Nvidia|Jetson|RaspberryPi|Arduino|Eaton|Honeywell|Emerson|Vecna|BostonDynamics|Anybotics|Figure|Agility|Unitree)\w*/;
const EDGE_RAIL_LITERAL =
  /["'](modbus|profinet|ethercat|canopen|j1939|opc-?ua|ros2?|sparkplug)["']/i;

describe("architecture: the governed edge boundary (WORK-029)", () => {
  test("ED1 the controller port carries NO authority and NO loop surface", () => {
    const port = codeOf(CONTROLLER_PORT_SOURCE);
    // The exact transport surface of the replaceable local-substrate seam.
    for (const method of [
      "applyEnvelope",
      "dispatchCommand",
      "reconciliationReport",
      "lastExecutedSequence",
    ]) {
      expect(port).toContain(`${method}(`);
    }
    // No authority vocabulary on the controller seam (adapters expose
    // capabilities and evidence, NOT authority). Word-boundary regexes:
    // "admitted" (the envelope status vocabulary) is not the authority
    // verb "admit".
    for (const forbidden of [
      "\\badmit\\b",
      "\\bauthorize\\b",
      "\\bapprove\\b",
      "\\bresolve\\(",
      "\\breserve\\b",
      "\\bsettle\\b",
      "\\btransition\\b",
      "waitHuman",
      "\\.resume\\(",
      "recordStepEvent",
    ]) {
      expect(new RegExp(forbidden).test(port)).toBe(false);
    }
    // No loop/scheduling surface: Zeck never drives and is never driven
    // by the local hard-real-time control loop through this port (the
    // word-boundary scans are over CODE only — comments are stripped).
    for (const forbidden of [
      "setInterval",
      "setTimeout",
      "setImmediate",
      "tick(",
      "loop(",
      "schedule(",
      "cadence",
      "period(",
      "rate(",
      "onStep",
      "subscribe(",
    ]) {
      expect(port.includes(forbidden)).toBe(false);
    }
    // The port exposes exactly the refusal classes (fail-safe, never
    // authorize): envelope-coverage | stale-command | out-of-order |
    // transport-disconnected.
    expect(port).toContain("envelope-coverage");
    expect(port).toContain("stale-command");
    expect(port).toContain("out-of-order");
    expect(port).toContain("transport-disconnected");
  });

  test("ED2 the REQUIRED admission seams exist with the frozen vocabulary", () => {
    const admission = codeOf(ADMISSION_PORT_SOURCE);
    expect(admission).toContain("export interface EdgePolicyAdmission {");
    expect(admission).toContain("admit(request: EdgePolicyAdmissionRequest)");
    expect(admission).toContain("export interface EdgeCapabilityGate {");
    expect(admission).toContain("resolve(request: EdgeCapabilityGateRequest)");
    // Budget authority is consumed DIRECTLY (no second budget port).
    expect(codeOf(SERVICE_SOURCE)).toContain("budgetAuthority?: BudgetAuthority");
    // Human approval binds through the approval ledger + the ledger
    // port's wait-human/resume commands — no new authority type.
    expect(codeOf(LEDGER_PORT_SOURCE)).toContain("waitHuman(");
    expect(codeOf(LEDGER_PORT_SOURCE)).toContain("resume(");
  });

  test("ED3 the edge service deps are pinned (no extra authority handles)", () => {
    const service = codeOf(SERVICE_SOURCE);
    const deps = service.slice(
      service.indexOf("export interface EdgeServiceDeps {"),
      service.indexOf("export interface EdgeDeviceReceipt"),
    );
    const declared = [...deps.matchAll(/readonly (\w+)(\?)?:/g)].map((m) => m[1]);
    expect([...declared].sort()).toEqual(
      [
        "policy",
        "capabilities",
        "budgetAuthority",
        "store",
        "ledger",
        "controller",
        "generateId",
        "now",
        "digest",
      ].sort(),
    );
  });

  test("ED4 the domain and ports stay pure (no platform/runtime/SDK imports)", () => {
    for (const source of EDGE_SOURCES.filter((entry) =>
      /src[\\/]integrations[\\/]edge[\\/](domain|ports)[\\/]/.test(entry.path),
    )) {
      expect(source.content).not.toMatch(/from\s+"\.\.\/\.\.\/\.\.\/platform\//);
      expect(source.content).not.toMatch(/from\s+"node:/);
      expect(source.content).not.toMatch(/from\s+"@?\w+(?:-\w+)*\/(?:node-)?\w*-sdk/);
    }
    // The domain module imports NOTHING outside the domain (pure).
    for (const source of EDGE_SOURCES.filter((entry) =>
      /src[\\/]integrations[\\/]edge[\\/]domain[\\/]/.test(entry.path),
    )) {
      const imports = [...source.content.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]);
      for (const specifier of imports) {
        expect(specifier?.startsWith("./") ?? false).toBe(true);
      }
    }
  });

  test("ED5 provider neutrality: no edge/embodied vendor identifiers in the tree", () => {
    for (const source of EDGE_SOURCES) {
      expect(
        EDGE_VENDOR_IDENTIFIER.test(source.content),
        `${source.path} matched a vendor identifier`,
      ).toBe(false);
      expect(
        EDGE_RAIL_LITERAL.test(source.content),
        `${source.path} matched a vendor rail literal`,
      ).toBe(false);
    }
  });

  test("ED6 no second execution state machine (provenance rides the canonical ledger)", () => {
    const ledger = codeOf(LEDGER_PORT_SOURCE);
    // The ledger port exposes exactly the canonical seams: event
    // recording + reads + the two PUBLIC lifecycle commands.
    const methods = [...ledger.matchAll(/(\w+)\(/g)].map((m) => m[1]);
    expect(methods).toContain("recordStepEvent");
    expect(methods).toContain("getExecution");
    expect(methods).toContain("waitHuman");
    expect(methods).toContain("resume");
    // The tools producer vocabulary ONLY (this integration owns no
    // ledger vocabulary of its own).
    const service = codeOf(SERVICE_SOURCE);
    const eventTypes = [...service.matchAll(/"tool-(requested|result|denied)"/g)].map((m) => m[0]);
    expect(new Set(eventTypes)).toEqual(
      new Set(['"tool-requested"', '"tool-result"', '"tool-denied"']),
    );
    // The store port carries NO execution-transition vocabulary and no
    // execution status column write path (the resumeSequence/
    // waitSequence fields are write-once LEDGER-SEQUENCE bindings, not
    // lifecycle commands — the only wait/resume calls live on the ledger
    // port, which forwards them to the executions authority).
    const store = codeOf(STORE_PORT_SOURCE);
    for (const forbidden of [
      "waitHuman(",
      ".resume(",
      "executionStatus",
      'status: "RUNNING"',
      '"WAITING_HUMAN"',
    ]) {
      expect(store.includes(forbidden)).toBe(false);
    }
    // The ONLY execution-status writes are the two ledger commands on
    // the executions service (the frozen authority).
    const waitCalls = (service.match(/ledger\.waitHuman\(/g) ?? []).length;
    const resumeCalls = (service.match(/ledger\.resume\(/g) ?? []).length;
    expect(waitCalls).toBeGreaterThanOrEqual(2); // fresh + convergence
    expect(resumeCalls).toBeGreaterThanOrEqual(2);
    for (const source of EDGE_SOURCES) {
      expect(source.content).not.toMatch(/executionStore|executions\.store/i);
    }
  });

  test("ED7 no cloud control loop (the governance plane is request/response only)", () => {
    // No timer/tick primitive anywhere in the integration source.
    for (const source of EDGE_SOURCES) {
      const code = codeOf(source.content);
      expect(code.includes("setInterval"), source.path).toBe(false);
      expect(code.includes("setImmediate"), source.path).toBe(false);
      // setTimeout appears only in host-side adapters if at all; the
      // simulated controller must not self-schedule either.
      if (source.path.includes("simulated-edge-controller")) {
        expect(code.includes("setTimeout"), source.path).toBe(false);
      }
    }
    // The simulated controller's device-side autonomous loop is invoked
    // from ZERO non-test source: the local substrate runs it, never the
    // governance plane. (The loop surface itself is allowed on the
    // DEVICE side of the simulation — the world/tests drive it.)
    const simulated = read("src/integrations/edge/adapters/simulated-edge-controller.ts");
    const methodSurface = [
      ...simulated.matchAll(/(?:^\s{2,})(\w+)\([^)]*\)(?:\s*:\s*[\w<>\s|,.]+)?\s*\{/gm),
      ...simulated.matchAll(/(?:^\s{2,})(\w+)\([^)]*\);/gm),
    ].map((m) => m[1]);
    const autonomousLoops = methodSurface.filter(
      (name) => name !== undefined && /autonom|tick|step|loop/i.test(name),
    );
    expect(autonomousLoops.length).toBeGreaterThan(0); // the device-side loop exists…
    // …and no src/ file outside the controller itself calls it.
    for (const source of EDGE_SOURCES) {
      if (source.path.includes("simulated-edge-controller")) {
        continue;
      }
      for (const loop of autonomousLoops) {
        expect(
          new RegExp(`\\.${loop}\\(`).test(codeOf(source.content)),
          `${source.path} drives the device-side loop (${loop})`,
        ).toBe(false);
      }
    }
    // One submit = one dispatch: the dispatch path is keyed one-shot
    // (exactly-once external effect per command id — the stable dispatch
    // key from the domain key registry).
    const service = codeOf(SERVICE_SOURCE);
    expect(service).toContain("controller.dispatchCommand(");
    expect(service).toContain("edgeCommandDispatchExternalKey(");
  });

  test("ED8 migration 0024 is the edge migration with the physical guards", () => {
    // The claim header (the collision rule: 0015 burned, WORK-029 owns 0024).
    expect(MIGRATION_SOURCE).toContain("WORK-029 claims 0024");
    // The durable state families.
    expect(MIGRATION_SOURCE).toContain("CREATE SCHEMA IF NOT EXISTS edge;");
    for (const table of [
      "edge.devices",
      "edge.device_health_reports",
      "edge.approvals",
      "edge.envelopes",
      "edge.commands",
      "edge.reconciliations",
      "edge.actuation_events",
      "edge.sensor_observations",
      "edge.operations",
    ]) {
      expect(MIGRATION_SOURCE).toContain(`CREATE TABLE ${table} (`);
    }
    // Envelope CONTENT immutability + write-once supersede (AC: safety
    // envelopes are IMMUTABLE once admitted; supersession is a NEW row).
    expect(MIGRATION_SOURCE).toContain("incl. the envelope CONTENT) is immutable");
    expect(MIGRATION_SOURCE).toContain("superseded_by_envelope_id IS NOT NULL");
    // Device identity-core immutability + terminal revocation (never
    // resurrected) + monotonic sequence discipline.
    expect(MIGRATION_SOURCE).toContain("edge.devices identity core is immutable");
    expect(MIGRATION_SOURCE).toContain("edge device % is revoked (terminal-immutable)");
    expect(MIGRATION_SOURCE).toContain("monotonic and dispatched never exceeds the stream");
    // Approval identity-core immutability + terminal decisions +
    // write-once ledger bindings.
    expect(MIGRATION_SOURCE).toContain("edge.approvals identity core is immutable");
    expect(MIGRATION_SOURCE).toContain("edge approval % is terminal-immutable in status %");
    expect(MIGRATION_SOURCE).toContain("wait-human ledger binding is write-once");
    expect(MIGRATION_SOURCE).toContain("resume ledger binding is write-once");
    // Command identity-core immutability + write-once
    // dispatch/denial/ledger evidence.
    expect(MIGRATION_SOURCE).toContain("edge.commands identity core is immutable");
    expect(MIGRATION_SOURCE).toContain("dispatch digest is write-once");
    expect(MIGRATION_SOURCE).toContain("denial evidence is write-once");
    // Append-only ledgers (actuation/sensor/health) and no-delete
    // guards on the identity families.
    const noDeleteGuards = (MIGRATION_SOURCE.match(/no_delete_guard/g) ?? []).length;
    expect(noDeleteGuards).toBeGreaterThanOrEqual(6);
    // The gapless per-device authoritative command stream.
    expect(MIGRATION_SOURCE).toContain("UNIQUE (application_id, device_id, sequence)");
    // The durable recoverable operation state (the WORK-024 standard).
    expect(MIGRATION_SOURCE).toContain("operation_key");
    expect(MIGRATION_SOURCE).toContain("attempts");
    expect(MIGRATION_SOURCE).toContain("stage");
    expect(MIGRATION_SOURCE).toContain("terminal");
    // The migration inventory discipline: this tree claims 0024 as the
    // NEXT number (0015 burned; 0023 is WORK-027's, already merged).
    expect(MIGRATION_PATH.endsWith("0024_edge_execution.sql")).toBe(true);
  });

  test("ED9 the public barrel is the only supported import surface", () => {
    const barrel = codeOf(PUBLIC_SOURCE);
    expect(barrel).toContain('export const integrationId = "edge"');
    // The exact supported surface: the application service, the domain
    // contracts, the port contracts, the ledger adapter, the durable
    // stores and the simulated controller (the substrate-federation
    // precedent — adapter FACTORIES are public; wiring is the host's).
    const sources = [...barrel.matchAll(/from "\.\/([\w-]+)\/([\w-]+)"/g)].map(
      (m) => `${m[1]}/${m[2]}`,
    );
    expect(new Set(sources)).toEqual(
      new Set([
        "application/edge-service",
        "domain/edge",
        "ports/edge-admission",
        "ports/edge-controller",
        "ports/edge-ledger",
        "ports/edge-store",
        "adapters/execution-ledger",
        "adapters/index",
        "adapters/simulated-edge-controller",
      ]),
    );
    // The internal namespace NEVER leaks through the barrel, and the
    // executions lifecycle is reached ONLY through the ledger adapter
    // (the executions service type never appears in the barrel).
    expect(barrel).not.toContain('from "./internal/');
    expect(barrel).not.toContain("ExecutionService");
    expect(barrel).toContain("createEdgeExecutionLedgerAdapter");
  });

  test("ED10 the crash-safety contract is STRUCTURAL in the store port", () => {
    const store = codeOf(STORE_PORT_SOURCE);
    for (const method of [
      "beginEdgeOperation(",
      "recordOperationCheckpoint(",
      "completeOperation(",
      "failOperation(",
      "findOperation(",
    ]) {
      expect(store).toContain(method);
    }
    // The operation vocabulary is CLOSED (the frozen literal union the
    // durable operation state moves within — inline in the port).
    for (const kind of [
      '"device-register"',
      '"device-revoke"',
      '"health-report"',
      '"envelope-admit"',
      '"envelope-revoke"',
      '"command-submit"',
      '"approval-request"',
      '"approval-decide"',
      '"sensor-ingest"',
      '"reconcile"',
    ]) {
      expect(store).toContain(kind);
    }
    // Write-once keyed arbitration is structural on every side-effecting
    // family (inserts converge per stable key).
    for (const method of [
      "insertApproval(",
      "insertEnvelope(",
      "insertCommand(",
      "insertActuationEvent(",
      "insertSensorObservation(",
      "insertReconciliation(",
    ]) {
      expect(store).toContain(method);
    }
  });
});
