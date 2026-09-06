// Scratch check (uncommitted): the envelope invariance proof for the deepsea.
// Imports HEAD's models.ts as client/.old-models.ts (a `git show HEAD:` copy)
// for the old DEEPSEA_ENVELOPE, and the new species/deepsea.ts, compares
// crownY / bellyY with Object.is, prints the placement rows that read them
// (BODY_COLUMNS.deepsea; SWIM_PROFILES.deepsea is hand-set and must be
// unchanged too), and shows that models.ts no longer exports the envelope.
import * as OldModels from './client/.old-models.ts';
import * as NewModels from './client/models.ts';
import { DEEPSEA_ENVELOPE as OLD } from './client/.old-models.ts';
import { DEEPSEA_ENVELOPE as NEW } from './client/species/deepsea.ts';
import { BODY_COLUMNS, SWIM_PROFILES } from './client/placement.ts';

console.log('old DEEPSEA_ENVELOPE (models.ts @HEAD):', JSON.stringify(OLD));
console.log('new DEEPSEA_ENVELOPE (species/deepsea.ts):', JSON.stringify(NEW));
let identical = true;
for (const key of ['crownY', 'bellyY'] as const) {
  const same = Object.is(OLD[key], NEW[key]);
  identical &&= same;
  console.log(`  ${key.padEnd(7)} old=${OLD[key]} new=${NEW[key]} ${same ? 'IDENTICAL' : 'DIFFERENT'}`);
}
console.log(`  new-only fields: length ${NEW.length}, halfLength ${NEW.halfLength}, halfWidth ${NEW.halfWidth} (what the file measures; placement reads none of them)`);

// The placement rows, evaluated: BODY_COLUMNS.deepsea reads the envelope,
// SWIM_PROFILES.deepsea is hand-set. Both must be byte-identical to HEAD's
// evaluation, which is the same literals: {"bellyY":-0.35,"crownY":0.35} and
// {"depthFraction":0.88,"minClearance":0.8,"minSubmergence":0.5,"halfLength":0.5,"halfWidth":0.28}.
const expectedColumn = '{"bellyY":-0.35,"crownY":0.35}';
const expectedProfile = '{"depthFraction":0.88,"minClearance":0.8,"minSubmergence":0.5,"halfLength":0.5,"halfWidth":0.28}';
const column = JSON.stringify(BODY_COLUMNS.deepsea);
const profile = JSON.stringify(SWIM_PROFILES.deepsea);
console.log('BODY_COLUMNS.deepsea :', column, column === expectedColumn ? 'IDENTICAL to HEAD' : 'DIFFERENT');
console.log('SWIM_PROFILES.deepsea:', profile, profile === expectedProfile ? 'IDENTICAL to HEAD' : 'DIFFERENT');
identical &&= column === expectedColumn && profile === expectedProfile;
identical &&= Object.is(BODY_COLUMNS.deepsea.crownY, OLD.crownY) && Object.is(BODY_COLUMNS.deepsea.bellyY, OLD.bellyY);

console.log('old models.ts exports:', Object.keys(OldModels).sort().join(', '));
console.log('new models.ts exports:', Object.keys(NewModels).sort().join(', '));
identical &&= !('DEEPSEA_ENVELOPE' in NewModels);
console.log(identical ? 'ALL IDENTICAL' : 'MISMATCH');
if (!identical) process.exit(1);
