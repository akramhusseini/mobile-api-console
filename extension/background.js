"use strict";

// Mobile API Console — browser capture service worker.
//
// Responsibilities:
//   1. Own the browserSession tuple (origin + profileId + context).
//   2. Receive page-script observations from content scripts / page world.
//   3. Optionally attach webRequest metadata (status, response headers).
//   4. Merge the two views and POST to /api/browser-event on localhost.
//   5. Forward clear markers from the Options page.
//
// The service worker is the only network sender. Content scripts and the
// page-world patch only message the SW.
//
// All the testable logic (message handling, page-script observation,
// webRequest correlation, merge) lives in `capture-helper.js` and is
// `require`-d from the Node test suite. This file just wires that helper
// to the chrome.* APIs.

const PROFILE_ID_STORAGE_KEY = "browserCapture.profileId";
const CONFIG_STORAGE_KEY = "browserCapture.config";
const OBSERVED_HOSTS_STORAGE_KEY = "browserCapture.observedApiHosts";
const CONSOLE_HOST_DEFAULT = "http://localhost:3957";

// capture-helper.js is a UMD module: in the extension runtime it attaches
// itself to `self.MobileApiConsoleCapture`. In Node's `node --test` it
// exports via `module.exports`. We support both via `importScripts` (which
// works in classic service workers) and a fetch+eval fallback for module
// workers. The helper has no DOM dependencies so `importScripts` is fine.
if (typeof importScripts === "function") {
  try {
    importScripts("capture-helper.js");
  } catch (error) {
    console.warn("failed to importScripts capture-helper.js", error);
  }
}

const captureApi = (typeof self !== "undefined" && self.MobileApiConsoleCapture)
  || (typeof globalThis !== "undefined" && globalThis.MobileApiConsoleCapture);

if (!captureApi || typeof captureApi.createCaptureController !== "function") {
  throw new Error("Mobile API Console: capture-helper.js did not load");
}

let cachedProfileId = null;
let cachedConfig = null;

chrome.runtime.onInstalled.addListener((details) => {
  ensureProfileId();
  if (details && details.reason === "install" && chrome.runtime.openOptionsPage) {
    chrome.runtime.openOptionsPage();
  }
});
chrome.runtime.onStartup.addListener(() => ensureProfileId());

const controller = captureApi.createCaptureController({
  getConfig,
  getProfileId,
  postEvent,
  sendClearMarker,
  profileIdSnapshot: () => cachedProfileId,
  consoleHostSnapshot: () => (cachedConfig && cachedConfig.consoleHost) || CONSOLE_HOST_DEFAULT
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  return controller.handleRuntimeMessage(message, sender, sendResponse);
});

// extraInfoSpec — only valid values per event:
//   onSendHeaders     → ["requestHeaders"]  (requestHeaders available)
//   onHeadersReceived → ["responseHeaders"] (responseHeaders available)
//   onResponseStarted → ["responseHeaders"] (responseHeaders available)
//   onCompleted       → ["responseHeaders"] (responseHeaders available)
//
// onBeforeRequest does NOT accept "requestHeaders" (it would be silently
// dropped or, in some Chrome versions, log a warning). We don't need its
// body either, so we leave it without an extraInfoSpec. It still fires and
// the helper correlates it by tabId+method+URL.
chrome.webRequest.onBeforeRequest.addListener(
  (details) => controller.attachWebRequestObservation(details, { partial: true }),
  { urls: ["http://*/*", "https://*/*"] }
);

chrome.webRequest.onSendHeaders.addListener(
  (details) => controller.attachWebRequestObservation(details, { partial: true }),
  { urls: ["http://*/*", "https://*/*"] },
  ["requestHeaders"]
);

chrome.webRequest.onHeadersReceived.addListener(
  (details) => controller.attachWebRequestObservation(details, { partial: true }),
  { urls: ["http://*/*", "https://*/*"] },
  ["responseHeaders"]
);

chrome.webRequest.onResponseStarted.addListener(
  (details) => controller.attachWebRequestObservation(details, { partial: true }),
  { urls: ["http://*/*", "https://*/*"] },
  ["responseHeaders"]
);

chrome.webRequest.onCompleted.addListener(
  (details) => controller.attachWebRequestObservation(details, { partial: false }),
  { urls: ["http://*/*", "https://*/*"] },
  ["responseHeaders"]
);

chrome.webRequest.onErrorOccurred.addListener(
  (details) => controller.attachWebRequestError(details),
  { urls: ["http://*/*", "https://*/*"] }
);

async function ensureProfileId() {
  const stored = await chrome.storage.local.get([PROFILE_ID_STORAGE_KEY]);
  if (stored[PROFILE_ID_STORAGE_KEY]) {
    cachedProfileId = stored[PROFILE_ID_STORAGE_KEY];
    return cachedProfileId;
  }
  const generated = `bprof_${randomHex(16)}`;
  await chrome.storage.local.set({ [PROFILE_ID_STORAGE_KEY]: generated });
  cachedProfileId = generated;
  return generated;
}

async function getProfileId() {
  if (cachedProfileId) return cachedProfileId;
  return ensureProfileId();
}

async function getConfig() {
  if (cachedConfig) return cachedConfig;
  const stored = await chrome.storage.local.get([CONFIG_STORAGE_KEY]);
  cachedConfig = stored[CONFIG_STORAGE_KEY] || {
    consoleHost: CONSOLE_HOST_DEFAULT,
    targetUrls: [],
    requestUrls: []
  };
  return cachedConfig;
}

async function setConfig(next) {
  cachedConfig = next;
  await chrome.storage.local.set({ [CONFIG_STORAGE_KEY]: next });
  broadcastConfig();
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes[CONFIG_STORAGE_KEY]) {
    cachedConfig = changes[CONFIG_STORAGE_KEY].newValue;
    broadcastConfig();
  }
  if (changes[PROFILE_ID_STORAGE_KEY]) {
    cachedProfileId = changes[PROFILE_ID_STORAGE_KEY].newValue;
  }
});

async function broadcastConfig() {
  const config = await getConfig();
  for (const tab of await chrome.tabs.query({})) {
    if (!tab.id) continue;
    chrome.tabs.sendMessage(tab.id, { type: "config-updated", config }).catch(() => {});
  }
}

let cachedObservedHosts = null;

async function getObservedHosts() {
  if (cachedObservedHosts) return cachedObservedHosts;
  const stored = await chrome.storage.local.get([OBSERVED_HOSTS_STORAGE_KEY]);
  const list = stored[OBSERVED_HOSTS_STORAGE_KEY];
  cachedObservedHosts = new Set(Array.isArray(list) ? list : []);
  return cachedObservedHosts;
}

// Record the cross-origin API origin a captured page is calling, so the popup
// can offer one-click "capture its headers". Same-origin calls and origins
// already in requestUrls are skipped.
async function recordApiHostFromEvent(event) {
  try {
    if (!event || !event.browserSession || !event.browserSession.origin) return;
    const reqUrl = (event.request && event.request.url) || (event.response && event.response.url) || "";
    if (!reqUrl) return;
    const req = new URL(reqUrl);
    const page = new URL(event.browserSession.origin);
    if ((req.protocol !== "http:" && req.protocol !== "https:") || req.origin === page.origin) return;
    const config = await getConfig();
    if ((config.requestUrls || []).some((p) => typeof p === "string" && (p.includes(req.origin) || p.includes(req.host)))) return;
    const observed = await getObservedHosts();
    if (observed.has(req.origin)) return;
    observed.add(req.origin);
    await chrome.storage.local.set({ [OBSERVED_HOSTS_STORAGE_KEY]: [...observed] });
  } catch { /* best effort — host discovery is a convenience, not a contract */ }
}

async function postEvent(event) {
  recordApiHostFromEvent(event);
  const config = await getConfig();
  const url = `${config.consoleHost || CONSOLE_HOST_DEFAULT}/api/browser-event`;
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(event)
    });
    if (!response.ok) {
      const text = await response.text();
      console.warn("console rejected browser event", response.status, text);
    }
  } catch (error) {
    console.warn("failed to POST browser event", error);
  }
}

async function sendClearMarker(browserSession) {
  if (!browserSession || !browserSession.origin) {
    return { ok: false, error: "browserSession required" };
  }
  const config = await getConfig();
  const url = `${config.consoleHost || CONSOLE_HOST_DEFAULT}/api/browser-event`;
  const body = { v: 1, clear: true, browserSession };
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body)
    });
    return { ok: response.ok, status: response.status };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

function randomHex(byteLength) {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

self.__MOBILE_API_CONSOLE_TEST__ = {
  setConfig,
  getConfig,
  sendClearMarker
};
