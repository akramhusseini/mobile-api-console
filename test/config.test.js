"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { buildConfig, DEFAULTS } = require("../src/config");

function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mac-config-"));
  try { return fn(dir); }
  finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

test("returns defaults when nothing is configured", () => {
  withTempDir((cwd) => {
    const config = buildConfig([], { HOME: cwd }, cwd);
    assert.equal(config.processName, DEFAULTS.processName);
    assert.equal(config.android.applicationId, DEFAULTS.androidApplicationId);
    assert.equal(config.android.logTag, DEFAULTS.androidLogTag);
    assert.equal(config.defaultSource, "auto");
    assert.equal(config.port, DEFAULTS.port);
  });
});

test("reads ~/.mobile-api-console.json", () => {
  withTempDir((cwd) => {
    const file = path.join(cwd, ".mobile-api-console.json");
    fs.writeFileSync(file, JSON.stringify({
      defaultSource: "android",
      ios: { processName: "MyApp", subsystem: "com.my.app", category: "logs" },
      android: { applicationId: "com.my.app", logTag: "MY_TAG", deviceSerial: "emulator-5554" }
    }));

    const config = buildConfig([], { MOBILE_API_CONSOLE_CONFIG: file }, cwd);
    assert.equal(config.defaultSource, "android");
    assert.equal(config.processName, "MyApp");
    assert.equal(config.subsystem, "com.my.app");
    assert.equal(config.category, "logs");
    assert.equal(config.android.applicationId, "com.my.app");
    assert.equal(config.android.logTag, "MY_TAG");
    assert.equal(config.android.deviceSerial, "emulator-5554");
    assert.equal(config.localConfigPath, file);
  });
});

test("env overrides config file", () => {
  withTempDir((cwd) => {
    const file = path.join(cwd, ".mobile-api-console.json");
    fs.writeFileSync(file, JSON.stringify({
      android: { logTag: "FROM_FILE" }
    }));

    const config = buildConfig(
      [],
      { MOBILE_API_CONSOLE_CONFIG: file, MOBILE_API_CONSOLE_ANDROID_LOG_TAG: "FROM_ENV" },
      cwd
    );
    assert.equal(config.android.logTag, "FROM_ENV");
  });
});

test("CLI overrides env and file", () => {
  withTempDir((cwd) => {
    const file = path.join(cwd, ".mobile-api-console.json");
    fs.writeFileSync(file, JSON.stringify({ android: { logTag: "FROM_FILE" } }));

    const config = buildConfig(
      ["--android-tag", "FROM_CLI"],
      { MOBILE_API_CONSOLE_CONFIG: file, MOBILE_API_CONSOLE_ANDROID_LOG_TAG: "FROM_ENV" },
      cwd
    );
    assert.equal(config.android.logTag, "FROM_CLI");
  });
});

test("normalizes invalid defaultSource to auto", () => {
  withTempDir((cwd) => {
    const config = buildConfig(["--source", "windows"], { HOME: cwd }, cwd);
    assert.equal(config.defaultSource, "auto");
  });
});

test("--source accepts ios, android, demo, auto", () => {
  withTempDir((cwd) => {
    for (const source of ["ios", "android", "demo", "auto"]) {
      const config = buildConfig(["--source", source], { HOME: cwd }, cwd);
      assert.equal(config.defaultSource, source);
    }
  });
});
