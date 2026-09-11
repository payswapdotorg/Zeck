# D-08 Audit & Compliance Operator Runbook (WORK-059 / SEC-004)

**Scope:** the append-only audit projection of governed actions, compliance
evidence export, retention policy and legal hold — `src/modules/audit/**`
(migration `0031_audit_compliance`).

**Authority posture:** audit records are EVIDENCE, never authority. Nothing
consults the projection for authorization; authoritative state stays in the
existing module stores. Deletion is legal ONLY inside the governed retention
purge (the store's transaction-gated procedure).

## Surfaces

| Surface | What it is |
|---|---|
| `createAuditService` | the projection write path (scrub → validate → append) + deterministic chain verification |
| `createComplianceExportService` | governed, bounded exports with verifiable chain proofs |
| `createRetentionService` | bounded policy adoption + the governed purge (fail-closed without a policy) |
| `createLegalHoldService` | hold placement/release (both audited; holds suspend expiry for their scope) |
| `SqlAuditStore` | the ONLY durable implementation (PostgreSQL via the neutral `DatabasePort`) |
| `createObservingExecutionService` / `createObservingAdmission` / `createObservingDecisionStore` | the existing-seam observers (wrap the authorities; outcomes pass through verbatim) |

## Wiring the observers (composition root)

The observers wrap the EXISTING authorities at composition time. The wrapped
service remains the authority — every call delegates unchanged and its
outcome passes through verbatim; the observer only appends evidence.

```ts
import {
  createAuditNodeDigest, createAuditService, createObservingExecutionService,
  createObservingAdmission, createObservingDecisionStore, SqlAuditStore,
} from "../modules/audit/public";
import { createExecutionAuthorization } from "../modules/policies/public";

const digest = createAuditNodeDigest();
const store = new SqlAuditStore(db, digest);
const audit = createAuditService({ store, digest });

// 1. Executions lifecycle (create + transitions):
const executions = createObservingExecutionService({
  inner: authorityExecutionsService, store, environment: "production",
  now: () => new Date(),
});

// 2. Policy admission (the authorize seam):
const authorization = createObservingAdmission({
  inner: createExecutionAuthorization(policyAuthority), store,
  environment: "production", command: "authorize", now: () => new Date(),
});

// 3. Optimization decision records (structural seam — inject the real store):
const decisionStore = createObservingDecisionStore({
  inner: optimizationDecisionStore, store, environment: "production",
  now: () => new Date(),
});
```

**Fail-closed observation:** if the audit append fails after an authority
operation committed, the observer throws a typed `AuditProjectionError` —
the caller retries; the authority's request idempotency replays the SAME
durable outcome and the audit append converges (content identity) to exactly
one evidence record. This convergence is proven by test.

**NOT yet wired in production composition:** the audit adapters are proven
over the real fabric by the integration suites; wiring them into the API-layer
composition root is the FOLLOWING composition Work Order's surface (this
runbook documents the assembly; `docs/work-items/WORK-059.md` records the
boundary honestly).

## Operator procedures

### Verify the chain (deterministic)

```ts
const verdict = await audit.verifyChain(applicationId);
// verdict.ok === true, or verdict.violations lists exact broken links /
// uncovered gaps / tampered records / overlapping purge manifests.
```

### Adopt a retention policy (bounded; audited)

```ts
await retention.adoptPolicy({
  applicationId, tenantId, version: 1, retentionDays: 90,
  reason: "SOC2 evidence window", adoptedBy: "compliance-operator",
});
```

`retentionDays` is bounded `[1, 3650]` by validation AND by the migration's
CHECK constraint — unbounded retention is unrepresentable. A scope WITHOUT an
active policy never purges (`executePurge` fails closed); that state is an
explicit disclosed boundary, never a silent infinite horizon.

### Execute the governed purge (the ONLY deletion path)

```ts
const outcome = await retention.executePurge({
  applicationId, environment: "production", procedureActorId: "retention-procedure",
});
// outcome.purgedCount, outcome.cutoff, outcome.evidence (the manifest record)
```

The purge runs in ONE transaction: expired, hold-free records are deleted
(under the `audit.governed_purge` session gate — the trigger rejects every
other DELETE and every UPDATE and TRUNCATE), the purge-evidence record with
the full manifest of purged `{sequence, recordDigest}` entries is appended,
and the chain head is advanced. A purge that finds nothing deletes nothing
and records nothing (re-runs and concurrent purges converge; no
double-purge). The chain verifies WITH manifest-covered gaps.

### Place / release a legal hold (audited; suspends expiry)

```ts
const hold = await holds.placeHold({
  applicationId, tenantId, holdScope: "target",   // or "application"
  targetKind: "execution", targetId,              // for target scope
  reason: "litigation matter 7", placedBy: "legal-operator",
});
await holds.releaseHold(applicationId, hold.holdId, "legal-operator");
```

While a hold is active, the governed purge never deletes records the hold
covers (application-wide holds cover everything; target holds match the
record's target identity).

### Generate a compliance export (governed, bounded, verifiable)

```ts
const exportObject = await exports.exportRecords({
  applicationId, tenantId, requestedBy: "compliance-auditor",
  purpose: "SOC2 quarterly evidence", fromSequence: 1, toSequence: 200,
  idempotencyKey: "export-2026q3", environment: "production",
});
const verdict = exports.verifyExport(exportObject);  // deterministic
```

One export carries at most 200 records + 200 purge manifests (page larger
scopes by sequence range). The export object carries per-record digests, the
manifests covering purged gaps inside the window, and the attested chain
boundary; `verifyExport` re-derives everything re-derivable and fails closed
on any tampered byte.

## Incident notes

- **UPDATE/DELETE/TRUNCATE on `audit.audit_records`** — rejected by trigger;
  only the store's governed purge (session-gated transaction) deletes. A
  database superuser setting the GUC manually is outside any application-level
  guarantee (residual boundary, disclosed).
- **`AuditProjectionError` from an observer** — the governed action committed
  but its evidence write failed: retry the request (idempotent convergence,
  proven). Do NOT bypass the observer.
- **Chain verification failure** — treat as a security incident: the
  violations list carries the exact broken links / gaps / tampered digests.
