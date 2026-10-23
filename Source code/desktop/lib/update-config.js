// Where every installed computer looks for new versions (see updater.js).
//
// MANIFEST_URL is the address of latest.json, the small file
// PUBLISH-UPDATE.command makes for each new version. GitHub's
// "releases/latest/download/..." address always points at the newest
// release, so publishing a new release there is all it takes. To host the
// files somewhere else (your own website, Cloudflare R2...), put that
// address here - any https address works, as long as latest.json and
// latest.json.sig sit side by side.
//
// Nobody can push an update by changing what is at that address: every
// computer only installs a version whose latest.json is signed with the
// private key that matches the public key in update-key.js (made once by
// PUBLISH-UPDATE.command and kept on your Mac, never in this folder).

module.exports = {
  MANIFEST_URL: "https://github.com/devnithdev/printbridge-updates/releases/latest/download/latest.json",
  // How often each computer looks. A small random amount is added so the
  // office's computers don't all ask (and download) at the same moment.
  CHECK_EVERY_HOURS: 6,
  // The first look after starting, so a computer that was off for a week
  // catches up soon after it is switched on.
  FIRST_CHECK_MINUTES: 3,
};
