// node_modules/@laurigates/comfy-modal-kit/dist/index.js
var KEY = Symbol.for("laurigates.comfyModalKit");
function getKit() {
  const g = globalThis;
  let kit = g[KEY];
  if (!kit) {
    kit = { fieldProviders: [], activeModal: null, pointerClaim: null };
    g[KEY] = kit;
  }
  return kit;
}
function isModalActive() {
  return getKit().activeModal !== null;
}
function claimPointer(id) {
  getKit().pointerClaim = id;
}

// src/index.ts
import { app } from "/scripts/app.js";
var EXT_NAME = "comfy.touch-tooltips";
var LONG_PRESS_MS = 450;
var MOVE_TOLERANCE_PX = 10;
var SOCKET_HIT_RADIUS_PX = 14;
var POPOVER_ID = "ttt-popover";
var STYLE_ID = "ttt-style";
var ATTACH_RETRY_MS = 250;
var ATTACH_MAX_RETRIES = 40;
var ENABLE_FOR_MOUSE = false;
var CSS = `
#${POPOVER_ID} {
    position: fixed;
    z-index: 10000;
    max-width: min(360px, calc(100vw - 24px));
    background: rgba(18, 18, 22, 0.97);
    color: #e8e8ea;
    border: 1px solid #3a3a44;
    border-radius: 8px;
    padding: 10px 12px 12px;
    font-family: system-ui, -apple-system, "Segoe UI", sans-serif;
    font-size: 13px;
    line-height: 1.45;
    box-shadow: 0 8px 28px rgba(0, 0, 0, 0.5);
    pointer-events: auto;
    user-select: none;
    -webkit-user-select: none;
    word-wrap: break-word;
    overflow-wrap: anywhere;
}
#${POPOVER_ID} .ttt-label {
    display: block;
    font-weight: 600;
    color: #9ec6ff;
    margin-bottom: 4px;
    font-size: 12px;
    letter-spacing: 0.02em;
}
#${POPOVER_ID} .ttt-sub {
    color: #b8b8c0;
    font-weight: 400;
    margin-left: 6px;
}
#${POPOVER_ID} .ttt-empty {
    color: #8a8a92;
    font-style: italic;
}
#${POPOVER_ID} .ttt-hint {
    margin-top: 8px;
    padding-top: 6px;
    border-top: 1px solid #2a2a32;
    font-size: 11px;
    color: #777;
}
`;
function lookupInputSpec(node, inputName) {
  const nd = node.constructor?.nodeData;
  if (!nd?.input)
    return null;
  const required = nd.input.required || {};
  const optional = nd.input.optional || {};
  return required[inputName] || optional[inputName] || null;
}
function tooltipFromInputSpec(spec) {
  if (!spec)
    return null;
  const opts = spec[1];
  if (opts && typeof opts === "object" && typeof opts.tooltip === "string") {
    return opts.tooltip;
  }
  return null;
}
function widgetHeight(node, w) {
  try {
    if (typeof w.computeSize === "function") {
      const sz = w.computeSize(node.size?.[0] ?? 200);
      if (Array.isArray(sz) && typeof sz[1] === "number" && sz[1] > 0)
        return sz[1];
    }
  } catch (err) {
    console.warn(`[${EXT_NAME}] widget.computeSize threw; using default height`, err);
  }
  const lg = typeof window !== "undefined" && window.LiteGraph || null;
  return lg?.NODE_WIDGET_HEIGHT || 20;
}
function hitTestWidget(node, lx, ly) {
  if (!node.widgets || node.flags?.collapsed)
    return null;
  for (const w of node.widgets) {
    if (w.hidden || w.options?.hidden)
      continue;
    const y = w.last_y;
    if (typeof y !== "number")
      continue;
    const h = widgetHeight(node, w);
    const width = node.size?.[0] ?? 200;
    if (ly >= y && ly <= y + h && lx >= 0 && lx <= width) {
      return w;
    }
  }
  return null;
}
function hitTestSocket(node, gx, gy) {
  if (node.flags?.collapsed)
    return null;
  const r2 = SOCKET_HIT_RADIUS_PX * SOCKET_HIT_RADIUS_PX;
  const check = (isInput, slots) => {
    if (!slots)
      return null;
    for (let i = 0;i < slots.length; i++) {
      try {
        const p = node.getConnectionPos(isInput, i);
        if (!p)
          continue;
        const dx = gx - p[0];
        const dy = gy - p[1];
        if (dx * dx + dy * dy <= r2) {
          return { isInput, index: i, slot: slots[i] };
        }
      } catch (err) {
        console.warn(`[${EXT_NAME}] getConnectionPos threw; skipping slot ${i}`, err);
      }
    }
    return null;
  };
  return check(true, node.inputs) || check(false, node.outputs);
}
function hitTestTitle(node, lx, ly) {
  if (node.flags?.collapsed)
    return true;
  const lg = typeof window !== "undefined" && window.LiteGraph || null;
  const titleH = lg?.NODE_TITLE_HEIGHT || 30;
  const width = node.size?.[0] ?? 200;
  return ly >= -titleH && ly <= 0 && lx >= 0 && lx <= width;
}
function resolveTooltipForHit(node, hit) {
  if (hit.type === "widget") {
    const w = hit.widget;
    const fromOpts = w.options && typeof w.options.tooltip === "string" ? w.options.tooltip : null;
    const fromSpec = tooltipFromInputSpec(lookupInputSpec(node, w.name ?? ""));
    const text = fromOpts || fromSpec;
    return { label: w.name || "(widget)", sub: w.type || "", text };
  }
  if (hit.type === "socket") {
    const { isInput, index, slot } = hit.socket;
    const name = slot?.name || (isInput ? "input" : "output");
    let text = typeof slot?.tooltip === "string" && slot.tooltip || null;
    if (!text && isInput) {
      text = tooltipFromInputSpec(lookupInputSpec(node, name));
    }
    if (!text && !isInput) {
      const nd = node.constructor?.nodeData;
      const tips = nd?.output_tooltips;
      if (Array.isArray(tips) && typeof tips[index] === "string") {
        text = tips[index];
      }
    }
    const type = slot?.type;
    const sub = type ? `${isInput ? "input" : "output"} · ${type}` : isInput ? "input" : "output";
    return { label: name, sub, text };
  }
  if (hit.type === "title") {
    const nd = node.constructor?.nodeData;
    const desc = nd?.description || null;
    return {
      label: node.title || node.type || "(node)",
      sub: node.type || "",
      text: desc
    };
  }
  return null;
}
function clampPopover(x, y, w, h, vw, vh) {
  let left = x + 14;
  let top = y + 14;
  if (left + w > vw - 8)
    left = Math.max(8, x - w - 14);
  if (top + h > vh - 8)
    top = Math.max(8, y - h - 14);
  if (left < 8)
    left = 8;
  if (top < 8)
    top = 8;
  return { left, top };
}
function ensureStyle() {
  if (document.getElementById(STYLE_ID))
    return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = CSS;
  document.head.appendChild(style);
}
function dismissPopover() {
  const el = document.getElementById(POPOVER_ID);
  if (el)
    el.remove();
}
function showPopover(x, y, label, sub, text) {
  dismissPopover();
  const el = document.createElement("div");
  el.id = POPOVER_ID;
  const labelEl = document.createElement("div");
  labelEl.className = "ttt-label";
  labelEl.textContent = label;
  if (sub) {
    const subEl = document.createElement("span");
    subEl.className = "ttt-sub";
    subEl.textContent = sub;
    labelEl.appendChild(subEl);
  }
  el.appendChild(labelEl);
  const body = document.createElement("div");
  if (text) {
    body.textContent = text;
  } else {
    body.className = "ttt-empty";
    body.textContent = "(no tooltip)";
  }
  el.appendChild(body);
  const hint = document.createElement("div");
  hint.className = "ttt-hint";
  hint.textContent = "Tap elsewhere to dismiss";
  el.appendChild(hint);
  document.body.appendChild(el);
  const rect = el.getBoundingClientRect();
  const { left, top } = clampPopover(x, y, rect.width, rect.height, window.innerWidth, window.innerHeight);
  el.style.left = `${left}px`;
  el.style.top = `${top}px`;
}
function attach(attempt = 0) {
  const canvas = app.canvas;
  const el = canvas?.canvas;
  if (!canvas || !el) {
    if (attempt >= ATTACH_MAX_RETRIES) {
      console.warn(`[${EXT_NAME}] app.canvas never materialized after ${ATTACH_MAX_RETRIES} attempts — long-press tooltips not installed`);
      return;
    }
    setTimeout(() => attach(attempt + 1), ATTACH_RETRY_MS);
    return;
  }
  let pressTimer = null;
  let startClientX = 0;
  let startClientY = 0;
  const CAPTURE = { capture: true, passive: true };
  const cancel = () => {
    if (pressTimer) {
      clearTimeout(pressTimer);
      pressTimer = null;
    }
  };
  el.addEventListener("pointerdown", (e) => {
    if (e.pointerType === "mouse" && !ENABLE_FOR_MOUSE)
      return;
    if (isModalActive())
      return;
    startClientX = e.clientX;
    startClientY = e.clientY;
    cancel();
    const screenX = e.clientX;
    const screenY = e.clientY;
    pressTimer = setTimeout(() => {
      pressTimer = null;
      let graphPos;
      try {
        graphPos = canvas.convertEventToCanvasOffset(e);
      } catch (err) {
        console.warn(`[${EXT_NAME}] convertEventToCanvasOffset threw; ignoring long-press`, err);
        return;
      }
      if (!graphPos)
        return;
      const [gx, gy] = graphPos;
      const nodeList = canvas.visible_nodes || canvas.graph?._nodes || [];
      const node = canvas.graph?.getNodeOnPos ? canvas.graph.getNodeOnPos(gx, gy, nodeList) : null;
      if (!node)
        return;
      const lx = gx - node.pos[0];
      const ly = gy - node.pos[1];
      const socketHit = hitTestSocket(node, gx, gy);
      let hit = null;
      if (socketHit) {
        hit = { type: "socket", socket: socketHit };
      } else {
        const widget = hitTestWidget(node, lx, ly);
        if (widget) {
          hit = { type: "widget", widget };
        } else if (hitTestTitle(node, lx, ly)) {
          hit = { type: "title" };
        }
      }
      if (!hit)
        return;
      const info = resolveTooltipForHit(node, hit);
      if (!info)
        return;
      claimPointer("touch-tooltips");
      showPopover(screenX, screenY, info.label, info.sub, info.text);
    }, LONG_PRESS_MS);
  }, CAPTURE);
  el.addEventListener("pointermove", (e) => {
    if (!pressTimer)
      return;
    if (Math.abs(e.clientX - startClientX) > MOVE_TOLERANCE_PX || Math.abs(e.clientY - startClientY) > MOVE_TOLERANCE_PX) {
      cancel();
    }
  }, CAPTURE);
  el.addEventListener("pointerup", cancel, CAPTURE);
  el.addEventListener("pointercancel", cancel, CAPTURE);
  el.addEventListener("pointerleave", cancel, CAPTURE);
  document.addEventListener("pointerdown", (e) => {
    const pop = document.getElementById(POPOVER_ID);
    if (!pop)
      return;
    if (!pop.contains(e.target))
      dismissPopover();
  }, { capture: true });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape")
      dismissPopover();
  });
  console.log(`[${EXT_NAME}] long-press tooltip layer installed — long-press a widget, socket, or title`);
}
app.registerExtension({
  name: EXT_NAME,
  async setup() {
    ensureStyle();
    attach();
  }
});
export {
  widgetHeight,
  tooltipFromInputSpec,
  resolveTooltipForHit,
  lookupInputSpec,
  hitTestWidget,
  hitTestTitle,
  hitTestSocket,
  clampPopover
};
