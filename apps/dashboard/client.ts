/**
 * Zeck dashboard client script (WORK-033, extended as the WORK-035
 * interaction foundation) — the ONE piece of progressive enhancement,
 * served as a static asset at /assets/client.js.
 *
 * Vanilla JavaScript, no framework, NO NETWORK CALLS: everything works
 * without it (native links, GET forms, details/summary disclosures,
 * method="dialog" close forms). The foundation conveniences:
 *  - Cmd/Ctrl+K opens the global command dialog (the second front door)
 *    and falls back to focusing the header search input when the dialog
 *    is absent;
 *  - the command dialog: typing filters the static suggestion list,
 *    arrow keys rove the visible suggestions, Enter submits through the
 *    existing GET /command dispatch path, Escape closes natively;
 *  - FOCUS OWNERSHIP: opening a dialog stores the opener and focus is
 *    RESTORED to it after close (the dialog element itself owns the
 *    modal focus trap and the Escape key);
 *  - sheet dialogs open from any [data-sheet-open] trigger;
 *  - the appearance and experience-mode selects apply instantly (cookie +
 *    data-theme/data-mode) and then submit the no-script fallback form so
 *    the server-side preference stays in sync;
 *  - arrow-key roving focus over the command results list.
 */

export const CLIENT_SCRIPT = `(function () {
  "use strict";
  var lastOpener = null;

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

  function openDialog(dialog, opener) {
    if (typeof dialog.showModal !== "function") { return false; }
    lastOpener = opener || null;
    dialog.showModal();
    return true;
  }

  function openCommandSurface(opener) {
    var dialog = document.getElementById("command-dialog");
    if (dialog && dialog.open !== true) {
      if (!openDialog(dialog, opener)) {
        var fallback = document.getElementById("command-input");
        if (fallback) { fallback.focus(); fallback.select(); }
      }
    }
  }

  document.addEventListener("keydown", function (event) {
    if ((event.metaKey || event.ctrlKey) && (event.key === "k" || event.key === "K")) {
      event.preventDefault();
      openCommandSurface(document.activeElement);
    }
  });

  // Command-dialog triggers (the header button and any [data-command-open]).
  var commandTriggers = Array.prototype.slice.call(
    document.querySelectorAll("[data-command-open]")
  );
  commandTriggers.forEach(function (trigger) {
    trigger.addEventListener("click", function () {
      openCommandSurface(trigger);
    });
  });

  // Sheet triggers: [data-sheet-open="<dialog id>"].
  var sheetTriggers = Array.prototype.slice.call(
    document.querySelectorAll("[data-sheet-open]")
  );
  sheetTriggers.forEach(function (trigger) {
    trigger.addEventListener("click", function (event) {
      event.preventDefault();
      var dialog = document.getElementById(trigger.getAttribute("data-sheet-open"));
      if (dialog) { openDialog(dialog, trigger); }
    });
  });

  // FOCUS RESTORE: when any dialog closes, focus returns to its opener.
  var dialogs = Array.prototype.slice.call(document.querySelectorAll("dialog"));
  dialogs.forEach(function (dialog) {
    dialog.addEventListener("close", function () {
      var opener = lastOpener;
      lastOpener = null;
      if (opener && typeof opener.focus === "function" && document.contains(opener)) {
        opener.focus();
      }
    });
  });

  // The command dialog: live filter + roving over the visible suggestions.
  var commandDialog = document.getElementById("command-dialog");
  if (commandDialog) {
    var input = commandDialog.querySelector("input[name='q']");
    var list = commandDialog.querySelector("[data-command-suggestions]");
    var empty = commandDialog.querySelector("[data-command-empty]");
    var visible = function () {
      return list ? Array.prototype.slice.call(list.querySelectorAll("li:not([hidden]) a")) : [];
    };
    var filter = function () {
      if (!list) { return; }
      var query = (input && input.value ? input.value : "").trim().toLowerCase();
      var shown = 0;
      Array.prototype.slice.call(list.children).forEach(function (item) {
        var text = (item.textContent || "").toLowerCase();
        var matches = query.length === 0 || text.indexOf(query) !== -1;
        if (matches) { item.removeAttribute("hidden"); shown += 1; }
        else { item.setAttribute("hidden", "hidden"); }
      });
      if (empty) {
        if (shown === 0) { empty.removeAttribute("hidden"); }
        else { empty.setAttribute("hidden", "hidden"); }
      }
    };
    if (input) {
      input.addEventListener("input", filter);
      input.addEventListener("keydown", function (event) {
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          event.preventDefault();
          var links = visible();
          if (links.length === 0) { return; }
          var current = links.indexOf(document.activeElement);
          var next = event.key === "ArrowDown"
            ? Math.min(current + 1, links.length - 1)
            : Math.max(current - 1, 0);
          if (next >= 0 && links[next]) { links[next].focus(); }
        }
      });
    }
  }

  // Presentation preferences: apply instantly, then sync the server cookie
  // through the no-script fallback form.
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
  var modeForm = document.querySelector("form.mode-form");
  if (modeForm) {
    var modeSelect = modeForm.querySelector("select[data-mode-select]");
    if (modeSelect) {
      modeSelect.addEventListener("change", function () {
        document.cookie =
          "zeck_mode=" + encodeURIComponent(modeSelect.value) +
          "; Path=/; Max-Age=31536000; SameSite=Lax";
        modeForm.submit();
      });
    }
  }

  // Roving focus over the server-rendered command results list.
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
