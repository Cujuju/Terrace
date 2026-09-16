import { MAX_HEIGHT, MAX_RELIEF_WORLD_UNITS, SEA_LEVEL } from '@terrace/shared';

// Vite-free so plugins can import it: config.ts reads import.meta.env, which
// a plugin's tsconfig cannot type.
export const HEIGHT_WORLD_SCALE = MAX_RELIEF_WORLD_UNITS / MAX_HEIGHT;

export const WATER_SURFACE_LIFT = 1 / 32;

// The drawn water plane: the one sea surface every rig floats on or stands on.
export const SEA_SURFACE_WORLD_Y = SEA_LEVEL * HEIGHT_WORLD_SCALE + WATER_SURFACE_LIFT;
