// The ADMIN PANEL — the debug spawn dialog (owner, 2026-09-01).
//
// WHAT IT IS FOR. Every event in this world arrives by a Poisson clock whose
// mean is minutes to hours — an eruption, a slide, a cyclone, the kraken. That
// is right for a game and useless for looking at the thing you just wrote.
// This panel lists every action the installed server plugins DECLARE
// (server plugins/types.ts, PluginActionDeclaration) and arms one on a
// click, to be fired where the next ground press lands. It is gated by the same
// world-admin key as the Worlds panel, because it is the same kind of thing:
// an operator reaching into the world.
//
// CORE KNOWS NO PLUGIN (design doc). Nothing here names a volcano. The cards
// are rendered from the listing the server sends — plugin, key, label,
// description, archetype — and the only thing this file adds is a colour,
// derived from the ARCHETYPE's name so every kind of event gets a stable
// accent without core keeping a palette of plugins. The archetype itself is
// the plugin's own word for what it brings (server plugins/types.ts,
// TerracePlugin.archetype); core groups by it without knowing one from
// another. The server refuses an action nobody declares.
//
// WHERE THE EVENT LANDS — AIMED, IN TWO STEPS (owner, 2026-09-01). Pressing a
// card does not fire it: it ARMS it (state/worldsState.ts's armedAction) and
// closes this panel, and the next press on the ground fires it at the cell
// under the pointer (main.tsx's placement listener). Firing at "wherever the
// camera points" was tried first and rejected: the panel's own button sits
// in a corner, so reaching it moves the view off the thing you meant.
//
// SOLID REACTIVITY: every reactive value is read by calling its accessor at
// the point of use — see Hud.tsx's header. There are no frozen consts here.

import { For, Show, createMemo, createSignal, onCleanup, type JSX } from 'solid-js';
import type { WorldAdminRequestMessage, WorldPluginAction } from '@terrace/shared';
import {
  activeWorldId,
  setAdminPanelOpen,
  setArmedAction,
  setWorldAdminKey,
  setWorldFeedback,
  worldAdminKey,
  worldFeedback,
  worldPlugins,
  type WorldFeedback,
} from '../state/worldsState.ts';
import type { WorldActions } from './WorldManager.tsx';
import { refusalText } from './worldAdminCopy.ts';

/**
 * A stable hue for an archetype, from its name — so "weather" is always the
 * same colour on every machine and nothing in core lists kinds to colour them.
 * FNV-1a over the name, folded onto the colour wheel. Any hash would do; this
 * one is short and spreads short lowercase words well.
 */
const FNV_OFFSET_BASIS = 0x811c9dc5;
const FNV_PRIME = 0x01000193;
const HUE_DEGREES = 360;

function hueFor(name: string): number {
  let hash = FNV_OFFSET_BASIS;
  for (let index = 0; index < name.length; index++) {
    hash ^= name.charCodeAt(index);
    hash = Math.imul(hash, FNV_PRIME) >>> 0;
  }
  return hash % HUE_DEGREES;
}

/**
 * The heading for actions whose plugin declares no archetype.
 *
 * A WORD OF CORE'S OWN, not a kind: it says "these plugins did not say what
 * they are", which is true of any plugin and names none of them. Inventing
 * 'weather' for an undeclared plugin would be exactly the guess the archetype
 * exists to avoid (server plugins/types.ts, TerracePlugin.archetype).
 */
const UNDECLARED_ARCHETYPE = 'other';

interface ArchetypeGroup {
  readonly archetype: string;
  readonly actions: WorldPluginAction[];
}

/**
 * The declared actions, grouped by ARCHETYPE — ONE HEADING, ONE GRID.
 *
 * The plugin is NOT a second heading (owner, 2026-09-04). It was, briefly, and
 * it read as a stack of one- and two-card lists: a plugin usually declares a
 * single action, so a sub-heading per plugin put "cyclone" directly above
 * "Spawn a cyclone" and broke the archetype's grid into rows of one. The
 * label already says which event this is, and the card's tooltip still names
 * the plugin for the operator who needs to go and disable it.
 *
 * First-appearance order, i.e. the server's load order, so the panel is stable
 * across openings; `sort` is stable in ES2019 and later, so moving the
 * undeclared group last leaves the rest of that order intact.
 */
function groupByArchetype(actions: readonly WorldPluginAction[]): ArchetypeGroup[] {
  const groups: ArchetypeGroup[] = [];
  for (const action of actions) {
    const archetype = action.archetype ?? UNDECLARED_ARCHETYPE;
    const group = groups.find((candidate) => candidate.archetype === archetype);
    if (group === undefined) groups.push({ archetype, actions: [action] });
    else group.actions.push(action);
  }
  // "Other" last: a heading that means "unstated" must never lead the panel.
  return groups.sort(
    (a, b) =>
      Number(a.archetype === UNDECLARED_ARCHETYPE) - Number(b.archetype === UNDECLARED_ARCHETYPE),
  );
}

/** Only the feedback this panel caused is shown here; the rest is the Worlds panel's. */
function isActionFeedback(feedback: WorldFeedback): boolean {
  return (feedback.kind === 'done' || feedback.kind === 'refused') && feedback.action === 'actPlugin';
}

export function AdminPanel(props: { actions: WorldActions }): JSX.Element {
  // Whether the operator has submitted a key from THIS panel (or arrived with
  // one already typed in the Worlds panel) — what the listing request below
  // waits on, and what hides the key field once it has been accepted.
  const [unlocked, setUnlocked] = createSignal(worldAdminKey() !== '');

  const send = (message: WorldAdminRequestMessage): void => {
    setWorldFeedback({ kind: 'working' });
    props.actions.send(message);
  };

  // THE LISTING, IN ONE ROUND-TRIP, ASKED WITHOUT AN ID (owner, 2026-09-04).
  //
  // It used to be two steps: ask for the WORLDS, wait for the active id to
  // come back on that listing, then ask for that world's plugins. Both halves
  // were wrong. The second is a round-trip the operator waits through; the
  // first is far worse — a world listing opens every world file on disk and
  // reads its name, size, restore-point count and thumbnail, which measured
  // 2.7 s warm and 7.2 s cold over five worlds on this machine, ON THE TICK
  // THREAD, to discover one id this panel never displays. The panel now asks
  // `worldPluginList` with no id, which means "the world I am in"; the answer
  // carries `activeId`, so the id arrives with the thing it identifies.
  //
  // The plugin listing itself touches no disk for the LIVE world — the enabled
  // set and settings are read off the open session — so this is a message and
  // a reply, and the cards are there.
  const requestListing = (): void => {
    setUnlocked(true);
    send({ type: 'worldPluginList', key: worldAdminKey() });
  };

  const listedForLiveWorld = (): boolean =>
    activeWorldId() !== null && worldPlugins()?.id === activeWorldId();

  // Asked once per opening, and skipped entirely when the listing already in
  // hand is this world's — reopening the panel after arming one event must not
  // cost a round-trip. A listing the Worlds panel fetched for some OTHER world
  // does not count, which is what `listedForLiveWorld` is checking.
  if (unlocked() && !listedForLiveWorld()) requestListing();

  // Escape closes, as every overlay here does. Window-level so it works with
  // focus anywhere in the sheet; not claimed, so nothing beneath loses it.
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') setAdminPanelOpen(false);
  };
  window.addEventListener('keydown', onKeyDown);
  onCleanup(() => window.removeEventListener('keydown', onKeyDown));

  // CLICKING OFF THE SHEET CLOSES IT (owner, 2026-09-04), the same dismissal
  // Escape gives, for the hand rather than the keyboard.
  //
  // BOTH ENDS OF THE CLICK MUST LAND ON THE BACKDROP. Testing only the click
  // would close the panel when a press that began inside the sheet — dragging
  // to select the description text of a card, or releasing a fraction outside
  // a button — happened to lift over the backdrop, which reads as the panel
  // vanishing on its own. `event.target === event.currentTarget` is what
  // distinguishes the backdrop from everything drawn on top of it; the sheet
  // is a child, so any press within it fails that test and is remembered as
  // such here.
  let pressedBackdrop = false;
  const onBackdropPointerDown = (event: PointerEvent & { currentTarget: HTMLDivElement }): void => {
    pressedBackdrop = event.target === event.currentTarget;
  };
  const onBackdropClick = (event: MouseEvent & { currentTarget: HTMLDivElement }): void => {
    if (pressedBackdrop && event.target === event.currentTarget) setAdminPanelOpen(false);
    pressedBackdrop = false;
  };

  const groups = createMemo(() => groupByArchetype(worldPlugins()?.actions ?? []));

  /** Arms the action and gets out of the way; the ground press does the rest. */
  const arm = (action: WorldPluginAction): void => {
    setArmedAction(action);
    setAdminPanelOpen(false);
  };

  return (
    <div
      class="restore-overlay"
      role="dialog"
      aria-label="Admin: world events"
      onPointerDown={onBackdropPointerDown}
      onClick={onBackdropClick}
    >
      <div class="restore-sheet admin-sheet">
        {/* HEADER: an eyebrow naming the mode, the title, and the close. */}
        <header class="admin-header">
          <div class="admin-title-block">
            <span class="admin-eyebrow">Admin</span>
            <h2 class="admin-title">World events</h2>
          </div>
          <button
            type="button"
            class="chart-button admin-close"
            aria-label="Close admin panel"
            title="Close this panel."
            onClick={() => setAdminPanelOpen(false)}
          >
            ✕
          </button>
        </header>

        <p class="admin-lede">
          Fire the events that would otherwise wait on chance. Pick one, then
          click the ground where it should happen; it behaves exactly as the
          real thing would.
        </p>

        {/* THE KEY, only until it has been accepted. A password field so it is
            not shoulder-read; the same signal the Worlds panel uses, so a key
            typed there unlocks here too. */}
        <Show when={!unlocked()}>
          <form
            class="admin-key-row"
            onSubmit={(event) => {
              event.preventDefault();
              requestListing();
            }}
          >
            <label class="controls-label" for="admin-key">
              World-admin key
            </label>
            <input
              id="admin-key"
              class="restore-key-input"
              type="password"
              autocomplete="off"
              placeholder="WORLD_ADMIN_KEY"
              value={worldAdminKey()}
              onInput={(event) => setWorldAdminKey(event.currentTarget.value)}
            />
            <button type="submit" class="chart-button admin-unlock" disabled={worldAdminKey() === ''}>
              Unlock
            </button>
          </form>
        </Show>

        {/* THE RECEIPT. One strip, coloured by outcome, carrying the plugin's
            own words — the whole point of the panel is knowing what happened. */}
        <Show when={isActionFeedback(worldFeedback())}>
          {(() => {
            // Narrowed once per render of the strip; `isActionFeedback` above
            // already established the kind.
            const feedback = worldFeedback() as Extract<WorldFeedback, { kind: 'done' | 'refused' }>;
            const tone =
              feedback.kind === 'done' ? 'ok' : feedback.reason === 'actionDeclined' ? 'declined' : 'refused';
            const text =
              feedback.kind === 'done'
                ? feedback.detail ?? 'Done.'
                : feedback.reason === 'actionDeclined'
                  ? feedback.detail ?? refusalText(feedback.reason)
                  : refusalText(feedback.reason);
            return (
              <p class="admin-receipt" classList={{ [`admin-receipt-${tone}`]: true }} role="status">
                <span class="admin-receipt-dot" aria-hidden="true" />
                <span>{text}</span>
              </p>
            );
          })()}
        </Show>

        {/* A world-management refusal that is NOT an action's (a bad key, a
            server with no key) still has to be explained here, or the panel
            simply never fills. */}
        <Show when={worldFeedback().kind === 'refused' && !isActionFeedback(worldFeedback())}>
          <p class="admin-receipt admin-receipt-refused" role="status">
            <span class="admin-receipt-dot" aria-hidden="true" />
            <span>{refusalText((worldFeedback() as { reason: Parameters<typeof refusalText>[0] }).reason)}</span>
          </p>
        </Show>

        {/* Not shown while a refusal strip is up: the strip already says what
            went wrong, and two explanations of one silence read as two faults. */}
        <Show
          when={
            unlocked() &&
            activeWorldId() === null &&
            worldFeedback().kind !== 'working' &&
            worldFeedback().kind !== 'refused'
          }
        >
          <p class="admin-empty">No world is loaded. Load one from the Worlds panel first.</p>
        </Show>

        <Show when={listedForLiveWorld() && groups().length === 0}>
          <p class="admin-empty">No installed plugin declares an action.</p>
        </Show>

        {/* THE CARDS: one heading per archetype, then one grid of every event
            of that kind, whichever plugin declared it. The hue comes from the
            archetype's name (hueFor) rather than the plugin's, so all of the
            weather shares one accent and the eye finds "the weather ones"
            without reading — which is the whole point of the grouping. Every
            card is one button: the whole surface fires, not a small control
            inside it. */}
        <Show when={listedForLiveWorld()}>
          <div class="admin-groups">
            <For each={groups()}>
              {(group) => (
                <section
                  class="admin-group"
                  style={{ '--admin-hue': `${hueFor(group.archetype)}` }}
                >
                  <h3 class="admin-group-name">
                    <span class="admin-group-swatch" aria-hidden="true" />
                    {group.archetype}
                  </h3>
                  <div class="admin-cards">
                    <For each={group.actions}>
                      {(action) => (
                        // The plugin lives in the tooltip rather than in a
                        // heading: still there for the operator who has to go
                        // and disable it, without splitting the grid.
                        <button
                          type="button"
                          class="admin-card"
                          title={`${action.plugin} — ${action.description} Click, then click the ground.`}
                          onClick={() => arm(action)}
                        >
                          <span class="admin-card-label">{action.label}</span>
                          <span class="admin-card-description">{action.description}</span>
                          <span class="admin-card-go" aria-hidden="true">→</span>
                        </button>
                      )}
                    </For>
                  </div>
                </section>
              )}
            </For>
          </div>
        </Show>
      </div>
    </div>
  );
}
