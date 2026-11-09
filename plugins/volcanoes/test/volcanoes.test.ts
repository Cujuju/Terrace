import { describe, it } from 'vitest';
import {
  announcesReheatedCells, completesManualEruptionsWithNoActivity, followsCurrentFreshwater,
  keepsEvictedReheatsOutOfStateDeltas, refusesUnreadableSnapshots, replaysVisibleStateOnUnlock,
} from './serverContracts.ts';
import { clearsWorldSynchronously, followsChangedGround, refreshesGroundAcrossChunkSeams } from './clientContracts.ts';

describe('volcano contracts', () => {
  it('parks unreadable slices and still restores legacy readable data', refusesUnreadableSnapshots);
  it('clears both renderers synchronously between worlds without replacing resources', clearsWorldSynchronously);
  it('announces reheating through deltas, events and fire ignition', announcesReheatedCells);
  it('does not resurrect reheated cells evicted in the same tick', keepsEvictedReheatsOutOfStateDeltas);
  it('checks the current freshwater map when advancing a front', followsCurrentFreshwater);
  it('moves grounded lava and existing plumes when terrain changes', followsChangedGround);
  it('refreshes seam-dependent ground without resampling unrelated flow', refreshesGroundAcrossChunkSeams);
  it('replays complete visible state only to the token that unlocked ground', replaysVisibleStateOnUnlock);
  it('finishes manual eruptions with activity none and creates no automatic vents', completesManualEruptionsWithNoActivity);
});
