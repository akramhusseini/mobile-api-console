"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { AndroidApiCurlParser, parseAndroidCurl } = require("../src/parsers/androidApiCurlParser");

function logcat(message, { pid = 12345, tid = 12346, level = "D", tag = "API_CURL", date = "06-24 15:32:11.123" } = {}) {
  return `${date} ${pid} ${tid} ${level} ${tag}: ${message}`;
}

function collect(parser, lines) {
  const actions = [];
  for (const line of lines) actions.push(...parser.pushLine(line));
  actions.push(...parser.flush());
  return actions;
}

test("groups summary line and multi-line curl into one event", () => {
  const parser = new AndroidApiCurlParser();
  const actions = collect(parser, [
    logcat("[200] GET v1/users (245ms)"),
    logcat("curl -X GET \\"),
    logcat("  -H 'Accept: application/json' \\"),
    logcat("  -H 'Authorization: Bearer abc' \\"),
    logcat("  'https://api.example.com/v1/users'")
  ]);

  const upserts = actions.filter((a) => a.type === "upsert");
  const final = upserts.at(-1).event;

  assert.equal(final.method, "GET");
  assert.equal(final.statusCode, 200);
  assert.equal(final.state, "success");
  assert.equal(final.url, "https://api.example.com/v1/users");
  assert.equal(final.host, "api.example.com");
  assert.equal(final.path, "/v1/users");
  assert.equal(final.request.headers.Accept, "application/json");
  assert.equal(final.request.headers.Authorization, "Bearer abc");
  assert.match(final.curl, /curl -X GET/);
  assert.ok(final.response, "expected event.response to be populated");
  assert.equal(final.response.statusCode, 200);
  assert.equal(final.response.url, "https://api.example.com/v1/users");
  assert.equal(final.response.meta.source, "android-api-curl");
});

test("the first upsert (right after summary) already carries id/method/status", () => {
  const parser = new AndroidApiCurlParser();
  const actions = parser.pushLine(logcat("[200] GET v1/users (5ms)"));

  const first = actions.find((a) => a.type === "upsert");
  assert.ok(first, "expected an immediate upsert on summary line");
  assert.equal(first.event.method, "GET");
  assert.equal(first.event.statusCode, 200);
  assert.match(first.event.id, /^android-\d+$/);
  assert.notEqual(first.event.id, "undefined");
});

test("captures multi-line [BODY] block into event.response.body", () => {
  const parser = new AndroidApiCurlParser();
  const actions = collect(parser, [
    logcat("[200] GET v1/users (10ms)"),
    logcat("curl -X GET 'https://api.example.com/v1/users'"),
    logcat("[BODY] {"),
    logcat("  \"data\": ["),
    logcat("    {\"id\": 1}"),
    logcat("  ]"),
    logcat("}")
  ]);

  const final = actions.filter((a) => a.type === "upsert").at(-1).event;
  assert.ok(final.response, "expected response populated");
  assert.equal(final.response.statusCode, 200);
  assert.match(final.response.body, /"data"/);
  assert.match(final.response.body, /"id": 1/);
});

test("[BODY] before next summary line still attaches to the right event", () => {
  const parser = new AndroidApiCurlParser();
  const actions = collect(parser, [
    logcat("[200] GET v1/a (5ms)"),
    logcat("curl -X GET 'https://api.example.com/v1/a'"),
    logcat("[BODY] {\"a\":1}"),
    logcat("[200] GET v1/b (5ms)"),
    logcat("curl -X GET 'https://api.example.com/v1/b'"),
    logcat("[BODY] {\"b\":2}")
  ]);

  const events = actions.filter((a) => a.type === "upsert").map((a) => a.event);
  const finalized = events.filter((e) => e.response && e.response.body);
  assert.equal(finalized.length, 2);
  assert.equal(finalized[0].response.body, '{"a":1}');
  assert.equal(finalized[1].response.body, '{"b":2}');
  assert.equal(finalized[0].url, "https://api.example.com/v1/a");
  assert.equal(finalized[1].url, "https://api.example.com/v1/b");
});

test("missing [BODY] (e.g. blank response) leaves body empty without crashing", () => {
  const parser = new AndroidApiCurlParser();
  const actions = collect(parser, [
    logcat("[204] DELETE v1/items/1 (5ms)"),
    logcat("curl -X DELETE 'https://api.example.com/v1/items/1'")
  ]);

  const final = actions.filter((a) => a.type === "upsert").at(-1).event;
  assert.equal(final.response.body, "");
  assert.equal(final.response.statusCode, 204);
});

test("strips chunk continuation prefix on long bodies too", () => {
  const parser = new AndroidApiCurlParser();
  const actions = collect(parser, [
    logcat("[200] GET v1/big (10ms)"),
    logcat("curl -X GET 'https://api.example.com/v1/big'"),
    logcat("[BODY] {\"big\":\""),
    logcat("...continued body chunk"),
    logcat("\"}")
  ]);
  const final = actions.filter((a) => a.type === "upsert").at(-1).event;
  assert.match(final.response.body, /continued body chunk/);
  assert.doesNotMatch(final.response.body, /^\.{3}/m);
});

test("chunked continuation reassembles compact JSON without injecting fake newlines", () => {
  // Reproduces the /api/v1/profile/me case: a long compact JSON body that
  // logLongMessage split at 4000 chars *inside* a string literal. With the
  // previous parser, JSON.parse failed because we inserted a `\n` at the
  // boundary. The fix concatenates `...`-prefixed continuation lines onto
  // the previous line with no separator.
  const parser = new AndroidApiCurlParser();
  const head = `{"perms":["a","b","very_long_permission_name_that_will_get_split_in_the_middle`;
  const tail = `_at_chunk_boundary","c"]}`;
  const actions = collect(parser, [
    logcat("[200] GET v1/profile/me (10ms)"),
    logcat("curl -X GET 'https://api.example.com/v1/profile/me'"),
    logcat(`[BODY] ${head}`),
    logcat(`...${tail}`)
  ]);

  const final = actions.filter((a) => a.type === "upsert").at(-1).event;
  // The reassembled body must be valid JSON (no `\n` injected mid-string).
  const parsed = JSON.parse(final.response.body);
  assert.equal(parsed.perms[2], "very_long_permission_name_that_will_get_split_in_the_middle_at_chunk_boundary");
  assert.doesNotMatch(final.response.body, /middle\n_at_chunk/);
});

test("non-continuation lines (pretty JSON with real newlines) still join with newlines", () => {
  const parser = new AndroidApiCurlParser();
  const actions = collect(parser, [
    logcat("[200] GET v1/users (10ms)"),
    logcat("curl -X GET 'https://api.example.com/v1/users'"),
    logcat("[BODY] {"),
    logcat("  \"data\": ["),
    logcat("    {\"id\": 1}"),
    logcat("  ]"),
    logcat("}")
  ]);

  const final = actions.filter((a) => a.type === "upsert").at(-1).event;
  // Lines without `...` are independent source lines and stay separate.
  assert.match(final.response.body, /\n {2}"data": \[/);
  assert.equal(JSON.parse(final.response.body).data[0].id, 1);
});

test("marks 4xx responses as error events", () => {
  const parser = new AndroidApiCurlParser();
  const actions = collect(parser, [
    logcat("[404] POST messages (1.2s)"),
    logcat("curl -X POST \\"),
    logcat("  -H 'Content-Type: application/json' \\"),
    logcat("  -d '{\"text\":\"hi\"}' \\"),
    logcat("  'https://api.example.com/v1/messages'")
  ]);

  const final = actions.filter((a) => a.type === "upsert").at(-1).event;
  assert.equal(final.statusCode, 404);
  assert.equal(final.state, "error");
  assert.equal(final.method, "POST");
  assert.equal(final.request.body, '{"text":"hi"}');
});

test("marks ERR summaries as error events with null status", () => {
  const parser = new AndroidApiCurlParser();
  const actions = collect(parser, [
    logcat("[ERR] GET v1/schedule (45ms)"),
    logcat("curl -X GET \\"),
    logcat("  'https://api.example.com/v1/schedule'")
  ]);

  const final = actions.filter((a) => a.type === "upsert").at(-1).event;
  assert.equal(final.state, "error");
  assert.equal(final.statusCode, null);
  assert.ok(final.errors.length >= 1);
});

test("finalizes the previous event when a new summary arrives", () => {
  const parser = new AndroidApiCurlParser();
  const actions = collect(parser, [
    logcat("[200] GET v1/a (10ms)"),
    logcat("curl -X GET 'https://api.example.com/v1/a'"),
    logcat("[200] GET v1/b (12ms)"),
    logcat("curl -X GET 'https://api.example.com/v1/b'")
  ]);

  const events = actions.filter((a) => a.type === "upsert").map((a) => a.event);
  const finalized = events.filter((e) => e.curl);
  assert.equal(finalized.length, 2);
  assert.equal(finalized[0].url, "https://api.example.com/v1/a");
  assert.equal(finalized[1].url, "https://api.example.com/v1/b");
});

test("emits clear action for console clear markers", () => {
  const parser = new AndroidApiCurlParser();
  const actions = parser.pushLine(logcat("API_CONSOLE_CLEAR"));
  assert.equal(actions[0].type, "clear");
});

test("ignores lines from other tags", () => {
  const parser = new AndroidApiCurlParser();
  const actions = collect(parser, [
    logcat("[200] GET v1/users (5ms)", { tag: "SomeOtherTag" }),
    logcat("[200] GET v1/users (5ms)"),
    logcat("curl -X GET 'https://api.example.com/v1/users'")
  ]);

  const upserts = actions.filter((a) => a.type === "upsert");
  assert.equal(upserts.at(-1).event.url, "https://api.example.com/v1/users");
});

test("ignores logcat session marker lines", () => {
  const parser = new AndroidApiCurlParser();
  const actions = collect(parser, [
    "--------- beginning of main",
    logcat("[200] GET v1/users (5ms)"),
    logcat("curl -X GET 'https://api.example.com/v1/users'")
  ]);

  const upserts = actions.filter((a) => a.type === "upsert");
  assert.equal(upserts.at(-1).event.statusCode, 200);
});

test("strips chunk continuation prefix on long curls", () => {
  const parser = new AndroidApiCurlParser();
  const actions = collect(parser, [
    logcat("[200] POST v1/items (50ms)"),
    logcat("curl -X POST \\"),
    logcat("  -H 'X-Token: ABC' \\"),
    logcat("...continued chunk text"),
    logcat("  'https://api.example.com/v1/items'")
  ]);
  const final = actions.filter((a) => a.type === "upsert").at(-1).event;
  assert.match(final.curl, /continued chunk text/);
  assert.doesNotMatch(final.curl, /^\.{3}/m);
});

test("parseAndroidCurl extracts method/url/headers/body", () => {
  const command = [
    "curl -X POST \\",
    "  -H 'Content-Type: application/json' \\",
    "  -H 'Authorization: Bearer xyz' \\",
    "  -d '{\"a\":1}' \\",
    "  'https://api.example.com/v1/items'"
  ].join("\n");

  const parsed = parseAndroidCurl(command);
  assert.equal(parsed.method, "POST");
  assert.equal(parsed.url, "https://api.example.com/v1/items");
  assert.equal(parsed.headers["Content-Type"], "application/json");
  assert.equal(parsed.headers["Authorization"], "Bearer xyz");
  assert.equal(parsed.body, '{"a":1}');
});
