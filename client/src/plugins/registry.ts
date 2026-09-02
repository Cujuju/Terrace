// The compiled-in client plugin list (decision Q6: build-time, not runtime —
// the loader consumes the stable TerraceClientPlugin signature so dynamic
// loading can be added later without touching the plugins).
//
// A plugin's client half lives at plugins/<name>/client/index.ts next to its
// server half and is imported here BY the client bundle; the plugin's name
// must match its server half or its messages route nowhere.

import { clientPlugin as boats } from '../../../plugins/boats/client/index.ts';
import { clientPlugin as chronicle } from '../../../plugins/chronicle/client/index.ts';
import { clientPlugin as cyclone } from '../../../plugins/cyclone/client/index.ts';
import { clientPlugin as daynight } from '../../../plugins/daynight/client/index.ts';
import { clientPlugin as fire } from '../../../plugins/fire/client/index.ts';
import { clientPlugin as flora } from '../../../plugins/flora/client/index.ts';
import { clientPlugin as fog } from '../../../plugins/fog/client/index.ts';
import { clientPlugin as invite } from '../../../plugins/invite/client/index.ts';
import { clientPlugin as mana } from '../../../plugins/mana/client/index.ts';
import { clientPlugin as monsters } from '../../../plugins/monsters/client/index.ts';
import { clientPlugin as mudslides } from '../../../plugins/mudslides/client/index.ts';
import { clientPlugin as pilgrims } from '../../../plugins/pilgrims/client/index.ts';
import { clientPlugin as rain } from '../../../plugins/rain/client/index.ts';
import { clientPlugin as relics } from '../../../plugins/relics/client/index.ts';
import { clientPlugin as snow } from '../../../plugins/snow/client/index.ts';
import { clientPlugin as structures } from '../../../plugins/structures/client/index.ts';
import { clientPlugin as temples } from '../../../plugins/temples/client/index.ts';
import { clientPlugin as thunderstorm } from '../../../plugins/thunderstorm/client/index.ts';
import { clientPlugin as tornado } from '../../../plugins/tornado/client/index.ts';
import { clientPlugin as volcanoes } from '../../../plugins/volcanoes/client/index.ts';
import { clientPlugin as wildlife } from '../../../plugins/wildlife/client/index.ts';
import type { TerraceClientPlugin } from './types.ts';

export const CLIENT_PLUGINS: readonly TerraceClientPlugin[] = [
  mana,
  invite,
  relics,
  wildlife,
  flora,
  fire,
  structures,
  temples,
  monsters,
  boats,
  pilgrims,
  daynight,
  // The four weather kinds, since the 2026-09-02 split (#283). The `weather`
  // plugin still exists on the SERVER as the hub that owns the wind and the
  // sky-kind register, and has no client half at all: nothing about a wind or a
  // register is something to draw.
  rain,
  thunderstorm,
  snow,
  fog,
  // The two rotating storms, since the 2026-09-02 split (#283). They were one
  // `storms` plugin over one parametric sim; the sim is now core's plugin kit
  // and each of these holds an instance of it.
  tornado,
  cyclone,
  mudslides,
  volcanoes,
  chronicle,
];
