// Shared reactive state between the imperative render/input layer and the
// Solid HUD.
//
// The signals live at MODULE scope, not inside a component. That is deliberate
// on two counts: the imperative layer needs to read and write them without
// being inside a reactive root, and it sidesteps the project's Solid rule
// entirely — there is no component body here to freeze a reactive read in.
// Consumers must call the exported accessors (`brushRadius()`), never store
// their result in a component-body const.
//
// PERSISTENCE: everything the player chose in the HUD survives a reload, under
// one versioned localStorage key, following the same idiom as
// state/controlPrefs.ts — load once at module init, every setter writes
// through, and any failure at either end degrades to a session-only default.
// Server-derived readouts (connection status, and the plugins' mana pool,
// relic skills and invite URL) are deliberately NOT persisted: they are re-sent
// on join, and a cached copy could only ever be a stale lie about the server.

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

// ---------------------------------------------------------------------------
// Persistence
//
// One key holds every persisted HUD field. They are written together (a single
// setItem per change) because they change together in the player's mind — "how
// I had the HUD set up" is one thing, not five — and one key is one entry to
// version, one to orphan on a schema change.
//
// The version lives in the KEY, as in controlPrefs.ts and cameraPose.ts, so a
// future schema change orphans old entries instead of migrating them. There is
// deliberately no second version stamp inside the payload: every field here is
// validated against a tiny closed set (a small integer range, or a literal
// union), so a payload from some other schema cannot masquerade as valid — it
// simply fails per field and yields defaults. (cameraPose stamps one because
// its fields are bare numbers, where a foreign schema's numbers WOULD parse.)
// ---------------------------------------------------------------------------

const STORAGE_KEY = 'terrace.hudState.v1';

/** Radius 1 is the Populous point brush — the least surprising default. */
export const DEFAULT_BRUSH_RADIUS = MIN_BRUSH_RADIUS;

/**
 * Brush tool and edge profile default to the WIRE defaults rather than to
 * literals: the HUD must start on exactly what an intent WITHOUT these fields
 * would mean, or the picker would show one thing on load and the server would
 * do another. (Decision 2026-08-14: stamp + soft is the player-facing default.)
 */
export const DEFAULT_BRUSH_TOOL: SculptTool = WIRE_DEFAULT_SCULPT_OPTIONS.tool;
export const DEFAULT_BRUSH_PROFILE: SculptProfile =
  WIRE_DEFAULT_SCULPT_OPTIONS.profile;

/** Raise is the default direction; lowering is the deliberate act. */
export const DEFAULT_SCULPT_MODE: SculptMode = 'raise';

/** The Controls panel starts collapsed — the HUD is a sculpting tool first. */
export const DEFAULT_SHOW_CONTROLS = false;

/** Everything persisted, in the shape it is stored and restored in. */
export interface PersistedHudState {
  readonly brushRadius: number;
  readonly brushTool: SculptTool;
  readonly brushProfile: SculptProfile;
  readonly sculptMode: SculptMode;
  readonly showControls: boolean;
}

export const DEFAULT_HUD_STATE: PersistedHudState = {
  brushRadius: DEFAULT_BRUSH_RADIUS,
  brushTool: DEFAULT_BRUSH_TOOL,
  brushProfile: DEFAULT_BRUSH_PROFILE,
  sculptMode: DEFAULT_SCULPT_MODE,
  showControls: DEFAULT_SHOW_CONTROLS,
};

/**
 * FALLBACK GRANULARITY — per field, not whole-object as in controlPrefs.ts.
 *
 * The difference is real, not stylistic. A control-binding table is one
 * INTERDEPENDENT scheme: restoring three of its four bindings and defaulting
 * the fourth can silently shadow an action (see ACTION_PRECEDENCE), so a
 * half-restored table is worse than no table, and it falls back whole.
 *
 * The fields here are INDEPENDENT — nothing about the brush radius changes
 * what a tool or an expanded panel means. So one corrupt field costs exactly
 * itself, and a payload written by an older build that simply lacks a field
 * added later still restores everything it does carry. Falling back whole
 * would throw away four good settings to punish one bad one.
 */
function readRadius(value: unknown): number {
  return typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= MIN_BRUSH_RADIUS &&
    value <= MAX_BRUSH_RADIUS
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

/**
 * Parses a stored payload. Unreadable JSON or a non-object gives the defaults
 * outright (there are no fields to salvage); anything else is salvaged field by
 * field. Exported so the parsing contract can be tested without a storage stub.
 */
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
  };
}

/** Reads the stored HUD state, or the defaults if storage is unavailable. */
function loadHudState(): PersistedHudState {
  try {
    return parseHudState(localStorage.getItem(STORAGE_KEY));
  } catch {
    // Storage unavailable (private mode, disabled, node) — session-only
    // defaults. Everything below still works, it just does not outlive the tab.
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

/**
 * Sculpt direction. On desktop this is CONTINUOUSLY re-derived from the held
 * modifier keys by input/sculptInput.ts (`syncMode`), so the restored value
 * there survives only until the first key event — which is correct, the keys
 * are the truth on a keyboard. It is persisted for TOUCH, where the sticky Mode
 * toggle is the only way to switch direction and re-tapping it after every
 * reload is pure friction. Restoring at load and then letting the existing
 * input logic take over needs no change to that logic at all.
 */
const [sculptMode, setSculptModeSignal] = createSignal<SculptMode>(
  stored.sculptMode,
);

/**
 * Whether the Controls panel is expanded. It lives here rather than inside
 * Hud.tsx (where it began as a component-local signal) purely so it can be
 * persisted with the rest: a player who opened the panel to rebind something
 * should not find it shut again on every reload.
 */
const [showControls, setShowControlsSignal] = createSignal<boolean>(
  stored.showControls,
);

/**
 * Writes the whole persisted record. Best effort: a full or unavailable
 * storage costs only the next reload's memory, never the live session.
 */
function persist(): void {
  const state: PersistedHudState = {
    brushRadius: brushRadius(),
    brushTool: brushTool(),
    brushProfile: brushProfile(),
    sculptMode: sculptMode(),
    showControls: showControls(),
  };
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    // Ignored; the in-memory HUD state still applies for this session.
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

/**
 * The no-op guard above is load-bearing on THIS setter in particular:
 * sculptInput calls it on every emitted intent (i.e. on the hold-repeat timer,
 * several times a second while a stroke is held) and on every modifier-key
 * event, almost always with the value it already has. Writing through on every
 * such call would mean a synchronous localStorage write per sculpt tick. Only
 * an actual change touches storage, so no debounce is needed — unlike the
 * camera, whose pose streams genuinely new values every frame (cameraPose.ts).
 */
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

export {
  connectionStatus,
  setConnectionStatus,
  brushRadius,
  brushTool,
  brushProfile,
  sculptMode,
  showControls,
};

/** The `dir` field of a SculptIntent for the current mode. */
export function sculptDirection(mode: SculptMode): 1 | -1 {
  return mode === 'raise' ? 1 : -1;
}
