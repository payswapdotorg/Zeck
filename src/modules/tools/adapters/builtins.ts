/**
 * Built-in deterministic tools (tools module adapters; WORK-010).
 *
 * First-class deterministic capabilities (architecture §2.6, ADR-0007):
 * computation that needs NO model, NO network, NO secrets and produces NO
 * external side effects — arithmetic and schema validation. They are the
 * runtime's reference implementations proving that the governed tool
 * runtime never assumes an LLM: a plan step of class `call-tool` resolves
 * these through the identical admission chain as any external tool.
 *
 * The capability identities they declare ("arithmetic" / tool kind,
 * "json-schema-validation" / algorithm kind) belong to the capabilities
 * vocabulary — composition roots publish the matching facts into the
 * capability registry (`SEED_BUILT_IN_TOOL_FACTS` below) through the
 * registry's normal publish path, exactly as rail adapters publish their
 * model capabilities.
 */

import type { PublishedCapabilityFact } from "../../capabilities/public";
import { checkAgainstSchema, isToolFieldSchema } from "../domain/schema";
import type { ToolContract } from "../domain/tool";
import type {
  ToolAdapter,
  ToolDispatch,
  ToolDispatchContext,
  ToolObservation,
} from "../ports/tool-adapter";

const PUBLISHED_AT = "2026-08-30T00:00:00Z";
const PUBLISHER = "tools:builtins";

/** The calculator contract: deterministic integer-safe arithmetic. */
export const CALCULATOR_CONTRACT: ToolContract = {
  toolId: "calculator",
  version: "1.0.0",
  capability: { id: "arithmetic", kind: "tool", minVersion: "1.0.0" },
  inputSchema: {
    fields: [
      {
        name: "operation",
        type: "string",
        required: true,
        description: "add | subtract | multiply | divide",
      },
      {
        name: "left",
        type: "string",
        required: true,
        description: "integer operand (decimal string)",
      },
      {
        name: "right",
        type: "string",
        required: true,
        description: "integer operand (decimal string)",
      },
    ],
  },
  outputSchema: {
    fields: [
      {
        name: "result",
        type: "string",
        required: true,
        description: "integer result (decimal string)",
      },
    ],
  },
  execution: { deterministic: true, timeoutMs: 5_000, idempotent: true },
  sideEffect: "none",
  network: { egress: "none", hosts: [] },
  secrets: { access: "none", refs: [] },
  cost: { estimatedMicroUsd: "0" },
  evidence: { producesArtifacts: false },
};

const INTEGER = /^-?\d{1,18}$/;
const OPERATIONS = new Set(["add", "subtract", "multiply", "divide"]);

/** The calculator adapter: pure bigint arithmetic over decimal strings. */
export const calculatorAdapter: ToolAdapter = {
  async execute(dispatch: ToolDispatch, _context: ToolDispatchContext): Promise<ToolObservation> {
    const { operation, left, right } = dispatch.input as {
      operation: unknown;
      left: unknown;
      right: unknown;
    };
    if (typeof operation !== "string" || !OPERATIONS.has(operation)) {
      return {
        kind: "tool-failure",
        failure: {
          failureClass: "tool-execution",
          message: `unsupported arithmetic operation "${String(operation)}"`,
          retryable: false,
        },
      };
    }
    if (
      typeof left !== "string" ||
      typeof right !== "string" ||
      !INTEGER.test(left) ||
      !INTEGER.test(right)
    ) {
      return {
        kind: "tool-failure",
        failure: {
          failureClass: "tool-execution",
          message: "arithmetic operands must be integer decimal strings (max 18 digits)",
          retryable: false,
        },
      };
    }
    const a = BigInt(left);
    const b = BigInt(right);
    let result: bigint;
    switch (operation) {
      case "add":
        result = a + b;
        break;
      case "subtract":
        result = a - b;
        break;
      case "multiply":
        result = a * b;
        break;
      case "divide": {
        if (b === 0n) {
          return {
            kind: "tool-failure",
            failure: {
              failureClass: "tool-execution",
              message: "division by zero",
              retryable: false,
            },
          };
        }
        result = a / b;
        break;
      }
      default:
        return {
          kind: "tool-failure",
          failure: {
            failureClass: "tool-execution",
            message: "unreachable operation",
            retryable: false,
          },
        };
    }
    return { kind: "tool-success", output: { result: result.toString() } };
  },
};

/** The schema-validator contract: deterministic payload shape validation. */
export const SCHEMA_VALIDATOR_CONTRACT: ToolContract = {
  toolId: "schema-validator",
  version: "1.0.0",
  capability: { id: "json-schema-validation", kind: "algorithm", minVersion: "1.0.0" },
  inputSchema: {
    fields: [
      {
        name: "schema",
        type: "object",
        required: true,
        description: "field schema to validate against",
      },
      { name: "payload", type: "object", required: true, description: "candidate payload" },
    ],
  },
  outputSchema: {
    fields: [
      { name: "valid", type: "boolean", required: true },
      { name: "reason", type: "string", required: false, nullable: true },
    ],
  },
  execution: { deterministic: true, timeoutMs: 5_000, idempotent: true },
  sideEffect: "none",
  network: { egress: "none", hosts: [] },
  secrets: { access: "none", refs: [] },
  cost: { estimatedMicroUsd: "0" },
  evidence: { producesArtifacts: false },
};

/** The schema-validator adapter: the domain's pure schema check as a tool. */
export const schemaValidatorAdapter: ToolAdapter = {
  async execute(dispatch: ToolDispatch, _context: ToolDispatchContext): Promise<ToolObservation> {
    const { schema, payload } = dispatch.input as { schema: unknown; payload: unknown };
    if (!isToolFieldSchema(schema)) {
      return {
        kind: "tool-failure",
        failure: {
          failureClass: "tool-execution",
          message: "schema field is not a valid field schema",
          retryable: false,
        },
      };
    }
    const check = checkAgainstSchema(schema, payload);
    if (check.ok) {
      return { kind: "tool-success", output: { valid: true, reason: null } };
    }
    return { kind: "tool-success", output: { valid: false, reason: check.reason } };
  },
};

/** Capability facts composition roots publish for the built-in tools. */
export const SEED_BUILT_IN_TOOL_FACTS: readonly PublishedCapabilityFact[] = [
  {
    claim: {
      id: "arithmetic",
      kind: "tool",
      version: "1.0.0",
      attributes: { deterministic: true },
    },
    provenance: { publisher: PUBLISHER, publishedAt: PUBLISHED_AT },
    evidence: { kind: "adapter-declared", reference: "tools:builtins:calculator@1.0.0" },
  },
  {
    claim: {
      id: "json-schema-validation",
      kind: "algorithm",
      version: "1.0.0",
      attributes: { deterministic: true },
    },
    provenance: { publisher: PUBLISHER, publishedAt: PUBLISHED_AT },
    evidence: { kind: "adapter-declared", reference: "tools:builtins:schema-validator@1.0.0" },
  },
];

/** The registered built-in tools (contract + adapter pairs). */
export const BUILT_IN_TOOLS: ReadonlyArray<{
  readonly contract: ToolContract;
  readonly adapter: ToolAdapter;
}> = [
  { contract: CALCULATOR_CONTRACT, adapter: calculatorAdapter },
  { contract: SCHEMA_VALIDATOR_CONTRACT, adapter: schemaValidatorAdapter },
];
