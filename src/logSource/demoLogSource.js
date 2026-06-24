"use strict";

const { LogSource } = require("./logSource");

const paths = [
  "/api/v1/courses/1/contents?types=section,lesson,chapter",
  "/api/v1/schedule?day=3",
  "/api/v1/classes/42/attendance",
  "/api/v1/messages?page=1"
];

class DemoLogSource extends LogSource {
  constructor() {
    super({
      mode: "demo",
      message: "Demo source not started",
      extras: { predicate: "demo", simulator: "demo" }
    });
    this.timer = null;
    this.index = 0;
  }

  start() {
    if (this.timer) return;
    this.setStatus({ running: true, message: "Demo source streaming" });
    this.emitSample();
    this.timer = setInterval(() => this.emitSample(), 2200);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.setStatus({ running: false, message: "Demo source stopped" });
  }

  restart() {
    this.stop();
    this.start();
  }

  emitSample() {
    const path = paths[this.index % paths.length];
    const method = this.index % 3 === 0 ? "POST" : "GET";
    const status = this.index % 5 === 4 ? 422 : 200;
    const url = `https://api.example.test${path}`;
    const body = status >= 400
      ? '{"message":"Failed to decode slot_id","errors":{"slot_id":["Invalid slot id"]}}'
      : '{"data":[{"id":1,"title":"Sample item"}],"meta":{"source":"demo"}}';

    const lines = [
      "",
      "===== REQUEST =====",
      `URL: ${url}`,
      `Method: ${method}`,
      "Headers:",
      "  Accept: application/json",
      "  X-App-Locale: en",
      method === "POST" ? 'Body: {"demo":true}' : "",
      "====================",
      "",
      "===== CURL COMMAND =====",
      `curl -X ${method} \\`,
      "  -H 'Accept: application/json' \\",
      method === "POST" ? "  -d '{\"demo\":true}' \\" : "",
      `  '${url}'`,
      "===========================",
      "",
      "===== RESPONSE =====",
      `Status Code: ${status}`,
      `URL: ${url}`,
      "Headers:",
      "  Content-Type: application/json",
      "  Cache-Control: no-cache, private",
      "Body:",
      body,
      "======================"
    ].filter(Boolean);

    for (const line of lines) {
      this.emit("line", line);
    }

    this.index += 1;
  }
}

module.exports = { DemoLogSource };
