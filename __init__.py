"""Touch-friendly tooltips for ComfyUI.

Frontend-only pack: no Python nodes. Adds long-press hit-testing on the
LiteGraph canvas so widgets and sockets surface their existing tooltip
metadata on touch devices.

The extension is authored in TypeScript (``src/index.ts``) and compiled
to browser ESM via ``bun build``, emitted to ``web/dist/`` — which is
what ``WEB_DIRECTORY`` points at. Do not edit ``web/dist/`` by hand;
change ``src/index.ts`` and rebuild.
"""

WEB_DIRECTORY = "./web/dist"

NODE_CLASS_MAPPINGS = {}
NODE_DISPLAY_NAME_MAPPINGS = {}

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]
