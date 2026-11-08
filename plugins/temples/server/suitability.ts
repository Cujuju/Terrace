import { isTempleGround } from '../suitability.ts';

export { TEMPLE_FOOTPRINT_OFFSETS } from '../suitability.ts';

export interface TempleWorld {
  readonly worldSize: number;
  heightAt(x: number, y: number): number;
  isCellUnlocked(x: number, y: number): boolean;
}

export function isTempleSite(world: TempleWorld, x: number, y: number): boolean {
  return isTempleGround({
    worldSize: world.worldSize,
    heightAt: (nx, ny) => world.isCellUnlocked(nx, ny) ? world.heightAt(nx, ny) : null,
  }, x, y);
}
