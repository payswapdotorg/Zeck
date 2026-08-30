# Deterministicization Examples

These examples are normative guidance for planning/evaluation, not hard-coded heuristics.

## Simple replacement

`calculateInvoiceTotal(lines)`

AI may extract/interpret invoice lines, but once normalized numeric fields exist, total calculation should use deterministic arithmetic.

## Hybrid replacement

`contractRiskReview(document)`

1. deterministic PDF/text extraction;
2. deterministic clause segmentation;
3. retrieval of relevant policy clauses;
4. model interpretation only for ambiguous semantic questions;
5. deterministic consistency checks;
6. verification.

## Progressive elimination

A repeated AI normalization step can initially run as:

```text
AI normalizer -> validator
```

After sufficient evidence:

```text
AI normalizer (incumbent)
          +
 deterministic candidate (shadow)
          ↓
 differential evaluator
          ↓
 canary
          ↓
 deterministic candidate becomes primary
```

## Codebase advisory analysis

A customer can submit a selected call graph:

```text
HTTP handler
  -> parseRequest
  -> classifyIntent [LLM]
  -> normalizeEntity [LLM]
  -> validateSchema
  -> persist
```

Zeck may report:

- `parseRequest`: deterministic candidate;
- `classifyIntent`: likely AI-essential or hybrid;
- `normalizeEntity`: candidate for deterministicization if the observed mapping is stable;
- `validateSchema`: deterministic and should remain non-generative.

The report includes confidence, supporting executions, estimated savings and the evidence required before changing production behavior.
