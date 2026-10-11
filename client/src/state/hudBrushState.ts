import { createSignal } from 'solid-js';
import {
  CARVE_DEFAULT_DEPTH_BANDS,
  CARVE_MAX_DEPTH_BANDS,
  CARVE_MIN_DEPTH_BANDS,
  CELL_WORLD_SIZE,
  FULL_BRUSH_RADIUS,
  MAX_BRUSH_RADIUS,
  MIN_BRUSH_RADIUS,
  NUDGE_STRENGTH_DEFAULT,
  NUDGE_STRENGTH_MAX,
  NUDGE_STRENGTH_MIN,
  SCULPT_PROFILES,
  SCULPT_TOOLS,
  SMOOTH_KINK_HALF_CELLS_DEFAULT,
  SMOOTH_KINK_HALF_CELLS_MAX,
  SMOOTH_KINK_HALF_CELLS_MIN,
  WIRE_DEFAULT_SCULPT_OPTIONS,
  WORLD_UNIT_CELLS,
  forEachFootprintOffset,
  isValidCarveDepth,
  type SculptProfile,
  type SculptTool,
} from '@terrace/shared';

export const BRUSH_LADDER_TOP_RADIUS = FULL_BRUSH_RADIUS;

export const BRUSH_RADII: readonly number[] = (() => {
  if (BRUSH_LADDER_TOP_RADIUS > MAX_BRUSH_RADIUS) {
    throw new Error('the brush ladder tops out above the wire ceiling');
  }
  const rungs: number[] = [];
  for (let r = MIN_BRUSH_RADIUS; r <= BRUSH_LADDER_TOP_RADIUS; r += 1) rungs.push(r);
  return rungs;
})();

export const BRUSH_ANCHOR_RADII: readonly number[] = (() => {
  const anchors: number[] = [];
  for (let r = MIN_BRUSH_RADIUS; r <= BRUSH_LADDER_TOP_RADIUS; r *= 2) anchors.push(r);
  return anchors;
})();

export function brushNominalWidthWorldUnits(radius: number): number {
  return 2 * radius * CELL_WORLD_SIZE;
}

export function brushWidthWorldUnits(radius: number): number {
  let reachCells = 0;
  forEachFootprintOffset(radius, (dx, dy) => {
    reachCells = Math.max(reachCells, Math.abs(dx), Math.abs(dy));
  });
  return (2 * reachCells + 1) * CELL_WORLD_SIZE;
}

export const BRUSH_TOOLS: readonly SculptTool[] = SCULPT_TOOLS;
export const BRUSH_PROFILES: readonly SculptProfile[] = SCULPT_PROFILES;

export type SculptMode = 'raise' | 'lower';

const STORAGE_KEY = 'terrace.hudState.v2';

export const DEFAULT_BRUSH_RADIUS = WORLD_UNIT_CELLS;

export const DEFAULT_BRUSH_TOOL: SculptTool = WIRE_DEFAULT_SCULPT_OPTIONS.tool;

export const DEFAULT_BRUSH_PROFILE: SculptProfile = 'hard';

export const DEFAULT_SCULPT_MODE: SculptMode = 'raise';

export const DEFAULT_NUDGE_STRENGTH = NUDGE_STRENGTH_DEFAULT;

export const DEFAULT_SMOOTH_KINK_HALF_CELLS = SMOOTH_KINK_HALF_CELLS_DEFAULT;

export const DEFAULT_CARVE_DEPTH_BANDS = CARVE_DEFAULT_DEPTH_BANDS;

export const DEFAULT_SHOW_CONTROLS = false;

export const DEFAULT_PANEL_OPEN: boolean =
  typeof navigator === 'undefined' || !(navigator.maxTouchPoints > 0);

export interface PersistedHudState {
  readonly brushRadius: number;
  readonly brushTool: SculptTool;
  readonly brushProfile: SculptProfile;
  readonly sculptMode: SculptMode;
  readonly nudgeStrength: number;
  readonly smoothKinkHalfCells: number;
  readonly carveDepthBands: number;
  readonly showControls: boolean;
  readonly panelOpen: boolean;
}

export const DEFAULT_HUD_STATE: PersistedHudState = {
  brushRadius: DEFAULT_BRUSH_RADIUS,
  brushTool: DEFAULT_BRUSH_TOOL,
  brushProfile: DEFAULT_BRUSH_PROFILE,
  sculptMode: DEFAULT_SCULPT_MODE,
  nudgeStrength: DEFAULT_NUDGE_STRENGTH,
  smoothKinkHalfCells: DEFAULT_SMOOTH_KINK_HALF_CELLS,
  carveDepthBands: DEFAULT_CARVE_DEPTH_BANDS,
  showControls: DEFAULT_SHOW_CONTROLS,
  panelOpen: DEFAULT_PANEL_OPEN,
};

function readRadius(value: unknown): number {
  return typeof value === 'number' && BRUSH_RADII.includes(value)
    ? value
    : DEFAULT_BRUSH_RADIUS;
}

function readTool(value: unknown): SculptTool {
  return SCULPT_TOOLS.includes(value as SculptTool)
    ? (value as SculptTool)
    : DEFAULT_BRUSH_TOOL;
}

function readProfile(value: unknown): SculptProfile {
  return SCULPT_PROFILES.includes(value as SculptProfile)
    ? (value as SculptProfile)
    : DEFAULT_BRUSH_PROFILE;
}

function readMode(value: unknown): SculptMode {
  return value === 'raise' || value === 'lower' ? value : DEFAULT_SCULPT_MODE;
}

/** An integer in [min, max], else the fallback. */
function readIntegerIn(value: unknown, min: number, max: number, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max
    ? value
    : fallback;
}

/** The wire predicate is the one depth authority; the HUD never re-states it. */
function readCarveDepthBands(value: unknown): number {
  return typeof value === 'number' && isValidCarveDepth(value)
    ? value
    : DEFAULT_CARVE_DEPTH_BANDS;
}

function readShowControls(value: unknown): boolean {
  return typeof value === 'boolean' ? value : DEFAULT_SHOW_CONTROLS;
}

function readPanelOpen(value: unknown): boolean {
  return typeof value === 'boolean' ? value : DEFAULT_PANEL_OPEN;
}

export function parseHudState(raw: string | null): PersistedHudState {
  if (raw === null) return DEFAULT_HUD_STATE;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return DEFAULT_HUD_STATE;
  }
  if (typeof parsed !== 'object' || parsed === null) return DEFAULT_HUD_STATE;
  const record = parsed as Record<string, unknown>;
  return {
    brushRadius: readRadius(record['brushRadius']),
    brushTool: readTool(record['brushTool']),
    brushProfile: readProfile(record['brushProfile']),
    sculptMode: readMode(record['sculptMode']),
    nudgeStrength: readIntegerIn(record['nudgeStrength'], NUDGE_STRENGTH_MIN, NUDGE_STRENGTH_MAX, DEFAULT_NUDGE_STRENGTH),
    smoothKinkHalfCells: readIntegerIn(record['smoothKinkHalfCells'], SMOOTH_KINK_HALF_CELLS_MIN, SMOOTH_KINK_HALF_CELLS_MAX, DEFAULT_SMOOTH_KINK_HALF_CELLS),
    carveDepthBands: readCarveDepthBands(record['carveDepthBands']),
    showControls: readShowControls(record['showControls']),
    panelOpen: readPanelOpen(record['panelOpen']),
  };
}

function loadHudState(): PersistedHudState {
  try {
    return parseHudState(localStorage.getItem(STORAGE_KEY));
  } catch {
    return DEFAULT_HUD_STATE;
  }
}

const stored = loadHudState();

const [brushRadius, setBrushRadiusSignal] = createSignal<number>(
  stored.brushRadius,
);
const [brushTool, setBrushToolSignal] = createSignal<SculptTool>(
  stored.brushTool,
);
const [brushProfile, setBrushProfileSignal] = createSignal<SculptProfile>(
  stored.brushProfile,
);

const [sculptMode, setSculptModeSignal] = createSignal<SculptMode>(
  stored.sculptMode,
);

/** Whether a chord is held. It inverts the toggle, so it is never persisted. */
const [sculptChord, setSculptChordSignal] = createSignal<boolean>(false);

/** Whether the alt chord is held. It narrows the drag, never persisted. */
const [sculptAlt, setSculptAltSignal] = createSignal<boolean>(false);

const [nudgeStrength, setNudgeStrengthSignal] = createSignal<number>(
  stored.nudgeStrength,
);

const [smoothKinkHalfCells, setSmoothKinkHalfCellsSignal] = createSignal<number>(
  stored.smoothKinkHalfCells,
);

const [carveDepthBands, setCarveDepthBandsSignal] = createSignal<number>(
  stored.carveDepthBands,
);

const [showControls, setShowControlsSignal] = createSignal<boolean>(
  stored.showControls,
);

const [panelOpen, setPanelOpenSignal] = createSignal<boolean>(
  stored.panelOpen,
);

function persist(): void {
  const state: PersistedHudState = {
    brushRadius: brushRadius(),
    brushTool: brushTool(),
    brushProfile: brushProfile(),
    sculptMode: sculptMode(),
    nudgeStrength: nudgeStrength(),
    smoothKinkHalfCells: smoothKinkHalfCells(),
    carveDepthBands: carveDepthBands(),
    showControls: showControls(),
    panelOpen: panelOpen(),
  };
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
  }
}

export function setBrushRadius(radius: number): void {
  if (radius === brushRadius()) return;
  setBrushRadiusSignal(radius);
  persist();
}

/** Moves the brush `rungs` steps along the size ladder, stopping at either end. */
export function stepBrushRadius(rungs: number): void {
  const at = Math.max(0, BRUSH_RADII.indexOf(brushRadius()));
  const next = Math.min(BRUSH_RADII.length - 1, Math.max(0, at + rungs));
  setBrushRadius(BRUSH_RADII[next]!);
}

export function setBrushTool(tool: SculptTool): void {
  if (tool === brushTool()) return;
  setBrushToolSignal(tool);
  persist();
}

export function setBrushProfile(profile: SculptProfile): void {
  if (profile === brushProfile()) return;
  setBrushProfileSignal(profile);
  persist();
}

export function setSculptMode(mode: SculptMode): void {
  if (mode === sculptMode()) return;
  setSculptModeSignal(mode);
  persist();
}

export function setSculptChord(held: boolean): void {
  if (held !== sculptChord()) setSculptChordSignal(held);
}

export function setSculptAlt(held: boolean): void {
  if (held !== sculptAlt()) setSculptAltSignal(held);
}

/** What a press sculpts right now: the toggle, inverted while a chord is held. */
export function effectiveSculptMode(): SculptMode {
  return sculptChord() ? oppositeSculptMode(sculptMode()) : sculptMode();
}

export function setNudgeStrength(strength: number): void {
  const clamped = Math.min(NUDGE_STRENGTH_MAX, Math.max(NUDGE_STRENGTH_MIN, Math.trunc(strength)));
  if (clamped === nudgeStrength()) return;
  setNudgeStrengthSignal(clamped);
  persist();
}

export function setSmoothKinkHalfCells(cells: number): void {
  const clamped = Math.min(SMOOTH_KINK_HALF_CELLS_MAX, Math.max(SMOOTH_KINK_HALF_CELLS_MIN, Math.trunc(cells)));
  if (clamped === smoothKinkHalfCells()) return;
  setSmoothKinkHalfCellsSignal(clamped);
  persist();
}

export function setCarveDepthBands(bands: number): void {
  const clamped = Math.min(
    CARVE_MAX_DEPTH_BANDS,
    Math.max(CARVE_MIN_DEPTH_BANDS, Math.trunc(bands)),
  );
  if (clamped === carveDepthBands()) return;
  setCarveDepthBandsSignal(clamped);
  persist();
}

export function setShowControls(show: boolean): void {
  if (show === showControls()) return;
  setShowControlsSignal(show);
  persist();
}

export function setPanelOpen(open: boolean): void {
  if (open === panelOpen()) return;
  setPanelOpenSignal(open);
  persist();
}

export {
  brushRadius,
  brushTool,
  brushProfile,
  sculptMode,
  sculptAlt,
  nudgeStrength,
  smoothKinkHalfCells,
  carveDepthBands,
  showControls,
  panelOpen,
};

export function sculptDirection(mode: SculptMode): 1 | -1 {
  return mode === 'raise' ? 1 : -1;
}

export function oppositeSculptMode(mode: SculptMode): SculptMode {
  return mode === 'raise' ? 'lower' : 'raise';
}
