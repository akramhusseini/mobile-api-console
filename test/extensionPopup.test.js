"use strict";

// Tests for the one-click "Capture this site" popup logic. Only the pure,
// deterministic helpers live in options-helper.js; the popup wiring (chrome.*
// calls) is thin glue exercised manually. These tests lock the two things
// that actually prevent the .co/.com class of bug: deriving the capture
// pattern from the real tab URL, and merging it into the config without
// clobbering existing settings.

const { test } = require("node:test");
const assert = require("node:assert/strict");

const helper = require("../extension/options-helper.js");

test("originPatternForUrl derives host pattern from a real tab URL", () => {
  assert.equal(
    helper.originPatternForUrl("https://nexa-lms-frontend-dev.joacademy.com/login?x=1"),
    "https://nexa-lms-frontend-dev.joacademy.com/*"
  );
});

test("originPatternForUrl keeps scheme and port", () => {
  assert.equal(helper.originPatternForUrl("http://localhost:3000/app"), "http://localhost:3000/*");
});

test("originPatternForUrl rejects non-capturable pages", () => {
  for (const url of ["chrome://extensions", "brave://settings", "about:blank", "chrome-extension://abc/options.html", "", null, undefined]) {
    assert.equal(helper.originPatternForUrl(url), null, `should reject: ${url}`);
  }
});

test("addTargetPattern adds the pattern and preserves other settings", () => {
  const next = helper.addTargetPattern(
    { consoleHost: "http://localhost:3957", targetUrls: ["https://a.example/*"], requestUrls: ["https://api.example/*"] },
    "https://b.example/*"
  );
  assert.deepEqual(next.targetUrls, ["https://a.example/*", "https://b.example/*"]);
  assert.equal(next.consoleHost, "http://localhost:3957");
  assert.deepEqual(next.requestUrls, ["https://api.example/*"]);
});

test("addTargetPattern dedupes and defaults safely from an empty config", () => {
  const once = helper.addTargetPattern({}, "https://b.example/*");
  assert.deepEqual(once.targetUrls, ["https://b.example/*"]);
  assert.equal(once.consoleHost, "http://localhost:3957");
  assert.deepEqual(once.requestUrls, []);

  const twice = helper.addTargetPattern(once, "https://b.example/*");
  assert.deepEqual(twice.targetUrls, ["https://b.example/*"], "must not add a duplicate");
});

// --- Auto-suggest observed API hosts (one-click header capture) ---

test("crossOriginApiHost detects a cross-origin API host", () => {
  assert.equal(
    helper.crossOriginApiHost("https://app.example.com", "https://api.example.com/v1/users"),
    "https://api.example.com"
  );
});

test("crossOriginApiHost returns null for same-origin or relative calls", () => {
  assert.equal(helper.crossOriginApiHost("https://app.example.com", "https://app.example.com/api/x"), null);
  assert.equal(helper.crossOriginApiHost("https://app.example.com", "/relative/path"), null);
});

test("requestPatternForHost preserves scheme when building match patterns", () => {
  assert.equal(helper.requestPatternForHost("https://api.example.com"), "https://api.example.com/*");
  assert.equal(helper.requestPatternForHost("http://localhost:3000"), "http://localhost:3000/*");
  assert.equal(helper.requestPatternForHost("api.example.com"), "https://api.example.com/*");
  assert.equal(helper.requestPatternForHost(""), null);
});

test("apiHostSuggestions excludes already-configured hosts and dedupes", () => {
  const out = helper.apiHostSuggestions(
    ["https://api.example.com", "https://api.example.com", "http://localhost:3000"],
    ["https://api.example.com/*"]
  );
  assert.deepEqual(out, ["http://localhost:3000"]);
});
