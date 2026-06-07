import { describe, expect, it } from "vitest";
import {
  clampPopover,
  hitTestSocket,
  hitTestTitle,
  hitTestWidget,
  lookupInputSpec,
  resolveTooltipForHit,
  tooltipFromInputSpec,
} from "../../src/index.ts";

// Pure hit-test / tooltip-resolution helpers. Importing the module also
// confirms the registerExtension wiring loads cleanly under the
// node-environment harness (app is mocked via __mocks__/app.js).

// A small node factory so each test only specifies what it cares about.
const makeNode = (over = {}) => ({
  pos: [0, 0],
  size: [200, 100],
  getConnectionPos: () => null,
  ...over,
});

describe("hitTestWidget", () => {
  it("returns the widget whose band contains the point", () => {
    const w = { name: "steps", type: "number", last_y: 40, computeSize: () => [200, 20] };
    const node = makeNode({ widgets: [w] });
    expect(hitTestWidget(node, 10, 45)).toBe(w);
  });

  it("returns null when the point is outside every widget band", () => {
    const w = { name: "steps", last_y: 40, computeSize: () => [200, 20] };
    const node = makeNode({ widgets: [w] });
    expect(hitTestWidget(node, 10, 200)).toBeNull();
  });

  it("respects the node width on the x-axis", () => {
    const w = { name: "steps", last_y: 40, computeSize: () => [200, 20] };
    const node = makeNode({ size: [200, 100], widgets: [w] });
    expect(hitTestWidget(node, 250, 45)).toBeNull();
  });

  it("skips hidden widgets (widget.hidden and options.hidden)", () => {
    const a = { name: "a", hidden: true, last_y: 40, computeSize: () => [200, 20] };
    const b = { name: "b", options: { hidden: true }, last_y: 40, computeSize: () => [200, 20] };
    const node = makeNode({ widgets: [a, b] });
    expect(hitTestWidget(node, 10, 45)).toBeNull();
  });

  it("returns null on a collapsed node", () => {
    const w = { name: "steps", last_y: 40, computeSize: () => [200, 20] };
    const node = makeNode({ widgets: [w], flags: { collapsed: true } });
    expect(hitTestWidget(node, 10, 45)).toBeNull();
  });
});

describe("hitTestSocket", () => {
  // Place one input socket at graph (10, 10) via a fake getConnectionPos.
  const socketNode = (slot) =>
    makeNode({
      inputs: [slot],
      getConnectionPos: (isInput, i) => (isInput && i === 0 ? [10, 10] : null),
    });

  it("hits a socket within the radius", () => {
    const slot = { name: "image", type: "IMAGE" };
    const hit = hitTestSocket(socketNode(slot), 12, 12);
    expect(hit).toEqual({ isInput: true, index: 0, slot });
  });

  it("misses a socket outside the radius", () => {
    const slot = { name: "image", type: "IMAGE" };
    // 14px radius → (40, 40) is well outside.
    expect(hitTestSocket(socketNode(slot), 40, 40)).toBeNull();
  });

  it("returns null on a collapsed node", () => {
    const slot = { name: "image", type: "IMAGE" };
    const node = makeNode({
      inputs: [slot],
      flags: { collapsed: true },
      getConnectionPos: () => [10, 10],
    });
    expect(hitTestSocket(node, 12, 12)).toBeNull();
  });

  it("falls through to outputs when no input is in range", () => {
    const out = { name: "latent", type: "LATENT" };
    const node = makeNode({
      inputs: [{ name: "in", type: "IMAGE" }],
      outputs: [out],
      getConnectionPos: (isInput, i) => (!isInput && i === 0 ? [50, 50] : [999, 999]),
    });
    const hit = hitTestSocket(node, 52, 52);
    expect(hit).toEqual({ isInput: false, index: 0, slot: out });
  });
});

describe("hitTestTitle", () => {
  it("hits within the title band above the body", () => {
    const node = makeNode({ size: [200, 100] });
    // ly in [-30, 0] within width.
    expect(hitTestTitle(node, 10, -15)).toBe(true);
  });

  it("misses below the title band (in the body)", () => {
    const node = makeNode({ size: [200, 100] });
    expect(hitTestTitle(node, 10, 20)).toBe(false);
  });

  it("treats any hit on a collapsed node as a title hit", () => {
    const node = makeNode({ flags: { collapsed: true } });
    expect(hitTestTitle(node, 500, 500)).toBe(true);
  });
});

describe("lookupInputSpec / tooltipFromInputSpec", () => {
  const node = makeNode({
    constructor: {
      nodeData: {
        input: {
          required: { steps: ["INT", { tooltip: "number of steps" }] },
          optional: { seed: ["INT", { tooltip: "rng seed" }] },
        },
      },
    },
  });

  it("finds a required input spec", () => {
    expect(lookupInputSpec(node, "steps")).toEqual(["INT", { tooltip: "number of steps" }]);
  });

  it("finds an optional input spec", () => {
    expect(lookupInputSpec(node, "seed")).toEqual(["INT", { tooltip: "rng seed" }]);
  });

  it("returns null for a missing input and for a node with no nodeData", () => {
    expect(lookupInputSpec(node, "nope")).toBeNull();
    expect(lookupInputSpec(makeNode(), "steps")).toBeNull();
  });

  it("extracts the tooltip string from a spec, null otherwise", () => {
    expect(tooltipFromInputSpec(["INT", { tooltip: "hi" }])).toBe("hi");
    expect(tooltipFromInputSpec(["INT", {}])).toBeNull();
    expect(tooltipFromInputSpec(["INT", undefined])).toBeNull();
    expect(tooltipFromInputSpec(null)).toBeNull();
  });
});

describe("resolveTooltipForHit", () => {
  it("prefers widget.options.tooltip over the input-spec fallback", () => {
    const node = makeNode({
      constructor: {
        nodeData: { input: { required: { steps: ["INT", { tooltip: "spec tip" }] } } },
      },
    });
    const w = { name: "steps", type: "number", options: { tooltip: "widget tip" } };
    const info = resolveTooltipForHit(node, { type: "widget", widget: w });
    expect(info).toEqual({ label: "steps", sub: "number", text: "widget tip" });
  });

  it("falls back to the input spec when the widget has no option tooltip", () => {
    const node = makeNode({
      constructor: {
        nodeData: { input: { required: { steps: ["INT", { tooltip: "spec tip" }] } } },
      },
    });
    const w = { name: "steps", type: "number" };
    const info = resolveTooltipForHit(node, { type: "widget", widget: w });
    expect(info.text).toBe("spec tip");
  });

  it("resolves an input socket via the input-spec fallback", () => {
    const node = makeNode({
      constructor: {
        nodeData: { input: { required: { image: ["IMAGE", { tooltip: "the image" }] } } },
      },
    });
    const slot = { name: "image", type: "IMAGE" };
    const info = resolveTooltipForHit(node, {
      type: "socket",
      socket: { isInput: true, index: 0, slot },
    });
    expect(info).toEqual({ label: "image", sub: "input · IMAGE", text: "the image" });
  });

  it("prefers slot.tooltip over the input-spec fallback for a socket", () => {
    const node = makeNode({
      constructor: { nodeData: { input: { required: { image: ["IMAGE", { tooltip: "spec" }] } } } },
    });
    const slot = { name: "image", type: "IMAGE", tooltip: "slot tip" };
    const info = resolveTooltipForHit(node, {
      type: "socket",
      socket: { isInput: true, index: 0, slot },
    });
    expect(info.text).toBe("slot tip");
  });

  it("resolves an output socket via output_tooltips by index", () => {
    const node = makeNode({
      constructor: { nodeData: { output_tooltips: ["first out", "second out"] } },
    });
    const slot = { name: "LATENT", type: "LATENT" };
    const info = resolveTooltipForHit(node, {
      type: "socket",
      socket: { isInput: false, index: 1, slot },
    });
    expect(info).toEqual({ label: "LATENT", sub: "output · LATENT", text: "second out" });
  });

  it("resolves a title hit via the node description", () => {
    const node = makeNode({
      title: "KSampler",
      type: "KSampler",
      constructor: { nodeData: { description: "samples a latent" } },
    });
    const info = resolveTooltipForHit(node, { type: "title" });
    expect(info).toEqual({ label: "KSampler", sub: "KSampler", text: "samples a latent" });
  });
});

describe("clampPopover", () => {
  it("offsets 14px from the tap when there is room", () => {
    expect(clampPopover(100, 100, 200, 100, 1000, 1000)).toEqual({ left: 114, top: 114 });
  });

  it("flips to the left of the tap near the right edge", () => {
    // x=950, w=200, vw=1000: 950+14+200 > 1000-8 → flip to 950-200-14 = 736.
    const { left } = clampPopover(950, 100, 200, 100, 1000, 1000);
    expect(left).toBe(736);
  });

  it("flips above the tap near the bottom edge", () => {
    // y=950, h=100, vh=1000: 950+14+100 > 1000-8 → flip to 950-100-14 = 836.
    const { top } = clampPopover(100, 950, 200, 100, 1000, 1000);
    expect(top).toBe(836);
  });

  it("clamps to >= 8 when the flipped position would go off the top-left", () => {
    // Near the bottom-right with a popover larger than the tap offset, the flip
    // math goes negative and is clamped up to 8.
    const { left, top } = clampPopover(10, 10, 400, 400, 420, 420);
    expect(left).toBe(8);
    expect(top).toBe(8);
  });
});
