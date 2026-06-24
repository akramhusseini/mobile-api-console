"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { SqliteStorage } = require("../src/storage/sqliteStorage");
const { EventStore } = require("../src/eventStore");

function withStore(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mobile-api-console-test-"));
  const dbPath = path.join(dir, "data.db");
  const storage = new SqliteStorage({ databasePath: dbPath }).init();
  const store = new EventStore({ storage, sourceKind: "test" });
  store.init();
  try {
    return fn({ store, storage });
  } finally {
    storage.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("init creates an open session and snapshot returns its events", () => {
  withStore(({ store, storage }) => {
    const current = store.currentSession();
    assert.ok(current);
    assert.equal(current.endedAt, null);

    store.upsert({ id: "1", method: "GET", url: "/a", state: "success" });
    const events = store.snapshot();
    assert.equal(events.length, 1);
    assert.equal(events[0].id, "1");

    const sessionInDb = storage.getSession(current.id);
    assert.equal(sessionInDb.eventCount, 1);
  });
});

test("clear ends current session and starts a new one", () => {
  withStore(({ store, storage }) => {
    const firstId = store.currentSession().id;

    let received = null;
    store.on("session-start", (payload) => { received = payload; });

    store.upsert({ id: "1", method: "GET", url: "/a", state: "pending" });
    store.clear("log-marker");

    assert.ok(received);
    assert.equal(received.previousSessionId, firstId);
    assert.notEqual(store.currentSession().id, firstId);

    const prev = storage.getSession(firstId);
    assert.ok(prev.endedAt);

    assert.equal(store.snapshot().length, 0);
  });
});

test("recentSessions returns newest first", () => {
  withStore(({ store }) => {
    store.upsert({ id: "1", method: "GET", url: "/a" });
    store.clear("log-marker");
    store.upsert({ id: "1", method: "POST", url: "/b" });

    const sessions = store.recentSessions({ limit: 10 });
    assert.equal(sessions.length, 2);
    assert.equal(sessions[0].endedAt, null);
    assert.ok(sessions[1].endedAt);
  });
});
