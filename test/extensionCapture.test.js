"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { createCaptureController } = require("../extension/capture-helper");

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function flush() {
  return new Promise((resolve) => setImmediate(resolve));
}

// A more thorough tick that runs the timer phase (where setTimeout(0)
// fires) before the check phase. In some Node.js environments, calling
// only setImmediate after scheduling a setTimeout(0) lets the immediate
// win — the helper's "completeDelayMs: 0" path needs the timer to fire
// before the test asserts.
function drainTimers() {
  return new Promise((resolve) => setTimeout(resolve, 5));
}

test("get-active-config handler resolves the config asynchronously and returns true", async () => {
  const expected = {
    consoleHost: "http://localhost:3957",
    targetUrls: ["https://app.example.com/*"],
    requestUrls: []
  };
  const controller = createCaptureController({
    getConfig: async () => expected,
    getProfileId: async () => "bprof_test",
    postEvent: async () => {}
  });

  const responseDeferred = deferred();
  const keepChannelOpen = controller.handleRuntimeMessage(
    { type: "get-active-config" },
    { tab: { id: 1 } },
    (response) => responseDeferred.resolve(response)
  );

  assert.equal(keepChannelOpen, true, "must return true so Chrome keeps the message channel open for async response");
  const response = await responseDeferred.promise;
  assert.deepEqual(response.config, expected);
});

test("get-active-config propagates errors as a null config rather than throwing", async () => {
  const controller = createCaptureController({
    getConfig: async () => { throw new Error("storage locked"); },
    getProfileId: async () => "bprof_test",
    postEvent: async () => {}
  });

  const responseDeferred = deferred();
  controller.handleRuntimeMessage(
    { type: "get-active-config" },
    { tab: { id: 1 } },
    (response) => responseDeferred.resolve(response)
  );

  const response = await responseDeferred.promise;
  assert.equal(response.config, null);
  assert.match(response.error, /storage locked/);
});

test("clear-browser-session resolves with the result from sendClearMarker", async () => {
  const controller = createCaptureController({
    getConfig: async () => ({}),
    getProfileId: async () => "bprof_test",
    postEvent: async () => {},
    sendClearMarker: async (browserSession) => ({ ok: true, cleared: true, session: { origin: browserSession.origin } })
  });

  const responseDeferred = deferred();
  const keepOpen = controller.handleRuntimeMessage(
    { type: "clear-browser-session", browserSession: { origin: "https://app.example.com", profileId: "bprof_test", context: "regular" } },
    { tab: { id: 1 } },
    (response) => responseDeferred.resolve(response)
  );

  assert.equal(keepOpen, true);
  const response = await responseDeferred.promise;
  assert.equal(response.ok, true);
  assert.equal(response.cleared, true);
});

test("page-script observation posts a complete-phase event with the page UUID preserved", async () => {
  const posts = [];
  const controller = createCaptureController({
    completeDelayMs: 0,
    getConfig: async () => ({}),
    getProfileId: async () => "bprof_test",
    postEvent: async (event) => {
      posts.push(event);
    }
  });

  await controller.handlePageScriptObservation(
    {
      eventId: "page-uuid-1",
      phase: "complete",
      request: {
        startedAt: 100, method: "GET", url: "https://app.example.com/v1/users",
        headers: { Accept: "application/json" }, body: null,
        bodyAvailable: true, bodyTruncated: false, bodyUnavailableReason: null
      },
      response: {
        completedAt: 150, durationMs: 50, status: 200,
        headers: { "Content-Type": "application/json" }, body: '{"ok":true}',
        bodyAvailable: true, bodyTruncated: false, bodyUnavailableReason: null
      },
      error: null,
      initiator: "https://app.example.com",
      pageUrl: "https://app.example.com/dashboard"
    },
    { tab: { id: 17 }, url: "https://app.example.com/dashboard", incognito: false }
  );

  // Let the scheduled post flush.
  await flush();

  // The request-phase observation is not posted; only the complete-phase post lands.
  const complete = posts.find((p) => p.phase === "complete");
  assert.ok(complete, "complete-phase post should be queued");
  assert.equal(complete.eventId, "page-uuid-1", "eventId from the page-world UUID must be preserved");
  assert.equal(complete.captureMode, "page-script");
  assert.equal(complete.browserSession.origin, "https://app.example.com");
  assert.equal(complete.browserSession.profileId, "bprof_test");
  assert.equal(complete.browserSession.context, "regular");
  assert.equal(complete.response.status, 200);
});

test("page-script request-phase posts immediately without waiting for complete", async () => {
  const posts = [];
  const controller = createCaptureController({
    getConfig: async () => ({}),
    getProfileId: async () => "bprof_test",
    postEvent: async (event) => { posts.push(event); }
  });

  await controller.handlePageScriptObservation(
    {
      eventId: "page-uuid-req",
      phase: "request",
      request: { startedAt: 100, method: "GET", url: "https://app.example.com/v1/x", headers: {}, body: null, bodyAvailable: true, bodyTruncated: false, bodyUnavailableReason: null },
      response: null,
      pageUrl: "https://app.example.com/"
    },
    { tab: { id: 1 }, url: "https://app.example.com/", incognito: false }
  );

  const requestPost = posts.find((p) => p.phase === "request");
  assert.ok(requestPost, "request-phase post must be sent immediately");
  assert.equal(requestPost.eventId, "page-uuid-req");
});

test("webRequest metadata merges into a pending page-script observation by tabId+method+URL", async () => {
  const posts = [];
  let pendingResolver;
  const postGate = new Promise((resolve) => { pendingResolver = resolve; });
  const controller = createCaptureController({
    getConfig: async () => ({}),
    getProfileId: async () => "bprof_test",
    postEvent: async (event) => {
      posts.push(event);
      if (event.phase === "complete") pendingResolver();
    }
  });

  // Page-script emits a "complete" observation first. This is queued for
  // a delayed post (so webRequest has a window to merge).
  await controller.handlePageScriptObservation(
    {
      eventId: "page-uuid-merge",
      phase: "complete",
      request: { startedAt: 100, method: "GET", url: "https://api.example.com/items", headers: { Accept: "application/json" }, body: null, bodyAvailable: true, bodyTruncated: false, bodyUnavailableReason: null },
      response: { completedAt: 150, durationMs: 50, status: 200, headers: { "X-Page": "yes" }, body: '{"items":[]}', bodyAvailable: true, bodyTruncated: false, bodyUnavailableReason: null },
      pageUrl: "https://app.example.com/dashboard"
    },
    { tab: { id: 17 }, url: "https://app.example.com/dashboard", incognito: false }
  );

  // webRequest arrives for the same tabId+method+URL with the response
  // headers the page script did not see.
  const merged = controller.attachWebRequestObservation(
    {
      tabId: 17,
      requestId: "12345",
      method: "GET",
      url: "https://api.example.com/items",
      statusCode: 200,
      timeStamp: 152,
      documentUrl: "https://app.example.com/dashboard",
      initiator: "https://app.example.com",
      responseHeaders: [
        { name: "Content-Type", value: "application/json" },
        { name: "X-Server", value: "edge-7" },
        { name: "Set-Cookie", value: "session=abc; Path=/" }
      ],
      incognito: false
    },
    { partial: false }
  );

  assert.equal(merged, true, "merge should be reported as applied");

  // Wait for the scheduled post to flush.
  await postGate;

  const complete = posts.find((p) => p.phase === "complete");
  assert.ok(complete, "complete-phase post should be present");
  assert.equal(complete.eventId, "page-uuid-merge", "page-script eventId must be preserved on merge");
  assert.equal(complete.captureMode, "merged", "merge should promote captureMode to 'merged'");
  assert.equal(complete.response.headers["X-Page"], "yes", "page-script headers must be preserved");
  assert.equal(complete.response.headers["Content-Type"], "application/json", "webRequest headers must be merged in");
  assert.equal(complete.response.headers["X-Server"], "edge-7");
  assert.equal(complete.response.headers["Set-Cookie"], undefined, "Set-Cookie must be stripped before sending");
  assert.equal(complete.metadata.webRequestId, "12345");
});

test("webRequest-only fallback derives origin from documentUrl when no page-script observation exists", async () => {
  const posts = [];
  let pendingResolver;
  const postGate = new Promise((resolve) => { pendingResolver = resolve; });
  const controller = createCaptureController({
    getConfig: async () => ({}),
    getProfileId: async () => "bprof_wronly",
    postEvent: async (event) => {
      posts.push(event);
      pendingResolver();
    }
  });

  const observed = controller.attachWebRequestObservation(
    {
      tabId: 42,
      requestId: "9999",
      method: "POST",
      url: "https://api.example.com/log",
      statusCode: 201,
      timeStamp: 5000,
      documentUrl: "https://app.example.com/page",
      initiator: "https://app.example.com",
      responseHeaders: [{ name: "X-Trace", value: "abc" }],
      incognito: false
    },
    { partial: false }
  );

  assert.equal(observed, true);
  // The webRequest-only fallback holds for the short merge window
  // (50ms) so the page-script request/complete phase can adopt it.
  // When nothing adopts it, the fallback posts itself.
  await postGate;

  assert.equal(posts.length, 1);
  const fallback = posts[0];
  assert.equal(fallback.captureMode, "web-request");
  assert.equal(fallback.eventId, "wr_9999");
  assert.equal(fallback.browserSession.origin, "https://app.example.com");
  assert.equal(fallback.browserSession.profileId, "bprof_wronly");
  assert.equal(fallback.response.status, 201);
  assert.equal(fallback.response.headers["X-Trace"], "abc");
  assert.equal(fallback.request.bodyUnavailableReason, "not-readable");
});

test("webRequest-only fallback derives origin from initiator when documentUrl is missing", async () => {
  const posts = [];
  let pendingResolver;
  const postGate = new Promise((resolve) => { pendingResolver = resolve; });
  const controller = createCaptureController({
    getConfig: async () => ({}),
    getProfileId: async () => "bprof_wronly",
    postEvent: async (event) => {
      posts.push(event);
      pendingResolver();
    }
  });

  controller.attachWebRequestObservation(
    {
      tabId: 7,
      requestId: "8888",
      method: "GET",
      url: "https://api.example.com/x",
      statusCode: 200,
      timeStamp: 1000,
      initiator: "https://app.example.com",
      incognito: true
    },
    { partial: false }
  );
  await postGate;

  assert.equal(posts.length, 1);
  assert.equal(posts[0].browserSession.origin, "https://app.example.com");
  assert.equal(posts[0].browserSession.context, "incognito");
});

test("webRequest-only fallback is dropped when no origin can be derived", async () => {
  const posts = [];
  const controller = createCaptureController({
    getConfig: async () => ({}),
    getProfileId: async () => "bprof_wronly",
    postEvent: async (event) => { posts.push(event); }
  });

  const observed = controller.attachWebRequestObservation(
    {
      tabId: 1,
      requestId: "7777",
      method: "GET",
      url: "https://api.example.com/x",
      statusCode: 200,
      timeStamp: 0,
      // No documentUrl, no initiator that looks like a URL.
      initiator: "null",
      incognito: false
    },
    { partial: false }
  );
  await new Promise((r) => setTimeout(r, 10));

  assert.equal(observed, false, "no derivable origin means we refuse to enqueue");
  assert.equal(posts.length, 0, "an unknown-origin event must never be posted");
});

test("webRequest error attaches to a pending page-script observation", async () => {
  const posts = [];
  const controller = createCaptureController({
    completeDelayMs: 0,
    getConfig: async () => ({}),
    getProfileId: async () => "bprof_test",
    postEvent: async (event) => { posts.push(event); }
  });

  await controller.handlePageScriptObservation(
    {
      eventId: "page-uuid-err",
      phase: "request",
      request: { startedAt: 100, method: "POST", url: "https://api.example.com/x", headers: {}, body: null, bodyAvailable: true, bodyTruncated: false, bodyUnavailableReason: null },
      response: null,
      pageUrl: "https://app.example.com/"
    },
    { tab: { id: 1 }, url: "https://app.example.com/", incognito: false }
  );

  controller.attachWebRequestError({
    tabId: 1,
    requestId: "abc",
    method: "POST",
    url: "https://api.example.com/x",
    error: "net::ERR_FAILED"
  });
  await flush();

  const errorEvent = posts.find((p) => p.error);
  assert.ok(errorEvent, "webRequest error should produce a post with an error");
  assert.equal(errorEvent.error, "net::ERR_FAILED");
  // We now have observations from both sources (page-script request +
  // webRequest error) so the merged mode is the honest label.
  assert.equal(errorEvent.captureMode, "merged");
});

test("onBeforeRequest-style webRequest events (no headers) still correlate with the page-script", async () => {
  // onBeforeRequest does not supply requestHeaders or responseHeaders.
  // It must still fire and let the helper merge against the page-script
  // observation by tabId+method+URL.
  const posts = [];
  const postGate = new Promise((resolve) => { setTimeout(resolve, 30); });
  const controller = createCaptureController({
    completeDelayMs: 0,
    getConfig: async () => ({}),
    getProfileId: async () => "bprof_test",
    postEvent: async (event) => { posts.push(event); }
  });

  await controller.handlePageScriptObservation(
    {
      eventId: "page-uuid-before",
      phase: "complete",
      request: { startedAt: 1, method: "GET", url: "https://app.example.com/v1/x", headers: { Accept: "*/*" }, body: null, bodyAvailable: true, bodyTruncated: false, bodyUnavailableReason: null },
      response: { completedAt: 5, durationMs: 4, status: 200, headers: { "Content-Type": "application/json" }, body: '{"ok":true}', bodyAvailable: true, bodyTruncated: false, bodyUnavailableReason: null },
      pageUrl: "https://app.example.com/dashboard"
    },
    { tab: { id: 9 }, url: "https://app.example.com/dashboard", incognito: false }
  );

  const merged = controller.attachWebRequestObservation(
    {
      tabId: 9,
      requestId: "no-headers",
      method: "GET",
      url: "https://app.example.com/v1/x",
      // intentionally no responseHeaders, no requestHeaders
      documentUrl: "https://app.example.com/dashboard",
      initiator: "https://app.example.com",
      incognito: false
    },
    { partial: false }
  );
  assert.equal(merged, true);

  await postGate;

  const complete = posts.find((p) => p.phase === "complete");
  assert.ok(complete, "complete-phase post should land");
  assert.equal(complete.eventId, "page-uuid-before", "page-script eventId must be preserved on headerless webRequest merge");
  assert.equal(complete.captureMode, "merged");
  assert.equal(complete.response.headers["Content-Type"], "application/json");
});

// ---------------------------------------------------------------------------
// Method / URL correlation regression tests.
//
// These cover the bug where a POST fetch would land in the console with
// top-level method: "GET" and produce a duplicate wr_* row. Root causes:
//   1. capture-helper derived method from `payload.request?.method || "GET"`
//      on the complete phase (where payload.request is null) instead of
//      looking up its own request phase by eventId.
//   2. page-inject emitted relative URLs while webRequest saw absolute
//      URLs, so the tabId+method+url key never matched.
//   3. browserEventParser defaulted missing request.method to "GET",
//      which the storage COALESCE happily overwrote a real prior POST
//      with on the complete-phase upsert.
// ---------------------------------------------------------------------------

test("page-script POST request phase + complete phase preserves top-level method POST", async () => {
  // The page-inject's complete-phase payload has request:null. The
  // helper must recover the POST and the absolute URL from the
  // request phase it stored earlier under the same eventId.
  const posts = [];
  const controller = createCaptureController({
    completeDelayMs: 0,
    getConfig: async () => ({}),
    getProfileId: async () => "bprof_test",
    postEvent: async (event) => { posts.push(event); }
  });

  // Request phase: POST with a body. URL is already absolute because
  // page-inject absolutizes relative URLs before emitting.
  await controller.handlePageScriptObservation(
    {
      eventId: "page-uuid-post",
      phase: "request",
      initiator: "https://app.example.com",
      request: {
        startedAt: 100, method: "POST", url: "https://app.example.com/v1/users",
        headers: { "Content-Type": "application/json" },
        body: '{"name":"x"}', bodyAvailable: true, bodyTruncated: false, bodyUnavailableReason: null
      },
      response: null, error: null,
      pageUrl: "https://app.example.com/dashboard"
    },
    { tab: { id: 17 }, url: "https://app.example.com/dashboard", incognito: false }
  );

  // Complete phase: same eventId, request:null, response carries the
  // body the page actually received. This is the shape the real
  // page-inject emits today.
  await controller.handlePageScriptObservation(
    {
      eventId: "page-uuid-post",
      phase: "complete",
      initiator: "https://app.example.com",
      request: null,
      response: {
        completedAt: 150, durationMs: 50, status: 201,
        url: "https://app.example.com/v1/users",
        headers: { "Content-Type": "application/json" },
        body: '{"id":1}', bodyAvailable: true, bodyTruncated: false, bodyUnavailableReason: null
      },
      error: null,
      pageUrl: "https://app.example.com/dashboard"
    },
    { tab: { id: 17 }, url: "https://app.example.com/dashboard", incognito: false }
  );

  await drainTimers();

  // Both phases must end up as a single event whose wire payload
  // preserves POST, the URL, the request body, and the response body.
  const complete = posts.find((p) => p.phase === "complete");
  assert.ok(complete, "complete-phase post must land");
  assert.equal(complete.eventId, "page-uuid-post");
  assert.equal(complete.request.method, "POST", "request.method must be POST after merge");
  assert.equal(complete.request.url, "https://app.example.com/v1/users", "request.url must be the absolute URL from the request phase");
  assert.equal(complete.request.body, '{"name":"x"}', "request body from request phase must survive");
  assert.equal(complete.response.status, 201);
  assert.equal(complete.response.body, '{"id":1}', "response body from complete phase must survive");

  // Exactly one row for this call (no separate "GET" complete row).
  const completePosts = posts.filter((p) => p.phase === "complete");
  assert.equal(completePosts.length, 1, "the two page-script phases must collapse into a single event");
});

test("relative URL fetch correlates with webRequest absolute URL via eventId migration", async () => {
  // Simulates the original bug: page-inject emits request phase with a
  // relative URL, webRequest comes in with the absolute URL, and then
  // the page-inject complete phase arrives. Without eventId-based
  // correlation the three pieces would split into two rows.
  const posts = [];
  const controller = createCaptureController({
    completeDelayMs: 0,
    getConfig: async () => ({}),
    getProfileId: async () => "bprof_test",
    postEvent: async (event) => { posts.push(event); }
  });

  // Request phase with relative URL — historical page-inject shape.
  // (The current code absolutizes first, but the helper must still
  // tolerate the relative-URL input to avoid regressing if a caller
  // forgets the absolutize step.)
  await controller.handlePageScriptObservation(
    {
      eventId: "page-uuid-rel",
      phase: "request",
      initiator: "https://app.example.com",
      request: {
        startedAt: 100, method: "POST", url: "/v1/users",
        headers: { "Content-Type": "application/json" },
        body: '{"a":1}', bodyAvailable: true, bodyTruncated: false, bodyUnavailableReason: null
      },
      response: null, error: null,
      pageUrl: "https://app.example.com/dashboard"
    },
    { tab: { id: 17 }, url: "https://app.example.com/dashboard", incognito: false }
  );

  // webRequest with the absolute URL.
  const merged = controller.attachWebRequestObservation(
    {
      tabId: 17, requestId: "12345", method: "POST", url: "https://app.example.com/v1/users",
      statusCode: 201, timeStamp: 150,
      documentUrl: "https://app.example.com/dashboard", initiator: "https://app.example.com",
      responseHeaders: [{ name: "X-Server", value: "edge-7" }],
      incognito: false
    },
    { partial: false }
  );
  assert.equal(merged, true, "webRequest must report merge into the page-script entry");

  // Complete phase with the same eventId, request:null, response.url
  // already absolute (browser native).
  await controller.handlePageScriptObservation(
    {
      eventId: "page-uuid-rel",
      phase: "complete",
      initiator: "https://app.example.com",
      request: null,
      response: {
        completedAt: 150, durationMs: 50, status: 201,
        url: "https://app.example.com/v1/users",
        headers: {}, body: '{"id":1}',
        bodyAvailable: true, bodyTruncated: false, bodyUnavailableReason: null
      },
      error: null,
      pageUrl: "https://app.example.com/dashboard"
    },
    { tab: { id: 17 }, url: "https://app.example.com/dashboard", incognito: false }
  );
  await drainTimers();

  // The merged event must carry the page-script's body, the
  // webRequest's response headers, and the absolute URL — and there
  // must be exactly one complete-phase post (no duplicate wr_* row).
  const complete = posts.find((p) => p.phase === "complete");
  assert.ok(complete, "complete-phase post must land");
  assert.equal(complete.eventId, "page-uuid-rel");
  assert.equal(complete.request.method, "POST", "POST must survive the relative→absolute URL migration");
  assert.equal(complete.request.url, "/v1/users", "request.url preserves the page-script's original URL until the merge normalizes it");
  assert.equal(complete.request.body, '{"a":1}');
  assert.equal(complete.response.status, 201);
  assert.equal(complete.response.body, '{"id":1}');
  assert.equal(complete.response.headers["X-Server"], "edge-7", "webRequest headers must merge in");
  assert.equal(complete.captureMode, "merged");
  assert.equal(posts.filter((p) => p.phase === "complete").length, 1, "no duplicate wr_* row");
});

test("webRequest fallback created before the page-script request phase is merged into the page-script eventId", async () => {
  // webRequest.onBeforeRequest can fire before the page-inject hook
  // runs (or before the page-script request observation is dispatched).
  // The helper must pick up that fallback entry by tabId+method+url
  // when the page-script request phase arrives, instead of producing
  // a separate wr_* row.
  const posts = [];
  const controller = createCaptureController({
    completeDelayMs: 0,
    getConfig: async () => ({}),
    getProfileId: async () => "bprof_test",
    postEvent: async (event) => { posts.push(event); }
  });

  // webRequest creates the fallback entry first.
  controller.attachWebRequestObservation(
    {
      tabId: 17, requestId: "9999", method: "POST", url: "https://app.example.com/v1/x",
      statusCode: 201, timeStamp: 100,
      documentUrl: "https://app.example.com/dashboard", initiator: "https://app.example.com",
      incognito: false
    },
    { partial: false }
  );
  await new Promise((r) => setTimeout(r, 5));

  // Page-script request phase arrives. Must adopt the webRequest
  // fallback instead of starting a new entry.
  await controller.handlePageScriptObservation(
    {
      eventId: "page-uuid-after-wr",
      phase: "request",
      initiator: "https://app.example.com",
      request: {
        startedAt: 100, method: "POST", url: "https://app.example.com/v1/x",
        headers: { "Content-Type": "application/json" },
        body: '{"k":"v"}', bodyAvailable: true, bodyTruncated: false, bodyUnavailableReason: null
      },
      response: null, error: null,
      pageUrl: "https://app.example.com/dashboard"
    },
    { tab: { id: 17 }, url: "https://app.example.com/dashboard", incognito: false }
  );

  // Complete phase.
  await controller.handlePageScriptObservation(
    {
      eventId: "page-uuid-after-wr",
      phase: "complete",
      initiator: "https://app.example.com",
      request: null,
      response: {
        completedAt: 150, durationMs: 50, status: 201,
        url: "https://app.example.com/v1/x", headers: {},
        body: '{"ok":true}', bodyAvailable: true, bodyTruncated: false, bodyUnavailableReason: null
      },
      error: null,
      pageUrl: "https://app.example.com/dashboard"
    },
    { tab: { id: 17 }, url: "https://app.example.com/dashboard", incognito: false }
  );
  await drainTimers();

  const complete = posts.find((p) => p.phase === "complete");
  assert.ok(complete, "complete-phase post must land");
  assert.equal(complete.eventId, "page-uuid-after-wr", "page-script eventId wins over the wr_* id");
  assert.equal(complete.request.body, '{"k":"v"}', "page-script request body must survive");
  assert.equal(complete.response.body, '{"ok":true}');
  assert.equal(complete.captureMode, "merged", "merging webRequest with page-script must promote captureMode to merged");
  assert.equal(posts.filter((p) => p.phase === "complete").length, 1, "no duplicate complete-phase row from the wr_* fallback");
});

// Real Chrome fires onBeforeRequest (partial) before onCompleted (non-partial)
// for the same call, so the helper often sees the non-partial pass find an
// existing webRequest fallback. The non-partial pass must NOT post the wr_*
// immediately at delay 0 — that would race with the page-script request /
// complete phase that arrives a few ms later and produce a duplicate row.
test("partial webRequest first, then non-partial for same call, is adopted by page-script without duplicate wr_* row", async () => {
  const posts = [];
  // profileIdSnapshot wires the cached-profile synchronous branch — the
  // same path the SW hits after ensureProfileId() has resolved.
  const profileIdSnapshot = () => "bprof_test";
  const controller = createCaptureController({
    completeDelayMs: 0,
    getConfig: async () => ({}),
    getProfileId: async () => "bprof_test",
    postEvent: async (event) => { posts.push(event); },
    profileIdSnapshot
  });

  // 1. onBeforeRequest partial: creates the webRequest fallback entry.
  controller.attachWebRequestObservation(
    {
      tabId: 17, requestId: "7777", method: "POST", url: "https://app.example.com/api/echo",
      timeStamp: 100,
      documentUrl: "https://app.example.com/dashboard", initiator: "https://app.example.com",
      incognito: false
    },
    { partial: true }
  );

  // 2. onCompleted non-partial for the same call: finds the existing
  //    webRequest fallback and would normally schedule a post at
  //    delay 0. The fix is to hold for the merge window so the
  //    page-script phase can adopt the entry.
  controller.attachWebRequestObservation(
    {
      tabId: 17, requestId: "7777", method: "POST", url: "https://app.example.com/api/echo",
      statusCode: 201, timeStamp: 150,
      documentUrl: "https://app.example.com/dashboard", initiator: "https://app.example.com",
      responseHeaders: [{ name: "X-Server", value: "edge-7" }],
      incognito: false
    },
    { partial: false }
  );

  // 3. 5ms wait — enough to clear the delay 0 path on a regression,
  //    short enough that the merge window (50ms) is still pending.
  await new Promise((r) => setTimeout(r, 5));

  // 4. Page-script request + complete arrive and must adopt the
  //    webRequest fallback.
  await controller.handlePageScriptObservation(
    {
      eventId: "page-uuid-partial-wr",
      phase: "request",
      initiator: "https://app.example.com",
      request: {
        startedAt: 100, method: "POST", url: "https://app.example.com/api/echo",
        headers: { "Content-Type": "application/json" },
        body: '{"name":"x"}', bodyAvailable: true, bodyTruncated: false, bodyUnavailableReason: null
      },
      response: null, error: null,
      pageUrl: "https://app.example.com/dashboard"
    },
    { tab: { id: 17 }, url: "https://app.example.com/dashboard", incognito: false }
  );
  await controller.handlePageScriptObservation(
    {
      eventId: "page-uuid-partial-wr",
      phase: "complete",
      initiator: "https://app.example.com",
      request: null,
      response: {
        completedAt: 150, durationMs: 50, status: 201,
        url: "https://app.example.com/api/echo", headers: {},
        body: '{"id":1}', bodyAvailable: true, bodyTruncated: false, bodyUnavailableReason: null
      },
      error: null,
      pageUrl: "https://app.example.com/dashboard"
    },
    { tab: { id: 17 }, url: "https://app.example.com/dashboard", incognito: false }
  );
  await drainTimers();

  // 5. Exactly one complete-phase post, and its eventId is the
  //    page-script UUID — no duplicate wr_* row.
  const completePosts = posts.filter((p) => p.phase === "complete");
  assert.equal(completePosts.length, 1, "no duplicate wr_* row for the partial→non-partial sequence");
  const complete = completePosts[0];
  assert.equal(complete.eventId, "page-uuid-partial-wr", "page-script eventId wins over the wr_* id");
  assert.equal(complete.request.method, "POST", "POST survives the partial webRequest-first sequence");
  assert.equal(complete.request.body, '{"name":"x"}', "page-script request body survives");
  assert.equal(complete.response.body, '{"id":1}', "page-script response body survives");
  assert.equal(complete.response.headers["X-Server"], "edge-7", "webRequest response headers still merge in");
  assert.equal(complete.captureMode, "merged");
  assert.equal(complete.metadata.webRequestId, "7777", "webRequest requestId preserved as metadata");
});

// --- Noise filtering (silence self-capture + non-API resource loads) ---

test("webRequest: the console's own origin is never captured (no localhost self-capture)", () => {
  const controller = createCaptureController({ consoleHostSnapshot: () => "http://localhost:3957" });
  const result = controller.attachWebRequestObservation({
    tabId: 1, requestId: "c1", method: "GET",
    url: "http://localhost:3957/api/source", type: "xmlhttprequest",
    documentUrl: "http://localhost:3957/"
  });
  assert.equal(result, false);
});

test("webRequest: non-API resource types (navigation/script/style/image/font) are ignored", () => {
  const controller = createCaptureController({ consoleHostSnapshot: () => "http://localhost:3957" });
  for (const type of ["main_frame", "script", "stylesheet", "image", "font", "media"]) {
    const result = controller.attachWebRequestObservation({
      tabId: 1, requestId: "r-" + type, method: "GET",
      url: "https://app.example.com/assets/file", type,
      documentUrl: "https://app.example.com/"
    });
    assert.equal(result, false, "should ignore resource type: " + type);
  }
});

test("webRequest: real xmlhttprequest API calls are still captured", () => {
  const controller = createCaptureController({ consoleHostSnapshot: () => "http://localhost:3957" });
  const result = controller.attachWebRequestObservation({
    tabId: 1, requestId: "x1", method: "GET",
    url: "https://api.example.com/v1/users", type: "xmlhttprequest",
    documentUrl: "https://app.example.com/"
  });
  assert.equal(result, true);
});

test("webRequest: untyped events (older fixtures) still pass — backward compatible", () => {
  const controller = createCaptureController({ consoleHostSnapshot: () => "http://localhost:3957" });
  const result = controller.attachWebRequestObservation({
    tabId: 1, requestId: "u1", method: "GET",
    url: "https://api.example.com/v1/x",
    documentUrl: "https://app.example.com/"
  });
  assert.equal(result, true);
});
