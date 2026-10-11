export interface CellColumn {
  readonly loY: number;
  readonly hiY: number;
}

export interface CellRayChord {
  readonly fromX: number;
  readonly fromZ: number;
  readonly toX: number;
  readonly toZ: number;
}

export type CellOccupancy = (x: number, y: number, chord: CellRayChord) => CellColumn | null;
