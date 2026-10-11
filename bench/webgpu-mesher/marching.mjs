// The marching-squares case table, built once here and shared by dump.mjs (which
// ships it to the page) and selfcheck.mjs (which proves it consistent).
//
// Corner refs 0..3 are NW, NE, SE, SW; crossing refs 4..7 are the crossings on
// sides N, E, S, W. Mask bits follow contours.ts: 1 = NW, 2 = NE, 4 = SE, 8 = SW.
// Case index 0..15 is the mask with saddles taken joined; 16 and 17 are the
// split readings of masks 5 and 10, which is the split/joined choice
// contours.ts makes from the mean of the four corner heights.

export const CORNER_REFS = 4;
export const MAX_POLY_REFS = 8;
export const MAX_POLYS = 2;
export const CASE_COUNT = 18;
export const SADDLE_5_SPLIT_CASE = 16;
export const SADDLE_10_SPLIT_CASE = 17;

// Each side is [from corner, to corner, crossing ref], walked in order so the
// polygon comes out as one boundary loop.
const SIDES = [[0, 1, 4], [1, 2, 5], [2, 3, 6], [3, 0, 7]];

export const REF_POSITION = [
  [0, 0], [1, 0], [1, 1], [0, 1],
  [1 / 2, 0], [1, 1 / 2], [1 / 2, 1], [0, 1 / 2],
];

const walk = (mask) => {
  const poly = [];
  for (const [from, to, cross] of SIDES) {
    const inFrom = (mask & (1 << from)) !== 0;
    if (inFrom) poly.push(from);
    if (inFrom !== ((mask & (1 << to)) !== 0)) poly.push(cross);
  }
  return poly;
};

export function buildMarchingTable() {
  const polys = [];
  for (let mask = 0; mask < 16; mask++) {
    const poly = walk(mask);
    polys.push(poly.length === 0 ? [] : [poly]);
  }
  // A split saddle is the two corner triangles the joined hexagon would merge.
  polys[SADDLE_5_SPLIT_CASE] = [[0, 4, 7], [2, 6, 5]];
  polys[SADDLE_10_SPLIT_CASE] = [[4, 1, 5], [6, 3, 7]];
  const len = new Int32Array(CASE_COUNT * MAX_POLYS);
  const ref = new Int32Array(CASE_COUNT * MAX_POLYS * MAX_POLY_REFS);
  for (let c = 0; c < CASE_COUNT; c++) {
    for (let p = 0; p < MAX_POLYS; p++) {
      const poly = polys[c][p] ?? [];
      if (poly.length > MAX_POLY_REFS) throw new RangeError(`case ${c} polygon ${p} has ${poly.length} refs`);
      len[c * MAX_POLYS + p] = poly.length;
      poly.forEach((r, v) => { ref[(c * MAX_POLYS + p) * MAX_POLY_REFS + v] = r; });
    }
  }
  return { polys, len, ref };
}

// A polygon edge between two crossing refs is a contour segment; every other
// edge lies on the square's own boundary. This is the single rule the WGSL uses
// to decide where a riser goes, so the self-check exercises exactly it.
export const isCrossingRef = (r) => r >= CORNER_REFS;

export function contourSegments(polys) {
  const segments = [];
  for (const poly of polys) {
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i];
      const b = poly[(i + 1) % poly.length];
      if (isCrossingRef(a) && isCrossingRef(b)) segments.push([a, b]);
    }
  }
  return segments;
}

export function polygonArea(poly) {
  let twice = 0;
  for (let i = 0; i < poly.length; i++) {
    const [ax, az] = REF_POSITION[poly[i]];
    const [bx, bz] = REF_POSITION[poly[(i + 1) % poly.length]];
    twice += ax * bz - az * bx;
  }
  return Math.abs(twice) / 2;
}

// The reading of the complement mask that partitions the same square: a saddle
// read joined on one side must be read split on the other.
export function complementCase(caseIndex) {
  if (caseIndex === 5) return SADDLE_10_SPLIT_CASE;
  if (caseIndex === 10) return SADDLE_5_SPLIT_CASE;
  if (caseIndex === SADDLE_5_SPLIT_CASE) return 10;
  if (caseIndex === SADDLE_10_SPLIT_CASE) return 5;
  return 15 - caseIndex;
}
