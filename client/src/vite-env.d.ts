/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_SERVER_URL?: string;
  readonly VITE_SERVER_PORT?: string;
  readonly VITE_ROOM_NAME?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

declare const __CLIENT_VERSION__: string;
