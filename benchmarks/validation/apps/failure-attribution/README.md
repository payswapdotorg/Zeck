# Failure-Attribution Application (VAL-020)

A customer-style failure-injection and attribution application: one
pinned probe corpus row per run, submitted through Zeck's public SDK
boundary, driving the platform's provider/model/tool failure taxonomy
end to end — every observed failure attributed to the correct layer
(transport vs provider vs tool vs platform) with the correct
retryability classification, through bounded retry/recovery policies,
with per-attempt journal evidence.

## The pinned corpus (`failure-attribution.probe.v1`)

| Row | Injected/observed class | Layer | Retryable | Attempts | Terminal |
|---|---|---|---|---|---|
| transport-failure | transport-failure (injected ECONNREFUSED) | transport | yes | 3 (bounded) | FAILED |
| quota-envelope | quota (dashscope AllocationQuota.FreeTierOnly 403) | provider | no | 1 | FAILED |
| openrouter-credit-402 | quota (OpenRouter error.code 402) | provider | no | 1 | FAILED |
| rate-limit | rate-limit (OpenRouter 429) | provider | yes | 3 (bounded) | FAILED |
| invalid-request | invalid-request (dashscope InternalError.Algo.InvalidParameter 400) | provider | no | 1 | FAILED |
| access-denied | access-denied (dashscope AccessDenied 403) | provider | no | 1 | FAILED |
| empty-completion | empty-completion (the empty-content 200) | provider | no | 1 | **COMPLETED** (honest success with empty content — the VAL-014 rule) |
| tool-failure | tool-failure (settled tool refusal) | tool | no | 1 | FAILED |
| tool-timeout | tool-timeout (deadline overrun) | tool | yes | 3 (bounded) | FAILED |
| healthy-recovery-after-retry | transport-failure then success | transport | yes | 2 | **COMPLETED** (retry history journaled exactly once per attempt) |
| healthy-no-retry | none (clean success) | — | — | 1 | COMPLETED |

## Live rail rows (env-gated; driven by the Lead's authorized credentials)

| Row | Rail | Documented posture | Expected |
|---|---|---|---|
| live-openrouter-healthy | REAL OpenRouter chat (OPENROUTER_API_KEY) | working credit-bearing key | COMPLETED, 1 attempt |
| live-qwen-imagegen-quota | REAL dashscope multimodal-generation (QWEN_API_KEY) | image-generation quota-blocked (AllocationQuota.FreeTierOnly) | FAILED, provider/quota, 1 attempt |
| live-qwen-video-access-denied | REAL dashscope video-synthesis (QWEN_API_KEY) | tier boundary (AccessDenied 403) | FAILED, provider/access-denied, 1 attempt |
| live-openrouter-credit-402 | REAL OpenRouter chat (OPENROUTER_API_KEY + ZECK_VAL_020_OPENROUTER_402_MODEL) | the deliberately pinned premium model over the balance | FAILED, provider/quota, 1 attempt |

A live-posture change (an operator payment lifting a quota) is an
honest finding that re-pins the row — never a silently tolerated
mismatch.

## Boundaries

- Integrates ONLY through the public SDK (the validation harness) —
  never Zeck internals; never selects provider/model/rail (the task
  references the corpus scenario; the platform derives the route).
- Offline rows replay the REAL provider failure envelope shapes from
  the documented live runs (code tokens verbatim; message text
  representative where the findings preserved only the code) through
  deterministic fault-injection transports — zero network dependence,
  zero credentials.
- Evidence carries payload DIGESTS, never payload bytes; usage, cost
  and latency are measured, never estimated.
- Configuration is repository-reproducible and secret-free; the single
  secret is the environment token (`ZECK_VALIDATION_TOKEN`).

## Run

Executed by the validation integration suite
(`tests/integration/validation/val-020-failure-attribution.test.ts`).
