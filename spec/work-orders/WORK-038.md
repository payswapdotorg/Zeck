# WORK-038 — Trust, evidence, artifacts and competence experience

Status: IN-FLIGHT

Owner: Architect-assigned implementation worker

Architecture Version: v1.0

Assurance Profile: HIGH_ASSURANCE

# Objective

Make Zeck's trust model tangible through evidence, provenance, artifact lineage, evaluations and reusable competences, while ensuring every displayed trust claim is grounded in platform authority.

# Context

Zeck's differentiator is not merely executing work but making the result inspectable and trustworthy. The technical architecture requires verification to be distinct from provider success and evidence to be durable. Competence extends this model by representing validated reusable ways of accomplishing work. The UI must make these concepts understandable without requiring users to learn verification-engine internals.

# Dependencies

Requires: WORK-037

# Requirement IDs

N/A — presentation realization of existing verification, artifact, learning and competence authorities.

# Declared Change Surfaces

- `apps/dashboard/` Result/Evidence/Trust surfaces, artifact views, competence views and evaluation views
- dashboard-local tests and fixtures
- `docs/work-items/WORK-038.md`

# Scope Boundaries

Allowed:
- Evidence and provenance presentation
- verification check summaries and drill-down
- provider/execution/quality/policy success discrimination in UI
- artifact preview, metadata, lineage and producing-execution links
- competence discovery, detail, use and trust metadata
- evaluation results and evidence views
- contextual object navigation between result/evidence/artifact/execution/source

Forbidden:
- client-generated verification or confidence truth
- second evidence/provenance authority
- silently promoting learning recommendations
- exposing raw secret material
- changes to backend modules or frozen architecture
- merging the worker's own PR

# Architecture Invariants

- Verification facts are sourced from the platform.
- Evidence is distinct from provider claims.
- Artifact lineage is authoritative in the existing artifact/evidence domain.
- Competence is presented as reusable validated behavior, not as an autonomous authority.
- Learning recommendations remain advisory until existing validation/promotion rules are satisfied.

# Acceptance Criteria

1. Result surfaces show a clear trust summary without reducing trust to an unsupported magic score.
2. Evidence explains which checks passed/failed and links each claim to available evidence.
3. Provider success, execution success, quality success and policy success remain visually and semantically distinct.
4. Evidence and artifact pages support contextual traversal between result, evidence, artifact, producing execution and source.
5. Artifact pages provide preview/metadata, provenance, parent lineage, verification and usage references where available.
6. Competence discovery emphasizes task outcome, relevance, success rate, typical cost/time and verification status.
7. Competence detail exposes provenance, procedures, validation population, uncertainty, compatibility and promotion state only when available from the API.
8. Evaluation views distinguish observation, recommendation, validation and authoritative production status.
9. Trust-state tests fail if a UI-only value is mistaken for platform verification truth.
10. Keyboard, screen-reader, responsive and mobile behavior preserve trust hierarchy and evidence navigation.

# Implementation Requirements

1. Reuse WORK-036 Result/Evidence/Activity semantics and WORK-035 disclosure primitives.
2. Centralize trust-state presentation so every route uses the same semantic vocabulary.
3. Make evidence links contextual; avoid forcing users back through indexes.
4. Treat competence use as an existing governed work action, not a local execution shortcut.
5. Add fixtures covering provider-success/task-failure, execution-success/quality-failure, policy-blocked and verified-success states.

# Required Checkpoint Contracts

- `SELF-HOSTING-BOUNDARY`
- `EXECUTION-PROVENANCE`

# Checkpoints

- readiness: exact base and WORK-037 completion verified
- trust: four success dimensions are independently represented
- evidence: every trust claim maps to platform evidence
- provenance: artifact/evidence/execution traversal is complete
- competence: reusable-skill presentation does not imply unauthorized promotion
- accessibility/responsive: primary trust journeys pass
- review: full gate twice consecutively at exact final head

# Evidence Contract

Evidence must identify exact revisions, trust-state fixtures, verification mappings, artifact/provenance routes, competence data projections, accessibility/responsive proofs and exact failure-mode discrimination results.

# Required Verification

- governance checker
- typecheck
- lint
- dashboard/unit/integration tests
- trust-state discrimination suite
- artifact/provenance traversal tests
- competence discovery/use tests
- responsive browser verification
- keyboard/accessibility verification
- secret-exposure discrimination
- full suite twice consecutively at exact final head

# Completion

Worker opens a PR but does not merge. Completion requires architect acceptance, exact-head verification and post-merge finalization.

# Dispatch Record

- Issue: #67
- Dispatch status: AUTHORIZED
- Exact base: `9426b0eef3bbce2732499455c21444a8acc29693`
- Required worker branch: `work/WORK-038-trust-evidence-artifacts-competence`
- Worker may implement only this Work Order and its declared surfaces.
- Worker must not modify `spec/development-state/*` during active work.
- Worker must not merge its own PR.
