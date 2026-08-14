// The ONE path that applies terrain edits and puts them on the wire.
//
// Both callers — the player intent pipeline and the plugin WorldApi — go
// through here, on purpose: if "apply, then filter, then broadcast, then notify
// plugins" were open-coded at each call site, the anti-cheat filter would be one
// forgotten line away from leaking locked terrain. There is exactly one line to
// audit, and it is in this file.

import type { CellDiff } from '@terrace/shared';
import { filterDiffToUnlocked } from './mask-filter.ts';
import type { World } from './world.ts';

/**
 * What this service needs from the plugin host. Structural, so tests can pass a
 * stub and so world code never imports the host (no cycles).
 */
export interface TerrainChangeListener {
  notifyTerrainChanged(diff: readonly CellDiff[]): void;
}

/**
 * Applies an authoritative sculpt and publishes it.
 *
 * 1. shared/applySculpt: brush + gradient relaxation (the same math the client
 *    predicts with — design §3.3).
 * 2. ANTI-CHEAT: filter the resulting diff down to unlocked chunks only.
 *    Relaxation spills across chunk borders, so this is a real, routinely-hit
 *    filter, not a formality.
 * 3. Broadcast the filtered diff — skipped entirely when nothing visible
 *    changed, so an edit whose whole cascade lands in locked terrain generates
 *    no traffic at all (and leaks nothing by its mere existence).
 * 4. Notify plugins with the FULL diff: plugins are trusted server-side code
 *    and need the true world state (a mana plugin charging per changed cell
 *    must not be fooled by the mask).
 *
 * Returns the full diff.
 */
export function applyServerSculpt(
  world: World,
  listener: TerrainChangeListener,
  x: number,
  y: number,
  radius: number,
  amount: number,
): CellDiff[] {
  const diff = world.applySculpt(x, y, radius, amount);
  if (diff.length === 0) return diff;

  const visible = filterDiffToUnlocked(world, diff);
  if (visible.length > 0) {
    world.broadcast({ type: 'terrainDiff', cells: visible });
  }

  listener.notifyTerrainChanged(diff);
  return diff;
}
