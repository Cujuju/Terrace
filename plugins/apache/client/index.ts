import { CELL_WORLD_SIZE } from '@terrace/shared';
import { Euler, Quaternion } from 'three';
import type { ClientPluginCtx, TerraceClientPlugin } from '../../../client/src/plugins/types.ts';
import { watchReducedMotion, type ReducedMotionWatch } from '../../../client/src/plugins/kit/reducedMotion.ts';
import { createFlightPose, fadeAt, sampleFlight } from '../flight.ts';
import {
  APACHE_PLUGIN_NAME, APACHE_STATE_MESSAGE, ROOFTOP_CLEARANCE, parseApachePayload,
} from '../protocol.ts';
import { createApache, preloadApache, releaseApache, type ApacheModel } from './model.ts';
import { FlightPlayback } from './playback.ts';

const playback = new FlightPlayback();
const pose = createFlightPose(), ahead = createFlightPose();
const attitude = new Quaternion();
const angles = new Euler(0, 0, 0, 'YZX');
const LOOK_AHEAD_SECONDS = [0, 0.75, 1.5, 2.5] as const;
let model: ApacheModel | null = null;
let reducedMotion: ReducedMotionWatch | null = null;
let unsubscribes: Array<() => void> = [];
let lift = 0;
let targetLift = 0;
let visibleLastFrame = false;

function reset(): void {
  playback.clear();
  lift = targetLift = 0;
  visibleLastFrame = false;
  if (model !== null) model.rig.root.visible = false;
}

function render(ctx: ClientPluginCtx, dt: number): void {
  if (model === null) return;
  const root = model.rig.root;
  const now = performance.now() / 1000;
  const active = playback.advance(now);
  const flight = playback.flight;
  if (!active || flight === null) {
    root.visible = false;
    visibleLastFrame = false;
    return;
  }
  sampleFlight(flight, playback.elapsed, pose);
  const x = pose.x / CELL_WORLD_SIZE, y = pose.z / CELL_WORLD_SIZE;
  const ground = ctx.drawnGroundYAt(x, y);
  if (!ctx.revealedAt(x, y) || ground === null) {
    root.visible = false;
    visibleLastFrame = false;
    return;
  }
  // Drawn-ground look-ahead responds to terrain sculpted after the server planned the pass.
  for (const seconds of LOOK_AHEAD_SECONDS) {
    sampleFlight(flight, playback.elapsed + seconds, ahead);
    const height = ctx.drawnGroundYAt(ahead.x / CELL_WORLD_SIZE, ahead.z / CELL_WORLD_SIZE);
    if (height !== null) targetLift = Math.max(targetLift, height + ROOFTOP_CLEARANCE - ahead.altitude);
  }
  const blend = 1 - Math.exp(-Math.min(dt, 0.1) * 3);
  lift += (targetLift - lift) * blend;
  root.position.set(pose.x, pose.altitude + lift, pose.z);
  angles.set(pose.bank, -pose.heading, pose.pitch, 'YZX');
  attitude.setFromEuler(angles);
  if (!visibleLastFrame) root.quaternion.copy(attitude);
  else root.quaternion.slerp(attitude, 1 - Math.exp(-Math.min(dt, 0.1) * 8));
  root.visible = true;
  visibleLastFrame = true;
  const opacity = fadeAt(playback.elapsed) * playback.signalFade(now);
  for (const material of model.materials) material.opacity = opacity;
  model.animateRotors(reducedMotion?.matches() === true ? 0 : playback.elapsed);
}

export const clientPlugin: TerraceClientPlugin = {
  name: APACHE_PLUGIN_NAME,
  drawBudget: 1,
  preload: preloadApache,
  attach(ctx): void {
    model = createApache(ctx);
    reducedMotion = watchReducedMotion();
    reset();
    unsubscribes = [
      ctx.onMessage(APACHE_STATE_MESSAGE, (payload) => {
        const state = parseApachePayload(payload);
        if (state === null) return;
        if (playback.flight?.id !== state.flight?.id) {
          lift = targetLift = 0;
          visibleLastFrame = false;
        }
        playback.receive(state.flight, performance.now() / 1000);
      }),
      ctx.onFrame((dt) => render(ctx, dt)),
      ctx.onWorldReset(reset),
    ];
  },
  dispose(): void {
    for (const unsubscribe of unsubscribes) unsubscribe();
    unsubscribes = [];
    reset();
    reducedMotion?.stop();
    reducedMotion = null;
    model?.dispose();
    model = null;
    releaseApache();
  },
};
