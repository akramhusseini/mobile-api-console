"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  allowedConsoleOrigins,
  localHostHeaderAllowed,
  stateChangingOriginAllowed
} = require("../src/httpSecurity");

function req(headers = {}) {
  return { headers };
}

test("stateChangingOriginAllowed accepts same-origin browser POSTs", () => {
  const result = stateChangingOriginAllowed(req({
    host: "localhost:3957",
    origin: "http://localhost:3957"
  }), { port: 3957 });

  assert.equal(result.ok, true);
  assert.equal(result.reason, "same-origin");
});

test("stateChangingOriginAllowed accepts localhost and 127.0.0.1 aliases for the configured port", () => {
  assert.equal(stateChangingOriginAllowed(req({
    host: "localhost:3957",
    origin: "http://127.0.0.1:3957"
  }), { port: 3957 }).ok, true);

  assert.equal(stateChangingOriginAllowed(req({
    host: "127.0.0.1:3957",
    origin: "http://localhost:3957"
  }), { port: 3957 }).ok, true);
});

test("stateChangingOriginAllowed accepts IPv6 loopback host and origin", () => {
  const result = stateChangingOriginAllowed(req({
    host: "[::1]:3957",
    origin: "http://[::1]:3957"
  }), { port: 3957 });

  assert.equal(result.ok, true);
});

test("stateChangingOriginAllowed accepts non-browser local tooling with no Origin or Referer", () => {
  const result = stateChangingOriginAllowed(req({ host: "localhost:3957" }), { port: 3957 });

  assert.equal(result.ok, true);
  assert.equal(result.reason, "no-browser-origin");
});

test("stateChangingOriginAllowed rejects cross-origin browser POSTs", () => {
  const result = stateChangingOriginAllowed(req({
    host: "localhost:3957",
    origin: "https://attacker.example"
  }), { port: 3957 });

  assert.equal(result.ok, false);
  assert.equal(result.reason, "cross-origin");
  assert.equal(result.origin, "https://attacker.example");
});

test("stateChangingOriginAllowed rejects DNS-rebinding shape where Host and Origin match attacker", () => {
  const result = stateChangingOriginAllowed(req({
    host: "attacker.example:3957",
    origin: "http://attacker.example:3957"
  }), { port: 3957 });

  assert.equal(result.ok, false);
  assert.equal(result.reason, "invalid-host");
  assert.equal(result.host, "attacker.example:3957");
});

test("stateChangingOriginAllowed rejects non-local Host even when Origin is absent", () => {
  const result = stateChangingOriginAllowed(req({
    host: "attacker.example:3957"
  }), { port: 3957 });

  assert.equal(result.ok, false);
  assert.equal(result.reason, "invalid-host");
});

test("stateChangingOriginAllowed falls back to Referer when Origin is absent", () => {
  assert.equal(stateChangingOriginAllowed(req({
    host: "localhost:3957",
    referer: "http://localhost:3957/"
  }), { port: 3957 }).ok, true);

  assert.equal(stateChangingOriginAllowed(req({
    host: "localhost:3957",
    referer: "https://attacker.example/page"
  }), { port: 3957 }).ok, false);
});

test("allowedConsoleOrigins ignores request Host and includes only fixed loopback origins", () => {
  assert.deepEqual(
    [...allowedConsoleOrigins(req({ host: "attacker.example:43957" }), 43957)].sort(),
    [
      "http://127.0.0.1:43957",
      "http://[::1]:43957",
      "http://localhost:43957"
    ]
  );
});

test("localHostHeaderAllowed accepts only local hostnames", () => {
  assert.equal(localHostHeaderAllowed(req({ host: "localhost:3957" })).ok, true);
  assert.equal(localHostHeaderAllowed(req({ host: "127.0.0.1:3957" })).ok, true);
  assert.equal(localHostHeaderAllowed(req({ host: "[::1]:3957" })).ok, true);
  assert.equal(localHostHeaderAllowed(req({ host: "attacker.example:3957" })).ok, false);
});
