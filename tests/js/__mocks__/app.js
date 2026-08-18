// Minimal stub of ComfyUI's scripts/app.js for the Vitest harness.
// Importing src/index.ts pulls in `app` without a real frontend.
//
// The pure-helper suite only needs `registerExtension` to exist. The jsdom
// gesture suite additionally needs (a) the registered extension object, so it
// can run `setup()` itself, and (b) a settable `canvas`, so `attach()` binds its
// listeners to an element the test owns and can dispatch on.

/** Every object passed to app.registerExtension, in call order. */
export const __registered = [];

export const app = {
  registerExtension(ext) {
    __registered.push(ext);
  },
  // Overwritten by the jsdom suite before it calls setup(). Nothing calls
  // setup() in the node-environment suite, so attach() never reads it there.
  canvas: undefined,
  graph: { _nodes: [] },
};
