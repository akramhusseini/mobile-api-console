#!/usr/bin/env node
"use strict";

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { URL } = require("node:url");
const { spawn } = require("node:child_process");

const browserDev = require("./bin/browser-dev-helper");
const { buildConfig } = require("./src/config");
const { EventStore } = require("./src/eventStore");
const { stateChangingOriginAllowed } = require("./src/httpSecurity");
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
let retentionTimer = null;

main().catch((error) => {
  console.error(`Mobile API Console failed to start: ${error.message}`);
  process.exit(1);
});

async function main() {
  storage = new SqliteStorage({ databasePath: config.databasePath }).init();
  sourceManager = new SourceManager({ config });
  await sourceManager.detect();

  store = new EventStore({ storage, maxEvents: config.maxEvents });
  hub = new SseHub();
  hub.startHeartbeat();

  sourceManager.store = store;
  sourceManager.hub = hub;

  store.on("upsert", (event) => hub.broadcast("event-upsert", event));
  store.on("session-start", (payload) => hub.broadcast("session-start", payload));
  sourceManager.on("changed", (payload) => hub.broadcast("source-changed", payload));

  if (config.cleanupOnStart) runRetention();
  retentionTimer = setInterval(runRetention, 24 * 60 * 60 * 1000);
  retentionTimer.unref?.();

  server = http.createServer(handleRequest);
  server.on("error", (error) => {
    console.error(`Unable to start Mobile API Console on port ${config.port}: ${error.message}`);
    sourceManager.stop();
    process.exitCode = 1;
  });

  await new Promise((resolve) => {
    server.listen(config.port, "127.0.0.1", () => {
      console.log(`Mobile API Console running at http://localhost:${config.port}`);
      if (config.localConfigPath) {
        console.log(`Loaded local config: ${config.localConfigPath}`);
      }
      sourceManager.start();
      console.log(`Active sources: ${sourceManager.list().active.map((entry) => entry.label || entry.sourceKey).join(", ")}`);
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
        currentSessions: store.currentSessions(),
        sessions: store.recentSessions({ sourceKey: sourceManager.selectedSourceKey }),
        allSessions: store.recentSessions(),
        source: sourceManager.status,
        sources: sourceManager.list(),
        config: publicConfig()
      });
      return;
    }

    if (requestUrl.pathname === "/api/events") {
      const sessionParam = requestUrl.searchParams.get("session");
      const sourceKey = requestUrl.searchParams.get("sourceKey") || sourceManager.selectedSourceKey;
      const liveSession = sourceKey ? store.currentSession(sourceKey) : store.currentSession();
      const sessionId = parseSessionId(sessionParam) ?? liveSession?.id ?? null;
      const session = sessionId ? store.decorateSession(storage.getSession(sessionId)) : null;
      return sendJson(res, {
        events: sessionId ? store.eventsForSession(sessionId, { limit: config.maxEvents }) : [],
        currentSession: liveSession,
        currentSessions: store.currentSessions(),
        session,
        sessions: store.recentSessions({ sourceKey }),
        allSessions: store.recentSessions(),
        source: sourceManager.status,
        sources: sourceManager.list(),
        config: publicConfig()
      });
    }

    if (requestUrl.pathname === "/api/sessions") {
      const limit = Number.parseInt(requestUrl.searchParams.get("limit") || "50", 10);
      const sourceKey = requestUrl.searchParams.get("sourceKey") || null;
      return sendJson(res, {
        sessions: store.recentSessions({
          limit: Number.isFinite(limit) ? limit : 50,
          sourceKey
        }),
        currentSession: sourceKey ? store.currentSession(sourceKey) : store.currentSession(),
        currentSessions: store.currentSessions()
      });
    }

    const sessionDetailMatch = requestUrl.pathname.match(/^\/api\/sessions\/(\d+)$/);
    if (sessionDetailMatch) {
      const sessionId = Number.parseInt(sessionDetailMatch[1], 10);
      const session = store.decorateSession(storage.getSession(sessionId));
      if (!session) return sendJson(res, { error: "Session not found" }, 404);
      return sendJson(res, { session });
    }

    const sessionEventsMatch = requestUrl.pathname.match(/^\/api\/sessions\/(\d+)\/events$/);
    if (sessionEventsMatch) {
      const sessionId = Number.parseInt(sessionEventsMatch[1], 10);
      const session = store.decorateSession(storage.getSession(sessionId));
      if (!session) return sendJson(res, { error: "Session not found" }, 404);
      return sendJson(res, {
        session,
        events: store.eventsForSession(sessionId, { limit: config.maxEvents })
      });
    }

    if (req.method === "POST" && requestUrl.pathname === "/api/clear") {
      if (!allowLocalStateChange(req, res)) return;
      // Optional session id in the body — when present, clear only that
      // session. For browser this targets one (origin, profile, context)
      // session; for other sources it matches the platform's live session.
      let body = {};
      try { body = await readJsonBody(req); } catch { /* empty body is fine */ }
      const targetSessionId = Number.isFinite(Number.parseInt(body.sessionId, 10))
        ? Number.parseInt(body.sessionId, 10)
        : null;

      if (targetSessionId) {
        sourceManager.resetParser();
        store.clearSessionById(targetSessionId, "manual");
      } else {
        sourceManager.resetParser();
        store.clearSource(sourceManager.selectedSourceKey, "manual");
      }
      return sendJson(res, { ok: true });
    }

    if (req.method === "POST" && requestUrl.pathname === "/api/restart") {
      if (!allowLocalStateChange(req, res)) return;
      sourceManager.restart();
      return sendJson(res, { ok: true });
    }

    if (requestUrl.pathname === "/api/sources") {
      if (req.method === "POST") {
        if (!allowLocalStateChange(req, res)) return;
        const body = await readJsonBody(req);
        const kind = String(body.kind || "").toLowerCase();
        if (!["ios", "android", "demo", "browser"].includes(kind)) {
          return sendJson(res, { error: "Unknown source kind" }, 400);
        }
        const deviceSerial = body.deviceSerial || null;
        try {
          sourceManager.select(kind, kind === "android" ? { deviceSerial } : {});
        } catch (error) {
          return sendJson(res, { error: error.message }, 400);
        }
        return sendJson(res, selectedSnapshot());
      }

      // Re-probe detection on every GET so a newly attached device shows up.
      await sourceManager.refresh();
      return sendJson(res, sourceManager.list());
    }

    if (req.method === "POST" && requestUrl.pathname === "/api/source") {
      if (!allowLocalStateChange(req, res)) return;
      // Legacy alias for POST /api/sources.
      const body = await readJsonBody(req);
      const kind = String(body.kind || "").toLowerCase();
      if (!["ios", "android", "demo", "browser"].includes(kind)) {
        return sendJson(res, { error: "Unknown source kind" }, 400);
      }
      const deviceSerial = body.deviceSerial || null;
      try {
        sourceManager.select(kind, kind === "android" ? { deviceSerial } : {});
      } catch (error) {
        return sendJson(res, { error: error.message }, 400);
      }
      return sendJson(res, selectedSnapshot());
    }

    if (requestUrl.pathname === "/api/config") {
      return sendJson(res, {
        source: sourceManager.status,
        sources: sourceManager.list(),
        config: publicConfig()
      });
    }

    if (requestUrl.pathname === "/api/browser-setup/defaults") {
      return sendJson(res, browserSetupDefaults());
    }

    if (requestUrl.pathname === "/api/browser-setup/enable") {
      if (req.method !== "POST") {
        res.setHeader("Allow", "POST");
        return sendJson(res, { ok: false, error: "Method not allowed" }, 405);
      }
      if (!allowLocalStateChange(req, res)) return;
      return handleBrowserSetupEnable(req, res);
    }

    if (requestUrl.pathname === "/api/browser-setup/launch") {
      if (req.method !== "POST") {
        res.setHeader("Allow", "POST");
        return sendJson(res, { ok: false, error: "Method not allowed" }, 405);
      }
      if (!allowLocalStateChange(req, res)) return;
      return handleBrowserSetupLaunch(req, res);
    }

    if (requestUrl.pathname === "/api/browser-event" || requestUrl.pathname === "/api/browser-event/") {
      // Intentional exception: the browser extension posts capture events here
      // with permissive CORS. This endpoint cannot rewrite config or launch apps.
      if (req.method === "OPTIONS") {
        return sendBrowserOptions(res);
      }
      if (req.method !== "POST") {
        res.setHeader("Allow", "POST, OPTIONS");
        return sendJson(res, { error: "Method not allowed" }, 405);
      }
      return handleBrowserEvent(req, res);
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
  if (retentionTimer) {
    clearInterval(retentionTimer);
    retentionTimer = null;
  }
  if (hub) {
    hub.stopHeartbeat();
    hub.closeAll();
  }

  if (sourceManager) sourceManager.stop();
  try {
    if (store) store.closeAllSessions();
    if (storage) storage.close();
  } catch {
    // best-effort during shutdown
  }
  if (server) server.close(() => process.exit(0));

  const fallback = setTimeout(() => process.exit(0), 1500);
  fallback.unref?.();
}

function selectedSnapshot() {
  return {
    ok: true,
    events: store.snapshot(),
    currentSession: store.currentSession(),
    currentSessions: store.currentSessions(),
    sessions: store.recentSessions({ sourceKey: sourceManager.selectedSourceKey }),
    allSessions: store.recentSessions(),
    source: sourceManager.status,
    sources: sourceManager.list()
  };
}

function browserSetupDefaults() {
  const browser = config.browser || {};
  return {
    ok: true,
    consoleHost: `http://localhost:${config.port}`,
    extensionDir: path.join(rootDir, "extension"),
    browser: {
      enabled: browser.enabled === true,
      targetUrls: Array.isArray(browser.targetUrls) ? browser.targetUrls : [],
      requestUrls: Array.isArray(browser.requestUrls) ? browser.requestUrls : []
    },
    sources: sourceManager.list()
  };
}

function allowLocalStateChange(req, res) {
  const guard = stateChangingOriginAllowed(req, { port: config.port });
  if (guard.ok) return true;
  sendJson(res, {
    ok: false,
    error: "forbidden_origin",
    message: "This local endpoint only accepts requests from the Mobile API Console page."
  }, 403);
  return false;
}

async function handleBrowserSetupLaunch(req, res) {
  let body;
  try {
    body = await readJsonBody(req);
  } catch (error) {
    return sendJson(res, { ok: false, error: "invalid_json", message: error.message }, 400);
  }

  const targetUrls = patternList(body.targetUrls);
  const requestUrls = patternList(body.requestUrls);
  if (targetUrls.length === 0) {
    return sendJson(res, {
      ok: false,
      error: "missing_target_urls",
      message: "Add at least one target page URL pattern."
    }, 400);
  }

  const requestedBrowser = normalizeBrowserChoice(body.browser);
  if (requestedBrowser === undefined) {
    return sendJson(res, {
      ok: false,
      error: "unknown_browser",
      message: "Choose Brave, Chrome, Edge, or Auto."
    }, 400);
  }

  const configPath = config.localConfigPath || browserDev.DEFAULT_CONFIG_PATH;
  let existingConfigText = "";
  try {
    existingConfigText = fs.readFileSync(configPath, "utf8");
  } catch (error) {
    if (error.code !== "ENOENT") {
      return sendJson(res, {
        ok: false,
        error: "config_read_failed",
        message: `Could not read ${configPath}: ${error.message}`
      }, 500);
    }
  }

  const profile = browserDev.DEFAULT_PROFILE_DIR;
  const plan = browserDev.buildPlan({
    target: targetUrls,
    request: requestUrls,
    port: config.port,
    browser: requestedBrowser,
    profile,
    noStart: true,
    dryRun: false,
    configPath,
    repoRoot: rootDir,
    platform: process.platform,
    existingConfigText,
    probe: (candidate) => {
      try { return fs.existsSync(candidate); } catch { return false; }
    }
  });

  // The web setup form treats an empty request list as a deliberate clear.
  // The CLI preserves the old request list when --request is omitted, so we
  // override the merged value here to match form semantics.
  if (plan.mergedConfig?.browser) {
    plan.mergedConfig.browser.requestUrls = requestUrls;
  }

  if (plan.errors.length > 0) {
    return sendJson(res, { ok: false, error: "setup_plan_failed", messages: plan.errors }, 400);
  }

  try {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify(plan.mergedConfig, null, 2) + "\n");
  } catch (error) {
    return sendJson(res, {
      ok: false,
      error: "config_write_failed",
      message: `Could not write ${configPath}: ${error.message}`
    }, 500);
  }

  config.localConfigPath = configPath;
  config.browser = {
    enabled: true,
    targetUrls: plan.mergedConfig.browser.targetUrls,
    requestUrls: plan.mergedConfig.browser.requestUrls
  };
  config.defaultSource = plan.mergedConfig.defaultSource || config.defaultSource;
  sourceManager.configureBrowser(config.browser);
  try {
    sourceManager.select("browser", {});
  } catch {
    // The response still includes the plan; the source list will show the
    // reason if selection could not happen immediately.
  }

  let launched = false;
  let launchError = null;
  const browserCommand = plan.browserCommand ? plan.browserCommand.slice() : null;
  if (browserCommand) {
    const appUrl = `http://localhost:${config.port}/?browserSetup=1`;
    browserCommand.push(appUrl);
    try {
      fs.mkdirSync(profile, { recursive: true });
      const child = spawn(browserCommand[0], browserCommand.slice(1), {
        stdio: "ignore",
        detached: true
      });
      child.unref();
      launched = true;
    } catch (error) {
      launchError = error.message;
    }
  }

  return sendJson(res, {
    ok: launched,
    error: launched ? null : "browser_launch_failed",
    message: launched
      ? "Browser launched. In the extension Options tab, click Save, then Allow."
      : (launchError || "Browser command was not available."),
    configPath,
    consoleHost: `http://localhost:${config.port}`,
    extensionDir: plan.extensionDir,
    browser: plan.browser,
    profile,
    targetUrls: plan.targets,
    requestUrls,
    launchCommand: browserCommand,
    sources: sourceManager.list()
  }, launched ? 200 : 500);
}

async function handleBrowserSetupEnable(req, res) {
  try {
    const result = enableBrowserSourceInConsole();
    return sendJson(res, {
      ok: true,
      message: "Browser source enabled. Load the extension, then click Capture this site from the extension popup.",
      configPath: result.configPath,
      browser: result.browser,
      sources: sourceManager.list(),
      config: publicConfig()
    });
  } catch (error) {
    return sendJson(res, {
      ok: false,
      error: "browser_enable_failed",
      message: error.message
    }, 500);
  }
}

function enableBrowserSourceInConsole() {
  const configPath = config.localConfigPath || browserDev.DEFAULT_CONFIG_PATH;
  let existing = {};
  try {
    const raw = fs.readFileSync(configPath, "utf8").trim();
    if (raw) existing = JSON.parse(raw);
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw new Error(`Could not read ${configPath}: ${error.message}`);
    }
  }

  const merged = browserDev.mergeConfig(existing, { targetUrls: [], requestUrls: [] });
  try {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify(merged, null, 2) + "\n");
  } catch (error) {
    throw new Error(`Could not write ${configPath}: ${error.message}`);
  }

  config.localConfigPath = configPath;
  config.browser = {
    enabled: true,
    targetUrls: Array.isArray(merged.browser?.targetUrls) ? merged.browser.targetUrls : [],
    requestUrls: Array.isArray(merged.browser?.requestUrls) ? merged.browser.requestUrls : []
  };
  config.defaultSource = merged.defaultSource || config.defaultSource;
  sourceManager.configureBrowser(config.browser);
  return { configPath, browser: config.browser };
}

function patternList(value) {
  const raw = Array.isArray(value) ? value : String(value == null ? "" : value).split(/\r?\n/);
  return raw
    .map((entry) => String(entry || "").trim())
    .filter(Boolean);
}

function normalizeBrowserChoice(value) {
  const browser = String(value || "auto").trim().toLowerCase();
  if (!browser || browser === "auto") return null;
  if (browserDev.KNOWN_BROWSERS.includes(browser)) return browser;
  return undefined;
}

function parseSessionId(value) {
  if (value === null || value === undefined || value === "") return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : null;
}

function runRetention() {
  const cutoff = new Date(Date.now() - config.retentionDays * 86400000).toISOString();
  const protectedIds = (store ? store.currentSessions() : [])
    .map((session) => session.id)
    .filter((id) => Number.isFinite(id));
  const removed = storage.pruneSessionsBefore(cutoff, { excludeSessionIds: protectedIds });
  if (removed > 0) storage.vacuum();
  const mb = storage.databaseSizeBytes() / (1024 * 1024);
  if (mb > config.maxDbMb) {
    // TODO: hard size-based eviction (delete oldest sessions until under the cap)
    console.warn(`Mobile API Console DB is ${mb.toFixed(0)}MB (> ${config.maxDbMb}MB cap).`);
  }
  if (removed > 0) {
    console.log(`Retention: removed ${removed} session(s) older than ${config.retentionDays}d.`);
  }
}

function publicConfig() {
  return {
    port: config.port,
    maxEvents: config.maxEvents,
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
    browser: {
      enabled: Boolean(config.browser && config.browser.enabled === true),
      targetUrls: (config.browser && Array.isArray(config.browser.targetUrls)) ? config.browser.targetUrls : [],
      requestUrls: (config.browser && Array.isArray(config.browser.requestUrls)) ? config.browser.requestUrls : []
    },
    defaultSource: config.defaultSource
  };
}

const BROWSER_MAX_BODY_BYTES = 2 * 1024 * 1024;
// The wire format caps each of request.body and response.body at 1 MB. The
// 2 MB total cap is the outer envelope; this is the per-field backstop the
// extension already enforces but the server has to re-validate.
const BROWSER_MAX_BODY_FIELD_BYTES = 1 * 1024 * 1024;

async function handleBrowserEvent(req, res) {
  if (!config.browser || config.browser.enabled !== true) {
    // Disabled browser capture must answer with a clear response, not silently
    // drop the event. The extension can detect this and surface a hint in
    // its badge / options page.
    return sendJson(res, {
      ok: false,
      error: "browser_capture_disabled",
      message: "Browser capture is disabled. Set browser.enabled=true in ~/.mobile-api-console.json and restart the console."
    }, 403);
  }

  let raw;
  try {
    raw = await readBrowserBody(req, BROWSER_MAX_BODY_BYTES);
  } catch (error) {
    if (error && error.code === "PAYLOAD_TOO_LARGE") {
      return sendJson(res, {
        ok: false,
        error: "payload_too_large",
        message: `Browser event exceeded ${BROWSER_MAX_BODY_BYTES} bytes`
      }, 413);
    }
    return sendJson(res, { ok: false, error: "invalid_json", message: error.message }, 400);
  }

  if (!raw || typeof raw !== "object") {
    return sendJson(res, { ok: false, error: "invalid_json", message: "Empty or non-object body" }, 400);
  }

  if (raw.clear === true) {
    return handleBrowserClearMarker(raw, res);
  }

  const fieldViolation = checkBrowserBodyFieldCaps(raw);
  if (fieldViolation) {
    return sendJson(res, {
      ok: false,
      error: "body_field_too_large",
      message: `Browser event ${fieldViolation.field}.body exceeded ${BROWSER_MAX_BODY_FIELD_BYTES} bytes (got ${fieldViolation.size})`
    }, 413);
  }

  try {
    const result = sourceManager.ingestBrowserEvent(raw);
    return sendJson(res, {
      ok: true,
      sessionKey: result.sessionKey,
      eventId: result.event.id,
      sessionId: result.event.sessionId
    });
  } catch (error) {
    return sendJson(res, { ok: false, error: "ingest_failed", message: error.message }, 400);
  }
}

// Validates the per-field body cap (request.body and response.body <= 1 MB).
// Returns the offending field and the measured size, or null when both fit.
// Strings are measured in UTF-16 code units, which matches what we store in
// the SQLite blob and what the extension truncates against client-side.
function checkBrowserBodyFieldCaps(raw) {
  for (const field of ["request", "response"]) {
    const body = raw && raw[field] && raw[field].body;
    if (typeof body !== "string") continue;
    if (body.length > BROWSER_MAX_BODY_FIELD_BYTES) {
      return { field, size: body.length };
    }
  }
  return null;
}

function handleBrowserClearMarker(raw, res) {
  if (!raw.browserSession || !raw.browserSession.origin) {
    return sendJson(res, {
      ok: false,
      error: "invalid_clear_marker",
      message: "Clear marker must include browserSession.origin"
    }, 400);
  }
  const result = sourceManager.clearBrowserSession(raw);
  if (!result) {
    return sendJson(res, {
      ok: true,
      cleared: false,
      message: "No active browser session for that key; nothing to clear"
    });
  }
  return sendJson(res, {
    ok: true,
    cleared: true,
    sessionId: result.session.id,
    previousSessionId: result.previousSessionId || null
  });
}

function sendBrowserOptions(res) {
  res.writeHead(204, {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "600"
  });
  res.end();
}

// Dedicated body reader for /api/browser-event. The shared readJsonBody()
// helper hard-caps at 64 KB and turns overflow into a 500, which would
// kill the extension's SW for one large-but-legal payload. This reader
// surfaces overflow as a code the handler turns into a clean 413.
//
// On overflow we drain the rest of the body (so the socket can be reused
// by HTTP keep-alive) and reject with `code: "PAYLOAD_TOO_LARGE"`. The
// handler is responsible for sending the actual 413 response.
function readBrowserBody(req, maxBytes) {
  return new Promise((resolve, reject) => {
    let received = 0;
    const chunks = [];
    let settled = false;
    let overflow = false;

    function settle(code, error) {
      if (settled) return;
      settled = true;
      if (code) {
        const err = new Error(error);
        err.code = code;
        reject(err);
      } else {
        reject(new Error(error));
      }
    }

    req.on("data", (chunk) => {
      if (overflow) return; // discard until end
      received += chunk.length;
      if (received > maxBytes) {
        overflow = true;
        // Drain but reject on end.
        return;
      }
      chunks.push(chunk);
    });
    req.on("error", (error) => settle(null, error.message));
    req.on("end", () => {
      if (overflow) {
        settle("PAYLOAD_TOO_LARGE", `Request body exceeded ${maxBytes} bytes`);
        return;
      }
      if (settled) return;
      settled = true;
      const text = Buffer.concat(chunks).toString("utf8").trim();
      if (!text) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(text));
      } catch (error) {
        const wrapped = new Error(`Invalid JSON body: ${error.message}`);
        reject(wrapped);
      }
    });
  });
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
