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
