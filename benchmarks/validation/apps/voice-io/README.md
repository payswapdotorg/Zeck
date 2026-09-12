# Voice Input/Output Application (VAL-014)

A customer-style voice application covering BOTH voice directions —
speech-to-text and text-to-speech — through Zeck's public SDK boundary.

## What it does

Submits pinned voice corpus tasks and asserts the deterministic outcome
contract per row:

- `transcribe-utterance` — speech-to-text over deterministic synthetic
  clips (the utterance and briefing families): the REAL ASR rail
  (dashscope-international dedicated task API, `qwen3-asr-flash`)
  transcribes the clip; the fixture's ground-truth annotation and the
  observed transcript are recorded in the mechanical criteria evidence
  (payload DIGESTS, never bytes).
- `transcribe-roundtrip` — the strong transcript oracle: the REAL TTS
  rail synthesizes the pinned phrase into REAL speech, the REAL ASR
  rail transcribes it, and the transcript is verified against the
  phrase fixture's own ground-truth terms (in-code synthesis cannot
  produce intelligible speech, so the transcript-vs-ground-truth
  oracle rides REAL provider speech — recorded honestly).
- `synthesize-speech` — text-to-speech over pinned phrases: the REAL
  TTS rail (`qwen3-tts-flash`) synthesizes audio that is verified
  mechanically (container/codec validity, non-empty payload, digest
  capture) since byte-level audio ground truth is not provider-stable.
- The corrupted-clip edge row asserts the honest failure contract
  (terminal `FAILED`, verification `FAIL` — the provider rejects
  genuinely undecodable audio); the empty-text edge row asserts the
  platform's pre-dispatch rejection (never dispatched, never retried).

## Boundaries

- Integrates ONLY through the public SDK (the validation harness) —
  never Zeck internals; never selects provider/model/rail.
- Configuration is repository-reproducible and secret-free; the single
  secret is the environment token (`ZECK_VALIDATION_TOKEN`). Provider
  credentials are platform-side env-gated (`QWEN_API_KEY`) and never
  appear in the repository, logs or evidence.
- The platform (Zeck's operators) plans the route, drives the REAL ASR
  and TTS dispatches (environment-credential gated, honest NOT RUN
  boundaries when absent) and records the mechanical verification
  criteria; evidence references carry payload DIGESTS, never audio
  bytes.

## Run

The application is executed by the validation integration suite
(`tests/integration/validation/val-014-voice.test.ts`), which binds the
run-time configuration, the served API and the real platform dispatch. A
clean checkout reproduces the same pinned tasks, the same fixtures and
the same assertions.
