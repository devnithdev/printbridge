// The name and colours people see. Change them here to re-brand.
// (Folder names, the Start-up entry and firewall rules keep the internal
// name "Office Printing" - see paths.js - so re-branding never moves files,
// and Setup can always install itself over an earlier brand as an update -
// see oldsetup.js and vprinter.js for how a previous brand name is cleaned up.)

// The maker's mark shown on every page and in Setup: a coffee cup and
// "by @devnithdev". The same little cup is drawn in the website's pages
// (server/public) and in the installers.
const CUP_SVG =
  '<svg class="cup" viewBox="0 0 24 24" width="15" height="15" aria-hidden="true" ' +
  'style="vertical-align:-2px;margin-right:4px" fill="none" stroke="currentColor" stroke-width="1.8" ' +
  'stroke-linecap="round" stroke-linejoin="round">' +
  '<path d="M4 9h12v5a5 5 0 0 1-5 5H9a5 5 0 0 1-5-5V9z"/>' +
  '<path d="M16 10.5h1.5a2.5 2.5 0 0 1 0 5H16"/>' +
  '<path d="M8 3.5c-.6.8.6 1.7 0 2.5M11.5 3.5c-.6.8.6 1.7 0 2.5"/>' +
  '<path d="M3 21h14"/></svg>';

const HANDLE = "@devnithdev";

module.exports = {
  NAME: "PrintBridge",
  TAGLINE: "Print from any computer to any printer in the office.",
  COMPANY: "Devnith AE",
  MAKER: "Devnith AE",
  // Plain-text form (logs, consoles, file details).
  CREDIT: "☕ by " + HANDLE,
  // For web pages: the drawn cup and the handle.
  CREDIT_HTML: '<span class="maker">' + CUP_SVG + "by " + HANDLE + "</span>",
  HANDLE,
  CUP_SVG,
  PRIMARY: "#1E6FBF",
  PRIMARY_DARK: "#123F73",
  ACCENT: "#21A67B",
};
