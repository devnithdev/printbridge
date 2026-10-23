// Light and dark for the program's own pages: Setup, Check PrintBridge, the
// "wasn't printed" page and the printer-connection page. (The printing
// website has the same switch in server/public/theme.js.)
//
// Light is the default. A round sun/moon button in the top right switches,
// and the choice is remembered in that browser. The pages also tell the
// browser they have their own dark colours, so Chrome's "dark mode for
// websites" and dark-mode extensions don't paint over them (that is what
// made them look broken: white boxes with faint text on a dark page).
//
// The colours are the same as the website's (server/public/style.css), so
// every PrintBridge page looks like one product.
//
// Pages use these colour names: --bg, --card, --ink, --soft, --line,
// --field, --brand-text, --ok, --bad, --warn-bg, --warn-line, --warn-ink,
// --bad-bg, --bad-line, --bad-ink, --ok-bg, --ok-ink.

const KEY = "printbridge-theme";

// Goes inside <head>, before the page's own <style>.
function head() {
  return `<meta name="color-scheme" content="light dark">
<meta name="darkreader-lock">
<script>(function(){var t="light";try{if(localStorage.getItem("${KEY}")==="dark")t="dark";}catch(e){}document.documentElement.setAttribute("data-theme",t);})();</script>`;
}

// Goes at the start of the page's own <style> (pages may override any of it).
const CSS = `
:root { color-scheme: light;
  --bg:#f5f7fa; --card:#ffffff; --ink:#1f2933; --soft:#667085; --line:#e3e8ee; --field:#ffffff;
  --brand-text:#1E6FBF; --ok:#15803d; --bad:#b91c1c;
  --warn-bg:#fff7ed; --warn-line:#fdba74; --warn-ink:#7c3a06;
  --bad-bg:#fef2f2; --bad-line:#fca5a5; --bad-ink:#991b1b;
  --ok-bg:#f0fdf4; --ok-ink:#14532d; --code:#f1f3f6; --shadow:rgba(0,0,0,.07); }
:root[data-theme="dark"] { color-scheme: dark;
  --bg:#0f1623; --card:#1a2231; --ink:#e8edf4; --soft:#9ba8ba; --line:#2f3b4f; --field:#111a28;
  --brand-text:#74b6f4; --ok:#4ade80; --bad:#f87171;
  --warn-bg:#3a2a12; --warn-line:#8a5a1c; --warn-ink:#fcd9a0;
  --bad-bg:#3a1a1e; --bad-line:#8a2f38; --bad-ink:#fecaca;
  --ok-bg:#12301f; --ok-ink:#bbf7d0; --code:#111a28; --shadow:rgba(0,0,0,.45); }
.theme-btn { position:fixed; top:14px; right:14px; z-index:50; width:38px; height:38px; padding:0 !important;
  margin:0 !important; border-radius:50% !important; display:inline-flex; align-items:center; justify-content:center;
  background:var(--card) !important; color:var(--ink) !important; border:1px solid var(--line) !important;
  cursor:pointer; box-shadow:0 1px 4px var(--shadow); }
.theme-btn:hover { border-color:var(--brand-text) !important; }
.theme-btn svg { width:19px; height:19px; display:block; }
.theme-btn .sun { display:none; }
:root[data-theme="dark"] .theme-btn .sun { display:block; }
:root[data-theme="dark"] .theme-btn .moon { display:none; }
@media print { .theme-btn { display:none !important; } }
`;

// Goes right after <body>.
function button() {
  return `<button type="button" class="theme-btn" id="themeBtn" aria-label="Switch to dark mode" title="Switch to dark mode" onclick="pbTheme()">` +
    `<svg class="sun" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>` +
    `<svg class="moon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20.5 14.2A8.5 8.5 0 0 1 9.8 3.5a8.5 8.5 0 1 0 10.7 10.7z"/></svg>` +
    `</button>
<script>
function pbThemeLabel(){var d=document.documentElement.getAttribute("data-theme")==="dark";var b=document.getElementById("themeBtn");var l=d?"Switch to light mode":"Switch to dark mode";b.setAttribute("aria-label",l);b.title=l;}
function pbTheme(){var r=document.documentElement;var n=r.getAttribute("data-theme")==="dark"?"light":"dark";r.setAttribute("data-theme",n);try{localStorage.setItem("${KEY}",n);}catch(e){}pbThemeLabel();}
pbThemeLabel();
</script>`;
}

module.exports = { head, CSS, button, KEY };
