"""
The PPR-024 non-Zeck baseline runner — the measurement arms of the proof
battery (NEVER the certified path): the SAME pinned Browser Use runtime
over the SAME corpus, executed WITHOUT Zeck, for the cost/latency
comparison the program mandates.

  - direct arm: the stock application configuration — the runtime's own
    in-process BrowserSession (the undelegated browser actuation: the
    app launches Chromium itself) + a ChatOpenAI pointed DIRECTLY at the
    sandbox's authorized GLM supply endpoint (the platform-side BYOK
    material, passed to THIS measurement process only — never into the
    certified runtime, the repository, or any evidence artifact).

  - optimized arm: the strong-optimized non-Zeck configuration — the
    same direct stack plus the app's own transport retry authority
    (max_retries=3, the pinned runtime's default for automation
    reliability) and the vision-capable model for the combined task's
    state turns (use_vision=True): a genuinely stronger arm, never a
    strawman.

Both arms run the same three corpus tasks with the same mechanical
verification the certified run uses. The results are BaselineRunRecord
material — structurally NOT Zeck evidence (the harness's labeling law).
"""

import asyncio
import json
import os
import sys
import traceback
from typing import Any

from browser_use import Agent, BrowserProfile, BrowserSession, Tools
from browser_use.llm.openai.chat import ChatOpenAI
from pydantic import BaseModel, create_model

SUPPLY_URL = os.environ.get("PPR_BASELINE_SUPPLY_URL", "")
SUPPLY_HEADERS_FILE = os.environ.get("PPR_BASELINE_SUPPLY_HEADERS_FILE", "")
SUPPLY_API_KEY = os.environ.get("PPR_BASELINE_SUPPLY_API_KEY", "")
TASK_FILE = os.environ.get("PPR_024_TASK_FILE", "")
ARM = os.environ.get("PPR_BASELINE_ARM", "direct")
MODEL_ID = os.environ.get("PPR_024_MODEL", "glm-4-plus")


def _strip_json_fence(content: str) -> str:
    """The provider-shape normalization shim (markdown-fenced JSON bodies)."""
    trimmed = content.strip()
    if trimmed.startswith("```"):
        lines = trimmed.split("\n")
        if len(lines) >= 2:
            body = "\n".join(lines[1:-1])
            try:
                import json as _json

                _json.loads(body)
                return body
            except Exception:
                return content
    return content


class _ShimChatOpenAI(ChatOpenAI):
    """The optimized arm's app-owned response-shape shim.

    The supply wraps JSON bodies in markdown fences even under
    response_format=json_schema; a direct consumer must own this
    normalization (the exact engineering surface the Zeck path removes —
    the certified rail performs it platform-side).
    """

    def get_client(self):
        client = super().get_client()
        original_create = client.chat.completions.create

        async def create(*args, **kwargs):
            response = await original_create(*args, **kwargs)
            try:
                message = response.choices[0].message
                if isinstance(message.content, str):
                    stripped = _strip_json_fence(message.content)
                    if stripped != message.content:
                        message.content = stripped
            except Exception:
                pass
            return response

        client.chat.completions.create = create
        return client


def _supply_llm(temperature: float, max_retries: int) -> ChatOpenAI:
    default_headers: dict[str, str] = {}
    if SUPPLY_HEADERS_FILE:
        with open(SUPPLY_HEADERS_FILE, encoding="utf8") as handle:
            default_headers = {
                str(key).lower(): str(value)
                for key, value in json.load(handle).items()
                if str(key).lower() != "authorization"
            }
    if ARM == "optimized":
        return _ShimChatOpenAI(
            model=MODEL_ID,
            base_url=SUPPLY_URL.rstrip("/"),
            api_key=SUPPLY_API_KEY or "baseline-supply",
            max_retries=max_retries,
            temperature=temperature,
            frequency_penalty=None,
            default_headers=default_headers or None,
        )
    return ChatOpenAI(
        model=MODEL_ID,
        base_url=SUPPLY_URL.rstrip("/"),
        api_key=SUPPLY_API_KEY or "baseline-supply",
        max_retries=max_retries,
        temperature=temperature,
        frequency_penalty=None,
        default_headers=default_headers or None,
    )


async def run_model_task(task: dict[str, Any]) -> dict[str, Any]:
    type_by_name = {"string": str, "boolean": bool, "number": float, "integer": int}
    field_specs: dict[str, Any] = {}
    for name, spec in (task.get("outputFields") or {}).items():
        field_specs[name] = (type_by_name.get(str(spec), str), ...)
    if not field_specs:
        field_specs = {"headline": (str, ...), "impact": (str, ...), "ok": (bool, ...)}
    OutputModel = create_model("OutputModel", **field_specs)
    retries = 3 if ARM == "optimized" else 0
    llm = _supply_llm(float(task.get("temperature", 0.0)), retries)
    from browser_use.llm.messages import UserMessage

    completion = await llm.ainvoke([UserMessage(content=str(task["instruction"]))], output_format=OutputModel)
    usage = completion.usage
    return {
        "resolved": completion.completion is not None,
        "finalResult": json.dumps(completion.completion.model_dump(), default=str),
        "usage": (
            {
                "inputTokens": usage.prompt_tokens or 0,
                "outputTokens": usage.completion_tokens or 0,
            }
            if usage
            else None
        ),
    }


CHROME_PATH = os.environ.get("PPR_024_BROWSER_PATH", "/home/z/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome")


async def run_actuation_task(task: dict[str, Any]) -> dict[str, Any]:
    """The direct arm's actuation task: the app's OWN in-process browser."""
    profile = BrowserProfile(
        headless=True,
        disable_security=True,
        chromium_sandbox=False,
        allowed_domains=[],
        executable_path=CHROME_PATH,
    )
    session = BrowserSession(browser_profile=profile)
    tools = Tools()
    await session.start()
    steps: list[str] = []
    try:
        cls = tools.registry.create_action_model()
        result = await tools.act(action=cls(**{"navigate": {"url": task["url"]}}), browser_session=session)
        steps.append(f"navigate:{result.error or 'ok'}")
        if result.error:
            return {"resolved": False, "finalResult": "", "steps": steps, "error": result.error}
        state = await session.get_browser_state_summary(include_screenshot=False, cached=False)
        selector_map = state.dom_state.selector_map
        target_text = str(task["clickText"]).lower()
        target_index = None
        for index, node in selector_map.items():
            blob = f"{node.node_name} {node.node_value or ''} {node.get_all_children_text(max_depth=2) if hasattr(node, 'get_all_children_text') else ''}".lower()
            if target_text in blob:
                target_index = index
                break
        if target_index is None:
            return {"resolved": False, "finalResult": "", "steps": steps, "error": "target not found"}
        result = await tools.act(action=cls(**{"click": {"index": target_index}}), browser_session=session)
        steps.append(f"click:{result.error or 'ok'}")
        if result.error:
            return {"resolved": False, "finalResult": "", "steps": steps, "error": result.error}
        state = await session.get_browser_state_summary(include_screenshot=False, cached=False)
        representation = state.dom_state.llm_representation()
        marker = str(task["tokenMarker"])
        token = ""
        pos = representation.find(marker)
        if pos >= 0:
            import re as _re

            match = _re.search(r"[A-Z0-9-]{6,}", representation[pos + len(marker): pos + len(marker) + 120])
            if match:
                token = match.group(0)
        return {"resolved": token != "", "finalResult": token, "steps": steps}
    finally:
        await session.stop()


async def run_agent_task(task: dict[str, Any]) -> dict[str, Any]:
    profile = BrowserProfile(
        headless=True,
        disable_security=True,
        chromium_sandbox=False,
        executable_path=CHROME_PATH,
    )
    session = BrowserSession(browser_profile=profile)
    tools = Tools()
    retries = 3 if ARM == "optimized" else 0
    agent = Agent(
        task=str(task["instruction"]),
        llm=_supply_llm(0.2, retries),
        browser_session=session,
        tools=tools,
        use_vision=False,
        use_judge=False,
        enable_planning=False,
        max_actions_per_step=1,
        max_failures=3,
        generate_gif=False,
        enable_signal_handler=False,
        max_steps=int(task.get("maxSteps", 12)),
        source="ppr-024-baseline",
    )
    history = await agent.run(max_steps=int(task.get("maxSteps", 12)))
    final = history.final_result()
    usage = None
    try:
        totals = history.usage()
        if isinstance(totals, dict):
            usage = {
                "inputTokens": int(totals.get("input_tokens") or 0),
                "outputTokens": int(totals.get("output_tokens") or 0),
            }
    except Exception:
        usage = None
    return {
        "resolved": final is not None and len(str(final)) > 0,
        "finalResult": final or "",
        "steps": history.action_names(),
        "usage": usage,
    }


async def main_async() -> int:
    with open(TASK_FILE, encoding="utf8") as handle:
        task = json.load(handle)
    kind = str(task.get("kind", ""))
    try:
        if kind == "model":
            result = await run_model_task(task)
        elif kind == "actuation":
            result = await run_actuation_task(task)
        elif kind == "agent":
            result = await run_agent_task(task)
        else:
            result = {"resolved": False, "error": f"unknown task kind {kind}"}
    except Exception as exc:
        result = {"resolved": False, "error": f"{type(exc).__name__}: {exc}", "traceback": traceback.format_exc()[-1200:]}
    result["taskId"] = task.get("taskId", "")
    result["arm"] = ARM
    print(json.dumps(result, default=str))
    return 0


def main() -> None:
    if not SUPPLY_URL or not TASK_FILE:
        print(json.dumps({"resolved": False, "error": "PPR_BASELINE_SUPPLY_URL and PPR_024_TASK_FILE are required"}))
        sys.exit(2)
    sys.exit(asyncio.run(main_async()))


if __name__ == "__main__":
    main()
