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
let hasReceivedClock = false;
let unsubscribeMessages: (() => void) | null = null;
let unsubscribeFrames: (() => void) | null = null;
let unsubscribeReset: (() => void) | null = null;
let unpublishPhase: (() => void) | null = null;

const PHASE_GAUGE_KEY = 'phase';

const DAYNIGHT_DRAW_OBJECTS = 0;

function resetClock(): void {
  interpolator.clear();
  hasReceivedClock = false;
  hasPushedInitialSky = false;
  setWorldClock(null);
}

export const clientPlugin: TerraceClientPlugin = {
  name: DAYNIGHT_PLUGIN_NAME,

  drawBudget: DAYNIGHT_DRAW_OBJECTS,

  attach(ctx: ClientPluginCtx): void {
    resetClock();
    unpublishPhase = ctx.publishGauge(PHASE_GAUGE_KEY, () => interpolator.samplePhase());
    reducedMotion = watchReducedMotion();
    unsubscribeReset = ctx.onWorldReset(resetClock);

    unsubscribeMessages = ctx.onMessage(DAYNIGHT_CLOCK_MESSAGE, (payload) => {
      const clock = parseClockPayload(payload);
      if (clock === null) return;
      interpolator.receive(clock);
      hasReceivedClock = true;
    });

    unsubscribeFrames = ctx.onFrame((dt) => {
      if (!hasReceivedClock) return;
      interpolator.advance(dt);
      const clock = interpolator.sampleClock();

      setWorldClock(
        worldClockReading(clock.phase, clock.day, clock.genesisDay),
      );

      const reduced = reducedMotion?.matches() ?? false;
      if (reduced && hasPushedInitialSky) return;

      ctx.setSkyRig(skyStateAtPhase(clock.phase));
      hasPushedInitialSky = true;
    });
  },

  dispose(): void {
    unpublishPhase?.();
    unpublishPhase = null;
    unsubscribeMessages?.();
    unsubscribeFrames?.();
    unsubscribeReset?.();
    unsubscribeMessages = null;
    unsubscribeFrames = null;
    unsubscribeReset = null;
    resetClock();

    reducedMotion?.stop();
    reducedMotion = null;
  },
};
