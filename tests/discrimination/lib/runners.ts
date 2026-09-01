/**
 * Shared runner-fleet boundary scanner (WORK-019).
 *
 * Used by BOTH the architecture gate
 * (tests/architecture/runner-fleet-boundary.test.ts) and the discrimination
 * proofs (tests/discrimination/runner-fleet.discrimination.test.ts) — one
 * definition of each protection, two uses, so a weakened protection is
 * provably rejected (the WORK-003/006/007/010/011/012 scanner discipline).
 *
 * Every violation id corresponds to a named WORK-019 discrimination
 * boundary (M1..M20 in the Work Order's CRITICAL profile):
 *
 *   M1  cross-tenant runner assignment
 *   M2  cross-application assignment
 *   M3  unregistered runner accepted
 *   M4  revoked runner accepted (assignment AND report time)
 *   M5  unauthorized capability accepted
 *   M6  runner bypasses policy (assignment without the admitted parent)
 *   M7  runner bypasses budget (authority seam inside the fleet)
 *   M8  runner bypasses capability (match + typed denial)
 *   M9  runner creates second execution identity
 *   M10 duplicate assignment under concurrency (unique-key convergence)
 *   M11 reconnect duplicates execution / mints a second assignment
 *   M12 stale runner executes new assignment (heartbeat freshness)
 *   M13 runner directly mutates execution lifecycle
 *   M14 provider-specific VM type leaks into public contract
 *   M15 runner becomes second execution authority
 *   M16 customer runner assumed trusted (default-trusted registration)
 *   M17 credentials cross the runner boundary (values instead of refs)
 *   M18 provenance lost across reconnect
 *   M19 release race leaves two active assignments (physical slot)
 *   M20 health race permits dead runner assignment (same-statement guard)
 */

export interface RunnerFleetFile {
  /** POSIX path relative to the repository root. */
  readonly path: string;
  readonly content: string;
}

export type RunnerFleetViolation = string;

/** Strip comments so prose cannot satisfy code-shape assertions. */
export function codeOnly(content: string): string {
  return content.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

export const RUNNER_CANONICAL_PATHS = [
  "src/modules/sandbox/domain/runner.ts",
  "src/modules/sandbox/ports/runner-store.ts",
  "src/modules/sandbox/ports/runner-channel.ts",
  "src/modules/sandbox/ports/isolated-runtime.ts",
  "src/modules/sandbox/application/runner-fleet.ts",
  "src/modules/sandbox/adapters/sql-runner-store.ts",
  "src/modules/sandbox/adapters/in-memory-runner-store.ts",
  "src/modules/sandbox/adapters/microvm-provider.ts",
  "src/modules/sandbox/adapters/vm-provider.ts",
  "src/modules/sandbox/adapters/customer-runner-provider.ts",
  "src/integrations/runners/public.ts",
  "src/integrations/runners/domain/submission.ts",
  "src/integrations/runners/ports/customer-runner-endpoint.ts",
  "src/integrations/runners/adapters/customer-runner-channel.ts",
  "src/integrations/runners/application/customer-runner-gateway.ts",
  "src/platform/db/migrations/0015_runner_fleet.sql",
] as const;

export function hasCanonicalRunnerFabric(files: readonly RunnerFleetFile[]): boolean {
  const paths = new Set(files.map((f) => f.path));
  return RUNNER_CANONICAL_PATHS.every((path) => paths.has(path));
}

/** Extract a named region (function body) from source for region-scoped checks. */
function region(content: string, startMarker: RegExp, endMarker: RegExp): string | null {
  const start = content.search(startMarker);
  if (start === -1) {
    return null;
  }
  const rest = content.slice(start);
  const end = rest.search(endMarker);
  return end === -1 ? rest : rest.slice(0, end);
}

const VM_VENDOR_VOCABULARY =
  /\b(firecracker|qemu|kvm|vmware|virtualbox|xen|hyperv|hyper-v|aws|amazon|ec2|gcp|azure|digitalocean|hetzner|linode|vultr|openstack|cloudstack|proxmox)/i;

/** The executions-module status vocabulary (a second state machine marker). */
const EXECUTION_STATUS_VOCABULARY =
  /\b(CREATED|AUTHORIZED|PLANNING|QUEUED|RUNNING|VERIFYING|REPLANNING|WAITING_TOOL|WAITING_HUMAN)\b/;

const RUNNER_CONTRACT_PATHS = [
  "src/modules/sandbox/domain/runner.ts",
  "src/modules/sandbox/ports/runner-store.ts",
  "src/modules/sandbox/ports/runner-channel.ts",
  "src/modules/sandbox/ports/isolated-runtime.ts",
  "src/modules/sandbox/adapters/microvm-provider.ts",
  "src/modules/sandbox/adapters/vm-provider.ts",
  "src/modules/sandbox/adapters/customer-runner-provider.ts",
  "src/integrations/runners/domain/submission.ts",
  "src/integrations/runners/ports/customer-runner-endpoint.ts",
  "src/integrations/runners/adapters/customer-runner-channel.ts",
  "src/integrations/runners/public.ts",
];

const RUNNER_CODE_PATHS = [
  "src/modules/sandbox/application/runner-fleet.ts",
  "src/modules/sandbox/adapters/sql-runner-store.ts",
  "src/modules/sandbox/adapters/in-memory-runner-store.ts",
  "src/integrations/runners/application/customer-runner-gateway.ts",
];

/**
 * Scan a source tree (the runner-fleet surfaces of the sandbox module, the
 * runners integration, and migration 0015) for runner-fleet boundary
 * violations. Pure: returns the violation ids (empty = clean).
 */
export function runnerFleetViolations(files: readonly RunnerFleetFile[]): RunnerFleetViolation[] {
  const violations: RunnerFleetViolation[] = [];
  const byPath = new Map(files.map((f) => [f.path, f] as const));
  const service = byPath.get("src/modules/sandbox/application/runner-fleet.ts");
  const serviceCode = service === undefined ? null : codeOnly(service.content);
  const domain = byPath.get("src/modules/sandbox/domain/runner.ts");
  const storePort = byPath.get("src/modules/sandbox/ports/runner-store.ts");
  const channelPort = byPath.get("src/modules/sandbox/ports/runner-channel.ts");
  const sqlStore = byPath.get("src/modules/sandbox/adapters/sql-runner-store.ts");
  const memoryStore = byPath.get("src/modules/sandbox/adapters/in-memory-runner-store.ts");
  const migration = byPath.get("src/platform/db/migrations/0015_runner_fleet.sql");
  const integrationGateway = byPath.get(
    "src/integrations/runners/application/customer-runner-gateway.ts",
  );
  const integrationChannel = byPath.get(
    "src/integrations/runners/adapters/customer-runner-channel.ts",
  );
  const publicBarrel = byPath.get("src/modules/sandbox/public.ts");

  const assignRegion =
    service === undefined
      ? null
      : region(
          service.content,
          /const assignRunner: RunnerFleetService\["assignRunner"\]/,
          /const buildHandoff/,
        );
  const reconnectRegion =
    service === undefined
      ? null
      : region(
          service.content,
          /const reconnectRunner: RunnerFleetService\["reconnectRunner"\]/,
          /const isEligible/,
        );
  const reportRegion =
    service === undefined
      ? null
      : region(
          service.content,
          /const reportResult: RunnerFleetService\["reportResult"\]/,
          /const releaseAssignment:/,
        );

  // ---- M1: the tenant guard at every runner boundary ----
  if (service !== undefined) {
    const code = codeOnly(service.content);
    if (!/runner\.tenantId !== actor\.tenantId/.test(code)) {
      violations.push("runner-tenant-check-missing");
    }
    if (!/record\.tenantId !== tenantId/.test(code)) {
      violations.push("runner-tenant-check-missing");
    }
    if (!/sandbox\.tenantId !== actor\.tenantId/.test(code)) {
      violations.push("runner-tenant-check-missing");
    }
    // ---- M2: the actor application scope guard ----
    if (!/actor\.applicationId !== applicationId/.test(code)) {
      violations.push("runner-actor-scope-missing");
    }
  }

  // ---- M2: every store read is application-qualified ----
  if (sqlStore !== undefined) {
    if (!/WHERE application_id = \$\d+ AND id = \$\d+/.test(sqlStore.content)) {
      violations.push("runner-scope-qualified-queries-missing");
    }
    if (!/WHERE application_id = \$\d+ AND assignment_key = \$\d+/.test(sqlStore.content)) {
      violations.push("runner-scope-qualified-queries-missing");
    }
  }
  if (memoryStore !== undefined) {
    const code = codeOnly(memoryStore.content);
    if (!/\$\{applicationId\}:\$\{runnerId\}/.test(code)) {
      violations.push("runner-scope-qualified-queries-missing");
    }
  }

  // ---- M3: an unregistered runner is a typed scope rejection ----
  if (assignRegion !== null) {
    if (!/if \(runner === null\) \{[\s\S]{0,260}?TENANT_SCOPE_VIOLATION/.test(assignRegion)) {
      violations.push("runner-unregistered-check-missing");
    }
    // ---- M1 (assignment axis): the runner's tenant within assignment ----
    if (!/runner\.tenantId !== actor\.tenantId/.test(assignRegion)) {
      violations.push("runner-tenant-check-missing");
    }
    // ---- M4: the authorization gate before the durable write ----
    if (
      !/runner\.authorizationStatus !== "authorized"[\s\S]{0,300}?AUTHORIZATION_DENIED/.test(
        assignRegion,
      )
    ) {
      violations.push("runner-revoked-check-missing");
    }
    // ---- M12: the health/heartbeat eligibility gate ----
    if (
      !/isRunnerHealthyForAssignment\(runner, nowMs\(\), deps\.heartbeatWindowMs\)/.test(
        assignRegion,
      )
    ) {
      violations.push("runner-health-gate-missing");
    }
    // ---- M5/M8: the capability requirement match + typed denial ----
    if (
      !/runnerSupportsRequirements\(runner\.declaredCapabilities, requiredCapabilities\)/.test(
        assignRegion,
      )
    ) {
      violations.push("runner-capability-match-missing");
    }
    if (!/CAPABILITY_UNAVAILABLE/.test(assignRegion)) {
      violations.push("runner-capability-match-missing");
    }
    // ---- M19 (service half): one active assignment per runner ----
    if (
      !/findActiveAssignmentByRunner\(actor\.applicationId, input\.runnerId\)/.test(assignRegion)
    ) {
      violations.push("runner-active-slot-precheck-missing");
    }
    // ---- M10 (service half): the idempotency reuse error ----
    if (!/IDEMPOTENCY_KEY_REUSED/.test(assignRegion)) {
      violations.push("runner-idempotency-reuse-missing");
    }
    if (!/existing\.requestFingerprint !== fingerprint/.test(assignRegion)) {
      violations.push("runner-fingerprint-reuse-check-missing");
    }
    // ---- M6: assignment anchors an ADMITTED + claimed parent sandbox ----
    if (!/sandbox\.status !== "dispatching"/.test(assignRegion)) {
      violations.push("runner-pre-admission-assignment-missing");
    }
    if (!/sandbox\.executionId !== input\.executionId/.test(assignRegion)) {
      violations.push("runner-parent-identity-check-missing");
    }
    if (!/sandbox\.environmentId !== input\.environmentId/.test(assignRegion)) {
      violations.push("runner-environment-mismatch-missing");
    }
    // ---- M17: the token crosses as a one-way fingerprint only ----
    if (
      serviceCode !== null &&
      !/const tokenFingerprint = hashToken\(input\.registrationToken\)/.test(serviceCode)
    ) {
      violations.push("runner-raw-token-storage");
    }
  }

  // ---- M4 (report time): a revoked runner cannot land an outcome ----
  if (reportRegion !== null) {
    if (!/authorization is not valid at report time/.test(reportRegion)) {
      violations.push("runner-report-time-authorization-missing");
    }
    if (!/runner\.authorizationStatus !== "authorized"/.test(reportRegion)) {
      violations.push("runner-report-time-authorization-missing");
    }
  }

  // ---- M7/M15: the fleet holds NO authority seam (exact deps shape) ----
  if (service !== undefined) {
    const depsRegion = region(service.content, /export interface RunnerFleetDeps \{/, /\n\}/);
    if (depsRegion === null) {
      violations.push("runner-fleet-deps-shape-missing");
    } else {
      const depsCode = codeOnly(depsRegion);
      if (
        /(admission|policy|policies|budget|capabilit|verification|ledger|executions|tools|agents)/i.test(
          depsCode,
        )
      ) {
        violations.push("runner-fleet-authority-seam");
      }
      const expectedFields = [
        "store: RunnerStore",
        "sandboxStore: SandboxStore",
        "generateId",
        "now",
        "heartbeatWindowMs",
        "leaseDurationMs",
        "hashToken",
      ];
      for (const field of expectedFields) {
        if (!depsCode.includes(field)) {
          violations.push("runner-fleet-deps-shape-missing");
          break;
        }
      }
    }
  }

  // ---- M9/M13: no execution creation/lifecycle surface anywhere ----
  for (const path of RUNNER_CODE_PATHS) {
    const file = byPath.get(path);
    if (file === undefined) {
      continue;
    }
    const code = codeOnly(file.content);
    if (/createExecution\(|executionService|\.transition\(/.test(code)) {
      violations.push("runner-execution-creation-surface");
      break;
    }
    if (/\b(INSERT INTO|UPDATE|DELETE FROM)\s+executions\./i.test(code)) {
      violations.push("runner-writes-execution-lifecycle");
      break;
    }
    if (/from ["'][^"']*modules\/executions\//.test(code)) {
      violations.push("runner-execution-module-import");
      break;
    }
  }

  // ---- M10 (physical half): unique-key convergence in the SQL insert ----
  if (sqlStore !== undefined) {
    const insertRegion = region(
      sqlStore.content,
      /async insertRunnerAssignment\(/,
      /async findRunnerAssignment\(/,
    );
    if (insertRegion === null || !/ON CONFLICT DO NOTHING/.test(insertRegion)) {
      violations.push("runner-no-convergence");
    }
    // ---- M20: the same-statement health/trust/heartbeat guard ----
    if (
      insertRegion === null ||
      !/r\.authorization_status = 'authorized'/.test(insertRegion) ||
      !/r\.health_status = 'healthy'/.test(insertRegion) ||
      !/r\.last_heartbeat_at >= \$\d+/.test(insertRegion)
    ) {
      violations.push("runner-health-guard-missing");
    }
    // ---- M16: registration inserts start UNTRUSTED ----
    const insertRunnerRegion = region(
      sqlStore.content,
      /async insertRunner\(/,
      /async findRunner\(/,
    );
    if (insertRunnerRegion === null || /authorization_status/.test(insertRunnerRegion)) {
      violations.push("runner-default-trusted");
    }
    const authorizeRegion = region(
      sqlStore.content,
      /async authorizeRunner\(/,
      /async revokeRunner\(/,
    );
    if (authorizeRegion === null || !/authorization_status = 'untrusted'/.test(authorizeRegion)) {
      violations.push("runner-authorization-transition-open");
    }
    // ---- M18 (store half): reconnect bookkeeping only increments ----
    const reconnectStoreRegion = region(
      sqlStore.content,
      /async recordRunnerReconnect\(/,
      /\/\/ ---- append-only evidence ----/,
    );
    if (
      reconnectStoreRegion === null ||
      !/reconnect_count = reconnect_count \+ 1/.test(reconnectStoreRegion)
    ) {
      violations.push("runner-reconnect-bookkeeping-missing");
    }
    // ---- M18: events are INSERT-only with a per-assignment sequence ----
    if (!/INSERT INTO sandbox\.runner_assignment_events/.test(sqlStore.content)) {
      violations.push("runner-provenance-trail-missing");
    }
  }
  if (memoryStore !== undefined) {
    const code = codeOnly(memoryStore.content);
    if (!/authorizationStatus: "untrusted"/.test(code)) {
      violations.push("runner-default-trusted");
    }
  }

  // ---- M11: reconnect re-binds the SAME assignment (no insert path) ----
  if (reconnectRegion !== null) {
    if (!/store\.recordRunnerReconnect\(/.test(reconnectRegion)) {
      violations.push("runner-reconnect-rebind-missing");
    }
    if (/insertRunnerAssignment\(|assignRunner\(/.test(reconnectRegion)) {
      violations.push("runner-reconnect-creates-assignment");
    }
    if (!/"reconnected"/.test(reconnectRegion)) {
      violations.push("runner-provenance-trail-missing");
    }
    // ---- M4/M16: a revoked runner cannot reconnect ----
    if (!/runner\.authorizationStatus === "revoked"/.test(reconnectRegion)) {
      violations.push("runner-reconnect-revocation-missing");
    }
    // ---- external identity is not authorization: token fingerprint proof ----
    if (
      !/hashToken\(input\.registrationToken\) !== runner\.tokenFingerprint/.test(reconnectRegion)
    ) {
      violations.push("runner-reconnect-identity-proof-missing");
    }
  }

  // ---- M14: provider-neutral contracts (no VM vendor vocabulary) ----
  for (const path of RUNNER_CONTRACT_PATHS) {
    const file = byPath.get(path);
    if (file === undefined) {
      continue;
    }
    const code = codeOnly(file.content);
    if (VM_VENDOR_VOCABULARY.test(code)) {
      violations.push("runner-vm-vendor-vocabulary");
      break;
    }
  }
  if (publicBarrel !== undefined) {
    const code = codeOnly(publicBarrel.content);
    if (VM_VENDOR_VOCABULARY.test(code)) {
      violations.push("runner-vm-vendor-vocabulary");
    }
  }

  // ---- M15: no second execution state machine / authority in the fleet ----
  if (domain !== undefined) {
    const code = codeOnly(domain.content);
    if (EXECUTION_STATUS_VOCABULARY.test(code)) {
      violations.push("runner-execution-status-vocabulary");
    }
    if (
      /interface\s+(PolicyAuthority|CapabilityRegistry|BudgetAuthority|ExecutionService|VerificationService|PolicyEngine|BudgetService)\b/.test(
        code,
      )
    ) {
      violations.push("runner-second-authority");
    }
  }
  if (storePort !== undefined) {
    const code = codeOnly(storePort.content);
    if (/waitHuman|WAITING_HUMAN|\btransition[A-Za-z]*\(|createExecution/.test(code)) {
      violations.push("runner-execution-lifecycle-coupling");
    }
  }
  if (channelPort !== undefined) {
    const code = codeOnly(channelPort.content);
    if (/waitHuman|WAITING_HUMAN|\btransition[A-Za-z]*\(|createExecution/.test(code)) {
      violations.push("runner-execution-lifecycle-coupling");
    }
  }

  // ---- M17: references only — values are structurally absent ----
  if (domain !== undefined) {
    const code = codeOnly(domain.content);
    if (!/readonly secretRefs: readonly string\[\]/.test(code)) {
      violations.push("runner-secret-field");
    }
    if (
      /(apiKey|api_key|plaintext|password|bearerTokens?|secretValues?|secretData)\s*[:?]/i.test(
        code,
      )
    ) {
      violations.push("runner-secret-field");
    }
    if (!/readonly tokenFingerprint: string/.test(code)) {
      violations.push("runner-identity-fingerprint-missing");
    }
  }

  // ---- M19 (physical half): the split-brain partial unique index ----
  if (migration !== undefined) {
    if (!/CREATE UNIQUE INDEX runner_assignments_active_slot/.test(migration.content)) {
      violations.push("runner-active-slot-guard-missing");
    }
    if (!/WHERE status IN \('assigned', 'dispatched'\)/.test(migration.content)) {
      violations.push("runner-active-slot-guard-missing");
    }
    if (
      !/runner_assignments_request_key UNIQUE \(application_id, assignment_key\)/.test(
        migration.content,
      )
    ) {
      violations.push("runner-assignment-key-unique-missing");
    }
    // ---- M18 (physical half): append-only evidence + immutability ----
    if (!/runner_assignment_events_no_update(?!_)/.test(migration.content)) {
      violations.push("runner-provenance-trail-missing");
    }
    if (!/runner_assignment_events_no_delete(?!_)/.test(migration.content)) {
      violations.push("runner-provenance-trail-missing");
    }
    if (!/runners_immutable_identity(?!_)/.test(migration.content)) {
      violations.push("runner-identity-immutability-missing");
    }
    // ---- M16 (physical half): registration defaults untrusted ----
    if (
      !/CHECK \(authorization_status IN \('untrusted', 'authorized', 'revoked'\)\)/.test(
        migration.content,
      )
    ) {
      violations.push("runner-authorization-vocabulary-missing");
    }
  }

  // ---- M15/M16 (integration half): delegation only, no second authority ----
  if (integrationGateway !== undefined) {
    const code = codeOnly(integrationGateway.content);
    if (!/from ["']\.\.\/(\.\.\/)+modules\/sandbox\/public["']/.test(integrationGateway.content)) {
      violations.push("runner-integration-not-delegating");
    }
    if (!/fleet\.registerRunner\(/.test(code) || !/fleet\.reconnectRunner\(/.test(code)) {
      violations.push("runner-integration-not-delegating");
    }
    if (
      /interface\s+(PolicyAuthority|CapabilityRegistry|BudgetAuthority|ExecutionService|VerificationService|PolicyEngine)\b/.test(
        code,
      )
    ) {
      violations.push("runner-second-authority");
    }
    if (/new Map\s*</.test(code)) {
      violations.push("runner-integration-holds-registry");
    }
  }
  if (integrationChannel !== undefined) {
    const code = codeOnly(integrationChannel.content);
    if (!/implements RunnerChannel/.test(code)) {
      violations.push("runner-integration-not-delegating");
    }
    if (/createExecution|transition\(|waitHuman/.test(code)) {
      violations.push("runner-execution-lifecycle-coupling");
    }
  }

  return violations;
}
