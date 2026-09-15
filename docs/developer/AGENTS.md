# The governed agent inventory

**One sentence:** `/agents` is a READ-ONLY projection of the agents
authority — your application's agent inventory with lifecycle status,
versions, validation states and promotion/rollback selections — and
there is deliberately NO agent mutation route on the public surface.

## The API surface (nine-part treatment)

### 1. One-sentence explanation

`GET /agents` lists your application's agents; `GET /agents/:id`,
`GET /agents/:id/versions` and `GET /agents/:id/status` project one
agent's summary, version history and full status view.

### 2. Conceptual model

Agents are **governed inventory**: identity, versions and selections
change through their owning authorities (validation, promotion,
rollback) — the public API projects the resulting rows and mutates
nothing. Version identity is `definitionDigest`-bound; each version
carries a `validationState` (`pending | validated | invalid`); the
latest selection is a `promotion | rollback` record with actor and
timestamp.

### 3. Minimal API example

```bash
curl "$ZECK_API_URL/agents" \
  -H "authorization: Bearer $ZECK_TOKEN" \
  -H "x-zeck-application: $ZECK_APPLICATION_ID"
```

### 4. SDK example

```typescript
const agents = await client.listAgents();
for (const agent of agents) {
  console.log(agent.slug, agent.status, agent.activeVersion ?? "no active version");
}
const status = await client.getAgentStatus(agents[0]!.id);
console.log(status.activeVersion?.validationState, status.latestSelection?.kind);
```

Runnable: `examples/agent-inventory.ts`.

### 5. Request/response schemas

Frozen wire types (`src/shared/wire.ts`): `AgentSummary`
(`id, slug, name, description, status (active|suspended|retired),
activeVersionId, activeVersion, createdAt, updatedAt`), `AgentVersion`
(`id, agentId, version, definitionDigest, validationState,
validationNotes, createdAt`), `AgentStatusView` (`agent, activeVersion,
latestSelection, availableVersions`), `AgentPromotionStatus`
(`selectionId, kind (promotion|rollback), selectedVersionId,
rollbackOf, selectedBy, selectedAt`). Machine projection:
[machine/openapi.json](machine/openapi.json).

### 6. Expected lifecycle

Inventory reads are synchronous and cheap (scoped GETs over authority
rows). An empty list is normal for a fresh application. Version
promotions and rollbacks appear as new selection records — history is
append-only.

### 7. Security and policy notes

- Every getter is application-scoped; cross-tenant agents are
  unreachable (404 indistinguishable from missing).
- Agent credentials never cross this surface — the inventory carries
  only governance metadata.
- The inventory enumeration seam itself is owned by the agents
  authority; the API projects it.

### 8. Cost/latency considerations

Reads are scoped projections — no execution, no spend. Large
inventories enumerate per-application only.

### 9. Common failures and remedies

| Failure | Code | Remedy |
|---|---|---|
| 404 on an agent id | `CAPABILITY_UNAVAILABLE` | Wrong id or another application's agent — check the inventory first |
| Empty inventory | — | No agents registered for the application yet (normal) |
| `validationState: invalid` | — | The version failed validation — the authority's validation notes say why; select a validated version |

Public contract links: `src/shared/wire.ts`, `src/api/routes/agents.ts`,
`sdk/index.ts` (`listAgents`, `getAgentStatus`),
[machine/openapi.json](machine/openapi.json).
