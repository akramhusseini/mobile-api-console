"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { BrowserEventParser } = require("../src/parsers/browserEventParser");

function baseWireEvent(overrides = {}) {
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
    metadata: {
      pageUrl: "https://app.example.com/dashboard",
      initiator: "https://app.example.com"
    },
    error: null,
    ...overrides
  };
}

test("normalizes a complete-phase merged event into the standard event shape", () => {
  const parser = new BrowserEventParser();
  const wire = baseWireEvent();
  const event = parser.normalizeEvent(wire);

  assert.equal(event.id, wire.eventId);
  assert.equal(event.method, "GET");
  assert.equal(event.url, "https://app.example.com/v1/users");
  assert.equal(event.host, "app.example.com");
  assert.equal(event.path, "/v1/users");
  assert.equal(event.statusCode, 200);
  assert.equal(event.state, "success");
  assert.equal(event.response.statusCode, 200);
  assert.equal(event.response.body, '{"data":[]}');
  assert.deepEqual(event.request.headers, { Accept: "application/json" });
  assert.equal(event.meta.captureMode, "merged");
  assert.equal(event.meta.sourceKind, "browser-chromium");
  assert.equal(event.meta.tabId, 17);
  assert.equal(event.meta.pageUrl, "https://app.example.com/dashboard");
  assert.equal(event.meta.browserSession.origin, "https://app.example.com");
});

test("two-phase request/complete upserts share the same event id", () => {
  const parser = new BrowserEventParser();
  const request = parser.normalizeEvent(baseWireEvent({
    phase: "request",
    response: null,
    error: null
  }));
  const complete = parser.normalizeEvent(baseWireEvent({ phase: "complete" }));

  assert.equal(request.id, complete.id, "client_event_id must be the same for both phases");
  assert.equal(request.state, "pending");
  assert.equal(complete.state, "success");
  assert.equal(complete.statusCode, 200);
});

test("session key is origin+profileId+context, not tabId or captureMode", () => {
  const parser = new BrowserEventParser();
  const wireA = baseWireEvent({ tabId: 1, captureMode: "page-script" });
  const wireB = baseWireEvent({ tabId: 99, captureMode: "web-request" });
  assert.equal(parser.sessionKeyFor(wireA), parser.sessionKeyFor(wireB));
});

test("different profileId or context produces different session keys", () => {
  const parser = new BrowserEventParser();
  const regular = parser.sessionKeyFor(baseWireEvent());
  const incognito = parser.sessionKeyFor(baseWireEvent({
    browserSession: {
      origin: "https://app.example.com",
      profileId: "bprof_8f3d1b6c9a2e4f10",
      context: "incognito"
    }
  }));
  const otherProfile = parser.sessionKeyFor(baseWireEvent({
    browserSession: {
      origin: "https://app.example.com",
      profileId: "bprof_different",
      context: "regular"
    }
  }));
  const otherOrigin = parser.sessionKeyFor(baseWireEvent({
    browserSession: {
      origin: "https://other.example.com",
      profileId: "bprof_8f3d1b6c9a2e4f10",
      context: "regular"
    }
  }));

  assert.notEqual(regular, incognito);
  assert.notEqual(regular, otherProfile);
  assert.notEqual(regular, otherOrigin);
  assert.notEqual(incognito, otherOrigin);
});

test("4xx response is reported as an error event with HTTP error", () => {
  const parser = new BrowserEventParser();
  const event = parser.normalizeEvent(baseWireEvent({
    response: {
      completedAt: 1751280000042,
      durationMs: 42,
      status: 422,
      headers: { "Content-Type": "application/json" },
      body: '{"message":"Invalid"}',
      bodyAvailable: true,
      bodyTruncated: false,
      bodyUnavailableReason: null
    }
  }));
  assert.equal(event.state, "error");
  assert.equal(event.statusCode, 422);
  assert.deepEqual(event.errors, ["HTTP 422"]);
});

test("network error is reported when error field is set and response is null", () => {
  const parser = new BrowserEventParser();
  const event = parser.normalizeEvent(baseWireEvent({
    phase: "complete",
    response: null,
    error: "Failed to fetch"
  }));
  assert.equal(event.state, "error");
  assert.equal(event.statusCode, null);
  assert.deepEqual(event.errors, ["Failed to fetch"]);
});

test("bodyUnavailableReason is preserved for unavailable response body", () => {
  const parser = new BrowserEventParser();
  const event = parser.normalizeEvent(baseWireEvent({
    response: {
      completedAt: 1751280000042,
      durationMs: 42,
      status: 200,
      headers: {},
      body: null,
      bodyAvailable: false,
      bodyTruncated: false,
      bodyUnavailableReason: "csp-blocked"
    }
  }));
  assert.equal(event.response.body, null);
  assert.equal(event.response.bodyAvailable, false);
  assert.equal(event.response.bodyUnavailableReason, "csp-blocked");
});

test("bodyTruncated flag is preserved when extension truncated the body", () => {
  const parser = new BrowserEventParser();
  const event = parser.normalizeEvent(baseWireEvent({
    response: {
      completedAt: 1751280000042,
      durationMs: 42,
      status: 200,
      headers: {},
      body: "x".repeat(1500),
      bodyAvailable: true,
      bodyTruncated: true,
      bodyUnavailableReason: null
    }
  }));
  assert.equal(event.response.bodyTruncated, true);
  assert.equal(event.response.body.length, 1500);
});

test("rejects events whose schema version is not 1", () => {
  const parser = new BrowserEventParser();
  assert.throws(
    () => parser.normalizeEvent(baseWireEvent({ v: 2 })),
    /Unsupported schema version/
  );
});

test("rejects events with missing browserSession fields", () => {
  const parser = new BrowserEventParser();
  assert.throws(
    () => parser.normalizeEvent(baseWireEvent({ browserSession: { origin: "x", profileId: "y" } })),
    /context are required/
  );
  assert.throws(
    () => parser.normalizeEvent(baseWireEvent({ browserSession: { origin: "x", context: "regular" } })),
    /profileId/
  );
});

test("rejects events with unknown captureMode", () => {
  const parser = new BrowserEventParser();
  assert.throws(
    () => parser.normalizeEvent(baseWireEvent({ captureMode: "satellite" })),
    /Invalid captureMode/
  );
});

test("rejects events with unknown context", () => {
  const parser = new BrowserEventParser();
  assert.throws(
    () => parser.normalizeEvent(baseWireEvent({
      browserSession: { origin: "https://x", profileId: "p", context: "weird" }
    })),
    /Invalid browserSession.context/
  );
});

test("rejects events with unknown sourceKind", () => {
  const parser = new BrowserEventParser();
  assert.throws(
    () => parser.normalizeEvent(baseWireEvent({ sourceKind: "browser-lynx" })),
    /Unknown sourceKind/
  );
});

test("sourceMetadataFor embeds the right browser session and source kind", () => {
  const parser = new BrowserEventParser();
  const wire = baseWireEvent();
  const meta = parser.sourceMetadataFor(wire);
  assert.equal(meta.sourceKey, "browser");
  assert.equal(meta.sourceKind, "browser-chromium");
  assert.deepEqual(meta.browserSession, wire.browserSession);
});

// Regression: a complete-phase wire event with request:null must not
// default the top-level method to "GET". The capture-helper now
// preserves the request identity across phases by looking up the
// request phase via eventId, so a complete-phase wire event normally
// carries request: { method, url } (or merges with the prior). But
// even when the wire event is reduced to request:null (e.g. an error
// from a network failure), the parser must NOT invent "GET" — that
// would let a storage COALESCE happily overwrite a real POST.
//
// Two checks:
//   1. When request is null on the wire, event.method is null (not
//      "GET") so the COALESCE preserves any prior upsert.
//   2. The same rule applies to request.normalized.method so the
//      persisted request JSON doesn't say "GET" for a network error
//      whose method we never learned.
test("parser does not default missing request.method to GET (null passes through to storage)", () => {
  const parser = new BrowserEventParser();
  const wire = baseWireEvent({
    request: null,
    response: null,
    error: "Failed to fetch"
  });
  const event = parser.normalizeEvent(wire);
  assert.equal(event.method, null, "top-level method must be null, not a synthetic 'GET'");
  assert.equal(event.request, null, "request field stays null when wire event has no request");
  assert.equal(event.state, "error");
});

test("parser request.normalized.method stays null when the wire request omits the method", () => {
  const parser = new BrowserEventParser();
  // Wire event where the request is present but carries no method
  // (e.g. a malformed page-script observation). The parser must not
  // invent one.
  const wire = baseWireEvent({
    request: {
      startedAt: 1751280000000,
      url: "https://app.example.com/v1/x",
      headers: {},
      body: null,
      bodyAvailable: false,
      bodyTruncated: false,
      bodyUnavailableReason: "not-readable"
    }
  });
  delete wire.request.method;
  const event = parser.normalizeEvent(wire);
  assert.equal(event.method, null, "missing request.method must not default to GET");
  assert.equal(event.request.method, null, "request.normalized.method must also stay null");
});

test("parser keeps the real method when request is present, even if response carries no method", () => {
  const parser = new BrowserEventParser();
  // The normal case after the fix: wire event has request.method=POST
  // and response (no method on response). The top-level method must
  // be POST, never "GET" (the historical bug).
  const wire = baseWireEvent({
    request: {
      startedAt: 1751280000000,
      method: "POST",
      url: "https://app.example.com/v1/users",
      headers: { "Content-Type": "application/json" },
      body: '{"x":1}', bodyAvailable: true, bodyTruncated: false, bodyUnavailableReason: null
    }
  });
  const event = parser.normalizeEvent(wire);
  assert.equal(event.method, "POST");
  assert.equal(event.request.method, "POST");
});

// --- Synthesized cURL for browser events ---

const { buildCurl } = require("../src/parsers/browserEventParser");

test("cURL: GET synthesizes without -X and without a body", () => {
  const event = new BrowserEventParser().normalizeEvent(baseWireEvent());
  assert.match(event.curl, /^curl 'https:\/\/app\.example\.com\/v1\/users'/);
  assert.ok(!event.curl.includes("-X"), "GET should omit -X");
  assert.ok(event.curl.includes("-H 'Accept: application/json'"));
  assert.ok(!event.curl.includes("--data-raw"));
});

test("cURL: POST keeps auth/content-type, drops noisy headers, includes body", () => {
  const event = new BrowserEventParser().normalizeEvent(baseWireEvent({
    request: {
      startedAt: 1, method: "POST", url: "https://api.example.com/v1/users",
      headers: {
        "Content-Type": "application/json",
        "Authorization": "Bearer tok123",
        "Host": "api.example.com",
        "Content-Length": "13",
        "sec-ch-ua": "\"Chromium\"",
        "sec-fetch-mode": "cors",
        "Accept-Encoding": "gzip"
      },
      body: '{"name":"x"}',
      bodyAvailable: true, bodyTruncated: false, bodyUnavailableReason: null
    },
    response: null
  }));
  assert.ok(event.curl.includes("-X POST"));
  assert.ok(event.curl.includes("-H 'Content-Type: application/json'"));
  assert.ok(event.curl.includes("-H 'Authorization: Bearer tok123'"), "auth must be kept for replay");
  assert.ok(event.curl.includes("--data-raw '{\"name\":\"x\"}'"));
  for (const noisy of ["Host:", "Content-Length:", "sec-ch-ua", "sec-fetch-mode", "Accept-Encoding"]) {
    assert.ok(!event.curl.includes(noisy), "should drop noisy header: " + noisy);
  }
});

test("cURL: shell-safe — single quotes in header values and body are escaped", () => {
  const event = new BrowserEventParser().normalizeEvent(baseWireEvent({
    request: {
      startedAt: 1, method: "POST", url: "https://api.example.com/x",
      headers: { "X-Note": "it's fine" },
      body: "{\"q\":\"O'Brien\"}",
      bodyAvailable: true, bodyTruncated: false, bodyUnavailableReason: null
    },
    response: null
  }));
  assert.ok(event.curl.includes("'\\''"), "embedded single quotes must be escaped");
  assert.ok(event.curl.includes("X-Note: it'\\''s fine"));
});

test("cURL: no request side (error/complete-only) yields empty string (COALESCE preserves prior phase)", () => {
  const event = new BrowserEventParser().normalizeEvent(baseWireEvent({
    request: null, response: null, error: "Failed to fetch"
  }));
  assert.equal(event.curl, "");
});

test("buildCurl returns empty string without a url", () => {
  assert.equal(buildCurl({ method: "GET" }), "");
  assert.equal(buildCurl({}), "");
});
