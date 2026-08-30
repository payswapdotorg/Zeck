# API (transport only)

`src/api/` is the transport layer of the modular monolith. It composes
module public contracts (`src/modules/*/public.ts`) and shared primitives
only — never module internals, never platform adapters directly
(`IMPLEMENTATION.md` §3).

The Fastify transport and the composition root arrive with the Work Order
that owns the public API surface (WORK-015). Until then this directory is an
explicit placeholder preserving the boundary.
