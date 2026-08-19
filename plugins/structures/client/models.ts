// Low-poly procedural buildings, drawn as INSTANCES — one InstancedMesh per
// (tier, part), exactly flora's "a tree is not an object" argument extended
// to six silhouettes instead of two.
//
// A building is a small fixed list of PARTS (a wall, a roof panel, a
// chimney...), each part pre-built as ONE geometry with one or more LOCAL
// transforms relative to the building's own origin (a mirrored roof panel is
// the same geometry placed twice, at +pitch and -pitch). Placing a whole
// building is: compose its own position/yaw/scale into a matrix once, then
// for every part, for every local transform, multiply the two together and
// write one instance. No per-part bookkeeping beyond that multiply — the
// shape of "a building" IS the list of (geometry, material, local transforms)
// triples, and nothing here cares what tier it belongs to beyond reading it
// off that list.
//
// SIX TIERS, EACH A DIFFERENT SILHOUETTE AND A DIFFERENT MATERIAL — the
// design brief's own bar, restated as a design table where every dimension
// and colour lives:
//
//   0 camp           canvas tent + campfire        lowest, roundest, warmest colour
//   1 hut             round wall + conical thatch   first solid drum
//   2 timber-house    box wall + gable roof         first hard edges (ridge roof)
//   3 longhouse       longer/lower box + chimney    widest footprint, low profile
//   4 stone-cottage   STONE wall + tile roof         first grey/stone material
//   5 watchtower      tall narrow tower + parapet    tallest, narrowest, first vertical silhouette
//
// Silhouette and material both move at every step — never scale alone — so
// the tiers stay legible from the game's orbit-camera distance the way
// flora's two tree kinds and monsters' three creatures do.
//
// The rules those plugins' models.ts files keep, kept here too: no textures,
// no per-object lights, no external assets, everything generated in this
// file, flat shading so a low-segment primitive reads as a deliberate
// faceted style rather than as low detail.

import {
  BoxGeometry,
  CanvasTexture,
  ConeGeometry,
  CylinderGeometry,
  Group,
  InstancedMesh,
  Matrix4,
  MeshLambertMaterial,
  Quaternion,
  SRGBColorSpace,
  Vector3,
  type BufferGeometry,
  type Material,
} from 'three';
import { STRUCTURES_CAP, STRUCTURE_TIER_COUNT, type StructureTier } from '../protocol.ts';
import { isDurandsCell } from './durands.ts';

// ── Shared build helpers ─────────────────────────────────────────────────────

const Z_AXIS = new Vector3(0, 0, 1);
const Y_AXIS = new Vector3(0, 1, 0);

function lambert(color: number, options: { emissive?: number } = {}): MeshLambertMaterial {
  return new MeshLambertMaterial({ color, flatShading: true, emissive: options.emissive ?? 0x000000 });
}

/** A matrix that only translates — the common case for a single-instance part. */
function at(x: number, y: number, z: number): Matrix4 {
  return new Matrix4().makeTranslation(x, y, z);
}

/**
 * The two local transforms for a symmetric gable roof panel: the SAME
 * geometry (a thin box whose local +X axis is its slope) placed once tilted
 * up-and-out to the right of the ridge and once to the left. Each side is
 * computed independently from its own (dx, dy) = (±halfSpan, -ridgeRise)
 * direction rather than derived from the other by a mirror formula — half
 * the arithmetic, and a bug in one side cannot silently be "the same bug,
 * mirrored" in the other.
 *
 * `halfSpan` is measured to the EAVE (wall half-width plus overhang), so the
 * panel's outer edge overhangs the wall exactly as far as a real eave would.
 */
function gableRoofPanelMatrices(halfSpan: number, ridgeRise: number, wallTopY: number): Matrix4[] {
  const matrices: Matrix4[] = [];
  for (const sign of [1, -1] as const) {
    const angle = Math.atan2(-ridgeRise, sign * halfSpan);
    const position = new Vector3((sign * halfSpan) / 2, wallTopY + ridgeRise / 2, 0);
    const rotation = new Quaternion().setFromAxisAngle(Z_AXIS, angle);
    matrices.push(new Matrix4().compose(position, rotation, new Vector3(1, 1, 1)));
  }
  return matrices;
}

/** Slope length of a gable roof panel — the box geometry's own length (local X). */
function gableSlopeLength(halfSpan: number, ridgeRise: number): number {
  return Math.hypot(halfSpan, ridgeRise);
}

// ── One building tier: a fixed list of (geometry, material, local transforms) ─

interface StructurePart {
  readonly geometry: BufferGeometry;
  readonly material: Material;
  /** One matrix per instance this part contributes, per building of this tier. */
  readonly localMatrices: Matrix4[];
}

function buildTierParts(): StructurePart[][] {
  const tiers: StructurePart[][] = [];

  // ── Tier 0: camp — a low canvas tent beside a campfire's ember glow. The
  // shortest, roundest-toned silhouette in the progression: nothing here
  // stands taller than half a cell.
  {
    const tentHeight = 0.55;
    const tent: StructurePart = {
      geometry: new ConeGeometry(0.42, tentHeight, 4),
      material: lambert(0xcbb994),
      localMatrices: [
        new Matrix4()
          .makeRotationY(Math.PI / 4)
          .premultiply(at(-0.16, tentHeight / 2, 0)),
      ],
    };
    const fireHeight = 0.16;
    const fire: StructurePart = {
      geometry: new ConeGeometry(0.08, fireHeight, 6),
      material: lambert(0x3a2010, { emissive: 0xd9540f }),
      localMatrices: [at(0.28, fireHeight / 2, 0.1)],
    };
    tiers.push([tent, fire]);
  }

  // ── Tier 1: hut — a round wattle-and-daub wall under a conical thatch
  // roof. First solid drum shape; still no hard edges anywhere on it.
  {
    const wallHeight = 0.5;
    const wall: StructurePart = {
      geometry: new CylinderGeometry(0.42, 0.44, wallHeight, 8),
      material: lambert(0x9c7a52),
      localMatrices: [at(0, wallHeight / 2, 0)],
    };
    const roofHeight = 0.42;
    const roof: StructurePart = {
      geometry: new ConeGeometry(0.52, roofHeight, 8),
      material: lambert(0xcaa645),
      localMatrices: [at(0, wallHeight + roofHeight / 2, 0)],
    };
    tiers.push([wall, roof]);
  }

  // ── Tier 2: timber-house — a squared log box under a peaked (gable) roof:
  // the first tier with hard edges anywhere on it.
  {
    const wallHeight = 0.55;
    const wallHalfWidth = 0.45;
    const wallDepth = 0.7;
    const wall: StructurePart = {
      geometry: new BoxGeometry(wallHalfWidth * 2, wallHeight, wallDepth),
      material: lambert(0x6b4a30),
      localMatrices: [at(0, wallHeight / 2, 0)],
    };
    const ridgeRise = 0.35;
    const eave = 0.08;
    const halfSpan = wallHalfWidth + eave;
    const roof: StructurePart = {
      geometry: new BoxGeometry(gableSlopeLength(halfSpan, ridgeRise), 0.05, wallDepth + eave * 2),
      material: lambert(0x8a3a2e),
      localMatrices: gableRoofPanelMatrices(halfSpan, ridgeRise, wallHeight),
    };
    tiers.push([wall, roof]);
  }

  // ── Tier 3: longhouse — longer and lower than the timber house (a
  // workshop's footprint, not its height), with a smoking chimney: the
  // widest silhouette in the whole progression.
  {
    const wallHeight = 0.48;
    const wallHalfWidth = 0.68;
    const wallDepth = 0.6;
    const wall: StructurePart = {
      geometry: new BoxGeometry(wallHalfWidth * 2, wallHeight, wallDepth),
      material: lambert(0x5a4028),
      localMatrices: [at(0, wallHeight / 2, 0)],
    };
    const ridgeRise = 0.28;
    const eave = 0.1;
    const halfSpan = wallHalfWidth + eave;
    const roof: StructurePart = {
      geometry: new BoxGeometry(gableSlopeLength(halfSpan, ridgeRise), 0.05, wallDepth + eave * 2),
      material: lambert(0x746558),
      localMatrices: gableRoofPanelMatrices(halfSpan, ridgeRise, wallHeight),
    };
    const chimneyHeight = 0.3;
    const chimney: StructurePart = {
      geometry: new BoxGeometry(0.1, chimneyHeight, 0.1),
      material: lambert(0x8b8b86),
      localMatrices: [at(wallHalfWidth * 0.55, wallHeight + ridgeRise * 0.5 + chimneyHeight / 2, 0)],
    };
    tiers.push([wall, roof, chimney]);
  }

  // ── Tier 4: stone-cottage — a STONE wall (first material break in the
  // progression) under a clay-tile roof, with a round chimney: semi-advanced
  // masonry, still a house.
  {
    const wallHeight = 0.6;
    const wallHalfWidth = 0.5;
    const wallDepth = 0.75;
    const wall: StructurePart = {
      geometry: new BoxGeometry(wallHalfWidth * 2, wallHeight, wallDepth),
      material: lambert(0x8b8b86),
      localMatrices: [at(0, wallHeight / 2, 0)],
    };
    const ridgeRise = 0.4;
    const eave = 0.09;
    const halfSpan = wallHalfWidth + eave;
    const roof: StructurePart = {
      geometry: new BoxGeometry(gableSlopeLength(halfSpan, ridgeRise), 0.05, wallDepth + eave * 2),
      material: lambert(0xb5502e),
      localMatrices: gableRoofPanelMatrices(halfSpan, ridgeRise, wallHeight),
    };
    const chimneyHeight = 0.4;
    const chimney: StructurePart = {
      geometry: new CylinderGeometry(0.07, 0.09, chimneyHeight, 6),
      material: lambert(0x77726c),
      localMatrices: [at(wallHalfWidth * 0.5, wallHeight + ridgeRise * 0.5 + chimneyHeight / 2, 0)],
    };
    tiers.push([wall, roof, chimney]);
  }

  // ── Tier 5: watchtower — a tall narrow stone tower with a parapet ring and
  // a slate roof. The one VERTICAL silhouette in the set: taller than every
  // other tier is wide, where every house tier is wider than it is tall.
  {
    const towerHeight = 1.55;
    const towerRadius = 0.3;
    const tower: StructurePart = {
      geometry: new CylinderGeometry(towerRadius, towerRadius * 1.08, towerHeight, 8),
      material: lambert(0x8b8b86),
      localMatrices: [at(0, towerHeight / 2, 0)],
    };
    const parapetHeight = 0.16;
    const parapet: StructurePart = {
      geometry: new CylinderGeometry(towerRadius + 0.1, towerRadius + 0.1, parapetHeight, 10),
      material: lambert(0x6f6a63),
      localMatrices: [at(0, towerHeight + parapetHeight / 2, 0)],
    };
    const roofHeight = 0.45;
    const roof: StructurePart = {
      geometry: new ConeGeometry(towerRadius + 0.06, roofHeight, 8),
      material: lambert(0x3a4a52),
      localMatrices: [at(0, towerHeight + parapetHeight + roofHeight / 2, 0)],
    };
    tiers.push([tower, parapet, roof]);
  }

  return tiers;
}

// ── Durand's: a cosmetic top-tier VARIANT ───────────────────────────────────
//
// At MAX_STRUCTURE_TIER, a deterministic ~1-in-6 slice of cells (see
// ./durands.ts) render as "Durand's" instead of the watchtower above: a
// two-storey saloon in the same low-poly, flat-shaded, no-external-asset
// style as every tier above, plus one deliberate exception — a small sign
// carrying real text. Everything else in this file draws text-free
// primitives by design (see the file banner); the sign is the one place
// that rule is bent, and only because the brief asks for a NAMED building,
// which no combination of boxes and cones can spell out on its own.
//
// The text is a CanvasTexture drawn ONCE at module init (below), not per
// building: every Durand's sign shows the identical string, so one canvas
// and one texture are shared by every instance the same way one geometry
// already is. That is also what keeps the sign INSTANCED rather than
// forcing a non-instanced mesh per building — the usual reason a texture
// breaks instancing (a different image per instance) does not apply here,
// because there is only ever one image.

/** Canvas the sign text is rasterised into. Proportioned for a short word. */
const DURANDS_SIGN_CANVAS_WIDTH = 512;
const DURANDS_SIGN_CANVAS_HEIGHT = 128;

/** The sign's text. Drawn once; never assembled from a per-instance string. */
const DURANDS_SIGN_TEXT = "Durand's";

/**
 * `bold <px> sans-serif` — the canvas default generic family, deliberately:
 * the brief calls for no external font assets, and `sans-serif` resolves to
 * whatever the platform ships rather than a font this bundle would have to
 * carry. `bold` is load-bearing at this resolution — the regular weight's
 * thin strokes alias badly once minified onto a low-poly board this small.
 */
const DURANDS_SIGN_FONT = 'bold 84px sans-serif';

/** Dark red-brown board and warm gold-leaf lettering — a saloon sign's usual palette. */
const DURANDS_SIGN_BOARD_COLOR = '#3a1610';
const DURANDS_SIGN_TEXT_COLOR = '#f2c85b';

/**
 * Draws the sign once and returns its texture. Called exactly once, at
 * module init (the module-scope `const` just below), per the brief.
 */
function buildDurandsSignTexture(): CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = DURANDS_SIGN_CANVAS_WIDTH;
  canvas.height = DURANDS_SIGN_CANVAS_HEIGHT;

  const context = canvas.getContext('2d');
  if (context !== null) {
    context.fillStyle = DURANDS_SIGN_BOARD_COLOR;
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = DURANDS_SIGN_TEXT_COLOR;
    context.font = DURANDS_SIGN_FONT;
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.fillText(DURANDS_SIGN_TEXT, canvas.width / 2, canvas.height / 2);
  }
  // A null 2D context (no canvas support at all) leaves the canvas blank
  // rather than throwing at module init, which would take the whole plugin
  // down with it — a blank sign board is a cosmetic miss, not a crash.

  const texture = new CanvasTexture(canvas);
  texture.colorSpace = SRGBColorSpace;
  return texture;
}

/** Built once, at module init — every Durand's sign instance shares this texture. */
const DURANDS_SIGN_TEXTURE = buildDurandsSignTexture();

/**
 * Seconds for one full flash cycle (dim → bright → dim). ~0.625 Hz.
 *
 * Bounded well under 3 Hz deliberately: weather/client/sky.ts's own lightning
 * flash and monsters/client/dread.ts's own strike both cite the same ceiling
 * — the photosensitive-seizure threshold most style guides (WCAG among them)
 * draw the line at. This sign is a continuous, LOW-frequency pulse rather
 * than a rare strobe, so unlike those two effects it does not need its own
 * prefers-reduced-motion gate: at this period there is nothing to reduce.
 */
export const DURANDS_SIGN_FLASH_PERIOD_SECONDS = 1.6;

/** Warm gold — the same hue as the sign's painted lettering, so the glow reads as the letters lighting up rather than a stage light hitting the board. */
const DURANDS_SIGN_EMISSIVE_COLOR = 0xf2c85b;

/**
 * Emissive intensity bounds the flash pulses between. The minimum is not
 * zero: at 0 the board still reads as painted wood under the scene's own
 * lights (see MeshLambertMaterial below), so "dark" is "unlit sign", not
 * "invisible sign". The maximum (matches relics/client/index.ts's own
 * GEM_EMISSIVE_INTENSITY reasoning) is high enough to read as lit against
 * shaded terrain without ACES tone-mapping blowing the lettering to white.
 */
const DURANDS_SIGN_EMISSIVE_MIN = 0.05;
const DURANDS_SIGN_EMISSIVE_MAX = 1.4;

/** One full turn, for turning a period in seconds into an angular rate. */
const DURANDS_TWO_PI = Math.PI * 2;

/** A saloon building plus its flashing sign, and the sign's material (animate() needs a handle to pulse it). */
interface DurandsBuilding {
  readonly parts: StructurePart[];
  readonly signMaterial: MeshLambertMaterial;
}

/**
 * Builds Durand's part list: a two-storey box building — dark red-brown
 * ground floor, a lighter warm-red jettied (overhanging) second storey, a
 * deep-red false front rising above the roofline, a porch roof on two tan
 * posts, and the sign mounted proud of the false front. Same "list of
 * (geometry, material, local transforms)" shape every other tier keeps
 * (see the file banner) — Durand's is not a special case to the instancer
 * below, only to this function.
 */
function buildDurandsParts(): DurandsBuilding {
  const groundFloorHeight = 0.55;
  const groundHalfWidth = 0.42;
  const groundDepth = 0.55;
  const groundFloor: StructurePart = {
    geometry: new BoxGeometry(groundHalfWidth * 2, groundFloorHeight, groundDepth),
    material: lambert(0x7a2a20),
    localMatrices: [at(0, groundFloorHeight / 2, 0)],
  };

  // Jettied (overhanging) second storey — a classic saloon/frontier detail:
  // wider than the floor beneath it, not merely stacked on top of it.
  const secondFloorHeight = 0.45;
  const secondHalfWidth = 0.46;
  const secondDepth = 0.55;
  const secondFloor: StructurePart = {
    geometry: new BoxGeometry(secondHalfWidth * 2, secondFloorHeight, secondDepth),
    material: lambert(0x8f3325),
    localMatrices: [at(0, groundFloorHeight + secondFloorHeight / 2, 0)],
  };

  // False front: a flat parapet standing proud of the roofline, flush with
  // the second storey's front face — the silhouette that makes a saloon read
  // as a saloon rather than as a plain box house.
  const falseFrontHeight = 0.28;
  const falseFrontDepth = 0.06;
  const falseFrontY = groundFloorHeight + secondFloorHeight + falseFrontHeight / 2;
  const falseFrontZ = secondDepth / 2 + falseFrontDepth / 2;
  const falseFront: StructurePart = {
    geometry: new BoxGeometry(secondHalfWidth * 2, falseFrontHeight, falseFrontDepth),
    material: lambert(0x9c2b1e),
    localMatrices: [at(0, falseFrontY, falseFrontZ)],
  };

  // Porch roof and its two support posts, overhanging the ground floor's
  // front face.
  const porchDepth = 0.32;
  const porchThickness = 0.05;
  const porchHalfWidth = groundHalfWidth + 0.05;
  const porchZ = groundDepth / 2 + porchDepth / 2;
  const porchRoof: StructurePart = {
    geometry: new BoxGeometry(porchHalfWidth * 2, porchThickness, porchDepth),
    material: lambert(0x4a2015),
    localMatrices: [at(0, groundFloorHeight, porchZ)],
  };

  const postInset = 0.05;
  const postX = porchHalfWidth - postInset;
  const postZ = groundDepth / 2 + porchDepth - postInset;
  const porchPosts: StructurePart = {
    geometry: new CylinderGeometry(0.03, 0.03, groundFloorHeight, 6),
    material: lambert(0xac8a55),
    localMatrices: [at(postX, groundFloorHeight / 2, postZ), at(-postX, groundFloorHeight / 2, postZ)],
  };

  // The sign: mounted proud of the false front's own face so it never
  // z-fights with the board behind it, at a height a passer-by would
  // actually look up and read.
  const signHalfWidth = 0.32;
  const signHalfHeight = 0.08;
  const signThickness = 0.02;
  const signGap = 0.01;
  const signY = groundFloorHeight + secondFloorHeight + falseFrontHeight * 0.5;
  const signZ = falseFrontZ + falseFrontDepth / 2 + signThickness / 2 + signGap;
  const signMaterial = new MeshLambertMaterial({
    map: DURANDS_SIGN_TEXTURE,
    flatShading: true,
    emissive: DURANDS_SIGN_EMISSIVE_COLOR,
    emissiveIntensity: DURANDS_SIGN_EMISSIVE_MIN,
  });
  const sign: StructurePart = {
    geometry: new BoxGeometry(signHalfWidth * 2, signHalfHeight * 2, signThickness),
    material: signMaterial,
    localMatrices: [at(0, signY, signZ)],
  };

  return { parts: [groundFloor, secondFloor, falseFront, porchRoof, porchPosts, sign], signMaterial };
}

// ── Instancing ────────────────────────────────────────────────────────────────

/** Where one structure stands and how it varies. World units; y is the ground. */
export interface StructurePlacement {
  readonly x: number;
  readonly z: number;
  readonly groundY: number;
  readonly tier: StructureTier;
  readonly scale: number;
  readonly yaw: number;
}

export interface StructureModels {
  readonly root: Group;
  apply(placements: readonly StructurePlacement[]): void;
  /** Advances the Durand's sign flash by `dt` seconds. A no-op otherwise — nothing else in this plugin animates per-frame. */
  animate(dt: number): void;
  dispose(): void;
}

export function createStructureModels(): StructureModels {
  const tierParts = buildTierParts();
  if (tierParts.length !== STRUCTURE_TIER_COUNT) {
    // Defensive: a mismatch here means a tier was added to the wire contract
    // (protocol.ts) without a matching model, which would silently drop that
    // tier's buildings from the scene rather than fail loudly at boot.
    throw new Error(`structures: built ${tierParts.length} tier models, expected ${STRUCTURE_TIER_COUNT}`);
  }

  const geometries: BufferGeometry[] = [];
  const materials: Material[] = [];
  const root = new Group();
  root.name = 'structures:buildings';

  // One InstancedMesh per (tier, part), capacity = STRUCTURES_CAP × however
  // many instances that part contributes per building (1, or 2 for a
  // mirrored roof panel). Every mesh assumes the worst case — every standing
  // structure is this tier — the same over-allocate-once trade flora makes
  // for its per-kind meshes.
  const meshesByTier: InstancedMesh[][] = tierParts.map((parts) =>
    parts.map((part) => {
      geometries.push(part.geometry);
      materials.push(part.material);
      const mesh = new InstancedMesh(part.geometry, part.material, STRUCTURES_CAP * part.localMatrices.length);
      mesh.count = 0;
      root.add(mesh);
      return mesh;
    }),
  );

  // Durand's own InstancedMesh set, built and capacity-allocated exactly like
  // a seventh tier's would be, but kept OUT of tierParts/meshesByTier: it is
  // not tier 6 on the wire (there is no tier 6 — MAX_STRUCTURE_TIER is still
  // 5), only a skin `apply()` below picks in place of tier 5's own meshes for
  // the cells ./durands.ts selects. Capacity is STRUCTURES_CAP again rather
  // than STRUCTURES_CAP / 6: the ~1-in-6 share is an average over many cells,
  // not a per-world guarantee, and the server's own STRUCTURES_CAP is the
  // only bound this client can rely on without risking `count` outrunning
  // `mesh.instanceMatrix` in some adversarial-but-legal cell layout.
  const durands = buildDurandsParts();
  const durandsMeshes: InstancedMesh[] = durands.parts.map((part) => {
    geometries.push(part.geometry);
    materials.push(part.material);
    const mesh = new InstancedMesh(part.geometry, part.material, STRUCTURES_CAP * part.localMatrices.length);
    mesh.count = 0;
    root.add(mesh);
    return mesh;
  });

  // Scratch objects, reused across every instance of every rebuild — the same
  // discipline flora's apply() keeps, for the same reason (a rebuild fires on
  // every founding, upgrade and demolition; per-instance allocation would
  // churn hundreds of short-lived objects on every one of those).
  const buildingPosition = new Vector3();
  const buildingRotation = new Quaternion();
  const buildingScale = new Vector3();
  const buildingMatrix = new Matrix4();
  const instanceMatrix = new Matrix4();

  /** Seconds since attach — the only state animate() advances. */
  let durandsFlashElapsedSeconds = 0;

  /**
   * Writes one building's instances into `meshes`, part by part, advancing
   * `counts` (one slot per part, mutated in place — the caller owns the
   * array and reads it back after every placement in this apply() pass).
   * Shared by both the per-tier path and the Durand's path below so the two
   * do not carry two copies of the same nested loop.
   */
  function writeInstances(parts: StructurePart[], meshes: InstancedMesh[], counts: number[]): void {
    for (let partIndex = 0; partIndex < parts.length; partIndex++) {
      const part = parts[partIndex];
      const mesh = meshes[partIndex];
      let count = counts[partIndex];
      // Capacity (STRUCTURES_CAP × localMatrices.length, see the allocation
      // above) covers every placement the caller can hand in: the
      // server-side registry itself never exceeds STRUCTURES_CAP structures,
      // so `count` cannot outrun `mesh.instanceMatrix`.
      for (const local of part.localMatrices) {
        instanceMatrix.multiplyMatrices(buildingMatrix, local);
        mesh.setMatrixAt(count++, instanceMatrix);
      }
      counts[partIndex] = count;
    }
  }

  /** Finalises one mesh list after a full apply() pass: instance count, upload flag, and a fresh bounding sphere. */
  function finalizeMeshes(meshes: InstancedMesh[], counts: number[]): void {
    for (let partIndex = 0; partIndex < meshes.length; partIndex++) {
      const mesh = meshes[partIndex];
      mesh.count = counts[partIndex];
      mesh.instanceMatrix.needsUpdate = true;
      // MANDATORY, not tidiness — see flora's identical call: an
      // InstancedMesh's cached bounding sphere is stale after any matrix
      // change, and frustum culling against a stale sphere makes a building
      // vanish when the camera moves.
      mesh.computeBoundingSphere();
    }
  }

  return {
    root,

    apply(placements: readonly StructurePlacement[]): void {
      const counts = meshesByTier.map((parts) => parts.map(() => 0));
      const durandsCounts = durandsMeshes.map(() => 0);

      for (const placement of placements) {
        buildingPosition.set(placement.x, placement.groundY, placement.z);
        buildingRotation.setFromAxisAngle(Y_AXIS, placement.yaw);
        buildingScale.setScalar(placement.scale);
        buildingMatrix.compose(buildingPosition, buildingRotation, buildingScale);

        // isDurandsCell's own contract gates this to MAX_STRUCTURE_TIER (see
        // ./durands.ts) — nothing below the top tier can ever come back true.
        if (isDurandsCell(placement.tier, placement.x, placement.z)) {
          writeInstances(durands.parts, durandsMeshes, durandsCounts);
          continue;
        }

        const parts = tierParts[placement.tier];
        const meshes = meshesByTier[placement.tier];
        if (parts === undefined || meshes === undefined) continue; // defensive: unknown tier, dropped rather than crashing the frame
        writeInstances(parts, meshes, counts[placement.tier]);
      }

      for (let tier = 0; tier < meshesByTier.length; tier++) finalizeMeshes(meshesByTier[tier], counts[tier]);
      finalizeMeshes(durandsMeshes, durandsCounts);
    },

    animate(dt: number): void {
      durandsFlashElapsedSeconds += dt;
      const angle = durandsFlashElapsedSeconds * (DURANDS_TWO_PI / DURANDS_SIGN_FLASH_PERIOD_SECONDS);
      const t = (Math.sin(angle) + 1) / 2; // remap sin's [-1, 1] to [0, 1]
      durands.signMaterial.emissiveIntensity =
        DURANDS_SIGN_EMISSIVE_MIN + t * (DURANDS_SIGN_EMISSIVE_MAX - DURANDS_SIGN_EMISSIVE_MIN);
    },

    dispose(): void {
      for (const parts of meshesByTier) for (const mesh of parts) mesh.dispose();
      for (const mesh of durandsMeshes) mesh.dispose();
      for (const geometry of geometries) geometry.dispose();
      for (const material of materials) material.dispose();
      root.clear();
    },
  };
}
