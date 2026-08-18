// @vitest-environment jsdom
//
// The gesture layer, driven through real DOM events. The pure suite
// (touch-tooltips.test.js) covers hit-testing and tooltip resolution; this one
// covers WHEN the popover is committed — the press window that keeps this pack
// off the gesture ComfyUI's own `Comfy.SimpleTouchSupport` uses for LiteGraph's
// context menu (issue #6).
//
// ── DISPATCH AT THE CANVAS, NEVER AT `document` ──────────────────────────────
// attach() binds every pointer listener to the canvas ELEMENT with
// { capture: true }. An event dispatched at `document` propagates DOWNWARD to
// its target, so it never reaches a listener on a descendant — meaning "the
// popover did not appear" would be true by construction, with or without the
// code under test. Every dispatch below therefore lands on `canvasEl`, which is
// where a real pointer event lands.
//
// ── WHAT THIS TIER CANNOT ASSERT ─────────────────────────────────────────────
// jsdom has no layout, no touch stack, and does not run ComfyUI, so none of the
// following is checked here — they belong to the real-browser tier
// (`comfyui-plugin:comfyui-pack-live-smoke`) on a device with a touchscreen:
//   • That ComfyUI's `touchend` handler and this pack's `pointerup` handler
//     really do read the same wall clock within a millisecond of each other.
//     The exclusivity argument rests on both using `Date.now()` on the same
//     physical press; the browser's pointerdown/touchstart dispatch order is
//     not reproduced here.
//   • Whether a 450–600 ms release window is comfortable for a human thumb, or
//     whether the native context menu is intrusive enough to be worth this
//     trade at all. That is the on-device judgement issue #6 asks for and it
//     HAS NOT BEEN MADE.
//   • Popover placement (clampPopover's inputs come from getBoundingClientRect,
//     which is all zeroes in jsdom).
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
// Side-effect import: evaluating the module registers the extension against the
// mocked app, which is how the suite gets hold of setup().
import "../../src/index.ts";
import { __registered, app } from "./__mocks__/app.js";

const POPOVER = "#ttt-popover";

/** A node whose widget band is y ∈ [40, 60] across the full 200px width. */
const NODE = {
  pos: [0, 0],
  size: [200, 100],
  widgets: [
    {
      name: "steps",
      type: "number",
      last_y: 40,
      computeSize: () => [200, 20],
      options: { tooltip: "How many sampling steps to run" },
    },
  ],
  getConnectionPos: () => null,
  constructor: { nodeData: { description: "a node" } },
};

let canvasEl;

/** Dispatch a touch pointer event at the canvas, where a real one would land. */
const at = (type, x, y) => {
  canvasEl.dispatchEvent(
    new PointerEvent(type, { pointerType: "touch", clientX: x, clientY: y, bubbles: true }),
  );
};

const popover = () => document.querySelector(POPOVER);

/**
 * Press at (x, y), hold for `heldMs`, release. `moveTo` dispatches one
 * pointermove partway through; `interrupt` dispatches that event type instead
 * of letting the hold run clean.
 */
const press = (heldMs, { x = 10, y = 45, moveTo = null, interrupt = null } = {}) => {
  at("pointerdown", x, y);
  if (moveTo) {
    vi.advanceTimersByTime(Math.floor(heldMs / 2));
    at("pointermove", moveTo[0], moveTo[1]);
    vi.advanceTimersByTime(heldMs - Math.floor(heldMs / 2));
  } else {
    vi.advanceTimersByTime(heldMs);
  }
  if (interrupt) at(interrupt, x, y);
  at("pointerup", x, y);
};

describe("comfyui-touch-tooltips long-press gesture", () => {
  beforeAll(() => {
    canvasEl = document.createElement("canvas");
    document.body.appendChild(canvasEl);
    app.canvas = {
      canvas: canvasEl,
      visible_nodes: [NODE],
      graph: {
        _nodes: [NODE],
        // Client coords map 1:1 to graph coords via convertEventToCanvasOffset
        // below, so the node occupies the region its own geometry describes.
        getNodeOnPos: (gx, gy, nodes) =>
          gx >= 0 && gx <= 200 && gy >= -30 && gy <= 100 ? nodes[0] : null,
      },
      convertEventToCanvasOffset: (e) => [e.clientX, e.clientY],
    };
    __registered.at(-1).setup();
  });

  beforeEach(() => {
    vi.useFakeTimers();
    popover()?.remove();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("commits on a release inside the window and declines the presses the native context menu owns", () => {
    // 500 ms: past this pack's floor, below the 600 ms at which ComfyUI's own
    // touchend handler opens LiteGraph's context menu. Ours.
    press(500);
    expect(popover()).not.toBeNull();
    expect(popover().textContent).toContain("How many sampling steps to run");
    expect(popover().textContent).toContain("steps");

    // 700 ms: the native menu fires for this press, so this pack must not.
    // Paired with the assertion above in one test — a "did not fire" that has
    // no "did fire" beside it passes just as happily against a handler that
    // never fires at all.
    popover().remove();
    press(700);
    expect(popover()).toBeNull();
  });

  it("ignores a release below the long-press floor", () => {
    press(200);
    expect(popover()).toBeNull();

    press(500);
    expect(popover()).not.toBeNull();
  });

  it("cancels on a move past MOVE_TOLERANCE_PX but tolerates a smaller one", () => {
    press(500, { moveTo: [10 + 4, 45 + 4] });
    expect(popover()).not.toBeNull();

    popover().remove();
    press(500, { moveTo: [10 + 12, 45] });
    expect(popover()).toBeNull();
  });

  it("disarms on pointercancel", () => {
    press(500, { interrupt: "pointercancel" });
    expect(popover()).toBeNull();

    press(500);
    expect(popover()).not.toBeNull();
  });
});
