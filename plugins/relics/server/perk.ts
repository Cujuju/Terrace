import { SKILLS, type SkillId } from '../protocol.ts';

export interface ManaPerk {
  readonly costMultiplier?: number;
  readonly regenMultiplier?: number;
}

export const AZURE_HEART_COST_MULTIPLIER = 0.5;

export const SPRING_OF_AETHER_REGEN_MULTIPLIER = 2;

export const NEUTRAL_MULTIPLIER = 1;

const PERK_BY_SKILL: ReadonlyMap<SkillId, ManaPerk> = new Map<SkillId, ManaPerk>([
  ['azure-heart', { costMultiplier: AZURE_HEART_COST_MULTIPLIER }],
  ['spring-of-aether', { regenMultiplier: SPRING_OF_AETHER_REGEN_MULTIPLIER }],
]);

for (const skill of SKILLS) {
  if (skill.kind === 'perk' && !PERK_BY_SKILL.has(skill.id)) {
    throw new Error(`relics: skill "${skill.id}" is kind 'perk' but has no perk value`);
  }
}

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

export function isPerkSkill(id: SkillId): boolean {
  return PERK_BY_SKILL.has(id);
}
