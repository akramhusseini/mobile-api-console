"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { StdioClientTransport } = require("@modelcontextprotocol/sdk/client/stdio.js");
const { SqliteStorage } = require("../src/storage/sqliteStorage");

test("stdio MCP server lists and executes read-only API tools", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mobile-api-console-mcp-stdio-"));
  const databasePath = path.join(dir, "data.db");
  const storage = new SqliteStorage({ databasePath }).init();
  const session = storage.createSession({
    sourceKind: "ios-simulator",
    sourceMetadata: { sourceKey: "ios", udid: "SIM-STDIO" },
    startedAt: "2026-07-14T10:00:00.000Z"
  });
  storage.saveEvent(session.id, {
    id: "stdio-event",
    method: "GET",
    url: "https://api.example/v1/profile",
    host: "api.example",
    path: "/v1/profile",
    statusCode: 200,
    state: "success",
    startedAt: "2026-07-14T10:01:00.000Z",
    response: { statusCode: 200, body: "{}" }
  });
  storage.saveEvent(session.id, {
    id: "malformed-method",
    method: "GET\\nHeaders:\\n  Authorization: Bearer 2077|server-Boundary-Secret",
    url: "https://api.example/v1/courses",
    host: "api.example",
    path: "/v1/courses",
    statusCode: 200,
    state: "success",
    startedAt: "2026-07-14T10:02:00.000Z",
    meta: { diagnostic: "Authorization: Bearer metadata-secret" }
  });
  storage.close();

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [path.join(__dirname, "..", "src", "mcp", "server.js"), "--db", databasePath],
    stderr: "pipe"
  });
  const client = new Client({ name: "mobile-api-console-test", version: "1.0.0" });
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    assert.deepEqual(tools.tools.map((tool) => tool.name).sort(), [
      "api_catalog",
      "get_api_call",
      "list_api_sessions",
      "search_api_calls",
      "summarize_api_calls"
    ]);

    const result = await client.callTool({ name: "search_api_calls", arguments: { platform: "ios" } });
    assert.equal(result.isError, undefined);
    const payload = JSON.parse(result.content[0].text);
    assert.equal(payload.items.length, 2);
    assert.ok(payload.items.some((item) => item.eventId === "stdio-event"));

    const catalogResult = await client.callTool({ name: "api_catalog", arguments: {} });
    const catalogText = catalogResult.content[0].text;
    assert.ok(!catalogText.toLowerCase().includes("server-boundary-secret"));
    assert.ok(!catalogText.toLowerCase().includes("metadata-secret"));
    assert.match(catalogText, /\"method\": \"GET\"/);
    const catalogPayload = JSON.parse(catalogText);
    assert.equal(catalogPayload.methods.filter((item) => item.method.length > 10).length, 0);

    const detailResult = await client.callTool({
      name: "get_api_call",
      arguments: { eventId: "malformed-method", include: { captureMetadata: true } }
    });
    assert.ok(!detailResult.content[0].text.toLowerCase().includes("server-boundary-secret"));
    assert.ok(!detailResult.content[0].text.toLowerCase().includes("metadata-secret"));
    assert.match(detailResult.content[0].text, /\[REDACTED\]/);
  } finally {
    await client.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
