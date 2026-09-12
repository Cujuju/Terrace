import { createSignal } from 'solid-js';
import type { RendererBackendName } from '../render/rendererBackend.ts';
import {
  CELL_WORLD_SIZE,
  FULL_BRUSH_RADIUS,
  MAX_BRUSH_RADIUS,
  MIN_BRUSH_RADIUS,
  SCULPT_PROFILES,
  SCULPT_TOOLS,
  WIRE_DEFAULT_SCULPT_OPTIONS,
  WORLD_UNIT_CELLS,
  forEachFootprintOffset,
  type SculptProfile,
  type SculptTool,
} from '@terrace/shared';
import type { ConnectionStatus } from '../net/connection.ts';
import type { FrameStatsSample } from '../render/frameStats.ts';

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

const [connectionStatus, setConnectionStatus] =
  createSignal<ConnectionStatus>('connecting');

export interface WorldIdentity {
  readonly name: string | null;
  readonly difficulty: number | null;
}

const [worldIdentity, setWorldIdentitySignal] = createSignal<WorldIdentity>({
  name: null,
  difficulty: null,
});

export function setWorldIdentity(identity: WorldIdentity): void {
  const name = identity.name?.trim() ?? '';
  const difficulty = identity.difficulty;
  setWorldIdentitySignal({
    name: name === '' ? null : name,
    difficulty:
      typeof difficulty === 'number' && Number.isFinite(difficulty)
        ? Math.round(difficulty)
        : null,
  });
}

const [serverVersion, setServerVersionSignal] = createSignal<string | null>(
  null,
);

export function setServerVersion(version: string | null | undefined): void {
  const trimmed = version?.trim() ?? '';
  setServerVersionSignal(trimmed === '' ? null : trimmed);
}

const [frameRate, setFrameRateSignal] = createSignal<number | null>(null);

export function setFrameRate(fps: number): void {
  setFrameRateSignal(fps);
}

export interface FrameDrawAccounting {
  readonly calls: number;
  readonly objects: number;
  readonly budget: number;
}

const [frameDraw, setFrameDrawSignal] = createSignal<FrameDrawAccounting | null>(
  null,
);

export function setFrameDraw(accounting: FrameDrawAccounting): void {
  setFrameDrawSignal(accounting);
}

/** What is drawing and what is meshing, sampled: a runtime demotion moves the mesher. */
export interface RenderPath {
  readonly backend: RendererBackendName;
  readonly mesher: 'gpu' | 'cpu';
}

const [renderPath, setRenderPathSignal] = createSignal<RenderPath | null>(null);

export function setRenderPath(path: RenderPath): void {
  setRenderPathSignal(path);
}

const [frameStats, setFrameStatsSignal] = createSignal<FrameStatsSample | null>(
  null,
);

export function setFrameStats(sample: FrameStatsSample | null): void {
  setFrameStatsSignal(sample);
}

const [perfOpen, setPerfOpenSignal] = createSignal(false);

export function setPerfOpen(open: boolean): void {
  setPerfOpenSignal(open);
}

const STORAGE_KEY = 'terrace.hudState.v2';

export const DEFAULT_BRUSH_RADIUS = WORLD_UNIT_CELLS;

export const DEFAULT_BRUSH_TOOL: SculptTool = WIRE_DEFAULT_SCULPT_OPTIONS.tool;

export const DEFAULT_BRUSH_PROFILE: SculptProfile = 'hard';

export const DEFAULT_SCULPT_MODE: SculptMode = 'raise';

export const DEFAULT_SHOW_CONTROLS = false;

export const DEFAULT_PANEL_OPEN: boolean =
  typeof navigator === 'undefined' || !(navigator.maxTouchPoints > 0);

export interface PersistedHudState {
  readonly brushRadius: number;
  readonly brushTool: SculptTool;
  readonly brushProfile: SculptProfile;
  readonly sculptMode: SculptMode;
  readonly showControls: boolean;
  readonly panelOpen: boolean;
}

export const DEFAULT_HUD_STATE: PersistedHudState = {
  brushRadius: DEFAULT_BRUSH_RADIUS,
  brushTool: DEFAULT_BRUSH_TOOL,
  brushProfile: DEFAULT_BRUSH_PROFILE,
  sculptMode: DEFAULT_SCULPT_MODE,
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
  connectionStatus,
  setConnectionStatus,
  worldIdentity,
  serverVersion,
  frameRate,
  frameDraw,
  renderPath,
  frameStats,
  perfOpen,
  brushRadius,
  brushTool,
  brushProfile,
  sculptMode,
  showControls,
  panelOpen,
};

export function sculptDirection(mode: SculptMode): 1 | -1 {
  return mode === 'raise' ? 1 : -1;
}
