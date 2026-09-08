import type { ClientPluginCtx, TerraceClientPlugin } from '../../../client/src/plugins/types.ts';
import {
  DAYNIGHT_CLOCK_MESSAGE,
  DAYNIGHT_PLUGIN_NAME,
  parseClockPayload,
} from '../protocol.ts';
import { DayNightInterpolator } from './interpolation.ts';
import { worldClockReading } from './formatTime.ts';
import { setWorldClock } from '../../../client/src/plugins/hudPanels.ts';
import { skyStateAtPhase } from './sky.ts';
import { watchReducedMotion } from '../../../client/src/plugins/kit/reducedMotion.ts';

const interpolator = new DayNightInterpolator();
let reducedMotion: { matches(): boolean; stop(): void } | null = null;
let hasPushedInitialSky = false;
let calendarDay: number | null = null;
let calendarGenesisDay: number | null = null;
let unsubscribeMessages: (() => void) | null = null;
let unsubscribeFrames: (() => void) | null = null;
let unpublishPhase: (() => void) | null = null;

const PHASE_GAUGE_KEY = 'phase';

const DAYNIGHT_DRAW_OBJECTS = 0;

export const clientPlugin: TerraceClientPlugin = {
  name: DAYNIGHT_PLUGIN_NAME,

  drawBudget: DAYNIGHT_DRAW_OBJECTS,

  attach(ctx: ClientPluginCtx): void {
    unpublishPhase = ctx.publishGauge(PHASE_GAUGE_KEY, () => interpolator.samplePhase());
    reducedMotion = watchReducedMotion();
    hasPushedInitialSky = false;
    calendarDay = null;
    calendarGenesisDay = null;

    unsubscribeMessages = ctx.onMessage(DAYNIGHT_CLOCK_MESSAGE, (payload) => {
      const clock = parseClockPayload(payload);
      if (clock === null) return;
      interpolator.receive(clock.phase);
      calendarDay = clock.day;
      calendarGenesisDay = clock.genesisDay;
    });

    unsubscribeFrames = ctx.onFrame((dt) => {
      interpolator.advance(dt);

      setWorldClock(
        worldClockReading(interpolator.samplePhase(), calendarDay, calendarGenesisDay),
      );

      const reduced = reducedMotion?.matches() ?? false;
      if (reduced && hasPushedInitialSky) return;

      ctx.setSkyRig(skyStateAtPhase(interpolator.samplePhase()));
      hasPushedInitialSky = true;
    });
  },

  dispose(): void {
    unpublishPhase?.();
    unpublishPhase = null;
    unsubscribeMessages?.();
    unsubscribeFrames?.();
    unsubscribeMessages = null;
    unsubscribeFrames = null;

    interpolator.clear();
    hasPushedInitialSky = false;
    calendarDay = null;
    calendarGenesisDay = null;
    setWorldClock(null);

    reducedMotion?.stop();
    reducedMotion = null;
  },
};
