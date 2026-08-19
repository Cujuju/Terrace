// THE GROUND A MONSTER WILL NOT LET YOU RAISE (owner decision, 2026-08-14).
//
// Cthulhu cannot be banished, and he does not stand aside either: a RAISE whose
// brush reaches him is refused outright. Lowering is untouched — you may dig his
// basin deeper, or drain it and leave him in the puddle, but you may not build
// the ground up under or beside him.
//
// WHERE THIS SITS. It is an intent INTERCEPTOR (server/src/plugins/types.ts),
// the same seam the mana plugin uses to price sculpts: core runs the chain
// before it touches the heightmap, so a denied raise never happens rather than
// happening and being undone. Core answers a plugin denial with the standard
// `sculptDenied` nack carrying the intent's seq, so the client retires exactly
// the prediction it made for that stroke — this plugin sends no message of its
// own and needs no client half for the feature.
//
// NO HUD FEEDBACK, deliberately, and it is the same argument the client half
// makes for having no panel at all: the reason the sculpt failed is a
// ten-cell-tall horror occupying the cells you aimed at. A toast explaining
// that would be telling a player what they are already looking at.
//
// FIXED INTERACTION (was: KNOWN, issue #19, 2026-08-18): plugins still run in
// directory order — `mana` sees an intent before `monsters` does — but mana no
// longer charges during that verdict pass. Core's intent pipeline is now
// two-phase (server/src/intent/pipeline.ts steps 3 and 6): every interceptor,
// this one included, only answers allow/deny/modify in the verdict phase, and
// a plugin that wants to spend a resource does so in `onIntentApplied`, which
// core calls only once every interceptor has allowed and the edit has
// actually landed. A raise refused here — DENY, in the verdict phase, before
// mana's own effect hook ever runs — costs the player nothing.

import type { SculptIntent } from '@terrace/shared';
import { groundProtectionRadiusCells, profileOf } from './kinds.ts';
import type { Monster } from './summoning.ts';

/** Direction field of a raise intent. Lowering is -1 and is never blocked. */
const RAISE_DIRECTION = 1;

/**
 * Reason string on the denial verdict. Server-side only — it reaches the host's
 * logs and the pipeline's IntentOutcome, never the wire.
 */
export const RAISE_BLOCKED_REASON = 'monster occupies the ground';

/**
 * Does this intent's brush reach the monster's protected ground?
 *
 * GEOMETRY, in cells, and both discs are stated exactly:
 *
 *   * the brush covers the cells with `floor(sqrt(dx² + dy²)) < radius` around
 *     its centre cell (shared/heightmap.ts applyBrush) — which is precisely the
 *     open disc of `intent.radius` about that cell's CENTRE, since flooring a
 *     distance below an integer is the same test as the distance being below
 *     it. The `+ 0.5` on the intent's integer cell coordinates is that centre;
 *   * the monster occupies the disc of groundProtectionRadiusCells about its
 *     LIVE fractional position — the same value the broadcast interpolates
 *     between, not a rounded or cell-snapped copy of it, so the refusal matches
 *     what the player can see to within one broadcast's interpolation.
 *
 * Two discs overlap exactly when the distance between their centres is less
 * than the sum of their radii. Compared squared: no Math.sqrt, and no question
 * about how a borderline case rounds.
 */
export function reachesProtectedGround(intent: SculptIntent, monster: Monster): boolean {
  const profile = profileOf(monster.kind);
  if (!profile.protectsGround) return false;
  if (intent.dir !== RAISE_DIRECTION) return false;

  const reach = intent.radius + groundProtectionRadiusCells(profile);
  const dx = intent.x + 0.5 - monster.x;
  const dy = intent.y + 0.5 - monster.y;
  return dx * dx + dy * dy < reach * reach;
}
