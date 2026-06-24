"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { MobileNetworkParser } = require("../src/parsers/mobileNetworkParser");

function collect(parser, lines) {
  const actions = [];
  for (const line of lines) actions.push(...parser.pushLine(line));
  actions.push(...parser.finishActive());
  return actions;
}

test("groups request curl and response into one event", () => {
  const parser = new MobileNetworkParser();
  const actions = collect(parser, [
    "===== REQUEST =====",
    "URL: https://api.example.test/api/v1/schedule?day=3",
    "Method: GET",
    "Headers:",
    "  Accept: application/json",
    "====================",
    "===== CURL COMMAND =====",
    "curl -X GET \\",
    "  -H 'Accept: application/json' \\",
    "  'https://api.example.test/api/v1/schedule?day=3'",
    "===========================",
    "===== RESPONSE =====",
    "Status Code: 200",
    "URL: https://api.example.test/api/v1/schedule?day=3",
    "Headers:",
    "  Content-Type: application/json",
    "Body:",
    "{\"data\":[]}",
    "======================"
  ]);

  const upserts = actions.filter((action) => action.type === "upsert");
  const finalEvent = upserts[upserts.length - 1].event;

  assert.equal(finalEvent.method, "GET");
  assert.equal(finalEvent.statusCode, 200);
  assert.equal(finalEvent.state, "success");
  assert.equal(finalEvent.request.headers.Accept, "application/json");
  assert.equal(finalEvent.response.headers["Content-Type"], "application/json");
  assert.match(finalEvent.curl, /curl -X GET/);
});

test("marks http failures as error events", () => {
  const parser = new MobileNetworkParser();
  const actions = collect(parser, [
    "===== REQUEST =====",
    "URL: https://example.com/api/v1/attendance",
    "Method: POST",
    "====================",
    "===== RESPONSE =====",
    "Status Code: 422",
    "URL: https://example.com/api/v1/attendance",
    "Body:",
    "{\"message\":\"Invalid slot_id\"}",
    "======================"
  ]);

  const finalEvent = actions.filter((action) => action.type === "upsert").at(-1).event;
  assert.equal(finalEvent.state, "error");
  assert.equal(finalEvent.statusCode, 422);
  assert.equal(finalEvent.errors.length, 1);
});

test("emits clear action for clear markers", () => {
  const parser = new MobileNetworkParser();
  const actions = collect(parser, ["API_CONSOLE_CLEAR"]);
  assert.equal(actions[0].type, "clear");
});

test("extracts eventMessage from json log lines", () => {
  const parser = new MobileNetworkParser();
  const actions = collect(parser, [
    JSON.stringify({ eventMessage: "===== RESPONSE =====" }),
    JSON.stringify({ eventMessage: "Status Code: 200" }),
    JSON.stringify({ eventMessage: "URL: https://example.com/a" }),
    JSON.stringify({ eventMessage: "======================" })
  ]);

  const finalEvent = actions.filter((action) => action.type === "upsert").at(-1).event;
  assert.equal(finalEvent.statusCode, 200);
  assert.equal(finalEvent.url, "https://example.com/a");
});

test("unescapes Apple's octal escapes in compact stream output", () => {
  const parser = new MobileNetworkParser();
  const actions = collect(parser, [
    "===== CURL COMMAND =====",
    "curl -X GET \\134",
    "  -H 'Accept: application/json' \\134",
    "  'https://example.com/api/v1/profile/me'",
    "==========================="
  ]);

  const event = actions.filter((a) => a.type === "upsert").at(-1).event;
  assert.match(event.curl, /curl -X GET \\/);
  assert.doesNotMatch(event.curl, /\\134/);
});

test("extracts oslog lines from compact log text", () => {
  const parser = new MobileNetworkParser();
  const actions = collect(parser, [
    "2026-06-24 11:40:00 ExampleMobileApp[123:456] ===== RESPONSE =====",
    "Status Code: 200",
    "URL: https://example.com/api",
    "Body:",
    "{",
    "  \"ok\": true",
    "}",
    "======================"
  ]);

  const finalEvent = actions.filter((action) => action.type === "upsert").at(-1).event;
  assert.equal(finalEvent.response.body, "{\n  \"ok\": true\n}");
});
