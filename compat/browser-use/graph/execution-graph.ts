/**
 * The PPR-024 declared execution graph for pinned Browser Use plus the
 * DISCOVERED edge inventory the static no-bypass reconciliation runs
 * against.
 *
 * UPSTREAM PIN PROVENANCE (recorded honestly):
 *
 *  - The work-order-named target "Browser Use" is the browser agent by
 *    the browser-use team: https://github.com/browser-use/browser-use
 *    ("Make websites accessible for AI agents"). The target matrix's
 *    observed seam ("provider/model abstraction with OpenAI-compatible
 *    options") is the repository's `browser_use/llm` BaseChatModel
 *    protocol with its OpenAI-compatible `ChatOpenAI` dataclass — but
 *    the matrix's own warning governs this proof: "model/intelligence
 *    plus browser actuation and any provider-backed cloud service …
 *    prove actuation plane, not only the model plane."
 *  - The pinned upstream revision is
 *    7be96ed8bafa8dfe1eef228b59cf5c884b8b2431
 *    (origin/main HEAD at proof-time clone; package version 0.13.10).
 *    It is run from the exact editable checkout installed in the
 *    sandbox's pinned venv; no upstream code is modified — every
 *    certified axis is the application's own documented configuration
 *    and extension surface (the Agent's llm=, browser_session= and
 *    tools= constructor seams).
 *
 * THE TWO-PLANE DECLARATION (the work order's contract):
 *
 *  - MODEL/INTELLIGENCE PLANE — `browseruse.agent-loop.main`
 *    (surface `browser-use-intelligence`): the application's ONE model
 *    client construction seam (browser_use/llm) exercised by every LLM
 *    turn: the Agent step loop's structured AgentOutput turns, the
 *    judge turn (judge_llm defaults to the main llm), the page-
 *    extraction turns (page_extraction_llm defaults to the main llm —
 *    including the ones issued from the substrate process, whose
 *    extraction LLM is the same delegated seam), and any direct
 *    invocation through the app's own ChatOpenAI abstraction (the
 *    pure-model corpus task). In the certified configuration this seam
 *    is a stock `ChatOpenAI(model=…, base_url=<the Zeck adapter>,
 *    api_key=<non-empty placeholder>, max_retries=0)` — zero code
 *    changes, the app's own documented provider surface.
 *
 *  - BROWSER ACTUATION PLANE — three declared edges (surface
 *    `sandbox-program-execution`, the neutral tool/substrate execution
 *    vocabulary) representing the browser substrate Browser Use would
 *    otherwise drive itself:
 *      · browseruse.substrate.session        (launch/attach/teardown)
 *      · browseruse.substrate.state-extraction (DOM snapshot + element
 *        map + screenshot + tabs — the state the intelligence consumes)
 *      · browseruse.substrate.action         (every agent-chosen
 *        action: navigate/click/input/scroll/extract/…)
 *    In the certified configuration these ride the integration's
 *    app-side adapter (custom `BrowserSession`/`Tools` subclasses at
 *    the Agent's documented constructor seams — never a fork of
 *    upstream internals): every substrate operation becomes a REAL
 *    Zeck execution whose lifecycle the Zeck-side substrate worker
 *    drives through the executions authority's own public transitions
 *    (authorize → plan → queue → start → tool-requested → tool-result
 *    → verify → pass), executing against the real Chromium via the
 *    pinned runtime's own `BrowserSession`/cdp-use driver hosted on
 *    the Zeck side of the boundary. The application process never
 *    opens the browser: its only destination is the local Zeck
 *    adapter (loopback), and its every non-loopback egress is denied
 *    by the proof environment.
 *
 * DORMANT / NOT-RUN SEAMS (declared with their gates + owners — never
 * silently out of scope; see BROWSER_USE_DORMANT_SEAMS below): the
 * Browser Use cloud LLM (ChatBrowserUse default), cloud browser
 * sessions, the app-owned fallback LLM axis, MCP servers, the skill
 * service, the app-side sandbox module, and the version-check /
 * telemetry endpoints (non-AI).
 */

import {
  type ApplicationExecutionGraph,
  type DiscoveredEdgeInventory,
} from "../../../src/integrations/compatibility/public";

/** The pinned upstream repository (cloned at proof time). */
export const BROWSER_USE_UPSTREAM_REPOSITORY = "https://github.com/browser-use/browser-use.git";

/** The pinned upstream revision (origin/main HEAD at proof-time clone; v0.13.10). */
export const BROWSER_USE_UPSTREAM_REVISION = "7be96ed8bafa8dfe1eef228b59cf5c884b8b2431";

/**
 * The Zeck integration revision this binding pins (the proof-time
 * placeholder is the governed delivery base the PPR-024 branch was cut
 * from — d51b5a59d53ef7824074acc4fce6726f065fcec5, the PPR-023
 * delivered-records commit and main head at branch time. The Lead
 * re-pins the binding to the actual merge base at delivery, the exact
 * class precedent the PPR-019/PPR-020/PPR-022/PPR-023 bindings
 * established. A different pin is a different object — never an
 * update.)
 */
export const BROWSER_USE_INTEGRATION_REVISION = "d51b5a59d53ef7824074acc4fce6726f065fcec5";

/** Every edge id the PPR-024 integration declares (the closed set). */
export const BROWSER_USE_EDGE_IDS = [
  "browseruse.agent-loop.main",
  "browseruse.substrate.session",
  "browseruse.substrate.state-extraction",
  "browseruse.substrate.action",
] as const;

export type BrowserUseEdgeId = (typeof BROWSER_USE_EDGE_IDS)[number];

/** The declared application execution graph (ACR-006 §1). */
export const BROWSER_USE_EXECUTION_GRAPH: ApplicationExecutionGraph = {
  edges: [
    {
      edgeId: "browseruse.agent-loop.main",
      component:
        "browser_use/llm BaseChatModel seam — the Agent's llm= constructor argument (agent/service.py ainvoke turns: the step loop's structured AgentOutput call, the judge turn whose judge_llm defaults to the main llm, the page-extraction turns whose page_extraction_llm defaults to the main llm — including extraction turns issued from the substrate process — and the pure-model corpus task's direct ChatOpenAI invocation) → ChatOpenAI {base_url: the certified Zeck adapter, api_key: non-empty placeholder} → POST {base}/chat/completions (response_format json_schema, image content parts when vision input is enabled)",
      surface: "browser-use-intelligence",
      transport:
        "OpenAI-compatible chat completions (json_schema structured output + tool-call-free action JSON; multimodal image content parts tolerated; the app's own documented ChatOpenAI configuration surface — zero code changes, max_retries=0 so no app-side transport retry authority)",
      externalExecution:
        "the configured provider's chat-completions endpoint (undelegated: e.g. api.openai.com/v1/chat/completions, api.anthropic.com, openrouter.ai, api.groq.com, api.deepseek.com, generativelanguage.googleapis.com, cloud.browser-use.com for the ChatBrowserUse default — the browser_use/llm provider catalog)",
      materiality:
        "the primary agent-loop model call: every action decision, judge verdict and extraction turn the runtime produces flows through this ONE model client construction seam — routing only a 'chat model' and leaving this seam direct would leave the application's whole intelligence surface provider-owned; the judge and page-extraction LLMs have no separate provider resolution under the certified configuration (both default to the main llm object), so no second AI client exists on the certified path",
    },
    {
      edgeId: "browseruse.substrate.session",
      component:
        "the browser substrate's lifecycle — BrowserSession.start()/stop() (browser_use/browser/session.py: Chromium launch via browser/chrome.py + cdp-use websocket attach, watchdog attach, profile/user-data-dir setup) — delegated through the integration's app-side custom BrowserSession subclass whose start/stop translate to Zeck executions of the neutral tool/substrate contract (the substrate worker launches/attaches/tears down the real Chromium on the Zeck side)",
      surface: "sandbox-program-execution",
      transport:
        "the substrate adapter's loopback relay (POST {adapter}/substrate/session {op}) → REAL Zeck execution → the Zeck-side substrate worker → the pinned runtime's own BrowserSession + cdp-use CDP driver against the sandbox Chromium (executable_path axis of BrowserProfile)",
      externalExecution:
        "the application's own in-process local browser session (undelegated: BrowserSession launching/connecting Chromium directly inside the application process — app-owned actuation, the exact configuration the target matrix names 'browser actuation')",
      materiality:
        "the work order delegates the browser substrate to Zeck: the substrate's own lifecycle (launch, attach, teardown) is a material execution surface of this integration — represented through the neutral tool/substrate execution contract with real lifecycle and evidence, not left as an unrecorded side effect of the application process",
    },
    {
      edgeId: "browseruse.substrate.state-extraction",
      component:
        "BrowserSession.get_browser_state_summary() (browser_use/browser/session.py → BrowserStateRequestEvent → the dom/screenshot watchdog handlers → CDP DOM snapshot + element map + screenshot + tab inventory) — delegated through the integration's app-side custom BrowserSession subclass: each state extraction becomes a REAL Zeck execution executed by the substrate worker's real session against the real browser, with the serialized BrowserStateSummary read back from the execution's public event ledger",
      surface: "sandbox-program-execution",
      transport:
        "the substrate adapter's loopback relay (POST {adapter}/substrate/state) → REAL Zeck execution → the Zeck-side substrate worker → the pinned runtime's own session state pipeline over cdp-use (DOM snapshot, element map, screenshot, tabs)",
      externalExecution:
        "the application's own in-process DOM/screenshot extraction (undelegated: the session's watchdogs issuing CDP DOM.getSnapshot/Input/screenshot commands inside the application process)",
      materiality:
        "state extraction performs the material browser work of READING the page (DOM snapshot, interactive-element map, screenshot, tabs) — the intelligence plane's every input depends on it, so a delegation that left state extraction in-process would leave the actuation plane's read path an unrecorded direct execution",
    },
    {
      edgeId: "browseruse.substrate.action",
      component:
        "Tools.act() → Registry.execute_action() (browser_use/tools/service.py: every agent-chosen action — navigate, search, click, click by coordinate, input, send_keys, scroll, scroll_to_text, go_back/go_forward, wait, switch_tab, close_tab, get/select dropdown, upload_file, save_as_pdf, screenshot, extract_content, find_elements, done) → BrowserSession event bus → the action watchdogs' CDP operations — delegated through the integration's app-side custom Tools subclass: each action execution becomes a REAL Zeck execution whose substrate worker executes the SAME action through the pinned runtime's own Tools/registry against the real browser and returns the ActionResult",
      surface: "sandbox-program-execution",
      transport:
        "the substrate adapter's loopback relay (POST {adapter}/substrate/action {action, params}) → REAL Zeck execution → the Zeck-side substrate worker → the pinned runtime's own action pipeline (validation, event dispatch, watchdog CDP handlers, post-action state reads)",
      externalExecution:
        "the application's own in-process action execution (undelegated: the watchdogs issuing Page.navigate / Input.dispatchMouseEvent / Input.insertText / DOM.* CDP commands inside the application process)",
      materiality:
        "THE actuation plane: the actions the model chooses are executed by the substrate — the work order's explicit rule that a model routed through Zeck alone is insufficient; every actuation the runtime performs must ride the neutral tool/substrate execution contract with lifecycle and evidence or be a BYPASS",
    },
  ],
};

/**
 * The DISCOVERED edge inventory: the static seam scan of the pinned
 * revision, restricted to the declared corpus configuration (the stock
 * Agent with llm=ChatOpenAI over the certified adapter,
 * browser_session= the integration's custom session, tools= the
 * integration's custom tools; ANONYMIZED_TELEMETRY=False; no cloud
 * credentials; no MCP servers; no skill service; no fallback LLM).
 *
 * The scan enumerated every AI-client construction seam and every
 * browser-actuation command seam reachable under that configuration
 * (browser_use/llm provider client modules (chat.py per provider) provider clients + ChatBrowserUse cloud
 * client; browser_use/browser/session.py + watchdogs/*.py CDP command
 * paths + browser/chrome.py launcher; browser_use/tools/service.py
 * action handlers); each discovered edge is claimed by exactly one
 * declared edge or disclosed as a dormant seam below (reconciled by
 * edge id and by component+surface+external chain).
 */
export const BROWSER_USE_DISCOVERED_INVENTORY: DiscoveredEdgeInventory = {
  source:
    "static seam scan of pinned Browser Use 7be96ed8bafa8dfe1eef228b59cf5c884b8b2431 (AI-client construction grep across browser_use/llm provider client modules (chat.py per provider) + browser_use/agent/service.py llm.ainvoke call sites + browser_use/llm/openai/chat.py AsyncOpenAI construction; browser-actuation command grep across browser_use/browser/session.py, browser_use/browser/watchdogs/ (the watchdog modules), browser_use/browser/chrome.py, browser_use/tools/service.py event dispatches; Agent-reachability restricted to the declared corpus configuration: llm=ChatOpenAI(base_url=adapter), custom browser_session/tools, no cloud keys, no MCP, no skills, no fallback LLM)",
  edges: [
    {
      edgeId: "browseruse.agent-loop.main",
      component:
        "browser_use/llm/base.py BaseChatModel protocol — the Agent's llm argument (agent/service.py: _get_next_action's ainvoke(messages, output_format=AgentOutput), the judge turn (agent/judge.py construct_judge_messages → judge_llm.ainvoke, judge_llm defaults to llm), the extract_content page-extraction turns (tools/service.py → page_extraction_llm.ainvoke, defaults to llm, including the substrate process's extraction LLM) and the pure-model task's direct ChatOpenAI.ainvoke — the ONE model client construction seam every intelligence turn rides",
      surface: "browser-use-intelligence",
      transport:
        "OpenAI-compatible chat completions (ChatOpenAI dataclass: base_url + api_key + model + max_retries; response_format json_schema for structured output; image content parts for vision input)",
      externalExecution:
        "the configured provider's chat-completions endpoint (undelegated: the browser_use/llm catalog — ChatOpenAI→api.openai.com, ChatAnthropic, ChatGoogle, ChatGroq, ChatDeepSeek, ChatOllama, ChatMistral, OpenRouter, Cerebras, Vercel, OCI, AWS Bedrock, Azure, ChatBrowserUse→cloud.browser-use.com)",
      materiality:
        "declared edge (the primary agent-loop seam — the target matrix's 'provider/model abstraction with OpenAI-compatible options' itself)",
    },
    {
      edgeId: "browseruse.substrate.session",
      component:
        "browser_use/browser/session.py BrowserSession.start()/stop() + browser_use/browser/chrome.py (Chromium subprocess launch, user-data-dir/profile setup, cdp-use CDPClient websocket attach, watchdog attach) — the substrate lifecycle seam",
      surface: "sandbox-program-execution",
      transport:
        "in-process Chromium subprocess + CDP websocket (cdp-use); delegated: the app-side custom session's start/stop → the substrate adapter → Zeck execution → the Zeck-side worker's own BrowserSession over the sandbox Chromium",
      externalExecution:
        "the application's own in-process local browser session (undelegated: BrowserSession launching Chromium inside the application process)",
      materiality:
        "declared edge (the substrate lifecycle is delegated to Zeck under the neutral tool/substrate contract)",
    },
    {
      edgeId: "browseruse.substrate.state-extraction",
      component:
        "browser_use/browser/session.py get_browser_state_summary() → BrowserStateRequestEvent → dom_watchdog.py + screenshot_watchdog.py handlers → CDP DOM.getSnapshot / Page.captureScreenshot / Target.getTargetInfo — the state-read seam (also get_current_page_url/title, cookies, tabs inventory)",
      surface: "sandbox-program-execution",
      transport:
        "in-process CDP commands; delegated: the app-side custom session's state method → the substrate adapter → Zeck execution → the Zeck-side worker's real session state pipeline",
      externalExecution:
        "the application's own in-process DOM/screenshot extraction (undelegated: the session's watchdog CDP commands inside the application process)",
      materiality:
        "declared edge (the actuation plane's read path — the intelligence's page input)",
    },
    {
      edgeId: "browseruse.substrate.action",
      component:
        "browser_use/tools/service.py Tools.act() → Registry.execute_action() → the action handlers' event dispatches (NavigateToUrlEvent, ClickElementEvent, ClickCoordinateEvent, TypeTextEvent, SendKeysEvent, ScrollEvent, ScrollToTextEvent, GoBackEvent, GoForwardEvent, RefreshEvent, WaitEvent, SwitchTabEvent, CloseTabEvent, GetDropdownOptionsEvent, SelectDropdownOptionEvent, UploadFileEvent, ElementSelectedEvent) → default_action_watchdog.py / dom_watchdog.py handlers → CDP Page.navigate / Input.dispatchMouseEvent / Input.insertText / DOM.* commands — the action-execution seam",
      surface: "sandbox-program-execution",
      transport:
        "in-process event bus → CDP commands; delegated: the app-side custom tools' act() → the substrate adapter → Zeck execution → the Zeck-side worker's real action pipeline",
      externalExecution:
        "the application's own in-process action execution (undelegated: the watchdogs' CDP commands inside the application process)",
      materiality:
        "declared edge (THE actuation plane — the actions the model chooses)",
    },
  ],
};

/**
 * The dormant seams at the pinned revision — inventoried and disclosed
 * (never silently out of scope), each with the configuration gate that
 * keeps it unreachable under the declared corpus and its owner.
 */
export interface DormantSeamDisclosure {
  readonly edgeId: string;
  readonly component: string;
  readonly surface: string;
  readonly gate: string;
  readonly owner: string;
}

export const BROWSER_USE_DORMANT_SEAMS: readonly DormantSeamDisclosure[] = [
  {
    edgeId: "browseruse.cloud.llm",
    component:
      "browser_use/llm/browser_use/chat.py ChatBrowserUse — the cloud LLM client (cloud.browser-use.com API; the DEFAULT llm when an Agent is constructed with llm=None and CONFIG.DEFAULT_LLM resolves to it)",
    surface: "browser-use-intelligence",
    gate:
      "the certified runtime constructs every Agent with its own ChatOpenAI pointed at the Zeck adapter (llm= is always passed — the app's own documented constructor axis), and no BROWSER_USE_API_KEY exists in the scrubbed credential-free environment; the proof environment's default-deny egress blocks cloud.browser-use.com for the application process. The cloud LLM is an operator-provided managed service (per-token billing) — an honest operator-provider boundary, never a fabricated delegation",
    owner:
      "operator-provider boundary (no Browser Use cloud credentials by erasure design; the certified configuration never selects the cloud LLM)",
  },
  {
    edgeId: "browseruse.cloud.browser",
    component:
      "browser_use/browser/cloud/cloud.py — the cloud browser session (use_cloud / cdp_url provisioned by the Browser Use cloud API; cloud browsers run remotely with the same in-app CDP client)",
    surface: "sandbox-program-execution",
    gate:
      "the certified configuration never enables use_cloud and carries no cloud credentials; the corpus drives the substrate-hosted local Chromium. A cloud browser would move the browser process to a remote host but keep the actuation client in-app — it is NOT the delegation this proof certifies and is out of scope as an operator-provided service",
    owner:
      "operator-provider boundary (no cloud browser credentials; the substrate delegation is proven on the locally-hosted real Chromium)",
  },
  {
    edgeId: "browseruse.fallback-llm",
    component:
      "browser_use/agent/service.py fallback_llm — the Agent's app-owned provider fallback axis (on ModelRateLimitError/ModelProviderError the agent can switch to a second provider LLM: self._using_fallback_llm)",
    surface: "browser-use-intelligence",
    gate:
      "the certified configuration passes fallback_llm=None (the app's own constructor axis): under ACR-007 §5 the application must not retain provider fallback semantics for a delegated edge — provider-axis retry/escalation is Zeck-owned (the rail worker's policy-permitted bounded retry), and the adapter's ChatOpenAI is configured with max_retries=0 so no app-side transport retry authority exists either. Disclosed as a deliberately-disabled app-owned axis, never a second AI path",
    owner:
      "classification: disabled-by-configuration app-owned fallback axis (owner: worker, disclosed); no fallback LLM object exists in the certified runtime",
  },
  {
    edgeId: "browseruse.mcp",
    component:
      "browser_use/mcp/ — MCP server integration (external tool servers; MCP tools can be AI-backed when a server provides them)",
    surface: "agent-delegation",
    gate:
      "the certified configuration registers no MCP servers (the Agent's mcp_config/mcp_servers axes are unset); no MCP client is constructed under the declared corpus",
    owner:
      "classification: configuration-gated dormant seam (owner: worker, disclosed); future delegation owner: worker",
  },
  {
    edgeId: "browseruse.skills",
    component:
      "browser_use/skills/ + the Agent's skill_service / skill_ids axes — the skill service executes remote skills with the session's cookies (execute_skill HTTP calls)",
    surface: "agent-delegation",
    gate:
      "the certified configuration passes no skill_service and no skill_ids; _register_skills_as_actions registers nothing and the cookies() call sites it guards are unreachable",
    owner:
      "classification: configuration-gated dormant seam (owner: worker, disclosed)",
  },
  {
    edgeId: "browseruse.sandbox",
    component:
      "browser_use/sandbox/ — the app-side sandboxed execution module (remote sandbox session execution for browser_script-style tools)",
    surface: "sandbox-program-execution",
    gate:
      "the declared corpus never constructs a sandbox session (the sandbox axes are unset); the module is unreachable under the certified configuration",
    owner:
      "classification: configuration-gated dormant seam (owner: worker, disclosed)",
  },
  {
    edgeId: "browseruse.telemetry-version",
    component:
      "browser_use/telemetry/service.py ProductTelemetry (posthog client) + browser_use/utils.py check_latest_browser_use_version (PyPI version probe) — the runtime's own non-AI outbound endpoints",
    surface: "deterministic-computation",
    gate:
      "ANONYMIZED_TELEMETRY=False disables the posthog client by the app's own documented env axis; the version check is a plain PyPI HTTP probe with NO model call — classified non-AI at the pinned revision, and the proof environment's default-deny egress blocks its host for the application process regardless",
    owner:
      "classification: non-AI telemetry/update endpoints, disabled by configuration and egress-denied (owner: worker, disclosed)",
  },
];

/**
 * The non-AI operations Browser Use retains as application/domain
 * capabilities (the work order: "Preserve Browser Use's own
 * agent/runtime/tool domain responsibilities") — each verified to make
 * NO model call and NO direct browser command of its own on the
 * certified path (the browser commands all ride the substrate edges).
 */
export const BROWSER_USE_NON_AI_OPERATIONS: readonly {
  readonly name: string;
  readonly note: string;
}[] = [
  {
    name: "agent orchestration / step loop / history / planning items",
    note:
      "the Agent's own state machine, message manager, compaction bookkeeping, loop detection and history — application-domain orchestration; every intelligence turn rides the delegated main seam",
  },
  {
    name: "prompt construction and output schema (SystemPrompt, AgentOutput, action registry descriptions)",
    note:
      "deterministic string/schema construction from the app's own templates — no model call, no browser command",
  },
  {
    name: "judge / variable-detector message construction",
    note:
      "construct_judge_messages and variable detection build the judge input deterministically; the judge LLM turn itself rides the delegated main seam",
  },
  {
    name: "file system / downloads bookkeeping (browser_use/filesystem)",
    note:
      "local file operations for the agent's workspace; no AI call, no direct browser command",
  },
  {
    name: "telemetry / observability (disabled) + logging",
    note:
      "local logging and the disabled posthog telemetry — non-AI, configuration-disabled, egress-denied",
  },
  {
    name: "CLI / config surface",
    note:
      "argument parsing and CONFIG resolution — deterministic computation",
  },
];
