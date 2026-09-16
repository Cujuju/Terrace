export { bandFloorHeight, isHeightInBand } from './bands.ts';

export {
  BEDROCK_FLOOR,
  BEDROCK_REMNANT_CEILING,
  highestCeilingUnderSpan,
  isGapDrawn,
  isSpanDrawn,
  OPEN_COLUMN_SAMPLE,
  parsePackedSpans,
  spanCapHeight,
  spanLowestBandHeight,
  spansHaveCapAtBand,
  spanUndersideHeight,
  type Span,
} from './columns/span.ts';

export {
  anyColumnLayered,
  applyPackedSpans,
  assertSingleSpanChunk,
  assertSingleSpanWorld,
  carveRange,
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
  applyBandFill,
  bandFillAt,
  canCarveBandAt,
  canSpreadBandToSpan,
  columnCoversBand,
  columnSampleAtBand,
  highestCeilingBelow,
  overhangSlabAt,
  spanIndexBelowBand,
  spanIndexCoveringBand,
  type BandFill,
} from './columns/bandQueries.ts';
