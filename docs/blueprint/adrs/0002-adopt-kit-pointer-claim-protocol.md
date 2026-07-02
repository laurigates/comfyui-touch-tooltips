---
id: ADR-0002
date: 2026-07-02
status: Accepted
deciders: Lauri Gates
domain: api-design
supersedes: []
relates-to: [ADR-0001]
github-issues: []
name: adopt-kit-pointer-claim-protocol
---

# ADR-0002: Adopt the comfy-modal-kit pointer-claim protocol (`isModalActive` veto + `claimPointer`)

> The touch/gesture packs in this family share a single design concern:
> multiple canvas-level or window-level pointer layers can be live at once,
> and a gesture pack must not act on a pointer while another pack's modal
> owns the interaction. `comfy-modal-kit` ADR-0001
> (`laurigates/comfy-modal-kit#8`, kit issue
> [#9](https://github.com/laurigates/comfy-modal-kit/issues/9)) defines a
> shared **pointer-claim protocol** — a `Symbol.for`-keyed global that every
> inlined copy of the kit shares — so packs can coordinate: read
> `isModalActive()` and defer before acting; call `claimPointer(id)` when
> taking a gesture, so peers can observe who owns it.

## Context

This pack registers a **canvas-scoped** `pointerdown` listener (capture,
passive) that starts a long-press timer and, on commit, surfaces a tooltip
popover. When a peer pack opens a full-screen modal (e.g. a widget editor
whose backdrop covers the canvas), the tooltip long-press should **not** run.

In practice this pack's handler often *cannot even fire* over such a modal:
the modal's backdrop sits above the canvas in the event path, so the canvas
element never sees the `pointerdown`. So there is **no live, reproducible bug**
here today. What is missing is:

1. an **explicit** statement of the deference (rather than relying on the
   incidental event-path fact), making it robust if a peer modal is ever
   rendered without a canvas-covering backdrop; and
2. **observability** — a `claimPointer` signal so peers and diagnostics can see
   that touch-tooltips took a gesture.

## Decision Drivers

- **Cross-pack coordination is a shared protocol, not a per-pack invention.**
  The kit ADR-0001 owns the protocol; each gesture pack adopts it identically
  (`if (isModalActive()) return;` before acting, `claimPointer(id)` on commit).
- **Defense-in-depth.** The canvas-scoped listener's inability to fire over a
  backdrop is incidental. An explicit veto does not depend on that incidental
  fact and survives a peer that renders a modal differently.
- **Observability with negligible cost.** `claimPointer` is advisory (stored
  for diagnostics / future arbitration) and adds one call at the exact point a
  tooltip is committed.
- **Zero runtime-bundle cost.** The kit is inlined at build (`bun build
  --external '/scripts/*'` bundles it into `web/dist/index.js`); nothing ships
  from `node_modules` at runtime, and all inlined copies share the one
  `Symbol.for` global. This preserves the ADR-0001 zero-runtime-bundle
  property.

## Considered Options

1. **Adopt the kit protocol** — add `@laurigates/comfy-modal-kit` as the first
   runtime dependency; veto with `isModalActive()` before starting the
   long-press; `claimPointer("touch-tooltips")` when the popover is committed.
2. **Do nothing** — rely on the incidental fact that the canvas listener can't
   fire over a modal backdrop. Rejected: implicit, fragile to peer rendering
   changes, and provides no cross-pack observability.
3. **Hand-roll a private coordination global** — duplicate the kit's
   `Symbol.for` slot logic locally. Rejected: reinvents a shared protocol,
   drifts from the family, and the kit already provides it.

## Decision Outcome

**Chosen option**: "Adopt the kit protocol". The change is **defense-in-depth
plus explicit protocol/observability**, not a fix for a live reproducible bug.

### Implementation

- Add `@laurigates/comfy-modal-kit@^0.4.0` (published 0.4.0 exports
  `isModalActive` and `claimPointer`) as the pack's first runtime dependency.
  It is inlined at build, so `web/dist/index.js` stays a single self-contained
  browser ESM file.
- **Veto** — in the canvas `pointerdown` listener, after the mouse guard and
  **before** starting the long-press timer: `if (isModalActive()) return;`.
  The listener stays `{ capture: true, passive: true }` — the guard is a pure
  read + early return, **no `preventDefault`** (the passive-listener hard rule
  is preserved).
- **Claim** — inside the long-press timer callback, at the point a real tooltip
  is committed (after the hit-test succeeds and the tooltip is resolved, just
  before `showPopover`): `claimPointer("touch-tooltips")`. Claiming on commit
  (not merely on timer fire) keeps the signal meaningful.

### Positive Consequences

- Deference to peer modals is explicit and robust, independent of the
  incidental event-path fact.
- Cross-pack observability of who owns a gesture, via the shared advisory
  claim.
- No runtime-bundle cost (kit inlined at build) — ADR-0001's zero-bundle
  property is preserved.

### Negative Consequences

- First runtime dependency for the pack (previously dev-only). Mitigated: it is
  inlined at build and never shipped from `node_modules`.
- The veto is defense-in-depth for a case that is usually already unreachable,
  so its direct effect is rarely observable — it earns its place as protocol
  compliance and future-proofing, not as a bug fix.

## Links

- comfy-modal-kit ADR-0001 / pointer-claim protocol:
  `laurigates/comfy-modal-kit#8`, kit issue
  [#9](https://github.com/laurigates/comfy-modal-kit/issues/9)
- Relates to ADR-0001 (TypeScript + bun build) — the inlining property this
  decision relies on comes from that build toolchain.
- `src/index.ts` § canvas `pointerdown` listener (veto) and the long-press
  timer callback (claim).

---
*Authored as part of the comfy-modal-kit pointer-claim protocol adoption.*
