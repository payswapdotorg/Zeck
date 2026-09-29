#!/usr/bin/env python3
"""The PPR-020 corpus driver — runs ONE representative coding-agent task
through the PINNED, UNMODIFIED OpenHands agent SDK (openhands-sdk 1.49.6 /
openhands-tools 1.49.6, installed editable from the exact upstream git
revisions recorded in the work log) inside the certified proof environment.

This file is PROOF-HARNESS GLUE (the Zeck repository's compat surface), not
OpenHands code: it configures the pinned application runtime through the
SDK's OWN public configuration surface — LLM(model, base_url, api_key, ...),
Agent(llm, tools, condenser), Conversation(agent, workspace) — exactly the
seam a real OpenHands user configures (examples/01_standalone_sdk/*.py).
No OpenHands file is forked, patched or shimmed, and nothing here teaches
OpenHands about Zeck: the ONLY thing it hands the runtime is an
OpenAI-compatible base URL (the local Zeck adapter) and the literal
placeholder api key the client-side shape check requires.

Usage (from the Zeck-side corpus runner):
    python openhands_task.py <task-spec.json>

The task spec (JSON):
    {
      "task_id": "...",
      "instruction": "...",            # the user message text
      "followups": ["...", ...],       # optional extra user turns
      "image": "path.png" | null,      # optional image attachment (vision edge)
      "tools": ["terminal", "file_editor", "task_tracker", "ask_oracle",
                "task_tool_set"],
      "terminal_type": "subprocess",   # the sandbox has no tmux server
      "max_iterations": 60,
      "condenser": {"max_size": 10, "keep_first": 2} | null,
      "seed_oracle_profile": true|false,
      "llm": {"model": "openai/glm-4-plus",
              "base_url": "http://127.0.0.1:<port>/v1",
              "api_key": "zeck-local-adapter",
              "vision": true|false,
              "max_retries": 2,
              "extra_headers": {"x-...": "..."} }  # optional — the
             # direct-baseline arm's session headers (the app holds the
             # credential for that arm, by definition of a direct baseline)
    }

Output: a single JSON object on the LAST stdout line:
    {"ok": true|false, "error": str|null, "final_message": str,
     "iterations": n, "events": n, "exit_status": str}
"""

from __future__ import annotations

import base64
import json
import os
import sys
import traceback
from pathlib import Path

OPENHANDS_SUPPRESS_BANNER = "1"
os.environ.setdefault("OPENHANDS_SUPPRESS_BANNER", OPENHANDS_SUPPRESS_BANNER)

from pydantic import SecretStr  # noqa: E402

from openhands.sdk import (  # noqa: E402
    Agent,
    Conversation,
    ImageContent,
    LLM,
    Message,
    TextContent,
)
from openhands.sdk.context.condenser import LLMSummarizingCondenser  # noqa: E402
from openhands.sdk.llm.llm_profile_store import LLMProfileStore  # noqa: E402
from openhands.sdk.tool import Tool  # noqa: E402
from openhands.tools.ask_oracle import AskOracleTool  # noqa: E402
from openhands.tools.file_editor import FileEditorTool  # noqa: E402
from openhands.tools.task import TaskToolSet  # noqa: E402
from openhands.tools.task_tracker import TaskTrackerTool  # noqa: E402
from openhands.tools.terminal import TerminalTool  # noqa: E402

TOOL_CONSTRUCTORS = {
    "terminal": TerminalTool,
    "file_editor": FileEditorTool,
    "task_tracker": TaskTrackerTool,
    "ask_oracle": AskOracleTool,
    "task_tool_set": TaskToolSet,
}


def build_tools(names: list[str], terminal_type: str) -> list[Tool]:
    tools: list[Tool] = []
    for name in names:
        if name == "terminal":
            # The sandbox has no tmux server: the terminal tool's own
            # subprocess backend (its public configuration axis).
            tools.append(Tool(name=TerminalTool.name, terminal_type=terminal_type))
        else:
            ctor = TOOL_CONSTRUCTORS.get(name)
            if ctor is None:
                raise ValueError(f"unknown tool in task spec: {name}")
            tools.append(Tool(name=ctor.name))
    return tools


def seed_oracle_profile(home: Path, model: str, base_url: str, api_key: str) -> None:
    """Seed the `oracle` LLM profile (the SDK's own profile-store surface).

    The ask_oracle tool resolves a saved profile named "oracle" by convention
    (ORACLE_PROFILE_NAME). We save one pointing at the SAME delegated seam
    (the local Zeck adapter + the placeholder key) through the SDK's own
    LLMProfileStore API — the application's configuration surface, never a
    code change.
    """
    from openhands.sdk.llm.llm import LLM as SDKLLM

    store = LLMProfileStore(base_dir=home / ".openhands" / "profiles")
    oracle_llm = SDKLLM(
        usage_id="oracle",
        model=model,
        base_url=base_url,
        api_key=SecretStr(api_key),
        api_mode="chat",
    )
    # include_secrets=True: the only secret-shaped value here is the
    # literal PLACEHOLDER (the litellm client's shape check requires a
    # non-empty key) — never a provider credential — so it must persist
    # for the stateless oracle consult to build its client.
    store.save("oracle", oracle_llm, include_secrets=True)


def main() -> int:
    spec_path = Path(sys.argv[1] if len(sys.argv) > 1 else "")
    if not spec_path.is_file():
        emit(ok=False, error=f"task spec not found: {spec_path}")
        return 2

    spec = json.loads(spec_path.read_text(encoding="utf-8"))
    workspace = Path(spec.get("workspace") or Path.cwd()).resolve()
    home = Path(spec.get("home") or Path.cwd()).resolve()

    llm_spec = spec["llm"]
    llm_kwargs: dict = {
        "usage_id": "agent",
        "model": llm_spec["model"],
        "base_url": llm_spec["base_url"],
        "api_key": SecretStr(llm_spec["api_key"]),
        "api_mode": "chat",
        "max_retries": int(llm_spec.get("max_retries", 2)),
    }
    # The DIRECT-baseline arm's credential materialization: the supply
    # endpoint authenticates through session headers (x-chat-id/
    # x-user-id/x-token) that a Bearer-only api_key cannot carry, so the
    # direct arm passes them through the LLM constructor's own public
    # extra_headers field (the application's configuration axis — the
    # credential lives in the APPLICATION runtime for this arm, by
    # definition of a direct baseline; the Zeck arm never sees it).
    extra_headers = llm_spec.get("extra_headers")
    if isinstance(extra_headers, dict):
        llm_kwargs["extra_headers"] = {
            str(k): str(v) for k, v in extra_headers.items()
        }
    if llm_spec.get("vision"):
        llm_kwargs["capability_overrides"] = {"supports_vision": True}
        # Upstream behavior at the pinned revision (disclosed): the SDK's
        # model-features fallback force-string-serializes any model id
        # containing the substring "glm" (FORCE_STRING_SERIALIZER_MODELS),
        # which silently DROPS ImageContent parts from every message —
        # the vision surface would never see the attachment. The LLM
        # constructor's own public `force_string_serializer` override
        # (precedence over the auto-detection) restores the list
        # serializer, so image parts reach the wire. This is the
        # application's own configuration axis — no fork, no patch.
        llm_kwargs["force_string_serializer"] = False
    llm = LLM(**llm_kwargs)

    if spec.get("seed_oracle_profile"):
        seed_oracle_profile(
            home, llm_spec["model"], llm_spec["base_url"], llm_spec["api_key"]
        )

    condenser = None
    condenser_spec = spec.get("condenser")
    if condenser_spec:
        condenser = LLMSummarizingCondenser(
            llm=llm.model_copy(update={"usage_id": "condenser"}),
            max_size=int(condenser_spec.get("max_size", 10)),
            keep_first=int(condenser_spec.get("keep_first", 2)),
        )

    tools = build_tools(spec.get("tools", ["terminal"]), spec.get("terminal_type", "subprocess"))
    agent = Agent(
        llm=llm,
        tools=tools,
        condenser=condenser,
        max_iterations=int(spec.get("max_iterations", 60)),
    )

    conversation = Conversation(
        agent=agent,
        workspace=str(workspace),
        persistence_dir=str(workspace / ".conversations"),
    )

    instruction = spec["instruction"]
    image_path = spec.get("image")
    if image_path:
        png = Path(image_path).read_bytes()
        data_url = "data:image/png;base64," + base64.b64encode(png).decode("ascii")
        message = Message(
            role="user",
            content=[
                TextContent(text=instruction),
                ImageContent(image_urls=[data_url]),
            ],
        )
        conversation.send_message(message)
    else:
        conversation.send_message(instruction)
    conversation.run()

    for followup in spec.get("followups", []):
        conversation.send_message(followup)
        conversation.run()

    final_message = ""
    try:
        from openhands.sdk.conversation.response_utils import get_agent_final_response

        final_message = get_agent_final_response(conversation.state.events) or ""
    except Exception:  # noqa: BLE001 - best-effort final-answer extraction
        final_message = ""

    try:
        event_count = len(conversation.state.events)
    except TypeError:
        event_count = len(list(conversation.state.events))
    emit(
        ok=True,
        error=None,
        final_message=final_message[:2000],
        iterations=int(spec.get("max_iterations", 60)),
        events=int(event_count),
        exit_status=str(conversation.state.execution_status),
    )
    return 0


def emit(**payload) -> None:
    """Print the machine-readable result as the LAST stdout line."""
    print("OPENHANDS_RESULT:" + json.dumps(payload, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    try:
        sys.exit(main())
    except SystemExit:
        raise
    except BaseException:  # noqa: BLE001 - the runner records honest failures
        traceback.print_exc()
        emit(ok=False, error=traceback.format_exc(limit=4)[:1500], final_message="",
             iterations=0, events=0, exit_status="ERROR")
        sys.exit(1)
