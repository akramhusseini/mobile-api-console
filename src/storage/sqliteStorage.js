"use strict";

const fs = require("node:fs");
const path = require("node:path");
const Database = require("better-sqlite3");

const { applyMigrations } = require("./migrations");

const DEFAULT_MIGRATIONS_DIR = path.join(__dirname, "..", "..", "migrations");

class SqliteStorage {
  constructor({ databasePath, migrationsDir = DEFAULT_MIGRATIONS_DIR } = {}) {
    if (!databasePath) {
      throw new Error("SqliteStorage requires a databasePath");
    }
    this.databasePath = databasePath;
    this.migrationsDir = migrationsDir;
    this.db = null;
  }

  init() {
    ensureParentDir(this.databasePath);
    this.db = new Database(this.databasePath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.db.pragma("synchronous = NORMAL");
    applyMigrations(this.db, this.migrationsDir);
    return this;
  }

  close() {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }

  // ----- Sessions -----

  createSession({ label = null, sourceKind = null, sourceMetadata = null, startedAt = null } = {}) {
    const started = startedAt || nowIso();
    const metadata = sourceMetadata ? JSON.stringify(sourceMetadata) : null;

    const info = this.db.prepare(`
      INSERT INTO sessions (label, started_at, source_kind, source_metadata)
      VALUES (?, ?, ?, ?)
    `).run(label, started, sourceKind, metadata);

    return this.getSession(info.lastInsertRowid);
  }

  endSession(sessionId, endedAt = null) {
    const ended = endedAt || nowIso();
    this.db.prepare(`
      UPDATE sessions
      SET ended_at = COALESCE(ended_at, ?)
      WHERE id = ?
    `).run(ended, sessionId);
    return this.getSession(sessionId);
  }

  getSession(sessionId) {
    const row = this.db.prepare("SELECT * FROM sessions WHERE id = ?").get(sessionId);
    return row ? hydrateSession(row) : null;
  }

  listSessions({ limit = 50 } = {}) {
    const rows = this.db.prepare(`
      SELECT * FROM sessions
      ORDER BY started_at DESC, id DESC
      LIMIT ?
    `).all(limit);
    return rows.map(hydrateSession);
  }

  latestOpenSession() {
    const row = this.db.prepare(`
      SELECT * FROM sessions
      WHERE ended_at IS NULL
      ORDER BY started_at DESC, id DESC
      LIMIT 1
    `).get();
    return row ? hydrateSession(row) : null;
  }

  // ----- Events -----

  saveEvent(sessionId, event) {
    const now = nowIso();
    const params = {
      session_id: sessionId,
      client_event_id: String(event.id),
      kind: event.kind || null,
      method: event.method || null,
      url: event.url || null,
      host: event.host || null,
      path: event.path || null,
      status_code: numericStatus(event.statusCode),
      state: event.state || null,
      started_at: event.startedAt || event.createdAt || now,
      finished_at: event.finishedAt || null,
      request_json: jsonOrNull(event.request),
      response_json: jsonOrNull(event.response),
      curl: event.curl || null,
      errors_json: jsonOrNull(event.errors),
      raw_json: jsonOrNull(event.raw),
      created_at: event.createdAt || now,
      updated_at: now
    };

    this.db.prepare(`
      INSERT INTO events (
        session_id, client_event_id, kind, method, url, host, path,
        status_code, state, started_at, finished_at,
        request_json, response_json, curl, errors_json, raw_json,
        created_at, updated_at
      ) VALUES (
        @session_id, @client_event_id, @kind, @method, @url, @host, @path,
        @status_code, @state, @started_at, @finished_at,
        @request_json, @response_json, @curl, @errors_json, @raw_json,
        @created_at, @updated_at
      )
      ON CONFLICT (session_id, client_event_id) DO UPDATE SET
        kind = excluded.kind,
        method = COALESCE(excluded.method, events.method),
        url = COALESCE(excluded.url, events.url),
        host = COALESCE(excluded.host, events.host),
        path = COALESCE(excluded.path, events.path),
        status_code = COALESCE(excluded.status_code, events.status_code),
        state = COALESCE(excluded.state, events.state),
        finished_at = COALESCE(excluded.finished_at, events.finished_at),
        request_json = COALESCE(excluded.request_json, events.request_json),
        response_json = COALESCE(excluded.response_json, events.response_json),
        curl = COALESCE(excluded.curl, events.curl),
        errors_json = COALESCE(excluded.errors_json, events.errors_json),
        raw_json = COALESCE(excluded.raw_json, events.raw_json),
        updated_at = excluded.updated_at
    `).run(params);

    this.db.prepare(`
      UPDATE sessions
      SET event_count = (SELECT COUNT(*) FROM events WHERE session_id = ?)
      WHERE id = ?
    `).run(sessionId, sessionId);

    return this.getEvent(sessionId, params.client_event_id);
  }

  getEvent(sessionId, clientEventId) {
    const row = this.db.prepare(`
      SELECT * FROM events WHERE session_id = ? AND client_event_id = ?
    `).get(sessionId, clientEventId);
    return row ? hydrateEvent(row) : null;
  }

  listEvents({ sessionId, limit = 500 } = {}) {
    if (!sessionId) return [];
    const rows = this.db.prepare(`
      SELECT * FROM events
      WHERE session_id = ?
      ORDER BY updated_at DESC
      LIMIT ?
    `).all(sessionId, limit);
    return rows.map(hydrateEvent);
  }

  countEvents(sessionId) {
    const row = this.db.prepare("SELECT COUNT(*) AS n FROM events WHERE session_id = ?").get(sessionId);
    return row ? row.n : 0;
  }

  // ----- Retention -----

  pruneSessionsBefore(cutoffIso, { excludeSessionIds = [] } = {}) {
    // events cascade via ON DELETE CASCADE
    const params = { cutoff: cutoffIso };
    let sql = "DELETE FROM sessions WHERE COALESCE(ended_at, started_at) < @cutoff";
    if (excludeSessionIds.length > 0) {
      sql += " AND id NOT IN (SELECT value FROM json_each(@excluded))";
      params.excluded = JSON.stringify(excludeSessionIds);
    }
    const info = this.db.prepare(sql).run(params);
    return info.changes;
  }

  vacuum() {
    this.db.exec("VACUUM");
  }

  databaseSizeBytes() {
    let total = 0;
    for (const suffix of ["", "-wal", "-shm"]) {
      try { total += fs.statSync(this.databasePath + suffix).size; }
      catch { /* sidecar may not exist */ }
    }
    return total;
  }
}

function ensureParentDir(filePath) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

function nowIso() {
  return new Date().toISOString();
}

function jsonOrNull(value) {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value) && value.length === 0) return null;
  return JSON.stringify(value);
}

function numericStatus(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function hydrateSession(row) {
  return {
    id: row.id,
    label: row.label,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    sourceKind: row.source_kind,
    sourceMetadata: row.source_metadata ? safeParse(row.source_metadata) : null,
    eventCount: row.event_count,
    createdAt: row.created_at
  };
}

function hydrateEvent(row) {
  return {
    id: row.client_event_id,
    sessionId: row.session_id,
    kind: row.kind,
    method: row.method,
    url: row.url,
    host: row.host,
    path: row.path,
    statusCode: row.status_code,
    state: row.state,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    request: safeParse(row.request_json),
    response: safeParse(row.response_json),
    curl: row.curl,
    errors: safeParse(row.errors_json) || [],
    raw: safeParse(row.raw_json) || [],
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function safeParse(text) {
  if (text === null || text === undefined) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

module.exports = { SqliteStorage };
