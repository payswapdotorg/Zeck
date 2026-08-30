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
```

Initial implementation frontier: `WORK-001`.

Parallel implementation is permitted only for dependency-independent Work Orders with non-overlapping declared surfaces and no protected shared-surface conflict.

Multimodal deployment is intentionally staged: WORK-023 establishes the common deployment abstraction and authority boundaries; WORK-024/025 specialize channel adapters; WORK-026 specializes asynchronous media-generation workloads.
