import {
  BAND_HEIGHT,
  CELL_WORLD_SIZE,
  MAX_HEIGHT,
  MAX_RELIEF_WORLD_UNITS,
  SEA_LEVEL,
} from '@terrace/shared';

export const DEFAULT_SERVER_PORT = 2567;

const pageHostname =
  typeof location === 'undefined' ? 'localhost' : location.hostname;

const pageHost =
  typeof location === 'undefined' ? `${pageHostname}:${DEFAULT_SERVER_PORT}` : location.host;

const serverPort: string =
  import.meta.env.VITE_SERVER_PORT ?? String(DEFAULT_SERVER_PORT);

export const DEFAULT_SERVER_URL = import.meta.env.DEV
  ? `ws://${pageHostname}:${serverPort}`
  : `ws://${pageHost}`;

export const DEFAULT_ROOM_NAME = 'world';

export const SERVER_URL = import.meta.env.VITE_SERVER_URL ?? DEFAULT_SERVER_URL;
export const ROOM_NAME = import.meta.env.VITE_ROOM_NAME ?? DEFAULT_ROOM_NAME;

export { CELL_WORLD_SIZE };

export { MAX_RELIEF_WORLD_UNITS };

export const HEIGHT_WORLD_SCALE = MAX_RELIEF_WORLD_UNITS / MAX_HEIGHT;

export const ORDINARY_SEA_DEPTH_BANDS = 15;

export const ORDINARY_SEA_FLOOR_HEIGHT = -ORDINARY_SEA_DEPTH_BANDS * BAND_HEIGHT;

export const ORDINARY_SEA_SHELF_BANDS = 10;

export const ORDINARY_SEA_SHELF_HEIGHT = -ORDINARY_SEA_SHELF_BANDS * BAND_HEIGHT;

export const SEA_DEPTH_CUE_SPAN_BANDS = 48;

export const SEA_DEPTH_CUE_FLOOR_HEIGHT = -SEA_DEPTH_CUE_SPAN_BANDS * BAND_HEIGHT;

export const BAND_WORLD_HEIGHT = BAND_HEIGHT * HEIGHT_WORLD_SCALE;

export const WORLD_UNIT_HEIGHT_UNITS = 1 / HEIGHT_WORLD_SCALE;

export const WATER_SURFACE_LIFT = 1 / 32;

export const SEA_SURFACE_WORLD_Y = SEA_LEVEL * HEIGHT_WORLD_SCALE + WATER_SURFACE_LIFT;

export const SCULPT_REPEAT_INTERVAL_MS = 120;

export const DISPLAY_HZ_CEILING = 144;

export const DRAG_INTENTS_PER_TICK = Math.ceil(
  (SCULPT_REPEAT_INTERVAL_MS * DISPLAY_HZ_CEILING) / 1000,
);

export const SCULPT_REPEAT_DELAY_MS = 400;

export const SCULPT_REPEAT_RAMP_FACTOR = 0.75;

export const TOUCH_STROKE_GRACE_MS = 100;

export const PINCH_ZOOM_BASE = 1.01;

export const TRACKPAD_PAN_SPEED = 1.5 / 1000;

export const TOUCH_DOLLY_MIN_SEPARATION_PX = 24;

export const TOUCH_DOLLY_MAX_STEP_RATIO = 1.5;

const TRACKPAD_FULL_SWIPE_DELTA_PIXELS = 500;

export const TRACKPAD_ORBIT_AZIMUTH_RADIANS_PER_PIXEL =
  Math.PI / TRACKPAD_FULL_SWIPE_DELTA_PIXELS;

export const TRACKPAD_ORBIT_POLAR_RADIANS_PER_PIXEL =
  TRACKPAD_ORBIT_AZIMUTH_RADIANS_PER_PIXEL;

export const SAFARI_GESTURE_ROTATE_SENSITIVITY = 1;

export const CAMERA_FOV_DEGREES = 55;
export const CAMERA_NEAR = 0.1;
export const CAMERA_FAR = 4000;
export const CAMERA_INITIAL_DISTANCE = 80;

export const CAMERA_CLOSEST_VIEW_WORLD_UNITS = 10;

export const CAMERA_MIN_DISTANCE =
  CAMERA_CLOSEST_VIEW_WORLD_UNITS /
  (2 * Math.tan((CAMERA_FOV_DEGREES * Math.PI) / 180 / 2));
export const CAMERA_MAX_DISTANCE = 900;
export const CAMERA_GROUND_CLEARANCE_WORLD_UNITS = 1;

export const CAMERA_MAX_POLAR_ANGLE_DEGREES = 85;

export const FPS_SAMPLE_INTERVAL_MS = 500;

export const FRAME_STATS_WINDOW_MS = 5000;

export const FRAME_STATS_CAPACITY = 2048;
