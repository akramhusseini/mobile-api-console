"use strict";

// Normalizes the wire format documented in `docs/BROWSER_SETUP.md` into the
// standard event shape used by the rest of the console (the same shape the
// iOS / Android parsers produce). The wire format is two-phase:
//
//   1) `phase: "request"` upsert when a fetch / XHR fires, with the
//      caller's request metadata and (best-effort) request body.
//   2) `phase: "complete"` (or error) upsert when the call finishes,
//      carrying the response, status, headers, and body.
//
// Both phases share the same `eventId`, which the server uses as the
// client_event_id for the upsert key.

const KNOWN_SOURCE_KINDS = new Set(["browser-chromium", "browser-gecko", "browser-webkit"]);
const KNOWN_CAPTURE_MODES = new Set(["page-script", "web-request", "merged"]);
const KNOWN_BODY_REASONS = new Set([
  null,
  "binary",
  "opaque-response",
  "csp-blocked",
  "service-worker-only",
  "too-large",
  "not-readable"
]);

class BrowserEventParser {
  constructor({} = {}) {
    // No state: the wire format carries enough information per POST.
  }

  reset() {
    // No state.
  }

  pushLine(_rawLine) {
    // Browser events do not arrive as log lines. The HTTP ingest path
    // calls normalizeEvent() directly.
    return [];
  }

  flush() {
    return [];
  }

  finishActive() {
    return [];
  }

  // Normalize one wire-format event into the standard event shape used by
  // the storage and UI layers. Returns the normalized event so the server
  // handler can upsert it; throws on schema violations.
  normalizeEvent(wireEvent) {
    if (!wireEvent || typeof wireEvent !== "object") {
      throw new Error("Browser event must be an object");
    }
    if (wireEvent.v !== 1) {
      throw new Error(`Unsupported schema version: ${wireEvent.v}`);
    }
    if (!KNOWN_SOURCE_KINDS.has(wireEvent.sourceKind)) {
      throw new Error(`Unknown sourceKind: ${wireEvent.sourceKind}`);
    }
    if (typeof wireEvent.eventId !== "string" || !wireEvent.eventId) {
      throw new Error("eventId is required");
    }
    if (!["request", "complete"].includes(wireEvent.phase)) {
      throw new Error(`Invalid phase: ${wireEvent.phase}`);
    }
    if (wireEvent.captureMode && !KNOWN_CAPTURE_MODES.has(wireEvent.captureMode)) {
      throw new Error(`Invalid captureMode: ${wireEvent.captureMode}`);
    }
    const browserSession = wireEvent.browserSession || {};
    if (!browserSession.origin || !browserSession.profileId || !browserSession.context) {
      throw new Error("browserSession.origin, profileId, and context are required");
    }
    if (!["regular", "incognito"].includes(browserSession.context)) {
      throw new Error(`Invalid browserSession.context: ${browserSession.context}`);
    }

    const request = normalizeRequestSide(wireEvent.request);
    const response = normalizeResponseSide(wireEvent.response);
    const error = wireEvent.error ? String(wireEvent.error) : null;
    const metadata = wireEvent.metadata || {};
    const captureMode = wireEvent.captureMode || "page-script";
    const tabId = Number.isInteger(wireEvent.tabId) ? wireEvent.tabId : null;

    const startedAt = request.startedAt || null;
    const completedAt = response?.completedAt || null;
    const durationMs = response?.durationMs || null;

    let statusCode = null;
    let state = "pending";
    if (response && response.status != null) {
      statusCode = response.status;
      state = statusCode >= 400 ? "error" : "success";
    }
    if (error) {
      state = "error";
    }

    const finalUrl = request.url || response?.url || "";
    const parsed = parseUrl(finalUrl);
    const errors = [];
    if (error) errors.push(error);
    if (state === "error" && statusCode && !error) {
      errors.push(`HTTP ${statusCode}`);
    }

    const raw = [
      `[browser] phase=${wireEvent.phase} captureMode=${captureMode} eventId=${wireEvent.eventId}`,
      `origin=${browserSession.origin} profileId=${browserSession.profileId} context=${browserSession.context}`,
      tabId != null ? `tabId=${tabId}` : null,
      metadata.pageUrl ? `pageUrl=${metadata.pageUrl}` : null,
      metadata.webRequestId ? `webRequestId=${metadata.webRequestId}` : null,
      `startedAt=${startedAt || ""} completedAt=${completedAt || ""} durationMs=${durationMs || ""}`
    ].filter(Boolean);

    const now = new Date().toISOString();
    const event = {
      id: wireEvent.eventId,
      createdAt: startedAt ? new Date(startedAt).toISOString() : now,
      updatedAt: completedAt ? new Date(completedAt).toISOString() : now,
      startedAt: startedAt ? new Date(startedAt).toISOString() : null,
      finishedAt: completedAt ? new Date(completedAt).toISOString() : null,
      state,
      // The wire event carries the method on the request side. We do
      // NOT default a missing request.method to "GET": doing so would
      // let a complete-phase wire event with request:null silently
      // overwrite a POST/DELETE/etc. recorded by the request phase.
      // Instead we pass null and rely on the storage COALESCE to
      // preserve the prior value when the row already exists.
      method: request.method ? request.method.toUpperCase() : null,
      url: finalUrl,
      host: parsed.host,
      path: parsed.path || "/(unknown endpoint)",
      request: request.normalized,
      response: response?.normalized || null,
      curl: "",
      statusCode,
      errors,
      raw,
      meta: {
        source: "browser",
        sourceKind: wireEvent.sourceKind,
        captureMode,
        browserSession: { ...browserSession },
        tabId,
        pageUrl: metadata.pageUrl || null,
        initiator: metadata.initiator || null,
        webRequestId: metadata.webRequestId || null,
        durationMs,
        phase: wireEvent.phase
      }
    };
    return event;
  }

  // The server uses eventId as the client_event_id for upsert, so two-phase
  // events land in the same row.
  clientEventIdFor(wireEvent) {
    return wireEvent.eventId;
  }

  // The server needs a stable session key for this event so it can route
  // it to the right (origin, profileId, context) browser session.
  sessionKeyFor(wireEvent) {
    const session = wireEvent.browserSession || {};
    return `browser::${session.origin}::${session.profileId}::${session.context}`;
  }

  // Same derivation for the session source-metadata blob.
  sourceMetadataFor(wireEvent) {
    return {
      sourceKey: "browser",
      sourceKind: wireEvent.sourceKind,
      browserSession: { ...wireEvent.browserSession },
      tabId: Number.isInteger(wireEvent.tabId) ? wireEvent.tabId : null,
      pageUrl: wireEvent.metadata?.pageUrl || null
    };
  }
}

function normalizeRequestSide(rawRequest) {
  if (!rawRequest || typeof rawRequest !== "object") return { startedAt: null, method: null, url: "", normalized: null };
  const startedAt = Number.isFinite(rawRequest.startedAt) ? rawRequest.startedAt : null;
  const method = rawRequest.method ? String(rawRequest.method) : null;
  const url = typeof rawRequest.url === "string" ? rawRequest.url : "";
  const headers = rawRequest.headers && typeof rawRequest.headers === "object" ? rawRequest.headers : {};
  const body = typeof rawRequest.body === "string" ? rawRequest.body : null;
  const bodyAvailable = rawRequest.bodyAvailable !== false;
  const bodyTruncated = Boolean(rawRequest.bodyTruncated);
  const bodyUnavailableReason = bodyAvailable ? null : sanitizeReason(rawRequest.bodyUnavailableReason);

  return {
    startedAt,
    method,
    url,
    normalized: {
      // Same rule as the top-level event.method: no default to "GET".
      // See normalizeEvent for the rationale. Callers that need a
      // display string should treat null as "unknown".
      method,
      url,
      headers,
      body,
      bodyAvailable,
      bodyTruncated,
      bodyUnavailableReason
    }
  };
}

function normalizeResponseSide(rawResponse) {
  if (!rawResponse || typeof rawResponse !== "object") return null;
  const completedAt = Number.isFinite(rawResponse.completedAt) ? rawResponse.completedAt : null;
  const durationMs = Number.isFinite(rawResponse.durationMs) ? rawResponse.durationMs : null;
  const status = Number.isInteger(rawResponse.status) ? rawResponse.status : null;
  const headers = rawResponse.headers && typeof rawResponse.headers === "object" ? rawResponse.headers : {};
  const body = typeof rawResponse.body === "string" ? rawResponse.body : null;
  const bodyAvailable = rawResponse.bodyAvailable !== false;
  const bodyTruncated = Boolean(rawResponse.bodyTruncated);
  const bodyUnavailableReason = bodyAvailable ? null : sanitizeReason(rawResponse.bodyUnavailableReason);

  return {
    completedAt,
    durationMs,
    status,
    url: typeof rawResponse.url === "string" ? rawResponse.url : "",
    normalized: {
      statusCode: status,
      url: typeof rawResponse.url === "string" ? rawResponse.url : "",
      headers,
      body,
      bodyAvailable,
      bodyTruncated,
      bodyUnavailableReason
    }
  };
}

function sanitizeReason(reason) {
  if (reason == null) return null;
  const text = String(reason);
  return KNOWN_BODY_REASONS.has(text) ? text : "not-readable";
}

function parseUrl(value) {
  if (!value) return { host: "", path: "" };
  try {
    const url = new URL(value);
    return { host: url.host, path: `${url.pathname}${url.search}` };
  } catch {
    return { host: "", path: value };
  }
}

module.exports = { BrowserEventParser };
