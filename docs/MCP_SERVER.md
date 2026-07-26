# Mobile API Console MCP Server

The repository includes a local read-only MCP server for querying its SQLite capture database from Codex or Claude Code. It uses stdio, opens the database with SQLite `readonly` and `query_only` enabled, and does not expose a network listener.

## Tools

- `api_catalog`: discover captured time ranges, platforms, devices/profiles, methods, hosts, and statuses.
- `list_api_sessions`: page through sessions by day, source, simulator/device, or browser identity.
- `search_api_calls`: search compact API event metadata with time, source, endpoint, status, and text filters.
- `get_api_call`: load selected request/response sections for one event.
- `summarize_api_calls`: aggregate calls and errors by endpoint, method, status, platform, session, or host.

Heartbeat calls are excluded by default. Headers and bodies are opt-in and capped.
Every MCP result and error passes through recursive redaction and a final serialized-text
redaction pass, so common secrets are scrubbed even when malformed capture data places
them in an unexpected field. Real and literal escaped newlines are normalized before
catalog aggregation; legacy multiline HTTP methods therefore collapse to their verb.

## Run

```sh
npm install
npm run mcp
```

The launcher is also available at `bin/mobile-api-console-mcp`. Pass `--db /absolute/path/data.db` or set `MOBILE_API_CONSOLE_DB` to override the normal console database.

## Codex

Register the repository launcher as a user MCP server:

```sh
codex mcp add mobile-api-console -- /absolute/path/mobile-api-console/bin/mobile-api-console-mcp
```

Install or symlink `skills/query-mobile-api-traffic` into the active Codex skills directory to add the query workflow.

## Claude Code

Register it at user scope so it remains available while working in the mobile app repository:

```sh
claude mcp add --scope user mobile-api-console -- /absolute/path/mobile-api-console/bin/mobile-api-console-mcp
```

Install or symlink `skills/query-mobile-api-traffic` into the applicable Claude skills directory.

## Query strategy

Start with `api_catalog` if source identities are unknown. Use `search_api_calls` for compact rows, then call `get_api_call` only for events whose body or headers are required. Calendar-day queries should include an IANA timezone, for example `day: 2026-07-14` and `timeZone: Asia/Amman`.
