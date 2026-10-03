"""
The PPR-024 Zeck-side browser substrate driver — the actuation-plane
executor hosted on the ZECK side of the delegation boundary.

WHAT THIS IS (the work order's contract): the neutral tool/substrate
execution contract's executor for the browser actuation plane. The
Zeck-side execution driver (compat/browser-use/harness/worker.ts) drives
every substrate execution through the executions authority's own public
transitions; when the task is a substrate task (session open/close, state
extraction, action execution) it dispatches HERE, and this driver
performs the real browser operation with the PINNED runtime's own
BrowserSession/Tools over the real Chromium (cdp-use) — exactly the class
of relationship the model rail has to the GLM supply: the supply's own
code does the model inference under a Zeck execution; here the pinned
runtime's own browser code does the actuation under a Zeck execution.

WHAT THIS IS NOT: it is not part of the application process. The
application runtime (the Agent runner) never talks to this driver
directly — its only destination is the local Zeck adapter; the adapter
creates the REAL Zeck execution; the execution driver executes it by
calling this driver. The browser, its CDP connection and its DOM state
live on the Zeck side of the boundary (the delegated substrate).

The extraction LLM (page-extraction turns of the extract_content action)
is a ChatOpenAI pointed at the SAME Zeck adapter — the page-extraction
intelligence rides the SAME delegated model seam (the main edge), never
a direct provider call: this driver's process carries no provider
credentials and no non-loopback destination.

HTTP surface (loopback only, called by the Zeck-side execution driver):
  GET  /health                          -> {"ok": true}
  POST /open   {profile axes}           -> {sessionId, ...}
  POST /state  {sessionId, ...}         -> {state summary + representations}
  POST /action {sessionId, action}      -> {actionResult, postActionUrl}
  POST /close  {sessionId}              -> {stopped: true}
  POST /shutdown                        -> {} (graceful exit)
"""

import argparse
import asyncio
import base64
import logging
import sys
import uuid
from os.path import join
from pathlib import Path
from typing import Any

from aiohttp import web

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
logger = logging.getLogger("ppr-024-substrate-driver")

# The pinned runtime (the exact editable checkout installed in the venv).
from browser_use import BrowserProfile, BrowserSession, Tools
from browser_use.filesystem.file_system import FileSystem
from browser_use.browser.profile import ProxySettings
from browser_use.llm.openai.chat import ChatOpenAI
from browser_use.agent.views import ActionResult

import os as _os

SUBSTRATE_WORK_ROOT = _os.environ.get(
    "PPR_024_WORK_ROOT", "/tmp/ppr-024-battery/substrate"
)

SESSIONS: dict[str, dict[str, Any]] = {}


def _extraction_llm(adapter_base_url: str, model: str, api_key: str) -> ChatOpenAI:
    """The page-extraction LLM over the SAME delegated Zeck adapter seam."""
    return ChatOpenAI(
        model=model,
        base_url=f"{adapter_base_url.rstrip('/')}/v1",
        api_key=api_key,
        max_retries=0,
        temperature=0.0,
    )


async def handle_health(_: web.Request) -> web.Response:
    return web.json_response({"ok": True})


async def handle_open(request: web.Request) -> web.Response:
    body = await request.json()
    profile_axes: dict[str, Any] = {
        "headless": bool(body.get("headless", True)),
        "disable_security": True,
        "chromium_sandbox": False,
        "wait_for_network_idle_page_load_time": float(body.get("networkIdleWaitMs", 0.25)),
        "minimum_wait_page_load_time": float(body.get("minWaitPageLoadMs", 0.0) / 1000.0),
    }
    executable = body.get("chromeExecutablePath")
    if isinstance(executable, str) and executable:
        profile_axes["executable_path"] = executable
    user_data_dir = body.get("userDataDir")
    if isinstance(user_data_dir, str) and user_data_dir:
        Path(user_data_dir).mkdir(parents=True, exist_ok=True)
        profile_axes["user_data_dir"] = user_data_dir
    proxy_server = body.get("proxyServer")
    if isinstance(proxy_server, str) and proxy_server:
        profile_axes["proxy"] = ProxySettings(
            server=proxy_server,
            bypass=str(body.get("proxyBypass", "127.0.0.1,localhost")),
        )
    allowed = body.get("allowedDomains")
    if isinstance(allowed, list) and allowed:
        profile_axes["allowed_domains"] = [str(domain) for domain in allowed]
    wait_between = body.get("waitBetweenActionsMs")
    if isinstance(wait_between, (int, float)):
        profile_axes["wait_between_actions"] = float(wait_between) / 1000.0

    profile = BrowserProfile(**profile_axes)
    session = BrowserSession(browser_profile=profile)
    await session.start()
    session_id = f"substrate-{uuid.uuid4().hex[:12]}"
    adapter_base_url = str(body.get("adapterBaseUrl", ""))
    model = str(body.get("model", ""))
    api_key = str(body.get("apiKey", "zeck-local-adapter"))
    tools = Tools()
    extraction_llm = (
        _extraction_llm(adapter_base_url, model, api_key)
        if adapter_base_url and model
        else None
    )
    file_system = FileSystem(join(SUBSTRATE_WORK_ROOT, "fs", session_id))
    SESSIONS[session_id] = {
        "session": session,
        "tools": tools,
        "extraction_llm": extraction_llm,
        "file_system": file_system,
        "action_model_cls": tools.registry.create_action_model(),
    }
    cdp_url = session.cdp_url or ""
    logger.info("substrate session %s opened (cdp=%s, headless=%s)", session_id, cdp_url[:60], profile_axes["headless"])
    return web.json_response(
        {
            "sessionId": session_id,
            "cdpUrl": cdp_url,
            "headless": profile_axes["headless"],
        }
    )


def _child_text(node: Any, depth: int = 0) -> str:
    """The concatenated text of an element's direct child text nodes."""
    parts: list[str] = []
    children = getattr(node, "children_nodes", None) or []
    for child in children[:40]:
        if getattr(child, "node_type", None) == 3 or isinstance(getattr(child, "node_value", None), str) and (getattr(child, "node_name", "") or "").lower() == "#text":
            parts.append(str(getattr(child, "node_value", "") or ""))
        elif depth < 2:
            parts.append(_child_text(child, depth + 1))
    return " ".join(part.strip() for part in parts if part.strip())


def _selector_metrics(selector_map: dict[int, Any]) -> dict[str, Any]:
    light: dict[str, Any] = {}
    for index, node in list(selector_map.items())[:400]:
        light[str(index)] = {
            "backendNodeId": getattr(node, "backend_node_id", None),
            "nodeName": getattr(node, "node_name", None),
            "nodeValue": (getattr(node, "node_value", None) or "")[:120],
            "text": _child_text(node)[:200],
            "attributes": dict(getattr(node, "attributes", {}) or {}),
        }
    return light


async def handle_state(request: web.Request) -> web.Response:
    body = await request.json()
    entry = SESSIONS.get(str(body.get("sessionId", "")))
    if entry is None:
        return web.json_response({"error": "unknown substrate session"}, status=404)
    session: BrowserSession = entry["session"]
    include_attributes = body.get("includeAttributes")
    state = await session.get_browser_state_summary(
        include_screenshot=bool(body.get("includeScreenshot", True)),
        cached=bool(body.get("cached", False)),
        include_recent_events=bool(body.get("includeRecentEvents", False)),
    )
    dom = state.dom_state
    try:
        representation = dom.llm_representation(
            include_attributes=include_attributes if isinstance(include_attributes, list) else None
        )
    except Exception as exc:  # honest degraded representation, never a crash
        representation = f"(state representation failed: {exc})"
    try:
        eval_representation = dom.eval_representation(
            include_attributes=include_attributes if isinstance(include_attributes, list) else None
        )
    except Exception:
        eval_representation = representation
    payload: dict[str, Any] = {
        "url": state.url,
        "title": state.title,
        "tabs": [tab.model_dump(mode="json") for tab in state.tabs],
        "screenshot": state.screenshot,
        "browserErrors": list(state.browser_errors or []),
        "stateError": state.state_error,
        "pixelsAbove": state.pixels_above,
        "pixelsBelow": state.pixels_below,
        "domLlmRepresentation": representation,
        "domEvalRepresentation": eval_representation,
        "selectorMapSize": len(dom.selector_map),
        "selectorMapLight": _selector_metrics(dom.selector_map),
    }
    return web.json_response(payload)


async def handle_action(request: web.Request) -> web.Response:
    body = await request.json()
    entry = SESSIONS.get(str(body.get("sessionId", "")))
    if entry is None:
        return web.json_response({"error": "unknown substrate session"}, status=404)
    action_payload = body.get("action")
    if not isinstance(action_payload, dict) or len(action_payload) != 1:
        return web.json_response({"error": "action must be a single {name: params} object"}, status=400)
    session: BrowserSession = entry["session"]
    tools: Tools = entry["tools"]
    action_model_cls = entry["action_model_cls"]
    try:
        action_model = action_model_cls(**{k: v for k, v in action_payload.items()})
    except Exception as exc:
        return web.json_response(
            {"actionResult": ActionResult(error=f"action shape rejected by the substrate registry: {exc}").model_dump(mode="json")},
            status=200,
        )
    pre_url = await session.get_current_page_url()
    result: ActionResult = await tools.act(
        action=action_model,
        browser_session=session,
        page_extraction_llm=entry["extraction_llm"],
        sensitive_data=None,
        available_file_paths=None,
        file_system=entry["file_system"],
        extraction_schema=None,
    )
    post_url = await session.get_current_page_url()
    state = session._cached_browser_state_summary
    return web.json_response(
        {
            "actionResult": result.model_dump(mode="json"),
            "preActionUrl": pre_url,
            "postActionUrl": post_url,
            "selectorMapSize": len(state.dom_state.selector_map) if state and state.dom_state else 0,
        }
    )


async def handle_close(request: web.Request) -> web.Response:
    body = await request.json()
    session_id = str(body.get("sessionId", ""))
    entry = SESSIONS.pop(session_id, None)
    if entry is None:
        return web.json_response({"stopped": False, "error": "unknown substrate session"}, status=404)
    try:
        await entry["session"].stop()
    except Exception as exc:
        logger.warning("substrate session %s stop raised: %s", session_id, exc)
        return web.json_response({"stopped": True, "stopError": str(exc)})
    return web.json_response({"stopped": True})


async def handle_shutdown(_: web.Request) -> web.Response:
    asyncio.get_event_loop().call_later(0.1, _shutdown)
    return web.json_response({})


def _shutdown() -> None:
    sys.exit(0)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, required=True)
    parser.add_argument("--host", default="127.0.0.1")
    args = parser.parse_args()
    app = web.Application()
    app.router.add_get("/health", handle_health)
    app.router.add_post("/open", handle_open)
    app.router.add_post("/state", handle_state)
    app.router.add_post("/action", handle_action)
    app.router.add_post("/close", handle_close)
    app.router.add_post("/shutdown", handle_shutdown)
    logger.info("substrate driver listening on %s:%s", args.host, args.port)
    web.run_app(app, host=args.host, port=args.port, print=None, handle_signals=True)


if __name__ == "__main__":
    main()
