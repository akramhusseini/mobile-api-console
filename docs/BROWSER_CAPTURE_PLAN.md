# Plan: Browser front-end capture (Phase 1 — Chromium)

> **Status:** awaiting review. Nothing has been implemented yet. This document
> is the consolidated plan for the `feat/browser-frontend-capture` branch.
> Delete or fold into [ROADMAP.md](ROADMAP.md) before the branch merges.

## Motivation

Backend developers asked whether the console could mirror its mobile-app
capture for the web front-end. The current console is mobile-only: it tails
OS log streams (`xcrun`, `adb`) that the mobile apps emit into via a small
debug-only logger. We want a parallel "browser source" that captures `fetch`
and `XMLHttpRequest` traffic from chosen tabs and surfaces it in the same UI,
session list, and SQLite history.

## Decisions already locked in

These were confirmed via questions earlier in the branch and drive the rest
of the plan:

1. **Engine scope, Phase 1:** Chromium-family only — Chrome, Brave, Edge,
   Arc, Opera. Firefox and Safari are deferred. (Safari is WebKit, not
   Chromium, and requires an Xcode-built Safari Web Extension; treat it as a
   separate effort.)
2. **Capture mechanism:** a Chromium MV3 extension patches `fetch` and
   `XMLHttpRequest` in the page world for bodies. The background service
   worker owns correlation, merges any `webRequest` metadata it can observe,
   and is the only component that POSTs to the console.
3. **Session model:** one selectable Browser source, with multiple concurrent
   browser sessions underneath it. Session key is `origin` + extension
   `profileId` + browsing `context` (`regular` / `incognito`). All tabs of the
   same origin in the same browser profile/context feed one session. Tab close
   does not end the session. Different browser profiles or incognito contexts
   produce different sessions.
4. **Default config in the public repo:** placeholder example only
   (`https://app.example.com/*`), with `enabled: false`. Same hygiene as the
   existing iOS subsystem / Android applicationId placeholders.

## Architectural shift to note

Mobile sources are *passive readers* of OS-emitted logs. The browser source is
**push-driven**: the extension is the only thing in the loop that emits events,
and its background service worker POSTs them to a new `/api/browser-event`
endpoint on the console.

The downstream event shape, SQLite event upsert path, SSE broadcasts, and
existing detail panes should be reused, but the current source/session model
cannot be reused unchanged. `EventStore` has one current session per
`sourceKey`; Browser needs one selected source (`browser`) with many live
browser sessions under it. Budget explicit `EventStore`, server, and UI work
for that multi-session source behavior.

## Out of scope for this branch

- Firefox extension variant (close cousin of the Chromium build — small
  delta, tracked separately).
- Safari Web Extension (Xcode build, signing, distribution all different).
- WebSocket / EventSource / WebRTC capture.
- Privacy redaction for browser cookies — covered by the general
  redaction work already in the roadmap.
- Publishing the extension to the Chrome Web Store. Phase 1 ships it as
  "load unpacked from the repo."

## Wire format

Already drafted in [`docs/BROWSER_SETUP.md`](BROWSER_SETUP.md) under "The
wire format." Summary of fields that ended up there:

- `v: 1` schema version, enforced by the ingest endpoint.
- `sourceKind: "browser-chromium"` with `browser-gecko` / `browser-webkit`
  reserved.
- `browserSession: { origin, profileId, context }` — the session key.
- `tabId` — metadata only, not part of the key.
- `captureMode: "page-script" | "web-request" | "merged"` — surfaces in the UI
  so you can see why a body is missing.
- `eventId` — UUID for one logical browser call. The extension background
  service worker owns correlation; the server only uses `eventId` to upsert
  request/complete phases for that logical call.
- Two-phase upsert: `request`-only when the call starts, then a `response`
  or `error` update on completion.
- Body fields carry availability/truncation metadata. The extension truncates
  body strings to 1 MB; the server validates the cap. Total POST capped at
  2 MB with an explicit `413`.
- Clear marker: `{ clear: true, browserSession: {...} }`.

The wire format is the part most worth scrutinising — once code is written
against it, schema changes mean bumping `v` to `2`.

## Implementation tasks

Numbered to match `TaskList`. Each row lists files most likely to be
touched. Estimates are rough; revise if needed.

| # | Task | Files | Notes |
|---|---|---|---|
| 1 | Wire format + ingest contract spec | `docs/BROWSER_SETUP.md` (drafted) | In progress. Awaiting your sign-off on the format before #2 starts. |
| 2 | `/api/browser-event` ingest endpoint | `server.js`, `src/eventStore.js` | POST handler, defensive extension CORS/OPTIONS handling, payload validation, dedicated 2 MB reader with `413`, version check, disabled-browser rejection, targeted browser-session clear. No auth (localhost-only, same trust model as existing UI). |
| 3 | Browser source/session plumbing + parser | `src/logSource/browserPushSource.js` (new), `src/parsers/browserEventParser.js` (new), `src/sourceManager.js`, `src/eventStore.js`, `src/storage/sqliteStorage.js` | Push-driven source (no child process). Parser normalises wire-format events into the existing event shape. Add a single selectable `browser` source with `ensureSourceSession` / `upsertForSourceSession` / `clearSourceSession`-style store methods for concurrent browser sessions keyed by `browserSession`. |
| 4 | Config | `src/config.js`, `src/sourceManager.js`, `server.js` | New `browser` block in `~/.mobile-api-console.json`. When `enabled: true`, the Browser source appears in `/api/sources` and the UI dropdown. No `platform.js` probe; browser availability is config-driven. Update all hardcoded source-kind allowlists (`ios` / `android` / `demo`) to include `browser`. |
| 5 | Chromium MV3 extension | `extension/manifest.json`, `extension/background.js`, `extension/content.js`, `extension/page-inject.js`, `extension/options.{html,js}`, `extension/icons/` | New top-level directory. Background service worker sends all POSTs. Options page stores target page URL patterns and optional request URL patterns, requests matching optional host permissions, and generates a stable per-profile `profileId`. Not bundled into `npm install`. |
| 6 | UI wiring | `public/app.js`, `public/index.html`, `public/styles.css` | One Browser dropdown entry. Session picker/history can show multiple live browser sessions with origin/profile labels. Synthetic cURL renderer (browser events don't carry a real cURL string). Capture-mode label and "Body not captured (reason)" / truncation indicators. |
| 7 | Tests | `test/browserIngest.test.js` (new), `test/browserSessionKeying.test.js` (new), `test/sourceManagerBrowser.test.js` (new), `test/eventStoreBrowser.test.js` (new) | Ingest validation; 2 MB/413 behavior; disabled-browser rejection; multi-tab same-origin collapses; different profile/context produces distinct session; clear targets only one browser session; page-script/webRequest metadata merges before POST; coexistence with iOS + Android in the same `SourceManager`. |
| 8 | README + ROADMAP updates | `README.md`, `docs/ROADMAP.md`, this file | Add "Browser (Chromium)" to Features and setup docs. Mark Phase 1 done in ROADMAP; list Firefox / Safari / WebSocket-style capture as follow-ups. |

## Sequencing

```
#1 (spec)  →  #2 (ingest)  →  #3 (source)  →  #4 (config)  ┐
                                                            ├─→  #7 (tests)
              #5 (extension) ──────────────────┐            │
                                               ├─→  #6 (UI) ┘
                                                            └─→  #8 (docs)
```

- #1 must land first; it's the contract.
- #2, #3, #4 are server-side and can be one PR or split. They are tested in
  isolation with the curl ingest snippet from `BROWSER_SETUP.md`.
- #5 (extension) can be developed in parallel with #2–#4 as long as the wire
  format is frozen.
- #6 (UI) needs #3 done so SSE events flow.
- #7 (tests) can grow alongside #2–#3 rather than waiting until the end.
- #8 (docs) lands last so the README only ships once the feature works.

Suggested PR shape: one PR per row 2–7, plus a final docs PR. Or one
mega-PR if you'd rather review it all at once — your call.

## Resolved review decisions

These decisions consolidate the review feedback and should not be reopened
during implementation unless the wire format is intentionally bumped.

1. **Transport: HTTP POST vs. native messaging.** Plan currently uses HTTP
   POST to `http://localhost:3957/api/browser-event` from the extension
   background service worker. Simpler, parallels the existing HTTP / SSE
   surface, and only needs `host_permissions:
   ["http://localhost/*"]` for the console transport. Native messaging avoids
   the HTTP surface but requires installing a per-OS native-messaging
   manifest. **Decision: HTTP POST.**
2. **`eventId` de-duplication.** Keep `eventId`, but define it as the
   extension-owned logical call id. The server does not perform heuristic
   dedupe between page-script and `webRequest`; the background service worker
   merges metadata before POST.
3. **Should target URLs be re-filtered server-side?** The extension enforces
   page/request URL permissions. The server validates event shape, schema
   version, and that the reported page origin matches `browserSession.origin`
   when page metadata is present. It does not maintain an allowlist copy for
   request URL filtering, because cross-origin API hosts are valid.
4. **Where does the extension live in the repo?** Plan puts it at top-level
   `extension/`. Alternative: `clients/chromium-extension/` if you anticipate
   Firefox/Safari siblings later. **Decision: `extension/` now, rename when
   the second engine lands.**

## Acceptance criteria

- `npm test` passes including new tests for #7.
- Running `curl http://localhost:3957/api/sources` with `browser.enabled:
  true` in config lists one Browser source.
- The curl ingest snippet in `BROWSER_SETUP.md` lands a synthetic event in
  the UI.
- Installing the extension, capturing a target page, and triggering a real
  `fetch` produces an event with status, headers, request body, and response
  body. The page patch runs as a MAIN-world content script so normal site CSP
  does not block body capture.
- Opening the same allowed origin in two tabs writes to the same browser
  session; opening it from a different browser profile or incognito context
  writes to a different browser session.
- A clear marker for one browser session does not clear other browser
  sessions or mobile sources.
- iOS and Android capture still work unchanged. (Existing tests cover this;
  CI is the gate.)
- Public repo defaults capture nothing without user action (`enabled:
  false`, placeholder `targetUrls`, empty or placeholder `requestUrls`).

---

## Current status / handoff (2026-06-30)

Phase 1 capture works end-to-end on a real app (JoAcademy LMS: frontend
`nexa-lms-frontend-dev.joacademy.com`, cross-origin API
`nexa-lms-api-dev.joacademy.co`) — verified live: a real cross-origin API
call landed with full request/response bodies, `captureMode: merged`.

### Shipped since the core capture work
- **One-click "Capture this site" popup** (`extension/popup.html` + `popup.js`,
  manifest `action` + `activeTab`). Reads the active tab, derives the capture
  pattern from its real URL (kills the `.co`/`.com` mistype class), requests
  permission, writes config, reloads the tab. No URL typing.
- **Simplified console modal** (`public/index.html`, `app.js`, `styles.css`):
  leads with the setup flow (enable Browser source → load extension → click
  Capture this site) + copyable `extension/` path; the old URL-form +
  clean-browser launch is now collapsed under "Advanced".
- **Noise filter** (`extension/capture-helper.js`): webRequest never records
  the console's own origin (`localhost:3957` self-capture) or non-API resource
  types (script/style/image/font/navigation). Real `fetch`/XHR untouched.
- **Auto-suggested API hosts** (`background.js` records observed cross-origin
  origins; popup offers one-click "Add headers"; pure helpers in
  `options-helper.js`).

### Tests
`npm test` → **200 pass / 0 fail.** New coverage:
`test/extensionPopup.test.js` (pattern derivation, config merge, cross-origin
host detection, suggestions) and `test/extensionCapture.test.js` (noise
filter: console-origin dropped, resource types dropped, xhr kept, untyped
backward-compatible), plus `test/browserIngest.test.js` coverage that the
simple setup flow enables Browser source before extension traffic arrives.

### Pending (needs a human at a real browser — cannot be automated)
1. **Fresh-install GUI smoke test:** the extension was removed to test setup
   simplicity. Open **Set up Browser** first so the console enables Browser
   source, re-load unpacked, click **Capture this site** on the LMS, and
   confirm (a) a NEW browser session id appears, (b) the view is clean (no
   `localhost` / `/assets/*.js` rows), (c) the popup lists `nexa-lms-api-dev…`
   under "API hosts seen" with a working **Add headers** button. The native
   permission **Allow** click is an OS prompt nothing in CDP can drive.
2. Nothing else outstanding. README now points at the one-click flow first;
   `browser:dev` remains documented as the clean-profile alternative.

### Next session, start here
Run the GUI smoke test in step 1 above; if anything's off, the console-side
data (`/api/events?sourceKey=browser`) shows the exact failure. The whole
pipeline (server, parser, store, extension helpers) is unit-covered; only the
live `chrome.*` glue + Allow click remain unverified by tests.
