"use strict";

// One-click "Capture this site" popup.
//
// Reads the active tab (granted by the "activeTab" permission when the user
// clicks the toolbar icon), derives the capture pattern from the tab's own
// origin — so there is no URL to type and nothing to mistype (.co vs .com) —
// requests the host permission, writes the target through the same
// chrome.storage config the content script already watches, and reloads the
// tab so capture starts from page load.
//
// IMPORTANT: chrome.permissions.request must run inside the click gesture
// with no awaited work before it, or Chrome silently auto-denies. The button
// handler therefore fires the request first, then does storage/reload after.

const CONFIG_STORAGE_KEY = "browserCapture.config"; // mirrors background.js
const OBSERVED_HOSTS_STORAGE_KEY = "browserCapture.observedApiHosts"; // mirrors background.js
const CONSOLE_HOST_DEFAULT = "http://localhost:3957";

const helper = (typeof globalThis !== "undefined" && globalThis.MobileApiConsoleOptions) || null;

const els = {
  site: document.getElementById("site"),
  capture: document.getElementById("capture"),
  status: document.getElementById("status"),
  badge: document.getElementById("capturingBadge"),
  openOptions: document.getElementById("openOptions"),
  apiSuggest: document.getElementById("apiSuggest"),
  apiSuggestList: document.getElementById("apiSuggestList")
};

const state = { tab: null, pattern: null };

function setStatus(text, kind) {
  els.status.textContent = text || "";
  els.status.className = `status ${kind || "muted"}`;
}

function readConfig() {
  return new Promise((resolve) => {
    chrome.storage.local.get([CONFIG_STORAGE_KEY], (stored) => {
      resolve(stored[CONFIG_STORAGE_KEY] || {
        consoleHost: CONSOLE_HOST_DEFAULT,
        targetUrls: [],
        requestUrls: []
      });
    });
  });
}

function activeTab() {
  return new Promise((resolve) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => resolve((tabs && tabs[0]) || null));
  });
}

async function init() {
  if (!helper) {
    els.site.textContent = "extension error";
    setStatus("options-helper failed to load", "err");
    return;
  }

  const tab = await activeTab();
  state.tab = tab;
  const pattern = helper.originPatternForUrl(tab && tab.url);
  state.pattern = pattern;

  if (!pattern) {
    els.site.textContent = "This page can't be captured";
    setStatus("Open a normal http(s) site, then try again.", "muted");
    els.capture.disabled = true;
    return;
  }

  const host = hostFromPattern(pattern);
  els.site.textContent = host;

  const config = await readConfig();
  const already = Array.isArray(config.targetUrls) && config.targetUrls.includes(pattern);
  if (already) {
    els.badge.hidden = false;
    els.capture.textContent = "Re-arm capture (reload tab)";
    setStatus("This site is already in your capture list.", "ok");
  } else {
    els.capture.textContent = `Capture ${host}`;
  }
  els.capture.disabled = false;
  await renderApiSuggestions(config);
}

function hostFromPattern(pattern) {
  try { return new URL(pattern.replace(/\/\*$/, "/")).host; } catch { return pattern; }
}

function readObservedHosts() {
  return new Promise((resolve) => {
    chrome.storage.local.get([OBSERVED_HOSTS_STORAGE_KEY], (stored) => {
      const list = stored[OBSERVED_HOSTS_STORAGE_KEY];
      resolve(Array.isArray(list) ? list : []);
    });
  });
}

// Show cross-origin API hosts the capture has already seen, each with a
// one-click button to grant the host permission so webRequest can attach
// their response headers. No typing — the hosts are discovered live.
async function renderApiSuggestions(config) {
  if (!els.apiSuggest || !els.apiSuggestList) return;
  const observed = await readObservedHosts();
  const hosts = helper.apiHostSuggestions(observed, config.requestUrls || []);
  els.apiSuggestList.textContent = "";
  if (hosts.length === 0) { els.apiSuggest.hidden = true; return; }
  for (const host of hosts) {
    const row = document.createElement("div");
    row.className = "suggest-row";
    const label = document.createElement("span");
    label.className = "suggest-host";
    label.textContent = host;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.textContent = "Add headers";
    btn.addEventListener("click", () => grantApiHost(host, btn, row));
    row.appendChild(label);
    row.appendChild(btn);
    els.apiSuggestList.appendChild(row);
  }
  els.apiSuggest.hidden = false;
}

function grantApiHost(host, btn, row) {
  const pattern = helper.requestPatternForHost(host);
  if (!pattern) return;
  btn.disabled = true;
  // Gesture-bound: request permission first, no awaits before it.
  helper.requestHostPermissions([pattern])
    .then(async (perm) => {
      if (!perm.ok) { btn.disabled = false; btn.textContent = "Try again"; return; }
      const config = await readConfig();
      const requestUrls = Array.isArray(config.requestUrls) ? config.requestUrls.slice() : [];
      if (!requestUrls.includes(pattern)) requestUrls.push(pattern);
      await new Promise((resolve) => chrome.storage.local.set({ [CONFIG_STORAGE_KEY]: { ...config, requestUrls } }, resolve));
      row.remove();
      if (!els.apiSuggestList.children.length) els.apiSuggest.hidden = true;
    })
    .catch(() => { btn.disabled = false; btn.textContent = "Try again"; });
}

els.capture.addEventListener("click", () => {
  const pattern = state.pattern;
  if (!pattern) return;

  els.capture.disabled = true;
  setStatus("Requesting permission…", "muted");

  // Gesture-bound: fire the permission request FIRST, no awaits before it.
  helper.requestHostPermissions([pattern])
    .then(async (perm) => {
      if (!perm.ok) {
        setStatus(`Permission not granted: ${perm.error || "cancelled"}`, "err");
        els.capture.disabled = false;
        return;
      }
      const config = await readConfig();
      const next = helper.addTargetPattern(config, pattern);
      await new Promise((resolve) => chrome.storage.local.set({ [CONFIG_STORAGE_KEY]: next }, resolve));
      if (state.tab && state.tab.id != null) {
        chrome.tabs.reload(state.tab.id);
      }
      els.badge.hidden = false;
      setStatus("Capturing. Reloading the tab so it records from the start…", "ok");
      setTimeout(() => window.close(), 1200);
    })
    .catch((error) => {
      setStatus(`Error: ${error && error.message ? error.message : error}`, "err");
      els.capture.disabled = false;
    });
});

els.openOptions.addEventListener("click", () => {
  if (chrome.runtime.openOptionsPage) chrome.runtime.openOptionsPage();
});

init();
