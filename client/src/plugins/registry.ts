import { clientPlugin as boats } from '../../../plugins/boats/client/index.ts';
import { clientPlugin as chronicle } from '../../../plugins/chronicle/client/index.ts';
import { clientPlugin as cyclone } from '../../../plugins/cyclone/client/index.ts';
import { clientPlugin as daynight } from '../../../plugins/daynight/client/index.ts';
import { clientPlugin as fire } from '../../../plugins/fire/client/index.ts';
import { clientPlugin as flora } from '../../../plugins/flora/client/index.ts';
import { clientPlugin as fog } from '../../../plugins/fog/client/index.ts';
import { clientPlugin as hydro } from '../../../plugins/hydro/client/index.ts';
import { clientPlugin as invite } from '../../../plugins/invite/client/index.ts';
import { clientPlugin as mana } from '../../../plugins/mana/client/index.ts';
import { clientPlugin as monsters } from '../../../plugins/monsters/client/index.ts';
import { clientPlugin as music } from '../../../plugins/music/client/index.ts';
import { clientPlugin as mudslides } from '../../../plugins/mudslides/client/index.ts';
import { clientPlugin as pilgrims } from '../../../plugins/pilgrims/client/index.ts';
import { clientPlugin as rain } from '../../../plugins/rain/client/index.ts';
import { clientPlugin as relics } from '../../../plugins/relics/client/index.ts';
import { clientPlugin as saucers } from '../../../plugins/saucers/client/index.ts';
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
  hydro,
  fire,
  structures,
  temples,
  monsters,
  boats,
  pilgrims,
  daynight,
  rain,
  thunderstorm,
  snow,
  fog,
  tornado,
  cyclone,
  mudslides,
  volcanoes,
  saucers,
  chronicle,
  music,
];
