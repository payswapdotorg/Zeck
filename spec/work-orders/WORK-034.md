# WORK-034 — API/SDK application-scope reconciliation

Status: PENDING

Owner: Architect-assigned implementation worker

Architecture Version: v1.0

Assurance Profile: HIGH_ASSURANCE

# Objective

Reconcile the public SDK transport contract with the authoritative API application-scope rule so that every application-scoped public operation invoked through the SDK carries the `X-Zeck-Application` selector the real API derives server-side scope from. After this order, the public developer surface cannot pass fake-transport tests while failing the real wire contract.

# Context

The WORK-033 Architect review (PR #58, changes required) established the defect: the real API execution routes require `X-Zeck-Application` for execution detail, results, events, verification and cancel, and reject the request when the header is absent — but the public SDK client sends only the bearer credential for those operations. The defect is broader than the execution family named in the review: agent inventory reads (`GET /agents`, `GET /agents/:id/status`) require the same header, the codebase-analysis and economic-action route families carry the same rule, and four route files each hold a local duplicate of the header rule. The CLI consumes the same broken client methods.

The reconciliation is deliberately NOT a dashboard-side workaround: the SDK is the transport boundary. No direct `fetch`, no client-owned tenant registry, no provider-specific transport, and no change to the server-side scope derivation model (scope is resolved from durable rows, never from client assertions).

# Dependencies

Requires: WORK-015, WORK-022, WORK-032

# Requirement IDs

N/A — reconciliation of already-published public contracts (API-001/API-002 scope semantics); frozen technical requirement ownership is unchanged.

# Declared Change Surfaces

- `sdk/`
- `src/shared/wire.ts` (the canonical application-scope header contract)
- `src/api/` (single-sourcing the application-scope rule; no semantic route change)
- `cli/`
- tests for the above
- `docs/work-items/WORK-034.md`

# Scope Boundaries

Allowed:

- SDK client application scope and scoped-method transport
- client-side fail-fast contract pinning for unscoped clients
- a shared wire-contract constant and a single API-side scope-header helper
- CLI application-scope pass-through
- reconciliation proof suites: SDK unit pins, API route rejection pins, CLI transport pins, and a cross-tier proof that drives the real API server through the real SDK client

Forbidden:

- changing the server-side scope derivation model (scope stays server-resolved)
- changing the create contract (`POST /executions` keeps `applicationId` in the request body)
- editing `apps/dashboard/` (WORK-033's declared surface; its verification update is sequenced after this order merges)
- editing `spec/` or `spec/development-state/`
- editing `src/modules/`
- new database migrations
- direct `fetch` in consumers, client-owned tenant registries, or provider-specific transports
- merging the worker's own PR

# Architecture Invariants

- The effective application/tenant scope is always derived server-side from durable membership/ownership rows; a client-supplied scope selector names the application, it never authorizes.
- The SDK remains the single transport boundary for public consumers.
- The wire contract stays single-sourced in `src/shared/wire.ts`, shared by the API transport and the SDK.
- Execution remains the primary public primitive; the client surface stays provider-neutral and secret-free.
- Idempotency semantics (create, cancel) remain owned by the platform authorities.
- Cross-application reads remain indistinguishable from missing ones.

# Acceptance Criteria

1. Every application-scoped SDK method — `getExecution`, `cancelExecution`, `getResult`, `listEvents`, `listVerification`, `listAgents`, `getAgentStatus` — sends `X-Zeck-Application` carrying the client's application scope, and the header value is the scope string exactly (no trimming or transformation beyond construction-time validation).
2. A client constructed without an application scope fails fast client-side on every scoped method with an actionable error naming the header and the missing client option; no unscoped wire request is ever issued.
3. `createExecution` is unchanged on the wire: the application selector stays the request body's `applicationId`, and no application header is required or sent for creation.
4. The application-scope rule is single-sourced: one canonical header constant in `src/shared/wire.ts` (re-exported by the SDK) and one shared API helper in `src/api/`; all four route families consume them and no route-local copies remain.
5. The CLI passes its application argument as the client scope for every scoped command.
6. The contract is pinned end-to-end: a proof suite drives the real API server (real routes over real module surfaces) through the real SDK client — creation, scoped reads, cancel and agent inventory — and also proves the server-side 400 for a headerless raw request and the client-side fail-fast for an unscoped client.
7. Zero edits to `apps/dashboard/`, `spec/`, `src/modules/`, and no new migration; the server-side scope derivation and every existing route behavior are unchanged.

# Implementation Requirements

1. Wire contract: declare the application-scope header as a named, documented constant in `src/shared/wire.ts` next to the request shapes it governs, with the split contract documented — creation carries the selector in the body, scoped reads and governed commands carry it in the header.
2. API single-sourcing: move the four route-local `applicationHeaderOf` implementations into one shared helper (in `src/api/request-identity.ts`, where the other request-field rules live), preserving each route family's disclosure-quality error message through a surface parameter; the four route files import the shared rule and the canonical constant.
3. SDK client scope: add `applicationId` to `ZeckClientOptions` (validated non-empty when provided); every scoped method sends the canonical header from that scope; an absent scope fails fast with a plain `Error` naming the header, the option, and one example remedy — mirroring the established client-side pinning pattern (M17 provider-selection rejection). The failure is not a `ZeckApiError`: it never reached the wire.
4. CLI: every command constructs its client with the application argument it already requires positionally.
5. Proof tiers: SDK unit tests pin the header on every scoped call and the fail-fast; API route tests pin the 400 rejection and canonical message for each scoped route family without the header; CLI tests pin the header on every command's transport; a cross-tier suite bridges the SDK's `fetchImpl` to the real Fastify server's inject pipeline and drives the full scoped journey end-to-end.
6. Every commit keeps the complete gate green (the ratchet); no dashboard, spec, module or migration edits at any commit.

# Required Checkpoint Contracts

- `AUTH-PRESERVATION`
- `TENANT-ISOLATION`
- `DEPENDENCY-DIRECTION`
- `IMPLEMENTATION-COMPLETENESS`

# Checkpoints

- readiness: confirm the exact frozen main base, dependency completion, the WORK-033 surface boundary (no dashboard edits) and the full baseline gate before implementation
- contract: the application-scope wire rule is single-sourced and consumed by every route family and the SDK
- boundary: unscoped clients fail fast client-side; no unscoped scoped request reaches the wire; no consumer gains a transport bypass
- proof: the real-server × real-SDK cross-tier journey is green, including the server-side rejection pin and the client-side fail-fast pin
- review: the complete gate runs twice consecutively at the exact final head

# Evidence Contract

Evidence must identify the exact frozen base and final head, the root-cause record (the PR #58 Architect review, including that the defect's true extent covered cancel and agent inventory reads beyond the review's execution-read list), the changed-file inventory confined to the declared surfaces, the single-sourcing map (route-local copies removed), the SDK scope semantics, the full proof inventory with test counts, the acceptance-criteria mapping, and the explicit disclosure that the WORK-033 verification update (its integration world enforcing the scoped-read requirement) is sequenced after this order merges and is not part of this order.

# Required Verification

- governance checker
- typecheck
- lint
- SDK client contract tests
- API route rejection pins for every scoped route family
- CLI transport pins
- the real-server × real-SDK cross-tier reconciliation proof
- the complete suite, run twice consecutively at the exact final head

# Completion

Worker opens a PR but does not merge. Completion requires architect acceptance, exact-head verification and post-merge finalization. The WORK-033 verification update against the reconciled contract follows the merge of this order, under WORK-033's own surfaces.
