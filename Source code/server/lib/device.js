// Who is this? - the whole answer, and it is deliberately small.
//
// There are no accounts and no passwords. The first time a browser visits,
// it gets a random id in a cookie. That id is only used for two things:
//   1. labelling a job as "yours" on the shared queue,
//   2. letting you cancel a job you sent, and nobody else's.
//
// The friendly name ("Dev's laptop") is chosen by the person, kept in their
// own browser, and sent along with each print. It is a label on a piece of
// paper, not an identity - anyone on the network can print regardless.

const { newId } = require("./ids");

const COOKIE = "device";
const COOKIE_DAYS = 365;

function readCookie(req, name) {
  const header = req.headers.cookie || "";
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return decodeURIComponent(rest.join("="));
  }
  return null;
}

// Express middleware. Puts req.deviceId on every request, issuing one to
// browsers that have never been here before.
function attachDevice(req, res, next) {
  let id = readCookie(req, COOKIE);

  if (!id || !/^dev_[a-f0-9]{8,}$/.test(id)) {
    id = newId("dev");
    const isHttps =
      req.secure || String(req.headers["x-forwarded-proto"] || "") === "https";
    const bits = [
      COOKIE + "=" + encodeURIComponent(id),
      "Path=/",
      "HttpOnly",
      "SameSite=Lax",
      "Max-Age=" + COOKIE_DAYS * 24 * 60 * 60,
    ];
    if (isHttps) bits.push("Secure");
    res.setHeader("Set-Cookie", bits.join("; "));
  }

  req.deviceId = id;
  next();
}

// Names are shown to everyone in the office, so keep them short and stop
// anyone pasting a wall of text into the queue.
function cleanLabel(value) {
  const text = String(value == null ? "" : value)
    .replace(/[\r\n\t]/g, " ")
    .trim()
    .slice(0, 40);
  return text || "Someone";
}

module.exports = { attachDevice, cleanLabel };
