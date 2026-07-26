"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

test("malformed method text cannot expand request rows or the detail header", () => {
  const css = fs.readFileSync(path.join(__dirname, "..", "public", "styles.css"), "utf8");
  const sharedBadgeRule = css.match(/\.method-badge,\s*\.status-badge\s*\{([^}]+)\}/s)?.[1] || "";
  const requestBadgeRule = css.match(/\.request-row \.method-badge\s*\{([^}]+)\}/s)?.[1] || "";

  assert.match(sharedBadgeRule, /max-width:\s*96px/);
  assert.match(sharedBadgeRule, /overflow:\s*hidden/);
  assert.match(sharedBadgeRule, /text-overflow:\s*ellipsis/);
  assert.match(sharedBadgeRule, /white-space:\s*nowrap/);
  assert.match(requestBadgeRule, /max-width:\s*56px/);
  assert.match(requestBadgeRule, /min-width:\s*0/);
});
