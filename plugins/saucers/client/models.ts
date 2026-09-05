// THE SAUCER BODIES: three authored hulls, and the primitives that stand in for
// them until the files land.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE ASSET CONVENTION (docs/model-assets.md), which the authored files honour
// and the fallback below reproduces exactly, because the rest of the client half
// is written against the CONVENTION and must not be able to tell which of the
// two it got:
//
//   units = cells, Y up, forward = +X, origin at the hull's centre-bottom,
//   authored outer diameter SAUCER_DIAMETER_CELLS.
//
//   meshes   `hull`   the body;
//            `ring`   spins about local Y — the animated part;
//            `dome`   the canopy;
//            `lights` an emissive strip, flashed by modulating its intensity.
//   Empties  `muzzle` the laser origin, on the underside;
//            `top`    the crown, for anything that wants to sit above the hull.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE ASSETS HAVE LANDED, AND THE FALLBACK STAYS.
//
// It was written as a stand-in while the three GLBs were being authored (the
// brief's `TODO(saucers): remove fallback once assets land`), and that job is
// done — the files are on disk and the authored path is what runs. What it is
// NOW is the DEGRADED path, and that is a different thing worth keeping:
// `preloadSaucerModels` is contractually forbidden to reject (see its doc
// comment — a rejected preload unmounts the plugin for the whole session), so
// something has to be drawable when a file is missing, truncated, or rejected by
// rigAsset's own validation. Deleting it would turn "the art is broken" into
// "the mechanic does not exist", which is the outcome the brief's
// keep-the-load-path-tolerant instruction exists to prevent.
//
// It builds a flattened sphere, a dome and two tori under the SAME node names,
// so the muzzle, the ring spin and the light flash work against either path and
// nothing downstream can tell which it got.
//
// WHY A GLOB AND NOT A `.glb?url` IMPORT: a static import of a file that is not
// there does not fail this plugin, it fails the whole client bundle at resolve
// time. See ./vite-glob.d.ts for the full argument.

import {
  Box3,
  BufferGeometry,
  Group,
  Material,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  SphereGeometry,
  TorusGeometry,
  Vector3,
  type ColorRepresentation,
} from 'three';
import type { ClientPluginCtx } from '../../../client/src/plugins/types.ts';
import type { RigAsset } from '../../../client/src/render/rigAsset.ts';
import { CELL_WORLD_SIZE, SAUCER_VARIANT_COUNT } from '../protocol.ts';
import { factionColour } from './factions.ts';

/**
 * The authored outer diameter, in cells.
 *
 * FOUR CELLS, from the brief. A war boat's silhouette fits one MODEL unit; a
 * saucer is four cells, which is big enough to read as a vehicle from an orbit
 * camera at the altitude these fly at, and small enough that two of them fit
 * inside the arena's weave without overlapping.
 */
export const SAUCER_DIAMETER_CELLS = 4;

/**
 * The same diameter in MODEL units, which is what every geometry constant below
 * is actually written in.
 *
 * A MODEL'S UNITS ARE SCENE UNITS, NOT CELLS, and this conversion is the whole
 * reason this constant exists. docs/model-assets.md still says "units are cells:
 * 1 unit = 1 cell", and that sentence has been stale since the 2026-08-21
 * re-sample made CELL_WORLD_SIZE 1/4: the boats plugin places its hull at
 * `boat.x * CELL_WORLD_SIZE` and applies NO scale to the model root
 * (plugins/boats/client/index.ts:131-135), so one authored unit is one SCENE
 * unit and therefore four cells of ground. Verified from that file this session.
 *
 * Writing the fallback's radii in raw "cells" would therefore have built a
 * saucer sixteen cells across instead of four.
 */
export const SAUCER_DIAMETER_WORLD_UNITS = SAUCER_DIAMETER_CELLS * CELL_WORLD_SIZE;

/**
 * The scale an authored file's root is drawn at.
 *
 * AN AUTHORED UNIT IS A CELL (docs/model-assets.md's first line: "Units are
 * cells: 1 unit = 1 cell"), and a THREE.js unit in this scene is a WORLD unit,
 * which is four cells since the 2026-08-21 re-sample. Those are not the same
 * unit, so somebody has to convert, and it is this plugin: the files measure
 * SAUCER_DIAMETER_CELLS across in their own units (verified from the three
 * installed hulls: 4.07, 4.00 and 4.00), and drawn unscaled they would each be
 * sixteen cells wide — four times the size the brief asked for and wider than
 * the arena's own weave.
 *
 * THE FALLBACK NEEDS NO SUCH FACTOR because it is built directly in world units
 * (SAUCER_DIAMETER_WORLD_UNITS above), which is why the two paths agree on size
 * without agreeing on a scale.
 */
const AUTHORED_UNIT_SCALE = CELL_WORLD_SIZE;

/**
 * How far past SAUCER_DIAMETER_CELLS an authored hull may measure before it is
 * refused, as a FRACTION of that diameter.
 *
 * FIVE PER CENT. It is a fraction and not boats' absolute two hundredths
 * because this budget is about a proportion — "the hull the plugin was tuned
 * against" — and because an exporter's float dust scales with the model. The
 * installed saucer-a is 1.75 % over, which is authored rim detail, not a
 * different-sized ship; a file twice the size is, and would be refused.
 */
const AUTHORED_FIT_TOLERANCE_FRACTION = 0.05;

/**
 * The most meshes any one authored hull holds — the number `drawBudget` is
 * written from.
 *
 * MEASURED PER FILE at preload, not assumed: the convention names four meshes
 * (hull, ring, dome, lights) and the installed hulls carry more — `rivets` on
 * all three and a `deck` on saucer-b — which is the modeller's business and not
 * a fault. Until the files are loaded this holds the conservative ceiling below,
 * which is what the host checks the declared budget against before any saucer
 * exists.
 *
 * THE CEILING IS EIGHT, not the six the current files need. It is HEADROOM, and
 * the reason it is generous is the cost of being wrong in each direction: two
 * spare draw objects per saucer is four draw calls out of a frame that measured
 * 197, whereas a ceiling the next re-export happens to exceed drops the whole
 * set to grey primitives over a modeller splitting a part in two.
 */
const SAUCER_MESHES_MAX = 8;

/**
 * What the FALLBACK costs: four — hull, ring, dome and lights, exactly the
 * convention's mesh list. The muzzle and the crown are Empties and draw nothing.
 * Set when the fallback table is built, so the budget is truthful on that path
 * too rather than sitting at the ceiling.
 */
const FALLBACK_SAUCER_MESHES = 4;

export let SAUCER_MODEL_DRAW_OBJECTS: number = SAUCER_MESHES_MAX;

/** Node names the rest of this plugin looks up. Exact, per the convention. */
const HULL_NODE = 'hull';
const RING_NODE = 'ring';
const DOME_NODE = 'dome';
const LIGHTS_NODE = 'lights';
const MUZZLE_NODE = 'muzzle';
const TOP_NODE = 'top';

/** The three files, in variant order — index 0 is DEFAULT_SAUCER_VARIANT's. */
const ASSET_FILENAMES: readonly string[] = ['saucer-a.glb', 'saucer-b.glb', 'saucer-c.glb'];

/**
 * One saucer in the scene: the root to place, plus the two parts that animate
 * and the point a bolt leaves from.
 *
 * THE PARTS ARE HELD, NOT LOOKED UP PER FRAME. `getObjectByName` walks the
 * subtree, and doing that three times per saucer per frame is a per-frame cost
 * with no per-frame reason — the graph does not change once the model is built.
 */
export interface SaucerModel {
  readonly root: Object3D;
  /** Spun about local Y every frame. */
  readonly ring: Object3D | null;
  /**
   * The ring's own material, cloned per instance, for the MUZZLE FLASH — the
   * hangar's: the ring glows up on every shot and decays back. Null when the
   * ring is not a single standard material (the fallback's ring has no glow).
   */
  readonly ringGlow: MeshStandardMaterial | null;
  /** The authored emissive intensity the ring rests at. */
  readonly ringBaseEmissive: number;
  /** Emissive strip whose intensity is modulated to flash. Null if unlit. */
  readonly lights: MeshStandardMaterial | null;
  /**
   * The strip's emissive intensity AT REST — the value the flash swings around.
   *
   * READ OFF THE MATERIAL, NOT IMPOSED ON IT. On the authored path this is what
   * the modeller baked into the file (KHR_materials_emissive_strength; the three
   * installed hulls carry 2.0 on `lights` and 1.3 on `ring`), and stamping this
   * plugin's own number over it would silently overrule a lighting decision made
   * in Blender — which for saucer-a would have DIMMED the strip from 2.0 to 1.2.
   * The fallback, which has no author, supplies SAUCER_LIGHTS_BASE_EMISSIVE.
   */
  readonly lightsBaseEmissive: number;
  /** Where a bolt leaves from, in the model's own space. */
  readonly muzzle: Object3D;
  /** Drops anything this INSTANCE owns (never the shared pool). */
  dispose(): void;
}

export interface SaucerModels {
  /** The model for one saucer. An out-of-range variant falls to index 0. */
  create(variant: number): SaucerModel;
  /** Frees every shared geometry and material. Call once, at plugin dispose. */
  dispose(): void;
}

/**
 * The loaded files, or null while none are installed. Module scope, matching
 * every other plugin's shape: the client host constructs exactly one instance of
 * each plugin, and preload/dispose bracket its whole lifetime.
 */
let installed: readonly RigAsset[] | null = null;

/**
 * Loads the three authored hulls, if they are on disk.
 *
 * NEVER REJECTS, and that is deliberate rather than lax. A rejected preload is a
 * logged breach that leaves the plugin unmounted for the whole session (see
 * TerraceClientPlugin.preload) — which for a missing MODEL would mean no saucers
 * at all rather than plain ones, and the whole point of the fallback is that the
 * mechanic is watchable before the art is finished. A file that is present but
 * BROKEN is reported on the console and falls back the same way: the alternative
 * is a client that shows nothing and says nothing.
 */
export async function preloadSaucerModels(
  ctx: Pick<ClientPluginCtx, 'loadRigAsset'>,
): Promise<void> {
  // Written so BOTH declarations of `glob` accept it — this package's own
  // (./vite-glob.d.ts) and vite/client's, which the client bundle's typecheck
  // uses. Assigning the result to a widened record is what makes the two agree;
  // the loader's resolved value is checked below rather than trusted.
  const found: Record<string, () => Promise<unknown>> = import.meta.glob('./assets/*.glb', {
    query: '?url',
    import: 'default',
    eager: false,
  });

  // ONE MISSING FILE MEANS THE FALLBACK FOR ALL THREE, not a mixed set: a world
  // in which one saucer is an authored hull and the other a grey sphere looks
  // broken in a way neither state does on its own, and the half-landed case is
  // exactly what happens while the files are dropped in one at a time. Checked
  // before anything is loaded so the common "none of them are here yet" case
  // costs no network at all.
  const loaders: (() => Promise<unknown>)[] = [];
  for (const filename of ASSET_FILENAMES) {
    const loader = found[`./assets/${filename}`];
    if (loader === undefined) return;
    loaders.push(loader);
  }

  try {
    const assets: RigAsset[] = [];
    for (const loader of loaders) {
      const url = await loader();
      if (typeof url !== 'string') return;
      // 'sky-environment': the hulls are authored METAL (issue #314), and a
      // metal is its reflection — see ClientPluginCtx.loadRigAsset.
      assets.push(await ctx.loadRigAsset(url, 'sky-environment'));
    }
    const rejected = measureInstalled(assets);
    if (rejected !== null) {
      console.error(`[saucers] ${rejected} — drawing primitives instead`);
      for (const asset of assets) asset.dispose();
      return;
    }
    installed = assets;
  } catch (error) {
    // See the doc comment: a broken file degrades to primitives and says so,
    // rather than taking the plugin off the air.
    console.error('[saucers] could not load an authored hull — drawing primitives instead', error);
    installed = null;
  }
}

/**
 * Checks every loaded hull against the fit budget and records the worst-case
 * mesh count. Returns a complaint, or null when all three are acceptable.
 *
 * ALL OR NOTHING, for the reason the missing-file check above gives: a scene in
 * which one saucer is authored and the other a primitive looks broken in a way
 * neither state does on its own.
 */
function measureInstalled(assets: readonly RigAsset[]): string | null {
  const limit = SAUCER_DIAMETER_CELLS * (1 + AUTHORED_FIT_TOLERANCE_FRACTION);
  let meshes = 0;
  for (const asset of assets) {
    const size = new Box3().setFromObject(asset.scene).getSize(new Vector3());
    if (size.x > limit || size.z > limit) {
      return (
        `an authored hull measures ${size.x.toFixed(2)} x ${size.z.toFixed(2)} authored units ` +
        `against a ${SAUCER_DIAMETER_CELLS}-cell budget`
      );
    }
    let count = 0;
    asset.scene.traverse((child) => {
      if ((child as Partial<Mesh>).isMesh === true) count++;
    });
    if (count > meshes) meshes = count;
  }
  if (meshes > SAUCER_MESHES_MAX) {
    return `an authored hull holds ${meshes} meshes against a ceiling of ${SAUCER_MESHES_MAX}`;
  }
  // Only ever LOWERED from the conservative ceiling, never raised past it: the
  // budget the host checks is declared before a file is seen, and a measurement
  // that could raise it would breach by construction.
  SAUCER_MODEL_DRAW_OBJECTS = meshes > 0 ? meshes : SAUCER_MESHES_MAX;
  return null;
}

/** Test/reset seam: forgets the loaded files without freeing them. */
export function clearSaucerAssets(): void {
  installed = null;
  SAUCER_MODEL_DRAW_OBJECTS = SAUCER_MESHES_MAX;
}

// ─────────────────────────────────────────────────────────────────────────────
// THE FALLBACK'S SHAPE.
//
// Every number below is a fraction of SAUCER_DIAMETER_WORLD_UNITS, so the stand-in is
// the same size as the authored hull it stands in for whatever that diameter
// becomes. They are proportions of a saucer, not measurements of one.

/** Hull: a sphere flattened to this fraction of its own width. */
const HULL_FLATTEN = 0.22;
/** Dome: this fraction of the hull's radius, sitting on top of it. */
const DOME_RADIUS_FRACTION = 0.4;
/** Ring: a torus at the hull's rim, this thick relative to the radius. */
const RING_TUBE_FRACTION = 0.06;
/** Lights: a second, slightly larger torus — the strip that flashes. */
const RING_LIGHTS_RADIUS_FRACTION = 0.72;
const RING_LIGHTS_TUBE_FRACTION = 0.035;
/** How far under the hull's centre the muzzle sits, as a fraction of radius. */
const MUZZLE_DROP_FRACTION = 0.18;

/**
 * Segment counts for the fallback's primitives.
 *
 * DELIBERATELY LOW — 20 around and 10 up for a sphere, 24 around for a torus.
 * At most two saucers exist and they are seen from a distance at speed, so the
 * silhouette is what carries and the tessellation is invisible; this whole set
 * is under 3k triangles, which is inside the budget the war boat's ~1.5k rig
 * established for a single authored model.
 */
const FALLBACK_RADIAL_SEGMENTS = 20;
const FALLBACK_HEIGHT_SEGMENTS = 10;
const FALLBACK_TORUS_SEGMENTS = 24;
const FALLBACK_TUBE_SEGMENTS = 8;

/**
 * The three stand-in hulls, one per variant — so the fallback still tells the
 * factions in a fight apart, which is the one thing the renderer needs from a
 * body it did not author. Its lights wear the faction colour (./factions.ts),
 * the same one its bolts do.
 */
const FALLBACK_HULL_COLOURS: readonly ColorRepresentation[] = [0x9aa4b2, 0xb0a08a, 0x8f9a86];

/**
 * The FALLBACK strip's emissive intensity at rest.
 *
 * ONLY THE FALLBACK'S. An authored hull carries its own (SaucerModel.
 * lightsBaseEmissive), and this number must never be written over it. 1.2 is
 * chosen to read like the authored 2.0 against the fallback's flat, untextured
 * materials, which pick up far more of the scene's light than a baked hull does.
 */
export const SAUCER_LIGHTS_BASE_EMISSIVE = 1.2;

/** The shared geometry pool the fallback builds from, or null on the file path. */
interface FallbackWorkshop {
  readonly hull: BufferGeometry;
  readonly dome: BufferGeometry;
  readonly ring: BufferGeometry;
  readonly lights: BufferGeometry;
  readonly materials: Material[];
  dispose(): void;
}

function createFallbackWorkshop(): FallbackWorkshop {
  const radius = SAUCER_DIAMETER_WORLD_UNITS / 2;
  const hull = new SphereGeometry(radius, FALLBACK_RADIAL_SEGMENTS, FALLBACK_HEIGHT_SEGMENTS);
  // Flattened in place rather than scaled on the Mesh, so the shared geometry
  // already IS the saucer shape and nothing downstream has to remember to
  // squash it. The lift puts the origin at the hull's centre-bottom, which is
  // the convention's origin rule.
  hull.scale(1, HULL_FLATTEN, 1);
  hull.translate(0, radius * HULL_FLATTEN, 0);

  const domeRadius = radius * DOME_RADIUS_FRACTION;
  // A half sphere: phiLength full, thetaLength half — the canopy, not a ball.
  const dome = new SphereGeometry(
    domeRadius,
    FALLBACK_RADIAL_SEGMENTS,
    FALLBACK_HEIGHT_SEGMENTS,
    0,
    Math.PI * 2,
    0,
    Math.PI / 2,
  );
  dome.translate(0, radius * HULL_FLATTEN * 2, 0);

  const ring = new TorusGeometry(
    radius,
    radius * RING_TUBE_FRACTION,
    FALLBACK_TUBE_SEGMENTS,
    FALLBACK_TORUS_SEGMENTS,
  );
  // A torus is authored in the XY plane; the saucer's ring lies in XZ.
  ring.rotateX(Math.PI / 2);
  ring.translate(0, radius * HULL_FLATTEN, 0);

  const lights = new TorusGeometry(
    radius * RING_LIGHTS_RADIUS_FRACTION,
    radius * RING_LIGHTS_TUBE_FRACTION,
    FALLBACK_TUBE_SEGMENTS,
    FALLBACK_TORUS_SEGMENTS,
  );
  lights.rotateX(Math.PI / 2);
  lights.translate(0, radius * HULL_FLATTEN * 0.6, 0);

  const materials: Material[] = [];
  return {
    hull,
    dome,
    ring,
    lights,
    materials,
    dispose() {
      hull.dispose();
      dome.dispose();
      ring.dispose();
      lights.dispose();
      for (const material of materials) material.dispose();
      materials.length = 0;
    },
  };
}

/**
 * Gives `node` its own copy of its single MeshStandardMaterial and returns it,
 * or null when the node is not a mesh wearing exactly one such material.
 *
 * CLONED, BUT NOT RETUNED. The clone is per-instance because a flash is
 * written into the material and two saucers must not share a pulse; its
 * emissive intensity is left exactly as the file set it, and read out by the
 * caller as the rest value the flash swings around.
 */
function cloneStandardMaterial(node: Object3D): MeshStandardMaterial | null {
  const mesh = node as Partial<Mesh> & Object3D;
  if (mesh.isMesh !== true) return null;
  const material = (node as Mesh).material;
  if (Array.isArray(material) || !(material instanceof MeshStandardMaterial)) return null;
  const own = material.clone();
  (node as Mesh).material = own;
  return own;
}

/** One stand-in saucer, under the convention's node names. */
function buildFallbackSaucer(workshop: FallbackWorkshop, variant: number): SaucerModel {
  const radius = SAUCER_DIAMETER_WORLD_UNITS / 2;
  const hullColour = FALLBACK_HULL_COLOURS[variant] ?? FALLBACK_HULL_COLOURS[0]!;
  const lightColour = factionColour(variant);

  const hullMaterial = new MeshStandardMaterial({ color: hullColour, roughness: 0.35, metalness: 0.6 });
  const domeMaterial = new MeshStandardMaterial({
    color: lightColour,
    roughness: 0.1,
    metalness: 0.1,
    emissive: lightColour,
    emissiveIntensity: 0.25,
  });
  const ringMaterial = new MeshStandardMaterial({ color: 0x3a3f46, roughness: 0.5, metalness: 0.8 });
  const lightsMaterial = new MeshStandardMaterial({
    color: 0x111111,
    emissive: lightColour,
    emissiveIntensity: SAUCER_LIGHTS_BASE_EMISSIVE,
  });
  workshop.materials.push(hullMaterial, domeMaterial, ringMaterial, lightsMaterial);

  const root = new Group();
  root.name = `saucers:body:${variant}`;

  const hull = new Mesh(workshop.hull, hullMaterial);
  hull.name = HULL_NODE;
  const dome = new Mesh(workshop.dome, domeMaterial);
  dome.name = DOME_NODE;
  const ring = new Mesh(workshop.ring, ringMaterial);
  ring.name = RING_NODE;
  const lights = new Mesh(workshop.lights, lightsMaterial);
  lights.name = LIGHTS_NODE;

  const muzzle = new Object3D();
  muzzle.name = MUZZLE_NODE;
  muzzle.position.set(0, -radius * MUZZLE_DROP_FRACTION, 0);
  const top = new Object3D();
  top.name = TOP_NODE;
  top.position.set(0, radius * HULL_FLATTEN * 2 + radius * DOME_RADIUS_FRACTION, 0);

  root.add(hull, dome, ring, lights, muzzle, top);

  return {
    root,
    ring,
    ringGlow: null,
    ringBaseEmissive: 0,
    lights: lightsMaterial,
    lightsBaseEmissive: SAUCER_LIGHTS_BASE_EMISSIVE,
    muzzle,
    dispose() {
      // Geometries and materials are the workshop's; an instance owns only its
      // place in the graph, and the parent removes that.
      root.clear();
    },
  };
}

/**
 * One saucer cloned from an authored file.
 *
 * A CLONE OF THE SCENE, not a baked rig. `bakeRig` (client/src/render/
 * rigSkin.ts) merges an authored tree into skinned surfaces, which is what the
 * war boat needs because its oars swing on joints; a saucer's only moving part
 * is a ring that spins about the model's own Y, and a clone keeps that as a
 * plain Object3D whose rotation can simply be set. At two instances alive at
 * once, the draw calls a clone costs (one per authored mesh) are inside the
 * budget declared in ./index.ts, and the simpler graph is what lets `muzzle`
 * stay a real node a bolt can be positioned from.
 *
 * THE LIGHTS MATERIAL IS CLONED PER INSTANCE, because the flash is written into
 * it: shared, one saucer's pulse would drive the other's. Nothing else is —
 * geometry and the other materials are read-only here.
 */
function buildAuthoredSaucer(asset: RigAsset, variant: number): SaucerModel {
  const root = asset.scene.clone(true);
  root.name = `saucers:body:${variant}`;
  // AUTHORED UNITS ARE CELLS; THE SCENE IS IN WORLD UNITS. See
  // AUTHORED_UNIT_SCALE — without this the hull is drawn four times too wide.
  root.scale.setScalar(AUTHORED_UNIT_SCALE);

  const ring = root.getObjectByName(RING_NODE) ?? null;
  const ringGlow = ring === null ? null : cloneStandardMaterial(ring);
  const muzzleNode = root.getObjectByName(MUZZLE_NODE);
  // A file that is missing `muzzle` still flies; its bolts leave from the hull's
  // origin. Throwing here (which is what `asset.node` would do) would take the
  // whole encounter off the screen over a misnamed Empty.
  const muzzle = muzzleNode ?? root;

  const lightsNode = root.getObjectByName(LIGHTS_NODE);
  const lights = lightsNode === undefined ? null : cloneStandardMaterial(lightsNode);

  return {
    root,
    ring,
    ringGlow,
    ringBaseEmissive: ringGlow === null ? 0 : ringGlow.emissiveIntensity,
    lights,
    // The authored rest value, or the fallback's number when this file has no
    // recognisable lights material to read one from.
    lightsBaseEmissive: lights === null ? SAUCER_LIGHTS_BASE_EMISSIVE : lights.emissiveIntensity,
    muzzle,
    dispose() {
      // The clones (the ones made above) are this instance's; everything else
      // it references belongs to the RigAsset.
      lights?.dispose();
      ringGlow?.dispose();
      root.clear();
    },
  };
}

/**
 * Builds the model table.
 *
 * WHICH PATH IS TAKEN IS DECIDED HERE, ONCE, from whether `preloadSaucerModels`
 * installed anything — never per saucer. A mixed scene is exactly what the
 * "one missing file means the fallback for all three" rule above exists to
 * prevent, and deciding it once is what makes that rule hold.
 */
export function createSaucerModels(): SaucerModels {
  const assets = installed;
  if (assets !== null && assets.length === SAUCER_VARIANT_COUNT) {
    return {
      create(variant: number): SaucerModel {
        const index = variant >= 0 && variant < assets.length ? variant : 0;
        return buildAuthoredSaucer(assets[index]!, index);
      },
      dispose(): void {
        // The RigAssets outlive this table: preload owns them, and a remount
        // builds a new table over the same files. `clearSaucerAssets` plus each
        // asset's own dispose is the plugin-teardown path (./index.ts).
      },
    };
  }

  const workshop = createFallbackWorkshop();
  SAUCER_MODEL_DRAW_OBJECTS = FALLBACK_SAUCER_MESHES;
  return {
    create(variant: number): SaucerModel {
      const index = variant >= 0 && variant < SAUCER_VARIANT_COUNT ? variant : 0;
      return buildFallbackSaucer(workshop, index);
    },
    dispose(): void {
      workshop.dispose();
    },
  };
}

/** Frees the authored files. Called at plugin dispose, after the models are. */
export function disposeSaucerAssets(): void {
  if (installed === null) return;
  for (const asset of installed) asset.dispose();
  clearSaucerAssets();
}
