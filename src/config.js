"use strict";

const os = require("node:os");
const path = require("node:path");

const DEFAULT_PORT = 3957;
const DEFAULT_PROCESS = "ExampleMobileApp";
const DEFAULT_SUBSYSTEM = "com.example.mobile";
const DEFAULT_CATEGORY = "api-console";
const DEFAULT_DATABASE_PATH = path.join(
  os.homedir(),
  "Library",
  "Application Support",
  "mobile-api-console",
  "data.db"
);

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

function buildConfig(argv = process.argv.slice(2), env = process.env) {
  const processName = readOption(
    argv,
    "process",
    env.MOBILE_API_CONSOLE_PROCESS || DEFAULT_PROCESS
  );

  const subsystem = readOption(
    argv,
    "subsystem",
    env.MOBILE_API_CONSOLE_SUBSYSTEM || DEFAULT_SUBSYSTEM
  );

  const category = readOption(
    argv,
    "category",
    env.MOBILE_API_CONSOLE_CATEGORY || DEFAULT_CATEGORY
  );

  const predicate = readOption(
    argv,
    "predicate",
    env.MOBILE_API_CONSOLE_PREDICATE
      || `subsystem == "${subsystem}" AND category == "${category}"`
  );

  const portValue = readOption(
    argv,
    "port",
    env.MOBILE_API_CONSOLE_PORT || String(DEFAULT_PORT)
  );

  const port = Number.parseInt(portValue, 10);

  return {
    port: Number.isFinite(port) ? port : DEFAULT_PORT,
    processName,
    subsystem,
    category,
    predicate,
    simulator: readOption(
      argv,
      "simulator",
      env.MOBILE_API_CONSOLE_SIMULATOR || "booted"
    ),
    demo: hasFlag(argv, "demo") || env.MOBILE_API_CONSOLE_DEMO === "1",
    noStream: hasFlag(argv, "no-stream") || env.MOBILE_API_CONSOLE_NO_STREAM === "1",
    publicDir: "public",
    maxEvents: Number.parseInt(env.MOBILE_API_CONSOLE_MAX_EVENTS || "400", 10),
    databasePath: readOption(argv, "db", env.MOBILE_API_CONSOLE_DB || DEFAULT_DATABASE_PATH)
  };
}

module.exports = { buildConfig };
