# Operations and Storage

This project is local-first. It stores captured API sessions in a SQLite
database and serves the UI on localhost.

## How we run it

For daily use we run the console as a **macOS LaunchAgent** so it's always
reachable at `http://localhost:3957` without keeping a terminal open. See
[Run as a macOS service](../README.md#run-as-a-macos-service-recommended) in
the README for the plist, control scripts, and log paths.

`npm start` (foreground) remains supported for quick checks, config
iteration, or when running on a non-mac box. Both modes share the same
config (`~/.mobile-api-console.json`), CLI flags, env vars, and SQLite
database.

This operational setup has been tested on macOS. On Windows and Ubuntu, use
foreground `npm start` for Android/Demo mode until a platform-specific service
file is added. iOS logging is not available on Windows or Ubuntu because it
depends on Apple's macOS-only `xcrun simctl` tooling.

The console checkout can live anywhere. The LaunchAgent `WorkingDirectory`
should point to the console repo, not to the iOS or Android app repo. Mobile
app repositories can live in any directory because the console only depends on
the debug log output exposed by `xcrun` and/or `adb`, plus the bundle id,
subsystem/category, Logcat tag, or device serial values in config.

When the LaunchAgent's plist changes (e.g. you add `ANDROID_HOME` or move
the working directory), reload the service so launchd re-reads it:

```sh
~/mobile-api-console/bin/stop-service
~/mobile-api-console/bin/start-service
```

The header dropdown in the UI switches between iOS / Android / Demo views live,
so under normal conditions you almost never need to restart the service.
Restart only when changing the plist itself, the port, or the on-disk config.

Current capture model: the service records every available real source even
when no browser is connected. For example, if both iOS and Android are
available, the iOS log stream and Android `adb logcat` process keep writing to
separate SQLite sessions while the web UI shows whichever platform is selected.
Previously captured sessions remain in the database and can still be selected
from history.

Platform adaptation:

- If only iOS is available, record iOS and show iOS sessions/history.
- If only Android is available, record Android and show Android
  sessions/history.
- If both are available, record both continuously and use the platform selector
  to choose which live stream and history are visible.

## First-run verification

Before blaming the browser UI, verify the raw platform logs:

```sh
# iOS, macOS only. Replace the subsystem with your app's value.
xcrun simctl spawn booted log stream \
  --style compact \
  --predicate 'subsystem == "com.example.mobile" AND category == "api-console"'

# Android. Adjust adb path if it is not on PATH.
adb logcat -v threadtime -T 1 API_CURL:D '*:S'
```

Then trigger one API request in the app. If these commands show nothing, the
mobile app emitter is not wired yet or the config identifiers do not match. If
they show valid blocks but the browser stays empty, check the service logs.

## Database Location

By default the database is stored at:

```text
~/Library/Application Support/mobile-api-console/data.db
```

You can override it when starting the server:

```sh
npm start -- --db /path/to/data.db
```

Or with an environment variable:

```sh
MOBILE_API_CONSOLE_DB=/path/to/data.db npm start
```

The parent directory is created automatically.

## Service Logs

When running through the LaunchAgent, stdout and stderr are written to:

```text
~/Library/Logs/mobile-api-console.out.log
~/Library/Logs/mobile-api-console.err.log
```

Use the helper scripts from the project directory:

```sh
bin/start-service
bin/stop-service
bin/status-service
bin/uninstall-service
```

## Current Cleanup Behavior

The app currently keeps captured sessions until the database is removed or a
future cleanup feature deletes old records. The UI clear action starts a fresh
session for the current active source, but it is not intended to be long-term
retention management.

For manual cleanup today:

1. Stop the server or service.
2. Back up the database if you need to keep old captures.
3. Remove the database files for the selected database path.
4. Start the server again.

SQLite may create sidecar files next to the main database:

```text
data.db
data.db-shm
data.db-wal
```

Remove all three together only when the server is stopped.

## Recommended Retention Direction

Future cleanup work should prefer conservative defaults:

- Keep recent sessions.
- Offer deletion of sessions older than 30 days.
- Show the database size in the UI.
- Warn when the database is large.
- Warn when system free space is low.
- Ask for confirmation before deleting stored sessions.
- Run SQLite `VACUUM` after large cleanup operations so disk space is actually
  returned to the system.

Suggested settings for a future implementation:

```text
MOBILE_API_CONSOLE_RETENTION_DAYS=30
MOBILE_API_CONSOLE_MAX_DB_MB=512
MOBILE_API_CONSOLE_MIN_FREE_SPACE_MB=2048
MOBILE_API_CONSOLE_CLEANUP_ON_START=0
```

These settings are not implemented yet; they document the intended shape of the
feature so future work has a clear target.

## Low Disk Space Behavior

When implemented, low-space handling should be helpful but not surprising:

- Show a warning in the top bar when free space drops below the configured
  threshold.
- Show the current database size and oldest stored session.
- Offer one-click cleanup for sessions older than 30 days.
- Avoid deleting logs automatically unless the user explicitly enables that
  behavior.
- Keep enough detail in the warning for the user to understand what will be
  deleted before confirming.
