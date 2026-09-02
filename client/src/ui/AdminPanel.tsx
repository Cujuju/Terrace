// The ADMIN PANEL — the debug spawn dialog (owner, 2026-09-01).
//
// WHAT IT IS FOR. Every event in this world arrives by a Poisson clock whose
// mean is minutes to hours — an eruption, a slide, a cyclone, the kraken. That
// is right for a game and useless for looking at the thing you just wrote.
// This panel lists every action the installed server plugins DECLARE
// (server plugins/types.ts, PluginActionDeclaration) and fires one on a
// click, sited where the camera is looking. It is gated by the same
// world-admin key as the Worlds panel, because it is the same kind of thing:
// an operator reaching into the world.
//
// CORE KNOWS NO PLUGIN (design §3.5). Nothing here names a volcano. The cards
// are rendered from the listing the server sends — plugin, key, label,
// description — and the only thing this file adds is a colour, derived from
// the plugin's NAME so every plugin gets a stable accent without core keeping
// a palette of plugins. The server refuses an action nobody declares.
//
// WHERE THE EVENT LANDS. The server never learns where a camera points, so
// the request carries the cell under the orbit target (`props.focusCell`),
// and the panel shows that cell in its header so the operator can see where
// the next event will be aimed before pressing anything.
//
// SOLID REACTIVITY: every reactive value is read by calling its accessor at
// the point of use — see Hud.tsx's header. There are no frozen consts here.

import { For, Show, createEffect, createMemo, createSignal, on, onCleanup, type JSX } from 'solid-js';
import type { WorldAdminRequestMessage, WorldPluginAction } from '@terrace/shared';
import {
  activeWorldId,
  setAdminPanelOpen,
  setWorldAdminKey,
  setWorldFeedback,
  worldAdminKey,
  worldFeedback,
  worldPlugins,
  type WorldFeedback,
} from '../state/worldsState.ts';
import type { WorldActions } from './WorldManager.tsx';
import { refusalText } from './worldAdminCopy.ts';

/** A cell of the live world, as the camera's orbit target lands on one. */
export interface FocusCell {
  readonly x: number;
  readonly y: number;
}

/**
 * A stable hue for a plugin, from its name — so "volcanoes" is always the
 * same colour on every machine and nothing in core lists plugins to colour
 * them. FNV-1a over the name, folded onto the colour wheel. Any hash would
 * do; this one is short and spreads short lowercase words well.
 */
const FNV_OFFSET_BASIS = 0x811c9dc5;
const FNV_PRIME = 0x01000193;
const HUE_DEGREES = 360;

function hueFor(pluginName: string): number {
  let hash = FNV_OFFSET_BASIS;
  for (let index = 0; index < pluginName.length; index++) {
    hash ^= pluginName.charCodeAt(index);
    hash = Math.imul(hash, FNV_PRIME) >>> 0;
  }
  return hash % HUE_DEGREES;
}

/** The declared actions, grouped by plugin in the server's load order. */
function groupByPlugin(actions: readonly WorldPluginAction[]): Array<{
  plugin: string;
  actions: WorldPluginAction[];
}> {
  const groups: Array<{ plugin: string; actions: WorldPluginAction[] }> = [];
  for (const action of actions) {
    const group = groups.find((candidate) => candidate.plugin === action.plugin);
    if (group === undefined) groups.push({ plugin: action.plugin, actions: [action] });
    else group.actions.push(action);
  }
  return groups;
}

/** Only the feedback this panel caused is shown here; the rest is the Worlds panel's. */
function isActionFeedback(feedback: WorldFeedback): boolean {
  return (feedback.kind === 'done' || feedback.kind === 'refused') && feedback.action === 'actPlugin';
}

export function AdminPanel(props: {
  actions: WorldActions;
  /** The cell under the camera's orbit target; null before the world arrives. */
  focusCell: () => FocusCell | null;
}): JSX.Element {
  // Which card was pressed last, as `plugin:key`, so it can show the working
  // state and then the receipt beside the thing that produced it.
  const [pressed, setPressed] = createSignal<string | null>(null);
  // Whether the operator has submitted a key from THIS panel (or arrived with
  // one already typed in the Worlds panel) — what the listing effect waits on.
  const [unlocked, setUnlocked] = createSignal(worldAdminKey() !== '');

  const send = (message: WorldAdminRequestMessage): void => {
    setWorldFeedback({ kind: 'working' });
    props.actions.send(message);
  };

  // THE LISTING, IN TWO STEPS. The action declarations ride on the plugin
  // listing, which is asked for BY WORLD ID — and the live world's id reaches
  // this client only on a world listing. So: ask for the worlds, and the
  // moment the active id is known (or already was), ask for that world's
  // plugins. `on` with `defer` false so a panel opened with the id already
  // in hand asks immediately.
  const requestListing = (): void => {
    setUnlocked(true);
    send({ type: 'worldList', key: worldAdminKey() });
  };
  createEffect(
    on([activeWorldId, unlocked], ([id, ready]) => {
      if (!ready || id === null) return;
      if (worldPlugins()?.id === id) return;
      send({ type: 'worldPluginList', key: worldAdminKey(), id });
    }),
  );
  if (unlocked()) requestListing();

  // Escape closes, as every overlay here does. Window-level so it works with
  // focus anywhere in the sheet; not claimed, so nothing beneath loses it.
  const onKeyDown = (event: KeyboardEvent): void => {
    if (event.key === 'Escape') setAdminPanelOpen(false);
  };
  window.addEventListener('keydown', onKeyDown);
  onCleanup(() => window.removeEventListener('keydown', onKeyDown));

  const groups = createMemo(() => groupByPlugin(worldPlugins()?.actions ?? []));
  const listedForLiveWorld = (): boolean =>
    activeWorldId() !== null && worldPlugins()?.id === activeWorldId();

  const fire = (action: WorldPluginAction): void => {
    const cell = props.focusCell();
    if (cell === null) return;
    setPressed(`${action.plugin}:${action.key}`);
    send({
      type: 'worldPluginAct',
      key: worldAdminKey(),
      plugin: action.plugin,
      action: action.key,
      x: cell.x,
      y: cell.y,
    });
  };

  return (
    <div class="restore-overlay" role="dialog" aria-label="Admin: world events">
      <div class="restore-sheet admin-sheet">
        {/* HEADER: an eyebrow naming the mode, the title, the aim readout,
            and the close — one row, the aim on the right where the eye goes
            after reading the title. */}
        <header class="admin-header">
          <div class="admin-title-block">
            <span class="admin-eyebrow">Admin</span>
            <h2 class="admin-title">World events</h2>
          </div>
          <div class="admin-aim" title="Events land at the cell under the centre of your view. Move the camera to aim.">
            <span class="admin-aim-label">Aimed at</span>
            <span class="admin-aim-cell">
              <Show when={props.focusCell()} fallback={'—'}>
                {(cell) => `${cell().x}, ${cell().y}`}
              </Show>
            </span>
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
          Fire the events that would otherwise wait on chance. Each lands near
          where you are looking, and behaves exactly as the real thing would.
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

        <Show when={unlocked() && activeWorldId() === null && worldFeedback().kind !== 'working'}>
          <p class="admin-empty">No world is loaded. Load one from the Worlds panel first.</p>
        </Show>

        <Show when={listedForLiveWorld() && groups().length === 0}>
          <p class="admin-empty">No installed plugin declares an action.</p>
        </Show>

        {/* THE CARDS, grouped by plugin. Each group gets a hue from its name
            (hueFor) — an accent bar and a tinted glow — so the eye can find
            "the storms ones" without reading, and every card is one button:
            the whole surface fires, not a small control inside it. */}
        <Show when={listedForLiveWorld()}>
          <div class="admin-groups">
            <For each={groups()}>
              {(group) => (
                <section class="admin-group" style={{ '--admin-hue': `${hueFor(group.plugin)}` }}>
                  <h3 class="admin-group-name">
                    <span class="admin-group-swatch" aria-hidden="true" />
                    {group.plugin}
                  </h3>
                  <div class="admin-cards">
                    <For each={group.actions}>
                      {(action) => {
                        const id = `${action.plugin}:${action.key}`;
                        const working = (): boolean =>
                          pressed() === id && worldFeedback().kind === 'working';
                        return (
                          <button
                            type="button"
                            class="admin-card"
                            classList={{ working: working() }}
                            disabled={props.focusCell() === null || worldFeedback().kind === 'working'}
                            title={action.description}
                            onClick={() => fire(action)}
                          >
                            <span class="admin-card-label">{action.label}</span>
                            <span class="admin-card-description">{action.description}</span>
                            <span class="admin-card-go" aria-hidden="true">
                              {working() ? '…' : '→'}
                            </span>
                          </button>
                        );
                      }}
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
