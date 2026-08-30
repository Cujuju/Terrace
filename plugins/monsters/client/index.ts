// monsters — client half. Draws whatever the server's `monsters:state`
// broadcast says exists, and nothing else.
//
// It holds no authority: it never summons, never moves the monster of its own
// accord, and never predicts. Between the 1 Hz broadcasts it interpolates
// (./interpolation.ts) and plays the idle animation (./models.ts); both are
// purely cosmetic, so a client that misses messages looks stiller, never wrong.
//
// No HUD panel, deliberately: the entire point of this plugin is a thing you
// notice in the water. A counter telling you it is there would be the opposite
// of the feature.
//
// The mist and the lightning around it (./atmosphere.ts) are the same kind of
// thing one step further: pure presentation, invented here, on the client, out
// of the position the server already sent and the frame clock. Nothing about
// them is on the wire, and nothing in the world can observe them. They are the
// SEA's weather and only the sea kinds wear them — see MonsterView.dread.
//
// Everything it touches arrives through ClientPluginCtx: its own Group in the
// scene, the rendered terrain height, the message channel, and the frame clock.

import { Group } from 'three';
import { CELL_WORLD_SIZE } from '@terrace/shared';
import type {
  ClientPluginCtx,
  TerraceClientPlugin,
} from '../../../client/src/plugins/types.ts';
import {
  MONSTERS_PLUGIN_NAME,
  MONSTERS_STATE_MESSAGE,
  parseMonstersPayload,
  type YetiVariant,
  MAX_LIVING_MONSTERS,
} from '../protocol.ts';
import { createDread, type Dread } from './atmosphere.ts';
import { dreadSpecOf } from './dread.ts';
import { MonsterInterpolator, type InterpolatedMonster } from './interpolation.ts';
import { createMonsterModels, type MonsterModel, type MonsterModels } from './models.ts';
import { SEA_SURFACE_WORLD_Y, monsterOriginY, placementRuleOf } from './placement.ts';

/**
 * Per-monster animation phase offset, in radians per unit of id. The golden
 * angle: consecutive ids land as far apart on the cycle as possible.
 *
 * It matters in two places now that a world can hold one monster per habitat:
 * across a banishment and a re-arrival — the newcomer should not resume the
 * departed one's breath mid-stroke — and between two monsters alive at once,
 * whose idle cycles should not be in lockstep even when a player can see both.
 */
const PHASE_RADIANS_PER_ID = Math.PI * (3 - Math.sqrt(5));

/**
 * Cap on the animation clock's advance per frame, in seconds. `onFrame`'s dt is
 * already capped by the host, but the animation clock is an accumulator: this
 * keeps a pathological frame from jumping the idle animation a full cycle.
 */
const MAX_ANIMATION_STEP_SECONDS = 0.1;

/** A monster currently in the scene. */
interface MonsterView {
  readonly model: MonsterModel;
  /**
   * The mist and lightning around it (./atmosphere.ts), or null for a kind that
   * wears no weather.
   *
   * IT IS THE SEA'S WEATHER, and that is why the test is the kind's PLACEMENT
   * rather than a flag: every sheet in the bank is authored at a height above
   * SEA_SURFACE_WORLD_Y and the whole effect is pinned to the waterline, so it
   * is meaningful for exactly the kinds that are placed against the sea surface.
   * On the yeti it would be a bank of mist hanging at sea level under a mountain
   * nine bands up — not "atmosphere for a land monster" but a visible bug. A
   * land creature that wants weather wants a DIFFERENT effect (blowing snow),
   * authored against the ground it stands on; this is not it, and pretending
   * otherwise by parameterising the height would have made one effect that is
   * wrong for both.
   */
  readonly dread: Dread | null;
  /** Fixed at creation from the id — never recomputed per frame. */
  readonly phase: number;
  /**
   * WHICH BODY this view was built from (2026-08-26), or undefined for a kind
   * that has only one.
   *
   * Recorded rather than re-derived because the model cannot be asked: a
   * MonsterModel is a root and an animate(), and nothing in it remembers which
   * constructor made it. The reconcile compares this against the sampled state
   * so a monster whose variant CHANGED under a live id is rebuilt rather than
   * left wearing the old body — see reconcileViews.
   */
  readonly variant: YetiVariant | undefined;
}

/**
 * Module-level singletons, matching the shape of this repo's other plugins. The
 * client host constructs exactly one instance of each plugin (client/src/
 * plugins/host.ts), and `attach`/`dispose` bracket their whole lifetime.
 */
let models: MonsterModels | null = null;
let container: Group | null = null;
const views = new Map<number, MonsterView>();
/**
 * The weather of monsters that have LEFT, still fading out where they stood.
 *
 * The model goes the instant the server stops listing it — the submersion is the
 * plot (see interpolation.ts) — but a mist bank that vanished on the same frame
 * would be a light switch. These outlive their monster by MIST_FADE_SECONDS and
 * are disposed the moment the fade reaches zero, so the list is empty in every
 * frame but the couple of hundred after a banishment.
 */
const retiringDread: Dread[] = [];
const interpolator = new MonsterInterpolator();
let animationSeconds = 0;
let unsubscribeMessages: (() => void) | null = null;
let unsubscribeFrames: (() => void) | null = null;

/**
 * Adds/removes scene objects so `views` matches the sampled state.
 *
 * Written as a general reconcile over a map rather than as "if there is one,
 * show it": the wire format is a list, and a client that assumed the list's
 * length would be a client that breaks on the day the server's cap changes —
 * while looking, until then, exactly correct. That day arrived when monster
 * slots became one PER HABITAT (a sea horror and a yeti can be alive at once)
 * and this function needed no change at all, which is what it was written for.
 */
function reconcileViews(sampled: ReadonlyMap<number, InterpolatedMonster>): void {
  if (models === null || container === null) return;

  for (const [id, monster] of sampled) {
    const existing = views.get(id);
    if (existing !== undefined) {
      if (existing.variant === monster.variant) continue;
      // A LIVE ID WHOSE BODY CHANGED. The server never does this — a variant is
      // chosen once at summon and is readonly for the monster's life
      // (server/summoning.ts) — so this is the belt-and-suspenders half of that
      // rule rather than a mechanic: the one way it can fire in practice is a
      // client that was watching a yeti through a server upgrade, where the
      // pre-variant payload defaulted him and the post-upgrade one names the
      // body he actually has. Rebuilding is the only correct answer available
      // here, and it costs what an arrival costs.
      //
      // The DREAD is deliberately untouched: it is a function of the KIND's
      // placement, not of the body, and tearing it down would blink the weather
      // for a change that is invisible on a swimmer anyway (no sea kind has
      // variants).
      container.remove(existing.model.root);
      const rebuilt = models.create(monster.kind, monster.variant);
      views.set(id, {
        model: rebuilt,
        dread: existing.dread,
        phase: existing.phase,
        variant: monster.variant,
      });
      container.add(rebuilt.root);
      continue;
    }
    const model = models.create(monster.kind, monster.variant);
    container.add(model.root);
    // Each swimmer's weather is derived from its OWN anatomy (dreadSpecOf —
    // 2026-08-19: a bank authored for Cthulhu's 2.4-cell eye height sat over
    // the kraken's waterline eyes). A kind with no spec gets no dread, which
    // is the same set as the non-swimmers.
    const spec = dreadSpecOf(monster.kind);
    const dread = spec !== null ? createDread(spec) : null;
    if (dread !== null) container.add(dread.root);
    views.set(id, { model, dread, phase: id * PHASE_RADIANS_PER_ID, variant: monster.variant });
  }

  for (const [id, view] of views) {
    if (sampled.has(id)) continue;
    container.remove(view.model.root);
    // Geometries and materials are shared per kind and owned by `models`, so
    // there is nothing to dispose here — dropping the Mesh objects is the whole
    // teardown. Disposing them here would tear the resource out from under the
    // next monster of the same kind.
    //
    // The dread is the opposite case: it owns its geometry, its materials and
    // its light outright, so it stays in the scene until it has faded and is
    // then disposed — by renderFrame, which is the only thing here with a dt.
    // A kind that wore none leaves nothing behind.
    if (view.dread !== null) retiringDread.push(view.dread);
    views.delete(id);
  }
}

/**
 * THE RENDER PATH. Runs once per animation frame.
 *
 * Placement is recomputed every frame rather than cached, because both inputs
 * move: the monster drifts between cells, and the seabed under it can be
 * sculpted at any moment. It is one terrainHeightAt lookup for one entity.
 */
function renderFrame(ctx: ClientPluginCtx, dt: number): void {
  const step = Math.min(dt, MAX_ANIMATION_STEP_SECONDS);
  animationSeconds += step;
  interpolator.advance(dt);

  const sampled = interpolator.sample();
  reconcileViews(sampled);

  for (const [id, monster] of sampled) {
    const view = views.get(id);
    if (view === undefined) continue;

    const root = view.model.root;
    // Cell coordinates scale to world X/Z by CELL_WORLD_SIZE — 1 until the
    // 2026-08-21 re-sample, which is why this used to be a bare assignment
    // (see placement.ts).
    // The VERTICAL rule is the KIND's: the two sea horrors hang from the surface
    // at very different depths — which is most of what tells them apart from a
    // distance — and the yeti stands on the snow. placement.ts owns which is
    // which and how many terrain samples each needs.
    root.position.set(
      monster.x * CELL_WORLD_SIZE,
      monsterOriginY(monster.kind, (cx, cy) => ctx.terrainHeightAt(cx, cy), monster.x, monster.y),
      monster.y * CELL_WORLD_SIZE,
    );
    // Models face +X. Rotating +X about Y by θ yields (cos θ, 0, -sin θ), and
    // the monster travels toward (cos heading, 0, sin heading) — hence the
    // negation.
    root.rotation.y = -monster.heading;

    view.model.animate(animationSeconds, view.phase);

    // THE MIST FOLLOWS THE SAME INTERPOLATED POSE the model does, so the bank
    // cannot lag or lead the thing it belongs to. It sits on the SEA SURFACE
    // rather than at the model's origin (which is down at the lurking depth) and
    // is never yawed — mist does not turn with the monster. A kind that wears no
    // weather has none of this (see MonsterView.dread).
    //
    // It is advanced by the CAPPED step rather than the raw dt for the same
    // reason the animation clock is: after a background tab wakes up, a fade
    // must not jump to its end and the lightning clock must not be handed a
    // minute of accumulated waiting.
    if (view.dread !== null) {
      view.dread.root.position.set(
        monster.x * CELL_WORLD_SIZE,
        SEA_SURFACE_WORLD_Y,
        monster.y * CELL_WORLD_SIZE,
      );
      view.dread.update(animationSeconds, step, true);
    }
  }

  // Banished monsters' weather, fading in place. Iterated backwards so a
  // finished one can be spliced out without skipping its neighbour.
  for (let index = retiringDread.length - 1; index >= 0; index--) {
    const dread = retiringDread[index]!;
    dread.update(animationSeconds, step, false);
    if (!dread.isFaded()) continue;
    container?.remove(dread.root);
    dread.dispose();
    retiringDread.splice(index, 1);
  }
}

/**
 * Draw objects one monster's MODEL costs at worst: SIX — the yeti, whose rig
 * bakes to six surfaces (kraken 3, cthulhu 4; measured 2026-08-29).
 */
const MONSTER_MODEL_DRAW_OBJECTS = 6;

/**
 * And its weather: FIVE for a swimmer's dread rig (mist sheets, glow sheet,
 * bolt). Budgeted for every living monster rather than for the swimmers alone,
 * because which kinds carry one is a question for ./dread.ts and not for a
 * ceiling.
 */
const MONSTER_DREAD_DRAW_OBJECTS = 5;

export const clientPlugin: TerraceClientPlugin = {
  name: MONSTERS_PLUGIN_NAME,

  /**
   * Its share of the frame's draw calls, from its own caps — see
   * TerraceClientPlugin.drawBudget and the constants above.
   */
  drawBudget: MAX_LIVING_MONSTERS * (MONSTER_MODEL_DRAW_OBJECTS + MONSTER_DREAD_DRAW_OBJECTS),

  attach(ctx: ClientPluginCtx): void {
    models = createMonsterModels();

    // One child Group of our own inside the host's layer: it keeps the monster
    // under a single named node, which makes the scene graph legible in the
    // three.js inspector and gives dispose() one thing to clear.
    container = new Group();
    container.name = 'monsters:living';
    ctx.layer.add(container);

    unsubscribeMessages = ctx.onMessage(MONSTERS_STATE_MESSAGE, (payload) => {
      const monsters = parseMonstersPayload(payload);
      // A malformed payload is dropped whole: the previous state keeps rendering
      // until the next good message, which is a second away. An EMPTY list is
      // not malformed — it is the despawn, and it is applied.
      if (monsters === null) return;
      interpolator.receive(monsters);
    });

    unsubscribeFrames = ctx.onFrame((dt) => renderFrame(ctx, dt));
  },

  dispose(): void {
    unsubscribeMessages?.();
    unsubscribeFrames?.();
    unsubscribeMessages = null;
    unsubscribeFrames = null;

    for (const view of views.values()) {
      view.model.root.clear();
      // Each dread owns its own GPU resources, so every one of them — living or
      // still fading — is freed here. Nothing may outlive the plugin.
      view.dread?.dispose();
    }
    views.clear();
    for (const dread of retiringDread) dread.dispose();
    retiringDread.length = 0;
    interpolator.clear();

    container?.clear();
    container = null;

    // Shared geometries and materials are freed exactly once, here.
    models?.dispose();
    models = null;
    animationSeconds = 0;
  },
};
