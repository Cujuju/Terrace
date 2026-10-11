import { isBuildableCell, type StructuresWorld } from './suitability.ts';

export interface LandmassBox {
  readonly minX: number;
  readonly maxX: number;
  readonly minY: number;
  readonly maxY: number;
}

export interface LandmassLabels {
  readonly worldSize: number;
  readonly count: number;
  readonly boxes: readonly LandmassBox[];
  labelAt(x: number, y: number): number;
  rowEntry(label: number, y: number, step: number, skipIndex: number): number;
  columnEntry(label: number, x: number, step: number, skipIndex: number): number;
}

const NO_LANDMASS = -1;

const FLOOD_OFFSETS: ReadonlyArray<readonly [number, number]> = [
  [-1, -1], [0, -1], [1, -1],
  [-1, 0],           [1, 0],
  [-1, 1],  [0, 1],  [1, 1],
];

interface AxisExtents {
  readonly offsets: Int32Array;
  readonly first: Int32Array;
  readonly second: Int32Array;
  readonly last: Int32Array;
  readonly penultimate: Int32Array;
}

function emptyExtents(spans: readonly number[]): AxisExtents {
  const offsets = new Int32Array(spans.length);
  let total = 0;
  for (let label = 0; label < spans.length; label++) {
    offsets[label] = total;
    total += spans[label]!;
  }
  return {
    offsets,
    first: new Int32Array(total).fill(NO_LANDMASS),
    second: new Int32Array(total).fill(NO_LANDMASS),
    last: new Int32Array(total).fill(NO_LANDMASS),
    penultimate: new Int32Array(total).fill(NO_LANDMASS),
  };
}

function recordExtent(extents: AxisExtents, label: number, line: number, position: number): void {
  const slot = extents.offsets[label]! + line;
  if (extents.first[slot]! < 0) extents.first[slot] = position;
  else if (extents.second[slot]! < 0) extents.second[slot] = position;
  if (extents.last[slot]! >= 0) extents.penultimate[slot] = extents.last[slot]!;
  extents.last[slot] = position;
}

function extentsOn(
  extents: AxisExtents,
  label: number,
  line: number,
  step: number,
): readonly [number, number] {
  const slot = extents.offsets[label]! + line;
  return step > 0
    ? [extents.first[slot]!, extents.second[slot]!]
    : [extents.last[slot]!, extents.penultimate[slot]!];
}

class Labelling implements LandmassLabels {
  readonly worldSize: number;
  readonly boxes: readonly LandmassBox[];
  private readonly cells: Int32Array;
  private readonly rows: AxisExtents;
  private readonly columns: AxisExtents;

  constructor(
    worldSize: number,
    cells: Int32Array,
    boxes: readonly LandmassBox[],
    rows: AxisExtents,
    columns: AxisExtents,
  ) {
    this.worldSize = worldSize;
    this.cells = cells;
    this.boxes = boxes;
    this.rows = rows;
    this.columns = columns;
  }

  get count(): number {
    return this.boxes.length;
  }

  labelAt(x: number, y: number): number {
    if (x < 0 || y < 0 || x >= this.worldSize || y >= this.worldSize) return NO_LANDMASS;
    return this.cells[y * this.worldSize + x]!;
  }

  rowEntry(label: number, y: number, step: number, skipIndex: number): number {
    const box = this.boxes[label];
    if (box === undefined || y < box.minY || y > box.maxY) return NO_LANDMASS;
    const [nearest, runnerUp] = extentsOn(this.rows, label, y - box.minY, step);
    if (nearest < 0) return NO_LANDMASS;
    const index = y * this.worldSize + nearest;
    if (index !== skipIndex) return index;
    if (runnerUp < 0) return NO_LANDMASS;
    return y * this.worldSize + runnerUp;
  }

  columnEntry(label: number, x: number, step: number, skipIndex: number): number {
    const box = this.boxes[label];
    if (box === undefined || x < box.minX || x > box.maxX) return NO_LANDMASS;
    const [nearest, runnerUp] = extentsOn(this.columns, label, x - box.minX, step);
    if (nearest < 0) return NO_LANDMASS;
    const index = nearest * this.worldSize + x;
    if (index !== skipIndex) return index;
    if (runnerUp < 0) return NO_LANDMASS;
    return runnerUp * this.worldSize + x;
  }
}

export function computeLandmassLabels(world: StructuresWorld): LandmassLabels {
  const size = world.worldSize;
  const buildable = new Uint8Array(Math.max(0, size * size));
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (isBuildableCell(world, x, y)) buildable[y * size + x] = 1;
    }
  }
  return computeLandmassLabelsFromBuildable(size, buildable);
}

export function computeLandmassLabelsFromBuildable(
  size: number,
  buildable: Uint8Array,
): LandmassLabels {
  const labeller = new IncrementalLandmassLabeller();
  labeller.begin(size, buildable);
  return labeller.advance(Number.MAX_SAFE_INTEGER)!;
}

const FLOOD_UNITS_PER_POP = 8;

const EXTENTS_LINE_UNITS_PER_CELL = 2;

export const LABEL_UNITS_PER_BOARD_CELL =
  3 + FLOOD_UNITS_PER_POP + EXTENTS_LINE_UNITS_PER_CELL;

type LabelPhase = 'idle' | 'clear' | 'flood' | 'extents';

export class IncrementalLandmassLabeller {
  private size = 0;
  private buildable: Uint8Array | null = null;
  private buffers: [Int32Array, Int32Array] = [new Int32Array(0), new Int32Array(0)];
  private write = 0;
  private phase: LabelPhase = 'idle';
  private cursor = 0;
  private stack: number[] = [];
  private boxes: LandmassBox[] = [];
  private componentOpen = false;
  private label = 0;
  private minX = 0;
  private maxX = 0;
  private minY = 0;
  private maxY = 0;
  private rows: AxisExtents | null = null;
  private columns: AxisExtents | null = null;

  get active(): boolean {
    return this.phase !== 'idle';
  }

  begin(size: number, buildable: Uint8Array): void {
    const cellCount = size > 0 ? size * size : 0;
    if (this.buffers[this.write].length !== cellCount) {
      this.buffers = [new Int32Array(cellCount), new Int32Array(cellCount)];
    }
    this.size = size;
    this.buildable = buildable;
    this.cursor = 0;
    this.stack.length = 0;
    this.boxes = [];
    this.componentOpen = false;
    this.rows = null;
    this.columns = null;
    this.phase = cellCount <= 0 ? 'extents' : 'clear';
  }

  abandon(): void {
    this.phase = 'idle';
    this.buildable = null;
    this.stack.length = 0;
    this.boxes = [];
    this.componentOpen = false;
    this.rows = null;
    this.columns = null;
  }

  advance(cellBudget: number): LandmassLabels | null {
    let budget = Math.floor(cellBudget);
    while (budget > 0 && this.phase !== 'idle') {
      if (this.phase === 'clear') budget = this.stepClear(budget);
      else if (this.phase === 'flood') budget = this.stepFlood(budget);
      else return this.stepExtents(budget);
    }
    return null;
  }

  private stepClear(budget: number): number {
    const total = this.buffers[this.write].length;
    const take = Math.min(budget, total - this.cursor);
    this.buffers[this.write].fill(NO_LANDMASS, this.cursor, this.cursor + take);
    this.cursor += take;
    if (this.cursor >= total) {
      this.cursor = 0;
      this.phase = 'flood';
    }
    return budget - take;
  }

  private stepFlood(budget: number): number {
    const size = this.size;
    const cells = this.buffers[this.write];
    const total = cells.length;
    const buildable = this.buildable!;
    const stack = this.stack;
    while (budget > 0) {
      if (stack.length > 0) {
        const index = stack.pop()!;
        budget -= FLOOD_UNITS_PER_POP;
        const y = (index / size) | 0;
        const x = index - y * size;
        if (x < this.minX) this.minX = x;
        if (x > this.maxX) this.maxX = x;
        if (y < this.minY) this.minY = y;
        if (y > this.maxY) this.maxY = y;
        for (const [ox, oy] of FLOOD_OFFSETS) {
          const nx = x + ox;
          const ny = y + oy;
          if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue;
          const nIndex = ny * size + nx;
          if (buildable[nIndex] === 0 || cells[nIndex] !== NO_LANDMASS) continue;
          cells[nIndex] = this.label;
          stack.push(nIndex);
        }
        continue;
      }
      if (this.componentOpen) {
        this.boxes.push({ minX: this.minX, maxX: this.maxX, minY: this.minY, maxY: this.maxY });
        this.componentOpen = false;
        continue;
      }
      if (this.cursor >= total) {
        return budget - this.beginExtents();
      }
      const seed = this.cursor++;
      budget--;
      if (buildable[seed] === 0 || cells[seed] !== NO_LANDMASS) continue;
      const y0 = (seed / size) | 0;
      this.label = this.boxes.length;
      this.minX = seed - y0 * size;
      this.maxX = this.minX;
      this.minY = y0;
      this.maxY = y0;
      this.componentOpen = true;
      cells[seed] = this.label;
      stack.push(seed);
    }
    return budget;
  }

  private beginExtents(): number {
    const rowSpans = this.boxes.map((box) => box.maxY - box.minY + 1);
    const columnSpans = this.boxes.map((box) => box.maxX - box.minX + 1);
    this.rows = emptyExtents(rowSpans);
    this.columns = emptyExtents(columnSpans);
    this.cursor = 0;
    this.phase = 'extents';
    let lines = 0;
    for (let label = 0; label < rowSpans.length; label++) {
      lines += rowSpans[label]! + columnSpans[label]!;
    }
    return lines;
  }

  private stepExtents(budget: number): LandmassLabels | null {
    const size = this.size;
    const cells = this.buffers[this.write];
    const total = cells.length;
    const rows = this.rows ?? emptyExtents([]);
    const columns = this.columns ?? emptyExtents([]);
    const end = Math.min(total, this.cursor + budget);
    for (let index = this.cursor; index < end; index++) {
      const label = cells[index]!;
      if (label === NO_LANDMASS) continue;
      const y = (index / size) | 0;
      const x = index - y * size;
      const box = this.boxes[label]!;
      recordExtent(rows, label, y - box.minY, x);
      recordExtent(columns, label, x - box.minX, y);
    }
    this.cursor = end;
    if (this.cursor < total) return null;

    const published = new Labelling(size, cells, this.boxes, rows, columns);
    this.write ^= 1;
    this.phase = 'idle';
    this.buildable = null;
    this.stack.length = 0;
    return published;
  }
}

function scanDiagonal(
  labels: LandmassLabels,
  label: number,
  box: LandmassBox,
  stepX: number,
  stepY: number,
  selfIndex: number,
): number {
  const width = box.maxX - box.minX + 1;
  const height = box.maxY - box.minY + 1;
  const span = width < height ? width : height;
  const startX = stepX > 0 ? box.minX : box.maxX;
  const startY = stepY > 0 ? box.minY : box.maxY;
  for (let i = 0; i < span; i++) {
    const x = startX + i * stepX;
    const y = startY + i * stepY;
    if (labels.labelAt(x, y) !== label) continue;
    const index = y * labels.worldSize + x;
    if (index === selfIndex) continue;
    return index;
  }
  return -1;
}

export function wrappedNeighborIndex(
  labels: LandmassLabels,
  x: number,
  y: number,
  dx: number,
  dy: number,
): number {
  const label = labels.labelAt(x, y);
  if (label === NO_LANDMASS) return -1;

  const size = labels.worldSize;
  const nx = x + dx;
  const ny = y + dy;
  if (labels.labelAt(nx, ny) === label) return ny * size + nx;

  const box = labels.boxes[label]!;
  const selfIndex = y * size + x;

  if (dx !== 0) {
    const wrapped = labels.rowEntry(label, ny, dx, selfIndex);
    if (wrapped >= 0) return wrapped;
  }
  if (dy !== 0) {
    const wrapped = labels.columnEntry(label, nx, dy, selfIndex);
    if (wrapped >= 0) return wrapped;
  }
  if (dx !== 0 && dy !== 0) {
    const wrapped = scanDiagonal(labels, label, box, dx, dy, selfIndex);
    if (wrapped >= 0) return wrapped;
  }
  return -1;
}
