# AI Execution OS Architecture Lock

**Architecture:** v1.0
**Status:** FROZEN AFTER APPROVAL

The following invariants are non-negotiable in v1.0:

1. `Execution` is the primary public AI-work abstraction.
2. No module depends directly on a provider SDK; provider-specific code is isolated behind adapters.
3. Policy admission happens before provider/tool/agent/secret/external-side-effect dispatch.
4. Capability selection precedes provider selection.
5. Customer-domain workflow/state authority remains outside AI Execution OS.
6. Verification is distinct from provider success and is evidence-producing.
7. Tool outcomes are observations; tools cannot exercise customer-domain authority.
8. Budget reservation/settlement is append-only and idempotent.
9. BYOK credentials are never exposed as ordinary model content or public domain state.
10. Execution identity is durable and idempotent across retries.
11. External effects use owned ports with durable intent and create-or-converge semantics where applicable.
12. Compute isolation is selected through the `ComputeEnvironment` abstraction; no agent is granted ambient host access.
13. Learning can change recommendations but cannot weaken policy or authority boundaries.
14. One Work Item maps to one implementation branch/PR in the development protocol.
15. Workers cannot merge their own PRs.
16. Frozen architecture cannot be silently rewritten by implementation workers.
17. Program/development state is repository-resident and reconstructable from a fresh clone.
18. A merged Work Order is complete only when its repository-resident state is finalized against the actual merge identity.
19. Assurance profiles can increase proof depth but cannot reduce required authority protections.
20. Unknown/unclassified change surfaces fail closed to `HIGH_ASSURANCE`.
