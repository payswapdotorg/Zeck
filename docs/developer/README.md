# Zeck Developer Documentation — the public integration kit

**Audience: human developers AND coding agents.** These pages teach the
complete integration path from files alone — no maintainer chat, no
prose-only critical instructions. Every claim links to the artifact that
backs it; every machine-readable artifact is validated by an automated
battery (`tests/unit/developer-docs/`).

**Start here → [QUICKSTART.md](QUICKSTART.md)** — five minutes from zero
to your first sandbox execution, result, evidence and cost.

## The reading map

| If you want to… | Read |
|---|---|
| Run your first execution now | [QUICKSTART.md](QUICKSTART.md) |
| Understand what Zeck IS (the authority chain in developer terms) | [CONCEPTS.md](CONCEPTS.md) |
| Get credentials / set up an application | [AUTH.md](AUTH.md) |
| Integrate the execution lifecycle | [EXECUTIONS.md](EXECUTIONS.md) |
| Inspect evidence, provenance and cost | [EVIDENCE.md](EVIDENCE.md) |
| Read the governed agent inventory | [AGENTS.md](AGENTS.md) |
| Propose payment intents safely | [ECONOMICS.md](ECONOMICS.md) |
| Run advisory codebase analysis | [CODEBASE-ANALYSIS.md](CODEBASE-ANALYSIS.md) |
| Receive signed webhooks | [WEBHOOKS.md](WEBHOOKS.md) |
| Use the SDK / CLI reference | [SDK.md](SDK.md) |
| Pick your workload family (22 families) | [WORKLOADS.md](WORKLOADS.md) |
| Configure providers/models/tools (BYOK) | [CONFIGURATION.md](CONFIGURATION.md) |
| Understand the sandbox and its limits | [SANDBOX.md](SANDBOX.md) |
| Go to production (promotion, secrets, quotas) | [PRODUCTION.md](PRODUCTION.md) |
| Diagnose failures (error playbook) | [TROUBLESHOOTING.md](TROUBLESHOOTING.md) |
| Know what is honestly available | [AVAILABILITY.md](AVAILABILITY.md) |
| Integrate as a coding agent (machine recipe) | [AGENT-GUIDE.md](AGENT-GUIDE.md) |

## The machine-readable layer (first-class)

Everything a coding agent needs to discover the full integration path
without parsing prose:

| Artifact | Content |
|---|---|
| [machine/openapi.json](machine/openapi.json) | The public API surface — every route, header, request/response schema (validated against the live route table). |
| [machine/error-codes.json](machine/error-codes.json) | The canonical error taxonomy: code → HTTP status, retry guidance, cause, remedy. |
| [machine/env-vars.json](machine/env-vars.json) | The developer-side environment variable contract (names only, never values). |
| [machine/capability-manifest.json](machine/capability-manifest.json) | Seeded capabilities, the 22 workload families and honest availability facts. |
| [machine/examples-manifest.json](machine/examples-manifest.json) | Every example under `examples/` with its classification. |
| [machine/integration-recipe.json](machine/integration-recipe.json) | The deterministic 9-step agent integration recipe. |

## The frozen contracts these pages document

- **The wire contract** — `src/shared/wire.ts` (the ONE canonical
  source; the API serializes into these shapes and the SDK re-exports
  them — contract drift is impossible by construction).
- **The SDK** — `sdk/index.ts` (execution-centric, provider-neutral,
  app-scoped).
- **The API transport** — `src/api/server.ts` and `src/api/routes/`
  (transport-only: every route delegates to module authorities).

These files are documentation surfaces for this kit — they are never
changed by it.

## Examples

`examples/` holds copy/paste-runnable integration examples for every
supported workload family plus the platform-surface examples
(webhooks, economic actions, error discipline). See
[examples/README.md](../../examples/README.md) for the run matrix.

## Honesty guarantees (baked into this kit)

1. **No secrets** in any page or example — credential *names* only; the
   battery scans for credential-shaped literals.
2. **Availability is disclosed** — every workload family is either
   `runnable` or explicitly `provider-gated` with its recorded boundary
   ([AVAILABILITY.md](AVAILABILITY.md)); a NOT RUN boundary is never
   converted into a pass.
3. **Links are checked** — every internal link in these pages and the
   examples resolves to a real file (automated).
4. **Schemas are reconciled** — the machine artifacts are validated
   against the wire contract enums and the live route table (automated).
5. **The example code paths run** — selected examples execute
   end-to-end against the REAL public API server through the REAL SDK
   in the battery (automated).
