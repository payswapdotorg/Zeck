# ADR-0001 — Execution as the Primary Abstraction

**Status:** Accepted

AI work is represented as an Execution rather than a provider/model call. An execution may compose multiple models, tools, programs, agents, verification steps and humans. This keeps the developer contract stable as providers and model capabilities evolve.
