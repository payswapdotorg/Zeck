# WORK-040 — Advanced inspection and multimodal work experience

Status: IN-FLIGHT

Owner: Architect-assigned implementation worker

Architecture Version: v1.0

Assurance Profile: HIGH_ASSURANCE

# Objective

Expose the depth of Zeck without contaminating the default experience by implementing advanced inspection plus modality-specific operational surfaces for computer use, realtime/messaging/media, long-running work, edge/embodied work, training/accelerators and economic actions.

# Context

Zeck's architecture deliberately unifies very different computational substrates under Execution while allowing specialized operational views. This order is the bridge between the simple Work mental model and the full platform depth. Advanced surfaces must answer expert questions — how, why, what is permitted, what substrate ran, what happened — without creating alternate authorities or alternate execution semantics.

# Dependencies

Requires: WORK-039

# Requirement IDs

N/A — dashboard presentation of existing domain/API contracts.

# Declared Change Surfaces

- `apps/dashboard/` advanced inspection, modality-specific operational and expert views
- dashboard-local tests and fixtures
- `docs/work-items/WORK-040.md`

# Scope Boundaries

Allowed:
- advanced plan/capability/provider/model/compute inspection
- execution Graph/Events/Raw views
- artifact lineage and audit inspection views
- computer-use capability/risk envelope and action history
- realtime/voice/messaging deployment/session views
- media-generation workload/result views
- long-running/recovery/checkpoint operational views
- edge/embodied operational views preserving local safety boundaries
- training/accelerator advanced resource views
- economic-action consequence/payment/resource-delivery views
- expert-mode configuration/inspection where supported by existing APIs

Forbidden:
- second execution or policy semantics for any modality
- client-side payment authorization, ledger or settlement truth
- cloud UI implying ownership of hard-real-time safety loops
- raw credentials/secrets
- new backend lifecycle authorities
- frozen architecture changes
- merging the worker's own PR

# Architecture Invariants

- All modalities remain Execution-compatible.
- Policy precedes dispatch and remains authoritative.
- Economic intent, authorization, transaction, settlement and verification remain separate.
- Edge safety authority remains local where required.
- Advanced views inspect existing facts; they do not manufacture them.

# Acceptance Criteria

1. Expert mode exposes plans, capabilities, effective policy, route/provider/model detail, compute substrate, events, lineage and audit without changing default user flows.
2. Computer-use views show explicit Browser/Desktop/Terminal access, filesystem/network constraints, approval requirements and risk before consequential interaction.
3. Realtime and messaging surfaces distinguish Deployment, Session and Execution and show activity/provenance contextually.
4. Media-generation surfaces present asynchronous work, artifact lineage, verification and retry/cancel state.
5. Long-running surfaces communicate phase, checkpoint, progress, spend and resume/recovery state without requiring lease/heartbeat knowledge.
6. Edge/embodied surfaces show current physical command, local safety state, authorization and last verified state without implying cloud hard-real-time control.
7. Training/accelerator detail exposes resource selection and checkpoints as advanced details while preserving compute/training/evaluation/release distinctions.
8. Economic-action views show bounded purpose/recipient/amount/expiration, authorization result, settlement correlation and independent resource/outcome verification where available.
9. Every advanced view links back to the canonical Work/Execution context.
10. Expert and modality-specific views pass tenant, authority, responsive and accessibility discrimination tests.

# Implementation Requirements

1. Reuse all earlier shared primitives and never create modality-specific status languages where universal semantics already exist.
2. Use progressive disclosure: outcome first, explanation second, control third, internals fourth.
3. For external side effects, use consequence preview before commitment.
4. Display provider/runtime/rail identities only as implementation detail unless they are directly relevant to a user decision.
5. Add fixtures for representative modality states and cross-links to canonical executions.

# Required Checkpoint Contracts

- `SELF-HOSTING-BOUNDARY`
- `EXECUTION-PROVENANCE`

# Checkpoints

- readiness: exact base and WORK-039 completion verified
- expert: advanced inspection does not alter semantics
- computer-use: risk and side-effect envelope correctly represented
- realtime/edge/economic: modality authority boundaries remain explicit
- provenance: every specialized result traces to governed work
- accessibility/responsive: expert and modality views remain usable
- review: full gate twice consecutively at exact final head

# Evidence Contract

Evidence must identify exact revisions, expert/modality routes, authority sources, representative state fixtures, consequence-preview evidence, tenant/secret-safety proofs, accessibility/responsive evidence and exact final-head verification.

# Required Verification

- governance checker
- typecheck
- lint
- dashboard/unit/integration tests
- expert-mode inspection tests
- computer-use risk/authorization tests
- realtime/messaging/session provenance tests
- long-running/training/edge/economic state tests
- tenant isolation and secret-exposure discrimination
- responsive browser verification
- keyboard/accessibility verification
- full suite twice consecutively at exact final head

# Completion

Worker opens a PR but does not merge. Completion requires architect acceptance, exact-head verification and post-merge finalization.

# Dispatch Record

- Issue: #71
- Dispatch status: AUTHORIZED / IN-FLIGHT
- Work Order was promoted from PENDING to IN-FLIGHT by the Architect before worker branch creation.
- Binding exact base: `aac355d1fad3c1a80a2d757f5c62160a95c4a5e3`
- Required worker branch: `work/WORK-040-advanced-inspection-multimodal-work`
- Worker must not modify `spec/development-state/*` during active work.
- Worker must not merge its own PR.
- Worker may implement only this Work Order and its declared surfaces.
