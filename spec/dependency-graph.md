# Dependency Graph

```text
WORK-001
  -> WORK-002
      -> WORK-003
          -> WORK-005
      -> WORK-004
          -> WORK-006
WORK-005 -> WORK-006
WORK-006 -> WORK-007
WORK-006 -> WORK-008
WORK-007 + WORK-008 -> WORK-009
WORK-006 + WORK-007 + WORK-008 -> WORK-010
WORK-010 -> WORK-011 -> WORK-012
WORK-009 + WORK-010 + WORK-011 -> WORK-013
WORK-009 + WORK-010 + WORK-013 -> WORK-014
WORK-002 + WORK-003 + WORK-004 + WORK-006 + WORK-009 + WORK-013 -> WORK-015
WORK-006 + WORK-007 + WORK-009 + WORK-010 + WORK-011 + WORK-013 + WORK-015 -> WORK-016
WORK-014 + WORK-016 -> WORK-017
WORK-010 + WORK-012 + WORK-014 + WORK-017 -> WORK-018
WORK-012 + WORK-016 + WORK-018 -> WORK-019
WORK-014 + WORK-017 + WORK-018 + WORK-019 -> WORK-020
WORK-013 + WORK-014 + WORK-017 + WORK-018 -> WORK-021
WORK-014 + WORK-016 + WORK-018 -> WORK-022
WORK-011 + WORK-012 + WORK-015 + WORK-016 -> WORK-023
WORK-023 -> WORK-024
WORK-023 -> WORK-025
WORK-009 + WORK-010 + WORK-013 + WORK-023 -> WORK-026
WORK-010 + WORK-012 + WORK-013 + WORK-031 -> WORK-027
WORK-006 + WORK-007 + WORK-010 + WORK-011 + WORK-012 + WORK-031 -> WORK-028
WORK-012 + WORK-016 + WORK-019 + WORK-031 -> WORK-029
WORK-012 + WORK-013 + WORK-016 + WORK-019 + WORK-031 -> WORK-030
WORK-006 + WORK-007 + WORK-008 + WORK-010 + WORK-011 + WORK-012 + WORK-013 + WORK-014 + WORK-016 -> WORK-031
WORK-004 + WORK-006 + WORK-007 + WORK-013 + WORK-015 + WORK-016 + WORK-017 -> WORK-032
WORK-015 + WORK-022 + WORK-032 -> WORK-034
WORK-015 + WORK-023 + WORK-027 + WORK-028 + WORK-029 + WORK-030 + WORK-032 + WORK-034 -> WORK-033
WORK-033 + WORK-034 -> WORK-035
WORK-035 -> WORK-036
WORK-036 -> WORK-037
WORK-037 -> WORK-038
WORK-038 -> WORK-039
WORK-039 -> WORK-040
WORK-040 -> WORK-041
```

Initial implementation frontier: `WORK-001`.

Parallel implementation is permitted only for dependency-independent Work Orders with non-overlapping declared surfaces and no protected shared-surface conflict.

Multimodal deployment is intentionally staged: WORK-023 establishes the common deployment abstraction and authority boundaries; WORK-024/025 specialize channel adapters; WORK-026 specializes asynchronous media-generation workloads.

Computational-substrate extensibility is intentionally staged: WORK-031 establishes the common substrate/workload-class contract; WORK-027/028/029/030 specialize computer use, long-running execution, edge/embodied execution and training/accelerator workloads.

UX realization is intentionally staged: WORK-033 established the prior dashboard projection; WORK-034 reconciled application scope; WORK-035 establishes the UX v2 foundation; WORK-036 through WORK-040 realize the product surfaces in dependency order; WORK-041 closes the cross-product usability, accessibility, responsive and release gate. All seven new Work Orders remain within the dashboard experience surface and are intentionally serialized to avoid protected shared-surface conflicts.
