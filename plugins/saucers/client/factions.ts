// THE FACTION COLOURS, one per hull — a faction IS a hull (../protocol.ts).
//
// These are the ring and light-strip emissives the three authored files carry
// (saucer-a: blue, saucer-b: amber, saucer-c: magenta; read out of the GLBs'
// KHR materials, 2026-09-04) as the hangar rig states them
// (.saucer-hangar/hangar.template.html, SPECS). They are restated here rather
// than sampled from the loaded material because two things need them that
// never touch a hull: a bolt, which must wear its shooter's colour (owner,
// 2026-09-04: "the laser colors match the saucer color, which should match the
// faction"), and the fallback body drawn when no file is installed.
//
// Indexed by variant. An edit to a hull's livery is an edit here too.

import type { ColorRepresentation } from 'three';
import { DEFAULT_SAUCER_VARIANT, SAUCER_VARIANT_COUNT } from '../protocol.ts';

const FACTION_COLOURS: readonly ColorRepresentation[] = [0x4a8fff, 0xff8f2e, 0xff3ae0];

/** The colour a saucer of this variant fights in. Out of range → the default hull's. */
export function factionColour(variant: number): ColorRepresentation {
  if (variant < 0 || variant >= SAUCER_VARIANT_COUNT) return FACTION_COLOURS[DEFAULT_SAUCER_VARIANT]!;
  return FACTION_COLOURS[variant] ?? FACTION_COLOURS[DEFAULT_SAUCER_VARIANT]!;
}
