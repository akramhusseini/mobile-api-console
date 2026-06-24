"use strict";

const { EventEmitter } = require("node:events");

class EventStore extends EventEmitter {
  constructor({ storage, sourceKind = "unknown", sourceMetadata = null } = {}) {
    super();
    if (!storage) {
      throw new Error("EventStore requires a storage backend");
    }
    this.storage = storage;
    this.sourceKind = sourceKind;
    this.sourceMetadata = sourceMetadata;
    this.currentSessionId = null;
  }

  init() {
    const session = this.storage.createSession({
      sourceKind: this.sourceKind,
      sourceMetadata: this.sourceMetadata
    });
    this.currentSessionId = session.id;
    return session;
  }

  setSource(sourceKind, sourceMetadata = null) {
    this.sourceKind = sourceKind;
    this.sourceMetadata = sourceMetadata;
  }

  currentSession() {
    if (!this.currentSessionId) return null;
    return this.storage.getSession(this.currentSessionId);
  }

  snapshot() {
    if (!this.currentSessionId) return [];
    return this.storage.listEvents({ sessionId: this.currentSessionId });
  }

  recentSessions({ limit = 20 } = {}) {
    return this.storage.listSessions({ limit });
  }

  eventsForSession(sessionId) {
    return this.storage.listEvents({ sessionId });
  }

  upsert(event) {
    const saved = this.storage.saveEvent(this.currentSessionId, event);
    this.emit("upsert", saved);
    return saved;
  }

  addError(message, rawLine) {
    const errorId = `log-error-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    return this.upsert({
      id: errorId,
      state: "error",
      method: "LOG",
      url: "",
      host: "",
      path: "Runtime log error",
      statusCode: null,
      request: null,
      response: null,
      curl: "",
      errors: [message],
      raw: rawLine ? [rawLine] : [message]
    });
  }

  clear(reason = "manual") {
    const previousId = this.currentSessionId;
    if (previousId) this.storage.endSession(previousId);

    const next = this.storage.createSession({
      sourceKind: this.sourceKind,
      sourceMetadata: this.sourceMetadata
    });
    this.currentSessionId = next.id;

    const payload = {
      reason,
      clearedAt: new Date().toISOString(),
      previousSessionId: previousId,
      session: next
    };
    this.emit("session-start", payload);
  }

  closeCurrentSession() {
    if (this.currentSessionId) {
      this.storage.endSession(this.currentSessionId);
    }
  }
}

module.exports = { EventStore };
