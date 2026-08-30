# ADR-0017 — Multimodal Deployment Product Surface

**Status:** accepted

Zeck will treat voice, realtime, messaging, video, image, audio, document/vision and future modalities as deployment profiles over the same governed Execution/Agent substrate.

The platform should hide upstream transport/infrastructure complexity behind provider-neutral adapters and let users specify goals, channels/modalities, budgets, permissions, quality/latency targets and escalation rules.

Agent remains a participant inside Execution. Modality adapters never become independent authorities for policy, budget, capability, execution, verification or tenant state.
