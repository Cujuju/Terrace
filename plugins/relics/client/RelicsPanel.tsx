// The relics HUD panel (design doc: "client-side plugins register HUD panels
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
// core HUD's own classes (hud-row, hud-label, hud-hint) for anything they
// already cover and carries the rest in the one <style> below, the way the
// mana gauge does. Colours come from the HUD's CSS custom properties, each
// with a literal fallback, so the panel follows the core theme.
//
// THE SKILLS ARE A GRID OF TILES (owner, 2026-09-04: "update the HUD for the
// relics in the same style" as the modeler dock and the toolbar; 2026-09-05:
// "a horizontal grid, not a vertical list, and only show their details on
// hover"): each skill wears its own shaded object (RelicIcons.tsx — the shape
// its relic takes in the world) on a tile like the tool icons', and the tiles
// wrap left-to-right. Name and description live only in the hover tooltip.
// Under each tile sits one word of state — Passive / Perk / Ready / Aiming —
// or the live cooldown countdown. For an active skill the tile IS the cast
// button — it glows in the accent while armed and dims while recharging — so
// the panel answers "what do I hold, and what can I throw" the way the
// toolbar answers "what is in my hand".

import { For, Show, type Component, type JSX } from 'solid-js';
import { Dynamic } from 'solid-js/web';
import { skillInfo, type SkillId, type SkillView } from '../protocol.ts';
import {
  CAST_DENIED_COOLDOWN,
  CAST_DENIED_TARGET,
  CAST_DENIED_UNOWNED,
  CAST_DENIED_UNSUITABLE,
} from '../protocol.ts';
import { cooldownLabelSeconds } from './gems.ts';
import {
  AzureHeartIcon,
  BulwarkIcon,
  GenesisIcon,
  LandslideIcon,
  QuakeIcon,
  SpringOfAetherIcon,
  TitansHandIcon,
} from './RelicIcons.tsx';
import { armSkill, armedSkill, castDenial, relics, skills } from './state.ts';

/**
 * The face each skill wears. Keyed by the protocol's own union, so a skill
 * added there without art here fails to typecheck rather than rendering a
 * blank tile.
 */
const SKILL_ICON: Readonly<Record<SkillId, Component>> = {
  'titans-hand': TitansHandIcon,
  quake: QuakeIcon,
  genesis: GenesisIcon,
  bulwark: BulwarkIcon,
  landslide: LandslideIcon,
  'azure-heart': AzureHeartIcon,
  'spring-of-aether': SpringOfAetherIcon,
};

/**
 * The one stylesheet this panel renders — the mana gauge's arrangement, and
 * for the same reason: a plugin may not edit hud.css. The tile's chrome is
 * the toolbar tile's (hud.css .hud-tool), restated here with the HUD's own
 * custom properties and fallbacks rather than by depending on that class,
 * which core may restyle.
 */
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

/** Human copy for each refusal the server can send. */
const DENIAL_TEXT: Record<string, string> = {
  [CAST_DENIED_UNOWNED]: 'You no longer hold that skill.',
  [CAST_DENIED_COOLDOWN]: 'That skill is still recharging.',
  [CAST_DENIED_TARGET]: 'That target is outside your territory.',
  [CAST_DENIED_UNSUITABLE]: 'That ground has no cliff face to bring down.',
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
  const name = skillInfo(skill.id).name;
  if (skill.cooldownRemainingS > 0) {
    return `${name}: ready in ${cooldownLabelSeconds(skill.cooldownRemainingS)}s`;
  }
  return armed ? `${name}: click the ground to aim` : `${name}: click to ready it`;
}

/** The one-word state under a tile, doubling as its colour class. */
type CellState = 'passive' | 'perk' | 'cooldown' | 'armed' | 'ready';

function SkillCell(props: { skill: SkillView }): JSX.Element {
  // props.skill is already reactive (Solid wraps prop expressions in getters),
  // so reading props.skill.* inside JSX below is a live read. These helpers are
  // accessors for the same reason — never plain consts.
  const info = (): ReturnType<typeof skillInfo> => skillInfo(props.skill.id);
  const onCooldown = (): boolean => props.skill.cooldownRemainingS > 0;
  const isArmed = (): boolean => armedSkill() === props.skill.id;
  /**
   * The cell's hover tooltip is the only place the name and description show.
   * While recharging it also carries the countdown, because a DISABLED button
   * does not raise the hover events a native tooltip needs (Chrome and Safari
   * both swallow them) — so the one state whose button tooltip can never
   * appear is answered by its cell.
   */
  const cellTitle = (): string =>
    onCooldown()
      ? `${info().name}: ${info().description} Ready in ${cooldownLabelSeconds(props.skill.cooldownRemainingS)}s.`
      : `${info().name}: ${info().description}`;

  const cellState = (): CellState => {
    if (!isCastable(props.skill)) return props.skill.kind === 'perk' ? 'perk' : 'passive';
    if (onCooldown()) return 'cooldown';
    return isArmed() ? 'armed' : 'ready';
  };

  /** One word (or the countdown) under the tile. */
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

/**
 * The one-line relics summary, rendered by core inside the corner panel's
 * HEADER (registered as `headerSummary`) rather than the panel body — the
 * panel is named by this line, so it belongs in the title bar.
 */
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
  // An accessor, not a const: the armed skill changes after mount.
  const armedName = (): string => {
    const id = armedSkill();
    return id === null ? '' : skillInfo(id).name;
  };

  return (
    <>
      <style>{RELICS_CSS}</style>
      {/* Mounted only while a skill is held (hasBody in ./index.ts), so there
          is no empty-state copy here: the header line is the empty state. */}
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
