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
  constructor({ config, store, hub } = {}) {
    super();
    this.config = config;
    this.store = store;
    this.hub = hub;
    this.detection = { ios: { available: false }, android: { available: false } };
    this.recorders = new Map();
    this.selectedSourceKey = null;
  }

  async detect() {
    const env = { ...process.env };
    if (this.config.android?.adbPath) env.ADB_PATH = this.config.android.adbPath;
    this.detection = await platform.detectAll(env);
    return this.detection;
  }

  async refresh() {
    await this.detect();
    this.startMissingRecorders();
    if (!this.selectedSourceKey || !this.recorders.has(this.selectedSourceKey)) {
      this.selectSourceKey(this.resolveInitialSourceKey(), { emit: false });
    }
    this.emit("changed", this.list());
    return this.list();
  }

  // Compatibility helper for existing callers/tests. In the multi-source
  // model this is the preferred initial view, not the only running source.
  resolveInitialKind() {
    return kindFromSourceKey(this.resolveInitialSourceKey()) || "demo";
  }

  resolveInitialSourceKey() {
    const keys = new Set(this.desiredRecorderDefinitions().map((definition) => definition.sourceKey));
    for (const definition of this.selectableDefinitions()) keys.add(definition.sourceKey);

    const preference = this.config.demo || this.config.noStream
      ? "demo"
      : (this.config.defaultSource || "auto");

    if (preference === "ios" && keys.has("ios")) return "ios";
    if (preference === "android") {
      const android = [...keys].find((key) => key.startsWith("android::"));
      if (android) return android;
    }
    if (preference === "demo" && keys.has("demo")) return "demo";

    if (keys.has("ios")) return "ios";
    const android = [...keys].find((key) => key.startsWith("android::"));
    if (android) return android;
    if (keys.has("demo")) return "demo";
    return null;
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

  start() {
    this.startMissingRecorders();
    const selected = this.resolveInitialSourceKey();
    if (selected) this.selectSourceKey(selected, { emit: false });
    this.emit("changed", this.list());
  }

  startMissingRecorders() {
    for (const definition of this.desiredRecorderDefinitions()) {
      this.startRecorder(definition);
    }
  }

  desiredRecorderDefinitions() {
    if (this.config.demo || this.config.noStream || this.config.defaultSource === "demo") {
      return [this.demoDefinition()];
    }

    const definitions = [];
    if (this.detection.ios.available && this.detection.ios.hasBooted) {
      definitions.push(this.iosDefinition());
    }

    for (const device of this.androidDevicesToRecord()) {
      definitions.push(this.androidDefinition(device));
    }

    return definitions.length ? definitions : [this.demoDefinition()];
  }

  selectableDefinitions() {
    if (this.config.demo || this.config.noStream) {
      return [this.demoDefinition()];
    }

    const definitions = [];

    if (this.detection.ios.available && this.detection.ios.hasBooted) {
      definitions.push(this.iosDefinition());
    }

    for (const device of this.androidDevicesToSelect()) {
      definitions.push(this.androidDefinition(device));
    }

    definitions.push(this.demoDefinition());
    return uniqueDefinitions(definitions);
  }

  androidDevicesToRecord() {
    if (!this.detection.android.available || !this.detection.android.hasDevices) return [];
    const devices = this.detection.android.devices || [];
    const configured = this.config.android?.deviceSerial || null;
    if (!configured) return devices;
    return devices.filter((device) => device.serial === configured);
  }

  androidDevicesToSelect() {
    if (!this.detection.android.available || !this.detection.android.hasDevices) return [];
    return this.detection.android.devices || [];
  }

  iosDefinition() {
    return {
      sourceKey: "ios",
      kind: "ios",
      opts: {},
      label: this.iosLabel()
    };
  }

  androidDefinition(device = {}) {
    const opts = { deviceSerial: device.serial || null };
    return {
      sourceKey: sourceKeyFor("android", opts),
      kind: "android",
      opts,
      label: device.label ? `Android (${device.label})` : "Android",
      device
    };
  }

  demoDefinition() {
    return {
      sourceKey: "demo",
      kind: "demo",
      opts: {},
      label: "Demo (offline)"
    };
  }

  list() {
    const selectable = this.selectableDefinitions().map((definition) => {
      const recorder = this.recorders.get(definition.sourceKey);
      return {
        sourceKey: definition.sourceKey,
        kind: definition.kind,
        opts: definition.opts,
        label: definition.label,
        running: Boolean(recorder),
        status: this.statusFor(definition.sourceKey),
        currentSession: this.store?.currentSession(definition.sourceKey) || null
      };
    });

    const current = this.currentDescriptor();
    return {
      current,
      selectedSourceKey: this.selectedSourceKey,
      selectedStatus: this.statusFor(this.selectedSourceKey),
      selectable,
      active: [...this.recorders.values()].map((recorder) => this.recorderDescriptor(recorder)),
      available: this.legacyAvailableList(),
      detection: {
        ios: {
          available: this.detection.ios.available,
          hasBooted: this.detection.ios.hasBooted,
          booted: this.detection.ios.booted
        },
        android: {
          available: this.detection.android.available,
          hasDevices: this.detection.android.hasDevices,
          devices: this.detection.android.devices
        }
      }
    };
  }

  legacyAvailableList() {
    const available = [];
    if (this.detection.ios.available && this.detection.ios.hasBooted) {
      available.push({
        kind: "ios",
        label: this.iosLabel(),
        warnings: this.iosWarnings()
      });
    }
    if (this.detection.android.available && this.detection.android.hasDevices) {
      available.push({
        kind: "android",
        label: "Android",
        devices: this.detection.android.devices,
        warnings: this.androidWarnings()
      });
    }
    available.push({ kind: "demo", label: "Demo (offline)" });
    return available;
  }

  currentDescriptor() {
    if (!this.selectedSourceKey) return { kind: null, opts: {}, sourceKey: null };
    const recorder = this.recorders.get(this.selectedSourceKey);
    if (recorder) return this.recorderDescriptor(recorder);

    const definition = this.selectableDefinitions()
      .find((entry) => entry.sourceKey === this.selectedSourceKey);
    if (!definition) return { kind: null, opts: {}, sourceKey: this.selectedSourceKey };
    return {
      sourceKey: definition.sourceKey,
      kind: definition.kind,
      opts: definition.opts,
      label: definition.label
    };
  }

  recorderDescriptor(recorder) {
    return {
      sourceKey: recorder.sourceKey,
      kind: recorder.kind,
      opts: recorder.opts,
      label: recorder.label,
      status: this.statusFor(recorder.sourceKey),
      currentSession: this.store?.currentSession(recorder.sourceKey) || null
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

  switchTo(kind, opts = {}) {
    return this.select(kind, opts);
  }

  select(kind, opts = {}) {
    if (!VALID_KINDS.has(kind)) {
      throw new Error(`Unknown source kind: ${kind}`);
    }

    const normalized = this.normalizeSelection(kind, opts);
    const definition = this.definitionForSelection(kind, normalized);
    if (!definition) {
      throw new Error(`Source is not available: ${kind}`);
    }

    this.startRecorder(definition);
    this.selectSourceKey(definition.sourceKey);
  }

  normalizeSelection(kind, opts = {}) {
    if (kind !== "android" || opts.deviceSerial) return opts || {};

    const running = [...this.recorders.values()].find((recorder) => recorder.kind === "android");
    if (running) return running.opts;

    const first = this.androidDevicesToSelect()[0];
    if (first) return { deviceSerial: first.serial };
    return opts || {};
  }

  definitionForSelection(kind, opts = {}) {
    const key = sourceKeyFor(kind, opts);
    return this.selectableDefinitions().find((definition) => definition.sourceKey === key)
      || (kind === "demo" ? this.demoDefinition() : null);
  }

  selectSourceKey(sourceKey, { emit = true } = {}) {
    if (!sourceKey) return;
    if (!this.recorders.has(sourceKey)) {
      const definition = this.selectableDefinitions()
        .find((entry) => entry.sourceKey === sourceKey);
      if (definition) this.startRecorder(definition);
    }
    if (!this.recorders.has(sourceKey)) {
      throw new Error(`Source is not running: ${sourceKey}`);
    }
    this.selectedSourceKey = sourceKey;
    this.store?.selectSource(sourceKey);
    if (emit) this.emit("changed", this.list());
  }

  startRecorder(definition) {
    if (!definition || this.recorders.has(definition.sourceKey)) {
      return this.recorders.get(definition?.sourceKey);
    }

    const { sourceKind, sourceMetadata } = this.kindToSessionMetadata(definition.kind, definition.opts);
    this.store?.ensureSource(definition.sourceKey, { sourceKind, sourceMetadata });

    const recorder = {
      sourceKey: definition.sourceKey,
      kind: definition.kind,
      opts: definition.opts || {},
      label: definition.label,
      parser: this.makeParser(definition.kind),
      source: this.makeSource(definition.kind, definition.opts || {}),
      flushTimer: null
    };

    this.recorders.set(definition.sourceKey, recorder);
    this.wireSource(recorder);
    recorder.source.start();
    return recorder;
  }

  kindToSessionMetadata(kind, opts = {}) {
    if (kind === "ios") {
      return {
        sourceKind: "ios-simulator",
        sourceMetadata: {
          sourceKey: sourceKeyFor(kind, opts),
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
          sourceKey: sourceKeyFor(kind, opts),
          applicationId: this.config.android.applicationId,
          logTag: this.config.android.logTag,
          deviceSerial: opts.deviceSerial || null
        }
      };
    }
    return {
      sourceKind: "demo",
      sourceMetadata: {
        sourceKey: "demo",
        simulator: "demo"
      }
    };
  }

  makeParser(kind) {
    if (kind === "android") return new AndroidApiCurlParser({ logTag: this.config.android.logTag });
    // Both iOS and demo emit the iOS-style block markers.
    return new MobileNetworkParser({ processName: this.config.ios.processName });
  }

  makeSource(kind, opts = {}) {
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

  wireSource(recorder) {
    const { source, parser, sourceKey } = recorder;
    const store = this.store;
    const hub = this.hub;

    source.on("line", (line) => {
      const actions = parser.pushLine(line);
      for (const action of actions) {
        if (action.type === "upsert") store.upsertForSource(sourceKey, action.event);
        if (action.type === "error") store.addErrorForSource(sourceKey, action.message, action.rawLine);
        if (action.type === "clear") {
          if (typeof parser.reset === "function") parser.reset();
          store.clearSource(sourceKey, action.reason);
        }
      }
      this.scheduleQuietFlush(recorder);
    });

    source.on("stderr", (line) => {
      hub?.broadcast("source-stderr", {
        sourceKey,
        kind: recorder.kind,
        line
      });
    });
    source.on("status", (status) => {
      const payload = {
        ...status,
        sourceKey,
        kind: recorder.kind,
        opts: recorder.opts
      };
      hub?.broadcast("source-status", payload);
      this.emit("status", payload);
    });
  }

  // Some log formats (notably Android API_CURL) have no explicit block
  // terminator. Track the quiet flush per recorder so one platform's idle
  // flush cannot finalize another platform's parser state.
  scheduleQuietFlush(recorder) {
    if (!recorder.parser || typeof recorder.parser.flush !== "function") return;
    this.clearQuietFlush(recorder);
    recorder.flushTimer = setTimeout(() => {
      recorder.flushTimer = null;
      this.flushRecorder(recorder);
    }, QUIET_FLUSH_MS);
    recorder.flushTimer.unref?.();
  }

  clearQuietFlush(recorder) {
    if (!recorder?.flushTimer) return;
    clearTimeout(recorder.flushTimer);
    recorder.flushTimer = null;
  }

  flushRecorder(recorder) {
    if (!recorder?.parser || typeof recorder.parser.flush !== "function") return;
    for (const action of recorder.parser.flush()) {
      if (action.type === "upsert") this.store.upsertForSource(recorder.sourceKey, action.event);
      if (action.type === "error") this.store.addErrorForSource(recorder.sourceKey, action.message, action.rawLine);
    }
  }

  stop() {
    for (const recorder of this.recorders.values()) {
      this.clearQuietFlush(recorder);
      if (recorder.source) {
        try { recorder.source.stop(); } catch { /* best-effort */ }
      }
      this.flushRecorder(recorder);
    }
  }

  resetParser(sourceKey = this.selectedSourceKey) {
    const recorder = this.recorders.get(sourceKey);
    if (recorder?.parser && typeof recorder.parser.reset === "function") {
      recorder.parser.reset();
    }
  }

  restart(sourceKey = this.selectedSourceKey) {
    const recorder = this.recorders.get(sourceKey);
    if (recorder?.source && typeof recorder.source.restart === "function") {
      recorder.source.restart();
    }
  }

  statusFor(sourceKey = this.selectedSourceKey) {
    const recorder = this.recorders.get(sourceKey);
    const status = recorder
      ? { ...recorder.source.status }
      : { running: false, message: "Not started" };
    return {
      ...status,
      sourceKey: sourceKey || null,
      kind: recorder?.kind || kindFromSourceKey(sourceKey),
      opts: recorder?.opts || {}
    };
  }

  get status() {
    return this.statusFor(this.selectedSourceKey);
  }
}

function sourceKeyFor(kind, opts = {}) {
  if (kind === "android") return `android::${opts.deviceSerial || ""}`;
  return kind;
}

function kindFromSourceKey(sourceKey) {
  if (!sourceKey) return null;
  if (sourceKey.startsWith("android::")) return "android";
  return sourceKey;
}

function uniqueDefinitions(definitions) {
  const seen = new Set();
  const unique = [];
  for (const definition of definitions) {
    if (seen.has(definition.sourceKey)) continue;
    seen.add(definition.sourceKey);
    unique.push(definition);
  }
  return unique;
}

module.exports = { SourceManager, sourceKeyFor, kindFromSourceKey };
