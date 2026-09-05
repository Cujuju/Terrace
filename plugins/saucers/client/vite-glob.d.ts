// Ambient declaration for Vite's `import.meta.glob`, for THIS package's own
// typecheck.
//
// This file must stay import/export free so the declaration below is global
// rather than module-scoped. The package's tsconfig takes only "node" types, so
// `vite/client` — which is where every other reader in this repo gets this from
// (client/tsconfig.json lists it) — is not in scope here. plugins/boats/client/
// glb-url.d.ts exists for exactly the same reason, one declaration over.
//
// IT IS NOT IN THE CLIENT PACKAGE'S PROGRAM and therefore cannot collide with
// vite/client's own, richer declaration: client/tsconfig.json includes only
// `src`, `test` and `vite.config.ts`, so a `.d.ts` sitting here is reached by
// nothing (TypeScript pulls in files that are IMPORTED, and an ambient
// declaration file is imported by no one). The client bundle's own typecheck of
// ./models.ts therefore uses vite/client's overloads, and the call there is
// written so both declarations accept it — see the note beside it.
//
// WHY THE GLOB AND NOT A `.glb?url` IMPORT. A static `import url from
// './assets/saucer-a.glb?url'` typechecks whether or not the file exists (an
// ambient module declaration says nothing about the filesystem) but FAILS TO
// RESOLVE at dev-server and build time when it does not, which takes the whole
// client bundle down — not just this plugin. `import.meta.glob` is resolved by
// Vite against what is actually on disk and yields an empty record when nothing
// matches, which is exactly the "the import did not resolve" condition the
// procedural fallback in ./models.ts is selected by.

interface ImportMeta {
  glob(
    pattern: string,
    options: {
      readonly query?: string;
      readonly import?: string;
      readonly eager?: boolean;
    },
  ): Record<string, () => Promise<unknown>>;
}
