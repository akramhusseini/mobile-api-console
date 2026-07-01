"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const http = require("node:http");

const { buildConfig } = require("../../src/config");
const { EventStore } = require("../../src/eventStore");
const { SseHub } = require("../../src/sseHub");
const { SqliteStorage } = require("../../src/storage/sqliteStorage");
const { SourceManager } = require("../../src/sourceManager");

async function withServer(configOverrides, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mac-ingest-"));
  const dbPath = path.join(dir, "data.db");
  const config = buildConfig([], { HOME: dir, MOBILE_API_CONSOLE_DB: dbPath }, dir);
  for (const [key, value] of Object.entries(configOverrides)) {
    if (value === null) delete config[key];
    else config[key] = value;
  }

  const storage = new SqliteStorage({ databasePath: config.databasePath }).init();
  const sourceManager = new SourceManager({ config });
  const store = new EventStore({ storage, maxEvents: config.maxEvents });
  const hub = new SseHub();
  sourceManager.store = store;
  sourceManager.hub = hub;
  sourceManager.start();

  const server = http.createServer((req, res) => router(req, res, { config, sourceManager, store }));
  return new Promise((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      const close = () => new Promise((done) => {
        server.close(() => done());
      });
      const teardown = () => {
        try { sourceManager.stop(); } catch {}
        try { hub.closeAll(); hub.stopHeartbeat(); } catch {}
        return close();
      };
      Promise.resolve(fn({ port, close, config, sourceManager, store }))
        .then((value) => teardown().then(() => { try { storage.close(); } catch {} resolve(value); }))
        .catch((error) => teardown().then(() => { try { storage.close(); } catch {} reject(error); }));
    });
  });
}

async function router(req, res, ctx) {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  if (url.pathname === "/api/browser-event" || url.pathname === "/api/browser-event/") {
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type",
        "Access-Control-Max-Age": "600"
      });
      res.end();
      return;
    }
    if (req.method !== "POST") {
      res.writeHead(405, { Allow: "POST, OPTIONS", "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Method not allowed" }));
      return;
    }
    await handleBrowserEvent(req, res, ctx);
    return;
  }
  if ((url.pathname === "/api/source" || url.pathname === "/api/sources") && req.method === "POST") {
    await handleSelectSource(req, res, ctx);
    return;
  }
  if (url.pathname === "/api/browser-setup/enable" && req.method === "POST") {
    handleBrowserSetupEnable(req, res, ctx);
    return;
  }
  if (url.pathname === "/api/sources" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(ctx.sourceManager.list()));
    return;
  }
  res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
}

async function handleSelectSource(req, res, ctx) {
  let body = {};
  try {
    const text = await readBody(req, 64 * 1024);
    body = text ? JSON.parse(text) : {};
  } catch (err) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: "invalid_json", message: err.message }));
    return;
  }
  const kind = String(body.kind || "").toLowerCase();
  if (!["ios", "android", "demo", "browser"].includes(kind)) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: "Unknown source kind" }));
    return;
  }
  const deviceSerial = body.deviceSerial || null;
  try {
    ctx.sourceManager.select(kind, kind === "android" ? { deviceSerial } : {});
  } catch (error) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: error.message }));
    return;
  }
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({
    ok: true,
    source: ctx.sourceManager.status,
    selectedSourceKey: ctx.sourceManager.selectedSourceKey
  }));
}

function handleBrowserSetupEnable(req, res, ctx) {
  const previous = ctx.config.browser || {};
  ctx.config.browser = {
    enabled: true,
    targetUrls: Array.isArray(previous.targetUrls) ? previous.targetUrls.slice() : [],
    requestUrls: Array.isArray(previous.requestUrls) ? previous.requestUrls.slice() : []
  };
  ctx.sourceManager.configureBrowser(ctx.config.browser);
  res.writeHead(200, { "Content-Type": "application/json" });
  res.end(JSON.stringify({
    ok: true,
    browser: ctx.config.browser,
    sources: ctx.sourceManager.list(),
    config: {
      browser: ctx.config.browser
    }
  }));
}

async function readBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    let received = 0;
    const chunks = [];
    let settled = false;
    let overflow = false;
    req.on("data", (chunk) => {
      if (overflow) return;
      received += chunk.length;
      if (received > maxBytes) {
        overflow = true;
        return;
      }
      chunks.push(chunk);
    });
    req.on("error", (err) => { if (settled) return; settled = true; reject(err); });
    req.on("end", () => {
      if (settled) return;
      settled = true;
      if (overflow) {
        const err = new Error("too large");
        err.code = "PAYLOAD_TOO_LARGE";
        reject(err);
        return;
      }
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
  });
}

async function handleBrowserEvent(req, res, ctx) {
  const { config, sourceManager } = ctx;
  const MAX = 2 * 1024 * 1024;
  const MAX_FIELD = 1 * 1024 * 1024;
  if (!config.browser || config.browser.enabled !== true) {
    res.writeHead(403, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      ok: false,
      error: "browser_capture_disabled",
      message: "Browser capture is disabled. Set browser.enabled=true in ~/.mobile-api-console.json and restart the console."
    }));
    return;
  }
  let raw;
  try {
    const text = await readBody(req, MAX);
    raw = text ? JSON.parse(text) : {};
  } catch (err) {
    if (err.code === "PAYLOAD_TOO_LARGE") {
      res.writeHead(413, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "payload_too_large" }));
      return;
    }
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: "invalid_json", message: err.message }));
    return;
  }
  if (raw.clear === true) {
    if (!raw.browserSession || !raw.browserSession.origin) {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: false, error: "invalid_clear_marker" }));
      return;
    }
    const cleared = sourceManager.clearBrowserSession(raw);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, cleared: Boolean(cleared) }));
    return;
  }
  // Per-body-field cap (1 MB on request.body / response.body).
  for (const field of ["request", "response"]) {
    const body = raw && raw[field] && raw[field].body;
    if (typeof body === "string" && body.length > MAX_FIELD) {
      res.writeHead(413, { "Content-Type": "application/json" });
      res.end(JSON.stringify({
        ok: false,
        error: "body_field_too_large",
        message: `Browser event ${field}.body exceeded ${MAX_FIELD} bytes (got ${body.length})`
      }));
      return;
    }
  }
  try {
    const result = sourceManager.ingestBrowserEvent(raw);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, sessionKey: result.sessionKey, eventId: result.event.id, sessionId: result.event.sessionId }));
  } catch (err) {
    res.writeHead(400, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: false, error: "ingest_failed", message: err.message }));
  }
}

function postJson(port, path, text) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const req = http.request({
      host: "127.0.0.1",
      port,
      path,
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(text) }
    }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => {
        if (settled) return;
        settled = true;
        const raw = Buffer.concat(chunks).toString("utf8");
        let payload = null;
        try { payload = raw ? JSON.parse(raw) : null; } catch { payload = { raw }; }
        resolve({ status: res.statusCode, headers: res.headers, body: payload });
      });
    });
    req.on("error", (err) => {
      // Server can destroy the socket on overflow. Treat as a 413/closed
      // connection; the test will assert the right code path.
      if (settled) return;
      settled = true;
      resolve({ status: 0, error: err.code || err.message });
    });
    req.end(text);
  });
}

module.exports = { withServer, postJson, postJsonAsObject };

function postJsonAsObject(port, path, obj) {
  return postJson(port, path, JSON.stringify(obj));
}
