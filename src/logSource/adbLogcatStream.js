"use strict";

const { spawn } = require("node:child_process");

const { LogSource } = require("./logSource");

class LineBuffer {
  constructor(onLine) {
    this.onLine = onLine;
    this.buffer = "";
  }

  push(chunk) {
    this.buffer += chunk.toString("utf8");
    let index = this.buffer.indexOf("\n");
    while (index >= 0) {
      const line = this.buffer.slice(0, index).replace(/\r$/, "");
      this.buffer = this.buffer.slice(index + 1);
      this.onLine(line);
      index = this.buffer.indexOf("\n");
    }
  }

  flush() {
    if (!this.buffer) return;
    this.onLine(this.buffer);
    this.buffer = "";
  }
}

class AdbLogcatStream extends LogSource {
  constructor({ adbPath = "adb", deviceSerial = null, logTag = "API_CURL" } = {}) {
    super({
      mode: "android",
      extras: { deviceSerial, logTag }
    });
    this.adbPath = adbPath;
    this.deviceSerial = deviceSerial;
    this.logTag = logTag;
    this.child = null;
    this.stopping = false;
    this.restartTimer = null;
    this.killTimer = null;
    this.restartDelayMs = 2500;
  }

  start() {
    if (this.child) return;
    this.stopping = false;
    this.clearRestart();

    // Reset position to "now" so we don't replay months of old log lines on
    // every restart. `-T 1` says "deliver entries from 1 second ago onwards".
    const args = [];
    if (this.deviceSerial) args.push("-s", this.deviceSerial);
    args.push("logcat", "-v", "threadtime", "-T", "1", `${this.logTag}:D`, "*:S");

    const child = spawn(this.adbPath, args, {
      stdio: ["ignore", "pipe", "pipe"]
    });
    this.child = child;

    this.setStatus({
      running: true,
      message: this.deviceSerial
        ? `Streaming ${this.logTag} from ${this.deviceSerial}`
        : `Streaming ${this.logTag} from default adb device`
    });

    const stdout = new LineBuffer((line) => this.emit("line", line));
    const stderr = new LineBuffer((line) => {
      if (!line.trim()) return;
      this.status.lastError = line;
      this.emit("stderr", line);
      this.setStatus({
        running: this.child === child,
        message: line
      });
    });

    child.stdout.on("data", (chunk) => stdout.push(chunk));
    child.stderr.on("data", (chunk) => stderr.push(chunk));

    child.on("error", (error) => {
      if (this.child !== child) return; // a newer child has taken over
      this.setStatus({
        running: false,
        message: `Unable to start ${this.adbPath}: ${error.message}`,
        lastError: error.message
      });
      this.scheduleRestart();
    });

    child.on("exit", (code, signal) => {
      stdout.flush();
      stderr.flush();
      // A restart may already have spawned a newer child. Don't touch
      // this.child or rebroadcast status in that case — the new child owns
      // those now.
      if (this.child !== child) return;

      if (this.killTimer) {
        clearTimeout(this.killTimer);
        this.killTimer = null;
      }
      this.child = null;

      const suffix = signal ? `signal ${signal}` : `code ${code}`;
      this.setStatus({
        running: false,
        message: this.stopping ? "Stopped" : `adb logcat ended (${suffix})`
      });

      if (!this.stopping) this.scheduleRestart();
    });
  }

  stop() {
    this.stopping = true;
    this.clearRestart();
    if (!this.child) {
      this.setStatus({ running: false, message: "Stopped" });
      return;
    }

    const child = this.child;
    this.child.kill("SIGTERM");
    this.killTimer = setTimeout(() => {
      if (this.child === child) child.kill("SIGKILL");
    }, 750);
    this.killTimer.unref?.();
  }

  restart() {
    this.stop();
    setTimeout(() => {
      this.stopping = false;
      this.start();
    }, 250);
  }

  scheduleRestart() {
    this.clearRestart();
    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      this.start();
    }, this.restartDelayMs);
  }

  clearRestart() {
    if (!this.restartTimer) return;
    clearTimeout(this.restartTimer);
    this.restartTimer = null;
  }
}

module.exports = { AdbLogcatStream };
