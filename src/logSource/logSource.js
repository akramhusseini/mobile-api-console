"use strict";

const { EventEmitter } = require("node:events");

/**
 * Base class for log sources that feed the parser.
 *
 * Concrete sources MUST:
 *   - implement start()
 *   - emit "line" (string) for each raw log line they observe
 *   - keep `this.status` populated and call setStatus() on every change
 *
 * Concrete sources MAY:
 *   - implement stop() (default is a no-op)
 *   - implement restart() (default: stop() then start() after a short delay)
 *   - emit "stderr" (string) for sideband warnings the user may want to see
 *
 * Status shape (extend freely with source-specific fields):
 *   { running: boolean,
 *     mode: string,          // "simulator" | "demo" | "http" | ...
 *     message: string,       // human-readable current state
 *     lastError: string,     // last error text (empty if none)
 *     ...                    // source-specific extras
 *   }
 *
 * To add a new adapter:
 *   1. Subclass LogSource.
 *   2. Set this.status.mode to a unique string in the constructor (via super()).
 *   3. In start(), open whatever stream/socket/process you need and emit
 *      "line" for each parsed line. Update this.setStatus({...}) so the UI
 *      reflects connectivity.
 *   4. Wire it in via server.js (or a new --source flag).
 */
class LogSource extends EventEmitter {
  constructor({ mode = "unknown", message = "Not started", extras = {} } = {}) {
    super();
    this.status = {
      running: false,
      mode,
      message,
      lastError: "",
      ...extras
    };
  }

  start() {
    throw new Error(`${this.constructor.name} must implement start()`);
  }

  stop() {
    // default no-op
  }

  restart() {
    this.stop();
    setTimeout(() => this.start(), 100);
  }

  setStatus(next) {
    this.status = { ...this.status, ...next };
    this.emit("status", this.status);
  }
}

module.exports = { LogSource };
