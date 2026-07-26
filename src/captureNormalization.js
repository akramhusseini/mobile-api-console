"use strict";

const HTTP_METHOD_RE = /^[A-Z][A-Z0-9!#$%&'*+.^_`|~-]{0,31}$/;

function splitCaptureLines(value) {
  return String(value || "").split(/\r?\n|(?<!\\)\\r\\n|(?<!\\)\\n/);
}

function firstCaptureLine(value) {
  if (value === null || value === undefined) return value;
  return splitCaptureLines(value)[0].trim();
}

function normalizeHttpMethod(value, { fallback = null } = {}) {
  const method = String(firstCaptureLine(value) || "").toUpperCase();
  return HTTP_METHOD_RE.test(method) ? method : fallback;
}

function normalizeCaptureUrl(value) {
  const firstLine = firstCaptureLine(value);
  return typeof firstLine === "string" ? firstLine.replace(/\\\//g, "/") : firstLine;
}

function normalizeCapturedEvent(event = {}) {
  const url = normalizeCaptureUrl(event.url);
  const endpoint = endpointParts(url);
  return {
    ...event,
    method: normalizeHttpMethod(event.method),
    url,
    host: endpoint.host || firstCaptureLine(event.host),
    path: endpoint.path || firstCaptureLine(event.path),
    request: normalizeMessage(event.request),
    response: normalizeMessage(event.response)
  };
}

function normalizeMessage(message) {
  if (!message || typeof message !== "object" || Array.isArray(message)) return message;
  const normalized = { ...message };
  if (Object.hasOwn(message, "method")) normalized.method = normalizeHttpMethod(message.method);
  if (Object.hasOwn(message, "url")) normalized.url = normalizeCaptureUrl(message.url);
  return normalized;
}

function endpointParts(value) {
  if (!value) return { host: "", path: "" };
  const text = String(value);
  if (text.startsWith("/")) return { host: "", path: text };
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) return { host: "", path: "" };
  try {
    const parsed = new URL(text);
    return { host: parsed.host, path: `${parsed.pathname}${parsed.search}` };
  } catch {
    return { host: "", path: "" };
  }
}

module.exports = {
  firstCaptureLine,
  normalizeCaptureUrl,
  normalizeCapturedEvent,
  normalizeHttpMethod,
  splitCaptureLines
};
