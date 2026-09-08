import {
  BoxGeometry,
  ConeGeometry,
  CylinderGeometry,
  Matrix4,
  MeshLambertMaterial,
  Quaternion,
  SphereGeometry,
  TorusGeometry,
  Vector3,
  type BufferGeometry,
  type Material,
} from 'three';
import { hashStructureCell } from '../protocol.ts';
import {
  FULL_TURN_RADIANS,
  X_AXIS,
  Y_AXIS,
  at,
  composed,
  lambert,
  mergeParts,
  pose,
  ringMatrices,
  type StructurePart,
} from './parts.ts';

function add(
  parts: StructurePart[],
  geometry: BufferGeometry,
  material: Material,
  localMatrices: Matrix4[],
): void {
  parts.push({ geometry, material, localMatrices });
}

function appendPlaced(parts: StructurePart[], sub: readonly StructurePart[], transform: Matrix4): void {
  for (const part of sub) {
    parts.push({
      geometry: part.geometry,
      material: part.material,
      localMatrices: part.localMatrices.map((local) => new Matrix4().multiplyMatrices(transform, local)),
    });
  }
}

const C = {
  thatchCap: 0xdcb95a,
  thatchSkirt: 0xc3a047,
  thatchCourse: 0xcfa94e,
  reedCap: 0xd8c88f,
  reedSkirt: 0xbfae76,
  reedCourse: 0xcabb84,
  daub: 0x9c7a52,
  daubDark: 0x87683f,
  withy: 0x7a5c3a,
  driftwood: 0x5a4028,
  plank: 0x8a6a42,
  door: 0x2a1a10,
  stone: 0x8d8781,
  stoneDark: 0x76736c,
  sand: 0xc9b48c,
  fish: 0xb9c6cb,
  fishDark: 0x8fa2a9,
  turf: 0x6f8f4e,
  turfDark: 0x5c7c3f,
  turfTuft: 0x87a760,
  cork: 0xb8813a,
  net: 0x6f8189,
  smoke: 0xa9b6b3,
  ember: 0xd8551f,
};

const TRIANGLE_PRISM_HALF_BASE = Math.sqrt(3) / 2;
const TRIANGLE_PRISM_HEIGHT = 1.5;

function gableEndMatrix(halfBase: number, rise: number, baseY: number, z: number, thickness: number): Matrix4 {
  return composed(
    new Vector3(0, baseY + rise / 3, z),
    new Quaternion().setFromAxisAngle(X_AXIS, -Math.PI / 2),
    new Vector3(halfBase / TRIANGLE_PRISM_HALF_BASE, thickness, rise / TRIANGLE_PRISM_HEIGHT),
  );
}

function fish(parts: StructurePart[], x: number, z: number, yaw: number, length = 0.15, dark = false): void {
  const bodyMat = lambert(dark ? C.fishDark : C.fish);
  const finMat = lambert(dark ? C.fish : C.fishDark);
  const half = length / 2;

  const bodyGeometry = new SphereGeometry(1, 8, 5);
  add(parts, bodyGeometry, bodyMat, [pose(x, 0.026, z, yaw, new Vector3(half * 0.78, 0.026, half * 0.34))]);
  const tailRotation = new Quaternion()
    .setFromAxisAngle(Y_AXIS, yaw)
    .multiply(new Quaternion().setFromAxisAngle(X_AXIS, -Math.PI / 2));
  add(parts, new ConeGeometry(1, 1, 3), finMat, [
    composed(
      new Vector3(x - Math.sin(yaw) * half * 0.95, 0.028, z - Math.cos(yaw) * half * 0.95),
      tailRotation,
      new Vector3(0.05, half * 0.55, 0.014),
    ),
  ]);
  add(parts, new ConeGeometry(1, 1, 3), finMat, [
    pose(x, 0.04, z, yaw, new Vector3(half * 0.3, 0.03, 0.008)),
  ]);
  add(parts, new SphereGeometry(0.009, 5, 4), lambert(C.door), [
    at(x + Math.sin(yaw) * half * 0.62 + Math.cos(yaw) * 0.012, 0.04, z + Math.cos(yaw) * half * 0.62 - Math.sin(yaw) * 0.012),
  ]);
}

function fishYard(parts: StructurePart[], frontZ: number, spread = 0.09): void {
  fish(parts, -spread * 0.55, frontZ, 0.35, 0.15, false);
  fish(parts, spread * 0.7, frontZ - 0.055, -0.9, 0.13, true);
}

function footingRing(parts: StructurePart[], radius: number, color = C.daubDark, height = 0.05, segments = 8): void {
  add(parts, new CylinderGeometry(radius + 0.01, radius + 0.02, height, segments, 1, true), lambert(color), [
    at(0, height / 2, 0),
  ]);
}

function doorFrame(parts: StructurePart[], width: number, height: number, z: number, bar = 0.026): void {
  const mat = lambert(C.driftwood);
  const jamb = new BoxGeometry(bar, height + bar, bar);
  add(parts, jamb, mat, [at(-width / 2 - bar / 2, (height + bar) / 2, z), at(width / 2 + bar / 2, (height + bar) / 2, z)]);
  add(parts, new BoxGeometry(width + bar * 2 + 0.02, bar, bar), mat, [at(0, height + bar / 2, z)]);
}

function eaveFringe(parts: StructurePart[], radius: number, y: number, color: number, spacing = 0.075): void {
  const count = Math.max(8, Math.round((FULL_TURN_RADIANS * radius) / spacing));
  add(parts, new BoxGeometry(0.042, 0.085, 0.018), lambert(color),
    ringMatrices(count, radius - 0.015, y, true, Math.PI / 7));
}

function capCourses(parts: StructurePart[], baseRadius: number, capHeight: number, baseY: number, color: number, fractions = [0.24, 0.54]): void {
  const H = 0.042;
  const geo = new CylinderGeometry(1, 1, 1, 8, 1, true);
  const mat = lambert(color);
  const radiusAt = (f: number): number => baseRadius * (1 - f);
  add(parts, geo, mat, fractions.map((f) => {
    const span = H / capHeight;
    const r = (radiusAt(f) + radiusAt(f + span)) / 2 + 0.008;
    return pose(0, baseY + capHeight * f + H / 2, 0, 0, new Vector3(r, H, r));
  }));
}

function reedCone(): StructurePart[] {
  const parts: StructurePart[] = [];
  const wallH = 0.34;
  const rTop = 0.2;
  const rBot = 0.215;

  footingRing(parts, rBot);
  add(parts, new CylinderGeometry(rTop, rBot, wallH, 8), lambert(C.daub), [at(0, wallH / 2, 0)]);
  add(parts, new CylinderGeometry(rTop + 0.008, rBot + 0.008, 0.022, 8, 1, true), lambert(C.withy),
    [at(0, wallH * 0.36, 0), at(0, wallH * 0.68, 0)]);

  const skirtEave = 0.3;
  const skirtTop = 0.235;
  const skirtH = 0.115;
  add(parts, new CylinderGeometry(skirtTop, skirtEave, skirtH, 8), lambert(C.reedSkirt), [at(0, wallH + skirtH / 2, 0)]);
  eaveFringe(parts, skirtEave, wallH + 0.01, C.reedSkirt);

  const capH = 0.29;
  add(parts, new ConeGeometry(skirtTop, capH, 8), lambert(C.reedCap), [at(0, wallH + skirtH + capH / 2, 0)]);
  capCourses(parts, skirtTop, capH, wallH + skirtH, C.reedCourse);
  add(parts, new CylinderGeometry(0.04, 0.04, 0.05, 6), lambert(C.door), [at(0, wallH + skirtH + capH - 0.02, 0)]);

  const doorH = 0.22;
  add(parts, new BoxGeometry(0.11, doorH, 0.025), lambert(C.door), [at(0, doorH / 2, rBot + 0.012)]);
  doorFrame(parts, 0.11, doorH, rBot + 0.012);

  add(parts, new BoxGeometry(0.2, 0.028, 0.13), lambert(C.stone), [at(0.0, 0.014, 0.33)]);
  fish(parts, -0.045, 0.335, 0.25, 0.14, false);
  fish(parts, 0.05, 0.31, -1.0, 0.12, true);
  return mergeParts(parts);
}

function lashedAFrame(): StructurePart[] {
  const parts: StructurePart[] = [];
  const halfSpan = 0.29;
  const ridgeY = 0.62;
  const halfLen = 0.26;
  const slope = Math.hypot(halfSpan, ridgeY);
  const lean = Math.atan2(halfSpan, ridgeY);

  const panel = new BoxGeometry(0.03, slope, halfLen * 2);
  const panelMat = lambert(C.reedSkirt);
  add(parts, panel, panelMat, [
    pose(halfSpan / 2, ridgeY / 2, 0, 0).multiply(new Matrix4().makeRotationZ(lean)),
    pose(-halfSpan / 2, ridgeY / 2, 0, 0).multiply(new Matrix4().makeRotationZ(-lean)),
  ]);
  const purlin = new CylinderGeometry(0.013, 0.013, halfLen * 2, 6);
  const purlinMat = lambert(C.withy);
  const purlins = [];
  for (const f of [0.22, 0.5, 0.78]) {
    const x = halfSpan * (1 - f) + 0.022;
    const y = ridgeY * f;
    purlins.push(pose(x, y, 0).multiply(new Matrix4().makeRotationX(Math.PI / 2)));
    purlins.push(pose(-x, y, 0).multiply(new Matrix4().makeRotationX(Math.PI / 2)));
  }
  add(parts, purlin, purlinMat, purlins);

  const pole = new CylinderGeometry(0.014, 0.014, 0.24, 6);
  add(parts, pole, lambert(C.driftwood), [
    pose(0, ridgeY - 0.02, halfLen - 0.02).multiply(new Matrix4().makeRotationZ(0.34)),
    pose(0, ridgeY - 0.02, halfLen - 0.02).multiply(new Matrix4().makeRotationZ(-0.34)),
    pose(0, ridgeY - 0.02, -halfLen + 0.02).multiply(new Matrix4().makeRotationZ(0.34)),
    pose(0, ridgeY - 0.02, -halfLen + 0.02).multiply(new Matrix4().makeRotationZ(-0.34)),
  ]);

  const endMat = lambert(C.reedCap);
  const tri = new CylinderGeometry(1, 1, 1, 3);
  add(parts, tri, endMat, [
    gableEndMatrix(halfSpan, ridgeY, 0, -halfLen + 0.015, 0.03),
    gableEndMatrix(halfSpan, ridgeY, 0, halfLen - 0.015, 0.03),
  ]);
  const doorH = 0.28;
  add(parts, new BoxGeometry(0.13, doorH, 0.03), lambert(C.door), [at(0, doorH / 2, halfLen + 0.012)]);
  doorFrame(parts, 0.13, doorH, halfLen + 0.012);

  add(parts, new BoxGeometry(0.055, 0.035, halfLen * 2 + 0.03), lambert(C.sand), [
    at(halfSpan - 0.005, 0.017, 0), at(-halfSpan + 0.005, 0.017, 0),
  ]);
  fishYard(parts, halfLen + 0.1);
  return mergeParts(parts);
}

function stiltedHut(): StructurePart[] {
  const parts: StructurePart[] = [];
  const deckY = 0.2;
  const halfW = 0.24;
  const halfD = 0.19;

  const pile = new CylinderGeometry(0.022, 0.026, deckY, 6);
  add(parts, pile, lambert(C.driftwood), [
    at(halfW - 0.03, deckY / 2, halfD - 0.03), at(-halfW + 0.03, deckY / 2, halfD - 0.03),
    at(halfW - 0.03, deckY / 2, -halfD + 0.03), at(-halfW + 0.03, deckY / 2, -halfD + 0.03),
    at(0, deckY / 2, halfD - 0.03), at(0, deckY / 2, -halfD + 0.03),
  ]);
  const deckT = 0.035;
  const boards = 7;
  const boardW = (halfW * 2) / boards;
  const plankMats = [lambert(C.plank), lambert(0x7d5f3b)];
  for (let i = 0; i < boards; i++) {
    add(parts, new BoxGeometry(boardW - 0.004, deckT, halfD * 2), plankMats[i % 2], [
      at(-halfW + boardW * (i + 0.5), deckY + deckT / 2, 0),
    ]);
  }

  const wallY = deckY + deckT;
  const wallH = 0.24;
  const wHalfW = 0.19;
  const wHalfD = 0.15;
  add(parts, new BoxGeometry(wHalfW * 2, wallH, wHalfD * 2), lambert(C.daub), [at(0, wallY + wallH / 2, 0)]);
  add(parts, new BoxGeometry(wHalfW * 2 + 0.01, 0.022, wHalfD * 2 + 0.01), lambert(C.withy), [
    at(0, wallY + wallH * 0.55, 0),
  ]);

  const roofH = 0.24;
  add(parts, new ConeGeometry(0.29, roofH, 4), lambert(C.thatchSkirt), [
    pose(0, wallY + wallH + roofH / 2, 0, Math.PI / 4),
  ]);
  add(parts, new ConeGeometry(0.235, 0.05, 4), lambert(C.thatchCourse), [
    pose(0, wallY + wallH + 0.055, 0, Math.PI / 4),
  ]);

  const doorH = 0.17;
  add(parts, new BoxGeometry(0.1, doorH, 0.022), lambert(C.door), [at(0, wallY + doorH / 2, wHalfD + 0.011)]);
  doorFrame(parts, 0.1, doorH, wHalfD + 0.011, 0.02);

  const rampLen = 0.26;
  add(parts, new BoxGeometry(0.13, 0.025, rampLen), lambert(C.plank), [
    pose(0, deckY / 2, halfD + rampLen * 0.4).multiply(new Matrix4().makeRotationX(Math.atan2(deckY, rampLen * 0.9))),
  ]);
  fish(parts, 0.13, 0.06, 1.2, 0.12, false);
  fish(parts, -0.1, 0.36, 0.4, 0.14, true);
  fish(parts, 0.03, 0.38, -0.6, 0.12, false);
  return mergeParts(parts);
}

function windbreakDome(): StructurePart[] {
  const parts: StructurePart[] = [];
  const r = 0.28;
  add(parts, new SphereGeometry(r, 10, 5, 0, FULL_TURN_RADIANS, 0, Math.PI / 2), lambert(C.thatchSkirt), [at(0, 0.0, 0)]);
  for (const f of [0.3, 0.62]) {
    const y = r * Math.sin(f * (Math.PI / 2));
    const ringR = Math.sqrt(Math.max(r * r - y * y, 0.0001));
    add(parts, new TorusGeometry(ringR, 0.014, 4, 12), lambert(C.thatchCourse), [
      pose(0, y, 0).multiply(new Matrix4().makeRotationX(Math.PI / 2)),
    ]);
  }
  footingRing(parts, r - 0.005, C.daubDark, 0.045, 10);

  const doorH = 0.2;
  add(parts, new BoxGeometry(0.13, doorH, 0.04), lambert(C.door), [at(0, doorH / 2, r - 0.055)]);
  add(parts, new CylinderGeometry(0.065, 0.065, 0.04, 8, 1, false, 0, Math.PI), lambert(C.door), [
    pose(0, doorH, r - 0.055).multiply(new Matrix4().makeRotationX(Math.PI / 2)),
  ]);
  doorFrame(parts, 0.13, doorH, r - 0.035, 0.022);

  const stakeMat = lambert(C.driftwood);
  const stakes = [-0.12, 0, 0.12];
  add(parts, new CylinderGeometry(0.012, 0.012, 0.26, 6), stakeMat,
    stakes.map((z) => at(-0.36, 0.13, z)));
  const weaveMat = lambert(C.withy);
  add(parts, new BoxGeometry(0.02, 0.026, 0.3), weaveMat, [
    at(-0.36, 0.08, 0), at(-0.36, 0.15, 0), at(-0.36, 0.22, 0),
  ]);
  fishYard(parts, 0.33);
  return mergeParts(parts);
}

function upturnedHull(): StructurePart[] {
  const parts: StructurePart[] = [];
  const wallH = 0.24;
  const halfW = 0.2;
  const halfD = 0.17;
  add(parts, new BoxGeometry(halfW * 2, wallH, halfD * 2), lambert(C.daub), [at(0, wallH / 2, 0)]);
  add(parts, new BoxGeometry(halfW * 2 + 0.012, 0.022, halfD * 2 + 0.012), lambert(C.withy), [at(0, wallH * 0.58, 0)]);
  add(parts, new BoxGeometry(halfW * 2 + 0.03, 0.04, halfD * 2 + 0.03), lambert(C.daubDark), [at(0, 0.02, 0)]);

  const hullR = 0.23;
  const bodyLen = 0.3;
  const capLen = 0.13;
  const hullMat = lambert(C.thatchSkirt);
  const halfSweep = { start: -Math.PI / 2, length: Math.PI };
  const layFlat = new Matrix4().makeRotationX(-Math.PI / 2);
  add(parts, new CylinderGeometry(hullR, hullR, bodyLen, 12, 1, false, halfSweep.start, halfSweep.length), hullMat, [
    pose(0, wallH, 0).multiply(layFlat),
  ]);
  add(parts, new CylinderGeometry(hullR, hullR * 0.3, capLen, 12, 1, false, halfSweep.start, halfSweep.length), hullMat, [
    pose(0, wallH, -bodyLen / 2 - capLen / 2 + 0.002).multiply(layFlat),
    pose(0, wallH, bodyLen / 2 + capLen / 2 - 0.002, Math.PI).multiply(layFlat),
  ]);
  for (const a of [0.5, 1.0]) {
    const y = wallH + Math.sin(a) * hullR;
    const x = Math.cos(a) * hullR;
    add(parts, new BoxGeometry(0.03, 0.02, bodyLen + capLen), lambert(C.thatchCourse), [
      at(x, y, 0), at(-x, y, 0),
    ]);
  }
  add(parts, new BoxGeometry(0.05, 0.035, bodyLen + capLen * 1.4), lambert(C.driftwood), [
    at(0, wallH + hullR + 0.005, 0),
  ]);

  const doorH = 0.17;
  add(parts, new BoxGeometry(0.1, doorH, 0.022), lambert(C.door), [at(0, doorH / 2, halfD + 0.011)]);
  doorFrame(parts, 0.1, doorH, halfD + 0.011, 0.02);

  add(parts, new CylinderGeometry(0.07, 0.055, 0.09, 8, 1, true), lambert(C.withy), [at(0.16, 0.045, 0.29)]);
  add(parts, new TorusGeometry(0.07, 0.008, 4, 10), lambert(C.driftwood), [
    pose(0.16, 0.09, 0.29).multiply(new Matrix4().makeRotationX(Math.PI / 2)),
  ]);
  fish(parts, 0.16, 0.29, 0.6, 0.12, false);
  fish(parts, -0.1, 0.3, -0.3, 0.15, true);
  return mergeParts(parts);
}

const YARD_THICKNESS = 0.016;

function twinHutYard(): StructurePart[] {
  const parts: StructurePart[] = [];
  add(parts, new CylinderGeometry(0.44, 0.44, YARD_THICKNESS, 16), lambert(C.sand), [
    at(0, YARD_THICKNESS / 2, 0),
  ]);

  const hut = (cx: number, cz: number, scale: number, yaw: number): void => {
    const sub: StructurePart[] = [];
    const wallH = 0.26 * scale;
    const r = 0.15 * scale;
    add(sub, new CylinderGeometry(r * 0.94, r, wallH, 8), lambert(C.daub), [at(0, wallH / 2, 0)]);
    add(sub, new CylinderGeometry(r * 0.95, r * 1.01, 0.02, 8, 1, true), lambert(C.withy), [at(0, wallH * 0.6, 0)]);
    const skirtEave = r * 1.42;
    const skirtH = 0.075 * scale;
    add(sub, new CylinderGeometry(r * 1.1, skirtEave, skirtH, 8), lambert(C.thatchSkirt), [
      at(0, wallH + skirtH / 2, 0),
    ]);
    eaveFringe(sub, skirtEave, wallH + 0.008, C.thatchSkirt, 0.06);
    const capH = 0.2 * scale;
    add(sub, new ConeGeometry(r * 1.1, capH, 8), lambert(C.thatchCap), [at(0, wallH + skirtH + capH / 2, 0)]);
    capCourses(sub, r * 1.1, capH, wallH + skirtH, C.thatchCourse, [0.3]);
    const doorH = 0.15 * scale;
    add(sub, new BoxGeometry(0.075, doorH, 0.022), lambert(C.door), [at(0, doorH / 2, r + 0.011)]);
    doorFrame(sub, 0.075, doorH, r + 0.011, 0.018);
    footingRing(sub, r, C.daubDark, 0.035);
    appendPlaced(parts, sub, pose(cx, YARD_THICKNESS, cz, yaw));
  };

  hut(-0.17, -0.05, 0.95, 0.5);
  hut(0.19, 0.1, 0.72, -0.35);

  fish(parts, -0.01, 0.13, 0.4, 0.14, false);
  fish(parts, 0.05, 0.02, -0.8, 0.12, true);
  fish(parts, -0.06, -0.05, 1.4, 0.11, false);
  return mergeParts(parts);
}

function dryingRackHut(): StructurePart[] {
  const parts: StructurePart[] = [];
  const wallH = 0.26;
  const halfW = 0.27;
  const halfD = 0.15;
  add(parts, new BoxGeometry(halfW * 2, wallH, halfD * 2), lambert(C.daub), [at(0, wallH / 2, -0.06)]);
  add(parts, new BoxGeometry(halfW * 2 + 0.012, 0.022, halfD * 2 + 0.012), lambert(C.withy), [at(0, wallH * 0.56, -0.06)]);
  add(parts, new BoxGeometry(halfW * 2 + 0.03, 0.04, halfD * 2 + 0.03), lambert(C.daubDark), [at(0, 0.02, -0.06)]);

  const ridgeRise = 0.19;
  const eave = 0.035;
  const span = halfW + eave;
  const slope = Math.hypot(span, ridgeRise);
  const lean = Math.atan2(span, ridgeRise);
  const roofMat = lambert(C.thatchSkirt);
  add(parts, new BoxGeometry(0.035, slope, (halfD + eave) * 2), roofMat, [
    pose(span / 2, wallH + ridgeRise / 2, -0.06).multiply(new Matrix4().makeRotationZ(lean)),
    pose(-span / 2, wallH + ridgeRise / 2, -0.06).multiply(new Matrix4().makeRotationZ(-lean)),
  ]);
  add(parts, new CylinderGeometry(1, 1, 1, 3), lambert(C.thatchCap), [
    gableEndMatrix(halfW, ridgeRise, wallH, -0.06 + halfD - 0.01, 0.03),
    gableEndMatrix(halfW, ridgeRise, wallH, -0.06 - halfD + 0.01, 0.03),
  ]);
  add(parts, new BoxGeometry(0.055, 0.035, (halfD + eave) * 2), lambert(C.driftwood), [
    at(0, wallH + ridgeRise + 0.01, -0.06),
  ]);

  const doorH = 0.18;
  add(parts, new BoxGeometry(0.1, doorH, 0.022), lambert(C.door), [at(0, doorH / 2, halfD - 0.049)]);
  doorFrame(parts, 0.1, doorH, halfD - 0.049, 0.02);

  const postH = 0.32;
  const rackZ = 0.28;
  const rackHalf = 0.26;
  add(parts, new CylinderGeometry(0.016, 0.018, postH, 6), lambert(C.driftwood), [
    at(-rackHalf, postH / 2, rackZ), at(rackHalf, postH / 2, rackZ),
  ]);
  add(parts, new BoxGeometry(rackHalf * 2 + 0.05, 0.022, 0.025), lambert(C.driftwood), [at(0, postH, rackZ)]);
  const hangXs = [-0.17, -0.06, 0.06, 0.17];
  add(parts, new CylinderGeometry(0.004, 0.004, 0.05, 4), lambert(C.withy),
    hangXs.map((x) => at(x, postH - 0.028, rackZ)));
  const hung = new SphereGeometry(1, 6, 5);
  add(parts, hung, lambert(C.fish), hangXs.map((x, i) =>
    pose(x, postH - 0.11, rackZ, 0, new Vector3(0.026, 0.062, 0.016 + (i % 2) * 0.003))));
  add(parts, new ConeGeometry(1, 1, 3), lambert(C.fishDark), hangXs.map((x) =>
    pose(x, postH - 0.185, rackZ, 0, new Vector3(0.03, 0.035, 0.01))
      .multiply(new Matrix4().makeRotationX(Math.PI))));

  fish(parts, -0.1, 0.4, 0.3, 0.14, true);
  fish(parts, 0.06, 0.38, -0.7, 0.12, false);
  return mergeParts(parts);
}

function turfRoofHut(): StructurePart[] {
  const parts: StructurePart[] = [];
  const courseH = 0.055;
  const halfW = 0.23;
  const halfD = 0.17;
  const shades = [lambert(C.stone), lambert(C.stoneDark)];
  for (let course = 0; course < 2; course++) {
    const y = courseH / 2 + course * courseH;
    const stagger = course % 2 === 1 ? 0.045 : 0;
    for (const [ax, az, len] of [
      [0, halfD, halfW * 2], [0, -halfD, halfW * 2],
    ]) {
      const n = 5;
      for (let i = 0; i < n; i++) {
        const w = len / n;
        add(parts, new BoxGeometry(w - 0.008, courseH - 0.008, 0.05), shades[(i + course) % 2], [
          at(ax - len / 2 + w * (i + 0.5) + stagger * 0.2, y, az),
        ]);
      }
    }
    for (const sx of [-halfW, halfW]) {
      const n = 4;
      for (let i = 0; i < n; i++) {
        const d = (halfD * 2) / n;
        add(parts, new BoxGeometry(0.05, courseH - 0.008, d - 0.008), shades[(i + course + 1) % 2], [
          at(sx, y, -halfD + d * (i + 0.5)),
        ]);
      }
    }
  }
  const stoneTop = courseH * 2;
  const wallH = 0.16;
  add(parts, new BoxGeometry(halfW * 2 - 0.01, wallH, halfD * 2 - 0.01), lambert(C.daub), [
    at(0, stoneTop + wallH / 2, 0),
  ]);

  const roofY = stoneTop + wallH;
  const roofH = 0.2;
  add(parts, new ConeGeometry(0.31, roofH, 4), lambert(C.turf), [pose(0, roofY + roofH / 2, 0, Math.PI / 4)]);
  add(parts, new ConeGeometry(0.255, 0.045, 4), lambert(C.turfDark), [pose(0, roofY + 0.05, 0, Math.PI / 4)]);
  const tuft = new ConeGeometry(0.02, 0.05, 4);
  add(parts, tuft, lambert(C.turfTuft), [
    pose(0.09, roofY + 0.1, 0.06, 0.4), pose(-0.11, roofY + 0.08, -0.03, -0.3),
    pose(0.02, roofY + 0.16, -0.09, 0.9), pose(-0.05, roofY + 0.12, 0.1, -0.8),
  ]);

  const doorH = 0.19;
  add(parts, new BoxGeometry(0.1, doorH, 0.022), lambert(C.door), [at(0, doorH / 2, halfD + 0.024)]);
  doorFrame(parts, 0.1, doorH, halfD + 0.024, 0.02);

  add(parts, new BoxGeometry(0.22, 0.024, 0.12), lambert(C.plank), [at(0.02, 0.012, 0.33)]);
  fish(parts, -0.03, 0.34, 0.3, 0.14, false);
  fish(parts, 0.07, 0.31, -0.9, 0.12, true);
  return mergeParts(parts);
}

function netDrapedCone(): StructurePart[] {
  const parts: StructurePart[] = [];
  const wallH = 0.3;
  const r = 0.21;
  footingRing(parts, r);
  add(parts, new CylinderGeometry(r * 0.95, r, wallH, 8), lambert(C.daub), [at(0, wallH / 2, 0)]);
  add(parts, new CylinderGeometry(r * 0.96, r * 1.01, 0.022, 8, 1, true), lambert(C.withy), [at(0, wallH * 0.62, 0)]);

  const skirtEave = 0.29;
  const skirtH = 0.1;
  add(parts, new CylinderGeometry(r * 1.12, skirtEave, skirtH, 8), lambert(C.thatchSkirt), [
    at(0, wallH + skirtH / 2, 0),
  ]);
  eaveFringe(parts, skirtEave, wallH + 0.01, C.thatchSkirt);
  const capH = 0.26;
  add(parts, new ConeGeometry(r * 1.12, capH, 8), lambert(C.thatchCap), [at(0, wallH + skirtH + capH / 2, 0)]);
  capCourses(parts, r * 1.12, capH, wallH + skirtH, C.thatchCourse);

  const doorH = 0.21;
  add(parts, new BoxGeometry(0.11, doorH, 0.024), lambert(C.door), [at(0, doorH / 2, r + 0.012)]);
  doorFrame(parts, 0.11, doorH, r + 0.012);

  const netMat = lambert(C.net);
  const cord = new BoxGeometry(0.0045, 0.0045, 1);
  const drape = [];
  const topY = wallH + skirtH * 0.4;
  const DRAPE_CORDS = 11;
  for (let i = 0; i < DRAPE_CORDS; i++) {
    const t = i / (DRAPE_CORDS - 1);
    const ax = 0.55 + t * 0.85;
    const x0 = Math.sin(ax) * skirtEave * 0.95;
    const z0 = Math.cos(ax) * skirtEave * 0.95;
    const x1 = Math.sin(ax) * (skirtEave + 0.11);
    const z1 = Math.cos(ax) * (skirtEave + 0.11);
    const from = new Vector3(x0, topY, z0);
    const to = new Vector3(x1, 0.005, z1);
    const dir = new Vector3().subVectors(to, from);
    const len = dir.length();
    const m = new Matrix4().lookAt(new Vector3(), dir, Y_AXIS);
    drape.push(new Matrix4().compose(
      new Vector3().addVectors(from, to).multiplyScalar(0.5),
      new Quaternion().setFromRotationMatrix(m),
      new Vector3(1, 1, len),
    ));
  }
  add(parts, cord, netMat, drape);
  const rungs = [];
  const NET_ROWS = 6;
  for (let row = 0; row < NET_ROWS; row++) {
    const h = topY * (1 - (row + 1) / (NET_ROWS + 1));
    for (let i = 0; i < DRAPE_CORDS - 1; i++) {
      const t0 = i / (DRAPE_CORDS - 1), t1 = (i + 1) / (DRAPE_CORDS - 1);
      const a0 = 0.55 + t0 * 0.85, a1 = 0.55 + t1 * 0.85;
      const rr = skirtEave * 0.95 + (row / NET_ROWS) * 0.11;
      const from = new Vector3(Math.sin(a0) * rr, h, Math.cos(a0) * rr);
      const to = new Vector3(Math.sin(a1) * rr, h, Math.cos(a1) * rr);
      const dir = new Vector3().subVectors(to, from);
      rungs.push(new Matrix4().compose(
        new Vector3().addVectors(from, to).multiplyScalar(0.5),
        new Quaternion().setFromRotationMatrix(new Matrix4().lookAt(new Vector3(), dir, Y_AXIS)),
        new Vector3(1, 1, dir.length()),
      ));
    }
  }
  add(parts, cord, netMat, rungs);
  add(parts, new SphereGeometry(0.022, 6, 5), lambert(C.cork), [
    pose(Math.sin(0.7) * 0.34, topY - 0.03, Math.cos(0.7) * 0.34),
    pose(Math.sin(1.05) * 0.36, topY - 0.11, Math.cos(1.05) * 0.36),
    pose(Math.sin(1.3) * 0.35, topY - 0.2, Math.cos(1.3) * 0.35),
  ]);

  fish(parts, -0.2, 0.28, 0.9, 0.14, false);
  fish(parts, -0.29, 0.19, 1.9, 0.12, true);
  return mergeParts(parts);
}

const EMBER_GLOW_COLOR = 0xff7a2a;
const EMBER_GLOW_INTENSITY = 0.9;
const SMOKE_OPACITY = 0.45;

function smokePitHut(): StructurePart[] {
  const parts: StructurePart[] = [];
  const wallH = 0.28;
  const r = 0.185;
  const cx = -0.08;
  const sub: StructurePart[] = [];
  footingRing(sub, r);
  add(sub, new CylinderGeometry(r * 0.95, r, wallH, 8), lambert(C.daub), [at(0, wallH / 2, 0)]);
  add(sub, new CylinderGeometry(r * 0.96, r * 1.01, 0.022, 8, 1, true), lambert(C.withy), [at(0, wallH * 0.6, 0)]);
  const skirtEave = 0.25;
  const skirtH = 0.09;
  add(sub, new CylinderGeometry(r * 1.1, skirtEave, skirtH, 8), lambert(C.thatchSkirt), [
    at(0, wallH + skirtH / 2, 0),
  ]);
  eaveFringe(sub, skirtEave, wallH + 0.008, C.thatchSkirt, 0.065);
  const capH = 0.22;
  add(sub, new ConeGeometry(r * 1.1, capH, 8), lambert(C.thatchCap), [at(0, wallH + skirtH + capH / 2, 0)]);
  capCourses(sub, r * 1.1, capH, wallH + skirtH, C.thatchCourse, [0.3]);
  const ventY = wallH + skirtH + capH;
  add(sub, new CylinderGeometry(0.038, 0.038, 0.045, 6), lambert(C.door), [at(0, ventY - 0.018, 0)]);
  const doorH = 0.19;
  add(sub, new BoxGeometry(0.1, doorH, 0.022), lambert(C.door), [at(0, doorH / 2, r + 0.011)]);
  doorFrame(sub, 0.1, doorH, r + 0.011, 0.02);
  appendPlaced(parts, sub, at(cx, 0, 0));

  const smokeMat = new MeshLambertMaterial({
    color: C.smoke,
    flatShading: true,
    transparent: true,
    opacity: SMOKE_OPACITY,
  });
  add(parts, new SphereGeometry(1, 6, 4), smokeMat, [
    pose(cx + 0.01, ventY + 0.05, 0, 0, new Vector3(0.05, 0.045, 0.05)),
    pose(cx + 0.05, ventY + 0.12, 0.01, 0, new Vector3(0.04, 0.036, 0.04)),
    pose(cx + 0.09, ventY + 0.19, 0.02, 0, new Vector3(0.028, 0.026, 0.028)),
  ]);

  const pit = new Vector3(0.22, 0, 0.2);
  add(parts, new SphereGeometry(1, 6, 4), lambert(C.stone),
    ringMatrices(7, 0.115, 0.022, false).map((m) =>
      m.multiply(new Matrix4().makeScale(0.032, 0.024, 0.032)))
      .map((m) => new Matrix4().makeTranslation(pit.x, 0, pit.z).multiply(m)));
  add(parts, new CylinderGeometry(0.09, 0.09, 0.016, 10),
    lambert(C.ember, { emissive: EMBER_GLOW_COLOR, emissiveIntensity: EMBER_GLOW_INTENSITY }),
    [at(pit.x, 0.012, pit.z)]);

  add(parts, new CylinderGeometry(0.01, 0.012, 0.16, 6), lambert(C.driftwood), [
    at(pit.x - 0.11, 0.08, pit.z), at(pit.x + 0.11, 0.08, pit.z),
  ]);
  add(parts, new CylinderGeometry(0.007, 0.007, 0.26, 6), lambert(C.driftwood), [
    pose(pit.x, 0.155, pit.z).multiply(new Matrix4().makeRotationZ(Math.PI / 2)),
  ]);
  add(parts, new SphereGeometry(1, 6, 5), lambert(C.fish), [
    pose(pit.x - 0.045, 0.115, pit.z, 0, new Vector3(0.024, 0.05, 0.015)),
    pose(pit.x + 0.045, 0.115, pit.z, 0, new Vector3(0.024, 0.05, 0.015)),
  ]);

  fish(parts, -0.13, 0.31, 0.5, 0.14, true);
  fish(parts, -0.03, 0.35, -0.5, 0.12, false);
  return mergeParts(parts);
}

export const FISHING_HUT_BUILDERS: ReadonlyArray<() => StructurePart[]> = [
  reedCone,
  lashedAFrame,
  stiltedHut,
  windbreakDome,
  upturnedHull,
  twinHutYard,
  dryingRackHut,
  turfRoofHut,
  netDrapedCone,
  smokePitHut,
];

export const FISHING_HUT_NAMES: readonly string[] = [
  'reed-cone',
  'lashed-a-frame',
  'stilted-hut',
  'windbreak-dome',
  'upturned-hull',
  'twin-hut-yard',
  'drying-rack-long-hut',
  'turf-roof-on-stone',
  'net-draped-cone',
  'smoke-pit-hut',
];

const FISHING_HUT_ROLL_SALT = 0x9e3779b1;

function fishingHutRollHash(x: number, y: number): number {
  let h = (hashStructureCell(x, y) ^ FISHING_HUT_ROLL_SALT) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d);
  h = Math.imul(h ^ (h >>> 15), 0x846ca68b);
  return (h ^ (h >>> 16)) >>> 0;
}

export function fishingHutVariantIndex(x: number, y: number): number {
  return fishingHutRollHash(x, y) % FISHING_HUT_BUILDERS.length;
}
