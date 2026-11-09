import { test } from 'node:test';
import { protectedFootprints, currentCrashSurface } from './crash-contracts.ts';
import { projectileResolution, continuousFlight } from './encounter-contracts.ts';
import { privateTerrain } from './visibility-contracts.ts';

test('craters exclude current square building footprints and guard every computed write', protectedFootprints);
test('crash effects, dive targets and wire classification use current terrain', currentCrashSurface);
test('terrain-dependent encounters respect each recipient mask and never sample locked heights', privateTerrain);
test('projectiles advance and expire after the rival faction ends', projectileResolution);
test('complete flight corridors clear narrow peaks and react to later terrain changes', continuousFlight);
