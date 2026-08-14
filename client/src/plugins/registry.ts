// The compiled-in client plugin list (decision Q6: build-time, not runtime —
// the loader consumes the stable TerraceClientPlugin signature so dynamic
// loading can be added later without touching the plugins).
//
// A plugin's client half lives at plugins/<name>/client/index.ts next to its
// server half and is imported here BY the client bundle; the plugin's name
// must match its server half or its messages route nowhere.

import type { TerraceClientPlugin } from './types.ts';

export const CLIENT_PLUGINS: readonly TerraceClientPlugin[] = [
  // Populated as plugins gain client halves (wildlife, relics, mana HUD…).
];
