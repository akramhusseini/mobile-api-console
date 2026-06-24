"use strict";

const fs = require("node:fs");
const path = require("node:path");

function ensureMigrationsTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      filename TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    )
  `);
}

function appliedFilenames(db) {
  const rows = db.prepare("SELECT filename FROM _migrations").all();
  return new Set(rows.map((row) => row.filename));
}

function discoverMigrations(migrationsDir) {
  if (!fs.existsSync(migrationsDir)) return [];
  return fs
    .readdirSync(migrationsDir)
    .filter((name) => name.endsWith(".sql"))
    .sort();
}

function applyMigrations(db, migrationsDir) {
  ensureMigrationsTable(db);
  const applied = appliedFilenames(db);
  const files = discoverMigrations(migrationsDir);
  const newlyApplied = [];

  for (const filename of files) {
    if (applied.has(filename)) continue;

    const sql = fs.readFileSync(path.join(migrationsDir, filename), "utf8");
    const insert = db.prepare("INSERT INTO _migrations (filename) VALUES (?)");

    db.exec("BEGIN");
    try {
      db.exec(sql);
      insert.run(filename);
      db.exec("COMMIT");
      newlyApplied.push(filename);
    } catch (error) {
      db.exec("ROLLBACK");
      const wrapped = new Error(`Failed to apply migration ${filename}: ${error.message}`);
      wrapped.cause = error;
      throw wrapped;
    }
  }

  return newlyApplied;
}

module.exports = { applyMigrations };
