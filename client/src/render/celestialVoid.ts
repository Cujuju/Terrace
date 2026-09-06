// THE CELESTIAL VOID — what is drawn outside the map (issue #326).
//
// The world used to sit on a flat `scene.background` the colour of the sky
// (render/scene.ts, before this arc), so "off the map" and "the sky" were the
// same painted nothing. The owner's ask: make it read as "a plot among the
// stars". Two approved looks, chosen per player in the HUD's Controls panel:
//
//   'wheel'  (default) — a four-armed spiral galaxy seen at 60 degrees, its
//                        hub on the view axis under the map: log-spiral arms,
//                        dust lanes, a warm bulge, and stars in the disk plane
//                        that turn rigidly with the gas.
//   'nebula'           — domain-warped fbm clouds with two steady star layers.
//
// The GLSL below is a faithful port of the shaders the owner approved
// (.claude/orchestration/refs/celestial-void-shaders.glsl), at that file's
// REVISION 7 (owner, 2026-09-04). Cumulatively that revision line is: a 60
// degree default tilt, rotation reversed (clockwise seen from above), no
// twinkle in either look, the nebula's drift 3x faster (NEBULA_RATE 0.15),
// and the wheel rebuilt as a four-armed spiral galaxy — log-spiral arms with
// grain streaked along them, dust lanes, a warm bulge under the map, and stars
// embedded in the disk plane that turn rigidly with the gas. The wheel's rate
// has moved twice: revision 4 put it back to -0.008 because revision 3's 3x
// was too fast, then revision 5 took it to -0.04 (~2.6 min per turn) on the
// owner's "many times faster", with the arm count going from two to four at
// the same time. Revision 6 (owner, in-world, 2026-09-04) slowed it by a third
// to -0.0267, removed the white core, dimmed the bulge, darkened the gas and
// made the arms thicker and more tightly wound; revision 7 (same day) pushed
// further: -0.021 (five minutes per turn), gas gain 1.0, arm exponent 1.0,
// winding 8.0. Revision 9 (in-world, same day) reworked the arms' CONTENT:
// grain sampled along each arm's own curve (long cells along, short across,
// in a seam-free periodic noise) instead of across it, a low-frequency
// wander on the arm phase so the swirl is not rigid, and a deeper palette
// (deep blue → violet, rose in dense grain, teal in the haze). The numbers in these shaders ARE the approved look; every
// one that encodes a design decision is a named constant here or in the
// shader's own `const` block.
//
// TIME OF DAY MUST NOT TOUCH IT. The owner's second rule: day/night affects
// the map's lighting only, never the void. That is enforced structurally
// rather than by a flag — `scene.background` is now null, and the one writer
// of it (render/skyRig.ts, driven by plugins/daynight) only writes when the
// background is a `Color`, so the day/night and cyclone plugins keep
// computing a `backgroundColor` that nothing consumes. No plugin edit, no
// conditional: there is simply no longer a background for them to tint.
//
// WHY A FULLSCREEN TRIANGLE MESH AND NOT A CAMERA-FOLLOWING SKY SPHERE.
// The brief left the choice open, on the criterion "least code in scene.ts".
// This shape needs ZERO code there beyond deleting the old background line:
// the mesh's vertex shader writes clip space directly, so it ignores the
// camera and the projection matrix entirely, needs no per-frame position
// sync, no radius that has to stay inside CAMERA_FAR, and no `frustumCulled`
// bookkeeping beyond the flag. A sky sphere would have needed a per-frame
// `position.copy(camera.position)` inside the render loop — i.e. an edit to
// renderFrame — plus a radius picked against the camera's near/far planes.
// Rendering the triangle before the scene with `autoClear` managed was the
// other option offered and was rejected for the same reason: it splits one
// `renderer.render` call into a manual two-pass sequence in scene.ts.
//
// TWO ANCHORS, ONE SHADER (owner, 2026-09-04: "give me the option in settings
// to lock it"). Every fragment builds a view ray from screen space and a
// focal length, turns it into DISK SPACE — hub at the origin, the disk in the
// z = 0 plane, z up, in disk units — and intersects the plane there. What
// differs between the anchors is only the three uniforms that define that
// frame, all set from JS:
//
//   'view'  (default) — the reference's own frame: origin fixed VIEW_HUB_DISTANCE
//           along the view axis, disk tilted WHEEL_TILT_DEGREES. Nothing here
//           reads the camera, so panning and orbiting leave the void alone
//           and the hub stays on the view axis, exactly as approved.
//   'world' — the disk IS the world's plane: its normal is world +Y, its hub
//           is the fixed world point LOCKED_HUB_CLEARANCE_WORLD below the
//           floor of the map at its centre, LOCKED_WORLD_UNITS_PER_DISK_UNIT world units to one
//           disk unit, and the ray is the real camera's. Orbiting, panning
//           and zooming all move the void with the terrain. THE HUB IS A
//           CONSTANT, NOT CAPTURED: locking never samples the camera or the
//           previous anchor, so lock → unlock → lock lands on the same
//           position every time (owner: "always be in the same position").
//
// The world frame is read in the mesh's onBeforeRender, not in onFrame:
// frame callbacks run BEFORE controls.update() writes the camera (see
// scene.ts's renderFrame), so a pose read there is a frame stale, and a
// backdrop one frame behind the terrain swims visibly during an orbit.
// onBeforeRender runs inside renderer.render, after the camera's matrices
// are final for this frame.
//
// THE ARM PATTERN IS BAKED, NOT EVALUATED PER FRAGMENT (perf, issue #340).
// `gasPattern` and the gas's level field depend only on the rotating-frame
// plane position, so they are rendered ONCE into two log-polar textures when
// the wheel material is first created, and every fragment reads them back with
// one atan, one log and two fetches. The values are the approved ones — the
// same GLSL writes the texture — and the mip chain also removes the shimmer the
// procedural version showed when the world anchor was zoomed far out. Rotation
// stays per-frame: only the evaluation was replaced, not the motion.
//
// THE GAS IS MARCHED AT HALF RESOLUTION (perf, issue #341). The march itself —
// the bake fetches, GAS_STEPS samples of the depth profile and the
// transmittance loop — is the wheel's other bulk cost, and its result is a
// smooth field: it has no edge sharper than a dust lane, which is many pixels
// wide at every pose. So it runs in its own program (GAS_GLSL) into a
// half-resolution render target once per frame, and the full-res wheel reads it
// back bilinearly. Only what the march CANNOT reconstruct is stored — the lit
// gas colour and the opacity — while the depth fade, the bulge, GAS_GAIN and
// the fade early-out stay at full resolution, so the one genuinely sharp edge
// in the composite is still evaluated per pixel. The pass is driven from the
// mesh's onBeforeRender, the same hook that writes the world frame, so the gas
// and the stars are drawn from one camera; an onFrame callback would leave the
// gas a frame behind the stars and the two layers would slide apart in an orbit.
//
// THE STARS ARE A POINT CLOUD (perf, issue #342). The wheel's last bulk item was
// the star search: every full-res fragment walked three 3-D voxel grids, hashing
// STAR_WALK voxels of each to find the stars on its own ray, for about a
// millisecond at 1440p. The stars are now generated ONCE into vertex buffers
// (render/celestialVoidStars.ts) and drawn as GL_POINTS after the wheel, so the
// GPU rasterises each star where it belongs instead of every pixel searching for
// it. The per-star arithmetic is unchanged — it simply runs once per star, in a
// vertex shader, instead of once per fragment per voxel: the same projection,
// the same depth fade, the same screen-size floor, the same gas dimming, and the
// same smoothstep falloff, now evaluated across a point sprite on
// `gl_PointCoord` rather than in 3-D against the ray. The 0.8 px radius floor
// (STAR_MIN_PX) and its anti-shimmer role carry over exactly.
//
// The composite is unchanged too, and deliberately: the wheel's stars were added
// (`col += stars`), so an ADDITIVE draw over the wheel's output is the same
// arithmetic and needs no second render target. The gas opacity every star
// formula wants is already in the texture the gas pass wrote this frame, so the
// point programs read `u_gasHalf.a` at the star's own screen position — which is
// how the field stars are dimmed by the gas over them exactly as before.
//
// THE IN-ARM GRID HAS NEVER DRAWN, AND STAYS OFF. Its walk was called with
// depth = DISK_THICKNESS at 40 cells per unit, which puts its floor at
// zBot = -0.94 cells; the walk starts at the voxel just under the plane,
// cell.z = floor(-0.001) = -1, so `if(cell.z<zBot) break;` fired on the first
// iteration and the grid contributed exactly nothing to any frame from rev 13
// to rev 20. The look the owner approved therefore has no in-arm stars in it,
// and a perf phase is not where a new layer arrives: STAR_ARM_GRID_ENABLED is
// false, so the grid is neither generated nor drawn. The shader's grid-2 branch
// is kept as written — it is the intended design and one flag away — and the
// owner decides on issue #342 whether to see it.
//
// Two things about the field DID change, and both are look decisions: it is a
// fresh random draw with the same statistics rather than today's exact stars
// (fixed seeds, so it is the same field on every start), and every star to a
// grid's full depth is drawn, where the walk stopped after STAR_WALK voxels —
// about 80 % of the coarse depth at 60 degrees and much less at the grazing
// angles that fill most of a tilted frame, a bench compromise rather than a look
// choice. The field therefore gains back the stars the walk never reached, which
// reads as more faint stars rather than as a brighter sky (measured on the
// bench's shots: 3.5x the distinct star cores in the deep field, +3 % mean
// luminance there).
//
// COLOUR PIPELINE. The renderer runs ACES tone mapping at exposure 1.25
// (render/scene.ts) and sRGB output conversion. Both are opt-in per shader in
// three: a custom ShaderMaterial only gets them if its fragment source
// `#include`s `<tonemapping_fragment>` / `<colorspace_fragment>`. Neither is
// included below, and `toneMapped: false` says so on the material as well, so
// the approved values reach the framebuffer as written — exactly as they did
// on the plain WebGL canvas the concept was approved on.

import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  Camera,
  ClampToEdgeWrapping,
  Float32BufferAttribute,
  HalfFloatType,
  LinearFilter,
  LinearMipmapLinearFilter,
  Matrix3,
  Mesh,
  type PerspectiveCamera,
  Points,
  type PixelFormat,
  RedFormat,
  RepeatWrapping,
  RGBAFormat,
  Scene,
  ShaderMaterial,
  type Texture,
  Vector2,
  Vector3,
  WebGLRenderTarget,
  type IUniform,
} from 'three';
import { DEFAULT_WORLD_SPAN, MAX_HEIGHT, MIN_HEIGHT } from '@terrace/shared';
import {
  CAMERA_FOV_DEGREES,
  CAMERA_MAX_DISTANCE,
  CELL_WORLD_SIZE,
  HEIGHT_WORLD_SCALE,
} from '../config.ts';
import { generateStarGrid, type StarGridSpec } from './celestialVoidStars.ts';
import type { Viewport } from './scene.ts';

export type VoidStyle = 'nebula' | 'wheel';

/** Where the void is fixed: to the view (the reference look) or to the world. */
export type VoidAnchor = 'view' | 'world';

/**
 * Tilt of the star wheel's disk from the view axis, in degrees.
 *
 * The owner's first ask was "something like a thirty to forty five degree
 * angle"; revision 2 of the approved reference (2026-09-04) supersedes that
 * with 60°, which is what they signed off on after seeing both — the steeper
 * tilt opens the ellipse enough that the stars' circular motion reads as
 * orbiting rather than as sideways drift.
 *
 * It is a constant and NOT a preference: the owner asked for the look to be
 * switchable, not for its tilt or its speed to be dialled from the HUD.
 */
const WHEEL_TILT_DEGREES = 60;

/**
 * Overall size of the disk relative to the approved concept page. Owner,
 * 2026-09-05: "reduce the size of the entire disk by maybe fifteen percent".
 * Applied in both anchors: the world anchor's units per disk unit, and the
 * view anchor's eye distance (a farther eye shrinks everything alike).
 */
const DISK_SCALE = 0.85;

/**
 * Distance from the eye to the hub along the view axis in the 'view' anchor,
 * disk units. The reference's DISK_DIST, pushed back by DISK_SCALE.
 */
const VIEW_HUB_DISTANCE = 2.6 / DISK_SCALE;

/**
 * The 'view' anchor's focal length: how far, in screen heights, the image
 * plane sits from the eye. 1.2 is the reference's FOCAL — a stand-in
 * perspective (~45° vertical) chosen for the look, not the real camera's.
 * The 'world' anchor uses the real camera's focal instead, otherwise the void
 * would not line up with the terrain drawn through the true projection.
 */
const VIEW_FOCAL = 1.2;

/**
 * The nebula's noise zoom: screen-height units to noise units in the 'view'
 * anchor (the reference's `uv*2.2`). In disk space that is a plane
 * NEBULA_ZOOM focal lengths from the eye, which is how the world anchor gets
 * the same texture density at the same apparent distance.
 */
const NEBULA_ZOOM = 2.2;

/**
 * World units per disk unit in the 'world' anchor. 200 makes the galaxy's
 * e-folding radius (DISK_RADIUS 1.7 → 340 world units) a little wider than
 * the default map's half-span (256), so the map sits over the bulge with the
 * arms sweeping out past every edge — the composition the concept page
 * approved, at 1:1 with the world instead of the view. Then DISK_SCALE.
 */
const LOCKED_WORLD_UNITS_PER_DISK_UNIT = 200 * DISK_SCALE;

/**
 * Full thickness of the disk, world units: gas volume and star field alike
 * live between the plane and this far under it. Owner, 2026-09-05: "don't
 * make the disk any thicker than four world units". In disk units for the
 * shaders below.
 */
const DISK_THICKNESS_WORLD = 4;
const DISK_THICKNESS = DISK_THICKNESS_WORLD / LOCKED_WORLD_UNITS_PER_DISK_UNIT;

/**
 * How far under the plane the star field reaches, world units. Owner,
 * 2026-09-05: "substantially more Z variability for the stars" — the gas
 * keeps to DISK_THICKNESS_WORLD, the stars go on below it, away from the map.
 */
const STAR_FIELD_DEPTH_WORLD = 120;
const STAR_FIELD_DEPTH = STAR_FIELD_DEPTH_WORLD / LOCKED_WORLD_UNITS_PER_DISK_UNIT;

/**
 * How far under the plane the FINE field reaches, disk units: half as deep as
 * the coarse one, which it has twice the cells per unit of — the same voxel
 * budget, back when the grids were walked.
 */
const STAR_FINE_DEPTH = 0.5 * STAR_FIELD_DEPTH;

/**
 * Clearance between the bottom of the map and the locked disk, world units.
 * Owner, 2026-09-04: "the map to sit just above the star rendering", then
 * "five world units from the lowest possible layer or band", then rev 10
 * "set the number of units from 5 to 2". The map's
 * lowest drawn geometry is at MIN_HEIGHT (the lava floor and the skirts down
 * to it), so the disk lies this far under that, not under sea level.
 */
const LOCKED_HUB_CLEARANCE_WORLD = 2;

/**
 * World y of the locked hub: LOCKED_HUB_CLEARANCE_WORLD under the world's
 * floor. Negative — the floor is MIN_HEIGHT (−24 world units at the current
 * relief scale) and the hub sits below it.
 */
const LOCKED_HUB_WORLD_Y = MIN_HEIGHT * HEIGHT_WORLD_SCALE - LOCKED_HUB_CLEARANCE_WORLD;

/**
 * Where `gasPattern`'s radial falloff finishes ramping in, disk units. It is a
 * RAMP, `smoothstep(0, GAS_INNER_R, r)`, not a floor: the gas is already half
 * strength at r = 0.06 and only reaches exactly zero at the hub itself. The
 * bake therefore has to cover r = 0, not start here — starting at 0.12 clamped
 * the inner sixth of the hub shot to one row of texels and turned the arms
 * into radial spokes (seen, 2026-09-05).
 */
const GAS_INNER_R = 0.12;

/**
 * The offset inside the arms' radial coordinate `s = log(r + S_LOG_EPS)`. It
 * is part of the approved arm geometry, and it is what makes the bake possible
 * at all: s stays finite at the hub, so the whole disk fits a bounded s range.
 */
const S_LOG_EPS = 0.05;

/**
 * Outer radius of the bake, disk units. The gas fades as
 * `exp(-r/DISK_RADIUS)` with DISK_RADIUS 1.7, which is under 1e-3 of its peak
 * beyond r = 12, so nothing visible lies outside and the texture's clamped
 * outer edge carries a negligible value.
 */
const R_BAKE_MAX = 12;

/** Bottom and height of the baked s range: the hub (r = 0) out to R_BAKE_MAX. */
const GAS_BAKE_S_MIN = Math.log(S_LOG_EPS);
const GAS_BAKE_S_SPAN = Math.log(R_BAKE_MAX + S_LOG_EPS) - GAS_BAKE_S_MIN;

/**
 * Texels along each axis of the baked arm pattern: GAS_BAKE_SIZE around theta
 * and the same up s.
 *
 * The derivation. The finest grain octave is `STREAK_ACROSS*16` = 640 cells
 * around the circle, i.e. 2pi/640 ~ 0.01 rad across an arm; and because the
 * wound angle advances `WIND/ARMS` = 2 rad per e-fold of radius, that same
 * feature moves ~0.005 e-fold in s. Over the baked range (GAS_BAKE_S_SPAN,
 * ~5.5 e-folds from the hub to R_BAKE_MAX) Nyquist therefore asks for ~2200
 * texels in s and ~1300 around, so 2048 on both axes — the nearest power of
 * two, a shade under what s asks for at the very finest octave, whose weight
 * is 0.025. 1024 was benched and shot against it (.void-bench/README.md).
 */
const GAS_BAKE_SIZE = 2048;

/**
 * Where the depth fade finishes, as a multiple of the eye's height above the
 * plane — so it is the same at every zoom in the world anchor. The reference
 * faded between ray lengths DISK_DIST (2.6) and FAR_FADE (12.0) with the eye
 * 2.6*cos(60deg) = 1.3 above the plane, i.e. out to 12.0/1.3 heights. It is a
 * TS constant as well as a shader one because the star field's extents are
 * derived from it (STAR_COARSE_RADIUS below).
 */
const FADE_END_HEIGHTS = 12.0 / 1.3;

/**
 * How far a ground point can lie from the eye's foot and still be inside the
 * fade, as a multiple of the eye's height: the fade ends at FADE_END_HEIGHTS
 * heights of RAY, and a ray of length L from height h reaches sqrt(L^2 - h^2)
 * across the plane.
 */
const FADE_GROUND_REACH = Math.sqrt(FADE_END_HEIGHTS * FADE_END_HEIGHTS - 1);

/**
 * E-folding radius of the gas disk, disk units — the shader's DISK_RADIUS. In
 * TS as well because the in-arm stars' extent is derived from it below.
 */
const GAS_DISK_RADIUS = 1.7;

/**
 * Star cells narrower than this on screen fade out (anti-shimmer). In TS as
 * well as in the shader because the per-frame guard on the fine grids and the
 * fine grid's own extent are both derived from it.
 */
const CELL_FADE_PX = 4.0;

/**
 * How much brighter the in-arm stars are drawn than the gas that reveals them:
 * the wheel's own `*gas*2.5`. In TS as well because it sets where those stars
 * stop being worth drawing at all (STAR_ARM_RADIUS).
 */
const ARM_GRID_GAIN = 2.5;

/**
 * Cells per disk unit of the three star grids, and stars per column of each
 * grid's plane cells — the numbers the wheel used to pass to `stars3`, now the
 * point cloud's own. The coarse field is the one that survives every zoom; the
 * fine field doubles it up close; the in-arm grid is finer still and lives
 * inside the gas.
 *
 * STAR_FINE_CELLS_PER_UNIT is also the measure the shader's cell fade is stated
 * in, for the in-arm grid as well as the fine one — see the guard in
 * updateStarVisibility.
 */
const STAR_COARSE_CELLS_PER_UNIT = 16;
const STAR_FINE_CELLS_PER_UNIT = 32;
const STAR_ARM_CELLS_PER_UNIT = 40;
const STAR_COARSE_DENSITY = 0.07;
const STAR_FINE_DENSITY = 0.05;
const STAR_ARM_DENSITY = 0.35;

/**
 * PRNG seeds, one per grid. Their VALUES mean nothing; that they are constants
 * is the whole point — the field has to be the same field on every start.
 */
const STAR_COARSE_SEED = 1;
const STAR_FINE_SEED = 2;
const STAR_ARM_SEED = 3;

/**
 * Greatest horizontal distance from the locked hub to the orbit target, world
 * units. The hub sits under the map's centre and the target stays on the map,
 * so the target's farthest reach is a corner of the largest supported world —
 * 512 world units on a side (DEFAULT_WORLD_SPAN, which CAMERA_FAR's own note
 * names as the largest).
 */
const STAR_TARGET_OFFSET_WORLD = (DEFAULT_WORLD_SPAN / 2) * Math.SQRT2;

/**
 * Greatest height of the orbit target above the locked hub, world units: the
 * world's whole relief, floor to peak, plus the clearance the hub sits under
 * the floor by.
 */
const STAR_TARGET_HEIGHT_WORLD =
  (MAX_HEIGHT - MIN_HEIGHT) * HEIGHT_WORLD_SCALE + LOCKED_HUB_CLEARANCE_WORLD;

/**
 * Radius of the COARSE field's disc, disk units: everything the depth fade can
 * ever reveal, from any pose the camera can reach. Beyond it the fade is zero
 * by construction, so the disc's edge can never be seen.
 *
 * The eye is at most CAMERA_MAX_DISTANCE from a target on the map, at some
 * polar angle p. Its foot is then STAR_TARGET_OFFSET_WORLD + d*sin(p) from the
 * hub and its height at most STAR_TARGET_HEIGHT_WORLD + d*cos(p), so the
 * farthest unfaded ground is
 *   offset + d*sin(p) + FADE_GROUND_REACH*(height + d*cos(p))
 * and the maximum over p of sin(p) + FADE_GROUND_REACH*cos(p) is
 * sqrt(1 + FADE_GROUND_REACH^2) = FADE_END_HEIGHTS. THE TWO EXTREMES ARE NOT
 * TAKEN TOGETHER: a far eye is either high or displaced, never both, and
 * summing them separately would cost a tenth of the whole point budget for
 * stars no pose can reach. The maximum sits at p ~ 6.2 degrees, well inside
 * CAMERA_MAX_POLAR_ANGLE_DEGREES, so the orbit's polar cap does not bind.
 *
 * 53.3 disk units, ~479 k stars.
 */
const STAR_COARSE_RADIUS =
  (STAR_TARGET_OFFSET_WORLD +
    FADE_GROUND_REACH * STAR_TARGET_HEIGHT_WORLD +
    FADE_END_HEIGHTS * CAMERA_MAX_DISTANCE) /
  LOCKED_WORLD_UNITS_PER_DISK_UNIT;

/**
 * The drawing-buffer height the fine field's extent is sized for. Its bound is
 * RESOLUTION-dependent — more pixels put more of them across a cell, so the
 * cell fade holds off to a greater distance — and it has to be a constant, so
 * it is stated for 4K.
 *
 * RESIDUAL, deliberate: above this height the fine and in-arm grids END before
 * they fade, so a display taller than 2160 device pixels could in principle
 * show the edge of the fine field at the far side of a fully zoomed-out world
 * anchor. Sizing for 8K instead would double both grids' point counts for a
 * case the owner's machine cannot produce.
 */
const STAR_FINE_MAX_RES_Y = 2160;

/**
 * How long a ray to the plane can be and still have the fine grids' cell fade
 * above zero, disk units: the fade is zero once a cell falls under
 * CELL_FADE_PX, i.e. once sdist > focal*resY/(cells*CELL_FADE_PX). The focal
 * length is the LARGER of the two anchors' — the view anchor's VIEW_FOCAL 1.2
 * against the world anchor's 0.5/tan(CAMERA_FOV_DEGREES/2), about 0.96 — since
 * a longer focal puts more pixels across a cell.
 */
const STAR_FINE_SDIST_MAX =
  (Math.max(VIEW_FOCAL, 0.5 / Math.tan((CAMERA_FOV_DEGREES * Math.PI) / 360)) *
    STAR_FINE_MAX_RES_Y) /
  (STAR_FINE_CELLS_PER_UNIT * CELL_FADE_PX);

/**
 * The polar angle, as its cosine, where the fine grids' two bounds cross: the
 * cell fade caps their reach at STAR_FINE_SDIST_MAX, the depth fade caps it at
 * FADE_END_HEIGHTS eye heights, and the eye's height falls with the polar angle
 * while its foot's offset rises. Below this angle the cell bound is the tighter
 * one and the disc need not grow; above it the depth fade closes in faster than
 * the offset opens out. So the disc's radius is the sum evaluated exactly here.
 */
const STAR_FINE_CROSS_COS =
  ((STAR_FINE_SDIST_MAX * LOCKED_WORLD_UNITS_PER_DISK_UNIT) / FADE_END_HEIGHTS -
    STAR_TARGET_HEIGHT_WORLD) /
  CAMERA_MAX_DISTANCE;

/**
 * Radius of the FINE field's disc, disk units: the eye's foot at the crossing
 * angle above, plus the cell fade's own reach. 27.3 disk units, ~360 k stars.
 * The in-arm grid shares the same cell fade but is bounded by the gas instead
 * (STAR_ARM_RADIUS), which is far tighter.
 */
const STAR_FINE_RADIUS =
  (STAR_TARGET_OFFSET_WORLD +
    CAMERA_MAX_DISTANCE * Math.sqrt(1 - STAR_FINE_CROSS_COS * STAR_FINE_CROSS_COS)) /
    LOCKED_WORLD_UNITS_PER_DISK_UNIT +
  STAR_FINE_SDIST_MAX;

/**
 * How faint an in-arm star has to get before it is not worth a vertex, as a
 * fraction of its own brightness. Two percent is under a single 8-bit step of
 * the faintest star the field draws, so nothing that crosses this threshold
 * could have shown on screen.
 */
const STAR_ARM_CUTOFF = 0.02;

/**
 * Radius of the IN-ARM grid's disc, disk units. These stars are bounded by the
 * gas, not by the fade: they are drawn `*gas*ARM_GRID_GAIN`, and the gas falls
 * as exp(-r/GAS_DISK_RADIUS), so this is the radius at which that factor drops
 * under STAR_ARM_CUTOFF. 8.2 disk units, ~356 k stars.
 */
const STAR_ARM_RADIUS = GAS_DISK_RADIUS * Math.log(ARM_GRID_GAIN / STAR_ARM_CUTOFF);

/**
 * Whether the in-arm grid is drawn at all. FALSE, because it has never been
 * drawn and the owner has therefore never seen it.
 *
 * The finding (2026-09-05, reviewing the point cloud against the walk it
 * replaces): `stars3` was called for this grid with depth = DISK_THICKNESS at
 * STAR_ARM_CELLS_PER_UNIT cells per unit, so its floor was
 * zBot = -DISK_THICKNESS*40 = -0.94 CELLS, while the walk starts one whole voxel
 * under the plane at cell.z = floor(-0.001) = -1. Its `if(cell.z<zBot) break;`
 * fired on the first iteration, every ray, every frame, from rev 13 through
 * rev 20. The approved look has no in-arm stars in it.
 *
 * The point cloud does not have that bug and would draw them — about 356 k more
 * stars threaded through the arms, which is a look change, not a perf change.
 * So it stays off: the grid is neither generated nor given a Points object, and
 * the shader's grid-2 branch is kept exactly as written because it is the
 * intended design. Flip this to true to see it; the owner decides on #342.
 */
const STAR_ARM_GRID_ENABLED = false;

/**
 * The grids, in the order the shader's `u_starGrid` numbers them: 0 the coarse
 * field, 1 the fine field, and 2 the in-arm stars when STAR_ARM_GRID_ENABLED
 * lets them exist. ~839 k points as shipped, ~1.19 M with the in-arm grid on —
 * inside the 1.2 M budget this arc set either way.
 */
const STAR_GRIDS: readonly StarGridSpec[] = [
  {
    seed: STAR_COARSE_SEED,
    radius: STAR_COARSE_RADIUS,
    depth: STAR_FIELD_DEPTH,
    scale: STAR_COARSE_CELLS_PER_UNIT,
    density: STAR_COARSE_DENSITY,
  },
  {
    seed: STAR_FINE_SEED,
    radius: STAR_FINE_RADIUS,
    depth: STAR_FINE_DEPTH,
    scale: STAR_FINE_CELLS_PER_UNIT,
    density: STAR_FINE_DENSITY,
  },
  ...(STAR_ARM_GRID_ENABLED
    ? [
        {
          seed: STAR_ARM_SEED,
          radius: STAR_ARM_RADIUS,
          depth: DISK_THICKNESS,
          scale: STAR_ARM_CELLS_PER_UNIT,
          density: STAR_ARM_DENSITY,
        },
      ]
    : []),
];

/**
 * Draw order for the void. Three sorts opaque objects by `renderOrder` before
 * anything else, so any value below every other object in the scene puts the
 * void first; combined with `depthWrite: false` it leaves the depth buffer
 * untouched for the world drawn over it. Nothing else in client/src sets a
 * negative render order, so -1 would do — a wide margin is used so a future
 * "behind everything" layer can still be ordered against it.
 */
const VOID_RENDER_ORDER = -1000;

/**
 * Draw order for the star points: immediately after the wheel and before
 * everything else. They are additive with no depth test, so the wheel must
 * already be in the buffer when they draw — and they must still be behind the
 * terrain, which is what keeps them `transparent: false` (three sorts opaque
 * objects by renderOrder first and draws that whole list before anything
 * transparent; see WebGLRenderLists.push and painterSortStable).
 */
const STARS_RENDER_ORDER = VOID_RENDER_ORDER + 1;

/**
 * How many full-res pixels across one texel of the half-resolution gas target
 * (perf, issue #341). The owner's rule for this pass is "half-res is fine,
 * quarter-res is not": 2 keeps the dust lanes' edges within a pixel of where
 * the full-res march put them, 4 shows them as blocks.
 *
 * The gas field is smooth everywhere below the horizon by construction — the
 * fade, the bulge and the gain are applied at full res — so 2 costs nothing in
 * sharpness and takes the march to a quarter of the fragments.
 */
const GAS_RES_DIVISOR = 2;

/**
 * Clip-space vertices of a single triangle that covers the viewport. Larger
 * than the screen on purpose: one triangle clipped to the frame rasterises
 * the same pixels as two triangles forming a quad, with no diagonal seam and
 * one fewer vertex invocation.
 */
const FULLSCREEN_TRIANGLE_POSITIONS = [-1, -1, 0, 3, -1, 0, -1, 3, 0];

// ---------------------------------------------------------------------------
// GLSL — ported from the approved reference, verbatim except for the
// vertex/uniform plumbing three needs and the named constants noted above.
// ---------------------------------------------------------------------------

/**
 * Writes clip space straight through, ignoring the model-view and projection
 * matrices — this is what makes the pass camera-anchored with no per-frame
 * transform work. `position.z` is dropped in favour of a constant so the
 * triangle has a defined depth even though `depthTest` is off.
 */
const VERTEX_SHADER = /* glsl */ `
void main() {
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

/** hash / value noise / fbm / star field — shared by both looks. */
const COMMON_GLSL = /* glsl */ `
precision highp float;
uniform vec2 u_res;
uniform float u_time;
// The anchor frame (see the header): focal length in screen heights, the
// rotation taking a view-space direction into disk space, and the eye's
// position in disk space (disk units, z up, plane at z = 0).
uniform float u_focal;
uniform mat3 u_toDisk;
uniform vec3 u_origin;
// 1.0 in the world anchor, 0.0 in the view anchor: whether a look that has no
// plane to intersect (the nebula's clouds, the wheel's sky above its horizon)
// maps the ray onto a dome around the world instead of the view's image plane.
uniform float u_dome;
vec3 viewRay(vec2 uv){ return u_toDisk*normalize(vec3(uv,-u_focal)); }
// Lambert azimuthal equal-area projection of a direction, from the nadir: a
// smooth 2-D domain over every direction but straight up (|p| = 2 there), with
// no seam and no stretch at the horizon (|p| = sqrt 2). Near the nadir it is
// d.xy to first order, so it matches the plane mapping where the two meet. The
// zenith is the one singular point, and the orbit's polar cap
// (CAMERA_MAX_POLAR_ANGLE_DEGREES) keeps it off screen.
vec2 dome(vec3 d){ return d.xy*sqrt(2.0/(1.0-d.z)); }

float hash(vec2 p){ p = fract(p*vec2(123.34,456.21)); p += dot(p,p+45.32); return fract(p.x*p.y); }
float vnoise(vec2 p){ vec2 i=floor(p), f=fract(p); f=f*f*(3.0-2.0*f);
  return mix(mix(hash(i),hash(i+vec2(1,0)),f.x), mix(hash(i+vec2(0,1)),hash(i+vec2(1,1)),f.x), f.y); }
float hash3(vec3 p){ p=fract(p*vec3(123.34,456.21,789.13)); p+=dot(p,p.yzx+45.32); return fract(p.x*p.y*p.z); }
float vnoise3(vec3 p){ vec3 i=floor(p), f=fract(p); f=f*f*(3.0-2.0*f);
  return mix(mix(mix(hash3(i),hash3(i+vec3(1,0,0)),f.x), mix(hash3(i+vec3(0,1,0)),hash3(i+vec3(1,1,0)),f.x), f.y),
             mix(mix(hash3(i+vec3(0,0,1)),hash3(i+vec3(1,0,1)),f.x), mix(hash3(i+vec3(0,1,1)),hash3(i+vec3(1,1,1)),f.x), f.y), f.z); }
float fbm(vec2 p){ float a=0.5, s=0.0; for(int i=0;i<5;i++){ s+=a*vnoise(p); p=p*2.03+vec2(17.3,9.1); a*=0.5; } return s; }
// The same fbm cut to FBM_LOW_OCTAVES, for fields read only on the broad scale (their fine octaves
// were below a filament wide and invisible); the same first octaves, so the look is unchanged.
const int FBM_LOW_OCTAVES=3;
float fbmLow(vec2 p){ float a=0.5, s=0.0; for(int i=0;i<FBM_LOW_OCTAVES;i++){ s+=a*vnoise(p); p=p*2.03+vec2(17.3,9.1); a*=0.5; } return s; }
// The same noise, periodic in y with period per cells: the lattice row wraps, so a domain
// whose y is an angle has no seam. Lacunarity exactly 2 and no y offset keep every octave periodic.
float pvnoise(vec2 p, float per){ vec2 i=floor(p), f=fract(p); f=f*f*(3.0-2.0*f);
  float y0=mod(i.y,per), y1=mod(i.y+1.0,per);
  return mix(mix(hash(vec2(i.x,y0)),hash(vec2(i.x+1.0,y0)),f.x), mix(hash(vec2(i.x,y1)),hash(vec2(i.x+1.0,y1)),f.x), f.y); }
float pfbm(vec2 p, float per){ float a=0.5, s=0.0; for(int i=0;i<5;i++){ s+=a*pvnoise(p,per); p=p*2.0+vec2(17.3,0.0); per*=2.0; a*=0.5; } return s; }
// Star layer: one candidate per grid cell, soft falloff, steady (stars do not twinkle here).
float stars(vec2 p, float density, float t){
  vec2 i=floor(p), f=fract(p)-0.5; float h=hash(i);
  if(h>density) return 0.0;
  vec2 o=vec2(hash(i+3.1),hash(i+7.7))-0.5; float d=length(f-o*0.8);
  float size = 0.03 + 0.05*hash(i+9.2);
  return smoothstep(size,0.0,d)*(0.5+0.5*h/density);
}
`;

const NEBULA_GLSL = /* glsl */ `${COMMON_GLSL}
const float NEBULA_RATE = 0.15;   // drift clock scale; owner set 3x the original 0.05
const float NEBULA_ZOOM = ${NEBULA_ZOOM.toFixed(1)}; // reference: p = uv*2.2
// World anchor only: how much of the eye's offset from the hub (disk units)
// slides the clouds. A quarter: panning across the whole default map (±1.28
// disk units) moves them by about a third of a screen, which reads as far
// away but still attached to the world.
const float NEBULA_PARALLAX = 0.25;
void main(){
  vec2 suv=(gl_FragCoord.xy-0.5*u_res)/u_res.y;
  vec3 d=viewRay(suv);
  float t=u_time*NEBULA_RATE;
  vec2 p;
  if(u_dome>0.5){
    // World anchor: clouds on a dome around the world, so orbiting turns them
    // with the terrain and no camera angle can see them stretch; panning
    // slides them a little (NEBULA_PARALLAX).
    p=NEBULA_ZOOM*dome(d)+u_origin.xy*NEBULA_PARALLAX;
  } else {
    // View anchor: the cloud plane is z = 0 in disk space with the eye
    // u_origin.z = NEBULA_ZOOM*focal above it and u_toDisk the identity, which
    // makes p exactly the reference's uv*NEBULA_ZOOM.
    p=u_origin.xy+d.xy*(u_origin.z/-d.z);
  }
  vec2 uv=p/NEBULA_ZOOM;             // the reference's screen coordinate, for the star layers
  vec2 q=vec2(fbm(p+t*0.3), fbm(p+vec2(5.2,1.3)-t*0.2));
  vec2 r=vec2(fbm(p+3.0*q+vec2(1.7,9.2)+t*0.15), fbm(p+3.0*q+vec2(8.3,2.8)-t*0.1));
  float n=fbm(p+2.5*r);
  vec3 deep=vec3(0.05,0.05,0.14), violet=vec3(0.26,0.14,0.42), ember=vec3(0.82,0.45,0.28), pale=vec3(0.55,0.62,0.85);
  vec3 col=mix(deep,violet,smoothstep(0.25,0.6,n));
  col=mix(col,ember,smoothstep(0.55,0.85,n)*0.55*(0.4+0.6*length(q)));
  col=mix(col,pale,smoothstep(0.7,0.95,n)*0.35);
  float s=stars(uv*90.0,0.06,u_time)+0.6*stars(uv*180.0+31.0,0.04,u_time*1.3);
  col+=vec3(0.9,0.9,1.0)*s;
  gl_FragColor=vec4(col,1.0);
}
`;

const WHEEL_FIELDS_GLSL = /* glsl */ `${COMMON_GLSL}
vec2 rot(vec2 p,float a){ float c=cos(a),s=sin(a); return vec2(c*p.x-s*p.y,s*p.x+c*p.y); }
// Disk stars: steady points in the disk plane with a screen-space size floor so far stars
// never shrink below a pixel and shimmer. minSize is in cell units, from the ray length.
float dstars(vec2 p, float density, float minSize){
  vec2 i=floor(p), f=fract(p)-0.5; float h=hash(i);
  if(h>density) return 0.0;
  vec2 o=vec2(hash(i+3.1),hash(i+7.7))-0.5; float d=length(f-o*0.8);
  float size = max(0.03 + 0.05*hash(i+9.2), minSize);
  return smoothstep(size,0.0,d)*(0.5+0.5*h/density);
}
const float WHEEL_RATE   = -0.021; // rad/s (2*pi/300 = ~5.0 min per turn); rev 7 owner 2026-09-04: 'about five minutes per turn'; negative = clockwise from above
// Depth fade, as multiples of the eye's height above the plane so it is the
// same at every zoom in the world anchor: the reference faded between ray
// lengths DISK_DIST (2.6) and FAR_FADE (12.0) with the eye 2.6*cos(60deg) = 1.3
// above the plane, i.e. between 2.0 and ~9.23 heights. The end is a TS constant
// as well: the star field's extents are derived from it.
const float FADE_START_HEIGHTS = 2.0;
const float FADE_END_HEIGHTS   = ${FADE_END_HEIGHTS.toFixed(6)};
const float ARMS         = 4.0;    // four gas arms; owner 2026-09-04: 'more than two'
const float WIND         = 8.0;    // how tightly the arms wind (log-spiral pitch); rev 6: 3.2 -> 6.0 'more circular', rev 7: 8.0
const float ARM_SHARPNESS= 1.4;    // arm cross-section exponent; rev 6: 2.2 -> 1.2 'thicker arms', rev 7: 1.0, rev 14: 1.4 'more definition between the arms'
const float GAS_GAIN     = 1.0;    // brightness of the gas arms; rev 6: 1.5 -> 1.2 'a little darker', rev 7: 1.0
const float BULGE_GAIN   = 0.25;   // warm hub glow; rev 6: 0.55 -> 0.25 and the white core removed, 'get rid of the bright center'
const float ARM_WOBBLE   = 0.25;   // rad of low-frequency phase wander; rev 9: 2.0 'too rigid', rev 10 owner 2026-09-04: 'not random squiggly lines' - arms follow the spiral again
const float ARM_BLEED    = 0.18;   // floor under the arm profile so gas spills across the gaps; rev 10: 0.35 'bleed into each other', rev 14: 0.18 'too homogeneous'
const float WOBBLE_SCALE = 0.6;    // disk units per wobble feature: the arms bend on a scale near the disk radius
const float STREAK_ALONG = 1.6;    // grain cells per e-fold of radius ALONG an arm (long filaments)
const float STREAK_ACROSS= 40.0;   // grain cells around the full circle ACROSS the arms (fine filaments); integer, the y period
const float HUE_SCALE    = 0.7;    // disk units per hue-drift feature between the deep blue and the violet
const float DISK_RADIUS  = ${GAS_DISK_RADIUS.toFixed(1)};    // e-folding radius of the gas disk, plane units; TS: the in-arm stars' extent is derived from it
// Rev 13 (owner 2026-09-05: 'the gas should look diffuse in three dimensions, and the stars should be
// placed in three dimensions', and 'don't make the disk any thicker than four world units'). The
// gas is a volume under the plane, ray-marched: the arm pattern runs through it as columns
// (gasPattern, once per ray), a vertical profile makes it diffuse about each patch's own level,
// and 3-D puff noise breaks it up through the thickness (gasDepthProfile, per sample). The stars are
// points in three 3-D grids: the in-arm stars inside the gas, the field and fine grids on down to
// STAR_FIELD_DEPTH under it, each dimmed by the gas in front of it. They used to be found by walking
// those grids per fragment; since issue #342 they are a point cloud drawn after this program (see
// STARS_VERT_GLSL and the header), and the numbers below that describe them are its numbers too. The
// in-arm grid is the exception: its walk broke before its first voxel, so it has never drawn, and
// STAR_ARM_GRID_ENABLED keeps it off until the owner has seen it.
// Nothing is above the plane, so the clearance to the map is unchanged.
const float DISK_THICKNESS= ${DISK_THICKNESS.toFixed(3)}; // DISK_THICKNESS_WORLD in disk units; gas and stars both stay within it
const int   GAS_STEPS    = 6;      // march samples through the thickness; rev 16 bench: 10 -> 6 saves ~0.5 ms at 1440p, no visible banding
// Rev 14 (owner: 'needs more 3-D variability, still a flat disk'): the depth of peak density is not one
// number but a field - each patch of gas sits at its own level between GAS_TOP_Z and GAS_BOTTOM_Z, in
// a thin layer, so patches above hide and shade the patches below.
const float GAS_TOP_Z    = -0.12*DISK_THICKNESS;  // shallowest layer centre
const float GAS_BOTTOM_Z = -0.88*DISK_THICKNESS;  // deepest layer centre
const float GAS_SCALE_H  = 0.12*DISK_THICKNESS;   // sech^2 scale height of each patch about its own level
const float LEVEL_SCALE  = 5.0;    // level-field features per disk unit: patches change level on about the filament scale
const float LIT_FROM_ABOVE=0.6;    // gas at the bottom of the slab is this much darker than at the top (a depth cue the eye reads)
const float GAS_EXTINCTION=100.0;  // optical depth per unit density per disk unit; 160 read like the rev 10 sheet; rev 17 'colors a little more transparent, maybe 20%' 128; rev 18 owner 2026-09-05 'more transparent' 100
const float PUFF_SCALE   = 12.0;   // 3-D puff noise features per disk unit across the disk
const float PUFF_Z_SCALE = 3.0/DISK_THICKNESS;    // ... and about three through the thickness, so the puffs vary with depth
const float PUFF_DEPTH   = 0.7;    // how much the puffs modulate the density (0 = columnar gas); rev 14: 0.35 -> 0.7
const float PUFF_OCTAVE2 = 0.4;    // weight of the second, finer puff octave (0 drops it: one vnoise3 per march step)
// The grids' depths (STAR_FIELD_DEPTH, STAR_FINE_DEPTH) and their density boost (STAR_POINT_BOOST)
// are TS/JS constants since issue #342: nothing in GLSL reads them now that the point cloud, not the
// fragment, decides where the stars are. STAR_WALK went with the walk itself; the ~80% of the coarse
// depth it reached at 60 degrees was a bench compromise, and the cloud draws every star instead.
const float STAR_GAS_SHADE=0.7;    // how much fully overlying gas dims a star (1 = hidden)
const float STAR_MIN_PX  = 0.8;    // smallest star radius on screen, px
const float CELL_FADE_PX = ${CELL_FADE_PX.toFixed(1)};    // star cells narrower than this on screen fade out (anti-shimmer); TS too, for the per-frame guard
// Rev 17 (owner 2026-09-05: 'make some of the floating stars glow a little bit, and others twinkle just a
// little bit'). Each star draws one kind from its own hash: the first GLOW_FRACTION carry a soft halo
// GLOW_RADIUS times their core, the next TWINKLE_FRACTION breathe in brightness by TWINKLE_DEPTH at
// TWINKLE_RATE with a per-star phase, the rest are steady. u_time is frozen under reduced motion.
const float GLOW_FRACTION   = 0.15;
const float GLOW_RADIUS     = 4.0;   // halo radius as a multiple of the core radius
const float GLOW_GAIN       = 0.35;  // halo peak brightness relative to the core
const float TWINKLE_FRACTION= 0.30;
const float TWINKLE_DEPTH   = 0.35;  // brightness swing, peak to trough, as a fraction of the star
const float TWINKLE_RATE    = 2.2;   // rad/s: about one breath every three seconds
// --- the log-polar bake (perf, issue #340) --------------------------------------------------
// gasPattern and gasLevel below depend only on rf, the rotating-frame plane position, so they are
// evaluated once into two textures at startup (BAKE_GLSL) and read back per fragment. The grid is
// the arms' own coordinate: theta across u, wrapping, and s = log(r + S_LOG_EPS) up v, in which a
// log spiral is a straight line - so a texel keeps the same shape across an arm at every radius
// (its aspect is TAU/BAKE_S_SPAN, a constant) and the grain stays resolved out to the rim.
const float TAU          = 6.2831853;
const float GAS_INNER_R  = ${GAS_INNER_R.toFixed(2)};   // radius over which the gas ramps in from the hub (a ramp, not a floor)
const float S_LOG_EPS    = ${S_LOG_EPS.toFixed(2)};   // the offset in s = log(r + eps); keeps s finite at the hub
const float GAS_BAKE_SIZE= ${GAS_BAKE_SIZE.toFixed(1)}; // texels per axis; the TS constant carries the Nyquist derivation
const float BAKE_S_MIN   = ${GAS_BAKE_S_MIN.toFixed(6)};  // s at the hub: log(S_LOG_EPS)
const float BAKE_S_SPAN  = ${GAS_BAKE_S_SPAN.toFixed(6)};   // log(R_BAKE_MAX + S_LOG_EPS) - BAKE_S_MIN
// The gas pattern on the plane in the rotating frame: the arms, their grain, lanes and colour.
// It is columnar - the same at every depth of the four-unit slab, whose parallax across the
// thickness is under a filament wide - so it is baked ONCE into the log-polar texture above and
// read back per fragment, and the march below only
// varies the vertical profile and the 3-D puffs (rev 16: 6.1 ms -> see the bench in .void-bench).
// ARMS log-spiral arms. The arm's own coordinates: s = log r runs ALONG an arm (a log spiral is a
// straight line in log-polar space) and thw, the angle in the frame wound so every arm is radial,
// runs ACROSS it - an arm sits at a fixed thw. The grain is sampled in (s, thw) with long cells
// along and short cells across, so the filaments run along the curve of each arm.
float gasPattern(vec2 rf, out vec3 gasCol){
  float r=length(rf);
  float th=atan(rf.y,rf.x);
  float s=log(r+S_LOG_EPS);
  float wobble=(fbmLow(rf/WOBBLE_SCALE+vec2(3.0,8.0))-0.5)*2.0*ARM_WOBBLE;
  float phase=th*ARMS-s*WIND+wobble;
  float arm=mix(pow(0.5+0.5*cos(phase),ARM_SHARPNESS),1.0,ARM_BLEED);
  // Unwind by MINUS the arm's own twist so the wound angle is phase/ARMS - constant along an arm.
  vec2 wound=rot(rf,-(s*WIND-wobble)/ARMS);
  float thw=atan(wound.y,wound.x);
  vec2 aq=vec2(s*STREAK_ALONG, (thw/TAU+0.5)*STREAK_ACROSS);
  float grain=0.6*pfbm(aq+vec2(4.0,0.0),STREAK_ACROSS)+0.4*pfbm(aq*2.0+vec2(1.0,0.0),STREAK_ACROSS*2.0);
  float haze=fbmLow(rf*1.4+vec2(9.0,2.0));
  float radial=exp(-r/DISK_RADIUS)*smoothstep(0.0,GAS_INNER_R,r);
  float lanes=smoothstep(0.6,0.78,grain)*arm*0.45;         // dark dust lanes cut through the arms
  // Rev 9 palette: deeper and more saturated - a deep blue drifting into violet across the disk,
  // rose where the grain is dense, a touch of teal in the haze; the warm bulge keeps its colour.
  vec3 deepBlue=vec3(0.08,0.24,0.88), violet=vec3(0.40,0.14,0.82), rose=vec3(0.95,0.30,0.60), teal=vec3(0.12,0.70,0.85);
  float hue=fbmLow(rf/HUE_SCALE+vec2(2.0,5.0));
  gasCol=mix(deepBlue,violet,smoothstep(0.35,0.7,hue));
  gasCol=mix(gasCol,rose,smoothstep(0.55,0.9,grain)*0.7);
  gasCol=mix(gasCol,teal,smoothstep(0.6,0.85,haze)*0.35);
  return (arm*(0.35+1.1*grain)+0.10*haze)*radial*(1.0-lanes);
}
// This patch's depth in the slab: the level field of rev 14, baked alongside the pattern.
float gasLevel(vec2 rf){ return mix(GAS_TOP_Z,GAS_BOTTOM_Z,fbmLow(rf*LEVEL_SCALE+vec2(6.0,13.0))); }
// rf -> bake texture coordinate. u wraps with theta (RepeatWrapping, so the two sides of atan's
// branch cut still filter into each other); v spans the hub to R_BAKE_MAX and clamps beyond it,
// where the gas is under 1e-3 of its peak.
vec2 gasBakeUv(vec2 rf){
  return vec2(atan(rf.y,rf.x)/TAU+0.5, (log(length(rf)+S_LOG_EPS)-BAKE_S_MIN)/BAKE_S_SPAN);
}
// ...and back: the rf that a bake texel centre stands for. Exactly the inverse of gasBakeUv, so a
// lookup lands on the texel that was written for it.
vec2 gasBakeRf(vec2 uv){
  float th=(uv.x-0.5)*TAU;
  return vec2(cos(th),sin(th))*(exp(BAKE_S_MIN+uv.y*BAKE_S_SPAN)-S_LOG_EPS);
}
// Reads the bake through whichever branch of atan has its cut a quarter turn away. RepeatWrapping
// gets the VALUE right across the cut, but u jumps by 1 there, and the quad that straddles the
// jump derives a huge du/dx and drops to the coarsest mip - a blurred radial line along -x, plain
// to see in the hub shot. u+1 reaches the same texel through the branch that is continuous there,
// so its cut lies along +x instead; each fragment takes the branch whose cut it is far from.
// The two branches sample the same texel wherever both are valid, so the switch itself is unseen.
vec4 gasBakeFetch(sampler2D tex, vec2 uv){
  vec4 nearCut=texture2D(tex,vec2(uv.x+1.0-step(0.5,uv.x),uv.y));
  return mix(texture2D(tex,uv),nearCut,step(0.25,abs(uv.x-0.5)));
}
`;

/**
 * The bake pass: writes gasPattern and gasLevel over the log-polar grid. It is drawn twice at
 * startup, once per field — WebGL2 gives one colour attachment per draw and this deliberately
 * uses no MRT — into the two render targets the wheel then samples. It is built from the same
 * WHEEL_FIELDS_GLSL as the wheel, so the arm pattern has exactly one source and the two cannot
 * drift apart.
 */
const BAKE_GLSL = /* glsl */ `${WHEEL_FIELDS_GLSL}
uniform float u_bakeField;   // 0: colour and pattern; 1: level
void main(){
  vec2 rf=gasBakeRf(gl_FragCoord.xy/GAS_BAKE_SIZE);
  if(u_bakeField>0.5){ gl_FragColor=vec4(gasLevel(rf),0.0,0.0,1.0); return; }
  vec3 gasCol;
  float pattern=gasPattern(rf,gasCol);
  gl_FragColor=vec4(gasCol,pattern);
}
`;

/**
 * THE GAS MARCH AT HALF RESOLUTION (perf, issue #341). Every fragment of this pass stands for one
 * full-res pixel — the centre of the GAS_RES_DIVISOR-square block it covers — and does exactly
 * what the wheel's march used to do inline: the two bake fetches, GAS_STEPS samples of
 * `pattern*gasDepthProfile`, and the transmittance loop. It writes what the wheel cannot cheaply
 * recompute: `rgb = gasCol*gasAcc` (the lit gas colour) and `a = gas` (= 1 - T, the opacity the
 * stars are dimmed by).
 *
 * What it deliberately does NOT apply: GAS_GAIN, the depth fade, the bulge and the fade early-out.
 * Those are analytic and cost a few instructions at full res, and leaving them out is what keeps
 * this field smooth everywhere below the horizon — there is no fade edge and no early-out cliff in
 * it for the bilinear upsample to blur across, and the fade's own edge stays pixel-crisp because
 * the full-res pass still evaluates it per pixel. Above the horizon (d.z >= 0) it writes zeros;
 * the wheel never reads the target there.
 */
const GAS_GLSL = /* glsl */ `${WHEEL_FIELDS_GLSL}
// The baked fields: gasPattern's colour in rgb and its pattern in a, gasLevel in the second
// texture's r. Half float, so the pattern's ~1.55 peak needs no scaling on the way through.
uniform sampler2D u_gasBake;
uniform sampler2D u_gasLevel;
// This pass's own resolution in texels; u_res stays the FULL-res drawing buffer in both programs.
uniform vec2 u_gasRes;
// Declared for the bench harness, which lifts it to size its own target (.void-bench/gl2.js); the
// app sizes the render target from the TS constant of the same name. The pass itself needs only
// the two resolutions, because ceil() rounding makes the ratio not exactly the divisor.
const float GAS_RES_DIVISOR = ${GAS_RES_DIVISOR.toFixed(1)};
// The gas's variation through the thickness at a point: a sech^2 layer about this patch's own level,
// broken up by 3-D puffs. Multiplies gasPattern.
float gasDepthProfile(vec2 rf, float z, float level){
  float dz=(z-level)/GAS_SCALE_H;
  float ch=exp(dz)+exp(-dz);
  float vert=4.0/(ch*ch);                                    // sech^2 (no cosh in GLSL ES 1.00): diffuse both ways about the level
  vec3 pq=vec3(rf*PUFF_SCALE,z*PUFF_Z_SCALE);
  float puff=(1.0-PUFF_OCTAVE2)*vnoise3(pq)+PUFF_OCTAVE2*vnoise3(pq*2.1+vec3(3.0,1.0,7.0));
  float puffMod=1.0-PUFF_DEPTH+2.0*PUFF_DEPTH*puff;          // mean 1
  return vert*puffMod;
}
void main(){
  // The full-res pixel this texel stands for. Scaling the texel centre by the exact ratio of the
  // two buffers — not by GAS_RES_DIVISOR — is what keeps the two passes on the same uv when the
  // drawing buffer has an odd dimension and the target was rounded up. The wheel reads back at
  // gl_FragCoord.xy/u_res, which is this mapping inverted exactly.
  vec2 full=gl_FragCoord.xy*(u_res/u_gasRes);
  vec2 uv=(full-0.5*u_res)/u_res.y;
  float a=u_time*WHEEL_RATE;
  vec3 d=viewRay(uv);                    // disk space: plane z = 0, hub at the origin
  if(d.z>=0.0){ gl_FragColor=vec4(0.0); return; }   // above the plane's horizon: no gas to march
  float sdist=-u_origin.z/d.z;           // ray length to the plane
  vec2 pp=u_origin.xy+d.xy*sdist;        // disk coordinates, hub at the origin
  vec2 rf=rot(pp,-a);                    // rotating frame: everything sampled here turns rigidly

  // --- gas: the plane pattern once, then march the thickness front to back ---
  vec2 bakeUv=gasBakeUv(rf);
  vec4 baked=gasBakeFetch(u_gasBake,bakeUv);
  vec3 gasCol=baked.rgb;
  float pattern=baked.a;
  float level=gasBakeFetch(u_gasLevel,bakeUv).r;                                  // this patch's depth
  float tBottom=(u_origin.z+DISK_THICKNESS)/-d.z;
  float dt=(tBottom-sdist)/float(GAS_STEPS);
  float gasAcc=0.0;                     // lit weight so far
  float T=1.0;                          // transmittance so far
  for(int i=0;i<GAS_STEPS;i++){
    float t=sdist+(float(i)+0.5)*dt;
    vec3 q=u_origin+d*t;
    float dens=pattern*gasDepthProfile(rot(q.xy,-a),q.z,level);
    float lit=1.0-LIT_FROM_ABOVE*clamp(-q.z/DISK_THICKNESS,0.0,1.0);   // deeper gas is darker
    float alpha=1.0-exp(-dens*GAS_EXTINCTION*dt);
    gasAcc+=T*alpha*lit;
    T*=1.0-alpha;
  }
  gl_FragColor=vec4(gasCol*gasAcc,1.0-T);   // lit colour before GAS_GAIN; alpha = total gas opacity
}
`;

const WHEEL_GLSL = /* glsl */ `${WHEEL_FIELDS_GLSL}
// The half-res gas pass's output (issue #341): rgb = gasCol*gasAcc before GAS_GAIN, a = the gas
// opacity. Bilinear, so a full-res pixel between texel centres gets the interpolated field.
uniform sampler2D u_gasHalf;
void main(){
  vec2 uv=(gl_FragCoord.xy-0.5*u_res)/u_res.y;
  float a=u_time*WHEEL_RATE;
  vec3 col=vec3(0.012,0.014,0.03);

  vec3 d=viewRay(uv);                    // disk space: plane z = 0, hub at the origin
  if(d.z<0.0){
    float sdist=-u_origin.z/d.z;         // ray length to the plane
    vec2 pp=u_origin.xy+d.xy*sdist;      // disk coordinates, hub at the origin
    vec2 rf=rot(pp,-a);                  // rotating frame: everything sampled here turns rigidly
    float r=length(rf);
    float depthFade=1.0-smoothstep(FADE_START_HEIGHTS*u_origin.z,FADE_END_HEIGHTS*u_origin.z,sdist);
    if(depthFade<=0.0){ gl_FragColor=vec4(col,1.0); return; }   // fully faded: nothing below would show

    // --- gas: marched at half resolution into u_gasHalf (issue #341), read back here ---
    // The exact inverse of the gas pass's own mapping, so the texel a pixel lands on is the one
    // written for it; between centres the bilinear filter interpolates a field that is smooth
    // everywhere below the horizon, which is why the fade and the gain stay out of it.
    vec4 gasHalf=texture2D(u_gasHalf,gl_FragCoord.xy/u_res);
    vec3 gasCol=gasHalf.rgb;              // lit gas colour (gasCol*gasAcc), before GAS_GAIN
    float bulge=exp(-r*2.0);
    vec3 warm=vec3(1.0,0.88,0.62);
    col+=(gasCol*GAS_GAIN+warm*bulge*BULGE_GAIN)*depthFade;
    // The stars under the plane are no longer found here: they are a point cloud drawn straight
    // over this program's output, additively (issue #342, STARS_VERT_GLSL below). col += stars
    // was already the composite, so the arithmetic is unchanged.
  } else {
    // Above the plane's horizon (never in the view anchor at 60deg; the world anchor at a flat
    // orbit): a still, sparse field so the void is not empty, fixed to the sky direction.
    col+=vec3(0.8,0.82,0.9)*0.4*stars(dome(d)*110.0+5.0,0.03,0.0);
  }
  gl_FragColor=vec4(col,1.0);
}
`;

/**
 * THE STARS' VERTEX PROGRAM (perf, issue #342). One invocation per star, doing exactly what the
 * wheel's `stars3` used to do per fragment per voxel: project the star, fade it by depth and by
 * cell size, floor its screen radius, dim it by the gas over it, and pick its kind. Every number
 * below is the one the walk used; only where it runs has changed.
 *
 * It is built on WHEEL_FIELDS_GLSL so the star constants, `rot` and the anchor uniforms have ONE
 * definition shared with the wheel, the bake and the gas pass. The noise and the pattern come with
 * them and are dead here, which the compiler removes.
 */
const STARS_VERT_GLSL = /* glsl */ `${WHEEL_FIELDS_GLSL}
// Which grid this Points object is: 0 the coarse field, 1 the fine field, 2 the in-arm stars (which
// STAR_ARM_GRID_ENABLED keeps off - the branch below is kept because it is the intended design, not
// because anything reaches it today). It is a property of the OBJECT, not of the vertex, so it is a
// uniform and the materials differ in nothing else (see createStarPoints).
uniform float u_starGrid;
// The half-res gas pass's output (issue #341). Only its alpha is read here — the total gas opacity
// along the ray — and only once per star, at the star's own screen position. Bilinear, no mips, so
// a vertex-shader texture2D is well defined under GLSL ES 1.00.
uniform sampler2D u_gasHalf;
// The driver's ALIASED_POINT_SIZE_RANGE maximum. A sprite wider than this is clamped by the GL
// silently, and the fragment's falloff is measured across the sprite, so the clamp has to happen
// here where both the size and the varying that carries it can see it.
uniform float u_pointSizeMax;
// Per star: radius in disk units, kind on [0,1), brightness on [0.5,1) - the three draws the voxel
// hashes used to make, now generated once (render/celestialVoidStars.ts).
attribute vec3 starShape;
varying vec3 v_col;      // the star's colour, everything but the falloff already applied
varying vec3 v_shape;    // core radius in px, 1 for a glow star, and the sprite's width in px
const float STAR_GRID_FINE = 1.0;
const float STAR_GRID_ARM  = 2.0;
const float STAR_FINE_CELLS_PER_UNIT = ${STAR_FINE_CELLS_PER_UNIT.toFixed(1)};  // the cell fade's own measure, for the in-arm grid as well as the fine one
const float FINE_GRID_WEIGHT = 0.6;   // the fine field's stars are drawn dimmer than the coarse field's
const float FIELD_GAS_LIFT   = 0.45;  // a field star keeps this much of itself with no gas in front of it...
const float FIELD_GAS_GAIN   = 0.9;   // ...and gains this much where the gas is thickest
const float ARM_GRID_GAIN    = ${ARM_GRID_GAIN.toFixed(1)};   // in-arm stars are revealed BY the gas: bright only where it is
const float POINT_SPRITE_MARGIN_PX = 2.0;  // so the smoothstep's tail is not clipped by the sprite's edge
// Clip space well outside the frustum, for a star that must not rasterise at all.
const vec4 OFF_SCREEN = vec4(2.0,2.0,2.0,1.0);
void main(){
  // The rotating frame back into disk space: the wheel samples at rot(pp,-a), so this is that
  // inverted, and the field turns rigidly with the gas exactly as before.
  float a=u_time*WHEEL_RATE;
  vec3 P=vec3(rot(position.xy,a),position.z);
  vec3 rel=P-u_origin;
  // Disk space back into view space. u_toDisk is a rotation, so its inverse is its transpose, and
  // rel*u_toDisk is that product (a row vector times the matrix). viewRay is the same map the
  // other way: u_toDisk*normalize(vec3(uv,-u_focal)).
  vec3 v=rel*u_toDisk;
  if(v.z>=0.0){ gl_Position=OFF_SCREEN; gl_PointSize=0.0; return; }   // behind the eye
  // Screen heights, the wheel's own uv convention. Named suv, not uv: three declares an attribute
  // vec2 uv in every ShaderMaterial's vertex prefix and shadowing it here would only confuse.
  vec2 suv=-v.xy*u_focal/v.z;
  vec2 ndc=2.0*suv*u_res.y/u_res;
  float t=length(rel);                   // disk units along the ray from the eye (the walk's tBase+along/scale)
  float sdist=-u_origin.z*t/rel.z;       // ray length to the plane along THIS star's ray
  float depthFade=1.0-smoothstep(FADE_START_HEIGHTS*u_origin.z,FADE_END_HEIGHTS*u_origin.z,sdist);
  float pxPerUnit=u_focal*u_res.y/sdist;
  float cellFade=smoothstep(CELL_FADE_PX,CELL_FADE_PX*3.0,pxPerUnit/STAR_FINE_CELLS_PER_UNIT);
  float weight=u_starGrid<STAR_GRID_FINE?1.0:(u_starGrid<STAR_GRID_ARM?FINE_GRID_WEIGHT*cellFade:cellFade);
  // The walk's max(size, minPerT*t*scale) projected: a star never shrinks below STAR_MIN_PX.
  float rPx=max(starShape.x*u_focal*u_res.y/t,STAR_MIN_PX);
  float glow=starShape.y<GLOW_FRACTION?1.0:0.0;
  float size=min(2.0*rPx*mix(1.0,GLOW_RADIUS,glow)+POINT_SPRITE_MARGIN_PX,u_pointSizeMax);
  // Faded out, or off screen by more than the sprite's own half width: no fragment, and no fetch.
  // At the reference pose over nine tenths of the coarse field is off screen and the fetch is by
  // far the most expensive thing here, so the order matters.
  if(depthFade<=0.0||weight<=0.0||abs(ndc.x)>1.0+size/u_res.x||abs(ndc.y)>1.0+size/u_res.y){
    gl_Position=OFF_SCREEN; gl_PointSize=0.0; return;
  }
  float gas=texture2D(u_gasHalf,ndc*0.5+0.5).a;   // total gas opacity along the ray
  // The field grids are dimmed by the gas over them and lifted by the gas in front of them; the
  // in-arm stars are INSIDE the gas, so nothing is over them and the gas is what reveals them.
  float above=u_starGrid<STAR_GRID_ARM?gas:0.0;
  float outer=u_starGrid<STAR_GRID_ARM?FIELD_GAS_LIFT+FIELD_GAS_GAIN*gas:1.0;
  if(u_starGrid>=STAR_GRID_ARM) weight*=gas*ARM_GRID_GAIN;
  float dim=1.0-STAR_GAS_SHADE*above*clamp(-position.z/DISK_THICKNESS,0.0,1.0);
  // Rev 17's kinds, unchanged: the first GLOW_FRACTION carry a halo (the fragment adds it), the
  // next TWINKLE_FRACTION breathe, the rest are steady. u_time is frozen under reduced motion.
  float twinkle=1.0;
  if(glow<0.5&&starShape.y<GLOW_FRACTION+TWINKLE_FRACTION)
    twinkle=1.0-TWINKLE_DEPTH*(0.5+0.5*sin(u_time*TWINKLE_RATE+starShape.y*40.0));
  v_col=vec3(0.95,0.93,0.9)*starShape.z*dim*twinkle*weight*outer*depthFade*depthFade;
  v_shape=vec3(rPx,glow,size);
  gl_Position=vec4(ndc,0.0,1.0);
  gl_PointSize=size;
}
`;

/**
 * THE STARS' FRAGMENT PROGRAM. The walk's own falloff, measured across the point sprite instead of
 * against the ray in 3-D: `smoothstep(size,0,dist)` on the distance from the star's centre, plus
 * the glow kind's wider, fainter second smoothstep. Alpha is written as zero so this additive pass
 * leaves the drawing buffer's alpha channel alone.
 */
const STARS_FRAG_GLSL = /* glsl */ `${WHEEL_FIELDS_GLSL}
varying vec3 v_col;
varying vec3 v_shape;
void main(){
  float d=length((gl_PointCoord-0.5)*v_shape.z);
  float core=smoothstep(v_shape.x,0.0,d);
  if(v_shape.y>0.5) core+=GLOW_GAIN*smoothstep(v_shape.x*GLOW_RADIUS,0.0,d);
  gl_FragColor=vec4(v_col*core,0.0);
}
`;

const FRAGMENT_SHADER: Record<VoidStyle, string> = {
  nebula: NEBULA_GLSL,
  wheel: WHEEL_GLSL,
};

export interface CelestialVoid {
  /** Switches the look live — no reload, no scene rebuild. */
  setStyle(style: VoidStyle): void;
  /** Switches what the void is fixed to — see the header's TWO ANCHORS. */
  setAnchor(anchor: VoidAnchor): void;
  /** Removes the pass from the scene and frees its GPU resources. */
  dispose(): void;
}

/**
 * True when the user has asked their system for reduced motion. Read once:
 * this is an accessibility setting, not something that changes mid-session in
 * any way worth a live listener, and the reference looks are decorative — a
 * frozen frame of either is still the intended image.
 */
function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

/**
 * The disk-space frame for one anchor: everything a fragment needs to turn a
 * screen position into a ray and intersect the disk. Written into the shared
 * uniforms — once for 'view', every frame for 'world'.
 */
interface DiskFrame {
  focal: number;
  toDisk: Matrix3;
  origin: Vector3;
}

/**
 * The reference's own frame, for the 'view' anchor: view space with the disk
 * tilted WHEEL_TILT_DEGREES about x so its top edge leans away, and the eye
 * VIEW_HUB_DISTANCE along the view axis from the hub. Constant — computed
 * once per style, never touched by the camera.
 *
 * Disk-space basis in view coordinates: e1 = (1,0,0), e2 = (0,cos t,-sin t),
 * e3 = (0,sin t,cos t) (the disk normal). The eye is at +VIEW_HUB_DISTANCE
 * on the view z axis relative to the hub, so its disk coordinates are that
 * vector projected onto e1..e3.
 */
function viewAnchorFrame(style: VoidStyle): DiskFrame {
  if (style === 'nebula') {
    // Untilted: the noise plane faces the eye, NEBULA_ZOOM focal lengths away,
    // which reproduces the reference's `uv*2.2` exactly (see NEBULA_GLSL).
    return {
      focal: VIEW_FOCAL,
      toDisk: new Matrix3().identity(),
      origin: new Vector3(0, 0, NEBULA_ZOOM * VIEW_FOCAL),
    };
  }
  const tilt = (WHEEL_TILT_DEGREES * Math.PI) / 180;
  const ct = Math.cos(tilt);
  const st = Math.sin(tilt);
  // Rows are the disk basis vectors, so the matrix maps view → disk.
  // prettier-ignore
  const toDisk = new Matrix3().set(
    1, 0,   0,
    0, ct, -st,
    0, st,  ct,
  );
  return {
    focal: VIEW_FOCAL,
    toDisk,
    origin: new Vector3(0, -st * VIEW_HUB_DISTANCE, ct * VIEW_HUB_DISTANCE),
  };
}

/**
 * World → disk rotation for the 'world' anchor: disk x = world x, disk y =
 * world −z, disk z = world y (up). Right-handed (x × −z = y), so the wheel
 * turns the same way seen from above as it does in the view anchor.
 */
// prettier-ignore
const WORLD_TO_DISK = new Matrix3().set(
  1, 0,  0,
  0, 0, -1,
  0, 1,  0,
);

/**
 * Installs the void pass on `viewport`. Adds one mesh to its scene and one
 * frame callback; owns nothing else.
 *
 * @param worldSize The current world's edge in cells, read live: the locked
 *   hub sits under the map's centre, and the map's size arrives with the
 *   first snapshot and changes on a rejoin. 0 (no world yet) centres the hub
 *   on the origin, which is where a 0-cell world's centre is anyway.
 */
/**
 * Scene-child names for this file's two contributions, under the `core:`
 * prefix client/src/perfProbe.ts ablates by. A core rig that wants to be
 * measurable names itself here-style; an unnamed one is invisible to the
 * attribution and shows up only inside the unattributable remainder.
 */
const CORE_RIG_STARS_NAME = 'core:void-stars';
const CORE_RIG_VOID_NAME = 'core:void';

export function createCelestialVoid(
  viewport: Viewport,
  initialStyle: VoidStyle,
  initialAnchor: VoidAnchor,
  worldSize: () => number,
): CelestialVoid {
  const geometry = new BufferGeometry();
  geometry.setAttribute(
    'position',
    new Float32BufferAttribute(FULLSCREEN_TRIANGLE_POSITIONS, 3),
  );

  // ONE uniform object shared by both materials, so switching styles carries
  // the clock across instead of restarting the animation at zero.
  const uniforms: Record<string, IUniform> = {
    u_res: { value: new Vector2(1, 1) },
    u_time: { value: 0 },
    u_focal: { value: VIEW_FOCAL },
    u_toDisk: { value: new Matrix3() },
    u_origin: { value: new Vector3() },
    u_dome: { value: 0 },
    // Filled by the bake when the wheel material is first created; the nebula
    // program has neither sampler, and three skips uniforms a program lacks.
    // Only the gas program reads these two now — the wheel reads u_gasHalf.
    u_gasBake: { value: null },
    u_gasLevel: { value: null },
    // The half-res gas pass (issue #341): its target's size, and its texture.
    // Filled with the wheel material as well; sized in the frame callback.
    u_gasRes: { value: new Vector2(1, 1) },
    u_gasHalf: { value: null },
  };
  const writeFrame = (frame: DiskFrame): void => {
    (uniforms['u_focal'] as IUniform<number>).value = frame.focal;
    (uniforms['u_toDisk'] as IUniform<Matrix3>).value.copy(frame.toDisk);
    (uniforms['u_origin'] as IUniform<Vector3>).value.copy(frame.origin);
  };

  let style = initialStyle;
  let anchor = initialAnchor;
  // Scratch for the world anchor's per-frame frame; allocated once.
  const worldFrame: DiskFrame = {
    focal: VIEW_FOCAL,
    toDisk: new Matrix3(),
    origin: new Vector3(),
  };
  const cameraToWorld = new Matrix3();
  const hub = new Vector3();
  /**
   * The world anchor's frame from the camera as it stands NOW. Called from
   * onBeforeRender so the pose is this frame's, not last frame's (header).
   */
  const writeWorldFrame = (camera: PerspectiveCamera): void => {
    // uv is in screen heights, so the focal length for a symmetric vertical
    // field of view is half a height over tan(fov/2).
    worldFrame.focal = 0.5 / Math.tan((camera.fov * Math.PI) / 360);
    cameraToWorld.setFromMatrix4(camera.matrixWorld);
    worldFrame.toDisk.multiplyMatrices(WORLD_TO_DISK, cameraToWorld);
    const halfSpan = (worldSize() * CELL_WORLD_SIZE) / 2;
    hub.set(halfSpan, LOCKED_HUB_WORLD_Y, halfSpan);
    worldFrame.origin
      .copy(camera.position)
      .sub(hub)
      .applyMatrix3(WORLD_TO_DISK)
      .divideScalar(LOCKED_WORLD_UNITS_PER_DISK_UNIT);
    writeFrame(worldFrame);
  };
  const applyAnchor = (): void => {
    // 'world' is written per frame in onBeforeRender; 'view' is a constant
    // per style and is written here, once, when either changes.
    (uniforms['u_dome'] as IUniform<number>).value = anchor === 'world' ? 1 : 0;
    if (anchor === 'view') writeFrame(viewAnchorFrame(style));
  };
  applyAnchor();

  /**
   * One of the two log-polar targets the arm pattern is baked into (`format`
   * says which: RGBA for the colour and pattern, red for the level). Half float
   * so the pattern's ~1.55 peak and the level's ~0.02 disk units both survive
   * unscaled; u repeats because theta wraps and v clamps because the s range
   * ends where the gas does; mipmapped because the world anchor zoomed far out
   * puts many texels in a pixel, which is exactly the shimmer the procedural
   * version had.
   */
  const makeBakeTarget = (format: PixelFormat): WebGLRenderTarget =>
    new WebGLRenderTarget(GAS_BAKE_SIZE, GAS_BAKE_SIZE, {
      type: HalfFloatType,
      format,
      wrapS: RepeatWrapping,
      wrapT: ClampToEdgeWrapping,
      minFilter: LinearMipmapLinearFilter,
      magFilter: LinearFilter,
      generateMipmaps: true,
      depthBuffer: false,
      stencilBuffer: false,
    });

  /** Which field one bake draw writes; matches BAKE_GLSL's `u_bakeField`. */
  const BAKE_FIELD_PATTERN = 0;
  const BAKE_FIELD_LEVEL = 1;

  let bakeTargets: WebGLRenderTarget[] = [];
  /**
   * Renders the arm pattern into its textures. Called once, from the wheel
   * material's creation, so a player on the nebula never pays for it.
   */
  const bakeGasPattern = (): void => {
    const material = new ShaderMaterial({
      uniforms: { u_bakeField: { value: BAKE_FIELD_PATTERN } },
      vertexShader: VERTEX_SHADER,
      fragmentShader: BAKE_GLSL,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    });
    // The vertex shader writes clip space directly, so the camera is a
    // formality and the mesh must not be culled against it.
    const bakeMesh = new Mesh(geometry, material);
    bakeMesh.frustumCulled = false;
    const bakeScene = new Scene().add(bakeMesh);
    const bakeCamera = new Camera();
    const { renderer } = viewport;
    const previous = renderer.getRenderTarget();
    const previousCubeFace = renderer.getActiveCubeFace();
    const previousMipmap = renderer.getActiveMipmapLevel();
    // The pattern target needs four channels (colour and pattern), the level one only needs one:
    // at GAS_BAKE_SIZE that is 45 MB against 11 MB with the mip chains, so it is worth the split.
    bakeTargets = [makeBakeTarget(RGBAFormat), makeBakeTarget(RedFormat)];
    for (const field of [BAKE_FIELD_PATTERN, BAKE_FIELD_LEVEL]) {
      (material.uniforms['u_bakeField'] as IUniform<number>).value = field;
      // renderer.render, not a raw draw: it is what generates the target's
      // mipmaps when it restores the framebuffer.
      renderer.setRenderTarget(bakeTargets[field] as WebGLRenderTarget);
      renderer.render(bakeScene, bakeCamera);
    }
    renderer.setRenderTarget(previous, previousCubeFace, previousMipmap);
    material.dispose();
    (uniforms['u_gasBake'] as IUniform<Texture>).value = (
      bakeTargets[BAKE_FIELD_PATTERN] as WebGLRenderTarget
    ).texture;
    (uniforms['u_gasLevel'] as IUniform<Texture>).value = (
      bakeTargets[BAKE_FIELD_LEVEL] as WebGLRenderTarget
    ).texture;
  };

  /**
   * The half-res gas pass's own resources (issue #341). All four are null until
   * the wheel material is first created, exactly like the bake, so a player on
   * the nebula never allocates the target or compiles the program.
   */
  let gasTarget: WebGLRenderTarget | null = null;
  let gasMaterial: ShaderMaterial | null = null;
  let gasScene: Scene | null = null;
  let gasCamera: Camera | null = null;
  /** Scratch for the drawing-buffer size, read every frame; allocated once. */
  const drawingBuffer = new Vector2();

  /**
   * Sizes the gas target to the drawing buffer over GAS_RES_DIVISOR, rounding
   * UP so the target always covers the last, partly-filled block of pixels —
   * a floor would leave the right and top edges sampling off the end of it.
   * Also writes u_gasRes, which is how the gas program recovers the exact
   * ratio between the two buffers rather than assuming the divisor.
   */
  const sizeGasTarget = (width: number, height: number): void => {
    if (gasTarget === null) return;
    const w = Math.ceil(width / GAS_RES_DIVISOR);
    const h = Math.ceil(height / GAS_RES_DIVISOR);
    if (gasTarget.width === w && gasTarget.height === h) return;
    gasTarget.setSize(w, h);
    (uniforms['u_gasRes'] as IUniform<Vector2>).value.set(w, h);
  };

  /**
   * Allocates the gas target, program and scene. Called once, from the wheel
   * material's creation, next to the bake.
   */
  const createGasPass = (): void => {
    const { renderer } = viewport;
    renderer.getDrawingBufferSize(drawingBuffer);
    // Half float and RGBA: rgb carries the lit gas colour and a the opacity,
    // both small positive numbers, and 8 bits would band the faint gas the
    // depth fade then stretches. Bilinear both ways because the whole point is
    // reading it back between texel centres; clamped because a pixel on the
    // very edge of the frame maps half a texel outside the target; no mipmaps
    // and no depth or stencil because it is sampled at one level and written by
    // a fullscreen triangle that tests nothing.
    gasTarget = new WebGLRenderTarget(1, 1, {
      type: HalfFloatType,
      format: RGBAFormat,
      wrapS: ClampToEdgeWrapping,
      wrapT: ClampToEdgeWrapping,
      minFilter: LinearFilter,
      magFilter: LinearFilter,
      generateMipmaps: false,
      depthBuffer: false,
      stencilBuffer: false,
    });
    sizeGasTarget(drawingBuffer.x, drawingBuffer.y);
    // The SAME uniforms object as the wheel, so the clock, the anchor frame and
    // the bake textures are shared and cannot drift by a frame between the two
    // programs.
    gasMaterial = new ShaderMaterial({
      uniforms,
      vertexShader: VERTEX_SHADER,
      fragmentShader: GAS_GLSL,
      depthTest: false,
      depthWrite: false,
      toneMapped: false,
    });
    const gasMesh = new Mesh(geometry, gasMaterial);
    // As in the bake: the vertex shader writes clip space, so the camera is a
    // formality and the mesh must not be culled against it.
    gasMesh.frustumCulled = false;
    gasScene = new Scene().add(gasMesh);
    gasCamera = new Camera();
    (uniforms['u_gasHalf'] as IUniform<Texture>).value = gasTarget.texture;
  };

  /**
   * Renders the gas into its target. Called from onBeforeRender, so the camera
   * it reads through the shared uniforms is this frame's final one.
   *
   * The state discipline is the Reflector's (three/examples/jsm/objects/
   * Reflector.js): a nested renderer.render must leave the render target, the
   * XR flag and the shadow auto-update exactly as it found them. `autoReset` is
   * saved too, which the Reflector does not need but this does — three resets
   * renderer.info at the top of every render, and the app reads the frame's
   * draw-call count out of it after the outer render (plugins/host.ts), so a
   * nested reset would throw away everything drawn before the void.
   */
  const renderGasPass = (): void => {
    if (gasScene === null || gasCamera === null || gasTarget === null) return;
    const { renderer } = viewport;
    const previousTarget = renderer.getRenderTarget();
    const previousCubeFace = renderer.getActiveCubeFace();
    const previousMipmap = renderer.getActiveMipmapLevel();
    const previousXrEnabled = renderer.xr.enabled;
    const previousShadowAutoUpdate = renderer.shadowMap.autoUpdate;
    const previousInfoAutoReset = renderer.info.autoReset;
    renderer.xr.enabled = false;
    renderer.shadowMap.autoUpdate = false;
    renderer.info.autoReset = false;
    renderer.setRenderTarget(gasTarget);
    renderer.render(gasScene, gasCamera);
    renderer.info.autoReset = previousInfoAutoReset;
    renderer.xr.enabled = previousXrEnabled;
    renderer.shadowMap.autoUpdate = previousShadowAutoUpdate;
    renderer.setRenderTarget(previousTarget, previousCubeFace, previousMipmap);
  };

  /**
   * The three star grids' `Points` (perf, issue #342), or empty until the wheel
   * material is first created — like the bake and the gas pass, so a player on
   * the nebula never generates a million vertices or compiles the programs.
   */
  let starPoints: Points[] = [];

  /**
   * Generates the star field and adds one `Points` per grid. Called once, from
   * the wheel material's creation.
   *
   * ONE MATERIAL PER GRID, each built on the SAME `uniforms` object (a
   * shallow copy shares the IUniform objects themselves, so the clock, the
   * anchor frame and the gas texture cannot drift by a frame) plus the one
   * uniform that differs. Three materials rather than one with a per-object
   * uniform because three refreshes a material's uniforms per MATERIAL, not per
   * object, so a shared material would draw all three grids as whichever value
   * was written last.
   */
  const createStarPoints = (): void => {
    const { renderer } = viewport;
    const gl = renderer.getContext();
    // The driver's own sprite limit. Queried once and passed to the shader,
    // which clamps to it: a sprite clipped silently by the GL would leave the
    // fragment measuring its falloff across a width the sprite does not have.
    const sizeRange = gl.getParameter(gl.ALIASED_POINT_SIZE_RANGE) as Float32Array;
    const pointSizeMax: IUniform<number> = { value: sizeRange[1] ?? 1 };
    starPoints = STAR_GRIDS.map((spec, grid) => {
      const buffers = generateStarGrid(spec);
      const starGeometry = new BufferGeometry();
      starGeometry.setAttribute('position', new BufferAttribute(buffers.position, 3));
      starGeometry.setAttribute('starShape', new BufferAttribute(buffers.shape, 3));
      const material = new ShaderMaterial({
        uniforms: { ...uniforms, u_starGrid: { value: grid }, u_pointSizeMax: pointSizeMax },
        vertexShader: STARS_VERT_GLSL,
        fragmentShader: STARS_FRAG_GLSL,
        blending: AdditiveBlending,
        // NOT COSMETIC. three's AdditiveBlending is `ONE, ONE` only when the
        // material declares its colour premultiplied; without this it picks
        // `SRC_ALPHA, ONE` instead (WebGLState.setBlending), and the alpha this
        // pass deliberately writes as zero would multiply every star away.
        premultipliedAlpha: true,
        // The stars belong in the OPAQUE list, so the terrain drawn after them
        // still covers them; `transparent` only chooses the list (see
        // STARS_RENDER_ORDER), and the blending above applies either way.
        transparent: false,
        // Like the wheel: the backdrop neither reads nor writes depth.
        depthTest: false,
        depthWrite: false,
        // See the colour-pipeline note at the top of this file.
        toneMapped: false,
      });
      const points = new Points(starGeometry, material);
      // The vertex shader writes clip space directly, so the object's bounds
      // and its matrix are both meaningless to it.
      points.frustumCulled = false;
      points.matrixAutoUpdate = false;
      points.renderOrder = STARS_RENDER_ORDER;
      points.visible = style === 'wheel';
      // Named so the perf probe's ablation scenario can hide it by name, the
      // way it hides a plugin's layer (client/src/perfProbe.ts). Core rigs are
      // otherwise anonymous children of the scene and cannot be attributed.
      // Per GRID, not one name for all of them: STAR_GRIDS builds several
      // Points objects and a shared name would make two rigs indistinguishable
      // in an ablation report — which it did on this name's first run.
      points.name = `${CORE_RIG_STARS_NAME}-${String(grid)}`;
      viewport.scene.add(points);
      return points;
    });
  };

  /**
   * Hides the fine grid (and the in-arm grid, where STAR_ARM_GRID_ENABLED lets
   * it exist) for frames on which it cannot draw anything, so its ~360 k
   * vertices are not shaded only to be discarded.
   *
   * The smallest `sdist` anywhere on screen is the eye's own height above the
   * plane — the ray straight down — so once THAT alone puts the fine grid's
   * cells under CELL_FADE_PX, the cell fade is zero for every pixel of the
   * frame. The in-arm grid is finer still (STAR_ARM_CELLS_PER_UNIT against
   * STAR_FINE_CELLS_PER_UNIT), and the shader fades both by the fine grid's
   * measure, so this one bound covers them both.
   *
   * Called from onBeforeRender, where the world anchor's frame has just been
   * written, so it reads this frame's pose. three builds its render list before
   * that, so the change lands on the NEXT frame — which costs nothing, because
   * at the threshold both grids' stars are already faded to nothing either way.
   */
  const updateStarVisibility = (): void => {
    if (starPoints.length === 0) return;
    const wheel = style === 'wheel';
    const origin = (uniforms['u_origin'] as IUniform<Vector3>).value;
    const res = (uniforms['u_res'] as IUniform<Vector2>).value;
    const focal = (uniforms['u_focal'] as IUniform<number>).value;
    const fine =
      origin.z < (focal * res.y) / (STAR_FINE_CELLS_PER_UNIT * CELL_FADE_PX);
    starPoints.forEach((points, grid) => {
      points.visible = wheel && (grid === 0 || fine);
    });
  };

  // Materials are compiled on first use and then cached: booting straight into
  // the default style must not pay for the other look's program.
  const materials = new Map<VoidStyle, ShaderMaterial>();
  const materialFor = (style: VoidStyle): ShaderMaterial => {
    const cached = materials.get(style);
    if (cached !== undefined) return cached;
    if (style === 'wheel') {
      bakeGasPattern();
      createGasPass();
      createStarPoints();
    }
    const material = new ShaderMaterial({
      uniforms,
      vertexShader: VERTEX_SHADER,
      fragmentShader: FRAGMENT_SHADER[style],
      // The pass is the backdrop: it must neither read nor write depth, so it
      // cannot occlude the world drawn after it nor be occluded by geometry
      // that has not been drawn yet.
      depthTest: false,
      depthWrite: false,
      // See the colour-pipeline note at the top of this file.
      toneMapped: false,
    });
    materials.set(style, material);
    return material;
  };

  const mesh = new Mesh(geometry, materialFor(initialStyle));
  // The vertex shader ignores every matrix, so the mesh's computed bounds are
  // meaningless — culling it against the camera frustum would drop the
  // backdrop at arbitrary camera angles.
  mesh.frustumCulled = false;
  mesh.renderOrder = VOID_RENDER_ORDER;
  mesh.matrixAutoUpdate = false;
  mesh.onBeforeRender = (_renderer, _scene, camera): void => {
    if (anchor === 'world') writeWorldFrame(camera as PerspectiveCamera);
    // AFTER the frame is written, and only for the wheel: the gas pass reads
    // the anchor frame this call just set, so both layers see one camera.
    updateStarVisibility();
    if (style === 'wheel') renderGasPass();
  };
  // See points.name above: this is the void's other scene child.
  mesh.name = CORE_RIG_VOID_NAME;
  viewport.scene.add(mesh);

  const frozen = prefersReducedMotion();

  const stopFrames = viewport.onFrame((dt) => {
    // Advanced from the render loop's own dt (capped by FRAME_DELTA_CAP_S in
    // render/scene.ts), never from a wall clock: a backgrounded tab that
    // stops receiving animation frames must resume where it left off rather
    // than jumping the wheel forward by the time it spent hidden.
    if (!frozen) (uniforms['u_time'] as IUniform<number>).value += dt;
    // Drawing-buffer size, not client size: the shaders divide fragment
    // coordinates by it, and those are in device pixels.
    viewport.renderer.getDrawingBufferSize(drawingBuffer);
    (uniforms['u_res'] as IUniform<Vector2>).value.copy(drawingBuffer);
    // Same source, same moment: the gas target follows the drawing buffer, and
    // sizeGasTarget returns immediately unless the size actually changed.
    sizeGasTarget(drawingBuffer.x, drawingBuffer.y);
  });

  return {
    setStyle(next: VoidStyle): void {
      style = next;
      mesh.material = materialFor(next);
      applyAnchor();
      // The stars are the wheel's; the nebula draws its own in its fragment.
      updateStarVisibility();
    },
    setAnchor(next: VoidAnchor): void {
      anchor = next;
      applyAnchor();
    },
    dispose(): void {
      stopFrames();
      viewport.scene.remove(mesh);
      for (const material of materials.values()) material.dispose();
      materials.clear();
      for (const target of bakeTargets) target.dispose();
      bakeTargets = [];
      gasMaterial?.dispose();
      gasMaterial = null;
      gasTarget?.dispose();
      gasTarget = null;
      gasScene?.clear();
      gasScene = null;
      gasCamera = null;
      for (const points of starPoints) {
        viewport.scene.remove(points);
        points.geometry.dispose();
        (points.material as ShaderMaterial).dispose();
      }
      starPoints = [];
      geometry.dispose();
    },
  };
}
