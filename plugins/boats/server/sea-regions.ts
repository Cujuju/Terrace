import {
  CHUNK_SIZE,
  isWalkableCell,
  navigableWaterProfile,
  type TerrainSampler,
  type TraversalProfile,
} from '@terrace/shared';

// One chunk's worth of scan/flood steps per tick, independent of the world's area.
export const SEA_REGION_STEPS_PER_TICK = CHUNK_SIZE * CHUNK_SIZE;

const LABELS_PER_PAGE = CHUNK_SIZE * CHUNK_SIZE;
const BLOCKED = -1;
const UNKNOWN = 0;
const CARDINAL_NEIGHBOURS = [[0, -1], [1, 0], [0, 1], [-1, 0]] as const;

/** Water admits every rise; legal diagonals require both flanks, so cardinal floods yield the same components. */
export class SeaRegionIndex {
  private readonly pages = new Map<number, Int32Array>();
  private readonly frontier = new Map<number, number>();
  private readonly profile: TraversalProfile;
  private readonly size: number;
  private head = 0;
  private tail = 0;
  private cursor = 0;
  private regions = 0;

  constructor(size: number, draftHeightUnits: number) {
    this.size = size;
    this.profile = navigableWaterProfile(draftHeightUnits);
  }

  get regionCount(): number { return this.regions; }

  get complete(): boolean {
    return this.cursor >= this.size * this.size && this.head === this.tail;
  }

  at(x: number, y: number): number {
    const cx = Math.floor(x), cy = Math.floor(y);
    if (cx < 0 || cy < 0 || cx >= this.size || cy >= this.size) return UNKNOWN;
    return Math.max(UNKNOWN, this.label(cy * this.size + cx));
  }

  advance(world: TerrainSampler, steps = SEA_REGION_STEPS_PER_TICK): void {
    for (let step = 0; step < steps && !this.complete; step++) {
      if (this.head === this.tail) {
        const key = this.cursor++;
        if (this.label(key) !== UNKNOWN) continue;
        const x = key % this.size, y = Math.floor(key / this.size);
        if (!isWalkableCell(world, this.profile, x, y)) {
          this.setLabel(key, BLOCKED);
          continue;
        }
        this.regions++;
        this.enqueue(key);
        this.setLabel(key, this.regions);
        continue;
      }
      const key = this.frontier.get(this.head)!;
      this.frontier.delete(this.head++);
      const x = key % this.size, y = Math.floor(key / this.size);
      for (const [dx, dy] of CARDINAL_NEIGHBOURS) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= this.size || ny >= this.size) continue;
        const neighbour = ny * this.size + nx;
        if (this.label(neighbour) !== UNKNOWN) continue;
        if (!isWalkableCell(world, this.profile, nx, ny)) {
          this.setLabel(neighbour, BLOCKED);
          continue;
        }
        this.setLabel(neighbour, this.regions);
        this.enqueue(neighbour);
      }
    }
  }

  private enqueue(key: number): void {
    this.frontier.set(this.tail++, key);
  }

  private label(key: number): number {
    return this.pages.get(Math.floor(key / LABELS_PER_PAGE))?.[key % LABELS_PER_PAGE] ?? UNKNOWN;
  }

  private setLabel(key: number, label: number): void {
    const pageKey = Math.floor(key / LABELS_PER_PAGE);
    let page = this.pages.get(pageKey);
    if (page === undefined) {
      page = new Int32Array(LABELS_PER_PAGE);
      this.pages.set(pageKey, page);
    }
    page[key % LABELS_PER_PAGE] = label;
  }
}
