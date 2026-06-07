// Playwright driver for the README screenshot (long-press tooltip popover).
//
// This pack has no static surface: its popover only appears ~450ms into a live
// touch long-press on the canvas. We synthesize that through the pack's real
// public path — dispatch a TOUCH `pointerdown` on the actual <canvas> element at
// the screen position of a widget that carries tooltip metadata, wait out the
// long-press timer, then screenshot the `#ttt-popover` the pack appends to
// <body>. No graph mutation; read-only hit-test → popover, exactly as on-device.

import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const HERE = dirname(fileURLToPath(import.meta.url));
const WORKFLOW_PATH = resolve(HERE, "workflow.json");
const OUT_DIR = process.env.OUT_DIR || "/out";
const BASE_URL = process.env.COMFYUI_URL || "http://127.0.0.1:8188/";

const POPOVER = "#ttt-popover";
const LONG_PRESS_MS = 450; // must match src/index.ts
const SCALE = 1.25;
// A representative tooltip used only if the frontend bundle doesn't ship one for
// the target widget — keeps the screenshot meaningful and deterministic across
// frontend versions. Real metadata is preferred when present.
const FALLBACK_TOOLTIP = "The random seed used to create the noise for sampling.";
const TARGET_WIDGET = "seed";

async function dismissStartupDialog(page) {
  await page.keyboard.press("Escape");
  await page.waitForTimeout(150);
  await page.evaluate(() => {
    for (const el of document.querySelectorAll(".p-dialog-mask")) el.remove();
  });
}

async function main() {
  const workflow = JSON.parse(await readFile(WORKFLOW_PATH, "utf8"));
  const browser = await chromium.launch({ args: ["--font-render-hinting=none"] });
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 2,
    hasTouch: true,
  });
  const page = await context.newPage();
  page.on("console", (msg) => {
    const t = msg.type();
    if (t === "error" || t === "warning") console.log(`[page:${t}] ${msg.text()}`);
  });

  console.log(`Navigating to ${BASE_URL}...`);
  await page.goto(BASE_URL, { waitUntil: "networkidle" });
  await page.waitForFunction(
    () => window.app && window.app.graph && Array.isArray(window.app.graph._nodes),
    null,
    { timeout: 30_000 },
  );

  console.log("Loading workflow...");
  await page.evaluate((wf) => window.app.loadGraphData(wf, true), workflow);
  await page.waitForFunction(() => window.app.graph._nodes.length >= 1, null, {
    timeout: 10_000,
  });
  await dismissStartupDialog(page);

  console.log("Positioning the node and locating the target widget...");
  const target = await page.evaluate(
    ({ scale, widgetName, fallback }) => {
      const canvas = window.app.canvas;
      const ds = canvas.ds;
      ds.scale = scale;
      const node = window.app.graph._nodes[0];
      // Place the node body's top-left at a comfortable screen spot.
      const screenX = 360;
      const screenY = 180;
      ds.offset[0] = screenX / scale - node.pos[0];
      ds.offset[1] = screenY / scale - node.pos[1];
      canvas.setDirty(true, true);
      canvas.draw(true, true); // populates widget.last_y

      const w = (node.widgets || []).find((x) => x.name === widgetName) || (node.widgets || [])[0];
      if (!w) throw new Error("node has no widgets to target");
      // Ensure a tooltip resolves regardless of frontend version.
      const nd = node.constructor && node.constructor.nodeData;
      const spec =
        nd && nd.input && ((nd.input.required && nd.input.required[w.name]) ||
          (nd.input.optional && nd.input.optional[w.name]));
      const hasSpecTip = spec && spec[1] && typeof spec[1].tooltip === "string";
      const hasOptTip = w.options && typeof w.options.tooltip === "string";
      if (!hasSpecTip && !hasOptTip) {
        w.options = w.options || {};
        w.options.tooltip = fallback;
      }

      const ly = (w.last_y || 0) + 10;
      const lx = (node.size ? node.size[0] : 200) / 2;
      const gx = node.pos[0] + lx;
      const gy = node.pos[1] + ly;
      const rect = canvas.canvas.getBoundingClientRect();
      const clientX = rect.left + (gx + ds.offset[0]) * scale;
      const clientY = rect.top + (gy + ds.offset[1]) * scale;
      // Validate the hit lands on the node before we bother dispatching.
      const found =
        canvas.graph.getNodeOnPos &&
        canvas.graph.getNodeOnPos(gx, gy, canvas.visible_nodes || canvas.graph._nodes);
      const extLoaded = (window.app.extensions || []).some((e) => e?.name === "comfy.touch-tooltips");
      return { clientX, clientY, label: w.name, hitNode: !!found, extLoaded };
    },
    { scale: SCALE, widgetName: TARGET_WIDGET, fallback: FALLBACK_TOOLTIP },
  );
  console.log(
    `extension loaded: ${target.extLoaded}; node under finger: ${target.hitNode}; ` +
      `long-pressing "${target.label}" at (${Math.round(target.clientX)}, ${Math.round(target.clientY)})`,
  );

  // Drive a REAL touch long-press via CDP — the on-device path. A synthetic
  // PointerEvent doesn't populate the fields LiteGraph's
  // convertEventToCanvasOffset reads, so the hit-test silently no-ops. The
  // touch is held (no touchEnd) across the long-press window so the popover
  // appears; we screenshot it, then release.
  const cdp = await context.newCDPSession(page);
  await cdp.send("Input.dispatchTouchEvent", {
    type: "touchStart",
    touchPoints: [{ x: target.clientX, y: target.clientY }],
  });

  console.log("Waiting out the long-press timer + popover...");
  try {
    await page.waitForSelector(POPOVER, { state: "visible", timeout: LONG_PRESS_MS + 4_000 });
    await page.waitForTimeout(250);
    console.log(`Capturing ${OUT_DIR}/tooltip.png...`);
    // Shoot just the popover element — a region clip would catch LiteGraph's
    // own long-press context menu, which also fires on the held touch.
    await page.locator(POPOVER).screenshot({ path: `${OUT_DIR}/tooltip.png` });
  } finally {
    await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
  }
  await browser.close();
}

main().catch((err) => {
  console.error("capture failed:", err);
  process.exit(1);
});
