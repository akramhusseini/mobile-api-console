# Mobile API Console

A local browser UI that mirrors a mobile app's API traffic from a booted iOS
Simulator. It streams Apple unified logs filtered by the app's debug category,
parses each request / cURL / response / multipart block, and groups them as a
list of API calls you can click through. Useful when you want a clean,
copy-friendly view of what the app is actually sending and receiving, without
scrolling through the Xcode console.

The web app is a small Node server plus a plain browser UI. There is no
Electron wrapper and no frontend build step. The only runtime package is
`better-sqlite3`, so run `npm install` once before starting the console.

## Features

- Live stream from the booted iOS Simulator (`xcrun simctl spawn booted log
  stream`), filtered by subsystem and category.
- Per-call view: request URL/method/headers/body, a ready-to-run cURL command,
  response status/headers/body, raw log lines, and any errors.
- Search and filter by URL, status, method.
- Demo mode for offline development of the UI itself.
- SQLite-backed session history so recent captures remain available after a
  restart.
- Optional macOS LaunchAgent so the console runs in the background and is
  always available at `http://localhost:3957`.

## Documentation

- [Operations and storage](docs/OPERATIONS.md) - database location, service
  logs, cleanup notes, and future retention controls.
- [Public release checklist](docs/PUBLIC_RELEASE.md) - final checks before
  publishing a clean branch to GitHub.
- [Roadmap and enhancement ideas](docs/ROADMAP.md) - planned expansion areas
  such as Android logcat support, richer JSON viewing, bracket highlighting,
  exports, privacy filters, and disk-space safeguards.

## Prerequisites

- macOS (the tool depends on `xcrun simctl` and Apple's unified log).
- Xcode + the iOS Simulator.
- Node.js 18 or newer.

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

The only runtime dependency is [`better-sqlite3`](https://github.com/WiseLibs/better-sqlite3), used to persist sessions and events. On macOS with a recent Node version it installs from a prebuilt binary, so there's no compile step in practice.

By default the database lives at:

```text
~/Library/Application Support/mobile-api-console/data.db
```

Override with `--db <path>` or `MOBILE_API_CONSOLE_DB=<path>`. The parent directory is created on first run.

## Configure the iOS app to feed the console

The console reads from Apple's unified log, filtered by:

```text
subsystem == "com.example.mobile" AND category == "api-console"
```

The iOS app must emit its API debug output through an `os.Logger` with that
exact `subsystem` and `category` while running in a `#if DEBUG` build.

Add (or keep) a debug-only extension on `NetworkManager` like this:

```swift
import OSLog

#if DEBUG
extension NetworkManager {
    private static let apiConsoleLogger = Logger(
        subsystem: "com.example.mobile",
        category: "api-console"
    )

    /// Emits one OSLog entry per call. Pass the entire multi-line block as
    /// a single string — do NOT split by newlines and call this per line,
    /// because that makes the Xcode console draw a row divider between
    /// every line.
    private func debugAPIConsolePrint(_ message: String) {
        Self.apiConsoleLogger.debug("\(message, privacy: .public)")
    }

    private func printRequest(_ request: URLRequest) {
        var lines: [String] = []
        lines.append("🌐 ===== REQUEST =====")
        lines.append("URL: \(request.url?.absoluteString ?? "N/A")")
        lines.append("Method: \(request.httpMethod ?? "N/A")")
        // ... headers, body ...
        lines.append("====================")
        debugAPIConsolePrint(lines.joined(separator: "\n"))

        printCurlCommand(request)
    }

    // printCurlCommand, printMultipartRequest, printResponse follow the
    // same pattern: build the block as one string, call
    // debugAPIConsolePrint once.
}
#endif
```

The parser recognises these block markers (text matters; the emoji prefix
is optional):

```text
===== REQUEST =====
===== MULTIPART REQUEST =====
===== CURL COMMAND =====
===== RESPONSE =====
```

Each block ends at the next block header or at a line of `=` of length 8 or
more. Inside a block the parser understands `URL:`, `Method:`, `Status Code:`,
`Headers:` (followed by `  key: value` indented lines), and `Body:` (followed
by the body — JSON is parsed/displayed prettified if valid).

Android / Android Studio support is not implemented yet. The intended direction
is to add an Android logcat source that emits the same REQUEST / CURL /
RESPONSE block format, so the browser UI and storage model can stay shared
across iOS and Android. See [Roadmap and enhancement ideas](docs/ROADMAP.md).

### Notes on the Xcode side

- The app **must be built in `DEBUG`** for the OSLog extension to compile in.
- Emit each REQUEST / CURL / RESPONSE block as **one** `os_log` call. If you
  split the block by newlines and emit per line, Xcode draws a row divider
  between each line and the console becomes painful to read or copy.
- Don't also `print()` the same content — that doubles every line in the
  Xcode console.

### Triggering a clear from the app

Emit any of these markers from the app to clear both Xcode and this console:

```text
API_CONSOLE_CLEAR
===== CONSOLE CLEARED =====
CONSOLE_CLEARED
```

## Run

```sh
cd /path/to/mobile-api-console
npm start
```

Then open:

```text
http://localhost:3957
```

### Demo mode (no simulator required)

```sh
npm run demo
```

### CLI options

```sh
npm start -- --process ExampleMobileApp
npm start -- --predicate 'process == "ExampleMobileApp"'
npm start -- --simulator booted
npm start -- --port 3957
```

### Environment variables

```sh
MOBILE_API_CONSOLE_PROCESS=ExampleMobileApp npm start
MOBILE_API_CONSOLE_PREDICATE='subsystem == "com.example.mobile" AND category == "api-console"' npm start
MOBILE_API_CONSOLE_PORT=3957 npm start
MOBILE_API_CONSOLE_SIMULATOR=booted npm start
MOBILE_API_CONSOLE_DEMO=1 npm start
MOBILE_API_CONSOLE_DB="$HOME/Library/Application Support/mobile-api-console/data.db" npm start
```

## Run as a macOS service (optional)

Installing a LaunchAgent keeps the console running in the background and
restarts it on reboot.

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

### 3. Logs

```text
~/Library/Logs/mobile-api-console.out.log
~/Library/Logs/mobile-api-console.err.log
```

## Project layout

```text
mobile-api-console/
├── docs/                   # roadmap, operations, and future expansion notes
├── bin/                    # service control scripts + node entry point
├── public/                 # static UI (HTML / CSS / JS)
├── src/
│   ├── config.js           # CLI + env var resolution
│   ├── eventStore.js       # in-memory event store with SSE notifications
│   ├── sseHub.js           # Server-Sent Events hub
│   ├── logSource/          # SimulatorLogStream + DemoLogSource
│   └── parsers/            # mobileNetworkParser: turns log lines into events
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

- **"No API calls yet" in the UI** — make sure the iOS app is built in `DEBUG`,
  the Simulator is booted (`xcrun simctl list devices | grep Booted`), and the
  app is using the `Logger(subsystem: "com.example.mobile", category:
  "api-console")` shown above.
- **Lines appear but blocks aren't grouped** — check that each block starts
  with one of the recognised headers (`===== REQUEST =====`, etc.) and ends
  with a separator line of `=` of length 8 or more or with the next block
  header.
- **Port 3957 already in use** — pass `--port` or set `MOBILE_API_CONSOLE_PORT`.
- **Service won't start** — `~/mobile-api-console/bin/status-service`, then check
  `~/Library/Logs/mobile-api-console.err.log`.
