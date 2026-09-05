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
// THE SKILL ROWS ARE TILES (owner, 2026-09-04: "update the HUD for the relics
// in the same style" as the modeler dock and the toolbar): each skill wears a
// shaded gem in its category's colour, hovering over the same isometric grass
// tile the tool icons stand on, lifted by the same drop shadow. For an active
// skill that tile IS the cast button — it glows in the accent while armed and
// dims while recharging — so the panel answers "what do I hold, and what can I
// throw" the way the toolbar answers "what is in my hand".

import { For, Show, type JSX } from 'solid-js';
import { skillInfo, type SkillView } from '../protocol.ts';
import {
  CAST_DENIED_COOLDOWN,
  CAST_DENIED_TARGET,
  CAST_DENIED_UNOWNED,
} from '../protocol.ts';
import { SKILL_KIND_COLOR, cooldownLabelSeconds, cssColor } from './gems.ts';
import { armSkill, armedSkill, castDenial, relics, skills } from './state.ts';

/**
 * A gem's four visible faces, lit from the top-left like the tool icons:
 * the category colour mixed toward white for the lit faces and toward black
 * for the shaded ones. Fractions are the brightness steps the isometric tiles
 * use between their own faces.
 */
const GEM_FACE_LIGHT = 0.45;
const GEM_FACE_LIT = 0.15;
const GEM_FACE_SHADE = -0.3;
const GEM_FACE_DARK = -0.55;

/** Mix a 0xRRGGBB colour toward white (fraction > 0) or black (fraction < 0). */
function mixColor(color: number, fraction: number): string {
  const channel = (shift: number): number => {
    const value = (color >> shift) & 0xff;
    const target = fraction > 0 ? 0xff : 0;
    return Math.round(value + (target - value) * Math.abs(fraction));
  };
  return cssColor((channel(16) << 16) | (channel(8) << 8) | channel(0));
}

/**
 * One relic's face: a floating octahedron in its category's colour over the
 * toolbar icons' isometric tile. The tile's gradient ids are prefixed with
 * the plugin's name because SVG ids are document-global; the gem's own faces
 * are flat fills computed from its colour, so no per-kind gradient is needed
 * and any number of rows can share the one tile definition.
 */
function GemIcon(props: { color: number }): JSX.Element {
  return (
    <svg class="relics-gem" viewBox="0 0 32 32" aria-hidden="true">
      <defs>
        <linearGradient id="relics-tile-top" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stop-color="#a6e08a" />
          <stop offset="1" stop-color="#4f9a4a" />
        </linearGradient>
        <linearGradient id="relics-tile-left" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="#9a6a45" />
          <stop offset="1" stop-color="#5a3a22" />
        </linearGradient>
        <linearGradient id="relics-tile-right" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stop-color="#6e4a2f" />
          <stop offset="1" stop-color="#3a2415" />
        </linearGradient>
      </defs>
      <ellipse cx="16" cy="27.5" rx="12" ry="3" fill="#000" opacity="0.35" />
      <polygon points="16,13 28,19 16,25 4,19" fill="url(#relics-tile-top)" />
      <polygon points="4,19 16,25 16,29 4,23" fill="url(#relics-tile-left)" />
      <polygon points="28,19 16,25 16,29 28,23" fill="url(#relics-tile-right)" />
      {/* The shade the hovering gem casts, then its glow on the grass. */}
      <ellipse cx="16" cy="19.2" rx="5" ry="2.2" fill="#2e5a2e" opacity="0.55" />
      <ellipse cx="16" cy="19" rx="6.5" ry="3" fill={cssColor(props.color)} opacity="0.22" />
      {/* The octahedron: apex, equator, base, with a front edge that gives
          it a near face and a far face on each half. */}
      <polygon points="16,2.5 8.5,11 16,13.5" fill={mixColor(props.color, GEM_FACE_LIGHT)} />
      <polygon points="16,2.5 16,13.5 23.5,11" fill={mixColor(props.color, GEM_FACE_LIT)} />
      <polygon points="8.5,11 16,13.5 16,19" fill={mixColor(props.color, GEM_FACE_SHADE)} />
      <polygon points="23.5,11 16,13.5 16,19" fill={mixColor(props.color, GEM_FACE_DARK)} />
      <path d="M16 2.5L8.5 11" stroke="#ffffff" stroke-width="0.6" opacity="0.6" />
    </svg>
  );
}

/**
 * The one stylesheet this panel renders — the mana gauge's arrangement, and
 * for the same reason: a plugin may not edit hud.css. The tile's chrome is
 * the toolbar tile's (hud.css .hud-tool), restated here with the HUD's own
 * custom properties and fallbacks rather than by depending on that class,
 * which core may restyle.
 */
const RELICS_CSS = `
.relics-skill {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 8px;
}
.relics-skill__words {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.relics-skill__name {
  color: var(--hud-text, #e8edf2);
}
.relics-skill__state {
  font-size: 11px;
  color: var(--hud-muted, #97a3b0);
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
/* RECHARGING: the gem greys and the countdown rides the tile, since a
   disabled button raises no hover and so can never show a tooltip. */
button.relics-tile:disabled {
  cursor: default;
  position: relative;
}
button.relics-tile:disabled .relics-gem {
  filter: grayscale(0.7) brightness(0.6);
}
.relics-tile__cooldown {
  position: absolute;
  right: 2px;
  bottom: 1px;
  font-size: 10px;
  font-variant-numeric: tabular-nums;
  color: var(--hud-text, #e8edf2);
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.8);
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

  /** What the row says under the name: the kind, or the live cast state. */
  const stateText = (): string => {
    if (!isCastable(props.skill)) return props.skill.kind === 'perk' ? 'Perk' : 'Passive';
    if (onCooldown()) return `Ready in ${cooldownLabelSeconds(props.skill.cooldownRemainingS)}s`;
    return isArmed() ? 'Click the ground to aim' : 'Click to ready';
  };

  return (
    <div class="relics-skill" title={rowTitle()}>
      <Show
        when={isCastable(props.skill)}
        fallback={
          <span class="relics-tile">
            <GemIcon color={SKILL_KIND_COLOR[props.skill.kind]} />
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
          <GemIcon color={SKILL_KIND_COLOR[props.skill.kind]} />
          <Show when={onCooldown()}>
            <span class="relics-tile__cooldown">
              {cooldownLabelSeconds(props.skill.cooldownRemainingS)}s
            </span>
          </Show>
        </button>
      </Show>
      <span class="relics-skill__words">
        <span class="relics-skill__name">{info().name}</span>
        <span class="relics-skill__state">{stateText()}</span>
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
      title="Gems hovering over the land right now — each one holds a skill to claim."
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
