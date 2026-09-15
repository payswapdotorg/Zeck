# Codebase analysis — advisory opportunity findings

**One sentence:** `POST /codebase-analysis` runs an ADVISORY analysis
of a selected execution-graph subgraph as a governing Execution —
policy admission precedes codebase access, findings are pinned to
repository provenance, and human ratings advance findings through
evidence-gated states (advisory → candidate → verified) with NO
'promoted' state on this surface.

## The API surface (nine-part treatment)

### 1. One-sentence explanation

`POST /codebase-analysis` creates the analysis (bound to a governing
execution, completing through verification); `GET /codebase-analysis/:id`
reads the report; `POST /codebase-analysis/:id/ratings` records
preference-only human evaluation ratings; `POST
/codebase-analysis/:id/findings/:findingId/transition` advances one
finding with evidence.

### 2. Conceptual model

- **Analysis is an Execution**: the analysis runs through the
  executions authority (policy admission, lifecycle, verification
  binding — the analysis digest binds completion).
- Findings are **advisory evidence, never an authority**: their states
  are `advisory | candidate | verified`; promotion into your codebase
  is an external decision this surface deliberately does not model.
- Every finding carries **pinned provenance** (repository, revision,
  target nodes with file/symbol), **confidence** (level, population,
  basis) and **impact** with an honest basis
  (`measured | estimated | unknown`).
- Opportunity classes (the neutral vocabulary): `ai-addition,
  ai-removal, deterministic-replacement, tool-replacement,
  tool-composition, hybrid-decomposition, context-enhancement,
  verification-enhancement, human-evaluation`.
- **Ratings are preference-only** (`prefer-candidate | prefer-baseline
  | no-difference | insufficient-information`) — a rating is NEVER a
  verification PASS.

### 3. Minimal API example

```bash
curl -X POST "$ZECK_API_URL/codebase-analysis" \
  -H "authorization: Bearer $ZECK_TOKEN" \
  -H "content-type: application/json" \
  -H "idempotency-key: analysis-1" \
  -d '{
    "applicationId": "'"$ZECK_APPLICATION_ID"'",
    "source": { "repository": "github.com/acme/app", "revision": "<sha>" },
    "subgraph": { "nodes": [ /* selected execution-graph nodes */ ] }
  }'
```

### 4. SDK-types example

```typescript
import type { CodebaseAnalysisReport } from "../sdk";

const response = await fetch(`${baseUrl}/codebase-analysis`, {
  method: "POST",
  headers: {
    authorization: `Bearer ${token}`,
    "content-type": "application/json",
    "idempotency-key": "analysis-1",
  },
  body: JSON.stringify({
    applicationId,
    source: { repository: "github.com/acme/app", revision },
    subgraph: { nodes },
  }),
});
const report = (await response.json()) as CodebaseAnalysisReport;
for (const finding of report.findings) {
  console.log(finding.findingId, finding.class, finding.state);
}
```

### 5. Request/response schemas

Frozen wire types (`src/shared/wire.ts`): `CodebaseAnalysisRequest`
(closed keys: `applicationId, source {repository, revision}, subgraph,
friction {userFrictionThreshold?, maxPrompts?}?`), the report types
(`CodebaseAnalysisReport`, `CodebaseAnalysis`, `CodebaseFinding`,
`CodebasePrompt`), the rating receipt (`CodebaseRatingReceipt`) and the
transition receipt (`CodebaseFindingTransitionReceipt`). Closed
vocabularies: `questionKind` (`pair-preference |
behavior-preservation | replacement-acceptability`), `answer`
(`prefer-candidate | prefer-baseline | no-difference |
insufficient-information`), `toState` (`advisory | candidate |
verified`), `evidenceKind` (`rating | verified-equivalence`). Machine
projection: [machine/openapi.json](machine/openapi.json).

### 6. Expected lifecycle

- Pre-validation is synchronous and side-effect-free: a malformed
  subgraph fails 422 with NO row anywhere.
- The analysis execution runs the real lifecycle (authorize → plan →
  queue → start → analyze → verify → pass) — the 201 response already
  carries the completed advisory report.
- Ratings and transitions are idempotent POSTs (durable receipts with
  `replayed`).

### 7. Security and policy notes

- Policy admission precedes codebase access — a denial leaves no
  learning rows.
- The route DERIVES the finding/revision/context binding for ratings;
  the caller cannot assert it.
- Findings never auto-apply — this surface has no write path into any
  repository.

### 8. Cost/latency considerations

- One analysis = one execution's economics (route/cost/usage readable
  on the governing execution like any other).
- `friction.maxPrompts` bounds emitted human prompts
  (value-of-information gated by `userFrictionThreshold`).

### 9. Common failures and remedies

| Failure | Code | Remedy |
|---|---|---|
| Malformed subgraph | `CAPABILITY_UNAVAILABLE` 422 | Fix the selection (missing provenance, mixed revisions, unknown kinds all fail closed) |
| Finding not found | `CAPABILITY_UNAVAILABLE` 404 | Use a findingId from the report of THIS analysis |
| Illegal transition | `CAPABILITY_UNAVAILABLE` 422 | Transitions are single-step forward, evidence-gated (rating or verified-equivalence) |
| Rating with wrong vocabulary | `CAPABILITY_UNAVAILABLE` 422 | Use the closed answer/questionKind vocabularies |

Public contract links: `src/shared/wire.ts` (the codebase types),
`src/api/routes/codebase-analysis.ts`,
[machine/openapi.json](machine/openapi.json).
