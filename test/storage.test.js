"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { SqliteStorage } = require("../src/storage/sqliteStorage");

function withTempStorage(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mobile-api-console-test-"));
  const dbPath = path.join(dir, "data.db");
  const storage = new SqliteStorage({ databasePath: dbPath }).init();
  try {
    return fn(storage);
  } finally {
    storage.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("applies migrations on init and is idempotent", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mobile-api-console-test-"));
  const dbPath = path.join(dir, "data.db");
  try {
    const first = new SqliteStorage({ databasePath: dbPath }).init();
    first.close();
    const second = new SqliteStorage({ databasePath: dbPath }).init();
    const tables = second.db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all()
      .map((row) => row.name);
    second.close();
    assert.ok(tables.includes("sessions"));
    assert.ok(tables.includes("events"));
    assert.ok(tables.includes("_migrations"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("creates a session and ends it", () => {
  withTempStorage((storage) => {
    const session = storage.createSession({ label: "test", sourceKind: "simulator" });
    assert.ok(session.id);
    assert.equal(session.label, "test");
    assert.equal(session.endedAt, null);

    const ended = storage.endSession(session.id);
    assert.ok(ended.endedAt);
  });
});

test("upserts events and bumps session event_count", () => {
  withTempStorage((storage) => {
    const session = storage.createSession({ sourceKind: "test" });

    storage.saveEvent(session.id, {
      id: "1",
      method: "GET",
      url: "https://example.com/a",
      host: "example.com",
      path: "/a",
      statusCode: 200,
      state: "success",
      request: { headers: { Accept: "application/json" } },
      response: { statusCode: 200, body: "{}" },
      raw: ["raw-1"]
    });

    // upsert same client_event_id should not duplicate
    storage.saveEvent(session.id, {
      id: "1",
      statusCode: 200,
      response: { statusCode: 200, body: "{\"ok\":true}" }
    });

    const events = storage.listEvents({ sessionId: session.id });
    assert.equal(events.length, 1);
    assert.equal(events[0].method, "GET");
    assert.equal(events[0].response.body, "{\"ok\":true}");

    const refreshed = storage.getSession(session.id);
    assert.equal(refreshed.eventCount, 1);
  });
});

test("listSessions returns newest first", () => {
  withTempStorage((storage) => {
    const a = storage.createSession({ label: "a", startedAt: "2026-06-24T10:00:00.000Z" });
    const b = storage.createSession({ label: "b", startedAt: "2026-06-24T11:00:00.000Z" });
    const sessions = storage.listSessions({ limit: 10 });
    assert.equal(sessions[0].id, b.id);
    assert.equal(sessions[1].id, a.id);
  });
});
