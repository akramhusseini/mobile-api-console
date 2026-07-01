"use strict";

// Page-world patch. Runs inside the page's JavaScript context so it can
// observe fetch() and XMLHttpRequest bodies, headers, and timing.
//
// It DOES NOT POST to the console directly. The service worker is the only
// network sender. The page-world patch only dispatches CustomEvents on
// window, which the content script forwards to the SW.

(function () {
  if (window.__mobileApiConsolePatched) return;
  window.__mobileApiConsolePatched = true;

  const REQUEST_BODY_CAP = 1024 * 1024;
  const RESPONSE_BODY_CAP = 1024 * 1024;

  function uuid() {
    if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
      return crypto.randomUUID();
    }
    return "obs-" + Math.random().toString(16).slice(2) + "-" + Date.now().toString(16);
  }

  function truncate(value, cap) {
    if (value == null) return { body: null, truncated: false, available: true };
    if (typeof value !== "string") {
      return { body: null, truncated: false, available: false, reason: "binary" };
    }
    if (value.length > cap) {
      return { body: value.slice(0, cap), truncated: true, available: true };
    }
    return { body: value, truncated: false, available: true };
  }

  function safeStringifyBody(value) {
    if (value == null) return { body: null, available: true, truncated: false };
    if (typeof value === "string") {
      return truncate(value, REQUEST_BODY_CAP);
    }
    if (value instanceof URLSearchParams) {
      return truncate(value.toString(), REQUEST_BODY_CAP);
    }
    if (value instanceof FormData) {
      const out = {};
      for (const [key, val] of value.entries()) {
        out[key] = typeof val === "string" ? val : "[binary]";
      }
      return truncate(JSON.stringify(out), REQUEST_BODY_CAP);
    }
    if (value instanceof Blob || value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
      return { body: null, available: false, truncated: false, reason: "binary" };
    }
    try {
      return truncate(JSON.stringify(value), REQUEST_BODY_CAP);
    } catch {
      return { body: null, available: false, truncated: false, reason: "not-readable" };
    }
  }

  function headersObject(headers) {
    if (!headers) return {};
    if (typeof headers.forEach === "function") {
      const out = {};
      headers.forEach((value, key) => { out[key] = value; });
      return out;
    }
    if (Array.isArray(headers)) {
      const out = {};
      for (const [key, value] of headers) out[key] = value;
      return out;
    }
    if (typeof headers === "object") {
      return { ...headers };
    }
    return {};
  }

  function emit(detail) {
    try {
      window.dispatchEvent(new CustomEvent("mobile-api-console:observation", { detail }));
    } catch {
      // ignore
    }
  }

  // Normalize a URL string against the page's location so that a relative
  // `fetch("/api/echo")` becomes an absolute URL the SW can correlate
  // against the corresponding webRequest entry. webRequest always sees
  // absolute URLs, so any relative URL the page-world patch emits ends
  // up under a different correlation key and produces a duplicate row
  // for the same logical call.
  function absolutizeUrl(rawUrl) {
    if (typeof rawUrl !== "string" || !rawUrl) return "";
    try {
      return new URL(rawUrl, location.href).href;
    } catch {
      return rawUrl;
    }
  }

  // ---- fetch patching ----
  const originalFetch = window.fetch;
  if (typeof originalFetch === "function") {
    window.fetch = function patchedFetch(input, init) {
      const startedAt = Date.now();
      const method = (init && init.method) || (input && input.method) || "GET";
      const rawUrl = typeof input === "string"
        ? input
        : (input && input.url) || "";
      // Absolutize once so request and complete phases emit the same
      // URL the webRequest layer will see.
      const url = absolutizeUrl(rawUrl);
      const reqHeaders = headersObject((init && init.headers) || (input && input.headers));
      const reqBodyInfo = safeStringifyBody(init && init.body);
      const eventId = uuid();

      emit({
        eventId,
        phase: "request",
        initiator: location.origin,
        request: {
          startedAt,
          method: String(method).toUpperCase(),
          url: String(url),
          headers: reqHeaders,
          body: reqBodyInfo.body,
          bodyAvailable: reqBodyInfo.available,
          bodyTruncated: reqBodyInfo.truncated,
          bodyUnavailableReason: reqBodyInfo.reason || null
        },
        response: null,
        error: null,
        pageUrl: location.href
      });

      return originalFetch.apply(this, arguments).then(
        async (response) => {
          const completedAt = Date.now();
          const durationMs = completedAt - startedAt;
          let responseBody = null;
          let bodyAvailable = true;
          let bodyTruncated = false;
          let bodyUnavailableReason = null;

          try {
            const clone = response.clone();
            const text = await clone.text();
            const tr = truncate(text, RESPONSE_BODY_CAP);
            responseBody = tr.body;
            bodyTruncated = tr.truncated;
            bodyAvailable = tr.available;
            bodyUnavailableReason = tr.reason || null;
          } catch (error) {
            bodyAvailable = false;
            bodyUnavailableReason = "not-readable";
          }

          emit({
            eventId,
            phase: "complete",
            initiator: location.origin,
            request: null,
            response: {
              completedAt,
              durationMs,
              status: response.status,
              url: response.url || url,
              headers: headersObject(response.headers),
              body: responseBody,
              bodyAvailable,
              bodyTruncated,
              bodyUnavailableReason
            },
            error: null,
            pageUrl: location.href
          });
          return response;
        },
        (error) => {
          const completedAt = Date.now();
          emit({
            eventId,
            phase: "complete",
            initiator: location.origin,
            request: null,
            response: null,
            error: String(error && error.message ? error.message : error),
            pageUrl: location.href
          });
          throw error;
        }
      );
    };
  }

  // ---- XHR patching ----
  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;
  const originalSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader;

  XMLHttpRequest.prototype.open = function patchedOpen(method, url) {
    this.__mac = this.__mac || {};
    this.__mac.method = String(method || "GET").toUpperCase();
    this.__mac.url = absolutizeUrl(String(url || ""));
    this.__mac.headers = {};
    this.__mac.startedAt = Date.now();
    return originalOpen.apply(this, arguments);
  };

  XMLHttpRequest.prototype.setRequestHeader = function patchedSetRequestHeader(name, value) {
    if (this.__mac) this.__mac.headers[String(name)] = String(value);
    return originalSetRequestHeader.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function patchedSend(body) {
    if (!this.__mac) {
      return originalSend.apply(this, arguments);
    }
    const startedAt = this.__mac.startedAt;
    const method = this.__mac.method;
    const url = this.__mac.url;
    const reqHeaders = this.__mac.headers;
    const reqBodyInfo = safeStringifyBody(body);
    const eventId = uuid();

    emit({
      eventId,
      phase: "request",
      initiator: location.origin,
      request: {
        startedAt,
        method,
        url,
        headers: reqHeaders,
        body: reqBodyInfo.body,
        bodyAvailable: reqBodyInfo.available,
        bodyTruncated: reqBodyInfo.truncated,
        bodyUnavailableReason: reqBodyInfo.reason || null
      },
      response: null,
      error: null,
      pageUrl: location.href
    });

    this.addEventListener("loadend", () => {
      const completedAt = Date.now();
      const durationMs = completedAt - startedAt;
      let responseBody = null;
      let bodyAvailable = true;
      let bodyTruncated = false;
      let bodyUnavailableReason = null;
      try {
        if (this.responseType === "" || this.responseType === "text") {
          const text = this.responseText || "";
          const tr = truncate(text, RESPONSE_BODY_CAP);
          responseBody = tr.body;
          bodyTruncated = tr.truncated;
          bodyAvailable = tr.available;
          bodyUnavailableReason = tr.reason || null;
        } else {
          bodyAvailable = false;
          bodyUnavailableReason = "binary";
        }
      } catch {
        bodyAvailable = false;
        bodyUnavailableReason = "not-readable";
      }

      const responseHeaders = {};
      const raw = this.getAllResponseHeaders();
      if (typeof raw === "string" && raw) {
        for (const line of raw.split(/\r?\n/)) {
          const idx = line.indexOf(":");
          if (idx > 0) {
            responseHeaders[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
          }
        }
      }

      emit({
        eventId,
        phase: "complete",
        initiator: location.origin,
        request: null,
        response: {
          completedAt,
          durationMs,
          status: this.status,
          url: this.responseURL || url,
          headers: responseHeaders,
          body: responseBody,
          bodyAvailable,
          bodyTruncated,
          bodyUnavailableReason
        },
        error: null,
        pageUrl: location.href
      });
    });

    this.addEventListener("error", () => {
      emit({
        eventId,
        phase: "complete",
        initiator: location.origin,
        request: null,
        response: null,
        error: "XHR network error",
        pageUrl: location.href
      });
    });

    return originalSend.apply(this, arguments);
  };
})();
