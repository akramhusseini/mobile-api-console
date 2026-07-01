"use strict";

// Content script — runs in the isolated world at document_start. It owns
// the bridge between the MAIN-world page patch and the service worker.
//
// Responsibilities:
//   1. Forward page-world observations to the SW via chrome.runtime.sendMessage.
//   2. Apply target URL filtering so we never observe pages the user has
//      not authorised.

(function () {
  if (window.top !== window) {
    // For now we only capture at the top frame. Phase 2 may extend to iframes.
    return;
  }

  let cachedConfig = null;
  let configLoaded = false;
  const pendingObservations = [];
  const MAX_PENDING_OBSERVATIONS = 100;

  function shouldCapture(url) {
    if (!cachedConfig) return false;
    if (!Array.isArray(cachedConfig.targetUrls) || cachedConfig.targetUrls.length === 0) {
      return false;
    }
    return cachedConfig.targetUrls.some((pattern) => matchPattern(pattern, url));
  }

  function matchPattern(pattern, url) {
    if (!pattern || !url) return false;
    // Chrome match patterns: scheme://host/path, where * is a wildcard.
    // We accept the same shape plus plain-prefix "*example.com" shorthand.
    const escaped = pattern
      .replace(/[.+?^${}()|[\]\\]/g, "\\$&")
      .replace(/\*/g, ".*");
    const re = new RegExp(`^${escaped}$`, "i");
    return re.test(url);
  }

  function postObservation(observation) {
    if (!configLoaded) {
      pendingObservations.push(observation);
      if (pendingObservations.length > MAX_PENDING_OBSERVATIONS) {
        pendingObservations.shift();
      }
      return;
    }
    const pageUrl = observation?.pageUrl || window.location.href;
    if (!shouldCapture(pageUrl)) return;
    chrome.runtime.sendMessage({
      type: "page-script-observation",
      payload: observation
    }).catch(() => {});
  }

  function flushPendingObservations() {
    while (pendingObservations.length) {
      postObservation(pendingObservations.shift());
    }
  }

  function applyConfig(config) {
    cachedConfig = config || null;
    configLoaded = true;
    flushPendingObservations();
  }

  // Listen for the page-world bridge events (CustomEvent on window).
  window.addEventListener("mobile-api-console:observation", (event) => {
    const detail = event?.detail;
    if (!detail || typeof detail !== "object") return;
    postObservation(detail);
  });

  // Pull config from the SW.
  function refreshConfig() {
    chrome.runtime.sendMessage({ type: "get-active-config" }, (response) => {
      if (chrome.runtime.lastError) {
        applyConfig(null);
        return;
      }
      applyConfig(response?.config || null);
    });
  }

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === "config-updated") {
      applyConfig(message.config || null);
    }
  });

  refreshConfig();
})();
