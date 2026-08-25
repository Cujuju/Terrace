// temples — server half: the one player-placed building in the game.
//
// The player holds the Temple tool in the bottom toolbar and presses the
// ground; this half decides whether the ground will take it, remembers where
// it stands, and tells every client. Everything that COMES OUT of the temple
// — the settlers, and the homes they found — lives in the pilgrims plugin,
// with the rest of the little people; it reads this plugin's
// `standingTemple()` through the ordinary cross-plugin bridge and this file
// knows nothing about it. See ../protocol.ts for the mechanic in a paragraph.
//
// ─────────────────────────────────────────────────────────────────────────────
// EXACTLY ONE TEMPLE, AND MOVING IT MEANS KNOCKING IT DOWN (owner, 2026-08-24:
// "You can place one and you can move it by destroying it and rebuilding it").
// That is why the state here is a single nullable cell rather than a
// collection: "one temple" is not a cap this file enforces against a list, it
// is the SHAPE of the state, so a second temple is unrepresentable rather than
// merely refused.
//
// AUTHORITY. A press is an INTENT, exactly like a sculpt (CLAUDE.md's hard
// rule: clients send intents, never state). The client half predicts nothing:
// it draws a ghost while the tool is held and the real temple only when this
// half says the temple exists. So a refusal needs no reconciliation message —
// there is nothing on the client to claw back.
//
// FULL-STATE PUSHES, NEVER DELTAS. The whole state is two integers or a null,
// so every push carries all of it (skipEmpty: false — the fog-of-war default
// for a REPLACE message, see WorldApi.broadcastVisible: a player who cannot
// see the temple's cell is told "no temple", which is exactly what they should
// draw).
// ─────────────────────────────────────────────────────────────────────────────

import type { CellDiff } from '@terrace/shared';
import type {
  PersistenceSlice,
  Player,
  TerracePlugin,
  WorldApi,
} from '../../../server/src/plugins/types.ts';
import {
  TEMPLES_PLUGIN_NAME,
  TEMPLE_PLACE_MESSAGE,
  TEMPLE_REMOVE_MESSAGE,
  TEMPLE_STATE_MESSAGE,
  TEMPLE_SURVEY_RADIUS_CELLS,
  packTemple,
  parseTemplePlacePayload,
  type TempleCell,
} from '../protocol.ts';
import { isTempleSite } from './suitability.ts';

// ── Mutable module state ─────────────────────────────────────────────────────
// Module-level singletons with a reset seam, matching every other plugin here.

/** Where the temple stands, or null while the world has none. Persisted. */
let temple: TempleCell | null = null;

/** Restored from a snapshot, held until onWorldCreate — flora's identical seam. */
let restoredTemple: TempleCell | null = null;

// ────────────────────────────────────────────────────────────────────────────
// Wire
// ────────────────────────────────────────────────────────────────────────────

/**
 * Pushes the whole state. `onlyPlayerId` narrows the fan-out to one recipient
 * (the join snapshot); absent, everyone hears it.
 *
 * The item list is the temple or nothing, and `buildPayload` re-packs
 * whichever survived the recipient's own visibility filter — so a player
 * whose mask does not cover the temple's cell receives the empty state rather
 * than the temple's coordinates, and learns nothing about land they have not
 * unlocked.
 */
function broadcastState(world: WorldApi, onlyPlayerId?: string): void {
  world.broadcastVisible(
    TEMPLE_STATE_MESSAGE,
    temple === null ? [] : [temple],
    (cell) => cell,
    (visible) => ({ temple: packTemple(visible[0] ?? null) }),
    onlyPlayerId === undefined ? undefined : { onlyPlayerId },
  );
}

// ────────────────────────────────────────────────────────────────────────────
// The two intents
// ────────────────────────────────────────────────────────────────────────────

/**
 * `temples:place`. Refused — silently, with no state change and no push —
 * when a temple already stands (moving one means removing it first, so a
 * place on top of a standing temple is a client that got ahead of its own
 * state, not a case to be clever about) or when the ground will not take it.
 *
 * SILENTLY IS THE POINT: the client already knows both answers. It offers no
 * placement ghost where the ground looks wrong and none at all while a temple
 * stands, so the only way to reach a refusal here is a malformed or
 * out-of-date client — the case every plugin's message handler answers by
 * doing nothing.
 */
function placeTemple(world: WorldApi, payload: unknown): void {
  if (temple !== null) return;
  const cell = parseTemplePlacePayload(payload);
  if (cell === null) return;
  if (!isTempleSite(world, cell.x, cell.y)) return;

  temple = cell;
  broadcastState(world);
  // The chronicle's ear: a temple going up is a world event a historian can
  // use, in the loose by-name shape WorldApi.emitEvent documents. Nothing in
  // this repo consumes it yet; emitting costs one fan-out over a handful of
  // plugins and means the event exists when something does.
  world.emitEvent('raised', { x: cell.x, y: cell.y });
}

/** `temples:remove`. A no-op when there is nothing standing. */
function removeTemple(world: WorldApi): void {
  if (temple === null) return;
  const fallen = temple;
  temple = null;
  broadcastState(world);
  world.emitEvent('fallen', { x: fallen.x, y: fallen.y, cause: 'razed' });
}

/**
 * THE REACTIVE PATH, structures' own rule applied to this one building: an
 * edit that breaks the ground under the temple knocks it down, in the same
 * call that applied the edit and before the terrain diff reaches any client.
 *
 * WHY THE WHOLE FOOTPRINT AND NOT JUST THE TEMPLE'S OWN CELL. The temple is
 * two world units across and its ground is guaranteed flat, dry and unlocked
 * across a whole surveyed square (../protocol.ts's footprint contract); an
 * edit one cell away can therefore leave it standing over a terrace edge
 * without ever touching the cell it stands on. structures accepts exactly
 * that lag for its own buildings (a neighbour's edit is left for the next CA
 * generation to notice) because it re-surveys its whole board every fifteen
 * seconds anyway — this plugin has no such sweep, so an edit inside the
 * footprint is re-validated HERE or never. Cheap, too: a diff is scanned once
 * against one cell's neighbourhood, and only when a temple exists at all.
 */
function reactToTerrain(world: WorldApi, diff: readonly CellDiff[]): void {
  if (temple === null || diff.length === 0) return;

  let touched = false;
  for (const cell of diff) {
    if (
      Math.abs(cell.x - temple.x) <= TEMPLE_SURVEY_RADIUS_CELLS &&
      Math.abs(cell.y - temple.y) <= TEMPLE_SURVEY_RADIUS_CELLS
    ) {
      touched = true;
      break;
    }
  }
  if (!touched) return;
  if (isTempleSite(world, temple.x, temple.y)) return;

  const fallen = temple;
  temple = null;
  broadcastState(world);
  // A different STORY from a razing (the ground moved, not a hand on the
  // tool), so the cause travels — structures' own sculpt/generation split.
  world.emitEvent('fallen', { x: fallen.x, y: fallen.y, cause: 'sculpt' });
}

// ────────────────────────────────────────────────────────────────────────────
// The plugin
// ────────────────────────────────────────────────────────────────────────────

function isPersistedTemple(value: unknown): value is TempleCell {
  if (typeof value !== 'object' || value === null) return false;
  const cell = value as { x?: unknown; y?: unknown };
  return Number.isInteger(cell.x) && Number.isInteger(cell.y);
}

const persistence: PersistenceSlice = {
  save(): unknown {
    return { temple: temple === null ? null : { x: temple.x, y: temple.y } };
  },
  load(data: unknown): void {
    // REPLACE, never merge — the re-runnable contract PersistenceSlice
    // states: load()+onWorldCreate() run again on a live world when an
    // operator rolls it back, and a restore that kept the current temple
    // would leave the world with the wrong one standing.
    restoredTemple = null;
    if (typeof data !== 'object' || data === null) return;
    const saved = (data as { temple?: unknown }).temple;
    if (isPersistedTemple(saved)) restoredTemple = { x: saved.x, y: saved.y };
  },
};

export const plugin: TerracePlugin = {
  name: TEMPLES_PLUGIN_NAME,

  onWorldCreate(world: WorldApi): void {
    // RE-VALIDATE ON LOAD, structures' footprint-prune rule (its
    // onWorldCreate) for the same reason: a snapshot restored onto a smaller
    // world, or onto ground a later edit or a stricter rule has spoiled,
    // must not put a temple back standing over a terrace edge. Prune, never
    // grandfather — the whole point of the site rule is that this building
    // never renders hanging off its own ground.
    temple =
      restoredTemple !== null &&
      isTempleSite(world, restoredTemple.x, restoredTemple.y)
        ? restoredTemple
        : null;
    restoredTemple = null;

    // No players are connected yet — this is only so a client already
    // listening at boot is not left empty until someone joins.
    broadcastState(world);
  },

  onTerrainChanged(world: WorldApi, diff: readonly CellDiff[]): void {
    reactToTerrain(world, diff);
  },

  onPlayerJoin(world: WorldApi, player: Player): void {
    broadcastState(world, player.id);
  },

  messages: {
    [TEMPLE_PLACE_MESSAGE]: (world, _player, payload) => placeTemple(world, payload),
    [TEMPLE_REMOVE_MESSAGE]: (world) => removeTemple(world),
  },

  persistence,
};

// ────────────────────────────────────────────────────────────────────────────
// The bridge-facing surface
// ────────────────────────────────────────────────────────────────────────────

/**
 * Where the temple stands, or null. THE PILGRIMS-FACING SURFACE: that plugin
 * duck-types this off this module through the dynamic-import bridge pattern
 * (plugins/relics/server/mana-bridge.ts owns the pattern's four rules) to
 * decide where its settlers walk out from. A plain read — this plugin never
 * learns it has a consumer.
 */
export function standingTemple(): TempleCell | null {
  return temple;
}

/** Test seam: drops all state so a suite can start from zero. */
export function resetTemplesState(): void {
  temple = null;
  restoredTemple = null;
}
