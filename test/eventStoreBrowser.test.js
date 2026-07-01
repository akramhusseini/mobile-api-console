"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { SqliteStorage } = require("../src/storage/sqliteStorage");
const { EventStore } = require("../src/eventStore");
const { BrowserEventParser } = require("../src/parsers/browserEventParser");

function withStore(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mac-eventstore-browser-"));
  const dbPath = path.join(dir, "data.db");
  const storage = new SqliteStorage({ databasePath: dbPath }).init();
  const store = new EventStore({ storage });
  store.init();
  try {
    return fn({ store, storage });
  } finally {
    storage.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function wireEvent(overrides = {}) {
  return {
    v: 1,
    sourceKind: "browser-chromium",
    browserSession: {
      origin: "https://app.example.com",
      profileId: "bprof_8f3d1b6c9a2e4f10",
      context: "regular"
    },
    tabId: 17,
    captureMode: "merged",
    eventId: "f1c3a2b8-9f0d-4f5b-9c7e-8a2e1d3b4c5d",
    phase: "complete",
    request: {
      startedAt: 1751280000000,
      method: "GET",
      url: "https://app.example.com/v1/users",
      headers: { Accept: "application/json" },
      body: null,
      bodyAvailable: true,
      bodyTruncated: false,
      bodyUnavailableReason: null
    },
    response: {
      completedAt: 1751280000042,
      durationMs: 42,
      status: 200,
      headers: { "Content-Type": "application/json" },
      body: '{"data":[]}',
      bodyAvailable: true,
      bodyTruncated: false,
      bodyUnavailableReason: null
    },
    metadata: { pageUrl: "https://app.example.com/" },
    error: null,
    ...overrides
  };
}

test("same origin+profile+context collapses to one browser session", () => {
  withStore(({ store, storage }) => {
    const parser = new BrowserEventParser();
    const a = parser.normalizeEvent(wireEvent({ tabId: 1, eventId: "evt-a" }));
    const b = parser.normalizeEvent(wireEvent({ tabId: 99, eventId: "evt-b" }));
    const sessionKeyA = parser.sessionKeyFor(wireEvent());
    const sessionKeyB = parser.sessionKeyFor(wireEvent({ tabId: 99 }));

    assert.equal(sessionKeyA, sessionKeyB, "tabId is metadata only and must not affect the session key");
    store.ensureSourceSession(sessionKeyA, {
      sourceKey: "browser",
      sourceKind: "browser-chromium",
      sourceMetadata: parser.sourceMetadataFor(wireEvent())
    });

    store.upsertForSourceSession(sessionKeyA, a);
    store.upsertForSourceSession(sessionKeyB, b);

    const session = store.currentSessionByKey(sessionKeyA);
    assert.ok(session);
    assert.equal(session.sourceKey, "browser");
    const events = store.eventsForSession(session.id, { limit: 50 });
    assert.equal(events.length, 2);
    const ids = events.map((event) => event.id).sort();
    assert.deepEqual(ids, ["evt-a", "evt-b"]);

    const refreshed = storage.getSession(session.id);
    assert.equal(refreshed.eventCount, 2);
  });
});

test("different profileId or context produces a separate browser session", () => {
  withStore(({ store }) => {
    const parser = new BrowserEventParser();
    const regularWire = wireEvent();
    const incognitoWire = wireEvent({
      browserSession: {
        origin: "https://app.example.com",
        profileId: "bprof_8f3d1b6c9a2e4f10",
        context: "incognito"
      },
      eventId: "evt-incognito"
    });
    const otherOriginWire = wireEvent({
      browserSession: {
        origin: "https://other.example.com",
        profileId: "bprof_8f3d1b6c9a2e4f10",
        context: "regular"
      },
      eventId: "evt-other"
    });
    const otherProfileWire = wireEvent({
      browserSession: {
        origin: "https://app.example.com",
        profileId: "bprof_different",
        context: "regular"
      },
      eventId: "evt-profile"
    });

    const keys = [regularWire, incognitoWire, otherOriginWire, otherProfileWire].map((w) => parser.sessionKeyFor(w));
    assert.equal(new Set(keys).size, 4, "expected four distinct session keys");

    for (const w of [regularWire, incognitoWire, otherOriginWire, otherProfileWire]) {
      const key = parser.sessionKeyFor(w);
      store.ensureSourceSession(key, {
        sourceKey: "browser",
        sourceKind: w.sourceKind,
        sourceMetadata: parser.sourceMetadataFor(w)
      });
      store.upsertForSourceSession(key, parser.normalizeEvent(w));
    }

    const liveSessions = store.currentSessions().filter((s) => s.sourceKey === "browser");
    assert.equal(liveSessions.length, 4, "all four browser sessions must be live simultaneously");

    // Clearing one browser session must not touch the other three.
    const target = parser.sessionKeyFor(regularWire);
    const beforeClearId = store.currentSessionByKey(target).id;
    const siblingBeforeId = store.currentSessionByKey(parser.sessionKeyFor(otherOriginWire)).id;
    store.clearSourceSession(target, "browser-marker");

    const afterClear = store.currentSessions().filter((s) => s.sourceKey === "browser");
    assert.equal(afterClear.length, 4, "clear must not destroy sibling sessions");

    const clearedSession = store.currentSessionByKey(target);
    const siblingSession = store.currentSessionByKey(parser.sessionKeyFor(otherOriginWire));
    assert.notEqual(clearedSession.id, beforeClearId, "clear should rotate the target session id");
    assert.equal(siblingSession.id, siblingBeforeId, "sibling session id must be unchanged");
    // After clearSourceSession, the target session is a fresh one with no events;
    // sibling session should be untouched and contain its event.
    const clearedEvents = store.eventsForSession(clearedSession.id, { limit: 50 });
    const siblingEvents = store.eventsForSession(siblingSession.id, { limit: 50 });
    assert.equal(clearedEvents.length, 0, "cleared session must be empty");
    assert.equal(siblingEvents.length, 1, "sibling session must keep its event");
  });
});

test("clearSourceSession emits a session-start event with the right sourceKey", () => {
  withStore(({ store }) => {
    const parser = new BrowserEventParser();
    const wire = wireEvent();
    const sessionKey = parser.sessionKeyFor(wire);

    store.ensureSourceSession(sessionKey, {
      sourceKey: "browser",
      sourceKind: wire.sourceKind,
      sourceMetadata: parser.sourceMetadataFor(wire)
    });
    store.upsertForSourceSession(sessionKey, parser.normalizeEvent(wire));

    const seen = [];
    store.on("session-start", (payload) => seen.push(payload));

    const next = store.clearSourceSession(sessionKey, "browser-marker");
    assert.equal(seen.length, 1);
    assert.equal(seen[0].sourceKey, "browser");
    assert.equal(seen[0].sessionKey, sessionKey);
    assert.equal(next.id, seen[0].session.id);
  });
});

test("currentSession('browser') returns the most recent live browser session", () => {
  withStore(({ store }) => {
    const parser = new BrowserEventParser();
    const w1 = wireEvent({ eventId: "evt-1" });
    const w2 = wireEvent({
      browserSession: {
        origin: "https://other.example.com",
        profileId: "bprof_8f3d1b6c9a2e4f10",
        context: "regular"
      },
      eventId: "evt-2"
    });
    const k1 = parser.sessionKeyFor(w1);
    const k2 = parser.sessionKeyFor(w2);

    store.ensureSourceSession(k1, { sourceKey: "browser", sourceKind: w1.sourceKind, sourceMetadata: parser.sourceMetadataFor(w1) });
    store.upsertForSourceSession(k1, parser.normalizeEvent(w1));

    // Backdate k1 so k2 is more recent.
    const first = store.currentSessionByKey(k1);
    store.storage.db.prepare("UPDATE sessions SET started_at = ? WHERE id = ?")
      .run("2026-04-01T10:00:00.000Z", first.id);

    store.ensureSourceSession(k2, { sourceKey: "browser", sourceKind: w2.sourceKind, sourceMetadata: parser.sourceMetadataFor(w2) });
    store.upsertForSourceSession(k2, parser.normalizeEvent(w2));

    const current = store.currentSession("browser");
    assert.ok(current, "expected a most-recent live browser session");
    assert.equal(current.sourceKey, "browser");
    const expectedSecond = store.currentSessionByKey(k2);
    assert.equal(current.id, expectedSecond.id, "currentSession('browser') should match the newer session");

    // And both browser sessions must be visible via currentSessions(), so
    // we don't accidentally hide the older one.
    const all = store.currentSessions().filter((s) => s.sourceKey === "browser");
    assert.equal(all.length, 2, "both browser sessions must remain live");
  });
});

test("ensureSourceSession is idempotent for the same key", () => {
  withStore(({ store }) => {
    const parser = new BrowserEventParser();
    const wire = wireEvent();
    const sessionKey = parser.sessionKeyFor(wire);
    const meta = {
      sourceKey: "browser",
      sourceKind: wire.sourceKind,
      sourceMetadata: parser.sourceMetadataFor(wire)
    };
    const a = store.ensureSourceSession(sessionKey, meta);
    const b = store.ensureSourceSession(sessionKey, meta);
    assert.equal(a.id, b.id, "ensureSourceSession must not create a new session for the same key");
  });
});
