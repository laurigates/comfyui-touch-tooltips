// Touch Tooltips — ComfyUI frontend extension (canvas-gesture pack).
//
// Served at /extensions/comfyui-touch-tooltips/index.js — the pack directory
// name IS this URL segment (EXT_NAME mirrors it, per the family convention).
// Renaming the pack dir breaks every fetch of the served file.
//
// Pattern ("the tooltip vein"): touch devices have no hover, so the rich
// tooltip metadata ComfyUI declares on widgets/sockets/nodes is invisible on
// mobile. This pack adds a CANVAS-LEVEL long-press handler that hit-tests the
// tap against the node under it (socket → widget → title, in that precedence)
// and surfaces the matching tooltip text in a dismissible popover. Additive +
// mobile-first: if app.canvas or the pointer model is absent it does nothing,
// and it never mutates the graph (read-only hit-testing + a transient DOM
// popover) so no workflow can break.
//
// ARCHITECTURE: the hit-testing and tooltip-resolution logic lives in PURE
// helpers (lookupInputSpec, tooltipFromInputSpec, widgetHeight, hitTestWidget,
// hitTestSocket, hitTestTitle, resolveTooltipForHit, clampPopover) that take
// plain LiteGraph-node data and return plain results. They never touch `app`
// and only `widgetHeight`/`hitTestTitle` read `window.LiteGraph` (defensively),
// so they are unit-tested in tests/js. The DOM wiring (dismissPopover,
// showPopover, attach) is a thin adapter: events → hit data,
// resolved tooltip → popover. It is exercised in the manual browser matrix.
//
// ComfyUI serves its frontend API at runtime from `/scripts/app.js`. The
// emitted import string stays `/scripts/app.js` (bun's `--external '/scripts/*'`
// keeps it unbundled); the type is supplied via a `paths` mapping in
// tsconfig.json that points the import at `src/comfyui-shims.d.ts`.

import { claimPointer, ensureStyleOnce, isModalActive } from "@laurigates/comfy-modal-kit";
import { app } from "/scripts/app.js";

// The pack-dir/URL segment and the prefix stamped on every console line this
// pack emits ([comfyui-touch-tooltips]) — the family convention (kit
// ADR-0002). The registerExtension name below stays the historical
// "comfy.touch-tooltips" so users' enable/disable state is preserved.
const EXT_NAME = "comfyui-touch-tooltips";

// Tunables
const LONG_PRESS_MS = 450;
const MOVE_TOLERANCE_PX = 10;
const SOCKET_HIT_RADIUS_PX = 14;
const POPOVER_ID = "ttt-popover";
const STYLE_ID = "ttt-style";
// attach() polls for app.canvas at this cadence; bound the retries so a canvas
// that never materializes surfaces a single diagnostic instead of looping forever.
const ATTACH_RETRY_MS = 250;
const ATTACH_MAX_RETRIES = 40; // ~10s of polling before giving up

// Set to true to also trigger on mouse (useful for dev/testing on desktop).
const ENABLE_FOR_MOUSE = false;

const CSS = `
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

// ============================================================
// Types
// ============================================================

/** A 2-tuple of [x, y] / [w, h] used throughout the geometry. */
type Vec2 = [number, number];

/**
 * A raw `INPUT_TYPES` spec entry: `[type, opts]`. The opts object carries the
 * declared tooltip among other widget options. Modelled loosely because the
 * registered node-def preserves whatever Python emitted.
 */
type InputSpec = [unknown, (Record<string, unknown> & { tooltip?: unknown }) | undefined];

/**
 * The registered node definition (`node.constructor.nodeData`) — same shape
 * Python's `INPUT_TYPES` returned, with `[type, opts]` tuples preserved, plus
 * the node-level `description` and per-output `output_tooltips`. Only the
 * members this pack reads are declared.
 */
interface NodeData {
  input?: {
    required?: Record<string, InputSpec>;
    optional?: Record<string, InputSpec>;
  };
  output_tooltips?: unknown[];
  description?: string;
}

/**
 * Minimal structural shape of a LiteGraph widget this pack reaches into. The
 * package's widget type is not exported, so the narrow surface used here is
 * modelled locally. Only the members actually touched are declared.
 */
interface Widget {
  name?: string;
  type?: string;
  hidden?: boolean;
  options?: (Record<string, unknown> & { hidden?: boolean; tooltip?: unknown }) | undefined;
  last_y?: number;
  computeSize?: (width: number) => unknown;
}

/**
 * Minimal structural shape of a LiteGraph input/output slot. `link`/`links`
 * are unused by the tooltip resolver but declared for completeness of the
 * slot surface this pack touches.
 */
interface Slot {
  name?: string;
  type?: string | number;
  link?: number | null;
  links?: number[] | null;
  tooltip?: unknown;
}

/**
 * Minimal structural shape of a LiteGraph node this pack reaches into. The
 * package's `LGraphNode` type is not exported, so the small surface used here
 * is modelled locally (narrow blast radius).
 */
interface GraphNode {
  pos: Vec2;
  size?: Vec2;
  widgets?: Widget[] | null;
  inputs?: Slot[] | null;
  outputs?: Slot[] | null;
  flags?: { collapsed?: boolean } | undefined;
  title?: string;
  type?: string;
  constructor?: { nodeData?: NodeData };
  getConnectionPos(isInput: boolean, index: number): Vec2 | null | undefined;
}

/** The minified-canvas surface this pack reads. All members are optional/defensive. */
interface CanvasLike {
  canvas?: HTMLCanvasElement;
  visible_nodes?: GraphNode[];
  graph?: {
    _nodes?: GraphNode[];
    getNodeOnPos?: (x: number, y: number, nodes: GraphNode[]) => GraphNode | null | undefined;
  };
  convertEventToCanvasOffset(e: Event): Vec2 | null | undefined;
}

/** A LiteGraph socket hit: which slot (input vs output, index) was hit. */
interface SocketHit {
  isInput: boolean;
  index: number;
  slot: Slot | undefined;
}

/** Discriminated hit result: a widget, a socket, or the node's title region. */
type Hit =
  | { type: "widget"; widget: Widget }
  | { type: "socket"; socket: SocketHit }
  | { type: "title" };

/** Resolved popover content for a hit. */
interface TooltipInfo {
  label: string;
  sub: string;
  text: string | null;
}

// --- Pure helpers (unit-tested) ----------------------------------------- //

/**
 * Find the raw `[type, opts]` spec for a named input on a node, walking the
 * registered node-def's required then optional maps. Returns null when the
 * node-def or the named input is absent.
 */
export function lookupInputSpec(node: GraphNode, inputName: string): InputSpec | null {
  const nd = node.constructor?.nodeData;
  if (!nd?.input) return null;
  const required = nd.input.required || {};
  const optional = nd.input.optional || {};
  return required[inputName] || optional[inputName] || null;
}

/**
 * Extract a string `tooltip` from a raw input spec's opts object, or null when
 * the spec is missing or carries no string tooltip.
 */
export function tooltipFromInputSpec(spec: InputSpec | null): string | null {
  if (!spec) return null;
  const opts = spec[1];
  if (opts && typeof opts === "object" && typeof opts.tooltip === "string") {
    return opts.tooltip;
  }
  return null;
}

/**
 * On-canvas pixel height of a widget. Prefers the widget's own computeSize(),
 * falling back to LiteGraph.NODE_WIDGET_HEIGHT (or 20). Defensive: a throwing
 * or non-numeric computeSize falls through to the constant.
 */
export function widgetHeight(node: GraphNode, w: Widget): number {
  try {
    if (typeof w.computeSize === "function") {
      const sz = w.computeSize(node.size?.[0] ?? 200);
      if (Array.isArray(sz) && typeof sz[1] === "number" && sz[1] > 0) return sz[1];
    }
  } catch (err) {
    // Defensive fallback to the constant height below — a throwing computeSize
    // must not break hit-testing, but make the fallback observable.
    console.warn(`[${EXT_NAME}] widget.computeSize threw; using default height`, err);
  }
  const lg =
    (typeof window !== "undefined" &&
      (window as unknown as { LiteGraph?: { NODE_WIDGET_HEIGHT?: number } }).LiteGraph) ||
    null;
  return lg?.NODE_WIDGET_HEIGHT || 20;
}

/**
 * Hit-test node-local (lx, ly) against the node's visible widgets. Skips hidden
 * widgets and returns null on a collapsed node or when no widget contains the
 * point. `last_y` is the widget's y-offset within the node, set on each draw.
 */
export function hitTestWidget(node: GraphNode, lx: number, ly: number): Widget | null {
  if (!node.widgets || node.flags?.collapsed) return null;
  for (const w of node.widgets) {
    if (w.hidden || w.options?.hidden) continue;
    const y = w.last_y;
    if (typeof y !== "number") continue;
    const h = widgetHeight(node, w);
    const width = node.size?.[0] ?? 200;
    if (ly >= y && ly <= y + h && lx >= 0 && lx <= width) {
      return w;
    }
  }
  return null;
}

/**
 * Hit-test graph-space (gx, gy) against the node's input then output sockets,
 * within a fixed touch radius. Uses the canonical socket positions from
 * getConnectionPos. Returns null on a collapsed node or when nothing is in
 * range. Defensive: a throwing getConnectionPos skips that slot.
 */
export function hitTestSocket(node: GraphNode, gx: number, gy: number): SocketHit | null {
  if (node.flags?.collapsed) return null;
  const r2 = SOCKET_HIT_RADIUS_PX * SOCKET_HIT_RADIUS_PX;
  const check = (isInput: boolean, slots: Slot[] | null | undefined): SocketHit | null => {
    if (!slots) return null;
    for (let i = 0; i < slots.length; i++) {
      try {
        const p = node.getConnectionPos(isInput, i);
        if (!p) continue;
        const dx = gx - p[0];
        const dy = gy - p[1];
        if (dx * dx + dy * dy <= r2) {
          return { isInput, index: i, slot: slots[i] };
        }
      } catch (err) {
        // A throwing getConnectionPos skips this slot rather than aborting the
        // whole hit-test; surface it so the skipped slot is observable.
        console.warn(`[${EXT_NAME}] getConnectionPos threw; skipping slot ${i}`, err);
      }
    }
    return null;
  };
  return check(true, node.inputs) || check(false, node.outputs);
}

/**
 * Hit-test node-local (lx, ly) against the node's title band. A collapsed node
 * counts any body hit as a title hit. Otherwise the title is the strip just
 * above the body: ly ∈ [-NODE_TITLE_HEIGHT, 0] within the node width.
 */
export function hitTestTitle(node: GraphNode, lx: number, ly: number): boolean {
  if (node.flags?.collapsed) return true; // any hit on collapsed body counts as title
  const lg =
    (typeof window !== "undefined" &&
      (window as unknown as { LiteGraph?: { NODE_TITLE_HEIGHT?: number } }).LiteGraph) ||
    null;
  const titleH = lg?.NODE_TITLE_HEIGHT || 30;
  const width = node.size?.[0] ?? 200;
  return ly >= -titleH && ly <= 0 && lx >= 0 && lx <= width;
}

/**
 * Resolve the popover content (label / sub / text) for a hit, walking the
 * tooltip lookup chain:
 *   • widget — widget.options.tooltip, then the input-spec fallback;
 *   • socket — slot.tooltip, then input-spec (inputs) / output_tooltips
 *     (outputs) fallback;
 *   • title  — the node-level description.
 * Returns null only for an unrecognized hit type.
 */
export function resolveTooltipForHit(node: GraphNode, hit: Hit): TooltipInfo | null {
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
    let text: string | null = (typeof slot?.tooltip === "string" && slot.tooltip) || null;
    if (!text && isInput) {
      text = tooltipFromInputSpec(lookupInputSpec(node, name));
    }
    if (!text && !isInput) {
      const nd = node.constructor?.nodeData;
      const tips = nd?.output_tooltips;
      if (Array.isArray(tips) && typeof tips[index] === "string") {
        text = tips[index] as string;
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
      text: desc,
    };
  }
  return null;
}

/**
 * Viewport-clamp math for the popover. Given the desired anchor (x, y), the
 * popover's measured size (w, h), and the viewport (vw, vh), return the
 * {left, top} that keeps it on-screen: offset 14px from the tap, flip to the
 * other side of the tap when it would overflow the right/bottom edge, and
 * never let either coordinate fall below 8px.
 */
export function clampPopover(
  x: number,
  y: number,
  w: number,
  h: number,
  vw: number,
  vh: number,
): { left: number; top: number } {
  let left = x + 14;
  let top = y + 14;
  if (left + w > vw - 8) left = Math.max(8, x - w - 14);
  if (top + h > vh - 8) top = Math.max(8, y - h - 14);
  if (left < 8) left = 8;
  if (top < 8) top = 8;
  return { left, top };
}

// --- DOM adapter (browser-matrix tested) -------------------------------- //

function dismissPopover(): void {
  const el = document.getElementById(POPOVER_ID);
  if (el) el.remove();
}

function showPopover(x: number, y: number, label: string, sub: string, text: string | null): void {
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

  // Position near tap, clamp inside viewport.
  const rect = el.getBoundingClientRect();
  const { left, top } = clampPopover(
    x,
    y,
    rect.width,
    rect.height,
    window.innerWidth,
    window.innerHeight,
  );
  el.style.left = `${left}px`;
  el.style.top = `${top}px`;
}

function attach(attempt = 0): void {
  const canvas = app.canvas as unknown as CanvasLike | undefined;
  const el = canvas?.canvas;
  if (!canvas || !el) {
    if (attempt >= ATTACH_MAX_RETRIES) {
      console.warn(
        `[${EXT_NAME}] app.canvas never materialized after ${ATTACH_MAX_RETRIES} attempts — long-press tooltips not installed`,
      );
      return;
    }
    setTimeout(() => attach(attempt + 1), ATTACH_RETRY_MS);
    return;
  }

  let pressTimer: ReturnType<typeof setTimeout> | null = null;
  let startClientX = 0;
  let startClientY = 0;

  // Listen in the CAPTURE phase: LiteGraph's own canvas pointerdown handler
  // stops propagation before the bubble phase, so a bubble-phase listener here
  // would never fire on the real ComfyUI canvas. Capture runs first. passive:
  // true — we only read the event, never preventDefault.
  const CAPTURE: AddEventListenerOptions = { capture: true, passive: true };

  const cancel = (): void => {
    if (pressTimer) {
      clearTimeout(pressTimer);
      pressTimer = null;
    }
  };

  el.addEventListener(
    "pointerdown",
    (e: PointerEvent) => {
      if (e.pointerType === "mouse" && !ENABLE_FOR_MOUSE) return;
      // Pointer-claim protocol (comfy-modal-kit): if any pack has a modal
      // open, don't start a long-press. Defense-in-depth — a canvas-scoped
      // listener usually can't fire over a full-screen modal backdrop anyway,
      // but the veto makes the deference explicit and robust.
      if (isModalActive()) return;
      startClientX = e.clientX;
      startClientY = e.clientY;
      cancel();
      const screenX = e.clientX;
      const screenY = e.clientY;
      pressTimer = setTimeout(() => {
        pressTimer = null;
        let graphPos: Vec2 | null | undefined;
        try {
          graphPos = canvas.convertEventToCanvasOffset(e);
        } catch (err) {
          console.warn(`[${EXT_NAME}] convertEventToCanvasOffset threw; ignoring long-press`, err);
          return;
        }
        if (!graphPos) return;
        const [gx, gy] = graphPos;
        const nodeList = canvas.visible_nodes || canvas.graph?._nodes || [];
        const node = canvas.graph?.getNodeOnPos
          ? canvas.graph.getNodeOnPos(gx, gy, nodeList)
          : null;
        if (!node) return;

        const lx = gx - node.pos[0];
        const ly = gy - node.pos[1];

        const socketHit = hitTestSocket(node, gx, gy);
        let hit: Hit | null = null;
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
        if (!hit) return;

        const info = resolveTooltipForHit(node, hit);
        if (!info) return;
        // A real long-press tooltip is committed — claim the pointer so peer
        // packs can observe who owns this gesture (advisory; part of the
        // comfy-modal-kit pointer-claim protocol).
        claimPointer("touch-tooltips");
        showPopover(screenX, screenY, info.label, info.sub, info.text);
      }, LONG_PRESS_MS);
    },
    CAPTURE,
  );

  el.addEventListener(
    "pointermove",
    (e: PointerEvent) => {
      if (!pressTimer) return;
      if (
        Math.abs(e.clientX - startClientX) > MOVE_TOLERANCE_PX ||
        Math.abs(e.clientY - startClientY) > MOVE_TOLERANCE_PX
      ) {
        cancel();
      }
    },
    CAPTURE,
  );

  el.addEventListener("pointerup", cancel, CAPTURE);
  el.addEventListener("pointercancel", cancel, CAPTURE);
  el.addEventListener("pointerleave", cancel, CAPTURE);

  // Dismiss on tap outside the popover.
  document.addEventListener(
    "pointerdown",
    (e: PointerEvent) => {
      const pop = document.getElementById(POPOVER_ID);
      if (!pop) return;
      if (!pop.contains(e.target as Node)) dismissPopover();
    },
    { capture: true },
  );

  document.addEventListener("keydown", (e: KeyboardEvent) => {
    if (e.key === "Escape") dismissPopover();
  });

  console.log(
    `[${EXT_NAME}] long-press tooltip layer installed — long-press a widget, socket, or title`,
  );
}

app.registerExtension({
  // Historical registration id — NOT EXT_NAME. Renaming it would reset
  // users' extension enable/disable state.
  name: "comfy.touch-tooltips",
  async setup() {
    ensureStyleOnce(STYLE_ID, CSS);
    attach();
  },
});
