// The flame-renderer contract — the seam between "what is burning" (the fire
// plugin's synced cell state) and "what a fire LOOKS like" (one of several
// candidate designs the owner chooses between).
//
// WHY A SEAM AT ALL, rather than one flame implementation written directly into
// client/index.ts: the look is a design decision that is made from pictures, not
// from code review, and the simulation half must be buildable and shippable
// before that decision exists. Everything on the sim side of this interface is
// finished work; everything on the far side is a candidate. Once a design is
// chosen the losers are deleted — the interface stays, because the same seam is
// what lets the look be re-tuned later without touching a line of the sim.
//
// THE RULES A CANDIDATE MUST KEEP (they are budget, not taste):
//
//   * DRAW CALLS ARE THE BUDGET. Every fire in the world must cost a FIXED,
//     SMALL number of draw calls — instanced or merged geometry, not a Group per
//     fire. flora draws 3000 trees in 3 calls (plugins/flora/client/models.ts);
//     a renderer that spends a call per burning cell is disqualified however
//     good it looks, because a spreading fire is precisely the moment the frame
//     can least afford it.
//   * NO EXTERNAL ASSETS. No textures loaded from disk, no image files, no
//     model files. Everything is generated in code, as everywhere else in this
//     renderer. A procedural CanvasTexture built at construction time is
//     allowed — it is generated, not loaded.
//   * NO PER-FIRE LIGHTS. Fire-light on the terrain is a separate, pooled
//     concern owned by the fire plugin (a small fixed number of PointLights
//     bound to the nearest fires), exactly as weather/client/rig.ts pools its
//     storm flash light. A renderer must not add lights of its own.
//   * ALLOCATION-FREE STEADY STATE. `update` runs every frame. Scratch objects
//     (Matrix4, Vector3, Color…) are constructed once at build time and reused,
//     the way flora's models.ts reuses its compose scratch.
//
// UNITS. World units throughout, the same ones plugins/flora/client/models.ts
// is authored in: one terrace band is 1 unit of relief and a full-grown tree is
// ~1.5 units tall. A flame that consumes a tree is therefore a ~1.5–2.5 unit
// object, not a 0.1 unit candle and not a 10 unit tower.

import type { Group } from 'three';

/**
 * One burning thing, as the renderer sees it. Deliberately NOT a tree: the fire
 * plugin burns whatever registers fuel with it (trees today, crops and
 * buildings next), so a renderer is told a position, a size and a phase, and
 * never what kind of thing is alight.
 */
export interface FireInstance {
  /**
   * THIS FIRE'S IDENTITY, unique among everything drawn this frame and stable
   * for as long as the fire burns.
   *
   * WHY THE LIST CARRIES ONE (bug, 2026-08-24: a fire's light lagged more than
   * a world unit behind the burning animal it belonged to, and went on lighting
   * ground where a fire had already been put out). The instance list is rebuilt
   * every frame, so an instance OBJECT is worth nothing beyond the frame it was
   * made in — anything that has to remember a particular fire between frames
   * (the light pool, today) must remember this number and look the fire up
   * again, never keep the object.
   *
   * Distinct from `seed`, which is a look: two fires may not share a key, while
   * `seed` is free to be anything stable that varies the animation.
   */
  readonly key: number;
  /** World X/Z of the burning cell's centre. */
  readonly x: number;
  readonly z: number;
  /** The terrain surface the fire stands on, in world units. */
  readonly groundY: number;
  /**
   * How big the burning thing is, in world units — a full-grown tree is ~1.5,
   * a crop is a fraction of that. The renderer scales its flame to this; it is
   * the only thing that distinguishes a burning forest from a burning field.
   */
  readonly fuelHeight: number;
  /**
   * How fiercely this cell is burning right now, 0…1. Rises as the fire takes
   * hold and falls as the fuel is spent, so a renderer that simply scales and
   * brightens by this number gets ignition and burnout for free.
   */
  readonly intensity: number;
  /**
   * Seconds since this cell ignited. Monotonic, never reset. Available so a
   * renderer can drive a phase that must not restart when intensity does.
   */
  readonly ageSeconds: number;
  /**
   * HOW MUCH OF THIS LOOK TO DRAW, 0…1. Absent means 1 — draw it fully.
   *
   * Distinct from `intensity`, and the distinction is the point: intensity is
   * how fiercely the fire is burning and belongs to the SIMULATION; presence is
   * how much of this particular renderer's contribution is wanted and belongs
   * to whoever is composing the looks. A renderer must express it as
   * TRANSPARENCY, never as size — a fire at presence 0 is being drawn by
   * somebody else, not burning less, so shrinking it would leave a stub
   * standing inside the other renderer's flame.
   *
   * It exists because the shipped look is TWO renderers crossfaded over a
   * fire's life (./ribbonsToPlume.ts). A renderer with no compositor above it
   * simply never sees anything but 1, which is why it is optional rather than
   * required.
   */
  readonly presence?: number;
  /**
   * A stable per-fire integer, derived from the cell. Two fires must never
   * flicker in lockstep, and the fire at a given cell must look the same on
   * every client — so this, and never Math.random(), is what a renderer varies
   * its phase, lean and jitter by.
   */
  readonly seed: number;
}

/**
 * One candidate look. Constructed once per plugin attach, handed the fires it
 * should draw whenever the burning set changes, and ticked every frame.
 */
export interface FlameRenderer {
  /** Human-readable name of this candidate — used by the preview harness. */
  readonly name: string;
  /** Everything this renderer draws. The plugin adds it to its layer. */
  readonly root: Group;
  /**
   * Replaces the drawn set with exactly these fires. Called only when the
   * burning set or a fire's phase changes (a server delta), NOT per frame.
   */
  apply(fires: readonly FireInstance[]): void;
  /**
   * How many fires this renderer is CURRENTLY DRAWING — the length of the last
   * list `apply` was handed, after any cap of its own.
   *
   * WHY THE CONTRACT REPORTS THIS (bug, 2026-08-24: a flame stood motionless
   * over a hole in the ground until something else, anywhere in the world,
   * caught fire). `apply` is the only writer of the drawn set, so a caller that
   * returns early on a quiet frame leaves whatever was last applied on screen —
   * and the one frame that MUST reach `apply` is the frame the world stops
   * burning, which is exactly the frame a "nothing is burning" early-out skips.
   *
   * Reporting the drawn count turns that from a rule a caller has to remember
   * into a condition it can test: nothing is really undrawn until `drawnCount`
   * says so. A compositor reports the total across its sub-renderers.
   */
  readonly drawnCount: number;
  /**
   * Advances the animation. `dt` is seconds since the last frame; `elapsed` is
   * seconds since the plugin attached, supplied so a renderer can drive a
   * continuous phase without integrating its own clock.
   *
   * MUST be a no-op when nothing is burning — a fire renderer costs nothing on
   * a world that is not on fire.
   */
  update(dt: number, elapsed: number): void;
  /** Frees every geometry, material and texture. Called once, at dispose. */
  dispose(): void;
}

/** How a candidate is constructed. No arguments: a look is not configurable. */
export type FlameRendererBuilder = () => FlameRenderer;
