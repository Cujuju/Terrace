// Ambient declaration for authored-model URL imports (`*.glb?url`), for the
// WHOLE workspace.
//
// WHY IT LIVES AT THE ROOT AND NOT BESIDE A CONSUMER. Every plugin may now ship
// authored model assets (owner decision, 2026-09-04), and every one of them
// imports the file the same way: `import url from './thing.glb?url'`. Vite's
// own `vite/client` types do not declare that pattern (Vite's known-asset list
// lacks .glb, which is also why client/vite.config.ts carries an
// `assetsInclude` entry for it), so without a declaration the import is an
// error. It was declared twice — once in client/src/vite-env.d.ts and once in
// plugins/boats/client/glb-url.d.ts — and the second copy existed only because
// a plugin package cannot see the first. A third plugin would have made a third
// copy; instead tsconfig.base.json names this file in `files`, which every
// package inherits (they override `include`, never `files`), so a NEW plugin
// gets it with no line of its own.
//
// This file must stay import/export free so the declaration below is GLOBAL
// rather than module-scoped.

declare module '*.glb?url' {
  const url: string;
  export default url;
}
