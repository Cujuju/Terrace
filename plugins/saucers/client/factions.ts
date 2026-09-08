import type { ColorRepresentation } from 'three';
import { DEFAULT_SAUCER_VARIANT, SAUCER_VARIANT_COUNT } from '../protocol.ts';

const FACTION_COLOURS: readonly ColorRepresentation[] = [0x4a8fff, 0xff8f2e, 0xff3ae0];

export function factionColour(variant: number): ColorRepresentation {
  if (variant < 0 || variant >= SAUCER_VARIANT_COUNT) return FACTION_COLOURS[DEFAULT_SAUCER_VARIANT]!;
  return FACTION_COLOURS[variant] ?? FACTION_COLOURS[DEFAULT_SAUCER_VARIANT]!;
}
