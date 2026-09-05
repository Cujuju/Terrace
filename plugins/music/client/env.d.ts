// Ambient `import.meta.env` shim — TYPECHECK ONLY, and only for this package.
// A copy of plugins/mana/client/env.d.ts, for the same reason.
//
// WHY IT EXISTS. This plugin imports AUDIO_DEBUG from
// client/src/audio/audioDebug.ts (the debug-flag convention core owns).
// Type-checking that module pulls its transitive imports into this project, and
// two of them — client/src/config.ts and client/src/render/scene.ts — read
// `import.meta.env`. That property is declared by Vite's `vite/client` types,
// which the client package names in its own tsconfig; this plugin has no Vite
// dependency and should not grow one for property lookups it never performs.
//
// WHY IT IS SAFE. Same shape Vite documents, narrower than Vite's declaration
// rather than in conflict with it, and scoped to this package's tsconfig. At
// RUNTIME nothing here exists: the plugin is bundled by the core client's Vite
// build, which supplies the genuine `import.meta.env`.
interface ImportMetaEnv {
  readonly [key: string]: string | undefined;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
