"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const helper = require("../bin/browser-dev-helper");
const {
  parseArgs,
  pickBrowser,
  mergeConfig,
  needsTarget,
  buildPlan,
  formatPlan,
  KNOWN_BROWSERS,
  DEFAULT_PROFILE_DIR,
  DEFAULT_PORT
} = helper;

// -----------------------------------------------------------------------------
// parseArgs
// -----------------------------------------------------------------------------

test("parseArgs: minimal --target produces sane defaults", () => {
  const a = parseArgs(["--target", "http://localhost:3000/*"]);
  assert.deepEqual(a.target, ["http://localhost:3000/*"]);
  assert.deepEqual(a.request, []);
  assert.equal(a.port, DEFAULT_PORT);
  assert.equal(a.profile, DEFAULT_PROFILE_DIR);
  assert.equal(a.browser, null);
  assert.equal(a.noStart, false);
  assert.equal(a.dryRun, false);
});

test("parseArgs: --target is repeatable", () => {
  const a = parseArgs([
    "--target", "http://a.example/*",
    "--target", "http://b.example/*"
  ]);
  assert.deepEqual(a.target, ["http://a.example/*", "http://b.example/*"]);
});

test("parseArgs: --request is repeatable and --target=, --request= forms work", () => {
  const a = parseArgs([
    "--target=http://localhost:3000/*",
    "--request=http://localhost:3000/api/*",
    "--request=http://localhost:3000/auth/*"
  ]);
  assert.deepEqual(a.target, ["http://localhost:3000/*"]);
  assert.deepEqual(a.request, ["http://localhost:3000/api/*", "http://localhost:3000/auth/*"]);
});

test("parseArgs: --port, --browser, --profile", () => {
  const a = parseArgs([
    "--target", "http://x/*",
    "--port", "4100",
    "--browser", "Chrome",
    "--profile", "/tmp/foo"
  ]);
  assert.equal(a.port, 4100);
  assert.equal(a.browser, "chrome", "--browser is lowercased");
  assert.equal(a.profile, "/tmp/foo");
});

test("parseArgs: --no-start and --dry-run are boolean flags", () => {
  const a = parseArgs(["--target", "x", "--no-start", "--dry-run"]);
  assert.equal(a.noStart, true);
  assert.equal(a.dryRun, true);
});

test("parseArgs: --config and --repo pass through", () => {
  const a = parseArgs(["--target", "x", "--config", "/tmp/c.json", "--repo", "/tmp/repo"]);
  assert.equal(a.configPath, "/tmp/c.json");
  assert.equal(a.repoRoot, "/tmp/repo");
});

test("parseArgs: rejects unknown --browser value", () => {
  assert.throws(() => parseArgs(["--target", "x", "--browser", "firefox"]), /Unknown --browser/);
});

test("parseArgs: rejects non-integer or out-of-range --port", () => {
  assert.throws(() => parseArgs(["--target", "x", "--port", "abc"]), /--port must be an integer/);
  assert.throws(() => parseArgs(["--target", "x", "--port", "99999"]), /Invalid --port/);
  assert.throws(() => parseArgs(["--target", "x", "--port", "0"]), /Invalid --port/);
});

test("parseArgs: rejects unknown positional args", () => {
  assert.throws(() => parseArgs(["--target", "x", "--bogus", "1"]), /Unknown argument/);
});

test("parseArgs: rejects --target without value", () => {
  assert.throws(() => parseArgs(["--target"]), /Missing value/);
});

// -----------------------------------------------------------------------------
// pickBrowser
// -----------------------------------------------------------------------------

test("pickBrowser: returns null when no candidate exists", () => {
  const got = pickBrowser({ requested: null, platform: "darwin", probe: () => false });
  assert.equal(got, null);
});

test("pickBrowser: returns first match in default order (Brave before Chrome)", () => {
  const calls = [];
  const got = pickBrowser({
    requested: null,
    platform: "darwin",
    probe: (p) => { calls.push(p); return p.includes("Brave"); }
  });
  assert.ok(got, "expected a match");
  assert.equal(got.name, "brave");
  // Probe order should match the candidate list, not be re-ordered.
  assert.equal(calls[0], helper.DEFAULT_BROWSER_CANDIDATES.darwin[0].path);
});

test("pickBrowser: --browser chrome narrows to chrome candidates", () => {
  const probed = [];
  const got = pickBrowser({
    requested: "chrome",
    platform: "darwin",
    probe: (p) => { probed.push(p); return p.includes("Chrome"); }
  });
  assert.ok(got);
  assert.equal(got.name, "chrome");
  // Must not have probed Brave.
  assert.ok(probed.every((p) => !p.includes("Brave")), "should not probe Brave when --browser chrome");
});

test("pickBrowser: --browser edge returns null when only brave/chrome exist", () => {
  const got = pickBrowser({
    requested: "edge",
    platform: "darwin",
    probe: (p) => p.includes("Brave") || p.includes("Chrome")
  });
  assert.equal(got, null);
});

test("pickBrowser: KNOWN_BROWSERS is [brave, chrome, edge]", () => {
  assert.deepEqual(KNOWN_BROWSERS, ["brave", "chrome", "edge"]);
});

// -----------------------------------------------------------------------------
// mergeConfig
// -----------------------------------------------------------------------------

test("mergeConfig: empty existing + new target produces a valid config", () => {
  const merged = mergeConfig({}, {
    targetUrls: ["http://localhost:3000/*"],
    requestUrls: ["http://localhost:3000/api/*"]
  });
  assert.equal(merged.browser.enabled, true);
  assert.deepEqual(merged.browser.targetUrls, ["http://localhost:3000/*"]);
  assert.deepEqual(merged.browser.requestUrls, ["http://localhost:3000/api/*"]);
  assert.equal(merged.defaultSource, "browser");
});

test("mergeConfig: preserves unrelated keys (processName, android, etc.)", () => {
  const existing = {
    processName: "MyApp",
    subsystem: "com.example.app",
    android: { applicationId: "com.example.app", logTag: "API_CURL" }
  };
  const merged = mergeConfig(existing, { targetUrls: ["http://x/*"], requestUrls: [] });
  assert.equal(merged.processName, "MyApp");
  assert.equal(merged.subsystem, "com.example.app");
  assert.deepEqual(merged.android, existing.android);
  assert.equal(merged.browser.enabled, true);
});

test("mergeConfig: does not clobber an existing non-browser defaultSource", () => {
  const existing = { defaultSource: "ios" };
  const merged = mergeConfig(existing, { targetUrls: ["http://x/*"], requestUrls: [] });
  assert.equal(merged.defaultSource, "ios", "user-chosen defaultSource is preserved");
});

test("mergeConfig: leaves an existing defaultSource='browser' alone", () => {
  const existing = { defaultSource: "browser" };
  const merged = mergeConfig(existing, { targetUrls: ["http://x/*"], requestUrls: [] });
  assert.equal(merged.defaultSource, "browser");
});

test("mergeConfig: sets defaultSource='browser' when it was missing", () => {
  const merged = mergeConfig({}, { targetUrls: ["http://x/*"], requestUrls: [] });
  assert.equal(merged.defaultSource, "browser");
});

test("mergeConfig: reuses existing targetUrls when caller passed none", () => {
  const existing = { browser: { enabled: false, targetUrls: ["http://keep.example/*"], requestUrls: [] } };
  const merged = mergeConfig(existing, { targetUrls: [], requestUrls: [] });
  assert.deepEqual(merged.browser.targetUrls, ["http://keep.example/*"]);
  assert.equal(merged.browser.enabled, true, "enabled is forced on");
});

test("mergeConfig: caller-supplied targetUrls replace existing", () => {
  const existing = { browser: { enabled: true, targetUrls: ["http://old.example/*"], requestUrls: [] } };
  const merged = mergeConfig(existing, { targetUrls: ["http://new.example/*"], requestUrls: [] });
  assert.deepEqual(merged.browser.targetUrls, ["http://new.example/*"]);
});

test("mergeConfig: leaves existing requestUrls alone when caller passes none", () => {
  const existing = { browser: { enabled: true, targetUrls: [], requestUrls: ["http://keep-api.example/*"] } };
  const merged = mergeConfig(existing, { targetUrls: ["http://page/*"], requestUrls: [] });
  assert.deepEqual(merged.browser.requestUrls, ["http://keep-api.example/*"]);
});

test("mergeConfig: caller-supplied requestUrls replace existing", () => {
  const existing = { browser: { enabled: true, targetUrls: [], requestUrls: ["http://old-api.example/*"] } };
  const merged = mergeConfig(existing, { targetUrls: ["http://page/*"], requestUrls: ["http://new-api.example/*"] });
  assert.deepEqual(merged.browser.requestUrls, ["http://new-api.example/*"]);
});

test("mergeConfig: existing malformed browser is normalized", () => {
  const existing = { browser: "not-an-object" };
  const merged = mergeConfig(existing, { targetUrls: ["http://x/*"], requestUrls: [] });
  assert.equal(merged.browser.enabled, true);
  assert.deepEqual(merged.browser.targetUrls, ["http://x/*"]);
});

test("mergeConfig: null existing produces a clean object", () => {
  const merged = mergeConfig(null, { targetUrls: ["http://x/*"], requestUrls: [] });
  assert.equal(merged.browser.enabled, true);
  assert.equal(merged.defaultSource, "browser");
});

// -----------------------------------------------------------------------------
// needsTarget
// -----------------------------------------------------------------------------

test("needsTarget: empty list is true", () => {
  assert.equal(needsTarget({ browser: { targetUrls: [] } }), true);
});

test("needsTarget: missing browser.targetUrls is true", () => {
  assert.equal(needsTarget({ browser: {} }), true);
});

test("needsTarget: populated list is false", () => {
  assert.equal(needsTarget({ browser: { targetUrls: ["http://x/*"] } }), false);
});

// -----------------------------------------------------------------------------
// buildPlan
// -----------------------------------------------------------------------------

function withBraveAt(probePath) {
  return {
    requested: null,
    platform: "darwin",
    probe: (p) => p === probePath
  };
}

test("buildPlan: errors when --target is missing and config has no browser.targetUrls", () => {
  const plan = buildPlan({
    target: [],
    request: [],
    port: 3957,
    browser: null,
    profile: "/tmp/p",
    noStart: true,
    dryRun: true,
    configPath: "/tmp/c.json",
    repoRoot: "/tmp/repo",
    platform: "darwin",
    existingConfigText: "",
    probe: (p) => p.includes("Brave")
  });
  assert.ok(plan.errors.some((e) => /--target/.test(e)), "expected --target error");
});

test("buildPlan: succeeds when --target is given and Brave is present", () => {
  const plan = buildPlan({
    target: ["http://localhost:3000/*"],
    request: ["http://localhost:3000/api/*"],
    port: 4000,
    browser: null,
    profile: "/tmp/p",
    noStart: false,
    dryRun: false,
    configPath: "/tmp/c.json",
    repoRoot: "/tmp/repo",
    platform: "darwin",
    existingConfigText: "",
    probe: (p) => p.includes("Brave")
  });
  assert.equal(plan.errors.length, 0);
  assert.equal(plan.port, 4000);
  assert.equal(plan.browser.name, "brave");
  assert.ok(plan.browserCommand.includes("--load-extension=/tmp/repo/extension"));
  assert.ok(plan.browserCommand.includes("--disable-extensions-except=/tmp/repo/extension"));
  assert.ok(plan.browserCommand.some((a) => a.startsWith("--user-data-dir=/tmp/p")));
  assert.deepEqual(plan.consoleCommand, ["node", "server.js", "--port", "4000", "--source", "browser"]);
  assert.deepEqual(plan.targets, ["http://localhost:3000/*"]);
  assert.deepEqual(plan.requests, ["http://localhost:3000/api/*"]);
});

test("buildPlan: errors clearly when no browser is found", () => {
  const plan = buildPlan({
    target: ["http://x/*"],
    request: [],
    port: 3957,
    browser: null,
    profile: "/tmp/p",
    noStart: true,
    dryRun: true,
    configPath: "/tmp/c.json",
    repoRoot: "/tmp/repo",
    platform: "darwin",
    existingConfigText: "",
    probe: () => false
  });
  assert.ok(plan.errors.some((e) => /No supported browser/.test(e)), "expected browser-not-found error");
});

test("buildPlan: errors clearly when explicit --browser is missing", () => {
  const plan = buildPlan({
    target: ["http://x/*"],
    request: [],
    port: 3957,
    browser: "edge",
    profile: "/tmp/p",
    noStart: true,
    dryRun: true,
    configPath: "/tmp/c.json",
    repoRoot: "/tmp/repo",
    platform: "darwin",
    existingConfigText: "",
    probe: (p) => p.includes("Brave") || p.includes("Chrome")
  });
  assert.ok(plan.errors.some((e) => /Requested --browser edge not found/.test(e)));
});

test("buildPlan: skips --target requirement when existing config already lists browser.targetUrls", () => {
  const plan = buildPlan({
    target: [],
    request: [],
    port: 3957,
    browser: null,
    profile: "/tmp/p",
    noStart: true,
    dryRun: true,
    configPath: "/tmp/c.json",
    repoRoot: "/tmp/repo",
    platform: "darwin",
    existingConfigText: JSON.stringify({
      browser: { enabled: true, targetUrls: ["http://already-set.example/*"], requestUrls: [] }
    }),
    probe: (p) => p.includes("Brave")
  });
  assert.equal(plan.errors.length, 0);
  assert.deepEqual(plan.targets, ["http://already-set.example/*"]);
});

test("buildPlan: surfaces a clean error if existing config JSON is malformed", () => {
  const plan = buildPlan({
    target: ["http://x/*"],
    request: [],
    port: 3957,
    browser: null,
    profile: "/tmp/p",
    noStart: true,
    dryRun: true,
    configPath: "/tmp/c.json",
    repoRoot: "/tmp/repo",
    platform: "darwin",
    existingConfigText: "{ this is not valid json",
    probe: (p) => p.includes("Brave")
  });
  assert.ok(plan.errors.some((e) => /Could not parse existing config/.test(e)));
});

test("buildPlan: --no-start is reflected in the plan and no console command is needed for validation", () => {
  const plan = buildPlan({
    target: ["http://x/*"],
    request: [],
    port: 3957,
    browser: null,
    profile: "/tmp/p",
    noStart: true,
    dryRun: true,
    configPath: "/tmp/c.json",
    repoRoot: "/tmp/repo",
    platform: "darwin",
    existingConfigText: "",
    probe: (p) => p.includes("Brave")
  });
  assert.equal(plan.noStart, true);
  assert.equal(plan.dryRun, true);
});

// -----------------------------------------------------------------------------
// formatPlan
// -----------------------------------------------------------------------------

test("formatPlan: includes the plan fields and a next-steps reminder", () => {
  const plan = buildPlan({
    target: ["http://x/*"],
    request: ["http://x/api/*"],
    port: 4000,
    browser: null,
    profile: "/tmp/p",
    noStart: true,
    dryRun: true,
    configPath: "/tmp/c.json",
    repoRoot: "/tmp/repo",
    platform: "darwin",
    existingConfigText: "",
    probe: (p) => p.includes("Brave")
  });
  const out = formatPlan(plan);
  assert.match(out, /Mobile API Console — browser-capture dev helper/);
  assert.match(out, /console port:  4000/);
  assert.match(out, /target URLs:   http:\/\/x\/\*/);
  assert.match(out, /request URLs:  http:\/\/x\/api\/\*/);
  assert.match(out, /DRY-RUN/);
  assert.match(out, /Next steps for you:/);
  assert.match(out, /native host-permission prompt/);
});
