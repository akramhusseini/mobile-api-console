"use strict";

// Parses `adb logcat -v threadtime` output emitted by the Android app's
// CurlLogger (tag = API_CURL).
//
// Each completed request produces up to THREE log shapes under the same tag:
//
//   1) Summary line:
//      [200] GET v1/users (245ms)
//      [ERR] POST messages (1.2s)
//
//   2) Multi-line curl, one logcat line per source line, e.g.:
//      curl -X GET \
//        -H 'Accept: application/json' \
//        'https://api.example.com/v1/users'
//
//   3) Optional response body, prefixed with `[BODY] ` on the first line only;
//      subsequent lines are raw body content split by logcat on `\n`:
//      [BODY] {
//        "data": [...]
//      }
//
// Response headers are not in this format; only status code (from the summary
// line) and body (from the [BODY] block when the app logs one) flow into
// event.response.
//
// Action shape returned from pushLine() matches MobileNetworkParser so the
// rest of the system stays platform-agnostic.

const THREADTIME_RE = /^\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}\.\d{3}\s+\d+\s+\d+\s+[VDIWEAF]\s+([^:]+):\s?(.*)$/;
const SUMMARY_RE = /^\[(\d{3}|ERR)\]\s+([A-Z]+)\s+(.+?)\s+\(([^)]+)\)\s*$/;
const CURL_START_RE = /^curl\s+(-X\s+)?[A-Z]/;
const BODY_START_RE = /^\[BODY\]\s?/;
const CHUNK_CONTINUATION_RE = /^\.{3}/;
const CLEAR_MARKERS = [
  "API_CONSOLE_CLEAR",
  "===== CONSOLE CLEARED =====",
  "CONSOLE_CLEARED"
];

class AndroidApiCurlParser {
  constructor({ logTag = "API_CURL" } = {}) {
    this.logTag = logTag;
    this.reset();
  }

  reset() {
    this.nextId = 1;
    this.activeEvent = null;
    this.curlLines = null; // null = not collecting; array = collecting
    this.bodyLines = null; // null = not collecting; array = collecting
  }

  pushLine(rawLine) {
    const message = this.extractMessage(rawLine);
    if (message === null) return [];

    const trimmed = message.trim();

    if (this.isClearMarker(trimmed)) {
      this.reset();
      return [{ type: "clear", reason: "log-marker" }];
    }

    const summary = trimmed.match(SUMMARY_RE);
    if (summary) {
      const actions = this.flushActive();
      this.activeEvent = this.startEvent({
        statusToken: summary[1],
        method: summary[2],
        apiName: summary[3].trim(),
        duration: summary[4].trim(),
        rawLine
      });
      this.beginCurlCollection();
      // Whatever follows under API_CURL is part of this event's curl, until the
      // next summary line or a clear marker. Snapshot AFTER activeEvent is set
      // so the first upsert carries the real id/method/status instead of an
      // empty object.
      actions.push({ type: "upsert", event: this.snapshotEvent() });
      return actions;
    }

    if (!this.activeEvent) {
      // Drop lines that arrive before we have any event opened.
      return [];
    }

    this.activeEvent.raw.push(rawLine);

    // `[BODY] ...` switches from curl-collection to body-collection. The
    // `[BODY]` prefix only appears on the first line; subsequent body lines
    // (logcat splits the JSON on `\n`) arrive unmarked.
    if (BODY_START_RE.test(trimmed)) {
      if (this.curlLines !== null) {
        this.finalizeCurlIntoEvent(this.activeEvent);
        this.curlLines = null;
      }
      const firstBodyLine = message.replace(BODY_START_RE, "");
      this.bodyLines = [firstBodyLine];
      return [];
    }

    if (this.bodyLines !== null) {
      appendLogcatLine(this.bodyLines, message);
      return [];
    }

    if (this.curlLines !== null) {
      appendLogcatLine(this.curlLines, message);
      return [];
    }

    if (CURL_START_RE.test(trimmed)) {
      this.beginCurlCollection();
      this.curlLines.push(message);
    }
    return [];
  }

  // Finalize whatever block is open (typically called via parser.flush() at
  // shutdown or before swapping sources).
  flush() {
    return this.flushActive();
  }

  // Backwards-compatible alias used by tests / collect helpers.
  finishActive() {
    return this.flushActive();
  }

  extractMessage(rawLine) {
    const value = String(rawLine || "").replace(/\r$/, "");
    if (!value) return null;
    if (value.startsWith("---------")) return null; // logcat session markers
    const match = value.match(THREADTIME_RE);
    if (match) {
      const tag = match[1].trim();
      if (tag !== this.logTag) return null;
      return match[2];
    }
    // Lines that don't match the threadtime prefix may come from `-v brief` or
    // similar; accept them only when no other prefix is plausible. For safety
    // here we drop them.
    return null;
  }

  isClearMarker(line) {
    return CLEAR_MARKERS.some((marker) => line.includes(marker));
  }

  beginCurlCollection() {
    this.curlLines = [];
  }

  startEvent({ statusToken, method, apiName, duration, rawLine }) {
    const now = new Date().toISOString();
    const statusCode = statusToken === "ERR" ? null : Number.parseInt(statusToken, 10);
    const state = statusToken === "ERR" || (statusCode != null && statusCode >= 400) ? "error" : "success";
    const event = {
      id: `android-${this.nextId++}`,
      createdAt: now,
      updatedAt: now,
      state,
      method: (method || "GET").toUpperCase(),
      url: "",
      host: "",
      path: apiName || "(unknown endpoint)",
      request: null,
      response: null,
      curl: "",
      statusCode,
      errors: statusToken === "ERR" ? ["Network error reported by app"] : [],
      raw: [rawLine],
      // Android-specific metadata; useful for UI hints and exports.
      meta: { source: "android", duration }
    };
    return event;
  }

  flushActive() {
    if (!this.activeEvent) return [];
    const event = this.activeEvent;

    if (this.curlLines && this.curlLines.length > 0) {
      this.finalizeCurlIntoEvent(event);
    }

    // Android's API_CURL format never logs response headers. The body comes
    // from the optional [BODY] block; if the app didn't log one, this stays
    // empty and the UI shows "(empty)".
    const body = this.bodyLines ? this.bodyLines.join("\n").trim() : "";
    event.response = {
      statusCode: event.statusCode,
      url: event.url,
      headers: {},
      body,
      meta: { source: "android-api-curl" }
    };

    event.updatedAt = new Date().toISOString();
    const upsertAction = { type: "upsert", event: { ...event } };

    this.activeEvent = null;
    this.curlLines = null;
    this.bodyLines = null;
    return [upsertAction];
  }

  finalizeCurlIntoEvent(event) {
    const command = this.curlLines.join("\n").trim();
    event.curl = command;
    const parsed = parseAndroidCurl(command);
    if (parsed.url) {
      event.url = parsed.url;
      const url = safeUrl(parsed.url);
      if (url) {
        event.host = url.host;
        event.path = `${url.pathname}${url.search}` || event.path;
      }
    }
    event.request = {
      url: event.url || parsed.url || "",
      method: parsed.method || event.method,
      headers: parsed.headers,
      body: parsed.body,
      raw: this.curlLines.slice()
    };
    if (parsed.method) event.method = parsed.method;
  }

  snapshotEvent() {
    return { ...this.activeEvent };
  }
}

function stripChunkContinuation(message) {
  return message.replace(CHUNK_CONTINUATION_RE, "");
}

// `logLongMessage` in the Android side splits long messages at 4000-char
// boundaries (often mid-token, mid-string-literal, etc.) and prefixes
// continuation chunks with `...`. Those continuation chunks must be glued
// back onto the previous line with NO newline in between — otherwise a
// chunk boundary that landed inside a JSON string yields an invalid JSON
// document and the UI falls back to the raw, un-prettified text. Lines
// without the `...` prefix are independent source lines (logcat split the
// original message on its real `\n` characters) and are joined normally.
function appendLogcatLine(buffer, message) {
  if (CHUNK_CONTINUATION_RE.test(message) && buffer.length > 0) {
    buffer[buffer.length - 1] += stripChunkContinuation(message);
    return;
  }
  buffer.push(message);
}

function safeUrl(value) {
  try {
    return new URL(value);
  } catch {
    return null;
  }
}

function parseAndroidCurl(command) {
  const result = { method: "GET", url: "", headers: {}, body: "" };

  const methodMatch = command.match(/curl\s+-X\s+([A-Za-z]+)/);
  if (methodMatch) result.method = methodMatch[1].toUpperCase();

  // Headers: -H 'Key: Value' — values that contain apostrophes survive as
  // the literal shell sequence '"'"', which we unwrap here.
  const headerRe = /-H\s+'((?:[^'\\]|'"'"')*)'/g;
  let headerMatch;
  while ((headerMatch = headerRe.exec(command)) !== null) {
    const raw = unescapeShellApos(headerMatch[1]);
    const sep = raw.indexOf(":");
    if (sep > 0) {
      const key = raw.slice(0, sep).trim();
      const value = raw.slice(sep + 1).trim();
      if (key) result.headers[key] = value;
    }
  }

  const bodyMatch = command.match(/-d\s+'((?:[^'\\]|'"'"')*)'/);
  if (bodyMatch) result.body = unescapeShellApos(bodyMatch[1]);

  const urlMatches = [...command.matchAll(/'(https?:\/\/[^']+)'/g)].map((m) => m[1]);
  if (urlMatches.length) result.url = urlMatches[urlMatches.length - 1];

  return result;
}

function unescapeShellApos(value) {
  return String(value).replace(/'"'"'/g, "'");
}

module.exports = {
  AndroidApiCurlParser,
  parseAndroidCurl,
  stripChunkContinuation
};
