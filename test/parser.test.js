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

test("decodes an ndjson response without capturing unified-log metadata", () => {
  const parser = new MobileNetworkParser();
  const responseMessage = [
    "===== RESPONSE =====",
    "Status Code: 200",
    "URL: https://example.com/api/v1/announcements",
    "Body:",
    '{"body":{"data":[{"id":58,"title":"rtyrt"}]}}',
    "======================"
  ].join("\n");

  const actions = collect(parser, [
    JSON.stringify({
      eventMessage: responseMessage,
      processImageUUID: "DA30BF70-974C-3829-9762-63D062A1EDCA",
      traceID: 102097763705553412,
      processID: 14528
    })
  ]);

  const finalEvent = actions.filter((action) => action.type === "upsert").at(-1).event;
  assert.deepEqual(JSON.parse(finalEvent.response.body), {
    body: { data: [{ id: 58, title: "rtyrt" }] }
  });
  assert.doesNotMatch(finalEvent.response.body, /processImageUUID|traceID|processID/);
  assert.doesNotMatch(finalEvent.response.body, /\\\"body\\\"/);
});

test("splits a multiline eventMessage before parsing request fields", () => {
  const parser = new MobileNetworkParser();
  const actions = collect(parser, [
    JSON.stringify({
      eventMessage: [
        "===== REQUEST =====",
        "URL: https://example.com/api/v1/announcements",
        "Method: PUT",
        "Headers:",
        "  Authorization: Bearer parser-secret",
        "Body:",
        '{"title":"Updated"}',
        "===================="
      ].join("\n")
    })
  ]);

  const event = actions.filter((action) => action.type === "upsert").at(-1).event;
  assert.equal(event.method, "PUT");
  assert.equal(event.url, "https://example.com/api/v1/announcements");
  assert.equal(event.request.headers.Authorization, "Bearer parser-secret");
  assert.equal(event.request.body, '{"title":"Updated"}');
  assert.doesNotMatch(event.method, /Headers|Bearer|\n/);
});

test("splits literal escaped newlines from unified-log event messages", () => {
  const parser = new MobileNetworkParser();
  const actions = collect(parser, [
    JSON.stringify({
      eventMessage: [
        "===== REQUEST =====",
        String.raw`URL: https:\/\/example.com/api/v1/announcements/32`,
        "Method: GET",
        "Headers:",
        "  Authorization: Bearer parser-secret",
        "Body:",
        '{"note":"first\\\\nsecond"}',
        "===================="
      ].join("\\n")
    })
  ]);

  const event = actions.filter((action) => action.type === "upsert").at(-1).event;
  assert.equal(event.method, "GET");
  assert.equal(event.url, "https://example.com/api/v1/announcements/32");
  assert.equal(event.path, "/api/v1/announcements/32");
  assert.equal(event.request.headers.Authorization, "Bearer parser-secret");
  assert.equal(event.request.body, '{"note":"first\\\\nsecond"}');
});

test("finalizes the last response when a JSON log line suffixes its separator", () => {
  const parser = new MobileNetworkParser();
  const requestLine = `"eventMessage" : "${[
    "===== REQUEST =====",
    "URL: https:\\/\\/example.com/api/v1/announcements",
    "Method: GET",
    "===================="
  ].join("\\n")}",`;
  const responseLine = `"eventMessage" : "${[
    "===== RESPONSE =====",
    "Status Code: 200",
    "URL: https:\\/\\/example.com/api/v1/announcements",
    "Body:",
    '{"data":[]}',
    "======================"
  ].join("\\n")}",`;

  const requestActions = parser.pushLine(requestLine);
  const responseActions = parser.pushLine(responseLine);
  const event = responseActions.filter((action) => action.type === "upsert").at(-1)?.event;

  assert.equal(requestActions.filter((action) => action.type === "upsert").length, 1);
  assert.ok(event, "the final response must upsert without waiting for another API block");
  assert.equal(event.statusCode, 200);
  assert.equal(event.state, "success");
  assert.equal(event.response.body, '{"data":[]}');
});

test("quiet flush finalizes an unterminated final response block", () => {
  const parser = new MobileNetworkParser();
  parser.pushLine("===== RESPONSE =====");
  parser.pushLine("Status Code: 204");
  parser.pushLine("URL: https://example.com/api/v1/ping");

  const event = parser.flush().filter((action) => action.type === "upsert").at(-1)?.event;
  assert.ok(event);
  assert.equal(event.statusCode, 204);
  assert.equal(event.state, "success");
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
