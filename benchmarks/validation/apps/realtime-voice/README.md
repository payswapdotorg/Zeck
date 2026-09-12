# Realtime Voice-Loop Application (VAL-014)

A customer-style realtime voice-loop application: bounded, typed voice
sessions submitted through Zeck's public SDK boundary.

## What it does

Submits pinned `voice-loop` session tasks (a declared, bounded turn
stream — never an unbounded stream claim) and asserts the deterministic
outcome contract per session. Each session drives the platform's
BOUNDED typed turn protocol:

- per turn: the user's clip is transcribed by the REAL ASR rail and the
  platform's pinned reply phrase is synthesized by the REAL TTS rail
  (both legs mechanically verified; payload DIGESTS in evidence, never
  bytes);
- durable turn checkpoints (digest + position) after every committed
  turn — resumable session boundaries;
- wait-user/resume cycles at the session's designed interruption
  boundary, with exactly-once turn accounting across resumes (no turn
  dispatched twice), a stale-worker resume denial (journaled), a
  corrupted-checkpoint detection edge (the honest FAILED row), and a
  no-op resume replay after terminal (the platform's idempotency).

## Realtime-rail boundary (honest)

A true streaming realtime voice rail (a WebSocket voice session API) is
NOT authorized in this validation environment. The realtime surface is
proven through the platform's session/resumability semantics over the
REAL execution lifecycle with REAL per-turn ASR/TTS dispatches; the
exact missing access requirement is surfaced by the platform module
(`REALTIME_VOICE_RAIL_REQUIREMENT`) and recorded in the evidence
document — never converted into a silent pass.

## Boundaries

- Integrates ONLY through the public SDK (the validation harness) —
  never Zeck internals; never selects provider/model/rail.
- Configuration is repository-reproducible and secret-free; the single
  secret is the environment token (`ZECK_VALIDATION_TOKEN`). Provider
  credentials are platform-side env-gated (`QWEN_API_KEY`) and never
  appear in the repository, logs or evidence.

## Run

The application is executed by the validation integration suite
(`tests/integration/validation/val-014-voice.test.ts`), which binds the
run-time configuration, the served API and the real platform dispatch. A
clean checkout reproduces the same pinned sessions, the same fixtures
and the same assertions.
