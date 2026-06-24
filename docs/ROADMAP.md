# Roadmap and Enhancement Ideas

This file is a parking place for future improvements. It should stay practical:
ideas are grouped by area, with enough detail that a later implementation can
turn them into issues or milestones.

## Current Status

- Android capture is implemented through `adb logcat`, the default `API_CURL`
  tag, and `AndroidApiCurlParser`.
- The UI can switch between iOS, Android, and Demo at runtime.
- SQLite persistence is active: captured sessions and events survive browser
  reloads and server restarts.
- Current source switching is still an active capture switch. The selected
  source keeps recording in the background, but the previous source is stopped,
  so logs from the unselected platform are not captured until switching back.

## Capture Sources

### Android and Android Studio

- [x] Android log source backed by `adb logcat` (`AdbLogcatStream`).
- [x] Emulator + physical-device selection (multi-device dropdown).
- [x] Filter by tag (`--android-tag`, defaults to `API_CURL`).
- [x] Header dropdown switches the active capture source between iOS / Android
  / Demo at runtime.
- [x] Platform metadata recorded on each session (`ios-simulator`,
  `android-emulator`, `android-device`, with package name, log tag, and device
  serial).
- [x] Parse Android `API_CURL` summaries, multi-line cURL commands, optional
  `[BODY]` response-body lines, and continuation chunks split around Logcat's
  per-line limit.
- [ ] Parse OkHttp `HttpLoggingInterceptor` lines as a fallback for apps that
  don't ship their own `CurlLogger`.
- [ ] Capture response headers on Android. The current `API_CURL` format can
  emit an optional response body, but response headers are still not represented
  in the parser contract.
- [ ] Reuse the iOS `===== REQUEST/CURL COMMAND/RESPONSE =====` markers on
  Android too, so Android apps that prefer the iOS-style block format can use
  the existing `MobileNetworkParser` instead of `AndroidApiCurlParser`.

### Always-on Multi-source Capture

Next planned work: keep every available real source recording independently,
even when the browser is closed or the UI is looking at another platform.

- [ ] Refactor `SourceManager` from one `{source, parser, store}` to a
  source-keyed map, for example iOS simulator plus each Android device serial.
- [ ] Start every available real source on server startup: iOS when a simulator
  is booted, Android when one or more devices are attached.
- [ ] Keep one open persistent session per active source, tagged with existing
  `sourceKind` and `sourceMetadata`.
- [ ] Route parser upserts, clear markers, errors, and quiet flushes to the
  correct source session instead of one global `EventStore.currentSessionId`.
- [ ] Change the dropdown into a view selector so switching views does not call
  `source.stop()` on the previous platform.
- [ ] Include source identity in SSE updates so the browser can render only the
  selected live source while still updating session counts in the background.
- [ ] Add a small enable/disable control for noisy or battery-sensitive
  background sources.
- [ ] Add tests covering parallel iOS/Android routing, source switching without
  data loss, source-specific clear markers, shutdown flushes, and legacy session
  browsing.

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
