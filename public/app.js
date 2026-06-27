"use strict";

const state = {
  events: [],
  sessions: [],
  activeSessionId: null,
  currentSessionId: null,
  selectedId: null,
  activeTab: "preview",
  source: null,
  sources: null,
  config: null
};

const els = {
  workspace: document.getElementById("workspace"),
  paneDivider: document.getElementById("paneDivider"),
  toggleListButton: document.getElementById("toggleListButton"),
  sourceDot: document.getElementById("sourceDot"),
  sourceText: document.getElementById("sourceText"),
  sourcePicker: document.getElementById("sourcePicker"),
  emptyStateHint: document.getElementById("emptyStateHint"),
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
  detailUrl: document.getElementById("detailUrl"),
  detailSize: document.getElementById("detailSize"),
  detailBody: document.getElementById("detailBody"),
  copyButton: document.getElementById("copyButton")
};

loadLayoutState();
bindLayout();
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

  if (els.sourcePicker) {
    els.sourcePicker.addEventListener("change", async () => {
      const value = els.sourcePicker.value;
      if (!value) return;
      const option = sourceOptionForValue(value);
      if (!option) return;
      const body = { kind: option.kind };
      if (option.kind === "android") body.deviceSerial = option.opts?.deviceSerial || null;
      const response = await fetch("/api/source", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
      if (!response.ok) {
        // Revert UI selection on failure.
        renderSourcePicker();
        return;
      }
      applySnapshotPayload(await response.json());
      render();
    });
  }

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
}

const LAYOUT_STORAGE_KEY = "mobileApiConsole.layout";
const LIST_MIN_PX = 80;
const LIST_DEFAULT_VW = 0.38;
const LIST_COLLAPSE_THRESHOLD = 60;
const LIST_KEYBOARD_STEP = 24;

let dragState = null;

function bindLayout() {
  if (!els.paneDivider) return;

  els.paneDivider.addEventListener("pointerdown", onDividerPointerDown);
  els.paneDivider.addEventListener("dblclick", () => {
    setListCollapsed(false);
    setListWidthPx(Math.max(LIST_MIN_PX, window.innerWidth * LIST_DEFAULT_VW));
    saveLayoutState();
  });
  els.paneDivider.addEventListener("keydown", (event) => {
    if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
      const delta = event.key === "ArrowLeft" ? -LIST_KEYBOARD_STEP : LIST_KEYBOARD_STEP;
      const current = currentListWidthPx();
      setListCollapsed(false);
      setListWidthPx(current + delta);
      saveLayoutState();
      event.preventDefault();
    } else if (event.key === "Enter" || event.key === " ") {
      toggleListCollapsed();
      event.preventDefault();
    }
  });

  els.toggleListButton.addEventListener("click", toggleListCollapsed);
}

function onDividerPointerDown(event) {
  if (event.button !== 0) return;
  const workspaceRect = els.workspace.getBoundingClientRect();
  dragState = {
    pointerId: event.pointerId,
    workspaceLeft: workspaceRect.left,
    workspaceRight: workspaceRect.right
  };
  els.paneDivider.setPointerCapture(event.pointerId);
  els.paneDivider.classList.add("dragging");
  document.body.style.cursor = "col-resize";
  els.paneDivider.addEventListener("pointermove", onDividerPointerMove);
  els.paneDivider.addEventListener("pointerup", onDividerPointerUp);
  els.paneDivider.addEventListener("pointercancel", onDividerPointerUp);
  event.preventDefault();
}

function onDividerPointerMove(event) {
  if (!dragState) return;
  const width = event.clientX - dragState.workspaceLeft;
  if (width < LIST_COLLAPSE_THRESHOLD) {
    setListCollapsed(true);
    return;
  }
  setListCollapsed(false);
  setListWidthPx(width);
}

function onDividerPointerUp(event) {
  if (!dragState) return;
  els.paneDivider.releasePointerCapture(dragState.pointerId);
  els.paneDivider.classList.remove("dragging");
  document.body.style.cursor = "";
  els.paneDivider.removeEventListener("pointermove", onDividerPointerMove);
  els.paneDivider.removeEventListener("pointerup", onDividerPointerUp);
  els.paneDivider.removeEventListener("pointercancel", onDividerPointerUp);
  dragState = null;
  saveLayoutState();
}

function toggleListCollapsed() {
  const collapsed = els.workspace.dataset.listCollapsed !== "true";
  setListCollapsed(collapsed);
  saveLayoutState();
}

function setListCollapsed(collapsed) {
  els.workspace.dataset.listCollapsed = collapsed ? "true" : "false";
  els.toggleListButton.setAttribute("aria-pressed", String(collapsed));
  els.toggleListButton.textContent = collapsed ? "› Show list" : "‹ Hide list";
  els.toggleListButton.title = collapsed ? "Show call list" : "Hide call list";
  els.toggleListButton.setAttribute("aria-label", els.toggleListButton.title);
  const valueNow = collapsed ? 0 : Math.round((currentListWidthPx() / window.innerWidth) * 100);
  els.paneDivider.setAttribute("aria-valuenow", String(valueNow));
}

function setListWidthPx(width) {
  const clamped = Math.max(LIST_MIN_PX, Math.min(width, window.innerWidth * 0.6));
  els.workspace.style.setProperty("--list-width", `${Math.round(clamped)}px`);
  els.paneDivider.setAttribute("aria-valuenow", String(Math.round((clamped / window.innerWidth) * 100)));
}

function currentListWidthPx() {
  const value = els.workspace.style.getPropertyValue("--list-width");
  if (value && value.endsWith("px")) return Number.parseFloat(value);
  return window.innerWidth * LIST_DEFAULT_VW;
}

function saveLayoutState() {
  try {
    const payload = {
      width: els.workspace.style.getPropertyValue("--list-width") || "",
      collapsed: els.workspace.dataset.listCollapsed === "true"
    };
    localStorage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify(payload));
  } catch {
    // localStorage unavailable (private mode, etc.) — skip silently.
  }
}

function loadLayoutState() {
  if (!els.workspace) return;
  try {
    const raw = localStorage.getItem(LAYOUT_STORAGE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed.width === "string" && parsed.width.endsWith("px")) {
        els.workspace.style.setProperty("--list-width", parsed.width);
      }
      if (parsed && parsed.collapsed) {
        els.workspace.dataset.listCollapsed = "true";
      }
    }
  } catch {
    // Ignore malformed persisted state.
  }
  // Initialise button label / aria attrs to match current state.
  const collapsed = els.workspace.dataset.listCollapsed === "true";
  els.toggleListButton.setAttribute("aria-pressed", String(collapsed));
  els.toggleListButton.textContent = collapsed ? "› Show list" : "‹ Hide list";
  els.toggleListButton.title = collapsed ? "Show call list" : "Hide call list";
  els.toggleListButton.setAttribute("aria-label", els.toggleListButton.title);
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
    applySnapshotPayload(payload);
    selectLatestIfNeeded();
    render();
  });

  eventSource.addEventListener("event-upsert", (message) => {
    const event = JSON.parse(message.data);
    if (event.sourceKey && event.sourceKey !== selectedSourceKey()) return;
    if (state.activeSessionId !== state.currentSessionId) return;
    if (event.sessionId && event.sessionId !== state.activeSessionId) return;
    const index = state.events.findIndex((item) => item.id === event.id);
    if (index >= 0) state.events[index] = event;
    else state.events.unshift(event);
    bumpSessionCount(event.sessionId);
    sortEvents();
    selectLatestIfNeeded(event.id);
    render();
  });

  eventSource.addEventListener("session-start", (message) => {
    const payload = JSON.parse(message.data);
    if (payload.sourceKey && payload.sourceKey !== selectedSourceKey()) return;
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
    const status = JSON.parse(message.data);
    updateSourceStatus(status);
    if (status.sourceKey === selectedSourceKey()) {
      state.source = status;
    }
    renderSource();
  });

  eventSource.addEventListener("source-changed", (message) => {
    state.sources = JSON.parse(message.data);
    renderSourcePicker();
    renderEmptyHint();
  });

  eventSource.onerror = () => {
    state.source = {
      running: false,
      message: "Disconnected from local server"
    };
    renderSource();
  };
}

function applySnapshotPayload(payload) {
  state.events = payload.events || [];
  state.sessions = payload.sessions || [];
  state.currentSessionId = payload.currentSession ? payload.currentSession.id : null;
  state.activeSessionId = state.currentSessionId;
  state.source = payload.source;
  state.sources = payload.sources || null;
  state.config = payload.config || state.config;
  state.selectedId = null;
}

function selectedSourceKey() {
  return state.sources?.selectedSourceKey
    || state.sources?.current?.sourceKey
    || null;
}

function updateSourceStatus(status) {
  if (!state.sources?.selectable || !status?.sourceKey) return;
  const entry = state.sources.selectable.find((item) => item.sourceKey === status.sourceKey);
  if (!entry) return;
  entry.status = status;
  entry.running = Boolean(status.running);
}

function bumpSessionCount(sessionId) {
  if (!sessionId) return;
  const session = state.sessions.find((item) => item.id === sessionId);
  if (!session) return;
  const visibleCount = state.events.filter((event) => event.sessionId === sessionId).length;
  session.eventCount = Math.max(session.eventCount || 0, visibleCount);
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
  renderSourcePicker();
  renderEmptyHint();
  renderSessionPicker();
  renderMethodFilter();
  renderList();
  renderDetail();
}

function renderSourcePicker(snapshot) {
  if (!els.sourcePicker) return;
  const sources = snapshot || state.sources;
  if (!sources) {
    els.sourcePicker.innerHTML = "";
    els.sourcePicker.disabled = true;
    return;
  }

  const options = [];
  for (const entry of sourceOptions()) {
    options.push({
      value: entry.sourceKey || sourceValueFor(entry),
      label: entry.label || entry.kind,
      kind: entry.kind,
      opts: entry.opts || {}
    });
  }

  const current = sources.current || { kind: "", opts: {} };
  const currentValue = sources.selectedSourceKey || current.sourceKey || sourceValueFor(current);

  els.sourcePicker.innerHTML = options.map((option) => {
    const selected = option.value === currentValue ? " selected" : "";
    return `<option value="${escapeHtml(option.value)}"${selected}>${escapeHtml(option.label)}</option>`;
  }).join("");
  els.sourcePicker.disabled = options.length <= 1;
}

function sourceOptions() {
  const sources = state.sources || {};
  if (sources.selectable && sources.selectable.length) return sources.selectable;

  const options = [];
  for (const entry of sources.available || []) {
    if (entry.kind === "android" && entry.devices && entry.devices.length > 0) {
      const single = entry.devices.length === 1;
      for (const device of entry.devices) {
        const label = single ? (entry.label || `Android · ${device.label}`) : `Android · ${device.label}`;
        options.push({
          sourceKey: `android::${device.serial}`,
          kind: "android",
          opts: { deviceSerial: device.serial },
          label
        });
      }
    } else if (entry.kind === "android") {
      options.push({
        sourceKey: "android::",
        kind: "android",
        opts: { deviceSerial: null },
        label: entry.label || "Android"
      });
    } else {
      options.push({
        sourceKey: entry.kind,
        kind: entry.kind,
        opts: {},
        label: entry.label || entry.kind
      });
    }
  }
  return options;
}

function sourceOptionForValue(value) {
  return sourceOptions().find((entry) => (entry.sourceKey || sourceValueFor(entry)) === value);
}

function sourceValueFor(entry) {
  if (!entry?.kind) return "";
  if (entry.kind === "android") return `android::${entry.opts?.deviceSerial || ""}`;
  return entry.kind;
}

function renderEmptyHint() {
  if (!els.emptyStateHint) return;
  const kind = state.sources?.current?.kind || "";
  if (kind === "android") {
    els.emptyStateHint.textContent = "Run the Android app on the attached device or emulator and trigger an API request.";
  } else if (kind === "demo") {
    els.emptyStateHint.textContent = "Demo source is streaming synthetic requests every couple of seconds.";
  } else {
    els.emptyStateHint.textContent = "Run the iOS app in a booted simulator and trigger an API request.";
  }
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
  const sessions = (state.sessions || []).filter(isVisibleSession);
  els.sessionPicker.innerHTML = sessions.map((session) => {
    const label = formatSessionLabel(session);
    const selected = session.id === state.activeSessionId ? " selected" : "";
    return `<option value="${session.id}"${selected}>${escapeHtml(label)}</option>`;
  }).join("");
}

function isVisibleSession(session) {
  if (session.id === state.currentSessionId) return true;
  if (session.id === state.activeSessionId) return true;
  return (session.eventCount || 0) > 0;
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

  const fullUrl = (event.response && event.response.url) || event.url || "";
  els.detailUrl.textContent = fullUrl;
  els.detailUrl.title = fullUrl;
  els.detailUrl.hidden = !fullUrl;

  const size = responseBodySize(event);
  if (size === null) {
    els.detailSize.hidden = true;
    els.detailSize.textContent = "";
  } else {
    els.detailSize.hidden = false;
    els.detailSize.textContent = formatBytes(size);
    els.detailSize.title = `${size.toLocaleString()} bytes`;
  }

  renderTabContent(event);
}

function renderTabContent(event) {
  const container = els.detailBody;
  container.replaceChildren();

  const tab = state.activeTab;
  if (tab === "preview") {
    renderBodyTab(container, event.response?.body, "No response captured yet.", event.response);
    return;
  }
  if (tab === "headers") {
    renderHeadersTab(container, event);
    return;
  }
  if (tab === "payload") {
    renderBodyTab(container, event.request?.body, "No request body captured.", event.request);
    return;
  }
  if (tab === "response") {
    renderTextTab(container, event.response?.body || "", "No response captured yet.", event.response);
    return;
  }
  if (tab === "curl") {
    renderTextTab(container, event.curl || "", "No cURL command captured yet.", event.curl);
    return;
  }
  if (tab === "errors") {
    const text = (event.errors || []).join("\n\n");
    renderTextTab(container, text, "No errors captured for this request.", event.errors?.length);
    return;
  }
  if (tab === "raw") {
    const text = (event.raw || []).join("\n");
    renderTextTab(container, text, "No raw lines captured.", event.raw?.length);
  }
}

function renderTextTab(container, text, emptyMessage, hasContent) {
  if (!hasContent || !text || text === "(empty)") {
    const empty = document.createElement("div");
    empty.className = "tab-empty";
    empty.textContent = emptyMessage;
    container.appendChild(empty);
    return;
  }
  const pre = document.createElement("pre");
  pre.className = "detail-pre";
  pre.textContent = text;
  container.appendChild(pre);
}

function renderBodyTab(container, body, emptyMessage, ownerPresent) {
  if (!ownerPresent || !body) {
    const empty = document.createElement("div");
    empty.className = "tab-empty";
    empty.textContent = emptyMessage;
    container.appendChild(empty);
    return;
  }

  const parsed = tryParseJson(body);
  if (parsed.ok && typeof window.renderJsonTree === "function") {
    container.appendChild(window.renderJsonTree(parsed.value));
    return;
  }

  const pre = document.createElement("pre");
  pre.className = "detail-pre";
  pre.textContent = body;
  container.appendChild(pre);
}

function tryParseJson(body) {
  if (typeof body !== "string") return { ok: false };
  const trimmed = body.trim();
  if (!trimmed) return { ok: false };
  const first = trimmed[0];
  if (first !== "{" && first !== "[") return { ok: false };
  try {
    return { ok: true, value: JSON.parse(trimmed) };
  } catch {
    return { ok: false };
  }
}

function renderHeadersTab(container, event) {
  const requestHeaders = event.request?.headers || {};
  const responseHeaders = event.response?.headers || {};
  const requestKeys = Object.keys(requestHeaders);
  const responseKeys = Object.keys(responseHeaders);

  if (!requestKeys.length && !responseKeys.length) {
    const empty = document.createElement("div");
    empty.className = "tab-empty";
    empty.textContent = "No headers captured yet.";
    container.appendChild(empty);
    return;
  }

  appendHeadersBlock(container, "Request headers", requestHeaders, event.request);
  appendHeadersBlock(container, "Response headers", responseHeaders, event.response);
}

function appendHeadersBlock(container, title, headers, ownerPresent) {
  const block = document.createElement("section");
  block.className = "headers-block";

  const heading = document.createElement("h3");
  heading.className = "headers-title";
  heading.textContent = title;
  block.appendChild(heading);

  const keys = Object.keys(headers).sort((a, b) => a.localeCompare(b));
  if (!keys.length) {
    const note = document.createElement("div");
    note.className = "headers-empty";
    note.textContent = ownerPresent ? "(none)" : "Not captured.";
    block.appendChild(note);
    container.appendChild(block);
    return;
  }

  const list = document.createElement("dl");
  list.className = "headers-list";
  for (const key of keys) {
    const dt = document.createElement("dt");
    dt.className = "header-name";
    dt.textContent = key;
    const dd = document.createElement("dd");
    dd.className = "header-value";
    dd.textContent = headers[key];
    list.appendChild(dt);
    list.appendChild(dd);
  }
  block.appendChild(list);
  container.appendChild(block);
}

function currentTabText(event) {
  if (!event) return "";

  if (state.activeTab === "preview") {
    return event.response ? formatBody(event.response.body) : "";
  }
  if (state.activeTab === "headers") {
    const reqText = formatHeaders(event.request?.headers);
    const resText = formatHeaders(event.response?.headers);
    return `Request headers:\n${reqText}\n\nResponse headers:\n${resText}`;
  }
  if (state.activeTab === "payload") {
    return event.request ? formatBody(event.request.body) : "";
  }
  if (state.activeTab === "response") {
    return event.response?.body || "";
  }
  if (state.activeTab === "curl") {
    return event.curl || "";
  }
  if (state.activeTab === "errors") {
    return (event.errors || []).join("\n\n");
  }
  if (state.activeTab === "raw") {
    return (event.raw || []).join("\n");
  }
  return "";
}

function responseBodySize(event) {
  const body = event.response?.body;
  if (typeof body !== "string" || !body) return null;
  return new Blob([body]).size;
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
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
