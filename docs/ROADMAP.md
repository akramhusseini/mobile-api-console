# Roadmap and Enhancement Ideas

This file is a parking place for future improvements. It should stay practical:
ideas are grouped by area, with enough detail that a later implementation can
turn them into issues or milestones.

## Capture Sources

### Android and Android Studio

- Add an Android log source backed by `adb logcat`.
- Support emulator and physical-device selection.
- Filter by package name, tag, or structured marker.
- Define an Android logging helper that emits the same block markers already
  used by the iOS parser:
  - `===== REQUEST =====`
  - `===== MULTIPART REQUEST =====`
  - `===== CURL COMMAND =====`
  - `===== RESPONSE =====`
- Keep parsed events platform-neutral so iOS and Android requests appear in the
  same UI model.
- Store platform metadata on each session, such as `ios-simulator`,
  `android-emulator`, device id, package name, and log predicate.

### Source Health

- Show whether the stream is connected, restarting, stalled, or failing.
- Add server-sent event heartbeats so the browser can distinguish idle streams
  from disconnected streams.
- Surface common setup problems with clearer messages:
  - no booted iOS simulator
  - `xcrun` missing
  - no Android device attached
  - `adb` missing
  - app is not emitting debug logs

## JSON and Body Viewer

- Add syntax coloring for JSON response and request bodies.
- Add collapsible JSON nodes for large payloads.
- Preserve raw text for non-JSON bodies.
- Add copy actions for:
  - full body
  - selected JSON node
  - JSON path
  - redacted body
- Add bracket-pair interaction:
  - clicking `{`, `[`, or `(` highlights the matching closing bracket
  - clicking a bracket highlights the full bracketed range
  - hovering a bracket previews the pair
  - keyboard shortcuts jump between matching brackets
- Add large-body safeguards so rendering very large responses does not freeze
  the browser.

## Storage, Retention, and Disk Space

- Add an automatic retention policy, starting with logs older than 30 days.
- Add a maximum database size option.
- Add a maximum events-per-session option.
- Add a manual cleanup action in the UI:
  - delete sessions older than a selected age
  - delete a selected session
  - delete all failed / successful / demo sessions
- Add a disk-space monitor:
  - warn when free space is low
  - warn when the database grows beyond a configured threshold
  - recommend cleanup before the machine gets critically low on space
- Add safe cleanup behavior:
  - vacuum the SQLite database after large deletions
  - keep recent sessions by default
  - require confirmation before destructive cleanup
- Add tests for retention pruning and session deletion.

## Search, Filtering, and Navigation

- Add saved filters for common workflows.
- Add filters by host, endpoint path, status code range, and request body text.
- Add timeline grouping by session, host, or request burst.
- Add quick navigation between errors.
- Add side-by-side comparison between two requests.
- Add a "follow latest unless I manually select an older request" mode.

## Export and Sharing

- Export selected requests as cURL commands.
- Export a session as HAR.
- Export a session as JSON.
- Export selected requests as a Postman collection.
- Copy a compact bug-report summary with URL, method, status, headers, and body.

## Privacy and Redaction

- Redact sensitive headers by default, such as `Authorization`, `Cookie`, and
  API keys.
- Add configurable body-field redaction for tokens, passwords, and personally
  identifiable values.
- Make redaction apply to UI display, copy actions, and exports.
- Add a visible indicator when a value has been redacted.

## UI Polish

- Improve method and status coloring while keeping the interface readable in a
  dark environment.
- Add a response/body split view for easier comparison.
- Keep tabs and selected filters stable across reloads.
- Add keyboard shortcuts for search, copy, next error, and tab switching.
- Make long URLs easier to scan with host, path, and query separated visually.

## Reliability and Performance

- Add pagination or virtual scrolling for very large sessions.
- Keep server memory bounded when sessions have many events.
- Add backpressure or batching for bursty log streams.
- Add parser fixtures from real iOS and future Android logs.
- Add browser-level smoke tests for the main UI flows.

