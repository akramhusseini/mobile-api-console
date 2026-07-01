"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

// Static manifest test. Body capture depends on `page-inject.js` running in
// the page's MAIN world so it can patch fetch/XMLHttpRequest. A DOM-inserted
// `<script src="chrome-extension://...">` is vulnerable to strict site CSP,
// which leaves only the webRequest fallback and no bodies. Keep the patch as
// a real MAIN-world content script instead.

const MANIFEST_PATH = path.join(__dirname, "..", "extension", "manifest.json");
const PAGE_INJECT_PATH = path.join(__dirname, "..", "extension", "page-inject.js");

function loadManifest() {
  return JSON.parse(fs.readFileSync(MANIFEST_PATH, "utf8"));
}

test("manifest.json is valid JSON with manifest_version 3", () => {
  const manifest = loadManifest();
  assert.equal(manifest.manifest_version, 3);
});

test("manifest registers page-inject.js as a MAIN-world content script", () => {
  const manifest = loadManifest();
  const scripts = manifest.content_scripts || [];
  const pageInject = scripts.find((entry) => (entry.js || []).includes("page-inject.js"));
  assert.ok(pageInject, "page-inject.js must be loaded by the manifest");
  assert.ok(
    Array.isArray(pageInject.matches) && pageInject.matches.includes("<all_urls>"),
    "page-inject.js must match the same granted pages as the bridge content script"
  );
  assert.equal(pageInject.run_at, "document_start");
  assert.equal(pageInject.world, "MAIN", "page-inject.js must run in MAIN world to patch page fetch/XHR");
  assert.equal(pageInject.all_frames, false, "Phase 1 captures only the top frame");
});

test("manifest keeps content.js as the isolated bridge script", () => {
  const manifest = loadManifest();
  const scripts = manifest.content_scripts || [];
  const bridge = scripts.find((entry) => (entry.js || []).includes("content.js"));
  assert.ok(bridge, "content.js bridge must be loaded by the manifest");
  assert.ok(
    Array.isArray(bridge.matches) && bridge.matches.includes("<all_urls>"),
    "content.js must match the same granted pages as the page patch"
  );
  assert.equal(bridge.run_at, "document_start");
  assert.notEqual(bridge.world, "MAIN", "content.js needs the isolated extension world for chrome.runtime");
});

test("page-inject.js exists on disk (not just declared)", () => {
  // Catch the case where someone removes the file but leaves the WAR
  // entry, or vice versa.
  assert.ok(fs.existsSync(PAGE_INJECT_PATH), "extension/page-inject.js must exist");
  const src = fs.readFileSync(PAGE_INJECT_PATH, "utf8");
  // Sanity: the file is the page-world patch (patches fetch + XHR).
  assert.match(src, /window\.fetch\s*=/, "page-inject.js must patch window.fetch");
  assert.match(src, /XMLHttpRequest\.prototype\.send/);
});

test("content.js does not inject page-inject.js with a DOM script tag", () => {
  const contentSrc = fs.readFileSync(path.join(__dirname, "..", "extension", "content.js"), "utf8");
  assert.doesNotMatch(
    contentSrc,
    /createElement\(\s*["']script["']\s*\)/,
    "DOM script injection is CSP-sensitive; page-inject.js belongs in manifest.content_scripts with world MAIN"
  );
  assert.doesNotMatch(
    contentSrc,
    /chrome\.runtime\.getURL\(\s*["']page-inject\.js["']\s*\)/,
    "content.js should not load page-inject.js as a web-accessible resource"
  );
});

test("manifest declares the permissions needed for the page-script + webRequest flow", () => {
  const manifest = loadManifest();
  assert.ok(Array.isArray(manifest.permissions), "permissions must be an array");
  assert.ok(manifest.permissions.includes("storage"), "storage permission required for config/profileId");
  assert.ok(manifest.permissions.includes("webRequest"), "webRequest permission required for the fallback path");

  // host_permissions must cover the console transport.
  const host = manifest.host_permissions || [];
  assert.ok(
    host.some((p) => p.startsWith("http://localhost/")),
    "host_permissions must cover http://localhost/* (the console transport)"
  );
});
