# Zeck Compute Isolation Profiles — Operator Guide

**Work Order:** WORK-058 (D-08) · **Requirements:** SEC-001 (runtime tenant isolation), SEC-002 (compute isolation classes and dedicated runners) · **Binding text:** `docs/DEPLOYMENT-ROADMAP-D08-REQUIREMENTS.md`

This is the operator documentation for the compute-isolation plane: the typed isolation profiles on the sandbox authority, the dedicated runner pools on the compute plane, and the runtime tenant-isolation guarantees enforced at the worker/runner plane. It augments (never replaces) the deployment documentation; `deploy/` tooling is owned by the D-05/D-07 surfaces and is unchanged by WORK-058.

## The isolation-profile classes (SEC-002)

Every compute environment carries exactly one isolation profile, declared on its specification and projected onto durable columns (`sandbox.compute_environments.isolation_class`, `pool_id`):

| Class | Meaning | Shape rules (fail closed at registration) |
| --- | --- | --- |
| `standard` | The baseline default-deny posture (the legacy class — an environment registered without a declaration is `standard` by durable record). | No pool identity. |
| `strict` | The hardened class for untrusted/consequential work. | Network egress **none** (an allowlist is not representable); workspace **none or ephemeral-read-only**; **no secret references**; isolation-substrate kinds only (`container`, `microvm`, `vm`, `customer-runner` — the `process` class is not a security boundary for untrusted work). |
| `dedicated-customer` | The dedicated customer runner profile: the environment executes only on the tenant's dedicated runner pool. | Requires a typed pool identity (`poolId`, lowercase kebab-case, max 64 chars) on an executing kind. |

The specification is the **single source**: the durable class/pool columns are its indexed projection, and the schema's consistency trigger (migration `0031_isolation_profiles.sql`) rejects any disagreement — an ambient assignment (columns claiming a class the spec never declared) is physically unrepresentable, and so is an in-place downgrade (the projection is immutable; a different profile under the same slug is an identity conflict because the content digest covers the isolation field).

## Governed selection (never an ambient default)

Profile selection rides the **existing policy/capability seams**:

- The environment **declares** the profile on its spec (validated at registration).
- At admission, the sandbox service submits the profile through the `SandboxAdmission` seam. The policy adapter maps the class onto the **frozen policies isolation ladder**: `standard`/`strict` anchor at the environment kind's ladder level; `dedicated-customer` anchors at `customer-runner` (the ladder's dedicated-runner class). The policy authority decides — a policy floor of `minIsolation: customer-runner` **requires** the dedicated class (a standard environment is denied), and a dedicated environment satisfies every floor its class meets.
- The admitted profile is recorded in the **immutable runtime metadata** and replayed at dispatch from that snapshot. A dispatch-time profile disagreement is unrepresentable — the substrate constructs exactly the admitted profile.

There is no profile-specific policy engine, no new authority, and no runtime profile assignment anywhere.

## Dedicated runner pools (SEC-002)

A pool is a typed identity (`poolId`) bound at two durable points:

1. **The environment** declares `isolation: { class: "dedicated-customer", poolId }` — the work's pool.
2. **The worker** registers with a pool binding (`compute_plane.worker_registrations.pool_id`, customer-runner workers only; first-party workers never carry one — the platform's shared pool). The binding is immutable for the worker identity.

Enforcement is **by construction** at claim admission (migration `0031`'s `claim_tenant_isolation_gate` trigger + the store's typed pre-checks inside the admission transaction):

- A dedicated-customer environment admits claims **only** from workers bound to its pool. Wrong-pool and unbound workers receive the typed `pool-mismatch` refusal (delivery, recovery re-selection and direct store admission alike).
- The claim's `pool_id` is **derived from the environment row inside the admission transaction** (scoped resolution at the seam — callers never supply a pool; the physical trigger assigns it, so a forged pool is unrepresentable).
- Pool quota accounting is per compute environment: two dedicated pools never share quota state.

## Runtime tenant isolation (SEC-001)

Cross-tenant access is impossible **by construction** at the worker/runner plane:

- **Claims**: the physical tenant-isolation gate (migration `0031`) rejects any claim whose tenant disagrees with the execution's or the compute environment's authoritative tenant — including every reassignment path (a successor claim is a fresh INSERT through the same gate). The store surfaces the typed `tenant-scope-refused` denial for misrouted claims.
- **Work execution**: the work executor composes its actor from the authoritative request scope; the sandbox service's tenant guards (execution, environment, actor) fire **before anything durable**; a hostile foreign-tenant request is a governed `TENANT_SCOPE_VIOLATION` refusal and nothing dispatches.
- **Evacuation/reassignment**: abandoned claims recover through fresh admissions that re-derive scope from the authority; the deterministic sandbox identity replays the same admitted (tenant-scoped) snapshot — the scope never widens (proven by the evacuation battery: hostile middle attempts are refused; a same-pool successor converges with exactly one provider dispatch).
- **External run identity**: the container run identity (`zeck-run:<tenantId>:<applicationId>:<executionId>:<sandboxId>`) is tenant-scoped — one tenant's work can never collide with (or be re-derived from) another tenant's identical work on a runner.
- **Artifacts/secrets/evidence**: the runtime spec carries only the environment's declared, tenant-scoped references (opaque refs, never values); sandbox evidence rows and ledger events are tenant-scoped through the existing composite foreign keys.

## Operator runbook (commands)

All pool/profile operations use the existing surfaces (nothing in `deploy/` changed):

- **Register a dedicated environment** (application-side): register a compute environment whose spec carries `isolation: { class: "dedicated-customer", poolId: "<pool>" }` through the environment catalog (the API surface or the SDK). Re-registering the identical spec converges; a different profile under the same slug is an identity conflict.
- **Register a pool-bound worker** (compute plane): register the worker with kind `customer-runner`, the governed runner binding, and the same `poolId`. The pool binding is immutable; a restarted process registers a NEW identity (existing worker-fabric discipline).
- **Quota per pool/environment**: `deploy:worker quota <environment> <n>` (unchanged surface) — dedicated environments have their own quota rows; pools never share quota state.
- **Inspect claims by pool**: the `compute_plane.worker_claims.pool_id` column is the durable record of which pool executed each claim.

## Honest boundaries

- The `strict` class is proven at the domain boundary (registration validation), the platform configuration validator (both layers reject the same shapes) and the substrate (the process substrate fails closed on a strict profile). External hardened runtimes (microVM/VM providers) are **not shipped** — a `strict` environment on an unshipped kind fails closed at dispatch (`runtime-unavailable`), never executes under-hardened.
- Dedicated pools guarantee claim/quota/declaration isolation and tenant-scoped resolution of artifacts/secrets/evidence through the existing tenant-scoped stores; the physical isolation of the runner hosts themselves is runner-infrastructure posture (the governed runner registration surface), not a Zeck-internal claim.
