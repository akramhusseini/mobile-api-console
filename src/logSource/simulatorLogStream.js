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

function isNoisySimulatorWarning(line) {
  return line.includes("getpwuid_r did not find a match for uid");
}

class SimulatorLogStream extends LogSource {
  constructor({ simulator, predicate }) {
    super({
      mode: "simulator",
      extras: { predicate, simulator }
    });
    this.simulator = simulator;
    this.predicate = predicate;
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

    const args = [
      "simctl",
      "spawn",
      this.simulator,
      "log",
      "stream",
      "--style",
      "compact",
      "--level",
      "debug",
      "--predicate",
      this.predicate
    ];

    this.child = spawn("xcrun", args, {
      stdio: ["ignore", "pipe", "pipe"]
    });

    this.setStatus({
      running: true,
      message: `Streaming ${this.simulator} simulator logs`
    });

    const stdout = new LineBuffer((line) => this.emit("line", line));
    const stderr = new LineBuffer((line) => {
      if (!line.trim()) return;
      if (isNoisySimulatorWarning(line)) {
        this.emit("stderr", line);
        return;
      }
      this.status.lastError = line;
      this.emit("stderr", line);
      this.setStatus({
        running: Boolean(this.child),
        message: line
      });
    });

    this.child.stdout.on("data", (chunk) => stdout.push(chunk));
    this.child.stderr.on("data", (chunk) => stderr.push(chunk));

    this.child.on("error", (error) => {
      this.setStatus({
        running: false,
        message: `Unable to start xcrun: ${error.message}`,
        lastError: error.message
      });
      this.scheduleRestart();
    });

    this.child.on("exit", (code, signal) => {
      stdout.flush();
      stderr.flush();
      if (this.killTimer) {
        clearTimeout(this.killTimer);
        this.killTimer = null;
      }
      this.child = null;

      const suffix = signal ? `signal ${signal}` : `code ${code}`;
      this.setStatus({
        running: false,
        message: this.stopping ? "Stopped" : `Log stream ended (${suffix})`
      });

      if (!this.stopping) {
        this.scheduleRestart();
      }
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
      if (this.child === child) {
        child.kill("SIGKILL");
      }
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

module.exports = { SimulatorLogStream };
