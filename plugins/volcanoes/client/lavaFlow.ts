import {
  BufferAttribute,
  BufferGeometry,
  DoubleSide,
  Group,
  Mesh,
} from 'three';
import { NodeMaterial, type Node } from 'three/webgpu';
import {
  Discard,
  Fn,
  abs,
  attribute,
  cameraProjectionMatrix,
  clamp,
  dot,
  float,
  floor,
  fract,
  mix,
  modelViewMatrix,
  positionGeometry,
  pow,
  sin,
  smoothstep,
  uniform,
  vec2,
  vec3,
  vec4,
} from 'three/tsl';
import { radianceForDisplay } from '../../../client/src/render/displayRadiance.ts';
import { CELL_WORLD_SIZE, cellsAcross } from '@terrace/shared';
import {
  FLOW_RADIUS_WORLD_UNITS,
  LAVA_COOL_SECONDS,
  lavaKey,
  type LavaCellState,
} from '../protocol.ts';

export const LAVA_CELL_CAP = 192;

export const FLOW_RADIUS_CELLS = cellsAcross(FLOW_RADIUS_WORLD_UNITS);

export const FLOW_CORE_FRACTION = 0.45;

function edgeStrengthAt(distance: number): number {
  const inner = FLOW_RADIUS_CELLS * FLOW_CORE_FRACTION;
  if (distance <= inner) return 1;
  const t = (distance - inner) / (FLOW_RADIUS_CELLS - inner);
  return 1 - t * t * (3 - 2 * t);
}

interface FootprintOffset {
  readonly dx: number;
  readonly dy: number;
  readonly distance: number;
  readonly strength: number;
}

const FOOTPRINT_STENCIL: readonly FootprintOffset[] = (() => {
  const out: FootprintOffset[] = [];
  for (let dy = -FLOW_RADIUS_CELLS; dy <= FLOW_RADIUS_CELLS; dy++) {
    for (let dx = -FLOW_RADIUS_CELLS; dx <= FLOW_RADIUS_CELLS; dx++) {
      const distance = Math.hypot(dx, dy);
      if (distance > FLOW_RADIUS_CELLS) continue;
      out.push({ dx, dy, distance, strength: edgeStrengthAt(distance) });
    }
  }
  return out;
})();

export const LAVA_HOVER_HEIGHT = 0.019;

export const LAVA_VERTEX_CAP = 54_000;

export const LAVA_RENDER_ORDER = 1;

const LAVA_CRUST_RGB: readonly [number, number, number] = [0.043, 0.045, 0.052];
const LAVA_MOLTEN_RGB: readonly [number, number, number] = [1.0, 0.42, 0.06];
const LAVA_CORE_RGB: readonly [number, number, number] = [1.0, 0.8, 0.33];

const LAVA_PULSE_RATE = 0.9;
const LAVA_PULSE_DEPTH = 0.1;

const hash21 = Fn(([q]: [Node<'vec2'>]) => {
  const p = fract(q.mul(vec2(123.34, 456.21))).toVar();
  p.addAssign(dot(p, p.add(45.32)));
  return fract(p.x.mul(p.y));
}).setLayout({ name: 'lavaHash21', type: 'float', inputs: [{ name: 'q', type: 'vec2' }] });

const vnoise = Fn(([p]: [Node<'vec2'>]) => {
  const i = floor(p);
  const f = fract(p);
  const u = f.mul(f).mul(vec2(3.0).sub(f.mul(2.0)));
  const a = hash21(i);
  const b = hash21(i.add(vec2(1.0, 0.0)));
  const c = hash21(i.add(vec2(0.0, 1.0)));
  const d = hash21(i.add(vec2(1.0, 1.0)));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}).setLayout({ name: 'lavaNoise', type: 'float', inputs: [{ name: 'p', type: 'vec2' }] });

interface CoveredCell {
  x: number;
  y: number;
  distance: number;
  strength: number;
  birth: number;
  capY: number;
  hasCap: boolean;
}

interface FlowCell {
  readonly x: number;
  readonly y: number;
  readonly birth: number;
}

const LAVA_CAP_VERTICES = 6;
const LAVA_RISER_VERTICES = 6;
const LAVA_RISERS_PER_CELL = 2;
const LAVA_SLOT_VERTICES = LAVA_CAP_VERTICES + LAVA_RISERS_PER_CELL * LAVA_RISER_VERTICES;

const LAVA_CAP_OFFSET = 0;
const LAVA_RISER_X_OFFSET = LAVA_CAP_VERTICES;
const LAVA_RISER_Z_OFFSET = LAVA_CAP_VERTICES + LAVA_RISER_VERTICES;

const LAVA_SLOT_CAP = Math.floor(LAVA_VERTEX_CAP / LAVA_SLOT_VERTICES);

export type DrawnGroundAtCell = (cellX: number, cellY: number) => number | null;

export interface LavaFlowRenderer {
  readonly root: Group;
  replaceAll(cells: readonly LavaCellState[], elapsed: number, groundAt: DrawnGroundAtCell): void;
  apply(
    forgotten: ReadonlyArray<{ x: number; y: number }>,
    molten: readonly LavaCellState[],
    elapsed: number,
    groundAt: DrawnGroundAtCell,
  ): void;
  readonly pendingGround: boolean;
  retryPending(groundAt: DrawnGroundAtCell): void;
  update(elapsed: number): void;
  dispose(): void;
}

export function createLavaFlow(): LavaFlowRenderer {
  const root = new Group();
  root.name = 'volcanoes:flow';

  const positions = new Float32Array(LAVA_VERTEX_CAP * 3);
  const births = new Float32Array(LAVA_VERTEX_CAP);
  const strengths = new Float32Array(LAVA_VERTEX_CAP);

  const positionAttribute = new BufferAttribute(positions, 3);
  const birthAttribute = new BufferAttribute(births, 1);
  const strengthAttribute = new BufferAttribute(strengths, 1);
  const attributes = [positionAttribute, birthAttribute, strengthAttribute];

  const geometry = new BufferGeometry();
  geometry.setAttribute('position', positionAttribute);
  geometry.setAttribute('aBirth', birthAttribute);
  geometry.setAttribute('aStrength', strengthAttribute);
  geometry.setDrawRange(0, 0);

  const material = new NodeMaterial();
  material.transparent = false;
  material.depthWrite = true;
  material.alphaToCoverage = true;
  material.side = DoubleSide;

  const elapsedUniform = uniform(0);
  const aBirth = attribute<'float'>('aBirth', 'float');
  const aStrength = attribute<'float'>('aStrength', 'float');

  // Authored in world space, so position.xz is the world plan: the crust is continuous across cells.
  const vPlan = positionGeometry.xz;

  material.vertexNode = cameraProjectionMatrix.mul(modelViewMatrix).mul(vec4(positionGeometry, 1.0));

  material.fragmentNode = Fn(() => {
    Discard(aStrength.lessThanEqual(0.0));

    // The cooling curve, protocol.ts's heatFromAge restated: nothing is written per frame.
    const age = elapsedUniform.sub(aBirth);
    const heat = clamp(float(1.0).sub(age.div(LAVA_COOL_SECONDS)), 0.0, 1.0);

    // The crust: cold plates floating on molten rock; the glow shows between them.
    const plates = vnoise(vPlan.mul(2.6));
    const seam = float(1.0).sub(abs(plates.sub(0.5)).mul(2.0));

    // The veins narrow as it cools rather than the colour washing through brown: exponent 2 to 18.
    const veins = pow(seam, float(2.0).add(float(1.0).sub(heat).mul(16.0)));

    // A slow, shallow pulse, offset by position so a hillside breathes unevenly.
    const pulse = float(1.0).add(
      sin(elapsedUniform.mul(LAVA_PULSE_RATE).add(vPlan.x.mul(1.7)).add(vPlan.y.mul(1.3))).mul(
        LAVA_PULSE_DEPTH,
      ),
    );

    // Tightened so the surface is decisively crust or lava, keeping midtones out of the mud.
    const lit = smoothstep(0.12, 0.62, veins.mul(heat).mul(pulse));

    // The hottest seams glow through toward yellow.
    const color = mix(
      mix(vec3(...LAVA_CRUST_RGB), vec3(...LAVA_MOLTEN_RGB), lit),
      vec3(...LAVA_CORE_RGB),
      smoothstep(0.86, 1.0, lit).mul(0.7),
    );

    // Opaque matter: alpha is MSAA coverage, 1 across the body and easing to 0 at the rim.
    // The GLSL wrote display bytes straight to the framebuffer, bypassing tone mapping.
    return vec4(radianceForDisplay(color), aStrength);
  })();

  const mesh = new Mesh(geometry, material);
  mesh.name = 'volcanoes:flow:crust';
  mesh.renderOrder = LAVA_RENDER_ORDER;
  mesh.frustumCulled = false;
  root.add(mesh);

  const cells = new Map<number, FlowCell>();

  const covered = new Map<number, number>();
  const slotCell: CoveredCell[] = [];
  const freeSlots: number[] = [];
  let slotWatermark = 0;
  const pendingCells = new Set<number>();

  const dirtyKeys = new Set<number>();
  const dirtyX: number[] = [];
  const dirtyY: number[] = [];
  const dirtySlots = new Set<number>();
  const changedFlowX: number[] = [];
  const changedFlowY: number[] = [];
  const sortedSlots: number[] = [];

  let nearestFound = false;
  let nearestDistance = 0;
  let nearestStrength = 0;
  let nearestBirth = 0;

  function findNearestFlow(px: number, py: number): void {
    nearestFound = false;
    let bestKey = 0;
    for (const offset of FOOTPRINT_STENCIL) {
      const fx = px + offset.dx;
      const fy = py + offset.dy;
      if (fx < 0 || fy < 0) continue;
      const key = lavaKey(fx, fy);
      const flow = cells.get(key);
      if (flow === undefined) continue;
      if (nearestFound) {
        if (offset.distance > nearestDistance) continue;
        if (offset.distance === nearestDistance) {
          if (flow.birth > nearestBirth) continue;
          if (flow.birth === nearestBirth && key >= bestKey) continue;
        }
      }
      nearestFound = true;
      nearestDistance = offset.distance;
      nearestStrength = offset.strength;
      nearestBirth = flow.birth;
      bestKey = key;
    }
  }

  function markPlanCell(x: number, y: number): void {
    if (x < 0 || y < 0) return;
    const key = lavaKey(x, y);
    if (dirtyKeys.has(key)) return;
    dirtyKeys.add(key);
    dirtyX.push(x);
    dirtyY.push(y);
  }

  function markFlowDisc(fx: number, fy: number): void {
    for (const offset of FOOTPRINT_STENCIL) markPlanCell(fx + offset.dx, fy + offset.dy);
  }

  function takeSlot(): number {
    const reused = freeSlots.pop();
    if (reused !== undefined) return reused;
    if (slotWatermark >= LAVA_SLOT_CAP) return -1;
    const slot = slotWatermark++;
    if (slotCell[slot] === undefined) {
      slotCell[slot] = { x: 0, y: 0, distance: 0, strength: 0, birth: 0, capY: 0, hasCap: false };
    }
    return slot;
  }

  function writeVertex(
    index: number,
    x: number,
    y: number,
    z: number,
    birth: number,
    strength: number,
  ): void {
    positions[index * 3] = x;
    positions[index * 3 + 1] = y;
    positions[index * 3 + 2] = z;
    births[index] = birth;
    strengths[index] = strength;
  }

  function writeDegenerate(base: number, count: number, x: number, y: number, z: number): void {
    for (let i = 0; i < count; i++) writeVertex(base + i, x, y, z, 0, 0);
  }

  function writeRiser(
    base: number,
    cell: CoveredCell,
    neighbourX: number,
    neighbourY: number,
    edgeAX: number,
    edgeAZ: number,
    edgeBX: number,
    edgeBZ: number,
    normalX: number,
    normalZ: number,
    fallbackX: number,
    fallbackZ: number,
  ): void {
    const y = cell.capY;
    const neighbourSlot = covered.get(lavaKey(neighbourX, neighbourY));
    const neighbour = neighbourSlot === undefined ? undefined : slotCell[neighbourSlot];
    if (neighbour === undefined || !neighbour.hasCap || neighbour.capY === y) {
      writeDegenerate(base, LAVA_RISER_VERTICES, fallbackX, y, fallbackZ);
      return;
    }

    const neighbourCapY = neighbour.capY;
    const topY = Math.max(y, neighbourCapY);
    const bottomY = Math.min(y, neighbourCapY);
    const sign = y > neighbourCapY ? 1 : -1;
    const offsetX = normalX * LAVA_HOVER_HEIGHT * sign;
    const offsetZ = normalZ * LAVA_HOVER_HEIGHT * sign;

    const riserStrength = Math.min(cell.strength, neighbour.strength);
    if (riserStrength <= 0) {
      writeDegenerate(base, LAVA_RISER_VERTICES, fallbackX, y, fallbackZ);
      return;
    }
    const riserBirth = y > neighbourCapY ? cell.birth : neighbour.birth;

    const ax = edgeAX + offsetX;
    const az = edgeAZ + offsetZ;
    const bx = edgeBX + offsetX;
    const bz = edgeBZ + offsetZ;
    writeVertex(base, ax, topY, az, riserBirth, riserStrength);
    writeVertex(base + 1, bx, topY, bz, riserBirth, riserStrength);
    writeVertex(base + 2, bx, bottomY, bz, riserBirth, riserStrength);
    writeVertex(base + 3, ax, topY, az, riserBirth, riserStrength);
    writeVertex(base + 4, bx, bottomY, bz, riserBirth, riserStrength);
    writeVertex(base + 5, ax, bottomY, az, riserBirth, riserStrength);
  }

  function writeSlot(slot: number): void {
    const cell = slotCell[slot];
    if (cell === undefined) return;
    const base = slot * LAVA_SLOT_VERTICES;

    const half = CELL_WORLD_SIZE / 2;
    const x0 = cell.x * CELL_WORLD_SIZE - half;
    const x1 = x0 + CELL_WORLD_SIZE;
    const z0 = cell.y * CELL_WORLD_SIZE - half;
    const z1 = z0 + CELL_WORLD_SIZE;

    if (!cell.hasCap || cell.strength <= 0) {
      writeDegenerate(base + LAVA_CAP_OFFSET, LAVA_CAP_VERTICES, x0, cell.capY, z0);
      writeDegenerate(base + LAVA_RISER_X_OFFSET, LAVA_RISER_VERTICES, x0, cell.capY, z0);
      writeDegenerate(base + LAVA_RISER_Z_OFFSET, LAVA_RISER_VERTICES, x0, cell.capY, z0);
      return;
    }

    const y = cell.capY;
    const strength = cell.strength;
    const birth = cell.birth;

    const cap = base + LAVA_CAP_OFFSET;
    writeVertex(cap, x0, y, z0, birth, strength);
    writeVertex(cap + 1, x0, y, z1, birth, strength);
    writeVertex(cap + 2, x1, y, z1, birth, strength);
    writeVertex(cap + 3, x0, y, z0, birth, strength);
    writeVertex(cap + 4, x1, y, z1, birth, strength);
    writeVertex(cap + 5, x1, y, z0, birth, strength);

    writeRiser(base + LAVA_RISER_X_OFFSET, cell, cell.x + 1, cell.y, x1, z0, x1, z1, 1, 0, x0, z0);
    writeRiser(base + LAVA_RISER_Z_OFFSET, cell, cell.x, cell.y + 1, x1, z1, x0, z1, 0, 1, x0, z0);
  }

  function uploadDirtySlots(): void {
    sortedSlots.length = 0;
    for (const slot of dirtySlots) sortedSlots.push(slot);
    sortedSlots.sort((a, b) => a - b);

    for (const attribute of attributes) attribute.clearUpdateRanges();

    let i = 0;
    while (i < sortedSlots.length) {
      const start = sortedSlots[i]!;
      let end = start;
      while (i + 1 < sortedSlots.length && sortedSlots[i + 1] === end + 1) {
        i++;
        end++;
      }
      i++;
      const firstVertex = start * LAVA_SLOT_VERTICES;
      const vertexCount = (end - start + 1) * LAVA_SLOT_VERTICES;
      for (const attribute of attributes) {
        attribute.addUpdateRange(firstVertex * attribute.itemSize, vertexCount * attribute.itemSize);
      }
    }

    for (const attribute of attributes) attribute.needsUpdate = true;
  }

  function clearScratch(): void {
    dirtyKeys.clear();
    dirtyX.length = 0;
    dirtyY.length = 0;
    dirtySlots.clear();
  }

  function restamp(groundAt: DrawnGroundAtCell): void {
    for (let i = 0; i < dirtyX.length; i++) {
      const x = dirtyX[i]!;
      const y = dirtyY[i]!;
      const key = lavaKey(x, y);
      findNearestFlow(x, y);

      let slot = covered.get(key);

      if (!nearestFound) {
        if (slot === undefined) continue;
        const leaving = slotCell[slot]!;
        leaving.hasCap = false;
        leaving.strength = 0;
        covered.delete(key);
        pendingCells.delete(key);
        freeSlots.push(slot);
        dirtySlots.add(slot);
        continue;
      }

      if (slot === undefined) {
        slot = takeSlot();
        if (slot < 0) continue;
        covered.set(key, slot);
      }

      const entry = slotCell[slot]!;
      entry.x = x;
      entry.y = y;
      entry.distance = nearestDistance;
      entry.strength = nearestStrength;
      entry.birth = nearestBirth;

      const ground = groundAt(x, y);
      if (ground === null) {
        entry.hasCap = false;
        entry.capY = 0;
        pendingCells.add(key);
      } else {
        entry.hasCap = true;
        entry.capY = ground + LAVA_HOVER_HEIGHT;
        pendingCells.delete(key);
      }

      dirtySlots.add(slot);
    }

    for (let i = 0; i < dirtyX.length; i++) {
      const x = dirtyX[i]!;
      const y = dirtyY[i]!;
      if (x > 0) {
        const slot = covered.get(lavaKey(x - 1, y));
        if (slot !== undefined) dirtySlots.add(slot);
      }
      if (y > 0) {
        const slot = covered.get(lavaKey(x, y - 1));
        if (slot !== undefined) dirtySlots.add(slot);
      }
    }

    if (covered.size === 0) {
      slotWatermark = 0;
      freeSlots.length = 0;
      geometry.setDrawRange(0, 0);
      clearScratch();
      return;
    }

    for (const slot of dirtySlots) writeSlot(slot);

    geometry.setDrawRange(0, slotWatermark * LAVA_SLOT_VERTICES);
    uploadDirtySlots();
    clearScratch();
  }

  function remember(list: readonly LavaCellState[], elapsed: number): boolean {
    let changed = false;
    for (const cell of list) {
      const key = lavaKey(cell.x, cell.y);
      const birth = elapsed - cell.ageSeconds;
      const existing = cells.get(key);
      if (existing !== undefined && existing.birth >= birth) continue;
      if (existing === undefined && cells.size >= LAVA_CELL_CAP) continue;
      cells.set(key, { x: cell.x, y: cell.y, birth });
      changedFlowX.push(cell.x);
      changedFlowY.push(cell.y);
      changed = true;
    }
    return changed;
  }

  function drop(list: ReadonlyArray<{ x: number; y: number }>): boolean {
    let changed = false;
    for (const cell of list) {
      if (!cells.delete(lavaKey(cell.x, cell.y))) continue;
      changedFlowX.push(cell.x);
      changedFlowY.push(cell.y);
      changed = true;
    }
    return changed;
  }

  function markChangedFlow(): void {
    for (let i = 0; i < changedFlowX.length; i++) markFlowDisc(changedFlowX[i]!, changedFlowY[i]!);
  }

  return {
    root,

    replaceAll(list, elapsed, groundAt): void {
      for (const slot of covered.values()) {
        const entry = slotCell[slot]!;
        markPlanCell(entry.x, entry.y);
      }
      cells.clear();
      changedFlowX.length = 0;
      changedFlowY.length = 0;
      remember(list, elapsed);
      markChangedFlow();
      restamp(groundAt);
    },

    apply(forgotten, molten, elapsed, groundAt): void {
      changedFlowX.length = 0;
      changedFlowY.length = 0;
      const dropped = drop(forgotten);
      const taken = remember(molten, elapsed);
      if (!dropped && !taken) return;
      markChangedFlow();
      restamp(groundAt);
    },

    get pendingGround(): boolean {
      return pendingCells.size > 0;
    },

    retryPending(groundAt): void {
      if (pendingCells.size === 0) return;
      for (const key of pendingCells) {
        const slot = covered.get(key);
        if (slot === undefined) continue;
        const entry = slotCell[slot]!;
        markPlanCell(entry.x, entry.y);
      }
      restamp(groundAt);
    },

    update(elapsed): void {
      elapsedUniform.value = elapsed;
    },

    dispose(): void {
      geometry.dispose();
      material.dispose();
      root.clear();
      cells.clear();
      covered.clear();
      pendingCells.clear();
    },
  };
}
