// Ambient `import.meta.env` shim — TYPECHECK ONLY, and only for this package.
//
// WHY IT EXISTS. skiffModels.ts floats the fleet on the plane the renderer
// actually draws the sea at, and imports that plane's constant from the module
// that owns it (client/src/config.ts's SEA_SURFACE_WORLD_Y — see the constant's
// own comment for why restating the expression here would be the bug). Type-
// checking that module pulls its transitive imports into this project, and
// config.ts reads `import.meta.env` for the server endpoint. That property is
// declared by Vite's `vite/client` types, which the client package names in its
// own tsconfig; this plugin has no Vite dependency and should not grow one for
// three property lookups it never performs itself.
//
// EXACTLY plugins/mana/client/env.d.ts, for exactly its reason — see that file
// for the full argument. It is the same shape Vite documents (env vars are
// strings and every one of them is optional), it is narrower than Vite's
// declaration rather than in conflict with it, and it is scoped to this
// package's tsconfig. At RUNTIME nothing here exists at all: this plugin's
// client half is bundled by the core client's Vite build, which supplies the
// genuine `import.meta.env`.
//
// NOTHING UNDER test/ REACHES IT. skiffModels.ts is the only file in this
// plugin that imports config.ts, and it imports `three` — no test imports it
// (the client tests import placement/site/skiffs/models, all pure or
// three-only), so no node test run has ever had to evaluate config.ts.
interface ImportMetaEnv {
  readonly [key: string]: string | undefined;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
