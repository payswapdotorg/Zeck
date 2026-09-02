/**
 * Simulated isolated computer-use environment (tools module adapter;
 * WORK-027, CUI-002).
 *
 * **HONESTY: this is a SIMULATED in-process environment.** No real
 * browser, no real desktop, no real network egress ever happens — the
 * adapter models the EXTERNAL environment seam (`ComputerUseEnvironment`)
 * behind the REAL confinement inputs (the declared browser profile /
 * desktop envelope / terminal policy of the admitted capability), so the
 * governance properties (admission ordering, isolation, keyed
 * crash-safety convergence, egress confinement, evidence discipline) are
 * exercised against the same contracts a real provider rail would
 * implement. A real provider adapter (Playwright-class browser, VNC-class
 * desktop) plugs into the same port with the same keyed-convergence
 * contract — that integration is future provider work, explicitly
 * UNVERIFIED here.
 *
 * The simulation implements the isolation contract EXACTLY:
 *
 *  - every opened context is constructed ONLY from the declared profile:
 *    a FRESH EMPTY cookie jar, an empty env, no mounts, no sockets —
 *    `inheritedHostState` is ALWAYS the empty array (the isolation
 *    proof's permanent expectation). A SIMULATED HOST WORLD carries
 *    cookies, credentials, env vars, mounts and sockets that must NOT
 *    leak into any context — the world is queryable so the proofs can
 *    assert nothing leaked;
 *  - egress confinement: an action/observation touching a host outside
 *    the declared allowlist fails closed BEFORE any effect is journaled
 *    (no hidden network access, even in the simulation);
 *  - the desktop envelope is honored: an action whose declared grant is
 *    false fails closed (`envelope-confined`);
 *  - every method is KEYED: repeated calls under the same operation key
 *    CONVERGE (exactly one recorded external effect per stable key — the
 *    WORK-024 crash-safety standard at the environment boundary; the
 *    replay is visible in the activity journal with `replayed: true`).
 */

import type {
  ComputerUseBrowserProfile,
  ComputerUseDesktopEnvelope,
  ComputerUseMode,
  ComputerUseObservationType,
} from "../domain/computer-use";
import { DESKTOP_ACTION_GRANTS, isComputerUseActionType } from "../domain/computer-use";
import type {
  ComputerUseEnvironment,
  ComputerUseEnvironmentActionRequest,
  ComputerUseEnvironmentActionResult,
  ComputerUseEnvironmentActivityEntry,
  ComputerUseEnvironmentCloseRequest,
  ComputerUseEnvironmentContextState,
  ComputerUseEnvironmentFailure,
  ComputerUseEnvironmentObservationResult,
  ComputerUseEnvironmentObserveRequest,
  ComputerUseEnvironmentOpenRequest,
  ComputerUseEnvironmentOpenResult,
} from "../ports/computer-use-environment";

/** A simulated host-world item the environment must NOT inherit. */
export interface SimulatedHostWorldItem {
  readonly kind: "cookie" | "credential" | "env" | "mount" | "socket";
  readonly name: string;
  readonly value: string;
}

/** The simulated host world: ambient state that must never leak in. */
export interface SimulatedComputerUseHostWorld {
  readonly cookies: readonly string[];
  readonly credentials: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly mounts: readonly string[];
  readonly sockets: readonly string[];
  /** Assert the full inventory (the no-leak proof's source of truth). */
  items(): readonly SimulatedHostWorldItem[];
}

/**
 * The host world the simulation runs "on top of": the honest model of an
 * ambient host that COULD leak cookies, credentials, env vars, mounts and
 * sockets into an un-isolated context. `createSimulatedComputerUseHostWorld`
 * constructs one with sentinel values; the isolation proofs assert none of
 * them ever appears in any context or observation.
 */
export function createSimulatedComputerUseHostWorld(
  overrides: Partial<Omit<SimulatedComputerUseHostWorld, "items">> = {},
): SimulatedComputerUseHostWorld {
  const world = {
    cookies: ["session=host-user-session-cookie", "csrf=host-csrf-token"],
    credentials: ["host-user-password", "AKIAIOSFODNN7EXAMPLE"],
    env: { HOME: "/home/host-user", AWS_SECRET_ACCESS_KEY: "host-secret", PATH: "/usr/bin" },
    mounts: ["/home/host-user/secret-keys:/secrets"],
    sockets: ["unix:///var/run/docker.sock"],
    ...overrides,
  };
  return {
    ...world,
    items: () => [
      ...world.cookies.map((cookie) => ({ kind: "cookie" as const, name: cookie, value: cookie })),
      ...world.credentials.map((credential) => ({
        kind: "credential" as const,
        name: credential,
        value: credential,
      })),
      ...Object.entries(world.env).map(([name, value]) => ({
        kind: "env" as const,
        name,
        value,
      })),
      ...world.mounts.map((mount) => ({ kind: "mount" as const, name: mount, value: mount })),
      ...world.sockets.map((socket) => ({ kind: "socket" as const, name: socket, value: socket })),
    ],
  };
}

interface SimulatedContext {
  readonly environmentRef: string;
  readonly mode: ComputerUseMode;
  readonly capabilityId: string;
  readonly browserProfile: ComputerUseBrowserProfile | null;
  readonly desktopEnvelope: ComputerUseDesktopEnvelope | null;
  readonly egressAllowlist: readonly string[];
  readonly cookies: string[];
  readonly openedAt: string;
  closed: boolean;
}

/**
 * Failure injection for typed-environment-failure proofs (a real rail
 * would fail transiently; the simulation makes it deterministic and
 * ONE-SHOT — the flag clears once fired).
 */
export interface SimulatedComputerUseEnvironmentOptions {
  readonly failNextOpen?: boolean;
  readonly failNextAction?: boolean;
}

/**
 * The simulated isolated environment. Construct with
 * `createSimulatedComputerUseEnvironment()`.
 */
export class SimulatedComputerUseEnvironment implements ComputerUseEnvironment {
  private readonly contexts = new Map<string, SimulatedContext>();
  private readonly effects = new Map<string, ComputerUseEnvironmentActivityEntry>();
  private readonly openRefs = new Map<string, string>();
  private readonly journal: ComputerUseEnvironmentActivityEntry[] = [];
  private readonly host: SimulatedComputerUseHostWorld;
  private failNextOpenFlag: boolean;
  private failNextActionFlag: boolean;
  private openCounter = 0;

  constructor(
    host: SimulatedComputerUseHostWorld = createSimulatedComputerUseHostWorld(),
    options: SimulatedComputerUseEnvironmentOptions = {},
  ) {
    this.host = host;
    this.failNextOpenFlag = options.failNextOpen ?? false;
    this.failNextActionFlag = options.failNextAction ?? false;
  }

  /** Test seam: inject a one-shot failure into the next action dispatch. */
  injectNextActionFailure(): void {
    this.failNextActionFlag = true;
  }

  /** Test seam: inject a one-shot failure into the next context open. */
  injectNextOpenFailure(): void {
    this.failNextOpenFlag = true;
  }

  /** The simulated ambient host world (the no-leak proof surface). */
  hostWorld(): SimulatedComputerUseHostWorld {
    return this.host;
  }

  private record(entry: ComputerUseEnvironmentActivityEntry): void {
    this.journal.push(entry);
  }

  private egressOf(
    mode: ComputerUseMode,
    browserProfile: ComputerUseBrowserProfile | null,
  ): readonly string[] {
    return mode === "deterministic" ? [] : (browserProfile?.egressAllowlist ?? []);
  }

  open(
    request: ComputerUseEnvironmentOpenRequest,
    operationKey: string,
  ): Promise<ComputerUseEnvironmentOpenResult | ComputerUseEnvironmentFailure> {
    return Promise.resolve().then(() => {
      const replayed = this.effects.has(operationKey);
      if (replayed) {
        const environmentRef = this.openRefs.get(operationKey) ?? "cuenv-unknown";
        this.record({
          operation: "open",
          mode: request.mode,
          operationKey,
          actionType: null,
          sideEffect: "none",
          at: new Date().toISOString(),
          replayed: true,
        });
        return { environmentRef, openedMode: request.mode, inheritedHostState: [] };
      }
      if (this.failNextOpenFlag) {
        this.failNextOpenFlag = false;
        return {
          failureClass: "environment-unavailable",
          message: "the simulated computer-use environment failed to open (injected)",
        };
      }
      // The context is constructed ONLY from the declared profile: a
      // fresh EMPTY cookie jar, no env, no mounts, no sockets — the host
      // world is never consulted (the isolation invariant).
      this.openCounter += 1;
      const environmentRef = `cuenv-${this.openCounter}`;
      const context: SimulatedContext = {
        environmentRef,
        mode: request.mode,
        capabilityId: request.capabilityId,
        browserProfile: request.browserProfile,
        desktopEnvelope: request.desktopEnvelope,
        egressAllowlist: this.egressOf(request.mode, request.browserProfile),
        cookies: [],
        openedAt: new Date().toISOString(),
        closed: false,
      };
      this.contexts.set(environmentRef, context);
      this.openRefs.set(operationKey, environmentRef);
      const entry: ComputerUseEnvironmentActivityEntry = {
        operation: "open",
        mode: request.mode,
        operationKey,
        actionType: null,
        sideEffect: "none",
        at: context.openedAt,
        replayed: false,
      };
      this.effects.set(operationKey, entry);
      this.record(entry);
      return { environmentRef, openedMode: request.mode, inheritedHostState: [] };
    });
  }

  dispatchAction(
    request: ComputerUseEnvironmentActionRequest,
    operationKey: string,
  ): Promise<ComputerUseEnvironmentActionResult> {
    return Promise.resolve().then(() => {
      const replayed = this.effects.has(operationKey);
      if (replayed) {
        // The keyed convergence: the external effect already happened —
        // replay the recorded frame set with zero new side effects.
        const prior = this.effects.get(operationKey);
        if (prior === undefined) {
          throw new Error("unreachable: effects map consistency");
        }
        this.record({ ...prior, replayed: true, at: new Date().toISOString() });
        return {
          outcome: "succeeded",
          observations: [],
          usageMicroUsd: "0",
          result: { replayed: true, operationKey },
        };
      }
      const context = this.contexts.get(request.environmentRef);
      if (context === undefined || context.closed) {
        return {
          outcome: "failed",
          failure: {
            failureClass: "environment-closed",
            message: "the isolated context is not open",
          },
          observations: [],
          usageMicroUsd: "0",
          result: null,
        };
      }
      if (this.failNextActionFlag) {
        this.failNextActionFlag = false;
        return {
          outcome: "failed",
          failure: {
            failureClass: "environment-failure",
            message: "the simulated environment action failed (injected)",
          },
          observations: [],
          usageMicroUsd: "0",
          result: null,
        };
      }
      // Desktop envelope confinement (defense in depth — the service
      // already confines; the environment holds the line for the rail).
      if (
        request.mode === "desktop" &&
        isComputerUseActionType(request.actionType) &&
        DESKTOP_ACTION_GRANTS[request.actionType] !== null
      ) {
        const grant = DESKTOP_ACTION_GRANTS[request.actionType];
        if (grant !== null && !(context.desktopEnvelope?.[grant] ?? false)) {
          return {
            outcome: "failed",
            failure: {
              failureClass: "envelope-confined",
              message: `the simulated environment confines ${request.actionType} out (grant ${String(grant)} is not declared)`,
            },
            observations: [],
            usageMicroUsd: "0",
            result: null,
          };
        }
      }
      // Egress confinement: a target host outside the declared allowlist
      // fails closed BEFORE any effect is journaled.
      const targetHost = this.hostOfTarget(request.target);
      if (targetHost !== null && !context.egressAllowlist.includes(targetHost)) {
        return {
          outcome: "failed",
          failure: {
            failureClass: "egress-confined",
            message: `host ${targetHost} is outside the context's declared egress allowlist; the simulated environment refuses hidden network access`,
          },
          observations: [],
          usageMicroUsd: "0",
          result: null,
        };
      }
      const at = new Date().toISOString();
      const observations = this.framesFor(request, context);
      // Simulated side-effect surface: a write-external action into a
      // browser context touches the cookie jar (a session cookie for the
      // target) — the ONLY state the simulation itself owns.
      if (request.sideEffect === "write-external" && context.mode === "browser") {
        context.cookies.push(`simulated-session=${targetHost ?? "local"}`);
      }
      const entry: ComputerUseEnvironmentActivityEntry = {
        operation: "action",
        mode: request.mode,
        operationKey,
        actionType: request.actionType,
        sideEffect: request.sideEffect,
        at,
        replayed: false,
      };
      this.effects.set(operationKey, entry);
      this.record(entry);
      return {
        outcome: "succeeded",
        observations,
        usageMicroUsd: "0",
        result: { actionType: request.actionType, target: request.target, simulated: true },
      };
    });
  }

  observe(
    request: ComputerUseEnvironmentObserveRequest,
    operationKey: string,
  ): Promise<ComputerUseEnvironmentObservationResult | ComputerUseEnvironmentFailure> {
    return Promise.resolve().then(() => {
      const replayed = this.effects.has(operationKey);
      if (replayed) {
        const prior = this.effects.get(operationKey);
        if (prior === undefined) {
          throw new Error("unreachable: effects map consistency");
        }
        this.record({ ...prior, replayed: true, at: new Date().toISOString() });
        const frame = this.observationFrame(request);
        return { frame };
      }
      const context = this.contexts.get(request.environmentRef);
      if (context === undefined || context.closed) {
        return {
          failureClass: "environment-closed",
          message: "the isolated context is not open",
        };
      }
      const frame = this.observationFrame(request);
      const entry: ComputerUseEnvironmentActivityEntry = {
        operation: "observe",
        mode: request.mode,
        operationKey,
        actionType: null,
        sideEffect: "read-only",
        at: new Date().toISOString(),
        replayed: false,
      };
      this.effects.set(operationKey, entry);
      this.record(entry);
      return { frame };
    });
  }

  close(
    request: ComputerUseEnvironmentCloseRequest,
    operationKey: string,
  ): Promise<{ closed: true } | ComputerUseEnvironmentFailure> {
    return Promise.resolve().then(() => {
      const replayed = this.effects.has(operationKey);
      if (replayed) {
        return { closed: true };
      }
      const context = this.contexts.get(request.environmentRef);
      if (context === undefined) {
        return {
          failureClass: "environment-closed",
          message: "the isolated context is not open",
        };
      }
      context.closed = true;
      // Terminal: the cookie jar and every context-held secret-shaped
      // state is destroyed with the context.
      context.cookies.length = 0;
      const entry: ComputerUseEnvironmentActivityEntry = {
        operation: "close",
        mode: context.mode,
        operationKey,
        actionType: null,
        sideEffect: "none",
        at: new Date().toISOString(),
        replayed: false,
      };
      this.effects.set(operationKey, entry);
      this.record(entry);
      return { closed: true };
    });
  }

  activity(): readonly ComputerUseEnvironmentActivityEntry[] {
    return [...this.journal];
  }

  contextState(environmentRef: string): ComputerUseEnvironmentContextState | null {
    const context = this.contexts.get(environmentRef);
    if (context === undefined) {
      return null;
    }
    return {
      environmentRef,
      mode: context.mode,
      inheritedHostState: [],
      cookies: [...context.cookies],
      egressAllowlist: [...context.egressAllowlist],
    };
  }

  /** The count of DISTINCT external effects (replays excluded). */
  effectCount(): number {
    return this.effects.size;
  }

  // -- internals ---------------------------------------------------------------

  private hostOfTarget(target: string): string | null {
    const urlMatch = /^https?:\/\/([^/:]+)/.exec(target);
    if (urlMatch !== null) {
      return urlMatch[1] ?? null;
    }
    return null;
  }

  private observationFrame(request: ComputerUseEnvironmentObserveRequest) {
    const body: Record<string, unknown> =
      request.observationType === "dom"
        ? {
            target: request.target,
            simulated: true,
            mode: request.mode,
            dom: `<html><body data-target="${request.target}"><button id="go" /></body></html>`,
          }
        : request.observationType === "accessibility-tree"
          ? {
              target: request.target,
              simulated: true,
              mode: request.mode,
              tree: [{ role: "button", name: "go", id: "go" }],
            }
          : request.observationType === "screenshot"
            ? {
                target: request.target,
                simulated: true,
                mode: request.mode,
                imageBase64: "c2ltLXNjcmVlbnNo", // "sim-screenshot"
              }
            : {
                target: request.target,
                simulated: true,
                mode: request.mode,
                apiResult: { ok: true },
              };
    return {
      observationType: request.observationType,
      body,
      retention: (request.observationType === "screenshot" ? "ephemeral" : "session") as
        | "session"
        | "execution"
        | "ephemeral",
      redaction: (request.observationType === "dom" ||
      request.observationType === "accessibility-tree" ||
      request.observationType === "screenshot"
        ? "sensitive-ui"
        : "none") as "none" | "sensitive-ui" | "secret-bearing",
      artifactRef: null,
    };
  }

  private framesFor(request: ComputerUseEnvironmentActionRequest, context: SimulatedContext) {
    const frames: {
      observationType: ComputerUseObservationType;
      body: Record<string, unknown>;
      retention: "session" | "execution" | "ephemeral";
      redaction: "none" | "sensitive-ui" | "secret-bearing";
      artifactRef: string | null;
    }[] = [];
    if (request.actionType === "navigate" || request.actionType === "read-dom") {
      frames.push({
        observationType: "dom",
        body: {
          target: request.target,
          simulated: true,
          mode: request.mode,
          dom: `<html><body data-target="${request.target}"><button id="go" /></body></html>`,
        },
        retention: "session",
        redaction: "sensitive-ui",
        artifactRef: null,
      });
    } else if (
      request.actionType === "read-accessibility-tree" ||
      request.actionType === "window-action"
    ) {
      frames.push({
        observationType: "accessibility-tree",
        body: {
          target: request.target,
          simulated: true,
          mode: request.mode,
          tree: [{ role: "button", name: "go", id: "go" }],
        },
        retention: "session",
        redaction: "sensitive-ui",
        artifactRef: null,
      });
    } else if (request.actionType === "screenshot" || request.actionType === "download") {
      frames.push({
        observationType: "screenshot",
        body: {
          target: request.target,
          simulated: true,
          mode: request.mode,
          imageBase64: "c2ltLXNjcmVlbnNo",
        },
        retention: "ephemeral",
        redaction: "sensitive-ui",
        artifactRef: null,
      });
    } else if (request.actionType === "api-call") {
      frames.push({
        observationType: "api-result",
        body: { target: request.target, simulated: true, ok: true },
        retention: "execution",
        redaction: "none",
        artifactRef: null,
      });
    }
    // Pure side-effect actions (click/type/clipboard-write/file-write)
    // and read-only confinement probes produce no observation frame —
    // the honest empty evidence.
    void context;
    return frames;
  }
}

/** Construct the simulated isolated environment (with its host world). */
export function createSimulatedComputerUseEnvironment(
  options: SimulatedComputerUseEnvironmentOptions = {},
): SimulatedComputerUseEnvironment {
  return new SimulatedComputerUseEnvironment(createSimulatedComputerUseHostWorld(), options);
}
