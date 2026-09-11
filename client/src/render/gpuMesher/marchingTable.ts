// Port of bench/webgpu-mesher/marching.mjs. Refs 0..3 are corners NW, NE, SE, SW;
// 4..7 are crossings on sides N, E, S, W. Mask bits match contours.ts.

export const MARCH_CORNER_REFS = 4;

export const MARCH_MAX_POLY_REFS = 8;

export const MARCH_MAX_POLYS = 2;

/** Masks 0..15 read with saddles joined, plus the split readings of 5 and 10. */
export const MARCH_CASE_COUNT = 18;

export const MARCH_SADDLE_5_SPLIT_CASE = 16;

export const MARCH_SADDLE_10_SPLIT_CASE = 17;

/** Where the ref block starts once len and ref share one buffer. */
export const MARCH_REF_BASE = MARCH_CASE_COUNT * MARCH_MAX_POLYS;

export const MARCH_TABLE_WORDS = MARCH_REF_BASE + MARCH_REF_BASE * MARCH_MAX_POLY_REFS;

/** [from corner, to corner, crossing ref], walked in order so the polygon is one loop. */
const SIDES: readonly (readonly [number, number, number])[] = [
  [0, 1, 4],
  [1, 2, 5],
  [2, 3, 6],
  [3, 0, 7],
];

function walk(mask: number): number[] {
  const poly: number[] = [];
  for (const [from, to, cross] of SIDES) {
    const inFrom = (mask & (1 << from)) !== 0;
    if (inFrom) poly.push(from);
    if (inFrom !== ((mask & (1 << to)) !== 0)) poly.push(cross);
  }
  return poly;
}

export interface MarchingTable {
  readonly polygons: readonly (readonly number[])[][];
  readonly len: Int32Array;
  readonly ref: Int32Array;
}

export function buildMarchingTable(): MarchingTable {
  const polygons: (readonly number[])[][] = [];
  for (let mask = 0; mask < 16; mask++) {
    const poly = walk(mask);
    polygons.push(poly.length === 0 ? [] : [poly]);
  }
  // A split saddle is the two corner triangles the joined hexagon would merge.
  polygons[MARCH_SADDLE_5_SPLIT_CASE] = [
    [0, 4, 7],
    [2, 6, 5],
  ];
  polygons[MARCH_SADDLE_10_SPLIT_CASE] = [
    [4, 1, 5],
    [6, 3, 7],
  ];

  const len = new Int32Array(MARCH_CASE_COUNT * MARCH_MAX_POLYS);
  const ref = new Int32Array(MARCH_CASE_COUNT * MARCH_MAX_POLYS * MARCH_MAX_POLY_REFS);
  for (let c = 0; c < MARCH_CASE_COUNT; c++) {
    for (let p = 0; p < MARCH_MAX_POLYS; p++) {
      const poly = polygons[c]![p] ?? [];
      if (poly.length > MARCH_MAX_POLY_REFS) {
        throw new RangeError(`case ${c} polygon ${p} has ${poly.length} refs`);
      }
      len[c * MARCH_MAX_POLYS + p] = poly.length;
      for (let v = 0; v < poly.length; v++) {
        ref[(c * MARCH_MAX_POLYS + p) * MARCH_MAX_POLY_REFS + v] = poly[v]!;
      }
    }
  }
  return { polygons, len, ref };
}

/** len then ref in one storage buffer, the layout the kernel indexes. */
export function marchingTableBuffer(): Int32Array {
  const { len, ref } = buildMarchingTable();
  const out = new Int32Array(MARCH_TABLE_WORDS);
  out.set(len, 0);
  out.set(ref, MARCH_REF_BASE);
  return out;
}
