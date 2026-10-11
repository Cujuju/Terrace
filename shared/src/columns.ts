export { bandFloorHeight, isHeightInBand } from './bands.ts';

export {
  BEDROCK_BAND,
  BEDROCK_FLOOR,
  canonicaliseColumn,
  floorBandOfHeight,
  highestCeilingUnderSpan,
  isGapDrawn,
  isSpanDrawn,
  OPEN_COLUMN_SAMPLE,
  parsePackedSpans,
  spanCapBand,
  spanCapHeight,
  spanCoversBand,
  spansAdjacent,
  spansHaveCapAtBand,
  spanUndersideLevel,
  SPAN_STRIDE,
  type Span,
} from './columns/span.ts';

export {
  anyColumnLayered,
  applyPackedSpans,
  assertSingleSpanChunk,
  assertSingleSpanWorld,
  carveBands,
  clearColumns,
  moveSpanCeiling,
  packColumnSpans,
  readSpans,
  resetColumns,
  seabedHeight,
  setColumn,
  spanAt,
  spanCount,
  topSpan,
} from './columns/store.ts';

export {
  canCarveBandAt,
  canSpreadBandToSpan,
  columnCoversBand,
  columnHoldsRun,
  columnSampleAtBand,
  fillBandRun,
  highestCeilingBelow,
  runFloorBandAt,
  spanIndexBelowBand,
  spanIndexCoveringBand,
} from './columns/bandQueries.ts';
