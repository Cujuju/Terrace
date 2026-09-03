// The light a fire casts on the ground around it.
//
// ─────────────────────────────────────────────────────────────────────────────
// A FIXED POOL, NEVER A LIGHT PER FIRE.
//
// Adding or removing a light invalidates every material's shader program — the
// light count is baked into the program key — so a light per fire would
// recompile the terrain, the water and every creature each time a tree caught.
// That is the same fact plugins/weather/client/rig.ts learned for its storm
// flash, and the reason its light is created with the rig and left in the graph
// at zero intensity between flashes.
//
// Here it is worse than it is for weather, because fires arrive in dozens. So
// the pool is built ONCE at attach, sized at FIRE_LIGHT_POOL_SIZE, and stays in
// the scene graph forever — the lights move between fires and drop to zero
// intensity when there is nothing to light.
//
// WHICH FIRES GET ONE. The fiercest, and that is deliberately not "the nearest":
// ClientPluginCtx exposes no camera (client/src/plugins/types.ts), and the
// fiercest fires are the ones whose glow is worth having anyway. A pool chosen
// by intensity is also STABLE — a fire does not gain and lose its light as the
// player orbits, which a distance-ranked pool would do at every tie.
//
// AND ONCE A SLOT HAS A FIRE, IT KEEPS IT (owner, 2026-09-02: "a bright white
// blob jumps around the burn"). Ranking alone is not stability when the ranking
// key is FLAT: ../protocol.ts's fireIntensity returns exactly 1 for the whole
// plateau between the ignition ramp and the decay tail, so on a burning meadow
// hundreds of cells tie at the top and "the four fiercest" is an arbitrary pick
// among them that the next ranking is free to make differently. Four times a
// second, four lights teleported across the field, each landing at full
// brightness in a new place — which is what the blob was.
//
// So the ranking no longer chooses the whole pool: it only fills slots that
// have NOTHING WORTH KEEPING (see FIRE_LIGHT_HOLD_MIN_INTENSITY), ties break by
// key so an all-equal meadow ranks identically every time, no light is handed
// out inside another's hot centre (see FIRE_LIGHT_MIN_SEPARATION_WORLD_UNITS),
// and every change of fire is RAMPED (see FIRE_LIGHT_HANDOVER_SECONDS) rather
// than jumped.
// ─────────────────────────────────────────────────────────────────────────────

import { Group, PointLight } from 'three';
import type { FireInstance } from './flames/types.ts';

/**
 * How many fires may cast light at once.
 *
 * FOUR. The renderer's other claimant on the light budget is weather's storm
 * flash (one PointLight per live storm, up to MAX_ACTIVE_SYSTEMS = 3), and the
 * scene's own rig is three more; four here keeps the worst case to a single
 * digit, which is the range where WebGL's forward renderer stays cheap. It is
 * also enough that a fire FRONT reads as a band of light rather than as one
 * bright dot, which is the whole point of having more than one.
 */
export const FIRE_LIGHT_POOL_SIZE = 4;

/**
 * How far a fire's light reaches, in world units.
 *
 * A tree is ~1.5 units tall, so 6 lights the tree, its neighbours and the
 * ground between them without washing across a whole terrace. Past this
 * distance the flame still glows — it is unlit geometry — but the ground stops
 * knowing about it, which is the correct place for a cheap approximation to
 * end.
 */
export const FIRE_LIGHT_RANGE_WORLD_UNITS = 6;

/**
 * How far apart two lit fire lights must be, in world units, measured on the
 * ground plane.
 *
 * THE WHITE BLOOM (issue #303, owner 2026-09-02). The ranking below picks the
 * fiercest free fires, and on a burning meadow the fiercest are hundreds of
 * equals (../protocol.ts's plateau) broken by key — a key that ./index.ts
 * hands out in IGNITION ORDER, so the four winners are the four cells that
 * caught one after another: neighbours. Measured live on the owner's stack:
 * three of the four lights on one row of cells 0.25 apart, all four inside
 * one world unit at times. Four lights on one spot are one light at four
 * times the irradiance, and ACESFilmicToneMapping renders that white however
 * warm FIRE_LIGHT_COLOR is — the same failure FIRE_LIGHT_MIN_HEIGHT_WORLD_UNITS
 * closed for a single light, reopened by stacking.
 *
 * Half the range: two lights this far apart still share ground — which is
 * what makes a front read as a BAND rather than four dots — but neither one's
 * hot centre sits inside the other's, so the sum near either never exceeds
 * about twice a single light. A full range apart would stop the band from
 * joining up; a quarter still stacks the two hot centres.
 *
 * Enforced where lights are HANDED OUT, never afterwards: a held light does
 * not move (FIRE_LIGHT_HOLD_MIN_INTENSITY), so two lights that were apart when
 * assigned stay apart for cells. A walking fire (a burning animal) can still
 * carry its light into another's — brief, and preferable to a light that lets
 * go of the animal it is lighting.
 */
export const FIRE_LIGHT_MIN_SEPARATION_WORLD_UNITS = FIRE_LIGHT_RANGE_WORLD_UNITS / 2;

/**
 * How many ranked fires the pass keeps PER FREE SLOT, so the separation rule
 * has something to choose from.
 *
 * With one candidate per slot, the four fiercest fires being neighbours would
 * leave three slots dark rather than lit further along the front. Four gives
 * the assignment sixteen fires to walk on a full refill — still one insertion
 * pass over the field, at most sixteen comparisons per fire. It is not enough
 * to fill every slot in ONE pass on the worst case (a front whose ignition
 * order runs straight along a row: sixteen cells is four world units, room for
 * two separated lights, not four), and that is accepted: a slot left dark is
 * offered the next sixteen on the next pass, FIRE_LIGHT_REASSIGN_SECONDS
 * later, so a band lights up over about a second rather than at once. Sizing
 * for the worst case instead would mean sixty-four comparisons per fire on
 * every pass, for a lag nobody can see.
 */
const CANDIDATES_PER_FREE_SLOT = 4;

/** Peak intensity of one fire light, at intensity 1. Matched to a fire's scale. */
export const FIRE_LIGHT_PEAK_INTENSITY = 2.5;

/**
 * Height above the ground the light sits at — inside the flame for anything
 * tall enough, and never below FIRE_LIGHT_MIN_HEIGHT_WORLD_UNITS.
 */
export const FIRE_LIGHT_HEIGHT_FRACTION_OF_FUEL = 0.5;

/**
 * How close to the ground a fire light may ever sit, in world units.
 *
 * NOT a taste number — it is where three.js's own falloff stops being an
 * inverse square (owner, 2026-09-02: the white blob on a burning meadow was
 * partly this, and it survived the pool being made sticky).
 *
 *   float distanceFalloff = 1.0 / max( pow( lightDistance, decayExponent ), 0.01 );
 *   — three/src/renderers/shaders/ShaderChunk/lights_pars_begin.glsl.js
 *
 * Grass has fuelHeight 0.15, so FIRE_LIGHT_HEIGHT_FRACTION_OF_FUEL puts the
 * light 0.075 above the ground, and pow(0.075, 2) = 0.005625 is BELOW that
 * 0.01 clamp: the ground directly beneath takes the clamp's hard maximum of
 * ×100, an irradiance of 250 that ACESFilmicToneMapping (client/src/render/
 * scene.ts) renders as white however warm FIRE_LIGHT_COLOR is. A tree
 * (fuelHeight 1.5, light at 0.75) gets ×1.78 — 56× less — so the same fraction
 * is right for a tree and degenerate for grass.
 *
 * 0.5 is the smallest round height that clears the clamp with room to spare:
 * pow(0.5, 2) = 0.25 gives ×4, an irradiance of 10 — still a brighter pool of
 * light than a tree fire casts, which is correct for standing in a burning
 * field, but inside the range the tone mapper renders as orange. Floored
 * rather than folded into the fraction because the fraction is right for
 * everything tall; only the short end is broken.
 */
export const FIRE_LIGHT_MIN_HEIGHT_WORLD_UNITS = 0.5;

/** Warm ember orange. Never white: firelight that is not warm reads as a lamp. */
export const FIRE_LIGHT_COLOR = 0xff7a33;

/**
 * Seconds between re-choosing which fires hold the lights.
 *
 * NOT every frame. Re-ranking 400 fires 60 times a second is real work to
 * produce an answer that changes on the scale of a fire's whole life, and a
 * light that hops between two nearly-equal fires every frame flickers in a way
 * no fire does. A quarter second is below the threshold at which the handover
 * is noticeable and 15× cheaper than doing it per frame.
 */
export const FIRE_LIGHT_REASSIGN_SECONDS = 0.25;

/**
 * How fiercely a fire must still be burning to KEEP the light it already holds.
 *
 * The number that makes a slot sticky. A held fire is not re-ranked against the
 * field at all — it is only asked whether it is still worth lighting — so the
 * pool changes at the rate fires DIE, not at the rate the ranking is run. On
 * the meadow that produced the blob that is the difference between four
 * handovers a second and a handover every several seconds per slot.
 *
 * 0.35 is the same threshold, and for the same reason, as ../server/spread.ts's
 * SPREAD_MIN_INTENSITY: it sits inside the plateau of ../protocol.ts's
 * intensity curve, so it excludes the ignition ramp (below
 * FIRE_IGNITION_FRACTION of the life) and the long decay tail (the last
 * FIRE_DECAY_FRACTION) without cutting into the full-strength middle. A fire
 * that has fallen past it is guttering, and a guttering fire is exactly the one
 * whose light should be given to something that is still roaring.
 *
 * RESTATED, NOT IMPORTED. spread.ts is server code and this is client code;
 * the two numbers answer different questions (what spreads, what stays lit) and
 * only happen to share a value, so importing across that seam would assert an
 * agreement that does not exist. ../protocol.ts — the file that DOES bind the
 * two halves — has no intensity floor to borrow.
 */
export const FIRE_LIGHT_HOLD_MIN_INTENSITY = 0.35;

/**
 * Seconds one light takes to leave one fire and arrive at another.
 *
 * THE POP. A light cannot be in two places, so a handover is a fade to black at
 * the old fire followed by a fade up at the new one, half of this each way. It
 * exists because the alternative is a step: before this, a slot changing fire
 * moved and re-lit in a single frame, and a full-strength fire light appearing
 * from nothing in 16 ms is a camera flash, not a fire.
 *
 * 0.3 s is picked from the step it has to hide. At 60 Hz the largest per-frame
 * change becomes FIRE_LIGHT_PEAK_INTENSITY / (0.15 × 60) ≈ 0.28, against 2.5
 * for the jump it replaces — a ninth of the step, and below the frame-to-frame
 * change a flame's own flicker already makes. It is also long enough (0.15 s
 * each way, ~9 frames) that the eye reads a fire dying down and another
 * catching rather than an edge, and short enough that the slot is back at full
 * brightness inside about one FIRE_LIGHT_REASSIGN_SECONDS of being retargeted,
 * so the pool is not spending its life at half strength.
 *
 * Re-targeting a slot mid-handover is safe and needs no special case: every
 * change of fire goes through this same ramp, so there is no path that jumps.
 */
export const FIRE_LIGHT_HANDOVER_SECONDS = 0.3;

/** One direction of a handover — down at the old fire, or up at the new one. */
const HANDOVER_RAMP_SECONDS = FIRE_LIGHT_HANDOVER_SECONDS / 2;

export interface FireLights {
  /** Parent of the pool; add to the plugin's layer. */
  readonly root: Group;
  /**
   * Points the pool at the fiercest of these fires. Cheap to call every frame:
   * the RANKING only re-runs on FIRE_LIGHT_REASSIGN_SECONDS, while the POSE AND
   * BRIGHTNESS of whatever is already held are re-read from this frame's list
   * every frame.
   */
  update(fires: readonly FireInstance[], dt: number): void;
  /** Drops every light to dark. Called when nothing is burning. */
  darken(): void;
}

/**
 * Where a slot is in its handover.
 *
 * `steady` covers both "lit and holding a fire" and "dark, holding nothing" —
 * the two are told apart by `heldKey`, and neither is ramping.
 */
type SlotPhase = 'steady' | 'fadingOut' | 'fadingIn';

interface LightSlot {
  readonly light: PointLight;
  /**
   * WHICH FIRE holds this light — by ./flames/types.ts's `key`, never by the
   * instance object, and 0 for "this slot holds nothing".
   *
   * BUG THIS SHAPE EXISTS TO PREVENT (2026-08-24). The pool used to keep the
   * FireInstance objects the ranking pass was handed, and the caller rebuilds
   * that list every frame — so between two rankings a quarter of a second
   * apart, every held object was a discarded snapshot of a fire as it had been.
   * A light on a burning animal sat where the animal used to be and then jumped
   * (measured at over a world unit behind a fleeing one, four times a second),
   * a light on a fire that had been put out went on burning at full brightness
   * until the next ranking, and brightness climbed in visible steps instead of
   * following the flame.
   *
   * A key cannot go stale: it either matches a fire in THIS frame's list, in
   * which case the light reads that fire's current pose, or it does not, in
   * which case the fire is gone and the light goes out.
   */
  heldKey: number;
  /** The fire this slot takes once its fade-out finishes; 0 for "go dark". */
  pendingKey: number;
  phase: SlotPhase;
  /** 0…1, multiplied onto the held fire's own intensity. The ramp itself. */
  envelope: number;
}

export function createFireLights(): FireLights {
  const root = new Group();
  root.name = 'fire:lights';

  const slots: LightSlot[] = [];
  for (let index = 0; index < FIRE_LIGHT_POOL_SIZE; index++) {
    const light = new PointLight(FIRE_LIGHT_COLOR, 0, FIRE_LIGHT_RANGE_WORLD_UNITS);
    light.visible = true;
    root.add(light);
    slots.push({ light, heldKey: 0, pendingKey: 0, phase: 'steady', envelope: 0 });
  }

  let sinceReassignSeconds = FIRE_LIGHT_REASSIGN_SECONDS;

  /**
   * This frame's instance for each slot's held key, or null. Scratch, reused:
   * nothing here may allocate per frame.
   */
  const heldFires: (FireInstance | null)[] = new Array(FIRE_LIGHT_POOL_SIZE).fill(null);

  /** Scratch for the ranking: the best free fires found, best first. */
  const candidates: (FireInstance | null)[] = new Array(
    FIRE_LIGHT_POOL_SIZE * CANDIDATES_PER_FREE_SLOT,
  ).fill(null);
  let candidateCount = 0;

  /**
   * Scratch: the ground positions of every fire that will be lit after this
   * pass — the kept slots' fires, then each fire as it is handed out — so a
   * candidate can be checked against all of them without a second walk.
   */
  const litX: number[] = new Array(FIRE_LIGHT_POOL_SIZE).fill(0);
  const litZ: number[] = new Array(FIRE_LIGHT_POOL_SIZE).fill(0);
  let litCount = 0;

  const MIN_SEPARATION_SQUARED =
    FIRE_LIGHT_MIN_SEPARATION_WORLD_UNITS * FIRE_LIGHT_MIN_SEPARATION_WORLD_UNITS;

  /** True if this fire sits at least the separation from every light in `lit`. */
  function isSeparated(fire: FireInstance): boolean {
    for (let index = 0; index < litCount; index++) {
      const dx = fire.x - litX[index]!;
      const dz = fire.z - litZ[index]!;
      if (dx * dx + dz * dz < MIN_SEPARATION_SQUARED) return false;
    }
    return true;
  }

  /** Scratch: which slots the ranking is allowed to fill this pass. */
  const slotIsFree: boolean[] = new Array(FIRE_LIGHT_POOL_SIZE).fill(false);

  /**
   * Fills `heldFires` from this frame's list, and drops any slot whose fire has
   * vanished from it.
   *
   * ONE PASS OVER THE FIRES, not one per slot. The inner loop is at most
   * FIRE_LIGHT_POOL_SIZE integer comparisons and it stops as soon as every held
   * key is resolved, so the worst case on the 2000-fire meadow that motivated
   * this file's rewrite is 2000 × 4 = 8000 comparisons over one linear walk of
   * an array the caller has just written (so: in cache) — microseconds, against
   * a ~7 ms frame budget. That is why there is no Map here: building one would
   * cost 2000 hash inserts EVERY frame to save comparisons that are already
   * free, and would allocate.
   *
   * A VANISHED FIRE GOES DARK AT ONCE, with no fade-out, and that is deliberate
   * rather than an omission. There is nothing left to fade AT: the fire is not
   * in this frame's list, so its flame has already left the screen this same
   * frame, and a glow lingering for 0.15 s over ground where no fire stands is
   * a worse artifact than the drop. It is also very nearly invisible anyway — a
   * fire that burns out reaches the end of ../protocol.ts's decay tail at
   * intensity 0, so the light it held was already near zero when it went.
   */
  function resolveHeld(fires: readonly FireInstance[]): void {
    let unresolved = 0;
    for (let slot = 0; slot < FIRE_LIGHT_POOL_SIZE; slot++) {
      heldFires[slot] = null;
      if (slots[slot]!.heldKey !== 0) unresolved++;
    }

    if (unresolved > 0) {
      for (const fire of fires) {
        for (let slot = 0; slot < FIRE_LIGHT_POOL_SIZE; slot++) {
          if (heldFires[slot] === null && slots[slot]!.heldKey === fire.key) {
            heldFires[slot] = fire;
            unresolved--;
            break;
          }
        }
        if (unresolved === 0) break;
      }
    }

    for (let slot = 0; slot < FIRE_LIGHT_POOL_SIZE; slot++) {
      const state = slots[slot]!;
      if (state.heldKey === 0 || heldFires[slot] !== null) continue;
      // The fire this slot held is not in this frame's list: it burned out, was
      // rained out, or its owner stopped drawing it. Dark, now, rather than at
      // the next ranking. Anything this slot was already fading TOWARDS is kept
      // — it simply arrives from black instead of from the old fire.
      state.heldKey = state.pendingKey;
      state.pendingKey = 0;
      state.envelope = 0;
      state.phase = state.heldKey === 0 ? 'steady' : 'fadingIn';
    }
  }

  /** True if any slot is holding this fire or has already been promised it. */
  function isSpokenFor(key: number): boolean {
    for (let slot = 0; slot < FIRE_LIGHT_POOL_SIZE; slot++) {
      const state = slots[slot]!;
      if (state.heldKey === key || state.pendingKey === key) return true;
    }
    return false;
  }

  /**
   * Files a fire into `candidates` if it is among the best `wanted` seen so far.
   *
   * FIERCEST FIRST, AND TIES BREAK BY KEY. The tiebreak is not cosmetic: on a
   * meadow every burning cell sits at exactly intensity 1 (../protocol.ts's
   * plateau), so without a total order the winner among hundreds of equals is
   * whatever order the caller's Map happened to yield this frame — which
   * changes as cells ignite and die, and made the pool churn even when nothing
   * about the fires themselves had changed. By key, the same field of equal
   * fires always ranks the same way.
   *
   * An insertion into a list of at most FIRE_LIGHT_POOL_SIZE ×
   * CANDIDATES_PER_FREE_SLOT, not a sort of the whole field: this replaces a
   * 2000-element sort (≈22 000 comparisons) with one pass and at most sixteen
   * comparisons per fire.
   */
  function offerCandidate(fire: FireInstance, wanted: number): void {
    let position = candidateCount;
    while (position > 0) {
      const above = candidates[position - 1]!;
      const better =
        fire.intensity > above.intensity ||
        (fire.intensity === above.intensity && fire.key < above.key);
      if (!better) break;
      if (position < wanted) candidates[position] = above;
      position--;
    }
    if (position >= wanted) return;
    candidates[position] = fire;
    if (candidateCount < wanted) candidateCount++;
  }

  /**
   * Hands the free slots the fiercest fires nobody already holds.
   *
   * A slot that is still holding a fire above FIRE_LIGHT_HOLD_MIN_INTENSITY is
   * not offered here at all, and the fires the pool already holds are excluded
   * from the ranking — so this pass can only ever fill a gap, never reshuffle a
   * working pool.
   */
  function reassign(fires: readonly FireInstance[]): void {
    let freeCount = 0;
    litCount = 0;
    for (let slot = 0; slot < FIRE_LIGHT_POOL_SIZE; slot++) {
      const state = slots[slot]!;
      const held = heldFires[slot];
      const keeps =
        state.phase !== 'fadingOut' &&
        held !== null &&
        held.intensity >= FIRE_LIGHT_HOLD_MIN_INTENSITY;
      slotIsFree[slot] = !keeps;
      if (!keeps) freeCount++;
      else {
        // A kept light is a place no new light may land next to.
        litX[litCount] = held.x;
        litZ[litCount] = held.z;
        litCount++;
      }
    }
    if (freeCount === 0) return;

    // Oversampled (CANDIDATES_PER_FREE_SLOT): the separation rule below will
    // pass over candidates, and a list exactly as long as the free slots would
    // leave slots dark whenever the fiercest fires happen to be neighbours —
    // which on a front is always.
    candidateCount = 0;
    const wanted = freeCount * CANDIDATES_PER_FREE_SLOT;
    for (const fire of fires) {
      if (fire.intensity <= 0) continue;
      if (isSpokenFor(fire.key)) continue;
      if (!isSeparated(fire)) continue;
      offerCandidate(fire, wanted);
    }
    if (candidateCount === 0) return;

    // Fiercest first, skipping any fire inside the separation of one already
    // lit — kept, or handed out earlier in this same pass. A slot for which no
    // candidate is far enough from the rest stays as it was: dark, or fading
    // out, rather than stacked (FIRE_LIGHT_MIN_SEPARATION_WORLD_UNITS).
    let next = 0;
    for (let slot = 0; slot < FIRE_LIGHT_POOL_SIZE && next < candidateCount; slot++) {
      if (!slotIsFree[slot]) continue;
      let fire: FireInstance | null = null;
      while (next < candidateCount) {
        const candidate = candidates[next]!;
        next++;
        if (isSeparated(candidate)) {
          fire = candidate;
          break;
        }
      }
      if (fire === null) break;
      litX[litCount] = fire.x;
      litZ[litCount] = fire.z;
      litCount++;
      const state = slots[slot]!;
      if (state.envelope <= 0) {
        // Already dark: nothing to fade out of, so take the fire now and ramp
        // up from black.
        state.heldKey = fire.key;
        state.pendingKey = 0;
        state.phase = 'fadingIn';
        heldFires[slot] = fire;
      } else {
        // Still lit by a fire that is no longer worth holding. Fade down where
        // it stands, THEN move — never both in one frame.
        state.pendingKey = fire.key;
        state.phase = 'fadingOut';
      }
    }
  }

  /** Advances one slot's ramp by a frame. */
  function advance(state: LightSlot, slot: number, dt: number): void {
    if (state.phase === 'fadingIn') {
      state.envelope = Math.min(1, state.envelope + dt / HANDOVER_RAMP_SECONDS);
      if (state.envelope >= 1) state.phase = 'steady';
      return;
    }
    if (state.phase === 'fadingOut') {
      state.envelope = Math.max(0, state.envelope - dt / HANDOVER_RAMP_SECONDS);
      if (state.envelope > 0) return;
      state.heldKey = state.pendingKey;
      state.pendingKey = 0;
      state.phase = state.heldKey === 0 ? 'steady' : 'fadingIn';
      // The new fire is resolved on the next frame's pass. At envelope 0 the
      // light contributes nothing, so a frame without a position is not a frame
      // anybody can see.
      heldFires[slot] = null;
      return;
    }
    state.envelope = state.heldKey === 0 ? 0 : 1;
  }

  return {
    root,

    update(fires: readonly FireInstance[], dt: number): void {
      sinceReassignSeconds += dt;

      resolveHeld(fires);

      if (sinceReassignSeconds >= FIRE_LIGHT_REASSIGN_SECONDS) {
        sinceReassignSeconds = 0;
        reassign(fires);
      }

      for (let slot = 0; slot < FIRE_LIGHT_POOL_SIZE; slot++) {
        const state = slots[slot]!;
        advance(state, slot, dt);

        const fire = heldFires[slot];
        if (fire === null) {
          state.light.intensity = 0;
          continue;
        }
        state.light.position.set(
          fire.x,
          fire.groundY +
            Math.max(
              fire.fuelHeight * FIRE_LIGHT_HEIGHT_FRACTION_OF_FUEL,
              FIRE_LIGHT_MIN_HEIGHT_WORLD_UNITS,
            ),
          fire.z,
        );
        state.light.intensity = fire.intensity * FIRE_LIGHT_PEAK_INTENSITY * state.envelope;
      }
    },

    darken(): void {
      for (const state of slots) {
        state.heldKey = 0;
        state.pendingKey = 0;
        state.phase = 'steady';
        state.envelope = 0;
        state.light.intensity = 0;
      }
    },
  };
}
