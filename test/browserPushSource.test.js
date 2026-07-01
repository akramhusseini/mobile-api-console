"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { BrowserPushSource } = require("../src/logSource/browserPushSource");

test("browser source status stays generic when URL patterns change", () => {
  const source = new BrowserPushSource({
    targetUrls: ["https://dev.example/*"],
    requestUrls: ["https://api.dev.example/*"]
  });

  source.start();
  assert.equal(source.status.message, "Browser source ready");

  source.configure({
    targetUrls: ["https://preprod.example/*"],
    requestUrls: ["https://api.preprod.example/*"]
  });
  assert.equal(source.status.message, "Browser source ready");

  source.noteIngest({
    captureMode: "merged",
    origin: "https://runtime.example",
    phase: "complete"
  });
  assert.equal(source.status.message, "Browser source ready");
  assert.equal(source.status.lastSeen.origin, "https://runtime.example");
});
