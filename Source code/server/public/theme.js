// Light or dark. Light is the default; the sun/moon button in the header
// switches, and the choice is remembered on this device. Loaded in <head>, so
// the right colours are in place before the page is drawn (no flash).
(function () {
  var KEY = "printbridge-theme";
  var root = document.documentElement;

  function saved() {
    try { return localStorage.getItem(KEY) === "dark" ? "dark" : "light"; } catch (err) { return "light"; }
  }
  function remember(theme) {
    try { localStorage.setItem(KEY, theme); } catch (err) { /* private window: just not remembered */ }
  }
  function apply(theme) {
    root.setAttribute("data-theme", theme);
    var btn = document.getElementById("themeBtn");
    if (btn) {
      var label = theme === "dark" ? "Switch to light mode" : "Switch to dark mode";
      btn.setAttribute("aria-label", label);
      btn.setAttribute("title", label);
    }
  }

  apply(saved());

  var SUN = '<svg class="sun" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>';
  var MOON = '<svg class="moon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20.5 14.2A8.5 8.5 0 0 1 9.8 3.5a8.5 8.5 0 1 0 10.7 10.7z"/></svg>';

  document.addEventListener("DOMContentLoaded", function () {
    var header = document.querySelector("header");
    if (!header || document.getElementById("themeBtn")) return;
    var btn = document.createElement("button");
    btn.id = "themeBtn";
    btn.type = "button";
    btn.className = "theme-btn";
    btn.innerHTML = SUN + MOON;
    btn.addEventListener("click", function () {
      var next = root.getAttribute("data-theme") === "dark" ? "light" : "dark";
      apply(next);
      remember(next);
    });
    // Sits after the flexible gap, i.e. at the right-hand end, before the other buttons.
    var spacer = header.querySelector(".spacer");
    if (spacer) spacer.insertAdjacentElement("afterend", btn); else header.appendChild(btn);
    apply(root.getAttribute("data-theme") || "light");
  });
})();
