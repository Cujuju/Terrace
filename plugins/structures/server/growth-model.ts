// THE GROWTH-MODEL SEAM — how a settlement grows, made replaceable, without
// making anything else about a settlement replaceable.
//
// This plugin stays the owner of the BOARD (which cells have a building on
// them), the WIRE, the tiers, the persistence slice and every downstream
// consumer that reads structures (fire, flora, chronicle, pilgrims). What a
// deployment may swap out is the RULE that decides, once per generation
// interval, what the board looks like next: the shipped Conway CA (./life.ts,
// the default) or another model registered from outside — plugins/populous is
// the first, and this seam exists so it needed no change to any of the five
// things listed above.
//
// ONE OUTCOME SHAPE, ONE APPLY PATH. A model returns exactly what a CA
// generation returns (`GrowthStepResult` is `life.ts`'s GenerationOutcome plus
// the population field), so index.ts applies it through the same swap, the
// same delta broadcast and the same persistence write the CA's own outcome
// goes through. A model that could reach the wire another way would be a
// second definition of what a settlement is.
//
// THE MODEL IS REGISTERED, NOT IMPORTED. This plugin must build and run with
// every other plugin deleted (CLAUDE.md), so it may not name plugins/populous
// — that plugin calls in here, across its own dynamic-import bridge, exactly
// as pilgrims calls into this plugin today. A deployment configured for a
// model whose plugin is absent gets a board that simply never changes, and one
// log line saying so.

import type { StructureCell } from '../protocol.ts';
import type { LiveCellRecord } from './life.ts';
import type { StructuresWorld } from './suitability.ts';

/**
 * The environment variable that picks the model, read once at plugin load.
 *
 * NAMED HERE, RESTATED IN THE MODEL PLUGIN. A model plugin has to read the
 * same variable to know whether it is the active one, and it may not import
 * this module (see the header). That is the same restate-don't-import rule
 * every cross-plugin constant in this repo lives under.
 */
export const STRUCTURES_MODEL_ENV = 'STRUCTURES_MODEL';

/** Today's Conway CA (./life.ts). The default: an unset variable changes nothing. */
export const STRUCTURES_MODEL_LIFE = 'life';

/** The Populous growth model, driven by plugins/populous through this seam. */
export const STRUCTURES_MODEL_POPULOUS = 'populous';

export type StructuresModel = typeof STRUCTURES_MODEL_LIFE | typeof STRUCTURES_MODEL_POPULOUS;

const STRUCTURES_MODELS: readonly StructuresModel[] = [
  STRUCTURES_MODEL_LIFE,
  STRUCTURES_MODEL_POPULOUS,
];

/**
 * Reads and validates STRUCTURES_MODEL, server/src/config.ts's `readInteger`
 * policy applied to an enumerated value: a typo is FATAL rather than a silent
 * fall back to the default, because booting the wrong settlement model is
 * precisely the class of mistake that "boots but is wrong" — a self-hoster who
 * typed `conway` would watch a world that ignores them, hours after the only
 * moment they were still watching the log.
 *
 * A plain `Error` rather than core's `ConfigError`: a plugin may not depend on
 * the server's config module (it pulls the persistence layer with it), and the
 * host reports a throw from a plugin's load with the same fatal-at-boot effect.
 */
export function readStructuresModel(env: NodeJS.ProcessEnv): StructuresModel {
  const raw = env[STRUCTURES_MODEL_ENV]?.trim();
  if (raw === undefined || raw === '') return STRUCTURES_MODEL_LIFE;
  if ((STRUCTURES_MODELS as readonly string[]).includes(raw)) return raw as StructuresModel;
  throw new Error(
    `${STRUCTURES_MODEL_ENV} must be one of ${STRUCTURES_MODELS.join(' | ')}, got ${raw}`,
  );
}

/**
 * One cell of the board as the WIRING handles it: the CA's own record, plus
 * the population a growth model may keep there.
 *
 * OPTIONAL, and it stays optional rather than becoming a required zero: the
 * CA writes records without it (life.ts is untouched by this seam), a slice
 * written before populations existed has no such field, and the one model that
 * cares reads `population ?? 0`. Persisted (./persistence.ts) so a house does
 * not forget its people across a restart.
 */
export interface BoardCellRecord extends LiveCellRecord {
  readonly population?: number;
}

/**
 * What one completed growth step changed — life.ts's GenerationOutcome shape,
 * over BoardCellRecord.
 *
 * `upgraded` is every cell whose TIER CHANGED, in either direction: the wire
 * carries the cell's new tier, not a direction, so a model that can demote a
 * house (populous does — its tier is a function of the ground, which moves)
 * needs no second list and the client needs no new message.
 */
export interface GrowthStepResult {
  readonly nextLive: Map<number, BoardCellRecord>;
  readonly born: StructureCell[];
  readonly upgraded: StructureCell[];
  readonly died: Array<{ x: number; y: number }>;
}

/**
 * The facts a model needs that belong to THIS plugin, handed in rather than
 * re-derived: buildability is one predicate (suitability.ts's isBuildableCell,
 * which also knows about locked territory and another plugin's reservations),
 * and the tier ceiling is the protocol's. A model that copied either would be
 * a second opinion waiting to drift.
 */
export interface GrowthContext {
  /** suitability.ts's isBuildableCell, bound to the live world. */
  isBuildable(x: number, y: number): boolean;
  /** protocol.ts's MAX_STRUCTURE_TIER — the highest tier the client can draw. */
  readonly maxTier: number;
  /** protocol.ts's STRUCTURES_CAP — the most cells the board may ever hold. */
  readonly cap: number;
}

/** A replaceable settlement-growth rule. Called once per generation interval. */
export interface GrowthModel {
  /** Diagnostic only — logged when the model is registered. */
  readonly name: string;
  step(
    world: StructuresWorld,
    live: ReadonlyMap<number, BoardCellRecord>,
    ctx: GrowthContext,
  ): GrowthStepResult;
}

let registered: GrowthModel | null = null;

/**
 * Registers (or, with null, clears) the growth model. LAST WRITER WINS and
 * there is exactly one slot: two models driving one board would be two
 * settlements standing in the same cells.
 */
export function setGrowthModel(model: GrowthModel | null): void {
  registered = model;
}

/** The registered model, or null while none has been (see the header). */
export function growthModel(): GrowthModel | null {
  return registered;
}
