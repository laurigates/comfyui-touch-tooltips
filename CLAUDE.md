# CLAUDE.md

Frontend-only ComfyUI custom-node pack in the canvas-gesture vein. `__init__.py`
is a loader stub; the extension is authored in TypeScript (`src/index.ts`) and
compiled to browser ESM via `bun build`, emitted to `web/dist/` (see ADR-0001).

## Architecture Decisions

| ID | Title | Domain |
|----|-------|--------|
| [ADR-0001](docs/blueprint/adrs/0001-adopt-typescript-bun-build.md) | Adopt TypeScript + bun build (supersedes the implicit no-bundler / single-file-JS decisions) | build-tooling |
| [ADR-0002](docs/blueprint/adrs/0002-adopt-kit-pointer-claim-protocol.md) | Adopt the comfy-modal-kit pointer-claim protocol (`isModalActive` veto + `claimPointer`) | api-design |

## The pattern ("the vein")

A mobile-first ComfyUI usability pack in the *gesture* vein: instead of
intercepting a single widget, a frontend JS extension adds a CANVAS-LEVEL
pointer layer. A **long-press** (finger moving less than ~10px, released
between `LONG_PRESS_MS` and `NATIVE_CONTEXT_MENU_MS` after it landed) whose
point lands on a widget, a socket, or a node title surfaces a popover with
that element's existing tooltip metadata (label + type + tooltip text).
Tap-away or Escape dismisses it. The enhancement is **additive** (no-op
fallback if `app.canvas` or the pointer model is absent — desktop hover
tooltips still work), **touch-first** (mouse is left alone unless
`ENABLE_FOR_MOUSE`), and reads only data that already exists — it never writes
to or mutates the graph. Pure hit-test / lookup helpers live at the top of the
extension and are unit-tested; DOM/popover wiring stays below them.

## Architecture: pure helpers + thin DOM adapter

`src/index.ts` is split so the hit-testing and tooltip lookup are testable
without a browser (no jsdom — by design, matching the other packs in the vein):

- **Pure helpers** (exported, unit-tested in `tests/js/`):
  - `hitTestWidget(node, x, y)` — which widget (if any) is under the canvas-space point.
  - `hitTestSocket(node, x, y)` — which input/output slot is under the point (within `SOCKET_HIT_RADIUS_PX`).
  - `hitTestTitle(node, x, y)` — whether the point is on the node title bar.
  - `resolveTooltipForHit(hit)` — given a widget/socket/title hit, returns `{label, type, tooltip}` by walking the lookup chain below.
  - `lookupInputSpec(node, name)` — finds a named input's `INPUT_TYPES` spec (`required`/`optional`).
  - `tooltipFromInputSpec(spec)` — pulls `opts.tooltip` out of an input-spec tuple `[type, opts]`.
  - `widgetHeight(widget)` — the widget's rendered height, for hit-test row math.
  - `clampPopover(rect, viewport)` — keeps the popover inside the viewport (edge clamping).
- **DOM adapter** (thin; gesture semantics pinned in jsdom, feel verified in the browser matrix):
  - `ensureStyle()` — injects the popover stylesheet once (idempotent).
  - `showPopover({label, type, tooltip}, x, y)` — builds/positions the popover via `clampPopover`.
  - `attach(canvas, cfg)` — wires the pointer-down/up/move + long-press timer + Escape/tap-away listeners onto the canvas; passive where it must not block pan/zoom.

The pure layer is exhaustively unit-tested in `tests/js`. The gesture wiring —
the press window, the move/cancel bail-outs — is pinned in the jsdom tier
(`tests/js/long-press-gesture.test.js`, with `tests/mutations.json` proving
those assertions can fail); everything about how the gesture *feels* stays in
the browser smoke matrix below.

Two traps that make a jsdom assertion here vacuous, both live in this suite:

- **Dispatch at the canvas element, never at `document`.** `attach()` binds
  with `{ capture: true }` on the canvas; an event dispatched at `document`
  propagates *downward* and never reaches a descendant's listener, so "the
  popover did not appear" would be true with or without the code under test.
- **Pair every "does not fire" with a "does fire" in the same test.** A
  one-sided negative passes identically against a handler that never fires;
  the `commit() is inert` entry in `tests/mutations.json` is the standing
  check that it doesn't.

## The tooltip lookup chain

`resolveTooltipForHit` resolves the tooltip text from the *first* source that
has it, by hit kind. Reference the tooling rule `writing-custom-nodes.md`
§ "Reading INPUT_TYPES tooltip metadata" for the canonical field map.

- **Widget hit**: `widget.options.tooltip` → else the widget's `INPUT_TYPES`
  spec opts via `lookupInputSpec(node, widget.name)` → `tooltipFromInputSpec(spec)`
  (i.e. `opts.tooltip` from the `required`/`optional` entry).
- **Socket hit (input)**: `slot.tooltip` → else the input-spec
  (`lookupInputSpec` + `tooltipFromInputSpec`).
- **Socket hit (output)**: `nodeData.output_tooltips[index]` (array indexed by
  output slot).
- **Title hit**: `nodeData.description`.

When the chain yields nothing, the popover renders "(no tooltip)" — surfacing
the label + type still helps, and an empty popover would read as a bug.

## File layout

| Path | Purpose |
|------|---------|
| `__init__.py` | Loader stub. Empty `NODE_CLASS_MAPPINGS`; exports `WEB_DIRECTORY = "./web/dist"`. |
| `src/index.ts` | The extension — TypeScript source (port of the former single-file JS): canvas long-press layer + pure hit-test/lookup helpers + the DOM popover adapter. Compiled to `web/dist/index.js`. |
| `src/comfyui-shims.d.ts` | Types the `/scripts/app.js` runtime import (see ADR-0001 type-seam notes). |
| `web/dist/` | **Generated** — `bun build` output (`index.js`). Git-tracked and CI-sync-gated (`git diff --exit-code -- web/dist`), and force-shipped to the registry via `[tool.comfy] includes`. Do not edit by hand — rebuild and commit. |
| `tsconfig.json` | TypeScript config — strict, `tsc --noEmit` type gate, `paths` shim. |
| `knip.json` | Dead-code / unused-dependency check config. |
| `pyproject.toml` | Comfy Registry metadata. `PublisherId` + `version` are the fields you touch. `[tool.comfy] includes = ["web/dist"]` force-ships the built artifact. |
| `package.json` | Dev toolchain — `bun build`, `tsc`, Vitest, Biome, knip. |
| `.github/workflows/` | `ci.yml` (ruff/biome/typecheck+build/pytest/vitest/gitleaks), `publish.yml` (builds, then auto-publishes on version bump), `release-please.yml`. |
| `tests/` | pytest stub suite. `tests/js/` Vitest: `touch-tooltips.test.js` (pure hit-test + lookup helpers, node env) and `long-press-gesture.test.js` (the gesture layer, jsdom). `tests/mutations.json` is the mutation table for the latter — `just mutation-check comfyui-touch-tooltips` from the workspace root. |
| `justfile` | `lint`, `format`, `typecheck`, `build`, `knip`, `test`, `check` recipes — the local CI gate. |

## Hard rules

- **Pack directory name is part of the URL.** The built `web/dist/index.js` is
  served at `/extensions/comfyui-touch-tooltips/index.js`. Renaming the pack dir
  breaks every fetch. If unavoidable, sync `EXT_NAME` in `src/index.ts`.
- **No Python dependencies. The pack is frontend-only; a feature genuinely needing Python belongs in a separate companion pack.**
- **Additive / non-clobbering.** Never replace an existing tooltip or control;
  the popover is read-only and only *surfaces* metadata that is already there.
  Never fabricate tooltip text — render "(no tooltip)" when the lookup chain
  comes up empty.
- **Passive listeners — canvas pan/zoom must be unaffected.** The long-press
  detection uses passive pointer listeners so it never blocks LiteGraph's own
  pan/zoom/drag. A drag (>`MOVE_TOLERANCE_PX`) cancels the pending long-press
  rather than fighting the canvas.
- **Canvas pointer model is version-sensitive.** The layer reads `app.canvas` /
  `ds.scale` / `ds.offset` and node `widgets`/`inputs`/`outputs`/`nodeData`.
  Keep the no-op fallback (do nothing when they are absent) so desktop hover
  tooltips always work.
- **URL / pack-dir-name sensitivity** — see the first rule; the served path is
  derived from the directory name.

## Tunables

`CONFIG` (module constant near the top) is the only knob — no in-UI settings for
v1:

- `LONG_PRESS_MS = 450` — a release before this is an ordinary tap; the popover is not committed.
- `NATIVE_CONTEXT_MENU_MS = 600` — a release at or after this belongs to
  ComfyUI's own `Comfy.SimpleTouchSupport`, which opens LiteGraph's context
  menu for a press it measures as `> 600ms` at `touchend`
  (`src/extensions/core/simpleTouchSupport.ts:62`). This pack declines those
  presses; it never suppresses the menu. **Not a free knob** — raising it past
  600 re-creates the double-fire of issue #6.
- `MOVE_TOLERANCE_PX = 10` — finger movement past this cancels the long-press (treat as a drag/pan).
- `SOCKET_HIT_RADIUS_PX = 14` — hit radius around a socket dot for `hitTestSocket`.
- `ENABLE_FOR_MOUSE` (default `false`) — touch-only unless enabled; flip on to also long-press with a mouse for debugging.

## Dev workflow

```sh
uv sync --group dev          # ruff, pytest, pre-commit
bun install                  # TS toolchain (typescript, types, vitest, biome, knip)
pre-commit install
just check                   # lint + typecheck + build + knip + test — the local CI gate
```

The served file is the built `web/dist/index.js` (generated, but git-tracked
and CI-sync-gated). After editing `src/index.ts` you must **`bun run build`**
and commit the rebuilt `web/dist/index.js` in the same change (CI runs
`git diff --exit-code -- web/dist`), then hard-refresh the tab. No ComfyUI
restart is needed — only a rebuild + refresh.

### Gates before commit

```sh
bun run typecheck   # tsc --noEmit
bun run build       # emit web/dist/index.js
bunx biome check .  # lint + format
bun run knip        # dead-code / unused-dep
bun run test        # Vitest (pure hit-test + lookup helpers)
uv run pytest -v    # Python loader-stub smoke tests
```

### Endpoint reachability check

```sh
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:8188/extensions/comfyui-touch-tooltips/index.js
```

## Browser smoke matrix (manual)

Unit tests cover the pure hit-test + lookup logic, and the jsdom tier covers
the press window; these must be verified live (devtools console + a touch
device or emulated touch). Hard-refresh the tab after editing.

| # | Check | Expect |
|---|-------|--------|
| 1 | Long-press a widget with a tooltip | popover shows correct label + type + tooltip text |
| 2 | Long-press an input/output socket | popover shows the slot's label + type + tooltip (input-spec / `output_tooltips`) |
| 3 | Long-press a node title | popover shows the node title + `nodeData.description` |
| 4 | Long-press an element with no tooltip | popover shows label + type + "(no tooltip)" |
| 5 | Tap away after a popover is open | popover dismisses |
| 6 | Press Escape after a popover is open | popover dismisses |
| 7 | Popover near a viewport edge | `clampPopover` keeps it fully on-screen |
| 8 | Long-press near the canvas edge while panning | a pan (>`MOVE_TOLERANCE_PX`) cancels the long-press; canvas pans normally |
| 9 | Mouse hover / mouse long-press (default) | unchanged — touch-only unless `ENABLE_FOR_MOUSE` is set |
| 10 | Endpoint reachable | the `curl` check above returns `200` |
| 11 | Press ~500ms on a widget and lift | popover appears; **no** LiteGraph context menu |
| 12 | Press ~1s on the same widget and lift | LiteGraph's context menu appears; **no** popover |
| 13 | Repeat 11–12 on iOS Safari and Android Chrome | the 450–600ms window is hittable by an actual thumb — if it is not, lower `LONG_PRESS_MS` (issue #6 is the open question) |

## Releases

Bump `version` in `pyproject.toml` and push to `main` →
`Comfy-Org/publish-node-action` publishes to the Comfy Registry. Requires
the `REGISTRY_ACCESS_TOKEN` repo secret. Use conventional commits;
release-please maintains `CHANGELOG.md` and the version bump PR.
