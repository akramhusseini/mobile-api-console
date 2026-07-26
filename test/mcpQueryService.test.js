"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { SqliteStorage } = require("../src/storage/sqliteStorage");
const { ApiConsoleQueryService, dayRange } = require("../src/mcp/queryService");

function withFixture(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mobile-api-console-mcp-test-"));
  const databasePath = path.join(dir, "data.db");
  const storage = new SqliteStorage({ databasePath }).init();
  const browser = storage.createSession({
    label: "https://school.example (regular)",
    sourceKind: "browser-chromium",
    sourceMetadata: {
      sourceKey: "browser",
      browserSession: { origin: "https://school.example", profileId: "browser-profile", context: "regular" }
    },
    startedAt: "2026-07-14T08:00:00.000Z"
  });
  const ios = storage.createSession({
    sourceKind: "ios-simulator",
    sourceMetadata: { sourceKey: "ios", udid: "SIM-123", simulator: "iPhone 17" },
    startedAt: "2026-07-14T09:00:00.000Z"
  });
  storage.saveEvent(browser.id, {
    id: "browser-call",
    method: "POST",
    url: "https://api.example/v1/announcements",
    host: "api.example",
    path: "/v1/announcements",
    statusCode: 201,
    state: "success",
    startedAt: "2026-07-14T08:30:00.000Z",
    finishedAt: "2026-07-14T08:30:00.250Z",
    request: {
      headers: { Authorization: "Bearer secret-token", Accept: "application/json" },
      body: JSON.stringify({ title: "Hello", password: "do-not-return" })
    },
    response: { statusCode: 201, headers: { "Set-Cookie": "session=secret" }, body: JSON.stringify({ id: 60 }) },
    errors: []
  });
  storage.saveEvent(browser.id, {
    id: "heartbeat",
    method: "POST",
    url: "https://api.example/api/v1/online/heartbeat",
    host: "api.example",
    path: "/api/v1/online/heartbeat",
    statusCode: 204,
    state: "success",
    startedAt: "2026-07-14T08:31:00.000Z",
    response: { statusCode: 204, body: "" }
  });
  storage.saveEvent(ios.id, {
    id: "ios-call",
    method: "GET",
    url: "https://api.example/v1/courses",
    host: "api.example",
    path: "/v1/courses",
    statusCode: 500,
    state: "error",
    startedAt: "2026-07-14T09:30:00.000Z",
    errors: ["Server error"]
  });
  storage.close();

  const service = new ApiConsoleQueryService({ databasePath });
  try { return fn({ service, databasePath }); }
  finally {
    service.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("calendar-day ranges honor the requested timezone", () => {
  assert.deepEqual(dayRange("2026-07-14", "Asia/Amman"), {
    from: "2026-07-13T21:00:00.000Z",
    to: "2026-07-14T21:00:00.000Z",
    timeZone: "Asia/Amman",
    day: "2026-07-14"
  });
});

test("search filters by platform and hides heartbeat calls by default", () => {
  withFixture(({ service }) => {
    const result = service.searchEvents({ day: "2026-07-14", timeZone: "Asia/Amman", platform: "browser" });
    assert.equal(result.items.length, 1);
    assert.equal(result.items[0].eventId, "browser-call");
    assert.equal(result.items[0].browser.profileId, "browser-profile");

    const withHeartbeats = service.searchEvents({ platform: "browser", includeHeartbeats: true });
    assert.equal(withHeartbeats.items.length, 2);
  });
});

test("event details are opt-in and secrets are always redacted", () => {
  withFixture(({ service }) => {
    const compact = service.getEvent({ eventId: "browser-call" });
    assert.equal(compact.request.headers, undefined);
    assert.equal(compact.request.body, undefined);

    const full = service.getEvent({
      eventId: "browser-call",
      include: { requestHeaders: true, requestBody: true, responseHeaders: true, responseBody: true }
    });
    assert.equal(full.request.headers.Authorization, "[REDACTED]");
    assert.equal(full.request.headers.Accept, "application/json");
    assert.equal(full.request.body.value.password, "[REDACTED]");
    assert.equal(full.response.headers["Set-Cookie"], "[REDACTED]");
    assert.deepEqual(full.response.body.value, { id: 60 });
  });
});

test("compact metadata redacts sensitive URL parameters", () => {
  withFixture(({ service }) => {
    service.close();
    const storage = new SqliteStorage({ databasePath: service.databasePath }).init();
    const session = storage.listSessions({ limit: 1 })[0];
    storage.saveEvent(session.id, {
      id: "secret-query",
      method: "GET",
      url: "https://api.example/v1/profile?access_token=secret-value&locale=ar",
      path: "/v1/profile?access_token=secret-value&locale=ar",
      statusCode: 200,
      state: "success",
      startedAt: "2026-07-14T10:00:00.000Z"
    });
    storage.close();
    service.db = new (require("better-sqlite3"))(service.databasePath, { readonly: true, fileMustExist: true });
    service.db.pragma("query_only = ON");

    const result = service.searchEvents({ pathContains: "/v1/profile" });
    assert.ok(result.items[0].url.includes("access_token=%5BREDACTED%5D"));
    assert.ok(!result.items[0].url.includes("secret-value"));
  });
});

test("catalog and summaries expose compact discovery data", () => {
  withFixture(({ service }) => {
    const catalog = service.catalog({ includeHeartbeats: false });
    assert.equal(catalog.counts.eventCount, 2);
    assert.ok(catalog.platforms.some((item) => item.platform === "browser"));
    assert.ok(catalog.devices.some((item) => item.device.includes("SIM-123")));

    const summary = service.summarizeEvents({ groupBy: "platform" });
    assert.deepEqual(summary.items.map((item) => item.group).sort(), ["browser", "ios"]);
  });
});

test("legacy multiline methods are normalized for discovery and filtering", () => {
  withFixture(({ service, databasePath }) => {
    service.close();
    const storage = new SqliteStorage({ databasePath }).init();
    const session = storage.listSessions({ limit: 1 })[0];
    storage.saveEvent(session.id, {
      id: "malformed-method",
      method: "PUT\\nHeaders:\\n  Authorization: Bearer 2077|catalog-Secret\\nBody:\\n{\"title\":\"Updated\"}",
      url: "https://api.example/v1/announcements/60",
      host: "api.example",
      path: "/v1/announcements/60",
      statusCode: 200,
      state: "success",
      startedAt: "2026-07-14T10:30:00.000Z"
    });
    storage.close();
    service.db = new (require("better-sqlite3"))(databasePath, { readonly: true, fileMustExist: true });
    service.db.pragma("query_only = ON");

    const catalog = service.catalog();
    assert.ok(catalog.methods.some((item) => item.method === "PUT"));
    assert.ok(!JSON.stringify(catalog).toLowerCase().includes("catalog-secret"));
    assert.ok(catalog.methods.every((item) => item.method.length <= 10));

    const search = service.searchEvents({ methods: ["PUT"] });
    assert.equal(search.items[0].method, "PUT");

    const summary = service.summarizeEvents({ groupBy: "method" });
    assert.ok(summary.items.some((item) => item.group === "PUT"));
    assert.ok(!JSON.stringify(summary).toLowerCase().includes("catalog-secret"));
  });
});
