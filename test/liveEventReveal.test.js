"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const APP_PATH = path.join(__dirname, "..", "public", "app.js");

test("new live calls remain settling until a terminal SSE upsert", () => {
  const source = fs.readFileSync(APP_PATH, "utf8");
  assert.match(source, /LIVE_EVENT_SETTLE_DELAY_MS\s*=\s*180/);
  assert.doesNotMatch(source, /LIVE_EVENT_PENDING_MAX_DELAY_MS/);
  assert.match(source, /if \(isNewEvent \|\| isWaitingForReveal\) \{\s*scheduleLiveEventReveal\(event\);/);
  assert.match(source, /if \(!hasTerminalEventData\(event\)\) \{[\s\S]*?eventRevealTimers\.set\(event\.id, \{ timer: null \}\);[\s\S]*?return;/);
  assert.match(source, /function isEventSettling\(event\) \{\s*return deferredEventIds\.has\(event\.id\) \|\| !hasTerminalEventData\(event\);/);
  assert.match(source, /hasTerminalEventData\(event\)/);
  assert.match(source, /new EventSource\("\/events"\)/);
  assert.match(source, /eventSource\.addEventListener\("event-upsert"/);
});

test("settling calls remain visible with loading feedback", () => {
  const source = fs.readFileSync(APP_PATH, "utf8");
  assert.doesNotMatch(source, /if \(deferredEventIds\.has\(event\.id\)\) return false/);
  assert.match(source, /const settling = isEventSettling\(event\)/);
  assert.match(source, /row-loading-indicator/);
  assert.match(source, /function renderProcessingDetail\(\)/);
  assert.match(source, /Retrieving response…/);
});

test("session changes clear pending reveal timers", () => {
  const source = fs.readFileSync(APP_PATH, "utf8");
  assert.match(source, /function clearDeferredEventReveals\(\)/);
  assert.match(source, /function applySnapshotPayload\(payload\) \{\s*clearDeferredEventReveals\(\);/);
  assert.match(source, /async function switchToSession\(id\)[\s\S]*?clearDeferredEventReveals\(\);/);
});
