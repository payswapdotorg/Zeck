# WORK-011 Evidence — Agent fabric, sessions and workspaces

Work Order: `spec/work-orders/WORK-011.md`
Assurance: `HIGH_ASSURANCE` · Architecture: `v1.0` (frozen) · ADR-0013 normative
Branch: `work/WORK-011-agent-fabric` · Base: `4621622ba596b2ccd33c5f007bb0137b187a9721` (actual current main at pickup, verified by `git fetch origin` — the handoff's stated SHA, confirmed exact; main = the post-WORK-010-finalization tip: WORK-009 merged as `31206d3` [PR #18], WORK-010 merged as `0bc6b94` [PR #19])
Implementation revision (this file binds): `7320e89cf93d1818455752887b85128c67063b00` (implementation commit)
Final branch head: bound in the PR body (the two-part SHA binding convention — this evidence commit cannot contain its own SHA)

## Repair-first disclosure (pre-existing main defect)

At pickup, pristine main failed its own governance checker: `spec/development-state/checkpoint-state.json` was **invalid JSON** ("Expecting ',' delimiter: line 17 column 1"). Root cause (proven by per-commit bisect): architect commit `6cc314d` ("Correct WORK-009 checkpoint base identity") compacted the file from multi-line to single-line entries and dropped exactly ONE closing brace per entry — all 9 WORK entries ended `]}},` where `]}}},` is required. The file was valid at `95177f3` and at every commit before `6cc314d`; every commit from `6cc314d` through the tip `4621622` is unparseable. Main's own CI is red from that commit onward (runs `33333344756`, `33333364103`, `33333368771` all fail the governance job; last green at `0bc6b94`), and the two checker-executing tests (`tests/discrimination/governance-gate.discrimination.test.ts` negative control, `tests/integration/fresh-clone-governance.test.ts`) fail identically on pristine main (baseline measured: **855/857**).

Repair commit `0584544` (the branch's first commit) restores exactly the 9 missing `}` characters — data-only, content-preserving (the repaired file parses to the identical item structure; `git diff` is 9 insertions/9 deletions, one character each), disclosed here and in the commit message, justified under `governance-model.json` `selfHostingBoundary.may: "maintain development state"` (the WORK-009 round-3 count-repair precedent), trivially revertible, no frozen architecture / checker logic / requirement content touched. Without it, no branch — main included — can pass governance or be CI-green. With it, governance is fully green: `Governance OK: 31 Work Orders, 94 requirements, frontier=[]` (WORK-011 in-flight).

## Requirement mapping

| Requirement | Acceptance criterion | Implementation | Proof |
|---|---|---|---|
| AGT-001 (criterion 1) | Agents distinct from LLM/model providers | `ports/agent-provider.ts`: the `AgentProvider` port — a neutral agent-RUNTIME contract (`runtimeKind: string` + `executeSession(identity, task)` returning an observation), structurally distinct from the models module's inference `ModelProvider` (`complete`/`stream`); no import of models anywhere in the agents module; vendor identity never leaks (scanner-enforced) | Architecture gate (shared scanner: `agent-provider-models-collapse`, `agent-provider-contract-shape`, `agent-provider-inference-contract`); discrimination M2, M22, M24 |
| AGT-002 (criterion 2) | Session/workspace bound to execution identity | `createSession`: tenant-guarded execution read through the executions public service; session + workspace rows carry `executionId`/`applicationId`/`tenantId` server-derived (never from user runtime fields); composite FKs in migration 0006 make cross-scope rows unrepresentable | Unit "binds session+workspace identity…"; real-PG sessions suite (identity binding + cross-scope physical rejection); discrimination M3/M4/M5 |
| AGT-003 / ACP-001 (criterion 6) | Stable governed identity + inventory/catalog record | `domain/agent.ts` + `application/agent-registry.ts`: `registerAgent` creates the stable catalog record (slug-unique per application); lifecycle `registered→validated→available⇄suspended→retired` (explicit transition table; `retired` terminal); duplicate registration converges on the durable identity | Unit registry suite; real-PG registry suite (convergence incl. ×8 concurrent race); discrimination M17 |
| AGT-004 / ACP-002 (criterion 7) | Immutable versioned artifacts with validation + promotion/rollback metadata | `domain/agent-version.ts`: closed-shape `AgentDefinition` with content-addressed digest; versions are INSERT+read only (no update/delete method on the store port; migration 0006 physical triggers reject UPDATE/DELETE); promotion/rollback append `agent_selections` rows (`initial`/`promotion`/`rollback` kinds) — the selected version is the LATEST selection, artifacts never mutate | Unit registry suite (rollback selects, never mutates); real-PG registry suite (physical immutability + append-only journal + byte-identical artifacts after rollback); discrimination M15, M16 |
| AGT-005 / ACP-003 (criterion 8) | Scoped revocable mediated credentials; NO raw long-lived secrets in agent runtime contracts | `domain/credential.ts`: grants carry scope KIND + opaque REFERENCE only — there is no value/material column anywhere (proven at `information_schema` level); the runtime identity carries grant REFERENCES only; revocation is monotonic and dispatch re-validates usability (revoked/expired grants absent from the runtime identity and insufficient for dispatch); definition validation rejects 9 raw-secret patterns in any free-text field + unknown fields (closed shape) | Unit (secret rejection, grant usability, revocation); real-PG (no-value-column proof, monotonic revocation trigger, revoked-grant dispatch failure); discrimination M6, M7, M8 |
| AGT-006 / ACP-004 (criterion 9) | Policy-designated human approval before high-risk actions; side effect impossible before approval | Approval gates engage IFF the version declares the action class AND the effective autonomy is policy-ladder gated (`none`/`gated`); `requestApproval` persists the request and moves the parent execution to `WAITING_HUMAN` (public transition only); the session moves to `waiting-approval` — dispatch is impossible in that state (status guard); `decideApproval` records the human decision (approver provenance) and resolves the gate (`resume`); dispatch requires an APPROVED, unexpired, unrevoked approval bound to the SAME session/execution/tenant | Unit approval suite (missing/revoked/expired/pending all block; denial fails the session; cross-tenant decision rejected); real-PG (WAITING_HUMAN through the real executions API; resume after approval; dispatch gated); discrimination M12, M13, M14 + the forced-state runtime record |
| AGT-008 / ACP-006 (criterion 10) | Session inputs/actions/tool calls/outputs/authorization context as execution evidence with who/what/when/why | Session start, significant actions and completion ride the executions EventEnvelope ledger as step events (`agent-session-started` / `agent-action-recorded` / `agent-session-completed`) through the REQUIRED ledger seam (the canonical write path — agents never write executions tables); payloads carry the full identity chain (session/agent/version/workspace/execution), input digests + artifact refs, the effective permissions, the policy evidence (the "why"), tool refs + grant ids; the ledger's occurredAt + gapless sequencing is the "when" | Unit evidence suite; real-PG provenance test (envelope-by-envelope who/what/when/why assertions + row-bound sequences); discrimination M20, M21 |
| Criterion 3 | Local/customer/hosted adapters without changing the Execution abstraction | The `AgentProvider` port is the single seam: runtime kinds are neutral strings; the real-PG suite runs local + hosted fakes through the identical governed path; the provider shapes carry no execution status/transition vocabulary | Architecture gate (`agent-provider-execution-coupled`); discrimination M24; real-PG full-run test |
| Criterion 4 | Policy and tool permissions propagated into the agent environment | The policy admission seam decides the EFFECTIVE permission set (the requested ∩ approved intersection — an agent can never self-grant); tool dispatch requires the tool to be in the effective set AND a usable grant | Unit (intersection semantics, tool permission failures); real-PG (grant-backed dispatch); discrimination M9, M10, M11 |
| Criterion 5 | Agent cannot access another application/tenant's workspace or execution | Every boundary re-validates: server-derived scope on the session row; `checkWorkspaceScope` (tenant+application+execution, fail-closed `TENANT_SCOPE_VIOLATION`); tenant-guarded execution reads; composite FKs at the storage layer | Unit + real-PG cross-scope blocks (physical insert rejection); discrimination M3/M4/M5/M14 |
| Criterion 11 | Idempotent/concurrent session lifecycle at the execution identity boundary | Session rows keyed `(application_id, session_key)`: same key + same fingerprint replays the SAME durable outcome; different fingerprint fails `IDEMPOTENCY_KEY_REUSED`; concurrent identical creates converge through PostgreSQL unique-index arbitration (the bundle — session + workspace + grants — commits in ONE transaction); guarded lifecycle transitions converge on committed rows | Unit idempotency; real-PG ×8 concurrent convergence + key-reuse; discrimination M18 |

Related-not-owned: `AGT-007`/`ACP-005` (external/BYOA interoperability adapters) belong to WORK-016 and are deliberately NOT implemented — this branch ships only the `AgentProvider` seam those adapters will implement.

## Implementation

Surfaces (declared): `src/modules/agents/` — domain (`agent.ts`, `agent-version.ts`, `session.ts`, `workspace.ts`, `credential.ts`, `approval.ts`, `permissions.ts`); application (`agent-registry.ts`, `session-service.ts`); ports (`agent-provider.ts`, `agent-admission.ts`, `agent-execution-ledger.ts`, `agent-store.ts`); adapters (`sql-agent-store.ts`, `policy-agent-admission.ts`, `execution-ledger.ts`, `in-memory-agent-store.ts`); barrels.

Surfaces (directly required, disclosed — the WORK-010 precedent):
- `src/modules/executions/domain/event.ts` — the step-event vocabulary extended ADDITIVELY with the three agent commands; executions remains the sole vocabulary owner. The merged WORK-010 comment explicitly reserved this seam: "agents (WORK-011) extend it through the same `recordStepEvent` seam". `tests/unit/executions/step-events.test.ts` — the one exact-vocabulary assertion updated.
- `src/platform/db/migrations/0006_agents.sql` — the durable identity/concurrency/provenance state the Required Verification mandates ("real PostgreSQL integration for … durable execution work"); a NEW migration file, shipped 0001–0005 untouched.
- `tests/**` — 3 unit suites + fakes, 3 real-PG suites + world fixture, 1 architecture gate, 1 discrimination suite + shared scanner lib.
- `spec/development-state/*.json` — the in-flight transition + checkpoint outcomes; the disclosed checkpoint-state brace repair.
- `docs/work-items/WORK-011.md` — this file. `package.json`/`bun.lock` untouched — runtime deps `[]`, no new packages.

## Design decisions (architect-review pointers)

1. **Agent is a participant, never an authority (ADR-0013).** The module owns agent identity/inventory, versioned artifacts, session/workspace state and approval records — and NOTHING else. Policy decisions live behind the REQUIRED `AgentAdmission` seam (the WORK-007 engine); execution lifecycle/evidence behind the REQUIRED `AgentExecutionLedger` seam (the executions public service — step events for evidence, `wait-human`/`resume` for approval gates); capability/budget authorities stay at their owning modules (consulted downstream at the tools/models seams). No second state machine, no second ledger, no vendor leakage — scanner-enforced end to end.
2. **The permission model is intersection-only (M9).** The agent definition REQUESTS capabilities; the policy authority APPROVES per-fact; the session carries ONLY the intersection; grants are issued ONLY for effective refs. "Agent self-grants permissions" is unrepresentable — there is no code path from a definition's requested set to the runtime-visible set that bypasses the admission decision.
3. **Autonomy designates the approval gate (AGT-006 semantics).** The policies module's frozen autonomy ladder is the designation mechanism: `none`/`gated` engage the human gate for version-declared high-risk action classes; `sandboxed`/`unconstrained` is the policy's explicit designation that the action runs without an additional gate. The admission adapter CLAMPS requested autonomy to the effective policy ceiling (asking for less is always allowed). An agent cannot fabricate a gate (requesting approval for an ungated action fails `POLICY_DENIED`) nor fabricate an approval (decisions exist only through the governed service path, bound to the approving human actor).
4. **Credentials are references all the way down (AGT-005/ACP-003).** The runtime contract carries `CredentialGrantReference[]` (id + kind + opaque ref). No field in any runtime/public shape can hold a secret value (architecture-gated); no value column exists in the grants table (proven at the schema level); definition validation rejects raw-secret-shaped strings in free text (9 patterns) and unknown fields outright (closed shape). Materialization of actual credential material stays behind the connections vault seam at adapter-dispatch time — the WORK-003 BYOK model is untouched.
5. **Approval is an execution/policy gate, not customer-domain state (criterion 9 / ADR-0002).** The gate manifests on the execution lifecycle through the public transition API (`RUNNING → WAITING_HUMAN → RUNNING`), journaled on the execution ledger; the approval row binds the wait-human envelope's sequence (durable linkage). While the session is `waiting-approval`, dispatch is impossible (status guard + no approved record); after a DENY, the session fails honestly. Post-approval revocation blocks dispatch again (monotonic statuses).
6. **Versions are immutable by construction at THREE layers.** The store port has no update/delete method (API layer); the SQL adapter issues no version UPDATE/DELETE (code layer); migration 0006 triggers reject both physically (storage layer). Promotion/rollback append selection records; "current version" is derived (the latest selection) — mutable "current version" data masquerading as artifact mutation is unrepresentable.
7. **Session identity is one transactional bundle.** Session + workspace + scoped grants insert in ONE PostgreSQL transaction with unique-key arbitration (`(application_id, session_key)`): concurrent duplicates converge on the winner's committed bundle; same key + different fingerprint fails `IDEMPOTENCY_KEY_REUSED`; the fingerprint is canonical (sorted artifact refs). The completion envelope is appended BEFORE the terminal row update (idempotent per key; the sequence binds in the same guarded finalizing update — terminal rows are physically immutable after, so no post-terminal bookkeeping exists).
8. **The step-event vocabulary stays executions-owned.** The three agent commands were added to `STEP_EVENT_COMMANDS` in the executions domain — the exact extension the merged WORK-010 code comments reserved for this Work Order. No other module defines step-event vocabularies (architecture-gated: the constant exists exactly once in src/).
9. **The provider seam is execution-agnostic (M24).** `AgentProvider` references no execution status/transition vocabulary; runtime kinds are neutral strings; local/customer-hosted/hosted runtimes (and future WORK-016 BYOA adapters) implement the identical interface without any change to the Execution abstraction. The provider shapes carry no stores/services/authorities — an adapter is structurally never handed an authority surface.
10. **Baseline admission is deny-by-default per the platform rule.** With no configured policy set, the authority denies the session (no default-allow exists anywhere); the PG world publishes a baseline permissive set so executions authorize — the identical discipline as the WORK-010 tools world.

## Verification (implementation head `7320e89cf93d1818455752887b85128c67063b00`)

Environment: Bun 1.3.14, embedded PostgreSQL 16.4 at `127.0.0.1:55432` (`ZECK_PG_TEST_URL`), the shipped migration set incl. `0006_agents.sql` applied per suite on disposable databases.

| Command | Result |
|---|---|
| `bun install --frozen-lockfile` | clean, no changes (runtime deps `[]`) |
| `bun run typecheck` | 0 errors |
| `bun run lint` | 0 errors (404 files; warnings: 0 after the assertion-style alignment) |
| `python3 scripts/governance-check.py` | exit 0 — `Governance OK: 31 Work Orders, 94 requirements, frontier=[]` (WORK-011 in-flight; checker byte-identical to main) |
| `bun run test:unit` | 537/537 (46 files; incl. 50 WORK-011 tests across 3 suites + the updated step-events vocabulary test) |
| `bun run test:architecture` (architecture + discrimination) | 226/226 (35 files; incl. `agent-fabric-boundary` 4/4, `agent-fabric.discrimination` 30/30, `governance-gate` negative control green) |
| `bun run test:integration` | 141/141 (24 files; incl. `fresh-clone-governance` green) |
| `bun run test:pg` (real PostgreSQL) | 128/128 (22 files; incl. agents-schema 3, agents-registry 5, agents-sessions 8 = 16 WORK-011 PG tests) |
| `ZECK_PG_TEST_URL=… bun run test` (FULL suite, **twice consecutively**) | **957/957 (106 files) — both runs, identical pass sets** |

Baseline comparison: pristine main at pickup measured **855/857** (98 files) — the 2 failures are exactly the two checker-executing tests failing on main's broken checkpoint-state.json (repaired by this branch's first commit). Delta: **+100 tests / +8 files, all passing; the 2 main-inherited failures repaired**.

## Discrimination evidence (HIGH_ASSURANCE — every named boundary)

`tests/discrimination/agent-fabric.discrimination.test.ts` (30 tests) + the shared scanner `tests/discrimination/lib/agent-fabric.ts` (one definition, two uses — the architecture gate runs it over the real tree):

| Mutant | Boundary removed by the mutant | Rejected as |
|---|---|---|
| M1 | Agent re-exports execution status vocabulary (second abstraction) | `agent-execution-status-vocabulary` |
| M2 | AgentProvider imports/collapses into ModelProvider | `agent-provider-models-collapse` |
| M3/M4 | Workspace scope check deleted (tenant + application) | `agent-workspace-scope-check-missing` |
| M5 | Execution tenant check deleted | `agent-execution-tenant-check-missing` |
| M6 | Definition validation deleted (raw secrets publishable) | `agent-definition-validation-missing` |
| M7 | Runtime credentials field becomes secret values | `agent-runtime-secret-field` |
| M8 | Grant usability re-validation deleted (both dispatch sites) | `agent-grant-usability-check-missing` |
| M9 | Session bundle carries requested (not effective) permissions | `agent-permission-intersection-bypass` |
| M10 / M10b | Policy admission call deleted / denial branch dropped | `agent-policy-gate-missing` / `…no-denial-branch` |
| M11 | Tool permission check deleted | `agent-tool-permission-check-missing` |
| M12 / M12b | Approval gate deleted / authorization check deleted | `agent-approval-gate-missing` / `…authorization-check-missing` |
| M13 | Session-status dispatch guard deleted (side effect before approval) | `agent-session-status-dispatch-guard-missing` |
| M14 | Approval tenant check deleted | `agent-approval-tenant-check-missing` |
| M15 | Version update/delete path appears in the store port | `agent-version-update-path` |
| M16 | Rollback stops appending selection records | `agent-rollback-selection-missing` |
| M17 | Registration convergence (ON CONFLICT) deleted | `agent-registration-no-convergence` |
| M18 | Session convergence (ON CONFLICT) deleted | `agent-session-no-convergence` |
| M19 | Agents writes executions tables directly | `agent-writes-authority-tables` |
| M20 | Evidence bypasses recordStepEvent | `agent-evidence-ledger-bypass` |
| M21 | Provenance payload stripped (policy evidence + version identity) | `agent-evidence-provenance-stripped` |
| M22 | Provider SDK imported / vendor identifiers leak | `agent-provider-sdk-import` |
| M23 | A second policy/capability/budget authority defined in agents | `agent-second-authority` (+ delegation checks on both adapters) |
| M24 | Provider port couples to execution transitions | `agent-provider-execution-coupled` |

Runtime red records (wiring mutants — the failure each static protection makes unrepresentable in src/, proven observable only under rogue composition, with the production adapter blocking the identical scenario): **R1** allow-all admission vs the REAL policy (production: autonomy clamped to the ceiling, non-allowlisted tools excluded); **R2** self-granting admission (production: the intersection — the runtime identity carries only approved tools); **R3** no-op ledger (production: the required seam records the started envelope + row-bound sequence); **M12/M13 runtime** — a forced session state STILL cannot dispatch a gated action without an approved, unrevoked approval.

## Real PostgreSQL proofs (the Work Order's durable list)

- Agent identity uniqueness: unique `(application_id, slug)` + ×8 concurrent registration race converging on one identity (registry suite).
- Immutable agent versions: physical UPDATE/DELETE rejection triggers + digest-identity convergence/divergence (schema + registry suites).
- Promotion/rollback semantics: the append-only selections journal; rollback selects the previously valid version; artifacts byte-identical after rollback; physical journal mutation rejection (registry suite).
- Workspace tenant/application constraints: composite FKs — cross-tenant workspace insert physically rejected; cross-tenant/cross-application service-level access fails closed (sessions suite).
- Session identity binding: session + workspace rows bound to execution/application/tenant, server-derived (sessions suite).
- Duplicate session convergence: same key replays; ×8 concurrent creates converge on ONE row (sessions suite).
- Credential/revocation state: scoped grant rows; revocation monotonic (physical trigger); revoked grants absent from the runtime identity and insufficient for dispatch (sessions suite).
- Approval persistence + approval-before-side-effect: pending/approved statuses durable; the parent execution moves to WAITING_HUMAN through the REAL executions transition API and resumes after the decision; the gated action is impossible before approval and dispatchable after (sessions suite).
- Provenance persistence: ledger envelopes reconstruct who (session actor + tenant), what (identity chain + input digest + artifact refs + action descriptor digest), when (gapless envelope sequencing + row-bound sequences), why (cause + policy evidence) (sessions suite).
- Cross-tenant rejection: every boundary — creation, session access, approval decisions, physical row shapes (sessions suite).

## Checkpoint evidence (HIGH_ASSURANCE — evidence, not completion authority)

| Contract | Status | Evidence |
|---|---|---|
| IMPLEMENTATION-COMPLETENESS | evidence-recorded, passed | This file; the 11 acceptance criteria mapped in the requirement table; all 12 owned requirements implemented (AGT-007/ACP-005 deliberately not absorbed — WORK-016 owns them) |
| IDENTITY-IDEMPOTENCY | evidence-recorded, passed | Unit idempotency tests; real-PG registration/session convergence suites (×8 races); discrimination M17/M18; the one-transaction bundle design |
| CONCURRENCY-CRASH-SAFETY | evidence-recorded, passed | Real-PG concurrent suites; guarded first-writer-wins transitions; the completion-envelope-before-terminal-row ordering (crash convergence analysis in design decision 7); unique-index arbitration throughout |
| SELF-HOSTING-BOUNDARY | evidence-recorded, passed | Governance green on-branch; the disclosed main-defect repair (data-only, revertible); checker/requirements/ADRs untouched; fresh-clone governance suite green |

Additional blocking boundaries from the Work Order's Checkpoints section: agent inventory/version authority (registry suites + physical immutability), credential mediation/secret non-exposure (no-value-column proof + closed-shape validation + scanner), human approval before risky side effects (the full gate suite + runtime red records), execution provenance for agent actions (ledger suites + scanner) — all covered above.

## Known limitations

1. **No concrete AgentProvider adapter ships** (deliberate): the Work Order's implementation sequence says "Do not start by building a concrete provider"; local/customer-hosted/hosted runtimes and WORK-016's BYOA adapters implement the seam later. The proof uses recording fakes through the REAL governed path.
2. **No durable PolicyStore adapter** (inherited WORK-007 posture): policy definitions are configuration-resident versioned data; durable admission decisions live on the executions ledger. The PG world publishes in-memory sets through the real authority.
3. **CI has no PostgreSQL service** (standing flag since WORK-002): the PG suites are env-gated and skip visibly in CI; the locally-executed real-PG runs above are the recorded proof (embedded PostgreSQL 16.4).
4. **Endpoint-scoped grants** are modeled (scope kind `endpoint`) but not issued by the session service — endpoint mediation arrives with the connections-backed materialization seam (future Work Order); `model`/`tool`/`secret` grants are issued and proven.
5. **The approval `expiresAt`** is caller-supplied at request time and evaluated at dispatch; no background sweeper marks expired approvals terminal (dispatch-time evaluation is authoritative; the row stays `approved` with a past expiry — `approvalAuthorizesDispatch` rejects it, as proven).
6. **Budget consultation at session dispatch** is not wired: agent sessions are not directly costed (costed work happens at the tool/model seams, which consult the budget authority). Should the architect want a session-level reservation, the `AgentAdmission` decision shape extends additively.

## PR binding (CURRENT)

PR **#21** (https://github.com/pectoraux/Zeck/pull/21), opened from `work/WORK-011-agent-fabric` against main. The PR body binds the exact base (`4621622…`), implementation head (`7320e89…`), evidence head (`8b67c96…`) and final branch head SHAs per the two-part convention (this file binds the implementation revision; the PR body binds the final branch head).

**CI on the evidence head `8b67c96`** (pull_request run `33336876335`, "Repository Governance" workflow): `toolchain-detection` **success**, `governance` **success**, `implementation` **success** — all three check-runs green (verified via the GitHub API at the exact head SHA). The final PR-binding commit below advances the final head; its CI record is bound in the PR body/comment after the run completes.

NOT merged — the architect is the sole merge authority; `program-state.json` keeps WORK-011 `in-flight` until post-merge finalization.
