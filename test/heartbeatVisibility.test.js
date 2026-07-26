"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const INDEX_PATH = path.join(__dirname, "..", "public", "index.html");
const APP_PATH = path.join(__dirname, "..", "public", "app.js");

test("console exposes a heartbeat visibility button", () => {
  const html = fs.readFileSync(INDEX_PATH, "utf8");
  assert.match(html, /id="toggleHeartbeatButton"/);
  assert.match(html, />Show heartbeats<\/button>/);
});

test("heartbeat calls are hidden by default without deleting stored events", () => {
  const source = fs.readFileSync(APP_PATH, "utf8");
  assert.match(source, /hideHeartbeats:\s*true/);
  assert.match(source, /stored === null \? true : stored === "true"/);
  assert.match(source, /return !state\.hideHeartbeats \|\| !isHeartbeatEvent\(event\)/);
  assert.match(source, /endsWith\("\/online\/heartbeat"\)/);
  assert.doesNotMatch(source, /state\.events\s*=\s*state\.events\.filter\(\(event\) => !isHeartbeatEvent/);
});

test("manual row selection pauses Follow latest", () => {
  const source = fs.readFileSync(APP_PATH, "utf8");
  assert.match(source, /row\.addEventListener\("click", \(\) => \{[\s\S]*?autoSelectToggle\.checked = false;[\s\S]*?state\.selectedId = row\.dataset\.id;/);
  assert.match(source, /autoSelectToggle\.addEventListener\("change"/);
});
