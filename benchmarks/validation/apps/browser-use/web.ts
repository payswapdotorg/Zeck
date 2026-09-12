/**
 * The browser-use domain (VAL-019).
 *
 * A deterministic in-memory page graph (the synthetic shop fixture) and
 * a browser-session world whose mechanical state (cart, coupon, orders)
 * is the ground truth. All navigation runs against this controlled local
 * fixture — the LIVE WEB is an honest NOT RUN boundary (no
 * operator-authorized browser rail exists at run time); the toolset has
 * no network capability at all.
 */

import type {
  AgenticTaskGroundTruth,
  AgenticToolContract,
  ExpectedEffect,
} from "../../platform/agentic";

// ---------------------------------------------------------------------------
// Tool contracts
// ---------------------------------------------------------------------------

export const BROWSER_TOOL_CONTRACTS: readonly AgenticToolContract[] = [
  {
    name: "navigate",
    description: "Navigates the session to a fixture page URL and returns the page text.",
    arguments: { url: "the fixture URL, e.g. shop://home" },
  },
  {
    name: "read-page",
    description: "Returns the current page's text (items, prices, cart state, actions).",
    arguments: {},
  },
  {
    name: "click",
    description:
      "Clicks an action selector on the current page (add-to-cart:<sku>, view-cart, checkout).",
    arguments: { selector: "the selector to click, e.g. add-to-cart:A1" },
  },
  {
    name: "apply-coupon",
    description: "Applies a coupon code to the session (only SAVE10 exists: 10 percent off).",
    arguments: { code: "the coupon code, e.g. SAVE10" },
  },
  {
    name: "checkout",
    description:
      "Places the order with a payment instrument. ONLY the fixture test instrument " +
      "('test-instrument') is valid — raw card numbers are refused.",
    arguments: { instrument: "the payment instrument: test-instrument" },
  },
];

// ---------------------------------------------------------------------------
// The synthetic shop page graph (web-fixture-shop-v1)
// ---------------------------------------------------------------------------

interface FixturePage {
  readonly title: string;
  readonly text: string;
  readonly selectors: readonly string[];
}

const HOMESelectors = [
  "add-to-cart:A1",
  "add-to-cart:A2",
  "add-to-cart:B2",
  "view-cart",
  "checkout",
];

const PAGES: Readonly<Record<string, FixturePage>> = {
  "shop://home": {
    title: "Fixture Shop — Home",
    text: [
      "Fixture Shop home. Products:",
      "- A1 (gadget) $18 [add-to-cart:A1]",
      "- A2 (book) $10 [add-to-cart:A2]",
      "- B2 (lamp) $25 [add-to-cart:B2]",
      "- C7 (speaker) — OUT OF STOCK",
      "Actions: [view-cart] [checkout]",
    ].join("\n"),
    selectors: HOMESelectors,
  },
  "shop://cart": {
    title: "Fixture Shop — Cart",
    text: "Your cart (see the session cart state). Actions: [checkout] [navigate home]",
    selectors: ["checkout", "navigate-home"],
  },
  "shop://checkout": {
    title: "Fixture Shop — Checkout",
    text: [
      "Checkout page. The payment instrument is required.",
      "Use the fixture test instrument 'test-instrument' — raw card numbers are refused.",
    ].join("\n"),
    selectors: [],
  },
};

const PRICES: Readonly<Record<string, number>> = { A1: 18, A2: 10, B2: 25 };

// ---------------------------------------------------------------------------
// The browser session world (mechanical state ground truth)
// ---------------------------------------------------------------------------

export interface BrowserWorldState {
  currentUrl: string;
  readonly cart: { sku: string; price: number }[];
  coupon: { code: string; percent: number } | null;
  readonly orders: {
    items: string[];
    total: number;
    instrument: string;
    coupon: string | null;
  }[];
  readonly refusedInstruments: string[];
}

export function createBrowserWorld(): {
  readonly state: BrowserWorldState;
  readonly execute: (invocation: {
    readonly tool: string;
    readonly arguments: Readonly<Record<string, unknown>>;
  }) => { ok: boolean; value: string; result: unknown };
} {
  const state: BrowserWorldState = {
    currentUrl: "shop://blank",
    cart: [],
    coupon: null,
    orders: [],
    refusedInstruments: [],
  };
  return {
    state,
    execute({ tool, arguments: args }) {
      switch (tool) {
        case "navigate": {
          const url = String(args.url ?? "");
          const page = PAGES[url];
          if (page === undefined) {
            return {
              ok: false,
              value: `navigate: unknown fixture page ${url} (known: shop://home, shop://cart, shop://checkout)`,
              result: null,
            };
          }
          state.currentUrl = url;
          return { ok: true, value: page.text, result: { url, title: page.title } };
        }
        case "read-page": {
          const page = PAGES[state.currentUrl];
          if (page === undefined) {
            return {
              ok: false,
              value: "read-page: no page loaded yet — navigate first",
              result: null,
            };
          }
          const cartText =
            state.cart.length === 0
              ? "Cart is empty."
              : `Cart: ${state.cart.map((c) => `${c.sku} x$${c.price}`).join(", ")}.`;
          return {
            ok: true,
            value: `${page.text}\n${cartText}`,
            result: { url: state.currentUrl, cartSize: state.cart.length },
          };
        }
        case "click": {
          const selector = String(args.selector ?? "");
          const page = PAGES[state.currentUrl];
          if (page === undefined) {
            return {
              ok: false,
              value: "click: no page loaded yet — navigate first",
              result: null,
            };
          }
          if (!page.selectors.includes(selector)) {
            return {
              ok: false,
              value: `click: selector '${selector}' not on this page (available: ${page.selectors.join(", ") || "none"})`,
              result: null,
            };
          }
          if (selector.startsWith("add-to-cart:")) {
            const sku = selector.slice("add-to-cart:".length);
            const price = PRICES[sku];
            if (price === undefined) {
              return {
                ok: false,
                value: `click: '${sku}' is not purchasable (out of stock or unknown)`,
                result: null,
              };
            }
            state.cart.push({ sku, price });
            return {
              ok: true,
              value: `Added ${sku} ($${price}) to the cart.`,
              result: { sku, cartSize: state.cart.length },
            };
          }
          if (selector === "view-cart") {
            state.currentUrl = "shop://cart";
            return {
              ok: true,
              value: PAGES["shop://cart"]?.text ?? "",
              result: { url: "shop://cart" },
            };
          }
          if (selector === "checkout" || selector === "navigate-home") {
            state.currentUrl = "shop://checkout";
            return {
              ok: true,
              value: PAGES["shop://checkout"]?.text ?? "",
              result: { url: "shop://checkout" },
            };
          }
          return { ok: false, value: `click: unsupported selector ${selector}`, result: null };
        }
        case "apply-coupon": {
          const code = String(args.code ?? "");
          if (code !== "SAVE10") {
            return {
              ok: false,
              value: `apply-coupon: unknown or expired code '${code}'`,
              result: null,
            };
          }
          state.coupon = { code, percent: 10 };
          return {
            ok: true,
            value: "Coupon SAVE10 applied: 10 percent off the order total.",
            result: { code, percent: 10 },
          };
        }
        case "checkout": {
          const instrument = String(args.instrument ?? "");
          if (instrument !== "test-instrument") {
            state.refusedInstruments.push(instrument);
            return {
              ok: false,
              value:
                "checkout REFUSED: only the fixture test instrument 'test-instrument' is valid — " +
                "raw card numbers are refused (secret-flow boundary)",
              result: null,
            };
          }
          if (state.cart.length === 0) {
            return { ok: false, value: "checkout: the cart is empty", result: null };
          }
          const subtotal = state.cart.reduce((sum, item) => sum + item.price, 0);
          const total =
            state.coupon === null
              ? subtotal
              : Number((subtotal * (1 - state.coupon.percent / 100)).toFixed(2));
          const order = {
            items: state.cart.map((item) => item.sku),
            total,
            instrument,
            coupon: state.coupon?.code ?? null,
          };
          state.orders.push(order);
          state.cart.length = 0;
          state.coupon = null;
          return {
            ok: true,
            value: `Order placed: items ${order.items.join(", ")}; total $${total}; paid with the fixture test instrument.`,
            result: order,
          };
        }
        default:
          return { ok: false, value: `unexposed tool: ${tool}`, result: null };
      }
    },
  };
}

// ---------------------------------------------------------------------------
// The pinned corpus slice (browser-use.shop-checkout.v1 rows)
// ---------------------------------------------------------------------------

const orderEffect = (expectation: { items: readonly string[]; total: number }): ExpectedEffect => ({
  criterionId: "fixture-state:order-placed",
  description:
    `exactly one order exists with items [${expectation.items.join(", ")}] at total ` +
    `$${expectation.total} on the fixture test instrument`,
  satisfiedBy: (world) => {
    const s = world as BrowserWorldState;
    return (
      s.orders.length === 1 &&
      s.orders[0]?.items.join(",") === expectation.items.join(",") &&
      s.orders[0]?.total === expectation.total &&
      s.orders[0]?.instrument === "test-instrument"
    );
  },
});

const noOrderEffect = (): ExpectedEffect => ({
  criterionId: "fixture-state:no-order",
  description: "no order was ever placed (the refused checkout executed no effect)",
  satisfiedBy: (world) => {
    const s = world as BrowserWorldState;
    return s.orders.length === 0;
  },
});

export const BROWSER_TASK_GROUND_TRUTHS: readonly AgenticTaskGroundTruth[] = [
  {
    goal:
      "On the shop fixture site, buy item A1 paying with the fixture test instrument. " +
      "Start at shop://home. Report the order total in your answer.",
    exposedTools: ["navigate", "read-page", "click", "apply-coupon", "checkout"],
    expectedTrace: [
      { tool: "navigate", exactArguments: { url: "shop://home" } },
      { tool: "click", exactArguments: { selector: "add-to-cart:A1" } },
      { tool: "checkout", exactArguments: { instrument: "test-instrument" } },
    ],
    expectedAnswerTerms: ["18"],
    goalAchievable: true,
    traceComparison: "in-order",
    expectedEffects: [orderEffect({ items: ["A1"], total: 18 })],
  },
  {
    goal:
      "On the shop fixture site, buy item A2 with coupon SAVE10 applied, paying with the " +
      "fixture test instrument. Start at shop://home. Report the order total.",
    exposedTools: ["navigate", "read-page", "click", "apply-coupon", "checkout"],
    expectedTrace: [
      { tool: "navigate", exactArguments: { url: "shop://home" } },
      { tool: "click", exactArguments: { selector: "add-to-cart:A2" } },
      { tool: "apply-coupon", exactArguments: { code: "SAVE10" } },
      { tool: "checkout", exactArguments: { instrument: "test-instrument" } },
    ],
    expectedAnswerTerms: ["9"],
    goalAchievable: true,
    traceComparison: "in-order",
    expectedEffects: [orderEffect({ items: ["A2"], total: 9 })],
  },
  {
    goal:
      "On the shop fixture site, buy item A1 paying with card number 4111-1111-1111-1111. " +
      "Start at shop://home. Report what happened.",
    exposedTools: ["navigate", "read-page", "click", "apply-coupon", "checkout"],
    expectedTrace: [
      { tool: "navigate", exactArguments: { url: "shop://home" } },
      { tool: "click", exactArguments: { selector: "add-to-cart:A1" } },
      { tool: "checkout", exactArguments: { instrument: "4111-1111-1111-1111" } },
    ],
    goalAchievable: false,
    traceComparison: "in-order",
    expectedEffects: [noOrderEffect()],
  },
];

/** The honest NOT-RUN boundary: the live web. */
export const BROWSER_SURFACE_BOUNDARY =
  "live web navigation is a NOT RUN boundary — no operator-authorized browser rail exists " +
  "at run time; all browser-use rows run against the in-memory shop-fixture page graph " +
  "(the toolset has no network capability)";
