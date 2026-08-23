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
  WORLD_UNIT_CELLS,
  type SculptProfile,
  type SculptTool,
} from '@terrace/shared';
import type { ConnectionStatus } from '../net/connection.ts';

/**
 * The brush ladder the player picks from, in cells: one, two, three and four
 * WORLD UNITS of ground, the same four sizes offered since 2026-08-13.
 *
 * THE LADDER IS IN WORLD UNITS AND THE BOUNDS ARE NOT (2026-08-21). It used to
 * be every integer radius from shared's MIN_BRUSH_RADIUS to MAX_BRUSH_RADIUS,
 * which was the same four sizes back when a cell was a world unit. After the
 * re-sample that range is thirteen rungs, twelve of them a quarter of a world
 * unit apart — brushes a player cannot tell apart — and its first rung is the
 * one-CELL brush, which cannot raise a terrace at all (see MIN_BRUSH_RADIUS,
 * where the floor's job is spelled out). So the ladder states the sizes it
 * always meant, and the ceiling is still shared's: `expect`ed to be the top
 * rung by hudState's own test, so widening the wire bound without revisiting
 * this list fails loudly.
 *
 * THE SINGLE-CELL BRUSH IS BACK ON THE LADDER (owner, 2026-08-22: "can we add
 * brush size one?"). It is the ONE sub-world-unit rung offered, and it is
 * offered as the exception the paragraph above describes rather than as a
 * reopening of it: the twelve rungs between it and one world unit are still
 * brushes a player cannot tell apart, but the floor itself is qualitatively a
 * different tool — the finest mark the grid can express. MIN_BRUSH_RADIUS's
 * own note spells out what it does and does not do: a click on it settles
 * inside band 0 rather than raising a terrace, so it polishes and it does not
 * build. That is the tool the owner asked for, not a defect in it.
 */
export const BRUSH_RADII: readonly number[] = [
  MIN_BRUSH_RADIUS,
  ...Array.from(
    { length: MAX_BRUSH_RADIUS / WORLD_UNIT_CELLS },
    (_, i) => (i + 1) * WORLD_UNIT_CELLS,
  ),
];

/** Selectable brush tools / edge profiles, straight from shared's own sets. */
export const BRUSH_TOOLS: readonly SculptTool[] = SCULPT_TOOLS;
export const BRUSH_PROFILES: readonly SculptProfile[] = SCULPT_PROFILES;

/** Which way a sculpt stroke moves the land. Mirrors SculptIntent['dir']. */
export type SculptMode = 'raise' | 'lower';

const [connectionStatus, setConnectionStatus] =
  createSignal<ConnectionStatus>('connecting');

/**
 * Who this world IS, as the join snapshot stated it: its name and its 1–100
 * difficulty rating. Both fields are nullable because both are optional on the
 * wire (JoinSnapshotMessage) — a server built before world names sends neither,
 * and the HUD must show nothing rather than invent either one.
 */
export interface WorldIdentity {
  readonly name: string | null;
  readonly difficulty: number | null;
}

const [worldIdentity, setWorldIdentitySignal] = createSignal<WorldIdentity>({
  name: null,
  difficulty: null,
});

/**
 * Server-derived and therefore NOT persisted (see the file header): a world's
 * identity arrives on every join, and a cached copy could only ever be a stale
 * lie — the player may have pointed the client at a different world entirely.
 *
 * NORMALISATION LIVES HERE, at the one door into this signal, rather than at
 * the call site: the fields come off the wire, so a blank name or a non-numeric
 * difficulty must become "unknown" exactly once, for every caller. A rating is
 * rounded to an integer because that is what the scale is — the HUD prints it
 * verbatim and must never render "Difficulty 37.4000001".
 */
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

/**
 * Build identity of the connected server, from the join snapshot's
 * `serverVersion` (see shared/protocol.ts on the field and
 * ui/VersionWatermark.tsx for the why). Server-derived, so NOT persisted (file
 * header rule): a cached stamp for a server this client is no longer talking
 * to could only ever be a stale lie. Null until a snapshot arrives, and null
 * after a snapshot from a server too old to send one — the watermark then
 * shows the client stamp alone rather than inventing a match.
 */
const [serverVersion, setServerVersionSignal] = createSignal<string | null>(
  null,
);

export function setServerVersion(version: string | null | undefined): void {
  const trimmed = version?.trim() ?? '';
  setServerVersionSignal(trimmed === '' ? null : trimmed);
}

/**
 * Measured frames per second, published by render/frameRate.ts once per
 * sampling window (never per frame — a signal written 60 times a second would
 * re-render the HUD 60 times a second to display a number that cannot be read
 * that fast).
 *
 * Null until the first window closes: the meter must show nothing rather than
 * a made-up figure, the same absent-means-unknown contract the server version
 * above and the world header's fields keep. Not persisted, for the same reason
 * as the server stamp — it is a fact about THIS session's rendering, and a
 * cached one could only ever be a stale lie about the machine's health.
 */
const [frameRate, setFrameRateSignal] = createSignal<number | null>(null);

export function setFrameRate(fps: number): void {
  setFrameRateSignal(fps);
}

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
//
// v1 → v2 (2026-08-22, owner bug report "lowering does not always work"): the
// 2026-08-21 re-sample changed what a stored `brushRadius` MEANS without
// changing the schema it is stored under. The numbers 1–4 were world units and
// became cells, so every player who had ever picked a brush silently got a
// quarter of the ground they chose — and radius 1–3 is not on the picker's
// ladder at all, so no brush button rendered as active. A value whose UNIT
// changes is a schema change; orphaning the old entries is exactly what the
// versioned key is for.
// ---------------------------------------------------------------------------

const STORAGE_KEY = 'terrace.hudState.v2';

/**
 * One world unit of ground, the Populous point brush, is the least surprising
 * default. NOT shared's MIN_BRUSH_RADIUS: that is the grid's floor, four times
 * finer since the 2026-08-21 re-sample, and a player who has picked nothing
 * should get the brush the game is tuned around.
 *
 * WRITTEN AS THE CONVERSION, NOT AS `BRUSH_RADII[0]` (2026-08-22). It was the
 * ladder's first rung while the ladder started at one world unit; the moment
 * the single-cell brush was added below it, the index silently became the
 * finest brush in the game. What this constant means is "one world unit", so
 * that is now what it says.
 */
export const DEFAULT_BRUSH_RADIUS = WORLD_UNIT_CELLS;

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

/**
 * The control-settings editor starts hidden — the HUD is a sculpting tool
 * first. (Since the 2026-08-19 layout it is the bottom-right settings POPUP;
 * before that, an inline collapsed section. Same fact persisted either way:
 * "the player has the control settings showing".)
 */
export const DEFAULT_SHOW_CONTROLS = false;

/**
 * Whether the INFO panel (top left: status, plugin panels, control hints —
 * the whole tools panel, before the 2026-08-19 corner split moved the brush
 * out of it) starts expanded, PER DEVICE CLASS (owner
 * report, 2026-08-14: on an iPhone the open panel covers half the world).
 * A touchscreen starts collapsed to a tab and expands on tap; a desktop, with
 * screen to spare and a hover cursor, starts open as it always has. The
 * device check is static for the life of the page, and the player's own
 * toggle is persisted over this default like every other HUD choice.
 * The predicate is the SAME `maxTouchPoints > 0` the HUD's touch-hint uses —
 * one definition of "this is a touch device" — and it must be the positive
 * form: environments without the field at all (bare node, some DOM stubs)
 * report undefined, which is "not a touchscreen", not "unknown, assume phone".
 */
export const DEFAULT_PANEL_OPEN: boolean =
  typeof navigator === 'undefined' || !(navigator.maxTouchPoints > 0);

/** Everything persisted, in the shape it is stored and restored in. */
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
 *
 * THE RADIUS IS VALIDATED AGAINST THE LADDER, NOT THE PROTOCOL BOUNDS
 * (2026-08-22). It used to accept any integer in [MIN_BRUSH_RADIUS,
 * MAX_BRUSH_RADIUS] — the WIRE's range, which is a fact about what an intent
 * may legally carry, not about what this picker can show. Every rung the
 * picker does not offer is a value it cannot render as selected, so restoring
 * one leaves the Brush row with no active button and the player holding a
 * brush no click of theirs could have chosen. The v1 → v2 key bump above
 * clears the entries that already went stale; this is the guard that stops a
 * future change to BRUSH_RADII from re-creating them.
 */
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
    panelOpen: readPanelOpen(record['panelOpen']),
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
 * Whether the whole tools panel is expanded, or collapsed to its tab (see
 * DEFAULT_PANEL_OPEN for the per-device default). Persisted like the rest:
 * closing the panel on a phone is a choice about this device, and it should
 * hold across reloads.
 */
const [panelOpen, setPanelOpenSignal] = createSignal<boolean>(
  stored.panelOpen,
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
    panelOpen: panelOpen(),
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
  brushRadius,
  brushTool,
  brushProfile,
  sculptMode,
  showControls,
  panelOpen,
};

/** The `dir` field of a SculptIntent for the current mode. */
export function sculptDirection(mode: SculptMode): 1 | -1 {
  return mode === 'raise' ? 1 : -1;
}
