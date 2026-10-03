"""
The PPR-024 application-side runner — the APPLICATION PROCESS of the
certified proof: the pinned Browser Use runtime (the exact editable
checkout installed in the sandbox venv) composed at the application's own
documented constructor seams (Agent(llm=…, browser_session=…, tools=…),
ChatOpenAI(model, base_url, api_key)) with ZERO upstream code changes.

WHAT RUNS HERE (the ACR-007 translation boundary's application half):
  - the MODEL plane: a stock `ChatOpenAI` (browser_use.llm.openai.chat)
    pointed at the local Zeck adapter — the app's own documented
    provider configuration surface (base_url + api_key + max_retries=0:
    no app-side transport retry authority, no provider credential);
  - the ACTUATION plane: `DelegatingBrowserSession` / `DelegatingTools`
    (subclasses of the pinned runtime's own BrowserSession / Tools — the
    Agent's documented browser_session= / tools= constructor seams): every
    substrate operation (session open/close, state extraction, action
    execution) is translated into a REAL Zeck execution through the
    adapter's substrate relay; the browser itself NEVER opens inside this
    process — its only destination is the loopback Zeck adapter, and this
    process's every non-loopback egress is denied by the proof proxy.

Task kinds (the corpus's two-plane declaration):
  - "model":     the pure-model task — a direct ChatOpenAI structured
                 invocation (no browser session at all);
  - "actuation": the actuation-value task — the delegated substrate client
                 driven directly (navigate → read state → act → read
                 state) with NO LLM turn: the material value is entirely
                 the browser actuation through Zeck;
  - "agent":     the combined task — the full pinned Agent loop: the
                 delegated LLM chooses the actions the delegated substrate
                 executes.

Protocol: one task spec JSON file (path in PPR_024_TASK_FILE); one
result JSON object printed to stdout. Exit code 0 = the runner executed
(the result's own fields carry success/failure honestly).
"""

import asyncio
import json
import os
import sys
import traceback
import urllib.request
import uuid
from typing import Any

# The pinned runtime (the exact editable checkout installed in the venv).
from browser_use import Agent, BrowserProfile, BrowserSession, Tools
from browser_use.llm.openai.chat import ChatOpenAI
from browser_use.browser.views import BrowserStateSummary
from browser_use.agent.views import ActionResult
from browser_use.dom.views import SerializedDOMState

ADAPTER_URL = os.environ.get("PPR_024_ADAPTER_URL", "")
MODEL_ID = os.environ.get("PPR_024_MODEL", "glm-4-plus")
API_KEY_PLACEHOLDER = os.environ.get("PPR_024_API_KEY", "zeck-local-adapter")
TASK_FILE = os.environ.get("PPR_024_TASK_FILE", "")

# The delegated destination is ALWAYS loopback: an opener with NO proxy
# handling at all (never proxied, never discovered) — the one destination
# the certified runtime may reach.
_OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def _rpc(path: str, payload: dict[str, Any], timeout: float = 240.0) -> dict[str, Any]:
    body = json.dumps(payload).encode("utf8")
    request = urllib.request.Request(
        f"{ADAPTER_URL.rstrip('/')}{path}",
        data=body,
        headers={"content-type": "application/json"},
        method="POST",
    )
    with _OPENER.open(request, timeout=timeout) as response:
        return json.loads(response.read().decode("utf8"))


def _delegated_llm(temperature: float = 0.2) -> ChatOpenAI:
    """The stock ChatOpenAI over the certified Zeck adapter (zero code changes)."""
    return ChatOpenAI(
        model=MODEL_ID,
        base_url=f"{ADAPTER_URL.rstrip('/')}/v1",
        api_key=API_KEY_PLACEHOLDER,
        max_retries=0,
        temperature=temperature,
        frequency_penalty=None,
    )


class _LightNode:
    """The transported interactive-element view (DOMInteractedElement source
    + the page-statistics traversal's original_node shape)."""

    def __init__(self, index: int, data: dict[str, Any]):
        self.node_id = index
        self.backend_node_id = int(data.get("backendNodeId") or index)
        self.frame_id = None
        self.node_type = 1
        self.text = str(data.get("text") or "")
        self.node_value = str(data.get("nodeValue") or "")
        self.node_name = str(data.get("nodeName") or "")
        self.tag_name = str(data.get("nodeName") or "").lower().strip("#")
        self.attributes = dict(data.get("attributes") or {})
        self.snapshot_node = None
        self.ax_node = None
        self.xpath = ""
        self.is_visible = True
        self.is_scrollable = False
        self.is_actually_scrollable = False
        self.absolute_position = None
        self.children_nodes = []

    def compute_stable_hash(self) -> str:
        return f"{self.node_name}:{self.node_value[:40]}"

    def get_all_children_text(self, max_depth: int = -1) -> str:
        return self.text

    def __hash__(self) -> int:
        return hash((self.backend_node_id, self.node_name, self.node_value))

    def __eq__(self, other: object) -> bool:
        return isinstance(other, _LightNode) and self.__hash__() == hash(other)


class _LightSimplifiedNode:
    """The transported SimplifiedNode view (the stats traversal's node)."""

    def __init__(self, original: _LightNode, is_interactive: bool):
        self.original_node = original
        self.children: list["_LightSimplifiedNode"] = []
        self.should_display = True
        self.is_interactive = is_interactive
        self.selector_index = original.node_id
        self.is_new = False
        self.ignored_by_paint_order = False
        self.excluded_by_parent = False
        self.is_shadow_host = False
        self.is_compound_component = False


class _TransportedDOMState:
    """The transported SerializedDOMState (llm_representation + selector map
    + the light _root tree the runtime's own page-statistics traversal reads)."""

    def __init__(self, representation: str, eval_representation: str, selector_light: dict[str, Any]):
        self._representation = representation
        self._eval_representation = eval_representation
        self.selector_map: dict[int, _LightNode] = {}
        for key, value in selector_light.items():
            try:
                self.selector_map[int(key)] = _LightNode(int(key), value)
            except (TypeError, ValueError):
                continue
        # The light root: a DOCUMENT node whose children are the transported
        # interactive elements (the stats traversal counts total/interactive
        # elements and text from this tree).
        root_original = _LightNode(0, {"nodeName": "#document", "nodeValue": ""})
        root_original.node_type = 9
        root = _LightSimplifiedNode(root_original, is_interactive=False)
        for index, node in self.selector_map.items():
            root.children.append(_LightSimplifiedNode(node, is_interactive=True))
        self._root = root

    def llm_representation(self, include_attributes: list[str] | None = None) -> str:
        return self._representation

    def eval_representation(self, include_attributes: list[str] | None = None) -> str:
        return self._eval_representation


class DelegatingBrowserSession(BrowserSession):
    """The app-side substrate client (the Agent's browser_session seam).

    Every substrate operation becomes a REAL Zeck execution through the
    adapter's substrate relay (the neutral tool/substrate contract); the
    browser never opens in this process.
    """

    def __init__(self, **kwargs: Any):
        profile = BrowserProfile(headless=True)
        super().__init__(browser_profile=profile)
        self._substrate_session_id: str | None = None
        self._substrate_open = False
        self._last_url: str = "about:blank"
        self._delegation_log: list[dict[str, Any]] = []

    @property
    def is_cdp_connected(self) -> bool:
        # The substrate session is the delegated CDP connection (Zeck side).
        return self._substrate_open

    def _note(self, kind: str, execution_id: str, replayed: bool) -> None:
        self._delegation_log.append(
            {"edge": f"browseruse.substrate.{kind}", "executionId": execution_id, "replayed": replayed}
        )

    async def start(self) -> None:
        response = _rpc(
            "/substrate/session",
            {"op": "open", "profile": {"headless": True}},
        )
        result = response.get("result") or {}
        session_id = str(result.get("substrateSessionId") or "")
        if not session_id:
            raise RuntimeError(f"substrate session open failed: {json.dumps(response)[:300]}")
        self._substrate_session_id = session_id
        self._substrate_open = True
        self._note("session", str(response.get("executionId") or ""), bool(response.get("replayed")))

    async def stop(self) -> None:
        if self._substrate_session_id is None:
            return
        try:
            response = _rpc(
                "/substrate/session",
                {"op": "close", "sessionId": self._substrate_session_id},
            )
            self._note("session", str(response.get("executionId") or ""), bool(response.get("replayed")))
        finally:
            self._substrate_open = False
            self._substrate_session_id = None

    async def get_browser_state_summary(
        self,
        include_screenshot: bool = True,
        cached: bool = False,
        include_recent_events: bool = False,
    ) -> BrowserStateSummary:
        if cached and self._cached_state is not None:
            return self._cached_state
        if self._substrate_session_id is None:
            raise RuntimeError("the delegated substrate session is not open")
        response = _rpc(
            "/substrate/state",
            {
                "sessionId": self._substrate_session_id,
                "includeScreenshot": include_screenshot,
                "cached": False,
                "includeRecentEvents": include_recent_events,
            },
        )
        result = response.get("result") or {}
        state = result.get("state") or {}
        url = str(state.get("url") or "about:blank")
        self._last_url = url
        summary = BrowserStateSummary(
            dom_state=_TransportedDOMState(
                str(state.get("domLlmRepresentation") or ""),
                str(state.get("domEvalRepresentation") or ""),
                dict(state.get("selectorMapLight") or {}),
            ),
            url=url,
            title=str(state.get("title") or ""),
            tabs=[],
            screenshot=state.get("screenshot") if include_screenshot else None,
            browser_errors=list(state.get("browserErrors") or []),
            state_error=state.get("stateError"),
            pixels_above=int(state.get("pixelsAbove") or 0),
            pixels_below=int(state.get("pixelsBelow") or 0),
        )
        self._cached_state = summary
        self._note(
            "state-extraction", str(response.get("executionId") or ""), bool(response.get("replayed"))
        )
        return summary

    async def get_current_page_url(self) -> str:
        # The app-side view of the URL the delegated substrate last reported
        # (every material read rode a Zeck execution; this is bookkeeping
        # over delegated facts, never a direct browser command).
        return self._last_url

    async def cookies(self) -> list[dict[str, Any]]:
        # Skills are disabled in the certified configuration; no cookie path.
        return []

    async def get_state_as_text(self) -> str:
        state = await self.get_browser_state_summary()
        return state.dom_state.llm_representation()


class DelegatingTools(Tools):
    """The app-side actuation client (the Agent's tools seam).

    Every agent-chosen action becomes a REAL Zeck execution through the
    adapter's substrate relay; the registry's action models (the output
    schema the LLM fills) are the pinned runtime's own.
    """

    def __init__(self) -> None:
        super().__init__()
        self._session: DelegatingBrowserSession | None = None
        self.delegation_log: list[dict[str, Any]] = []

    def bind(self, session: DelegatingBrowserSession) -> None:
        self._session = session

    async def act(
        self,
        action: Any,
        browser_session: Any,
        page_extraction_llm: Any = None,
        sensitive_data: dict[str, Any] | None = None,
        available_file_paths: list[str] | None = None,
        file_system: Any = None,
        extraction_schema: dict[str, Any] | None = None,
        action_timeout: float | None = None,
    ) -> ActionResult:
        if self._session is None or self._session._substrate_session_id is None:
            return ActionResult(error="the delegated substrate session is not open")
        action_dump = action.model_dump(exclude_unset=True)
        if not action_dump:
            return ActionResult(error="empty action")
        response = _rpc(
            "/substrate/action",
            {
                "sessionId": self._session._substrate_session_id,
                "action": action_dump,
            },
        )
        result = response.get("result") or {}
        post_url = result.get("postActionUrl")
        if isinstance(post_url, str) and post_url:
            self._session._last_url = post_url
            self._session._cached_state = None
        self.delegation_log.append(
            {
                "edge": "browseruse.substrate.action",
                "action": list(action_dump.keys()),
                "executionId": str(response.get("executionId") or ""),
                "replayed": bool(response.get("replayed")),
            }
        )
        raw = result.get("actionResult")
        if not isinstance(raw, dict):
            return ActionResult(error=f"substrate action returned no result: {json.dumps(response)[:300]}")
        try:
            return ActionResult(**raw)
        except Exception as exc:
            return ActionResult(error=f"substrate ActionResult rejected: {exc}")


async def run_model_task(task: dict[str, Any]) -> dict[str, Any]:
    """The pure-model corpus task: a direct ChatOpenAI structured invocation."""
    from pydantic import BaseModel, create_model

    field_specs: dict[str, Any] = {}
    declared = task.get("outputFields") or {}
    type_by_name = {"string": str, "boolean": bool, "number": float, "integer": int}
    for name, spec in declared.items():
        python_type = type_by_name.get(str(spec)) if isinstance(spec, str) else None
        if python_type is None:
            python_type = str
        field_specs[name] = (python_type, ...)
    if not field_specs:
        field_specs = {"headline": (str, ...), "impact": (str, ...), "ok": (bool, ...)}
    OutputModel = create_model("OutputModel", **field_specs)

    llm = _delegated_llm(temperature=float(task.get("temperature", 0.0)))
    from browser_use.llm.messages import UserMessage

    completion = await llm.ainvoke(
        [UserMessage(content=str(task["instruction"]))], output_format=OutputModel
    )
    parsed = completion.completion
    return {
        "kind": "model",
        "resolved": parsed is not None,
        "finalResult": json.dumps(parsed.model_dump(), default=str),
        "stopReason": completion.stop_reason,
        "usage": completion.usage.model_dump(mode="json") if completion.usage else None,
        "delegationLog": [],
    }


async def run_actuation_task(task: dict[str, Any]) -> dict[str, Any]:
    """The actuation-value corpus task: the delegated substrate driven directly.

    NO LLM turn happens in this task — the material value is entirely the
    browser actuation (navigate → state read → click → state read), every
    operation a REAL Zeck execution on the substrate plane.
    """
    session = DelegatingBrowserSession()
    tools = DelegatingTools()
    tools.bind(session)
    await session.start()
    steps: list[str] = []
    try:
        action_model_cls = tools.registry.create_action_model()
        # 1. navigate to the fixture page (a substrate action execution)
        result = await tools.act(
            action=action_model_cls(**{"navigate": {"url": task["url"]}}),
            browser_session=session,
        )
        steps.append(f"navigate:{result.error or 'ok'}")
        if result.error:
            return {"kind": "actuation", "resolved": False, "finalResult": "", "steps": steps,
                    "error": f"navigate failed: {result.error}",
                    "delegationLog": session._delegation_log + tools.delegation_log}
        # 2. read the state (a substrate state-extraction execution)
        state = await session.get_browser_state_summary(include_screenshot=False)
        representation = state.dom_state.llm_representation()
        # 3. find the target element index (deterministic app logic over the
        #    delegated selector map — the same map the LLM would read)
        selector_map = state.dom_state.selector_map
        target_text = str(task["clickText"])
        target_index = None
        for index, node in selector_map.items():
            blob = (
                f"{node.node_name} {node.node_value} {getattr(node, 'text', '')} "
                f"{' '.join(node.attributes.values())}"
            ).lower()
            if target_text.lower() in blob:
                target_index = index
                break
        if target_index is None:
            return {"kind": "actuation", "resolved": False, "finalResult": "",
                    "steps": steps, "error": f"target element not found in selector map ({len(selector_map)} elements)",
                    "domHead": representation[:400],
                    "delegationLog": session._delegation_log + tools.delegation_log}
        # 4. click it (a substrate action execution)
        result = await tools.act(
            action=action_model_cls(**{"click": {"index": target_index}}),
            browser_session=session,
        )
        steps.append(f"click:{result.error or 'ok'}")
        if result.error:
            return {"kind": "actuation", "resolved": False, "finalResult": "", "steps": steps,
                    "error": f"click failed: {result.error}",
                    "delegationLog": session._delegation_log + tools.delegation_log}
        # 5. read the state again and extract the token (substrate execution)
        state = await session.get_browser_state_summary(include_screenshot=False)
        representation = state.dom_state.llm_representation()
        token_marker = str(task["tokenMarker"])
        token = ""
        marker_pos = representation.find(token_marker)
        if marker_pos >= 0:
            tail = representation[marker_pos + len(token_marker): marker_pos + len(token_marker) + 120]
            import re as _re
            match = _re.search(r"[A-Z0-9-]{6,}", tail)
            if match:
                token = match.group(0)
        return {
            "kind": "actuation",
            "resolved": token != "",
            "finalResult": token,
            "steps": steps,
            "domHead": representation[:400],
            "delegationLog": session._delegation_log + tools.delegation_log,
        }
    finally:
        await session.stop()


async def run_agent_task(task: dict[str, Any]) -> dict[str, Any]:
    """The combined corpus task: the full pinned Agent loop (model + substrate)."""
    session = DelegatingBrowserSession()
    tools = DelegatingTools()
    tools.bind(session)
    agent = Agent(
        task=str(task["instruction"]),
        llm=_delegated_llm(temperature=0.2),
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
        source="ppr-024",
    )
    history = await agent.run(max_steps=int(task.get("maxSteps", 12)))
    final = history.final_result()
    return {
        "kind": "agent",
        "resolved": final is not None and len(str(final)) > 0,
        "finalResult": final or "",
        "steps": history.action_names(),
        "urls": history.urls(),
        "errors": [str(e) for e in (history.errors() or [])][:10],
        "delegationLog": session._delegation_log + tools.delegation_log,
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
            result = {"kind": kind, "resolved": False, "error": f"unknown task kind {kind}"}
    except Exception as exc:
        result = {
            "kind": kind,
            "resolved": False,
            "error": f"{type(exc).__name__}: {exc}",
            "traceback": traceback.format_exc()[-2000:],
        }
    result["taskId"] = task.get("taskId", "")
    print(json.dumps(result, default=str))
    return 0


def main() -> None:
    if not ADAPTER_URL or not TASK_FILE:
        print(json.dumps({"resolved": False, "error": "PPR_024_ADAPTER_URL and PPR_024_TASK_FILE are required"}))
        sys.exit(2)
    sys.exit(asyncio.run(main_async()))


if __name__ == "__main__":
    main()
