// The weather, built: falling columns of rain and snow, drifting fog banks, and
// the bolts that come out of a storm.
//
// CLIENT-SIDE PRESENTATION. Nothing here is on the wire and nothing here is
// authoritative — every drop, flake, sheet and bolt is invented locally out of
// the four numbers a system carries (centre, radius, intensity, wind) plus the
// frame clock. Two players standing in the same front see the same front and
// different drops.
//
// Rules this file keeps:
//
//   * NOT scene.fog, NOT the lighting rig, NOT the sky. Those are global, and
//     tinting the whole world would be the opposite of "weather in large chunks"
//     — this is local geometry that moves with the mass that owns it and leaves
//     the rest of the map in the sun. Clear weather is therefore literally
//     nothing: no system, no rig, no draw call, no change to any scene state.
//     The one exception is a flash's PointLight, which is a light in the scene
//     by necessity and is bounded by FLASH_LIGHT_RANGE_CELLS.
//   * PHOTOSENSITIVITY IS A HARD REQUIREMENT, not a setting. Under
//     prefers-reduced-motion there are no flashes at all and the whole sky holds
//     still; outside it, the client-wide LightningGovernor and the single-rise
//     envelope in sky.ts bound the stimulus. See MIN_FLASH_INTERVAL_SECONDS.
//   * NO PER-FRAME ALLOCATIONS. Every geometry, material, buffer and light is
//     built once when a rig is created, mutated in place each frame, and pooled
//     for reuse when its system dissipates. The frame path writes numbers into
//     arrays that already exist.
//   * ONE OWNER. Everything a rig creates is reachable from it and freed by its
//     dispose(); everything SHARED between rigs (the fog sheet's geometry, the
//     bolt's) is owned by the pool and freed exactly once, by the pool.
//
// WHERE THE NUMBERS LIVE: ./sky.ts, for the reason dread.ts exists next door —
// they are the ones a node test can check without a GL context. This file owns
// only the resolution the shapes are tessellated at.

import {
  AdditiveBlending,
  BufferGeometry,
  DoubleSide,
  DynamicDrawUsage,
  Float32BufferAttribute,
  Group,
  LineBasicMaterial,
  LineSegments,
  Mesh,
  MeshBasicMaterial,
  Points,
  PointsMaterial,
  PointLight,
  type Material,
  type Object3D,
} from 'three';
import { CELL_WORLD_SIZE } from '@terrace/shared';
import type { WeatherKind } from '../protocol.ts';
import type { InterpolatedSystem } from './interpolation.ts';
import {
  BOLT_BOTTOM_WORLD_Y,
  BOLT_JAG_WORLD_UNITS,
  BOLT_TIP_WIDTH_FRACTION,
  BOLT_TOP_WORLD_Y,
  BOLT_WIDTH_WORLD_UNITS,
  CLOUD_BASE_WORLD_Y,
  FLASH_COLOR,
  FLASH_GLOW_OPACITY,
  FLASH_LIGHT_PEAK_INTENSITY,
  FLASH_LIGHT_RANGE_CELLS,
  FOG_COLOR,
  FOG_EDGE_SOFTNESS,
  FOG_LAYERS,
  LightningSchedule,
  PRECIPITATION_COLUMN_WORLD_UNITS,
  PRECIPITATION_HAZE_SCALE,
  PRECIPITATION_PROFILES,
  driftSeconds,
  fallFraction,
  fogEdgeWobble,
  type LightningGovernor,
  type PrecipitationProfile,
} from './sky.ts';

const TWO_PI = Math.PI * 2;

/**
 * Tessellation of one fog sheet: segments around, rings out from the centre.
 *
 * 64 around keeps the wobbled outline curved rather than polygonal at the radius
 * these sheets are drawn at — half again the monsters plugin's 48, because a
 * weather system is up to five times the size of that mist bank and the same
 * segment count would show facets. 6 rings keeps the alpha falloff, which is
 * interpolated linearly between rings, from banding. 385 vertices, ONE geometry
 * shared by every fog sheet on the client.
 */
const FOG_RADIAL_SEGMENTS = 64;
const FOG_RINGS = 6;

/**
 * Kinks in a bolt, and the phase each kink advances by.
 *
 * Nine kinks over a 22-unit fall is a jag every 2.4 units: fewer reads as a bent
 * stick, many more reads as a fuzzy line at any real camera distance. The phase
 * step is deliberately not a rational fraction of 2π, so the kinks do not fall
 * into a repeating zigzag.
 */
const BOLT_SEGMENTS = 9;
const BOLT_JAG_TURN_RADIANS = 2.4;

/**
 * Draw order for everything in here.
 *
 * The sea is transparent too (render/water.ts) and it is ONE plane the size of
 * the world, so three sorts it by the distance to its centre — the middle of the
 * map, not the water under the weather. Left to the sort, a fog sheet a unit
 * above the surface can therefore be drawn first and then painted over by the
 * sea. A positive render order puts every sheet after it, unconditionally. Same
 * value and same reasoning as the monsters plugin's DREAD_RENDER_ORDER.
 */
const WEATHER_RENDER_ORDER = 1;

// ── Shared geometry (owned by the pool, never by a rig) ──────────────────────

/**
 * One fog sheet: a horizontal UNIT disc in the XZ plane, opaque-ish at the
 * centre and vanishing at the rim. Scaled to a system's radius by the sheet that
 * uses it, which is what lets every fog bank on the client share one geometry.
 *
 * The falloff is per-vertex ALPHA rather than a texture or a shader. three
 * multiplies the material's opacity by the vertex colour when the colour
 * attribute carries four components, so one stock MeshBasicMaterial gives a soft
 * radial blob whose overall strength is still a single number the system's
 * intensity can drive — with no texture to load, no canvas to rasterise and no
 * custom shader to keep compiling.
 */
function buildFogGeometry(): BufferGeometry {
  const positions: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];

  // The centre vertex. RGB is left at 1 so the material's own colour rules; only
  // the alpha varies across the sheet.
  positions.push(0, 0, 0);
  colors.push(1, 1, 1, 1);

  for (let ring = 1; ring <= FOG_RINGS; ring++) {
    const out = ring / FOG_RINGS;
    const alpha = Math.pow(1 - out * out, FOG_EDGE_SOFTNESS);
    for (let side = 0; side < FOG_RADIAL_SEGMENTS; side++) {
      const angle = (side / FOG_RADIAL_SEGMENTS) * TWO_PI;
      const radius = out * fogEdgeWobble(angle);
      positions.push(radius * Math.cos(angle), 0, radius * Math.sin(angle));
      colors.push(1, 1, 1, alpha);
    }
  }

  // Inner fan, centre to the first ring.
  for (let side = 0; side < FOG_RADIAL_SEGMENTS; side++) {
    const here = 1 + side;
    const next = 1 + ((side + 1) % FOG_RADIAL_SEGMENTS);
    indices.push(0, next, here);
  }

  // Quads between consecutive rings.
  for (let ring = 1; ring < FOG_RINGS; ring++) {
    const inner = 1 + (ring - 1) * FOG_RADIAL_SEGMENTS;
    const outer = 1 + ring * FOG_RADIAL_SEGMENTS;
    for (let side = 0; side < FOG_RADIAL_SEGMENTS; side++) {
      const nextSide = (side + 1) % FOG_RADIAL_SEGMENTS;
      indices.push(inner + side, outer + nextSide, outer + side);
      indices.push(inner + side, inner + nextSide, outer + nextSide);
    }
  }

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geometry.setAttribute('color', new Float32BufferAttribute(colors, 4));
  geometry.setIndex(indices);
  return geometry;
}

/**
 * The bolt: two ribbons crossed at a right angle, following the same jagged
 * descent from the cloud base down into the haze.
 *
 * CROSSED, because one flat ribbon disappears when the camera comes round to its
 * edge — and the camera here is a free orbit, so that is not an edge case, it is
 * a quarter of all views. Two of them at 90° means one is always presenting a
 * face. Cheaper and steadier than billboarding, which would have to re-orient
 * the strip every frame against a camera this plugin has no access to (the
 * ClientPluginCtx contract does not expose one, deliberately).
 *
 * Authored once in its own space and shared by every storm on the client; a
 * strike is placed by moving the pivot it hangs off, never by rebuilding it.
 */
function buildBoltGeometry(): BufferGeometry {
  const positions: number[] = [];
  const indices: number[] = [];
  const span = BOLT_TOP_WORLD_Y - BOLT_BOTTOM_WORLD_Y;

  /** Emits one ribbon; `sideways` is which horizontal axis it spreads along. */
  function ribbon(sideways: 'x' | 'z'): void {
    const first = positions.length / 3;
    for (let step = 0; step <= BOLT_SEGMENTS; step++) {
      const along = step / BOLT_SEGMENTS;
      const y = BOLT_TOP_WORLD_Y - along * span;
      const jag = BOLT_JAG_WORLD_UNITS * Math.sin(step * BOLT_JAG_TURN_RADIANS);
      const halfWidth =
        (BOLT_WIDTH_WORLD_UNITS * (1 - (1 - BOLT_TIP_WIDTH_FRACTION) * along)) / 2;
      for (const edge of [-1, 1]) {
        const offset = jag + edge * halfWidth;
        positions.push(sideways === 'x' ? offset : 0, y, sideways === 'z' ? offset : 0);
      }
    }
    for (let step = 0; step < BOLT_SEGMENTS; step++) {
      const corner = first + step * 2;
      indices.push(corner, corner + 1, corner + 3);
      indices.push(corner, corner + 3, corner + 2);
    }
  }

  ribbon('x');
  ribbon('z');

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  return geometry;
}

// ── Precipitation ────────────────────────────────────────────────────────────

/** A pooled column of falling particles. Positions are rewritten every frame. */
interface Precipitation {
  readonly object: Object3D;
  readonly material: Material;
  /**
   * Rewrites every particle's position for this frame. `vx`/`vy` are the
   * system's wind in cells per second and shear the column downwind.
   */
  advance(elapsed: number, radius: number, vx: number, vy: number): void;
  dispose(): void;
}

/**
 * Builds one falling column in the LOCAL space of its rig — the rig's root is
 * moved to the system's centre, so nothing here ever holds a world coordinate
 * and the numbers stay small however far across a 512² world the front has
 * drifted.
 *
 * `frustumCulled` is off. three computes a bounding sphere once, from the
 * positions the geometry was created with, and every frame after that these
 * positions move; a stale sphere would cull the column exactly when the camera
 * looked at it. With at most MAX_ACTIVE_SYSTEMS columns on screen, always
 * submitting three draw calls is cheaper than any correct alternative.
 */
function createPrecipitation(profile: PrecipitationProfile): Precipitation {
  const verticesPerParticle = profile.form === 'streak' ? 2 : 1;
  const positions = new Float32Array(profile.count * verticesPerParticle * 3);

  // Per-particle constants, drawn once. Kept in flat arrays rather than an array
  // of objects: the frame loop reads them count times, and a struct-of-arrays
  // walk is both allocation-free and cache-friendly.
  const discX = new Float32Array(profile.count);
  const discZ = new Float32Array(profile.count);
  const birth = new Float32Array(profile.count);
  const swayPhase = new Float32Array(profile.count);

  for (let i = 0; i < profile.count; i++) {
    // sqrt of a uniform gives a UNIFORM AREA density over the disc; using the
    // uniform directly would crowd every column into its own middle.
    const r = Math.sqrt(Math.random());
    const angle = Math.random() * TWO_PI;
    discX[i] = Math.cos(angle) * r;
    discZ[i] = Math.sin(angle) * r;
    birth[i] = Math.random();
    swayPhase[i] = Math.random() * TWO_PI;
  }

  const geometry = new BufferGeometry();
  const attribute = new Float32BufferAttribute(positions, 3);
  // Told once that this buffer changes every frame, so the driver can pick the
  // right storage for it instead of assuming static geometry.
  attribute.setUsage(DynamicDrawUsage);
  geometry.setAttribute('position', attribute);

  const material =
    profile.form === 'streak'
      ? new LineBasicMaterial({
          color: profile.color,
          transparent: true,
          opacity: 0,
          // Depth TESTED so terrain and the sea occlude the part of the column
          // below them, not depth WRITTEN so drops never cut each other or the
          // fog sheets they fall through.
          depthWrite: false,
        })
      : new PointsMaterial({
          color: profile.color,
          size: profile.spriteSize,
          sizeAttenuation: true,
          transparent: true,
          opacity: 0,
          depthWrite: false,
        });

  const object =
    profile.form === 'streak'
      ? new LineSegments(geometry, material as LineBasicMaterial)
      : new Points(geometry, material as PointsMaterial);
  object.frustumCulled = false;
  object.renderOrder = WEATHER_RENDER_ORDER;

  return {
    object,
    material,

    advance(elapsed: number, radius: number, vx: number, vy: number): void {
      // The streak points along the particle's actual velocity — down at
      // fallSpeed, sideways at the wind — so rain leans into the wind instead of
      // hanging vertically in a gale. One normalisation per frame, not per drop.
      const speed = Math.hypot(vx, profile.fallSpeed, vy);
      const streakX = (vx / speed) * profile.streakLength;
      const streakY = (-profile.fallSpeed / speed) * profile.streakLength;
      const streakZ = (vy / speed) * profile.streakLength;

      let write = 0;
      for (let i = 0; i < profile.count; i++) {
        const fraction = fallFraction(elapsed, birth[i]!, profile.fallSpeed);
        const aloft = driftSeconds(fraction, profile.fallSpeed);
        const sway =
          profile.swayCells === 0
            ? 0
            : profile.swayCells * Math.sin(elapsed * profile.swayHz * TWO_PI + swayPhase[i]!);

        const x = discX[i]! * radius + vx * aloft + sway;
        const y = CLOUD_BASE_WORLD_Y - fraction * PRECIPITATION_COLUMN_WORLD_UNITS;
        // The second sway axis is a quarter cycle out of phase with the first,
        // so a flake traces a slow ellipse rather than sliding along one line.
        const z =
          discZ[i]! * radius +
          vy * aloft +
          (profile.swayCells === 0
            ? 0
            : profile.swayCells *
              Math.cos(elapsed * profile.swayHz * TWO_PI + swayPhase[i]!));

        positions[write++] = x;
        positions[write++] = y;
        positions[write++] = z;
        if (verticesPerParticle === 2) {
          positions[write++] = x + streakX;
          positions[write++] = y + streakY;
          positions[write++] = z + streakZ;
        }
      }
      attribute.needsUpdate = true;
    },

    dispose(): void {
      geometry.dispose();
      material.dispose();
    },
  };
}

// ── A rig ────────────────────────────────────────────────────────────────────

/** One system's weather, in the scene. Positioned and animated by `update`. */
export interface WeatherRig {
  readonly kind: WeatherKind;
  /** Put at the system's centre on the X/Z plane; never rotated. */
  readonly root: Group;
  /**
   * One frame. `elapsed` is the plugin's animation clock — which STOPS
   * ADVANCING under prefers-reduced-motion, so every drop, sheet and sway in
   * here becalms from that one fact — and `dt` drives only the lightning clocks.
   */
  update(
    system: InterpolatedSystem,
    elapsed: number,
    dt: number,
    reduced: boolean,
    governor: LightningGovernor,
  ): void;
  /**
   * A bolt landed at this world-space offset from the system's own centre
   * (plugins/weather/server/lightning.ts chose the cell; the caller converted
   * it). Moves the bolt and its light there and begins the flash — unless the
   * governor refuses, in which case NOTHING moves: a refused flash must not
   * leave a dark bolt sitting at the new position, waiting to be lit by the
   * next one.
   *
   * A no-op for kinds with no lightning at all, so a caller does not have to
   * ask whether a system is a storm before telling it it was struck.
   */
  strike(offsetX: number, offsetZ: number, governor: LightningGovernor): void;
  /**
   * Forgets any in-progress lightning flash. Called by the pool before a rig
   * re-enters the free list, so a storm rig reused by a later system never opens
   * with a stale flash that the LightningGovernor never approved (sky.ts). A
   * no-op for kinds with no lightning clock.
   */
  reset(): void;
  /** Frees everything this rig OWNS. Shared geometry belongs to the pool. */
  dispose(): void;
}

interface SharedGeometry {
  readonly fog: BufferGeometry;
  readonly bolt: BufferGeometry;
}

function createRig(kind: WeatherKind, shared: SharedGeometry): WeatherRig {
  const root = new Group();
  root.name = `weather:${kind}`;

  const profile = PRECIPITATION_PROFILES[kind];
  const precipitation = profile === null ? null : createPrecipitation(profile);
  if (precipitation !== null) root.add(precipitation.object);

  /**
   * The haze bank. Fog systems ARE this bank; rain and snow get a third of it
   * (PRECIPITATION_HAZE_SCALE) so the air a front falls through greys, which is
   * what stops precipitation reading as lines in a vacuum.
   */
  const hazeScale = kind === 'fog' ? 1 : PRECIPITATION_HAZE_SCALE;
  const fogMaterials: MeshBasicMaterial[] = [];
  const fogSheets: Mesh[] = [];
  for (const layer of FOG_LAYERS) {
    const material = new MeshBasicMaterial({
      color: FOG_COLOR,
      transparent: true,
      // Starts invisible; the system's intensity owns this from frame one.
      opacity: 0,
      // Per-vertex alpha (buildFogGeometry) needs this; the vertex RGB is 1, so
      // the material's colour is what actually tints the sheet.
      vertexColors: true,
      // Visible from underneath, for a camera that has dipped toward the water.
      side: DoubleSide,
      depthWrite: false,
    });
    const sheet = new Mesh(shared.fog, material);
    sheet.renderOrder = WEATHER_RENDER_ORDER;
    root.add(sheet);
    fogMaterials.push(material);
    fogSheets.push(sheet);
  }

  // ── Storm-only parts ───────────────────────────────────────────────────────
  const isStorm = kind === 'storm';
  const lightning = isStorm ? new LightningSchedule() : null;

  /**
   * The flash's effect on the weather itself. The sheets are unlit, so the point
   * light below cannot reach them; this additive sheet through the middle of the
   * bank is what makes the haze light up from inside instead of sitting dead
   * while the terrain around it flares.
   */
  const glowMaterial = isStorm
    ? new MeshBasicMaterial({
        color: FLASH_COLOR,
        transparent: true,
        opacity: 0,
        vertexColors: true,
        side: DoubleSide,
        blending: AdditiveBlending,
        depthWrite: false,
      })
    : null;
  const glowSheet = glowMaterial === null ? null : new Mesh(shared.fog, glowMaterial);
  if (glowSheet !== null) {
    glowSheet.renderOrder = WEATHER_RENDER_ORDER;
    glowSheet.visible = false;
    root.add(glowSheet);
  }

  const boltMaterial = isStorm
    ? new MeshBasicMaterial({
        color: FLASH_COLOR,
        transparent: true,
        opacity: 0,
        side: DoubleSide,
        // The bolt is light, not a surface: it adds to whatever is behind it.
        blending: AdditiveBlending,
        depthWrite: false,
      })
    : null;
  /**
   * The bolt hangs off its own pivot so a strike is placed by moving ONE node —
   * and so its jag is authored once, in its own space, instead of being rebuilt
   * per strike.
   */
  const boltPivot = isStorm ? new Group() : null;
  const bolt = boltMaterial === null ? null : new Mesh(shared.bolt, boltMaterial);
  if (bolt !== null && boltPivot !== null) {
    bolt.visible = false;
    bolt.renderOrder = WEATHER_RENDER_ORDER;
    boltPivot.add(bolt);
    root.add(boltPivot);
  }

  /**
   * The momentary light, added once and left in the graph at zero intensity
   * between flashes.
   *
   * ADDING OR REMOVING A LIGHT INVALIDATES EVERY MATERIAL'S SHADER PROGRAM: the
   * light count is baked into the program key, so three recompiles the terrain,
   * the water and every creature the next time each is drawn. Doing that per
   * flash would hitch the frame every ten seconds. Doing it when a storm arrives
   * and when it dissipates — minutes apart, and only for storms — is a cost
   * nobody can see. It is also why rigs are POOLED: a storm that leaves and one
   * that arrives a minute later reuse the same rig and the same light.
   */
  const flashLight = isStorm ? new PointLight(FLASH_COLOR, 0, FLASH_LIGHT_RANGE_CELLS) : null;
  if (flashLight !== null) {
    flashLight.position.y = BOLT_BOTTOM_WORLD_Y;
    root.add(flashLight);
  }

  return {
    kind,
    root,

    update(system, elapsed, dt, reduced, governor): void {
      // The wire carries a system's position, radius and velocity in CELLS —
      // the server sims the weather on the same grid as everything else — and
      // everything below draws in WORLD UNITS. One conversion at the top, so no
      // line further down has to remember which space it is in. It was a no-op
      // until the 2026-08-21 re-sample made a cell a quarter of a world unit.
      const worldRadius = system.radius * CELL_WORLD_SIZE;
      root.position.set(system.x * CELL_WORLD_SIZE, 0, system.y * CELL_WORLD_SIZE);

      const intensity = system.intensity;
      // Nothing to draw at zero, and a transparent draw call that contributes
      // nothing is still a transparent draw call — plus this is what makes a
      // gathering system cost nothing until it is actually visible.
      const lit = intensity > 0;
      root.visible = lit;
      if (!lit) return;

      if (precipitation !== null && profile !== null) {
        precipitation.material.opacity = profile.opacity * intensity;
        precipitation.advance(
          elapsed,
          worldRadius,
          system.vx * CELL_WORLD_SIZE,
          system.vy * CELL_WORLD_SIZE,
        );
      }

      for (let index = 0; index < fogSheets.length; index++) {
        const layer = FOG_LAYERS[index]!;
        const sheet = fogSheets[index]!;
        fogMaterials[index]!.opacity = layer.opacity * hazeScale * intensity;
        sheet.scale.setScalar(worldRadius * layer.radiusScale);
        // `elapsed` is frozen under reduced motion, so this is the rest pose
        // re-asserted every frame — no state machine, and a preference turned on
        // mid-session becalms the bank on the next frame.
        sheet.rotation.y = elapsed * layer.spinHz * TWO_PI;
        sheet.position.y =
          layer.height + Math.sin(elapsed * layer.bobHz * TWO_PI) * layer.bobUnits;
      }

      if (lightning === null) return;

      // THE LIGHTNING. This frame only DECAYS the flash envelope — where and
      // when a bolt lands is the server's call now, and arrives through
      // `strike` below (sky.ts's LightningSchedule header). Reduced motion no
      // longer needs to disarm anything here: the caller does not deliver
      // strikes at all under it, and the brightness is forced to zero on the
      // spot two lines down, so a preference turned on mid-flash takes effect
      // on the next frame rather than after the tail.
      lightning.advance(dt);

      // Intensity multiplies the flash as well, so a storm dissipating mid-flash
      // takes its lightning down with it instead of leaving a bolt over ground
      // that has cleared.
      const brightness = reduced ? 0 : lightning.brightness() * intensity;
      const flashing = brightness > 0;
      bolt!.visible = flashing;
      glowSheet!.visible = flashing;
      if (flashing) {
        boltMaterial!.opacity = brightness;
        glowMaterial!.opacity = brightness * FLASH_GLOW_OPACITY;
        // The glow rides the widest sheet, so the whole bank lights rather than
        // a disc in its middle.
        glowSheet!.scale.setScalar(worldRadius * FOG_LAYERS[0]!.radiusScale);
        glowSheet!.position.y = FOG_LAYERS[0]!.height;
      }
      flashLight!.intensity = brightness * FLASH_LIGHT_PEAK_INTENSITY;
    },

    strike(offsetX: number, offsetZ: number, governor: LightningGovernor): void {
      if (lightning === null) return;
      // The governor first, and the move only if it says yes — see the
      // interface's doc comment for why a refused flash must not reposition the
      // bolt.
      if (!lightning.strike(governor)) return;

      boltPivot!.position.set(offsetX, 0, offsetZ);
      // The jag is authored once in its own space (shared.bolt); spinning the
      // pivot is what stops every bolt in a session from being the same
      // silhouette. Derived from the strike's own offset rather than drawn at
      // random, so the same strike looks the same on every client that draws it.
      boltPivot!.rotation.y = Math.atan2(offsetZ, offsetX);
      flashLight!.position.set(offsetX, BOLT_BOTTOM_WORLD_Y, offsetZ);
    },

    reset(): void {
      lightning?.reset();
    },

    dispose(): void {
      root.clear();
      precipitation?.dispose();
      for (const material of fogMaterials) material.dispose();
      glowMaterial?.dispose();
      boltMaterial?.dispose();
      // The fog and bolt GEOMETRIES are the pool's, shared by every rig; freeing
      // them here would tear the resource out from under every other system.
      // PointLight owns no GPU resource and has no dispose(); dropping it out of
      // the graph above is its whole teardown.
    },
  };
}


// ── The dry bolt ─────────────────────────────────────────────────────────────

/**
 * ONE bolt that belongs to no weather system — the client half of dry lightning
 * (server/lightning.ts; owner, 2026-08-24: "randomly fire even without a
 * storm").
 *
 * A storm's bolt is a child of its rig, placed as an OFFSET from the system's
 * centre, so it moves with the front and dies with it. A dry bolt has no front:
 * it is placed at a world position and is gone in a fraction of a second. That
 * is the whole difference, and it is why this cannot be a storm rig with the
 * rain turned off — a rig is anchored to a system that, here, does not exist.
 *
 * ONE, not a pool: two dry bolts inside FLASH_DURATION_SECONDS of each other
 * cannot happen, because the governor's photosensitivity floor
 * (MIN_FLASH_INTERVAL_SECONDS) is longer than a flash and refuses the second.
 * A second instance could never be lit.
 *
 * It shares the pool's bolt GEOMETRY and owns its own material, light and
 * schedule — the same division every storm rig keeps.
 */
export interface DryBoltRig {
  /** Add to the plugin's layer. Positioned in world space, never re-parented. */
  readonly root: Group;
  /**
   * A bolt just landed at this world position. Begins the flash unless the
   * governor refuses, in which case NOTHING moves — a refused flash must not
   * leave a dark bolt standing at the new position waiting to be lit.
   */
  strike(worldX: number, worldZ: number, governor: LightningGovernor): void;
  /** One frame: decays the flash. `reduced` forces it dark on the spot. */
  update(dt: number, reduced: boolean): void;
  dispose(): void;
}

export function createDryBoltRig(shared: SharedGeometry): DryBoltRig {
  const root = new Group();
  root.name = 'weather:dry-bolt';

  const material = new MeshBasicMaterial({
    color: FLASH_COLOR,
    transparent: true,
    opacity: 0,
    side: DoubleSide,
    blending: AdditiveBlending,
    depthWrite: false,
  });
  const bolt = new Mesh(shared.bolt, material);
  bolt.visible = false;
  bolt.renderOrder = WEATHER_RENDER_ORDER;

  // The pivot carries the bolt so a strike is placed by moving ONE node, and so
  // the jag can be spun rather than re-authored — a storm rig's arrangement,
  // for its reasons.
  const pivot = new Group();
  pivot.add(bolt);
  root.add(pivot);

  // Created once and left in the graph at zero intensity, NEVER added and
  // removed per flash: the light count is baked into every material's shader
  // program key, so toggling one recompiles the terrain, the water and every
  // creature (see createRig's flashLight).
  const light = new PointLight(FLASH_COLOR, 0, FLASH_LIGHT_RANGE_CELLS);
  light.position.y = BOLT_BOTTOM_WORLD_Y;
  root.add(light);

  const schedule = new LightningSchedule();

  return {
    root,

    strike(worldX: number, worldZ: number, governor: LightningGovernor): void {
      if (!schedule.strike(governor)) return;
      pivot.position.set(worldX, 0, worldZ);
      // Yaw from the strike's own coordinates rather than at random, so the same
      // bolt has the same silhouette on every client that draws it.
      pivot.rotation.y = Math.atan2(worldZ, worldX);
      light.position.set(worldX, BOLT_BOTTOM_WORLD_Y, worldZ);
    },

    update(dt: number, reduced: boolean): void {
      schedule.advance(dt);
      const brightness = reduced ? 0 : schedule.brightness();
      const flashing = brightness > 0;
      bolt.visible = flashing;
      if (flashing) material.opacity = brightness;
      light.intensity = brightness * FLASH_LIGHT_PEAK_INTENSITY;
    },

    dispose(): void {
      root.clear();
      material.dispose();
      // The bolt GEOMETRY is the pool's; PointLight owns no GPU resource.
    },
  };
}

// ── The pool ─────────────────────────────────────────────────────────────────

/**
 * Rigs, reused across systems of the same kind.
 *
 * WHY POOL AT ALL when at most MAX_ACTIVE_SYSTEMS exist: building a rain rig
 * allocates a 1 350-drop buffer and a fresh material, and creating a STORM rig
 * adds a PointLight to the scene, which invalidates every material's shader
 * program (see flashLight). Weather turns over every few minutes forever, so
 * without a pool a world left running all evening pays that repeatedly. With one
 * it pays it once per kind, and the shared fog and bolt geometry once ever.
 */
export interface WeatherRigs {
  /**
   * The world's single dry bolt — lightning that belongs to no system. Owned by
   * the pool because it shares the pool's bolt geometry and has exactly the same
   * lifetime.
   */
  readonly dryBolt: DryBoltRig;
  /** A rig for this kind, from the free list if one is waiting. */
  acquire(kind: WeatherKind): WeatherRig;
  /** Returns a rig to the free list. The caller has already unparented it. */
  release(rig: WeatherRig): void;
  /** Frees every rig, free or not, and the shared geometry. */
  dispose(): void;
}

export function createWeatherRigs(): WeatherRigs {
  const shared: SharedGeometry = { fog: buildFogGeometry(), bolt: buildBoltGeometry() };
  const free = new Map<WeatherKind, WeatherRig[]>();
  const all: WeatherRig[] = [];
  const dryBolt = createDryBoltRig(shared);

  return {
    dryBolt,

    acquire(kind: WeatherKind): WeatherRig {
      const waiting = free.get(kind);
      const reused = waiting?.pop();
      if (reused !== undefined) return reused;
      const rig = createRig(kind, shared);
      all.push(rig);
      return rig;
    },

    release(rig: WeatherRig): void {
      // A rig re-enters the pool dark: without this, a storm rig freed mid-flash
      // (or within FLASH_DURATION_SECONDS of one) would hand its stale
      // LightningSchedule state to whatever system acquires it next, lighting an
      // ungoverned phantom flash at the OLD storm's bolt position on the very
      // first frame.
      rig.reset();
      let waiting = free.get(rig.kind);
      if (waiting === undefined) {
        waiting = [];
        free.set(rig.kind, waiting);
      }
      waiting.push(rig);
    },

    dispose(): void {
      for (const rig of all) rig.dispose();
      all.length = 0;
      free.clear();
      dryBolt.dispose();
      shared.fog.dispose();
      shared.bolt.dispose();
    },
  };
}
