# Mobile API Console

A local browser UI that mirrors a mobile app's API traffic. It streams either
iOS Simulator unified logs (`xcrun simctl spawn booted log stream`) or Android
logcat output (`adb logcat`), parses each request / cURL / response block, and
groups them as a list of API calls you can click through. Useful when you want
a clean, copy-friendly view of what the app is actually sending and receiving,
without scrolling through Xcode or Android Studio's console.

The web app is a small Node server plus a plain browser UI. There is no
Electron wrapper and no frontend build step. The only runtime package is
`better-sqlite3`, so run `npm install` once before starting the console.

## Features

- Live stream from available sources: the booted iOS Simulator, attached
  Android emulator/device, or demo mode. Sources are auto-detected on startup;
  when both iOS and Android are available, both record continuously and the
  header dropdown selects which platform history to view.
- Per-call view: status, method, and full URL are pinned in the detail
  header, with tabs for Preview (interactive JSON tree with type-aware
  colors, collapsible `{}` and `[]` nodes, and bracket-pair highlight),
  Headers (request and response headers side by side), Payload (request
  body, also rendered as a tree when JSON), Response (raw response
  body), cURL, Errors, and Raw log lines.
- Search and filter by URL, status, method.
- Resizable workspace: drag the divider between the call list and the
  detail pane to change their proportions, or use the "Hide list"
  toggle in the header to collapse the list entirely (it can be
  restored at any time from the same button). Layout choices persist
  across reloads via `localStorage`.
- Demo mode for offline development of the UI itself.
- SQLite-backed session history so recent captures remain available after a
  restart. Each session is tagged with the platform (`ios-simulator`,
  `android-emulator`, or `android-device`).
- Adaptive capture: iOS-only machines record iOS, Android-only machines record
  Android, machines with both available record both, and machines with neither
  fall back to Demo.
- Optional macOS LaunchAgent so the console runs in the background and is
  always available at `http://localhost:3957`.
- Per-developer config via `~/.mobile-api-console.json` so real bundle ids,
  Logcat tags, and device serials never get committed to the repo.

## Documentation

- [Operations and storage](docs/OPERATIONS.md) - database location, service
  logs, cleanup notes, and future retention controls.
- [Public release checklist](docs/PUBLIC_RELEASE.md) - final checks before
  publishing a clean branch to GitHub.
- [Roadmap and enhancement ideas](docs/ROADMAP.md) - planned expansion areas
  such as always-on multi-source capture, richer JSON viewing, bracket
  highlighting, exports, privacy filters, and disk-space safeguards.

## Prerequisites

- Node.js 18 or newer.
- At least one of:
  - **iOS:** macOS + Xcode + a booted iOS Simulator (the tool uses `xcrun simctl`
    and Apple's unified log).
  - **Android:** Android Studio (or just the platform-tools), with `adb` on
    `PATH` or `ANDROID_HOME` / `ANDROID_SDK_ROOT` exported, and an emulator or
    USB-debuggable device attached.

On startup the console probes both `xcrun` and `adb`. If only one platform is
usable, the UI locks to that platform's live history. If both iOS and Android
are usable, the server starts both log streams and writes both to SQLite while
the dropdown only selects which platform is visible. Demo mode is always
available as a fallback.

### Platform support status

- **macOS:** primary supported and tested platform. Supports iOS Simulator,
  Android emulator/device, Demo mode, and the LaunchAgent background service.
- **Windows / Ubuntu:** Android and Demo mode should work when Node.js and
  `adb` are available. iOS Simulator logging is not available because Apple's
  `xcrun simctl` tooling only exists on macOS. The service scripts in `bin/`
  are macOS LaunchAgent scripts; on Windows / Ubuntu, run foreground for now or
  adapt the server command into your own service manager.

### New macOS machine checklist

Use this when setting up a fresh Mac or helping another developer get running:

1. Install Xcode from the App Store if you need iOS capture, then open it once
   so it finishes installing simulator components.
2. Install Android Studio or Android platform-tools if you need Android capture.
   Boot an emulator at least once, or attach a USB-debuggable device.
3. Install Node.js 18 or newer.
4. Clone this console repo anywhere on disk and run `npm install`.
5. Add `~/.mobile-api-console.json` with the real app identifiers:
   iOS subsystem/category, Android package/tag, and optionally the Android
   device serial or `adb` path.
6. Add the debug-only emitter to the mobile app repo. See
   [Mobile App Setup](docs/MOBILE_APP_SETUP.md), including the copy-paste
   assistant prompt if you want a coding assistant to wire it.
7. Verify raw logs first:
   `xcrun simctl spawn booted log stream ...` for iOS and
   `adb logcat -v threadtime -T 1 API_CURL:D '*:S'` for Android.
8. Start the console with `npm start`, or install the LaunchAgent for daily
   background use.
9. Open `http://localhost:3957`, trigger app requests, and confirm sessions
   populate for the available platform(s).

### Install Node.js on macOS

The simplest path is Homebrew:

```sh
# 1. Install Homebrew if you don't already have it
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"

# 2. Install Node (includes npm)
brew install node

# 3. Verify
node --version   # should print v18.x or newer
npm  --version
```

Other ways to install Node — `nvm`, the official installer from
`nodejs.org`, or `asdf` — all work. Anything that gives you `node >= 18` on
`PATH` is fine.

## Install the console

```sh
git clone <repo-url> mobile-api-console
cd mobile-api-console
npm install
```

The console can live anywhere on disk. It does not inspect, import, or assume
the path of your iOS or Android app repository. App-side setup happens inside
the mobile app project, while this console only reads the emitted OSLog or
Logcat output through `xcrun` / `adb` and your local config.

For a new target machine, the minimum handoff is intentionally small:

1. The URL or name of this console repo.
2. The local mobile app repo to instrument.
3. The real app identifiers, if known: iOS subsystem/category and Android
   package/tag.

With those pieces, a coding assistant can follow this README plus
[Mobile App Setup](docs/MOBILE_APP_SETUP.md) to install the console, create
`~/.mobile-api-console.json`, and add the debug-only mobile app log emitter.

The only runtime dependency is [`better-sqlite3`](https://github.com/WiseLibs/better-sqlite3), used to persist sessions and events. On macOS with a recent Node version it installs from a prebuilt binary, so there's no compile step in practice.

By default the database lives at:

```text
~/Library/Application Support/mobile-api-console/data.db
```

Override with `--db <path>` or `MOBILE_API_CONSOLE_DB=<path>`. The parent directory is created on first run.

## Configure the mobile app to feed the console

The console doesn't sniff the network — it parses log lines your app emits.
You'll add a small debug-only emitter on the app side that prints requests
and responses in a specific format the console knows how to read.

**Full walkthrough with copy-pasteable code for both platforms:**
→ **[docs/MOBILE_APP_SETUP.md](docs/MOBILE_APP_SETUP.md)**

That document covers:

- iOS via OSLog (`subsystem` + `category` of your choice).
- Android via Logcat (tag `API_CURL` by default).
- A copy-paste **agent-neutral setup prompt** at the bottom that you can hand
  to any coding assistant inside your mobile-app repo so it does the wiring
  for you.

### Target-machine assistant handoff prompt

Use this prompt when a coding assistant is setting up a new machine. Replace
the placeholders before sending it:

```text
You are setting up Mobile API Console on this machine.

Inputs:
- Console repo: <repo URL or repo name>
- Mobile app repo path(s): <iOS repo path, Android repo path, or both>
- Desired platform(s): <iOS only | Android only | both>
- Known identifiers, if any:
  - iOS subsystem: <value or unknown>
  - iOS category: api-console
  - Android applicationId: <value or unknown>
  - Android Logcat tag: API_CURL

Tasks:
1. Clone or open the console repo and read README.md plus docs/MOBILE_APP_SETUP.md.
2. Install console dependencies with npm install.
3. Confirm platform tools:
   - macOS+iOS: Xcode is installed, xcrun simctl works, and a simulator is booted.
   - Android: adb works and adb devices lists a device/emulator.
4. Create ~/.mobile-api-console.json for the available platform(s). Do not commit
   this file.
5. In the mobile app repo(s), add the debug-only log emitter exactly as described
   in docs/MOBILE_APP_SETUP.md. If both platform repos are present and the desired
   platform is "both", wire both.
6. Verify raw logs before relying on the browser:
   - iOS: xcrun simctl spawn booted log stream --predicate 'subsystem == "<subsystem>" AND category == "api-console"'
   - Android: adb logcat -v threadtime -T 1 API_CURL:D '*:S'
7. Start the console with npm start, or configure the macOS LaunchAgent if this is
   a Mac intended for daily use.
8. Report the final config values, files changed in the mobile app repo(s), and
   one sample raw log block from each configured platform.

Important constraints:
- Do not hardcode local mobile app paths into the console repo.
- Do not remove existing app networking behavior.
- Keep all emitters debug-only.
- On Windows or Ubuntu, configure Android/Demo only; iOS logging is macOS-only.
```

### TL;DR — the wire format

iOS emits four block markers under your chosen `subsystem` + `category`:

```text
===== REQUEST =====
===== MULTIPART REQUEST =====
===== CURL COMMAND =====
===== RESPONSE =====
```

Each block is one `Logger.debug(...)` call with the lines joined by `\n`.
Block ends at the next block header or a line of `=` (length ≥ 8). Inside a
block the parser reads `URL:`, `Method:`, `Status Code:`, `Headers:` (followed
by `  key: value` indented lines), and `Body:`.

Android emits one tag (`API_CURL` by default) with three line shapes per
request:

```text
[200] GET v1/users (245ms)            ← summary line opens a new event
curl -X GET \                          ← multi-line cURL
  -H 'Accept: application/json' \
  'https://api.example.com/v1/users'
[BODY] {"data":[…]}                    ← optional response body
```

Long messages (cURL or body over 4 KB) are chunked at 4000-char boundaries by
the app and continuation chunks are prefixed with literal `...` so the parser
glues them back without a fake newline. The console handles that for you.

### Triggering a clear from the app

Emit any of these markers (under the iOS subsystem/category, or under the
Android tag) and the console wipes the current session:

```text
API_CONSOLE_CLEAR
===== CONSOLE CLEARED =====
CONSOLE_CLEARED
```

## Run

There are two supported ways to run the console. **For day-to-day use we
recommend the LaunchAgent setup** so the console is always reachable at
`http://localhost:3957` without a terminal window — but `npm start` works
just as well for quick checks and is the right choice the first few times
you're tweaking config.

- **[Recommended — run as a macOS service](#run-as-a-macos-service-recommended)**
  via a LaunchAgent. Starts on demand and is controlled with the
  `bin/` scripts.
- **[Quick / foreground — `npm start`](#run-in-the-foreground-npm-start)**.
  Useful when you're iterating on config files, want logs in your current
  terminal, or are running on a non-mac box.

Both modes share the same CLI flags, env vars, and `~/.mobile-api-console.json`
config file documented below.

### Run in the foreground (`npm start`)

```sh
cd /path/to/mobile-api-console
npm start
```

Then open:

```text
http://localhost:3957
```

#### Demo mode (no simulator required)

```sh
npm run demo
```

Demo mode does not read your mobile app, `xcrun`, or `adb`. It generates fake
API requests so you can verify the browser UI, SQLite persistence, filtering,
copy buttons, and service setup before wiring a real app. Demo is also the
fallback when neither iOS nor Android is available. Use it to check the console
itself; use iOS or Android mode to inspect real app traffic.

### CLI options

```sh
# iOS
npm start -- --process ExampleMobileApp
npm start -- --predicate 'process == "ExampleMobileApp"'
npm start -- --simulator booted

# Android
npm start -- --android-app com.example.mobile
npm start -- --android-tag API_CURL
npm start -- --android-device emulator-5554
npm start -- --adb-path /opt/homebrew/share/android-sdk/platform-tools/adb

# Initial view selection
npm start -- --source ios
npm start -- --source android
npm start -- --source demo

# General
npm start -- --port 3957
```

### Environment variables

```sh
# iOS
MOBILE_API_CONSOLE_PROCESS=ExampleMobileApp npm start
MOBILE_API_CONSOLE_PREDICATE='subsystem == "com.example.mobile" AND category == "api-console"' npm start
MOBILE_API_CONSOLE_SIMULATOR=booted npm start

# Android
MOBILE_API_CONSOLE_ANDROID_APP_ID=com.example.mobile npm start
MOBILE_API_CONSOLE_ANDROID_LOG_TAG=API_CURL npm start
MOBILE_API_CONSOLE_ANDROID_DEVICE=emulator-5554 npm start
ADB_PATH=/opt/homebrew/share/android-sdk/platform-tools/adb npm start

# Initial view selection
MOBILE_API_CONSOLE_SOURCE=android npm start

# General
MOBILE_API_CONSOLE_PORT=3957 npm start
MOBILE_API_CONSOLE_DEMO=1 npm start
MOBILE_API_CONSOLE_DB="$HOME/Library/Application Support/mobile-api-console/data.db" npm start
```

### Per-developer config file (`~/.mobile-api-console.json`)

For real bundle ids, OSLog subsystem/category values, Logcat tags, and device
serials — anything you don't want to type on every launch and definitely don't
want committed to the repo —
drop a JSON file at `~/.mobile-api-console.json` (also picked up from the
current working directory, and from `$MOBILE_API_CONSOLE_CONFIG` if you set
it). This file is gitignored.

```json
{
  "defaultSource": "auto",
  "ios": {
    "processName": "MyAppName",
    "subsystem": "com.mycompany.myapp",
    "category": "api-console"
  },
  "android": {
    "applicationId": "com.mycompany.myapp",
    "logTag": "API_CURL",
    "deviceSerial": null,
    "adbPath": null
  }
}
```

Resolution order is **CLI flag > environment variable > config file > public
default**, so any value can be overridden ad-hoc without editing the file.

`defaultSource` / `--source` / `MOBILE_API_CONSOLE_SOURCE` controls the
initially visible view. With `auto`, iOS is shown first when available, then
Android, then Demo. When both iOS and Android are available, both still record
in the background. Selecting `demo` intentionally runs Demo-only mode.

### Configuration recipes

**iOS only** — use this when the developer only has Xcode / Simulator:

```json
{
  "defaultSource": "ios",
  "ios": {
    "subsystem": "com.mycompany.myapp",
    "category": "api-console",
    "simulator": "booted"
  }
}
```

**Android only** — use this when the developer only has Android tools:

```json
{
  "defaultSource": "android",
  "android": {
    "applicationId": "com.mycompany.myapp",
    "logTag": "API_CURL",
    "deviceSerial": null,
    "adbPath": null
  }
}
```

If `adb` is not on `PATH`, either set `ANDROID_HOME`, `ANDROID_SDK_ROOT`, or
put the absolute path in `android.adbPath`, for example:

```json
{
  "android": {
    "adbPath": "/Users/you/Library/Android/sdk/platform-tools/adb"
  }
}
```

**Both iOS and Android** — use this on a Mac that can run both apps. The
console records both continuously and the dropdown chooses which history you
are viewing:

```json
{
  "defaultSource": "auto",
  "ios": {
    "subsystem": "com.mycompany.myapp",
    "category": "api-console",
    "simulator": "booted"
  },
  "android": {
    "applicationId": "com.mycompany.myapp",
    "logTag": "API_CURL",
    "deviceSerial": null,
    "adbPath": null
  }
}
```

The console repo can stay in one folder and the mobile app repos can live
anywhere else. The only required connection is the emitted debug log format
plus the matching identifiers above.

When moving the tool to an Android developer's machine, the only setup they
need (beyond `npm install`) is:

1. Create `~/.mobile-api-console.json` with their `applicationId` and Logcat
   tag (the defaults are placeholders for the public repo).
2. Ensure `adb` is on `PATH`, or set `ADB_PATH` / `ANDROID_HOME` in the env or
   under `android.adbPath` in the config file.
3. Start the console — either `npm start` for a foreground run, or install
   the LaunchAgent below for the background flow.

### Windows and Ubuntu notes

These platforms are Android/Demo only. iOS logging is not available outside
macOS. This project has been tested on macOS so far; Windows and Ubuntu should
be treated as best-effort until someone validates them end-to-end.

For Ubuntu:

```sh
npm install
MOBILE_API_CONSOLE_DB="$HOME/.local/share/mobile-api-console/data.db" \
MOBILE_API_CONSOLE_SOURCE=android \
npm start
```

For Windows PowerShell:

```powershell
npm install
$env:MOBILE_API_CONSOLE_DB="$env:LOCALAPPDATA\mobile-api-console\data.db"
$env:MOBILE_API_CONSOLE_SOURCE="android"
npm start
```

Make sure `adb devices` lists an attached device or running emulator before
starting the console. The macOS LaunchAgent section below does not apply to
Windows or Ubuntu.

## Run as a macOS service (recommended)

Installing a LaunchAgent keeps the console running in the background after you
start it with the helper script, so `http://localhost:3957` is reachable
without a terminal window. This is the setup we use day-to-day on macOS.
The plist below uses `RunAtLoad=false` and `KeepAlive=false`, which means the
helper script starts it on demand. If your team wants it to start automatically
at login, change `RunAtLoad` to `true` after you understand that behavior.

### 1. Create the LaunchAgent plist

Save the following to `~/Library/LaunchAgents/local.mobile-api-console.daemon.plist`,
replacing `__YOUR_HOME__` and `__NODE_PATH__` with the absolute paths from
your machine (`echo "$HOME"` and `which node`):

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>local.mobile-api-console.daemon</string>

    <key>ProgramArguments</key>
    <array>
        <string>__NODE_PATH__</string>
        <string>__YOUR_HOME__/mobile-api-console/server.js</string>
    </array>

    <key>WorkingDirectory</key>
    <string>__YOUR_HOME__/mobile-api-console</string>

    <key>EnvironmentVariables</key>
    <dict>
        <key>PATH</key>
        <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
        <key>MOBILE_API_CONSOLE_PORT</key>
        <string>3957</string>
        <!-- Optional: helps the console auto-detect Android when `adb` is
             not on PATH. Equivalent to setting `android.adbPath` in
             ~/.mobile-api-console.json. -->
        <key>ANDROID_HOME</key>
        <string>__YOUR_HOME__/Library/Android/sdk</string>
    </dict>

    <key>RunAtLoad</key>
    <false/>

    <key>KeepAlive</key>
    <false/>

    <key>StandardOutPath</key>
    <string>__YOUR_HOME__/Library/Logs/mobile-api-console.out.log</string>

    <key>StandardErrorPath</key>
    <string>__YOUR_HOME__/Library/Logs/mobile-api-console.err.log</string>
</dict>
</plist>
```

### 2. Control the service

```sh
~/mobile-api-console/bin/start-service       # bootstrap + kickstart
~/mobile-api-console/bin/stop-service        # graceful TERM, then KILL if needed
~/mobile-api-console/bin/status-service      # is it running? is the port open?
~/mobile-api-console/bin/uninstall-service   # bootout + delete plist
```

After editing the plist (e.g. adding `ANDROID_HOME` or swapping `WorkingDirectory`),
run `bin/stop-service` then `bin/start-service` so launchd re-reads it.

#### Using a custom service label

The scripts assume the LaunchAgent label is `local.mobile-api-console.daemon`.
If your plist uses a different label, export it once:

```sh
export MOBILE_API_CONSOLE_SERVICE_LABEL=dev.mycompany-api-console.daemon
```

All four `bin/*-service` scripts honour this override. Add the export to your
shell profile to make it permanent.

### 3. Logs

```text
~/Library/Logs/mobile-api-console.out.log
~/Library/Logs/mobile-api-console.err.log
```

Tail them with:

```sh
tail -f ~/Library/Logs/mobile-api-console.out.log
```

### 4. Quick switching while the service runs

The header dropdown in the UI selects the visible platform live — no need to
restart the service when you move between the iOS Simulator, an Android
emulator, and demo mode. When multiple real sources are available, each keeps
recording into its own SQLite session while you switch views. The selected
view is also exposed via:

```sh
curl http://localhost:3957/api/sources                              # current + available
curl -X POST -H 'Content-Type: application/json' \
     -d '{"kind":"android"}' http://localhost:3957/api/source        # switch live
```

## Project layout

```text
mobile-api-console/
├── docs/                   # roadmap, operations, and future expansion notes
├── bin/                    # service control scripts + node entry point
├── public/                 # static UI (HTML / CSS / JS)
├── src/
│   ├── config.js           # CLI / env / ~/.mobile-api-console.json resolution
│   ├── platform.js         # xcrun + adb detection
│   ├── sourceManager.js    # owns live source recorders + parsers
│   ├── eventStore.js       # source/session-scoped event store with SSE notifications
│   ├── sseHub.js           # Server-Sent Events hub
│   ├── logSource/          # SimulatorLogStream, AdbLogcatStream, DemoLogSource
│   └── parsers/            # mobileNetworkParser (iOS) + androidApiCurlParser
├── test/                   # node --test
├── server.js               # HTTP server + wiring
└── package.json
```

## Tests

```sh
npm test
```

## License

MIT. See [LICENSE](LICENSE).

## Troubleshooting

- **"No API calls yet" in the UI (iOS)** — make sure the iOS app is built in
  `DEBUG`, the Simulator is booted (`xcrun simctl list devices | grep Booted`),
  and the app is using the `Logger(subsystem: "com.example.mobile", category:
  "api-console")` shown above.
- **"No API calls yet" in the UI (Android)** — make sure the Android app is
  built in `debug`, a device shows in `adb devices`, and `CurlLogger` is being
  called from your OkHttp interceptor. Check `adb logcat -v threadtime API_CURL:D \*:S`
  in a separate terminal to confirm the lines are reaching logcat.
- **Lines appear but blocks aren't grouped (iOS)** — check that each block
  starts with one of the recognised headers (`===== REQUEST =====`, etc.) and
  ends with a separator line of `=` of length 8 or more or with the next block
  header.
- **Android response body is empty** — the Android adapter only displays a body
  when the app emits the optional `[BODY] ...` line under the configured Logcat
  tag. Response headers are not part of the default Android wire format yet.
- **Source dropdown only shows one platform** — the other tool isn't on `PATH`.
  For Android, export `ANDROID_HOME` or `ADB_PATH`. For iOS you need a full
  Xcode install (the Command Line Tools alone are not enough for `simctl`).
- **Port 3957 already in use** — pass `--port` or set `MOBILE_API_CONSOLE_PORT`.
- **Service won't start** — `~/mobile-api-console/bin/status-service`, then check
  `~/Library/Logs/mobile-api-console.err.log`.
