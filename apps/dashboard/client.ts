/**
 * Zeck dashboard client script (WORK-033) — the ONE piece of progressive
 * enhancement, served as a static asset at /assets/client.js.
 *
 * Vanilla JavaScript, no framework, no network calls: everything works
 * without it (native links, GET forms, details/summary disclosures).
 * It adds three conveniences:
 *  - Cmd/Ctrl+K focuses the global command/search input;
 *  - the appearance select applies light/dark/system instantly (cookie +
 *    data-theme) and then submits the no-script fallback form so the
 *    server-side preference stays in sync;
 *  - arrow-key roving focus over the command results list.
 */

export const CLIENT_SCRIPT = `(function () {
  "use strict";
  function setTheme(mode) {
    if (mode === "light" || mode === "dark") {
      document.documentElement.setAttribute("data-theme", mode);
    } else {
      document.documentElement.removeAttribute("data-theme");
    }
    document.cookie =
      "zeck_appearance=" + encodeURIComponent(mode) +
      "; Path=/; Max-Age=31536000; SameSite=Lax";
  }
  document.addEventListener("keydown", function (event) {
    if ((event.metaKey || event.ctrlKey) && (event.key === "k" || event.key === "K")) {
      event.preventDefault();
      var input = document.getElementById("command-input");
      if (input) {
        input.focus();
        input.select();
      }
    }
  });
  var appearanceForm = document.querySelector("form.appearance-form");
  if (appearanceForm) {
    var select = appearanceForm.querySelector("select");
    if (select) {
      select.addEventListener("change", function () {
        setTheme(select.value);
        appearanceForm.submit();
      });
    }
  }
  var results = document.querySelector(".command-results");
  if (results) {
    var links = Array.prototype.slice.call(results.querySelectorAll("a"));
    var index = -1;
    results.addEventListener("keydown", function (event) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        if (links.length === 0) { return; }
        if (event.key === "ArrowDown") {
          index = Math.min(index + 1, links.length - 1);
        } else {
          index = Math.max(index - 1, 0);
        }
        var target = links[index];
        if (target) { target.focus(); }
      }
    });
  }
})();
`;
