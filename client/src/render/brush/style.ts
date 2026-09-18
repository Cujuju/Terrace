import { BAND_WORLD_HEIGHT, CELL_WORLD_SIZE } from '../../config.ts';

export const OUTLINE_LIFT_WORLD_UNITS = 0.05;

export const OUTLINE_OPACITY = 0.28;

export const HEM_OPACITY = OUTLINE_OPACITY / 3;

/**
 * The hem gives the ring thickness against its tread: half a band, so it
 * reads clearly without mimicking a second surface.
 */
export const RING_HEM_WORLD_UNITS = BAND_WORLD_HEIGHT / 2;

export const CELL_GRID_COLOR = 0x8b918a;

export const CELL_GRID_OPACITY = OUTLINE_OPACITY * 0.55;

export const CROSSHAIR_ARM_WORLD_UNITS = CELL_WORLD_SIZE * 0.3;

export const CROSSHAIR_GAP_WORLD_UNITS = CELL_WORLD_SIZE * 0.08;

export const CROSSHAIR_OPACITY = 1;

export const MARK_COLOR_RISER = 0xff2d95;

export const OUTLINE_IS_CURSOR_CLASS = 'brush-outline-shown';

export const OUTLINE_COLOR_CAP = 0xffffff;
export const OUTLINE_COLOR_RISER = 0xffb347;

export const MARK_COLOR_REFUSED = 0x9aa09b;

export const MARK_REFUSED_OPACITY = 0.5;

export const MARK_BAND_TINT_MIX = 1 / 3;
