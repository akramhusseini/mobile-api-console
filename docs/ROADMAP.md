# Roadmap and Enhancement Ideas

This file is a parking place for future improvements. It should stay practical:
ideas are grouped by area, with enough detail that a later implementation can
turn them into issues or milestones.

## Current Status

- Android capture is implemented through `adb logcat`, the default `API_CURL`
  tag, and `AndroidApiCurlParser`.
- The UI can switch between iOS, Android, Browser, and Demo views at runtime.
- SQLite persistence is active: captured sessions and events survive browser
  reloads and server restarts.
- Always-on multi-source capture is active: if iOS and Android are both
  available, both keep recording while the UI selects which platform history to
  view.
- Chromium-family browser capture (Chrome, Brave, Edge, Arc, Opera) is
  implemented as a MV3 extension that lives at the top of the repo under
  `extension/`. It POSTs to `/api/browser-event`; the server ingests
  per-event sessions keyed by `origin` + extension `profileId` + `context`
  (regular / incognito), with multiple concurrent sessions under one
  selectable Browser source.

## Capture Sources

### Android and Android Studio

- [x] Android log source backed by `adb logcat` (`AdbLogcatStream`).
- [x] Emulator + physical-device selection (multi-device dropdown).
- [x] Filter by tag (`--android-tag`, defaults to `API_CURL`).
- [x] Header dropdown switches the visible view between iOS / Android / Browser
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

### Browser (Chromium, Phase 1)

- [x] MV3 extension under `extension/`, loaded unpacked (not on the Web
  Store).
- [x] Push-driven source: background service worker is the only network
  sender; page-world patch and content script only message the SW.
- [x] Wire format `v: 1` (locked in `docs/BROWSER_SETUP.md`).
- [x] One selectable `Browser` source with multiple live sessions keyed by
  `origin` + extension `profileId` + `context` (regular / incognito).
- [x] Two-phase upsert keyed by `eventId` (request / complete / error).
- [x] Dedicated 2 MB body reader with explicit 413 response for the
  `/api/browser-event` endpoint.
- [x] OPTIONS preflight with permissive CORS headers.
- [x] Disabled-capture response: 403 with `browser_capture_disabled` error
  code so the extension can surface a hint to the user.
- [x] Browser clear marker targets only the matching (origin, profile,
  context) session; other browser sessions and other platforms are
  untouched.
- [x] Body fields carry `bodyAvailable`, `bodyTruncated`, and
  `bodyUnavailableReason` so the UI can honestly report binary,
  opaque-response, service-worker-only, and not-readable bodies.
- [x] Capture mode label: `page-script` | `web-request` | `merged`, surfaced
  in the request row and detail pane.
- [x] UI: per-session labels (origin + context), capture-mode badge, body
  truncation notice, "Body not captured (reason)" empty state.
- [x] Optional host permissions for target and request URLs are requested
  from the Options page Save click (a user gesture).
- [ ] Auto-discover API hosts from page traffic or a lightweight setup crawl,
  then show an in-app prompt to request the extra host permission from a user
  gesture instead of requiring the API URL up front.
- [ ] Firefox extension variant (close cousin of the Chromium build; deferred).
- [ ] Safari Web Extension (Xcode build, signing, distribution; deferred).
- [ ] WebSocket / EventSource / WebRTC capture (out of scope for Phase 1).
- [ ] Publishing the extension to the Chrome Web Store (Phase 1 is
  unpacked-only).

### Always-on Multi-source Capture

Implemented direction: keep every available real source recording independently,
even when the browser is closed or the UI is looking at another platform.

- [x] Keep the console repo directory-agnostic. It must not require or hardcode
  the iOS or Android app checkout path; local app paths are only development
  references.
- [x] Drive platform availability from `xcrun`, `adb`, attached devices,
  booted simulators, CLI flags, environment variables, and
  `~/.mobile-api-console.json`, not from the mobile app source directory.
- [x] Support iOS-only environments by starting iOS capture and presenting a
  single iOS-focused view/history.
- [x] Support Android-only environments by starting Android capture and
  presenting a single Android-focused view/history.
- [x] Support environments with both platforms by recording both continuously
  and letting the user choose which platform's live stream and history to view.
- [x] Refactor `SourceManager` from one `{source, parser, store}` to a
  source-keyed map, for example iOS simulator plus each Android device serial.
- [x] Start every available real source on server startup: iOS when a simulator
  is booted, Android when one or more devices are attached.
- [x] Keep one open persistent session per active source, tagged with existing
  `sourceKind` and `sourceMetadata`.
- [x] Route parser upserts, clear markers, errors, and quiet flushes to the
  correct source session instead of one global `EventStore.currentSessionId`.
- [x] Change the dropdown into a view selector so switching views does not call
  `source.stop()` on the previous platform.
- [x] Filter the session picker/history by selected platform while still
  preserving access to older sessions from all platforms.
- [x] Include source identity in SSE updates so the browser can render only the
  selected live source while still updating session counts in the background.
- [ ] Add a small enable/disable control for noisy or battery-sensitive
  background sources.
- [x] Add tests covering parallel iOS/Android routing, iOS-only adaptation,
  Android-only adaptation, view switching without data loss, and source-specific
  clear markers.
- [ ] Add tests covering multi-source shutdown flushes and legacy session
  browsing edge cases.

### Source Health

- Show whether the stream is connected, restarting, stalled, or failing.
- [x] Add server-sent event heartbeats so the browser can distinguish idle
  streams from disconnected streams. `SseHub` now sends a `: ping` comment
  every 20s and evicts clients whose sockets throw on write.
- Surface common setup problems with clearer messages:
  - no booted iOS simulator
  - `xcrun` missing
  - no Android device attached
  - `adb` missing
  - app is not emitting debug logs

## JSON and Body Viewer

- [x] Add syntax coloring for JSON response and request bodies.
- [x] Add collapsible JSON nodes for large payloads (alt-click recursively
  expands or collapses a whole subtree).
- [x] Preserve raw text for non-JSON bodies (Preview falls back to text;
  Response always shows the raw body).
- [x] Bracket-pair hover highlight on open and close.
- [ ] Add copy actions for:
  - full body (covered by the existing Copy button)
  - selected JSON node
  - JSON path
  - redacted body
- [ ] Bracket-pair extras:
  - keyboard shortcuts jump between matching brackets
  - clicking a bracket highlights the full bracketed range (vs. just the
    pair partner)
- [ ] Add large-body safeguards so rendering very large responses does not
  freeze the browser (virtualization, string truncation with "Show more").

## Storage, Retention, and Disk Space

- [x] Add an automatic retention policy, starting with logs older than 30 days.
  Time-based prune runs on start and once per day; `VACUUM` follows any prune
  that removed at least one session. Settings: `MOBILE_API_CONSOLE_RETENTION_DAYS`
  (default `30`), `MOBILE_API_CONSOLE_CLEANUP_ON_START` (default `1`).
- [x] Add a maximum database size option (warning only — no hard eviction yet).
  Setting: `MOBILE_API_CONSOLE_MAX_DB_MB` (default `512`).
- [x] Cap the in-memory live snapshot list via `MOBILE_API_CONSOLE_MAX_EVENTS`
  (default `400`).
- [x] Add tests for retention pruning and session deletion.
- [ ] Hard size-based eviction: delete oldest sessions until the DB is under
  `MAX_DB_MB`.
- [ ] Add a manual cleanup action in the UI:
  - delete sessions older than a selected age
  - delete a selected session
  - delete all failed / successful / demo sessions
- [ ] Add a disk-space monitor:
  - warn when free space is low (`MOBILE_API_CONSOLE_MIN_FREE_SPACE_MB`)
  - recommend cleanup before the machine gets critically low on space
- [ ] Safe cleanup behavior:
  - keep recent sessions by default (already enforced by `RETENTION_DAYS`)
  - require confirmation before destructive cleanup (applies to UI items above)

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
