"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");

const { withServer, postJson, postJsonAsObject } = require("./helpers/ingestFixture");

const VALID_WIRE = {
  v: 1,
  sourceKind: "browser-chromium",
  browserSession: {
    origin: "https://app.example.com",
    profileId: "bprof_8f3d1b6c9a2e4f10",
    context: "regular"
  },
  tabId: 1,
  captureMode: "merged",
  eventId: "11111111-1111-1111-1111-111111111111",
  phase: "complete",
  request: {
    startedAt: 0,
    method: "GET",
    url: "https://app.example.com/ping",
    headers: {},
    body: null,
    bodyAvailable: true,
    bodyTruncated: false,
    bodyUnavailableReason: null
  },
  response: {
    completedAt: 5,
    durationMs: 5,
    status: 200,
    headers: {},
    body: "pong",
    bodyAvailable: true,
    bodyTruncated: false,
    bodyUnavailableReason: null
  },
  metadata: { pageUrl: "https://app.example.com/", initiator: "https://app.example.com" },
  error: null
};

function postJsonExpecting(port, path, body) {
  return postJson(port, path, JSON.stringify(body));
}

test("valid wire event returns 200 and creates a browser session", async () => {
  await withServer({ browser: { enabled: true, targetUrls: ["https://app.example.com/*"], requestUrls: [] } }, async ({ port, store }) => {
    const result = await postJsonExpecting(port, "/api/browser-event", VALID_WIRE);
    assert.equal(result.status, 200);
    assert.equal(result.body.ok, true);
    assert.equal(result.body.eventId, VALID_WIRE.eventId);
    assert.ok(result.body.sessionKey.startsWith("browser::"));
    const live = store.currentSessions().filter((s) => s.sourceKey === "browser");
    assert.equal(live.length, 1);
    const events = store.eventsForSession(live[0].id, { limit: 50 });
    assert.equal(events.length, 1);
    assert.equal(events[0].id, VALID_WIRE.eventId);
    assert.equal(events[0].statusCode, 200);
    assert.equal(events[0].state, "success");
    assert.equal(events[0].response.body, "pong");
  });
});

test("two-phase event lands in one row (upsert by eventId)", async () => {
  await withServer({ browser: { enabled: true, targetUrls: [], requestUrls: [] } }, async ({ port, store }) => {
    const request = { ...VALID_WIRE, phase: "request", response: null };
    const complete = { ...VALID_WIRE, phase: "complete" };
    const r1 = await postJsonExpecting(port, "/api/browser-event", request);
    const r2 = await postJsonExpecting(port, "/api/browser-event", complete);
    assert.equal(r1.status, 200);
    assert.equal(r2.status, 200);
    const live = store.currentSessions().filter((s) => s.sourceKey === "browser");
    assert.equal(live.length, 1);
    const events = store.eventsForSession(live[0].id, { limit: 50 });
    assert.equal(events.length, 1, "two phases must upsert into the same row");
    assert.equal(events[0].id, VALID_WIRE.eventId);
    assert.equal(events[0].state, "success");
  });
});

test("payloads larger than 2MB are rejected with 413 (not 500)", async () => {
  await withServer({ browser: { enabled: true, targetUrls: [], requestUrls: [] } }, async ({ port }) => {
    const big = "x".repeat(2 * 1024 * 1024 + 1);
    const raw = JSON.stringify({
      ...VALID_WIRE,
      response: { ...VALID_WIRE.response, body: big }
    });
    const result = await postJson(port, "/api/browser-event", raw);
    assert.equal(result.status, 413);
    assert.equal(result.body.error, "payload_too_large");
  });
});

test("response.body over 1MB is rejected with 413 (per-field cap)", async () => {
  await withServer({ browser: { enabled: true, targetUrls: [], requestUrls: [] } }, async ({ port, store }) => {
    const big = "x".repeat(1 * 1024 * 1024 + 1);
    const wire = {
      ...VALID_WIRE,
      response: { ...VALID_WIRE.response, body: big, bodyTruncated: false }
    };
    const result = await postJsonExpecting(port, "/api/browser-event", wire);
    assert.equal(result.status, 413, "oversize response.body must be rejected");
    assert.equal(result.body.error, "body_field_too_large");
    assert.match(result.body.message, /response\.body/);

    // Nothing should have been persisted.
    const live = store.currentSessions().filter((s) => s.sourceKey === "browser");
    assert.equal(live.length, 0, "rejected events must not create a browser session");
  });
});

test("request.body over 1MB is rejected with 413 (per-field cap)", async () => {
  await withServer({ browser: { enabled: true, targetUrls: [], requestUrls: [] } }, async ({ port, store }) => {
    const big = "y".repeat(1 * 1024 * 1024 + 1);
    const wire = {
      ...VALID_WIRE,
      request: { ...VALID_WIRE.request, body: big, bodyTruncated: false }
    };
    const result = await postJsonExpecting(port, "/api/browser-event", wire);
    assert.equal(result.status, 413, "oversize request.body must be rejected");
    assert.equal(result.body.error, "body_field_too_large");
    assert.match(result.body.message, /request\.body/);

    const live = store.currentSessions().filter((s) => s.sourceKey === "browser");
    assert.equal(live.length, 0, "rejected events must not create a browser session");
  });
});

test("body exactly 1MB is accepted (per-field cap is strict-less-than-or-equal)", async () => {
  await withServer({ browser: { enabled: true, targetUrls: [], requestUrls: [] } }, async ({ port, store }) => {
    const big = "z".repeat(1 * 1024 * 1024);
    const wire = {
      ...VALID_WIRE,
      response: { ...VALID_WIRE.response, body: big, bodyTruncated: true }
    };
    const result = await postJsonExpecting(port, "/api/browser-event", wire);
    assert.equal(result.status, 200, "1 MB exactly must be accepted");
    const live = store.currentSessions().filter((s) => s.sourceKey === "browser");
    assert.equal(live.length, 1);
    const events = store.eventsForSession(live[0].id, { limit: 50 });
    assert.equal(events.length, 1);
    assert.equal(events[0].response.body.length, 1 * 1024 * 1024);
  });
});

test("disabled browser capture returns a clear 403 response, not a silent drop", async () => {
  await withServer({ browser: { enabled: false, targetUrls: [], requestUrls: [] } }, async ({ port }) => {
    const result = await postJsonExpecting(port, "/api/browser-event", VALID_WIRE);
    assert.equal(result.status, 403);
    assert.equal(result.body.error, "browser_capture_disabled");
    assert.match(result.body.message, /browser\.enabled=true/);
  });
});

test("OPTIONS preflight returns 204 with permissive CORS headers", async () => {
  await withServer({ browser: { enabled: true, targetUrls: [], requestUrls: [] } }, async ({ port }) => {
    const result = await new Promise((resolve, reject) => {
      const req = http.request({ host: "127.0.0.1", port, path: "/api/browser-event", method: "OPTIONS" }, (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString("utf8") }));
      });
      req.on("error", reject);
      req.end();
    });
    assert.equal(result.status, 204);
    assert.equal(result.headers["access-control-allow-methods"], "POST, OPTIONS");
    assert.equal(result.headers["access-control-allow-headers"], "Content-Type");
  });
});

test("invalid schema version returns 400", async () => {
  await withServer({ browser: { enabled: true, targetUrls: [], requestUrls: [] } }, async ({ port }) => {
    const result = await postJsonExpecting(port, "/api/browser-event", { ...VALID_WIRE, v: 2 });
    assert.equal(result.status, 400);
    assert.equal(result.body.error, "ingest_failed");
    assert.match(result.body.message, /schema version/);
  });
});

test("invalid JSON body returns 400", async () => {
  await withServer({ browser: { enabled: true, targetUrls: [], requestUrls: [] } }, async ({ port }) => {
    const result = await postJson(port, "/api/browser-event", "{ not json");
    assert.equal(result.status, 400);
    assert.equal(result.body.error, "invalid_json");
  });
});

test("clear marker only clears the targeted session", async () => {
  await withServer({ browser: { enabled: true, targetUrls: [], requestUrls: [] } }, async ({ port, store }) => {
    const a = VALID_WIRE;
    const b = {
      ...VALID_WIRE,
      eventId: "22222222-2222-2222-2222-222222222222",
      browserSession: { origin: "https://other.example.com", profileId: "bprof_x", context: "regular" }
    };
    const ra = await postJsonExpecting(port, "/api/browser-event", a);
    const rb = await postJsonExpecting(port, "/api/browser-event", b);
    assert.equal(ra.status, 200);
    assert.equal(rb.status, 200);

    let live = store.currentSessions().filter((s) => s.sourceKey === "browser");
    assert.equal(live.length, 2);

    const clearResult = await postJsonExpecting(port, "/api/browser-event", { clear: true, browserSession: a.browserSession });
    assert.equal(clearResult.status, 200);
    assert.equal(clearResult.body.ok, true);
    assert.equal(clearResult.body.cleared, true);

    live = store.currentSessions().filter((s) => s.sourceKey === "browser");
    assert.equal(live.length, 2, "sibling session must remain after clear");

    const aSessionKey = `browser::${a.browserSession.origin}::${a.browserSession.profileId}::${a.browserSession.context}`;
    const bSessionKey = `browser::${b.browserSession.origin}::${b.browserSession.profileId}::${b.browserSession.context}`;
    const aSession = store.currentSessionByKey(aSessionKey);
    const bSession = store.currentSessionByKey(bSessionKey);
    assert.equal(store.eventsForSession(aSession.id, { limit: 50 }).length, 0, "cleared session must be empty");
    assert.equal(store.eventsForSession(bSession.id, { limit: 50 }).length, 1, "sibling session must keep its event");
  });
});

test("GET /api/sources lists a browser source when enabled", async () => {
  await withServer({ browser: { enabled: true, targetUrls: ["https://app.example.com/*"], requestUrls: [] } }, async ({ port }) => {
    const result = await new Promise((resolve, reject) => {
      const req = http.request({ host: "127.0.0.1", port, path: "/api/sources", method: "GET" }, (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          resolve({ status: res.statusCode, body: JSON.parse(raw) });
        });
      });
      req.on("error", reject);
      req.end();
    });
    assert.equal(result.status, 200);
    const browser = result.body.selectable.find((s) => s.sourceKey === "browser");
    assert.ok(browser, "browser source must be in selectable list");
    assert.equal(browser.kind, "browser");
  });
});

test("GET /api/sources omits browser when disabled", async () => {
  await withServer({ browser: { enabled: false, targetUrls: [], requestUrls: [] } }, async ({ port }) => {
    const result = await new Promise((resolve, reject) => {
      const req = http.request({ host: "127.0.0.1", port, path: "/api/sources", method: "GET" }, (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          resolve({ status: res.statusCode, body: JSON.parse(raw) });
        });
      });
      req.on("error", reject);
      req.end();
    });
    assert.equal(result.status, 200);
    const browser = result.body.selectable.find((s) => s.sourceKey === "browser");
    assert.equal(browser, undefined, "browser must not appear in selectable list when disabled");
  });
});

test("POST /api/browser-setup/enable turns on Browser source before extension traffic", async () => {
  await withServer({ browser: { enabled: false, targetUrls: [], requestUrls: [] } }, async ({ port, store, sourceManager }) => {
    const enable = await postJsonAsObject(port, "/api/browser-setup/enable", {});
    assert.equal(enable.status, 200);
    assert.equal(enable.body.ok, true);
    assert.equal(enable.body.config.browser.enabled, true);
    assert.equal(sourceManager.config.browser.enabled, true);
    assert.ok(
      enable.body.sources.selectable.find((entry) => entry.sourceKey === "browser"),
      "Browser source must be selectable immediately after setup enable"
    );

    const ingest = await postJsonExpecting(port, "/api/browser-event", VALID_WIRE);
    assert.equal(ingest.status, 200, "extension events must not be rejected after the simple setup flow enables Browser");
    assert.equal(store.currentSessions().filter((s) => s.sourceKey === "browser").length, 1);
  });
});

test("two browser sessions with different origin/profile/context stay separate end-to-end", async () => {
  await withServer({ browser: { enabled: true, targetUrls: [], requestUrls: [] } }, async ({ port, store }) => {
    const regular = VALID_WIRE;
    const incognito = {
      ...VALID_WIRE,
      eventId: "evt-incognito",
      browserSession: { origin: "https://app.example.com", profileId: "bprof_8f3d1b6c9a2e4f10", context: "incognito" }
    };
    const otherOrigin = {
      ...VALID_WIRE,
      eventId: "evt-other",
      browserSession: { origin: "https://other.example.com", profileId: "bprof_x", context: "regular" }
    };
    await postJsonExpecting(port, "/api/browser-event", regular);
    await postJsonExpecting(port, "/api/browser-event", incognito);
    await postJsonExpecting(port, "/api/browser-event", otherOrigin);

    const live = store.currentSessions().filter((s) => s.sourceKey === "browser");
    assert.equal(live.length, 3, "expected three live browser sessions under one sourceKey");

    const sessionEvents = live
      .map((s) => store.eventsForSession(s.id, { limit: 50 }).map((e) => e.id))
      .sort((a, b) => a.join(",").localeCompare(b.join(",")));
    assert.deepEqual(sessionEvents, [
      [VALID_WIRE.eventId],
      ["evt-incognito"],
      ["evt-other"]
    ]);
  });
});

test("POST /api/source { kind: 'browser' } selects the umbrella before any traffic and ingests a subsequent event", async () => {
  await withServer({ browser: { enabled: true, targetUrls: ["https://app.example.com/*"], requestUrls: [] } }, async ({ port, store, sourceManager }) => {
    const selectResult = await postJsonAsObject(port, "/api/source", { kind: "browser" });
    assert.equal(selectResult.status, 200);
    assert.equal(selectResult.body.ok, true);
    assert.equal(selectResult.body.selectedSourceKey, "browser");
    assert.equal(sourceManager.selectedSourceKey, "browser");
    assert.equal(store.selectedSourceKey, "browser");
    assert.ok(store.sources.has("browser"), "umbrella source must be registered on selection");

    // Now ingest a wire event and verify the selected umbrella snapshots it.
    const ingest = await postJsonExpecting(port, "/api/browser-event", VALID_WIRE);
    assert.equal(ingest.status, 200);
    const live = store.currentSessions().filter((s) => s.sourceKey === "browser");
    assert.equal(live.length, 1);
    const snap = store.snapshot("browser");
    assert.equal(snap.length, 1);
    assert.equal(snap[0].id, VALID_WIRE.eventId);
  });
});

test("POST /api/source { kind: 'browser' } works after first ingest and keeps the live session", async () => {
  await withServer({ browser: { enabled: true, targetUrls: ["https://app.example.com/*"], requestUrls: [] } }, async ({ port, store, sourceManager }) => {
    const first = await postJsonExpecting(port, "/api/browser-event", VALID_WIRE);
    assert.equal(first.status, 200);
    const liveBefore = store.currentSession("browser");
    assert.ok(liveBefore, "expected a live browser session after first ingest");

    const selectResult = await postJsonAsObject(port, "/api/source", { kind: "browser" });
    assert.equal(selectResult.status, 200);
    assert.equal(selectResult.body.selectedSourceKey, "browser");
    assert.equal(sourceManager.selectedSourceKey, "browser");

    const liveAfter = store.currentSession("browser");
    assert.ok(liveAfter, "currentSession('browser') must still surface the live session after selection");
    assert.equal(liveAfter.id, liveBefore.id, "selection must not rotate the existing live session");

    const snap = store.snapshot("browser");
    assert.equal(snap.length, 1);
    assert.equal(snap[0].id, VALID_WIRE.eventId);
  });
});

test("POST /api/source { kind: 'browser' } is rejected with a clear error when browser is disabled", async () => {
  await withServer({ browser: { enabled: false, targetUrls: [], requestUrls: [] } }, async ({ port }) => {
    const result = await postJsonAsObject(port, "/api/source", { kind: "browser" });
    assert.equal(result.status, 400, "selecting a disabled source must fail with a clear error");
    assert.match(result.body.error, /not available/);
  });
});
