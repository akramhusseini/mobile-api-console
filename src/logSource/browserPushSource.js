"use strict";

const { LogSource } = require("./logSource");

// The browser source is push-driven: the extension's background service
// worker POSTs to /api/browser-event and the server handler in turn
// normalizes the wire format and upserts it into the EventStore. There is
// no child process to spawn. This source is a placeholder so the
// SourceManager has a real "recorder" object to start/stop and so the
// status broadcasts use the same shape as iOS / Android / Demo.
class BrowserPushSource extends LogSource {
  constructor({ targetUrls = [], requestUrls = [] } = {}) {
    super({
      mode: "browser",
      message: "Browser source ready",
      extras: { targetUrls, requestUrls }
    });
    this.targetUrls = Array.isArray(targetUrls) ? targetUrls : [];
    this.requestUrls = Array.isArray(requestUrls) ? requestUrls : [];
  }

  start() {
    this.setStatus({
      running: true,
      message: this.enabledMessage()
    });
  }

  stop() {
    this.setStatus({ running: false, message: "Browser source stopped" });
  }

  restart() {
    this.stop();
    setTimeout(() => this.start(), 50);
  }

  configure({ targetUrls = [], requestUrls = [] } = {}) {
    this.targetUrls = Array.isArray(targetUrls) ? targetUrls : [];
    this.requestUrls = Array.isArray(requestUrls) ? requestUrls : [];
    this.setStatus({
      running: true,
      message: this.enabledMessage(),
      targetUrls: this.targetUrls,
      requestUrls: this.requestUrls
    });
  }

  // Server-side hooks that the ingest path calls so the source can update
  // its status when an event lands. Best-effort: never throws.
  noteIngest({ captureMode, origin, phase, error = null } = {}) {
    const lastSeen = this.status.lastSeen || {};
    if (origin) lastSeen.origin = origin;
    if (captureMode) lastSeen.captureMode = captureMode;
    lastSeen.phase = phase || null;
    if (error) lastSeen.lastError = error;
    lastSeen.at = new Date().toISOString();
    this.setStatus({
      running: true,
      message: this.enabledMessage(),
      lastSeen
    });
  }

  enabledMessage() {
    if (this.status.lastError) {
      return `Browser source: ${this.status.lastError}`;
    }
    return "Browser source ready";
  }
}

module.exports = { BrowserPushSource };
