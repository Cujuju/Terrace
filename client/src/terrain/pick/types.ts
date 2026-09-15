export interface Ndc {
  x: number;
  y: number;
}

export interface ViewportRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface CellPick {
  x: number;
  y: number;
}

export interface Vec3 {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export type PickFace = 'riser' | 'tread' | 'underside';

export interface TerrainRayPick {
  readonly x: number;
  readonly y: number;
  readonly surfaceY: number;
  readonly spanIndex: number;
  readonly face: PickFace;
  readonly hitY: number;
  readonly hitX: number;
  readonly hitZ: number;
}

export type CellVisitor = (i: number, j: number, tEnter: number, tExit: number) => boolean;

export interface ScaledRay {
  readonly ox: number;
  readonly oz: number;
  readonly oy: number;
  readonly dx: number;
  readonly dz: number;
  readonly dy: number;
}

export interface RayBoxClip {
  readonly tEnter: number;
  readonly tExit: number;
}

export interface DrawnRisers {
  segmentsOf(chunkIdx: number, band: number): Float32Array | undefined;
}

export interface DrawnCap {
  readonly t: number;
  readonly band: number;
  readonly capY: number;
  readonly drawnY: number;
  readonly u: number;
  readonly v: number;
}

export interface BandOwner {
  readonly x: number;
  readonly y: number;
  readonly spanIndex: number;
}

export interface PointedCellPick {
  readonly x: number;
  readonly y: number;
  readonly distance: number;
}
