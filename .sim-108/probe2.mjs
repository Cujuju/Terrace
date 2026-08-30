// Throwaway probe: can a PLAYER still build a mountain? Stacked clicks under
// the wire defaults (anchor 'clicked', spill 'banded') and under the library
// defaults (smooth/soft/free/free), old rule vs new.
import * as OLD from './old-src/index.ts';
import * as NEW from '../shared/src/index.ts';

for (const [label, M] of [['old', OLD], ['new', NEW]]) {
  for (const [optLabel, opts] of [
    ['library default (free/free)', undefined],
    ['wire default (clicked/banded)', M.WIRE_DEFAULT_SCULPT_OPTIONS],
    ['stamp/hard', { tool: 'stamp', profile: 'hard' }],
  ]) {
    for (const radius of [2, 8]) {
      const clicks = (M.MAX_HEIGHT * 6) / M.DEFAULT_SCULPT_AMOUNT;
      const map = M.createHeightmap(64);
      let sum0 = 0;
      for (let i = 0; i < map.cells.length; i++) sum0 += map.cells[i];
      for (let k = 0; k < clicks; k++) M.applySculpt(map, 32, 32, radius, M.DEFAULT_SCULPT_AMOUNT, opts);
      let sum1 = 0;
      for (let i = 0; i < map.cells.length; i++) sum1 += map.cells[i];
      console.log(
        `${label.padEnd(4)} ${String(optLabel).padEnd(30)} r=${radius}  peak=${String(M.heightAt(map, 32, 32)).padStart(5)}  mapTotal ${String(sum0).padStart(8)} -> ${String(sum1).padStart(9)}`,
      );
    }
  }
  console.log('');
}
