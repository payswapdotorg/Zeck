/**
 * PPR-015 — the public-experience BROWSER smoke (agent-browser-driven).
 *
 * THE REAL-BROWSER LAYER of the correction's regression surface (the
 * work order's "Required regression protection" items 4, 5 and 7):
 * the structural batteries
 * (tests/unit/deployment/experience-routing.test.ts — the derived
 * routing projection; tests/integration/deployment/experience-gateway.test.ts
 * — the two-function composition over real HTTP) pin the class of the
 * defect; THIS battery drives a REAL browser (the `agent-browser`
 * CLI — the same tool the work order's browser audits mandate) through
 * the corrected public shape:
 *
 *   Home (the outcome explanation + the discovery affordances)
 *   → capability discovery (the 22 families, four honest states)
 *   → safe start (the safety envelope BEFORE any run)
 *   → the fall-through spot sweep (previously-broken visible routes)
 *   → the API boundary (the machine routes stay machine, same origin)
 *   → responsive (mobile viewport: no horizontal scroll, the bottom
 *     bar, touch targets)
 *   → keyboard (the skip link is first, focus is visible).
 *
 * The composition is the REAL two-function local plane
 * (deploy/local-experience-gateway.ts: the bootstrap API plane + the
 * experience function behind vercel.json's routing grammar) — the
 * same composition the integration battery pins.
 *
 * Usage: bun tests/browser/public-experience-browser-smoke.ts
 * Exit 0 = every step passed; 1 = any step failed; 2 = preflight
 * refusal (agent-browser unavailable — the honest not-run, owner the
 * operator's environment).
 */

import { execFile } from "node:child_process";
import { bootLocalExperienceComposition } from "../../deploy/local-experience-gateway";

const SESSION = "ppr-015-browser-smoke";
const OUTCOME_STATEMENT =
  "Describe an outcome. Zeck plans it, executes it under policy, and returns it with evidence.";

interface StepResult {
  readonly id: string;
  readonly status: "pass" | "fail";
  readonly observed: string;
}

const results: StepResult[] = [];

function record(id: string, ok: boolean, observed: string): void {
  results.push({ id, status: ok ? "pass" : "fail", observed: observed.slice(0, 300) });
}

function browser(args: readonly string[]): Promise<{ result: unknown; raw: string }> {
  return new Promise((resolvePromise, reject) => {
    execFile(
      "agent-browser",
      ["--session", SESSION, ...args, "--json"],
      { timeout: 60_000 },
      (error, stdout, stderr) => {
        if (error !== null && stdout.trim().length === 0) {
          reject(new Error(`agent-browser ${args.join(" ")} failed: ${stderr.slice(0, 200)}`));
          return;
        }
        try {
          const parsed = JSON.parse(stdout) as {
            success: boolean;
            data?: { result?: unknown };
            error?: string | null;
          };
          if (parsed.success !== true) {
            reject(
              new Error(`agent-browser ${args.join(" ")} refused: ${parsed.error ?? "unknown"}`),
            );
            return;
          }
          resolvePromise({ result: parsed.data?.result, raw: stdout });
        } catch {
          reject(new Error(`agent-browser output not JSON: ${stdout.slice(0, 120)}`));
        }
      },
    );
  });
}

async function evalInPage(expression: string): Promise<unknown> {
  const { result } = await browser(["eval", expression]);
  return result;
}

async function open(url: string): Promise<void> {
  await browser(["open", url]);
  await browser(["wait", "--load", "networkidle"]);
}

async function main(): Promise<number> {
  // The preflight (the honest refusal when the tool is absent).
  await new Promise<void>((resolvePromise) => {
    execFile("agent-browser", ["--version"], { timeout: 15_000 }, (error) => {
      if (error !== null) {
        console.error(
          "preflight refusal: agent-browser is not available in this environment (the browser smoke is an honest NOT RUN here; owner: the operator's environment)",
        );
        process.exit(2);
      }
      resolvePromise();
    });
  });

  const composition = await bootLocalExperienceComposition();
  const base = composition.gatewayUrl;
  try {
    // ------------------------------------------------------------------
    // 1. THE LANDING: the bare origin lands on the Home experience.
    // ------------------------------------------------------------------
    await open(`${base}/`);
    const landingUrl = String(await evalInPage("location.pathname"));
    const landingTitle = String(await evalInPage("document.title"));
    const landedHome = landingUrl === "/home" && landingTitle === "Zeck — Home";
    record("landing-home", landedHome, `landed ${landingUrl} (title: ${landingTitle})`);

    // 2. THE OUTCOME EXPLANATION is visible on the landing (no search).
    const outcomeVisible = Boolean(
      await evalInPage(`document.body.innerText.includes(${JSON.stringify(OUTCOME_STATEMENT)})`),
    );
    record(
      "outcome-explanation",
      outcomeVisible,
      outcomeVisible ? "visible on Home" : "NOT visible",
    );

    // 3. CAPABILITY DISCOVERY: the families grid is on Home; the catalog
    //    serves all 22 families with the four honest states.
    const gridCount = Number(
      await evalInPage("document.querySelectorAll('.availability-grid a').length"),
    );
    record("home-families-grid", gridCount >= 22, `${gridCount} family links on Home`);
    await open(`${base}/console/catalog`);
    const catalogRows = Number(
      await evalInPage("document.querySelectorAll('.catalog-table tbody tr').length"),
    );
    const catalogStates = String(
      await evalInPage(
        "['Available','Requires access','Provider-gated','NOT RUN'].map(s => document.body.innerText.includes(s)).join(',')",
      ),
    );
    const fourStates = catalogStates === "true,true,true,true";
    record(
      "capability-catalog",
      catalogRows === 22 && fourStates,
      `${catalogRows} families; four states present: ${catalogStates}`,
    );

    // 4. SAFE START: the guided sandbox shows the safety envelope before
    //    any run, with no provider/model selection.
    await open(`${base}/console/start`);
    const startText = String(await evalInPage("document.body.innerText"));
    const envelope = startText.includes("safety envelope") && startText.includes("2.00");
    const noProviderPick = !/select (a |the )?(provider|model)/i.test(startText);
    record(
      "safe-start-envelope",
      envelope && noProviderPick,
      `envelope=${envelope}; no provider/model selection=${noProviderPick}`,
    );

    // 5. THE FALL-THROUGH SPOT SWEEP (the previously-broken classes, in
    //    the real browser): Work, Build, Library, Improve, the shell's
    //    utilities and the agents UI — every one must render HTML.
    for (const [path, label] of [
      ["/runs", "work"],
      ["/build", "build"],
      ["/build/agents", "agents-ui"],
      ["/assets", "library"],
      ["/improve/insights", "improve"],
      ["/command", "command"],
      ["/attention", "attention"],
    ] as const) {
      await open(`${base}${path}`);
      const contentType = String(await evalInPage("document.contentType"));
      const hasTitle = Boolean(await evalInPage("Boolean(document.title)"));
      record(
        `visible-route-${label}`,
        contentType === "text/html" && hasTitle,
        `${path} served ${contentType}`,
      );
    }

    // 6. THE API BOUNDARY (same origin): the machine routes stay machine.
    for (const [path, label] of [
      ["/agents", "agents-machine"],
      ["/health", "health"],
    ] as const) {
      await open(`${base}${path}`);
      const contentType = String(await evalInPage("document.contentType"));
      record(
        `api-boundary-${label}`,
        contentType === "application/json",
        `${path} served ${contentType}`,
      );
    }

    // 7. RESPONSIVE (mobile viewport): no horizontal scroll, the bottom
    //    bar, the canonical Home link, touch-safe targets.
    await browser(["set", "viewport", "390", "844"]);
    await open(`${base}/home`);
    const mobile = String(
      await evalInPage(
        "JSON.stringify({hscroll: document.documentElement.scrollWidth > document.documentElement.clientWidth, nav: getComputedStyle(document.querySelector('.mobile-nav')).display !== 'none', home: document.querySelector('.mobile-nav a')?.getAttribute('href'), targets: Array.from(document.querySelectorAll('.mobile-nav a')).every(a => a.getBoundingClientRect().height >= 40)})",
      ),
    );
    const mobileParsed = JSON.parse(mobile) as {
      hscroll: boolean;
      nav: boolean;
      home: string | undefined;
      targets: boolean;
    };
    record(
      "responsive-mobile",
      mobileParsed.hscroll === false &&
        mobileParsed.nav === true &&
        mobileParsed.home === "/home" &&
        mobileParsed.targets === true,
      mobile,
    );

    // 8. KEYBOARD: the skip link is the first focusable, focus is visible.
    await browser(["set", "viewport", "1280", "800"]);
    await open(`${base}/home`);
    await browser(["press", "Tab"]);
    const firstFocus = String(
      await evalInPage(
        "(()=>{const el=document.activeElement; return el.tagName + ' ' + (el.getAttribute('href') ?? '') + ' ' + (el.matches(':focus-visible') ? 'visible' : 'not-visible');})()",
      ),
    );
    record(
      "keyboard-skip-link",
      firstFocus.startsWith("A #main") && firstFocus.endsWith("visible"),
      firstFocus,
    );

    await browser(["close"]);
  } finally {
    await composition.stop();
  }

  const failed = results.filter((step) => step.status === "fail");
  console.log(
    JSON.stringify(
      {
        tool: "tests/browser/public-experience-browser-smoke.ts",
        composition: "local two-function plane (deploy/local-experience-gateway.ts)",
        steps: results,
        summary: {
          passed: results.length - failed.length,
          failed: failed.length,
        },
      },
      null,
      2,
    ),
  );
  return failed.length === 0 ? 0 : 1;
}

main()
  .then((code) => {
    process.exit(code);
  })
  .catch((error: unknown) => {
    console.error(`browser smoke error: ${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
