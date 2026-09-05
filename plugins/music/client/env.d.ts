// Ambient `import.meta.env` shim — TYPECHECK ONLY, and only for this package.
// A copy of plugins/mana/client/env.d.ts; see that file for why and why it is
// safe. Here the chain is the AUDIO_DEBUG import, which reaches
// client/src/config.ts and client/src/render/scene.ts.
interface ImportMetaEnv {
  readonly [key: string]: string | undefined;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
