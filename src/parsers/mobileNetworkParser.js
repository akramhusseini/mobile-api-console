"use strict";

const ANSI_RE = /\x1b\[[0-9;]*m/g;
const CLEAR_MARKERS = [
  "API_CONSOLE_CLEAR",
  "===== CONSOLE CLEARED =====",
  "CONSOLE_CLEARED"
];

class MobileNetworkParser {
  constructor({ processName = "ExampleMobileApp" } = {}) {
    this.processName = processName;
    this.reset();
  }

  reset() {
    this.nextId = 1;
    this.active = null;
    this.events = new Map();
    this.pending = [];
  }

  pushLine(rawLine) {
    const line = this.extractMessage(String(rawLine || ""));
    const trimmed = line.trim();
    const actions = [];

    if (!trimmed) {
      if (this.active) this.active.lines.push("");
      return actions;
    }

    if (this.isClearLine(trimmed)) {
      this.reset();
      return [{ type: "clear", reason: "log-marker" }];
    }

    const startKind = this.blockKind(trimmed);
    if (startKind) {
      actions.push(...this.finishActive());
      this.active = {
        kind: startKind,
        lines: [trimmed],
        raw: [rawLine],
        startedAt: new Date().toISOString()
      };
      return actions;
    }

    if (this.active) {
      this.active.lines.push(line);
      this.active.raw.push(rawLine);
      if (this.isSeparator(trimmed)) {
        actions.push(...this.finishActive());
      }
      return actions;
    }

    const errorMessage = this.parseStandaloneError(trimmed);
    if (errorMessage) {
      return [{ type: "error", message: errorMessage, rawLine }];
    }

    return actions;
  }

  finishActive() {
    if (!this.active) return [];
    const block = this.active;
    this.active = null;

    if (block.kind === "request" || block.kind === "multipartRequest") {
      const request = parseRequestBlock(block.lines, block.raw);
      return [this.createRequestEvent(request)];
    }

    if (block.kind === "curl") {
      const curl = parseCurlBlock(block.lines, block.raw);
      return [this.attachCurl(curl)];
    }

    if (block.kind === "response") {
      const response = parseResponseBlock(block.lines, block.raw);
      return [this.attachResponse(response)];
    }

    return [];
  }

  blockKind(line) {
    if (line.includes("===== MULTIPART REQUEST =====")) return "multipartRequest";
    if (line.includes("===== REQUEST =====")) return "request";
    if (line.includes("===== CURL COMMAND =====")) return "curl";
    if (line.includes("===== RESPONSE =====")) return "response";
    return "";
  }

  isSeparator(line) {
    return /^={8,}$/.test(line);
  }

  isClearLine(line) {
    return CLEAR_MARKERS.some((marker) => line.includes(marker));
  }

  extractMessage(line) {
    let value = line.replace(ANSI_RE, "").replace(/\r$/, "");
    value = unescapeAppleLog(value);

    if (value.startsWith("{")) {
      try {
        const parsed = JSON.parse(value);
        if (typeof parsed.eventMessage === "string") return this.extractMessage(parsed.eventMessage);
        if (typeof parsed.message === "string") return this.extractMessage(parsed.message);
      } catch {
        // Compact log lines are not JSON; keep the original line.
      }
    }

    const processPatterns = [
      `${this.processName}:`,
      `${this.processName}[`
    ];

    for (const pattern of processPatterns) {
      const index = value.indexOf(pattern);
      if (index >= 0) {
        if (pattern.endsWith("[")) {
          const close = value.indexOf("]", index);
          if (close >= 0) return value.slice(close + 1).replace(/^:\s*/, "").trimEnd();
        } else {
          return value.slice(index + pattern.length).trimEnd();
        }
      }
    }

    const tokens = [
      "===== MULTIPART REQUEST =====",
      "===== REQUEST =====",
      "===== CURL COMMAND =====",
      "===== RESPONSE =====",
      "Status Code:",
      "URL:",
      "Method:",
      "Headers:",
      "Body:",
      "curl -X"
    ];

    const tokenIndex = tokens
      .map((token) => value.indexOf(token))
      .filter((index) => index >= 0)
      .sort((a, b) => a - b)[0];

    if (Number.isInteger(tokenIndex)) return value.slice(tokenIndex).trimEnd();

    return value.trimEnd();
  }

  createRequestEvent(request) {
    const now = new Date().toISOString();
    const event = normalizeEvent({
      id: `api-${this.nextId++}`,
      createdAt: now,
      updatedAt: now,
      state: "pending",
      method: request.method || "GET",
      url: request.url || "",
      request,
      response: null,
      curl: "",
      statusCode: null,
      errors: [],
      raw: request.raw || []
    });

    this.events.set(event.id, event);
    this.pending.push(event.id);
    return { type: "upsert", event };
  }

  attachCurl(curl) {
    const event = this.findPendingEvent(curl.url, (candidate) => !candidate.curl)
      || this.latestPendingEvent((candidate) => !candidate.curl)
      || this.createSyntheticEvent();

    event.curl = curl.command;
    event.method = event.method || curl.method || "GET";
    event.url = event.url || curl.url || "";
    event.raw = appendRaw(event.raw, curl.raw);
    this.events.set(event.id, normalizeEvent(event));

    return { type: "upsert", event: this.events.get(event.id) };
  }

  attachResponse(response) {
    const event = this.findPendingEvent(response.url)
      || this.latestPendingEvent((candidate) => !candidate.response)
      || this.createSyntheticEvent();

    event.response = response;
    event.statusCode = response.statusCode;
    event.url = event.url || response.url || "";
    event.state = response.statusCode >= 400 ? "error" : "success";
    event.raw = appendRaw(event.raw, response.raw);

    if (response.statusCode >= 400) {
      const message = response.body
        ? `HTTP ${response.statusCode}: ${truncate(response.body, 220)}`
        : `HTTP ${response.statusCode}`;
      event.errors = [...(event.errors || []), message];
    }

    this.pending = this.pending.filter((id) => id !== event.id);
    this.events.set(event.id, normalizeEvent(event));

    return { type: "upsert", event: this.events.get(event.id) };
  }

  createSyntheticEvent() {
    const now = new Date().toISOString();
    const event = normalizeEvent({
      id: `api-${this.nextId++}`,
      createdAt: now,
      updatedAt: now,
      state: "pending",
      method: "GET",
      url: "",
      request: null,
      response: null,
      curl: "",
      statusCode: null,
      errors: [],
      raw: []
    });
    this.events.set(event.id, event);
    this.pending.push(event.id);
    return event;
  }

  findPendingEvent(url, predicate = () => true) {
    const normalizedUrl = normalizeUrl(url);
    for (let index = this.pending.length - 1; index >= 0; index -= 1) {
      const event = this.events.get(this.pending[index]);
      if (!event || !predicate(event)) continue;
      if (!normalizedUrl || normalizeUrl(event.url) === normalizedUrl) return event;
    }
    return null;
  }

  latestPendingEvent(predicate = () => true) {
    for (let index = this.pending.length - 1; index >= 0; index -= 1) {
      const event = this.events.get(this.pending[index]);
      if (event && predicate(event)) return event;
    }
    return null;
  }

  parseStandaloneError(line) {
    const lower = line.toLowerCase();
    const looksNetworkRelated = /(network|api|request|response|urlsession|decode|decoding|http)/i.test(line);
    const looksLikeError = /(error|failed|failure|exception|networkerror|decodingerror)/i.test(lower);
    if (looksNetworkRelated && looksLikeError) return line;
    return "";
  }
}

function parseRequestBlock(lines, raw) {
  return {
    url: findField(lines, "URL"),
    method: findField(lines, "Method"),
    headers: parseHeaders(lines),
    body: parseBody(lines),
    raw
  };
}

function parseResponseBlock(lines, raw) {
  return {
    statusCode: Number.parseInt(findField(lines, "Status Code") || "0", 10) || null,
    url: findField(lines, "URL"),
    headers: parseHeaders(lines),
    body: parseBody(lines),
    raw
  };
}

function parseCurlBlock(lines, raw) {
  const bodyLines = lines
    .filter((line) => !line.includes("===== CURL COMMAND ====="))
    .filter((line) => !/^={8,}$/.test(line.trim()));
  const command = bodyLines.join("\n").trim();
  const methodMatch = command.match(/curl\s+-X\s+([A-Z]+)/i);
  const urls = [...command.matchAll(/'(https?:\/\/[^']+)'/g)].map((match) => match[1]);
  return {
    command,
    method: methodMatch ? methodMatch[1].toUpperCase() : "",
    url: urls[urls.length - 1] || "",
    raw
  };
}

function findField(lines, label) {
  const prefix = `${label}:`;
  for (const line of lines) {
    const index = line.indexOf(prefix);
    if (index >= 0) return line.slice(index + prefix.length).trim();
  }
  return "";
}

function parseHeaders(lines) {
  const headers = {};
  let inHeaders = false;

  for (const line of lines) {
    const trimmed = line.trim();

    if (trimmed === "Headers:") {
      inHeaders = true;
      continue;
    }

    if (!inHeaders) continue;
    if (!trimmed || trimmed === "Body:" || /^={8,}$/.test(trimmed)) break;
    if (/^(URL|Method|Status Code|Body):/.test(trimmed)) break;

    const match = line.match(/(?:^|\s{2})([A-Za-z0-9-]+):\s*(.*)$/);
    if (!match) continue;
    headers[match[1]] = match[2];
  }

  return headers;
}

function parseBody(lines) {
  const bodyStart = lines.findIndex((line) => line.includes("Body:"));
  if (bodyStart < 0) return "";

  const firstLine = lines[bodyStart];
  const inline = firstLine.slice(firstLine.indexOf("Body:") + "Body:".length).trim();
  const bodyLines = inline ? [inline] : [];

  for (let index = bodyStart + 1; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^={8,}$/.test(line.trim())) break;
    bodyLines.push(line);
  }

  return bodyLines.join("\n").trim();
}

function normalizeEvent(event) {
  const parsed = parseUrl(event.url);
  const errors = event.errors || [];
  return {
    ...event,
    host: parsed.host,
    path: parsed.path || event.path || "(unknown endpoint)",
    state: errors.length ? "error" : event.state,
    errors
  };
}

function parseUrl(value) {
  if (!value) return { host: "", path: "" };
  try {
    const url = new URL(value);
    return {
      host: url.host,
      path: `${url.pathname}${url.search}`
    };
  } catch {
    return { host: "", path: value };
  }
}

function normalizeUrl(value) {
  return (value || "").trim();
}

function appendRaw(current = [], next = []) {
  return [...current, ...next].slice(-250);
}

function truncate(value, maxLength) {
  if (!value || value.length <= maxLength) return value || "";
  return `${value.slice(0, maxLength - 1)}...`;
}

// Apple's unified log compact output escapes bytes outside the printable
// ASCII range (and the backslash itself) as `\NNN` octal. The most common
// hit is `\134` -> `\`, which corrupts multi-line cURL line-continuations.
// Convert any printable-ASCII octal escape back to its original byte.
function unescapeAppleLog(value) {
  if (!value || !value.includes("\\")) return value;
  return value.replace(/\\([0-3][0-7]{2})/g, (match, oct) => {
    const code = Number.parseInt(oct, 8);
    if (code >= 0x20 && code <= 0x7e) return String.fromCharCode(code);
    return match;
  });
}

module.exports = { MobileNetworkParser };
