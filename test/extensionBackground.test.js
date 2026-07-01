"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

// Chrome silently ignores (and in some versions warns about) extraInfoSpec
// values that aren't valid for a given webRequest event. The most
// important rule: onBeforeRequest does not accept "requestHeaders".
// We assert this by parsing the addListener calls in background.js.

function loadBackgroundSrc() {
  return fs.readFileSync(path.join(__dirname, "..", "extension", "background.js"), "utf8");
}

function extraInfoSpecFor(src, eventName) {
  // Capture from `chrome.webRequest.<eventName>.addListener(` to the
  // matching `);` that closes it. The block is small and balanced so a
  // paren-counting scan is reliable.
  const startMarker = `chrome.webRequest.${eventName}.addListener(`;
  const start = src.indexOf(startMarker);
  if (start < 0) return null;
  let depth = 0;
  let end = -1;
  for (let i = start + startMarker.length - 1; i < src.length; i += 1) {
    const ch = src[i];
    if (ch === "(") depth += 1;
    else if (ch === ")") {
      depth -= 1;
      if (depth === 0) { end = i; break; }
    }
  }
  if (end < 0) return null;
  const block = src.slice(start, end + 1);
  // The last top-level array literal before the closing paren is the
  // extraInfoSpec. We pick the rightmost one whose contents look like
  // ["..."].
  const matches = [...block.matchAll(/\[\s*("[^"]+"(?:\s*,\s*"[^"]+")*)\s*\]/g)];
  if (matches.length === 0) return [];
  const last = matches[matches.length - 1];
  return last[1].split(",").map((s) => s.trim().replace(/^"|"$/g, ""));
}

test("onBeforeRequest must not include requestHeaders in extraInfoSpec", () => {
  const src = loadBackgroundSrc();
  const tokens = extraInfoSpecFor(src, "onBeforeRequest");
  assert.ok(tokens !== null, "background.js must register an onBeforeRequest listener");
  assert.ok(!tokens.includes("requestHeaders"),
    "onBeforeRequest does not accept 'requestHeaders' — use onSendHeaders instead");
});

test("onSendHeaders includes requestHeaders so the merge can see request headers", () => {
  const src = loadBackgroundSrc();
  const tokens = extraInfoSpecFor(src, "onSendHeaders");
  assert.ok(tokens !== null, "background.js must register an onSendHeaders listener");
  assert.ok(tokens.includes("requestHeaders"),
    "onSendHeaders must include 'requestHeaders' in extraInfoSpec");
});

test("onHeadersReceived / onResponseStarted / onCompleted include responseHeaders", () => {
  const src = loadBackgroundSrc();
  for (const event of ["onHeadersReceived", "onResponseStarted", "onCompleted"]) {
    const tokens = extraInfoSpecFor(src, event);
    assert.ok(tokens !== null, `background.js must register an ${event} listener`);
    assert.ok(tokens.includes("responseHeaders"),
      `${event} must include 'responseHeaders' in extraInfoSpec`);
  }
});

test("onErrorOccurred does not require an extraInfoSpec (it fires after the response)", () => {
  // The error path uses the same correlation key, no headers needed.
  // We just assert the listener is registered; the parser is permissive
  // about extraInfoSpec.
  const src = loadBackgroundSrc();
  assert.match(src, /chrome\.webRequest\.onErrorOccurred\.addListener\(/);
});
