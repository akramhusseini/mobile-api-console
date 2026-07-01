"use strict";

// Capture controller for the Mobile API Console browser extension.
//
// This module is intentionally written as a UMD-style helper so it can be:
//   1. `importScripts`-ed by the background service worker (`background.js`).
//   2. `require`d from the Node test suite under `test/`.
//
// All dependencies (`getConfig`, `getProfileId`, `postEvent`,
// `sendClearMarker`, `now`, etc.) are injected so the tests can mock them
// without touching the Chrome runtime.

(function (globalThis) {
  const PENDING_PAGE_SCRIPT_TIMEOUT_MS = 1500;
  const DEFAULT_COMPLETE_DELAY_MS = 100;
  // Short window during which a webRequest-only fallback waits before
  // posting on its own. The page-script request/complete phase almost
  // always arrives within a few ms of onBeforeRequest / onCompleted;
  // giving it that window lets it adopt the fallback (replacing the
  // wr_* eventId with the page-script UUID) instead of producing a
  // duplicate row.
  const WEBREQUEST_MERGE_WINDOW_MS = 50;

  function createCaptureController(deps = {}) {
    const getConfig = deps.getConfig || (async () => ({}));
    const getProfileId = deps.getProfileId || (async () => "unknown-profile");
    const postEvent = deps.postEvent || (async () => {});
    const sendClearMarker = deps.sendClearMarker || (async () => ({ ok: true }));
    const now = deps.now || (() => Date.now());
    const setTimeoutFn = deps.setTimeout || setTimeout;
    const clearTimeoutFn = deps.clearTimeout || clearTimeout;
    const completeDelayMs = Number.isFinite(deps.completeDelayMs) ? deps.completeDelayMs : DEFAULT_COMPLETE_DELAY_MS;
    const consoleHostSnapshot = deps.consoleHostSnapshot || (() => "http://localhost:3957");

    const recentEvents = new Map();
    // Secondary index: page-script eventId -> key in recentEvents. Lets
    // the complete phase find its own request phase by eventId, even if
    // the page-script relative-URL -> absolute-URL transition (or any
    // other field) caused the correlation key to drift.
    const eventIdToKey = new Map();
    const timers = new Map();

    // ------------------------------------------------------------------------
    // Public surface
    // ------------------------------------------------------------------------

    async function handlePageScriptObservation(payload, sender) {
      if (!payload || typeof payload !== "object") return;
      const profileId = await getProfileId();
      const context = (sender && sender.incognito) ? "incognito" : "regular";
      const pageUrl = (sender && sender.url) || payload.pageUrl || "";
      let origin = "";
      try { origin = new URL(pageUrl).origin; } catch { origin = ""; }
      if (!origin) return;

      const browserSession = { origin, profileId, context };
      const pageEventId = payload.eventId || randomUUID();
      const tabId = (sender && sender.tab && sender.tab.id != null) ? sender.tab.id : null;

      // Look up the request phase by eventId first. The complete phase
      // arrives with `request: null`, so deriving method/url from
      // payload alone falls back to a default ("GET") and loses the
      // POST/relative-URL info the request phase already had. The
      // eventId is the only stable identity across the two phases.
      let existing = null;
      let existingKey = null;
      if (payload.eventId) {
        const foundKey = eventIdToKey.get(payload.eventId);
        if (foundKey && recentEvents.has(foundKey)) {
          existing = recentEvents.get(foundKey);
          existingKey = foundKey;
        }
      }

      // Canonicalize URLs against pageUrl / sender.url so a relative
      // `fetch("/api/echo")` (from a page-inject that forgot to
      // absolutize, or from a future caller) matches the absolute URL
      // webRequest sees. The original raw URL is still preserved in
      // the merged request/response objects; only the correlation key
      // uses the absolute form.
      const methodFromPayload = ((payload.request && payload.request.method) || "").toUpperCase();
      const rawRequestUrl = (payload.request && payload.request.url) || "";
      const rawResponseUrl = (payload.response && payload.response.url) || "";
      const canonicalRequestUrl = canonicalizeUrl(rawRequestUrl, pageUrl);
      const canonicalResponseUrl = canonicalizeUrl(rawResponseUrl, pageUrl);

      // Fallback: tabId+method+url lookup against the canonical (absolute)
      // URL. webRequest may have created an entry under the canonical key
      // before the page-script request phase arrived (e.g. onBeforeRequest
      // fires before the fetch hook runs). Picking that up here is what
      // lets webRequest metadata merge into the page-script event instead
      // of producing a separate wr_* row.
      if (!existing && tabId != null && methodFromPayload && canonicalRequestUrl) {
        const keyByTab = correlationKey(tabId, methodFromPayload, canonicalRequestUrl);
        if (recentEvents.has(keyByTab)) {
          existing = recentEvents.get(keyByTab);
          existingKey = keyByTab;
        }
      }

      // Canonical method/url for the correlation key: prefer the
      // request phase's values, then the payload, then a last-resort
      // empty string. Using existing.request.url here is what allows a
      // page-inject absolute URL emitted in the request phase to win
      // over a relative URL the complete phase might have re-emitted.
      // The existing URL is also canonicalized so a request phase that
      // was indexed under a relative URL still matches the canonical
      // (absolute) key webRequest will use.
      const method = ((existing && existing.request && existing.request.method)
        || (payload.request && payload.request.method)
        || "GET").toUpperCase();
      const existingCanonicalUrl = (existing && existing.request && existing.request.url)
        ? canonicalizeUrl(existing.request.url, ((existing.metadata && existing.metadata.pageUrl) || pageUrl))
        : "";
      const url = existingCanonicalUrl
        || canonicalRequestUrl
        || canonicalResponseUrl
        || "";

      const key = correlationKey(tabId, method, url);

      // If the request phase was indexed under a different key (because
      // the URL got absolutized between phases, for example), move the
      // entry over to the canonical key so the post-time lookup matches
      // what webRequest will compute. Timers and eventIdToKey entries
      // must move with it; the old eventId → oldKey mapping is cleared
      // so a stale lookup cannot resurrect a deleted entry.
      if (existingKey && existingKey !== key) {
        if (recentEvents.get(existingKey) === existing) {
          recentEvents.delete(existingKey);
        }
        const oldTimer = timers.get(existingKey);
        if (oldTimer) {
          clearTimeoutFn(oldTimer);
          timers.delete(existingKey);
        }
        if (existing && existing.eventId && existing.eventId !== pageEventId) {
          if (eventIdToKey.get(existing.eventId) === existingKey) {
            eventIdToKey.delete(existing.eventId);
          }
        }
      }

      const merged = mergeObservations(existing, {
        v: 1,
        sourceKind: "browser-chromium",
        browserSession,
        tabId,
        captureMode: pageCaptureMode(existing),
        eventId: pageEventId,
        phase: payload.phase || "complete",
        request: payload.request || (existing && existing.request) || null,
        response: payload.response || (existing && existing.response) || null,
        metadata: {
          pageUrl: ((existing && existing.metadata) && existing.metadata.pageUrl) || pageUrl || null,
          initiator: ((existing && existing.metadata) && existing.metadata.initiator) || (payload.initiator || null),
          webRequestId: ((existing && existing.metadata) && existing.metadata.webRequestId) || null
        },
        error: payload.error || (existing && existing.error) || null
      });
      recentEvents.set(key, merged);
      // Clear any stale eventId → key mapping for the old eventId
      // (e.g. a wr_* id) so a later lookup of that id cannot find a
      // deleted entry. The new mapping is set unconditionally.
      if (existing && existing.eventId && existing.eventId !== pageEventId) {
        if (eventIdToKey.get(existing.eventId) === key) {
          eventIdToKey.delete(existing.eventId);
        }
      }
      eventIdToKey.set(pageEventId, key);

      if (merged.phase === "complete") {
        schedulePost(key, merged, { delayMs: completeDelayMs });
      } else {
        await postEvent(merged);
      }
    }

    function attachWebRequestObservation(details, options = {}) {
      if (!details || details.tabId == null || details.tabId < 0) return false;
      if (isIgnoredWebRequest(details)) return false;
      const tabId = details.tabId;
      const method = (details.method || "GET").toUpperCase();
      const url = details.url || "";
      const key = correlationKey(tabId, method, url);
      const existing = recentEvents.get(key) || null;

      if (existing) {
        const merged = mergeWebRequestInto(existing, details);
        recentEvents.set(key, merged);
        if (!options.partial && merged.phase === "complete") {
          // In real Chrome, onCompleted (non-partial) usually follows
          // onBeforeRequest (partial) for the same call. The partial
          // pass creates a webRequest-only fallback; the non-partial
          // pass finds that fallback and would otherwise schedule a
          // post at delay 0, racing with the page-script request/
          // complete phase that arrives a few ms later. Holding the
          // post for the short merge window lets the page script
          // adopt the entry (replacing the wr_* eventId with the
          // page-script UUID) instead of producing a duplicate row.
          //
          // For an existing page-script or merged entry the page
          // script is already in the driver's seat — post immediately
          // so the call lands without the extra latency.
          const fallbackDelay = existing.captureMode === "web-request"
            ? WEBREQUEST_MERGE_WINDOW_MS
            : 0;
          schedulePost(key, merged, { delayMs: fallbackDelay });
        }
        return true;
      }

      // WebRequest-only fallback. We need to derive a meaningful origin
      // before posting, otherwise the server's session-key derivation
      // would point at an empty origin and the event would land in a
      // "browser::::unknown::regular" session.
      const pageUrl = details.documentUrl || details.initiator || "";
      let origin = "";
      try { origin = new URL(pageUrl).origin; } catch { origin = ""; }
      if (!origin) return false;

      const wire = buildWebRequestWire(details, origin);
      const context = details.incognito ? "incognito" : "regular";
      const profileId = deps.profileIdSnapshot ? deps.profileIdSnapshot() : null;
      // Hold the fallback for the short merge window before posting so
      // the page-script request/complete phase (which almost always
      // arrives within a few ms of onCompleted) can adopt it. Posting
      // immediately at delay 0 would emit a wr_* row that the page
      // script cannot later replace, producing a duplicate row for the
      // same logical call.
      const fallbackDelayMs = !options.partial && wire.phase === "complete"
        ? WEBREQUEST_MERGE_WINDOW_MS
        : 0;
      if (profileId) {
        wire.browserSession = { origin, profileId, context };
        recentEvents.set(key, wire);
        if (fallbackDelayMs > 0) {
          schedulePost(key, wire, { delayMs: fallbackDelayMs });
        }
        return true;
      }

      // Async fallback: resolve profileId, then enqueue.
      getProfileId().then((resolvedProfileId) => {
        wire.browserSession = { origin, profileId: resolvedProfileId || "unknown-profile", context };
        recentEvents.set(key, wire);
        if (fallbackDelayMs > 0) {
          schedulePost(key, wire, { delayMs: fallbackDelayMs });
        }
      }).catch(() => {
        // Drop the event rather than post with a half-baked browserSession.
      });
      return true;
    }

    function attachWebRequestError(details) {
      if (!details || details.tabId == null || details.tabId < 0) return false;
      if (isIgnoredWebRequest(details)) return false;
      const tabId = details.tabId;
      const method = (details.method || "GET").toUpperCase();
      const url = details.url || "";
      const key = correlationKey(tabId, method, url);
      const existing = recentEvents.get(key) || null;
      if (existing) {
        existing.error = details.error || "webRequest error";
        existing.captureMode = existing.captureMode === "page-script" ? "merged" : existing.captureMode;
        recentEvents.set(key, existing);
        schedulePost(key, existing, { delayMs: 0 });
        return true;
      }
      return false;
    }

    function correlationKey(tabId, method, url) {
      return `${tabId || 0}:${method}:${url}`;
    }

    // Resource types that are never API calls — dropping them keeps the
    // console focused on fetch/XHR instead of every script/style/image the
    // page loads. webRequest's `type` distinguishes them; page-script
    // capture is unaffected (it only ever sees fetch/XHR).
    const NON_API_RESOURCE_TYPES = new Set([
      "main_frame", "sub_frame", "stylesheet", "script", "image", "font",
      "object", "media", "ping", "csp_report", "beacon", "imageset",
      "xslt", "favicon", "prefetch", "websocket"
    ]);

    function consoleOrigin() {
      try { return new URL(consoleHostSnapshot() || "http://localhost:3957").origin; }
      catch { return "http://localhost:3957"; }
    }

    // Drop webRequest events we never want as rows: static page resources
    // (noise in an API console) and any traffic to the console's own
    // origin — the extension POSTing events, plus the console UI itself if
    // it happens to be open in the captured browser (the localhost:3957
    // self-capture the user reported).
    function isIgnoredWebRequest(details) {
      if (!details) return true;
      if (details.type && NON_API_RESOURCE_TYPES.has(details.type)) return true;
      if (details.url) {
        try { if (new URL(details.url).origin === consoleOrigin()) return true; } catch { /* keep */ }
      }
      return false;
    }

    // Absolutize a URL string against a base (pageUrl / sender.url). A
    // URL that already has a scheme is returned unchanged. This mirrors
    // page-inject.js's absolutizeUrl so the helper can correlate a
    // relative `fetch("/api/echo")` from the page script with the
    // absolute URL webRequest will see for the same call.
    function canonicalizeUrl(rawUrl, baseUrl) {
      if (typeof rawUrl !== "string" || !rawUrl) return "";
      if (/^[a-z][a-z0-9+.-]*:/i.test(rawUrl)) return rawUrl;
      if (!baseUrl) return rawUrl;
      try {
        return new URL(rawUrl, baseUrl).href;
      } catch {
        return rawUrl;
      }
    }

    // For test inspection.
    function _state() {
      return {
        recentEvents: Array.from(recentEvents.entries()),
        timers: Array.from(timers.keys())
      };
    }

    function _reset() {
      for (const t of timers.values()) clearTimeoutFn(t);
      recentEvents.clear();
      timers.clear();
    }

    // Exposed so background.js can wire it to chrome.runtime.onMessage.
    function handleRuntimeMessage(message, sender, sendResponse) {
      if (!message || typeof message !== "object") return false;

      if (message.type === "page-script-observation") {
        handlePageScriptObservation(message.payload, sender)
          .catch((error) => console.warn("page-script observation failed", error));
        return false;
      }

      if (message.type === "get-active-config") {
        // MUST return true so Chrome keeps the message channel open for
        // the async response. The content script depends on this.
        Promise.resolve()
          .then(() => getConfig())
          .then((config) => sendResponse({ config }))
          .catch((error) => sendResponse({ config: null, error: error.message }));
        return true;
      }

      if (message.type === "clear-browser-session") {
        sendClearMarker(message.browserSession)
          .then((result) => sendResponse(result))
          .catch((error) => sendResponse({ ok: false, error: error.message }));
        return true;
      }

      return false;
    }

    // ------------------------------------------------------------------------
    // Internal helpers (defined here so they share `timers`/`recentEvents`)
    // ------------------------------------------------------------------------

    function pageCaptureMode(existing) {
      if (!existing) return "page-script";
      if (existing.captureMode === "web-request") return "merged";
      return existing.captureMode || "page-script";
    }

    function mergeObservations(existing, incoming) {
      if (!existing) return { ...incoming };
      return {
        ...existing,
        ...incoming,
        browserSession: existing.browserSession || incoming.browserSession,
        tabId: existing.tabId != null ? existing.tabId : incoming.tabId,
        // The page-script observation's eventId is the canonical
        // identity for the wire event. If existing came from a
        // webRequest fallback (eventId = "wr_...") and incoming is
        // the page-script request/complete phase, the page-script
        // UUID must win so both phases (and the eventual server
        // upsert) share the same client_event_id.
        eventId: incoming.eventId || existing.eventId,
        captureMode: pageCaptureMode(existing) === "merged" || incoming.captureMode === "merged"
          ? "merged"
          : pageCaptureMode(existing),
        request: mergeRequest(incoming.request, existing.request),
        response: mergeResponse(incoming.response, existing.response),
        metadata: {
          pageUrl: (existing.metadata && existing.metadata.pageUrl) || (incoming.metadata && incoming.metadata.pageUrl) || null,
          initiator: (existing.metadata && existing.metadata.initiator) || (incoming.metadata && incoming.metadata.initiator) || null,
          webRequestId: (incoming.metadata && incoming.metadata.webRequestId) || (existing.metadata && existing.metadata.webRequestId) || null
        },
        error: incoming.error || existing.error || null
      };
    }

    // Merge two request sides. Incoming wins for scalar fields (method,
    // url, body) because the page-script is the source of truth for
    // what the caller's code actually sent. Headers are unioned so a
    // webRequest merge (which only contributes request headers) is not
    // blown away by a later page-script observation that omits them.
    function mergeRequest(incoming, existing) {
      if (!incoming) return existing || null;
      if (!existing) return incoming;
      return {
        ...existing,
        ...incoming,
        headers: { ...(existing.headers || {}), ...(incoming.headers || {}) }
      };
    }

    // Merge two response sides. Same rule as mergeRequest: incoming
    // wins for status / body / url (page-script is the source of
    // truth for what the caller actually received), but headers are
    // unioned so webRequest response headers survive a later
    // page-script observation that arrives with a stripped header bag.
    function mergeResponse(incoming, existing) {
      if (!incoming) return existing || null;
      if (!existing) return incoming;
      return {
        ...existing,
        ...incoming,
        headers: { ...(existing.headers || {}), ...(incoming.headers || {}) }
      };
    }

    function mergeWebRequestInto(existing, details) {
      const next = { ...existing };
      if (existing.captureMode === "page-script") next.captureMode = "merged";
      if (details.responseHeaders) {
        next.response = next.response || {};
        next.response.headers = { ...(next.response.headers || {}), ...filterResponseHeaders(details.responseHeaders) };
      }
      if (details.requestHeaders) {
        next.request = next.request || {};
        next.request.headers = { ...(next.request.headers || {}), ...filterRequestHeaders(details.requestHeaders) };
      }
      if (details.statusCode && (!next.response || !next.response.status)) {
        next.response = next.response || {};
        next.response.status = details.statusCode;
      }
      if (details.timeStamp) {
        if (!next.response) next.response = {};
        if (!next.response.completedAt) next.response.completedAt = details.timeStamp;
      }
      if (details.requestId) {
        next.metadata = next.metadata || {};
        if (!next.metadata.webRequestId) next.metadata.webRequestId = details.requestId;
      }
      return next;
    }

    function buildWebRequestWire(details, origin) {
      return {
        v: 1,
        sourceKind: "browser-chromium",
        browserSession: { origin, profileId: "pending", context: "regular" },
        tabId: details.tabId,
        captureMode: "web-request",
        eventId: `wr_${details.requestId}`,
        phase: "complete",
        request: {
          startedAt: details.timeStamp || null,
          method: (details.method || "GET").toUpperCase(),
          url: details.url || "",
          headers: filterRequestHeaders(details.requestHeaders),
          body: null,
          bodyAvailable: false,
          bodyTruncated: false,
          bodyUnavailableReason: "not-readable"
        },
        response: {
          completedAt: details.timeStamp || null,
          durationMs: null,
          status: details.statusCode || null,
          headers: filterResponseHeaders(details.responseHeaders),
          body: null,
          bodyAvailable: false,
          bodyTruncated: false,
          bodyUnavailableReason: "not-readable"
        },
        metadata: {
          pageUrl: details.documentUrl || details.initiator || null,
          initiator: details.initiator || null,
          webRequestId: details.requestId
        },
        error: null
      };
    }

    function filterRequestHeaders(headers) {
      if (!Array.isArray(headers)) return {};
      const out = {};
      for (const entry of headers) {
        if (!entry || !entry.name) continue;
        out[entry.name] = entry.value || "";
      }
      return out;
    }

    function filterResponseHeaders(headers) {
      if (!Array.isArray(headers)) return {};
      const out = {};
      for (const entry of headers) {
        if (!entry || !entry.name) continue;
        if (/^set-cookie$/i.test(entry.name)) continue;
        out[entry.name] = entry.value || "";
      }
      return out;
    }

    function schedulePost(key, event, { delayMs = 0 } = {}) {
      const previous = timers.get(key);
      if (previous) {
        clearTimeoutFn(previous);
        timers.delete(key);
      }
      const timer = setTimeoutFn(() => {
        timers.delete(key);
        const current = recentEvents.get(key);
        if (current !== event) {
          return;
        }
        recentEvents.delete(key);
        Promise.resolve(postEvent(event)).catch(() => {});
      }, delayMs);
      if (timer && typeof timer.unref === "function") timer.unref();
      timers.set(key, timer);
    }


    return {
      handlePageScriptObservation,
      attachWebRequestObservation,
      attachWebRequestError,
      handleRuntimeMessage,
      correlationKey,
      _state,
      _reset,
      PENDING_PAGE_SCRIPT_TIMEOUT_MS
    };
  }

  function randomUUID() {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
    return `${randomHex(4)}-${randomHex(2)}-${randomHex(2)}-${randomHex(2)}-${randomHex(6)}`;
  }

  function randomHex(byteLength) {
    const bytes = new Uint8Array(byteLength);
    if (typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function") {
      crypto.getRandomValues(bytes);
    } else {
      for (let i = 0; i < byteLength; i += 1) bytes[i] = Math.floor(Math.random() * 256);
    }
    return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  }

  const api = { createCaptureController };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    globalThis.MobileApiConsoleCapture = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : self);
