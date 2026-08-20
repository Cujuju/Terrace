// The compiled-in client plugin list (decision Q6: build-time, not runtime —
// the loader consumes the stable TerraceClientPlugin signature so dynamic
// loading can be added later without touching the plugins).
//
// A plugin's client half lives at plugins/<name>/client/index.ts next to its
// server half and is imported here BY the client bundle; the plugin's name
// must match its server half or its messages route nowhere.

import { clientPlugin as chronicle } from '../../../plugins/chronicle/client/index.ts';
import { clientPlugin as daynight } from '../../../plugins/daynight/client/index.ts';
import { clientPlugin as flora } from '../../../plugins/flora/client/index.ts';
import { clientPlugin as invite } from '../../../plugins/invite/client/index.ts';
import { clientPlugin as mana } from '../../../plugins/mana/client/index.ts';
import { clientPlugin as monsters } from '../../../plugins/monsters/client/index.ts';
import { clientPlugin as pilgrims } from '../../../plugins/pilgrims/client/index.ts';
import { clientPlugin as relics } from '../../../plugins/relics/client/index.ts';
import { clientPlugin as structures } from '../../../plugins/structures/client/index.ts';
import { clientPlugin as weather } from '../../../plugins/weather/client/index.ts';
import { clientPlugin as wildlife } from '../../../plugins/wildlife/client/index.ts';
import type { TerraceClientPlugin } from './types.ts';

export const CLIENT_PLUGINS: readonly TerraceClientPlugin[] = [
  mana,
  invite,
  relics,
  wildlife,
  flora,
  structures,
  monsters,
  pilgrims,
  daynight,
  weather,
  chronicle,
];
