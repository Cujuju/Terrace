// The fuel registry — how `fire` learns what is flammable without knowing what
// anything IS.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY REGISTRATION, AND NOT A BRIDGE PER FLAMMABLE PLUGIN.
//
// This repo's established way for one plugin to read another is the bridge
// (plugins/relics/server/mana-bridge.ts, plugins/flora/server/structures-
// bridge.ts): a dynamic import of the sibling folder, duck-typed, degrading to
// a warning when the sibling is absent. Applied here it would mean `fire`
// importing flora, then structures, then whatever burns next — a file and an
// edit to this plugin for every new flammable thing in the game, forever.
//
// So the dependency runs the OTHER way. `fire` publishes `registerFuel` and
// knows nothing; each flammable plugin bridges to `fire` and declares itself.
// Adding a burnable thing is then a change to that thing's plugin and to
// nothing else, which is the property that makes this a contract rather than a
// list. `fire` degrades the same way a bridge does: with no fuel registered
// nothing can be lit, which on a world with no flammable plugins installed is
// exactly true.
//
// THE COST OF INVERTING IT, stated honestly: a registration is a WRITE into
// this module, so bridge rule 3 ("buffer, don't drop") lands on the REGISTRANT
// — a plugin whose dynamic import of `fire` has not resolved yet must hold its
// registration and replay it, not drop it. That is the same obligation relics
// already carries for mana, and it is one file's worth of care in each
// registrant against a file's worth of bridge here per registrant.
//
// ORDER. Sources are consulted in registration order, first non-null wins.
// Plugin load order is alphabetical (the host sorts by directory name), so the
// order is stable across boots without anyone having to declare a priority. Two
// sources claiming the same cell is not a conflict worth arbitrating — a cell
// with a building on it has no tree, because flora already treats an occupied
// cell as unplantable.
// ─────────────────────────────────────────────────────────────────────────────

/** What burning one cell of some plugin's stuff amounts to. */
export interface CellFuel {
  /**
   * How long this cell burns, in simulated seconds, from catching to spent.
   * The fuel decides: a tree is a long slow burn, a crop is a flash.
   */
  readonly burnSeconds: number;
  /**
   * How tall the burning thing is, in world units — the only thing that tells
   * the renderer a burning forest from a burning field. A full-grown tree is
   * ~1.5 (plugins/flora/client/models.ts).
   */
  readonly height: number;
}

/** A cell, in the plugin-wide integer-cell coordinates everything else uses. */
export interface FuelCell {
  readonly x: number;
  readonly y: number;
}

/**
 * One plugin's declaration of what it contributes to the world's flammability.
 *
 * Everything here is called from inside `fire`'s own tick or hook, on the
 * server, synchronously. A source must not assume it is the only one.
 */
export interface FuelSource {
  /**
   * Registering plugin's name. Used in logs and to make a re-registration
   * REPLACE rather than duplicate — a plugin whose module is re-imported (the
   * rollback path re-runs load/onWorldCreate) must not end up registered twice.
   */
  readonly name: string;

  /**
   * What is at this cell that could burn, or null for "nothing of mine".
   *
   * Called at IGNITION only, never per tick: a fire's whole life is fixed from
   * this one answer, so a source that is expensive to query pays once per fire
   * rather than once per fire per tick.
   */
  fuelAt(x: number, y: number): CellFuel | null;

  /**
   * These cells finished burning — the fuel is gone. The source destroys
   * whatever was there (flora fells the tree) and broadcasts its own change.
   *
   * Called ONLY for fires that ran to completion. A fire cut short — rained
   * out, or the ground dug from under it — does not consume its fuel and does
   * not call this.
   */
  onBurnedOut(cells: readonly FuelCell[]): void;

  /**
   * Optional: these cells just caught. For a source that wants to react to the
   * start of a burn rather than its end (a building that stops working the
   * moment it is alight). Nothing needs it yet; it exists because a source that
   * only learns about fire when its stuff is already gone cannot do anything
   * about it.
   */
  onIgnited?(cells: readonly FuelCell[]): void;
}

/** Registered sources, in registration order. */
const sources: FuelSource[] = [];

/**
 * Declares a plugin's flammable content. Idempotent per source name: a second
 * registration under the same name REPLACES the first (see FuelSource.name).
 */
export function registerFuel(source: FuelSource): void {
  const existing = sources.findIndex((candidate) => candidate.name === source.name);
  if (existing >= 0) sources[existing] = source;
  else sources.push(source);
}

/**
 * Withdraws a source. Exists for tests and for symmetry; nothing in the shipped
 * server unregisters, because a plugin's flammability does not end while the
 * process lives.
 */
export function unregisterFuel(name: string): void {
  const index = sources.findIndex((candidate) => candidate.name === name);
  if (index >= 0) sources.splice(index, 1);
}

/** Every registered source, in order. Read-only view for the sim. */
export function fuelSources(): readonly FuelSource[] {
  return sources;
}

/** Test seam: forgets every registration. */
export function resetFuelRegistry(): void {
  sources.length = 0;
}

/**
 * What is burnable at this cell, and which source owns it — first non-null
 * answer in registration order (see the header on why first-wins needs no
 * arbitration).
 */
export function fuelAt(x: number, y: number): { fuel: CellFuel; source: FuelSource } | null {
  for (const source of sources) {
    const fuel = source.fuelAt(x, y);
    // A source that answers with a nonsensical burn time is treated as having
    // no fuel rather than trusted: a zero-length fire is already dead by
    // fireIntensity's definition, and admitting one would put an entry in the
    // burning set that never renders and never clears.
    if (fuel !== null && fuel.burnSeconds > 0) return { fuel, source };
  }
  return null;
}
