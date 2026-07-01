# Browser Setup

> **Status:** Phase 1 (Chromium-family) draft. This file is the contract
> between the browser extension and the console server, and the user-facing
> setup guide. Firefox and Safari are out of scope for this branch — see the
> [Roadmap](ROADMAP.md) for follow-ups.

Unlike iOS / Android, the console cannot tail a system log stream for browsers.
There is no `xcrun` or `adb` equivalent. Instead, a small browser **extension**
captures `fetch` and `XMLHttpRequest` traffic from tabs whose URL matches your
configured allowlist. Its background service worker merges any available
`webRequest` metadata and POSTs each logical call to the console at
`http://localhost:3957/api/browser-event`. The console treats those POSTs as
events under one Browser source, with separate live sessions per page origin
and browser profile/context.

- [Overview](#overview)
- [Quick start — one click in your own browser (recommended)](#quick-start--one-click-in-your-own-browser-recommended)
- [Alternative — `npm run browser:dev` (throwaway clean profile)](#alternative--npm-run-browserdev-throwaway-clean-profile)
- [Install the extension (manual fallback)](#manual-install-load-unpacked-fallback)
- [Configure the console (manual fallback)](#configure-the-console-manual-fallback)
- [The wire format](#the-wire-format)
- [Session model](#session-model)
- [Verifying end-to-end](#verifying-end-to-end)
- [Limitations](#limitations)
- [Troubleshooting](#troubleshooting)
- [Agent-neutral setup prompt](#agent-neutral-setup-prompt)

---

## Overview

| | Browser (Chromium) |
|---|---|
| Supported browsers | Chrome, Brave, Edge, Arc, Opera (anything that loads Chrome MV3 extensions) |
| Capture mechanism | Extension page-world patch captures `fetch` + `XMLHttpRequest`; background `webRequest` listener merges headers/metadata when host permissions allow |
| Transport to console | Background service worker HTTP `POST http://localhost:3957/api/browser-event` |
| Selector | Page URL allowlist configured in the extension options page; optional request URL patterns grant richer `webRequest` metadata |
| Session key | `origin` + extension `profileId` + context (`regular` / `incognito`) |
| Request body | from the patched `fetch` / `XHR` call site |
| Response body | from the patched `fetch` / `XHR` call site — **may be unavailable on sites with a strict `Content-Security-Policy`** (see [Limitations](#limitations)) |
| Response headers | from the `webRequest` listener |
| cURL command | **synthesized** by the console parser from the captured request (method + URL + headers + body); browser-noise headers dropped, auth kept, shell-safe |
| Build gate | extension is debug-tooling by definition; not loaded into release builds of anything |
| Clear marker | `POST /api/browser-event` with `{ "clear": true, "browserSession": {...} }` |

The contract is intentionally narrow: one JSON shape in, parsed events out. The
extension is the only thing that has to speak this format; the page being
monitored does not.

### Non-negotiable contract

- **Localhost only.** The console ingest endpoint binds to `127.0.0.1`. The
  extension never sends to a remote host.
- **URL allowlist required.** With an empty allowlist, the extension captures
  nothing. There is no "capture everything" mode by design — that would record
  unrelated browsing.
- **No HTTPS interception.** The extension does not install a CA or proxy
  traffic. It only sees calls the page itself made.
- **Push, not pull.** The extension background service worker is the only
  network sender. Content scripts and injected page scripts never POST directly
  to the console.
- **Schema versioned.** Every event carries `"v": 1`. Schema changes bump `v`
  and the ingest endpoint refuses unknown versions with 400.

### Synthesized cURL

Browser events carry no native cURL string — the page makes the call, not the
console. The browser event parser (`src/parsers/browserEventParser.js`,
`buildCurl`) synthesizes a runnable command from the normalized request:

- `-X <METHOD>` (omitted for `GET`), the full request URL (including query),
  and `--data-raw` for the request body when present.
- Request headers minus browser-managed / noisy ones curl would set itself or
  that don't replay (`Host`, `Content-Length`, `Accept-Encoding`,
  `Connection`, `sec-ch-*`, `sec-fetch-*`, `proxy-*`, …). `Authorization` and
  `Cookie` are **kept** so the command reproduces the authenticated call.
- Every value is single-quoted with `'\''` escaping, so nothing in a header or
  body can break the quoting or inject shell syntax.

Computed server-side at ingest and stored on the event, so the cURL tab and
Copy button work exactly as they do for iOS / Android.

---

## Quick start — one click in your own browser (recommended)

The simplest path. No URLs to type, no separate browser, and it runs in the
browser where you are already signed in:

1. **Open the console setup.** In Mobile API Console, click **Set up
   Browser**. The dialog enables the Browser source in the console and shows
   the exact `extension/` folder path to load.
2. **Load the extension once.** Open `brave://extensions` (or
   `chrome://extensions`) → enable **Developer mode** → **Load unpacked** →
   select the `extension/` folder in this repo. Pin it to the toolbar
   (🧩 menu → pin) so the icon is always visible.
3. **Open the app you want to inspect** and click the **Mobile API Console**
   toolbar icon → **Capture this site**. Approve the one permission prompt;
   the tab reloads and capture begins. The pattern is derived from the tab's
   own URL, so there is nothing to mistype.
4. **Watch it** in the console: pick **Browser** in the Source dropdown. Your
   app's `fetch` / `XHR` calls stream in with request and response bodies —
   including cross-origin API calls. You do **not** need to configure the API
   host; the page-world patch captures those bodies automatically.

The console's **Set up Browser** dialog performs the server-side enable step
and keeps the copyable path to the `extension/` folder handy.

### Capturing API response headers (optional)

Bodies are captured without any API-host config. If you also want
cross-origin API **response headers**, open the popup again after browsing:
it lists every API origin it has observed under *"API hosts seen — also
capture their response headers"*, each with a one-click **Add headers**
button. It requests that origin's permission and adds it to `requestUrls` —
you never type the host.

### What is not captured

To keep the view focused on API traffic, the extension never records:

- **the console's own origin** (`localhost:3957`) — no self-capture noise;
- **static page resources** (scripts, stylesheets, images, fonts, and the
  page navigation itself) — only `fetch` / `XHR` calls become rows.

---

## Alternative — `npm run browser:dev` (throwaway clean profile)

> Use this only when you want an **isolated** browser profile (e.g. to avoid
> mixing with your normal browsing). That profile has no login session, so
> apps that require sign-in render a blank page — prefer the one-click flow
> above for anything you log into.

From the repo root, one command writes your `~/.mobile-api-console.json`,
starts the console with `Browser` selected, and launches a Chromium-family
browser with the unpacked extension from `./extension` already loaded into
a throwaway profile. Quote the URL pattern so your shell does not try to
glob the `*`:

```sh
npm run browser:dev -- --target 'http://localhost:3000/*'
```

The helper prints a plan summarizing what it did and the four steps that
still need a human:

```text
Mobile API Console — browser-capture dev helper

  config:        /Users/you/.mobile-api-console.json
  extension:     /Users/you/mobile-api-console/extension
  console port:  3957
  browser:       brave (/Applications/Brave Browser.app/Contents/MacOS/Brave Browser)
  profile dir:   /tmp/mobile-api-console-browser-profile
  target URLs:   http://localhost:3000/*
  request URLs:  <none>
  start console: yes

Next steps for you:
  1. Open the extension's Options page (right-click the icon → Options).
  2. Paste the same target / request URL patterns and click Save.
  3. Click Allow on the native host-permission prompt.
  4. Load the target page; events should land in the Browser source.
```

Steps 2 and 3 are the bits nothing inside the browser can automate:
opening the Options page and clicking **Allow** on the OS-level host
permission prompt.

### Flags

| Flag | Description |
|---|---|
| `--target <pattern>` | Page URL pattern to capture. Repeatable. **Required** unless `browser.targetUrls` is already set in `~/.mobile-api-console.json`. |
| `--request <pattern>` | API-host URL pattern for response-header / `webRequest` metadata. Repeatable. |
| `--port <port>` | Console port. Default `3957`. |
| `--browser brave\|chrome\|edge` | Force a specific browser. Default: auto-detect Brave → Chrome → Edge. |
| `--profile <dir>` | Temp browser profile directory. Default `/tmp/mobile-api-console-browser-profile`. |
| `--no-start` | Skip spawning the console (use when it's already running, e.g. via the LaunchAgent). |
| `--dry-run` | Print the plan and exit without writing or spawning anything. Useful for sanity-checking flags. |
| `--config <path>` | Override the config file path. Default `~/.mobile-api-console.json`. |
| `--repo <path>` | Override the repo root (where `./extension` lives). Default: the current working directory. |
| `-h`, `--help` | Show usage. |

### What it touches

The helper merges into your existing `~/.mobile-api-console.json` and
**only** writes the keys it owns:

- `browser.enabled` → `true`
- `browser.targetUrls` → from `--target` (or the existing list if you
  didn't pass any)
- `browser.requestUrls` → from `--request` (or the existing list)
- `defaultSource` → `"browser"` only if it was unset

Unrelated keys (`processName`, `android`, `ios`, `retentionDays`,
`maxDbMb`, etc.) are preserved verbatim.

The browser is launched in its own throwaway profile at
`/tmp/mobile-api-console-browser-profile` (or `--profile`) with
`--user-data-dir`, `--load-extension`, and `--disable-extensions-except`
so other Chrome extensions stay out of the way.

### Examples

```sh
# With a cross-origin API host for richer response metadata:
npm run browser:dev -- --target 'http://localhost:3000/*' \
                      --request 'http://localhost:3000/api/*'

# On a non-default port:
npm run browser:dev -- --target 'http://localhost:3000/*' --port 4000

# Force Chrome when Brave isn't installed:
npm run browser:dev -- --target 'http://localhost:3000/*' --browser chrome

# Console already running via the LaunchAgent — skip the spawn:
npm run browser:dev -- --target 'http://localhost:3000/*' --no-start

# Print the plan without writing or spawning:
npm run browser:dev -- --target 'http://localhost:3000/*' --dry-run
```

### Known limitations

- **The host-permission Allow click is not automatable.** Chrome shows a
  native dialog after the extension's `chrome.permissions.request` call.
  No CDP / `Browser.setPermission` / profile-prefs workaround survives a
  fresh launch — the user has to click Allow.
- **macOS is the primary target.** Linux/Windows paths are wired but
  the helper is best-effort there until someone validates them
  end-to-end.
- **Auto-detect looks in standard install locations.** If your browser
  lives somewhere custom, pass `--browser brave|chrome|edge` and the
  helper will at least tell you which path it expected and didn't find.

---

## Manual install (load-unpacked fallback)

> If you used [`npm run browser:dev`](#alternative--npm-run-browserdev-throwaway-clean-profile) above
> you can skip this section — the helper already loaded the unpacked
> extension into the throwaway profile it launched. The instructions below
> apply when you want to load the extension into your normal browser
> profile, when you're packaging it for a non-mac box, or when the
> helper's auto-detect missed your install location.

The extension lives in this repository under `extension/` and is loaded
unpacked. It is not shipped through the Chrome Web Store at this stage.

1. In your browser, open the extensions page:
   - Chrome / Brave / Edge / Opera: `chrome://extensions`
   - Arc: `arc://extensions`
2. Enable **Developer mode** (top-right toggle).
3. Click **Load unpacked** and select the `extension/` directory inside your
   clone of `mobile-api-console`.
4. Pin the extension to the toolbar (puzzle icon → pin) so you can see its
   status badge.
5. Open the extension's **Options** page (right-click the icon → Options) and
   configure:
   - **Console host** — defaults to `http://localhost:3957`. Only change this
     if you ran the console on a non-default port.
   - **Target page URLs** — one URL pattern per line, e.g.
     `https://app.example.com/*`. These are the pages the extension may inject
     into. Empty list = capture nothing.
   - **Request URL permissions** — optional URL patterns for API hosts, e.g.
     `https://api.example.com/*`. Grant these when the app calls cross-origin
     APIs and you want response headers / `webRequest` fallback metadata.
6. Click **Save**.

Saving target page or request URL patterns asks Chrome for the matching
optional host permissions. If Chrome denies a permission, capture for that
pattern stays inactive until you grant it. Chrome grants host permissions at
the scheme/host level; the extension still applies the full path pattern at
runtime before it captures anything.

The extension icon shows a small badge when capture is active for the current
tab.

---

## Configure the console (manual fallback)

> Skipped automatically if you used
> [`npm run browser:dev`](#alternative--npm-run-browserdev-throwaway-clean-profile). Only follow
> this section if you're editing the config file by hand.

Add a `browser` block to `~/.mobile-api-console.json`:

```json
{
  "browser": {
    "enabled": true,
    "targetUrls": ["https://app.example.com/*"],
    "requestUrls": ["https://api.example.com/*"]
  }
}
```

- `enabled` — set to `false` (or omit the block) to hide the browser source
  from the console's `/api/sources` response and the UI dropdown. The ingest
  endpoint rejects browser POSTs with a clear disabled response so the
  extension can show that the console is not accepting browser capture.
- `targetUrls` — **informational only on the console side.** The extension
  enforces the page allowlist; the console does not re-filter. This field
  exists so the console can show a friendly summary in the source picker and so
  the documentation lives in one place.
- `requestUrls` — optional API URL patterns for `webRequest` metadata. When
  omitted, the extension tries only the `targetUrls` patterns. Add cross-origin
  API hosts here if the app page and API origin differ.

The public repo defaults to `enabled: false` and a placeholder
`https://app.example.com/*` entry. Replace with your own URL(s).

---

## The wire format

All events POST to `http://localhost:3957/api/browser-event` with
`Content-Type: application/json`. The background service worker sends every
POST; content scripts and injected page scripts only message the service
worker. The extension manifest grants `http://localhost/*` as a host permission
for this transport. The server may answer extension `OPTIONS` preflights
defensively, but the contract does not rely on page-origin CORS.

### Event payload (`v: 1`)

```json
{
  "v": 1,
  "sourceKind": "browser-chromium",
  "browserSession": {
    "origin": "https://app.example.com",
    "profileId": "bprof_8f3d1b6c9a2e4f10",
    "context": "regular"
  },
  "tabId": 17,
  "captureMode": "merged",
  "eventId": "f1c3a2b8-9f0d-4f5b-9c7e-8a2e1d3b4c5d",
  "phase": "complete",
  "request": {
    "startedAt": 1751280000000,
    "method": "GET",
    "url": "https://app.example.com/v1/users",
    "headers": { "Accept": "application/json" },
    "body": null,
    "bodyAvailable": true,
    "bodyTruncated": false,
    "bodyUnavailableReason": null
  },
  "response": {
    "completedAt": 1751280000042,
    "durationMs": 42,
    "status": 200,
    "headers": { "Content-Type": "application/json" },
    "body": "{\"data\":[…]}",
    "bodyAvailable": true,
    "bodyTruncated": false,
    "bodyUnavailableReason": null
  },
  "metadata": {
    "pageUrl": "https://app.example.com/dashboard",
    "initiator": "https://app.example.com",
    "webRequestId": "12345"
  },
  "error": null
}
```

Field rules:

- `v` — schema version. Currently `1`. Unknown versions are rejected with `400`.
- `sourceKind` — currently always `"browser-chromium"`. Reserved future values:
  `"browser-gecko"`, `"browser-webkit"`.
- `browserSession.origin` — origin of the monitored page/tab: scheme + host +
  port, no path / query / fragment. This is not necessarily the same as the API
  request URL origin; cross-origin APIs are valid.
- `browserSession.profileId` — stable random id generated once by the extension
  and persisted in that Chrome profile's extension storage. This distinguishes
  named browser profiles, where Chromium does not expose a reliable profile id
  to extensions.
- `browserSession.context` — `"regular"` or `"incognito"`. This distinguishes
  regular and incognito capture even when they share the same extension install.
- `tabId` — informational; useful for grouping events from the same tab in the
  detail pane but **not** part of the session key.
- `captureMode` — `"page-script"` when page-world capture supplied the body,
  `"web-request"` when only background metadata was available, or `"merged"`
  when the extension merged both views before POST. The UI surfaces this as a
  label on the event.
- `eventId` — UUID generated by the extension background service worker for one
  logical browser call. The server uses this only to upsert the request and
  completion phases for that call; it does not attempt heuristic dedupe between
  independent observers.
- `phase` — `"request"` for the request-start upsert, `"complete"` for the
  response/error upsert.
- `request.body`, `response.body` — UTF-8 strings or `null`. Binary bodies are
  not represented.
- `request.bodyAvailable`, `response.bodyAvailable` — `false` when a body
  existed but could not be represented. If there was no body, `body` is `null`,
  `bodyAvailable` is `true`, and `bodyUnavailableReason` is `null`.
- `bodyUnavailableReason` — `null` when the body is available or absent. Known
  values are `"binary"`, `"opaque-response"`, `"service-worker-only"`,
  `"too-large"`, and `"not-readable"`.
- `bodyTruncated` — `true` when the extension truncated the body string to the
  1 MB field cap.
- `metadata.pageUrl` — full page URL that produced the event. The server may
  validate that its origin matches `browserSession.origin`.
- `error` — populated when the call threw (e.g. network error,
  `Failed to fetch`). When `error` is set, `response` may be `null`.

### Two-phase events

A single call is reported in two phases:

1. **`request`-only** when the call starts. Lets the console show the row
   immediately with status `pending`.
2. **`response`** (or `error`) update when the call completes. Matched to the
   original by `eventId`.

This matches how iOS / Android already upsert events as they progress. The
extension background service worker must merge page-script and `webRequest`
observations before POSTing; the server does not correlate independent
observer events after the fact.

### Clear marker

```json
{
  "v": 1,
  "clear": true,
  "browserSession": {
    "origin": "https://app.example.com",
    "profileId": "bprof_8f3d1b6c9a2e4f10",
    "context": "regular"
  }
}
```

Wipes the session for the given origin + profile/context only. Other browser
sessions and other platforms are unaffected. This uses the browser ingest code
path, not `POST /api/clear`, because `/api/clear` targets the currently
selected source.

### Payload limits

- Total request body to `/api/browser-event`: 2 MB. Larger payloads are
  rejected with `413`.
- The extension truncates each request/response body string to 1 MB before
  POSTing and sets `bodyTruncated: true`. The server validates this field cap
  as a backstop.

---

## Session model

- **Key:** `origin` + `profileId` + `context`. Same origin in the same browser
  profile/context → one session.
- **Survives tab close.** Closing one tab does not end the session. New tabs
  on the same origin in the same profile continue feeding the same session.
- **Splits by profile/context.** Two named browser profiles, or regular +
  incognito, viewing the same origin produce parallel sessions.
- **Single Browser source.** The source dropdown shows one Browser entry when
  `browser.enabled` is true. The session picker/history shows each active
  browser session separately, labelled by origin and context.
- **Splits across server restarts.** The console assigns a new session id on
  restart, same as iOS / Android. Older sessions remain browsable from the
  history picker.
- **`tabId` is only metadata.** It appears in the per-event detail pane but
  does not affect grouping. This is intentional — the most common case is
  refreshing a SPA in a single tab, which would otherwise fragment the log.

---

## Verifying end-to-end

1. Confirm the console is running:

    ```sh
    curl http://localhost:3957/api/sources
    ```

    Browser source appears in the response once `browser.enabled` is `true`
    in `~/.mobile-api-console.json`.

2. Manually POST a synthetic event (sanity-checks the ingest endpoint
   without the extension):

    ```sh
    curl -X POST http://localhost:3957/api/browser-event \
      -H 'Content-Type: application/json' \
      -d '{
        "v": 1,
        "sourceKind": "browser-chromium",
        "browserSession": { "origin": "https://app.example.com", "profileId": "manual-profile", "context": "regular" },
        "tabId": 1,
        "captureMode": "merged",
        "eventId": "11111111-1111-1111-1111-111111111111",
        "phase": "complete",
        "request":  { "startedAt": 0, "method": "GET", "url": "https://app.example.com/ping", "headers": {}, "body": null, "bodyAvailable": true, "bodyTruncated": false, "bodyUnavailableReason": null },
        "response": { "completedAt": 5, "durationMs": 5, "status": 200, "headers": {}, "body": "pong", "bodyAvailable": true, "bodyTruncated": false, "bodyUnavailableReason": null },
        "metadata": { "pageUrl": "https://app.example.com/", "initiator": "https://app.example.com" },
        "error": null
      }'
    ```

    Open the console, select **Browser** in the dropdown, and the event
    should appear under `app.example.com`.

3. Install the extension, configure your target page URL, reload the page, and
   trigger a real request. The event should appear in the same session.

---

## Limitations

- **Reload after extension updates.** Body capture depends on the
  `page-inject.js` MAIN-world content script. After changing the unpacked
  extension files, reload the extension from `brave://extensions` or
  `chrome://extensions`, then hard-refresh the target page. Otherwise old
  tabs may keep using the previous content-script version and fall back to
  `webRequest` metadata only.
- **Service-worker traffic.** Fetches from a page's service worker are
  visible to `webRequest` but the patched `fetch` / `XHR` in the page world
  does not see them. They're captured with `captureMode: "web-request"`
  (metadata only) when request URL permissions allow it.
- **Cross-origin API metadata.** Page-script capture can see calls made by the
  page, but `webRequest` response headers/fallback metadata require host
  permission for the request URL. Add API hosts to `requestUrls` when the app
  page and API origin differ.
- **Opaque cross-origin responses.** `mode: "no-cors"` responses have no
  status or body visible to the page; the console records the request side
  and any `webRequest` metadata that host permissions allow.
- **Binary bodies.** `Blob` / `ArrayBuffer` request bodies and binary
  response bodies are recorded as `null` with `bodyAvailable: false` and
  `bodyUnavailableReason: "binary"`.
- **WebSocket / EventSource / WebRTC.** Out of scope for Phase 1. The
  extension captures only `fetch` and `XMLHttpRequest`.
- **Firefox / Safari.** Not supported in Phase 1. Tracked in [ROADMAP.md](ROADMAP.md).

---

## Troubleshooting

- **Console dropdown does not show a Browser entry.** Check that
  `~/.mobile-api-console.json` has `browser.enabled: true`. Restart the
  console after editing the file. `curl http://localhost:3957/api/sources`
  confirms the server's view.
- **Extension installed but nothing appears.** Open the page you're trying
  to monitor and check the extension's options page — is its URL in your
  target page URL list? Match patterns are exact
  (`https://app.example.com/*`, not `app.example.com`). Also confirm Chrome
  granted the requested host permission.
- **Events arrive but the Response tab says "Body not captured".** Strict
  CSP on the target site. Open the page's devtools, network tab, response
  headers — if you see a `Content-Security-Policy` that omits
  `'unsafe-inline'` or sets a strict `script-src`, that's the cause. There
  is no body-capture workaround in Phase 1.
- **Response headers are missing for cross-origin APIs.** Add the API origin to
  the extension's Request URL permissions and grant the host permission.
- **Two sessions appear for the same site.** You're viewing the site in two
  different browser profiles (normal + incognito, or two named profiles).
  This is intentional.
- **CORS error in extension console.** The ingest endpoint allows
  extension-origin POSTs defensively, but normal operation sends from the
  background service worker with `http://localhost/*` host permission. If you
  see CORS from a page origin, a content script or page script is POSTing
  directly; route it through the service worker instead.
- **`413 Payload Too Large`.** The full JSON POST exceeded 2 MB. The extension
  truncates individual bodies to 1 MB before sending, so a 413 usually means
  very large headers or a bug in extension-side truncation.

---

## Agent-neutral setup prompt

Use this when handing the install to a coding assistant on a target machine:

> ```
> You are setting up the browser-capture portion of Mobile API Console.
>
> Inputs:
> - Console repo: <path or repo URL>
> - Target page URL(s) to monitor: <e.g. https://app.example.com/*>
> - Optional API request URL(s) for response headers: <e.g. https://api.example.com/*>
> - Browser to install into: <Chrome | Brave | Edge | Arc | Opera>
>
> Tasks:
> 1. Confirm the console is already installed and reachable at
>    http://localhost:3957/api/sources. If not, install it first per the
>    repo's main README.
> 2. Add or merge this block into ~/.mobile-api-console.json (do not
>    commit; this file is gitignored):
>      "browser": {
>        "enabled": true,
>        "targetUrls": ["<the page URL pattern(s) above>"],
>        "requestUrls": ["<the optional API URL pattern(s) above>"]
>      }
>    Restart the console.
> 3. In the chosen browser, open the extensions page, enable Developer
>    mode, and load the extension/ directory from the console repo as an
>    unpacked extension.
> 4. Open the extension's Options page and enter the same target page URL(s)
>    and request URL(s) you put in the config file. Save and grant the
>    requested host permissions.
> 5. Verify with the curl ingest snippet from docs/BROWSER_SETUP.md
>    "Verifying end-to-end" section; confirm a synthetic event shows up
>    in the Browser source.
> 6. Load the real target page URL in the browser, trigger a request, and
>    confirm a real event lands in the same session.
>
> Constraints:
> - Do not change the wire format.
> - Do not enable capture for any page or request URL the user did not authorize.
> - Do not ship the extension to the Chrome Web Store or any other store.
>   Loading unpacked from the repo is the only supported install path
>   right now.
>
> Report the browser used, the exact targetUrls/requestUrls values written,
> and one captured event from the curl verify step.
> ```
