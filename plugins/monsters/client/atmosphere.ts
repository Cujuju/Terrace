// The dread, built: a low mist bank that follows the monster across the water,
// and the occasional bolt that falls into it.
//
// CLIENT-SIDE WEATHER. Nothing here is on the wire, nothing here is simulated,
// and nothing here can be observed by the server or by another plugin. It is
// driven entirely by the monster state the client already receives (position,
// via the same interpolated pose the model uses) plus elapsed time.
//
// Rules this file keeps:
//   * NOT scene.fog. That is a global, and tinting the whole world would be the
//     opposite of "dread around the monster" — this is local geometry that moves
//     with him and leaves the rest of the sea alone.
//   * PHOTOSENSITIVITY IS A HARD REQUIREMENT, not a setting. Under
//     prefers-reduced-motion there are no flashes at all and the mist holds
//     still; outside it, the strike interval floor and the single-rise envelope
//     in dread.ts bound the stimulus. See MIN_FLASH_INTERVAL_SECONDS.
//   * NO PER-FRAME ALLOCATIONS. Every mesh, material, geometry and light is
//     built once when the monster arrives, mutated in place each frame, and
//     freed when it leaves. The frame path touches numbers on objects that
//     already exist.
//   * ONE OWNER. Everything this module creates is reachable from the returned
//     handle and is freed by its dispose(). Unlike models.ts there is no shared
//     pool: the mist's opacity and the bolt's placement are per-monster ANIMATED
//     state, so sharing a material between two of them would have them fight,
//     and the ~350 vertices this builds cost nothing on an event (a summoning)
//     that happens minutes apart.
//
// WHERE THE NUMBERS LIVE: ./dread.ts, for the same reason anatomy.ts exists —
// they are the ones a node test can check without a GL context. This file owns
// only the resolution the shapes are tessellated at.

import {
  AdditiveBlending,
  BufferGeometry,
  Float32BufferAttribute,
  Group,
  Mesh,
  MeshBasicMaterial,
  PointLight,
  DoubleSide,
} from 'three';
import {
  BOLT_BOTTOM_CELLS,
  BOLT_JAG_CELLS,
  BOLT_MAX_RADIUS_CELLS,
  BOLT_MIN_RADIUS_CELLS,
  BOLT_TIP_WIDTH_FRACTION,
  BOLT_TOP_CELLS,
  BOLT_WIDTH_CELLS,
  FLASH_COLOR,
  FLASH_GLOW_LAYER_INDEX,
  FLASH_GLOW_OPACITY,
  FLASH_LIGHT_HEIGHT_CELLS,
  FLASH_LIGHT_PEAK_INTENSITY,
  FLASH_LIGHT_RANGE_CELLS,
  LightningSchedule,
  MIST_COLOR,
  MIST_EDGE_LOBES_A,
  MIST_EDGE_LOBES_B,
  MIST_EDGE_PHASE_A,
  MIST_EDGE_PHASE_B,
  MIST_EDGE_SOFTNESS,
  MIST_EDGE_WOBBLE,
  MIST_FADE_SECONDS,
  MIST_LAYERS,
  MIST_RADIUS_CELLS,
  approachEnvelope,
} from './dread.ts';

const TWO_PI = Math.PI * 2;

/**
 * Tessellation of one mist sheet: segments around, rings out from the centre.
 *
 * 48 around is what keeps the wobbled outline curved rather than polygonal at
 * the radius these sheets are drawn at; 6 rings is what keeps the alpha falloff
 * — which is interpolated linearly between rings — from banding. 288 vertices a
 * sheet, three sheets plus the glow, all sharing one geometry.
 */
const MIST_RADIAL_SEGMENTS = 48;
const MIST_RINGS = 6;

/**
 * Kinks in a bolt, and the phase each kink advances by.
 *
 * Seven kinks over ~13 cells is a jag every two cells: fewer reads as a bent
 * stick, many more reads as a fuzzy line at any real camera distance. The phase
 * step is deliberately not a rational fraction of 2π, so the seven kinks do not
 * fall into a repeating zigzag.
 */
const BOLT_SEGMENTS = 7;
const BOLT_JAG_TURN_RADIANS = 2.4;

/**
 * Draw order for everything in here.
 *
 * The sea is transparent too (render/water.ts) and it is ONE plane the size of
 * the world, so three sorts it by the distance to its centre — which is the
 * middle of the map, not the water under the monster. Left to the sort, mist a
 * cell above the surface can therefore be drawn first and then painted over by
 * the sea. A positive render order puts every sheet after it, unconditionally.
 */
const DREAD_RENDER_ORDER = 1;

const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

/**
 * Tracks the user's motion preference LIVE, the way the mana gauge does
 * (plugins/mana/client/ManaGauge.tsx): someone who turns it on mid-session must
 * not have to reload to stop the lightning.
 *
 * Falls back to "reduced" being false where matchMedia does not exist. That is
 * the honest default rather than the safe-looking one: the only environment in
 * this project without matchMedia is the node test runner, which draws nothing,
 * and defaulting to true there would let the effect's normal path go untested.
 */
function watchReducedMotion(): { matches(): boolean; stop(): void } {
  const query =
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia(REDUCED_MOTION_QUERY)
      : null;
  if (query === null) return { matches: () => false, stop: () => {} };

  let reduced = query.matches;
  const onChange = (event: MediaQueryListEvent): void => {
    reduced = event.matches;
  };
  query.addEventListener('change', onChange);
  return {
    matches: () => reduced,
    stop: () => query.removeEventListener('change', onChange),
  };
}

/** Radius multiplier of the wobbled outline at bearing `angle`. */
function edgeWobble(angle: number): number {
  return (
    1 +
    MIST_EDGE_WOBBLE *
      (Math.sin(MIST_EDGE_LOBES_A * angle + MIST_EDGE_PHASE_A) * 0.6 +
        Math.sin(MIST_EDGE_LOBES_B * angle + MIST_EDGE_PHASE_B) * 0.4)
  );
}

/**
 * One mist sheet: a horizontal disc in the XZ plane, opaque-ish at the centre
 * and vanishing at the rim.
 *
 * The falloff is per-vertex ALPHA rather than a texture or a shader. three
 * multiplies the material's opacity by the vertex colour when the colour
 * attribute carries four components, so one stock MeshBasicMaterial gives a soft
 * radial blob whose overall strength is still a single number the fade envelope
 * can drive — with no texture to load, no canvas to rasterise and no custom
 * shader to keep compiling.
 */
function buildMistGeometry(): BufferGeometry {
  const positions: number[] = [];
  const colors: number[] = [];
  const indices: number[] = [];

  // The centre vertex. RGB is left at 1 so the material's own colour rules; only
  // the alpha varies across the sheet.
  positions.push(0, 0, 0);
  colors.push(1, 1, 1, 1);

  for (let ring = 1; ring <= MIST_RINGS; ring++) {
    const out = ring / MIST_RINGS;
    const alpha = Math.pow(1 - out * out, MIST_EDGE_SOFTNESS);
    for (let side = 0; side < MIST_RADIAL_SEGMENTS; side++) {
      const angle = (side / MIST_RADIAL_SEGMENTS) * TWO_PI;
      const radius = MIST_RADIUS_CELLS * out * edgeWobble(angle);
      positions.push(radius * Math.cos(angle), 0, radius * Math.sin(angle));
      colors.push(1, 1, 1, alpha);
    }
  }

  // Inner fan, centre to the first ring.
  for (let side = 0; side < MIST_RADIAL_SEGMENTS; side++) {
    const here = 1 + side;
    const next = 1 + ((side + 1) % MIST_RADIAL_SEGMENTS);
    indices.push(0, next, here);
  }

  // Quads between consecutive rings.
  for (let ring = 1; ring < MIST_RINGS; ring++) {
    const inner = 1 + (ring - 1) * MIST_RADIAL_SEGMENTS;
    const outer = 1 + ring * MIST_RADIAL_SEGMENTS;
    for (let side = 0; side < MIST_RADIAL_SEGMENTS; side++) {
      const nextSide = (side + 1) % MIST_RADIAL_SEGMENTS;
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
 * descent from BOLT_TOP_CELLS down into the top of the mist.
 *
 * CROSSED, because one flat ribbon disappears when the camera comes round to its
 * edge — and the camera here is a free orbit, so that is not an edge case, it is
 * a quarter of all views. Two of them at 90° means one is always presenting a
 * face. Cheaper and steadier than billboarding, which would have to re-orient
 * the strip every frame against a camera this module has no access to.
 */
function buildBoltGeometry(): BufferGeometry {
  const positions: number[] = [];
  const indices: number[] = [];
  const span = BOLT_TOP_CELLS - BOLT_BOTTOM_CELLS;

  /** Emits one ribbon; `sideways` is which horizontal axis it spreads along. */
  function ribbon(sideways: 'x' | 'z'): void {
    const first = positions.length / 3;
    for (let step = 0; step <= BOLT_SEGMENTS; step++) {
      const along = step / BOLT_SEGMENTS;
      const y = BOLT_TOP_CELLS - along * span;
      const jag = BOLT_JAG_CELLS * Math.sin(step * BOLT_JAG_TURN_RADIANS);
      const halfWidth =
        (BOLT_WIDTH_CELLS * (1 - (1 - BOLT_TIP_WIDTH_FRACTION) * along)) / 2;
      for (const edge of [-1, 1]) {
        const offset = jag + edge * halfWidth;
        positions.push(
          sideways === 'x' ? offset : 0,
          y,
          sideways === 'z' ? offset : 0,
        );
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

/** One monster's weather. Positioned by the caller; animated by `update`. */
export interface Dread {
  /**
   * Put at the monster's world X/Z on the SEA SURFACE — not at the model's
   * origin, which sits at the lurking depth. Never rotated: mist does not turn
   * with the thing it hangs over.
   */
  readonly root: Group;

  /**
   * One frame. `seconds` is the plugin's animation clock, `dt` the frame step,
   * and `present` false once the monster is gone — which starts the fade-out and
   * stops any further lightning.
   */
  update(seconds: number, dt: number, present: boolean): void;

  /**
   * True once a retired instance has faded to nothing, i.e. it can be removed
   * from the scene and disposed. Also true for a fresh instance before its first
   * update, which is why only retired ones are ever asked.
   */
  isFaded(): boolean;

  /** Frees every geometry, material and light this instance owns. */
  dispose(): void;
}

export function createDread(): Dread {
  const root = new Group();
  root.name = 'monsters:dread';

  const mistGeometry = buildMistGeometry();
  const boltGeometry = buildBoltGeometry();

  const mistMaterials: MeshBasicMaterial[] = [];
  const mistSheets: Mesh[] = [];
  for (const layer of MIST_LAYERS) {
    const material = new MeshBasicMaterial({
      color: MIST_COLOR,
      transparent: true,
      // Starts invisible and fades in; the envelope owns this from frame one.
      opacity: 0,
      // Per-vertex alpha (buildMistGeometry) needs this; the vertex RGB is 1, so
      // the material's colour is what actually tints the sheet.
      vertexColors: true,
      // Visible from underneath, for a camera that has dipped toward the water.
      side: DoubleSide,
      // Depth TESTED so terrain and the monster occlude it, not depth WRITTEN so
      // the three sheets never cut each other or the model.
      depthWrite: false,
    });
    const sheet = new Mesh(mistGeometry, material);
    sheet.scale.setScalar(layer.radiusScale);
    sheet.position.y = layer.height;
    sheet.renderOrder = DREAD_RENDER_ORDER;
    root.add(sheet);
    mistMaterials.push(material);
    mistSheets.push(sheet);
  }

  /**
   * The flash's effect on the mist itself. The sheets are unlit, so the point
   * light below cannot reach them; this additive sheet through the middle of the
   * bank is what makes the fog light up from inside instead of sitting dead
   * while everything around it flares.
   */
  const glowMaterial = new MeshBasicMaterial({
    color: FLASH_COLOR,
    transparent: true,
    opacity: 0,
    vertexColors: true,
    side: DoubleSide,
    blending: AdditiveBlending,
    depthWrite: false,
  });
  const glowSheet = new Mesh(mistGeometry, glowMaterial);
  glowSheet.position.y = MIST_LAYERS[FLASH_GLOW_LAYER_INDEX]!.height;
  glowSheet.renderOrder = DREAD_RENDER_ORDER;
  glowSheet.visible = false;
  root.add(glowSheet);

  const boltMaterial = new MeshBasicMaterial({
    color: FLASH_COLOR,
    transparent: true,
    opacity: 0,
    side: DoubleSide,
    // The bolt is light, not a surface: it adds to whatever is behind it, the
    // same reasoning the eye haloes use (models.ts).
    blending: AdditiveBlending,
    depthWrite: false,
  });
  const bolt = new Mesh(boltGeometry, boltMaterial);
  bolt.renderOrder = DREAD_RENDER_ORDER;
  bolt.visible = false;
  /**
   * The bolt hangs off its own pivot so a strike is placed by moving ONE node —
   * and so its jag is authored once, in its own space, instead of being rebuilt
   * per strike.
   */
  const boltPivot = new Group();
  boltPivot.add(bolt);
  root.add(boltPivot);

  /**
   * The momentary light, added once and left in the scene at zero intensity
   * between strikes.
   *
   * ADDING OR REMOVING A LIGHT INVALIDATES EVERY MATERIAL'S SHADER PROGRAM: the
   * light count is baked into the program key, so three recompiles the terrain,
   * the water and the monster the next time each is drawn. Doing that per flash
   * would hitch the frame every ten seconds. Doing it twice per monster — at the
   * summoning and at the banishment — is a cost nobody can see.
   */
  const flashLight = new PointLight(FLASH_COLOR, 0, FLASH_LIGHT_RANGE_CELLS);
  flashLight.position.y = FLASH_LIGHT_HEIGHT_CELLS;
  root.add(flashLight);

  const reducedMotion = watchReducedMotion();
  const lightning = new LightningSchedule();
  /** 0 = gone, 1 = fully gathered. */
  let envelope = 0;

  return {
    root,

    update(seconds: number, dt: number, present: boolean): void {
      const reduced = reducedMotion.matches();

      // THE FADE. Under reduced motion it snaps: an opacity ramp is motion too,
      // and the requirement there is that the fog may stay, statically.
      const target = present ? 1 : 0;
      envelope = reduced
        ? target
        : approachEnvelope(envelope, target, dt, MIST_FADE_SECONDS);

      for (let index = 0; index < mistSheets.length; index++) {
        const layer = MIST_LAYERS[index]!;
        const sheet = mistSheets[index]!;
        mistMaterials[index]!.opacity = layer.opacity * envelope;
        // Nothing to draw at zero, and a transparent draw call that contributes
        // nothing is still a transparent draw call.
        sheet.visible = envelope > 0;
        if (reduced) {
          // The rest pose, re-asserted every frame rather than only on the
          // transition: the preference can be turned on at any moment, and this
          // is what puts a drifting bank back to still without a state machine.
          sheet.rotation.y = 0;
          sheet.position.y = layer.height;
          continue;
        }
        sheet.rotation.y = seconds * layer.spinHz * TWO_PI;
        sheet.position.y =
          layer.height + Math.sin(seconds * layer.bobHz * TWO_PI) * layer.bobCells;
      }

      // THE LIGHTNING. Armed only when the monster is here and the user has not
      // asked for less motion — which is the single `if` that makes "no flashes
      // at all under prefers-reduced-motion" true, rather than something every
      // value below has to remember.
      const strike = lightning.advance(dt, present && !reduced);
      if (strike !== null) {
        const distance =
          BOLT_MIN_RADIUS_CELLS +
          strike.reach * (BOLT_MAX_RADIUS_CELLS - BOLT_MIN_RADIUS_CELLS);
        const x = Math.cos(strike.bearing) * distance;
        const z = Math.sin(strike.bearing) * distance;
        boltPivot.position.set(x, 0, z);
        boltPivot.rotation.y = strike.yaw;
        flashLight.position.set(x, FLASH_LIGHT_HEIGHT_CELLS, z);
      }

      // The fade multiplies the flash as well, so a monster banished mid-strike
      // takes its lightning with it instead of leaving a bolt over empty water.
      const brightness = reduced ? 0 : lightning.brightness() * envelope;
      const lit = brightness > 0;
      bolt.visible = lit;
      glowSheet.visible = lit;
      if (lit) {
        boltMaterial.opacity = brightness;
        glowMaterial.opacity = brightness * FLASH_GLOW_OPACITY;
      }
      flashLight.intensity = brightness * FLASH_LIGHT_PEAK_INTENSITY;
    },

    isFaded(): boolean {
      return envelope <= 0;
    },

    dispose(): void {
      reducedMotion.stop();
      root.clear();
      mistGeometry.dispose();
      boltGeometry.dispose();
      for (const material of mistMaterials) material.dispose();
      glowMaterial.dispose();
      boltMaterial.dispose();
      // PointLight owns no GPU resource and has no dispose(); dropping it out of
      // the graph above is its whole teardown.
    },
  };
}
