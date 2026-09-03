# Work Items

| ID | Title | Dependencies | Assurance | Initial frontier |
|---|---|---|---|---|
| WORK-001 | Repository, modular-monolith and governance foundation | — | CRITICAL | yes |
| WORK-002 | Identity, applications and tenant isolation | 001 | CRITICAL | no |
| WORK-003 | Connections, BYOK and provider federation | 001,002 | HIGH_ASSURANCE | no |
| WORK-004 | Budgets, wallets, reservations and ledger | 001,002,003 | CRITICAL | no |
| WORK-005 | Capability registry and capability evidence | 003 | HIGH_ASSURANCE | no |
| WORK-006 | Execution identity, lifecycle and event core | 002,004,005 | CRITICAL | no |
| WORK-007 | Policy engine and admission boundary | 003,004,005,006 | CRITICAL | no |
| WORK-008 | Context compiler and artifact lineage | 005,006 | HIGH_ASSURANCE | no |
| WORK-009 | Model routing and adaptive execution planner | 005,006,007,008 | HIGH_ASSURANCE | no |
| WORK-010 | Governed tool runtime | 006,007,008 | CRITICAL | no |
| WORK-011 | Agent fabric, sessions and workspaces | 006,007,010 | HIGH_ASSURANCE | no |
| WORK-012 | Compute environments and sandbox manager | 006,007,010,011 | CRITICAL | no |
| WORK-013 | Verification, evaluators and quality gates | 006,009,010,011 | CRITICAL | no |
| WORK-014 | Learning telemetry, scorecards and shadow evaluation | 006,009,010,013 | STANDARD | no |
| WORK-015 | Public API, SDKs, CLI and developer dashboard | 002,003,004,006,009,013 | HIGH_ASSURANCE | no |
| WORK-016 | WorkflowOS integration adapter and benchmark harness | 006,007,009,010,011,013,015 | HIGH_ASSURANCE | no |
| WORK-017 | Advanced tool learning and tool-composition intelligence | 014,016 | STANDARD | no |
| WORK-018 | Tool synthesis and validated ephemeral programs | 010,012,014,017 | CRITICAL | no |
| WORK-019 | MicroVM/VM execution fleet and customer runners | 012,016,018 | CRITICAL | no |
| WORK-020 | Learned execution planning and automatic policy optimization | 014,017,018,019 | CRITICAL | no |
| WORK-021 | Deterministicization discovery and progressive AI-call elimination | 013,014,017,018 | CRITICAL | no |
| WORK-022 | Codebase AI opportunity analysis and selective human evaluation | 014,016,018 | HIGH_ASSURANCE | no |
| WORK-023 | Multimodal agent deployment fabric | 011,012,015,016 | HIGH_ASSURANCE | no |
| WORK-024 | Voice and realtime agent deployment | 023 | HIGH_ASSURANCE | no |
| WORK-025 | Messaging agent deployment | 023 | HIGH_ASSURANCE | no |
| WORK-026 | Media generation agent deployment | 009,010,013,023 | HIGH_ASSURANCE | no |
| WORK-027 | Computer-use and GUI execution | 010,012,013,031 | CRITICAL | no |
| WORK-028 | Long-running and resumable execution | 006,007,010,011,012,031 | CRITICAL | no |
| WORK-029 | Edge, real-time and embodied execution integration | 012,016,019,031 | CRITICAL | no |
| WORK-030 | Training, batch GPU and specialized accelerator workloads | 012,013,016,019,031 | HIGH_ASSURANCE | no |
| WORK-031 | Computational substrate federation and workload classes | 006,007,008,010,011,012,013,014,016 | HIGH_ASSURANCE | no |
| WORK-032 | Agentic economic actions and provider-neutral payment rails | 004,006,007,013,015,016,017 | CRITICAL | no |
| WORK-033 | Zeck UX experience shell and dashboard realization | 015,023,027,028,029,030,032,034 | HIGH_ASSURANCE | no |
| WORK-034 | API/SDK application-scope reconciliation | 015,022,032 | HIGH_ASSURANCE | no |
| WORK-035 | Zeck experience foundation and interaction system | 033,034 | HIGH_ASSURANCE | no |
| WORK-036 | Home, Work creation and execution experience | 035 | HIGH_ASSURANCE | no |
| WORK-037 | Build, agents, deployments and workloads experience | 036 | HIGH_ASSURANCE | no |
| WORK-038 | Trust, evidence, artifacts and competence experience | 037 | HIGH_ASSURANCE | no |
| WORK-039 | Control, spend, connections and improvement experience | 038 | HIGH_ASSURANCE | no |
| WORK-040 | Advanced inspection and multimodal work experience | 039 | HIGH_ASSURANCE | no |
| WORK-041 | UX integration hardening, usability and release gate | 040 | HIGH_ASSURANCE | no |

Parallel implementation is permitted only for dependency-independent Work Orders with non-overlapping declared surfaces and no protected shared-surface conflict.
