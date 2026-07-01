"use strict";

const PROFILE_ID_KEY = "browserCapture.profileId";
const CONFIG_KEY = "browserCapture.config";
const DEFAULT_CONFIG = {
  consoleHost: "http://localhost:3957",
  targetUrls: [],
  requestUrls: []
};

// options-helper.js is a UMD module: in the extension page it attaches
// itself to `window.MobileApiConsoleOptions` (loaded as a sibling <script>
// in options.html, before this file). In Node's `node --test` it exports
// via `module.exports`. options-helper.js has no DOM dependencies.
const optionsApi = (typeof window !== "undefined" && window.MobileApiConsoleOptions)
  || (typeof self !== "undefined" && self.MobileApiConsoleOptions)
  || (typeof globalThis !== "undefined" && globalThis.MobileApiConsoleOptions);

if (!optionsApi || typeof optionsApi.buildAndAuthorize !== "function") {
  throw new Error("Mobile API Console: options-helper.js did not load");
}

const form = document.getElementById("configForm");
const consoleHostInput = document.getElementById("consoleHost");
const targetUrlsInput = document.getElementById("targetUrls");
const requestUrlsInput = document.getElementById("requestUrls");
const statusEl = document.getElementById("status");
const profileEl = document.getElementById("profileId");
const rotateProfileBtn = document.getElementById("rotateProfile");
const testBtn = document.getElementById("testBtn");

function setStatus(text, kind = "") {
  statusEl.textContent = text || "";
  statusEl.className = "status" + (kind ? " " + kind : "");
}

async function loadConfig() {
  const stored = await chrome.storage.local.get([CONFIG_KEY, PROFILE_ID_KEY]);
  const config = await configWithConsoleDefaults({ ...DEFAULT_CONFIG, ...(stored[CONFIG_KEY] || {}) });
  consoleHostInput.value = config.consoleHost || DEFAULT_CONFIG.consoleHost;
  targetUrlsInput.value = (config.targetUrls || []).join("\n");
  requestUrlsInput.value = (config.requestUrls || []).join("\n");
  profileEl.textContent = stored[PROFILE_ID_KEY] || "(missing)";
}

async function configWithConsoleDefaults(config) {
  const defaults = await fetchConsoleDefaults(config.consoleHost || DEFAULT_CONFIG.consoleHost);
  if (!defaults || !defaults.browser) return config;
  const next = { ...config };
  if (defaults.consoleHost) next.consoleHost = defaults.consoleHost;
  if (Array.isArray(defaults.browser.targetUrls) && defaults.browser.targetUrls.length > 0) {
    next.targetUrls = defaults.browser.targetUrls;
  }
  if (Array.isArray(defaults.browser.requestUrls)) {
    next.requestUrls = defaults.browser.requestUrls;
  }
  return next;
}

async function fetchConsoleDefaults(consoleHost) {
  try {
    const base = String(consoleHost || DEFAULT_CONFIG.consoleHost).replace(/\/+$/, "");
    const response = await fetch(`${base}/api/browser-setup/defaults`, { cache: "no-store" });
    if (!response.ok) return null;
    return response.json();
  } catch {
    return null;
  }
}

async function loadProfileId() {
  const stored = await chrome.storage.local.get([PROFILE_ID_KEY]);
  if (stored[PROFILE_ID_KEY]) return stored[PROFILE_ID_KEY];
  const generated = `bprof_${cryptoHex(16)}`;
  await chrome.storage.local.set({ [PROFILE_ID_KEY]: generated });
  return generated;
}

function cryptoHex(byteLength) {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  setStatus("Requesting permissions…");

  // buildAndAuthorize issues exactly one chrome.permissions.request call
  // for the combined target + request patterns. Asking twice (or asking
  // after an await) lets Chrome silently auto-deny the second prompt.
  const result = await optionsApi.buildAndAuthorize({
    consoleHost: consoleHostInput.value,
    targetUrls: targetUrlsInput.value,
    requestUrls: requestUrlsInput.value
  });

  if (!result.ok) {
    if (result.error === "no_target_patterns") {
      setStatus("Add at least one target page URL pattern.", "error");
      return;
    }
    if (result.error === "permission_denied") {
      setStatus("Permissions denied: " + (result.detail || "user cancelled"), "error");
      return;
    }
    setStatus("Save failed: " + (result.error || "unknown"), "error");
    return;
  }

  await chrome.storage.local.set({ [CONFIG_KEY]: result.config });
  setStatus(
    `Saved. ${result.config.targetUrls.length} target pattern${result.config.targetUrls.length === 1 ? "" : "s"}, ${result.config.requestUrls.length} request pattern${result.config.requestUrls.length === 1 ? "" : "s"}.`,
    "ok"
  );
});

rotateProfileBtn.addEventListener("click", async () => {
  const next = `bprof_${cryptoHex(16)}`;
  await chrome.storage.local.set({ [PROFILE_ID_KEY]: next });
  profileEl.textContent = next;
  setStatus("Profile id regenerated. Existing browser sessions in the console will start a new session.", "ok");
});

testBtn.addEventListener("click", async () => {
  setStatus("Sending test event…");
  const profileId = await loadProfileId();
  const origin = window.location.origin || "chrome-extension://test";
  const eventId = crypto.randomUUID();
  const event = {
    v: 1,
    sourceKind: "browser-chromium",
    browserSession: { origin, profileId, context: "regular" },
    tabId: null,
    captureMode: "page-script",
    eventId,
    phase: "complete",
    request: {
      startedAt: Date.now() - 12,
      method: "GET",
      url: `${origin}/__test__`,
      headers: { "X-Test": "1" },
      body: null,
      bodyAvailable: true,
      bodyTruncated: false,
      bodyUnavailableReason: null
    },
    response: {
      completedAt: Date.now(),
      durationMs: 12,
      status: 200,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ok: true, test: true }),
      bodyAvailable: true,
      bodyTruncated: false,
      bodyUnavailableReason: null
    },
    metadata: { pageUrl: origin, initiator: origin },
    error: null
  };
  try {
    const response = await chrome.runtime.sendMessage({
      type: "page-script-observation",
      payload: event
    });
    setStatus("Test event sent. Check the console UI.", "ok");
  } catch (error) {
    setStatus("Test event failed: " + error.message, "error");
  }
});

loadConfig();
loadProfileId();
