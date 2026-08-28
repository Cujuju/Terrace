// mudslides — saturated steep ground gives way and flows downhill (#212).
//
// Core knows nothing about mudslides and must not: ground that collapses under
// what a player built is as gamey as a mechanic gets, and the design record's
// rule ("nothing gamey in core") puts the whole thing here. It reads the world
// through `heightAt`, `freshwater` and the unlock mask, asks weather how hard it
// is raining through the host's sibling lookup, and writes the ground in exactly
// one place — `WorldApi.sculpt`, via ./terrain.ts's guarded wrapper.
//
// SHAPE OF THE TICK:
//   1. the survey samples revealed ground for steep sites (./slides.ts);
//   2. every tracked site soaks or dries;
//   3. the world rolls its single arrival, scaled by how much of the sample is
//      saturated and by the frequency setting;
//   4. every running slide advances: the head scours, the front walks downhill,
//      the run-out is laid down;
//   5. finished slides go out as `mudslides:flow` world events;
//   6. clients are told, on the cadence, fog-of-war filtered.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHAT REACTS TO A SLIDE.
//
// CHRONICLE, today — it subscribes to `mudslides:flow` by name and writes the
// slide into the world's saga. structures, flora and fire are issue #212's other
// named consumers and none of them read it yet; the event is the seam those
// follow-ups attach to, and emitting it costs one fan-out per finished slide.
//
// The one plugin this half depends on is WEATHER, and only to be told how wet a
// cell is (./weather-bridge.ts). No weather, no rain trigger — freshwater
// adjacency still works, so a world without the weather plugin still has slides,
// on river banks.
//
// ─────────────────────────────────────────────────────────────────────────────
// SYNC: FULL STATE FOR THE FRONTS, ADDITIVE FOR THE DEBRIS.
//
// `mudslides:active` carries every visible RUNNING slide, at 5 Hz, replacing the
// client's list — so a slide that has finished is learned by its absence, which
// is why the send uses `skipEmpty: false`. `mudslides:debris` is ADDITIVE and
// uses `skipEmpty: true`: debris does not move once it is on the ground, which is
// the exact condition that flag is safe under.
//
// FILTERED, both of them. Where a hillside collapsed is a statement about terrain,
// so a player who has not revealed that ground must not be told about it.
//
// CADENCE. 5 Hz, matching storms and for its reason: a front covers sixteen cells
// a second, so at 1 Hz it would teleport sixteen cells a push and no interpolation
// could hide it. At 5 Hz it moves about three cells between pushes and the
// client's own extrapolation smooths it out. NOTHING IS SENT while no slide is
// running, which is almost all of the time.

import type {
  PersistenceSlice,
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
import { forceSlideFromEnv } from './dev.ts';
import { MUDSLIDES_SLICE_VERSION, loadSlides, saveSlides } from './persistence.ts';
import {
  FREQUENCY_INTERVAL_MULTIPLIERS,
  MAX_ACTIVE_SLIDES,
  advanceSlides,
  flowEventFor,
  livingSlides,
  meanIntervalSeconds,
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

/**
 * Ticks between client broadcasts. 2 → 5 Hz at the shipped TICK_HZ of 10. See
 * this file's header for why 5 Hz and not weather's 1 Hz.
 */
export const BROADCAST_TICK_INTERVAL = 2;

/** Events this plugin emits. Namespaced `mudslides:` by the host. */
export { MUDSLIDES_FLOW_EVENT };

/** Re-exported so a HUD or a sibling reaches the ceiling through the API. */
export { MAX_ACTIVE_SLIDES };

let tickCount = 0;

/**
 * The world's frequency setting, read ONCE in onWorldCreate.
 *
 * WorldApi.setting's own instruction: the value is fixed for the life of a
 * session (changing it persists the row and REOPENS the world, which replays
 * restore + worldCreate), so a plugin that re-read it every tick would be reading
 * a value that cannot move at a cost that can.
 */
let frequency: MudslideFrequency = DEFAULT_MUDSLIDE_FREQUENCY;

function resetSessionState(): void {
  tickCount = 0;
  frequency = DEFAULT_MUDSLIDE_FREQUENCY;
  resetSlides();
  resetWeatherBridge();
}

/**
 * What this world's frequency setting does to the mean arrival interval.
 *
 * `off` NEVER REACHES THIS — the tick returns before the trigger runs — so it
 * falls to `rare` rather than to a zero, which would be an interval of zero
 * seconds and therefore an infinite rate. A wrong-but-quiet default here would be
 * the one kind of bug this codebase's tick loop cannot survive, so the fallback is
 * the shipped default and not a sentinel.
 */
function intervalMultiplier(): number {
  return frequency === 'common'
    ? FREQUENCY_INTERVAL_MULTIPLIERS.common
    : FREQUENCY_INTERVAL_MULTIPLIERS.rare;
}

/**
 * Sends the visible running slides to one player (a join) or to everyone.
 *
 * GATED ON THE FRONT, not on the head: the front is the thing being drawn and the
 * thing about to arrive somewhere. A player who has revealed the valley but not
 * the peak should see the mud coming down at them.
 *
 * `skipEmpty: false` — a FULL-STATE REPLACE message, so a recipient whose filtered
 * subset is empty must still be sent the empty list. That is the only way a client
 * learns the slide it could see has finished; omitting the send would leave its
 * last non-empty payload flowing forever.
 */
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

/**
 * Sends debris cells — the additive delta during a run, or the whole remembered
 * list to a joining player.
 *
 * `skipEmpty: true`, and it is safe here for the reason WorldApi.broadcastVisible
 * spells out: per-player masks only ever grow, and debris never moves once
 * placed, so a cell invisible to a player now was equally invisible when it was
 * laid down. There is nothing an empty send could correct.
 */
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

  surveySites(world, dt);
  soakSites(dt);

  const born = rollTrigger(world, world.difficulty, intervalMultiplier(), dt);
  if (born !== null) {
    console.info(`[mudslides] slide ${born.id} started at (${born.headX}, ${born.headY})`);
  }

  const tick = advanceSlides(world, dt);

  for (const slide of tick.finished) {
    const event = flowEventFor(slide);
    world.emitEvent(MUDSLIDES_FLOW_EVENT, event);
    // THE MASS REPORT, per slide (./slides.ts's header has the argument for why
    // it is measured rather than assumed). A residual that is a large share of
    // the excavated volume means the run-out had nowhere to go — worth seeing in
    // a log, and the only way anyone would ever notice.
    const residual = residualHeightUnits(slide);
    console.info(
      `[mudslides] slide ${slide.id} ${event.stop} after ${event.cells.length} cells: ` +
        `moved ${event.volumeMoved} height units, ${residual} undeposited ` +
        `(${slide.unmeasuredCells} cells outside the measurement window)`,
    );
  }

  // Debris FIRST, so a client that is about to be told the slide has vanished has
  // already been told what it left behind.
  broadcastDebris(world, takePendingDebris());

  if (tickCount % BROADCAST_TICK_INTERVAL !== 0) return;
  // A world with nothing running costs one comparison per tick and no traffic —
  // but the tick a slide FINISHES on must still send, or the client keeps drawing
  // a front that is gone. `tick.changed` is true whenever anything was running at
  // the top of this tick, which includes that one.
  if (tick.changed || livingSlides().length > 0) broadcastActive(world);
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
    // The slice has ALREADY been restored by the time this runs, so a full
    // `resetSlides()` here would discard a slide that was mid-run when the server
    // went down. Only the SESSION-scoped state is reset: the tick counter, the dev
    // freeze (which belongs to the world that set it) and the sibling bridge.
    tickCount = 0;
    setDevFrozen(false);
    resetWeatherBridge();

    frequency = parseFrequency(world.setting(MUDSLIDES_FREQUENCY_SETTING_KEY));
    loadWeatherBridge(world);

    if (frequency === 'off') return;

    // THE DEV FORCE-SPAWN (./dev.ts) — a no-op unless MUDSLIDES_DEV_FORCE is set,
    // which it is in no real deployment. It runs AFTER the restore, so a world
    // booted with it twice gets a second slide rather than none; that is the
    // correct behaviour for a development aid whose whole purpose is "collapse
    // something now".
    forceSlideFromEnv(world, process.env);

    console.info(
      `[mudslides] frequency: ${frequency}, difficulty ${world.difficulty} → ` +
        `a slide every ~${Math.round(
          meanIntervalSeconds(world.difficulty) * intervalMultiplier(),
        )}s on fully saturated ground`,
    );
  },

  onWorldClose(): void {
    // The plugin holds no WorldApi at module scope, so there is nothing to
    // release — but its sim state belongs to the world that is closing, and
    // leaving it standing would hand the next world this one's landslides.
    resetSessionState();
  },

  onTick(world: WorldApi, dt: number): void {
    // `off` stops the SIM as well as the trigger, which is stronger than it needs
    // to be and deliberately so: a world switched to `off` mid-session reopens
    // (WorldApi.setting), so a slide still running is restored from the slice and
    // would otherwise sit there forever with nothing to finish it.
    if (frequency === 'off') return;
    simulate(world, dt);
  },

  onPlayerJoin(world: WorldApi, player: Player): void {
    if (frequency === 'off') return;
    // The debris snapshot first, so the ground is already decorated on the frame
    // the joiner renders a running front over it.
    broadcastDebris(world, trackedDebris(), player.id);
    if (livingSlides().length > 0) broadcastActive(world, player.id);
  },

  persistence,
};

/** Test seam: drops all accumulated state so a suite can start from zero. */
export function resetMudslidesState(): void {
  resetSessionState();
}

/**
 * THE LIVE SLIDES, re-exported for other plugins (the entry point IS this
 * plugin's compatibility surface — weather/server/index.ts's own argument for
 * re-exporting `currentWind` there).
 *
 * A sibling that wants to ask "is this cell about to be buried?" can duck-type
 * this member rather than reaching into ./slides.ts and coupling to a file
 * layout. Nothing does yet; `mudslides:flow` is the push half of the same seam.
 */
export { livingSlides };
