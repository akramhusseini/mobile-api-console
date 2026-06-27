"use strict";

const AUTO_COLLAPSE_DEPTH = 3;
const AUTO_COLLAPSE_THRESHOLD = 40;

let nextPairId = 0;

function renderJsonTree(value) {
  const root = document.createElement("div");
  root.className = "json-tree";
  const node = renderNode(value, { depth: 0 }, { isRoot: true });
  root.appendChild(node);
  attachTreeListeners(root);
  return root;
}

function renderNode(value, ctx, opts = {}) {
  if (isContainer(value)) return renderContainer(value, ctx, opts);
  return renderLeafLine(value, opts);
}

function renderLeafLine(value, opts) {
  const line = document.createElement("div");
  line.className = "json-line";

  appendCaretPlaceholder(line);
  appendLabel(line, opts);

  const leaf = renderLeaf(value);
  line.appendChild(leaf);

  if (opts.hasComma) line.appendChild(makePunct(","));
  return line;
}

function renderContainer(value, ctx, opts) {
  const isArray = Array.isArray(value);
  const kind = isArray ? "array" : "object";
  const { open, close } = isArray ? { open: "[", close: "]" } : { open: "{", close: "}" };
  const entries = isArray
    ? value.map((v, i) => ({ label: String(i), labelClass: "json-index", value: v, rawKey: i }))
    : Object.entries(value).map(([k, v]) => ({
      label: JSON.stringify(k),
      labelClass: "json-key",
      value: v,
      rawKey: k
    }));

  const node = document.createElement("div");
  node.className = `json-node json-node--${kind}`;
  node.dataset.collapsed = shouldAutoCollapse(ctx, entries.length, opts) ? "true" : "false";

  const pairId = String(++nextPairId);

  const header = document.createElement("div");
  header.className = "json-line json-line--header";

  appendCaret(header, entries.length > 0);
  appendLabel(header, opts);
  header.appendChild(makeBracket(open, kind, "open", pairId));

  if (entries.length === 0) {
    header.appendChild(makeBracket(close, kind, "close", pairId, "empty"));
    if (opts.hasComma) header.appendChild(makePunct(","));
    node.appendChild(header);
    return node;
  }

  const summary = document.createElement("span");
  summary.className = "json-summary";
  summary.textContent = ` ${summarize(value, entries)} `;
  header.appendChild(summary);
  header.appendChild(makeBracket(close, kind, "close", pairId, "inline"));
  if (opts.hasComma) {
    const inlineComma = makePunct(",");
    inlineComma.classList.add("json-comma--inline");
    header.appendChild(inlineComma);
  }

  node.appendChild(header);

  const children = document.createElement("div");
  children.className = "json-children";
  entries.forEach((entry, index) => {
    const child = renderNode(entry.value, { depth: ctx.depth + 1 }, {
      label: entry.label,
      labelClass: entry.labelClass,
      hasComma: index < entries.length - 1
    });
    children.appendChild(child);
  });
  node.appendChild(children);

  const closeLine = document.createElement("div");
  closeLine.className = "json-line json-line--close";
  appendCaretPlaceholder(closeLine);
  closeLine.appendChild(makeBracket(close, kind, "close", pairId));
  if (opts.hasComma) closeLine.appendChild(makePunct(","));
  node.appendChild(closeLine);

  return node;
}

function renderLeaf(value) {
  const span = document.createElement("span");
  if (value === null) {
    span.className = "json-leaf json-null";
    span.textContent = "null";
  } else if (typeof value === "string") {
    span.className = "json-leaf json-string";
    span.textContent = JSON.stringify(value);
  } else if (typeof value === "number") {
    span.className = "json-leaf json-number";
    span.textContent = Number.isFinite(value) ? String(value) : JSON.stringify(value);
  } else if (typeof value === "boolean") {
    span.className = "json-leaf json-bool";
    span.textContent = String(value);
  } else if (value === undefined) {
    span.className = "json-leaf json-null";
    span.textContent = "undefined";
  } else {
    span.className = "json-leaf";
    span.textContent = String(value);
  }
  return span;
}

function appendLabel(parent, opts) {
  if (opts.label === undefined) return;
  const labelSpan = document.createElement("span");
  labelSpan.className = opts.labelClass || "json-key";
  labelSpan.textContent = opts.label;
  parent.appendChild(labelSpan);
  parent.appendChild(makePunct(": "));
}

function appendCaret(parent, hasChildren) {
  const caret = document.createElement("span");
  caret.className = hasChildren ? "json-caret" : "json-caret json-caret--hidden";
  parent.appendChild(caret);
}

function appendCaretPlaceholder(parent) {
  const spacer = document.createElement("span");
  spacer.className = "json-caret json-caret--hidden";
  parent.appendChild(spacer);
}

function makeBracket(text, kind, role, pairId, variant) {
  const span = document.createElement("span");
  const variantClass = variant ? ` json-bracket--${variant}` : "";
  span.className = `json-bracket json-bracket--${kind} json-bracket--${role}${variantClass}`;
  span.dataset.pair = pairId;
  span.textContent = text;
  return span;
}

function makePunct(text) {
  const span = document.createElement("span");
  span.className = "json-punct";
  span.textContent = text;
  return span;
}

function summarize(value, entries) {
  if (Array.isArray(value)) {
    return `${value.length} item${value.length === 1 ? "" : "s"}`;
  }
  const previewKeys = entries.slice(0, 3).map((entry) => entry.rawKey).join(", ");
  const ellipsis = entries.length > 3 ? ", …" : "";
  const count = `${entries.length} key${entries.length === 1 ? "" : "s"}`;
  return `${previewKeys}${ellipsis} · ${count}`;
}

function shouldAutoCollapse(ctx, entryCount, opts) {
  if (opts.isRoot) return false;
  if (entryCount === 0) return false;
  if (ctx.depth >= AUTO_COLLAPSE_DEPTH) return true;
  if (entryCount > AUTO_COLLAPSE_THRESHOLD) return true;
  return false;
}

function isContainer(value) {
  return value !== null && typeof value === "object";
}

function attachTreeListeners(root) {
  root.addEventListener("click", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    if (!target.classList.contains("json-caret") && !target.classList.contains("json-bracket")) return;
    if (target.classList.contains("json-caret--hidden")) return;
    if (target.classList.contains("json-bracket--empty")) return;

    const node = target.closest(".json-node");
    if (!node) return;

    if (event.altKey) {
      const collapsed = node.dataset.collapsed !== "true";
      toggleRecursive(node, collapsed ? "true" : "false");
    } else {
      node.dataset.collapsed = node.dataset.collapsed === "true" ? "false" : "true";
    }
    event.stopPropagation();
  });

  root.addEventListener("mouseover", (event) => highlightBracketPair(root, event, true));
  root.addEventListener("mouseout", (event) => highlightBracketPair(root, event, false));
}

function highlightBracketPair(root, event, on) {
  const target = event.target;
  if (!(target instanceof HTMLElement) || !target.classList.contains("json-bracket")) return;
  if (target.classList.contains("json-bracket--empty")) return;
  const pair = target.dataset.pair;
  if (!pair) return;
  const matches = root.querySelectorAll(`.json-bracket[data-pair="${pair}"]`);
  matches.forEach((element) => element.classList.toggle("json-bracket--match", on));
}

function toggleRecursive(node, value) {
  node.dataset.collapsed = value;
  node.querySelectorAll(".json-node").forEach((child) => {
    child.dataset.collapsed = value;
  });
}

window.renderJsonTree = renderJsonTree;
