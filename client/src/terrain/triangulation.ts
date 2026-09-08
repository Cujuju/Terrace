import { CHUNK_SIZE } from '@terrace/shared';
import { RECT_NONE, samePoint, type ContourLoop, type ContourPoint } from './contours.ts';

const BRIDGE_SEARCH_LIMIT = 64;

const BRIDGE_SLIT_WIDTH = 1e-6;

function signedArea(loop: ContourLoop): number {
  let sum = 0;
  for (let i = 0; i < loop.length; i++) {
    const a = loop[i];
    const b = loop[(i + 1) % loop.length];
    sum += a.x * b.z - b.x * a.z;
  }
  return sum / 2;
}

function pointInLoop(px: number, pz: number, loop: ContourLoop): boolean {
  let inside = false;
  for (let i = 0, j = loop.length - 1; i < loop.length; j = i++) {
    const a = loop[i];
    const b = loop[j];
    if (a.z > pz !== b.z > pz) {
      const t = (pz - a.z) / (b.z - a.z);
      if (px < a.x + t * (b.x - a.x)) inside = !inside;
    }
  }
  return inside;
}

function turn(ax: number, az: number, bx: number, bz: number, cx: number, cz: number): number {
  return (bx - ax) * (cz - az) - (bz - az) * (cx - ax);
}

function pointInTriangle(
  ax: number,
  az: number,
  bx: number,
  bz: number,
  cx: number,
  cz: number,
  px: number,
  pz: number,
): boolean {
  const d1 = turn(ax, az, bx, bz, px, pz);
  const d2 = turn(bx, bz, cx, cz, px, pz);
  const d3 = turn(cx, cz, ax, az, px, pz);
  const anyNegative = d1 < 0 || d2 < 0 || d3 < 0;
  const anyPositive = d1 > 0 || d2 > 0 || d3 > 0;
  return !(anyNegative && anyPositive);
}

function seesPoint(loop: ContourLoop, i: number, px: number, pz: number): boolean {
  const n = loop.length;
  const a = loop[i];
  const prev = loop[(i + n - 1) % n];
  const next = loop[(i + 1) % n];
  if (turn(prev.x, prev.z, a.x, a.z, next.x, next.z) > 0) {
    return (
      turn(a.x, a.z, px, pz, next.x, next.z) <= 0 &&
      turn(a.x, a.z, prev.x, prev.z, px, pz) <= 0
    );
  }
  return (
    turn(a.x, a.z, px, pz, prev.x, prev.z) > 0 ||
    turn(a.x, a.z, next.x, next.z, px, pz) > 0
  );
}

function segmentsCross(
  a: ContourPoint,
  b: ContourPoint,
  c: ContourPoint,
  d: ContourPoint,
): boolean {
  const d1 = turn(a.x, a.z, b.x, b.z, c.x, c.z);
  const d2 = turn(a.x, a.z, b.x, b.z, d.x, d.z);
  const d3 = turn(c.x, c.z, d.x, d.z, a.x, a.z);
  const d4 = turn(c.x, c.z, d.x, d.z, b.x, b.z);
  return d1 * d2 < 0 && d3 * d4 < 0;
}

export function bridgeHole(outer: ContourLoop, hole: ContourLoop): ContourLoop {
  let holeIndex = 0;
  for (let j = 1; j < hole.length; j++) {
    if (hole[j].x > hole[holeIndex].x) holeIndex = j;
  }
  const hx = hole[holeIndex].x;
  const hz = hole[holeIndex].z;

  let hitX = Infinity;
  let outerIndex = -1;
  for (let i = 0; i < outer.length; i++) {
    const a = outer[i];
    const b = outer[(i + 1) % outer.length];
    if (a.z === b.z) continue;
    if (hz < Math.min(a.z, b.z) || hz > Math.max(a.z, b.z)) continue;
    const x = a.x + ((hz - a.z) / (b.z - a.z)) * (b.x - a.x);
    if (x < hx || x >= hitX) continue;
    hitX = x;
    outerIndex = a.x > b.x ? i : (i + 1) % outer.length;
  }
  if (outerIndex >= 0) {
    const mx = outer[outerIndex].x;
    const mz = outer[outerIndex].z;
    let bestTangent = Infinity;
    for (let i = 0; i < outer.length; i++) {
      if (i === outerIndex) continue;
      const p = outer[i];
      if (p.x <= hx || p.x > mx) continue;
      if (!pointInTriangle(hx, hz, hitX, hz, mx, mz, p.x, p.z)) continue;
      if (!seesPoint(outer, i, hx, hz)) continue;
      const tangent = Math.abs(hz - p.z) / (p.x - hx);
      if (tangent < bestTangent || (tangent === bestTangent && p.x < outer[outerIndex].x)) {
        bestTangent = tangent;
        outerIndex = i;
      }
    }
  }

  const clear = (i: number, j: number): boolean => {
    const a = outer[i];
    const b = hole[j];
    for (let k = 0; k < outer.length; k++) {
      if (segmentsCross(a, b, outer[k], outer[(k + 1) % outer.length])) return false;
    }
    for (let k = 0; k < hole.length; k++) {
      if (segmentsCross(a, b, hole[k], hole[(k + 1) % hole.length])) return false;
    }
    return true;
  };

  if (outerIndex < 0 || !clear(outerIndex, holeIndex)) {
    const candidates: { outerIndex: number; holeIndex: number; distance: number }[] = [];
    for (let i = 0; i < outer.length; i++) {
      for (let j = 0; j < hole.length; j++) {
        candidates.push({
          outerIndex: i,
          holeIndex: j,
          distance: (outer[i].x - hole[j].x) ** 2 + (outer[i].z - hole[j].z) ** 2,
        });
      }
    }
    candidates.sort((a, b) => a.distance - b.distance);
    let found = false;
    for (const candidate of candidates.slice(0, BRIDGE_SEARCH_LIMIT)) {
      if (!clear(candidate.outerIndex, candidate.holeIndex)) continue;
      outerIndex = candidate.outerIndex;
      holeIndex = candidate.holeIndex;
      found = true;
      break;
    }
    if (!found && outerIndex < 0) {
      outerIndex = candidates[0].outerIndex;
      holeIndex = candidates[0].holeIndex;
    }
  }

  const bridgeX = outer[outerIndex].x - hole[holeIndex].x;
  const bridgeZ = outer[outerIndex].z - hole[holeIndex].z;
  const bridgeLength = Math.hypot(bridgeX, bridgeZ) || 1;
  const slitX = (-bridgeZ / bridgeLength) * BRIDGE_SLIT_WIDTH;
  const slitZ = (bridgeX / bridgeLength) * BRIDGE_SLIT_WIDTH;

  const merged: ContourLoop = [];
  for (let i = 0; i <= outerIndex; i++) merged.push(outer[i]);
  for (let j = 0; j < hole.length; j++) {
    merged.push(hole[(holeIndex + j) % hole.length]);
  }
  merged.push({
    x: hole[holeIndex].x + slitX,
    z: hole[holeIndex].z + slitZ,
    rect: RECT_NONE,
  });
  merged.push({
    x: outer[outerIndex].x + slitX,
    z: outer[outerIndex].z + slitZ,
    rect: RECT_NONE,
  });
  for (let i = outerIndex + 1; i < outer.length; i++) merged.push(outer[i]);
  return merged;
}

export function earClip(
  polygon: ContourLoop,
  emit: (a: ContourPoint, b: ContourPoint, c: ContourPoint) => void,
): void {
  const pending: ContourLoop[] = [polygon];
  let splits = 0;
  while (pending.length > 0) {
    const poly = pending.pop() as ContourLoop;
    const stalled = clipEars(poly, emit);
    if (stalled === null) continue;
    if (splits >= EAR_CLIP_SPLIT_LIMIT) continue;
    const halves = splitPolygon(stalled);
    if (halves === null) continue;
    splits++;
    pending.push(halves[0], halves[1]);
  }
}

const EAR_CLIP_SPLIT_LIMIT = 64;

const COLLINEAR_TOUCH_EPSILON = 1e-9;

function clipEars(
  polygon: ContourLoop,
  emit: (a: ContourPoint, b: ContourPoint, c: ContourPoint) => void,
): ContourLoop | null {
  const n = polygon.length;
  if (n < 3) return null;
  const live: number[] = [];
  for (let i = 0; i < n; i++) live.push(i);

  let guard = n * n + n;
  while (live.length > 3 && guard-- > 0) {
    let clipped = false;
    for (let k = 0; k < live.length; k++) {
      const a = polygon[live[(k + live.length - 1) % live.length]];
      const b = polygon[live[k]];
      const c = polygon[live[(k + 1) % live.length]];
      if (turn(a.x, a.z, b.x, b.z, c.x, c.z) <= 0) continue;
      let blocked = false;
      for (let m = 0; m < live.length; m++) {
        if (
          m === k ||
          m === (k + live.length - 1) % live.length ||
          m === (k + 1) % live.length
        ) {
          continue;
        }
        const p = polygon[live[m]];
        if (
          turn(a.x, a.z, b.x, b.z, p.x, p.z) >= 0 &&
          turn(b.x, b.z, c.x, c.z, p.x, p.z) >= 0 &&
          turn(c.x, c.z, a.x, a.z, p.x, p.z) >= 0
        ) {
          blocked = true;
          break;
        }
      }
      if (blocked) continue;
      emit(a, b, c);
      live.splice(k, 1);
      clipped = true;
      break;
    }
    if (!clipped) break;
  }
  if (live.length === 3) {
    emit(polygon[live[0]], polygon[live[1]], polygon[live[2]]);
    return null;
  }
  if (live.length < 3) return null;
  return live.map((index) => polygon[index]);
}

function splitPolygon(polygon: ContourLoop): [ContourLoop, ContourLoop] | null {
  const n = polygon.length;
  for (let i = 0; i < n; i++) {
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue;
      const a = polygon[i];
      const b = polygon[j];
      if (samePoint(a, b)) continue;
      let blocked = false;
      for (let k = 0; k < n && !blocked; k++) {
        const c = polygon[k];
        const d = polygon[(k + 1) % n];
        if (segmentsCross(a, b, c, d)) blocked = true;
      }
      if (blocked) continue;
      for (let k = 0; k < n && !blocked; k++) {
        if (k === i || k === j) continue;
        const p = polygon[k];
        if (Math.abs(turn(a.x, a.z, b.x, b.z, p.x, p.z)) > COLLINEAR_TOUCH_EPSILON) {
          continue;
        }
        const withinX = p.x >= Math.min(a.x, b.x) && p.x <= Math.max(a.x, b.x);
        const withinZ = p.z >= Math.min(a.z, b.z) && p.z <= Math.max(a.z, b.z);
        if (withinX && withinZ) blocked = true;
      }
      if (blocked) continue;
      const midX = (a.x + b.x) / 2;
      const midZ = (a.z + b.z) / 2;
      if (!pointInLoop(midX, midZ, polygon)) continue;
      const first = polygon.slice(i, j + 1);
      const second = polygon.slice(j).concat(polygon.slice(0, i + 1));
      if (first.length < 3 || second.length < 3) continue;
      if (signedArea(first) <= 0 || signedArea(second) <= 0) continue;
      return [first, second];
    }
  }
  return null;
}

export interface CapPolygon {
  outer: ContourLoop;
  holes: ContourLoop[];
}

function rightmostX(loop: ContourLoop): number {
  let x = -Infinity;
  for (const p of loop) {
    if (p.x > x) x = p.x;
  }
  return x;
}

export function groupLoops(loops: ContourLoop[]): CapPolygon[] {
  const outers: CapPolygon[] = [];
  const holes: ContourLoop[] = [];
  for (const loop of loops) {
    if (signedArea(loop) > 0) outers.push({ outer: loop, holes: [] });
    else holes.push(loop);
  }
  for (const hole of holes) {
    let best = -1;
    let bestArea = Infinity;
    for (let i = 0; i < outers.length; i++) {
      if (!pointInLoop(hole[0].x, hole[0].z, outers[i].outer)) continue;
      const area = signedArea(outers[i].outer);
      if (area < bestArea) {
        bestArea = area;
        best = i;
      }
    }
    if (best >= 0) outers[best].holes.push(hole);
  }
  for (const polygon of outers) {
    polygon.holes.sort((a, b) => rightmostX(b) - rightmostX(a));
  }
  return outers;
}
