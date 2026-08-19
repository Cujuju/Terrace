/// <reference types="vite/client" />

// Ambient declarations only — this file must stay import/export free so the
// interfaces below merge with Vite's globals rather than becoming a module.

interface ImportMetaEnv {
  /** Colyseus endpoint override, e.g. `ws://192.168.1.10:2567`. */
  readonly VITE_SERVER_URL?: string;
  /** Room name override; must match the server's `gameServer.define()` name. */
  readonly VITE_ROOM_NAME?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

/**
 * Build identity of this bundle, replaced at build time by vite.config.ts's
 * `define` (see the `buildVersion` note there). Declared here so the one use
 * site (ui/VersionWatermark.tsx) typechecks; at runtime the identifier no
 * longer exists — the literal has been inlined.
 */
declare const __CLIENT_VERSION__: string;
