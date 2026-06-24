"use strict";

const state = {
  events: [],
  sessions: [],
  activeSessionId: null,
  currentSessionId: null,
  selectedId: null,
  activeTab: "response",
  source: null,
  config: null
};

const els = {
  sourceDot: document.getElementById("sourceDot"),
  sourceText: document.getElementById("sourceText"),
  restartButton: document.getElementById("restartButton"),
  clearButton: document.getElementById("clearButton"),
  searchInput: document.getElementById("searchInput"),
  stateFilter: document.getElementById("stateFilter"),
  methodFilter: document.getElementById("methodFilter"),
  autoSelectToggle: document.getElementById("autoSelectToggle"),
  sessionPicker: document.getElementById("sessionPicker"),
  countText: document.getElementById("countText"),
  lastUpdateText: document.getElementById("lastUpdateText"),
  requestList: document.getElementById("requestList"),
  emptyState: document.getElementById("emptyState"),
  detailContent: document.getElementById("detailContent"),
  detailHost: document.getElementById("detailHost"),
  detailTitle: document.getElementById("detailTitle"),
  detailMethod: document.getElementById("detailMethod"),
  detailStatus: document.getElementById("detailStatus"),
  detailPre: document.getElementById("detailPre"),
  detailResponse: document.getElementById("detailResponse"),
  responseStatusValue: document.getElementById("responseStatusValue"),
  responseUrlValue: document.getElementById("responseUrlValue"),
  responseHeadersValue: document.getElementById("responseHeadersValue"),
  responseBody: document.getElementById("responseBody"),
  copyButton: document.getElementById("copyButton"),
  copyBodyButton: document.getElementById("copyBodyButton")
};

connectEvents();
bindUi();

function bindUi() {
  els.searchInput.addEventListener("input", render);
  els.stateFilter.addEventListener("change", render);
  els.methodFilter.addEventListener("change", render);

  els.clearButton.addEventListener("click", async () => {
    await fetch("/api/clear", { method: "POST" });
  });

  els.restartButton.addEventListener("click", async () => {
    await fetch("/api/restart", { method: "POST" });
  });

  els.sessionPicker.addEventListener("change", async () => {
    const id = Number.parseInt(els.sessionPicker.value, 10);
    if (!Number.isFinite(id)) return;
    await switchToSession(id);
  });

  document.querySelectorAll(".tab-button").forEach((button) => {
    button.addEventListener("click", () => {
      state.activeTab = button.dataset.tab;
      document.querySelectorAll(".tab-button").forEach((item) => {
        item.classList.toggle("active", item === button);
      });
      renderDetail();
    });
  });

  els.copyButton.addEventListener("click", async () => {
    const text = currentTabText(selectedEvent());
    if (!text) return;
    await flashCopy(els.copyButton, text);
  });

  els.copyBodyButton.addEventListener("click", async () => {
    const event = selectedEvent();
    if (!event || !event.response) return;
    const text = formatBody(event.response.body);
    if (!text || text === "(empty)") return;
    await flashCopy(els.copyBodyButton, text);
  });
}

async function flashCopy(button, text) {
  await navigator.clipboard.writeText(text);
  const original = button.textContent;
  button.textContent = "Copied";
  setTimeout(() => {
    button.textContent = original;
  }, 900);
}

function connectEvents() {
  const eventSource = new EventSource("/events");

  eventSource.addEventListener("snapshot", (message) => {
    const payload = JSON.parse(message.data);
    state.events = payload.events || [];
    state.sessions = payload.sessions || [];
    state.currentSessionId = payload.currentSession ? payload.currentSession.id : null;
    state.activeSessionId = state.currentSessionId;
    state.source = payload.source;
    state.config = payload.config;
    selectLatestIfNeeded();
    render();
  });

  eventSource.addEventListener("event-upsert", (message) => {
    const event = JSON.parse(message.data);
    if (state.activeSessionId !== state.currentSessionId) return;
    if (event.sessionId && event.sessionId !== state.activeSessionId) return;
    const index = state.events.findIndex((item) => item.id === event.id);
    if (index >= 0) state.events[index] = event;
    else state.events.unshift(event);
    sortEvents();
    selectLatestIfNeeded(event.id);
    render();
  });

  eventSource.addEventListener("session-start", (message) => {
    const payload = JSON.parse(message.data);
    const session = payload.session;
    const wasOnLive = state.activeSessionId === state.currentSessionId;

    state.currentSessionId = session.id;
    const existing = state.sessions.findIndex((s) => s.id === session.id);
    if (existing >= 0) state.sessions[existing] = session;
    else state.sessions = [session, ...state.sessions];

    if (payload.previousSessionId) {
      const prev = state.sessions.find((s) => s.id === payload.previousSessionId);
      if (prev && !prev.endedAt) prev.endedAt = payload.clearedAt;
    }

    if (wasOnLive) {
      state.activeSessionId = session.id;
      state.events = [];
      state.selectedId = null;
    }
    render();
  });

  eventSource.addEventListener("source-status", (message) => {
    state.source = JSON.parse(message.data);
    renderSource();
  });

  eventSource.onerror = () => {
    state.source = {
      running: false,
      message: "Disconnected from local server"
    };
    renderSource();
  };
}

function selectLatestIfNeeded(newId) {
  if (els.autoSelectToggle.checked && newId) {
    state.selectedId = newId;
    return;
  }

  if (!state.selectedId && state.events.length) {
    state.selectedId = state.events[0].id;
  }
}

function sortEvents() {
  state.events.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
}

function render() {
  sortEvents();
  renderSource();
  renderSessionPicker();
  renderMethodFilter();
  renderList();
  renderDetail();
}

async function switchToSession(id) {
  const response = await fetch(`/api/sessions/${id}/events`);
  if (!response.ok) return;
  const payload = await response.json();
  state.activeSessionId = id;
  state.events = payload.events || [];
  state.selectedId = null;
  const replaced = state.sessions.findIndex((s) => s.id === payload.session.id);
  if (replaced >= 0) state.sessions[replaced] = payload.session;
  render();
}

function renderSessionPicker() {
  if (!els.sessionPicker) return;
  const sessions = state.sessions || [];
  els.sessionPicker.innerHTML = sessions.map((session) => {
    const label = formatSessionLabel(session);
    const selected = session.id === state.activeSessionId ? " selected" : "";
    return `<option value="${session.id}"${selected}>${escapeHtml(label)}</option>`;
  }).join("");
}

function formatSessionLabel(session) {
  const live = session.id === state.currentSessionId ? "● Live · " : "";
  const started = session.startedAt
    ? new Date(session.startedAt).toLocaleString([], {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit"
    })
    : "";
  const count = session.eventCount ?? 0;
  return `${live}#${session.id} · ${count} call${count === 1 ? "" : "s"} · ${started}`;
}

function renderSource() {
  const source = state.source || {};
  els.sourceDot.classList.toggle("running", Boolean(source.running));
  els.sourceDot.classList.toggle("error", !source.running && Boolean(source.lastError));
  els.sourceText.textContent = source.message || "Connecting...";
}

function renderMethodFilter() {
  const current = els.methodFilter.value;
  const methods = [...new Set(state.events.map((event) => event.method).filter(Boolean))].sort();
  const options = ["all", ...methods];
  els.methodFilter.innerHTML = options.map((method) => {
    const label = method === "all" ? "All methods" : method;
    return `<option value="${escapeHtml(method)}">${escapeHtml(label)}</option>`;
  }).join("");
  els.methodFilter.value = options.includes(current) ? current : "all";
}

function filteredEvents() {
  const query = els.searchInput.value.trim().toLowerCase();
  const stateFilter = els.stateFilter.value;
  const methodFilter = els.methodFilter.value;

  return state.events.filter((event) => {
    if (stateFilter !== "all" && event.state !== stateFilter) return false;
    if (methodFilter !== "all" && event.method !== methodFilter) return false;
    if (!query) return true;
    return searchableText(event).includes(query);
  });
}

function renderList() {
  const events = filteredEvents();
  els.countText.textContent = `${events.length} ${events.length === 1 ? "call" : "calls"}`;
  els.lastUpdateText.textContent = state.events[0] ? relativeTime(state.events[0].updatedAt) : "Waiting";

  if (!events.find((event) => event.id === state.selectedId)) {
    state.selectedId = events[0] ? events[0].id : null;
  }

  els.requestList.innerHTML = events.map((event) => {
    const active = event.id === state.selectedId ? "active" : "";
    const statusClass = statusClassName(event);
    const statusText = event.statusCode || event.state || "pending";
    return `
      <button class="request-row ${active} ${statusClass}" data-id="${escapeHtml(event.id)}">
        <span class="method-badge">${escapeHtml(event.method || "GET")}</span>
        <span class="row-main">
          <span class="row-path">${escapeHtml(event.path || "(unknown endpoint)")}</span>
          <span class="row-host">${escapeHtml(event.host || "")}</span>
        </span>
        <span class="row-time">${escapeHtml(relativeTime(event.updatedAt))}</span>
      </button>
    `;
  }).join("");

  els.requestList.querySelectorAll(".request-row").forEach((row) => {
    row.addEventListener("click", () => {
      state.selectedId = row.dataset.id;
      render();
    });
  });
}

function renderDetail() {
  const event = selectedEvent();
  els.emptyState.classList.toggle("hidden", Boolean(event));
  els.detailContent.classList.toggle("hidden", !event);

  if (!event) return;

  els.detailHost.textContent = event.host || "";
  els.detailTitle.textContent = event.path || event.url || "(unknown endpoint)";
  els.detailMethod.textContent = event.method || "GET";
  els.detailStatus.textContent = event.statusCode || event.state || "pending";
  els.detailStatus.className = `status-badge ${statusClassName(event)}`;

  const isResponse = state.activeTab === "response";
  els.detailPre.classList.toggle("hidden", isResponse);
  els.detailResponse.classList.toggle("hidden", !isResponse);

  if (isResponse) {
    renderResponseSummary(event);
    els.responseBody.textContent = event.response
      ? formatBody(event.response.body)
      : "No response captured yet.";
  } else {
    els.detailPre.textContent = currentTabText(event);
  }
}

function renderResponseSummary(event) {
  const response = event.response;
  if (!response) {
    els.responseStatusValue.textContent = "—";
    els.responseStatusValue.className = "field-value field-value--status pending";
    els.responseUrlValue.textContent = "—";
    els.responseHeadersValue.textContent = "No response captured yet.";
    return;
  }

  const status = response.statusCode ?? event.statusCode ?? "—";
  els.responseStatusValue.textContent = String(status);
  els.responseStatusValue.className = `field-value field-value--status ${statusClassName(event)}`;

  els.responseUrlValue.textContent = response.url || event.url || "—";

  renderInlineHeaders(els.responseHeadersValue, response.headers || {});
}

function renderInlineHeaders(container, headers) {
  const keys = Object.keys(headers).sort((a, b) => a.localeCompare(b));
  container.replaceChildren();
  if (!keys.length) {
    container.textContent = "(none)";
    return;
  }

  keys.forEach((key, index) => {
    const keySpan = document.createElement("span");
    keySpan.className = "header-key";
    keySpan.textContent = `${key}:`;
    container.appendChild(keySpan);
    container.appendChild(document.createTextNode(` ${headers[key]}`));
    if (index < keys.length - 1) {
      const sep = document.createElement("span");
      sep.className = "header-sep";
      sep.textContent = ", ";
      container.appendChild(sep);
    }
  });
}

function currentTabText(event) {
  if (!event) return "";

  if (state.activeTab === "response") {
    if (!event.response) return "No response captured yet.";
    return formatSection({
      "Status Code": event.response.statusCode || "",
      URL: event.response.url || event.url || "",
      Headers: formatHeaders(event.response.headers),
      Body: formatBody(event.response.body)
    });
  }

  if (state.activeTab === "request") {
    if (!event.request) return "No request block captured yet.";
    return formatSection({
      Method: event.request.method || event.method || "",
      URL: event.request.url || event.url || "",
      Headers: formatHeaders(event.request.headers),
      Body: formatBody(event.request.body)
    });
  }

  if (state.activeTab === "curl") {
    return event.curl || "No cURL command captured yet.";
  }

  if (state.activeTab === "errors") {
    return event.errors && event.errors.length
      ? event.errors.join("\n\n")
      : "No errors captured for this request.";
  }

  if (state.activeTab === "raw") {
    return (event.raw || []).join("\n") || "No raw lines captured.";
  }

  return "";
}

function selectedEvent() {
  return state.events.find((event) => event.id === state.selectedId) || null;
}

function statusClassName(event) {
  if (event.state === "error" || Number(event.statusCode) >= 400) return "error";
  if (event.state === "success" || (event.statusCode >= 200 && event.statusCode < 400)) return "success";
  return "pending";
}

function searchableText(event) {
  return [
    event.method,
    event.url,
    event.host,
    event.path,
    event.statusCode,
    event.state,
    event.curl,
    JSON.stringify(event.request || {}),
    JSON.stringify(event.response || {}),
    (event.errors || []).join(" "),
    (event.raw || []).join(" ")
  ].join(" ").toLowerCase();
}

function formatSection(items) {
  return Object.entries(items)
    .map(([key, value]) => {
      const text = value || "";
      return `${key}:\n${text}`;
    })
    .join("\n\n");
}

function formatHeaders(headers = {}) {
  const keys = Object.keys(headers);
  if (!keys.length) return "(none)";
  return keys.sort().map((key) => `${key}: ${headers[key]}`).join("\n");
}

function formatBody(body) {
  if (!body) return "(empty)";
  try {
    return JSON.stringify(JSON.parse(body), null, 2);
  } catch {
    return body;
  }
}

function relativeTime(value) {
  if (!value) return "";
  const diff = Date.now() - new Date(value).getTime();
  if (diff < 1000) return "now";
  if (diff < 60_000) return `${Math.floor(diff / 1000)}s`;
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m`;
  return new Date(value).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}
