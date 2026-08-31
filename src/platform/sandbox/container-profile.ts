/**
 * Container security profile + escape validator (platform sandbox seam;
 * WORK-012, ENV-002 — acceptance criterion 5).
 *
 * The provider-neutral CONTAINER CONFIGURATION MODEL the sandbox module's
 * container provider builds and validates before any runtime client may
 * receive it. This file is platform-infrastructure surface: it may name
 * container MECHANICS (mounts, capabilities, seccomp — the OCI-shaped
 * control vocabulary of the substrate class) but NO vendor SDK types — a
 * concrete runtime (Docker/containerd/OCI) implements
 * `ContainerRuntimeClient` elsewhere; nothing here imports an SDK
 * (`IMPLEMENTATION.md` §1: no provider SDK outside its owning adapter).
 *
 * DEFAULT DENY, VALIDATED: the configuration carries the dangerous fields
 * explicitly so the validator can PROVE they are rejected. A configuration
 * that would grant a sandbox ANY of the following is invalid —
 *
 *   - privileged mode                             (privileged-container)
 *   - host network namespace                      (host-network)
 *   - host PID namespace                          (host-process-namespace)
 *   - host IPC namespace                          (host-ipc-namespace)
 *   - any device access                           (device-access)
 *   - any added Linux capability                  (added-capabilities)
 *   - capabilities not fully dropped              (capabilities-not-dropped)
 *   - seccomp disabled                            (seccomp-disabled)
 *   - no-new-privileges disabled                  (no-new-privileges-disabled)
 *   - running as root                             (runs-as-root)
 *   - a writable root filesystem                  (writable-rootfs)
 *   - a HOST-shaped mount source                  (host-mount)
 *   - secret-shaped environment entries           (env-secret-shaped)
 *   - an open/ambient network mode                (ambient-network)
 *   - missing resource bounds                     (resource-limits-missing)
 *
 * — with a fail-closed contract: `containerConfigurationViolations` returns
 * EVERY violation and the caller refuses to dispatch when the list is
 * non-empty. Missing guarantees NEVER translate into permissive defaults
 * (discrimination M18).
 */

// ---------------------------------------------------------------------------
// The provider-neutral container configuration model
// ---------------------------------------------------------------------------

/** A mount: an OPAQUE artifact reference staged read-only, or the sandbox workspace. */
export interface ContainerMount {
  /**
   * Either an opaque ARTIFACT REFERENCE (staged by the object store) or
   * the synthetic "workspace" source. NEVER a host path — host-shaped
   * sources are rejected by the validator.
   */
  readonly source: string;
  readonly target: string;
  readonly readOnly: boolean;
}

export const WORKSPACE_MOUNT_SOURCE = "workspace";

export interface ContainerNetworkConfig {
  /** `none` (default-deny) or an explicit host allowlist. Never ambient. */
  readonly mode: "none" | "allowlist";
  readonly allowedHosts: readonly string[];
}

export interface ContainerResourceLimits {
  readonly cpuMilliCores: number;
  readonly memoryMiB: number;
  readonly executionTimeoutMs: number;
  readonly storageMiB?: number;
  readonly processCount?: number;
}

/** The full container execution configuration (the OCI-shaped control surface). */
export interface ContainerConfiguration {
  readonly image: string;
  readonly command: string;
  readonly args: readonly string[];
  /** The EXPLICIT environment (built from the admitted publicEnv only). */
  readonly env: readonly { readonly name: string; readonly value: string }[];
  readonly mounts: readonly ContainerMount[];
  readonly network: ContainerNetworkConfig;
  readonly resourceLimits: ContainerResourceLimits;
  // --- security posture (every field MUST hold its safe value) ---
  readonly readOnlyRootfs: boolean;
  readonly runAsNonRoot: boolean;
  readonly privileged: boolean;
  readonly hostNetwork: boolean;
  readonly hostPid: boolean;
  readonly hostIpc: boolean;
  readonly devices: readonly string[];
  readonly addedCapabilities: readonly string[];
  readonly droppedCapabilities: readonly string[];
  readonly seccompProfile: "default" | "unconfined";
  readonly noNewPrivileges: boolean;
}

// ---------------------------------------------------------------------------
// Host-path detection (mount sources are references, never locations)
// ---------------------------------------------------------------------------

const KNOWN_HOST_SOCKETS = [
  "/var/run/docker.sock",
  "/run/docker.sock",
  "/var/run/containerd",
  "/run/containerd",
  "/var/run/crio",
] as const;

/**
 * Whether a mount source denotes a HOST location: absolute paths, parent
 * traversal, home-relative paths, Windows drive letters, known container
 * engine sockets and host pseudo-filesystem roots. The docker socket is
 * called out explicitly: mounting it is THE canonical container-escape
 * vector (`spec/architecture.md` §15 isolation; ADR-0004).
 */
export function mountSourceIsHostPath(source: string): boolean {
  if (source === WORKSPACE_MOUNT_SOURCE) {
    return false; // the synthetic ephemeral workspace source
  }
  if (KNOWN_HOST_SOCKETS.includes(source as (typeof KNOWN_HOST_SOCKETS)[number])) {
    return true;
  }
  if (source.startsWith("/") || source.startsWith("~") || source.startsWith("\\")) {
    return true;
  }
  if (/^[A-Za-z]:/.test(source) || source.includes("..") || source.includes("\\")) {
    return true;
  }
  // Host pseudo-filesystem roots by name (relative "proc" or "sys" mounts
  // are still host namespaces — only opaque artifact refs are stageable).
  if (
    /^(proc|sys|dev|etc|var|usr|bin|sbin|lib|boot|root|home|mnt|media|opt|srv|run|tmp)(\/|$)/.test(
      source,
    )
  ) {
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// The escape validator (fail closed — every violation is enumerated)
// ---------------------------------------------------------------------------

export type ContainerConfigurationViolation = string;

/**
 * Platform-local raw-secret detection (the infrastructure mirror of the
 * sandbox module domain's `containsRawSecretValue` — `platform-isolation`
 * forbids platform importing modules, so the validator carries its own
 * pattern set; the discrimination suite proves BOTH layers reject the
 * same shapes: the domain at the durable contract boundary, the platform
 * at the runtime-configuration boundary).
 */
const RAW_SECRET_VALUE_PATTERNS: readonly RegExp[] = [
  /sk-[A-Za-z0-9]{16,}/,
  /AKIA[0-9A-Z]{16}/,
  /ghp_[A-Za-z0-9]{20,}/,
  /github_pat_[A-Za-z0-9_]{20,}/,
  /xox[baprs]-[A-Za-z0-9-]+/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./,
  /bearer\s+[A-Za-z0-9._-]{16,}/i,
  /(api[_-]?key|apikey|secret|password|passwd|token)\s*[:=]\s*["']?[^\s"']{8,}/i,
];

function containsRawSecretValue(value: string): boolean {
  return RAW_SECRET_VALUE_PATTERNS.some((pattern) => pattern.test(value));
}

const HOST_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*(:\d{1,5})?$/;

/**
 * Validate a container configuration against the sandbox security model.
 * Pure and total: returns EVERY violation (empty list = safe to dispatch).
 * This is the ADAPTER-CONFIGURATION half of acceptance criterion 5 — the
 * policy half lives in the sandbox admission seam; BOTH must reject a
 * sandbox-escape-shaped request.
 */
export function containerConfigurationViolations(
  config: ContainerConfiguration,
): ContainerConfigurationViolation[] {
  const violations: ContainerConfigurationViolation[] = [];

  if (config === null || typeof config !== "object") {
    return ["configuration-missing"];
  }

  // --- baseline shape ---
  if (typeof config.image !== "string" || config.image.length === 0 || config.image.length > 512) {
    violations.push("image-invalid");
  }
  if (typeof config.command !== "string" || config.command.length === 0) {
    violations.push("command-invalid");
  }
  if (!Array.isArray(config.args) || config.args.some((arg) => typeof arg !== "string")) {
    violations.push("args-invalid");
  }

  // --- THE escape surface (M5/M6/M7: host filesystem / network / process /
  //     device access must be REJECTED, not merely discouraged) ---
  if (config.privileged === true) {
    violations.push("privileged-container");
  }
  if (config.hostNetwork === true) {
    violations.push("host-network");
  }
  if (config.hostPid === true) {
    violations.push("host-process-namespace");
  }
  if (config.hostIpc === true) {
    violations.push("host-ipc-namespace");
  }
  if (Array.isArray(config.devices) && config.devices.length > 0) {
    violations.push("device-access");
  }
  if (Array.isArray(config.addedCapabilities) && config.addedCapabilities.length > 0) {
    violations.push("added-capabilities");
  }
  if (!Array.isArray(config.droppedCapabilities) || !config.droppedCapabilities.includes("ALL")) {
    violations.push("capabilities-not-dropped");
  }
  if (config.seccompProfile === "unconfined") {
    violations.push("seccomp-disabled");
  }
  if (config.noNewPrivileges !== true) {
    violations.push("no-new-privileges-disabled");
  }
  if (config.runAsNonRoot !== true) {
    violations.push("runs-as-root");
  }
  if (config.readOnlyRootfs !== true) {
    violations.push("writable-rootfs");
  }

  // --- mounts: opaque references only, never host locations ---
  if (!Array.isArray(config.mounts)) {
    violations.push("mounts-invalid");
  } else {
    for (const mount of config.mounts) {
      if (mount === null || typeof mount !== "object") {
        violations.push("mount-invalid");
        continue;
      }
      if (mountSourceIsHostPath(mount.source ?? "")) {
        violations.push("host-mount");
      }
      if (
        typeof mount.target !== "string" ||
        !mount.target.startsWith("/") ||
        mount.target.includes("..")
      ) {
        violations.push("mount-target-invalid");
      }
      if (mount.readOnly !== true && mount.source !== WORKSPACE_MOUNT_SOURCE) {
        violations.push("mount-not-read-only");
      }
    }
  }

  // --- environment: explicit entries only; secret-shaped entries rejected ---
  if (!Array.isArray(config.env)) {
    violations.push("env-invalid");
  } else {
    for (const entry of config.env) {
      if (entry === null || typeof entry !== "object") {
        violations.push("env-invalid");
        continue;
      }
      if (typeof entry.name !== "string" || entry.name.length === 0) {
        violations.push("env-invalid");
        continue;
      }
      if (containsRawSecretValue(String(entry.value ?? ""))) {
        violations.push("env-secret-shaped");
      }
    }
  }

  // --- network: explicit none/allowlist only; never ambient ---
  if (config.network === null || typeof config.network !== "object") {
    violations.push("ambient-network");
  } else if (config.network.mode !== "none" && config.network.mode !== "allowlist") {
    violations.push("ambient-network");
  } else if (config.network.mode === "allowlist") {
    const hosts = config.network.allowedHosts ?? [];
    if (!Array.isArray(hosts) || hosts.length === 0) {
      violations.push("ambient-network");
    } else {
      for (const host of hosts) {
        if (typeof host !== "string" || !HOST_PATTERN.test(host)) {
          violations.push("ambient-network");
        }
      }
    }
  }

  // --- resource limits: explicit and bounded, never host defaults ---
  const limits = config.resourceLimits;
  if (limits === null || typeof limits !== "object") {
    violations.push("resource-limits-missing");
  } else {
    if (!Number.isInteger(limits.cpuMilliCores) || limits.cpuMilliCores < 1) {
      violations.push("resource-limits-missing");
    }
    if (!Number.isInteger(limits.memoryMiB) || limits.memoryMiB < 4) {
      violations.push("resource-limits-missing");
    }
    if (!Number.isInteger(limits.executionTimeoutMs) || limits.executionTimeoutMs < 1) {
      violations.push("resource-limits-missing");
    }
  }

  return violations;
}

/** Whether a configuration is safe to dispatch (zero violations). */
export function containerConfigurationIsSafe(config: ContainerConfiguration): boolean {
  return containerConfigurationViolations(config).length === 0;
}
