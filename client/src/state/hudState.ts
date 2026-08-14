// Shared reactive state between the imperative render/input layer and the
// Solid HUD.
//
// The signals live at MODULE scope, not inside a component. That is deliberate
// on two counts: the imperative layer needs to read and write them without
// being inside a reactive root, and it sidesteps the project's Solid rule
// entirely — there is no component body here to freeze a reactive read in.
// Consumers must call the exported accessors (`brushRadius()`), never store
// their result in a component-body const.

import { createSignal } from 'solid-js';
import {
  MAX_BRUSH_RADIUS,
  MIN_BRUSH_RADIUS,
  SCULPT_PROFILES,
  SCULPT_TOOLS,
  WIRE_DEFAULT_SCULPT_OPTIONS,
  type SculptProfile,
  type SculptTool,
} from '@terrace/shared';
import type { ConnectionStatus } from '../net/connection.ts';

/** Selectable radii, derived from shared's bounds — never hard-coded. */
export const BRUSH_RADII: readonly number[] = Array.from(
  { length: MAX_BRUSH_RADIUS - MIN_BRUSH_RADIUS + 1 },
  (_, i) => MIN_BRUSH_RADIUS + i,
);

/** Selectable brush tools / edge profiles, straight from shared's own sets. */
export const BRUSH_TOOLS: readonly SculptTool[] = SCULPT_TOOLS;
export const BRUSH_PROFILES: readonly SculptProfile[] = SCULPT_PROFILES;

/** Which way a sculpt stroke moves the land. Mirrors SculptIntent['dir']. */
export type SculptMode = 'raise' | 'lower';

const [connectionStatus, setConnectionStatus] =
  createSignal<ConnectionStatus>('connecting');

/** Radius 1 is the Populous point brush — the least surprising default. */
const [brushRadius, setBrushRadius] = createSignal<number>(MIN_BRUSH_RADIUS);

const [sculptMode, setSculptMode] = createSignal<SculptMode>('raise');

/**
 * Brush tool and edge profile, seeded from the WIRE defaults rather than from
 * literals: the HUD must start on exactly what an intent WITHOUT these fields
 * would mean, or the picker would show one thing on load and the server would
 * do another. (Decision 2026-08-14: stamp + soft is the player-facing default.)
 */
const [brushTool, setBrushTool] = createSignal<SculptTool>(
  WIRE_DEFAULT_SCULPT_OPTIONS.tool,
);
const [brushProfile, setBrushProfile] = createSignal<SculptProfile>(
  WIRE_DEFAULT_SCULPT_OPTIONS.profile,
);

export {
  connectionStatus,
  setConnectionStatus,
  brushRadius,
  setBrushRadius,
  brushTool,
  setBrushTool,
  brushProfile,
  setBrushProfile,
  sculptMode,
  setSculptMode,
};

/** The `dir` field of a SculptIntent for the current mode. */
export function sculptDirection(mode: SculptMode): 1 | -1 {
  return mode === 'raise' ? 1 : -1;
}
