"""Touch-friendly tooltips for ComfyUI.

Frontend-only pack: no Python nodes. Adds long-press hit-testing on the
LiteGraph canvas so widgets and sockets surface their existing tooltip
metadata on touch devices.
"""

WEB_DIRECTORY = "./web"

NODE_CLASS_MAPPINGS = {}
NODE_DISPLAY_NAME_MAPPINGS = {}

__all__ = ["NODE_CLASS_MAPPINGS", "NODE_DISPLAY_NAME_MAPPINGS", "WEB_DIRECTORY"]
