"use strict";

class SseHub {
  constructor() {
    this.clients = new Set();
  }

  add(req, res) {
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no"
    });
    res.write(": connected\n\n");

    const client = { res };
    this.clients.add(client);

    req.on("close", () => {
      this.clients.delete(client);
    });

    return client;
  }

  send(client, type, payload) {
    client.res.write(`event: ${type}\n`);
    client.res.write(`data: ${JSON.stringify(payload)}\n\n`);
  }

  broadcast(type, payload) {
    for (const client of this.clients) {
      this.send(client, type, payload);
    }
  }

  closeAll() {
    for (const client of this.clients) {
      try {
        this.send(client, "shutdown", { ok: true });
        client.res.end();
      } catch {
        // Client already disconnected.
      }
    }
    this.clients.clear();
  }
}

module.exports = { SseHub };
