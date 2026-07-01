"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  splitLines,
  toMatchPatterns,
  requestHostPermissions,
  buildAndAuthorize
} = require("../extension/options-helper");

test("splitLines trims and drops empty entries", () => {
  assert.deepEqual(splitLines("a\n  b \n\nc\r\n"), ["a", "b", "c"]);
  assert.deepEqual(splitLines(""), []);
  assert.deepEqual(splitLines(null), []);
});

test("toMatchPatterns keeps URL-shaped lines and drops prose", () => {
  const lines = [
    "https://app.example.com/*",
    "http://api.example.com/*",
    "just a note",
    "*://*.cdn.example/*"
  ];
  assert.deepEqual(toMatchPatterns(lines), [
    "https://app.example.com/*",
    "http://api.example.com/*",
    "*://*.cdn.example/*"
  ]);
});

test("requestHostPermissions issues exactly one chrome.permissions.request call", async () => {
  const calls = [];
  const fakePermissions = {
    request: (req) => {
      calls.push(req);
      return Promise.resolve(true);
    }
  };
  const patterns = ["https://app.example.com/*", "https://api.example.com/*"];
  const result = await requestHostPermissions(patterns, { permissions: fakePermissions });
  assert.equal(result.ok, true);
  assert.equal(result.granted.length, 2);
  assert.equal(calls.length, 1, "must call chrome.permissions.request exactly once");
  assert.deepEqual(calls[0].origins, patterns);
});

test("requestHostPermissions reports denial with the user-cancelled detail", async () => {
  const fakePermissions = { request: () => Promise.resolve(false) };
  const result = await requestHostPermissions(["https://app.example.com/*"], { permissions: fakePermissions });
  assert.equal(result.ok, false);
  assert.equal(result.error, "user cancelled");
});

test("requestHostPermissions reports API errors", async () => {
  const fakePermissions = { request: () => Promise.reject(new Error("permissions API down")) };
  const result = await requestHostPermissions(["https://app.example.com/*"], { permissions: fakePermissions });
  assert.equal(result.ok, false);
  assert.match(result.error, /permissions API down/);
});

test("requestHostPermissions returns ok-with-empty when no patterns are passed", async () => {
  const calls = [];
  const fakePermissions = { request: (req) => { calls.push(req); return Promise.resolve(true); } };
  const result = await requestHostPermissions([], { permissions: fakePermissions });
  assert.equal(result.ok, true);
  assert.equal(result.granted.length, 0);
  assert.equal(calls.length, 0, "empty pattern list must not trigger a permission request");
});

test("buildAndAuthorize rejects when there are no target patterns", async () => {
  const result = await buildAndAuthorize({
    consoleHost: "http://localhost:3957",
    targetUrls: "just a comment",
    requestUrls: "https://api.example.com/*"
  }, { permissions: { request: () => { throw new Error("should not be called"); } } });
  assert.equal(result.ok, false);
  assert.equal(result.error, "no_target_patterns");
});

test("buildAndAuthorize issues a single combined permission request", async () => {
  const calls = [];
  const fakePermissions = {
    request: (req) => { calls.push(req); return Promise.resolve(true); }
  };
  const result = await buildAndAuthorize({
    consoleHost: "http://localhost:3957",
    targetUrls: "https://app.example.com/*",
    requestUrls: "https://api.example.com/*\nhttps://cdn.example.com/*"
  }, { permissions: fakePermissions });

  assert.equal(result.ok, true);
  assert.equal(calls.length, 1, "must combine targetUrls and requestUrls into a single permission request");
  assert.deepEqual(calls[0].origins, [
    "https://app.example.com/*",
    "https://api.example.com/*",
    "https://cdn.example.com/*"
  ]);
  assert.deepEqual(result.config, {
    consoleHost: "http://localhost:3957",
    targetUrls: ["https://app.example.com/*"],
    requestUrls: ["https://api.example.com/*", "https://cdn.example.com/*"]
  });
});

test("buildAndAuthorize propagates permission denial with detail", async () => {
  const fakePermissions = { request: () => Promise.resolve(false) };
  const result = await buildAndAuthorize({
    consoleHost: "http://localhost:3957",
    targetUrls: "https://app.example.com/*",
    requestUrls: ""
  }, { permissions: fakePermissions });
  assert.equal(result.ok, false);
  assert.equal(result.error, "permission_denied");
  assert.equal(result.detail, "user cancelled");
});
