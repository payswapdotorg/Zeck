# Deployment Profile Taxonomy

Zeck deployment profiles are capability declarations and runtime compositions, not vendor identities.

| Profile | Primary modalities | Typical external rails | Typical Zeck composition |
|---|---|---|---|
| `realtime-voice` | audio in/out | realtime media, telephony, SIP | agent + STT/LLM/tools/TTS + policy + budget + escalation |
| `messaging` | text, attachments | messaging networks | agent + context + tools + delivery adapter |
| `media-generation` | video, image, audio | media inference/storage rails | async model + deterministic transforms + artifact lineage + verification |
| `document-vision` | documents, images | OCR/vision rails | retrieval/OCR + deterministic extraction + model escalation + verification |
| `realtime-multimodal` | text/audio/video/vision | realtime/media rails | agent + mixed modality adapters + tools + policy |
| `background-automation` | scheduled/event-driven | customer/event rails | execution plan + tools + agents/models as needed |

New profiles should be added by extending the capability vocabulary and adapter contracts, not by creating another execution authority.
