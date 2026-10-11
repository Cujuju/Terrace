export const FLORA_STABILITY_SECONDS = 90;

export class StabilityMap {
  private readonly lastChangedSeconds: Int32Array;

  readonly worldSize: number;

  constructor(worldSize: number) {
    this.worldSize = worldSize;
    this.lastChangedSeconds = new Int32Array(worldSize * worldSize);
  }

  private indexOf(x: number, y: number): number {
    if (x < 0 || y < 0 || x >= this.worldSize || y >= this.worldSize) return -1;
    return y * this.worldSize + x;
  }

  markChanged(x: number, y: number, nowSeconds: number): void {
    const index = this.indexOf(x, y);
    if (index < 0) return;
    this.lastChangedSeconds[index] = Math.floor(nowSeconds);
  }

  secondsSinceChange(x: number, y: number, nowSeconds: number): number {
    const index = this.indexOf(x, y);
    if (index < 0) return 0;
    return nowSeconds - this.lastChangedSeconds[index];
  }

  isStable(x: number, y: number, nowSeconds: number): boolean {
    return this.secondsSinceChange(x, y, nowSeconds) >= FLORA_STABILITY_SECONDS;
  }
}
