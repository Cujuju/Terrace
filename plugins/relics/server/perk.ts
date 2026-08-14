// The mana-perk half of the skill roster: what Azure Heart and Spring of Aether
// are worth, and how two of them combine into the single value mana's perk API
// takes.
//
// `ManaPerk` is declared HERE rather than imported from plugins/mana, even as a
// type. The whole premise of the bridge next door is that plugins/mana may not
// exist on this machine; a type-only import would still be a path that has to
// resolve at typecheck time, so declaring the structural shape locally is what
// makes "mana is optional" true at every level rather than only at runtime.
// The cost is one duplicated interface, and it is the correct duplication: it
// is a compatibility contract between two independently-deletable folders, not
// a second copy of one owner's type.

import { SKILLS, type SkillId } from '../protocol.ts';

/** Structural mirror of mana's `ManaPerk`. Omitted field = neutral (1). */
export interface ManaPerk {
  readonly costMultiplier?: number;
  readonly regenMultiplier?: number;
}

/**
 * Azure Heart: sculpts cost half.
 *
 * A half, not a third or a quarter, because mana's own numbers make halving
 * legible: MANA_CAPACITY / MANA_COST_PER_SCULPT sculpts from a full pool,
 * so the perk reads as "16 from full" — a doubling a player can count. It also
 * sits at the ceiling of what mana's perk band allows to be given away
 * (MANA_PERK_MIN_MULTIPLIER is 0.25), leaving room for a future relic to stack
 * on top without the clamp silently swallowing it.
 */
export const AZURE_HEART_COST_MULTIPLIER = 0.5;

/**
 * Spring of Aether: mana regenerates twice as fast.
 *
 * Chosen to mirror Azure Heart rather than to out-do it: at 2× regen a holder
 * sustains a sculpt every 0.625 s instead of every 1.25 s, which is the same
 * doubling of throughput Azure Heart gives, arrived at from the other side. Two
 * perks of equal weight means a player picking between the two relics is making
 * a style choice (burst capacity vs. sustain), not a power choice.
 */
export const SPRING_OF_AETHER_REGEN_MULTIPLIER = 2;

/** Neutral multiplier — matches mana's own default for an unmodified player. */
export const NEUTRAL_MULTIPLIER = 1;

/** Which skills carry a mana perk, and what each one is worth on its own. */
const PERK_BY_SKILL: ReadonlyMap<SkillId, ManaPerk> = new Map<SkillId, ManaPerk>([
  ['azure-heart', { costMultiplier: AZURE_HEART_COST_MULTIPLIER }],
  ['spring-of-aether', { regenMultiplier: SPRING_OF_AETHER_REGEN_MULTIPLIER }],
]);

/**
 * Sanity check on the roster: every skill of kind 'perk' must have an entry
 * above, or a relic would grant a perk skill that quietly does nothing. It runs
 * at module load, which is boot — the only moment where "this build is
 * misconfigured" is still cheap to discover.
 */
for (const skill of SKILLS) {
  if (skill.kind === 'perk' && !PERK_BY_SKILL.has(skill.id)) {
    throw new Error(`relics: skill "${skill.id}" is kind 'perk' but has no perk value`);
  }
}

/**
 * Composes every perk skill a player holds into the single total value mana's
 * `setManaPerk` takes.
 *
 * MULTIPLICATIVE, not additive, and that is a decision rather than a default:
 * these are multipliers on a price and a rate, so composing them by multiplying
 * is the only combination under which the order relics are collected in cannot
 * change the result, and under which holding both is exactly "both effects".
 * Additive stacking of two 0.5s would reach zero, which mana would then have to
 * clamp — a rule that only ever fires because the composition was wrong.
 *
 * Returns neutral for a player holding no perk skills, so the caller may push
 * the result unconditionally.
 */
export function composeManaPerk(skills: Iterable<SkillId>): ManaPerk {
  let costMultiplier = NEUTRAL_MULTIPLIER;
  let regenMultiplier = NEUTRAL_MULTIPLIER;

  for (const id of skills) {
    const perk = PERK_BY_SKILL.get(id);
    if (perk === undefined) continue;
    costMultiplier *= perk.costMultiplier ?? NEUTRAL_MULTIPLIER;
    regenMultiplier *= perk.regenMultiplier ?? NEUTRAL_MULTIPLIER;
  }

  return { costMultiplier, regenMultiplier };
}

/** Whether a skill id carries a mana perk at all. */
export function isPerkSkill(id: SkillId): boolean {
  return PERK_BY_SKILL.has(id);
}
