#!/usr/bin/env node
"use strict";

const { McpServer } = require("@modelcontextprotocol/sdk/server/mcp.js");
const { StdioServerTransport } = require("@modelcontextprotocol/sdk/server/stdio.js");
const { z } = require("zod");

const { buildConfig } = require("../config");
const { ApiConsoleQueryService, redactText, redactValue } = require("./queryService");

const platform = z.enum(["ios", "android", "browser", "demo", "other"]);
const timeFields = {
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().describe("One local calendar day in YYYY-MM-DD form."),
  timeZone: z.string().optional().describe("IANA timezone for day, such as Asia/Amman. Defaults to the Mac's timezone."),
  from: z.string().datetime({ offset: true }).optional().describe("Inclusive ISO-8601 timestamp."),
  to: z.string().datetime({ offset: true }).optional().describe("Exclusive ISO-8601 timestamp."),
  lastMinutes: z.number().int().positive().max(525600).optional().describe("Relative window ending now. Ignored when day is present.")
};
const sourceFields = {
  platform: platform.optional(),
  sourceKinds: z.array(z.string()).max(20).optional().describe("Exact source kinds, e.g. ios-simulator, ios-device, android-emulator, browser-chromium."),
  device: z.string().optional().describe("Case-insensitive partial simulator UDID/name, Android serial, browser profile id, or session label."),
  browserOrigin: z.string().optional().describe("Case-insensitive partial browser page origin."),
  browserProfileId: z.string().optional().describe("Exact browser profile id."),
  browserContext: z.enum(["regular", "incognito"]).optional()
};
const eventFilterFields = {
  ...timeFields,
  ...sourceFields,
  sessionIds: z.array(z.number().int().positive()).max(100).optional(),
  methods: z.array(z.string()).max(20).optional(),
  statusCodes: z.array(z.number().int().min(100).max(599)).max(100).optional(),
  statusClass: z.enum(["1xx", "2xx", "3xx", "4xx", "5xx"]).optional(),
  states: z.array(z.enum(["pending", "success", "error"])).max(3).optional(),
  host: z.string().optional().describe("Exact API host."),
  pathContains: z.string().optional().describe("Case-insensitive endpoint/path fragment."),
  query: z.string().optional().describe("Full-text substring across URL, path, host, request, response, and errors."),
  hasResponse: z.boolean().optional(),
  includeHeartbeats: z.boolean().default(false).describe("Heartbeat calls are excluded by default.")
};

function createApiConsoleMcpServer({ databasePath } = {}) {
  const service = new ApiConsoleQueryService({ databasePath });
  const server = new McpServer(
    { name: "mobile-api-console", version: "0.2.0" },
    {
      instructions: [
        "This server provides read-only access to locally captured mobile and browser API traffic.",
        "Call api_catalog when source/device/session values are unknown.",
        "Use search_api_calls for compact metadata and get_api_call only for the few bodies or headers actually needed.",
        "Prefer day plus timeZone for calendar-day questions. Heartbeats are excluded unless explicitly requested.",
        "Pagination cursors are opaque. Sensitive headers and common secret fields are always redacted."
      ].join(" ")
    }
  );
  const readOnlyAnnotations = {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false
  };

  server.registerTool("api_catalog", {
    title: "Inspect API capture catalog",
    description: "Discover available platforms, device/profile identities, source kinds, browser origins, methods, hosts, status codes, event counts, errors, and captured time bounds. Returns no bodies or headers.",
    inputSchema: z.object({ ...timeFields, includeHeartbeats: z.boolean().default(false) }),
    annotations: readOnlyAnnotations
  }, toolHandler((args) => service.catalog(args)));

  server.registerTool("list_api_sessions", {
    title: "List API capture sessions",
    description: "List paginated capture sessions filtered by calendar day/time range, platform, simulator/device/browser profile, origin, or source kind.",
    inputSchema: z.object({
      ...timeFields,
      ...sourceFields,
      openOnly: z.boolean().optional(),
      withEventsOnly: z.boolean().default(true),
      limit: z.number().int().min(1).max(200).default(50),
      cursor: z.string().optional()
    }),
    annotations: readOnlyAnnotations
  }, toolHandler((args) => service.listSessions(args)));

  server.registerTool("search_api_calls", {
    title: "Search captured API calls",
    description: "Return compact paginated API-call metadata using precise time, platform, device/profile, session, method, status, host, endpoint, response-presence, and full-text filters. Does not return headers or bodies; follow with get_api_call for selected events.",
    inputSchema: z.object({
      ...eventFilterFields,
      limit: z.number().int().min(1).max(200).default(50),
      cursor: z.string().optional(),
      includeTotal: z.boolean().default(false)
    }),
    annotations: readOnlyAnnotations
  }, toolHandler((args) => service.searchEvents(args)));

  server.registerTool("get_api_call", {
    title: "Get one captured API call",
    description: "Fetch one event's selected request/response details. Bodies, headers, cURL, and raw capture are opt-in to keep context small. Sensitive headers and common secret fields are always redacted.",
    inputSchema: z.object({
      eventId: z.string().min(1),
      sessionId: z.number().int().positive().optional().describe("Use when the client event id may exist in multiple sessions."),
      include: z.object({
        requestHeaders: z.boolean().default(false),
        requestBody: z.boolean().default(false),
        responseHeaders: z.boolean().default(false),
        responseBody: z.boolean().default(false),
        errors: z.boolean().default(true),
        curl: z.boolean().default(false),
        raw: z.boolean().default(false),
        captureMetadata: z.boolean().default(true)
      }).default({}),
      maxBodyChars: z.number().int().min(0).max(200000).default(20000)
    }),
    annotations: readOnlyAnnotations
  }, toolHandler((args) => {
    const event = service.getEvent(args);
    if (!event) throw new Error("API call not found");
    return event;
  }));

  server.registerTool("summarize_api_calls", {
    title: "Summarize captured API calls",
    description: "Aggregate matching calls by endpoint, method, status, platform, source kind, session, or host with counts, errors, durations, and time bounds.",
    inputSchema: z.object({
      ...eventFilterFields,
      groupBy: z.enum(["endpoint", "method", "status", "platform", "sourceKind", "session", "host"]).default("endpoint"),
      limit: z.number().int().min(1).max(100).default(25)
    }),
    annotations: readOnlyAnnotations
  }, toolHandler((args) => service.summarizeEvents(args)));

  return { server, service };
}

function toolHandler(operation) {
  return async (args) => {
    try {
      const result = redactValue(operation(args || {}));
      return {
        content: [{ type: "text", text: redactText(JSON.stringify(result, null, 2)) }]
      };
    } catch (error) {
      return {
        content: [{ type: "text", text: redactText(redactValue(error instanceof Error ? error.message : String(error))) }],
        isError: true
      };
    }
  };
}

async function main() {
  const config = buildConfig(process.argv.slice(2), process.env, process.cwd());
  const { server, service } = createApiConsoleMcpServer({ databasePath: config.databasePath });
  const shutdown = async () => {
    service.close();
    await server.close();
  };
  process.once("SIGINT", () => { shutdown().finally(() => process.exit(0)); });
  process.once("SIGTERM", () => { shutdown().finally(() => process.exit(0)); });
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`mobile-api-console MCP failed: ${error.message}\n`);
    process.exit(1);
  });
}

module.exports = { createApiConsoleMcpServer, main };
