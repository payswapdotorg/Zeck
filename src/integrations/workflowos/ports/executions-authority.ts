/**
 * The executions authority seam consumed by the WorkflowOS integration
 * (WORK-016; the `executions` module's public service is the ONLY write
 * path and the ONLY read path for execution state).
 *
 * This port is a CONSUMED AUTHORITY, not an authority this integration
 * owns: the composition root injects the real executions service; tests
 * inject the real service over in-memory or SQL stores. There is
 * deliberately NO second execution surface, NO transition logic, NO
 * idempotency ledger and NO store behind this seam — a `Pick` of the
 * public service's methods is the entire contract (discrimination M3:
 * "bypass Zeck Execution" is unrepresentable — the adapter cannot
 * create executions any other way).
 */

import type { ExecutionService } from "../../../modules/executions/public";

/** The executions authority subset the WorkflowOS submission path uses. */
export type WorkflowOsExecutionsAuthority = Pick<
  ExecutionService,
  "createExecution" | "getExecution" | "listEvents" | "listVerificationResults"
>;
