CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  label TEXT,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  source_kind TEXT,
  source_metadata TEXT,
  event_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX IF NOT EXISTS idx_sessions_started ON sessions (started_at DESC);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  client_event_id TEXT NOT NULL,
  kind TEXT,
  method TEXT,
  url TEXT,
  host TEXT,
  path TEXT,
  status_code INTEGER,
  state TEXT,
  started_at TEXT,
  finished_at TEXT,
  request_json TEXT,
  response_json TEXT,
  curl TEXT,
  errors_json TEXT,
  raw_json TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  UNIQUE (session_id, client_event_id)
);

CREATE INDEX IF NOT EXISTS idx_events_session ON events (session_id);
CREATE INDEX IF NOT EXISTS idx_events_method ON events (method);
CREATE INDEX IF NOT EXISTS idx_events_status ON events (status_code);
CREATE INDEX IF NOT EXISTS idx_events_host ON events (host);
CREATE INDEX IF NOT EXISTS idx_events_path ON events (path);
CREATE INDEX IF NOT EXISTS idx_events_started ON events (started_at DESC);
CREATE INDEX IF NOT EXISTS idx_events_session_updated ON events (session_id, updated_at DESC);
