"use strict";

const Database = require("better-sqlite3");
const { normalizeCaptureUrl, normalizeCapturedEvent, normalizeHttpMethod, splitCaptureLines } = require("../captureNormalization");

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const DEFAULT_BODY_LIMIT = 20_000;
const MAX_BODY_LIMIT = 200_000;
const SENSITIVE_KEY = /^(authorization|proxy-authorization|cookie|set-cookie|x-api-key|api-key|apikey|access[_-]?token|refresh[_-]?token|token|password|passwd|secret|client[_-]?secret)$/i;
const PLATFORM_SQL = `CASE
  WHEN s.source_kind LIKE 'ios-%' THEN 'ios'
  WHEN s.source_kind LIKE 'android-%' THEN 'android'
  WHEN s.source_kind LIKE 'browser-%' THEN 'browser'
  WHEN s.source_kind = 'demo' THEN 'demo'
  ELSE 'other'
END`;
const DEVICE_SQL = `TRIM(
  COALESCE(json_extract(s.source_metadata, '$.deviceName'), '') || ' ' ||
  COALESCE(json_extract(s.source_metadata, '$.udid'), '') || ' ' ||
  COALESCE(json_extract(s.source_metadata, '$.deviceSerial'), '') || ' ' ||
  COALESCE(json_extract(s.source_metadata, '$.simulator'), '') || ' ' ||
  COALESCE(json_extract(s.source_metadata, '$.browserSession.profileId'), '') || ' ' ||
  COALESCE(s.label, '')
)`;
const EVENT_TIME_SQL = "COALESCE(e.started_at, e.created_at)";
const SESSION_TIME_SQL = "COALESCE(s.started_at, s.created_at)";
const METHOD_SQL = `UPPER(TRIM(CASE
  WHEN instr(COALESCE(e.method, ''), char(10)) > 0
    THEN substr(e.method, 1, instr(e.method, char(10)) - 1)
  WHEN instr(COALESCE(e.method, ''), char(13)) > 0
    THEN substr(e.method, 1, instr(e.method, char(13)) - 1)
  WHEN instr(COALESCE(e.method, ''), '\\r\\n') > 0
    THEN substr(e.method, 1, instr(e.method, '\\r\\n') - 1)
  WHEN instr(COALESCE(e.method, ''), '\\n') > 0
    THEN substr(e.method, 1, instr(e.method, '\\n') - 1)
  ELSE COALESCE(e.method, '')
END))`;

class ApiConsoleQueryService {
  constructor({ databasePath } = {}) {
    if (!databasePath) throw new Error("databasePath is required");
    this.databasePath = databasePath;
    this.db = new Database(databasePath, { readonly: true, fileMustExist: true });
    this.db.pragma("query_only = ON");
  }

  close() {
    if (this.db) this.db.close();
  }

  catalog(filters = {}) {
    const { where, params, resolvedTimeRange } = buildEventWhere(filters);
    const join = "FROM events e JOIN sessions s ON s.id = e.session_id";
    const stats = this.db.prepare(`
      SELECT
        COUNT(*) AS event_count,
        COUNT(DISTINCT e.session_id) AS session_count,
        MIN(${EVENT_TIME_SQL}) AS first_event_at,
        MAX(${EVENT_TIME_SQL}) AS last_event_at,
        SUM(CASE WHEN e.state = 'error' OR e.status_code >= 400 THEN 1 ELSE 0 END) AS error_count
      ${join}
      ${where}
    `).get(params);

    return {
      readOnly: true,
      timeRange: resolvedTimeRange,
      counts: camelizeRow(stats),
      platforms: this.#distinct(`${PLATFORM_SQL}`, join, where, params, "platform"),
      sourceKinds: this.#distinct("s.source_kind", join, where, params, "sourceKind"),
      devices: this.#distinct(DEVICE_SQL, join, where, params, "device"),
      browserOrigins: this.#distinct("json_extract(s.source_metadata, '$.browserSession.origin')", join, where, params, "browserOrigin"),
      browserProfiles: this.#distinct("json_extract(s.source_metadata, '$.browserSession.profileId')", join, where, params, "browserProfileId"),
      methods: this.#distinct(METHOD_SQL, join, where, params, "method"),
      hosts: this.#distinct("e.host", join, where, params, "host"),
      statusCodes: this.#distinct("e.status_code", join, where, params, "statusCode")
    };
  }

  listSessions(filters = {}) {
    const limit = normalizedLimit(filters.limit);
    const cursor = decodeCursor(filters.cursor, "session");
    const { clauses, params, resolvedTimeRange } = buildSessionClauses(filters);
    if (cursor) {
      clauses.push(`(${SESSION_TIME_SQL} < @cursorTime OR (${SESSION_TIME_SQL} = @cursorTime AND s.id < @cursorId))`);
      params.cursorTime = cursor.time;
      params.cursorId = cursor.id;
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.db.prepare(`
      SELECT s.*
      FROM sessions s
      ${where}
      ORDER BY ${SESSION_TIME_SQL} DESC, s.id DESC
      LIMIT @limit
    `).all({ ...params, limit: limit + 1 });
    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit).map(sessionSummary);
    const last = rows[Math.min(rows.length, limit) - 1];

    return {
      timeRange: resolvedTimeRange,
      items: page,
      nextCursor: hasMore && last
        ? encodeCursor({ kind: "session", time: last.started_at || last.created_at, id: last.id })
        : null
    };
  }

  searchEvents(filters = {}) {
    const limit = normalizedLimit(filters.limit);
    const cursor = decodeCursor(filters.cursor, "event");
    const { clauses, params, resolvedTimeRange } = buildEventClauses(filters);
    if (cursor) {
      clauses.push(`(${EVENT_TIME_SQL} < @cursorTime OR (${EVENT_TIME_SQL} = @cursorTime AND e.id < @cursorId))`);
      params.cursorTime = cursor.time;
      params.cursorId = cursor.id;
    }
    const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
    const rows = this.db.prepare(`
      SELECT
        e.id AS row_id,
        e.client_event_id,
        e.session_id,
        e.method,
        e.url,
        e.host,
        e.path,
        e.status_code,
        e.state,
        e.started_at,
        e.finished_at,
        e.request_json,
        e.response_json,
        e.errors_json,
        e.meta_json,
        e.created_at,
        e.updated_at,
        s.label AS session_label,
        s.source_kind,
        s.source_metadata
      FROM events e
      JOIN sessions s ON s.id = e.session_id
      ${where}
      ORDER BY ${EVENT_TIME_SQL} DESC, e.id DESC
      LIMIT @limit
    `).all({ ...params, limit: limit + 1 });
    const hasMore = rows.length > limit;
    const pageRows = rows.slice(0, limit);
    const last = pageRows[pageRows.length - 1];
    const result = {
      timeRange: resolvedTimeRange,
      items: pageRows.map(eventSummary),
      nextCursor: hasMore && last
        ? encodeCursor({ kind: "event", time: last.started_at || last.created_at, id: last.row_id })
        : null
    };

    if (filters.includeTotal === true) {
      result.total = this.db.prepare(`
        SELECT COUNT(*) AS count
        FROM events e JOIN sessions s ON s.id = e.session_id
        ${where}
      `).get(params).count;
    }
    return result;
  }

  getEvent({ eventId, sessionId = null, include = {}, maxBodyChars = DEFAULT_BODY_LIMIT } = {}) {
    if (!eventId) throw new Error("eventId is required");
    const bodyLimit = Math.max(0, Math.min(Number(maxBodyChars) || DEFAULT_BODY_LIMIT, MAX_BODY_LIMIT));
    const params = { eventId: String(eventId) };
    const sessionClause = sessionId == null ? "" : "AND e.session_id = @sessionId";
    if (sessionId != null) params.sessionId = Number(sessionId);
    const row = this.db.prepare(`
      SELECT e.*, e.id AS row_id, s.label AS session_label, s.source_kind, s.source_metadata
      FROM events e
      JOIN sessions s ON s.id = e.session_id
      WHERE e.client_event_id = @eventId ${sessionClause}
      ORDER BY e.updated_at DESC, e.id DESC
      LIMIT 1
    `).get(params);
    if (!row) return null;

    const request = safeJson(row.request_json);
    const response = safeJson(row.response_json);
    const detail = {
      ...eventSummary(row),
      kind: row.kind,
      request: selectMessageParts(request, include, "request", bodyLimit),
      response: selectMessageParts(response, include, "response", bodyLimit),
      errors: include.errors === false ? undefined : redactValue(safeJson(row.errors_json)),
      curl: include.curl === true ? redactCurl(row.curl || "") : undefined,
      raw: include.raw === true ? redactValue(safeJson(row.raw_json)) : undefined,
      capture: include.captureMetadata === false ? undefined : redactValue(safeJson(row.meta_json))
    };
    return dropUndefined(detail);
  }

  summarizeEvents(filters = {}) {
    const groupBy = filters.groupBy || "endpoint";
    const limit = Math.max(1, Math.min(Number(filters.limit) || 25, 100));
    const { where, params, resolvedTimeRange } = buildEventWhere(filters);
    const group = summaryGroup(groupBy);
    const rows = this.db.prepare(`
      SELECT
        ${group.expression} AS group_value,
        COUNT(*) AS call_count,
        SUM(CASE WHEN e.state = 'error' OR e.status_code >= 400 THEN 1 ELSE 0 END) AS error_count,
        ROUND(AVG(${durationSql()}), 1) AS average_duration_ms,
        ROUND(MAX(${durationSql()}), 1) AS maximum_duration_ms,
        MIN(${EVENT_TIME_SQL}) AS first_event_at,
        MAX(${EVENT_TIME_SQL}) AS last_event_at
      FROM events e
      JOIN sessions s ON s.id = e.session_id
      ${where}
      GROUP BY ${group.expression}
      ORDER BY call_count DESC, group_value ASC
      LIMIT @summaryLimit
    `).all({ ...params, summaryLimit: limit });

    return {
      timeRange: resolvedTimeRange,
      groupBy,
      items: rows.map((row) => ({
        group: row.group_value ?? "unknown",
        ...camelizeRow({
          call_count: row.call_count,
          error_count: row.error_count,
          average_duration_ms: row.average_duration_ms,
          maximum_duration_ms: row.maximum_duration_ms,
          first_event_at: row.first_event_at,
          last_event_at: row.last_event_at
        })
      }))
    };
  }

  #distinct(expression, join, where, params, name) {
    return this.db.prepare(`
      SELECT ${expression} AS value, COUNT(*) AS count
      ${join}
      ${where}
      GROUP BY ${expression}
      HAVING value IS NOT NULL AND value != ''
      ORDER BY count DESC, value ASC
      LIMIT 200
    `).all(params).map((row) => ({ [name]: row.value, count: row.count }));
  }
}

function buildEventWhere(filters) {
  const built = buildEventClauses(filters);
  return {
    ...built,
    where: built.clauses.length ? `WHERE ${built.clauses.join(" AND ")}` : ""
  };
}

function buildEventClauses(filters = {}) {
  const clauses = [];
  const params = {};
  const resolvedTimeRange = addTimeClauses(clauses, params, filters, EVENT_TIME_SQL);
  addSourceClauses(clauses, params, filters);
  addArrayClause(clauses, params, "e.session_id", "sessionIds", filters.sessionIds, Number);
  addArrayClause(clauses, params, METHOD_SQL, "methods", filters.methods, (value) => String(value).toUpperCase());
  addArrayClause(clauses, params, "e.status_code", "statusCodes", filters.statusCodes, Number);
  addArrayClause(clauses, params, "e.state", "states", filters.states, String);
  if (filters.statusClass) {
    const start = Number(String(filters.statusClass)[0]) * 100;
    clauses.push("e.status_code BETWEEN @statusStart AND @statusEnd");
    params.statusStart = start;
    params.statusEnd = start + 99;
  }
  if (filters.host) {
    clauses.push("LOWER(e.host) = LOWER(@host)");
    params.host = filters.host;
  }
  if (filters.pathContains) {
    clauses.push("LOWER(COALESCE(e.path, e.url, '')) LIKE LOWER(@pathContains)");
    params.pathContains = `%${escapeLike(filters.pathContains)}%`;
  }
  if (filters.query) {
    clauses.push(`LOWER(COALESCE(e.url, '') || ' ' || COALESCE(e.path, '') || ' ' || COALESCE(e.host, '') || ' ' || COALESCE(e.request_json, '') || ' ' || COALESCE(e.response_json, '') || ' ' || COALESCE(e.errors_json, '')) LIKE LOWER(@query) ESCAPE '\\'`);
    params.query = `%${escapeLike(filters.query)}%`;
  }
  if (filters.hasResponse === true) clauses.push("e.response_json IS NOT NULL");
  if (filters.hasResponse === false) clauses.push("e.response_json IS NULL");
  if (filters.includeHeartbeats !== true) {
    clauses.push("COALESCE(e.path, e.url, '') NOT LIKE '%/online/heartbeat%'");
  }
  return { clauses, params, resolvedTimeRange };
}

function buildSessionClauses(filters = {}) {
  const clauses = [];
  const params = {};
  const resolvedTimeRange = addTimeClauses(clauses, params, filters, SESSION_TIME_SQL);
  addSourceClauses(clauses, params, filters);
  if (filters.openOnly === true) clauses.push("s.ended_at IS NULL");
  if (filters.withEventsOnly !== false) clauses.push("s.event_count > 0");
  return { clauses, params, resolvedTimeRange };
}

function addSourceClauses(clauses, params, filters) {
  if (filters.platform) {
    clauses.push(`${PLATFORM_SQL} = @platform`);
    params.platform = filters.platform;
  }
  addArrayClause(clauses, params, "s.source_kind", "sourceKinds", filters.sourceKinds, String);
  if (filters.device) {
    clauses.push(`LOWER(${DEVICE_SQL}) LIKE LOWER(@device) ESCAPE '\\'`);
    params.device = `%${escapeLike(filters.device)}%`;
  }
  if (filters.browserOrigin) {
    clauses.push("LOWER(COALESCE(json_extract(s.source_metadata, '$.browserSession.origin'), '')) LIKE LOWER(@browserOrigin) ESCAPE '\\'");
    params.browserOrigin = `%${escapeLike(filters.browserOrigin)}%`;
  }
  if (filters.browserProfileId) {
    clauses.push("json_extract(s.source_metadata, '$.browserSession.profileId') = @browserProfileId");
    params.browserProfileId = filters.browserProfileId;
  }
  if (filters.browserContext) {
    clauses.push("json_extract(s.source_metadata, '$.browserSession.context') = @browserContext");
    params.browserContext = filters.browserContext;
  }
}

function addTimeClauses(clauses, params, filters, column) {
  const range = resolveTimeRange(filters);
  if (range.from) {
    clauses.push(`${column} >= @fromTime`);
    params.fromTime = range.from;
  }
  if (range.to) {
    clauses.push(`${column} < @toTime`);
    params.toTime = range.to;
  }
  return range;
}

function resolveTimeRange(filters = {}, now = new Date()) {
  if (filters.day) return dayRange(filters.day, filters.timeZone);
  if (filters.lastMinutes) {
    const minutes = Math.max(1, Number(filters.lastMinutes));
    return { from: new Date(now.getTime() - minutes * 60_000).toISOString(), to: now.toISOString(), timeZone: "UTC" };
  }
  return {
    from: normalizeIso(filters.from),
    to: normalizeIso(filters.to),
    timeZone: filters.timeZone || null
  };
}

function dayRange(day, timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC") {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(day));
  if (!match) throw new Error("day must use YYYY-MM-DD");
  const parts = { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
  const nextDate = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + 1));
  const next = { year: nextDate.getUTCFullYear(), month: nextDate.getUTCMonth() + 1, day: nextDate.getUTCDate() };
  return {
    from: zonedMidnightToUtc(parts, timeZone).toISOString(),
    to: zonedMidnightToUtc(next, timeZone).toISOString(),
    timeZone,
    day: String(day)
  };
}

function zonedMidnightToUtc(parts, timeZone) {
  let utc = Date.UTC(parts.year, parts.month - 1, parts.day, 0, 0, 0);
  for (let attempt = 0; attempt < 2; attempt += 1) {
    utc = Date.UTC(parts.year, parts.month - 1, parts.day, 0, 0, 0) - timeZoneOffsetMs(new Date(utc), timeZone);
  }
  return new Date(utc);
}

function timeZoneOffsetMs(date, timeZone) {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    hourCycle: "h23"
  });
  const values = Object.fromEntries(formatter.formatToParts(date).filter((part) => part.type !== "literal").map((part) => [part.type, part.value]));
  const asUtc = Date.UTC(Number(values.year), Number(values.month) - 1, Number(values.day), Number(values.hour), Number(values.minute), Number(values.second));
  return asUtc - date.getTime();
}

function normalizeIso(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`Invalid ISO date/time: ${value}`);
  return date.toISOString();
}

function addArrayClause(clauses, params, expression, name, values, transform) {
  if (!Array.isArray(values) || values.length === 0) return;
  const safeValues = values.slice(0, 100).map(transform);
  const placeholders = safeValues.map((_, index) => `@${name}${index}`);
  safeValues.forEach((value, index) => { params[`${name}${index}`] = value; });
  clauses.push(`${expression} IN (${placeholders.join(", ")})`);
}

function sessionSummary(row) {
  const metadata = safeJson(row.source_metadata) || {};
  return {
    id: row.id,
    label: row.label,
    platform: platformFor(row.source_kind),
    sourceKind: row.source_kind,
    device: deviceFor(metadata, row.label),
    browser: metadata.browserSession || undefined,
    processName: metadata.processName,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    isOpen: row.ended_at == null,
    eventCount: row.event_count
  };
}

function eventSummary(row) {
  const normalized = normalizeCapturedEvent(row);
  const sourceMetadata = safeJson(row.source_metadata) || {};
  const request = safeJson(row.request_json);
  const response = safeJson(row.response_json);
  const errors = safeJson(row.errors_json);
  const capture = safeJson(row.meta_json) || {};
  return dropUndefined({
    eventId: row.client_event_id,
    sessionId: row.session_id,
    method: normalized.method || "unknown",
    url: redactUrl(normalized.url),
    host: normalized.host,
    path: redactUrl(normalized.path),
    statusCode: row.status_code,
    state: row.state,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    durationMs: durationMs(row, capture),
    updatedAt: row.updated_at,
    platform: platformFor(row.source_kind),
    sourceKind: row.source_kind,
    device: deviceFor(sourceMetadata, row.session_label),
    browser: sourceMetadata.browserSession,
    sessionLabel: row.session_label,
    hasRequestBody: Boolean(request && request.body !== null && request.body !== undefined && request.body !== ""),
    hasResponse: Boolean(response),
    hasResponseBody: Boolean(response && response.body !== null && response.body !== undefined && response.body !== ""),
    errorCount: Array.isArray(errors) ? errors.length : 0
  });
}

function selectMessageParts(message, include, prefix, bodyLimit) {
  if (!message) return null;
  const includeHeaders = include[`${prefix}Headers`] === true;
  const includeBody = include[`${prefix}Body`] === true;
  const selected = {
    method: message.method ? normalizeHttpMethod(message.method, { fallback: "unknown" }) : undefined,
    url: redactUrl(normalizeCaptureUrl(message.url)),
    statusCode: message.statusCode,
    bodyAvailable: message.bodyAvailable,
    bodyTruncated: message.bodyTruncated,
    bodyUnavailableReason: message.bodyUnavailableReason,
    headers: includeHeaders ? redactHeaders(message.headers) : undefined,
    body: includeBody ? limitedBody(message.body, bodyLimit) : undefined
  };
  return dropUndefined(selected);
}

function limitedBody(body, limit) {
  if (body === null || body === undefined) return body;
  const text = typeof body === "string" ? body : JSON.stringify(body);
  const truncated = text.length > limit;
  const parsed = truncated ? null : safeJson(text);
  return {
    value: parsed === null ? redactText(text.slice(0, limit)) : redactValue(parsed),
    characterCount: text.length,
    truncated
  };
}

function redactHeaders(headers) {
  if (!headers || typeof headers !== "object") return headers;
  return Object.fromEntries(Object.entries(headers).map(([key, value]) => [key, SENSITIVE_KEY.test(key) ? "[REDACTED]" : redactValue(value)]));
}

function redactValue(value) {
  if (Array.isArray(value)) return value.map(redactValue);
  if (!value || typeof value !== "object") return typeof value === "string" ? redactText(value) : value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, SENSITIVE_KEY.test(key) ? "[REDACTED]" : redactValue(item)]));
}

function redactText(text) {
  return splitCaptureLines(String(text)).map((line) => line
    .replace(/\bBearer[ \t]+\S+/gi, "Bearer [REDACTED]")
    .replace(/(["']?(?:authorization|proxy-authorization|cookie|set-cookie|x-api-key|api-key|apikey|access[_-]?token|refresh[_-]?token|password|passwd|secret|client[_-]?secret)["']?\s*[:=]\s*["']?)([^"'&\s,;}]+)/gi, "$1[REDACTED]")
    .replace(/(authorization|proxy-authorization|x-api-key|api-key)\s*[:=]\s*([^\s,;]+)/gi, "$1: [REDACTED]")
    .replace(/((?:access|refresh)[_-]?token|password|client[_-]?secret)\s*[=:]\s*([^&\s,;]+)/gi, "$1=[REDACTED]"))
    .join("\n");
}

function redactUrl(value) {
  if (!value) return value;
  const input = String(value);
  const absolute = /^[a-z][a-z0-9+.-]*:\/\//i.test(input);
  try {
    const parsed = new URL(input, "https://mobile-api-console.invalid");
    for (const key of [...parsed.searchParams.keys()]) {
      if (SENSITIVE_KEY.test(key)) parsed.searchParams.set(key, "[REDACTED]");
    }
    return absolute ? parsed.toString() : `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return redactText(input);
  }
}

function redactCurl(curl) {
  return redactText(String(curl)).replace(/(-H\s+['"](?:Authorization|Cookie|Set-Cookie|X-API-Key):)[^'"]*(['"])/gi, "$1 [REDACTED]$2");
}

function summaryGroup(groupBy) {
  const groups = {
    endpoint: "CASE WHEN instr(COALESCE(e.path, e.url, ''), '?') > 0 THEN substr(COALESCE(e.path, e.url, ''), 1, instr(COALESCE(e.path, e.url, ''), '?') - 1) ELSE COALESCE(e.path, e.url, '') END",
    method: `COALESCE(NULLIF(${METHOD_SQL}, ''), 'unknown')`,
    status: "COALESCE(CAST(e.status_code AS TEXT), e.state, 'unknown')",
    platform: PLATFORM_SQL,
    sourceKind: "COALESCE(s.source_kind, 'unknown')",
    session: "CAST(e.session_id AS TEXT)",
    host: "COALESCE(e.host, 'unknown')"
  };
  if (!groups[groupBy]) throw new Error(`Unsupported groupBy: ${groupBy}`);
  return { expression: groups[groupBy] };
}

function durationSql() {
  return `COALESCE(
    CAST(json_extract(e.meta_json, '$.durationMs') AS REAL),
    CASE WHEN e.finished_at IS NOT NULL AND e.started_at IS NOT NULL
      THEN (julianday(e.finished_at) - julianday(e.started_at)) * 86400000.0
      ELSE NULL END
  )`;
}

function durationMs(row, capture) {
  if (Number.isFinite(capture.durationMs)) return capture.durationMs;
  if (!row.started_at || !row.finished_at) return null;
  const value = new Date(row.finished_at).getTime() - new Date(row.started_at).getTime();
  return Number.isFinite(value) ? value : null;
}

function platformFor(sourceKind) {
  if (String(sourceKind).startsWith("ios-")) return "ios";
  if (String(sourceKind).startsWith("android-")) return "android";
  if (String(sourceKind).startsWith("browser-")) return "browser";
  if (sourceKind === "demo") return "demo";
  return "other";
}

function deviceFor(metadata, label) {
  const identifier = metadata.udid || metadata.deviceSerial || metadata.browserSession?.profileId || metadata.simulator || null;
  if (metadata.deviceName && identifier && metadata.deviceName !== identifier) return `${metadata.deviceName} (${identifier})`;
  return metadata.deviceName || identifier || label || null;
}

function encodeCursor(value) {
  return Buffer.from(JSON.stringify({ version: 1, ...value }), "utf8").toString("base64url");
}

function decodeCursor(cursor, expectedKind) {
  if (!cursor) return null;
  try {
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (value.version !== 1 || value.kind !== expectedKind || !value.time || !Number.isInteger(value.id)) throw new Error("shape");
    return value;
  } catch {
    throw new Error("Invalid pagination cursor");
  }
}

function normalizedLimit(value) {
  return Math.max(1, Math.min(Number(value) || DEFAULT_LIMIT, MAX_LIMIT));
}

function escapeLike(value) {
  return String(value).replace(/[\\%_]/g, (match) => `\\${match}`);
}

function safeJson(value) {
  if (value === null || value === undefined || value === "") return null;
  if (typeof value !== "string") return value;
  try { return JSON.parse(value); }
  catch { return null; }
}

function camelizeRow(row) {
  return Object.fromEntries(Object.entries(row || {}).map(([key, value]) => [key.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase()), value]));
}

function dropUndefined(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
}

module.exports = {
  ApiConsoleQueryService,
  dayRange,
  encodeCursor,
  decodeCursor,
  redactHeaders,
  redactText,
  redactValue
};
