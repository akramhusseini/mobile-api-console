"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { EventStore } = require("../src/eventStore");
const { SourceManager } = require("../src/sourceManager");
const { SqliteStorage } = require("../src/storage/sqliteStorage");

function withManager(detection, fn, configOverrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mobile-api-console-test-"));
  const dbPath = path.join(dir, "data.db");
  const storage = new SqliteStorage({ databasePath: dbPath }).init();
  const store = new EventStore({ storage });
  const manager = new SourceManager({
    config: {
      demo: false,
      noStream: false,
      defaultSource: "auto",
      ios: {
        simulator: "booted",
        predicate: "subsystem == \"com.example.mobile\"",
        processName: "ExampleMobile"
      },
      android: {
        applicationId: "com.example.mobile",
        logTag: "API_CURL",
        deviceSerial: null,
        adbPath: null
      },
      ...configOverrides
    },
    store
  });

  manager.detection = detection;
  manager.makeSource = (kind, opts) => new FakeSource(kind, opts);
  manager.makeParser = (kind) => new FakeParser(kind);

  try {
    return fn({ manager, store, storage });
  } finally {
    manager.stop();
    storage.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("starts iOS and Android recorders when both platforms are available", () => {
  withManager(bothPlatforms(), ({ manager, store }) => {
    manager.start();

    assert.ok(manager.recorders.has("ios"));
    assert.ok(manager.recorders.has("android::emulator-5554"));
    assert.equal(manager.selectedSourceKey, "ios");
    assert.equal(store.currentSessions().length, 2);

    manager.recorders.get("android::emulator-5554").source.emitLine("android-one");

    assert.equal(store.snapshot("ios").length, 0);
    assert.equal(store.snapshot("android::emulator-5554").length, 1);

    manager.select("android", { deviceSerial: "emulator-5554" });

    assert.equal(manager.selectedSourceKey, "android::emulator-5554");
    assert.equal(store.snapshot().length, 1);
  });
});

test("adapts to Android-only environments", () => {
  withManager(androidOnly(), ({ manager, store }) => {
    manager.start();

    assert.equal(manager.selectedSourceKey, "android::emulator-5554");
    assert.ok(manager.recorders.has("android::emulator-5554"));
    assert.equal(manager.recorders.has("ios"), false);
    assert.equal(store.currentSession().sourceKey, "android::emulator-5554");
  });
});

test("adapts to iOS-only environments", () => {
  withManager(iosOnly(), ({ manager, store }) => {
    manager.start();

    assert.equal(manager.selectedSourceKey, "ios");
    assert.ok(manager.recorders.has("ios"));
    assert.equal(manager.recorders.has("android::emulator-5554"), false);
    assert.equal(store.currentSession().sourceKey, "ios");
  });
});

test("clear markers only reset the matching source session", () => {
  withManager(bothPlatforms(), ({ manager, store }) => {
    manager.start();

    const iosSessionId = store.currentSession("ios").id;
    const androidSessionId = store.currentSession("android::emulator-5554").id;

    manager.recorders.get("ios").source.emitLine("ios-one");
    manager.recorders.get("android::emulator-5554").source.emitLine("android-one");
    manager.recorders.get("android::emulator-5554").source.emitLine("clear");

    assert.equal(store.currentSession("ios").id, iosSessionId);
    assert.notEqual(store.currentSession("android::emulator-5554").id, androidSessionId);
    assert.equal(store.snapshot("ios").length, 1);
    assert.equal(store.snapshot("android::emulator-5554").length, 0);
  });
});

function bothPlatforms() {
  return {
    ios: {
      available: true,
      hasBooted: true,
      booted: [{ name: "iPhone 16", udid: "00000000-0000-0000-0000-000000000000" }]
    },
    android: {
      available: true,
      hasDevices: true,
      adb: "adb",
      devices: [{ serial: "emulator-5554", label: "Pixel_8", state: "device", meta: {} }]
    }
  };
}

function androidOnly() {
  return {
    ios: { available: false, hasBooted: false, booted: [] },
    android: {
      available: true,
      hasDevices: true,
      adb: "adb",
      devices: [{ serial: "emulator-5554", label: "Pixel_8", state: "device", meta: {} }]
    }
  };
}

function iosOnly() {
  return {
    ios: {
      available: true,
      hasBooted: true,
      booted: [{ name: "iPhone 16", udid: "00000000-0000-0000-0000-000000000000" }]
    },
    android: { available: false, hasDevices: false, adb: "adb", devices: [] }
  };
}

class FakeSource extends EventEmitter {
  constructor(kind, opts) {
    super();
    this.kind = kind;
    this.opts = opts;
    this.status = { running: false, message: `${kind} stopped` };
  }

  start() {
    this.status = { running: true, message: `${this.kind} running` };
    this.emit("status", this.status);
  }

  stop() {
    this.status = { running: false, message: `${this.kind} stopped` };
    this.emit("status", this.status);
  }

  restart() {
    this.stop();
    this.start();
  }

  emitLine(line) {
    this.emit("line", line);
  }
}

class FakeParser {
  constructor(kind) {
    this.kind = kind;
  }

  pushLine(line) {
    if (line === "clear") return [{ type: "clear", reason: "log-marker" }];
    return [{
      type: "upsert",
      event: {
        id: `${this.kind}-${line}`,
        method: "GET",
        url: `https://example.com/${line}`,
        path: `/${line}`,
        state: "success"
      }
    }];
  }

  flush() {
    return [];
  }

  reset() {
    // no state in the fake parser
  }
}
