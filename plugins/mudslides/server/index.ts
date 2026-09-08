import type {
  PersistenceSlice,
  PluginActionOutcome,
  PluginActionSite,
  Player,
  TerracePlugin,
  WorldApi,
} from '../../../server/src/plugins/types.ts';
import {
  DEFAULT_MUDSLIDE_FREQUENCY,
  MUDSLIDES_ACTIVE_MESSAGE,
  MUDSLIDES_DEBRIS_MESSAGE,
  MUDSLIDES_FLOW_EVENT,
  MUDSLIDES_PLUGIN_NAME,
  MUDSLIDE_FREQUENCIES,
  MUDSLIDES_FREQUENCY_SETTING_KEY,
  parseFrequency,
  roundBroadcastLoad,
  roundBroadcastPosition,
  type DebrisCell,
  type MudslideFrequency,
  type SlideState,
} from '../protocol.ts';
import { forceSlideFromEnv, forceSlideNear, resetDevForce, tickDevForce } from './dev.ts';
import { MUDSLIDES_SLICE_VERSION, loadSlides, saveSlides } from './persistence.ts';
import {
  FREQUENCY_INTERVAL_MULTIPLIERS,
  MAX_ACTIVE_SLIDES,
  startSlide,
  advanceSlides,
  flowEventFor,
  livingSlides,
  meanIntervalSeconds,
  movedGround,
  residualHeightUnits,
  resetSlides,
  rollTrigger,
  setDevFrozen,
  slideStates,
  soakSites,
  surveySites,
  takePendingDebris,
  trackedDebris,
} from './slides.ts';
import { loadWeatherBridge, resetWeatherBridge } from './weather-bridge.ts';

export const BROADCAST_TICK_INTERVAL = 2;

export { MUDSLIDES_FLOW_EVENT };

export { MAX_ACTIVE_SLIDES };

let tickCount = 0;
let activeBroadcastPending = false;

let frequency: MudslideFrequency = DEFAULT_MUDSLIDE_FREQUENCY;

const SLIDE_ACTION = 'slide';

function resetSessionState(): void {
  tickCount = 0;
  frequency = DEFAULT_MUDSLIDE_FREQUENCY;
  resetSlides();
  resetDevForce();
  resetWeatherBridge();
}

function intervalMultiplier(): number {
  return frequency === 'off'
    ? FREQUENCY_INTERVAL_MULTIPLIERS.rare
    : FREQUENCY_INTERVAL_MULTIPLIERS[frequency];
}

function broadcastActive(world: WorldApi, onlyPlayerId?: string): void {
  world.broadcastVisible(
    MUDSLIDES_ACTIVE_MESSAGE,
    slideStates(),
    (slide: SlideState) => ({ x: Math.round(slide.x), y: Math.round(slide.y) }),
    (visible) => ({
      slides: visible.map((slide) => ({
        ...slide,
        x: roundBroadcastPosition(slide.x),
        y: roundBroadcastPosition(slide.y),
        vx: roundBroadcastPosition(slide.vx),
        vy: roundBroadcastPosition(slide.vy),
        load: roundBroadcastLoad(slide.load),
      })),
    }),
    { skipEmpty: false, onlyPlayerId },
  );
}

function broadcastDebris(
  world: WorldApi,
  cells: readonly DebrisCell[],
  onlyPlayerId?: string,
): void {
  if (cells.length === 0) return;
  world.broadcastVisible(
    MUDSLIDES_DEBRIS_MESSAGE,
    cells,
    (cell: DebrisCell) => ({ x: cell.x, y: cell.y }),
    (visible) => ({ cells: visible }),
    { skipEmpty: true, onlyPlayerId },
  );
}

function simulate(world: WorldApi, dt: number): void {
  tickCount++;

  tickDevForce(world, dt);
  surveySites(world, dt);
  soakSites(dt);

  const born = rollTrigger(world, world.difficulty, intervalMultiplier(), dt);
  if (born !== null) {
    console.info(`[mudslides] slide ${born.id} started at (${born.headX}, ${born.headY})`);
  }

  const tick = advanceSlides(world, dt);

  for (const slide of tick.finished) {
    if (!movedGround(slide)) continue;
    const event = flowEventFor(slide);
    world.emitEvent(MUDSLIDES_FLOW_EVENT, event);
    const residual = residualHeightUnits(slide);
    console.info(
      `[mudslides] slide ${slide.id} ${event.stop} after ${event.cells.length} cells: ` +
        `moved ${event.volumeMoved} height units, ${residual} undeposited ` +
        `(${slide.unmeasuredCells} cells outside the measurement window)`,
    );
  }

  broadcastDebris(world, takePendingDebris(tick.finished));

  if (tick.changed) activeBroadcastPending = true;
  if (tickCount % BROADCAST_TICK_INTERVAL !== 0) return;
  if (activeBroadcastPending || livingSlides().length > 0) {
    activeBroadcastPending = false;
    broadcastActive(world);
  }
}

const persistence: PersistenceSlice = {
  version: MUDSLIDES_SLICE_VERSION,
  save(): unknown {
    return saveSlides();
  },
  load(data: unknown): void {
    loadSlides(data);
  },
};

export const plugin: TerracePlugin = {
  name: MUDSLIDES_PLUGIN_NAME,

  settings: [
    {
      key: MUDSLIDES_FREQUENCY_SETTING_KEY,
      values: MUDSLIDE_FREQUENCIES,
      defaultValue: DEFAULT_MUDSLIDE_FREQUENCY,
    },
  ],

  onWorldCreate(world: WorldApi): void {
    tickCount = 0;
    setDevFrozen(false);
    resetDevForce();
    resetWeatherBridge();

    frequency = parseFrequency(world.setting(MUDSLIDES_FREQUENCY_SETTING_KEY));
    loadWeatherBridge(world);

    if (frequency === 'off') return;

    forceSlideFromEnv(world, process.env);

    console.info(
      `[mudslides] frequency: ${frequency}, difficulty ${world.difficulty} → ` +
        `a slide every ~${Math.round(
          meanIntervalSeconds(world.difficulty) * intervalMultiplier(),
        )}s on fully saturated ground`,
    );
  },

  onWorldClose(): void {
    resetSessionState();
  },

  archetype: 'terrain',
  actions: [
    {
      key: SLIDE_ACTION,
      label: 'Start a mudslide',
      description: 'Collapses the hillside with the longest run-out near where you are looking, rain or no rain.',
    },
  ],

  onAction(world: WorldApi, key: string, site: PluginActionSite): PluginActionOutcome {
    if (key !== SLIDE_ACTION) return { ok: false, detail: `no such action "${key}"` };
    if (frequency === 'off') {
      return { ok: false, detail: 'mudslides are off for this world — set the frequency first' };
    }
    if (livingSlides().length >= MAX_ACTIVE_SLIDES) {
      return { ok: false, detail: `${MAX_ACTIVE_SLIDES} slides are already running` };
    }
    const { slide, detail } = forceSlideNear(world, site);
    if (slide === null) return { ok: false, detail };
    broadcastActive(world);
    return { ok: true, detail };
  },

  onTick(world: WorldApi, dt: number): void {
    if (frequency === 'off') return;
    simulate(world, dt);
  },

  onPlayerJoin(world: WorldApi, player: Player): void {
    if (frequency === 'off') return;
    broadcastDebris(world, trackedDebris(), player.id);
    if (livingSlides().length > 0) broadcastActive(world, player.id);
  },

  persistence,
};

export function resetMudslidesState(): void {
  resetSessionState();
}

export { livingSlides };

export function startDirectedSlide(world: WorldApi, x: number, y: number): boolean {
  if (frequency === 'off') return false;
  if (livingSlides().length >= MAX_ACTIVE_SLIDES) return false;
  if (startSlide(world, x, y) === null) return false;
  broadcastActive(world);
  return true;
}
