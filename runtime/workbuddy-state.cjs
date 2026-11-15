'use strict';
const hook = require('./hook-state.cjs');

function applyEvent(store, event) {
  return hook.applyEvent(store, event, 'workbuddy');
}

function sessionRows(store, now = Date.now()) {
  return hook.sessionRows(store, 'workbuddy', now);
}

module.exports = { applyEvent, sessionRows, ACTIVE_TTL: hook.ACTIVE_TTL, HISTORY_TTL: hook.HISTORY_TTL };
