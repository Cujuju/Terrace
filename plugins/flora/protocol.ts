export const FLORA_PLUGIN_NAME = 'flora';

export const FLORA_FOREST_MESSAGE = 'forest';

export const FLORA_CHANGES_MESSAGE = 'changes';

export const FLORA_TREE_CAP = 4096;

export interface TreeCell {
  readonly x: number;
  readonly y: number;
}

export const FLORA_CELL_KEY_STRIDE = 65536;

export function treeKey(x: number, y: number): number {
  return y * FLORA_CELL_KEY_STRIDE + x;
}

export function treeCellOf(key: number): TreeCell {
  return { x: key % FLORA_CELL_KEY_STRIDE, y: Math.floor(key / FLORA_CELL_KEY_STRIDE) };
}

export function packTreeCells(cells: Iterable<TreeCell>): number[] {
  const packed: number[] = [];
  for (const cell of cells) packed.push(cell.x, cell.y);
  return packed;
}

export function isCellCoordinate(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 0 &&
    value < FLORA_CELL_KEY_STRIDE
  );
}

export function parseTreeCells(value: unknown): TreeCell[] | null {
  if (!Array.isArray(value)) return null;

  const cells: TreeCell[] = [];
  for (let i = 0; i + 1 < value.length; i += 2) {
    if (cells.length >= FLORA_TREE_CAP) break;
    const x = value[i];
    const y = value[i + 1];
    if (!isCellCoordinate(x) || !isCellCoordinate(y)) continue;
    cells.push({ x, y });
  }
  return cells;
}

export interface FloraForestPayload {
  readonly trees: readonly number[];
}

export interface FloraChangesPayload {
  readonly grown: readonly number[];
  readonly felled: readonly number[];
}

export function parseForestPayload(payload: unknown): TreeCell[] | null {
  if (typeof payload !== 'object' || payload === null) return null;
  return parseTreeCells((payload as { trees?: unknown }).trees);
}

export function parseChangesPayload(
  payload: unknown,
): { grown: TreeCell[]; felled: TreeCell[] } | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const message = payload as { grown?: unknown; felled?: unknown };
  const grown = parseTreeCells(message.grown ?? []);
  const felled = parseTreeCells(message.felled ?? []);
  if (grown === null || felled === null) return null;
  return { grown, felled };
}

export const FLORA_CROPS_MESSAGE = 'crops';

export const FLORA_CROP_CHANGES_MESSAGE = 'cropChanges';

export const FLORA_CROP_CAP = 2048;

export interface CropCell {
  readonly x: number;
  readonly y: number;
}

export function cropKey(x: number, y: number): number {
  return y * FLORA_CELL_KEY_STRIDE + x;
}

export function cropCellOf(key: number): CropCell {
  return { x: key % FLORA_CELL_KEY_STRIDE, y: Math.floor(key / FLORA_CELL_KEY_STRIDE) };
}

export function packCropCells(cells: Iterable<CropCell>): number[] {
  const packed: number[] = [];
  for (const cell of cells) packed.push(cell.x, cell.y);
  return packed;
}

export function parseCropCells(value: unknown): CropCell[] | null {
  if (!Array.isArray(value)) return null;

  const cells: CropCell[] = [];
  for (let i = 0; i + 1 < value.length; i += 2) {
    if (cells.length >= FLORA_CROP_CAP) break;
    const x = value[i];
    const y = value[i + 1];
    if (!isCellCoordinate(x) || !isCellCoordinate(y)) continue;
    cells.push({ x, y });
  }
  return cells;
}

export interface FloraCropsPayload {
  readonly crops: readonly number[];
}

export interface FloraCropChangesPayload {
  readonly sprouted: readonly number[];
  readonly withered: readonly number[];
}

export function parseCropsPayload(payload: unknown): CropCell[] | null {
  if (typeof payload !== 'object' || payload === null) return null;
  return parseCropCells((payload as { crops?: unknown }).crops);
}

export function parseCropChangesPayload(
  payload: unknown,
): { sprouted: CropCell[]; withered: CropCell[] } | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const message = payload as { sprouted?: unknown; withered?: unknown };
  const sprouted = parseCropCells(message.sprouted ?? []);
  const withered = parseCropCells(message.withered ?? []);
  if (sprouted === null || withered === null) return null;
  return { sprouted, withered };
}

export const FLORA_TREE_KINDS = ['conifer', 'broadleaf'] as const;

export type FloraTreeKind = (typeof FLORA_TREE_KINDS)[number];

export const FLORA_CONIFER_SHARE_OF_256 = 154;

export const FLORA_TREE_SCALE_MIN = 0.78;
export const FLORA_TREE_SCALE_MAX = 1.25;

export interface FloraTreeVariation {
  readonly kind: FloraTreeKind;
  readonly scale: number;
  readonly yaw: number;
}

export function hashCell(x: number, y: number): number {
  let h = (Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1)) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

const TWO_PI = Math.PI * 2;

const YAW_BITS = 16;
const YAW_DIVISOR = 1 << YAW_BITS;

export function treeVariation(x: number, y: number): FloraTreeVariation {
  const hash = hashCell(x, y);
  const kindRoll = hash & 0xff;
  const scaleRoll = (hash >>> 8) & 0xff;
  const yawRoll = (hash >>> 16) & (YAW_DIVISOR - 1);

  return {
    kind: kindRoll < FLORA_CONIFER_SHARE_OF_256 ? 'conifer' : 'broadleaf',
    scale:
      FLORA_TREE_SCALE_MIN + (scaleRoll / 0xff) * (FLORA_TREE_SCALE_MAX - FLORA_TREE_SCALE_MIN),
    yaw: (yawRoll / YAW_DIVISOR) * TWO_PI,
  };
}

export const CROP_SCALE_MIN = 0.85;
export const CROP_SCALE_MAX = 1.15;

export interface CropVariation {
  readonly scale: number;
  readonly yaw: number;
}

export function cropVariation(x: number, y: number): CropVariation {
  const hash = hashCell(x, y);
  const scaleRoll = hash & 0xff;
  const yawRoll = (hash >>> 8) & (YAW_DIVISOR - 1);
  return {
    scale: CROP_SCALE_MIN + (scaleRoll / 0xff) * (CROP_SCALE_MAX - CROP_SCALE_MIN),
    yaw: (yawRoll / YAW_DIVISOR) * TWO_PI,
  };
}

export const CROP_STALK_OFFSET_IN_CLUSTER_SPANS = 0.19;

export const CROP_STALK_OFFSETS: ReadonlyArray<readonly [number, number]> = [
  [-CROP_STALK_OFFSET_IN_CLUSTER_SPANS, -CROP_STALK_OFFSET_IN_CLUSTER_SPANS],
  [CROP_STALK_OFFSET_IN_CLUSTER_SPANS, -CROP_STALK_OFFSET_IN_CLUSTER_SPANS],
  [-CROP_STALK_OFFSET_IN_CLUSTER_SPANS, CROP_STALK_OFFSET_IN_CLUSTER_SPANS],
  [CROP_STALK_OFFSET_IN_CLUSTER_SPANS, CROP_STALK_OFFSET_IN_CLUSTER_SPANS],
];

export const CROP_STALKS_PER_PLOT = CROP_STALK_OFFSETS.length;

const CROP_STALK_ROLL_SALT = 0x9e3779b1;

export const CROP_STALK_HEIGHT_SPREAD = 0.22;

export const CROP_STALK_JITTER_IN_CLUSTER_SPANS = 0.03;

export interface CropStalkVariation {
  readonly yaw: number;
  readonly height: number;
  readonly jitterX: number;
  readonly jitterZ: number;
}

function cropStalkHash(x: number, y: number, index: number): number {
  let h = (hashCell(x, y) ^ CROP_STALK_ROLL_SALT) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d);
  h = Math.imul(h ^ (index + 1), 0x846ca68b);
  return ((h ^ (h >>> 16)) >>> 0);
}

const JITTER_BITS = 8;
const JITTER_DIVISOR = 1 << JITTER_BITS;

export function cropStalkVariation(x: number, y: number, index: number): CropStalkVariation {
  const hash = cropStalkHash(x, y, index);
  const yawRoll = hash & (YAW_DIVISOR - 1);
  const heightRoll = (hash >>> 16) & 0xff;
  const jitterXRoll = (hash >>> 8) & (JITTER_DIVISOR - 1);
  const jitterZRoll = (hash >>> 24) & (JITTER_DIVISOR - 1);
  const centred = (roll: number): number => (roll / (JITTER_DIVISOR - 1)) * 2 - 1;
  return {
    yaw: (yawRoll / YAW_DIVISOR) * TWO_PI,
    height: 1 + centred(heightRoll) * CROP_STALK_HEIGHT_SPREAD,
    jitterX: centred(jitterXRoll) * CROP_STALK_JITTER_IN_CLUSTER_SPANS,
    jitterZ: centred(jitterZRoll) * CROP_STALK_JITTER_IN_CLUSTER_SPANS,
  };
}

import { CONTOUR_CELL_CENTRE_GUARD } from '@terrace/shared';

const SQUARE_CIRCUMRADIUS_PER_EDGE = Math.SQRT2 / 2;

export const CROP_PLOT_MAX_REACH_CELLS = 0.5;

export const CROP_PLOT_CLUSTER_CELL_SPAN =
  CROP_PLOT_MAX_REACH_CELLS / (SQUARE_CIRCUMRADIUS_PER_EDGE * CROP_SCALE_MAX);

export const CROP_PLOT_TREAD_RING_CELLS = Math.max(
  0,
  Math.ceil(CROP_PLOT_MAX_REACH_CELLS - CONTOUR_CELL_CENTRE_GUARD),
);

if (
  CROP_PLOT_CLUSTER_CELL_SPAN * CROP_SCALE_MAX * SQUARE_CIRCUMRADIUS_PER_EDGE >
  CROP_PLOT_MAX_REACH_CELLS
) {
  throw new RangeError(
    `a crop plot of ${CROP_PLOT_CLUSTER_CELL_SPAN} cells reaches past ${CROP_PLOT_MAX_REACH_CELLS} cells and would overlap its neighbours`,
  );
}

export const FLORA_GRASS_MESSAGE = 'grass';

export const FLORA_GRASS_CHANGES_MESSAGE = 'grassChanges';

export const GRASS_CELLS_PER_TUFT = 1.78;

export const FLORA_GRASS_SHARE_OF_256 = Math.round(256 / GRASS_CELLS_PER_TUFT);

export const FLORA_GRASS_CAP = 40960;

export interface GrassCell {
  readonly x: number;
  readonly y: number;
}

export function grassKey(x: number, y: number): number {
  return y * FLORA_CELL_KEY_STRIDE + x;
}

export function grassCellOf(key: number): GrassCell {
  return { x: key % FLORA_CELL_KEY_STRIDE, y: Math.floor(key / FLORA_CELL_KEY_STRIDE) };
}

export function packGrassCells(cells: Iterable<GrassCell>): number[] {
  const packed: number[] = [];
  for (const cell of cells) packed.push(cell.x, cell.y);
  return packed;
}

export function parseGrassCells(value: unknown): GrassCell[] | null {
  if (!Array.isArray(value)) return null;
  const cells: GrassCell[] = [];
  for (let i = 0; i + 1 < value.length; i += 2) {
    if (cells.length >= FLORA_GRASS_CAP) break;
    const x = value[i];
    const y = value[i + 1];
    if (!isCellCoordinate(x) || !isCellCoordinate(y)) continue;
    cells.push({ x, y });
  }
  return cells;
}

export interface FloraGrassPayload {
  readonly grass: readonly number[];
}

export interface FloraGrassChangesPayload {
  readonly sprouted: readonly number[];
  readonly withered: readonly number[];
}

export function parseGrassPayload(payload: unknown): GrassCell[] | null {
  if (typeof payload !== 'object' || payload === null) return null;
  return parseGrassCells((payload as { grass?: unknown }).grass);
}

export function parseGrassChangesPayload(
  payload: unknown,
): { sprouted: GrassCell[]; withered: GrassCell[] } | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const message = payload as { sprouted?: unknown; withered?: unknown };
  const sprouted = parseGrassCells(message.sprouted ?? []);
  const withered = parseGrassCells(message.withered ?? []);
  if (sprouted === null || withered === null) return null;
  return { sprouted, withered };
}

const GRASS_ROLL_SALT = 0x85ebca77;

function grassHash(x: number, y: number): number {
  let h = (hashCell(x, y) ^ GRASS_ROLL_SALT) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x2545f491);
  return ((h ^ (h >>> 15)) >>> 0);
}

export function grassCoversCell(x: number, y: number): boolean {
  return (grassHash(x, y) & 0xff) < FLORA_GRASS_SHARE_OF_256;
}

export const GRASS_SCALE_MIN = 0.75;
export const GRASS_SCALE_MAX = 1.25;

export interface GrassVariation {
  readonly scale: number;
  readonly yaw: number;
}

export function grassVariation(x: number, y: number): GrassVariation {
  const hash = grassHash(x, y);
  const scaleRoll = (hash >>> 8) & 0xff;
  const yawRoll = (hash >>> 16) & (YAW_DIVISOR - 1);
  return {
    scale: GRASS_SCALE_MIN + (scaleRoll / 0xff) * (GRASS_SCALE_MAX - GRASS_SCALE_MIN),
    yaw: (yawRoll / YAW_DIVISOR) * TWO_PI,
  };
}

export const GRASS_TUFT_MAX_REACH_CELLS = 0.5;

export const GRASS_TUFT_CLUSTER_CELL_SPAN =
  GRASS_TUFT_MAX_REACH_CELLS / (SQUARE_CIRCUMRADIUS_PER_EDGE * GRASS_SCALE_MAX);

const GRASS_BLADE_RADIUS_IN_CLUSTER_SPANS = 0.25;

const GRASS_BLADE_COUNT = 5;

export const GRASS_BLADE_OFFSETS: ReadonlyArray<readonly [number, number]> =
  Array.from({ length: GRASS_BLADE_COUNT }, (_unused, index): readonly [number, number] => {
    const angle = (Math.PI * 2 * index) / GRASS_BLADE_COUNT;
    return [
      GRASS_BLADE_RADIUS_IN_CLUSTER_SPANS * Math.sin(angle),
      GRASS_BLADE_RADIUS_IN_CLUSTER_SPANS * Math.cos(angle),
    ];
  });

export const GRASS_BLADES_PER_TUFT = GRASS_BLADE_OFFSETS.length;

export const GRASS_BLADE_HEIGHT_SPREAD = 0.35;

export const GRASS_BLADE_JITTER_IN_CLUSTER_SPANS = 0.06;

export interface GrassBladeVariation {
  readonly yaw: number;
  readonly height: number;
  readonly jitterX: number;
  readonly jitterZ: number;
}

function grassBladeHash(x: number, y: number, index: number): number {
  let h = grassHash(x, y);
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d);
  h = Math.imul(h ^ (index + 1), 0x846ca68b);
  return ((h ^ (h >>> 16)) >>> 0);
}

export function grassBladeVariation(x: number, y: number, index: number): GrassBladeVariation {
  const hash = grassBladeHash(x, y, index);
  const yawRoll = hash & (YAW_DIVISOR - 1);
  const heightRoll = (hash >>> 16) & 0xff;
  const jitterXRoll = (hash >>> 8) & (JITTER_DIVISOR - 1);
  const jitterZRoll = (hash >>> 24) & (JITTER_DIVISOR - 1);
  const centred = (roll: number): number => (roll / (JITTER_DIVISOR - 1)) * 2 - 1;
  return {
    yaw: (yawRoll / YAW_DIVISOR) * TWO_PI,
    height: 1 + centred(heightRoll) * GRASS_BLADE_HEIGHT_SPREAD,
    jitterX: centred(jitterXRoll) * GRASS_BLADE_JITTER_IN_CLUSTER_SPANS,
    jitterZ: centred(jitterZRoll) * GRASS_BLADE_JITTER_IN_CLUSTER_SPANS,
  };
}

if (
  GRASS_TUFT_CLUSTER_CELL_SPAN * GRASS_SCALE_MAX * SQUARE_CIRCUMRADIUS_PER_EDGE >
  GRASS_TUFT_MAX_REACH_CELLS + Number.EPSILON
) {
  throw new RangeError(
    `a grass tuft of ${GRASS_TUFT_CLUSTER_CELL_SPAN} cells reaches past ${GRASS_TUFT_MAX_REACH_CELLS} cells and could overhang a terrace lip`,
  );
}

export const GRASS_FLOWERING_SHARE_OF_256 = 42;

export interface GrassFlower {
  readonly bladeIndex: number;
  readonly tintRoll: number;
}

const GRASS_FLOWER_ROLL_SALT = 0x2f1c8ad3;

function grassFlowerHash(x: number, y: number): number {
  let h = (grassHash(x, y) ^ GRASS_FLOWER_ROLL_SALT) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x9e3779b1);
  return (h ^ (h >>> 15)) >>> 0;
}

export function grassFlowerOf(x: number, y: number): GrassFlower | null {
  const hash = grassFlowerHash(x, y);
  if ((hash & 0xff) >= GRASS_FLOWERING_SHARE_OF_256) return null;
  return {
    bladeIndex: ((hash >>> 8) & 0xff) % GRASS_BLADES_PER_TUFT,
    tintRoll: (hash >>> 16) & 0xff,
  };
}

export const FLORA_FRINGE_MESSAGE = 'fringe';

export const FLORA_FRINGE_CHANGES_MESSAGE = 'fringeChanges';

export type FringeSpecies = 'reed' | 'heather';

export const FRINGE_REED_SHORE_RADIUS_CELLS = 3;

export const FRINGE_REED_CELLS_PER_PLANT = 2;
export const FRINGE_HEATHER_CELLS_PER_PLANT = 4;

export const FRINGE_REED_SHARE_OF_256 = Math.round(256 / FRINGE_REED_CELLS_PER_PLANT);
export const FRINGE_HEATHER_SHARE_OF_256 = Math.round(256 / FRINGE_HEATHER_CELLS_PER_PLANT);

export const FLORA_FRINGE_CAP = 8192;

export interface FringeCell {
  readonly x: number;
  readonly y: number;
}

export function fringeKey(x: number, y: number): number {
  return y * FLORA_CELL_KEY_STRIDE + x;
}

export function fringeCellOf(key: number): FringeCell {
  return { x: key % FLORA_CELL_KEY_STRIDE, y: Math.floor(key / FLORA_CELL_KEY_STRIDE) };
}

export function packFringeCells(cells: Iterable<FringeCell>): number[] {
  const packed: number[] = [];
  for (const cell of cells) packed.push(cell.x, cell.y);
  return packed;
}

export function parseFringeCells(value: unknown): FringeCell[] | null {
  if (!Array.isArray(value)) return null;
  const cells: FringeCell[] = [];
  for (let i = 0; i + 1 < value.length; i += 2) {
    if (cells.length >= FLORA_FRINGE_CAP) break;
    const x = value[i];
    const y = value[i + 1];
    if (!isCellCoordinate(x) || !isCellCoordinate(y)) continue;
    cells.push({ x, y });
  }
  return cells;
}

export interface FloraFringePayload {
  readonly reeds: readonly number[];
  readonly heather: readonly number[];
}

export interface FloraFringeChangesPayload {
  readonly reeds: readonly number[];
  readonly heather: readonly number[];
  readonly withered: readonly number[];
}

export interface FringeBySpecies {
  readonly reed: FringeCell[];
  readonly heather: FringeCell[];
}

function parseFringeBySpecies(value: {
  reeds?: unknown;
  heather?: unknown;
}): FringeBySpecies | null {
  const reed = parseFringeCells(value.reeds ?? []);
  const heather = parseFringeCells(value.heather ?? []);
  if (reed === null || heather === null) return null;
  return { reed, heather };
}

export function parseFringePayload(payload: unknown): FringeBySpecies | null {
  if (typeof payload !== 'object' || payload === null) return null;
  return parseFringeBySpecies(payload as { reeds?: unknown; heather?: unknown });
}

export function parseFringeChangesPayload(
  payload: unknown,
): { sprouted: FringeBySpecies; withered: FringeCell[] } | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const message = payload as { reeds?: unknown; heather?: unknown; withered?: unknown };
  const sprouted = parseFringeBySpecies(message);
  const withered = parseFringeCells(message.withered ?? []);
  if (sprouted === null || withered === null) return null;
  return { sprouted, withered };
}

const FRINGE_ROLL_SALT = 0x6b43a9f5;

function fringeHash(x: number, y: number): number {
  let h = (hashCell(x, y) ^ FRINGE_ROLL_SALT) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x2545f491);
  return (h ^ (h >>> 15)) >>> 0;
}

export function fringeCoversCell(x: number, y: number, species: FringeSpecies): boolean {
  const share = species === 'reed' ? FRINGE_REED_SHARE_OF_256 : FRINGE_HEATHER_SHARE_OF_256;
  return (fringeHash(x, y) & 0xff) < share;
}

export const FRINGE_SCALE_MIN = 0.75;
export const FRINGE_SCALE_MAX = 1.25;

export interface FringeVariation {
  readonly scale: number;
  readonly yaw: number;
}

export function fringeVariation(x: number, y: number): FringeVariation {
  const hash = fringeHash(x, y);
  const scaleRoll = (hash >>> 8) & 0xff;
  const yawRoll = (hash >>> 16) & (YAW_DIVISOR - 1);
  return {
    scale: FRINGE_SCALE_MIN + (scaleRoll / 0xff) * (FRINGE_SCALE_MAX - FRINGE_SCALE_MIN),
    yaw: (yawRoll / YAW_DIVISOR) * TWO_PI,
  };
}

export const FRINGE_MAX_REACH_CELLS = 0.5;

export const FRINGE_CLUSTER_CELL_SPAN =
  FRINGE_MAX_REACH_CELLS / (SQUARE_CIRCUMRADIUS_PER_EDGE * FRINGE_SCALE_MAX);

const FRINGE_REED_STEM_COUNT = 3;
const FRINGE_HEATHER_STEM_COUNT = 7;
const FRINGE_REED_STEM_RADIUS_IN_SPANS = 0.12;
const FRINGE_HEATHER_STEM_RADIUS_IN_SPANS = 0.28;

function ringOffsets(count: number, radius: number): ReadonlyArray<readonly [number, number]> {
  return Array.from({ length: count }, (_unused, index): readonly [number, number] => {
    const angle = (TWO_PI * index) / count;
    return [radius * Math.sin(angle), radius * Math.cos(angle)];
  });
}

export const FRINGE_REED_STEM_OFFSETS = ringOffsets(
  FRINGE_REED_STEM_COUNT,
  FRINGE_REED_STEM_RADIUS_IN_SPANS,
);

export const FRINGE_HEATHER_STEM_OFFSETS = ringOffsets(
  FRINGE_HEATHER_STEM_COUNT,
  FRINGE_HEATHER_STEM_RADIUS_IN_SPANS,
);

export function fringeStemOffsets(
  species: FringeSpecies,
): ReadonlyArray<readonly [number, number]> {
  return species === 'reed' ? FRINGE_REED_STEM_OFFSETS : FRINGE_HEATHER_STEM_OFFSETS;
}

export const FRINGE_MAX_STEMS_PER_PLANT = Math.max(
  FRINGE_REED_STEM_COUNT,
  FRINGE_HEATHER_STEM_COUNT,
);

export const FRINGE_STEM_HEIGHT_SPREAD = 0.3;

export const FRINGE_STEM_JITTER_IN_SPANS = 0.05;

export interface FringeStemVariation {
  readonly yaw: number;
  readonly height: number;
  readonly jitterX: number;
  readonly jitterZ: number;
}

function fringeStemHash(x: number, y: number, index: number): number {
  let h = fringeHash(x, y);
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d);
  h = Math.imul(h ^ (index + 1), 0x846ca68b);
  return (h ^ (h >>> 16)) >>> 0;
}

export function fringeStemVariation(x: number, y: number, index: number): FringeStemVariation {
  const hash = fringeStemHash(x, y, index);
  const yawRoll = hash & (YAW_DIVISOR - 1);
  const heightRoll = (hash >>> 16) & 0xff;
  const jitterXRoll = (hash >>> 8) & (JITTER_DIVISOR - 1);
  const jitterZRoll = (hash >>> 24) & (JITTER_DIVISOR - 1);
  const centred = (roll: number): number => (roll / (JITTER_DIVISOR - 1)) * 2 - 1;
  return {
    yaw: (yawRoll / YAW_DIVISOR) * TWO_PI,
    height: 1 + centred(heightRoll) * FRINGE_STEM_HEIGHT_SPREAD,
    jitterX: centred(jitterXRoll) * FRINGE_STEM_JITTER_IN_SPANS,
    jitterZ: centred(jitterZRoll) * FRINGE_STEM_JITTER_IN_SPANS,
  };
}

if (
  FRINGE_CLUSTER_CELL_SPAN * FRINGE_SCALE_MAX * SQUARE_CIRCUMRADIUS_PER_EDGE >
  FRINGE_MAX_REACH_CELLS + Number.EPSILON
) {
  throw new RangeError(
    `a fringe plant of ${FRINGE_CLUSTER_CELL_SPAN} cells reaches past ${FRINGE_MAX_REACH_CELLS} cells and could overhang a terrace lip`,
  );
}

export const FLORA_STUMP_MESSAGE = 'stumps';

export const FLORA_STUMP_CHANGES_MESSAGE = 'stumpChanges';

export const FLORA_STUMP_CAP = FLORA_TREE_CAP;

export interface StumpCell {
  readonly x: number;
  readonly y: number;
}

export function stumpKey(x: number, y: number): number {
  return y * FLORA_CELL_KEY_STRIDE + x;
}

export function stumpCellOf(key: number): StumpCell {
  return { x: key % FLORA_CELL_KEY_STRIDE, y: Math.floor(key / FLORA_CELL_KEY_STRIDE) };
}

export function packStumpCells(cells: Iterable<StumpCell>): number[] {
  const packed: number[] = [];
  for (const cell of cells) packed.push(cell.x, cell.y);
  return packed;
}

export function parseStumpCells(value: unknown): StumpCell[] | null {
  if (!Array.isArray(value)) return null;

  const cells: StumpCell[] = [];
  for (let i = 0; i + 1 < value.length; i += 2) {
    if (cells.length >= FLORA_STUMP_CAP) break;
    const x = value[i];
    const y = value[i + 1];
    if (!isCellCoordinate(x) || !isCellCoordinate(y)) continue;
    cells.push({ x, y });
  }
  return cells;
}

export interface FloraStumpsPayload {
  readonly stumps: readonly number[];
}

export interface FloraStumpChangesPayload {
  readonly left: readonly number[];
  readonly rotted: readonly number[];
}

export function parseStumpsPayload(payload: unknown): StumpCell[] | null {
  if (typeof payload !== 'object' || payload === null) return null;
  return parseStumpCells((payload as { stumps?: unknown }).stumps);
}

export function parseStumpChangesPayload(
  payload: unknown,
): { left: StumpCell[]; rotted: StumpCell[] } | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const message = payload as { left?: unknown; rotted?: unknown };
  const left = parseStumpCells(message.left ?? []);
  const rotted = parseStumpCells(message.rotted ?? []);
  if (left === null || rotted === null) return null;
  return { left, rotted };
}

export const FLORA_STUMP_SCALE_MIN = 0.85;
export const FLORA_STUMP_SCALE_MAX = 1.15;

export interface StumpVariation {
  readonly scale: number;
  readonly yaw: number;
}

const STUMP_ROLL_SALT = 0x51ab7d29;

export function stumpVariation(x: number, y: number): StumpVariation {
  let hash = (hashCell(x, y) ^ STUMP_ROLL_SALT) >>> 0;
  hash = Math.imul(hash ^ (hash >>> 16), 0x9e3779b1);
  hash = (hash ^ (hash >>> 15)) >>> 0;

  const scaleRoll = (hash >>> 8) & 0xff;
  const yawRoll = (hash >>> 16) & (YAW_DIVISOR - 1);
  return {
    scale:
      FLORA_STUMP_SCALE_MIN + (scaleRoll / 0xff) * (FLORA_STUMP_SCALE_MAX - FLORA_STUMP_SCALE_MIN),
    yaw: (yawRoll / YAW_DIVISOR) * TWO_PI,
  };
}

export const STUMP_MAX_REACH_CELLS = 0.5;
