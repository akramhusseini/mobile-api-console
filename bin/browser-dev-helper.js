"use strict";

// Pure logic for `bin/browser-dev`. Kept side-effect-free so the
// unit tests can exercise arg parsing, config merging, and the dry-run
// plan without touching the filesystem or spawning processes.
//
// The CLI in `bin/browser-dev.js` is a thin wrapper that:
//   1. reads/writes ~/.mobile-api-console.json via fs,
//   2. spawns the console,
//   3. spawns the browser,
//   4. prints the plan / next-step reminder.
//
// All of those side-effects are described here as data (a "plan")
// so the tests can verify them.

const path = require("node:path");
const os = require("node:os");

const KNOWN_BROWSERS = ["brave", "chrome", "edge"];

// Default profile location; ~/.cache would be more XDG-friendly on
// Linux, but `/tmp` is the simplest cross-platform default and matches
// what the smoke test in this repo already uses.
const DEFAULT_PROFILE_DIR = "/tmp/mobile-api-console-browser-profile";
const DEFAULT_PORT = 3957;
const DEFAULT_CONFIG_PATH = path.join(os.homedir(), ".mobile-api-console.json");

const DEFAULT_BROWSER_CANDIDATES = {
  darwin: [
    { name: "brave", path: "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser" },
    { name: "chrome", path: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" },
    { name: "edge", path: "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge" }
  ],
  linux: [
    { name: "chrome", path: "/usr/bin/google-chrome" },
    { name: "chrome", path: "/usr/bin/google-chrome-stable" },
    { name: "brave", path: "/usr/bin/brave-browser" },
    { name: "edge", path: "/usr/bin/microsoft-edge" }
  ],
  win32: [
    // Best-effort default; users typically pass --browser explicitly on
    // Windows. Real lookup left to the CLI on win32.
    { name: "chrome", path: "C:/Program Files/Google/Chrome/Application/chrome.exe" },
    { name: "brave", path: "C:/Program Files/BraveSoftware/Brave-Browser/Application/brave.exe" },
    { name: "edge", path: "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe" }
  ]
};

// -----------------------------------------------------------------------------
// Arg parsing
// -----------------------------------------------------------------------------

// Parse `process.argv`-style args into a plan inputs object. We don't
// use a third-party parser; the surface area is small and the
// semantics need to be explicit (e.g. --target repeatable, --no-start
// is a boolean).
function parseArgs(argv) {
  const out = {
    target: [],
    request: [],
    port: DEFAULT_PORT,
    browser: null,        // null = auto-detect
    profile: DEFAULT_PROFILE_DIR,
    noStart: false,
    dryRun: false,
    configPath: null,     // null = use DEFAULT_CONFIG_PATH
    repoRoot: null        // null = derive from caller
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--no-start") { out.noStart = true; continue; }
    if (arg === "--dry-run") { out.dryRun = true; continue; }
    if (arg === "--help" || arg === "-h") { out.help = true; continue; }

    const take = (name) => {
      const value = argv[i + 1];
      if (value === undefined) throw new Error(`Missing value for ${name}`);
      i += 1;
      return value;
    };

    if (arg === "--target") out.target.push(take("--target"));
    else if (arg === "--request") out.request.push(take("--request"));
    else if (arg === "--port") out.port = parsePort(take("--port"));
    else if (arg === "--browser") out.browser = take("--browser").toLowerCase();
    else if (arg === "--profile") out.profile = take("--profile");
    else if (arg === "--config") out.configPath = take("--config");
    else if (arg === "--repo") out.repoRoot = take("--repo");
    else if (arg.startsWith("--target=")) out.target.push(arg.slice("--target=".length));
    else if (arg.startsWith("--request=")) out.request.push(arg.slice("--request=".length));
    else if (arg.startsWith("--port=")) out.port = parsePort(arg.slice("--port=".length));
    else if (arg.startsWith("--browser=")) out.browser = arg.slice("--browser=".length).toLowerCase();
    else if (arg.startsWith("--profile=")) out.profile = arg.slice("--profile=".length);
    else if (arg.startsWith("--config=")) out.configPath = arg.slice("--config=".length);
    else if (arg.startsWith("--repo=")) out.repoRoot = arg.slice("--repo=".length);
    else throw new Error(`Unknown argument: ${arg}`);
  }

  if (out.browser && !KNOWN_BROWSERS.includes(out.browser)) {
    throw new Error(`Unknown --browser value: ${out.browser} (expected one of: ${KNOWN_BROWSERS.join(", ")})`);
  }
  if (!Number.isInteger(out.port) || out.port < 1 || out.port > 65535) {
    throw new Error(`Invalid --port value: ${out.port}`);
  }
  return out;
}

function parsePort(raw) {
  const n = Number.parseInt(raw, 10);
  if (!Number.isInteger(n)) throw new Error(`--port must be an integer (got ${raw})`);
  return n;
}

// -----------------------------------------------------------------------------
// Browser detection
// -----------------------------------------------------------------------------

// Pick a browser binary path given the requested name (or null for
// "auto-detect") and a list of available browsers (probe result).
// Returns `{ name, path }` or `null` if none of the requested/known
// binaries are present.
//
// On macOS the typical install locations are probed by default; the
// caller can override with `--browser <name>`. The `probe` callback is
// `fs.existsSync` in production and a stub in tests.
function pickBrowser({ requested, platform, probe }) {
  const list = DEFAULT_BROWSER_CANDIDATES[platform] || [];
  const order = requested
    ? list.filter((b) => b.name === requested)
    : list;
  for (const candidate of order) {
    if (probe(candidate.path)) return { name: candidate.name, path: candidate.path };
  }
  return null;
}

// -----------------------------------------------------------------------------
// Config merge
// -----------------------------------------------------------------------------

// Merge new browser-capture values into an existing config object. The
// existing object is mutated and returned. The merge is intentionally
// narrow: we only touch the keys the helper owns. Any other field the
// user has set (processName, simulator, android, etc.) is preserved.
//
// Rules:
//   - browser.enabled becomes true.
//   - browser.targetUrls is REPLACED with the new list (or the
//     existing list if none was provided and the existing list is
//     non-empty). This matches the helper's "required unless already
//     configured" semantics for --target.
//   - browser.requestUrls is REPLACED with the new list. If the caller
//     didn't pass any --request flags we leave the existing list
//     alone so a follow-up run that only updates --target doesn't
//     clobber a previously-granted request URL allowlist.
//   - defaultSource becomes "browser" only if it was unset or already
//     "browser". Any other value (e.g. "ios") is left alone, because
//     the user may have intentionally set it.
function mergeConfig(existing, { targetUrls, requestUrls }) {
  const base = (existing && typeof existing === "object" && !Array.isArray(existing))
    ? { ...existing }
    : {};
  const browser = (base.browser && typeof base.browser === "object" && !Array.isArray(base.browser))
    ? { ...base.browser }
    : {};
  const existingTargets = Array.isArray(browser.targetUrls) ? browser.targetUrls : [];
  const existingRequests = Array.isArray(browser.requestUrls) ? browser.requestUrls : [];

  browser.enabled = true;
  browser.targetUrls = (Array.isArray(targetUrls) && targetUrls.length > 0)
    ? targetUrls.slice()
    : existingTargets;
  browser.requestUrls = (Array.isArray(requestUrls) && requestUrls.length > 0)
    ? requestUrls.slice()
    : existingRequests;

  base.browser = browser;

  if (base.defaultSource === undefined || base.defaultSource === null) {
    base.defaultSource = "browser";
  } else if (base.defaultSource === "browser") {
    // already what we want, no-op
  } else {
    // User has set defaultSource to something else (e.g. "ios"). Leave it.
  }

  return base;
}

// Decide whether the merged config actually needs a new --target from
// the CLI. The helper accepts "required unless already configured" —
// that means: if the helper would end up with an empty targetUrls
// after merge, the caller must provide --target.
function needsTarget(merged) {
  const list = merged?.browser?.targetUrls;
  return !Array.isArray(list) || list.length === 0;
}

// -----------------------------------------------------------------------------
// Plan: turn inputs into a side-effect description
// -----------------------------------------------------------------------------

// Produce a plan describing what the CLI should do, without doing
// it. Tests assert against this; the CLI reads it and acts.
function buildPlan(input) {
  const errors = [];

  const configPath = input.configPath || DEFAULT_CONFIG_PATH;
  const repoRoot = input.repoRoot || process.cwd();
  const extensionDir = path.join(repoRoot, "extension");

  // Read the existing config (the CLI passes raw text; the helper is
  // content-agnostic about I/O so tests can stub it).
  let existing = {};
  if (input.existingConfigText && input.existingConfigText.trim()) {
    try {
      existing = JSON.parse(input.existingConfigText);
    } catch (err) {
      errors.push(`Could not parse existing config at ${configPath}: ${err.message}`);
    }
  }

  // If we already know the existing config has browser enabled and
  // we don't have new --target / --request overrides, that's fine.
  // Otherwise enforce "required unless already configured".
  const wouldMerge = mergeConfig(existing, {
    targetUrls: input.target,
    requestUrls: input.request
  });
  if (needsTarget(wouldMerge)) {
    errors.push("Missing required --target <pattern> (no existing browser.targetUrls in config).");
  }

  const browser = pickBrowser({
    requested: input.browser,
    platform: input.platform,
    probe: input.probe || (() => false)
  });
  if (!browser) {
    errors.push(
      input.browser
        ? `Requested --browser ${input.browser} not found in known install locations.`
        : "No supported browser found in known install locations. Pass --browser brave|chrome|edge explicitly."
    );
  }

  const consoleCommand = ["node", "server.js", "--port", String(input.port), "--source", "browser"];

  const browserCommand = browser ? [
    browser.path,
    `--user-data-dir=${input.profile}`,
    `--load-extension=${extensionDir}`,
    `--disable-extensions-except=${extensionDir}`,
    "--no-first-run",
    "--no-default-browser-check"
  ] : null;

  return {
    errors,
    configPath,
    repoRoot,
    extensionDir,
    mergedConfig: wouldMerge,
    consoleCommand,
    browser,
    browserCommand,
    noStart: input.noStart,
    dryRun: input.dryRun,
    profile: input.profile,
    port: input.port,
    targets: wouldMerge?.browser?.targetUrls || [],
    requests: wouldMerge?.browser?.requestUrls || []
  };
}

// -----------------------------------------------------------------------------
// Plan pretty-printer (used by the CLI and asserted on by tests)
// -----------------------------------------------------------------------------

function formatPlan(plan) {
  const lines = [];
  lines.push("Mobile API Console — browser-capture dev helper");
  lines.push("");
  lines.push(`  config:        ${plan.configPath}`);
  lines.push(`  extension:     ${plan.extensionDir}`);
  lines.push(`  console port:  ${plan.port}`);
  lines.push(`  browser:       ${plan.browser ? `${plan.browser.name} (${plan.browser.path})` : "<none found>"}`);
  lines.push(`  profile dir:   ${plan.profile}`);
  lines.push(`  target URLs:   ${plan.targets.join(", ") || "<none>"}`);
  lines.push(`  request URLs:  ${plan.requests.join(", ") || "<none>"}`);
  lines.push(`  start console: ${plan.noStart ? "no (--no-start)" : "yes"}`);
  lines.push("");
  if (plan.dryRun) {
    lines.push("DRY-RUN: no filesystem writes, no process spawns.");
  }
  if (plan.consoleCommand) {
    lines.push(`Would run: ${plan.consoleCommand.join(" ")}`);
  }
  if (plan.browserCommand) {
    lines.push(`Would launch: ${plan.browserCommand.join(" ")}`);
  }
  lines.push("");
  lines.push("Next steps for you:");
  lines.push("  1. Open the extension's Options page (right-click the icon → Options).");
  lines.push("  2. Paste the same target / request URL patterns and click Save.");
  lines.push("  3. Click Allow on the native host-permission prompt.");
  lines.push("  4. Load the target page; events should land in the Browser source.");
  return lines.join("\n");
}

module.exports = {
  parseArgs,
  pickBrowser,
  mergeConfig,
  needsTarget,
  buildPlan,
  formatPlan,
  KNOWN_BROWSERS,
  DEFAULT_PROFILE_DIR,
  DEFAULT_PORT,
  DEFAULT_CONFIG_PATH,
  DEFAULT_BROWSER_CANDIDATES
};
