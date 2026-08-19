// The ONE path that applies terrain edits and puts them on the wire.
//
// Both callers — the player intent pipeline and the plugin WorldApi — go
// through here, on purpose: if "apply, then filter, then broadcast, then notify
// plugins" were open-coded at each call site, the anti-cheat filter would be one
// forgotten line away from leaking locked terrain. There is exactly one line to
// audit, and it is in this file.

import type { CellDiff, SculptOptions } from '@terrace/shared';
import { filterDiffToUnlocked } from './mask-filter.ts';
import type { World } from './world.ts';

/**
 * What this service needs from the plugin host. Structural, so tests can pass a
 * stub and so world code never imports the host (no cycles).
 *
 * `sculptorToken` (added issue #17) identifies WHO made this edit, when it was
 * a player: the reveal plugin's per-player creep policy needs to know whose
 * mask to unlock into, and nothing else upstream of onTerrainChanged carries
 * that. Optional because not every edit has a sculptor — see applyServerSculpt.
 */
export interface TerrainChangeListener {
  notifyTerrainChanged(diff: readonly CellDiff[], sculptorToken?: string): void;
}

/**
 * Applies an authoritative sculpt and publishes it.
 *
 * 1. shared/applySculpt: brush, plus gradient relaxation when the options say
 *    so (the same math the client predicts with — design §3.3). `options` is
 *    passed through verbatim; an OMITTED options argument is the shared
 *    library's compatibility default, smooth+soft, which is exactly what the
 *    plugin WorldApi path wants (world-api.ts). Player intents arrive here
 *    already resolved by the pipeline's single call to `sculptOptionsOf`.
 * 2. ANTI-CHEAT: filter the resulting diff down to unlocked chunks only.
 *    Smooth-tool relaxation spills across chunk borders, so this is a real,
 *    routinely-hit filter, not a formality.
 * 3. Broadcast the filtered diff — skipped entirely when nothing visible
 *    changed, so an edit whose whole cascade lands in locked terrain generates
 *    no traffic at all (and leaks nothing by its mere existence). Still
 *    filtered against the UNION mask and still ONE broadcast — see the doc
 *    comment on World.isCellUnlocked for why issue #17 deliberately leaves
 *    this step alone.
 * 4. Notify plugins with the FULL diff: plugins are trusted server-side code
 *    and need the true world state (a mana plugin charging per changed cell
 *    must not be fooled by the mask). `sculptorToken` rides along unchanged
 *    from the caller — a player's own sculpt carries theirs (intent/
 *    pipeline.ts), a plugin-initiated edit via WorldApi.sculpt carries none,
 *    because there is no player to credit a creep unlock to.
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
  options?: SculptOptions,
  sculptorToken?: string,
): CellDiff[] {
  const diff = world.applySculpt(x, y, radius, amount, options);
  if (diff.length === 0) return diff;

  const visible = filterDiffToUnlocked(world, diff);
  if (visible.length > 0) {
    world.broadcast({ type: 'terrainDiff', cells: visible });
  }

  listener.notifyTerrainChanged(diff, sculptorToken);
  return diff;
}
