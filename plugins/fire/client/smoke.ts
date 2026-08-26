// SMOKE — the one fire visual that is not a picture of a flame, and the one
// that is not derived from `fireIntensity`.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHAT IT IS FOR (issue #185, owner 2026-08-26).
//
// The flame is a CLOSE-RANGE signal. It is 1.4 × a tree tall, it is drawn
// unlit, and past a certain distance it is a couple of orange pixels behind a
// hill. So a fire somewhere the player is not currently looking — which is
// exactly the fire they would most want to notice — has no signature at all.
// Smoke is that signature: a tall, slow, pale column that clears the canopy,
// clears the terrace steps, and is legible from across the map at a size where
// the flame that made it is not.
//
// It is distinct from #135 (a CATCHING fire reading close up); this is an
// ESTABLISHED fire reading at DISTANCE.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY IT KEEPS ITS OWN CLOCK, AND OUTLIVES THE FIRE.
//
// Every other fire visual is a function of `fireIntensity(age, burn)`: it rises
// as the fire takes hold and it is gone the instant the fire is. Smoke must not
// be, because a burned-out fire still smokes, and that lasting mark — "a fire
// happened HERE, recently" — is the whole feature. A flame you missed tells you
// nothing after it goes out; a column of smoke over the black tells you where
// to go.
//
// So this renderer keeps PER-FIRE STATE OF ITS OWN, rising while the fire is
// alight and decaying for SMOKE_AFTERLIFE_SECONDS after the fire has left the
// world. `apply` is therefore NOT the "replace the drawn set with exactly
// these" contract that ./flames/types.ts's FlameRenderer defines — the list it
// is handed says which fires are ALIVE, and this renderer may be drawing many
// columns that are not in it. That difference is why smoke has its own
// interface below rather than pretending to be a flame renderer.
//
// KEYED BY `key`, NEVER BY HOLDING A FireInstance. The instance list is rebuilt
// every frame, so an instance object is worth nothing beyond the frame it was
// made in (./flames/types.ts's `key`, and the 2026-08-24 bug that put it
// there). Everything remembered between frames is remembered against the key
// and copied out of the instance by value.
//
// THE RESIDUAL, stated rather than fixed: a client that joins AFTER a fire died
// sees no smoke for it, because the lifetime is client-owned and the server
// tells a joining client only what is currently alight. Paying for that would
// mean server state for a purely cosmetic afterglow, and the owner declined it
// (DESIGN.md, 2026-08-26). What the feature is actually for — noticing a fire
// you are not looking at, and finding it after it burned out while you WERE
// connected — is unaffected.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE BUDGET RULES (./flames/types.ts) BIND SMOKE UNCHANGED.
//
//   * ONE InstancedMesh, ONE draw call for the world, whatever is burning and
//     whatever is still smoking. A plume of smoke per fire — the naive version —
//     is disqualified however good it looks, and a spreading fire is precisely
//     the frame that can least afford it.
//   * No external assets: the column is a noise-warped sleeve coloured in the
//     fragment shader, with no texture, no canvas and no ramp table.
//   * No lights of its own.
//   * Allocation-free steady state: the scratch below is built once, and a Map
//     entry is allocated only when a NEW fire starts smoking, which is a server
//     delta and not a frame event.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE TWO GEOMETRY LESSONS FROM THE FLAME WORK, applied here on purpose.
//
// CROWN DEPTH-CULLING. A column standing at a tree's centre is hidden by the
// tree's own crown for as much of its length as lies below the canopy — the
// exact reason the flame's plume only owns intensity ≥ 0.55
// (./flames/ribbonsToPlume.ts). Smoke would suffer it far worse, because smoke
// is pale and thin where a flame is saturated. So this column DOES NOT START AT
// THE GROUND: its foot sits at SMOKE_BASE_HEIGHT_PER_FUEL × the fuel's height,
// i.e. at the top of the thing that is burning, above the crown's silhouette
// entirely, and its lowest stretch fades in rather than beginning at a hard
// edge. Nothing of the column is ever inside the crown, so nothing of it can be
// culled by one. What connects it visually to the fire below is the flame's own
// plume, which reaches 1.4 × the fuel and therefore overlaps the smoke's first
// stretch.
//
// EQUAL-POWER CROSSFADE. Not used, and deliberately: smoke never hands over to
// another look. It is composited OVER the flame and UNDER nothing, so there is
// no share to split and the √ rule has nothing to apply to. Its only fade is
// its own lifetime, which is one look going from present to absent.
//
// ─────────────────────────────────────────────────────────────────────────────
// AND THE FAILURE THIS FEATURE COULD CAUSE: a distance signature that becomes
// an opaque grey wall in the player's face is the same feature failing, and the
// first cut of this file did exactly that. See SMOKE_SILENT_DISTANCE — a column
// is drawn at NOTHING once the camera is inside the closest zoom the player can
// reach, and climbs to full only out at the camera's default orbit, where the
// flame has stopped being legible. The two ends of that ramp are the camera's
// own zoom band, not numbers chosen to look right.
// ─────────────────────────────────────────────────────────────────────────────

import {
  CylinderGeometry,
  DoubleSide,
  DynamicDrawUsage,
  Group,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  Quaternion,
  ShaderMaterial,
  Vector3,
} from 'three';
import { FIRE_FLAME_INSTANCE_CAP } from '../protocol.ts';
import { VALUE_NOISE_GLSL } from './valueNoiseGlsl.ts';
import type { FireInstance } from './flames/types.ts';

// ── Lifetime ──────────────────────────────────────────────────────────────
/**
 * Seconds from ignition to a column at full strength.
 *
 * FOUR, against real burn times: a tree burns for 22 s
 * (flora's FLORA_TREE_BURN_SECONDS), a crop for 4 and grass for 3. Four seconds
 * puts a tree's column at full strength while the flame is still climbing —
 * smoke that only arrived once the fire was already dying would miss the whole
 * point, which is noticing a fire early. It also means the shortest fuels,
 * grass and crops, never quite reach full: a burning tuft producing the same
 * column as a burning wood is the version of this feature that cries wolf.
 */
const SMOKE_RISE_SECONDS = 4;
/**
 * Seconds a column goes on smoking AFTER its fire has left the world.
 *
 * THIRTY, chosen against the longest fuel in the game rather than picked: a
 * tree burns for 22 s, so at 30 the after-signature outlives even the slowest
 * fire that made it, by half again. That is the property the owner asked for —
 * a mark that says a fire happened here, still readable by someone who arrives
 * after it went out. Bounded well under a minute so that a wood which burned
 * out has visibly cleared by the time a player has walked to it, rather than
 * leaving the map permanently hazed with the history of every fire.
 */
const SMOKE_AFTERLIFE_SECONDS = 30;
/**
 * How many columns may exist at once — live and retiring together.
 *
 * The flame's cap, for the arithmetic that gives it: at most
 * FIRE_FLAME_INSTANCE_CAP things can be alight at one moment, and each of them
 * seeds at most one column. Smoke outliving its fire means the count can
 * momentarily want to exceed that, and when it does the FAINTEST column is
 * evicted — the least visible thing on screen is the correct thing to lose, and
 * it is a strictly better answer than dropping whichever fire hashed last.
 */
const SMOKE_COLUMN_CAP = FIRE_FLAME_INSTANCE_CAP;
/**
 * Below this strength a column is retired outright rather than drawn.
 *
 * ./flames/ribbonsToPlume.ts's MINIMUM_VISIBLE_PRESENCE, for its reason and not
 * as an optimisation: a column at strength 0.004 is invisible but still holds a
 * cap slot, still writes into the depth-sorted transparent pass, and still
 * costs the vertex work of a full column.
 */
const SMOKE_MINIMUM_VISIBLE_STRENGTH = 0.01;

// ── The sleeve ────────────────────────────────────────────────────────────
/**
 * Radial and vertical tessellation. Coarser than the flame's 10 × 18 in both
 * axes, and it can be: smoke is pale, soft-edged and mostly seen far away, so
 * its silhouette carries nothing like the flame's detail — while its instance
 * count is the same order, so the triangles saved are saved 448 times over.
 * Twelve height segments are still enough joints for the drift to read as a
 * bending column rather than as a leaning cone.
 */
const SMOKE_RADIAL_SEGMENTS = 8;
const SMOKE_HEIGHT_SEGMENTS = 12;
/**
 * Unit sleeve: 1 tall, radius 1 at the TOP, and this at the foot.
 *
 * The flame's sleeve tapers upward and smoke's widens upward, because that is
 * what the two gases do: a flame is combustion narrowing as it is consumed, and
 * smoke is a cooling body spreading as it entrains air. Getting this backwards
 * is the single clearest way to draw smoke that reads as a grey flame.
 */
const SMOKE_FOOT_RADIUS_FRACTION = 0.34;

// ── Size, in world units ──────────────────────────────────────────────────
/**
 * Column height as a multiple of the fuel's height. A full-grown tree is 1.5
 * world units, so 4.5 puts its column 6.75 units tall — nearly seven terrace
 * bands, which is the scale at which a thing is still legible from across a
 * valley. The flame it stands over is 2.1 units, and that is the entire point:
 * smoke is the part of a fire that is visible when the fire is not.
 */
const SMOKE_HEIGHT_PER_FUEL = 4.5;
/**
 * Radius at the TOP of the column, as a multiple of the fuel's height — 1.65
 * units for a tree, so a mature column is about as wide as the tree is tall.
 * The foot is SMOKE_FOOT_RADIUS_FRACTION of that (0.56 units), comfortably
 * wider than the flame's 0.5-unit plume, so the smoke reads as leaving the
 * flame rather than as a second, thinner stalk beside it.
 */
const SMOKE_TIP_RADIUS_PER_FUEL = 1.1;
/**
 * Where the column's foot sits, as a multiple of the fuel's height.
 *
 * ONE — the top of the burning thing, and the answer to the crown depth-culling
 * problem in the header. Not less: below 1 the foot is inside the crown, which
 * is opaque, and the part of the column a near camera sees most of is the part
 * that is culled. Not more: a gap between the flame's tip and the smoke's foot
 * reads as a cloud hovering over a fire rather than as smoke coming off one,
 * and at exactly 1 the flame's plume (1.4 × the fuel) still overlaps the
 * column's first stretch, which is what stitches the two together.
 */
const SMOKE_BASE_HEIGHT_PER_FUEL = 1;

// ── Drift ─────────────────────────────────────────────────────────────────
/** Noise cycles along the column's height. Fewer than the flame's 3.7: smoke bends in long, slow arcs, not in lobes. */
const SMOKE_DRIFT_FREQUENCY = 1.6;
/**
 * How fast the drift travels up the column, in noise cycles per second. Well
 * under the flame's 1.35 — a flame flickers and smoke crawls, and matching the
 * two speeds is what makes smoke look like a grey flame.
 */
const SMOKE_DRIFT_SCROLL_SPEED = 0.34;
/** Sideways wander at the TOP, as a fraction of the column's tip radius. */
const SMOKE_DRIFT_AMPLITUDE = 0.9;
/**
 * How hard the noise pinches and swells the column's RADIUS, as a fraction.
 *
 * The flame's WARP_RADIUS_AMPLITUDE, and the renders are why it is here: with
 * lateral drift alone the column is a straight-sided wedge that leans, and a
 * leaning cone is not smoke — the first pass of this file photographed as five
 * grey sheets standing over a wood. Swelling and necking the radius as the noise
 * travels up is what turns the sleeve into a stack of billows. Deeper than the
 * flame's 0.5 because smoke has no colour ramp and no flicker to carry it: the
 * silhouette is all it has.
 */
const SMOKE_BILLOW_RADIUS_AMPLITUDE = 0.62;
/**
 * The drift is scaled by (height^this) so the FOOT of the column stays planted
 * over the fire. The flame's WARP_HEIGHT_BIAS for the identical reason — an
 * unweighted warp slides the whole column off the thing that is burning.
 */
const SMOKE_DRIFT_HEIGHT_BIAS = 1.4;
/**
 * A steady draught, in tip radii per unit of column height, and the compass
 * direction it blows along. RAISED from 0.55 to 1.2 after the renders: 0.55
 * tilted a 6.75-unit column by about 0.9 units, which is under eight degrees
 * and photographs as vertical. 1.2 gives roughly two world units of travel over
 * the column's height — a sixteen-degree lean, the least that reads as gas
 * being carried somewhere rather than as a pillar standing still.
 *
 * WHY A CONSTANT AND NOT THE WEATHER'S WIND: this plugin is forbidden from
 * importing weather (plugins may not import each other), and no wind vector is
 * exposed on ClientPluginCtx today. A SHARED lean matters more than a correct
 * one here — every column in a burning wood leaning the same way is what makes
 * fifty fires read as one event, and fifty independently wandering columns read
 * as fifty decals. Small, so it biases the noise rather than replacing it. The
 * honest residual: smoke does not answer to the storm blowing through it. If
 * wind is ever published to plugins, this is the constant it replaces.
 */
const SMOKE_DRAUGHT_LEAN = 1.2;
const SMOKE_DRAUGHT_DIRECTION_X = 0.82;
const SMOKE_DRAUGHT_DIRECTION_Z = -0.57;
/**
 * How far one column's lean may swing off the shared draught, in radians of
 * compass bearing, and by what fraction its lean may be longer or shorter.
 *
 * WHAT THIS FIXES, from the renders: with one draught applied identically to
 * every column, five fires photographed as five parallel pillars — the shape
 * of fog, not of smoke, because nothing in a real column of gas is parallel to
 * the one beside it. The variation is bounded rather than free for the reason
 * the shared draught exists at all: ±0.35 rad is ±20°, wide enough that no two
 * columns in a frame are parallel and narrow enough that all of them are still
 * plainly standing in the same air, so a burning wood still reads as ONE event.
 * ±40 % on the length does the same for how far each one leans.
 *
 * SEEDED FROM THE FIRE'S OWN `seed`, through the aSeed attribute that is
 * already there, so a column's lean is stable for its whole life and identical
 * on every client: never Math.random(), and no new attribute, no new
 * allocation and no new draw call to carry it.
 */
const SMOKE_DRAUGHT_BEARING_SPREAD_RADIANS = 0.35;
const SMOKE_DRAUGHT_LEAN_SPREAD = 0.4;

// ── Colour and alpha ──────────────────────────────────────────────────────
/**
 * The height ramp. Sooty where it leaves the fire, pale where it has cooled and
 * spread. Both greys are deliberately off-neutral toward warm: pure grey over
 * this game's bright green grass reads as a rendering artefact, and smoke off
 * burning wood is brown-grey in life.
 */
const SMOKE_BASE_COLOR: readonly [number, number, number] = [0.24, 0.22, 0.21];
const SMOKE_TIP_COLOR: readonly [number, number, number] = [0.74, 0.72, 0.7];
/**
 * Alpha ceiling — LOW, and that is the number that decides whether this feature
 * helps or hurts. Smoke is a thin volume seen through, not a surface; a peak
 * anywhere near the flame's 0.92 would give a grey slab standing in the world.
 * RAISED to 0.5 from 0.34 when SMOKE_EDGE_SOFTNESS was added: that term costs
 * the column most of its alpha everywhere except dead-centre, and at 0.34 the
 * result photographed as a wisp that had lost the distance legibility this
 * whole feature is for. The two numbers are one decision — how dense the CORE
 * of the column is — and only their product is meaningful. 0.5 is dense enough
 * to be a shape against a pale sky and light enough that the terrain, the trees
 * and the flame all read through it.
 */
const SMOKE_ALPHA_PEAK = 0.5;
/**
 * Height over which the column fades IN off its foot, and the height above
 * which it fades OUT to nothing.
 *
 * The foot fade is what keeps the base from being a hard-edged ring hanging in
 * the air where the sleeve begins — the failure the header's crown solution
 * would otherwise buy at the cost of a visible seam. The top fade is smoke
 * dispersing: a column that simply stops at its tip reads as a cropped object.
 */
const SMOKE_FOOT_FADE_HEIGHT = 0.1;
const SMOKE_TOP_FADE_HEIGHT = 0.5;
/**
 * Billowing: noise cycles per second around and up the column, and how much of
 * the alpha it eats. Slower and shallower than the flame's flicker, for the
 * same reason the drift scroll is — this is the surface of a slow body of gas
 * turning over, not a fire guttering.
 */
const SMOKE_BILLOW_SPEED = 0.9;
const SMOKE_BILLOW_DEPTH = 0.55;
/**
 * How sharply the column thins toward its SILHOUETTE EDGES, as an exponent on
 * how squarely the surface faces the camera.
 *
 * WHAT THIS FIXES, from the renders: a sleeve drawn at uniform alpha has a hard
 * outline, and a hard-outlined translucent shape reads as a sheet of glass, not
 * as gas. Real smoke has no edge — it has a falling density you stop being able
 * to see. Fading the grazing angles out reproduces that, and because the sleeve
 * is drawn DoubleSide the two walls stack up through the middle of the column,
 * so the same term makes it densest exactly where you are looking through the
 * most of it. An exponent above 1 pulls the soft margin wider; 1.6 leaves a
 * clear core with a margin about a fifth of the column's width. 1.6 was tried
 * first and photographed as a ghost: past about 1.2 the soft margin has eaten
 * the core it was supposed to be a margin around.
 */
const SMOKE_EDGE_SOFTNESS = 1.1;
/**
 * How deeply the billow noise EATS INTO the column's boundary, as a fraction of
 * what is left there after SMOKE_EDGE_SOFTNESS has thinned it.
 *
 * WHAT THIS FIXES, and it is the other half of the visible-billboard defect: a
 * soft edge is still an edge if it is the same softness all the way round. The
 * renders showed a straight vertical line at the top of frame and clean
 * rectangular smears over the terrace, because the sleeve's outline is a
 * mathematically smooth curve and the eye finds a smooth curve however gently
 * it fades. Letting the same slow noise that drives the billows bite into the
 * margin breaks that curve into a ragged density, which is what a boundary made
 * of gas actually looks like.
 *
 * Weighted by (1 − rim) so it only ever bites at the MARGIN: at 0.7 the
 * silhouette can be eaten away almost entirely where the noise is dark, while
 * the head-on core — where rim is near 1 and the weight near 0 — is untouched.
 * A term that thinned the core instead would be a second, worse way of doing
 * what SMOKE_ALPHA_PEAK already does.
 */
const SMOKE_EDGE_EROSION = 0.7;

// ── Distance ──────────────────────────────────────────────────────────────
/**
 * THE PLAYER'S CAMERA BAND, restated from client/src/config.ts.
 *
 * DOCUMENTED COPIES, not imports: nothing under plugins/ imports client/src,
 * and this plugin is not about to be the first. They are copied rather than
 * invented because "how close is in the player's face" and "how far away is
 * the ordinary view" both have exactly one honest answer each, and it is the
 * camera's own zoom band — CAMERA_CLOSEST_VIEW_WORLD_UNITS,
 * CAMERA_FOV_DEGREES and CAMERA_INITIAL_DISTANCE. If that band is retuned,
 * these three move with it and the two distances below re-derive themselves.
 */
const SMOKE_CLOSEST_ZOOM_FRAME_HEIGHT_WORLD_UNITS = 10;
const SMOKE_CAMERA_FOV_DEGREES = 55;
const SMOKE_DEFAULT_ORBIT_DISTANCE_WORLD_UNITS = 80;
/**
 * Camera distance at which a column is drawn at NOTHING AT ALL, in world units.
 *
 * THE CLOSEST ZOOM THE PLAYER CAN REACH, derived exactly as client/src/config.ts
 * derives CAMERA_MIN_DISTANCE and never written by hand: a lens of vertical
 * field SMOKE_CAMERA_FOV_DEGREES frames `2 · d · tan(fov / 2)` of world height
 * at distance d, so the distance that frames exactly the closest zoom's ten
 * world units is that solved for d — 9.6 units.
 *
 * WHY ZERO HERE, AND NOT THE LOW FRACTION THIS FILE SHIPPED FIRST. At that
 * range the frame is ten world units tall while a mature column is 6.75 tall
 * and 3.3 wide: one column is a third of the picture and a burning wood is the
 * whole of it. The first cut kept 0.3 of an already-low peak and photographed
 * as a grey slab over the top half of the frame, with the sky gone entirely
 * once the fires had burned out — a distance signature that blinds the player
 * up close has failed exactly as badly as one that is invisible. Inside this
 * distance the FLAME is unmissable on its own (2.1 world units in a ten-unit
 * frame, a fifth of the picture), so smoke has nothing left to add and
 * everything to hide, and it is drawn at nothing.
 */
const SMOKE_SILENT_DISTANCE =
  SMOKE_CLOSEST_ZOOM_FRAME_HEIGHT_WORLD_UNITS /
  (2 * Math.tan((SMOKE_CAMERA_FOV_DEGREES * Math.PI) / 180 / 2));
/**
 * Camera distance at which a column reaches FULL strength, in world units.
 *
 * THE CAMERA'S DEFAULT ORBIT: the distance the game opens at and the one a
 * player spends most of their time near. It is also, and this is why it is the
 * right end of the ramp rather than a number chosen to look nice, exactly where
 * the flame has stopped being legible — 2.1 world units in the 83-unit frame an
 * 80-unit orbit gives is under three per cent of frame height, a couple of
 * pixels behind a hill. From here out the column is the only thing carrying the
 * fire, which is the whole of issue #185.
 *
 * The band between the two is therefore the handover: the flame does the
 * talking near, the smoke does it far, and no camera distance has both
 * shouting. Wide on purpose — nine to eighty world units — because the fires in
 * one frame stand a few units apart, and a narrow band was what made two
 * neighbouring columns in the same picture differ visibly in strength for no
 * reason a player could see.
 */
const SMOKE_FULL_STRENGTH_DISTANCE = SMOKE_DEFAULT_ORBIT_DISTANCE_WORLD_UNITS;

/**
 * Where smoke sits in the transparent pass: BEFORE the flames.
 *
 * Both this and the flames are depth-write-off transparent geometry, so the
 * order they are submitted in is the order they composite in, and it is not
 * decided by depth. Smoke rises out of the BACK of a fire, so the flame must be
 * painted over it; the reverse puts a grey veil across the one thing in the
 * frame that is supposed to be the brightest.
 */
const SMOKE_RENDER_ORDER = -1;

/** Stable 0…1 from an integer — ./flames/shaderPlume.ts's. Never Math.random(). */
function unitFromSeed(seed: number, salt: number): number {
  let h = (seed ^ (salt * 0x9e3779b1)) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 0x100000000;
}

const SMOKE_VERTEX_SHADER = /* glsl */ `
  uniform float uTime;

  attribute float aSeed;
  attribute float aStrength;

  varying float vHeight;
  varying float vSeed;
  varying float vAngle;
  varying float vStrength;
  varying float vDistanceFade;
  varying float vFacing;

  ${VALUE_NOISE_GLSL}

  void main() {
    // The sleeve is authored with its foot at y = 0 and unit height, so
    // position.y IS the height fraction — no division, no uniform.
    float height = clamp(position.y, 0.0, 1.0);
    vHeight = height;
    vSeed = aSeed;
    vStrength = aStrength;
    vAngle = atan(position.z, position.x);

    // Anchor the foot over the fire, free the top.
    float bias = pow(height, ${SMOKE_DRIFT_HEIGHT_BIAS.toFixed(2)});
    float travel = height * ${SMOKE_DRIFT_FREQUENCY.toFixed(2)} - uTime * ${SMOKE_DRIFT_SCROLL_SPEED.toFixed(2)};

    // Two decorrelated lookups so x and z wander independently — one lookup
    // shared between them would make every column sway along one diagonal.
    float driftX = fnoise(vec2(travel, aSeed * 41.0));
    float driftZ = fnoise(vec2(travel, aSeed * 41.0 + 23.9));
    float swell = fnoise(vec2(travel * 1.9, aSeed * 41.0 + 8.4));

    vec3 warped = position;
    // Neck and swell BEFORE the lean, so the billows are carried sideways with
    // the column rather than being stretched across a shape that already leant.
    warped.xz *= 1.0 + swell * ${SMOKE_BILLOW_RADIUS_AMPLITUDE.toFixed(2)} * bias;
    warped.x += driftX * ${SMOKE_DRIFT_AMPLITUDE.toFixed(2)} * bias;
    warped.z += driftZ * ${SMOKE_DRIFT_AMPLITUDE.toFixed(2)} * bias;
    // The shared draught, on top of the per-column wander: this is what makes a
    // wood full of fires read as one event rather than as many. Swung off that
    // shared bearing by a bounded, seed-stable amount per column, because five
    // columns leaning IDENTICALLY are five parallel pillars and no column of
    // gas has ever been parallel to the one next to it. Two decorrelated hashes
    // so bearing and length do not vary together.
    float bearingJitter = hash21(vec2(aSeed, 3.70)) * 2.0 - 1.0;
    float lengthJitter = hash21(vec2(aSeed, 8.31)) * 2.0 - 1.0;
    float bearing = bearingJitter * ${SMOKE_DRAUGHT_BEARING_SPREAD_RADIANS.toFixed(3)};
    float leanLength =
      ${SMOKE_DRAUGHT_LEAN.toFixed(3)} *
      (1.0 + lengthJitter * ${SMOKE_DRAUGHT_LEAN_SPREAD.toFixed(2)});
    // Rotating the shared unit bearing, rather than jittering x and z apart,
    // keeps every column's lean the same LENGTH it was asked for — a component
    // jitter would quietly make diagonal leans longer than axis-aligned ones.
    vec2 draught = vec2(
      ${SMOKE_DRAUGHT_DIRECTION_X.toFixed(3)} * cos(bearing) - ${SMOKE_DRAUGHT_DIRECTION_Z.toFixed(3)} * sin(bearing),
      ${SMOKE_DRAUGHT_DIRECTION_X.toFixed(3)} * sin(bearing) + ${SMOKE_DRAUGHT_DIRECTION_Z.toFixed(3)} * cos(bearing));
    vec2 lean = draught * leanLength;
    warped.xz += lean * bias;

    // DISTANCE FADE, measured to the COLUMN'S FOOT and not per-vertex: the
    // whole column must fade as one body. A per-vertex distance would fade a
    // column's near side differently from its far side, which is a gradient
    // across a single object that nothing in the world justifies.
    vec4 foot = modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
    float cameraDistance = distance(cameraPosition, foot.xyz);
    // ...and it runs from NOTHING at the closest zoom to full at the default
    // orbit. No floor under it: inside SMOKE_SILENT_DISTANCE the flame is a
    // fifth of the frame on its own and the column is only in the way.
    vDistanceFade = smoothstep(
      ${SMOKE_SILENT_DISTANCE.toFixed(2)},
      ${SMOKE_FULL_STRENGTH_DISTANCE.toFixed(2)},
      cameraDistance);

    // HOW SQUARELY THIS PIECE OF WALL FACES THE CAMERA, 0 at the silhouette and
    // 1 head-on. This is the term the whole no-visible-billboard problem rests
    // on, and getting it from the AUTHORED normal — which is what this file
    // shipped first — is why the sleeve read as a quad.
    //
    // The normal that matters is the normal of the surface ACTUALLY DRAWN, and
    // two transforms stand between the two:
    //
    //   THE WARP, which is a SHEAR. Every stretch above displaces xz by an
    //   amount that grows with height, so the wall is not the wall the cone
    //   authored: it is tilted by the rate at which that displacement changes
    //   with height. At the lean this column now carries that is on the order
    //   of fifteen degrees, and it tilts the two sides of the column in
    //   OPPOSITE directions — which is exactly what the renders showed, one
    //   silhouette edge softening correctly and the other staying hard.
    //
    //   THE INSTANCE MATRIX, which is a non-uniform SCALE: this sleeve is
    //   stretched about four times harder up (SMOKE_HEIGHT_PER_FUEL) than out
    //   (SMOKE_TIP_RADIUS_PER_FUEL), and three's normalMatrix is built from the
    //   modelView matrix ALONE, with the instance matrix nowhere in it.
    //
    // Both are undone here, in order, and BOTH ARE EXACT rather than
    // approximated, because a normal is transformed by the INVERSE TRANSPOSE of
    // the map that moved the surface and both maps are known in closed form.
    // The only thing left out is the noise's own dependence on position, which
    // is a second-order wobble on a term feeding a soft falloff — and recovering
    // it would mean three more noise evaluations per vertex.
    //
    // The shear's Jacobian is [[s, gx, 0], [0, 1, 0], [0, gz, s]]: s is the
    // radial swell, and gx/gz are how fast the lateral displacement grows with
    // height — the same drift, swell and lean already computed above, times the
    // slope of the height bias. Its inverse transpose is what the three lines
    // below apply, at the cost of two multiplies and a divide.
    float biasSlope =
      ${SMOKE_DRIFT_HEIGHT_BIAS.toFixed(2)} *
      pow(max(height, 0.0001), ${(SMOKE_DRIFT_HEIGHT_BIAS - 1).toFixed(2)});
    float radialSwell = 1.0 + swell * ${SMOKE_BILLOW_RADIUS_AMPLITUDE.toFixed(2)} * bias;
    float shearX =
      (position.x * swell * ${SMOKE_BILLOW_RADIUS_AMPLITUDE.toFixed(2)} +
        driftX * ${SMOKE_DRIFT_AMPLITUDE.toFixed(2)} + lean.x) * biasSlope;
    float shearZ =
      (position.z * swell * ${SMOKE_BILLOW_RADIUS_AMPLITUDE.toFixed(2)} +
        driftZ * ${SMOKE_DRIFT_AMPLITUDE.toFixed(2)} + lean.y) * biasSlope;
    vec3 surfaceNormal = vec3(
      normal.x / radialSwell,
      normal.y - (shearX * normal.x + shearZ * normal.z) / radialSwell,
      normal.z / radialSwell);
    vec3 instanceScale = vec3(
      length(instanceMatrix[0].xyz),
      length(instanceMatrix[1].xyz),
      length(instanceMatrix[2].xyz));
    vFacing = abs(normalize(normalMatrix * (surfaceNormal / instanceScale)).z);

    gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(warped, 1.0);
  }
`;

const SMOKE_FRAGMENT_SHADER = /* glsl */ `
  uniform float uTime;

  varying float vHeight;
  varying float vSeed;
  varying float vAngle;
  varying float vStrength;
  varying float vDistanceFade;
  varying float vFacing;

  ${VALUE_NOISE_GLSL}

  void main() {
    // Sooty at the fire, pale where it has cooled and spread.
    vec3 color = mix(
      vec3(${SMOKE_BASE_COLOR.map((c) => c.toFixed(3)).join(', ')}),
      vec3(${SMOKE_TIP_COLOR.map((c) => c.toFixed(3)).join(', ')}),
      vHeight);

    // In off the foot, out into nothing at the top.
    float body =
      smoothstep(0.0, ${SMOKE_FOOT_FADE_HEIGHT.toFixed(2)}, vHeight) *
      (1.0 - smoothstep(${SMOKE_TOP_FADE_HEIGHT.toFixed(2)}, 1.0, vHeight));

    // Billow, sampled around the column AND up it, so the turning-over crawls
    // across the surface instead of pulsing the whole sleeve at once. Stronger
    // near the top: the foot of a column is a coherent stream, the top is where
    // it breaks up.
    float turn = fnoise(vec2(
      vAngle * 1.4 + vSeed * 17.0,
      vHeight * 2.6 - uTime * ${SMOKE_BILLOW_SPEED.toFixed(2)}));
    float billow = 1.0 - ${SMOKE_BILLOW_DEPTH.toFixed(2)} * vHeight * (0.5 - 0.5 * turn) * 2.0;

    // No hard outline: the column thins to nothing at its silhouette, which is
    // the difference between gas and a pane of grey glass.
    float rim = pow(clamp(vFacing, 0.0, 1.0), ${SMOKE_EDGE_SOFTNESS.toFixed(2)});
    // ...and no outline the eye can TRACE either. the billow noise is the same slow noise
    // the billows are made of, reused rather than sampled again, so the ragged
    // boundary crawls with the body it belongs to instead of shimmering against
    // it. (0.5 - 0.5 * turn) maps the noise's -1…1 onto 0…1, deepest where the
    // noise is darkest.
    float edge = clamp(
      rim - ${SMOKE_EDGE_EROSION.toFixed(2)} * (1.0 - rim) * (0.5 - 0.5 * turn),
      0.0,
      1.0);

    float alpha =
      body * edge * clamp(billow, 0.0, 1.0) * vStrength * vDistanceFade *
      ${SMOKE_ALPHA_PEAK.toFixed(2)};
    if (alpha <= 0.004) discard;
    gl_FragColor = vec4(color, alpha);
  }
`;

/**
 * One fire's smoke, remembered between frames.
 *
 * Everything here is copied BY VALUE out of a FireInstance. The instance object
 * itself is never retained — see this file's header, and ./flames/types.ts's
 * `key`.
 */
interface SmokeColumn {
  x: number;
  z: number;
  groundY: number;
  fuelHeight: number;
  seed: number;
  /** 0…1. Rises while the fire is alight, decays for good once it is not. */
  strength: number;
  /** Whether the fire that seeds this column was in the last applied list. */
  alive: boolean;
}

/**
 * The smoke renderer's contract.
 *
 * Shaped like ./flames/types.ts's FlameRenderer and deliberately NOT that type,
 * because `apply` means something different here: the list is WHICH FIRES ARE
 * ALIVE, not the set to draw. A renderer that promised FlameRenderer's contract
 * and then drew columns for fires nobody handed it would be lying about the one
 * thing that contract exists to state.
 */
export interface FireSmoke {
  /** Everything this renderer draws. The plugin adds it to its layer. */
  readonly root: Group;
  /**
   * Tells the renderer which fires are ALIGHT right now. Columns are created
   * for keys it has not seen, refreshed for keys it has, and left to decay for
   * keys that have stopped appearing. Safe to call with an empty list on every
   * frame of a world that has stopped burning — that is exactly the case the
   * afterlife exists for.
   */
  apply(fires: readonly FireInstance[]): void;
  /** How many columns are currently being drawn — live fires and retiring smoke. */
  readonly drawnCount: number;
  /**
   * Advances every column's lifetime and its animation. `dt` is seconds since
   * the last frame; `elapsed` is seconds since the plugin attached.
   *
   * MUST be called on every frame in which anything is still smoking, INCLUDING
   * frames on which nothing is burning — otherwise a column's retirement stalls
   * and the last fire in the world leaves a permanent smudge over its ashes.
   */
  update(dt: number, elapsed: number): void;
  /** Frees every geometry and material. Called once, at dispose. */
  dispose(): void;
}

export const createFireSmoke = (): FireSmoke => {
  const root = new Group();
  root.name = 'fire:smoke';

  // Open-ended: no lid and no floor. Both would be visible as flat discs the
  // moment the camera looked down the column's axis, which this game's camera
  // does constantly — and the top disc of a smoke column would be the worst of
  // the two, since the top is the widest part.
  const geometry = new CylinderGeometry(
    1,
    SMOKE_FOOT_RADIUS_FRACTION,
    1,
    SMOKE_RADIAL_SEGMENTS,
    SMOKE_HEIGHT_SEGMENTS,
    true,
  );
  // Foot at the origin, so position.y is the height fraction in the shader.
  geometry.translate(0, 0.5, 0);

  const material = new ShaderMaterial({
    uniforms: { uTime: { value: 0 } },
    vertexShader: SMOKE_VERTEX_SHADER,
    fragmentShader: SMOKE_FRAGMENT_SHADER,
    transparent: true,
    depthWrite: false,
    // Normal blending, never additive — ./flames/shaderPlume.ts's reason and
    // then some. Additive grey over bright green grass is a paler green, which
    // is to say: no smoke at all, exactly where a fire is most likely to be.
    // Smoke is also the one thing here that must be able to DARKEN what is
    // behind it, and additive blending can only ever lighten.
    side: DoubleSide,
  });

  const mesh = new InstancedMesh(geometry, material, SMOKE_COLUMN_CAP);
  mesh.name = 'fire:smoke:columns';
  mesh.count = 0;
  mesh.renderOrder = SMOKE_RENDER_ORDER;
  // The drift moves vertices past the geometry's own bounds, so the cached
  // bounding sphere would cull a column that is still on screen.
  mesh.frustumCulled = false;
  root.add(mesh);

  const seeds = new InstancedBufferAttribute(new Float32Array(SMOKE_COLUMN_CAP), 1);
  const strengths = new InstancedBufferAttribute(new Float32Array(SMOKE_COLUMN_CAP), 1);
  seeds.setUsage(DynamicDrawUsage);
  strengths.setUsage(DynamicDrawUsage);
  geometry.setAttribute('aSeed', seeds);
  geometry.setAttribute('aStrength', strengths);

  /**
   * Every column, by ./flames/types.ts's `key`. THE key, not the instance: the
   * key is what survives a frame, and looking a fire up again by it is the only
   * thing that cannot go stale.
   */
  const columns = new Map<number, SmokeColumn>();

  // Scratch — built once and written in place forever, since `update` runs on
  // every frame in which anything is smoking.
  const matrix = new Matrix4();
  const position = new Vector3();
  const rotation = new Quaternion();
  const scale = new Vector3();

  /**
   * Frees a slot when the cap binds, by dropping the FAINTEST column.
   *
   * The faintest is the least visible thing on screen, so it is the cheapest
   * thing to lose — and unlike "drop the oldest" it never sacrifices a column
   * that is still climbing to full strength in order to keep one that is a
   * second from retiring anyway.
   */
  function evictFaintest(): void {
    let faintestKey: number | null = null;
    let faintestStrength = Infinity;
    for (const [key, column] of columns) {
      if (column.strength < faintestStrength) {
        faintestStrength = column.strength;
        faintestKey = key;
      }
    }
    if (faintestKey !== null) columns.delete(faintestKey);
  }

  return {
    root,

    get drawnCount(): number {
      return mesh.count;
    },

    apply(fires: readonly FireInstance[]): void {
      // Everything is presumed dead until this frame's list says otherwise.
      // That is what turns "the fire is gone from the synced set" — which
      // arrives as an ABSENCE, never as a message — into the start of a
      // column's afterlife.
      for (const column of columns.values()) column.alive = false;

      for (const fire of fires) {
        const existing = columns.get(fire.key);
        if (existing !== undefined) {
          // A WALKING fire moves, so the position is refreshed every frame
          // rather than kept from ignition. When it finally dies, the column
          // retires wherever the creature fell, which is where the fire was.
          existing.x = fire.x;
          existing.z = fire.z;
          existing.groundY = fire.groundY;
          existing.fuelHeight = fire.fuelHeight;
          existing.alive = true;
          continue;
        }
        if (columns.size >= SMOKE_COLUMN_CAP) evictFaintest();
        // The only allocation this renderer makes after construction, and it
        // happens on a server delta — a new fire — not on a frame.
        columns.set(fire.key, {
          x: fire.x,
          z: fire.z,
          groundY: fire.groundY,
          fuelHeight: fire.fuelHeight,
          seed: fire.seed,
          strength: 0,
          alive: true,
        });
      }
    },

    update(dt: number, elapsed: number): void {
      if (columns.size === 0) {
        // Nothing has ever smoked, or everything has retired. Leave the drawn
        // count at zero rather than re-uploading an empty buffer every frame.
        mesh.count = 0;
        return;
      }

      material.uniforms['uTime']!.value = elapsed;

      const seedArray = seeds.array as Float32Array;
      const strengthArray = strengths.array as Float32Array;
      let drawn = 0;

      for (const [key, column] of columns) {
        if (column.alive) {
          column.strength = Math.min(1, column.strength + dt / SMOKE_RISE_SECONDS);
        } else {
          column.strength -= dt / SMOKE_AFTERLIFE_SECONDS;
          if (column.strength < SMOKE_MINIMUM_VISIBLE_STRENGTH) {
            // Retired. Deleting DURING the iteration is safe on a Map and is
            // how ../client/index.ts drops a burned-out fire as it passes it.
            columns.delete(key);
            continue;
          }
        }

        // The foot sits at the TOP of the fuel, never on the ground — the crown
        // depth-culling answer in this file's header.
        position.set(
          column.x,
          column.groundY + column.fuelHeight * SMOKE_BASE_HEIGHT_PER_FUEL,
          column.z,
        );
        const tipRadius = column.fuelHeight * SMOKE_TIP_RADIUS_PER_FUEL;
        scale.set(tipRadius, column.fuelHeight * SMOKE_HEIGHT_PER_FUEL, tipRadius);
        matrix.compose(position, rotation, scale);
        mesh.setMatrixAt(drawn, matrix);

        // The seed is a phase, not an index: scaled into a range wide enough
        // that two neighbouring cells land in different noise cells entirely.
        seedArray[drawn] = unitFromSeed(column.seed, 9) * 64;
        strengthArray[drawn] = column.strength;
        drawn++;
      }

      mesh.count = drawn;
      mesh.instanceMatrix.needsUpdate = true;
      seeds.needsUpdate = true;
      strengths.needsUpdate = true;
    },

    dispose(): void {
      mesh.dispose();
      geometry.dispose();
      material.dispose();
      root.clear();
      columns.clear();
    },
  };
};
