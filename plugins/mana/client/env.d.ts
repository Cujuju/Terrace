// Ambient `import.meta.env` shim — TYPECHECK ONLY, and only for this package.
//
// WHY IT EXISTS. The gauge reads the player's live brush selection from
// client/src/state/hudState.ts (the documented client-half coupling, see
// ./state.ts). Type-checking that module pulls its transitive imports into this
// project, and one of them — client/src/config.ts — reads `import.meta.env`.
// That property is declared by Vite's `vite/client` types, which the client
// package names in its own tsconfig; this plugin has no Vite dependency and
// should not grow one for two property lookups it never performs itself.
//
// WHY IT IS SAFE. It is the same shape Vite documents (env vars are strings and
// every one of them is optional), it is narrower than Vite's declaration rather
// than in conflict with it, and it is scoped to this package's tsconfig — the
// client package still typechecks against the real `vite/client`. At RUNTIME
// nothing here exists at all: the plugin's client half is bundled by the core
// client's Vite build, which supplies the genuine `import.meta.env`.
interface ImportMetaEnv {
  readonly [key: string]: string | undefined;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
