---
name: query-mobile-api-traffic
description: Query locally captured iOS, Android, and browser API traffic through the read-only mobile-api-console MCP server. Use when investigating recent app requests, comparing simulator and frontend behavior, finding calls for a specific day/device/profile/session/endpoint, checking payloads or responses, tracing backend contract issues, or summarizing API errors and status patterns.
---

# Query Mobile API Traffic

Use the `mobile-api-console` MCP tools as the source of live capture evidence. Keep results narrow and distinguish “not captured in this scope” from “the backend never returned it.”

## Workflow

1. Translate the request into the smallest useful time and source scope.
   - For a calendar day, pass `day` plus the user's IANA `timeZone`.
   - For “just now” or “the latest operation,” start with `lastMinutes`.
   - Set `platform` or `device` when the user names Simulator, Android, or Browser.
2. Call `api_catalog` only when available source, device, origin, method, host, or time values are unknown.
3. Call `search_api_calls` for compact event metadata. Filter by endpoint, method, status, session, or free text before increasing the limit.
4. Call `get_api_call` only for the few selected events that need bodies or headers. Request only the required sections.
5. Use `summarize_api_calls` for counts, error patterns, endpoint frequency, and latency comparisons.
6. Follow `nextCursor` only while additional pages are relevant.

## Evidence Rules

- Treat one event as the merged request/response record; do not infer a missing response while it is still pending.
- Heartbeats are excluded by default. Include them only when heartbeat behavior is the subject.
- Prefer exact event IDs and session IDs when reporting evidence.
- Report the resolved UTC range returned by the tool when calendar-day boundaries matter.
- State filters used and whether more pages remain.
- Never request cURL, raw capture, bodies, or headers speculatively.
- Sensitive headers and common secret fields are always redacted by the server. Do not attempt to bypass redaction or query SQLite directly for secrets.

## Tool Selection

- Discovery: `api_catalog`
- Capture sessions: `list_api_sessions`
- Individual calls: `search_api_calls`
- Selected payload/response: `get_api_call`
- Aggregation: `summarize_api_calls`

Read [references/tools.md](references/tools.md) when constructing advanced filters, pagination, or detail requests.
