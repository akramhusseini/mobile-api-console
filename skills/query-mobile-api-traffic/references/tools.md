# MCP Tool Reference

## Shared time and source filters

- `day`: local day in `YYYY-MM-DD`.
- `timeZone`: IANA zone such as `Asia/Amman`; use with `day`.
- `from` / `to`: inclusive/exclusive ISO-8601 timestamps with offsets.
- `lastMinutes`: relative window ending now.
- `platform`: `ios`, `android`, `browser`, `demo`, or `other`.
- `sourceKinds`: exact stored kinds such as `ios-simulator`, `ios-device`, `android-emulator`, `android-device`, or `browser-chromium`.
- `device`: partial simulator name/UDID, Android name/serial, browser profile ID, or session label.
- `browserOrigin`, `browserProfileId`, `browserContext`: narrow browser sessions.

`day` takes precedence over relative/from-to fields. Returned `timeRange` shows the resolved interval.

## `api_catalog`

Use for discovery before guessing filter values. It returns counts, captured bounds, platforms, source kinds, devices, browser origins/profiles, methods, hosts, and status codes without payloads.

Example: discover Browser captures for an Amman calendar day.

```json
{"day":"2026-07-14","timeZone":"Asia/Amman","includeHeartbeats":false}
```

## `list_api_sessions`

Use to identify a capture session or compare devices/profiles. Supports shared filters plus `openOnly`, `withEventsOnly`, `limit`, and opaque `cursor`.

## `search_api_calls`

Use for compact event rows. Additional filters:

- `sessionIds`, `methods`, `statusCodes`, `statusClass`, `states`
- `host`, `pathContains`, `query`, `hasResponse`
- `includeHeartbeats` (default false), `includeTotal`, `limit`, `cursor`

Examples:

```json
{"lastMinutes":15,"platform":"ios","methods":["POST"],"pathContains":"announcements","limit":20}
```

```json
{"day":"2026-07-14","timeZone":"Asia/Amman","platform":"browser","statusClass":"4xx","includeTotal":true}
```

## `get_api_call`

Pass `eventId` and, when known, `sessionId`. The `include` object accepts:

- `requestHeaders`, `requestBody`
- `responseHeaders`, `responseBody`
- `errors`, `captureMetadata`
- `curl`, `raw`

All large or sensitive sections are opt-in. Use `maxBodyChars` to cap each body; the maximum is 200,000 characters.

Example:

```json
{
  "eventId":"event-id-from-search",
  "sessionId":76,
  "include":{"requestBody":true,"responseBody":true,"errors":true},
  "maxBodyChars":30000
}
```

## `summarize_api_calls`

Supports all event filters. Group using `endpoint`, `method`, `status`, `platform`, `sourceKind`, `session`, or `host`. Results include call/error counts, average/maximum duration, and first/last timestamps.

## Interpretation

- Empty result: no matching capture in the requested filters and retained history.
- `hasResponse: false`: the event may still be pending or the capture ended without a response.
- `bodyUnavailableReason`: the capture mechanism could not read that body; do not treat it as an empty backend response.
- `nextCursor`: more matching rows exist; pass it unchanged with identical filters.
