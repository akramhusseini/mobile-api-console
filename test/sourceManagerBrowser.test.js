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

function withManager(config, detection, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mac-srcmgr-browser-"));
  const dbPath = path.join(dir, "data.db");
  const storage = new SqliteStorage({ databasePath: dbPath }).init();
  const store = new EventStore({ storage });
  const hub = new FakeHub();
  const manager = new SourceManager({ config, store, hub });
  manager.detection = detection;
  manager.makeSource = (kind, opts) => new FakeSource(kind, opts);
  manager.makeParser = (kind) => new FakeParser(kind);

  try {
    return fn({ manager, store, storage, hub });
  } finally {
    manager.stop();
    storage.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function baseConfig(overrides = {}) {
  return {
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
    browser: { enabled: false, targetUrls: [], requestUrls: [] },
    ...overrides
  };
}

function noDevices() {
  return {
    ios: { available: false, hasBooted: false, booted: [] },
    android: { available: false, hasDevices: false, devices: [], adb: "adb" }
  };
}

function wireEvent(overrides = {}) {
  return {
    v: 1,
    sourceKind: "browser-chromium",
    browserSession: {
      origin: "https://app.example.com",
      profileId: "bprof_8f3d1b6c9a2e4f10",
      context: "regular"
    },
    tabId: 17,
    captureMode: "merged",
    eventId: "evt-1",
    phase: "complete",
    request: {
      startedAt: 1751280000000,
      method: "GET",
      url: "https://app.example.com/v1/users",
      headers: { Accept: "application/json" },
      body: null,
      bodyAvailable: true,
      bodyTruncated: false,
      bodyUnavailableReason: null
    },
    response: {
      completedAt: 1751280000042,
      durationMs: 42,
      status: 200,
      headers: { "Content-Type": "application/json" },
      body: '{"data":[]}',
      bodyAvailable: true,
      bodyTruncated: false,
      bodyUnavailableReason: null
    },
    metadata: { pageUrl: "https://app.example.com/" },
    error: null,
    ...overrides
  };
}

test("browser source only appears in the dropdown when enabled", () => {
  withManager(baseConfig({ browser: { enabled: false, targetUrls: [], requestUrls: [] } }), noDevices(), ({ manager }) => {
    manager.start();
    const selectable = manager.list().selectable;
    assert.ok(!selectable.find((s) => s.sourceKey === "browser"),
      "browser must not be selectable when disabled");
  });

  withManager(baseConfig({ browser: { enabled: true, targetUrls: ["https://app.example.com/*"], requestUrls: [] } }), noDevices(), ({ manager }) => {
    manager.start();
    const selectable = manager.list().selectable;
    const browser = selectable.find((s) => s.sourceKey === "browser");
    assert.ok(browser, "browser must be selectable when enabled");
    assert.equal(browser.kind, "browser");
    assert.equal(browser.label, "Browser");
  });
});

test("configureBrowser enables Browser source without a restart", () => {
  withManager(baseConfig({ browser: { enabled: false, targetUrls: [], requestUrls: [] } }), noDevices(), ({ manager, store }) => {
    manager.start();
    assert.ok(!manager.list().selectable.find((s) => s.sourceKey === "browser"));

    manager.configureBrowser({
      enabled: true,
      targetUrls: ["https://app.example.com/*"],
      requestUrls: ["https://api.example.com/*"]
    });
    manager.select("browser", {});

    const browser = manager.list().selectable.find((s) => s.sourceKey === "browser");
    assert.ok(browser, "browser must become selectable immediately");
    assert.equal(browser.label, "Browser");
    assert.equal(manager.selectedSourceKey, "browser");
    assert.equal(store.selectedSourceKey, "browser");
    assert.ok(store.sources.has("browser"), "umbrella source must be registered");
  });
});

test("configureBrowser updates an existing Browser recorder label and status", () => {
  withManager(
    baseConfig({ browser: { enabled: true, targetUrls: ["https://old.example/*"], requestUrls: [] } }),
    noDevices(),
    ({ manager }) => {
      manager.start();
      const recorder = manager.recorders.get("browser");
      assert.ok(recorder, "browser recorder should start");

      manager.configureBrowser({
        enabled: true,
        targetUrls: ["https://new.example/*"],
        requestUrls: ["https://api.example/*"]
      });

      assert.equal(manager.list().selectable.find((s) => s.sourceKey === "browser").label, "Browser");
      assert.equal(recorder.label, "Browser");
      assert.deepEqual(recorder.source.browserConfig.targetUrls, ["https://new.example/*"]);
      assert.deepEqual(recorder.source.browserConfig.requestUrls, ["https://api.example/*"]);
    }
  );
});

test("browser source label stays generic when target patterns change", () => {
  withManager(
    baseConfig({ browser: { enabled: true, targetUrls: ["https://dev.example/*"], requestUrls: [] } }),
    noDevices(),
    ({ manager }) => {
      manager.start();

      manager.configureBrowser({
        enabled: true,
        targetUrls: ["https://preprod.example/*"],
        requestUrls: ["https://api.preprod.example/*"]
      });
      manager.ingestBrowserEvent(wireEvent({
        browserSession: {
          origin: "https://runtime.example",
          profileId: "bprof_runtime",
          context: "regular"
        },
        request: {
          ...wireEvent().request,
          url: "https://api.runtime.example/v1/users"
        },
        response: {
          ...wireEvent().response,
          url: "https://api.runtime.example/v1/users"
        },
        metadata: { pageUrl: "https://runtime.example/dashboard" }
      }));

      const browser = manager.list().selectable.find((s) => s.sourceKey === "browser");
      assert.equal(browser.label, "Browser");
      assert.equal(manager.currentDescriptor().label, "Browser");
      assert.equal(browser.currentSession.sourceMetadata.browserSession.origin, "https://runtime.example");
    }
  );
});

test("ingestBrowserEvent lands events in the right (origin, profile, context) session", () => {
  withManager(
    baseConfig({ browser: { enabled: true, targetUrls: ["https://app.example.com/*"], requestUrls: [] } }),
    noDevices(),
    ({ manager, store }) => {
      manager.start();
      const a = wireEvent({ eventId: "evt-a" });
      const b = wireEvent({
        browserSession: {
          origin: "https://app.example.com",
          profileId: "bprof_8f3d1b6c9a2e4f10",
          context: "incognito"
        },
        eventId: "evt-b"
      });
      const c = wireEvent({
        browserSession: {
          origin: "https://other.example.com",
          profileId: "bprof_other",
          context: "regular"
        },
        eventId: "evt-c"
      });

      manager.ingestBrowserEvent(a);
      manager.ingestBrowserEvent(b);
      manager.ingestBrowserEvent(c);

      // Three distinct live browser sessions, all under sourceKey "browser".
      const live = store.currentSessions().filter((s) => s.sourceKey === "browser");
      assert.equal(live.length, 3);

      // Each session should contain only its own event.
      for (const wire of [a, b, c]) {
        const sessionKey = manager.browserParser.sessionKeyFor(wire);
        const session = store.currentSessionByKey(sessionKey);
        const ids = store.eventsForSession(session.id, { limit: 50 }).map((e) => e.id);
        assert.deepEqual(ids, [wire.eventId], `session ${sessionKey} should only contain its own event`);
      }
    }
  );
});

test("clearBrowserSession targets only one session and leaves siblings intact", () => {
  withManager(
    baseConfig({ browser: { enabled: true, targetUrls: ["https://app.example.com/*"], requestUrls: [] } }),
    noDevices(),
    ({ manager, store }) => {
      manager.start();
      const a = wireEvent({ eventId: "evt-a" });
      const b = wireEvent({
        browserSession: {
          origin: "https://other.example.com",
          profileId: "bprof_other",
          context: "regular"
        },
        eventId: "evt-b"
      });
      manager.ingestBrowserEvent(a);
      manager.ingestBrowserEvent(b);

      const beforeClear = store.currentSessions().filter((s) => s.sourceKey === "browser");
      assert.equal(beforeClear.length, 2);

      const cleared = manager.clearBrowserSession(a);
      assert.ok(cleared, "clear must return the new session");

      const afterClear = store.currentSessions().filter((s) => s.sourceKey === "browser");
      assert.equal(afterClear.length, 2, "sibling session must remain live");

      // Old 'a' session is gone; old 'b' session is unchanged.
      const aSession = store.currentSessionByKey(manager.browserParser.sessionKeyFor(a));
      const bSession = store.currentSessionByKey(manager.browserParser.sessionKeyFor(b));
      const aEvents = store.eventsForSession(aSession.id, { limit: 50 });
      const bEvents = store.eventsForSession(bSession.id, { limit: 50 });
      assert.equal(aEvents.length, 0, "cleared session must be empty");
      assert.equal(bEvents.length, 1, "sibling session must keep its event");
    }
  );
});

test("clearBrowserSession for an unknown session is a no-op (returns null)", () => {
  withManager(
    baseConfig({ browser: { enabled: true, targetUrls: [], requestUrls: [] } }),
    noDevices(),
    ({ manager }) => {
      manager.start();
      const ghost = wireEvent({
        browserSession: { origin: "https://never-seen.example", profileId: "p", context: "regular" },
        eventId: "ghost"
      });
      const result = manager.clearBrowserSession(ghost);
      assert.equal(result, null, "no session means no clear");
    }
  );
});

test("ingestBrowserEvent updates the BrowserPushSource status with captureMode + origin", () => {
  withManager(
    baseConfig({ browser: { enabled: true, targetUrls: ["https://app.example.com/*"], requestUrls: [] } }),
    noDevices(),
    ({ manager }) => {
      manager.start();
      const wire = wireEvent({ captureMode: "page-script" });
      manager.ingestBrowserEvent(wire);

      const status = manager.statusFor("browser");
      assert.equal(status.running, true);
      assert.equal(status.lastSeen?.origin, "https://app.example.com");
      assert.equal(status.lastSeen?.captureMode, "page-script");
      assert.ok(status.lastSeen?.at, "lastSeen timestamp must be set");
    }
  );
});

test("browser source coexists with iOS and Android recorders", () => {
  withManager(
    baseConfig({ browser: { enabled: true, targetUrls: ["https://app.example.com/*"], requestUrls: [] } }),
    {
      ios: { available: true, hasBooted: true, booted: [{ name: "iPhone 16", udid: "00000000-0000-0000-0000-000000000000" }] },
      android: { available: true, hasDevices: true, adb: "adb", devices: [{ serial: "emulator-5554", label: "Pixel_8", state: "device", meta: {} }] }
    },
    ({ manager, store }) => {
      manager.start();
      const keys = [...manager.recorders.keys()].sort();
      assert.deepEqual(keys, ["android::emulator-5554", "browser", "ios"],
        "browser, ios, and android must all be running side by side");
      const live = store.currentSessions();
      // iOS, Android, plus the just-in-time browser session that ingest creates.
      assert.ok(live.find((s) => s.sourceKey === "ios"));
      assert.ok(live.find((s) => s.sourceKey === "android::emulator-5554"));
    }
  );
});

test("select('browser') succeeds before any browser traffic and registers the umbrella", () => {
  withManager(
    baseConfig({ browser: { enabled: true, targetUrls: ["https://app.example.com/*"], requestUrls: [] } }),
    noDevices(),
    ({ manager, store }) => {
      // Deliberately skip manager.start() — the user may POST /api/source
      // before anything else has happened.
      assert.doesNotThrow(() => manager.select("browser", {}));
      assert.equal(manager.selectedSourceKey, "browser");
      assert.equal(store.selectedSourceKey, "browser");
      assert.ok(store.sources.has("browser"), "umbrella source must be registered by select()");
      assert.ok(manager.recorders.has("browser"), "browser recorder must be started by select()");
      // No traffic yet, so the snapshot is empty (no live session under the umbrella).
      assert.deepEqual(store.snapshot("browser"), []);
      // But the umbrella is still listed as the selected source.
      const status = manager.statusFor("browser");
      assert.equal(status.sourceKey, "browser");
    }
  );
});

test("select('browser') succeeds after first browser ingest and snapshot returns the live event", () => {
  withManager(
    baseConfig({ browser: { enabled: true, targetUrls: ["https://app.example.com/*"], requestUrls: [] } }),
    noDevices(),
    ({ manager, store }) => {
      manager.start();
      const wire = wireEvent({ eventId: "evt-1" });
      manager.ingestBrowserEvent(wire);

      // Selecting the umbrella after ingest must not throw and must
      // surface the live session.
      assert.doesNotThrow(() => manager.select("browser", {}));
      assert.equal(manager.selectedSourceKey, "browser");
      assert.equal(store.selectedSourceKey, "browser");

      const live = store.currentSession("browser");
      assert.ok(live, "currentSession('browser') must surface the most recent live browser session");
      assert.equal(live.sourceKey, "browser");

      const events = store.snapshot("browser");
      assert.equal(events.length, 1);
      assert.equal(events[0].id, "evt-1");
    }
  );
});

test("selecting browser after ingest fires event-upsert so SSE clients see the live event", () => {
  withManager(
    baseConfig({ browser: { enabled: true, targetUrls: ["https://app.example.com/*"], requestUrls: [] } }),
    noDevices(),
    ({ manager, store, hub }) => {
      manager.start();
      // Wire the same broadcaster the server wires in main().
      store.on("upsert", (event) => hub.broadcast("event-upsert", event));

      // Select the browser umbrella BEFORE any ingest so the selection path
      // runs first; then ingest one event and verify the broadcast.
      manager.select("browser", {});
      manager.ingestBrowserEvent(wireEvent({ eventId: "evt-bcast" }));

      // The hub splits each event into "event: X\n" + "data: ...\n\n"
      // chunks, so stitch them back together to find the data line.
      const stitched = hub.broadcasts.join("");
      const eventMatches = stitched.match(/event: event-upsert\ndata: ({.*})\n\n/g) || [];
      assert.equal(eventMatches.length, 1, "hub must broadcast one event-upsert for the ingested event");
      const dataLine = eventMatches[0].split("\n").find((line) => line.startsWith("data: "));
      assert.ok(dataLine);
      const payload = JSON.parse(dataLine.slice("data: ".length));
      assert.equal(payload.id, "evt-bcast");
      assert.equal(payload.sourceKey, "browser");
    }
  );
});

class FakeSource extends EventEmitter {
  constructor(kind, opts) {
    super();
    this.kind = kind;
    this.opts = opts;
    this.status = { running: false, message: `${kind} stopped` };
  }

  start() {
    this.status = { running: true, message: `${this.kind} running`, mode: this.kind };
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

  noteIngest(payload) {
    this.status = { ...this.status, lastSeen: { ...payload, at: new Date().toISOString() } };
    this.emit("status", this.status);
  }

  configure(config) {
    this.browserConfig = {
      targetUrls: config.targetUrls || [],
      requestUrls: config.requestUrls || []
    };
    this.status = {
      ...this.status,
      running: true,
      message: "browser configured"
    };
    this.emit("status", this.status);
  }
}

class FakeParser {
  constructor(kind) {
    this.kind = kind;
  }

  pushLine() {
    return [];
  }

  flush() {
    return [];
  }

  reset() {
    // no parser state
  }
}

class FakeHub {
  constructor() {
    this.clients = new Set();
    this.broadcasts = [];
  }

  add(_client) {
    const client = { res: { write: (chunk) => this.broadcasts.push(chunk), end: () => {} }, writes: this.broadcasts };
    this.clients.add(client);
    return client;
  }

  send(client, type, payload) {
    client.res.write(`event: ${type}\n`);
    client.res.write(`data: ${JSON.stringify(payload)}\n\n`);
  }

  broadcast(type, payload) {
    this.broadcasts.push(`event: ${type}\n`);
    this.broadcasts.push(`data: ${JSON.stringify(payload)}\n\n`);
  }

  startHeartbeat() {}
  stopHeartbeat() {}
  closeAll() {
    this.clients.clear();
  }
}
