// The Help button.
//
// With no accounts there is no "the admin" to notify, so a call for help
// goes up on everyone's screen. Whoever is nearest, or knows how to clear a
// paper jam, deals with it and marks it done. That is how it works in a
// real office anyway.

const { db, save } = require("./store");
const { newId } = require("./ids");
const jobsLive = require("./jobs");

const MAX_ALERTS = 50;

function publicAlert(alert) {
  return {
    id: alert.id,
    label: alert.label,
    message: alert.message,
    createdAt: alert.createdAt,
    resolved: alert.resolved,
  };
}

function create(label, message) {
  const alert = {
    id: newId("help"),
    label: String(label || "Someone").slice(0, 40),
    message: String(message || "").trim().slice(0, 200),
    createdAt: Date.now(),
    resolved: false,
    resolvedAt: 0,
  };

  db.helpAlerts.unshift(alert);
  if (db.helpAlerts.length > MAX_ALERTS) db.helpAlerts.length = MAX_ALERTS;
  save();

  jobsLive.broadcastToEveryone("help", publicAlert(alert));
  return alert;
}

function listOpen() {
  return db.helpAlerts.filter((a) => !a.resolved).map(publicAlert);
}

function resolve(id) {
  const alert = db.helpAlerts.find((a) => a.id === id);
  if (!alert || alert.resolved) return null;
  alert.resolved = true;
  alert.resolvedAt = Date.now();
  save();
  jobsLive.broadcastToEveryone("help-resolved", { id: alert.id });
  return alert;
}

module.exports = { create, listOpen, resolve, publicAlert };
