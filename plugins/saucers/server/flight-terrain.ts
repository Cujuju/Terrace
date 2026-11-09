import {
  CHUNK_SIZE,
  chunksPerEdge,
  MAX_HEIGHT,
  SEA_LEVEL,
  pointWithinSweep,
  type CellDiff,
} from '@terrace/shared';
import {
  CRUISE_ALTITUDE_WORLD_UNITS,
  HEIGHT_WORLD_SCALE,
  SAUCER_DIAMETER_CELLS,
} from '../protocol.ts';

export interface FlightWorld {
  readonly worldSize: number;
  heightAt(x: number, y: number): number;
  isCellUnlocked(x: number, y: number): boolean;
}

interface Point {
  readonly x: number;
  readonly y: number;
}

// A drawn square can use a diagonal neighbour; rounding either route endpoint adds another half-cell diagonal.
const DRAWN_SAMPLE_HALO_CELLS = Math.SQRT2;
const ENDPOINT_ROUNDING_HALO_CELLS = Math.SQRT1_2;
const HULL_RADIUS_CELLS = SAUCER_DIAMETER_CELLS / 2;

export class FlightTerrain {
  private readonly cells = new Set<number>();
  private readonly chunks = new Map<number, Point>();
  private peak = SEA_LEVEL;

  altitude(): number {
    return this.peak * HEIGHT_WORLD_SCALE + CRUISE_ALTITUDE_WORLD_UNITS;
  }

  includeCorridor(world: FlightWorld, from: Point, to: Point, routeRadius = 0): void {
    const radius = Math.ceil(
      routeRadius + HULL_RADIUS_CELLS + DRAWN_SAMPLE_HALO_CELLS + ENDPOINT_ROUNDING_HALO_CELLS,
    );
    const sweep = {
      fromX: Math.round(from.x), fromY: Math.round(from.y),
      toX: Math.round(to.x), toY: Math.round(to.y),
      radius, radiusSquared: radius * radius,
    };
    const minX = Math.max(0, Math.min(sweep.fromX, sweep.toX) - radius);
    const maxX = Math.min(world.worldSize - 1, Math.max(sweep.fromX, sweep.toX) + radius);
    const minY = Math.max(0, Math.min(sweep.fromY, sweep.toY) - radius);
    const maxY = Math.min(world.worldSize - 1, Math.max(sweep.fromY, sweep.toY) + radius);
    for (let y = minY; y <= maxY; y++) {
      for (let x = minX; x <= maxX; x++) {
        if (!pointWithinSweep(sweep, x, y)) continue;
        const key = y * world.worldSize + x;
        if (this.cells.has(key)) continue;
        this.cells.add(key);
        this.read(world, x, y);
      }
    }
  }

  refresh(world: FlightWorld, diff: readonly CellDiff[]): number {
    const before = this.altitude();
    for (const cell of diff) {
      if (this.cells.has(cell.y * world.worldSize + cell.x)) this.read(world, cell.x, cell.y);
    }
    return this.altitude() - before;
  }

  visibleTo(world: { isChunkVisibleTo(id: string, x: number, y: number): boolean }, id: string): boolean {
    for (const chunk of this.chunks.values()) {
      if (!world.isChunkVisibleTo(id, chunk.x, chunk.y)) return false;
    }
    return true;
  }

  private read(world: FlightWorld, x: number, y: number): void {
    // Locked terrain uses its public upper bound and is never read.
    if (!world.isCellUnlocked(x, y)) {
      this.peak = MAX_HEIGHT;
      return;
    }
    const cx = Math.floor(x / CHUNK_SIZE);
    const cy = Math.floor(y / CHUNK_SIZE);
    const key = cy * chunksPerEdge(world.worldSize) + cx;
    if (!this.chunks.has(key)) this.chunks.set(key, { x: cx, y: cy });
    this.peak = Math.max(this.peak, world.heightAt(x, y));
  }
}
