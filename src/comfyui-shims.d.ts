// ComfyUI serves its frontend API at runtime from `/scripts/app.js`. The
// `@comfyorg/comfyui-frontend-types` package only types the bare-package
// symbols, not that served-path module. TypeScript will not match an ambient
// `declare module` against a rooted (`/…`) path specifier, so instead a
// `paths` mapping in tsconfig.json points the `/scripts/app.js` import at this
// declaration file. The emitted import string stays `/scripts/app.js` (bun's
// `--external '/scripts/*'` keeps it unbundled, resolved at runtime against
// ComfyUI's served module).
//
// This pack reaches into LiteGraph internals via `app.canvas` (convertEvent…,
// getNodeOnPos, getConnectionPos). Those live behind loosely-typed members on
// ComfyApp, so index.ts narrows them with its OWN local interfaces
// (CanvasLike / GraphNode / …) and casts `app.canvas`. The shim therefore
// stays minimal — identical to the touch-resize sibling.
import type { ComfyApp } from "@comfyorg/comfyui-frontend-types";

export declare const app: ComfyApp;
