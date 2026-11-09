export interface CellColumn {
  readonly loY: number;
  readonly hiY: number;
  readonly cell?: { readonly x: number; readonly y: number };
}

export interface CellRayChord {
  readonly fromX: number;
  readonly fromY?: number;
  readonly fromZ: number;
  readonly toX: number;
  readonly toY?: number;
  readonly toZ: number;
}

export type CellOccupancy = (x: number, y: number, chord: CellRayChord) => CellColumn | null;
