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

// Regression for the browser-capture method/correlation bug. The
// browserEventParser no longer defaults missing request.method to
// "GET"; it passes null. The storage layer must keep the prior
// method on a subsequent upsert, not invent GET and overwrite.
test("storage COALESCE preserves a real prior method when a later upsert has no method", () => {
  withTempStorage((storage) => {
    const session = storage.createSession({ sourceKind: "test" });

    // Request phase: the page-inject correctly saw POST.
    storage.saveEvent(session.id, {
      id: "evt-1",
      method: "POST",
      url: "https://app.example.com/v1/users",
      host: "app.example.com",
      path: "/v1/users",
      statusCode: null,
      state: "pending",
      request: { method: "POST", url: "https://app.example.com/v1/users", body: '{"a":1}' }
    });

    // Complete phase: the parser couldn't recover the method and
    // passes null. The COALESCE on the events table must keep POST.
    storage.saveEvent(session.id, {
      id: "evt-1",
      method: null,
      statusCode: 201,
      state: "success",
      response: { statusCode: 201, body: '{"id":1}' }
    });

    const events = storage.listEvents({ sessionId: session.id });
    assert.equal(events.length, 1, "must collapse to a single row, not duplicate");
    assert.equal(events[0].method, "POST", "prior POST must survive a null-method upsert");
    assert.equal(events[0].statusCode, 201, "statusCode from the complete phase must be applied");
    assert.equal(events[0].state, "success", "state from the complete phase must be applied");
    assert.equal(events[0].request.body, '{"a":1}', "request body from the request phase must survive");
    assert.equal(events[0].response.body, '{"id":1}', "response body from the complete phase must be applied");
  });
});

test("storage accepts an explicit method: null on the very first insert (column is null, not 'GET')", () => {
  // The parser passes null when it cannot determine the method. The
  // storage must store SQL NULL, not coerce to "GET". Otherwise an
  // INSERT-then-UPDATE sequence would flip a real prior POST to GET.
  withTempStorage((storage) => {
    const session = storage.createSession({ sourceKind: "test" });
    storage.saveEvent(session.id, {
      id: "evt-null-method",
      method: null,
      url: "https://example.com/x",
      host: "example.com",
      path: "/x",
      state: "pending"
    });
    const row = storage.db
      .prepare("SELECT method FROM events WHERE client_event_id = ?")
      .get("evt-null-method");
    assert.equal(row.method, null, "first insert with method:null must persist as SQL NULL, not 'GET'");
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

test("listSessions supports paging through session history", () => {
  withTempStorage((storage) => {
    storage.createSession({ label: "first", startedAt: "2026-01-01T00:00:00.000Z" });
    storage.createSession({ label: "second", startedAt: "2026-01-02T00:00:00.000Z" });
    storage.createSession({ label: "third", startedAt: "2026-01-03T00:00:00.000Z" });

    const page = storage.listSessions({ limit: 1, offset: 1 });
    assert.equal(page.length, 1);
    assert.equal(page[0].label, "second");
  });
});

test("pruneSessionsBefore removes old sessions and cascades to events", () => {
  withTempStorage((storage) => {
    const cutoff = "2026-06-24T12:00:00.000Z";
    const oldSession = storage.createSession({
      label: "old",
      startedAt: "2026-05-01T10:00:00.000Z"
    });
    const recentSession = storage.createSession({
      label: "recent",
      startedAt: "2026-06-24T13:00:00.000Z"
    });

    storage.saveEvent(oldSession.id, { id: "old-1", method: "GET", url: "/a" });
    storage.saveEvent(recentSession.id, { id: "recent-1", method: "GET", url: "/b" });

    const removed = storage.pruneSessionsBefore(cutoff);
    assert.equal(removed, 1);
    assert.equal(storage.getSession(oldSession.id), null);
    assert.equal(storage.listEvents({ sessionId: oldSession.id }).length, 0);
    assert.ok(storage.getSession(recentSession.id));
    assert.equal(storage.listEvents({ sessionId: recentSession.id }).length, 1);
  });
});

test("pruneSessionsBefore is idempotent", () => {
  withTempStorage((storage) => {
    storage.createSession({ label: "old", startedAt: "2026-05-01T10:00:00.000Z" });
    const cutoff = "2026-06-24T12:00:00.000Z";

    assert.equal(storage.pruneSessionsBefore(cutoff), 1);
    assert.equal(storage.pruneSessionsBefore(cutoff), 0);
  });
});

test("pruneSessionsBefore honors excludeSessionIds for live sessions", () => {
  withTempStorage((storage) => {
    const cutoff = "2026-06-24T12:00:00.000Z";
    const live = storage.createSession({
      label: "live-old",
      startedAt: "2026-04-01T10:00:00.000Z"
    });
    const stale = storage.createSession({
      label: "stale-old",
      startedAt: "2026-04-02T10:00:00.000Z"
    });
    const recent = storage.createSession({
      label: "recent",
      startedAt: "2026-06-24T13:00:00.000Z"
    });

    storage.saveEvent(live.id, { id: "live-1", method: "GET", url: "/a" });
    storage.saveEvent(stale.id, { id: "stale-1", method: "GET", url: "/b" });
    storage.saveEvent(recent.id, { id: "recent-1", method: "GET", url: "/c" });

    const removed = storage.pruneSessionsBefore(cutoff, { excludeSessionIds: [live.id] });
    assert.equal(removed, 1);
    assert.ok(storage.getSession(live.id), "excluded live session must survive");
    assert.equal(storage.listEvents({ sessionId: live.id }).length, 1);
    assert.equal(storage.getSession(stale.id), null, "non-excluded stale session must be pruned");
    assert.ok(storage.getSession(recent.id), "recent session must survive");
  });
});

test("databaseSizeBytes returns a positive number after writes", () => {
  withTempStorage((storage) => {
    const session = storage.createSession({ sourceKind: "test" });
    storage.saveEvent(session.id, { id: "1", method: "GET", url: "/a" });
    const bytes = storage.databaseSizeBytes();
    assert.ok(typeof bytes === "number");
    assert.ok(bytes > 0);
  });
});

test("saveEvent round-trips the optional meta blob", () => {
  withTempStorage((storage) => {
    const session = storage.createSession({ sourceKind: "test" });
    const meta = {
      source: "browser",
      captureMode: "merged",
      browserSession: { origin: "https://app.example.com", profileId: "p1", context: "regular" },
      tabId: 7,
      pageUrl: "https://app.example.com/dashboard",
      durationMs: 42
    };
    storage.saveEvent(session.id, {
      id: "1",
      method: "POST",
      url: "https://app.example.com/api",
      statusCode: 200,
      state: "success",
      meta
    });
    const fetched = storage.getEvent(session.id, "1");
    assert.deepEqual(fetched.meta, meta);
  });
});

test("normalizes malformed multiline capture fields before storage", () => {
  withTempStorage((storage) => {
    const session = storage.createSession({ sourceKind: "ios-simulator" });
    const suffix = "\\nMethod: GET\\nHeaders:\\n Authorization: Bearer storage-secret";
    storage.saveEvent(session.id, {
      id: "malformed-new",
      method: `GET${suffix}`,
      url: `https://api.example/v1/announcements/32${suffix}`,
      host: "api.example",
      path: `/v1/announcements/32${suffix}`,
      request: { method: `GET${suffix}`, url: `https://api.example/v1/announcements/32${suffix}` }
    });

    const event = storage.getEvent(session.id, "malformed-new");
    assert.equal(event.method, "GET");
    assert.equal(event.url, "https://api.example/v1/announcements/32");
    assert.equal(event.host, "api.example");
    assert.equal(event.path, "/v1/announcements/32");
    assert.equal(event.request.method, "GET");
    assert.equal(event.request.url, "https://api.example/v1/announcements/32");
  });
});

test("normalizes legacy malformed rows while hydrating without rewriting history", () => {
  withTempStorage((storage) => {
    const session = storage.createSession({ sourceKind: "ios-simulator" });
    storage.saveEvent(session.id, { id: "legacy", method: "GET", url: "https://api.example/original" });
    const suffix = "\\nHeaders:\\n Authorization: Bearer legacy-secret";
    storage.db.prepare(`
      UPDATE events
      SET method = ?, url = ?, host = ?, path = ?, request_json = ?
      WHERE session_id = ? AND client_event_id = ?
    `).run(
      `PUT${suffix}`,
      `${String.raw`https:\/\/api.example/v1/announcements/50`}${suffix}`,
      "api.example",
      `/v1/announcements/50/nHeaders:%20Authorization${suffix}`,
      JSON.stringify({ method: `PUT${suffix}`, url: `${String.raw`https:\/\/api.example/v1/announcements/50`}${suffix}` }),
      session.id,
      "legacy"
    );

    const event = storage.getEvent(session.id, "legacy");
    assert.equal(event.method, "PUT");
    assert.equal(event.url, "https://api.example/v1/announcements/50");
    assert.equal(event.host, "api.example");
    assert.equal(event.path, "/v1/announcements/50");
    assert.equal(event.request.method, "PUT");
    assert.ok(!JSON.stringify(event).includes("legacy-secret"));

    const stored = storage.db.prepare("SELECT method FROM events WHERE session_id = ? AND client_event_id = ?")
      .get(session.id, "legacy");
    assert.ok(stored.method.includes("legacy-secret"), "read normalization must not mutate captured history");
  });
});


test("late request phase preserves finished browser state and capture details", () => {
  withTempStorage((storage) => {
    const session = storage.createSession({ sourceKind: "browser-chromium" });
    storage.saveEvent(session.id, { id: "late", state: "error", statusCode: 503,
      response: { body: "unavailable" }, errors: ["HTTP 503"], raw: ["complete"], meta: { captureMode: "merged" } });
    storage.saveEvent(session.id, { id: "late", state: "pending", request: { method: "POST" },
      errors: [], raw: ["request"], meta: { captureMode: "page-script" } });
    const event = storage.listEvents({ sessionId: session.id })[0];
    assert.equal(event.state, "error");
    assert.equal(event.response.body, "unavailable");
    assert.deepEqual(event.errors, ["HTTP 503"]);
    assert.deepEqual(event.raw, ["complete"]);
    assert.equal(event.meta.captureMode, "merged");
  });
});
