import {
  BufferAttribute,
  BufferGeometry,
  DoubleSide,
  Group,
  Mesh,
  ShaderMaterial,
} from 'three';
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

const LAVA_CRUST_RGB = '0.043, 0.045, 0.052';
const LAVA_MOLTEN_RGB = '1.0, 0.42, 0.06';
const LAVA_CORE_RGB = '1.0, 0.80, 0.33';

const LAVA_PULSE_RATE = 0.9;
const LAVA_PULSE_DEPTH = 0.1;

const LAVA_VERTEX_SHADER =  `
  attribute float aBirth;
  attribute float aStrength;

  varying vec2 vPlan;
  varying float vBirth;
  varying float vStrength;

  void main() {
    // The geometry is authored in WORLD space, so position.xz IS the world
    // plan coordinate — which is what makes the crust pattern below continuous
    // across the whole flow instead of restarting in every cell.
    vPlan = position.xz;
    vBirth = aBirth;
    vStrength = aStrength;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const LAVA_NOISE_GLSL =  `
  float hash21(vec2 p) {
    p = fract(p * vec2(123.34, 456.21));
    p += dot(p, p + 45.32);
    return fract(p.x * p.y);
  }

  float vnoise(vec2 p) {
    vec2 i = floor(p);
    vec2 f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    float a = hash21(i);
    float b = hash21(i + vec2(1.0, 0.0));
    float c = hash21(i + vec2(0.0, 1.0));
    float d = hash21(i + vec2(1.0, 1.0));
    return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
  }
`;

const LAVA_FRAGMENT_SHADER =  `
  uniform float uElapsed;

  varying vec2 vPlan;
  varying float vBirth;
  varying float vStrength;

  ${LAVA_NOISE_GLSL}

  void main() {
    if (vStrength <= 0.0) discard;

    // THE COOLING CURVE, RUN IN THE SHADER — protocol.ts's heatFromAge, restated
    // in GLSL. This is why nothing is written per frame: aBirth is when this
    // cell went molten and uElapsed is now, so the heat falls out of one
    // subtraction and no buffer has to be touched as a flow goes out.
    float age = uElapsed - vBirth;
    float heat = clamp(1.0 - age / ${LAVA_COOL_SECONDS.toFixed(1)}, 0.0, 1.0);

    // THE CRUST. Cold plates floating on molten rock: the noise field is the
    // plates, and what shows between them is the glow.
    float plates = vnoise(vPlan * 2.6);
    float seam = 1.0 - abs(plates - 0.5) * 2.0;

    // THE VEINS NARROW AS IT COOLS, rather than the colour washing out — and
    // that is the whole reason there is no brown anywhere in this shader
    // (owner, 2026-08-27). Fading hot orange toward dark rock passes THROUGH
    // brown, and a flow spends most of its life in exactly that middle. So the
    // lit colour never changes; only how much of the surface is lit does. A
    // half-cooled flow is thin bright cracks on near-black, which is both what
    // the real thing looks like and the one version of it that is never muddy.
    //
    // The exponent runs 2 (fresh: broad rivers of lava with plates riding on
    // them) to 18 (cold: hairline seams), so what changes across a flow's life
    // is the AREA that is lit and never the colour of it.
    float veins = pow(seam, 2.0 + (1.0 - heat) * 16.0);

    // A slow, shallow pulse, offset by position so a hillside breathes unevenly
    // rather than strobing in unison. Lava is a heavy liquid with a skin that
    // breaks and heals; it does not flicker like flame.
    float pulse = 1.0 + ${LAVA_PULSE_DEPTH.toFixed(2)} *
      sin(uElapsed * ${LAVA_PULSE_RATE.toFixed(2)} + vPlan.x * 1.7 + vPlan.y * 1.3);

    // Tightened with a smoothstep so most of the surface is decisively crust or
    // decisively lava and the band between them is thin — the other half of
    // keeping the midtones out of the mud.
    float lit = smoothstep(0.12, 0.62, veins * heat * pulse);

    vec3 color = mix(vec3(${LAVA_CRUST_RGB}), vec3(${LAVA_MOLTEN_RGB}), lit);
    // The hottest seams glow through toward yellow, which is what stops a fresh
    // flow reading as a single flat orange.
    color = mix(color, vec3(${LAVA_CORE_RGB}), smoothstep(0.86, 1.0, lit) * 0.7);

    // OPAQUE MATTER, AND THE ALPHA IS COVERAGE. This is new ground: nothing it
    // buried should read through it, so the alpha here is never a see-through
    // factor. The material is opaque with alphaToCoverage on, so this value is
    // consumed as the FRACTION OF THE PIXEL'S MSAA SAMPLES the flow occupies —
    // 1 across the body of the flow, easing to 0 at the rim, which resolves to
    // a soft edge made of geometry coverage rather than of blending. Full
    // strength therefore writes a fully opaque pixel (the 0.96 that used to sit
    // here existed only to let the terrace lip read through, which the owner
    // settled against on 2026-09-01).
    gl_FragColor = vec4(color, vStrength);
  }
`;
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

  const material = new ShaderMaterial({
    uniforms: { uElapsed: { value: 0 } },
    vertexShader: LAVA_VERTEX_SHADER,
    fragmentShader: LAVA_FRAGMENT_SHADER,
    transparent: false,
    depthWrite: true,
    alphaToCoverage: true,
    side: DoubleSide,
  });

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
      material.uniforms.uElapsed!.value = elapsed;
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
