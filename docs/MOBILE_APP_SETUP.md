# Mobile App Setup

The Mobile API Console doesn't read the network — it reads what your app
**logs**. To see anything in the UI, you need to emit a specific log format
from the mobile app. This document is the canonical reference for that
emitter, on both iOS and Android.

If you'd rather paste a prompt to an AI coding assistant and have it do the
wiring, jump to [Agent-neutral setup prompt](#agent-neutral-setup-prompt) at
the bottom of this file.

The mobile app repository can live anywhere on disk. These steps are applied
inside the app repo, but the console itself does not need that path and should
not be configured with local checkout directories. It only needs the emitted
OSLog / Logcat lines and the matching identifiers in `~/.mobile-api-console.json`.

- [Overview](#overview)
- [iOS setup](#ios-setup)
- [Android setup](#android-setup)
- [Verifying end-to-end](#verifying-end-to-end)
- [Troubleshooting](#troubleshooting)
- [Agent-neutral setup prompt](#agent-neutral-setup-prompt)

---

## Overview

There are two emitter formats — one per platform — and the console picks the
right parser for each running source.

| | iOS | Android |
|---|---|---|
| Log channel | OSLog (`os.Logger`) | Logcat (`android.util.Log.d`) |
| How the console reads it | `xcrun simctl spawn booted log stream --predicate '…'` | `adb logcat -v threadtime -T 1 API_CURL:D '*:S'` |
| Selector | `subsystem` + `category` (default `com.example.mobile` / `api-console`) | tag (default `API_CURL`) |
| Format | `===== REQUEST =====` / `===== CURL COMMAND =====` / `===== RESPONSE =====` blocks | `[STATUS] METHOD apiName (duration)` summary line + cURL + optional `[BODY] …` |
| Request body | `Body:` field inside REQUEST block | embedded in cURL (`-d '…'`) |
| Response body | `Body:` field inside RESPONSE block | optional `[BODY] {…}` line (Android only emits if app explicitly logs it) |
| Response headers | inside RESPONSE block | **not supported** in the default `API_CURL` format |
| Build gate | `#if DEBUG` | `if (!BuildConfig.DEBUG) return` |
| Clear marker | `API_CONSOLE_CLEAR` (or `===== CONSOLE CLEARED =====` or `CONSOLE_CLEARED`) | same — any of those three strings |

Both formats are intentionally minimal — text in, parsed events out. You can
add fields without breaking the parser as long as you don't change the
markers.

Current console behavior: iOS and Android emitters can both be installed in
their apps. If only one platform is available, the console records that
platform. If both are available, the service records both continuously while
the dropdown selects which platform history is visible.

### Non-negotiable log contract

The console is deliberately simple: it does not inspect your app code and does
not sniff HTTPS traffic. It only parses text logs. If the UI is empty, first
prove the raw logs match this contract.

- **Debug-only:** emitters must compile out of release builds.
- **Stable selectors:** iOS uses one `subsystem` + category `api-console`;
  Android uses one Logcat tag, `API_CURL` by default.
- **Whole blocks:** iOS REQUEST / CURL / RESPONSE blocks must be emitted as
  one OSLog call per block, not one log call per line.
- **Public iOS privacy:** iOS string interpolation must use
  `privacy: .public`, otherwise OSLog redacts the useful values.
- **Exact Android summary:** Android requests must start with
  `[200] GET path (123ms)` or `[ERR] GET path (123ms)`.
- **Exact Android body marker:** Android response bodies must be prefixed with
  `[BODY] `.
- **Long Android messages:** continuation chunks must be prefixed with literal
  `...` so the parser joins them without injecting fake newlines.
- **Clear markers:** `API_CONSOLE_CLEAR`, `===== CONSOLE CLEARED =====`, or
  `CONSOLE_CLEARED` start a fresh session for that platform only.

---

## iOS setup

### Prerequisites

- macOS + Xcode + an iOS Simulator you can boot.
- The app builds in **`DEBUG`** configuration. The emitter must compile out of
  Release builds.
- A network layer you can intercept — typically a `URLSession`-based
  `NetworkManager` / API client.

### Step 1: Add an OSLog-based logger

Create or extend a file in your network layer. The subsystem and category
strings here must match what the console expects — they default to
`com.example.mobile` / `api-console`. For your own app, pick something stable
and put the real values in `~/.mobile-api-console.json` under `ios.subsystem`
and `ios.category` (see the main [README](../README.md#per-developer-config-file-mobile-api-consolejson)).

```swift
import OSLog
import Foundation

#if DEBUG
extension NetworkManager {
    private static let apiConsoleLogger = Logger(
        subsystem: "com.example.mobile",     // ← change for your app
        category: "api-console"               // ← keep as "api-console" by convention
    )

    /// Emits one OSLog entry per call. Pass the entire multi-line block as
    /// a single string — do NOT split by newlines and call this per line,
    /// because that makes the Xcode console draw a row divider between
    /// every line.
    private func debugAPIConsolePrint(_ message: String) {
        Self.apiConsoleLogger.debug("\(message, privacy: .public)")
    }
}
#endif
```

The `privacy: .public` matters — without it OSLog redacts string
interpolations as `<private>` and the console sees nothing useful.

### Step 2: Emit a REQUEST block before each call

```swift
#if DEBUG
extension NetworkManager {
    private func printRequest(_ request: URLRequest) {
        var lines: [String] = []
        lines.append("===== REQUEST =====")
        lines.append("URL: \(request.url?.absoluteString ?? "N/A")")
        lines.append("Method: \(request.httpMethod ?? "N/A")")

        if let headers = request.allHTTPHeaderFields, !headers.isEmpty {
            lines.append("Headers:")
            for (key, value) in headers.sorted(by: { $0.key < $1.key }) {
                lines.append("  \(key): \(value)")
            }
        }

        if let body = request.httpBody, let text = String(data: body, encoding: .utf8) {
            lines.append("Body: \(text)")
        }

        lines.append("====================")
        debugAPIConsolePrint(lines.joined(separator: "\n"))
        printCurlCommand(request)
    }
}
#endif
```

Multipart requests go through a sibling `printMultipartRequest(_:)` that uses
`===== MULTIPART REQUEST =====` instead.

### Step 3: Emit a CURL COMMAND block

```swift
#if DEBUG
extension NetworkManager {
    private func printCurlCommand(_ request: URLRequest) {
        guard let url = request.url else { return }
        var parts: [String] = ["===== CURL COMMAND ====="]
        var curl = "curl -X \(request.httpMethod ?? "GET")"

        request.allHTTPHeaderFields?.forEach { key, value in
            curl += " \\\n  -H '\(key): \(value)')"
        }
        if let body = request.httpBody, let text = String(data: body, encoding: .utf8) {
            curl += " \\\n  -d '\(text)'"
        }
        curl += " \\\n  '\(url.absoluteString)'"

        parts.append(curl)
        parts.append("===========================")
        debugAPIConsolePrint(parts.joined(separator: "\n"))
    }
}
#endif
```

### Step 4: Emit a RESPONSE block after each call

```swift
#if DEBUG
extension NetworkManager {
    private func printResponse(_ response: HTTPURLResponse, data: Data?, for url: URL?) {
        var lines: [String] = []
        lines.append("===== RESPONSE =====")
        lines.append("Status Code: \(response.statusCode)")
        if let url = url {
            lines.append("URL: \(url.absoluteString)")
        }
        lines.append("Headers:")
        for (key, value) in response.allHeaderFields.sorted(by: { "\($0.key)" < "\($1.key)" }) {
            lines.append("  \(key): \(value)")
        }
        if let data = data, let text = String(data: data, encoding: .utf8) {
            lines.append("Body:")
            lines.append(text)
        }
        lines.append("======================")
        debugAPIConsolePrint(lines.joined(separator: "\n"))
    }
}
#endif
```

### Step 5: Wire it into your network layer

In the actual request dispatch:

```swift
#if DEBUG
printRequest(request)
#endif

let (data, response) = try await URLSession.shared.data(for: request)

#if DEBUG
if let http = response as? HTTPURLResponse {
    printResponse(http, data: data, for: request.url)
}
#endif
```

### Step 6 (optional): Reset the console from the app

Anywhere — e.g. on app foreground, or behind a debug menu item — emit any of
these markers and the console wipes the current session:

```swift
#if DEBUG
NetworkManager.apiConsoleLogger.debug("\("API_CONSOLE_CLEAR", privacy: .public)")
#endif
```

### Common iOS pitfalls

- **Splitting blocks per line.** Calling `apiConsoleLogger.debug` once per
  line makes Xcode draw a row divider between every line of the block, and
  also creates more parser ambiguity. Always join the block into one string
  and call `debug` once.
- **Forgetting `privacy: .public`.** OSLog redacts string interpolations by
  default. The console will receive `<private>` placeholders.
- **Double-printing.** If you also `print(...)` the same content, Xcode shows
  every line twice. Pick one — keep `os_log` for the console, drop `print`.
- **`#if DEBUG` not gating.** Make sure your release build target has `DEBUG`
  *off*; otherwise these markers leak into production logs.

---

## Android setup

### Prerequisites

- Android Studio with at least the platform-tools (`adb`) on the SDK path.
- An emulator booted, or a USB-debuggable device attached. Verify with
  `adb devices`.
- The app builds in the **`debug`** variant, and `BuildConfig.DEBUG` is `true`
  in that variant. The emitter must compile out of `release`.
- An HTTP client you can intercept — **OkHttp / Retrofit** is what these
  examples assume. Adapt the interceptor shape if you use Ktor or pure
  `HttpURLConnection`.

### Step 1: Add a `NetworkLogEntry` data class

Holds one captured call, with helpers for the `apiName()` and the `toCurl()`
representation the parser will see.

```kotlin
// app/src/main/kotlin/.../features/networklog/NetworkLogEntry.kt
package com.example.app.features.networklog

import java.util.UUID

data class NetworkLogEntry(
    val id: String = UUID.randomUUID().toString(),
    val timestamp: Long = System.currentTimeMillis(),
    val method: String,
    val url: String,
    val requestHeaders: Map<String, String>,
    val requestBody: String?,
    val responseCode: Int?,
    val responseHeaders: Map<String, String>,
    val responseBody: String?,
    val durationMs: Long?,
    val error: String?
) {
    fun toCurl(): String {
        val sb = StringBuilder("curl -X $method")
        requestHeaders.forEach { (key, value) ->
            sb.append(" \\\n  -H '${escape("$key: $value")}'")
        }
        if (!requestBody.isNullOrBlank()) {
            val hasContentType = requestHeaders.keys.any { it.equals("Content-Type", true) }
            if (!hasContentType) sb.append(" \\\n  -H 'Content-Type: application/json'")
            sb.append(" \\\n  -d '${escape(requestBody)}'")
        }
        sb.append(" \\\n  '${escape(url)}'")
        return sb.toString()
    }

    fun apiName(): String = try {
        val path = java.net.URL(url).path
        path.removePrefix("/api/v1/").removePrefix("/api/v2/").removePrefix("/api/").trimEnd('/')
            .ifBlank { path }
    } catch (_: Exception) { url }

    fun formattedDuration(): String = when {
        durationMs == null -> "-"
        durationMs < 1000 -> "${durationMs}ms"
        else -> "%.1fs".format(durationMs / 1000.0)
    }

    private fun escape(value: String): String = value.replace("'", "'\"'\"'")
}
```

### Step 2: Add `CurlLogger` — the emitter the console reads

This file is the **contract**. Get this right and the console works. The tag,
the `[STATUS]` summary line, the cURL block, and the optional `[BODY]` line
are all what `AndroidApiCurlParser` matches on.

```kotlin
// app/src/main/kotlin/.../features/networklog/CurlLogger.kt
package com.example.app.features.networklog

import android.util.Log
import com.example.app.BuildConfig

object CurlLogger {
    private const val TAG = "API_CURL"     // ← matches android.logTag in ~/.mobile-api-console.json
    private const val MAX_LOG_LENGTH = 4000

    fun log(entry: NetworkLogEntry) {
        if (!BuildConfig.DEBUG) return

        val status = entry.responseCode?.toString() ?: "ERR"
        Log.d(TAG, "[$status] ${entry.method} ${entry.apiName()} (${entry.formattedDuration()})")
        logLongMessage(entry.toCurl())
        entry.responseBody?.takeIf { it.isNotBlank() }?.let {
            logLongMessage("[BODY] $it")
        }
    }

    private fun logLongMessage(message: String) {
        if (message.length <= MAX_LOG_LENGTH) {
            Log.d(TAG, message)
            return
        }
        // Logcat's per-line limit is ~4 KB. Split long messages and prefix
        // continuation chunks with "..." so the console parser glues them
        // back without inserting a fake newline (which would corrupt JSON
        // split mid-string).
        message.chunked(MAX_LOG_LENGTH).forEachIndexed { index, chunk ->
            val prefix = if (index == 0) "" else "..."
            Log.d(TAG, "$prefix$chunk")
        }
    }
}
```

Three subtle bits that matter:

1. The TAG must be a single token, no spaces — `adb logcat` uses it as a filter.
2. The summary line format `[\d{3}|ERR] METHOD path (duration)` is what opens
   a new event in the parser. Keep the brackets, the space-separated method,
   the parenthesised duration.
3. The `...` prefix on continuation chunks is **required**. Without it,
   parser-side reassembly will insert `\n` at every chunk boundary and any
   compact-JSON body over 4000 chars will fail to pretty-print.

### Step 3: Add the OkHttp interceptor

```kotlin
// app/src/main/kotlin/.../features/networklog/NetworkLogInterceptor.kt
package com.example.app.features.networklog

import okhttp3.Interceptor
import okhttp3.Response
import okio.Buffer
import java.io.IOException

class NetworkLogInterceptor : Interceptor {
    override fun intercept(chain: Interceptor.Chain): Response {
        val request = chain.request()
        val startTime = System.currentTimeMillis()

        val requestBody: String? = request.body?.let { body ->
            try {
                val buffer = Buffer()
                body.writeTo(buffer)
                buffer.readUtf8()
            } catch (_: IOException) { null }
        }

        val requestHeaders = request.headers.toMap()

        return try {
            val response = chain.proceed(request)
            val duration = System.currentTimeMillis() - startTime
            val responseBody = response.peekBody(Long.MAX_VALUE).string()

            val entry = NetworkLogEntry(
                method = request.method,
                url = request.url.toString(),
                requestHeaders = requestHeaders,
                requestBody = requestBody,
                responseCode = response.code,
                responseHeaders = response.headers.toMap(),
                responseBody = responseBody,
                durationMs = duration,
                error = null
            )
            CurlLogger.log(entry)
            response
        } catch (e: IOException) {
            val duration = System.currentTimeMillis() - startTime
            val entry = NetworkLogEntry(
                method = request.method,
                url = request.url.toString(),
                requestHeaders = requestHeaders,
                requestBody = requestBody,
                responseCode = null,
                responseHeaders = emptyMap(),
                responseBody = null,
                durationMs = duration,
                error = e.message ?: "Network error"
            )
            CurlLogger.log(entry)
            throw e
        }
    }
}
```

`response.peekBody(Long.MAX_VALUE)` reads the body without consuming it, so
downstream code still sees the original `ResponseBody`. Don't replace this
with `response.body?.string()` — that's a one-shot read.

### Step 4: Wire it into your OkHttpClient

Wherever you build your shared `OkHttpClient`:

```kotlin
val client = OkHttpClient.Builder()
    .addInterceptor(NetworkLogInterceptor())   // ← add this
    .build()
```

Place it **after** any auth/retry interceptors so the headers it logs are the
ones actually sent on the wire.

### Step 5: Optional — clear the console from the app

```kotlin
if (BuildConfig.DEBUG) {
    Log.d("API_CURL", "API_CONSOLE_CLEAR")
}
```

Useful behind a debug-menu button or on app cold-start.

### Common Android pitfalls

- **`adb` not on `PATH`.** Android Studio installs it but doesn't add it to
  shell `PATH`. Either export `ANDROID_HOME` (the console uses it to find
  `adb`), or set `android.adbPath` in `~/.mobile-api-console.json`.
- **`BuildConfig.DEBUG` is false.** This happens if you accidentally test
  with the `release` variant, or `buildTypes.debug.isDebuggable = false`.
  Check `BuildConfig.DEBUG` is true in a `Log.d` from `onCreate`.
- **Tag collision.** If your project already uses tag `API_CURL` for
  something else, change `TAG` here and set `android.logTag` in
  `~/.mobile-api-console.json` to match.
- **Multipart bodies look wrong.** OkHttp's multipart `Buffer.readUtf8()` is
  raw bytes; for binary multipart you'll see garbled content. Acceptable
  for debugging.
- **Splitting the cURL by hand.** Don't try to break the cURL string into
  multiple `Log.d` calls per line. `Log.d` already splits on `\n`, and
  `logLongMessage`'s chunker handles the 4 KB limit. Just call it once with
  the full string.

---

## Verifying end-to-end

### iOS

In one terminal:

```sh
xcrun simctl spawn booted log stream \
  --style compact \
  --predicate 'subsystem == "com.example.mobile" AND category == "api-console"'
```

In another, run the app and trigger a request. You should see:

```text
===== REQUEST =====
URL: https://api.example.com/...
Method: GET
…
====================
===== CURL COMMAND =====
curl -X GET …
===========================
===== RESPONSE =====
Status Code: 200
…
======================
```

Then open the console: http://localhost:3957. The dropdown should say
"iOS Simulator (…)" and a Live session should populate.

### Android

In one terminal:

```sh
~/Library/Android/sdk/platform-tools/adb logcat -v threadtime -T 1 API_CURL:D '*:S'
```

(Adjust the `adb` path if needed.) Run the app, trigger a request. You should
see:

```text
06-24 16:32:11.123 12345 12346 D API_CURL: [200] GET v1/users (245ms)
06-24 16:32:11.124 12345 12346 D API_CURL: curl -X GET \
06-24 16:32:11.124 12345 12346 D API_CURL:   -H 'Accept: application/json' \
06-24 16:32:11.124 12345 12346 D API_CURL:   'https://api.example.com/v1/users'
06-24 16:32:11.125 12345 12346 D API_CURL: [BODY] {"data":[…]}
```

Open the console; the dropdown should say "Android" and the session should
populate.

---

## Troubleshooting

- **Nothing reaches the console.** Sanity-check at the log layer (the verify
  commands above). If `xcrun` or `adb` shows nothing, the app side is the
  problem. If they show lines but the UI doesn't, it's the console.
- **Lines show up but block boundaries look wrong (iOS).** The most common
  cause is splitting the block across multiple `os_log` calls. Concatenate
  the whole block to one string and call `debug` once.
- **cURL parses but URL is empty.** Make sure the URL is wrapped in single
  quotes as the last token of the cURL: `... \\\n  '<url>'`.
- **Response body is empty on Android.** Your `CurlLogger` may not be emitting
  the `[BODY]` line. Confirm in raw logcat first.
- **JSON looks crammed on Android for big payloads.** You may be running an
  older console build. The parser must handle the `...` continuation prefix
  by *concatenating* (no newline) so chunk boundaries inside string literals
  don't break `JSON.parse`. Update the console to the current build.

---

## Agent-neutral setup prompt

Copy the block below into any coding assistant once you're inside the mobile-app
repo. It's self-contained — the assistant does not need to read this file.

> ```
> You're going to wire a mobile app into the Mobile API Console — a local
> browser tool that mirrors API traffic by parsing log lines. Your job is to
> add the right log emitter on the mobile side.
>
> Step 1 — figure out the platform:
>   - If you see `Podfile`, `*.xcodeproj`, or `*.swift` files → iOS.
>   - If you see `build.gradle.kts`, `build.gradle`, or `AndroidManifest.xml`
>     → Android.
>   - If both are present, wire both unless I explicitly asked for only one.
>     The console can record both platforms at the same time.
>
> Step 2 — read the network layer for each selected platform. Find the central
> place that issues HTTP requests (a `NetworkManager`, an `OkHttpClient`
> builder, a Retrofit module, or similar). Don't sprinkle logging across every
> call site.
>
> Step 3 — emit the exact format the console parses. Do NOT invent your own.
>
> If iOS:
>   - Use OSLog (`import OSLog`) with `Logger(subsystem: "<reverse DNS for
>     this app>", category: "api-console")`. The category MUST be
>     "api-console". Pick a stable subsystem and tell me what you used.
>   - Gate the entire emitter behind `#if DEBUG`.
>   - For each request emit ONE OSLog call per block, with these block
>     headers:
>       ===== REQUEST =====       URL:, Method:, Headers: (followed by
>                                 "  Key: Value" indented lines), Body:
>       ===== CURL COMMAND =====   the full curl command, multi-line is fine
>       ===== RESPONSE =====       Status Code:, URL:, Headers:, Body:
>     End each block with a separator line of >= 8 `=` characters, or with
>     the next block header. Multipart requests use
>     `===== MULTIPART REQUEST =====` instead of REQUEST.
>   - On the OSLog interpolation, use `privacy: .public`. Without this OSLog
>     redacts everything.
>   - Each block must be ONE `logger.debug(...)` call with the lines joined
>     by `\n`. Do not call `debug` once per line.
>
> If Android:
>   - Use `android.util.Log.d` with tag exactly `API_CURL`. The tag is a
>     filter on the console side; don't change it.
>   - Gate the entire emitter behind `if (!BuildConfig.DEBUG) return`.
>   - Add a `NetworkLogEntry` data class with: id, timestamp, method, url,
>     requestHeaders (Map<String,String>), requestBody (String?),
>     responseCode (Int?), responseHeaders (Map<String,String>), responseBody
>     (String?), durationMs (Long?), error (String?). Helpers:
>       - apiName(): trims `/api/v1/`, `/api/v2/`, `/api/` from the URL path
>       - formattedDuration(): "Nms" or "N.Ns"
>       - toCurl(): builds `curl -X <METHOD> \n  -H '...' \n  -d '<body>' \n
>         '<url>'`, escaping `'` as `'\"'\"'`
>   - Add a `CurlLogger` object that, for each entry, logs:
>       1. `Log.d(TAG, "[$status] $method $apiName ($duration)")` where
>          status is the responseCode or `"ERR"`.
>       2. `logLongMessage(entry.toCurl())`
>       3. If responseBody is non-blank:
>          `logLongMessage("[BODY] $responseBody")`
>     `logLongMessage` must split messages over 4000 chars into chunks and
>     prefix continuation chunks with literal `...`. This is required —
>     omitting the `...` corrupts JSON that gets split mid-string.
>   - Add an OkHttp `Interceptor` that wraps the call, captures method, url,
>     request headers, request body (via `Buffer().also { req.body?.writeTo(it) }
>     .readUtf8()`), response code, response headers, response body (via
>     `response.peekBody(Long.MAX_VALUE).string()` — do NOT consume the
>     real body), and duration. On IOException, capture the error string,
>     log via `CurlLogger.log`, then re-throw.
>   - Add this interceptor to the shared `OkHttpClient.Builder()` AFTER any
>     auth/retry interceptors.
>
> Step 4 — verify yourself before declaring done.
>   - iOS: stream `xcrun simctl spawn booted log stream --predicate
>     'subsystem == "<your subsystem>" AND category == "api-console"'` while
>     the app makes a request. Expect REQUEST/CURL/RESPONSE blocks.
>   - Android: run `adb logcat -v threadtime -T 1 API_CURL:D '*:S'` while
>     the app makes a request. Expect summary + cURL + optional [BODY].
>   - If the verification command shows nothing, the emitter isn't wired.
>     Don't ask me to "check the console" — fix it.
>
> Step 5 — report:
>   - The exact subsystem you used (iOS) and/or the tag you used (Android).
>   - The file paths you created or modified.
>   - One captured request from each verify command above, so I can paste the
>     identifiers into ~/.mobile-api-console.json under `ios.subsystem` /
>     `android.applicationId`.
>
> Do not modify the console repo. Do not change my OkHttp/URLSession
> behavior outside adding the interceptor/extension. Do not remove existing
> logging — add alongside.
> ```

After the assistant finishes, drop the values it reports into
`~/.mobile-api-console.json` (see the main [README](../README.md#per-developer-config-file-mobile-api-consolejson))
and you're done.
