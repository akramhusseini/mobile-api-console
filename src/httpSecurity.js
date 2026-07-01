"use strict";

function stateChangingOriginAllowed(req, { port } = {}) {
  const hostCheck = localHostHeaderAllowed(req);
  if (!hostCheck.ok) {
    return { ok: false, reason: "invalid-host", host: hostCheck.host };
  }

  const originHeader = firstHeader(req.headers?.origin);
  const refererHeader = firstHeader(req.headers?.referer || req.headers?.referrer);

  // Allow local scripts, curl, and tests. Browsers send Origin for cross-site
  // fetch/forms, which is the case this guard is meant to block.
  if (!originHeader && !refererHeader) {
    return { ok: true, reason: "no-browser-origin" };
  }

  const observed = parseOrigin(originHeader || refererHeader);
  if (!observed) {
    return { ok: false, reason: "invalid-origin" };
  }

  const allowed = allowedConsoleOrigins(req, port);
  if (allowed.has(observed)) {
    return { ok: true, reason: "same-origin" };
  }

  return { ok: false, reason: "cross-origin", origin: observed };
}

function allowedConsoleOrigins(_req, port) {
  const out = new Set();
  const numericPort = Number.parseInt(port, 10);
  if (Number.isFinite(numericPort) && numericPort > 0) {
    out.add(`http://localhost:${numericPort}`);
    out.add(`http://127.0.0.1:${numericPort}`);
    out.add(`http://[::1]:${numericPort}`);
  }
  return out;
}

function localHostHeaderAllowed(req) {
  const host = firstHeader(req.headers?.host);
  if (!host) return { ok: true, host: "" };
  const hostname = parseHostHeader(host);
  if (!hostname) return { ok: false, host };
  const normalized = hostname.toLowerCase();
  if (
    normalized === "localhost" ||
    normalized === "127.0.0.1" ||
    normalized === "::1" ||
    normalized === "[::1]"
  ) {
    return { ok: true, host };
  }
  return { ok: false, host };
}

function parseHostHeader(host) {
  try {
    return new URL(`http://${host}`).hostname;
  } catch {
    return null;
  }
}

function parseOrigin(value) {
  if (!value || typeof value !== "string") return null;
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

function firstHeader(value) {
  if (Array.isArray(value)) return value[0] || "";
  return value || "";
}

module.exports = {
  stateChangingOriginAllowed,
  allowedConsoleOrigins,
  localHostHeaderAllowed
};
