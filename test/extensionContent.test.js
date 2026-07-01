"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const CONTENT_JS = fs.readFileSync(path.join(__dirname, "..", "extension", "content.js"), "utf8");

function loadContentScript({ href = "https://app.example.com/dashboard" } = {}) {
  const listeners = new Map();
  const runtimeListeners = [];
  const sentMessages = [];
  const appendedScripts = [];
  let configCallback = null;

  const windowObj = {
    top: null,
    location: {
      href,
      origin: new URL(href).origin
    },
    addEventListener(type, handler) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(handler);
    }
  };
  windowObj.top = windowObj;

  function appendChild(script) {
    appendedScripts.push(script);
    if (typeof script.onload === "function") script.onload();
    return script;
  }

  const documentObj = {
    createElement(tagName) {
      return {
        tagName: String(tagName).toUpperCase(),
        dataset: {},
        remove() {
          this.removed = true;
        }
      };
    },
    head: { appendChild },
    documentElement: { appendChild }
  };

  const chromeObj = {
    runtime: {
      lastError: null,
      getURL(resource) {
        return `chrome-extension://extension-id/${resource}`;
      },
      sendMessage(message, callback) {
        if (typeof callback === "function") {
          configCallback = callback;
          return undefined;
        }
        sentMessages.push(message);
        return { catch() {} };
      },
      onMessage: {
        addListener(listener) {
          runtimeListeners.push(listener);
        }
      }
    }
  };

  vm.runInNewContext(CONTENT_JS, {
    window: windowObj,
    document: documentObj,
    chrome: chromeObj,
    console
  });

  return {
    appendedScripts,
    sentMessages,
    dispatchObservation(detail) {
      for (const listener of listeners.get("mobile-api-console:observation") || []) {
        listener({ detail });
      }
    },
    resolveConfig(config) {
      assert.ok(configCallback, "content script should request active config");
      chromeObj.runtime.lastError = null;
      configCallback({ config });
    },
    rejectConfig() {
      assert.ok(configCallback, "content script should request active config");
      chromeObj.runtime.lastError = { message: "service worker unavailable" };
      configCallback(null);
      chromeObj.runtime.lastError = null;
    },
    sendRuntimeMessage(message) {
      for (const listener of runtimeListeners) listener(message);
    }
  };
}

test("content script buffers page observations until config arrives", () => {
  const harness = loadContentScript();
  const observation = {
    eventId: "evt-before-config",
    pageUrl: "https://app.example.com/dashboard",
    request: { url: "https://api.example.com/v1/users" }
  };

  harness.dispatchObservation(observation);
  assert.equal(harness.sentMessages.length, 0, "observation must not be dropped before config resolves");

  harness.resolveConfig({ targetUrls: ["https://app.example.com/*"] });
  assert.equal(harness.sentMessages.length, 1);
  assert.equal(harness.sentMessages[0].type, "page-script-observation");
  assert.equal(harness.sentMessages[0].payload, observation);
});

test("content script drops buffered observations that do not match target URLs", () => {
  const harness = loadContentScript();
  harness.dispatchObservation({
    eventId: "evt-wrong-site",
    pageUrl: "https://other.example.com/dashboard"
  });

  harness.resolveConfig({ targetUrls: ["https://app.example.com/*"] });
  assert.equal(harness.sentMessages.length, 0);
});

test("content script forwards observations immediately after config is loaded", () => {
  const harness = loadContentScript();
  harness.resolveConfig({ targetUrls: ["https://app.example.com/*"] });

  harness.dispatchObservation({
    eventId: "evt-after-config",
    pageUrl: "https://app.example.com/dashboard"
  });

  assert.equal(harness.sentMessages.length, 1);
  assert.equal(harness.sentMessages[0].payload.eventId, "evt-after-config");
});

test("content script can flush buffered observations from a config-updated message", () => {
  const harness = loadContentScript();
  harness.dispatchObservation({
    eventId: "evt-config-update",
    pageUrl: "https://app.example.com/dashboard"
  });

  harness.sendRuntimeMessage({
    type: "config-updated",
    config: { targetUrls: ["https://app.example.com/*"] }
  });

  assert.equal(harness.sentMessages.length, 1);
  assert.equal(harness.sentMessages[0].payload.eventId, "evt-config-update");
});

test("content script leaves page patch loading to the manifest MAIN-world script", () => {
  const harness = loadContentScript();

  assert.equal(harness.appendedScripts.length, 0);
});
