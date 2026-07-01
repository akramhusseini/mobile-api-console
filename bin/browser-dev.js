#!/usr/bin/env node
"use strict";

// Thin CLI wrapper around bin/browser-dev-helper.js.
//
// The helper is pure logic; this file does filesystem I/O and process
// spawning. Anything that is testable in isolation lives in the
// helper.
//
// Usage:
//   bin/browser-dev --target http://localhost:3000/* \
//                   [--request http://localhost:3000/api/*] \
//                   [--port 3957] [--browser brave|chrome|edge] \
//                   [--profile <dir>] [--no-start] [--dry-run] \
//                   [--config <path>] [--repo <path>]
//
// Equivalent npm script:
//   npm run browser:dev -- --target http://localhost:3000/*

const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

const helper = require("./browser-dev-helper");

const USAGE = `\
Usage: bin/browser-dev [options]

Options:
  --target <pattern>     Page URL pattern to capture (repeatable; required
                         unless ~/.mobile-api-console.json already lists
                         browser.targetUrls)
  --request <pattern>    Optional API host URL pattern (repeatable)
  --port <port>          Console port (default ${helper.DEFAULT_PORT})
  --browser <name>       brave | chrome | edge (default: auto-detect)
  --profile <dir>        Temp browser profile directory
                         (default ${helper.DEFAULT_PROFILE_DIR})
  --no-start             Don't spawn the console (use when it's already running)
  --dry-run              Print the plan and exit, no writes, no spawns
  --config <path>        Override the user config file location
  --repo <path>          Override the repo root (where ./extension lives)
  -h, --help             Show this help

Examples:
  bin/browser-dev --target http://localhost:3000/*
  bin/browser-dev --target http://localhost:3000/* --request http://localhost:3000/api/*
  bin/browser-dev --target http://localhost:3000/* --browser chrome --port 4000
`;

function main() {
  let args;
  try {
    args = helper.parseArgs(process.argv.slice(2));
  } catch (err) {
    process.stderr.write(`Error: ${err.message}\n\n${USAGE}`);
    process.exit(2);
  }

  if (args.help) {
    process.stdout.write(USAGE);
    process.exit(0);
  }

  // Read existing config (raw text) so we can hand it to the pure
  // helper. The helper does the actual parse/merge.
  const configPath = args.configPath || helper.DEFAULT_CONFIG_PATH;
  let existingText = "";
  try {
    existingText = fs.readFileSync(configPath, "utf8");
  } catch (err) {
    if (err.code !== "ENOENT") {
      process.stderr.write(`Error: could not read ${configPath}: ${err.message}\n`);
      process.exit(2);
    }
  }

  const plan = helper.buildPlan({
    target: args.target,
    request: args.request,
    port: args.port,
    browser: args.browser,
    profile: args.profile,
    noStart: args.noStart,
    dryRun: args.dryRun,
    configPath,
    repoRoot: args.repoRoot,
    platform: process.platform,
    existingConfigText: existingText,
    probe: (p) => {
      try { return fs.existsSync(p); } catch { return false; }
    }
  });

  if (plan.errors.length > 0) {
    process.stderr.write("Cannot proceed:\n");
    for (const e of plan.errors) process.stderr.write(`  - ${e}\n`);
    process.stderr.write(`\n${USAGE}`);
    process.exit(2);
  }

  process.stdout.write(helper.formatPlan(plan) + "\n");

  if (args.dryRun) {
    process.stdout.write("\nDRY-RUN: exiting without writing or spawning.\n");
    process.exit(0);
  }

  // 1. Write ~/.mobile-api-console.json (merged).
  try {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify(plan.mergedConfig, null, 2) + "\n");
    process.stdout.write(`Wrote ${configPath}\n`);
  } catch (err) {
    process.stderr.write(`Error: could not write ${configPath}: ${err.message}\n`);
    process.exit(2);
  }

  // 2. Spawn the console unless --no-start.
  let consoleChild = null;
  if (!args.noStart) {
    const cwd = plan.repoRoot;
    process.stdout.write(`Starting console: ${plan.consoleCommand.join(" ")}\n`);
    // If the user pointed --config at a non-default path, the spawned
    // console must load the same file or it will not see the merge we
    // just performed. MOBILE_API_CONSOLE_CONFIG is the env var
    // src/config.js honors for this.
    const consoleEnv = {
      ...process.env,
      MOBILE_API_CONSOLE_PORT: String(args.port)
    };
    if (configPath !== helper.DEFAULT_CONFIG_PATH) {
      consoleEnv.MOBILE_API_CONSOLE_CONFIG = configPath;
    }
    consoleChild = spawn(plan.consoleCommand[0], plan.consoleCommand.slice(1), {
      cwd,
      stdio: "inherit",
      env: consoleEnv
    });
    consoleChild.on("error", (err) => {
      process.stderr.write(`Console failed to start: ${err.message}\n`);
      process.exit(1);
    });
  } else {
    process.stdout.write("Skipping console start (--no-start).\n");
  }

  // 3. Launch the browser.
  if (plan.browserCommand) {
    // Make sure the temp profile dir exists; --user-data-dir is happy
    // with a missing path but other Chrome startup logic prefers one.
    try { fs.mkdirSync(args.profile, { recursive: true }); } catch {}

    process.stdout.write(`Launching browser: ${plan.browserCommand.join(" ")}\n`);
    const browserChild = spawn(plan.browserCommand[0], plan.browserCommand.slice(1), {
      stdio: "ignore",
      detached: true
    });
    browserChild.on("error", (err) => {
      process.stderr.write(`Browser failed to launch: ${err.message}\n`);
      process.exit(1);
    });
    browserChild.unref();
  }

  // Wait briefly so the user sees the "next steps" output before
  // child stdio takes over the terminal. In a real run, the
  // process should keep running as long as the console does.
  if (consoleChild) {
    consoleChild.on("exit", (code) => process.exit(code ?? 0));
  } else {
    process.stdout.write("\nReminder: the console was already running — restart it if its config changed.\n");
  }
}

main();
