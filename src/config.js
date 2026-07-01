"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const DEFAULT_PORT = 3957;
const DEFAULT_PROCESS = "ExampleMobileApp";
const DEFAULT_SUBSYSTEM = "com.example.mobile";
const DEFAULT_CATEGORY = "api-console";
const DEFAULT_SIMULATOR = "booted";
const DEFAULT_ANDROID_APPLICATION_ID = "com.example.mobile";
const DEFAULT_ANDROID_LOG_TAG = "API_CURL";
const DEFAULT_SOURCE = "auto";

const DEFAULT_DATABASE_PATH = path.join(
  os.homedir(),
  "Library",
  "Application Support",
  "mobile-api-console",
  "data.db"
);

const LOCAL_CONFIG_FILENAMES = [".mobile-api-console.json"];

function readOption(args, name, fallback) {
  const prefix = `--${name}=`;
  const inline = args.find((arg) => arg.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);

  const index = args.indexOf(`--${name}`);
  if (index >= 0 && args[index + 1]) return args[index + 1];

  return fallback;
}

function hasFlag(args, name) {
  return args.includes(`--${name}`);
}

function loadLocalConfig(env, cwd = process.cwd(), home = env.HOME || os.homedir()) {
  const explicit = env.MOBILE_API_CONSOLE_CONFIG;
  const candidates = [];
  if (explicit) candidates.push(explicit);
  for (const name of LOCAL_CONFIG_FILENAMES) {
    candidates.push(path.join(cwd, name));
    candidates.push(path.join(home, name));
  }

  for (const candidate of candidates) {
    if (!candidate) continue;
    if (!fs.existsSync(candidate)) continue;
    try {
      const raw = fs.readFileSync(candidate, "utf8");
      const parsed = JSON.parse(raw);
      return { path: candidate, data: parsed };
    } catch (error) {
      // Surface the path but don't crash the server on a malformed file.
      process.stderr.write(`Ignoring malformed config at ${candidate}: ${error.message}\n`);
    }
  }
  return { path: null, data: {} };
}

function pick(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return undefined;
}

// Parse a positive integer with a fallback. Anything that isn't a finite
// positive integer collapses to the fallback. Used for retentionDays,
// maxDbMb, and maxEvents so an invalid env var (e.g.
// MOBILE_API_CONSOLE_RETENTION_DAYS=abc) can't poison downstream Date math
// or arithmetic and turn a misconfiguration into a launchd restart loop.
function positiveIntFrom(...values) {
  for (const value of values) {
    if (value === undefined || value === null || value === "") continue;
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return undefined;
}

// Coerce a boolean-ish value. Accepts: true, 1, "1", "true", "yes", "on"
// (case-insensitive) and any of false, 0, "0", "false", "no", "off" as
// false. Anything that doesn't parse falls back to the default.
function booleanFrom(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (value === 1) return true;
    if (value === 0) return false;
  }
  const normalized = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return fallback;
}

function normalizeSource(value) {
  const v = String(value || "").toLowerCase();
  if (v === "ios" || v === "android" || v === "demo" || v === "browser" || v === "auto") return v;
  return "auto";
}

function normalizeBrowserConfig(value = {}) {
  if (!value || typeof value !== "object") {
    return { enabled: false, targetUrls: [], requestUrls: [] };
  }
  const targetUrls = Array.isArray(value.targetUrls)
    ? value.targetUrls.filter((entry) => typeof entry === "string" && entry.trim()).map((entry) => entry.trim())
    : [];
  const requestUrls = Array.isArray(value.requestUrls)
    ? value.requestUrls.filter((entry) => typeof entry === "string" && entry.trim()).map((entry) => entry.trim())
    : [];
  return {
    enabled: value.enabled === true,
    targetUrls,
    requestUrls
  };
}

function buildConfig(argv = process.argv.slice(2), env = process.env, cwd = process.cwd()) {
  const local = loadLocalConfig(env, cwd, env.HOME || os.homedir());
  const file = local.data || {};
  const fileIos = file.ios || {};
  const fileAndroid = file.android || {};
  const fileBrowser = normalizeBrowserConfig(file.browser);

  const processName = pick(
    readOption(argv, "process", undefined),
    env.MOBILE_API_CONSOLE_PROCESS,
    fileIos.processName,
    file.processName,
    DEFAULT_PROCESS
  );

  const subsystem = pick(
    readOption(argv, "subsystem", undefined),
    env.MOBILE_API_CONSOLE_SUBSYSTEM,
    fileIos.subsystem,
    DEFAULT_SUBSYSTEM
  );

  const category = pick(
    readOption(argv, "category", undefined),
    env.MOBILE_API_CONSOLE_CATEGORY,
    fileIos.category,
    DEFAULT_CATEGORY
  );

  const predicate = pick(
    readOption(argv, "predicate", undefined),
    env.MOBILE_API_CONSOLE_PREDICATE,
    fileIos.predicate,
    `subsystem == "${subsystem}" AND category == "${category}"`
  );

  const simulator = pick(
    readOption(argv, "simulator", undefined),
    env.MOBILE_API_CONSOLE_SIMULATOR,
    fileIos.simulator,
    DEFAULT_SIMULATOR
  );

  const androidApplicationId = pick(
    readOption(argv, "android-app", undefined),
    env.MOBILE_API_CONSOLE_ANDROID_APP_ID,
    fileAndroid.applicationId,
    DEFAULT_ANDROID_APPLICATION_ID
  );

  const androidLogTag = pick(
    readOption(argv, "android-tag", undefined),
    env.MOBILE_API_CONSOLE_ANDROID_LOG_TAG,
    fileAndroid.logTag,
    DEFAULT_ANDROID_LOG_TAG
  );

  const androidDeviceSerial = pick(
    readOption(argv, "android-device", undefined),
    env.MOBILE_API_CONSOLE_ANDROID_DEVICE,
    fileAndroid.deviceSerial,
    null
  );

  const androidAdbPath = pick(
    readOption(argv, "adb-path", undefined),
    env.ADB_PATH,
    fileAndroid.adbPath,
    null
  );

  const portValue = pick(
    readOption(argv, "port", undefined),
    env.MOBILE_API_CONSOLE_PORT,
    file.port,
    String(DEFAULT_PORT)
  );
  const port = Number.parseInt(portValue, 10);

  const defaultSource = normalizeSource(pick(
    readOption(argv, "source", undefined),
    env.MOBILE_API_CONSOLE_SOURCE,
    file.defaultSource,
    DEFAULT_SOURCE
  ));

  const demo = hasFlag(argv, "demo") || env.MOBILE_API_CONSOLE_DEMO === "1";
  const noStream = hasFlag(argv, "no-stream") || env.MOBILE_API_CONSOLE_NO_STREAM === "1";

  return {
    port: Number.isFinite(port) ? port : DEFAULT_PORT,

    // Legacy top-level iOS fields kept so existing code keeps working unchanged.
    processName,
    subsystem,
    category,
    predicate,
    simulator,

    ios: { processName, subsystem, category, predicate, simulator },
    android: {
      applicationId: androidApplicationId,
      logTag: androidLogTag,
      deviceSerial: androidDeviceSerial,
      adbPath: androidAdbPath
    },
    browser: fileBrowser,

    defaultSource,
    demo,
    noStream,
    publicDir: "public",
    maxEvents: positiveIntFrom(env.MOBILE_API_CONSOLE_MAX_EVENTS, file.maxEvents) ?? 400,
    retentionDays: positiveIntFrom(env.MOBILE_API_CONSOLE_RETENTION_DAYS, file.retentionDays) ?? 30,
    maxDbMb: positiveIntFrom(env.MOBILE_API_CONSOLE_MAX_DB_MB, file.maxDbMb) ?? 512,
    cleanupOnStart: booleanFrom(
      pick(env.MOBILE_API_CONSOLE_CLEANUP_ON_START, file.cleanupOnStart),
      true
    ),
    databasePath: pick(
      readOption(argv, "db", undefined),
      env.MOBILE_API_CONSOLE_DB,
      file.databasePath,
      DEFAULT_DATABASE_PATH
    ),
    localConfigPath: local.path
  };
}

module.exports = {
  buildConfig,
  loadLocalConfig,
  normalizeSource,
  DEFAULTS: {
    port: DEFAULT_PORT,
    processName: DEFAULT_PROCESS,
    subsystem: DEFAULT_SUBSYSTEM,
    category: DEFAULT_CATEGORY,
    simulator: DEFAULT_SIMULATOR,
    androidApplicationId: DEFAULT_ANDROID_APPLICATION_ID,
    androidLogTag: DEFAULT_ANDROID_LOG_TAG,
    source: DEFAULT_SOURCE,
    databasePath: DEFAULT_DATABASE_PATH
  }
};
