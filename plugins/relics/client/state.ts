import { createSignal } from 'solid-js';
import type { RelicView, SkillId, SkillView } from '../protocol.ts';

const [relics, setRelics] = createSignal<readonly RelicView[]>([]);

const [skills, setSkills] = createSignal<readonly SkillView[]>([]);

const [armedSkill, setArmedSkill] = createSignal<SkillId | null>(null);

const [castDenial, setCastDenial] = createSignal<string | null>(null);

export {
  relics,
  setRelics,
  skills,
  setSkills,
  armedSkill,
  castDenial,
  setCastDenial,
};

export function armSkill(skill: SkillId | null): void {
  setArmedSkill(skill);
  setCastDenial(null);
}

export function resetRelicsClientState(): void {
  setRelics([]);
  setSkills([]);
  setArmedSkill(null);
  setCastDenial(null);
}
