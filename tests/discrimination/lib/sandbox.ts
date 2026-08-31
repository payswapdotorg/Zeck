/**
 * Shared sandbox boundary scanner (WORK-012).
 *
 * Used by BOTH the architecture gate
 * (tests/architecture/sandbox-boundary.test.ts) and the discrimination
 * proofs (tests/discrimination/sandbox.discrimination.test.ts) — one
 * definition of each protection, two uses, so a weakened protection is
 * provably rejected (the WORK-003/006/007/010/011 scanner discipline).
 *
 * Every violation id corresponds to a named WORK-012 discrimination
 * boundary (M1..M18 in the Work Order's CRITICAL profile):
 *
 *   M1  ambient host access defaults (env inheritance / host paths)
 *   M2  policy admission removed
 *   M3  capability admission removed
 *   M4  budget/resource controls bypassed
 *   M5  host filesystem access allowed
 *   M6  host network access allowed
 *   M7  host process/device access allowed
 *   M8  raw secrets injected
 *   M9  cross-tenant execution accepted
 *   M10 cross-application execution accepted
 *   M11 sandbox identity fabricated (idempotency broken)
 *   M12 durable identity binding removed
 *   M13 runtime metadata made mutable
 *   M14 provider-specific contracts in domain/public surfaces
 *   M15 execution before admission
 *   M16 canonical execution identity bypassed
 *   M17 "no execution" forced into a runtime
 *   M18 missing guarantees translated into permissive defaults
 */

export interface SandboxFabricFile {
  /** POSIX path relative to the repository root. */
  readonly path: string;
  readonly content: string;
}

export type SandboxFabricViolation = string;

/** Strip comments so prose cannot satisfy code-shape assertions. */
export function codeOnly(content: string): string {
  return content.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

function isSandboxModule(path: string): boolean {
  return path.startsWith("src/modules/sandbox/");
}

/** The canonical protected files the scanner reasons about. */
export const SANDBOX_CANONICAL_PATHS = [
  "src/modules/sandbox/public.ts",
  "src/modules/sandbox/domain/environment.ts",
  "src/modules/sandbox/domain/sandbox.ts",
  "src/modules/sandbox/ports/sandbox-admission.ts",
  "src/modules/sandbox/ports/sandbox-capability-gate.ts",
  "src/modules/sandbox/ports/sandbox-ledger.ts",
  "src/modules/sandbox/ports/sandbox-provider.ts",
  "src/modules/sandbox/ports/sandbox-store.ts",
  "src/modules/sandbox/application/environment-catalog.ts",
  "src/modules/sandbox/application/sandbox-service.ts",
  "src/modules/sandbox/adapters/policy-sandbox-admission.ts",
  "src/modules/sandbox/adapters/capability-gate.ts",
  "src/modules/sandbox/adapters/execution-ledger.ts",
  "src/modules/sandbox/adapters/process-provider.ts",
  "src/modules/sandbox/adapters/container-provider.ts",
  "src/modules/sandbox/adapters/sql-sandbox-store.ts",
  "src/platform/sandbox/container-profile.ts",
  "src/platform/sandbox/process-runtime.ts",
  "src/platform/sandbox/runtime-client.ts",
] as const;

export function hasCanonicalSandboxFabric(files: readonly SandboxFabricFile[]): boolean {
  const paths = new Set(files.map((f) => f.path));
  return SANDBOX_CANONICAL_PATHS.every((path) => paths.has(path));
}

/**
 * Scan a source tree (the sandbox module files + the platform seam) for
 * sandbox boundary violations. Pure: returns the violation ids (empty =
 * clean).
 */
export function sandboxFabricViolations(
  files: readonly SandboxFabricFile[],
): SandboxFabricViolation[] {
  const violations: SandboxFabricViolation[] = [];
  const byPath = new Map(files.map((f) => [f.path, f] as const));
  const sandboxFiles = files.filter((f) => isSandboxModule(f.path));
  const platformFiles = files.filter((f) => f.path.startsWith("src/platform/sandbox/"));

  const service = byPath.get("src/modules/sandbox/application/sandbox-service.ts");
  const catalog = byPath.get("src/modules/sandbox/application/environment-catalog.ts");
  const storePort = byPath.get("src/modules/sandbox/ports/sandbox-store.ts");
  const providerPort = byPath.get("src/modules/sandbox/ports/sandbox-provider.ts");
  const admissionPort = byPath.get("src/modules/sandbox/ports/sandbox-admission.ts");
  const publicBarrel = byPath.get("src/modules/sandbox/public.ts");
  const sqlStore = byPath.get("src/modules/sandbox/adapters/sql-sandbox-store.ts");
  const admissionAdapter = byPath.get("src/modules/sandbox/adapters/policy-sandbox-admission.ts");
  const capabilityAdapter = byPath.get("src/modules/sandbox/adapters/capability-gate.ts");
  const ledgerAdapter = byPath.get("src/modules/sandbox/adapters/execution-ledger.ts");
  const containerProvider = byPath.get("src/modules/sandbox/adapters/container-provider.ts");
  const containerProfile = byPath.get("src/platform/sandbox/container-profile.ts");
  const processRuntime = byPath.get("src/platform/sandbox/process-runtime.ts");
  const environmentDomain = byPath.get("src/modules/sandbox/domain/environment.ts");
  const sandboxDomain = byPath.get("src/modules/sandbox/domain/sandbox.ts");

  // ---- M1: no ambient host access anywhere in the sandbox stack ----
  for (const f of [...sandboxFiles, ...platformFiles]) {
    const code = codeOnly(f.content);
    if (/process\.env/.test(code) && !/runIsolatedProcess|childEnv|options\.env/.test(code)) {
      violations.push("sandbox-ambient-environment");
    }
    if (/\.\.\.\s*process\.env/.test(code)) {
      violations.push("sandbox-ambient-environment");
    }
  }
  if (processRuntime !== undefined) {
    const code = codeOnly(processRuntime.content);
    // The child env must be constructed from the EXPLICIT entries only.
    if (!/env:\s*childEnv/.test(code) || /\.\.\.process\.env/.test(code)) {
      violations.push("sandbox-ambient-environment");
    }
  }
  if (
    environmentDomain !== undefined &&
    !/refLooksLikeHostPath\(ref\)/.test(codeOnly(environmentDomain.content))
  ) {
    violations.push("sandbox-host-path-check-missing");
  }

  // ---- M2: policy admission REQUIRED (no default-allow) ----
  if (service !== undefined) {
    const code = codeOnly(service.content);
    if (!/admission\.admit\(/.test(code)) {
      violations.push("sandbox-policy-gate-missing");
    }
    const denialBranch =
      /if \(!decision\.allowed\) \{[\s\S]{0,900}?POLICY_DENIED[\s\S]{0,900}?\}/.exec(code);
    if (denialBranch === null) {
      violations.push("sandbox-policy-gate-no-denial-branch");
    }
  }
  if (admissionAdapter !== undefined) {
    if (
      !/from ["']\.\.\/\.\.\/policies\/public["']/.test(admissionAdapter.content) ||
      !/admitDispatch/.test(admissionAdapter.content)
    ) {
      violations.push("sandbox-admission-not-delegating");
    }
  }
  if (
    admissionPort !== undefined &&
    /allowed:\s*true[\s\S]{0,80}default/.test(codeOnly(admissionPort.content))
  ) {
    violations.push("sandbox-default-allow-admission");
  }

  // ---- M3: capability admission REQUIRED ----
  if (service !== undefined) {
    const code = codeOnly(service.content);
    if (!/capabilities\.resolve\(/.test(code)) {
      violations.push("sandbox-capability-gate-missing");
    }
    if (!/CAPABILITY_UNAVAILABLE/.test(code)) {
      violations.push("sandbox-capability-gate-no-denial");
    }
  }
  if (capabilityAdapter !== undefined) {
    if (
      !/from ["']\.\.\/\.\.\/capabilities\/public["']/.test(capabilityAdapter.content) ||
      !/registry\.resolve/.test(capabilityAdapter.content)
    ) {
      violations.push("sandbox-capability-not-delegating");
    }
  }

  // ---- M4: budget/resource controls ----
  if (service !== undefined) {
    const code = codeOnly(service.content);
    if (!/budgetAuthority\.reserve\(/.test(code)) {
      violations.push("sandbox-budget-reservation-missing");
    }
    if (!/BUDGET_EXCEEDED/.test(code)) {
      violations.push("sandbox-budget-fail-closed-missing");
    }
  }
  if (environmentDomain !== undefined) {
    const code = codeOnly(environmentDomain.content);
    // The mandatory limit fields must be pinned REQUIRED in the bounds
    // table (cpu/memory/timeout carry the required=true flag).
    if (!/\["cpuMilliCores", RESOURCE_LIMIT_BOUNDS\.cpuMilliCores, true\]/.test(code)) {
      violations.push("sandbox-resource-limits-not-required");
    }
    if (!/\["memoryMiB", RESOURCE_LIMIT_BOUNDS\.memoryMiB, true\]/.test(code)) {
      violations.push("sandbox-resource-limits-not-required");
    }
    if (!/\["executionTimeoutMs", RESOURCE_LIMIT_BOUNDS\.executionTimeoutMs, true\]/.test(code)) {
      violations.push("sandbox-resource-limits-not-required");
    }
  }

  // ---- M5/M6/M7: the container escape validator must reject the full
  //      escape surface (host mounts / network / process / devices) ----
  if (containerProfile !== undefined) {
    const code = codeOnly(containerProfile.content);
    // Each escape-shaped condition must be GUARDED BY its rejection marker
    // within the branch (the condition and its rejection travel together —
    // deleting either side is a detected weakening).
    const escapeGuards: ReadonlyArray<readonly [RegExp, string]> = [
      [/if \(config\.privileged === true\) \{[\s\S]{0,120}?privileged-container/, "privileged"],
      [/if \(config\.hostNetwork === true\) \{[\s\S]{0,120}?host-network/, "host-network"],
      [/if \(config\.hostPid === true\) \{[\s\S]{0,120}?host-process-namespace/, "host-pid"],
      [/if \(config\.hostIpc === true\) \{[\s\S]{0,120}?host-ipc-namespace/, "host-ipc"],
      [
        /if \(Array\.isArray\(config\.devices\) && config\.devices\.length > 0\) \{[\s\S]{0,120}?device-access/,
        "devices",
      ],
      [
        /if \(Array\.isArray\(config\.addedCapabilities\) && config\.addedCapabilities\.length > 0\) \{[\s\S]{0,120}?added-capabilities/,
        "added-caps",
      ],
      [/config\.seccompProfile === "unconfined"[\s\S]{0,120}?seccomp-disabled/, "seccomp"],
      [/config\.noNewPrivileges !== true[\s\S]{0,120}?no-new-privileges-disabled/, "no-new-privs"],
      [/config\.runAsNonRoot !== true[\s\S]{0,120}?runs-as-root/, "non-root"],
      [/config\.readOnlyRootfs !== true[\s\S]{0,120}?writable-rootfs/, "read-only-rootfs"],
    ];
    for (const [guard] of escapeGuards) {
      if (!guard.test(code)) {
        violations.push("sandbox-escape-validator-missing");
        break;
      }
    }
    if (!/mountSourceIsHostPath\(mount\.source/.test(code) || !/docker\.sock/.test(code)) {
      violations.push("sandbox-host-mount-detection-missing");
    }
  }
  if (containerProvider !== undefined) {
    const code = codeOnly(containerProvider.content);
    if (!/containerConfigurationViolations\(/.test(code)) {
      violations.push("sandbox-config-validation-missing");
    }
  }

  // ---- M8: references only — raw secrets are structurally absent ----
  if (providerPort !== undefined) {
    const code = codeOnly(providerPort.content);
    if (!/readonly secretRefs: readonly string\[\]/.test(code)) {
      violations.push("sandbox-runtime-secret-field");
    }
    if (/(apiKey|api_key|plaintext|password|bearerToken|secretValue)\s*[:?]/i.test(code)) {
      violations.push("sandbox-runtime-secret-field");
    }
  }
  if (
    sandboxDomain !== undefined &&
    !/containsRawSecretValue\(value\)/.test(codeOnly(sandboxDomain.content))
  ) {
    violations.push("sandbox-secret-validation-missing");
  }

  // ---- M9/M10: tenant/application guards at every boundary ----
  if (service !== undefined) {
    const code = codeOnly(service.content);
    if (!/ledger\.getExecution\(/.test(code)) {
      violations.push("sandbox-execution-binding-missing");
    }
    if (!/execution\.tenantId !== actor\.tenantId/.test(code)) {
      violations.push("sandbox-execution-tenant-check-missing");
    }
    if (!/sandbox\.tenantId !== actor\.tenantId|found\.tenantId !== actor\.tenantId/.test(code)) {
      violations.push("sandbox-dispatch-tenant-check-missing");
    }
  }
  if (
    catalog !== undefined &&
    !/input\.applicationId !== actor\.applicationId/.test(codeOnly(catalog.content))
  ) {
    violations.push("sandbox-catalog-scope-check-missing");
  }

  // ---- M11: unique-key convergence (SQL store ON CONFLICT arbitration) ----
  if (sqlStore !== undefined) {
    const content = sqlStore.content;
    if (!/ON CONFLICT \(application_id, sandbox_key\) DO NOTHING/.test(content)) {
      violations.push("sandbox-no-convergence");
    }
    if (!/ON CONFLICT \(application_id, slug\) DO NOTHING/.test(content)) {
      violations.push("sandbox-environment-no-convergence");
    }
  }
  if (service !== undefined && !/IDEMPOTENCY_KEY_REUSED/.test(codeOnly(service.content))) {
    violations.push("sandbox-idempotency-reuse-missing");
  }

  // ---- M12: durable identity binding (execution + environment) ----
  if (service !== undefined) {
    const code = codeOnly(service.content);
    if (!/const fingerprint = sandboxRequestFingerprint\(/.test(code)) {
      violations.push("sandbox-fingerprint-missing");
    }
    if (!/existing\.requestFingerprint !== fingerprint/.test(code)) {
      violations.push("sandbox-fingerprint-reuse-check-missing");
    }
  }
  if (sqlStore !== undefined) {
    // composite FKs live in the migration; the store must carry the
    // composite scope columns in every query (application-scoped reads)
    if (!/WHERE application_id = \$\d+ AND sandbox_key/.test(sqlStore.content)) {
      violations.push("sandbox-scope-qualified-queries-missing");
    }
  }

  // ---- M13: runtime metadata immutability ----
  if (storePort !== undefined) {
    const code = codeOnly(storePort.content);
    if (/updateRuntimeMetadata|mutateMetadata|setRuntimeMetadata/.test(code)) {
      violations.push("sandbox-metadata-update-path");
    }
  }
  if (service !== undefined) {
    const code = codeOnly(service.content);
    // dispatch must build the spec from the record's immutable snapshot
    if (!/const metadata = record\.runtimeMetadata;/.test(code)) {
      violations.push("sandbox-dispatch-not-snapshot-driven");
    }
  }

  // ---- M14: provider-neutral contracts (no vendor vocabulary in the
  //      module contracts; no execution vocabulary coupling) ----
  if (publicBarrel !== undefined) {
    const code = codeOnly(publicBarrel.content);
    if (/docker|kubernetes|k8s|podman|containerd|dockerode/i.test(code)) {
      violations.push("sandbox-provider-vocabulary-leak");
    }
    if (/\bExecutionStatus\b|\bEXECUTION_STATES\b|\bTRANSITION_TABLE\b/.test(code)) {
      violations.push("sandbox-execution-status-vocabulary");
    }
  }
  for (const f of sandboxFiles) {
    if (
      f.path.includes("/domain/") &&
      /\b(CREATED|AUTHORIZED|VERIFYING|REPLANNING)\b/.test(codeOnly(f.content))
    ) {
      violations.push("sandbox-second-execution-state-machine");
      break;
    }
  }
  if (providerPort !== undefined) {
    const code = codeOnly(providerPort.content);
    if (/waitHuman|WAITING_HUMAN|resume\(|transition\(/.test(code)) {
      violations.push("sandbox-provider-execution-coupled");
    }
  }
  // no provider SDK imports anywhere in the sandbox stack
  for (const f of [...sandboxFiles, ...platformFiles]) {
    if (
      /from ["'](dockerode|@docker\/|kubernetes|@kubernetes\/|@google-cloud\/container)/.test(
        f.content,
      )
    ) {
      violations.push("sandbox-provider-sdk-import");
      break;
    }
  }

  // ---- M15: execution only after admission (status guards) ----
  if (service !== undefined) {
    const code = codeOnly(service.content);
    if (!/claimDispatching\(/.test(code)) {
      violations.push("sandbox-dispatch-claim-missing");
    }
    if (!/a denied sandbox cannot be dispatched/.test(code)) {
      violations.push("sandbox-denied-dispatch-guard-missing");
    }
  }

  // ---- M16: the canonical execution identity/event path only ----
  for (const f of sandboxFiles) {
    if (
      /\b(INSERT|UPDATE|DELETE)\s+(INTO\s+)?(executions|platform|policies|capabilities|budgets|tools|agents)\./i.test(
        codeOnly(f.content),
      )
    ) {
      violations.push("sandbox-writes-authority-tables");
      break;
    }
  }
  if (service !== undefined) {
    const code = codeOnly(service.content);
    if (!/ledger\.recordStepEvent\(/.test(code)) {
      violations.push("sandbox-evidence-ledger-bypass");
    }
    if (!/sandbox-admitted/.test(code) || !/sandbox-completed/.test(code)) {
      violations.push("sandbox-evidence-lifecycle-events-missing");
    }
  }
  if (ledgerAdapter !== undefined) {
    if (
      !/from ["']\.\.\/\.\.\/executions\/public["']/.test(ledgerAdapter.content) ||
      !/recordStepEvent/.test(ledgerAdapter.content)
    ) {
      violations.push("sandbox-ledger-not-delegating");
    }
  }

  // ---- M17: no-execution is first class (never forced through a runtime) ----
  if (service !== undefined) {
    const code = codeOnly(service.content);
    if (!/kindExecutes\(/.test(code)) {
      violations.push("sandbox-no-execution-not-first-class");
    }
    if (!/providers\.providerFor\(/.test(code)) {
      violations.push("sandbox-no-execution-not-first-class");
    }
  }

  // ---- M18: fail-closed posture (no permissive defaults) ----
  if (containerProvider !== undefined) {
    const code = codeOnly(containerProvider.content);
    // The null-client branch MUST fail closed INSIDE the branch (deleting
    // the branch condition or its failClosed call is a detected weakening).
    if (!/if \(this\.client === null\) \{[\s\S]{0,300}?failClosed\(/.test(code)) {
      violations.push("sandbox-fail-closed-missing");
    }
    if (!/runtime-unavailable/.test(code)) {
      violations.push("sandbox-fail-closed-missing");
    }
  }
  if (service !== undefined) {
    const code = codeOnly(service.content);
    if (!/NON_CONVERGENT_EXTERNAL_EFFECT/.test(code)) {
      violations.push("sandbox-crash-nonconvergent-missing");
    }
  }

  // ---- no second authority (policy/capability/budget engines) ----
  for (const f of sandboxFiles) {
    if (
      /interface\s+(PolicyAuthority|CapabilityRegistry|BudgetAuthority|BudgetService|PolicyEngine)\b/.test(
        codeOnly(f.content),
      )
    ) {
      violations.push("sandbox-second-authority");
      break;
    }
  }

  return violations;
}
