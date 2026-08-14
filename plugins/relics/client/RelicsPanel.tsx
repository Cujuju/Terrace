// The relics HUD panel (design §3.5: "client-side plugins register HUD panels
// (Solid components)"). It is mounted by the core HUD's plugin-panel stack —
// see client/src/ui/Hud.tsx — and gets no props.
//
// SOLID REACTIVITY, THE SAME DISCIPLINE AS Hud.tsx: this component body runs
// EXACTLY ONCE. Every reactive value below is read by CALLING its accessor at
// the point of use — inside JSX, or inside an event handler. There is not one
// `const x = someSignal()` in this file, by construction, and there must never
// be: such a const freezes on the value at mount and the panel silently stops
// updating. Derived values are accessors (`const armedName = () => …`) so that
// calling them at the use site is still a live read.
//
// Styling: this plugin cannot add to client/src/ui/hud.css, so it reuses the
// core HUD's own classes (hud-row, hud-label, hud-hint, brush-button) for
// anything they already cover and carries the rest inline. Colours come from
// the HUD's CSS custom properties, so the panel follows the core theme.

import { For, Show, type JSX } from 'solid-js';
import { skillInfo, type SkillView } from '../protocol.ts';
import {
  CAST_DENIED_COOLDOWN,
  CAST_DENIED_TARGET,
  CAST_DENIED_UNOWNED,
} from '../protocol.ts';
import { SKILL_KIND_COLOR, cooldownLabelSeconds, cssColor } from './gems.ts';
import { armSkill, armedSkill, castDenial, relics, skills } from './state.ts';

/** Human copy for each refusal the server can send. */
const DENIAL_TEXT: Record<string, string> = {
  [CAST_DENIED_UNOWNED]: 'You no longer hold that skill.',
  [CAST_DENIED_COOLDOWN]: 'That skill is still recharging.',
  [CAST_DENIED_TARGET]: 'That target is outside your territory.',
};

/** A skill is castable if the roster says it is active. */
function isCastable(skill: SkillView): boolean {
  return skill.kind === 'active';
}

/**
 * The cast button's tooltip, for the three states its caption already shows in
 * shorthand. Built from the same props the caption is built from, so the two
 * can never disagree; a cooldown reads the LIVE remaining seconds, since a
 * generic "it recharges" would be the one thing the player already knows.
 */
function castTitle(skill: SkillView, armed: boolean): string {
  if (skill.cooldownRemainingS > 0) {
    return `Just used — ready to cast again in ${cooldownLabelSeconds(skill.cooldownRemainingS)}s.`;
  }
  const name = skillInfo(skill.id).name;
  return armed
    ? `Now click the ground to aim it — or click here to put ${name} away.`
    : `Ready ${name}, then click the ground to choose where it lands.`;
}

function SkillRow(props: { skill: SkillView }): JSX.Element {
  // props.skill is already reactive (Solid wraps prop expressions in getters),
  // so reading props.skill.* inside JSX below is a live read. These helpers are
  // accessors for the same reason — never plain consts.
  const info = (): ReturnType<typeof skillInfo> => skillInfo(props.skill.id);
  const onCooldown = (): boolean => props.skill.cooldownRemainingS > 0;
  const isArmed = (): boolean => armedSkill() === props.skill.id;
  /**
   * The row explains the skill; while it is recharging it also carries the
   * countdown, because a DISABLED button does not raise the hover events a
   * native tooltip needs (Chrome and Safari both swallow them) — so the one
   * state whose button tooltip can never appear is answered by its row.
   */
  const rowTitle = (): string =>
    onCooldown()
      ? `${info().description} Ready again in ${cooldownLabelSeconds(props.skill.cooldownRemainingS)}s.`
      : info().description;

  return (
    <div class="hud-row" title={rowTitle()}>
      <span
        class="status-dot"
        style={{ background: cssColor(SKILL_KIND_COLOR[props.skill.kind]) }}
      />
      <span style={{ flex: '1 1 auto' }}>{info().name}</span>

      <Show when={isCastable(props.skill)}>
        <button
          type="button"
          class="brush-button"
          classList={{ active: isArmed() }}
          style={{ width: 'auto', padding: '0 8px' }}
          aria-label={`Cast ${info().name}`}
          title={castTitle(props.skill, isArmed())}
          disabled={onCooldown()}
          onClick={() => armSkill(isArmed() ? null : props.skill.id)}
        >
          {onCooldown()
            ? `${cooldownLabelSeconds(props.skill.cooldownRemainingS)}s`
            : isArmed()
              ? 'Aim…'
              : 'Cast'}
        </button>
      </Show>
    </div>
  );
}

export function RelicsPanel(): JSX.Element {
  // An accessor, not a const: the armed skill changes after mount.
  const armedName = (): string => {
    const id = armedSkill();
    return id === null ? '' : skillInfo(id).name;
  };

  return (
    <>
      <div
        class="hud-row"
        title="Gems hovering over the land right now — each one holds a skill to claim."
      >
        <span class="hud-label">Relics</span>
        <span>{relics().length} in the world</span>
      </div>

      <Show
        when={skills().length > 0}
        fallback={
          <p
            class="hud-hint"
            title="Click the ground under a floating gem and its skill is yours to keep."
          >
            No skills yet — click a floating gem to collect one.
          </p>
        }
      >
        <For each={skills()}>{(skill) => <SkillRow skill={skill} />}</For>
      </Show>

      <Show when={armedSkill() !== null}>
        <p class="hud-hint">Click the ground to cast {armedName()}.</p>
      </Show>

      <Show when={castDenial() !== null}>
        <p class="hud-hint" style={{ color: 'var(--status-connecting)' }}>
          {DENIAL_TEXT[castDenial() ?? ''] ?? 'That cast was refused.'}
        </p>
      </Show>
    </>
  );
}
