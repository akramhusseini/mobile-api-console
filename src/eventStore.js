"use strict";

const { EventEmitter } = require("node:events");

class EventStore extends EventEmitter {
  constructor({ storage, sourceKey = "default", sourceKind = "unknown", sourceMetadata = null, maxEvents = 400 } = {}) {
    super();
    if (!storage) {
      throw new Error("EventStore requires a storage backend");
    }
    this.storage = storage;
    this.defaultSourceKey = sourceKey;
    this.selectedSourceKey = sourceKey;
    this.maxEvents = Number.isFinite(maxEvents) && maxEvents > 0 ? maxEvents : 400;
    this.sources = new Map();
    this.sourceKeys = new Map();
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

  initSource(sourceKey, { sourceKind = "unknown", sourceMetadata = null, sessionKey = null } = {}) {
    const resolvedKey = sessionKey || sourceKey;
    const session = this.storage.createSession({
      label: sourceKind && (sourceKind === "browser-chromium" || sourceKind === "browser-gecko" || sourceKind === "browser-webkit")
        ? browserSessionLabel(sourceMetadata)
        : null,
      sourceKind,
      sourceMetadata
    });
    this.sources.set(resolvedKey, {
      currentSessionId: session.id,
      sourceKind,
      sourceMetadata,
      sourceKey
    });
    this.trackSourceKey(sourceKey, resolvedKey);
    if (!this.selectedSourceKey || !this.sources.has(this.selectedSourceKey)) {
      this.selectedSourceKey = sourceKey;
    }
    return this.decorateSession(session, sourceKey);
  }

  // Register an umbrella source — a virtual entry that has no current session
  // of its own but is a known, selectable source key. Used for browser, which
  // is one selectable source with many per-(origin, profile, context) child
  // sessions. The umbrella can be selected before any traffic and after.
  registerUmbrellaSource(sourceKey, { sourceKind = "unknown", sourceMetadata = null } = {}) {
    if (!sourceKey) throw new Error("registerUmbrellaSource requires a sourceKey");
    if (this.sources.has(sourceKey)) return;
    this.sources.set(sourceKey, {
      currentSessionId: null,
      sourceKind,
      sourceMetadata,
      sourceKey,
      isUmbrella: true
    });
    this.trackSourceKey(sourceKey, sourceKey);
  }

  ensureSource(sourceKey, metadata = {}) {
    if (this.sources.has(sourceKey)) return this.currentSession(sourceKey);
    return this.initSource(sourceKey, metadata);
  }

  ensureSourceSession(sessionKey, { sourceKey, sourceKind = "unknown", sourceMetadata = null } = {}) {
    if (!sessionKey) throw new Error("ensureSourceSession requires a sessionKey");
    if (!sourceKey) throw new Error("ensureSourceSession requires a sourceKey");
    if (this.sources.has(sessionKey)) return this.currentSessionByKey(sessionKey);
    // Ensure the umbrella entry exists so the parent source is selectable
    // even if no traffic has arrived yet.
    if (isBrowserSourceKind(sourceKind) && !this.sources.has(sourceKey)) {
      this.registerUmbrellaSource(sourceKey, { sourceKind, sourceMetadata });
    }
    return this.initSource(sourceKey, { sourceKind, sourceMetadata, sessionKey });
  }

  hasSourceSession(sessionKey) {
    return Boolean(sessionKey && this.sources.has(sessionKey));
  }

  isUmbrellaSourceKey(sourceKey) {
    const entry = this.sources.get(sourceKey);
    return Boolean(entry && entry.isUmbrella);
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
    if (this.sources.has(sourceKey)) {
      const source = this.sources.get(sourceKey);
      if (source?.currentSessionId) {
        return this.decorateSession(this.storage.getSession(source.currentSessionId), sourceKey);
      }
      // Umbrella source (e.g. "browser"): the parent has no session of its
      // own, but children do. Fall through to find the most recent live
      // session under this source key so callers can still surface something
      // useful to the UI when the user selects the umbrella.
    }
    return this.mostRecentSessionForSourceKey(sourceKey);
  }

  currentSessionByKey(sessionKey) {
    const source = this.sources.get(sessionKey);
    if (!source?.currentSessionId) return null;
    return this.decorateSession(this.storage.getSession(source.currentSessionId), source.sourceKey);
  }

  mostRecentSessionForSourceKey(sourceKey) {
    const sessionKeys = this.sourceKeys.get(sourceKey);
    if (!sessionKeys || sessionKeys.size === 0) return null;
    let latest = null;
    let latestStartedAt = "";
    for (const sessionKey of sessionKeys) {
      const entry = this.sources.get(sessionKey);
      if (!entry?.currentSessionId) continue;
      const session = this.storage.getSession(entry.currentSessionId);
      if (!session) continue;
      const startedAt = session.startedAt || "";
      if (!latest || startedAt > latestStartedAt) {
        latest = session;
        latestStartedAt = startedAt;
      }
    }
    return latest ? this.decorateSession(latest, sourceKey) : null;
  }

  currentSessions() {
    const out = [];
    for (const entry of this.sources.values()) {
      if (!entry?.currentSessionId) continue;
      const session = this.storage.getSession(entry.currentSessionId);
      if (session) out.push(this.decorateSession(session, entry.sourceKey));
    }
    return out;
  }

  snapshot(sourceKey = this.selectedSourceKey) {
    const current = this.currentSession(sourceKey);
    if (!current) return [];
    return this.eventsForSession(current.id, { limit: this.maxEvents });
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

  eventsForSession(sessionId, { limit = null } = {}) {
    const session = this.storage.getSession(sessionId);
    const sourceKey = this.sourceKeyForSession(session);
    return this.storage
      .listEvents({ sessionId, limit: limit ?? undefined })
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

  upsertForSourceSession(sessionKey, event) {
    if (!this.sources.has(sessionKey)) {
      throw new Error(`Unknown source session: ${sessionKey}`);
    }
    const entry = this.sources.get(sessionKey);
    if (!entry?.currentSessionId) {
      throw new Error(`No active session for source session: ${sessionKey}`);
    }
    const session = this.storage.getSession(entry.currentSessionId);
    const saved = this.decorateEvent(this.storage.saveEvent(session.id, event), entry.sourceKey);
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
      label: source.sourceKind && (source.sourceKind === "browser-chromium" || source.sourceKind === "browser-gecko" || source.sourceKind === "browser-webkit")
        ? browserSessionLabel(source.sourceMetadata)
        : null,
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

  clearSourceSession(sessionKey, reason = "manual") {
    const source = this.sources.get(sessionKey);
    if (!source) {
      throw new Error(`Unknown source session: ${sessionKey}`);
    }

    const previousId = source.currentSessionId;
    if (previousId) this.storage.endSession(previousId);

    const next = this.storage.createSession({
      label: browserSessionLabel(source.sourceMetadata),
      sourceKind: source.sourceKind,
      sourceMetadata: source.sourceMetadata
    });
    source.currentSessionId = next.id;

    const payload = {
      sourceKey: source.sourceKey,
      sessionKey,
      reason,
      clearedAt: new Date().toISOString(),
      previousSessionId: previousId,
      session: this.decorateSession(next, source.sourceKey)
    };
    this.emit("session-start", payload);
    return payload.session;
  }

  // Clear the live session for a given session id. For multi-session sources
  // (browser) this targets only the matching (origin, profileId, context)
  // session; for single-session sources it behaves like clearSource().
  clearSessionById(sessionId, reason = "manual") {
    if (!Number.isFinite(sessionId)) {
      throw new Error("clearSessionById requires a numeric session id");
    }
    const session = this.storage.getSession(sessionId);
    if (!session) return null;

    // Find which sources entry owns this session id.
    for (const [key, entry] of this.sources.entries()) {
      if (entry.currentSessionId === sessionId) {
        const sourceKey = entry.sourceKey;
        if (isBrowserSourceKind(entry.sourceKind)) {
          return this.clearSourceSession(key, reason);
        }
        return this.clearSource(sourceKey, reason);
      }
    }
    // Fallback: the session is not live (already ended). Just end it.
    this.storage.endSession(sessionId);
    return this.decorateSession(this.storage.getSession(sessionId));
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

  trackSourceKey(sourceKey, sessionKey) {
    if (!sourceKey) return;
    let set = this.sourceKeys.get(sourceKey);
    if (!set) {
      set = new Set();
      this.sourceKeys.set(sourceKey, set);
    }
    set.add(sessionKey);
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
    if (isBrowserSourceKind(session.sourceKind)) {
      return "browser";
    }
    return session.sourceKind || "unknown";
  }
}

function isBrowserSourceKind(sourceKind) {
  return sourceKind === "browser-chromium"
    || sourceKind === "browser-gecko"
    || sourceKind === "browser-webkit";
}

function browserSessionLabel(sourceMetadata) {
  if (!sourceMetadata || !sourceMetadata.browserSession) return null;
  const { origin, context } = sourceMetadata.browserSession;
  if (!origin) return null;
  return context ? `${origin} (${context})` : origin;
}

module.exports = { EventStore };
