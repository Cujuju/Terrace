export type SkillKind = 'passive' | 'active' | 'perk';

export type SkillId =
  | 'bedrock-ward'
  | 'quake'
  | 'genesis'
  | 'bulwark'
  | 'landslide'
  | 'azure-heart'
  | 'spring-of-aether';

export interface SkillInfo {
  readonly id: SkillId;
  readonly kind: SkillKind;
  readonly name: string;
  readonly description: string;
}

export const SKILLS: readonly SkillInfo[] = [
  {
    id: 'bedrock-ward',
    kind: 'passive',
    name: 'Bedrock Ward',
    description: 'Land you have just shaped refuses another hand.',
  },
  {
    id: 'quake',
    kind: 'active',
    name: 'Quake',
    description: 'Collapse a wide crater at a chosen cell.',
  },
  {
    id: 'genesis',
    kind: 'active',
    name: 'Genesis',
    description: 'Raise a small island at a chosen cell.',
  },
  {
    id: 'bulwark',
    kind: 'active',
    name: 'Bulwark',
    description: 'Raise a ring wall, and leave the ground inside it alone.',
  },
  {
    id: 'landslide',
    kind: 'active',
    name: 'Landslide',
    description: 'Topple a cliff face into a slope that can be walked.',
  },
  {
    id: 'azure-heart',
    kind: 'perk',
    name: 'Azure Heart',
    description: 'Your sculpts cost half the mana.',
  },
  {
    id: 'spring-of-aether',
    kind: 'perk',
    name: 'Spring of Aether',
    description: 'Your mana regenerates twice as fast.',
  },
];

export const SKILL_IDS: readonly SkillId[] = SKILLS.map((skill) => skill.id);

const SKILLS_BY_ID = new Map<string, SkillInfo>(SKILLS.map((skill) => [skill.id, skill]));

export function isSkillId(value: unknown): value is SkillId {
  return typeof value === 'string' && SKILLS_BY_ID.has(value);
}

export function skillInfo(id: SkillId): SkillInfo {
  return SKILLS_BY_ID.get(id) as SkillInfo;
}

export const RELICS_MESSAGE = 'relics';

export const SKILLS_MESSAGE = 'skills';

export const COLLECT_MESSAGE = 'collect';

export const CAST_MESSAGE = 'cast';

export const CAST_DENIED_MESSAGE = 'denied';

export interface RelicView {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly skill: SkillId;
}

export interface RelicsPayload {
  readonly relics: readonly RelicView[];
}

export interface SkillView {
  readonly id: SkillId;
  readonly kind: SkillKind;
  readonly cooldownS: number;
  readonly cooldownRemainingS: number;
}

export interface SkillsPayload {
  readonly skills: readonly SkillView[];
}

export interface CollectPayload {
  readonly id: string;
}

export interface CastPayload {
  readonly skill: SkillId;
  readonly x: number;
  readonly y: number;
}

export interface CastDeniedPayload {
  readonly skill: string;
  readonly reason: string;
}

export const CAST_DENIED_UNOWNED = 'unowned';
export const CAST_DENIED_COOLDOWN = 'cooldown';
export const CAST_DENIED_TARGET = 'target';
export const CAST_DENIED_WARDED = 'warded';
export const CAST_DENIED_UNSUITABLE = 'unsuitable';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

export function isCellCoordinate(value: unknown, worldSize: number): value is number {
  return Number.isInteger(value) && (value as number) >= 0 && (value as number) < worldSize;
}

export function parseCollectPayload(payload: unknown): CollectPayload | null {
  if (!isRecord(payload)) return null;
  const { id } = payload;
  if (typeof id !== 'string' || id.length === 0) return null;
  return { id };
}

export function parseCastPayload(payload: unknown, worldSize: number): CastPayload | null {
  if (!isRecord(payload)) return null;
  const { skill, x, y } = payload;
  if (!isSkillId(skill)) return null;
  if (!isCellCoordinate(x, worldSize)) return null;
  if (!isCellCoordinate(y, worldSize)) return null;
  return { skill, x, y };
}

export function parseRelicsPayload(payload: unknown): RelicView[] {
  if (!isRecord(payload) || !Array.isArray(payload.relics)) return [];

  const relics: RelicView[] = [];
  for (const entry of payload.relics) {
    if (!isRecord(entry)) continue;
    const { id, x, y, skill } = entry;
    if (typeof id !== 'string' || id.length === 0) continue;
    if (!Number.isInteger(x) || !Number.isInteger(y)) continue;
    if (!isSkillId(skill)) continue;
    relics.push({ id, x: x as number, y: y as number, skill });
  }
  return relics;
}

function asSeconds(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return 0;
  return value;
}

export function parseSkillsPayload(payload: unknown): SkillView[] {
  if (!isRecord(payload) || !Array.isArray(payload.skills)) return [];

  const skills: SkillView[] = [];
  for (const entry of payload.skills) {
    if (!isRecord(entry)) continue;
    const { id } = entry;
    if (!isSkillId(id)) continue;
    skills.push({
      id,
      kind: skillInfo(id).kind,
      cooldownS: asSeconds(entry.cooldownS),
      cooldownRemainingS: asSeconds(entry.cooldownRemainingS),
    });
  }
  return skills;
}

export const RELIC_COUNT = SKILL_IDS.length;
