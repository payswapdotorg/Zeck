# Multimodal Agent Deployment Contract

## Purpose

Define a single provider-neutral contract for deploying governed agents across channels and modalities.

## DeploymentRequest

A deployment request declares:

- agent identity/version
- application/environment scope
- channels and modalities
- input/output modality requirements
- latency and quality targets
- budget/resource constraints
- allowed capabilities/tools
- secret/reference requirements
- human escalation requirements
- isolation requirements
- external integration requirements

Vendor/provider choice is not part of the stable customer-domain abstraction.

## DeploymentPlan

An immutable deployment plan resolves:

- deployment profile
- required capabilities
- channel adapters
- model/agent/tool components
- context/artifact references
- policy snapshot
- budget reservation strategy
- isolation environment
- verification strategy
- escalation paths
- observability/evidence configuration

## Profiles

### Realtime voice

Supports interactive audio input/output, interruption, turn-taking, telephony or web realtime transport through external rails. The runtime must preserve low-latency constraints while retaining policy/tool/budget/provenance controls.

### Messaging

Supports conversational messaging through channel adapters. Channel identity must bind to application/tenant scope and message/event provenance.

### Media generation

Supports video, image, audio and multimodal generation as execution workloads. The planner may combine deterministic preprocessing, model generation, post-processing, validation and artifact lineage.

### Document/vision

Supports document ingestion, OCR, visual analysis, structured extraction and downstream tool/model execution.

### Realtime multimodal

Supports combinations of audio, video, text, vision and tool interaction under one Execution identity.

## Deployment lifecycle

```text
requested
  -> validated
  -> planned
  -> admitted
  -> provisioned
  -> active
  -> updating
  -> suspended
  -> retired
```

Every deployed configuration is versioned. Existing executions remain bound to the version they started with.

## Upstream rails

Zeck should prefer integration over reinvention for transport/infrastructure capabilities such as realtime media, telephony, messaging, storage, inference and media processing. Adapters normalize their APIs into Zeck's provider-neutral contracts.

## Deterministic-first rule

A deployed agent must not invoke a generative model merely because the deployment is labeled an "AI agent". The execution planner may select deterministic code, retrieval, algorithms, tools, or hybrid plans before generative inference.

## Safety requirements

- policy before external side effect
- tenant isolation before channel/resource access
- scoped/revocable credentials
- immutable deployment versions
- auditable promotion/rollback
- typed provider/channel failures distinct from quality/verification failures
- provenance from inbound event through tool/model actions to output
- idempotent message/call event handling where required
