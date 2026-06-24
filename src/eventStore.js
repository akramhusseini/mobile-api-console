"use strict";

const { EventEmitter } = require("node:events");

class EventStore extends EventEmitter {
  constructor({ storage, sourceKey = "default", sourceKind = "unknown", sourceMetadata = null } = {}) {
    super();
    if (!storage) {
      throw new Error("EventStore requires a storage backend");
    }
    this.storage = storage;
    this.defaultSourceKey = sourceKey;
    this.selectedSourceKey = sourceKey;
    this.sources = new Map();
    this.pendingSource = {
      sourceKey,
      sourceKind,
      sourceMetadata
    };
  }

  init() {
    const { sourceKey, sourceKind, sourceMetadata } = this.pendingSource;
    return this.initSource(sourceKey, { sourceKind, sourceMetadata });
  }

  initSource(sourceKey, { sourceKind = "unknown", sourceMetadata = null } = {}) {
    const session = this.storage.createSession({
      sourceKind,
      sourceMetadata
    });
    this.sources.set(sourceKey, {
      currentSessionId: session.id,
      sourceKind,
      sourceMetadata
    });
    if (!this.selectedSourceKey || !this.sources.has(this.selectedSourceKey)) {
      this.selectedSourceKey = sourceKey;
    }
    return this.decorateSession(session, sourceKey);
  }

  ensureSource(sourceKey, metadata = {}) {
    if (this.sources.has(sourceKey)) return this.currentSession(sourceKey);
    return this.initSource(sourceKey, metadata);
  }

  setSource(sourceKind, sourceMetadata = null, sourceKey = this.selectedSourceKey) {
    if (!this.sources.has(sourceKey)) {
      this.pendingSource = { sourceKey, sourceKind, sourceMetadata };
      return;
    }
    const entry = this.sources.get(sourceKey);
    entry.sourceKind = sourceKind;
    entry.sourceMetadata = sourceMetadata;
  }

  selectSource(sourceKey) {
    if (!this.sources.has(sourceKey)) {
      throw new Error(`Unknown source session: ${sourceKey}`);
    }
    this.selectedSourceKey = sourceKey;
  }

  get currentSessionId() {
    const current = this.currentSession();
    return current ? current.id : null;
  }

  currentSession(sourceKey = this.selectedSourceKey) {
    const source = this.sources.get(sourceKey);
    if (!source?.currentSessionId) return null;
    return this.decorateSession(this.storage.getSession(source.currentSessionId), sourceKey);
  }

  currentSessions() {
    return [...this.sources.keys()]
      .map((sourceKey) => this.currentSession(sourceKey))
      .filter(Boolean);
  }

  snapshot(sourceKey = this.selectedSourceKey) {
    const current = this.currentSession(sourceKey);
    if (!current) return [];
    return this.eventsForSession(current.id);
  }

  recentSessions({ limit = 20, sourceKey = null } = {}) {
    const fetchLimit = sourceKey ? Math.max(limit * 5, 50) : limit;
    const sessions = this.storage
      .listSessions({ limit: fetchLimit })
      .map((session) => this.decorateSession(session));

    if (!sourceKey) return sessions.slice(0, limit);
    return sessions
      .filter((session) => session.sourceKey === sourceKey)
      .slice(0, limit);
  }

  eventsForSession(sessionId) {
    const session = this.storage.getSession(sessionId);
    const sourceKey = this.sourceKeyForSession(session);
    return this.storage
      .listEvents({ sessionId })
      .map((event) => this.decorateEvent(event, sourceKey));
  }

  upsert(event) {
    return this.upsertForSource(this.selectedSourceKey, event);
  }

  upsertForSource(sourceKey, event) {
    const current = this.currentSession(sourceKey);
    if (!current) {
      throw new Error(`No active session for source: ${sourceKey}`);
    }
    const saved = this.decorateEvent(this.storage.saveEvent(current.id, event), sourceKey);
    this.emit("upsert", saved);
    return saved;
  }

  addError(message, rawLine) {
    return this.addErrorForSource(this.selectedSourceKey, message, rawLine);
  }

  addErrorForSource(sourceKey, message, rawLine) {
    const errorId = `log-error-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    return this.upsertForSource(sourceKey, {
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
    return this.clearSource(this.selectedSourceKey, reason);
  }

  clearSource(sourceKey, reason = "manual") {
    const source = this.sources.get(sourceKey);
    if (!source) {
      throw new Error(`No active session for source: ${sourceKey}`);
    }

    const previousId = source.currentSessionId;
    if (previousId) this.storage.endSession(previousId);

    const next = this.storage.createSession({
      sourceKind: source.sourceKind,
      sourceMetadata: source.sourceMetadata
    });
    source.currentSessionId = next.id;

    const payload = {
      sourceKey,
      reason,
      clearedAt: new Date().toISOString(),
      previousSessionId: previousId,
      session: this.decorateSession(next, sourceKey)
    };
    this.emit("session-start", payload);
    return payload.session;
  }

  closeCurrentSession(sourceKey = this.selectedSourceKey) {
    const source = this.sources.get(sourceKey);
    if (source?.currentSessionId) {
      this.storage.endSession(source.currentSessionId);
    }
  }

  closeAllSessions() {
    for (const sourceKey of this.sources.keys()) {
      this.closeCurrentSession(sourceKey);
    }
  }

  decorateSession(session, explicitSourceKey = null) {
    if (!session) return null;
    return {
      ...session,
      sourceKey: explicitSourceKey || this.sourceKeyForSession(session)
    };
  }

  decorateEvent(event, sourceKey = null) {
    if (!event) return null;
    return {
      ...event,
      sourceKey: sourceKey || this.sourceKeyForEvent(event)
    };
  }

  sourceKeyForEvent(event) {
    if (!event?.sessionId) return null;
    return this.sourceKeyForSession(this.storage.getSession(event.sessionId));
  }

  sourceKeyForSession(session) {
    if (!session) return null;
    if (session.sourceKind === "ios-simulator") return "ios";
    if (session.sourceKind === "demo") return "demo";
    if (session.sourceKind === "android-emulator" || session.sourceKind === "android-device") {
      return `android::${session.sourceMetadata?.deviceSerial || ""}`;
    }
    return session.sourceKind || "unknown";
  }
}

module.exports = { EventStore };
