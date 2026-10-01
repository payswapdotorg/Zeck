#!/usr/bin/env python3
"""The PPR-022 media-surface driver — drives ONE voice-memo transcription
through the PINNED, UNMODIFIED Hermes-Agent runtime's own transcription
surface (tools.transcription_tools.transcribe_audio — the exact function
the gateway dispatches inbound voice notes through), inside the certified
proof environment.

This file is PROOF-HARNESS GLUE (the Zeck repository's compat surface),
not Hermes code: it invokes the pinned application runtime through its
own public module surface with the certified configuration
(stt.provider=openai + the shared tts.openai.{api_key,base_url} audio
resolution pointed at the local Zeck adapter). No Hermes file is forked,
patched or shimmed, and nothing here teaches Hermes about Zeck: the ONLY
things the runtime sees are its own config.yaml and the literal
placeholder api key the client-side shape check requires.

Usage (from the Zeck-side corpus runner):
    python hermes_media.py transcribe <audio-file>

Output: a single JSON object on the LAST stdout line:
    {"ok": true|false, "error": str|null, "transcript": str, "provider": str}
"""

from __future__ import annotations

import json
import sys
import traceback


def main() -> int:
    if len(sys.argv) < 3 or sys.argv[1] != "transcribe":
        emit(ok=False, error="usage: hermes_media.py transcribe <audio-file>", transcript="", provider="")
        return 2
    audio_path = sys.argv[2]

    from tools.transcription_tools import transcribe_audio

    try:
        result = transcribe_audio(audio_path)
    except Exception:
        traceback.print_exc()
        emit(ok=False, error=traceback.format_exc(limit=4)[:1200], transcript="", provider="")
        return 1

    ok = bool(result.get("success"))
    emit(
        ok=ok,
        error=str(result.get("error") or "")[:400] or None,
        transcript=str(result.get("transcript") or ""),
        provider=str(result.get("provider") or ""),
    )
    return 0 if ok else 1


def emit(**payload) -> None:
    """Print the machine-readable result as the LAST stdout line."""
    print("HERMES_MEDIA:" + json.dumps(payload, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    try:
        sys.exit(main())
    except SystemExit:
        raise
    except BaseException:  # noqa: BLE001 - the runner records honest failures
        traceback.print_exc()
        emit(ok=False, error=traceback.format_exc(limit=4)[:1200], transcript="", provider="")
        sys.exit(1)
