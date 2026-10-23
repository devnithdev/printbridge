// Helpers for random ids and tokens.

const crypto = require("crypto");

// A short, readable id for database rows.
function newId(prefix) {
  return prefix + "_" + crypto.randomBytes(9).toString("hex");
}

// A long secret string, used for session cookies, agent tokens and
// one-time file links. 32 random bytes is plenty.
function newToken() {
  return crypto.randomBytes(32).toString("hex");
}

// We never store raw tokens in the database. We store this hash instead,
// so a leaked database file does not hand out working tokens.
function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

// Compare two secrets without leaking, through timing, how much matched.
function safeEqual(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

module.exports = { newId, newToken, hashToken, safeEqual };
