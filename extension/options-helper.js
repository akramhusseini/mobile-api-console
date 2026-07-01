"use strict";

// Options-page helpers for the Mobile API Console browser extension.
//
// This module is intentionally written as a UMD-style helper so it can be:
//   1. `importScripts`-ed by the options page (`options.js`).
//   2. `require`d from the Node test suite under `test/`.
//
// The host-permission request must be issued from a synchronous user
// gesture. Awaiting anything (a `chrome.permissions.contains` check, a
// `chrome.storage.local.get`, etc.) between the gesture and the call to
// `chrome.permissions.request` makes Chrome silently auto-deny the prompt.
// `requestHostPermissions` is therefore the only call path — the caller
// passes a single combined origin list and we fire exactly one request.

(function (globalThis) {
  function splitLines(value) {
    return String(value == null ? "" : value)
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
  }

  function toMatchPatterns(lines) {
    const out = [];
    for (const line of lines) {
      if (!line) continue;
      // Mirror the cheap filter options.js uses: only treat lines that
      // look like URL patterns as patterns; ignore plain prose.
      if (/[*?:\/.]/.test(line) || line.startsWith("http")) {
        out.push(line);
      }
    }
    return out;
  }

  // Issues a single chrome.permissions.request call for the combined list
  // of target and request URL patterns. The chrome API can be injected for
  // tests. The promise resolves to:
  //   { ok: true,  granted: [...] } on success
  //   { ok: false, error: "..." }  on denial / failure
  async function requestHostPermissions(patterns, deps) {
    const api = (deps && deps.permissions) || (typeof chrome !== "undefined" && chrome.permissions);
    if (!api || typeof api.request !== "function") {
      return { ok: false, error: "chrome.permissions.request unavailable" };
    }
    if (!Array.isArray(patterns) || patterns.length === 0) {
      return { ok: true, granted: [] };
    }
    try {
      const granted = await api.request({ origins: patterns });
      if (granted) return { ok: true, granted: patterns };
      return { ok: false, error: "user cancelled" };
    } catch (error) {
      return { ok: false, error: error && error.message ? error.message : String(error) };
    }
  }

  // Validates form input, returns the pattern lists to persist, and asks
  // the user for all the host permissions in a single prompt.
  //
  // Returns one of:
  //   { ok: true, config: { consoleHost, targetUrls, requestUrls } }
  //   { ok: false, error: "no_target_patterns" }
  //   { ok: false, error: "permission_denied", detail: "..." }
  async function buildAndAuthorize(form, deps) {
    const consoleHost = String(form.consoleHost || "").trim() || "http://localhost:3957";
    const targetPatterns = toMatchPatterns(splitLines(form.targetUrls));
    const requestPatterns = toMatchPatterns(splitLines(form.requestUrls));

    if (targetPatterns.length === 0) {
      return { ok: false, error: "no_target_patterns" };
    }

    // Combine into a single permission request. This is the user gesture
    // window — only one chrome.permissions.request per Save click.
    const combined = targetPatterns.concat(requestPatterns);
    const perm = await requestHostPermissions(combined, deps);
    if (!perm.ok) {
      return { ok: false, error: "permission_denied", detail: perm.error || "user cancelled" };
    }

    return {
      ok: true,
      config: {
        consoleHost,
        targetUrls: targetPatterns,
        requestUrls: requestPatterns
      }
    };
  }

  // Derive the capture match pattern for a tab URL. Used by the one-click
  // "Capture this site" popup so the user never types a URL (and can never
  // mistype it, e.g. .co vs .com). Returns `https://host/*` for http/https
  // pages, or null for pages we cannot capture (chrome://, brave://,
  // about:, extension pages, etc.).
  function originPatternForUrl(url) {
    if (typeof url !== "string" || !url) return null;
    let parsed;
    try { parsed = new URL(url); } catch { return null; }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return `${parsed.origin}/*`;
  }

  // Return a new config with `pattern` added to targetUrls (deduped),
  // preserving consoleHost and requestUrls. Pure so the popup and tests
  // share one definition of "add this site to the allowlist".
  function addTargetPattern(config, pattern) {
    const base = (config && typeof config === "object") ? config : {};
    const targetUrls = Array.isArray(base.targetUrls) ? base.targetUrls.slice() : [];
    if (pattern && !targetUrls.includes(pattern)) targetUrls.push(pattern);
    return {
      consoleHost: base.consoleHost || "http://localhost:3957",
      targetUrls,
      requestUrls: Array.isArray(base.requestUrls) ? base.requestUrls.slice() : []
    };
  }

  // Origin of `requestUrl` when it is cross-origin to `pageOrigin`, else null.
  // Lets the popup detect the API host a captured page actually calls and
  // offer one-click header capture for it. The legacy function name is kept
  // because popup/tests already call it; the returned value is now scheme+host
  // so HTTP dev servers don't get converted into HTTPS permission patterns.
  function crossOriginApiHost(pageOrigin, requestUrl) {
    let request;
    try { request = new URL(requestUrl); } catch { return null; }
    if (request.protocol !== "http:" && request.protocol !== "https:") return null;
    let page = null;
    try { page = new URL(pageOrigin); } catch { page = null; }
    if (page && request.origin === page.origin) return null;
    return request.origin;
  }

  function requestPatternForHost(originOrHost) {
    if (typeof originOrHost !== "string" || !originOrHost) return null;
    try {
      const parsed = new URL(originOrHost);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
      return `${parsed.origin}/*`;
    } catch {
      return `https://${originOrHost}/*`;
    }
  }

  // Observed API origins/hosts not already covered by a configured request pattern.
  function apiHostSuggestions(observedHosts, requestUrls) {
    const observed = Array.isArray(observedHosts) ? observedHosts : [];
    const patterns = Array.isArray(requestUrls) ? requestUrls : [];
    const seen = new Set();
    const out = [];
    for (const host of observed) {
      if (!host || seen.has(host)) continue;
      seen.add(host);
      if (patterns.some((p) => typeof p === "string" && p.includes(host))) continue;
      out.push(host);
    }
    return out;
  }

  const api = {
    splitLines,
    toMatchPatterns,
    requestHostPermissions,
    buildAndAuthorize,
    originPatternForUrl,
    addTargetPattern,
    crossOriginApiHost,
    requestPatternForHost,
    apiHostSuggestions
  };

  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    globalThis.MobileApiConsoleOptions = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : self);
