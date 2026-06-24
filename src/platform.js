"use strict";

const { spawn } = require("node:child_process");

const DEFAULT_PROBE_TIMEOUT_MS = 1500;

function runQuick(command, args, { timeoutMs = DEFAULT_PROBE_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
    } catch (error) {
      resolve({ ok: false, code: -1, stdout: "", stderr: error.message });
      return;
    }

    let stdout = "";
    let stderr = "";
    let settled = false;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      try { child.kill("SIGKILL"); } catch { /* ignore */ }
      resolve(result);
    };

    child.stdout.on("data", (chunk) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
    child.on("error", (error) => finish({ ok: false, code: -1, stdout, stderr: error.message }));
    child.on("exit", (code) => finish({ ok: code === 0, code, stdout, stderr }));

    const timer = setTimeout(() => finish({ ok: false, code: -1, stdout, stderr: "timeout" }), timeoutMs);
    timer.unref?.();
  });
}

async function detectIos() {
  const xcrun = await runQuick("xcrun", ["--find", "simctl"]);
  if (!xcrun.ok) {
    return { available: false, reason: "xcrun not found", booted: [] };
  }

  const sims = await runQuick("xcrun", ["simctl", "list", "devices", "booted"]);
  const booted = parseBootedSimulators(sims.stdout);
  return {
    available: true,
    booted,
    hasBooted: booted.length > 0
  };
}

function parseBootedSimulators(stdout) {
  const lines = String(stdout || "").split("\n");
  const booted = [];
  for (const line of lines) {
    const match = line.match(/^\s*([^()]+?)\s+\(([0-9A-F-]{36})\)\s+\(Booted\)\s*$/i);
    if (match) booted.push({ name: match[1].trim(), udid: match[2] });
  }
  return booted;
}

function resolveAdbPath(env = process.env) {
  if (env.ADB_PATH) return env.ADB_PATH;
  if (env.ANDROID_HOME) return `${env.ANDROID_HOME}/platform-tools/adb`;
  if (env.ANDROID_SDK_ROOT) return `${env.ANDROID_SDK_ROOT}/platform-tools/adb`;
  return "adb";
}

async function detectAndroid(env = process.env) {
  const adb = resolveAdbPath(env);
  const version = await runQuick(adb, ["version"]);
  if (!version.ok) {
    return { available: false, reason: "adb not found", devices: [], adb };
  }

  const list = await runQuick(adb, ["devices", "-l"]);
  const devices = parseAdbDevices(list.stdout);
  return {
    available: true,
    devices,
    hasDevices: devices.length > 0,
    adb
  };
}

function parseAdbDevices(stdout) {
  const lines = String(stdout || "").split("\n").slice(1); // drop "List of devices attached"
  const devices = [];
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) continue;
    const parts = line.split(/\s+/);
    const serial = parts[0];
    const state = parts[1] || "";
    if (!serial || state !== "device") continue;

    const meta = {};
    for (const token of parts.slice(2)) {
      const eq = token.indexOf(":");
      if (eq > 0) meta[token.slice(0, eq)] = token.slice(eq + 1);
    }
    const label = meta.model || meta.device || serial;
    devices.push({ serial, label, state, meta });
  }
  return devices;
}

async function detectAll(env = process.env) {
  const [ios, android] = await Promise.all([detectIos(), detectAndroid(env)]);
  return { ios, android };
}

module.exports = {
  detectIos,
  detectAndroid,
  detectAll,
  resolveAdbPath,
  parseAdbDevices,
  parseBootedSimulators
};
