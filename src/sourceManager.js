"use strict";

const { EventEmitter } = require("node:events");

const { MobileNetworkParser } = require("./parsers/mobileNetworkParser");
const { AndroidApiCurlParser } = require("./parsers/androidApiCurlParser");
const { SimulatorLogStream } = require("./logSource/simulatorLogStream");
const { AdbLogcatStream } = require("./logSource/adbLogcatStream");
const { DemoLogSource } = require("./logSource/demoLogSource");
const platform = require("./platform");

const VALID_KINDS = new Set(["ios", "android", "demo"]);

const QUIET_FLUSH_MS = 800;

class SourceManager extends EventEmitter {
  constructor({ config, store, hub }) {
    super();
    this.config = config;
    this.store = store;
    this.hub = hub;
    this.detection = { ios: { available: false }, android: { available: false } };
    this.source = null;
    this.parser = null;
    this.currentKind = null;
    this.currentOpts = {};
    this.flushTimer = null;
  }

  async detect() {
    const env = { ...process.env };
    if (this.config.android?.adbPath) env.ADB_PATH = this.config.android.adbPath;
    this.detection = await platform.detectAll(env);
    return this.detection;
  }

  // Returns the kind to start with, given config.defaultSource and detection
  // results. `auto` resolves to whichever platform is currently usable,
  // preferring iOS when both are available.
  resolveInitialKind() {
    if (this.config.demo || this.config.noStream) return "demo";

    const preference = this.config.defaultSource || "auto";
    if (preference !== "auto") {
      if (preference === "ios" && this.detection.ios.available) return "ios";
      if (preference === "android" && this.detection.android.available) return "android";
      if (preference === "demo") return "demo";
      // Configured preference unavailable on this machine — fall through to auto.
    }

    if (this.detection.ios.available) return "ios";
    if (this.detection.android.available) return "android";
    return "demo";
  }

  optsForKind(kind) {
    if (kind === "android") {
      const serial = this.config.android?.deviceSerial
        || this.detection.android?.devices?.[0]?.serial
        || null;
      return { deviceSerial: serial };
    }
    return {};
  }

  list() {
    const available = [];
    if (this.detection.ios.available) {
      available.push({
        kind: "ios",
        label: this.iosLabel(),
        warnings: this.iosWarnings()
      });
    }
    if (this.detection.android.available) {
      available.push({
        kind: "android",
        label: "Android",
        devices: this.detection.android.devices,
        warnings: this.androidWarnings()
      });
    }
    available.push({ kind: "demo", label: "Demo (offline)" });

    return {
      current: { kind: this.currentKind, opts: this.currentOpts },
      available,
      detection: {
        ios: { available: this.detection.ios.available, hasBooted: this.detection.ios.hasBooted, booted: this.detection.ios.booted },
        android: { available: this.detection.android.available, hasDevices: this.detection.android.hasDevices, devices: this.detection.android.devices }
      }
    };
  }

  iosLabel() {
    const booted = this.detection.ios?.booted || [];
    if (booted.length === 1) return `iOS Simulator (${booted[0].name})`;
    if (booted.length > 1) return `iOS Simulator (${booted.length} booted)`;
    return "iOS Simulator";
  }

  iosWarnings() {
    if (!this.detection.ios.hasBooted) return ["No booted iOS simulator detected"];
    return [];
  }

  androidWarnings() {
    if (!this.detection.android.hasDevices) return ["No Android device/emulator detected"];
    return [];
  }

  start() {
    const initial = this.resolveInitialKind();
    const opts = this.optsForKind(initial);
    this.activate(initial, opts);
  }

  switchTo(kind, opts = {}) {
    if (!VALID_KINDS.has(kind)) {
      throw new Error(`Unknown source kind: ${kind}`);
    }
    if (kind === this.currentKind && JSON.stringify(opts) === JSON.stringify(this.currentOpts)) {
      return; // no-op
    }

    this.clearQuietFlush();
    if (this.source) {
      // Detach BEFORE stopping. The old child's exit event fires a few ms
      // after SIGTERM and would otherwise rebroadcast a stale "Stopped"
      // source-status that overwrites the new source's "running" status in
      // the UI.
      this.source.removeAllListeners();
      try { this.source.stop(); } catch { /* best-effort */ }
    }
    this.source = null;
    this.parser = null;

    this.activate(kind, opts, { startsNewSession: true });
  }

  activate(kind, opts, { startsNewSession = false } = {}) {
    this.currentKind = kind;
    this.currentOpts = opts || {};

    const { sourceKind, sourceMetadata } = this.kindToSessionMetadata(kind, opts);
    this.store.setSource(sourceKind, sourceMetadata);
    if (startsNewSession) this.store.clear("source-switch");

    this.parser = this.makeParser(kind);
    this.source = this.makeSource(kind, opts);
    this.wireSource();
    this.source.start();
    this.emit("changed", this.list());
  }

  kindToSessionMetadata(kind, opts) {
    if (kind === "ios") {
      return {
        sourceKind: "ios-simulator",
        sourceMetadata: {
          simulator: this.config.ios.simulator,
          predicate: this.config.ios.predicate,
          processName: this.config.ios.processName
        }
      };
    }
    if (kind === "android") {
      return {
        sourceKind: opts.deviceSerial ? "android-device" : "android-emulator",
        sourceMetadata: {
          applicationId: this.config.android.applicationId,
          logTag: this.config.android.logTag,
          deviceSerial: opts.deviceSerial || null
        }
      };
    }
    return {
      sourceKind: "demo",
      sourceMetadata: { simulator: "demo" }
    };
  }

  makeParser(kind) {
    if (kind === "android") return new AndroidApiCurlParser({ logTag: this.config.android.logTag });
    // Both iOS and demo emit the iOS-style block markers.
    return new MobileNetworkParser({ processName: this.config.ios.processName });
  }

  makeSource(kind, opts) {
    if (kind === "ios") {
      return new SimulatorLogStream({
        simulator: this.config.ios.simulator,
        predicate: this.config.ios.predicate
      });
    }
    if (kind === "android") {
      const adbPath = this.config.android.adbPath || this.detection.android.adb || "adb";
      return new AdbLogcatStream({
        adbPath,
        deviceSerial: opts.deviceSerial || null,
        logTag: this.config.android.logTag
      });
    }
    return new DemoLogSource();
  }

  wireSource() {
    const source = this.source;
    const parser = this.parser;
    const store = this.store;
    const hub = this.hub;

    source.on("line", (line) => {
      const actions = parser.pushLine(line);
      for (const action of actions) {
        if (action.type === "upsert") store.upsert(action.event);
        if (action.type === "error") store.addError(action.message, action.rawLine);
        if (action.type === "clear") store.clear(action.reason);
      }
      this.scheduleQuietFlush();
    });

    source.on("stderr", (line) => hub.broadcast("source-stderr", { line }));
    source.on("status", (status) => hub.broadcast("source-status", { ...status, kind: this.currentKind }));
  }

  // Some log formats (notably Android API_CURL) have no explicit block
  // terminator — a request's body lines just stop arriving. Without a quiet
  // flush the most recent event sits in a half-built state until the *next*
  // request arrives, so its Response tab shows "No response captured yet."
  // even though the body is already in the parser's buffer.
  scheduleQuietFlush() {
    if (!this.parser || typeof this.parser.flush !== "function") return;
    this.clearQuietFlush();
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      if (!this.parser) return;
      for (const action of this.parser.flush()) {
        if (action.type === "upsert") this.store.upsert(action.event);
        if (action.type === "error") this.store.addError(action.message, action.rawLine);
      }
    }, QUIET_FLUSH_MS);
    this.flushTimer.unref?.();
  }

  clearQuietFlush() {
    if (!this.flushTimer) return;
    clearTimeout(this.flushTimer);
    this.flushTimer = null;
  }

  stop() {
    this.clearQuietFlush();
    if (this.source) {
      try { this.source.stop(); } catch { /* best-effort */ }
    }
    if (this.parser && typeof this.parser.flush === "function") {
      const trailing = this.parser.flush();
      for (const action of trailing) {
        if (action.type === "upsert") this.store.upsert(action.event);
      }
    }
  }

  resetParser() {
    if (this.parser && typeof this.parser.reset === "function") this.parser.reset();
  }

  restart() {
    if (this.source && typeof this.source.restart === "function") this.source.restart();
  }

  get status() {
    const status = this.source ? { ...this.source.status } : { running: false, message: "Not started" };
    status.kind = this.currentKind;
    return status;
  }
}

module.exports = { SourceManager };
