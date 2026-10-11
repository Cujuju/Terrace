import { For, Show, type Component, type JSX } from 'solid-js';
import { Dynamic } from 'solid-js/web';
import { skillInfo, type SkillId, type SkillView } from '../protocol.ts';
import {
  CAST_DENIED_COOLDOWN,
  CAST_DENIED_TARGET,
  CAST_DENIED_UNOWNED,
  CAST_DENIED_UNSUITABLE,
  CAST_DENIED_WARDED,
} from '../protocol.ts';
import { cooldownLabelSeconds } from './gems.ts';
import {
  AzureHeartIcon,
  BedrockWardIcon,
  BulwarkIcon,
  GenesisIcon,
  LandslideIcon,
  QuakeIcon,
  SpringOfAetherIcon,
} from './RelicIcons.tsx';
import { armSkill, armedSkill, castDenial, relics, skills } from './state.ts';

const SKILL_ICON: Readonly<Record<SkillId, Component>> = {
  'bedrock-ward': BedrockWardIcon,
  quake: QuakeIcon,
  genesis: GenesisIcon,
  bulwark: BulwarkIcon,
  landslide: LandslideIcon,
  'azure-heart': AzureHeartIcon,
  'spring-of-aether': SpringOfAetherIcon,
};

const RELICS_CSS = `
.relics-grid {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 8px;
}
.relics-cell {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 3px;
}
.relics-cell__state {
  font-size: 10px;
  line-height: 1;
  font-variant-numeric: tabular-nums;
  color: var(--hud-muted, #97a3b0);
}
.relics-cell__state.ready,
.relics-cell__state.armed {
  color: rgb(var(--hud-accent-rgb, 111, 191, 115));
}
.relics-cell__state.cooldown {
  color: var(--hud-text, #e8edf2);
}
.relics-tile {
  flex: none;
  width: 38px;
  height: 38px;
  display: grid;
  place-items: center;
  padding: 0;
  border: 1px solid var(--hud-border, rgba(255, 255, 255, 0.12));
  border-radius: 10px;
  background: linear-gradient(180deg, rgba(255, 255, 255, 0.07), rgba(255, 255, 255, 0.02));
  box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.08);
  color: inherit;
  font: inherit;
  transition:
    border-color var(--hud-motion, 160ms ease),
    background var(--hud-motion, 160ms ease),
    box-shadow var(--hud-motion, 160ms ease),
    transform var(--hud-motion, 160ms ease);
}
.relics-gem {
  width: 30px;
  height: 30px;
  filter: drop-shadow(0 2px 3px rgba(0, 0, 0, 0.55));
  transition: transform var(--hud-motion, 160ms ease), filter var(--hud-motion, 160ms ease);
}
button.relics-tile {
  cursor: pointer;
}
button.relics-tile:hover:enabled {
  border-color: rgba(var(--hud-accent-rgb, 111, 191, 115), 0.6);
  background: linear-gradient(180deg, rgba(255, 255, 255, 0.1), rgba(255, 255, 255, 0.04));
}
button.relics-tile:hover:enabled .relics-gem {
  transform: translateY(-2px) scale(1.08);
  filter: drop-shadow(0 4px 5px rgba(0, 0, 0, 0.6));
}
button.relics-tile:active:enabled {
  transform: translateY(1px);
}
/* ARMED: the accent glow the toolbar gives the held tool, so "what am I
   about to throw" is answered the same way "what am I holding" is. */
button.relics-tile.armed {
  border-color: rgba(var(--hud-accent-rgb, 111, 191, 115), 0.7);
  background: linear-gradient(
    180deg,
    rgba(var(--hud-accent-rgb, 111, 191, 115), 0.32),
    rgba(var(--hud-accent-rgb, 111, 191, 115), 0.1)
  );
  box-shadow:
    0 0 18px rgba(var(--hud-accent-rgb, 111, 191, 115), 0.35),
    inset 0 1px 0 rgba(255, 255, 255, 0.14);
}
/* RECHARGING: the gem greys; the countdown sits under the tile, since a
   disabled button raises no hover and so can never show a tooltip. */
button.relics-tile:disabled {
  cursor: default;
}
button.relics-tile:disabled .relics-gem {
  filter: grayscale(0.7) brightness(0.6);
}
@media (pointer: coarse) {
  .relics-tile {
    width: 44px;
    height: 44px;
  }
}
@media (prefers-reduced-motion: reduce) {
  .relics-tile,
  .relics-gem {
    transition: none;
  }
  button.relics-tile:hover:enabled .relics-gem {
    transform: none;
  }
}
`;

const DENIAL_TEXT: Record<string, string> = {
  [CAST_DENIED_UNOWNED]: 'You no longer hold that skill.',
  [CAST_DENIED_COOLDOWN]: 'That skill is still recharging.',
  [CAST_DENIED_TARGET]: 'That target is outside your territory.',
  [CAST_DENIED_UNSUITABLE]: 'That ground has no cliff face to bring down.',
  [CAST_DENIED_WARDED]: 'Another hand shaped that ground a moment ago.',
};

function isCastable(skill: SkillView): boolean {
  return skill.kind === 'active';
}

function castTitle(skill: SkillView, armed: boolean): string {
  const name = skillInfo(skill.id).name;
  if (skill.cooldownRemainingS > 0) {
    return `${name}: ready in ${cooldownLabelSeconds(skill.cooldownRemainingS)}s`;
  }
  return armed ? `${name}: click the ground to aim` : `${name}: click to ready it`;
}

type CellState = 'passive' | 'perk' | 'cooldown' | 'armed' | 'ready';

function SkillCell(props: { skill: SkillView }): JSX.Element {
  const info = (): ReturnType<typeof skillInfo> => skillInfo(props.skill.id);
  const onCooldown = (): boolean => props.skill.cooldownRemainingS > 0;
  const isArmed = (): boolean => armedSkill() === props.skill.id;
  const cellTitle = (): string =>
    onCooldown()
      ? `${info().name}: ${info().description} Ready in ${cooldownLabelSeconds(props.skill.cooldownRemainingS)}s.`
      : `${info().name}: ${info().description}`;

  const cellState = (): CellState => {
    if (!isCastable(props.skill)) return props.skill.kind === 'perk' ? 'perk' : 'passive';
    if (onCooldown()) return 'cooldown';
    return isArmed() ? 'armed' : 'ready';
  };

  const stateText = (): string => {
    switch (cellState()) {
      case 'passive':
        return 'Passive';
      case 'perk':
        return 'Perk';
      case 'cooldown':
        return `${cooldownLabelSeconds(props.skill.cooldownRemainingS)}s`;
      case 'armed':
        return 'Aiming';
      case 'ready':
        return 'Ready';
    }
  };

  return (
    <div class="relics-cell" title={cellTitle()}>
      <Show
        when={isCastable(props.skill)}
        fallback={
          <span class="relics-tile">
            <Dynamic component={SKILL_ICON[props.skill.id]} />
          </span>
        }
      >
        <button
          type="button"
          class="relics-tile"
          classList={{ armed: isArmed() }}
          aria-label={`Cast ${info().name}`}
          aria-pressed={isArmed()}
          title={castTitle(props.skill, isArmed())}
          disabled={onCooldown()}
          onClick={() => armSkill(isArmed() ? null : props.skill.id)}
        >
          <Dynamic component={SKILL_ICON[props.skill.id]} />
        </button>
      </Show>
      <span class="relics-cell__state" classList={{ [cellState()]: true }}>
        {stateText()}
      </span>
    </div>
  );
}

export function RelicsHeaderLine(): JSX.Element {
  return (
    <div
      class="hud-row"
      title="Relics: gems waiting on the land"
    >
      <span class="hud-label">Relics</span>
      <span>{relics().length} in the world</span>
    </div>
  );
}

export function RelicsPanel(): JSX.Element {
  const armedName = (): string => {
    const id = armedSkill();
    return id === null ? '' : skillInfo(id).name;
  };

  return (
    <>
      <style>{RELICS_CSS}</style>
      {
}
      <div class="relics-grid">
        <For each={skills()}>{(skill) => <SkillCell skill={skill} />}</For>
      </div>

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
