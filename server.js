#!/usr/bin/env node
"use strict";

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { URL } = require("node:url");

const { buildConfig } = require("./src/config");
const { EventStore } = require("./src/eventStore");
const { SseHub } = require("./src/sseHub");
const { SqliteStorage } = require("./src/storage/sqliteStorage");
const { SourceManager } = require("./src/sourceManager");

const config = buildConfig();
const rootDir = __dirname;
const publicDir = path.join(rootDir, config.publicDir);

let shuttingDown = false;
let server;
let storage;
let store;
let sourceManager;
let hub;

main().catch((error) => {
  console.error(`Mobile API Console failed to start: ${error.message}`);
  process.exit(1);
});

async function main() {
  storage = new SqliteStorage({ databasePath: config.databasePath }).init();
  sourceManager = new SourceManager({ config });
  await sourceManager.detect();

  const initialKind = sourceManager.resolveInitialKind();
  const initialOpts = sourceManager.optsForKind(initialKind);
  const initialMetadata = sourceManager.kindToSessionMetadata(initialKind, initialOpts);

  store = new EventStore({
    storage,
    sourceKind: initialMetadata.sourceKind,
    sourceMetadata: initialMetadata.sourceMetadata
  });
  store.init();
  hub = new SseHub();

  sourceManager.store = store;
  sourceManager.hub = hub;

  store.on("upsert", (event) => hub.broadcast("event-upsert", event));
  store.on("session-start", (payload) => hub.broadcast("session-start", payload));
  sourceManager.on("changed", (payload) => hub.broadcast("source-changed", payload));

  server = http.createServer(handleRequest);
  server.on("error", (error) => {
    console.error(`Unable to start Mobile API Console on port ${config.port}: ${error.message}`);
    sourceManager.stop();
    process.exitCode = 1;
  });

  await new Promise((resolve) => {
    server.listen(config.port, "127.0.0.1", () => {
      console.log(`Mobile API Console running at http://localhost:${config.port}`);
      console.log(`Initial source: ${initialKind}${initialOpts.deviceSerial ? ` (device ${initialOpts.deviceSerial})` : ""}`);
      if (config.localConfigPath) {
        console.log(`Loaded local config: ${config.localConfigPath}`);
      }
      sourceManager.start();
      resolve();
    });
  });
}

async function handleRequest(req, res) {
  try {
    const requestUrl = new URL(req.url, `http://${req.headers.host || "localhost"}`);

    if (requestUrl.pathname === "/events") {
      const client = hub.add(req, res);
      hub.send(client, "snapshot", {
        events: store.snapshot(),
        currentSession: store.currentSession(),
        sessions: store.recentSessions(),
        source: sourceManager.status,
        sources: sourceManager.list(),
        config: publicConfig()
      });
      return;
    }

    if (requestUrl.pathname === "/api/events") {
      const sessionParam = requestUrl.searchParams.get("session");
      const sessionId = parseSessionId(sessionParam) ?? store.currentSessionId;
      const session = sessionId ? storage.getSession(sessionId) : null;
      return sendJson(res, {
        events: sessionId ? store.eventsForSession(sessionId) : [],
        currentSession: store.currentSession(),
        session,
        sessions: store.recentSessions(),
        source: sourceManager.status,
        sources: sourceManager.list(),
        config: publicConfig()
      });
    }

    if (requestUrl.pathname === "/api/sessions") {
      const limit = Number.parseInt(requestUrl.searchParams.get("limit") || "50", 10);
      return sendJson(res, {
        sessions: store.recentSessions({ limit: Number.isFinite(limit) ? limit : 50 }),
        currentSession: store.currentSession()
      });
    }

    const sessionDetailMatch = requestUrl.pathname.match(/^\/api\/sessions\/(\d+)$/);
    if (sessionDetailMatch) {
      const sessionId = Number.parseInt(sessionDetailMatch[1], 10);
      const session = storage.getSession(sessionId);
      if (!session) return sendJson(res, { error: "Session not found" }, 404);
      return sendJson(res, { session });
    }

    const sessionEventsMatch = requestUrl.pathname.match(/^\/api\/sessions\/(\d+)\/events$/);
    if (sessionEventsMatch) {
      const sessionId = Number.parseInt(sessionEventsMatch[1], 10);
      const session = storage.getSession(sessionId);
      if (!session) return sendJson(res, { error: "Session not found" }, 404);
      return sendJson(res, {
        session,
        events: store.eventsForSession(sessionId)
      });
    }

    if (req.method === "POST" && requestUrl.pathname === "/api/clear") {
      sourceManager.resetParser();
      store.clear("manual");
      return sendJson(res, { ok: true });
    }

    if (req.method === "POST" && requestUrl.pathname === "/api/restart") {
      sourceManager.restart();
      return sendJson(res, { ok: true });
    }

    if (requestUrl.pathname === "/api/sources") {
      if (req.method === "POST") {
        const body = await readJsonBody(req);
        const kind = String(body.kind || "").toLowerCase();
        if (!["ios", "android", "demo"].includes(kind)) {
          return sendJson(res, { error: "Unknown source kind" }, 400);
        }
        const deviceSerial = body.deviceSerial || null;
        try {
          sourceManager.switchTo(kind, kind === "android" ? { deviceSerial } : {});
        } catch (error) {
          return sendJson(res, { error: error.message }, 400);
        }
        return sendJson(res, { ok: true, sources: sourceManager.list() });
      }

      // Re-probe detection on every GET so a newly attached device shows up.
      await sourceManager.detect();
      return sendJson(res, sourceManager.list());
    }

    if (req.method === "POST" && requestUrl.pathname === "/api/source") {
      // Legacy alias for POST /api/sources.
      const body = await readJsonBody(req);
      const kind = String(body.kind || "").toLowerCase();
      if (!["ios", "android", "demo"].includes(kind)) {
        return sendJson(res, { error: "Unknown source kind" }, 400);
      }
      const deviceSerial = body.deviceSerial || null;
      sourceManager.switchTo(kind, kind === "android" ? { deviceSerial } : {});
      return sendJson(res, { ok: true, sources: sourceManager.list() });
    }

    if (requestUrl.pathname === "/api/config") {
      return sendJson(res, {
        source: sourceManager.status,
        sources: sourceManager.list(),
        config: publicConfig()
      });
    }

    return serveStatic(requestUrl.pathname, res);
  } catch (error) {
    sendJson(res, { error: error.message }, 500);
  }
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

function shutdown() {
  if (shuttingDown) {
    process.exit(130);
    return;
  }

  shuttingDown = true;
  if (hub) hub.closeAll();

  if (sourceManager) sourceManager.stop();
  try {
    if (store) store.closeCurrentSession();
    if (storage) storage.close();
  } catch {
    // best-effort during shutdown
  }
  if (server) server.close(() => process.exit(0));

  const fallback = setTimeout(() => process.exit(0), 1500);
  fallback.unref?.();
}

function parseSessionId(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function publicConfig() {
  return {
    port: config.port,
    processName: config.processName,
    subsystem: config.subsystem,
    category: config.category,
    predicate: config.predicate,
    simulator: config.simulator,
    demo: config.demo,
    noStream: config.noStream,
    android: {
      applicationId: config.android.applicationId,
      logTag: config.android.logTag,
      deviceSerial: config.android.deviceSerial
    },
    defaultSource: config.defaultSource
  };
}

function sendJson(res, payload, statusCode = 200) {
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-cache"
  });
  res.end(JSON.stringify(payload));
}

function readJsonBody(req, { maxBytes = 64 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    let received = 0;
    const chunks = [];
    req.on("data", (chunk) => {
      received += chunk.length;
      if (received > maxBytes) {
        reject(new Error("Request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("error", reject);
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8").trim();
      if (!raw) return resolve({});
      try { resolve(JSON.parse(raw)); }
      catch (error) { reject(new Error(`Invalid JSON body: ${error.message}`)); }
    });
  });
}

function serveStatic(pathname, res) {
  const requested = pathname === "/" ? "/index.html" : pathname;
  const decoded = decodeURIComponent(requested);
  const filePath = path.normalize(path.join(publicDir, decoded));

  if (!filePath.startsWith(publicDir)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  fs.readFile(filePath, (error, data) => {
    if (error) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }

    res.writeHead(200, {
      "Content-Type": mimeType(filePath),
      "Cache-Control": "no-cache"
    });
    res.end(data);
  });
}

function mimeType(filePath) {
  const ext = path.extname(filePath);
  if (ext === ".html") return "text/html; charset=utf-8";
  if (ext === ".css") return "text/css; charset=utf-8";
  if (ext === ".js") return "text/javascript; charset=utf-8";
  if (ext === ".json") return "application/json; charset=utf-8";
  return "text/plain; charset=utf-8";
}
